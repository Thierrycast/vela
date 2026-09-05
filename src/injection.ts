import { loadSettings } from "./storage";

const SCRIPT_ID = "vela-content";

/**
 * O content script deixa de ser estático: só fica presente em todas as páginas quando o
 * usuário mantém o contexto de seleção ligado. Para agir, o agente injeta sob demanda.
 */
export async function syncContentScriptRegistration() {
  const settings = await loadSettings();
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }).catch(() => []);
  const shouldRegister = settings.context.selection;

  if (shouldRegister && !registered.length) {
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      js: ["content.js"],
      matches: ["<all_urls>"],
      runAt: "document_idle",
      allFrames: true,
      persistAcrossSessions: true,
    }]).catch(() => undefined);
    return;
  }
  if (!shouldRegister && registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => undefined);
  }
}

/** Garante presença na aba ativa quando o painel abre, cobrindo abas já abertas. */
export async function injectIntoActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url || /^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(tab.url)) return;
  try {
    const alive = await chrome.tabs.sendMessage(tab.id, { type: "agent:ping" }).catch(() => null);
    if (!alive) await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
  } catch { /* página bloqueia injeção */ }
}
