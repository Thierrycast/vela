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

export type TraceKind =
  | "turn" | "user.input" | "model.request" | "model.stream" | "model.text" | "model.tool"
  | "tool.call" | "action" | "page.read" | "navigation"
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
};

const DATABASE = "vela-trace";
const STORE = "events";
const MAX_EVENTS = 20_000;
const MAX_STRING = 2_000;

/** Nomes cujo valor nunca entra na trilha, em qualquer profundidade. */
const SECRET = /^(apikey|api_key|authorization|token|password|senha|secret|cookie)$/i;

/**
 * Trunca e redige. Um trace que vaza a chave de API não pode ser exportado nem compartilhado —
 * e a graça dele é justamente poder anexar num relatório.
 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return "[profundo demais]";
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitize(item, depth + 1));
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
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      store.createIndex("at", "at");
      store.createIndex("turn", "turn");
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

export function configureTrace(options: { from?: string; enabled?: boolean }) {
  if (options.from) context = options.from;
  if (options.enabled !== undefined) enabled = options.enabled;
}

export const traceEnabled = () => enabled;
export function beginTurn(id: string) { currentTurn = id; }
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

export function record(kind: TraceKind, label: string, extra: Partial<TraceEvent> = {}) {
  if (!enabled) return;
  const event: TraceEvent = {
    at: Date.now(),
    turn: currentTurn,
    from: context,
    kind,
    label,
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
