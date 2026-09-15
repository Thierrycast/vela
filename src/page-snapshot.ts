import { accessibleName, everyElement, fold, isInteractive, isSensitive, isVisible, roleOf } from "./dom-semantics";
import { registerElement, sweep } from "./element-registry";

const MAX_NODES = 150;
/** Teto da varredura, para não passear por uma página infinita — o corte de verdade é o de cima. */
const HARD_LIMIT = 1200;
const MAX_NAME = 100;
const DEFAULT_BUDGET = 12000;

/**
 * Os refs saem daqui como `[#12]` — o número que o elemento tem **neste frame**.
 *
 * O background troca cada um pelo ref público (`[e412]`) antes de o texto chegar ao modelo, e faz
 * o caminho inverso quando uma ação volta. É ele que garante que o `#12` do topo da página e o
 * `#12` de dentro de um iframe não colidam, e é ele que sabe a qual aba cada ref pertence.
 */
function describe(element: Element, bypassWireguard: boolean = false) {
  const role = roleOf(element);
  const name = accessibleName(element, bypassWireguard).slice(0, MAX_NAME);
  const parts = [`[#${registerElement(element)}]<${role}`];
  if (name) parts.push(`name="${name.replace(/"/g, "'")}"`);
  const href = element.getAttribute("href");
  if (href) { try { const url = new URL(href, location.href); parts.push(`href="${url.host}${url.pathname.slice(0, 40)}"`); } catch { /* href relativo inválido */ } }
  const type = element.getAttribute("type");
  if (type) parts.push(`type="${type}"`);
  const expanded = element.getAttribute("aria-expanded");
  if (expanded) parts.push(`expanded="${expanded}"`);
  const toggle = element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio");
  if (toggle) parts.push(element.checked ? "checked" : "unchecked");
  if (element.getAttribute("aria-pressed") === "true") parts.push("pressed");
  if (element.getAttribute("aria-checked") === "true") parts.push("checked");

  const canShowValue = !isSensitive(element) || bypassWireguard;
  if (element instanceof HTMLInputElement && !toggle && canShowValue && element.value) parts.push(`value="${element.value.slice(0, 40).replace(/"/g, "'")}"`);
  if (element instanceof HTMLTextAreaElement && canShowValue && element.value) parts.push(`value="${element.value.slice(0, 40).replace(/"/g, "'")}"`);
  if (element instanceof HTMLSelectElement && canShowValue) {
    const selected = element.options[element.selectedIndex];
    if (selected && selected.value) parts.push(`value="${selected.text.slice(0, 40).replace(/"/g, "'")}"`);
  }
  const formField = element as Partial<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>;
  if (formField.required || element.getAttribute("aria-required") === "true") parts.push("required");
  if (formField.readOnly) parts.push("readonly");
  if (element.hasAttribute("disabled") || formField.disabled || element.getAttribute("aria-disabled") === "true") parts.push("disabled");
  const rect = element.getBoundingClientRect();
  if (rect.bottom < 0) parts.push("acima-do-viewport");
  else if (rect.top > innerHeight) parts.push("abaixo-do-viewport");
  return `${parts.join(" ")} />`;
}

function collect(root: Document | ShadowRoot, found: Element[]) {
  const walker = root.ownerDocument
    ? document.createTreeWalker(root as unknown as Node, NodeFilter.SHOW_ELEMENT)
    : document.createTreeWalker((root as Document).body ?? root, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode as Element | null;
  while (node) {
    if (node instanceof Element) {
      if (node.hasAttribute("data-vela-ui")) { node = walker.nextSibling() as Element | null; continue; }
      if (node.shadowRoot) collect(node.shadowRoot, found);
      // O corte acontece **depois** da ordenação por viewport, não aqui: cortando na ordem do
      // documento, um menu de navegação com cem links consumia a cota sozinho e o conteúdo que
      // a pessoa quer nunca aparecia no retrato.
      if (found.length < HARD_LIMIT && isInteractive(node) && isVisible(node)) found.push(node);
    }
    node = walker.nextNode() as Element | null;
  }
}

function headings() {
  return [...document.querySelectorAll("h1,h2,h3")]
    .filter((element) => isVisible(element))
    .slice(0, 25)
    .map((element) => `${"#".repeat(Number(element.tagName[1]))} ${(element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME)}`);
}

function readableText() {
  let text = document.body.innerText ?? "";
  // Em páginas onde innerText falha ou vem vazio (ex: tudo no ShadowDOM), tentamos o fallback
  if (!text.trim()) {
    const chunks: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (!node.parentElement?.closest("script,style,noscript,svg,[data-vela-ui]")) {
        chunks.push((node.textContent ?? "").replace(/\s+/g, " ").trim());
      }
      node = walker.nextNode();
    }
    text = chunks.join(" ").replace(/\s{2,}/g, " ");
  }
  // Limpa excesso de quebras de linha e preserva tabs (usados pelo innerText para tabelas)
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export type FindOptions = { query?: string; selector?: string; limit?: number };

/**
 * Procura na página inteira, sem rolar e sem depender do retrato.
 *
 * O retrato tem teto de elementos e um menu de navegação come esse teto sozinho: o que a pessoa
 * pediu podia simplesmente não estar lá, e a saída era rolar às cegas relendo a página — que foi
 * exatamente o loop observado. Aqui a varredura é do documento todo, incluindo shadow DOM e o
 * que está fora do viewport, e o resultado já vem com refs válidos para clicar.
 *
 * Prefere o elemento **mais específico**: se um link e o `<div>` que o contém casam, o link é a
 * resposta — clicar no contêiner acerta o alvo errado com frequência.
 */
export function findElements(options: FindOptions) {
  const { query = "", selector, limit = 20 } = options;
  const needle = fold(query);
  const pool: Element[] = [];
  if (selector) {
    try { pool.push(...document.querySelectorAll(selector)); } catch { /* seletor inválido cai como zero resultados */ }
  } else {
    everyElement(document, pool, 12_000);
  }

  const scored: Array<{ element: Element; score: number; text: string }> = [];
  for (const element of pool) {
    if (!isVisible(element)) continue;
    const name = accessibleName(element);
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    const attributes = [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("alt"), element.getAttribute("placeholder"), element.getAttribute("href")].filter(Boolean).join(" ");
    if (needle) {
      const inName = fold(name).includes(needle);
      const inText = fold(text).includes(needle);
      const inAttributes = fold(attributes).includes(needle);
      if (!inName && !inText && !inAttributes) continue;
      // Casar pelo nome acessível vale mais que casar por um texto que só passa por dentro.
      const exact = fold(name) === needle ? 40 : 0;
      const size = Math.min(20, Math.round(2000 / Math.max(20, text.length)));
      scored.push({ element, score: exact + (inName ? 22 : 0) + (inAttributes ? 8 : 0) + size + (isInteractive(element) ? 14 : 0), text: name || text });
    } else {
      scored.push({ element, score: isInteractive(element) ? 10 : 0, text: name || text });
    }
  }

  // Contêiner que só casa porque um descendente casou não é resposta.
  const specific = scored.filter((item) => !scored.some((other) => other !== item && item.element.contains(other.element)));
  specific.sort((first, second) => second.score - first.score);
  const winners = specific.slice(0, limit);

  const lines = winners.map((item) => {
    const rect = item.element.getBoundingClientRect();
    const place = rect.bottom < 0 ? "acima do viewport" : rect.top > innerHeight ? "abaixo do viewport" : "visível";
    const href = item.element.getAttribute("href");
    const destino = href ? ` href="${href.slice(0, 80)}"` : "";
    return `[#${registerElement(item.element)}] <${roleOf(item.element)}> ${item.text.slice(0, 120)}${destino} — ${place}`;
  });
  sweep();

  return {
    content: lines.join("\n"),
    total: specific.length,
    shown: winners.length,
  };
}

export type SnapshotOptions = { mode?: "outline" | "text"; offset?: number; budget?: number; bypassWireguard?: boolean };

export function captureSnapshot(options: SnapshotOptions = {}) {
  const { mode = "outline", offset = 0, budget = DEFAULT_BUDGET, bypassWireguard = false } = options;
  const found: Element[] = [];
  collect(document, found);
  const viewport = found.filter((element) => { const rect = element.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight; });
  const rest = found.filter((element) => !viewport.includes(element));
  const nodes = [...viewport, ...rest].slice(0, MAX_NODES);

  const sections = [
    `url: ${location.href}`,
    `título: ${document.title}`,
    "",
    "# Estrutura",
    ...headings(),
    "",
    "# Elementos interativos",
    ...nodes.map((element) => describe(element, bypassWireguard)),
  ];
  if (found.length > nodes.length) sections.push(`[${found.length - nodes.length} elementos não couberam neste retrato — use find com o texto do que você procura em vez de rolar a página]`);
  if (mode === "text") { sections.push("", "# Texto da página", readableText()); }
  sweep();

  const full = sections.join("\n");
  const slice = full.slice(offset, offset + budget);
  return {
    content: slice,
    truncated: offset + budget < full.length,
    nextOffset: offset + slice.length,
    url: location.href,
    title: document.title,
    elementCount: nodes.length,
  };
}
