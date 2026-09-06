const MAX_NODES = 150;
/** Teto da varredura, para não passear por uma página infinita — o corte de verdade é o de cima. */
const HARD_LIMIT = 1200;
const MAX_NAME = 100;
const DEFAULT_BUDGET = 12000;

const ROLE_BY_TAG: Record<string, string> = {
  a: "link", button: "button", select: "combobox", textarea: "textbox", summary: "button",
  h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  nav: "navigation", main: "main", header: "banner", footer: "contentinfo", form: "form", label: "label",
};

const SENSITIVE_AUTOCOMPLETE = ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"];

let nodes: Element[] = [];
let snapshotId = 0;

export function resolveRef(ref: string): { element: Element | null; stale: boolean } {
  const match = /^ref_(\d+)_(\d+)$/.exec(ref);
  if (!match) return { element: null, stale: false };
  if (Number(match[1]) !== snapshotId) return { element: null, stale: true };
  const element = nodes[Number(match[2])] ?? null;
  return { element: element && element.isConnected ? element : null, stale: false };
}

export function invalidateSnapshot() { snapshotId += 1; nodes = []; }

function isSensitive(element: Element) {
  const type = (element.getAttribute("type") ?? "").toLowerCase();
  if (type === "password" || type === "hidden") return true;
  const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
  return SENSITIVE_AUTOCOMPLETE.some((item) => autocomplete.includes(item));
}

export function roleOf(element: Element) {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "reset") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "file") return "button";
    return "textbox";
  }
  return ROLE_BY_TAG[tag] ?? "generic";
}

function ownText(element: Element) {
  let text = "";
  for (const child of element.childNodes) if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
  return text.replace(/\s+/g, " ").trim();
}

export function accessibleName(element: Element): string {
  if (isSensitive(element)) {
    const label = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "";
    return label.trim() || "[valor omitido]";
  }
  const aria = element.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const referenced = labelledBy.split(/\s+/).map((token) => element.ownerDocument.getElementById(token)?.textContent ?? "").join(" ").trim();
    if (referenced) return referenced.replace(/\s+/g, " ");
  }
  const alt = element.getAttribute("alt");
  if (alt?.trim()) return alt.trim();
  const placeholder = element.getAttribute("placeholder");
  if (placeholder?.trim()) return placeholder.trim();
  const title = element.getAttribute("title");
  if (title?.trim()) return title.trim();
  if (element.id) {
    const label = element.ownerDocument.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    const text = label ? (label.textContent ?? "").replace(/\s+/g, " ").trim() : "";
    if (text) return text;
  }
  const own = ownText(element);
  if (own) return own;
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  return text;
}

function isVisible(element: Element) {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.05) return false;
  return !element.closest("[aria-hidden='true'],[inert]");
}

function isInteractive(element: Element) {
  const tag = element.tagName.toLowerCase();
  if (["a", "button", "input", "select", "textarea", "summary", "details"].includes(tag)) return tag !== "a" || element.hasAttribute("href");
  const role = element.getAttribute("role") ?? "";
  if (["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "option", "switch", "textbox", "combobox", "searchbox", "slider"].includes(role)) return true;
  if (element.getAttribute("contenteditable") === "true") return true;
  const tabindex = element.getAttribute("tabindex");
  return tabindex !== null && Number(tabindex) >= 0;
}

function describe(element: Element, index: number) {
  const role = roleOf(element);
  const name = accessibleName(element).slice(0, MAX_NAME);
  const parts = [`[ref_${snapshotId}_${index}]<${role}`];
  if (name) parts.push(`name="${name.replace(/"/g, "'")}"`);
  const href = element.getAttribute("href");
  if (href) { try { const url = new URL(href, location.href); parts.push(`href="${url.host}${url.pathname.slice(0, 40)}"`); } catch { /* href relativo inválido */ } }
  const type = element.getAttribute("type");
  if (type) parts.push(`type="${type}"`);
  const toggle = element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio");
  if (element instanceof HTMLInputElement && !toggle && !isSensitive(element) && element.value) parts.push(`value="${element.value.slice(0, 40).replace(/"/g, "'")}"`);
  if (toggle) parts.push((element as HTMLInputElement).checked ? "checked" : "unchecked");
  const expanded = element.getAttribute("aria-expanded");
  if (expanded) parts.push(`expanded=${expanded}`);
  if (element.hasAttribute("disabled")) parts.push("disabled");
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
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || parent.closest("script,style,noscript,template,svg,[data-vela-ui]")) return NodeFilter.FILTER_REJECT;
      return (node.textContent ?? "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const chunks: string[] = [];
  let node = walker.nextNode();
  while (node) { chunks.push((node.textContent ?? "").replace(/\s+/g, " ").trim()); node = walker.nextNode(); }
  return chunks.join(" ").replace(/\s{2,}/g, " ");
}

/** Sem acento e em minúsculas: quem dita "recent contributions" não digita o acento certo, e a
 *  página raramente escreve do jeito que a pessoa falou. */
function fold(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function everyElement(root: Document | ShadowRoot, found: Element[], limit: number) {
  const walker = root.ownerDocument
    ? document.createTreeWalker(root as unknown as Node, NodeFilter.SHOW_ELEMENT)
    : document.createTreeWalker((root as Document).body ?? root, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode as Element | null;
  while (node && found.length < limit) {
    if (node instanceof Element) {
      if (node.hasAttribute("data-vela-ui")) { node = walker.nextSibling() as Element | null; continue; }
      if (node.shadowRoot) everyElement(node.shadowRoot, found, limit);
      found.push(node);
    }
    node = walker.nextNode() as Element | null;
  }
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

  snapshotId += 1;
  nodes = winners.map((item) => item.element);
  const lines = winners.map((item, index) => {
    const rect = item.element.getBoundingClientRect();
    const place = rect.bottom < 0 ? "acima do viewport" : rect.top > innerHeight ? "abaixo do viewport" : "visível";
    const href = item.element.getAttribute("href");
    const destino = href ? ` href="${href.slice(0, 80)}"` : "";
    return `[ref_${snapshotId}_${index}] <${roleOf(item.element)}> ${item.text.slice(0, 120)}${destino} — ${place}`;
  });

  return {
    content: lines.join("\n"),
    snapshotId,
    total: specific.length,
    shown: winners.length,
  };
}

export type SnapshotOptions = { mode?: "outline" | "text"; offset?: number; budget?: number };

export function captureSnapshot(options: SnapshotOptions = {}) {
  const { mode = "outline", offset = 0, budget = DEFAULT_BUDGET } = options;
  snapshotId += 1;
  const found: Element[] = [];
  collect(document, found);
  const viewport = found.filter((element) => { const rect = element.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight; });
  const rest = found.filter((element) => !viewport.includes(element));
  nodes = [...viewport, ...rest].slice(0, MAX_NODES);

  const sections = [
    `url: ${location.href}`,
    `título: ${document.title}`,
    "",
    "# Estrutura",
    ...headings(),
    "",
    "# Elementos interativos",
    ...nodes.map((element, index) => describe(element, index)),
  ];
  if (found.length > nodes.length) sections.push(`[${found.length - nodes.length} elementos não couberam neste retrato — use find com o texto do que você procura em vez de rolar a página]`);
  if (mode === "text") { sections.push("", "# Texto da página", readableText()); }

  const full = sections.join("\n");
  const slice = full.slice(offset, offset + budget);
  return {
    content: slice,
    snapshotId,
    truncated: offset + budget < full.length,
    nextOffset: offset + slice.length,
    url: location.href,
    title: document.title,
    elementCount: nodes.length,
  };
}
