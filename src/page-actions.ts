import { ActionResult, BrowserAction } from "./types";
import { accessibleName, captureSnapshot, invalidateSnapshot, resolveRef, roleOf } from "./page-snapshot";

function failure(code: Extract<ActionResult, { ok: false }>["code"], summary: string): ActionResult { return { ok: false, code, summary }; }

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function locate(action: { ref?: string; selector?: string }): { element: Element | null; error?: ActionResult } {
  if (action.ref) {
    const { element, stale } = resolveRef(action.ref);
    if (stale) return { element: null, error: failure("stale_snapshot", "O snapshot mudou. Chame extractPage de novo antes de agir.") };
    if (!element) return { element: null, error: failure("element_not_found", `Elemento ${action.ref} não existe mais na página.`) };
    return { element };
  }
  if (action.selector) {
    const element = document.querySelector(action.selector);
    if (!element) return { element: null, error: failure("element_not_found", `Nenhum elemento casa com o seletor ${action.selector}.`) };
    return { element };
  }
  return { element: null, error: failure("element_not_found", "Informe ref ou selector para esta ação.") };
}

function describeTarget(element: Element) {
  const name = accessibleName(element).slice(0, 60);
  return name ? `${roleOf(element)} “${name}”` : roleOf(element);
}

/** Sinais de que a ação surtiu efeito. Mutação de DOM não cobre tudo: marcar um checkbox
 *  muda propriedade, não atributo, e passaria por "sem efeito". */
function captureSignals(element: Element) {
  return {
    url: location.href,
    focus: document.activeElement,
    checked: element instanceof HTMLInputElement ? element.checked : null,
    value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : null,
    expanded: element.getAttribute("aria-expanded"),
    selected: element.getAttribute("aria-selected"),
  };
}

function pointerSequence(element: Element) {
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, clientX, clientY, view: window } as const;
  element.dispatchEvent(new PointerEvent("pointerover", { ...base, pointerId: 1, isPrimary: true }));
  element.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, isPrimary: true, buttons: 1 }));
  element.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
  if (element instanceof HTMLElement) element.focus({ preventScroll: true });
  element.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mouseup", base));
  element.dispatchEvent(new MouseEvent("click", base));
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value); else element.value = value;
}

async function typeInto(element: Element, text: string, mode: "replace" | "append") {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus({ preventScroll: true });
    const start = mode === "append" ? element.value : "";
    if (mode === "replace") { setNativeValue(element, ""); element.dispatchEvent(new Event("input", { bubbles: true })); }
    let current = start;
    for (const character of text) {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: character, bubbles: true }));
      current += character;
      setNativeValue(element, current);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: character, inputType: "insertText" }));
      element.dispatchEvent(new KeyboardEvent("keyup", { key: character, bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value;
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus({ preventScroll: true });
    if (mode === "replace") document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
    return element.textContent ?? "";
  }
  return null;
}

function pressKey(element: Element | null, key: string) {
  const target = element ?? document.activeElement ?? document.body;
  const init: KeyboardEventInit = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true };
  const keydown = new KeyboardEvent("keydown", init);
  const consumed = !target.dispatchEvent(keydown);
  if (key.length === 1) target.dispatchEvent(new KeyboardEvent("keypress", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  if (key === "Enter" && !consumed) {
    const form = (target as HTMLElement).closest?.("form");
    if (form instanceof HTMLFormElement) { form.requestSubmit(); return "formulário enviado"; }
  }
  return consumed ? "a página tratou a tecla" : "tecla despachada";
}

export async function performAction(action: BrowserAction): Promise<ActionResult> {
  if (action.type === "extractPage") {
    const snapshot = captureSnapshot({ mode: action.mode, offset: action.offset });
    return { ok: true, summary: `Página lida: ${snapshot.elementCount} elementos interativos.`, content: snapshot.content, snapshotId: snapshot.snapshotId, truncated: snapshot.truncated, nextOffset: snapshot.nextOffset, url: snapshot.url, title: snapshot.title };
  }

  if (action.type === "wait") {
    await wait(Math.min(Math.max(action.milliseconds, 0), 10_000));
    return { ok: true, summary: `Esperei ${Math.min(action.milliseconds, 10_000)} ms.` };
  }

  if (action.type === "scroll") {
    const before = window.scrollY;
    window.scrollBy({ left: action.deltaX ?? 0, top: action.deltaY ?? 0, behavior: "instant" as ScrollBehavior });
    await wait(120);
    const moved = window.scrollY - before;
    const atEnd = window.scrollY + window.innerHeight >= document.body.scrollHeight - 2;
    return { ok: true, summary: `Rolei ${Math.round(moved)} px${atEnd ? " (fim da página)" : ""}.` };
  }

  if (action.type === "keyPress") {
    const target = action.ref ? locate(action) : { element: null as Element | null, error: undefined };
    if (target.error) return target.error;
    const urlBefore = location.href;
    const detail = pressKey(target.element, action.key);
    await wait(150);
    if (location.href !== urlBefore) invalidateSnapshot();
    return { ok: true, summary: `Tecla ${action.key}: ${detail}.` };
  }

  if (action.type === "navigate") return failure("unsupported", "Navegação é tratada fora da página.");

  const { element, error } = locate(action);
  if (error) return error;
  if (!element) return failure("element_not_found", "Elemento não encontrado.");
  if (element.hasAttribute("disabled")) return failure("element_not_interactable", `${describeTarget(element)} está desabilitado.`);

  element.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  await wait(60);

  if (action.type === "click") {
    const before = captureSignals(element);
    let mutated = false;
    const observer = new MutationObserver(() => { mutated = true; });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    pointerSequence(element);
    await wait(400);
    observer.disconnect();
    const after = captureSignals(element);
    const navigated = after.url !== before.url;
    const toggled = after.checked !== before.checked;
    const stateChanged = after.expanded !== before.expanded || after.selected !== before.selected;
    const refocused = after.focus !== before.focus;
    if (navigated || mutated || toggled || stateChanged) invalidateSnapshot();
    const effect = navigated ? "a página navegou"
      : toggled ? `agora está ${after.checked ? "marcado" : "desmarcado"}`
      : stateChanged ? "o estado do elemento mudou"
      : mutated ? "a página reagiu"
      : refocused ? "o foco mudou"
      : "sem efeito perceptível";
    return { ok: true, summary: `Cliquei em ${describeTarget(element)} — ${effect}.` };
  }

  if (action.type === "type") {
    const value = await typeInto(element, action.text, action.mode ?? "replace");
    if (value === null) return failure("element_not_interactable", `${describeTarget(element)} não aceita digitação.`);
    let detail = "";
    if (action.submit) { await wait(80); detail = ` ${pressKey(element, "Enter")}`; await wait(300); invalidateSnapshot(); }
    return { ok: true, summary: `Digitei em ${describeTarget(element)} (valor agora: “${value.slice(0, 60)}”).${detail}` };
  }

  return failure("unsupported", "Ação não executável na página.");
}
