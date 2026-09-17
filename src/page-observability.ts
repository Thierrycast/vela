import { enableDomain, releaseObserver, whenSessionEnds, withSession } from "./cdp-session";

/**
 * O que a página diz para si mesma: console e rede.
 *
 * É a diferença entre entender a interface e entender o site. Uma lista que carrega por XHR expõe,
 * na rede, o endereço que devolve os dados prontos — e chegar a eles por ali resolve em um passo o
 * que a interface resolveria em oito, sem rolagem, sem paginação, sem esperar animação. O console
 * conta a outra metade: quando uma ação não teve efeito, muitas vezes o motivo já está escrito lá,
 * e sem isso o agente fica adivinhando.
 *
 * Três decisões que mantêm isto seguro e barato:
 *
 * - **Grava a partir de quando se pede.** Nada é capturado sem que a habilidade esteja ligada e a
 *   leitura tenha sido pedida naquela aba. A resposta diz isso com todas as letras, porque um
 *   buffer vazio que parece completo é pior que um buffer ausente — o modelo concluiria que a
 *   página não fez requisição nenhuma.
 * - **Nunca guarda credencial.** Cabeçalhos não entram; a URL entra com os parâmetros sensíveis
 *   apagados. Um token em query string é exatamente o tipo de coisa que acabaria no histórico da
 *   conversa e, de lá, no contexto do modelo.
 * - **Esquece ao trocar de domínio.** O que a página anterior conversou não descreve esta.
 */

export type ConsoleEntry = { level: string; text: string; at: number };
export type NetworkEntry = { method: string; url: string; status?: number; type?: string; size?: number; at: number };

const MAX_ENTRIES = 300;
const SENSITIVE_PARAM = /(token|key|secret|password|senha|auth|session|signature|sig)/i;

type Buffers = { console: ConsoleEntry[]; network: NetworkEntry[]; pending: Map<string, NetworkEntry>; host: string };
const buffers = new Map<number, Buffers>();
const watching = { console: new Set<number>(), network: new Set<number>() };
let listening = false;

function bufferOf(tabId: number): Buffers {
  const existing = buffers.get(tabId);
  if (existing) return existing;
  const fresh: Buffers = { console: [], network: [], pending: new Map(), host: "" };
  buffers.set(tabId, fresh);
  return fresh;
}

/** Um token em query string acabaria no histórico da conversa e, de lá, no contexto do modelo. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    for (const [name] of [...parsed.searchParams]) {
      if (SENSITIVE_PARAM.test(name)) parsed.searchParams.set(name, "[omitido]");
    }
    return parsed.toString().slice(0, 300);
  } catch {
    return url.slice(0, 300);
  }
}

/** Trocou de site, esvazia: o que a página anterior conversou não descreve esta. */
function resetOnNavigation(tabId: number, url: string) {
  const buffer = bufferOf(tabId);
  let host: string;
  try { host = new URL(url).host; } catch { host = ""; }
  if (host && buffer.host && host !== buffer.host) {
    buffer.console = [];
    buffer.network = [];
    buffer.pending.clear();
  }
  if (host) buffer.host = host;
}

const push = <T>(list: T[], item: T) => {
  list.push(item);
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
};

/** Um argumento de `console.log` chega como objeto remoto; o que interessa é como ele se lê. */
function readArgument(argument: { value?: unknown; description?: string; preview?: { description?: string } }): string {
  if (argument?.value !== undefined) return typeof argument.value === "string" ? argument.value : JSON.stringify(argument.value);
  return argument?.description ?? argument?.preview?.description ?? "[objeto]";
}

function ensureListener() {
  if (listening || typeof chrome === "undefined" || !chrome.debugger?.onEvent) return;
  listening = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const payload = (params ?? {}) as Record<string, unknown>;
    const buffer = bufferOf(tabId);

    if (method === "Runtime.consoleAPICalled") {
      const args = (payload.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
      push(buffer.console, { level: String(payload.type ?? "log"), text: args.map(readArgument).join(" ").slice(0, 500), at: Date.now() });
      return;
    }
    if (method === "Log.entryAdded") {
      const entry = payload.entry as { level?: string; text?: string; url?: string } | undefined;
      if (entry) push(buffer.console, { level: entry.level ?? "log", text: `${entry.text ?? ""}${entry.url ? ` (${redact(entry.url)})` : ""}`.slice(0, 500), at: Date.now() });
      return;
    }
    if (method === "Network.requestWillBeSent") {
      const request = payload.request as { url?: string; method?: string } | undefined;
      const id = String(payload.requestId ?? "");
      if (!request?.url) return;
      // A navegação do documento principal é o sinal de que a página trocou.
      if (payload.type === "Document") resetOnNavigation(tabId, request.url);
      const entry: NetworkEntry = { method: request.method ?? "GET", url: redact(request.url), type: String(payload.type ?? ""), at: Date.now() };
      buffer.pending.set(id, entry);
      push(buffer.network, entry);
      return;
    }
    if (method === "Network.responseReceived") {
      const response = payload.response as { status?: number; mimeType?: string } | undefined;
      const entry = buffer.pending.get(String(payload.requestId ?? ""));
      if (entry && response) { entry.status = response.status; entry.type = response.mimeType ?? entry.type; }
      return;
    }
    if (method === "Network.loadingFinished") {
      const id = String(payload.requestId ?? "");
      const entry = buffer.pending.get(id);
      if (entry) { entry.size = Number(payload.encodedDataLength ?? 0); buffer.pending.delete(id); }
    }
  });
}

type Kind = "console" | "network";

/** Liga a gravação e devolve se ela já estava de pé — a resposta precisa dizer se o silêncio do
 *  buffer significa "a página não fez nada" ou "eu não estava ouvindo ainda". */
export async function startWatching(tabId: number, kind: Kind): Promise<{ ok: boolean; jaEstava: boolean; motivo?: string }> {
  ensureListener();
  if (watching[kind].has(tabId)) return { ok: true, jaEstava: true };
  return withSession(tabId, "observe", async () => {
    try {
      if (kind === "console") { await enableDomain(tabId, "Runtime"); await enableDomain(tabId, "Log"); }
      else await enableDomain(tabId, "Network");
      watching[kind].add(tabId);
      return { ok: true, jaEstava: false };
    } catch (error) {
      return { ok: false, jaEstava: false, motivo: error instanceof Error ? error.message : "o depurador recusou o comando" };
    }
  }, () => ({ ok: false, jaEstava: false, motivo: "não consegui anexar o depurador a esta aba (o DevTools pode estar aberto nela)" }));
}

export function stopWatching(tabId: number) {
  watching.console.delete(tabId);
  watching.network.delete(tabId);
  buffers.delete(tabId);
  void releaseObserver(tabId);
}

/*
 * A gravação morre junto com a sessão do depurador.
 *
 * Sem isto a marca de "estou observando esta aba" sobrevivia ao fim do turno, enquanto os domínios
 * do protocolo tinham sido desligados junto com o anexo. Na tarefa seguinte, `startWatching`
 * responderia `jaEstava: true` — e a leitura viria vazia, parecendo que a página não fez nada,
 * quando na verdade ninguém estava ouvindo.
 */
whenSessionEnds(stopWatching);

export function readConsole(tabId: number, pattern: string | undefined, limit: number): ConsoleEntry[] {
  const all = bufferOf(tabId).console;
  const filtered = pattern ? all.filter((entry) => entry.text.toLowerCase().includes(pattern.toLowerCase()) || entry.level === pattern) : all;
  return filtered.slice(-limit);
}

export function readNetwork(tabId: number, pattern: string | undefined, limit: number): NetworkEntry[] {
  const all = bufferOf(tabId).network;
  const filtered = pattern ? all.filter((entry) => entry.url.toLowerCase().includes(pattern.toLowerCase())) : all;
  return filtered.slice(-limit);
}
