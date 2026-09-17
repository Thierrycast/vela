import { ActionResult, BrowserAction } from "./types";
import { accessibleName, fold, isVisible, roleOf } from "./dom-semantics";
import { captureSnapshot, findElements } from "./page-snapshot";
import { resolveRef } from "./element-registry";
import { callPageTool, describePageTools, listPageTools } from "./page-tools";

function failure(code: Extract<ActionResult, { ok: false }>["code"], summary: string): ActionResult { return { ok: false, code, summary }; }

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Esperar a página reagir, e não um tempo fixo.
 *
 * Todo clique esperava 400 ms e todo hover 450, sempre — inclusive quando a página tinha reagido em
 * 30 ms. Numa tarefa de dez cliques são quatro segundos parados. Agora a espera termina assim que a
 * reação acontece e a página fica quieta por um instante (ou a URL muda). Quando nada acontece, a
 * espera continua indo até o teto: é esse tempo que sustenta dizer "sem efeito perceptível" sem
 * acusar à toa uma página que só demorou a responder.
 */
function observarReacao() {
  const inicio = performance.now();
  let ultima = 0;
  const urlAntes = location.href;
  const observer = new MutationObserver(() => { ultima = performance.now(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  return {
    get mudou() { return ultima > 0; },
    async assentar(teto: number, minimo = 120, quieto = 90) {
      for (;;) {
        await wait(30);
        const agora = performance.now();
        if (agora - inicio >= teto) break;
        if (location.href !== urlAntes) break;
        if (ultima && agora - inicio >= minimo && agora - ultima >= quieto) break;
      }
      observer.disconnect();
    },
  };
}

const MAX_WAIT = 30_000;
const DEFAULT_WAIT = 8_000;

/**
 * Esperar por uma condição, em vez de por um número.
 *
 * `wait` pede ao modelo que adivinhe quanto tempo a página vai levar, e ele erra dos dois lados:
 * curto demais e a ação seguinte acontece antes de a tela existir; longo demais e a tarefa fica
 * parada olhando para algo que já terminou. A condição resolve o dilema — volta assim que o que
 * se espera aconteceu, e diz **por que** voltou. Um retorno que não explica o motivo obrigaria a
 * uma leitura extra só para descobrir se valeu a pena esperar.
 */
async function waitForCondition(action: Extract<BrowserAction, { type: "waitFor" }>): Promise<ActionResult> {
  const limit = Math.min(Math.max(action.timeoutMs ?? DEFAULT_WAIT, 200), MAX_WAIT);
  const needle = action.text ? fold(action.text) : "";
  if (!needle && !action.selector && !action.networkIdle) {
    return failure("unsupported", "Diga o que esperar: text (um texto que deve aparecer), selector (um elemento) ou networkIdle.");
  }

  const present = () => {
    if (action.selector) {
      try { if (!document.querySelector(action.selector)) return false; } catch { return false; }
    }
    if (needle && !fold(document.body?.innerText ?? "").includes(needle)) return false;
    return true;
  };
  /** `gone: true` inverte a pergunta: espera-se o sumiço de um carregando, de um modal, de um erro. */
  const satisfied = () => (action.gone ? !present() : present());

  const started = performance.now();
  let lastRequest = performance.now();
  const cleanup: Array<() => void> = [];

  if (action.networkIdle && typeof PerformanceObserver !== "undefined") {
    try {
      const resources = new PerformanceObserver(() => { lastRequest = performance.now(); });
      resources.observe({ type: "resource", buffered: false });
      cleanup.push(() => resources.disconnect());
    } catch { /* navegador sem observador de recursos: a espera cai no intervalo curto */ }
  }

  try {
    // Mutação acorda a verificação na hora; o intervalo curto cobre o que muda sem tocar no DOM
    // (uma requisição que termina, um atributo em shadow root que o observador não alcança).
    const done = await new Promise<string | null>((resolve) => {
      const check = () => {
        const quiet = !action.networkIdle || performance.now() - lastRequest > 600;
        if (satisfied() && quiet) {
          resolve(action.networkIdle && !needle && !action.selector ? "a rede parou" : action.gone ? "o que você esperava sumir sumiu" : "o que você esperava apareceu");
          return true;
        }
        if (performance.now() - started > limit) { resolve(null); return true; }
        return false;
      };
      if (check()) return;
      const timer = setInterval(() => { if (check()) clearInterval(timer); }, 150);
      cleanup.push(() => clearInterval(timer));
      const observer = new MutationObserver(() => { if (check()) clearInterval(timer); });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      cleanup.push(() => observer.disconnect());
    });

    const spent = Math.round(performance.now() - started);
    if (done) return { ok: true, summary: `Esperei ${spent} ms e ${done}.` };
    const alvo = action.text ? `o texto “${action.text}”` : action.selector ? `o elemento ${action.selector}` : "a rede parar";
    return failure("timeout", `Passaram-se ${spent} ms e ${alvo} ${action.gone ? "continua na página" : "não apareceu"}. Leia a página (extractPage) para ver o que está acontecendo em vez de esperar de novo.`);
  } finally {
    for (const undo of cleanup) undo();
  }
}

export type Target = { element: Element | null; error?: ActionResult; note?: string };

/**
 * Do ref ao elemento — e à recusa, quando o elemento não é mais o que foi mostrado.
 *
 * Cada desfecho tem código próprio porque a recuperação de cada um é diferente: sumiu da página
 * pede releitura, virou outra coisa pede `find` pelo texto lembrado. Um erro genérico custaria
 * uma rodada só para o modelo descobrir qual dos dois aconteceu.
 */
export function resolveTarget(action: { ref?: string; selector?: string }): Target {
  if (action.ref) {
    const resolution = resolveRef(action.ref);
    if (resolution.status === "unknown") {
      return { element: null, error: failure("ref_desconhecido", "Esse ref não existe nesta página. Refs vêm de um extractPage ou de um find — leia a página e use o ref como ele apareceu.") };
    }
    if (resolution.status === "gone") {
      return { element: null, error: failure("element_not_found", `O elemento “${resolution.recorded}” não está mais nesta página, mas a página não mudou de endereço — provavelmente um modal fechou ou a lista recarregou. Chame extractPage para ver o estado atual.`) };
    }
    if (resolution.status === "changed") {
      return { element: null, error: failure("ref_changed", `Esse elemento ainda existe, mas agora é outra coisa: quando você o leu era “${resolution.recorded}” e agora é “${resolution.current}”. Isso acontece em listas que reaproveitam as mesmas linhas conforme você rola. Não fiz nada. Chame find com query “${resolution.recorded}” para pegar o ref atual desse item — é mais direto que reler a página inteira.`) };
    }
    /*
     * Existir não é o mesmo que estar disponível.
     *
     * Um `<dialog>` fechado, uma aba de conteúdo escondida e um menu recolhido mantêm seus botões
     * no DOM, resolvendo normalmente. Clicar neles não dá erro: dá "sem efeito perceptível", que
     * manda o modelo procurar culpa no alvo errado — ele tentaria outro seletor, outro caminho,
     * quando o que falta é reabrir o que se fechou.
     */
    if (!isVisible(resolution.element)) {
      return { element: null, error: failure("element_not_interactable", `“${resolution.recorded}” ainda está na página, mas não está visível — o que costuma significar que o modal, o menu ou a aba onde ele fica foi fechado. Reabra o que o contém e leia de novo; clicar nele agora não faria nada.`) };
    }
    const note = resolution.rebound
      ? " (a lista reaproveitou os elementos ao rolar; reencontrei o item pelo texto)"
      : resolution.verdict === "drifted" ? ` (o rótulo era “${resolution.recorded}” quando você leu)` : undefined;
    return { element: resolution.element, note };
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
/*
 * "Não pegou" é o campo não ter mudado — não é o valor ser diferente do texto.
 *
 * Exigir igualdade marcava como falha todo campo que formata o que recebe: telefone com máscara,
 * CPF, moeda, `maxlength`. O texto entrava, o campo o reescrevia do jeito dele, e a ação voltava
 * "sem efeito perceptível" — sem Enter, escalando para o modo preciso e dizendo ao modelo que o
 * campo não aceitava preenchimento, quando aceitava. O que denuncia evento ignorado é o valor
 * continuar o de antes (ou vazio); o que sobra é reformatação, e é dito como tal.
 */
function typeLanded(outcome: TypeOutcome, text: string, mode: "replace" | "append", before: string) {
  if (outcome.kind === "select") return true;
  if (!text) return true;
  const exact = mode === "replace" ? outcome.value.trim() === text.trim() : outcome.value.includes(text);
  if (exact) return true;
  if (!outcome.value.trim()) return false;
  return outcome.value !== before;
}

function valueOf(element: Element) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
  if (element instanceof HTMLElement && element.isContentEditable) return element.textContent ?? "";
  return "";
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

/**
 * `resolved` chega de fora quando quem chamou já traduziu o ref em elemento.
 *
 * O content script precisa do alvo antes de agir — é para ele que o cursor viaja — e resolver de
 * novo aqui abriria uma janela entre as duas resoluções: o `scrollIntoView` e o quadro de
 * animação que existem entre elas bastam para uma lista virtualizada reciclar a linha, e a ação
 * cairia num elemento diferente daquele que o usuário viu ser mirado.
 */
export async function performAction(action: BrowserAction, resolved?: Target): Promise<ActionResult> {
  if (action.type === "extractPage") {
    const snapshot = captureSnapshot({ mode: action.mode, offset: action.offset, bypassWireguard: action.bypassWireguard, depth: action.depth, rootRef: action.ref });
    if (snapshot.missingRoot) return failure("element_not_found", "O elemento que você pediu para reler não está mais na página. Leia a página inteira (sem ref) para se situar.");
    const pageTools = await listPageTools();
    const content = snapshot.content + describePageTools(pageTools);
    const extra = pageTools.length ? ` A página oferece ${pageTools.length} ferramenta(s) própria(s).` : "";
    return { ok: true, summary: `Página lida: ${snapshot.elementCount} elementos interativos.${extra}`, content, truncated: snapshot.truncated, nextOffset: snapshot.nextOffset, url: snapshot.url, title: snapshot.title };
  }

  if (action.type === "find") {
    if (!action.query?.trim() && !action.selector?.trim() && !action.role?.trim()) return failure("unsupported", "Informe query (o que procurar), selector (CSS) ou role (o papel do elemento).");
    const result = findElements({ query: action.query, selector: action.selector, limit: action.limit, role: action.role, hint: action.hint });
    if (!result.total) return failure("element_not_found", `Nada casa com ${action.query ? `“${action.query}”` : action.selector} nesta página.`);
    return {
      ok: true,
      summary: `Achei ${result.total} correspondência(s)${result.shown < result.total ? `, mostrando as ${result.shown} melhores` : ""}.`,
      content: result.content,
      url: location.href,
      bestSelector: result.bestSelector,
    };
  }

  if (action.type === "pageTool") {
    const result = await callPageTool(action.name, action.arguments);
    return result.ok
      ? { ok: true, summary: `Usei a ferramenta “${action.name}” da página.`, content: result.text }
      : failure("unsupported", result.text);
  }

  /*
   * O script nao roda aqui, e nao e escolha de estilo.
   *
   * Montar funcao em tempo de execucao dentro do mundo isolado e barrado pelo CSP de MV3 — medido
   * no Chrome, tanto por `new Function` no content script quanto por `scripting.executeScript` com
   * `world: "ISOLATED"`: "'unsafe-eval' is not an allowed source of script". Durante um bom tempo
   * a acao existiu, foi anunciada ao modelo, e **sempre** devolveu esse erro. O unico lugar onde
   * codigo montado na hora executa e o mundo da propria pagina, e quem injeta la e o background
   * (`script-world.ts`).
   */
  if (action.type === "evaluateScript") return failure("unsupported", "A execucao de script e tratada fora da pagina.");

  if (action.type === "waitFor") return waitForCondition(action);

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
    const target = action.ref ? (resolved ?? resolveTarget(action)) : { element: null as Element | null, error: undefined };
    if (target.error) return target.error;
    const detail = pressKey(target.element, action.key);
    await wait(150);
    return { ok: true, summary: `Tecla ${action.key}: ${detail}.` };
  }

  if (action.type === "navigate" || action.type === "history") return failure("unsupported", "Navegação é tratada fora da página.");
  // A captura precisa da API de abas, que só existe no background: a página não fotografa a si.
  if (action.type === "screenshot") return failure("unsupported", "A captura é tratada fora da página.");

  const { element, error, note } = resolved ?? resolveTarget(action);
  if (error) return error;
  if (!element) return failure("element_not_found", "Elemento não encontrado.");
  if (element.hasAttribute("disabled")) return failure("element_not_interactable", `${describeTarget(element)} está desabilitado.`);


  /*
   * Passar o mouse por cima é uma ação de verdade, não um preâmbulo do clique.
   *
   * Menu que só abre no hover é comum o bastante para ter travado tarefas inteiras: o agente
   * clicava no item pai, a página não reagia (porque o pai não é clicável), e não havia degrau
   * seguinte. A resposta diz se alguma coisa apareceu — sem isso, "passei o mouse" não informa
   * nada e o modelo leria a página de novo para descobrir.
   */
  if (action.type === "hover") {
    const rect = element.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, view: window } as const;
    const reacao = observarReacao();
    element.dispatchEvent(new PointerEvent("pointerover", { ...base, pointerId: 1, isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mouseover", base));
    element.dispatchEvent(new PointerEvent("pointermove", { ...base, pointerId: 1, isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mousemove", base));
    if (element instanceof HTMLElement) element.focus({ preventScroll: true });
    await reacao.assentar(450);
    return { ok: true, summary: `Passei o mouse sobre ${describeTarget(element)}${note ?? ""} — ${reacao.mudou ? "alguma coisa apareceu; leia a página para ver o quê" : "nada mudou na página"}.` };
  }

  /*
   * Arrastar é uma sequência de pontos, não um salto.
   *
   * Bibliotecas de arrastar-e-soltar ignoram um movimento que vai direto do começo ao fim: elas
   * escutam `pointermove` para decidir que o gesto começou, e um único evento não convence
   * nenhuma delas. Os passos intermediários são o que faz a lista reordenar de verdade.
   */
  if (action.type === "drag") {
    const destino = resolveTarget({ ref: action.toRef, selector: action.toSelector });
    if (destino.error) return destino.error;
    if (!destino.element) return failure("element_not_found", "Informe para onde arrastar (toRef ou toSelector).");
    const from = element.getBoundingClientRect();
    const to = destino.element.getBoundingClientRect();
    const start = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
    const end = { x: to.left + to.width / 2, y: to.top + to.height / 2 };
    const point = (x: number, y: number) => ({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, pointerId: 1, isPrimary: true } as const);

    element.dispatchEvent(new PointerEvent("pointerover", point(start.x, start.y)));
    element.dispatchEvent(new PointerEvent("pointerdown", { ...point(start.x, start.y), buttons: 1 }));
    element.dispatchEvent(new MouseEvent("mousedown", { ...point(start.x, start.y), buttons: 1 }));
    for (let step = 1; step <= 10; step += 1) {
      const x = start.x + ((end.x - start.x) * step) / 10;
      const y = start.y + ((end.y - start.y) * step) / 10;
      const over = document.elementFromPoint(x, y) ?? destino.element;
      over.dispatchEvent(new PointerEvent("pointermove", { ...point(x, y), buttons: 1 }));
      over.dispatchEvent(new MouseEvent("mousemove", { ...point(x, y), buttons: 1 }));
      await wait(16);
    }
    destino.element.dispatchEvent(new PointerEvent("pointerup", point(end.x, end.y)));
    destino.element.dispatchEvent(new MouseEvent("mouseup", point(end.x, end.y)));
    await wait(250);
    return { ok: true, summary: `Arrastei ${describeTarget(element)} até ${describeTarget(destino.element)}. Leia a página para conferir se o destino aceitou.` };
  }

  /*
   * A combobox tem caminho próprio porque simular a abertura do menu e o clique na opção é o
   * jeito mais frágil de fazer a coisa mais comum de um formulário — e o `<select>` nativo nem
   * abre menu de verdade para eventos sintéticos.
   */
  if (action.type === "selectOption") {
    if (!(element instanceof HTMLSelectElement)) return failure("element_not_interactable", `${describeTarget(element)} não é uma combobox nativa. Se for um menu customizado, clique nele e depois clique na opção.`);
    const options = Array.from(element.options);
    const wanted = action.label ?? action.value ?? "";
    const needle = fold(wanted);
    const chosen = action.index !== undefined ? options[action.index]
      : options.find((option) => fold(option.text) === needle)
      ?? options.find((option) => fold(option.value) === needle)
      ?? options.find((option) => fold(option.text).includes(needle) && needle.length > 0);
    if (!chosen) {
      const amostra = options.slice(0, 12).map((option) => `“${option.text.trim().slice(0, 40)}”`).join(", ");
      return failure("element_not_found", `Nenhuma opção casa com ${wanted ? `“${wanted}”` : `índice ${action.index}`}. As opções são: ${amostra}${options.length > 12 ? ` (e mais ${options.length - 12})` : ""}.`);
    }
    element.value = chosen.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, summary: `Escolhi “${chosen.text.trim().slice(0, 60)}” em ${describeTarget(element)}.` };
  }

  if (action.type === "click") {
    const before = captureSignals(element);
    const reacao = observarReacao();
    pointerSequence(element);
    await reacao.assentar(400);
    const mutated = reacao.mudou;
    const after = captureSignals(element);
    const navigated = after.url !== before.url;
    const toggled = after.checked !== before.checked;
    const stateChanged = after.expanded !== before.expanded || after.selected !== before.selected;
    const refocused = after.focus !== before.focus;
    const effect = navigated ? `a página navegou para ${after.url}`
      : toggled ? `agora está ${after.checked ? "marcado" : "desmarcado"}`
      : stateChanged ? "o estado do elemento mudou"
      : mutated ? "a página reagiu"
      : refocused ? "o foco mudou"
      : "sem efeito perceptível";
    return { ok: true, summary: `Cliquei em ${describeTarget(element)}${note ?? ""} — ${effect}.` };
  }

  if (action.type === "type") {
    const mode = action.mode ?? "replace";
    const before = valueOf(element);
    const outcome = await typeInto(element, action.text, mode);
    if (outcome === null) return failure("element_not_interactable", `${describeTarget(element)} não aceita digitação.`);
    /*
     * Campo que ignora evento sintético devolvia "Digitei em X (valor agora: '')" — uma frase que
     * afirma sucesso e descreve fracasso na mesma linha, e que o modelo lia como sucesso. Dizer
     * "sem efeito perceptível" usa o mesmo vocabulário do clique, que é o que a escalada para o
     * caminho confiável já sabe reconhecer.
     */
    if (!typeLanded(outcome, action.text, mode, before)) {
      return { ok: true, summary: `Tentei digitar em ${describeTarget(element)} e o campo continua com “${outcome.value.slice(0, 60)}” — sem efeito perceptível.` };
    }
    let detail = "";
    if (action.submit) { await wait(80); detail = ` ${pressKey(element, "Enter")}`; await wait(300); }
    const reformatado = outcome.kind !== "select" && mode === "replace" && outcome.value.trim() !== action.text.trim() ? " — o campo reformatou o que recebeu" : "";
    return { ok: true, summary: `Digitei em ${describeTarget(element)}${note ?? ""} (valor agora: “${outcome.value.slice(0, 60)}”${reformatado}).${detail}` };
  }

  return failure("unsupported", "Ação não executável na página.");
}
