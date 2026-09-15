import { ActionResult, BrowserAction } from "./types";

const KEY = "vela:action-stats";

export type ActionStats = {
  total: number;
  noEffect: number;
  failures: number;
  byCode: Record<string, number>;
  byType: Record<string, number>;
  /** Turnos completos, e o que cada um custou em idas ao modelo. A razão entre os dois é a
   *  medida de fluidez: quantas vezes a Vela teve que parar e perguntar ao modelo o que fazer. */
  turns: number;
  rounds: number;
  toolCalls: number;
  /** Ações executadas dentro de um lote — o que o lote economizou em rodadas. */
  batchItems: number;
  since: number;
};

const empty = (): ActionStats => ({ total: 0, noEffect: 0, failures: 0, byCode: {}, byType: {}, turns: 0, rounds: 0, toolCalls: 0, batchItems: 0, since: Date.now() });

export async function loadActionStats(): Promise<ActionStats> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return empty();
  const stored = await chrome.storage.local.get(KEY);
  // Contagem salva antes dos campos novos existirem não tem `turns`/`rounds`: sem o merge, a
  // tela mostraria `undefined` e a soma seguinte viraria NaN, apagando o histórico em silêncio.
  return { ...empty(), ...((stored[KEY] as Partial<ActionStats> | undefined) ?? {}) };
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

/** Ações que couberam num lote — a diferença entre elas e o total de rodadas é o que o lote poupou. */
export async function recordBatch(items: number) {
  if (!items || typeof chrome === "undefined" || !chrome.storage?.local) return;
  const stats = await loadActionStats();
  stats.batchItems += items;
  await chrome.storage.local.set({ [KEY]: stats });
}

/** Fecha o turno na contagem. Sem isto, "rodadas por tarefa" só existiria na trilha, que é uma
 *  janela de 20 mil eventos — some justamente quando se quer comparar semana passada com hoje. */
export async function recordTurn(rounds: number, toolCalls: number, batchItems = 0) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  const stats = await loadActionStats();
  stats.turns += 1;
  stats.rounds += rounds;
  stats.toolCalls += toolCalls;
  stats.batchItems += batchItems;
  await chrome.storage.local.set({ [KEY]: stats });
}
