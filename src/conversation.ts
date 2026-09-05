import { ChatMessage } from "./types";
import { loadMessages, loadConversations, saveConversations } from "./storage";

export type ConversationSummary = { id: string; title: string; updatedAt: number };
export type Conversation = ConversationSummary & { messages: ChatMessage[] };

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 200;

let cache: Conversation[] | null = null;
let activeId: string | null = null;
let persistTimer = 0;

function makeConversation(): Conversation {
  return { id: crypto.randomUUID(), title: "Nova tarefa", updatedAt: Date.now(), messages: [] };
}

function titleFrom(messages: ChatMessage[]) {
  const first = messages.find((item) => item.role === "user");
  return first ? first.content.replace(/\s+/g, " ").slice(0, 48) : "Nova tarefa";
}

async function ensure(): Promise<Conversation[]> {
  if (cache) return cache;
  cache = await loadConversations();
  if (!cache.length) {
    // Migração do formato antigo, que guardava uma lista única de mensagens.
    const legacy = await loadMessages();
    cache = [legacy.length ? { id: crypto.randomUUID(), title: titleFrom(legacy), updatedAt: Date.now(), messages: legacy } : makeConversation()];
  }
  activeId ??= cache[0].id;
  return cache;
}

async function active(): Promise<Conversation> {
  const conversations = await ensure();
  return conversations.find((item) => item.id === activeId) ?? conversations[0];
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = 0; void flush(); }, 400) as unknown as number;
}

export async function flush() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = 0; }
  if (!cache) return;
  const trimmed = cache
    .map((item) => ({ ...item, messages: item.messages.slice(-MAX_MESSAGES) }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
  await saveConversations(trimmed);
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
  await flush();
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
