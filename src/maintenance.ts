import { AppSettings, defaultSettings } from "./types";
import { UserScript } from "./script-store";
import { normalizeSettings, SETTINGS_KEY } from "./storage";

export type StorageSlice = { key: string; label: string; description: string; bytes: number; clearable: boolean };

const SLICES: Array<Omit<StorageSlice, "bytes">> = [
  { key: "vela:conversations", label: "Conversas arquivadas", description: "Tudo que aparece no histórico da topbar.", clearable: true },
  { key: "vela:messages", label: "Conversa atual", description: "As mensagens da tarefa aberta agora.", clearable: true },
  { key: "vela:user-scripts", label: "Scripts", description: "Os userscripts salvos neste perfil.", clearable: true },
  { key: "vela:logs", label: "Registros", description: "Eventos de diagnóstico dos últimos usos.", clearable: true },
  { key: "vela:action-stats", label: "Diagnóstico de ações", description: "Contagem de cliques que surtiram ou não efeito.", clearable: true },
  { key: SETTINGS_KEY, label: "Configurações", description: "Preferências e providers, inclusive as chaves.", clearable: false },
];

export const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

export async function measureStorage(): Promise<StorageSlice[]> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return SLICES.map((slice) => ({ ...slice, bytes: 0 }));
  const everything = await chrome.storage.local.get(null);
  return SLICES.map((slice) => {
    const value = everything[slice.key];
    return { ...slice, bytes: value === undefined ? 0 : new Blob([JSON.stringify(value)]).size };
  });
}

export async function clearSlice(key: string) {
  if (typeof chrome !== "undefined" && chrome.storage?.local) await chrome.storage.local.remove(key);
}

export type Backup = { produto: "vela"; versao: 1; exportadoEm: string; settings: AppSettings; scripts: UserScript[] };

/** A chave de API sai do backup por padrão: um JSON no Downloads não é lugar de credencial. */
export async function buildBackup(includeKeys: boolean): Promise<Backup> {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, "vela:user-scripts"]);
  const settings = normalizeSettings(stored[SETTINGS_KEY] as Partial<AppSettings> | undefined);
  return {
    produto: "vela",
    versao: 1,
    exportadoEm: new Date().toISOString(),
    settings: includeKeys ? settings : { ...settings, providers: settings.providers.map((provider) => ({ ...provider, apiKey: "" })) },
    scripts: (stored["vela:user-scripts"] as UserScript[] | undefined) ?? [],
  };
}

export type RestoreReport = { providers: number; scripts: number; keysKept: boolean };

/** Restaurar nunca apaga a chave que já está configurada: um backup sem chave manteria você deslogado. */
export async function restoreBackup(text: string): Promise<RestoreReport> {
  let parsed: Partial<Backup>;
  try { parsed = JSON.parse(text) as Partial<Backup>; } catch { throw new Error("Arquivo inválido: não é JSON."); }
  if (parsed.produto !== "vela" || !parsed.settings) throw new Error("Este arquivo não é um backup da Vela.");

  const current = normalizeSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<AppSettings> | undefined);
  const incoming = normalizeSettings(parsed.settings);
  let keysKept = false;
  const providers = incoming.providers.map((provider) => {
    if (provider.apiKey) return provider;
    const existing = current.providers.find((item) => item.id === provider.id);
    if (existing?.apiKey) keysKept = true;
    return { ...provider, apiKey: existing?.apiKey ?? "" };
  });

  const scripts = Array.isArray(parsed.scripts) ? parsed.scripts.filter((script) => typeof script?.code === "string") : [];
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...incoming, providers }, "vela:user-scripts": scripts });
  return { providers: providers.length, scripts: scripts.length, keysKept };
}

/** Volta tudo ao padrão de fábrica menos os providers — perder a chave por engano seria hostil. */
export async function resetPreferences(): Promise<AppSettings> {
  const current = normalizeSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<AppSettings> | undefined);
  const restored: AppSettings = { ...defaultSettings, providers: current.providers, activeProviderId: current.activeProviderId };
  await chrome.storage.local.set({ [SETTINGS_KEY]: restored });
  return restored;
}
