const RESTRICTED = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/i;
const WEB_STORE = /^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/i;

export const isRestrictedUrl = (url: string | undefined) => !url || RESTRICTED.test(url) || WEB_STORE.test(url);

/**
 * A causa importa: "não posso agir aqui" sem motivo parece limitação da Vela, quando na verdade
 * é o Chrome que proíbe extensões nessas páginas. Nenhuma extensão consegue — nem a do Google.
 */
export function restrictionReason(url: string | undefined): string {
  if (!url) return "não consegui identificar a aba ativa";
  if (WEB_STORE.test(url)) return "o Chrome bloqueia toda extensão na Chrome Web Store, para que nenhuma possa instalar ou remover outra sem você ver. Nenhuma extensão age aqui";
  if (/^chrome-extension:|^moz-extension:/i.test(url)) return "esta é a página de uma extensão, e o Chrome não deixa uma extensão mexer na outra";
  if (/^(chrome|edge|about):/i.test(url)) return "é uma página interna do navegador, onde o Chrome não permite scripts de extensão";
  if (/^devtools:|^view-source:/i.test(url)) return "é uma página de ferramentas do navegador, fora do alcance de extensões";
  return "o Chrome não permite scripts de extensão nesta página";
}
export const isPdf = (url: string | undefined) => !!url && /\.pdf($|[?#])/i.test(url);

export type NavigationOutcome = { ok: boolean; url?: string; partial?: boolean; error?: string };

export function waitForNavigation(tabId: number, timeoutMs = 15_000): Promise<NavigationOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: NavigationOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.webNavigation.onCompleted.removeListener(onCompleted);
      chrome.webNavigation.onErrorOccurred.removeListener(onError);
      chrome.webNavigation.onHistoryStateUpdated.removeListener(onHistory);
      chrome.webNavigation.onReferenceFragmentUpdated.removeListener(onHistory);
      resolve(outcome);
    };
    const mine = (details: { tabId: number; frameId: number }) => details.tabId === tabId && details.frameId === 0;
    const onCompleted = (details: { tabId: number; frameId: number; url: string }) => { if (mine(details)) finish({ ok: true, url: details.url }); };
    const onError = (details: { tabId: number; frameId: number; error: string }) => { if (mine(details)) finish({ ok: false, error: details.error }); };
    const onHistory = (details: { tabId: number; frameId: number; url: string }) => { if (mine(details)) finish({ ok: true, url: details.url }); };
    const timer = setTimeout(() => finish({ ok: true, partial: true }), timeoutMs);

    chrome.webNavigation.onCompleted.addListener(onCompleted);
    chrome.webNavigation.onErrorOccurred.addListener(onError);
    chrome.webNavigation.onHistoryStateUpdated.addListener(onHistory);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(onHistory);
  });
}

/** onCompleted não garante content script pronto: confirma com ping e reinjeta se preciso. */
export async function waitForContentScript(tabId: number, attempts = 8): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "agent:ping" }, { frameId: 0 });
      if ((response as { ok?: boolean } | undefined)?.ok) return true;
    } catch { /* ainda não registrou o listener */ }
    if (attempt === 2) {
      try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] }); } catch { /* URL restrita */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
