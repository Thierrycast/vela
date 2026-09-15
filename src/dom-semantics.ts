/**
 * Como a Vela lê significado de um elemento: papel, nome, se dá para ver, se dá para usar.
 *
 * Mora fora de `page-snapshot.ts` porque deixou de ser assunto só do retrato. O registro de refs
 * (`element-registry.ts`) precisa do papel e do nome acessível para gravar a assinatura de cada
 * elemento que mostrou ao modelo, e o retrato precisa do registro para emitir os refs — com as
 * duas coisas no mesmo arquivo, os dois módulos se importariam em círculo.
 */

const ROLE_BY_TAG: Record<string, string> = {
  a: "link", button: "button", select: "combobox", textarea: "textbox", summary: "button",
  h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  nav: "navigation", main: "main", header: "banner", footer: "contentinfo", form: "form", label: "label",
};

const SENSITIVE_AUTOCOMPLETE = ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"];

export function isSensitive(element: Element) {
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

export function accessibleName(element: Element, bypassWireguard: boolean = false): string {
  if (!bypassWireguard && isSensitive(element)) {
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

export function isVisible(element: Element) {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.05) return false;
  return !element.closest("[aria-hidden='true'],[inert]");
}

export function isInteractive(element: Element) {
  const tag = element.tagName.toLowerCase();
  if (["a", "button", "input", "select", "textarea", "summary", "details"].includes(tag)) return tag !== "a" || element.hasAttribute("href");
  const role = element.getAttribute("role") ?? "";
  if (["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "option", "switch", "textbox", "combobox", "searchbox", "slider"].includes(role)) return true;
  if (element.getAttribute("contenteditable") === "true") return true;
  const attrs = element.getAttributeNames();
  if (attrs.some((a) => a.startsWith("on") || a.startsWith("hx-") || ["ng-click", "@click", "v-on:click", "data-action", "x-on:click", "on:click"].includes(a))) return true;
  const tabindex = element.getAttribute("tabindex");
  return tabindex !== null && Number(tabindex) >= 0;
}

/** Sem acento e em minúsculas: quem dita "recent contributions" não digita o acento certo, e a
 *  página raramente escreve do jeito que a pessoa falou. */
export function fold(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function everyElement(root: Document | ShadowRoot, found: Element[], limit: number) {
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
