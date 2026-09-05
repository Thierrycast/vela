import { ActionResult, BrowserAction } from "./types";

const KEY = "vela:action-stats";

export type ActionStats = {
  total: number;
  noEffect: number;
  failures: number;
  byCode: Record<string, number>;
  byType: Record<string, number>;
  since: number;
};

const empty = (): ActionStats => ({ total: 0, noEffect: 0, failures: 0, byCode: {}, byType: {}, since: Date.now() });

export async function loadActionStats(): Promise<ActionStats> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return empty();
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as ActionStats | undefined) ?? empty();
}

export const clearActionStats = () => chrome.storage.local.set({ [KEY]: empty() });

/**
 * "sem efeito perceptível" é a métrica que decide se vale declarar `debugger` e usar CDP.
 * Sem contar, a recomendação de "medir por uma semana" seria só uma frase.
 */
export async function recordAction(action: BrowserAction, result: ActionResult) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  const stats = await loadActionStats();
  stats.total += 1;
  stats.byType[action.type] = (stats.byType[action.type] ?? 0) + 1;
  if (!result.ok) {
    stats.failures += 1;
    stats.byCode[result.code] = (stats.byCode[result.code] ?? 0) + 1;
  } else if (result.summary.includes("sem efeito perceptível")) {
    stats.noEffect += 1;
  }
  await chrome.storage.local.set({ [KEY]: stats });
}
