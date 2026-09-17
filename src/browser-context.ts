import { AppSettings, BrowserContext, TabSummary } from "./types";
import { isRestrictedUrl } from "./navigation";

const ATTACHMENTS_KEY = "vela:attachments";

export async function addAttachment(text: string) {
  const current = await listAttachments();
  const next = [...current, text].slice(-5);
  await chrome.storage.session.set({ [ATTACHMENTS_KEY]: next });
  return next;
}

export async function listAttachments(): Promise<string[]> {
  const stored = await chrome.storage.session.get(ATTACHMENTS_KEY);
  return (stored[ATTACHMENTS_KEY] as string[] | undefined) ?? [];
}

export async function removeAttachment(index: number) {
  const current = await listAttachments();
  const next = current.filter((_, position) => position !== index);
  await chrome.storage.session.set({ [ATTACHMENTS_KEY]: next });
  return next;
}

export async function clearAttachments() {
  await chrome.storage.session.remove(ATTACHMENTS_KEY);
}

async function liveSelection(tabId: number): Promise<string | undefined> {
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "agent:get-selection" }) as Promise<{ text?: string }>,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 600)),
    ]);
    return response?.text || undefined;
  } catch { return undefined; }
}

/*
 * A seleção só é lida na primeira rodada do turno.
 *
 * Ela é "o que a pessoa tinha selecionado quando pediu" — e isso não muda enquanto a Vela trabalha.
 * Ler a cada rodada custava uma mensagem à aba (com espera de até 600 ms numa página que demora a
 * responder) antes de cada ida ao modelo, e ainda podia trocar a seleção original por uma que a
 * própria Vela criou ao clicar e digitar.
 */
export async function collectBrowserContext(settings: AppSettings, options: { lerSelecao?: boolean } = {}): Promise<BrowserContext> {
  const context: BrowserContext = { attachments: await listAttachments(), tabs: [], autonomy: settings.agent.autonomy };
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (settings.context.currentPage && active?.url && !isRestrictedUrl(active.url)) {
    context.page = { url: active.url, title: active.title ?? "" };
  }
  if (settings.context.selection && active?.id && options.lerSelecao !== false) {
    context.selection = await liveSelection(active.id);
  }
  if (settings.context.sessionTabs || settings.context.outsideTabs) {
    const query = settings.context.outsideTabs ? {} : { lastFocusedWindow: true };
    const tabs = await chrome.tabs.query(query);
    context.tabs = tabs.flatMap<TabSummary>((tab) => tab.id === undefined || !tab.url || isRestrictedUrl(tab.url)
      ? []
      : [{ tabId: tab.id, title: (tab.title ?? "").slice(0, 80), url: tab.url, active: !!tab.active }]);
  }
  return context;
}
