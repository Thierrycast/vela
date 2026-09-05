export type UserScript = { id: string; name: string; description: string; matches: string[]; code: string; enabled: boolean; createdAt: number; updatedAt: number };
const KEY = "vela:user-scripts";
const LEGACY_KEY = "browser-ai:user-scripts";
const get = async (): Promise<UserScript[]> => { if (typeof chrome === "undefined" || !chrome.storage?.local) return []; const result = await chrome.storage.local.get(KEY); if (result[KEY] !== undefined) return result[KEY] as UserScript[]; const legacy = await chrome.storage.local.get(LEGACY_KEY); const migrated = legacy[LEGACY_KEY] as UserScript[] | undefined; if (!migrated) return []; await chrome.storage.local.set({ [KEY]: migrated }); await chrome.storage.local.remove(LEGACY_KEY); return migrated; };
const set = (scripts: UserScript[]) => chrome.storage.local.set({ [KEY]: scripts });
export const listScripts = get;
export async function saveScript(script: UserScript) { const scripts = await get(); const next = scripts.some((item) => item.id === script.id) ? scripts.map((item) => item.id === script.id ? script : item) : [...scripts, script]; await set(next); return script; }
export async function deleteScript(id: string) { await set((await get()).filter((script) => script.id !== id)); }
export function newScript(): UserScript { const now = Date.now(); return { id: crypto.randomUUID(), name: "Novo script", description: "", matches: ["<all_urls>"], code: "// Código executado na página\n", enabled: true, createdAt: now, updatedAt: now }; }
