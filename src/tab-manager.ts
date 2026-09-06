/**
 * As abas da sessão, sob o comando da Vela.
 *
 * O limite é deliberado: **ela só governa o que está no grupo dela**. Abrir uma aba já a coloca
 * ali, então tudo que ela criou é dela; o que estava aberto antes é do usuário, e fechar a aba
 * errada é o tipo de erro que não tem desfazer. Por isso `close` recusa qualquer id fora do
 * grupo em vez de "só ignorar" — recusa silenciosa ensina o modelo a tentar de novo.
 */
import { getSession, forgetTab } from "./session";

export type TabCommand =
  | { op: "list" }
  | { op: "activate"; tabId: number }
  | { op: "close"; tabIds: number[] }
  | { op: "closeOthers"; keep: number };

export type TabResult = { ok: true; summary: string; content?: string } | { ok: false; summary: string };

async function sessionTabs() {
  const session = await getSession();
  if (!session) return null;
  const tabs = await chrome.tabs.query({ groupId: session.groupId });
  return tabs;
}

function describe(tab: chrome.tabs.Tab) {
  return `[${tab.id}] ${tab.title ?? "sem título"} — ${tab.url ?? ""}${tab.active ? " (ativa)" : ""}`;
}

export async function manageTabs(command: TabCommand): Promise<TabResult> {
  const tabs = await sessionTabs();
  if (!tabs) return { ok: false, summary: "Ainda não existe um grupo de abas da Vela nesta janela." };
  const mine = new Set(tabs.map((tab) => tab.id).filter((id): id is number => id !== undefined));

  if (command.op === "list") {
    return { ok: true, summary: `${tabs.length} aba(s) no grupo da Vela.`, content: tabs.map(describe).join("\n") };
  }

  if (command.op === "activate") {
    if (!mine.has(command.tabId)) return { ok: false, summary: `A aba ${command.tabId} não está no grupo da Vela.` };
    await chrome.tabs.update(command.tabId, { active: true });
    const tab = tabs.find((item) => item.id === command.tabId);
    return { ok: true, summary: `Foquei a aba ${command.tabId}${tab?.title ? ` — ${tab.title}` : ""}.` };
  }

  const alvos = command.op === "close"
    ? command.tabIds
    : [...mine].filter((id) => id !== command.keep);

  if (command.op === "closeOthers" && !mine.has(command.keep)) {
    return { ok: false, summary: `A aba ${command.keep} não está no grupo da Vela.` };
  }

  const fora = alvos.filter((id) => !mine.has(id));
  if (fora.length) return { ok: false, summary: `Estas abas não são da sessão da Vela e não posso fechá-las: ${fora.join(", ")}.` };
  if (!alvos.length) return { ok: true, summary: "Não havia nada para fechar." };
  // Fechar a última aba do grupo fecharia o grupo inteiro; a sessão deixa de existir junto.
  await chrome.tabs.remove(alvos);
  for (const id of alvos) await forgetTab(id);
  return { ok: true, summary: `Fechei ${alvos.length} aba(s): ${alvos.join(", ")}.` };
}
