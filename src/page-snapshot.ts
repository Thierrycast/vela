const MAX_NODES = 150;
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
      if (found.length < MAX_NODES && isInteractive(node) && isVisible(node)) found.push(node);
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

export type SnapshotOptions = { mode?: "outline" | "text"; offset?: number; budget?: number };

export function captureSnapshot(options: SnapshotOptions = {}) {
  const { mode = "outline", offset = 0, budget = DEFAULT_BUDGET } = options;
  snapshotId += 1;
  const found: Element[] = [];
  collect(document, found);
  const viewport = found.filter((element) => { const rect = element.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight; });
  const rest = found.filter((element) => !viewport.includes(element));
  nodes = [...viewport, ...rest];

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
