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
  if (pendente) return pendente;
  if (typeof chrome === "undefined" || !chrome.storage?.local) return empty();
  const stored = await chrome.storage.local.get(KEY);
  // Contagem salva antes dos campos novos existirem não tem `turns`/`rounds`: sem o merge, a
  // tela mostraria `undefined` e a soma seguinte viraria NaN, apagando o histórico em silêncio.
  return { ...empty(), ...((stored[KEY] as Partial<ActionStats> | undefined) ?? {}) };
}

export const clearActionStats = async () => { pendente = null; if (gravacao) { clearTimeout(gravacao); gravacao = undefined; } await chrome.storage.local.set({ [KEY]: empty() }); };

/*
 * A contagem é acumulada em memória e gravada em lote.
 *
 * Era um ler-somar-gravar por ação: numa tarefa com trinta cliques, sessenta idas ao storage para
 * mudar um número. Pior que o custo, a corrida — duas ações terminando juntas liam o mesmo valor e
 * uma sobrescrevia a outra, e a contagem que existe justamente para medir saía errada. Dois
 * segundos de acúmulo resolvem os dois, e o `flush` fecha antes de qualquer leitura.
 */
let pendente: ActionStats | null = null;
let gravacao: ReturnType<typeof setTimeout> | undefined;

async function acumular(muda: (stats: ActionStats) => void) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  pendente ??= await loadActionStats();
  muda(pendente);
  if (gravacao) return;
  gravacao = setTimeout(() => { gravacao = undefined; void flushActionStats(); }, 2_000);
}

export async function flushActionStats() {
  if (gravacao) { clearTimeout(gravacao); gravacao = undefined; }
  const stats = pendente;
  pendente = null;
  if (stats) await chrome.storage.local.set({ [KEY]: stats });
}

/**
 * "sem efeito perceptível" é a métrica que decide se vale declarar `debugger` e usar CDP.
 * Sem contar, a recomendação de "medir por uma semana" seria só uma frase.
 */
export async function recordAction(action: BrowserAction, result: ActionResult) {
  await acumular((stats) => {
    stats.total += 1;
    stats.byType[action.type] = (stats.byType[action.type] ?? 0) + 1;
    if (!result.ok) {
      stats.failures += 1;
      stats.byCode[result.code] = (stats.byCode[result.code] ?? 0) + 1;
    } else if (result.summary.includes("sem efeito perceptível")) {
      stats.noEffect += 1;
    }
  });
}

/** Ações que couberam num lote — a diferença entre elas e o total de rodadas é o que o lote poupou. */
export async function recordBatch(items: number) {
  if (!items) return;
  await acumular((stats) => { stats.batchItems += items; });
}

/** Fecha o turno na contagem. Sem isto, "rodadas por tarefa" só existiria na trilha, que é uma
 *  janela de 20 mil eventos — some justamente quando se quer comparar semana passada com hoje. */
export async function recordTurn(rounds: number, toolCalls: number, batchItems = 0) {
  await acumular((stats) => {
    stats.turns += 1;
    stats.rounds += rounds;
    stats.toolCalls += toolCalls;
    stats.batchItems += batchItems;
  });
  // O turno acabou: a contagem dele não espera o lote, senão o painel aberto logo depois mostraria
  // o número de antes.
  await flushActionStats();
}
