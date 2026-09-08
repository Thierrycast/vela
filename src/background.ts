import { ChatMessage } from "./types";
import { adoptTab, endSession, ensureSession, forgetTab, getSession, renameSession } from "./session";
import { listScripts } from "./script-store";
import { parseMetadata } from "./user-script";
import { SIDECAR_PORT, SidecarInbound, SidecarOutbound, VoiceState } from "./messages";
import { LensIntent, attachmentText, lensPrompt } from "./prompts";
import { addAttachment, listAttachments, removeAttachment } from "./browser-context";
import { ApprovalDecision, cancelPendingApprovals, clearSessionApprovals, configureApprovals, resolveApproval, resumeTakeover } from "./approvals";
import * as agentLoop from "./agent-loop";
import * as conversation from "./conversation";
import { injectIntoActiveTab, syncContentScriptRegistration } from "./injection";
import { bridgeStatus, configureBridge, onKeepAliveAlarm, syncBridge } from "./bridge";
import { TraceEvent, clearTrace, configureTrace, onTrace, readTrace, record as traceRecord } from "./trace";
import { SETTINGS_KEY, loadSettings } from "./storage";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void syncContentScriptRegistration();
  void syncBridge();
});
chrome.runtime.onStartup.addListener(() => { void syncContentScriptRegistration(); void syncBridge(); });
chrome.alarms?.onAlarm.addListener((alarm) => onKeepAliveAlarm(alarm.name));
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command === "toggle-side-panel" && tab?.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[SETTINGS_KEY]) return;
  void syncContentScriptRegistration();
  void syncBridge();
});

configureTrace({ from: "background" });

const debugPorts = new Set<chrome.runtime.Port>();
// Espelha cada evento para quem estiver com o visor aberto, sem esperar o lote ir ao disco.
onTrace((event) => {
  for (const port of debugPorts) {
    try { port.postMessage({ type: "trace:event", event }); } catch { debugPorts.delete(port); }
  }
});

const sidecarPorts = new Set<chrome.runtime.Port>();
const broadcast = (message: SidecarInbound) => {
  for (const port of sidecarPorts) {
    try { port.postMessage(message); } catch { sidecarPorts.delete(port); }
  }
};

/** Aprovação e tomada de controle aparecem nas duas superfícies: painel e Pulse. */
const notifySurfaces = (message: SidecarInbound) => {
  broadcast(message);
  if (voiceMode === "off") return;
  if (message.type === "chat:approval") void notifyTabs({ type: "pulse:approval", id: message.request.id, summary: message.request.summary, detail: message.request.detail });
  if (message.type === "chat:approval-closed" || message.type === "chat:takeover-closed") void notifyTabs({ type: "pulse:cards-close" });
  if (message.type === "chat:takeover") void notifyTabs({ type: "pulse:takeover", reason: message.reason, expected: message.expected });
};

configureApprovals(notifySurfaces, () => sidecarPorts.size > 0 || voiceMode !== "off");

/** Um agente externo não é superfície de aprovação: ele não consegue responder ao cartão. Por isso
 *  a ponte só emite eventos para o painel, e o gate continua exigindo painel ou voz aberta. */
configureBridge({
  emit: (event) => notifySurfaces({ type: "chat:event", event }),
  ask: askAgent,
});

let keepAliveTimer = 0;
function ensureKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    if (!agentLoop.isRunning()) { clearInterval(keepAliveTimer); keepAliveTimer = 0; return; }
    void chrome.storage.session.get("vela:keepalive");
  }, 20_000) as unknown as number;
}

let voiceMode: "off" | "live" | "dictation" = "off";

async function ensureVoiceRuntime() {
  if (!chrome.offscreen) throw new Error("Esta versão do Chrome não oferece documento offscreen.");
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "Capturar e analisar áudio da voz enquanto a sidebar estiver fechada." });
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const pong = await chrome.runtime.sendMessage({ type: "voice:ping" }).catch(() => null) as { ok?: boolean } | null;
    if (pong?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("O runtime de voz não respondeu.");
}

const VOICE_LABEL: Record<string, string> = { idle: "Ocioso", listening: "Ouvindo", thinking: "Pensando", speaking: "Falando", paused: "Microfone mudo", error: "Erro" };

/** Telemetria a 20Hz vai só para a aba ativa; mandar para todas seria fan-out inútil. */
async function notifyActiveTab(message: unknown) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id) void chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
}

async function notifyTabs(message: unknown) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.flatMap((tab) => tab.id === undefined ? [] : [chrome.tabs.sendMessage(tab.id, message).catch(() => undefined)]));
}

function scriptMatches(patterns: string[], url: string) {
  if (/^(chrome|edge|about|devtools):/i.test(url)) return false;
  return patterns.some((pattern) => { if (pattern === "<all_urls>" || pattern === "*://*/*") return true; const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"); return new RegExp(`^${escaped}$`).test(url); });
}

async function runUserScript(scriptId: string, tabId: number) {
  const script = (await listScripts()).find((item) => item.id === scriptId);
  if (!script || !script.enabled) throw new Error("Script inexistente ou desativado.");
  if (!script.code.trim() || script.code.length > 250_000) throw new Error("O script precisa ter código e no máximo 250 KB.");
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !scriptMatches(parseMetadata(script.code).matches, tab.url)) throw new Error("O script não corresponde à URL atual.");
  return chrome.scripting.executeScript({ target: { tabId }, func: (source: string) => { const result = new Function(source)(); if (result === undefined) return "Executado."; try { return JSON.stringify(result); } catch { return String(result); } }, args: [script.code] });
}

async function publishSession() {
  const session = await getSession();
  broadcast({ type: "chat:session", title: session?.title ?? "", tabCount: session?.tabIds.length ?? 0 });
}

async function runTurn(text: string) {
  ensureKeepAlive();
  void ensureSession(text).then(publishSession);
  return agentLoop.submit(text, notifySurfaces);
}

/** Entrada da ponte MCP: um agente de fora descreve o objetivo e a Vela executa no navegador
 *  logado do usuário, com o mesmo loop, a mesma memória e o mesmo gate de autonomia. */
async function askAgent(prompt: string): Promise<string> {
  if (agentLoop.isRunning()) return "ERRO [falha] A Vela já está executando outra tarefa. Tente de novo quando ela terminar.";
  await runTurn(prompt);
  const messages = await conversation.all();
  const answer = [...messages].reverse().find((item: ChatMessage) => item.role === "assistant" && item.content.trim());
  return answer?.content ?? "A tarefa terminou sem resposta em texto.";
}

/**
 * Fala a resposta do turno que acabou — e só ela.
 *
 * Antes isto era "fale a última mensagem do assistente", sem saber se o turno tinha rendido uma.
 * Quando a fala chegava com a Vela ocupada, o turno era descartado em silêncio e ela **repetia a
 * resposta anterior**: você perguntava outra coisa e ouvia de novo o que já tinha ouvido.
 */
async function speakAnswerAfter(previousId: string | null) {
  const messages = await conversation.all();
  const last = [...messages].reverse().find((item: ChatMessage) => item.role === "assistant" && item.content.trim());
  if (!last || last.id === previousId) {
    // Turno que termina sem resposta — porque estourou o teto de etapas, por exemplo — deixava a
    // conversa em silêncio. Numa conversa falada, silêncio é lido como "não me ouviu", e a pessoa
    // repete o pedido, que abre outro turno, que estoura de novo. Foi o ciclo observado.
    traceRecord("voice", "turno sem resposta: avisei por voz", { from: "background", ok: false, code: "sem_resposta", data: { anterior: previousId } });
    void chrome.runtime.sendMessage({ type: "voice:speak", text: "Não consegui concluir essa. Quer que eu tente de outro jeito?" }).catch(() => undefined);
    return;
  }
  void chrome.runtime.sendMessage({ type: "voice:speak", text: last.content }).catch(() => undefined);
}

async function lastAnswerId(): Promise<string | null> {
  const messages = await conversation.all();
  return [...messages].reverse().find((item: ChatMessage) => item.role === "assistant" && item.content.trim())?.id ?? null;
}

/**
 * Falar por cima é uma instrução nova, não ruído.
 *
 * Numa conversa falada não existe "aguarde a vez": se a pessoa fala enquanto a Vela trabalha, é
 * porque quer corrigir o rumo. O turno em andamento é abortado e o novo entra no lugar — sem
 * isso, `submit` recusava calado e a fala se perdia inteira.
 */
async function speakTurn(text: string) {
  if (agentLoop.isRunning()) {
    traceRecord("voice", "interrompi o turno para atender a nova fala", { from: "background", data: { texto: text.slice(0, 200) } });
    cancelPendingApprovals();
    agentLoop.abort();
    void chrome.runtime.sendMessage({ type: "voice:speak-stop" }).catch(() => undefined);
    // O loop encerra de forma assíncrona — ele ainda está dentro do stream do modelo. Esperar o
    // fim de verdade evita que `submit` veja `running` e recuse a fala nova.
    const until = Date.now() + 3000;
    while (agentLoop.isRunning() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 60));
  }
  const previous = await lastAnswerId();
  const accepted = await runTurn(text);
  if (!accepted) {
    traceRecord("voice", "fala descartada: o turno anterior não encerrou", { from: "background", ok: false, code: "ocupada", data: { texto: text.slice(0, 200) } });
    return;
  }
  await speakAnswerAfter(previous);
}

/** Ler uma resposta em voz alta sobe o runtime de áudio sozinho: não faz sentido exigir que o
 *  Live Voice esteja ligado só para ouvir uma mensagem. */
async function speakText(text: string) {
  try {
    await ensureVoiceRuntime();
    void chrome.runtime.sendMessage({ type: "voice:speak", text }).catch(() => undefined);
  } catch (error) {
    broadcast({ type: "voice:error", message: error instanceof Error ? error.message : "Não consegui iniciar a leitura." });
    broadcast({ type: "chat:speaking", speaking: false });
  }
}

async function stopSpeaking() {
  void chrome.runtime.sendMessage({ type: "voice:speak-stop" }).catch(() => undefined);
  broadcast({ type: "chat:speaking", speaking: false });
  if (voiceMode === "off") await chrome.offscreen?.closeDocument().catch(() => undefined);
}

/**
 * Editar, reenviar e gerar outra resposta são a mesma operação: a linha do tempo volta a um
 * ponto e segue de lá. Anexar a correção ao fim deixaria o histórico contraditório — o modelo
 * leria o pedido antigo e o novo como duas instruções.
 */
async function rewind(id: string, text?: string) {
  if (agentLoop.isRunning()) { cancelPendingApprovals(); agentLoop.abort(); }
  const target = await conversation.messageById(id);
  if (!target) return;
  const anchor = target.role === "user" ? target : await conversation.previousUserMessage(id);
  if (!anchor) return;
  const prompt = (text ?? anchor.content).trim();
  if (!prompt) return;
  await conversation.truncateFrom(anchor.id);
  broadcast({ type: "chat:snapshot", ...(await agentLoop.snapshot()) });
  await runTurn(prompt);
}

async function startVoice(mode: "live" | "dictation") {
  try {
    await ensureVoiceRuntime();
    voiceMode = mode;
    void chrome.runtime.sendMessage({ type: "voice:start", mode }).catch(() => undefined);
    if (mode === "live") {
      // A preferência viaja junto: o content script não lê settings, e pedir depois deixaria o
      // Pulse aparecendo com um visual e trocando para outro na frente do usuário.
      const settings = await loadSettings();
      if (settings.voice.showPulse) void notifyTabs({ type: "pulse:show", state: "Ouvindo", visual: settings.voice.visual, shader: settings.voice.customShader });
    }
  } catch (error) {
    voiceMode = "off";
    broadcast({ type: "voice:error", message: error instanceof Error ? error.message : "Falha ao iniciar a voz." });
  }
}

async function stopVoice() {
  voiceMode = "off";
  await chrome.runtime.sendMessage({ type: "voice:stop" }).catch(() => undefined);
  await chrome.offscreen?.closeDocument().catch(() => undefined);
  void notifyTabs({ type: "pulse:hide" });
  broadcast({ type: "voice:state", state: "idle" });
}

async function applySidecarMessage(message: SidecarOutbound) {
  if (message.type === "chat:submit") return runTurn(message.text);
  if (message.type === "chat:abort") { cancelPendingApprovals(); agentLoop.abort(); return; }
  if (message.type === "chat:new") {
    cancelPendingApprovals();
    clearSessionApprovals();
    await agentLoop.reset();
    await endSession();
    broadcast({ type: "chat:reset" });
    await publishSession();
    return;
  }
  if (message.type === "chat:history-request") { broadcast({ type: "chat:history", items: await conversation.list() }); return; }
  if (message.type === "chat:open") {
    if (!(await conversation.open(message.id))) return;
    cancelPendingApprovals();
    agentLoop.abort();
    broadcast({ type: "chat:snapshot", ...(await agentLoop.snapshot()) });
    return;
  }
  if (message.type === "chat:rewind") return rewind(message.id, message.text);
  if (message.type === "chat:speak") return speakText(message.text);
  if (message.type === "chat:speak-stop") return stopSpeaking();
  if (message.type === "chat:attach") {
    const header = `Arquivo anexado “${message.name}”:`;
    broadcast({ type: "chat:attachments", items: await addAttachment(`${header}\n${message.text}`) });
    broadcast({ type: "chat:event", event: { kind: "status", text: `Anexei “${message.name}” ao contexto.` } });
    return;
  }
  if (message.type === "chat:detach") { broadcast({ type: "chat:attachments", items: await removeAttachment(message.index) }); return; }
  if (message.type === "approval:resolve") return resolveApproval(message.id, message.decision);
  if (message.type === "takeover:resume") return resumeTakeover();
  if (message.type === "session:rename") { await renameSession(message.title); await publishSession(); return; }
  if (message.type === "voice:start-live") return startVoice("live");
  if (message.type === "voice:start-dictation") return startVoice("dictation");
  if (message.type === "voice:stop-live") return stopVoice();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "vela:debug") {
    debugPorts.add(port);
    void readTrace({ limit: 3000 }).then((events: TraceEvent[]) => {
      try { port.postMessage({ type: "trace:snapshot", events }); } catch { debugPorts.delete(port); }
    });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; debugPorts.delete(port); });
    return;
  }
  if (port.name !== SIDECAR_PORT) return;
  sidecarPorts.add(port);
  void injectIntoActiveTab();
  void (async () => {
    try {
      port.postMessage({ type: "chat:snapshot", ...(await agentLoop.snapshot()) } satisfies SidecarInbound);
      port.postMessage({ type: "chat:attachments", items: await listAttachments() } satisfies SidecarInbound);
      const session = await getSession();
      port.postMessage({ type: "chat:session", title: session?.title ?? "", tabCount: session?.tabIds.length ?? 0 } satisfies SidecarInbound);
    } catch { sidecarPorts.delete(port); }
  })();
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; sidecarPorts.delete(port); });
  port.onMessage.addListener((raw) => { void applySidecarMessage(raw as SidecarOutbound); });
});

async function runLensAction(payload: { intent: LensIntent; text: string; url: string; title: string }) {
  if (payload.intent === "context") {
    broadcast({ type: "chat:attachments", items: await addAttachment(attachmentText(payload)) });
    broadcast({ type: "chat:event", event: { kind: "status", text: "Trecho anexado ao contexto." } });
    return;
  }
  const prompt = lensPrompt(payload);
  if (payload.intent === "ask") { broadcast({ type: "chat:prefill", text: prompt }); return; }
  await runTurn(prompt);
}

// Abas abertas pelo agente entram na sessão; window.open e target=_blank também.
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => { void adoptTab(details.tabId).then(publishSession); });
chrome.tabs.onRemoved.addListener((tabId) => { void forgetTab(tabId).then(publishSession); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.groupId === undefined) return;
  void getSession().then((session) => { if (session && changeInfo.groupId === session.groupId) void adoptTab(tabId).then(publishSession); });
});

chrome.runtime.onMessage.addListener((message: { type: string; tabId?: number; title?: string; message?: string; text?: string; url?: string; intent?: string; state?: string; scriptId?: string; id?: string; decision?: string; telemetry?: { metrics?: unknown; state?: string }; entry?: unknown }, _sender, sendResponse) => {
  if (message.type === "lens:action" && message.text) {
    void runLensAction({ intent: (message.intent ?? "context") as LensIntent, text: message.text, url: message.url ?? "", title: message.title ?? "" });
  }
  if (message.type === "agent:pause") { cancelPendingApprovals(); agentLoop.abort(); }
  if (message.type === "bridge:status") { sendResponse(bridgeStatus()); return true; }
  if (message.type === "trace:clear") { void clearTrace(); return false; }
  if (message.type === "trace:push" && message.entry) {
    const entry = message.entry as { kind: string; label: string; from?: string; data?: Record<string, unknown>; ok?: boolean; ms?: number };
    traceRecord(entry.kind as Parameters<typeof traceRecord>[0], entry.label, { from: entry.from ?? "desconhecido", data: entry.data, ok: entry.ok, ms: entry.ms });
    return false;
  }
  if (message.type === "script:run" && message.scriptId && message.tabId !== undefined) {
    void runUserScript(message.scriptId, message.tabId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Falha ao executar script." }));
    return true;
  }
  if (message.type === "voice:state" && message.state) {
    broadcast({ type: "voice:state", state: message.state as VoiceState });
    if (voiceMode === "live") void notifyTabs({ type: "pulse:set-state", motion: message.state, state: VOICE_LABEL[message.state] ?? "Vela" });
  }
  if (message.type === "voice:telemetry" && (voiceMode === "live" || message.telemetry?.state === "speaking")) {
    void notifyActiveTab({ type: "pulse:metrics", metrics: message.telemetry?.metrics });
  }
  if (message.type === "pulse:approval-resolve" && message.id && message.decision) resolveApproval(message.id, message.decision as ApprovalDecision);
  if (message.type === "pulse:takeover-resume") resumeTakeover();
  if (message.type === "voice:error" && message.message) broadcast({ type: "voice:error", message: message.message });
  // O parcial é rascunho: aparece no palco e na janelinha, e nunca chama `speakTurn`.
  if (message.type === "voice:partial" && message.text && voiceMode === "live") {
    broadcast({ type: "voice:partial", text: message.text });
    void notifyActiveTab({ type: "pulse:transcript", text: message.text });
  }
  if (message.type === "voice:transcript" && message.text) {
    const text = message.text;
    if (voiceMode === "live") { void notifyActiveTab({ type: "pulse:transcript", text }); void speakTurn(text); }
    else broadcast({ type: "voice:transcript", text });
  }
  return false;
});
