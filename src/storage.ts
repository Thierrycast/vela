import { AppSettings, ChatMessage, defaultSettings, LogEntry } from "./types";

export const SETTINGS_KEY = "vela:settings";
const MESSAGES_KEY = "vela:messages";
const CONVERSATIONS_KEY = "vela:conversations";
const LOGS_KEY = "vela:logs";
const BRAND_HEALED_KEY = "vela:brand-renamed";
const LEGACY_APP_NAMES = ["Browser AI", "browser-ai"];
const LEGACY_ACCENTS = ["#d97757", "#5250f2"];
const VOICE_HEALED_KEY = "vela:voice-endpoint";
const ROUNDS_HEALED_KEY = "vela:rounds-raised";
const LEGACY_VOICE_MODELS = ["whisper-1", "tts-1", ""];
/** Vozes do kokoro: boas, mas geram em o dobro do tempo do áudio. */
const SLOW_VOICES = ["", "alloy", "pf_dora"];

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
    bridge: { ...defaultSettings.bridge, ...(stored?.bridge ?? {}) },
    voice: { ...defaultSettings.voice, ...(stored?.voice ?? {}) },
    /*
     * Cada perfil é completado, não apenas aceito como veio. Um perfil sem `capabilities` — vindo
     * de backup antigo, de importação, ou de storage editado à mão — derrubava **todo turno** em
     * `profile?.capabilities.webFetch`, com a mensagem "Cannot read properties of undefined
     * (reading 'webFetch')" aparecendo na conversa como se o modelo tivesse falhado.
     */
    providers: stored?.providers?.length
      ? stored.providers.map((profile) => ({
        ...defaultSettings.providers[0],
        ...profile,
        capabilities: { ...defaultSettings.providers[0].capabilities, ...(profile.capabilities ?? {}) },
      }))
      : defaultSettings.providers,
  };
}

/**
 * O produto trocou de nome. Sem isto, quem já usava a versão antiga continuaria vendo
 * "Browser AI" e a cor antiga para sempre — o valor salvo venceria o default novo.
 * Roda uma única vez e não toca em nome ou cor que o usuário tenha escolhido de fato.
 */
async function healLegacyBrand(settings: AppSettings): Promise<AppSettings> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return settings;
  const stored = await chrome.storage.local.get(BRAND_HEALED_KEY);
  if (stored[BRAND_HEALED_KEY]) return settings;

  const staleName = LEGACY_APP_NAMES.includes(settings.brand.appName.trim());
  const staleAccent = LEGACY_ACCENTS.includes(settings.brand.accentColor.trim().toLowerCase());
  const healed: AppSettings = {
    ...settings,
    brand: {
      appName: staleName ? defaultSettings.brand.appName : settings.brand.appName,
      accentColor: staleAccent ? "" : settings.brand.accentColor,
      logoText: staleName ? defaultSettings.brand.logoText : settings.brand.logoText,
    },
  };
  await chrome.storage.local.set({ [BRAND_HEALED_KEY]: true });
  if (staleName || staleAccent) await local.set(SETTINGS_KEY, healed);
  return healed;
}

/**
 * O teto de etapas subiu de 8 para 12 quando o loop de repetição foi resolvido, mas quem já
 * usava a Vela continuou com 8 salvo — e 8 corta tarefa legítima, como abrir um vídeo depois de
 * pesquisar. Sobe só quem está exatamente no default antigo: quem escolheu outro número escolheu.
 */
const LEGACY_MAX_ROUNDS = 8;

/** A voz ganhou servidor próprio; quem já tinha settings ficou sem endereço e com modelo alheio. */
async function healVoiceEndpoint(settings: AppSettings): Promise<AppSettings> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return settings;
  const stored = await chrome.storage.local.get(VOICE_HEALED_KEY);
  if (stored[VOICE_HEALED_KEY]) return settings;
  await chrome.storage.local.set({ [VOICE_HEALED_KEY]: true });

  const voice = { ...settings.voice };
  if (!voice.baseUrl.trim()) voice.baseUrl = defaultSettings.voice.baseUrl;
  if (!voice.streamingUrl.trim()) voice.streamingUrl = defaultSettings.voice.streamingUrl;
  if (LEGACY_VOICE_MODELS.includes(voice.transcriptionModel.trim())) voice.transcriptionModel = defaultSettings.voice.transcriptionModel;
  if (!voice.visual) voice.visual = defaultSettings.voice.visual;
  if (SLOW_VOICES.includes(voice.speechVoice.trim())) voice.speechVoice = defaultSettings.voice.speechVoice;

  const healed: AppSettings = { ...settings, voice };
  await local.set(SETTINGS_KEY, healed);
  return healed;
}

async function healMaxRounds(settings: AppSettings): Promise<AppSettings> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return settings;
  const stored = await chrome.storage.local.get(ROUNDS_HEALED_KEY);
  if (stored[ROUNDS_HEALED_KEY]) return settings;
  await chrome.storage.local.set({ [ROUNDS_HEALED_KEY]: true });
  if (settings.agent.maxRounds !== LEGACY_MAX_ROUNDS) return settings;
  const healed: AppSettings = { ...settings, agent: { ...settings.agent, maxRounds: defaultSettings.agent.maxRounds } };
  await local.set(SETTINGS_KEY, healed);
  return healed;
}

export const loadSettings = async () => healMaxRounds(await healVoiceEndpoint(await healLegacyBrand(normalizeSettings(await local.get<Partial<AppSettings>>(SETTINGS_KEY, {})))));
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
