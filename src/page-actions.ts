import { ActionResult, BrowserAction } from "./types";
import { accessibleName, captureSnapshot, findElements, invalidateSnapshot, resolveRef, roleOf } from "./page-snapshot";
import { callPageTool, describePageTools, listPageTools } from "./page-tools";

function failure(code: Extract<ActionResult, { ok: false }>["code"], summary: string): ActionResult { return { ok: false, code, summary }; }

/**
 * O que `evaluateScript` devolve precisa ser lido, e `JSON.stringify` sozinho falha justamente no
 * caso mais comum de uso — inspecionar o DOM: `Element`/`Node` não têm propriedade enumerável
 * nenhuma e viram "{}", igual `Map`/`Set`. Um objeto com referência circular derrubava o script
 * inteiro com erro, mesmo tendo rodado certo.
 */
function serializeEvalResult(result: unknown): string {
  if (result === undefined) return "Script executado sem retorno explícito.";
  if (result === null) return "null";
  if (typeof result === "bigint") return `${result.toString()}n`;
  if (typeof result === "function") return result.toString().slice(0, 300);
  if (result instanceof Node) {
    if (result instanceof Element) {
      const attrs = result.getAttributeNames().map((name) => `${name}="${(result.getAttribute(name) ?? "").slice(0, 80)}"`).join(" ");
      const text = (result.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      return `<${result.tagName.toLowerCase()}${attrs ? ` ${attrs}` : ""}>${text ? ` texto="${text}"` : ""}`;
    }
    return (result.textContent ?? "").slice(0, 300);
  }
  if (result instanceof NodeList || result instanceof HTMLCollection || Array.isArray(result)) {
    const list = Array.from(result as ArrayLike<unknown>);
    return `[${list.length} item(ns)] ${list.slice(0, 30).map(serializeEvalResult).join(" | ").slice(0, 1500)}`;
  }
  if (result instanceof Map) return serializeEvalResult(Object.fromEntries(result));
  if (result instanceof Set) return serializeEvalResult(Array.from(result));
  if (typeof result === "object") {
    try { return JSON.stringify(result); } catch { return String(result); }
  }
  return String(result);
}

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

type TypeOutcome = { value: string; kind: "field" | "editable" | "select" };

/**
 * A digitação diz o que o campo ficou valendo **e** por qual caminho — e os dois importam.
 *
 * Um `<select>` devolve o texto da opção escolhida, que não tem por que parecer com o que foi
 * pedido ("br" seleciona "Brasil"); um campo de texto, sim. Sem distinguir os dois, conferir se
 * a digitação pegou daria falso alarme em toda combobox.
 */
async function typeInto(element: Element, text: string, mode: "replace" | "append"): Promise<TypeOutcome | null> {
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
    return { value: element.value, kind: "field" };
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus({ preventScroll: true });
    if (mode === "replace") document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
    return { value: element.textContent ?? "", kind: "editable" };
  }
  if (element instanceof HTMLSelectElement) {
    const options = Array.from(element.options);
    const needle = text.toLowerCase().trim();
    const best = options.find((opt) => opt.text.toLowerCase().trim() === needle)
              ?? options.find((opt) => opt.value.toLowerCase().trim() === needle)
              ?? options.find((opt) => opt.text.toLowerCase().includes(needle));
    if (best) {
      element.value = best.value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { value: best.text, kind: "select" };
    }
  }
  return null;
}

/** O campo ficou mesmo com o que foi pedido? É esta conta que decide se vale escalar para o
 *  caminho confiável — sem ela, "digitei" era afirmação de intenção, não de resultado. */
function typeLanded(outcome: TypeOutcome, text: string, mode: "replace" | "append") {
  if (outcome.kind === "select") return true;
  if (!text) return true;
  return mode === "replace" ? outcome.value.trim() === text.trim() : outcome.value.includes(text);
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
    const snapshot = captureSnapshot({ mode: action.mode, offset: action.offset, bypassWireguard: action.bypassWireguard });
    const pageTools = await listPageTools();
    const content = snapshot.content + describePageTools(pageTools);
    const extra = pageTools.length ? ` A página oferece ${pageTools.length} ferramenta(s) própria(s).` : "";
    return { ok: true, summary: `Página lida: ${snapshot.elementCount} elementos interativos.${extra}`, content, snapshotId: snapshot.snapshotId, truncated: snapshot.truncated, nextOffset: snapshot.nextOffset, url: snapshot.url, title: snapshot.title };
  }

  if (action.type === "find") {
    if (!action.query?.trim() && !action.selector?.trim()) return failure("unsupported", "Informe query (texto a procurar) ou selector.");
    const result = findElements({ query: action.query, selector: action.selector, limit: action.limit });
    if (!result.total) return failure("element_not_found", `Nada casa com ${action.query ? `“${action.query}”` : action.selector} nesta página.`);
    return {
      ok: true,
      summary: `Achei ${result.total} correspondência(s)${result.shown < result.total ? `, mostrando as ${result.shown} melhores` : ""}.`,
      content: result.content,
      snapshotId: result.snapshotId,
    };
  }

  if (action.type === "pageTool") {
    const result = await callPageTool(action.name, action.arguments);
    return result.ok
      ? { ok: true, summary: `Usei a ferramenta “${action.name}” da página.`, content: result.text }
      : failure("unsupported", result.text);
  }

  if (action.type === "evaluateScript") {
    try {
      const run = new Function(`return (async () => { ${action.script} })();`);
      const result = await run();
      return { ok: true, summary: "Script injetado e executado.", content: serializeEvalResult(result) };
    } catch (e) {
      return failure("unsupported", `Erro no script: ${e instanceof Error ? e.message : String(e)}`);
    }
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
  // A captura precisa da API de abas, que só existe no background: a página não fotografa a si.
  if (action.type === "screenshot") return failure("unsupported", "A captura é tratada fora da página.");

  const { element, error } = locate(action);
  if (error) return error;
  if (!element) return failure("element_not_found", "Elemento não encontrado.");
  if (element.hasAttribute("disabled")) return failure("element_not_interactable", `${describeTarget(element)} está desabilitado.`);


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
    const effect = navigated ? `a página navegou para ${after.url}`
      : toggled ? `agora está ${after.checked ? "marcado" : "desmarcado"}`
      : stateChanged ? "o estado do elemento mudou"
      : mutated ? "a página reagiu"
      : refocused ? "o foco mudou"
      : "sem efeito perceptível";
    return { ok: true, summary: `Cliquei em ${describeTarget(element)} — ${effect}.` };
  }

  if (action.type === "type") {
    const mode = action.mode ?? "replace";
    const outcome = await typeInto(element, action.text, mode);
    if (outcome === null) return failure("element_not_interactable", `${describeTarget(element)} não aceita digitação.`);
    /*
     * Campo que ignora evento sintético devolvia "Digitei em X (valor agora: '')" — uma frase que
     * afirma sucesso e descreve fracasso na mesma linha, e que o modelo lia como sucesso. Dizer
     * "sem efeito perceptível" usa o mesmo vocabulário do clique, que é o que a escalada para o
     * caminho confiável já sabe reconhecer.
     */
    if (!typeLanded(outcome, action.text, mode)) {
      return { ok: true, summary: `Tentei digitar em ${describeTarget(element)} e o campo continua com “${outcome.value.slice(0, 60)}” — sem efeito perceptível.` };
    }
    let detail = "";
    if (action.submit) { await wait(80); detail = ` ${pressKey(element, "Enter")}`; await wait(300); invalidateSnapshot(); }
    return { ok: true, summary: `Digitei em ${describeTarget(element)} (valor agora: “${outcome.value.slice(0, 60)}”).${detail}` };
  }

  return failure("unsupported", "Ação não executável na página.");
}
