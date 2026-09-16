import { registrableDomain } from "./domain-policy";

/**
 * Por onde se chega a cada coisa, em cada site.
 *
 * A Vela reaprende o mesmo caminho toda vez. Procurar o campo de busca do mesmo site na segunda
 * conversa custa exatamente o que custou na primeira — a varredura da página inteira, a pontuação,
 * e a chance de escolher outro elemento parecido. Um caminho que já funcionou é informação barata
 * de guardar e cara de redescobrir.
 *
 * O que se guarda é deliberadamente pobre: domínio, o que se procurava, e um seletor. Não é um
 * modelo do site nem um roteiro de tarefa — é um atalho para a primeira tentativa, que continua
 * sendo verificado como qualquer outro palpite.
 *
 * Três decisões que tornam isto seguro:
 *
 * - **Palpite, nunca resposta.** O seletor entra como sugestão na busca; se não casar exatamente
 *   um elemento visível, a varredura normal acontece como se o cache não existisse. Cache que
 *   decide sozinho é pior que cache nenhum, porque erra com confiança quando o site muda.
 * - **Morre na primeira mentira.** Um erro apaga a entrada. Site muda de layout sem avisar, e um
 *   atalho quebrado que insiste custa mais do que nunca ter existido.
 * - **Nunca entra no prompt sozinho.** Diferente da memória, isto não é lido pelo modelo nem
 *   escrito por ele — é consultado pelo código, na hora da busca. Um texto que o site controla e
 *   que entra sozinho no system prompt é o canal clássico de injeção persistente.
 */

const KEY = "vela:route-cache";
const MAX_ENTRIES = 400;
/** Duas semanas: tempo suficiente para valer numa rotina, curto para não fossilizar um layout. */
const TTL = 14 * 24 * 60 * 60 * 1000;

export type CachedRoute = { selector: string; hits: number; updatedAt: number };
type Store = Record<string, CachedRoute>;

const keyOf = (url: string, query: string) => `${registrableDomain(url)}|${query.toLowerCase().trim().slice(0, 60)}`;

async function load(): Promise<Store> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return {};
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as Store | undefined) ?? {};
}

const save = (store: Store) => chrome.storage.local.set({ [KEY]: store });

export async function rememberRoute(url: string, query: string, selector: string) {
  if (!selector || !query.trim()) return;
  const store = await load();
  const key = keyOf(url, query);
  const current = store[key];
  store[key] = { selector, hits: (current?.selector === selector ? current.hits : 0) + 1, updatedAt: Date.now() };

  const cutoff = Date.now() - TTL;
  for (const [entry, value] of Object.entries(store)) if (value.updatedAt < cutoff) delete store[entry];
  const keys = Object.keys(store);
  if (keys.length > MAX_ENTRIES) {
    const oldest = keys.sort((first, second) => store[first].updatedAt - store[second].updatedAt).slice(0, keys.length - MAX_ENTRIES);
    for (const entry of oldest) delete store[entry];
  }
  await save(store);
}

export async function recallRoute(url: string, query: string): Promise<string | undefined> {
  if (!query.trim()) return undefined;
  const store = await load();
  const entry = store[keyOf(url, query)];
  if (!entry) return undefined;
  if (entry.updatedAt < Date.now() - TTL) return undefined;
  return entry.selector;
}

/** O atalho mentiu: sai da memória em vez de continuar sendo tentado. */
export async function forgetRoute(url: string, query: string) {
  const store = await load();
  const key = keyOf(url, query);
  if (!(key in store)) return;
  delete store[key];
  await save(store);
}

export async function clearRouteCache() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) await chrome.storage.local.remove(KEY);
}

export async function routeCacheSize() {
  return Object.keys(await load()).length;
}
