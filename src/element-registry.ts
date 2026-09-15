import { accessibleName, everyElement, fold, isVisible, roleOf } from "./dom-semantics";

/**
 * A identidade dos elementos que a Vela já mostrou ao modelo.
 *
 * Antes, cada leitura da página criava um universo novo: os refs eram `ref_<leitura>_<posição>`,
 * e a leitura seguinte invalidava todos os anteriores. Consequência prática — depois de qualquer
 * clique que mexesse no DOM, o modelo tinha que reler a página inteira só para reconquistar o
 * direito de clicar no botão ao lado. Era a maior fonte de rodadas desperdiçadas do sistema.
 *
 * Aqui o ref pertence ao elemento, não à leitura. Enquanto o nó existir, o número continua valendo.
 *
 * **O estado mora em `window`, e isso não é estilo.** `navigation.ts` e `injection.ts` reinjetam
 * `content.js` em frames que já o têm; a trava `__velaLoaded` impede o listener duplicado, mas não
 * impede o módulo de reexecutar. Com o mapa em escopo de módulo, cada reinjeção zeraria a
 * identidade de tudo — e, ao contrário do que acontecia antes, isso não daria erro visível: daria
 * um ref reaproveitado apontando para outro elemento.
 *
 * ## O risco que a estabilidade cria
 *
 * Ref estável tem um custo que ref volátil não tinha. Numa lista virtualizada — React e Vue
 * reaproveitam o mesmo `<div>` para outra linha conforme se rola — o nó continua vivo e passa a
 * significar outra coisa. Sem defesa, o agente clicaria em "Cancelar pedido #2211" achando que
 * cancela o #1043, **e reportaria sucesso**. Por isso todo ref carrega uma assinatura, conferida
 * antes de cada uso: a assinatura não descreve o elemento, descreve *o que foi mostrado ao
 * modelo*, e a pergunta que ela responde é "isto ainda é a coisa que eu te descrevi?".
 */

export type Signature = {
  tag: string;
  role: string;
  /** O discriminador. Numa lista reciclada tudo se mantém — tag, papel, classes, posição — e o
   *  texto muda. É o único campo que pega esse caso. */
  nameHash: number;
  /** Os primeiros caracteres do nome, crus. Existe para a **mensagem de erro** poder dizer o que
   *  o elemento era quando o modelo o leu; um erro que só diz "mudou" custa uma rodada a mais. */
  nameShown: string;
  attrHash: number;
  /** Só desempate. Em lista virtualizada a posição no DOM não muda — é esse o ponto da
   *  virtualização — e em SPA ela muda o tempo todo sem que nada de errado aconteça. */
  path: string;
};

export type Verdict = "identical" | "moved" | "drifted" | "recycled";

export type Resolution =
  | { status: "ok"; element: Element; verdict: Verdict; recorded: string; current: string; rebound: boolean }
  | { status: "gone"; recorded: string }
  | { status: "changed"; recorded: string; current: string }
  | { status: "unknown" };

type RefRecord = { node: WeakRef<Element>; sig: Signature; seenAt: number };
type Registry = { refs: Map<number, RefRecord>; reverse: WeakMap<Element, number>; counter: number; epoch: string };
type VelaWindow = Window & { __velaRegistry?: Registry };

/** Teto de refs vivos por documento. Um SPA lido cinquenta vezes acumularia sem limite. */
const MAX_REFS = 2000;
/** Nomes que casam com qualquer coisa: re-resolver por eles erra com confiança. */
const GENERIC = new Set(["ok", "x", "+", "-", "...", "…", "mais", "menos", "fechar", "abrir", "editar", "excluir", "remover", "ver", "sim", "nao", "voltar", "proximo", "anterior"]);

function registry(): Registry {
  const holder = window as VelaWindow;
  if (!holder.__velaRegistry) {
    holder.__velaRegistry = { refs: new Map(), reverse: new WeakMap(), counter: 0, epoch: crypto.randomUUID() };
  }
  return holder.__velaRegistry;
}

/** Identifica este documento. Se o content script recarregou, o epoch muda — e o background
 *  descobre que os refs que ele tinha em mãos pertencem a um documento que não existe mais. */
export const epoch = () => registry().epoch;

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function pathOf(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  for (let level = 0; node && level < 6; level += 1) {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const siblings = [...parent.children].filter((child) => child.tagName === node!.tagName);
    parts.unshift(`${node.tagName.toLowerCase()}:${siblings.indexOf(node)}`);
    node = parent;
  }
  return parts.join("/");
}

function attributeFingerprint(element: Element): number {
  const parts = ["id", "name", "data-testid", "data-test", "href", "type", "value"]
    .map((attribute) => `${attribute}=${element.getAttribute(attribute) ?? ""}`);
  return hash(parts.join("|"));
}

export function signatureOf(element: Element): Signature {
  const name = accessibleName(element);
  return {
    tag: element.tagName.toLowerCase(),
    role: roleOf(element),
    nameHash: hash(fold(name)),
    nameShown: name.slice(0, 60),
    attrHash: attributeFingerprint(element),
    path: pathOf(element),
  };
}

/** Rótulo que só difere em número — "3 novas mensagens" e "4 novas mensagens" — é o mesmo botão. */
const withoutDigits = (value: string) => fold(value).replace(/\d+/g, "#");

function compare(recorded: Signature, current: Signature): Verdict {
  if (recorded.role !== current.role || recorded.tag !== current.tag) return "recycled";
  if (recorded.attrHash !== current.attrHash) return "recycled";
  if (recorded.nameHash === current.nameHash) return recorded.path === current.path ? "identical" : "moved";
  if (withoutDigits(recorded.nameShown) === withoutDigits(current.nameShown)) return "drifted";
  return "recycled";
}

const distinctive = (sig: Signature) => sig.nameShown.trim().length >= 3 && !GENERIC.has(fold(sig.nameShown));

/**
 * O item que o modelo queria normalmente **ainda está na página** — o nó é que foi reaproveitado
 * para outra linha. Reencontrá-lo pelo texto transforma o caso mais comum de reciclagem numa ação
 * bem-sucedida, em vez de uma rodada perdida.
 *
 * Dois portões, ambos obrigatórios: o nome precisa ser distintivo (nome genérico casa com dezenas
 * de nós) e o candidato precisa ser **único** (com dois "Pedido #1043" na página, escolher um é
 * exatamente o clique-errado-silencioso que este módulo existe para impedir).
 */
function reresolve(sig: Signature): Element | null {
  if (!distinctive(sig)) return null;
  const pool: Element[] = [];
  everyElement(document, pool, 12_000);
  const matches = pool.filter((element) =>
    roleOf(element) === sig.role
    && element.tagName.toLowerCase() === sig.tag
    && hash(fold(accessibleName(element))) === sig.nameHash
    && attributeFingerprint(element) === sig.attrHash
    && isVisible(element));
  return matches.length === 1 ? matches[0] : null;
}

function bind(id: number, element: Element, sig: Signature) {
  const store = registry();
  store.refs.set(id, { node: new WeakRef(element), sig, seenAt: Date.now() });
  store.reverse.set(element, id);
}

/** Devolve o id que este elemento já tinha, ou cria um. A assinatura é **regravada** a cada
 *  leitura: se a página atualizou a linha no lugar e o modelo viu a atualização, os dois seguem
 *  concordando sobre o que aquele ref significa. */
export function registerElement(element: Element): number {
  const store = registry();
  const known = store.reverse.get(element);
  if (known !== undefined && store.refs.get(known)?.node.deref() === element) {
    bind(known, element, signatureOf(element));
    return known;
  }
  store.counter += 1;
  bind(store.counter, element, signatureOf(element));
  return store.counter;
}

export function resolveLocal(id: number): Resolution {
  const store = registry();
  const record = store.refs.get(id);
  if (!record) return { status: "unknown" };

  const element = record.node.deref();
  if (!element || !element.isConnected) {
    const found = reresolve(record.sig);
    if (!found) return { status: "gone", recorded: record.sig.nameShown };
    bind(id, found, signatureOf(found));
    return { status: "ok", element: found, verdict: "moved", recorded: record.sig.nameShown, current: record.sig.nameShown, rebound: true };
  }

  const current = signatureOf(element);
  const verdict = compare(record.sig, current);
  if (verdict === "recycled") {
    const found = reresolve(record.sig);
    if (!found) return { status: "changed", recorded: record.sig.nameShown, current: current.nameShown };
    bind(id, found, signatureOf(found));
    return { status: "ok", element: found, verdict: "moved", recorded: record.sig.nameShown, current: record.sig.nameShown, rebound: true };
  }

  record.seenAt = Date.now();
  if (verdict === "drifted") record.sig = current;
  return { status: "ok", element, verdict, recorded: record.sig.nameShown, current: current.nameShown, rebound: false };
}

/** O ref como ele chega do background, já traduzido para o número local deste frame: `#12`. */
export function resolveRef(ref: string): Resolution {
  const match = /^#(\d+)$/.exec(ref.trim());
  return match ? resolveLocal(Number(match[1])) : { status: "unknown" };
}

/**
 * Varre os mortos ao fim de cada leitura.
 *
 * `isConnected` além de `deref()`: um nó destacado que o framework segura num pool de reciclagem
 * ainda tem referência viva e é perfeitamente inclicável — testar só a coleta de lixo o deixaria
 * no mapa para sempre.
 */
export function sweep() {
  const store = registry();
  for (const [id, record] of store.refs) {
    const element = record.node.deref();
    if (!element || !element.isConnected) store.refs.delete(id);
  }
  if (store.refs.size <= MAX_REFS) return;
  const oldestFirst = [...store.refs.entries()].sort((first, second) => first[1].seenAt - second[1].seenAt);
  for (const [id] of oldestFirst.slice(0, store.refs.size - Math.floor(MAX_REFS * 0.8))) store.refs.delete(id);
}
