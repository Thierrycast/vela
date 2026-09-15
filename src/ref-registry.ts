/**
 * O espaço de nomes público dos refs: `e412`.
 *
 * O content script sabe quem é o elemento, mas não sabe que existe outro frame — dois frames
 * numerariam `#1` ao mesmo tempo. O background sabe de todos, mas não pode segurar um nó do DOM.
 * Daí a divisão: identidade lá, endereço aqui.
 *
 * O ganho de o ref ser **atômico** (`e412`, não `t847.f0.ref_3_12`) é duplo. Em tokens: três
 * contra onze, cento e cinquenta vezes por leitura, e leitura é o item mais repetido do turno — a
 * aba e o frame são constantes dentro de um bloco e cabem no cabeçalho, uma vez só. Em confiança:
 * um ref composto convida à recombinação, e o modelo monta `t847.f0.e12` juntando pedaços que viu
 * em lugares diferentes. Um número inteiro não tem partes para recombinar.
 *
 * Traduzir um ref é um `Map.get` — sem perguntar a frame nenhum, sem broadcast, sem ambiguidade.
 */

export type Route = { tabId: number; frameId: number; epoch: string; localId: number };
export type FrameContext = { tabId: number; frameId: number; epoch: string };

export type Lookup =
  | { status: "ok"; route: Route }
  | { status: "legacy" }
  | { status: "navigated"; tabId: number; from: string; to: string }
  | { status: "unknown" };

type Grave = { tabId: number; from: string; to: string; at: number };

const routes = new Map<number, Route>();
/** `tabId:frameId:epoch` → (id local do frame → id público). É ele que faz o ref ser **estável**:
 *  o mesmo elemento relido no mesmo documento recebe o número que já tinha. */
const reverse = new Map<string, Map<number, number>>();
const graves = new Map<number, Grave>();
/** `tabId:frameId` → última URL vista naquele frame. Ver `evictFrame`. */
const lastUrl = new Map<string, string>();
let counter = 0;

/** Tetos de memória. O service worker do MV3 morre e renasce; isto é cache, não verdade. */
const MAX_ROUTES = 20_000;
const MAX_GRAVES = 500;
const GRAVE_TTL = 5 * 60_000;

const docKey = (context: FrameContext) => `${context.tabId}:${context.frameId}:${context.epoch}`;

/** Formatos que existiram antes de o ref ser atômico. O histórico persiste entre atualizações da
 *  extensão, então eles **vão** chegar aqui — e merecem uma mensagem própria, não "ref inválido". */
const LEGACY_REF = /^(f\d+\.)?ref_\d+_\d+$/;

function trim() {
  if (routes.size > MAX_ROUTES) {
    for (const id of [...routes.keys()].slice(0, routes.size - MAX_ROUTES)) routes.delete(id);
  }
  const cutoff = Date.now() - GRAVE_TTL;
  for (const [id, grave] of graves) if (grave.at < cutoff) graves.delete(id);
  if (graves.size > MAX_GRAVES) {
    for (const id of [...graves.keys()].slice(0, graves.size - MAX_GRAVES)) graves.delete(id);
  }
}

/**
 * Troca os `[#12]` que o frame emitiu pelos refs públicos que o modelo vai ler.
 *
 * Vale para **todo** conteúdo que volta de um frame, não só para o retrato: antes, só
 * `readAllFrames` reescrevia refs, e os do `find` saíam sem identificação de frame nenhuma —
 * funcionavam por acaso, enquanto o alvo estivesse no frame de cima.
 */
export function allocateRefs(content: string, context: FrameContext): string {
  const key = docKey(context);
  let known = reverse.get(key);
  if (!known) { known = new Map(); reverse.set(key, known); }

  const result = content.replace(/\[#(\d+)\]/g, (_full, raw: string) => {
    const localId = Number(raw);
    const existing = known!.get(localId);
    if (existing !== undefined) return `[e${existing}]`;
    counter += 1;
    known!.set(localId, counter);
    routes.set(counter, { ...context, localId });
    return `[e${counter}]`;
  });
  trim();
  return result;
}

export function resolveRoute(ref: string): Lookup {
  const trimmed = ref.trim();
  if (LEGACY_REF.test(trimmed)) return { status: "legacy" };
  const match = /^e(\d+)$/.exec(trimmed);
  if (!match) return { status: "unknown" };
  const id = Number(match[1]);
  const route = routes.get(id);
  if (route) return { status: "ok", route };
  const grave = graves.get(id);
  return grave ? { status: "navigated", tabId: grave.tabId, from: grave.from, to: grave.to } : { status: "unknown" };
}

/**
 * O documento foi trocado: todo elemento que o modelo viu ali deixou de existir.
 *
 * As rotas não somem sem deixar rastro — viram lápide. A diferença aparece na mensagem de erro:
 * "não existe nenhum e412" não diz como se recuperar, enquanto "a aba 847 navegou de X para Y"
 * diz exatamente o que reler. É a pior mensagem do sistema virando a melhor pelo custo de um mapa.
 */
export function evictFrame(tabId: number, frameId: number, to: string) {
  /*
   * A URL de onde se saiu não dá para perguntar ao Chrome depois do fato: quando `onCommitted`
   * dispara, `tabs.get` já devolve o destino. Ela é lembrada aqui, no commit anterior — é o que
   * permite a lápide dizer "navegou de X para Y" em vez de só "o ref não existe".
   */
  const trail = `${tabId}:${frameId}`;
  const from = lastUrl.get(trail) ?? "";
  lastUrl.set(trail, to);
  for (const [key, known] of reverse) {
    if (!key.startsWith(`${tabId}:${frameId}:`)) continue;
    for (const publicId of known.values()) {
      routes.delete(publicId);
      graves.set(publicId, { tabId, from, to, at: Date.now() });
    }
    reverse.delete(key);
  }
  trim();
}

export function evictTab(tabId: number) {
  for (const [key, known] of reverse) {
    if (!key.startsWith(`${tabId}:`)) continue;
    for (const publicId of known.values()) routes.delete(publicId);
    reverse.delete(key);
  }
  for (const [id, grave] of graves) if (grave.tabId === tabId) graves.delete(id);
  for (const key of lastUrl.keys()) if (key.startsWith(`${tabId}:`)) lastUrl.delete(key);
}

/** Só para diagnóstico e testes: quantos refs vivos e quantas lápides. */
export const refRegistrySize = () => ({ routes: routes.size, graves: graves.size });
