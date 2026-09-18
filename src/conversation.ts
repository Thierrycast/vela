import { ChatMessage } from "./types";
import { loadConversationIndex, loadConversationsById, loadMessages, saveConversationChanges } from "./storage";

export type ConversationSummary = { id: string; title: string; updatedAt: number };
export type Conversation = ConversationSummary & { messages: ChatMessage[] };

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 200;

let cache: Conversation[] | null = null;
let activeId: string | null = null;
let persistTimer = 0;
/** O que mudou desde a última gravação: é só isso que vai ao storage. */
const sujas = new Set<string>();
const removidas = new Set<string>();

function makeConversation(): Conversation {
  return { id: crypto.randomUUID(), title: "Nova tarefa", updatedAt: Date.now(), messages: [] };
}

function titleFrom(messages: ChatMessage[]) {
  const first = messages.find((item) => item.role === "user");
  return first ? first.content.replace(/\s+/g, " ").slice(0, 48) : "Nova tarefa";
}

async function ensure(): Promise<Conversation[]> {
  if (cache) return cache;
  const indice = await loadConversationIndex();
  cache = await loadConversationsById(indice.map((item) => item.id));
  if (!cache.length) {
    // Migração do formato antigo, que guardava uma lista única de mensagens.
    const legacy = await loadMessages();
    cache = [legacy.length ? { id: crypto.randomUUID(), title: titleFrom(legacy), updatedAt: Date.now(), messages: legacy } : makeConversation()];
    sujas.add(cache[0].id);
  }
  activeId ??= cache[0].id;
  curarRespostasInterrompidas(cache);
  return cache;
}

/*
 * Resposta que ficou "sendo escrita" para sempre.
 *
 * O status vive na mensagem e é gravado junto com ela. Se o navegador fecha (ou o service worker
 * morre) no meio de um turno, aquela mensagem fica `streaming` no disco — e ao reabrir a extensão
 * dias depois o painel mostra o carrossel de "pensando" numa resposta que morreu, sem nada rodando
 * para parar. Foi o que aconteceu numa sessão real: a Vela parecia estar trabalhando numa mensagem
 * de dias atrás, e o botão de parar não tinha o que parar.
 *
 * Quem carrega a conversa cura: com texto, a resposta vale o que chegou; sem texto, ela diz que foi
 * interrompida — que é a verdade, e é acionável (dá para pedir de novo).
 */
function curarRespostasInterrompidas(conversas: Conversation[]) {
  for (const conversa of conversas) {
    let mudou = false;
    for (const mensagem of conversa.messages) {
      if (mensagem.status !== "streaming") continue;
      mudou = true;
      if (mensagem.content.trim()) mensagem.status = "complete";
      else { mensagem.content = "A resposta foi interrompida antes de começar (o navegador fechou, ou a extensão foi recarregada). Peça de novo, se ainda precisar."; mensagem.status = "error"; }
    }
    // A cura vai para o disco: sem isso ela se repetiria a cada abertura, e a conversa continuaria
    // gravada com uma resposta eternamente "sendo escrita".
    if (mudou) { sujas.add(conversa.id); schedulePersist(conversa.id); }
  }
}

async function active(): Promise<Conversation> {
  const conversations = await ensure();
  return conversations.find((item) => item.id === activeId) ?? conversations[0];
}

function schedulePersist(id = activeId) {
  if (id) sujas.add(id);
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = 0; void flush(); }, 400) as unknown as number;
}

export async function flush() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = 0; }
  if (!cache) return;
  cache.sort((left, right) => right.updatedAt - left.updatedAt);
  /*
   * As que passam do teto saem da memória e do storage — **menos a que está aberta**.
   *
   * Abrir uma conversa antiga não mexe no `updatedAt` dela (ler não é usar), então com mais de
   * cinquenta conversas ela ficava além do corte: a primeira gravação disparada por qualquer outro
   * caminho apagava justamente a conversa que a pessoa estava lendo, e a tela caía na primeira da
   * lista sem explicação.
   */
  const sobrando = cache.filter((item) => item.id !== activeId).slice(MAX_CONVERSATIONS - 1);
  for (const sobra of sobrando) {
    cache.splice(cache.indexOf(sobra), 1);
    removidas.add(sobra.id);
    sujas.delete(sobra.id);
  }
  const mudadas = cache
    .filter((item) => sujas.has(item.id))
    // Captura não é persistida: uma tela em base64 come o orçamento de `chrome.storage.local`
    // sozinha, e ao reabrir a conversa ela já estaria mentindo sobre o que está na página.
    .map((item) => ({ ...item, messages: item.messages.slice(-MAX_MESSAGES).map((message) => message.images ? { ...message, images: undefined } : message) }));
  const apagar = [...removidas];
  /*
   * As marcas de "mudou" só saem depois que a gravação deu certo.
   *
   * Limpando antes, uma falha de escrita (cota estourada, worker derrubado no meio) levava junto a
   * informação de que aquela conversa ainda precisava ser salva: nenhuma gravação futura tentaria de
   * novo, e a mensagem se perdia em silêncio.
   */
  try {
    await saveConversationChanges(cache.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })), mudadas, apagar);
    for (const item of mudadas) sujas.delete(item.id);
    for (const id of apagar) removidas.delete(id);
  } catch {
    // Fica tudo marcado: a próxima gravação tenta de novo.
  }
}

export async function all(): Promise<ChatMessage[]> { return (await active()).messages; }

export async function append(...items: ChatMessage[]) {
  const conversation = await active();
  conversation.messages.push(...items);
  conversation.updatedAt = Date.now();
  if (conversation.title === "Nova tarefa") conversation.title = titleFrom(conversation.messages);
  schedulePersist();
}

export async function appendText(id: string, text: string) {
  const message = (await active()).messages.find((item) => item.id === id);
  if (message) { message.content += text; schedulePersist(); }
}

export async function patch(id: string, values: Partial<ChatMessage>) {
  const message = (await active()).messages.find((item) => item.id === id);
  if (message) { Object.assign(message, values); schedulePersist(); }
}

/** Arquiva a conversa atual e começa outra; nada é perdido. */
export async function reset() {
  const conversations = await ensure();
  const current = await active();
  if (!current.messages.length) { current.updatedAt = Date.now(); await flush(); return; }
  const next = makeConversation();
  conversations.unshift(next);
  activeId = next.id;
  sujas.add(current.id);
  await flush();
}

/**
 * Apaga uma conversa. Não havia como apagar nenhuma: o histórico só abria, e uma tarefa de teste
 * ficava para sempre na lista das dez recentes, empurrando o trabalho real para fora da vista.
 *
 * Devolve se a conversa apagada era a ativa, porque nesse caso quem chamou precisa republicar a
 * tela — o painel estaria mostrando mensagens que já não existem em lugar nenhum.
 */
export async function remove(id: string): Promise<{ existia: boolean; eraAtiva: boolean }> {
  const conversations = await ensure();
  const index = conversations.findIndex((item) => item.id === id);
  if (index < 0) return { existia: false, eraAtiva: false };

  const eraAtiva = conversations[index].id === activeId;
  conversations.splice(index, 1);
  removidas.add(id);
  sujas.delete(id);
  // Apagar a última deixaria `ensure` recarregando do storage e ressuscitando o que foi apagado,
  // porque uma lista vazia é o sinal de "cache frio". Uma conversa nova toma o lugar.
  if (!conversations.length) conversations.push(makeConversation());
  if (eraAtiva) activeId = conversations[0].id;
  await flush();
  return { existia: true, eraAtiva };
}

export async function messageById(id: string): Promise<ChatMessage | null> {
  return (await active()).messages.find((item) => item.id === id) ?? null;
}

/** Corta a conversa a partir de uma mensagem (inclusive). É o que sustenta editar, reenviar e
 *  gerar outra resposta: em vez de anexar correções ao fim, a linha do tempo volta ao ponto. */
export async function truncateFrom(id: string): Promise<ChatMessage | null> {
  const conversation = await active();
  const index = conversation.messages.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const [target] = conversation.messages.splice(index, conversation.messages.length - index);
  conversation.updatedAt = Date.now();
  schedulePersist();
  return target ?? null;
}

/** A mensagem do usuário que antecede uma resposta — o ponto de partida de "gerar outra". */
export async function previousUserMessage(id: string): Promise<ChatMessage | null> {
  const messages = (await active()).messages;
  const index = messages.findIndex((item) => item.id === id);
  if (index < 0) return null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === "user") return messages[cursor];
  }
  return null;
}

export async function list(): Promise<ConversationSummary[]> {
  const conversations = await ensure();
  return conversations
    .filter((item) => item.messages.length)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
}

export async function open(id: string): Promise<boolean> {
  const conversations = await ensure();
  if (!conversations.some((item) => item.id === id)) return false;
  activeId = id;
  return true;
}
