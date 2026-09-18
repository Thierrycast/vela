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
    agent: {
      ...defaultSettings.agent,
      ...(stored?.agent ?? {}),
      // Subobjeto novo dentro de `agent`: sem esta linha, um settings salvo antes dele existir
      // chegaria com `modelos: undefined` e derrubaria a escolha de modelo no primeiro turno.
      modelos: { ...defaultSettings.agent.modelos, ...(stored?.agent?.modelos ?? {}) },
    },
    /*
     * Sem esta linha, um settings salvo antes das habilidades existirem (que não tem o campo)
     * passaria pelo espalhamento de cima como `capabilities: undefined` e derrubaria toda
     * consulta a `settings.capabilities.x`. Todo subobjeto novo precisa da sua própria linha
     * aqui — o espalhamento raiz não alcança um nível abaixo.
     */
    capabilities: { ...defaultSettings.capabilities, ...(stored?.capabilities ?? {}) },
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
export type ConversationIndexEntry = { id: string; title: string; updatedAt: number };

/*
 * Uma chave por conversa, e um índice leve.
 *
 * As cinquenta conversas moravam numa chave só, e cada gravação — a cada pausa de 400 ms durante
 * uma tarefa — serializava e reescrevia todas elas, megabytes, para mudar uma mensagem da conversa
 * aberta. Pior: sem `unlimitedStorage`, passar de 10 MB fazia o Chrome recusar a gravação em
 * silêncio, e daí em diante nem as configurações salvavam. Agora se grava só a conversa que mudou.
 */
export const CONVERSATION_INDEX_KEY = "vela:conversa-indice";
export const CONVERSATION_PREFIX = "vela:conversa:";
const conversationKey = (id: string) => `${CONVERSATION_PREFIX}${id}`;

export async function loadConversationIndex(): Promise<ConversationIndexEntry[]> {
  const indice = await local.get<ConversationIndexEntry[] | null>(CONVERSATION_INDEX_KEY, null);
  if (indice) return indice;
  // Migração do formato de chave única: divide uma vez e apaga o antigo.
  const antigas = await local.get<StoredConversation[]>(CONVERSATIONS_KEY, []);
  if (!antigas.length || typeof chrome === "undefined" || !chrome.storage?.local) return [];
  const novoIndice = antigas.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  await chrome.storage.local.set(Object.fromEntries([[CONVERSATION_INDEX_KEY, novoIndice], ...antigas.map((item) => [conversationKey(item.id), item])]));
  await chrome.storage.local.remove(CONVERSATIONS_KEY);
  return novoIndice;
}

export async function loadConversationsById(ids: string[]): Promise<StoredConversation[]> {
  if (!ids.length || typeof chrome === "undefined" || !chrome.storage?.local) return [];
  const stored = await chrome.storage.local.get(ids.map(conversationKey));
  return ids.flatMap((id) => (stored[conversationKey(id)] as StoredConversation | undefined) ?? []);
}

export async function saveConversationChanges(index: ConversationIndexEntry[], changed: StoredConversation[], removed: string[]) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  await chrome.storage.local.set(Object.fromEntries([[CONVERSATION_INDEX_KEY, index], ...changed.map((item) => [conversationKey(item.id), item])]));
  if (removed.length) await chrome.storage.local.remove(removed.map(conversationKey));
}

export const countConversations = async () => (await loadConversationIndex()).length;
export const loadLogs = () => local.get<LogEntry[]>(LOGS_KEY, []);

/*
 * Registros entram em lote.
 *
 * Cada chamada de ferramenta, cada rodada e cada telemetria lia os 250 registros e os regravava
 * inteiros — várias gravações por rodada para um diagnóstico que a trilha já cobre em detalhe.
 * Juntos num intervalo de um segundo, viram uma gravação só.
 */
let logsPendentes: LogEntry[] = [];
let logsTimer: ReturnType<typeof setTimeout> | undefined;
export const appendLog = async (entry: Omit<LogEntry, "id" | "createdAt">) => {
  logsPendentes.push({ ...entry, id: crypto.randomUUID(), createdAt: Date.now() });
  if (logsTimer) return;
  logsTimer = setTimeout(() => {
    logsTimer = undefined;
    const lote = logsPendentes;
    logsPendentes = [];
    void loadLogs().then((logs) => local.set(LOGS_KEY, [...logs, ...lote].slice(-250))).catch(() => undefined);
  }, 1_000);
};
export const clearLogs = () => local.set(LOGS_KEY, []);

const MEMORY_KEY = "vela:memory";

export async function getMemory(): Promise<Record<string, string>> {
  return await local.get<Record<string, string>>(MEMORY_KEY, {});
}

export async function setMemory(memory: Record<string, string>): Promise<void> {
  await local.set(MEMORY_KEY, memory);
}
