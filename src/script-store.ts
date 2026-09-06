import { parseMetadata, scriptTemplate } from "./user-script";

export type UserScript = { id: string; code: string; enabled: boolean; createdAt: number; updatedAt: number };

const KEY = "vela:user-scripts";
const LEGACY_KEY = "browser-ai:user-scripts";

type LegacyScript = UserScript & { name?: string; description?: string; matches?: string[] };

/** Scripts antigos guardavam nome, descrição e matches em campos separados. Agora tudo vive no
 *  bloco de metadados; a migração recompõe o cabeçalho a partir dos campos soltos. */
function migrateShape(script: LegacyScript): UserScript {
  if (/==UserScript==/.test(script.code)) return { id: script.id, code: script.code, enabled: script.enabled, createdAt: script.createdAt, updatedAt: script.updatedAt };
  const header = [
    "// ==UserScript==",
    `// @name         ${script.name ?? "Script importado"}`,
    "// @version      1.0",
    `// @description  ${script.description ?? ""}`,
    ...(script.matches ?? ["<all_urls>"]).map((pattern) => `// @match        ${pattern}`),
    "// ==/UserScript==",
    "",
  ].join("\n");
  return { id: script.id, code: header + script.code, enabled: script.enabled, createdAt: script.createdAt, updatedAt: script.updatedAt };
}

const read = async (): Promise<UserScript[]> => {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return [];
  const result = await chrome.storage.local.get(KEY);
  if (result[KEY] !== undefined) return (result[KEY] as LegacyScript[]).map(migrateShape);
  const legacy = await chrome.storage.local.get(LEGACY_KEY);
  const migrated = legacy[LEGACY_KEY] as LegacyScript[] | undefined;
  if (!migrated) return [];
  const shaped = migrated.map(migrateShape);
  await chrome.storage.local.set({ [KEY]: shaped });
  await chrome.storage.local.remove(LEGACY_KEY);
  return shaped;
};

const write = (scripts: UserScript[]) => chrome.storage.local.set({ [KEY]: scripts });

export const listScripts = read;

export async function saveScript(script: UserScript) {
  const scripts = await read();
  const next = scripts.some((item) => item.id === script.id)
    ? scripts.map((item) => item.id === script.id ? script : item)
    : [...scripts, script];
  await write(next);
  return script;
}

export async function deleteScript(id: string) {
  await write((await read()).filter((script) => script.id !== id));
}

export function newScript(): UserScript {
  const now = Date.now();
  return { id: crypto.randomUUID(), code: scriptTemplate(), enabled: false, createdAt: now, updatedAt: now };
}

/** Usado pelas ferramentas do agente: encontra por nome do metadado, não por id opaco. */
export async function findScriptByName(name: string) {
  const wanted = name.trim().toLowerCase();
  return (await read()).find((script) => parseMetadata(script.code).name.trim().toLowerCase() === wanted) ?? null;
}
