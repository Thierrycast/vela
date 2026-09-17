import { BLOB_STORE, openTraceDatabase, traceDetail } from "./trace";

/**
 * Os binários da trilha — hoje, áudio.
 *
 * A transcrição é a interpretação do que foi dito; o áudio é o que foi dito. Quando as duas
 * discordam — e numa conversa falada elas discordam com frequência — só o áudio resolve a dúvida,
 * e sem ele a revisão vira discussão sobre quem entendeu errado. Guardar o trecho de fala é o que
 * torna a pergunta "o STT ouviu isso mesmo?" respondível.
 *
 * Três decisões que mantêm isto viável:
 *
 * - **Só no rastreio completo.** Áudio é caro; em uso normal a trilha não engorda nada.
 * - **Teto próprio, em bytes.** A store de eventos se poda por contagem, que não diz nada sobre
 *   tamanho quando cada item pesa megabytes. Aqui o corte é por espaço ocupado, do mais antigo
 *   para o mais novo.
 * - **Fica onde já se está.** Mesmo IndexedDB da trilha, porque offscreen e background compartilham
 *   a origem da extensão — o áudio capturado no offscreen é lido pelo painel sem trafegar por
 *   mensagem, que é o que tornaria isso pesado demais para valer a pena.
 */

export type TraceBlob = { id: string; at: number; turn: string; mime: string; label: string; bytes: ArrayBuffer };

/** Cem megabytes de fala são muitas horas de conversa; passar disso não ajuda ninguém a revisar. */
const MAX_BYTES = 100 * 1024 * 1024;

export async function saveBlob(input: { turn: string; mime: string; label: string; bytes: ArrayBuffer | Uint8Array }): Promise<string | undefined> {
  if (traceDetail() !== "completo") return undefined;
  const id = crypto.randomUUID();
  const bytes = input.bytes instanceof Uint8Array ? input.bytes.slice().buffer : input.bytes;
  try {
    const db = await openTraceDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(BLOB_STORE, "readwrite");
      transaction.objectStore(BLOB_STORE).add({ id, at: Date.now(), turn: input.turn, mime: input.mime, label: input.label, bytes } satisfies TraceBlob);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    void prune();
    return id;
  } catch {
    return undefined;
  }
}

export async function readBlob(id: string): Promise<TraceBlob | null> {
  try {
    const db = await openTraceDatabase();
    return await new Promise((resolve) => {
      const request = db.transaction(BLOB_STORE, "readonly").objectStore(BLOB_STORE).get(id);
      request.onsuccess = () => resolve((request.result as TraceBlob | undefined) ?? null);
      request.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export async function listBlobs(turn?: string): Promise<Array<Omit<TraceBlob, "bytes"> & { size: number }>> {
  try {
    const db = await openTraceDatabase();
    const todos = await new Promise<TraceBlob[]>((resolve) => {
      const request = db.transaction(BLOB_STORE, "readonly").objectStore(BLOB_STORE).getAll();
      request.onsuccess = () => resolve(request.result as TraceBlob[]);
      request.onerror = () => resolve([]);
    });
    return todos
      .filter((item) => !turn || item.turn === turn)
      .map(({ bytes, ...resto }) => ({ ...resto, size: bytes.byteLength }));
  } catch { return []; }
}

export async function blobsSize(): Promise<{ count: number; bytes: number }> {
  const todos = await listBlobs();
  return { count: todos.length, bytes: todos.reduce((soma, item) => soma + item.size, 0) };
}

export async function clearBlobs() {
  try {
    const db = await openTraceDatabase();
    await new Promise<void>((resolve) => {
      const request = db.transaction(BLOB_STORE, "readwrite").objectStore(BLOB_STORE).clear();
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  } catch { /* nada a limpar */ }
}

/** Corta por espaço, do mais antigo para o mais novo — uma janela de áudio, não um arquivo eterno. */
async function prune() {
  const { bytes } = await blobsSize();
  if (bytes <= MAX_BYTES) return;
  const db = await openTraceDatabase();
  let excesso = bytes - MAX_BYTES;
  await new Promise<void>((resolve) => {
    const store = db.transaction(BLOB_STORE, "readwrite").objectStore(BLOB_STORE);
    const cursor = store.index("at").openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item || excesso <= 0) { resolve(); return; }
      excesso -= (item.value as TraceBlob).bytes.byteLength;
      item.delete();
      item.continue();
    };
    cursor.onerror = () => resolve();
  });
}
