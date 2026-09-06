import { ActionResult, Autonomy, BrowserAction } from "./types";
import { isPdf, isRestrictedUrl, restrictionReason, waitForContentScript, waitForNavigation } from "./navigation";
import { loadSettings } from "./storage";
import { approvalKey, describeAction, isRisky, requestApproval } from "./approvals";
import { span } from "./trace";
import { adoptTab } from "./session";

const READ_ONLY: Array<BrowserAction["type"]> = ["extractPage", "scroll", "wait"];
const NO_CURSOR: Array<BrowserAction["type"]> = ["pageTool"];
const TIMEOUTS: Record<BrowserAction["type"], number> = { extractPage: 12_000, click: 8_000, type: 12_000, keyPress: 6_000, scroll: 5_000, wait: 14_000, navigate: 20_000, pageTool: 20_000 };

export const isReadOnly = (action: BrowserAction) => READ_ONLY.includes(action.type);

const failure = (code: Extract<ActionResult, { ok: false }>["code"], summary: string): ActionResult => ({ ok: false, code, summary });

const tracedTabs = new Set<number>();

/** A borda e a pílula são estado de sessão, não de ação — senão piscam a cada passo. */
async function beginTrace(tabId: number) {
  if (tracedTabs.has(tabId)) return;
  tracedTabs.add(tabId);
  try { await chrome.tabs.sendMessage(tabId, { type: "trace:session", state: "start", trace: await traceConfig() }); } catch { tracedTabs.delete(tabId); }
}

export async function endTraceSessions() {
  for (const tabId of tracedTabs) {
    try { await chrome.tabs.sendMessage(tabId, { type: "trace:session", state: "stop" }); } catch { /* aba fechada */ }
  }
  tracedTabs.clear();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

async function sendToTab(tabId: number, message: unknown, timeoutMs: number, frameId = 0): Promise<ActionResult> {
  const attempt = () => chrome.tabs.sendMessage(tabId, message, { frameId }) as Promise<ActionResult>;
  const withTimeout = (promise: Promise<ActionResult>) => Promise.race([
    promise,
    new Promise<ActionResult>((resolve) => setTimeout(() => resolve(failure("timeout", `A página não respondeu em ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs)),
  ]);
  try {
    return await withTimeout(attempt());
  } catch {
    const ready = await waitForContentScript(tabId, 4);
    if (!ready) return failure("no_content_script", "A Vela não consegue agir nesta página (script de conteúdo indisponível).");
    try { return await withTimeout(attempt()); } catch (error) { return failure("no_content_script", error instanceof Error ? error.message : "Falha ao falar com a página."); }
  }
}

const FRAME_REF = /^f(\d+)\.(ref_\d+_\d+)$/;

/** Índices são por frame; sem o prefixo, ref_1_3 do topo colidiria com ref_1_3 de um iframe. */
function splitFrameRef(ref: string | undefined): { frameId: number; ref: string | undefined } {
  if (!ref) return { frameId: 0, ref: undefined };
  const match = FRAME_REF.exec(ref);
  return match ? { frameId: Number(match[1]), ref: match[2] } : { frameId: 0, ref };
}

/** Checkout, login e captcha vivem em iframes de outra origem: sem ler todos, o agente é cego. */
async function readAllFrames(tabId: number, action: Extract<BrowserAction, { type: "extractPage" }>): Promise<ActionResult> {
  let frames: Array<{ frameId: number; url: string }> = [];
  try { frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? []; } catch { /* sem permissão nesta aba */ }
  const usable = frames.filter((frame) => !isRestrictedUrl(frame.url)).slice(0, 10);
  if (!usable.length) usable.push({ frameId: 0, url: "" });

  const parts: string[] = [];
  let total = 0;
  let anySuccess = false;

  for (const frame of usable) {
    const result = await sendToTab(tabId, { type: "agent:action", action, actionId: crypto.randomUUID() }, TIMEOUTS.extractPage, frame.frameId);
    if (!result?.ok || !result.content) continue;
    anySuccess = true;
    const labelled = result.content.replace(/\[(ref_\d+_\d+)\]/g, (_full, ref: string) => `[f${frame.frameId}.${ref}]`);
    parts.push(frame.frameId === 0 ? labelled : `\n--- iframe f${frame.frameId} (${safeHost(frame.url)}) ---\n${labelled}`);
    total += 1;
  }

  if (!anySuccess) return failure("no_content_script", "Não consegui ler nenhum frame desta página.");
  return { ok: true, summary: `Página lida em ${total} frame(s).`, content: parts.join("\n") };
}

function safeHost(url: string) {
  try { return new URL(url).host; } catch { return url.slice(0, 40); }
}

function originOf(url: string | undefined) {
  try { return url ? new URL(url).origin : "página desconhecida"; } catch { return "página desconhecida"; }
}

async function targetLabel(tabId: number, action: BrowserAction) {
  if (!("ref" in action) && !("selector" in action)) return "";
  const { frameId, ref } = splitFrameRef("ref" in action ? action.ref : undefined);
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "agent:describe", action: { ...action, ref } }, { frameId }) as Promise<{ label?: string }>,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 800)),
    ]);
    return response?.label ?? "";
  } catch { return ""; }
}

export async function executeAction(action: BrowserAction, autonomy: Autonomy): Promise<ActionResult> {
  const actionSpan = span("action", action.type, { action });
  const result = await runAction(action, autonomy);
  actionSpan.end({
    ok: result.ok,
    code: result.ok ? undefined : result.code,
    data: { action, summary: result.summary, noEffect: result.ok && result.summary.includes("sem efeito perceptível") },
  });
  return result;
}

async function runAction(action: BrowserAction, autonomy: Autonomy): Promise<ActionResult> {
  const denied = autonomy === "observe" && !isReadOnly(action);
  const tab = await activeTab();
  if (!tab?.id) return failure("no_tab", "Nenhuma aba ativa disponível.");

  // Recusas baratas vêm antes da aprovação: não faz sentido consultar o usuário
  // sobre uma ação que já vai falhar por causa da página.
  if (action.type !== "navigate") {
    if (isRestrictedUrl(tab.url)) return failure("restricted_url", `Não dá para agir em ${tab.url ?? "esta página"}: ${restrictionReason(tab.url)}. Explique isso ao usuário e peça para ele abrir a página onde quer que você trabalhe.`);
    if (isPdf(tab.url) && action.type === "extractPage") return failure("unsupported", "Esta aba é um PDF; o leitor de página não funciona aqui. Use web_fetch nesta URL.");
  }

  if (!isReadOnly(action) && !denied) {
    const label = await targetLabel(tab.id, action);
    const origin = originOf(tab.url);
    if (autonomy === "assist" || isRisky(action, label)) {
      const decision = await requestApproval(approvalKey(action, origin), describeAction(action, label), origin);
      if (decision === "unattended") return failure("denied", "Modo Assistir sem painel aberto: não havia como pedir sua aprovação. Peça ao usuário para abrir o painel da Vela ou mudar a autonomia para Auto.");
      if (decision === "deny") return failure("denied", "O usuário não aprovou esta ação. Explique o que pretendia fazer e peça orientação, sem repetir a mesma chamada.");
    }
  }

  if (action.type === "navigate") {
    if (denied) return failure("denied", "Modo Observar: navegação bloqueada. Descreva o passo ao usuário ou peça para trocar a autonomia.");
    let targetId = tab.id;
    if (action.newTab) {
      const created = await chrome.tabs.create({ url: action.url, active: false, openerTabId: tab.id });
      if (!created.id) return failure("nav_error", "Não foi possível abrir a aba.");
      targetId = created.id;
      // `chrome.tabs.create` feito pela própria extensão não dispara onCreatedNavigationTarget,
      // então a aba precisa ser adotada à mão ou fica de fora do grupo da tarefa.
      await adoptTab(created.id);
    } else {
      await chrome.tabs.update(tab.id, { url: action.url });
    }
    const outcome = await waitForNavigation(targetId, TIMEOUTS.navigate);
    if (!outcome.ok) return failure("nav_error", `Falha ao navegar para ${action.url}: ${outcome.error ?? "erro desconhecido"}.`);
    await waitForContentScript(targetId);
    return { ok: true, summary: `Abri ${outcome.url ?? action.url}${outcome.partial ? " (ainda carregando)" : ""}. Chame extractPage para ler a página.`, navigatedTo: outcome.url ?? action.url };
  }

  if (action.type === "extractPage") return readAllFrames(tab.id, action);

  if (!isReadOnly(action) && !NO_CURSOR.includes(action.type)) await beginTrace(tab.id);

  const { frameId, ref } = splitFrameRef("ref" in action ? action.ref : undefined);
  const routed = "ref" in action && ref !== action.ref ? { ...action, ref } : action;

  const urlBefore = tab.url;
  const result = await sendToTab(tab.id, {
    type: "agent:action",
    action: routed,
    actionId: crypto.randomUUID(),
    ghost: denied,
    trace: await traceConfig(),
  }, TIMEOUTS[action.type], frameId);

  if (!result?.ok) return result ?? failure("timeout", "Sem resposta da página.");

  // Clique pode disparar navegação implícita; sem detectar isso o próximo snapshot vem da página velha.
  if (action.type === "click" || (action.type === "type" && action.submit) || action.type === "keyPress") {
    const outcome = await Promise.race([
      waitForNavigation(tab.id, 1200),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1300)),
    ]);
    if (outcome && outcome.ok && outcome.url && outcome.url !== urlBefore) {
      await waitForContentScript(tab.id);
      return { ...result, summary: `${result.summary} A página navegou para ${outcome.url}; releia com extractPage.`, navigatedTo: outcome.url };
    }
  }
  return result;
}

async function traceConfig() {
  const settings = await loadSettings();
  return { cursor: settings.agent.showCursor, border: settings.agent.showControlBorder, highlight: settings.agent.showTargetHighlights, speed: settings.agent.cursorSpeed };
}
