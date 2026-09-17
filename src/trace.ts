/**
 * Trilha de execução da Vela: tudo que entra, sai, demora ou falha.
 *
 * Existe para a fase de ajuste fino — sem medir cada elo (quanto tempo o modelo levou até o
 * primeiro token, qual ação não surtiu efeito, qual retrato de página estava obsoleto), otimizar
 * vira palpite. O log antigo (`vela:logs`) guarda uma linha de texto por evento e não responde
 * nada disso; este guarda o evento inteiro, com duração e payload.
 *
 * Fica em IndexedDB, não em `chrome.storage.local`: o limite de 10 MB do storage não cabe uma
 * semana de uso, e aqui a ideia é justamente acumular para depois analisar.
 */

/**
 * O vocabulário de etapas do pipeline, do microfone à fala de volta.
 *
 * É fechado de propósito. Rótulo livre em cada ponto de instrumentação produz uma trilha que só
 * quem escreveu consegue ler — e, pior, impossível de agrupar: "transcrição", "stt" e "áudio
 * transcrito" viram três coisas diferentes para qualquer filtro. Com o vocabulário fechado, o
 * relatório sabe montar a narrativa sem conhecer quem gravou o quê.
 *
 * A ordem abaixo é a ordem em que as coisas acontecem numa conversa falada:
 * o áudio entra, o STT transcreve, o turno recebe, o modelo pensa, as ferramentas executam,
 * a resposta sai, o TTS sintetiza e o alto-falante toca.
 */
export type TraceKind =
  | "turn" | "user.input" | "model.request" | "model.stream" | "model.text" | "model.tool"
  /** O que **exatamente** foi enviado ao modelo, e o que ele devolveu inteiro. */
  | "model.prompt" | "model.response"
  | "tool.call" | "action" | "page.read" | "navigation"
  /** Voz, etapa a etapa. `voice` continua existindo para o que é do runtime e não do pipeline. */
  | "audio.capture" | "stt.partial" | "stt.result"
  | "tts.request" | "tts.audio" | "tts.play"
  | "voice" | "bridge" | "ui" | "error";

export type TraceEvent = {
  id?: number;
  at: number;
  turn: string;
  kind: TraceKind;
  label: string;
  /** Duração em ms, quando o evento nasceu de um span. */
  ms?: number;
  ok?: boolean;
  /** Código curto de falha, o mesmo vocabulário de `ActionErrorCode`. */
  code?: string;
  /** Payload já redigido e truncado. */
  data?: Record<string, unknown>;
  /** Contexto de onde o evento saiu: background, painel, offscreen, conteúdo. */
  from: string;
  /*
   * Costura.
   *
   * Sem isto a trilha é uma fita: dá para ver que houve uma chamada de ferramenta e que houve uma
   * ação, e presumir pela ordem que uma levou à outra. Presumir é exatamente o que não serve numa
   * revisão — um lote dispara cinco ações dentro de uma chamada, duas tarefas de fundo escrevem
   * intercaladas, e a ordem deixa de significar parentesco. Com os três ids, o relatório reconstrói
   * a árvore em vez de adivinhá-la.
   */
  round?: number;
  callId?: string;
  actionId?: string;
  /** Id de um binário guardado junto (hoje, áudio). Ver `trace-blobs.ts`. */
  blobId?: string;
};

export const DATABASE = "vela-trace";
const STORE = "events";
export const BLOB_STORE = "blobs";
const MAX_EVENTS = 20_000;

/**
 * Dois níveis, porque duas perguntas diferentes.
 *
 * O normal responde "o que aconteceu e quanto demorou", e paga barato por isso: cortar texto em
 * dois mil caracteres mantém a trilha viva por semanas de uso. Serve para perceber que algo está
 * lento ou falhando.
 *
 * O completo responde **"por quê"** — e essa pergunta não tem resposta sem o prompt exato que o
 * modelo leu, a resposta inteira que ele deu e o retrato de página que ele viu. Um retrato cortado
 * em seiscentos caracteres é justamente a parte que não explica nada: o elemento que faltava
 * estava no pedaço descartado. Por isso o completo guarda tudo, e por isso ele nasce desligado e
 * se liga para uma sessão de depuração, não para a vida.
 */
export type TraceDetail = "normal" | "completo";
const LIMITE: Record<TraceDetail, number> = { normal: 2_000, completo: 400_000 };
const ITENS_DE_LISTA: Record<TraceDetail, number> = { normal: 40, completo: 400 };
const PROFUNDIDADE: Record<TraceDetail, number> = { normal: 4, completo: 8 };

let detail: TraceDetail = "normal";
export const traceDetail = () => detail;

/**
 * Nomes cujo valor nunca entra na trilha, em qualquer profundidade e em qualquer nível.
 *
 * Isto não afrouxa no modo completo, e é a única coisa que não afrouxa. Uma trilha que vaza a
 * chave de API deixa de poder ser exportada — e exportar é o ponto inteiro dela.
 */
const SECRET = /^(apikey|api_key|authorization|token|password|senha|secret|cookie|refresh_token|access_token)$/i;

/** Trunca conforme o nível, redige sempre. */
export function sanitize(value: unknown, depth = 0): unknown {
  const maxString = LIMITE[detail];
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > maxString ? `${value.slice(0, maxString)}…[+${value.length - maxString}]` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= PROFUNDIDADE[detail]) return "[profundo demais]";
  if (Array.isArray(value)) return value.slice(0, ITENS_DE_LISTA[detail]).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET.test(key) ? "[omitido]" : sanitize(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

let database: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("at", "at");
        store.createIndex("turn", "turn");
      }
      /*
       * Binários no mesmo banco, em store separada.
       *
       * O áudio de uma fala é a única prova do que foi realmente dito — a transcrição é a
       * interpretação, não o fato, e quando as duas discordam é o áudio que resolve. Fica numa
       * store à parte porque a de eventos é lida inteira a cada relatório, e carregar megabytes de
       * PCM junto tornaria isso impraticável.
       */
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        const blobs = db.createObjectStore(BLOB_STORE, { keyPath: "id" });
        blobs.createIndex("at", "at");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

type Listener = (event: TraceEvent) => void;
const listeners = new Set<Listener>();
let context = "background";
let currentTurn = "sem-turno";
let enabled = true;
let pending: TraceEvent[] = [];
let flushTimer = 0;

export function configureTrace(options: { from?: string; enabled?: boolean; detail?: TraceDetail }) {
  if (options.from) context = options.from;
  if (options.enabled !== undefined) enabled = options.enabled;
  if (options.detail) detail = options.detail;
}

/** Só grava no modo completo: o que é caro demais para a trilha do dia a dia. */
export const recordFull = (kind: TraceKind, label: string, extra: Partial<TraceEvent> = {}) => {
  if (detail === "completo") record(kind, label, extra);
};

export const traceEnabled = () => enabled;
export function beginTurn(id: string) { currentTurn = id; currentRound = undefined; currentCall = undefined; }
export const currentTurnId = () => currentTurn;

/** O visor em tempo real se inscreve aqui; a gravação segue independente. */
export function onTrace(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Escreve em lote. Gravar evento a evento no IndexedDB durante um stream de tokens seria a maior
 * fonte de latência do próprio sistema que se quer medir.
 */
function schedule() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = 0; void flush(); }, 400) as unknown as number;
}

export const openTraceDatabase = open;

export async function flush() {
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      for (const event of batch) store.add(event);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    void prune();
  } catch { /* sem IndexedDB, a trilha simplesmente não persiste */ }
}

/** Descarta o mais antigo quando passa do teto: a trilha é uma janela, não um arquivo eterno. */
async function prune() {
  const db = await open();
  const total = await new Promise<number>((resolve) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(0);
  });
  if (total <= MAX_EVENTS) return;
  const excess = total - MAX_EVENTS;
  await new Promise<void>((resolve) => {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const cursor = store.openCursor();
    let removed = 0;
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item || removed >= excess) { resolve(); return; }
      item.delete();
      removed += 1;
      item.continue();
    };
    cursor.onerror = () => resolve();
  });
}

/**
 * O que a costura preenche sozinha.
 *
 * Exigir que cada ponto de instrumentação repita a rodada e a chamada em que está seria garantir
 * que metade deles esqueceria — e um evento sem parentesco é justamente o que obriga o relatório a
 * adivinhar pela ordem. Quem entra numa rodada anuncia; quem grava herda.
 */
let currentRound: number | undefined;
let currentCall: string | undefined;
export function beginRound(round: number | undefined) { currentRound = round; currentCall = undefined; }
export function beginCall(callId: string | undefined) { currentCall = callId; }

export function record(kind: TraceKind, label: string, extra: Partial<TraceEvent> = {}) {
  if (!enabled) return;
  const event: TraceEvent = {
    at: Date.now(),
    turn: currentTurn,
    from: context,
    kind,
    label,
    round: currentRound,
    callId: currentCall,
    ...extra,
    data: extra.data ? sanitize(extra.data) as Record<string, unknown> : undefined,
  };
  for (const listener of listeners) listener(event);
  pending.push(event);
  schedule();
}

/**
 * Mede um trecho. `end` aceita o desfecho, então o mesmo span serve para sucesso e falha sem
 * duplicar evento — o que importa no ajuste fino é a duração ligada ao resultado.
 */
export function span(kind: TraceKind, label: string, data?: Record<string, unknown>) {
  const started = performance.now();
  return {
    end(extra: Partial<TraceEvent> = {}) {
      record(kind, label, { ms: Math.round(performance.now() - started), data, ...extra });
    },
  };
}

export type TraceFilter = { kinds?: TraceKind[]; turn?: string; since?: number; limit?: number; search?: string };

export async function readTrace(filter: TraceFilter = {}): Promise<TraceEvent[]> {
  await flush();
  try {
    const db = await open();
    const all = await new Promise<TraceEvent[]>((resolve) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result as TraceEvent[]);
      request.onerror = () => resolve([]);
    });
    const needle = filter.search?.toLowerCase();
    const filtered = all.filter((event) =>
      (!filter.kinds?.length || filter.kinds.includes(event.kind))
      && (!filter.turn || event.turn === filter.turn)
      && (!filter.since || event.at >= filter.since)
      && (!needle || `${event.label} ${JSON.stringify(event.data ?? "")}`.toLowerCase().includes(needle)));
    return filter.limit ? filtered.slice(-filter.limit) : filtered;
  } catch { return []; }
}

export async function clearTrace() {
  pending = [];
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).clear();
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  } catch { /* nada a limpar */ }
}

export async function traceSize(): Promise<{ events: number; bytes: number }> {
  const events = await readTrace();
  return { events: events.length, bytes: new Blob([JSON.stringify(events)]).size };
}

/** Uma linha por evento: o formato que ferramentas de análise leem sem preâmbulo. */
export const toJsonl = (events: TraceEvent[]) => events.map((event) => JSON.stringify(event)).join("\n");
