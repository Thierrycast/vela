import { AppSettings, ChatMessage, defaultSettings, LogEntry } from "./types";

export const SETTINGS_KEY = "vela:settings";
const MESSAGES_KEY = "vela:messages";
const CONVERSATIONS_KEY = "vela:conversations";
const LOGS_KEY = "vela:logs";

const legacyKey = (key: string) => key.replace(/^vela:/, "browser-ai:");

const local = {
  get: async <T>(key: string, fallback: T): Promise<T> => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return fallback;
    const result = await chrome.storage.local.get(key);
    if (result[key] !== undefined) return result[key] as T;
    const legacy = await chrome.storage.local.get(legacyKey(key));
    const migrated = legacy[legacyKey(key)] as T | undefined;
    if (migrated === undefined) return fallback;
    await chrome.storage.local.set({ [key]: migrated });
    await chrome.storage.local.remove(legacyKey(key));
    return migrated;
  },
  set: async (key: string, value: unknown) => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) await chrome.storage.local.set({ [key]: value });
  },
};

export function normalizeSettings(stored: Partial<AppSettings> | undefined): AppSettings {
  return {
    ...defaultSettings,
    ...(stored ?? {}),
    brand: { ...defaultSettings.brand, ...(stored?.brand ?? {}) },
    agent: { ...defaultSettings.agent, ...(stored?.agent ?? {}) },
    context: { ...defaultSettings.context, ...(stored?.context ?? {}) },
    voice: { ...defaultSettings.voice, ...(stored?.voice ?? {}) },
    providers: stored?.providers?.length ? stored.providers : defaultSettings.providers,
  };
}

export const loadSettings = async () => normalizeSettings(await local.get<Partial<AppSettings>>(SETTINGS_KEY, {}));
export const saveSettings = (settings: AppSettings) => local.set(SETTINGS_KEY, settings);

export const loadMessages = () => local.get<ChatMessage[]>(MESSAGES_KEY, []);
export type StoredConversation = { id: string; title: string; updatedAt: number; messages: ChatMessage[] };
export const loadConversations = () => local.get<StoredConversation[]>(CONVERSATIONS_KEY, []);
export const saveConversations = (conversations: StoredConversation[]) => local.set(CONVERSATIONS_KEY, conversations);
export const loadLogs = () => local.get<LogEntry[]>(LOGS_KEY, []);
export const appendLog = async (entry: Omit<LogEntry, "id" | "createdAt">) => {
  const logs = await loadLogs();
  await local.set(LOGS_KEY, [...logs, { ...entry, id: crypto.randomUUID(), createdAt: Date.now() }].slice(-250));
};
export const clearLogs = () => local.set(LOGS_KEY, []);
