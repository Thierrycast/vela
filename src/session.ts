export type VelaSession = { groupId: number; title: string; tabIds: number[] };

const KEY = "vela:session";

async function read(): Promise<VelaSession | null> {
  const stored = await chrome.storage.session.get(KEY);
  return (stored[KEY] as VelaSession | undefined) ?? null;
}

async function write(session: VelaSession | null) {
  if (session) await chrome.storage.session.set({ [KEY]: session });
  else await chrome.storage.session.remove(KEY);
}

export const getSession = read;

/** Criada preguiçosamente, na primeira ação que abre aba — não ao abrir o chat. */
export async function ensureSession(title: string, tabId?: number): Promise<VelaSession | null> {
  const existing = await read();
  if (existing) {
    try { await chrome.tabGroups.get(existing.groupId); return existing; } catch { await write(null); }
  }
  if (!chrome.tabs?.group) return null;
  const current = tabId ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  if (current === undefined) return null;
  try {
    const groupId = await chrome.tabs.group({ tabIds: [current] });
    await chrome.tabGroups.update(groupId, { title: `Vela · ${title.slice(0, 40)}`, color: "cyan", collapsed: false });
    const session = { groupId, title, tabIds: [current] };
    await write(session);
    return session;
  } catch { return null; }
}

export async function adoptTab(tabId: number) {
  const session = await read();
  if (!session) return;
  if (session.tabIds.includes(tabId)) return;
  try {
    await chrome.tabs.group({ groupId: session.groupId, tabIds: [tabId] });
    await write({ ...session, tabIds: [...session.tabIds, tabId] });
  } catch { /* grupo já fechado */ }
}

export async function forgetTab(tabId: number) {
  const session = await read();
  if (!session || !session.tabIds.includes(tabId)) return;
  const tabIds = session.tabIds.filter((item) => item !== tabId);
  await write(tabIds.length ? { ...session, tabIds } : null);
}

export async function renameSession(title: string) {
  const session = await read();
  if (!session) return;
  try { await chrome.tabGroups.update(session.groupId, { title: `Vela · ${title.slice(0, 40)}` }); } catch { /* grupo fechado */ }
  await write({ ...session, title });
}

export async function endSession() {
  await write(null);
}
