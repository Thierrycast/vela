import { ChatMessage } from "./types";
import { adoptTab, endSession, ensureSession, forgetTab, getSession, renameSession } from "./session";
import { evictFrame, evictTab } from "./ref-registry";
import { listScripts } from "./script-store";
import { parseMetadata } from "./user-script";
import { SIDECAR_PORT, SidecarInbound, SidecarOutbound, VoiceState } from "./messages";
import { LensIntent, attachmentText, lensPrompt } from "./prompts";
import { addAttachment, listAttachments, removeAttachment } from "./browser-context";
import { ApprovalDecision, ApprovalRequest, cancelPendingApprovals, clearSessionApprovals, configureApprovals, resolveApproval, resumeTakeover } from "./approvals";
import * as agentLoop from "./agent-loop";
import * as conversation from "./conversation";
import { injectIntoActiveTab, syncContentScriptRegistration } from "./injection";
import { bridgeStatus, configureBridge, onKeepAliveAlarm, syncBridge } from "./bridge";
import { TraceEvent, clearTrace, configureTrace, onTrace, readTrace, record as traceRecord } from "./trace";
import { clearBlobs } from "./trace-blobs";
import { criarNarrador } from "./voice-narrator";
import { SETTINGS_KEY, loadSettings, saveSettings } from "./storage";

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

/**
 * Entrega uma aprovação ou tomada de controle e devolve quantas superfícies aceitaram.
 *
 * São três, em ordem de preferência:
 *
 * 1. **O painel**, quando aberto — é onde a conversa está.
 * 2. **O Pulse, na aba que está sendo operada.** Antes isto só acontecia com a voz ligada, o que
 *    era uma confusão entre superfície e modo: o Pulse é a UI da página, não um acessório da voz.
 *    Com o painel fechado e a voz desligada, a ação era recusada por `unattended` mesmo com uma
 *    aba ali, capaz de mostrar o cartão, e onde a Vela estava agindo naquele instante.
 * 3. **Notificação do Chrome**, só quando as duas primeiras falham — página restrita, `chrome://`,
 *    Web Store, onde nenhum content script entra.
 */
/** O painel está aberto agora? Enquanto houver porta viva, ele é a superfície da vez. */
const painelAberto = () => sidecarPorts.size > 0;

const notifySurfaces = async (message: SidecarInbound): Promise<number> => {
  broadcast(message);
  let surfaces = sidecarPorts.size;

  if (message.type === "chat:approval") {
    surfaces += await notifyTabsCounting({ type: "pulse:approval", id: message.request.id, summary: message.request.summary, detail: message.request.detail });
    if (!surfaces) surfaces += await notifyByNotification(message.request);
  }
  if (message.type === "chat:takeover") {
    surfaces += await notifyTabsCounting({ type: "pulse:takeover", reason: message.reason, expected: message.expected });
  }
  if (message.type === "chat:approval-closed" || message.type === "chat:takeover-closed") {
    void notifyTabs({ type: "pulse:cards-close" });
    if (message.type === "chat:approval-closed") clearApprovalNotification(message.id);
  }
  return surfaces;
};

/**
 * A última superfície. Vive fora do navegador, então funciona em página restrita — e é o único
 * caminho quando a Vela age numa aba onde nenhum script dela pode entrar.
 */
const approvalNotifications = new Map<string, string>();

async function notifyByNotification(request: ApprovalRequest): Promise<number> {
  if (!chrome.notifications) return 0;
  try {
    const notificationId = await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "A Vela precisa de aprovação",
      message: request.summary,
      contextMessage: request.detail.slice(0, 120),
      requireInteraction: true,
      buttons: [{ title: "Permitir" }, { title: "Recusar" }],
    });
    approvalNotifications.set(notificationId, request.id);
    return 1;
  } catch {
    // Notificação bloqueada pelo sistema. Não há mais superfície: quem chamou decide o que fazer.
    return 0;
  }
}

/** Sem isto sobra um cartão morto na bandeja, aceitando clique em algo que já foi decidido. */
function clearApprovalNotification(approvalId: string) {
  for (const [notificationId, id] of approvalNotifications) {
    if (id !== approvalId) continue;
    approvalNotifications.delete(notificationId);
    void chrome.notifications?.clear(notificationId);
  }
}

chrome.notifications?.onButtonClicked.addListener((notificationId, buttonIndex) => {
  const approvalId = approvalNotifications.get(notificationId);
  if (!approvalId) return;
  approvalNotifications.delete(notificationId);
  void chrome.notifications.clear(notificationId);
  resolveApproval(approvalId, buttonIndex === 0 ? "allow" : "deny");
});

// Fechar a notificação sem escolher é uma resposta: a ação não foi autorizada.
chrome.notifications?.onClosed.addListener((notificationId) => {
  const approvalId = approvalNotifications.get(notificationId);
  if (!approvalId) return;
  approvalNotifications.delete(notificationId);
  resolveApproval(approvalId, "deny");
});

configureApprovals(notifySurfaces);

/** Um agente externo não é superfície de aprovação: ele não consegue responder ao cartão. A ponte
 *  só emite eventos, e quem decide continua sendo painel, Pulse ou notificação. */
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
/** Último estado publicado pela voz: é o rótulo que a janelinha mostra ao (re)aparecer. */
let voiceState = "idle";

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

/**
 * Como `notifyTabs`, mas conta quantas abas de fato receberam.
 *
 * `sendMessage` rejeita com "Receiving end does not exist" quando não há content script na aba —
 * página restrita, Web Store, aba onde a Vela nunca entrou. Essa rejeição é justamente o sinal de
 * que ali ninguém veria o cartão, e é o que separa "entreguei" de "achei que tinha entregue".
 *
 * A aba ativa vem primeiro porque é onde a atenção está; a ordem não muda a contagem, mas muda
 * qual cartão a pessoa vê aparecer.
 */
async function notifyTabsCounting(message: unknown): Promise<number> {
  const tabs = await chrome.tabs.query({});
  const ordenadas = [...tabs].sort((left, right) => Number(right.active) - Number(left.active));
  const entregues = await Promise.all(ordenadas.map(async (tab) => {
    if (tab.id === undefined) return 0;
    try { await chrome.tabs.sendMessage(tab.id, message); return 1; } catch { return 0; }
  }));
  return entregues.reduce<number>((total, item) => total + item, 0);
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

/**
 * De onde veio o que entrou.
 *
 * O mesmo texto pode ter sido digitado, falado, selecionado numa página pelo Lens ou mandado por
 * outro agente pela ponte. Numa revisão isso muda tudo — uma frase estranha vinda da transcrição é
 * problema de STT, a mesma frase digitada é problema de intenção — e o turno não guardava essa
 * diferença em lugar nenhum.
 */
type Origem = "texto" | "voz" | "lens" | "ponte" | "atalho";

async function runTurn(text: string, useFastModel = false, origem: Origem = "texto", enunciado?: string, emit: (message: SidecarInbound) => unknown = notifySurfaces) {
  ensureKeepAlive();
  void ensureSession(text).then(publishSession);
  return agentLoop.submit(text, emit as typeof notifySurfaces, { useFastModel, origem, enunciado });
}

/** Entrada da ponte MCP: um agente de fora descreve o objetivo e a Vela executa no navegador
 *  logado do usuário, com o mesmo loop, a mesma memória e o mesmo gate de autonomia. */
async function askAgent(prompt: string): Promise<string> {
  if (agentLoop.isRunning()) return "ERRO [falha] A Vela já está executando outra tarefa. Tente de novo quando ela terminar.";
  await runTurn(prompt, false, "ponte");
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
async function speakAnswerAfter(previousId: string | null, narrador?: ReturnType<typeof criarNarrador>, interrompido = false) {
  const messages = await conversation.all();
  const last = [...messages].reverse().find((item: ChatMessage) => item.role === "assistant" && item.content.trim());
  /*
   * Turno interrompido não anuncia fracasso.
   *
   * Quem interrompe foi a própria pessoa falando de novo — e o pedido novo já está sendo processado.
   * Dizer "não consegui concluir essa" aí é mentira dupla: ela não falhou, e o que ela estava
   * fazendo muitas vezes já tinha dado certo. Foi exatamente o que se ouviu na sessão de teste,
   * depois de uma transcrição de ruído abrir um turno por cima do que estava em andamento.
   */
  if (interrompido) {
    traceRecord("voice", "turno interrompido: nada a falar", { from: "background", data: { anterior: previousId } });
    return;
  }
  if (!last || last.id === previousId) {
    // Turno que termina sem resposta — porque estourou o teto de etapas, por exemplo — deixava a
    // conversa em silêncio. Numa conversa falada, silêncio é lido como "não me ouviu", e a pessoa
    // repete o pedido, que abre outro turno, que estoura de novo. Foi o ciclo observado.
    traceRecord("voice", "turno sem resposta: avisei por voz", { from: "background", ok: false, code: "sem_resposta", data: { anterior: previousId } });
    void chrome.runtime.sendMessage({ type: "voice:speak", text: "Não consegui concluir essa. Quer que eu tente de outro jeito?" }).catch(() => undefined);
    return;
  }
  if (!narrador) { void chrome.runtime.sendMessage({ type: "voice:speak", text: last.content }).catch(() => undefined); return; }
  // O que a narração já falou não se repete: só o fim que ainda não tinha fechado em frase, na fila,
  // depois do que já está tocando.
  const restante = narrador.restante(last.id, last.content);
  if (restante) void chrome.runtime.sendMessage({ type: "voice:speak-queue", text: restante }).catch(() => undefined);
}

/** Conta os turnos abertos pela voz: o turno que não é o último não fala mais nada. */
let turnoDaVoz = 0;

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
async function speakTurn(text: string, enunciado?: string) {
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
  const meuTurno = ++turnoDaVoz;
  const previous = await lastAnswerId();
  const narrador = criarNarrador((frase) => { void chrome.runtime.sendMessage({ type: "voice:speak-queue", text: frase }).catch(() => undefined); });
  const comNarracao = (message: SidecarInbound) => {
    if (message.type === "chat:delta") narrador.pedaco(message.id, message.text);
    /*
     * A resposta que já estava sendo falada foi descartada pelo loop (desistência do modelo rápido).
     * Sem emenda, a pessoa ouviria o começo de uma resposta e, em seguida, outra resposta diferente,
     * sem nada explicando o corte. Uma frase curta cobre o intervalo e é honesta sobre o que houve.
     */
    if (message.type === "chat:descartada" && narrador.jaFalou(message.id)) {
      narrador.esquecer(message.id);
      void chrome.runtime.sendMessage({ type: "voice:speak-queue", text: "Deixa eu tentar de outro jeito." }).catch(() => undefined);
    }
    return notifySurfaces(message);
  };
  const accepted = await runTurn(text, voiceMode === "live", "voz", enunciado, comNarracao);
  if (!accepted) {
    traceRecord("voice", "fala descartada: o turno anterior não encerrou", { from: "background", ok: false, code: "ocupada", data: { texto: text.slice(0, 200) } });
    return;
  }
  // Se outra fala abriu um turno enquanto este rodava, quem fala é o novo — este cala.
  await speakAnswerAfter(previous, narrador, meuTurno !== turnoDaVoz);
}

/** Ler uma resposta em voz alta sobe o runtime de áudio sozinho: não faz sentido exigir que o
 *  Live Voice esteja ligado só para ouvir uma mensagem. */
async function speakText(text: string, id?: string) {
  try {
    await ensureVoiceRuntime();
    void chrome.runtime.sendMessage({ type: "voice:speak", text, id }).catch(() => undefined);
  } catch (error) {
    broadcast({ type: "voice:error", message: error instanceof Error ? error.message : "Não consegui iniciar a leitura." });
    broadcast({ type: "chat:speaking", speaking: false });
  }
}

async function stopSpeaking() {
  void chrome.runtime.sendMessage({ type: "voice:speak-stop" }).catch(() => undefined);
  broadcast({ type: "chat:speaking", speaking: false });
  if (voiceMode === "off") {
    await chrome.offscreen?.closeDocument().catch(() => undefined);
    /*
     * Fechar o offscreen mata quem publicaria o `idle`: o `finally` de `speak()` nunca roda num
     * documento destruído. O painel ficava em "speaking" para sempre, e o orb da leitura continuava
     * na tela depois de a pessoa ter parado. Quem fechou é quem avisa.
     */
    broadcast({ type: "voice:state", state: "idle" });
  }
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

async function mostrarPulseSePrecisa() {
  const settings = await loadSettings();
  if (!settings.voice.showPulse) return;
  void notifyTabs({ type: "pulse:show", state: VOICE_LABEL[voiceState] ?? "Ouvindo", visual: settings.voice.visual, shader: settings.voice.customShader });
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
      /*
       * A janelinha é a superfície de quem está **sem** o painel.
       *
       * Com o painel aberto, ela é a mesma coisa duas vezes na tela — o orb, o estado e o rascunho
       * aparecem nos dois lugares, e a página fica com um retângulo por cima à toa. Ela entra quando
       * o painel fecha (ver `mostrarPulseSePrecisa`) e sai quando ele volta.
       */
      if (settings.voice.showPulse && !painelAberto()) void notifyTabs({ type: "pulse:show", state: "Ouvindo", visual: settings.voice.visual, shader: settings.voice.customShader });
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
  // Encerrar a voz com a gravação ligada é o jeito mais comum de parar de gravar: o offscreen
  // entrega o pacote no `voice:stop`, e o nível de rastreio precisa voltar junto.
  await devolverRastreio();
  void notifyTabs({ type: "pulse:hide" });
  broadcast({ type: "voice:state", state: "idle" });
}

async function applySidecarMessage(message: SidecarOutbound) {
  if (message.type === "chat:submit") return runTurn(message.text);
  if (message.type === "chat:abort") { cancelPendingApprovals(); agentLoop.abortAll(); return; }
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
    // Trocar de conversa leva junto o que rodava em segundo plano: o resultado cairia na outra.
    agentLoop.abortAll();
    broadcast({ type: "chat:snapshot", ...(await agentLoop.snapshot()) });
    return;
  }
  if (message.type === "chat:forget") {
    const { existia, eraAtiva } = await conversation.remove(message.id);
    if (!existia) return;
    // Apagar a conversa aberta deixaria a tela mostrando mensagens que já não existem: o laço
    // precisa recarregar da conversa que passou a ser a ativa antes de republicar o retrato.
    if (eraAtiva) { cancelPendingApprovals(); agentLoop.abortAll(); broadcast({ type: "chat:snapshot", ...(await agentLoop.snapshot()) }); await publishSession(); }
    broadcast({ type: "chat:history", items: await conversation.list() });
    broadcast({ type: "chat:event", event: { kind: "status", text: "Conversa apagada." } });
    return;
  }
  if (message.type === "chat:rewind") return rewind(message.id, message.text);
  if (message.type === "chat:speak") return speakText(message.text, message.id);
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
  if (message.type === "voice:debug-start") {
    if (voiceMode === "off") { broadcast({ type: "voice:error", message: "Ligue o Live Voice ou o ditado antes de gravar a sessão de depuração." }); return; }
    await ligarRastreioCompleto();
    void chrome.runtime.sendMessage({ type: "voice:debug-start" }).catch(() => undefined);
    return;
  }
  if (message.type === "voice:debug-stop") {
    void chrome.runtime.sendMessage({ type: "voice:debug-stop" }).catch(() => undefined);
    await devolverRastreio();
    return;
  }
}

/*
 * Gravar a sessão pelo botão do palco é ligar o mesmo interruptor de Avançado, não um segundo modo.
 *
 * Um botão que grava "quase tudo" e um interruptor que grava "tudo" seriam duas verdades sobre a
 * mesma sessão, e quem revisa nunca saberia qual delas está olhando. Ao parar, o nível volta ao que
 * a pessoa tinha escolhido — deixar o rastreio completo ligado sem ela saber custaria disco e
 * guardaria conteúdo de página que ela não pediu para guardar.
 */
/*
 * O nível anterior mora no `storage.session`, não numa variável.
 *
 * O service worker dorme e acorda no meio de uma sessão de voz longa; guardado em memória, o valor
 * a restaurar sumia junto, e o rastreio completo ficava ligado para sempre sem ninguém ter pedido.
 */
const RASTREIO_ANTERIOR = "vela:rastreio-anterior";

async function ligarRastreioCompleto() {
  const settings = await loadSettings();
  const jaGuardado = (await chrome.storage.session.get(RASTREIO_ANTERIOR))[RASTREIO_ANTERIOR];
  // Apertar gravar duas vezes não pode trocar o "anterior" por "ligado": aí nada voltaria.
  if (jaGuardado === undefined) await chrome.storage.session.set({ [RASTREIO_ANTERIOR]: settings.agent.fullTrace });
  if (settings.agent.fullTrace) return;
  await saveSettings({ ...settings, agent: { ...settings.agent, fullTrace: true } });
  configureTrace({ detail: "completo" });
}

async function devolverRastreio() {
  const anterior = (await chrome.storage.session.get(RASTREIO_ANTERIOR))[RASTREIO_ANTERIOR];
  await chrome.storage.session.remove(RASTREIO_ANTERIOR);
  if (anterior !== false) return;
  const settings = await loadSettings();
  await saveSettings({ ...settings, agent: { ...settings.agent, fullTrace: false } });
  configureTrace({ detail: "normal" });
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
  // O painel voltou: a janelinha sai de cena, senão a mesma conversa fica em dois lugares.
  void notifyTabs({ type: "pulse:hide" });
  void injectIntoActiveTab();
  void (async () => {
    try {
      port.postMessage({ type: "chat:snapshot", ...(await agentLoop.snapshot()) } satisfies SidecarInbound);
      port.postMessage({ type: "chat:attachments", items: await listAttachments() } satisfies SidecarInbound);
      const session = await getSession();
      port.postMessage({ type: "chat:session", title: session?.title ?? "", tabCount: session?.tabIds.length ?? 0 } satisfies SidecarInbound);
    } catch { sidecarPorts.delete(port); }
  })();
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    sidecarPorts.delete(port);
    // Fechou o painel no meio de uma conversa falada: agora a janelinha é a única superfície.
    if (!painelAberto() && voiceMode === "live") void mostrarPulseSePrecisa();
  });
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
  await runTurn(prompt, false, "lens");
}

// Abas abertas pelo agente entram na sessão; window.open e target=_blank também — mas só quando
// nascem de uma aba que já estava no grupo. Sem checar a origem, um ctrl+click em qualquer link,
// em qualquer aba do navegador, puxava a aba nova para dentro do grupo da Vela.
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  void getSession().then((session) => { if (session?.tabIds.includes(details.sourceTabId)) void adoptTab(details.tabId).then(publishSession); });
});
chrome.tabs.onRemoved.addListener((tabId) => { void evictTab(tabId); void forgetTab(tabId).then(publishSession); });

/*
 * Documento trocado: os refs daquele frame morrem junto com ele.
 *
 * `onCommitted` é a granularidade certa. Navegação de SPA passa por `onHistoryStateUpdated`, onde
 * o documento e o content script continuam vivos — e, com refs por elemento, os refs continuam
 * válidos. Invalidar ali seria jogar fora o ganho inteiro: era exatamente o que o modelo antigo
 * fazia a cada clique que mexesse no DOM.
 */
chrome.webNavigation.onCommitted.addListener((details) => { void evictFrame(details.tabId, details.frameId, details.url); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.groupId === undefined) return;
  void getSession().then((session) => { if (session && changeInfo.groupId === session.groupId) void adoptTab(tabId).then(publishSession); });
});

chrome.runtime.onMessage.addListener((message: { type: string; tabId?: number; title?: string; message?: string; text?: string; url?: string; intent?: string; state?: string; scriptId?: string; id?: string; decision?: string; telemetry?: { metrics?: unknown; state?: string }; entry?: unknown; recording?: boolean; items?: number; enunciado?: string }, _sender, sendResponse) => {
  if (message.type === "lens:action" && message.text) {
    void runLensAction({ intent: (message.intent ?? "context") as LensIntent, text: message.text, url: message.url ?? "", title: message.title ?? "" });
  }
  if (message.type === "agent:pause") { cancelPendingApprovals(); agentLoop.abortAll(); }
  if (message.type === "bridge:status") { sendResponse(bridgeStatus()); return true; }
  /*
   * O documento offscreen só enxerga `chrome.runtime` — `chrome.storage` não existe lá.
   *
   * `loadSettings()` chamado de dentro dele devolvia os padrões em silêncio, e a voz inteira rodava
   * com eles: servidor, modelo de transcrição, voz, velocidade e o nível de rastreio. Trocar a voz
   * nas Configurações não mudava nada, e o rastreio completo nunca gravava áudio — porque quem
   * decide isso estava lendo um objeto que nunca saiu de fábrica.
   */
  if (message.type === "settings:get") { void loadSettings().then(sendResponse); return true; }
  // Áudio some junto: metade de um registro é pior que nenhum, porque o relatório continua
  // citando arquivos que não existem mais.
  if (message.type === "trace:clear") { void Promise.all([clearTrace(), clearBlobs()]); return false; }
  /*
   * O evento de outra superfície chega inteiro, ou não chega.
   *
   * Aqui só passavam kind, label, data, ok e ms. Tudo o que costura — a rodada, a chamada, a ação —
   * e o `blobId` que liga um evento ao áudio ficavam para trás, então a conversa falada, que é toda
   * gravada no offscreen, virava uma lista de eventos soltos com o relatório citando arquivos que
   * ele não tinha como apontar. O `code` seguia o mesmo caminho: o motivo de um descarte sumia.
   */
  if (message.type === "trace:push" && message.entry) {
    const entry = message.entry as { kind: string; label: string; from?: string; data?: Record<string, unknown>; ok?: boolean; ms?: number; code?: string; round?: number; callId?: string; actionId?: string; blobId?: string };
    traceRecord(entry.kind as Parameters<typeof traceRecord>[0], entry.label, {
      from: entry.from ?? "desconhecido",
      data: entry.data,
      ok: entry.ok,
      ms: entry.ms,
      code: entry.code,
      round: entry.round,
      callId: entry.callId,
      actionId: entry.actionId,
      blobId: entry.blobId,
    });
    return false;
  }
  if (message.type === "script:run" && message.scriptId && message.tabId !== undefined) {
    void runUserScript(message.scriptId, message.tabId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Falha ao executar script." }));
    return true;
  }
  if (message.type === "voice:state" && message.state) {
    voiceState = String(message.state);
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
    if (voiceMode === "live") { void notifyActiveTab({ type: "pulse:transcript", text }); void speakTurn(text, message.enunciado); }
    else broadcast({ type: "voice:transcript", text });
  }
  if (message.type === "voice:debug-state") broadcast({ type: "voice:debug-state", recording: !!message.recording, items: Number(message.items) || 0 });
  return false;
});
