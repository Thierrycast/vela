import { accessibleName, everyElement, fold, isInteractive, isSensitive, isVisible, roleOf, stableSelector } from "./dom-semantics";
import { registerElement, resolveRef, sweep } from "./element-registry";

const MAX_NODES = 150;
/** Moldura nao concorre com os elementos pela cota: ela custa pouco e e o que da sentido a eles. */
const MAX_STRUCTURE = 60;
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

/** Sobe um nível, atravessando a fronteira do shadow DOM — que `parentElement` não cruza. */
function parentOf(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** Elementos que não se clica, mas que dizem **onde** as coisas estão: seções, formulários, títulos. */
function isLandmark(element: Element) {
  const tag = element.tagName.toLowerCase();
  if (["h1", "h2", "h3", "h4", "nav", "main", "header", "footer", "form", "table", "aside", "article", "section", "dialog", "ul", "ol", "li"].includes(tag)) return true;
  const role = element.getAttribute("role") ?? "";
  return ["navigation", "main", "banner", "contentinfo", "form", "dialog", "list", "listitem", "table", "row", "region", "search", "tablist", "menu"].includes(role);
}

/**
 * A profundidade que o modelo vê é a de **contenção entre o que foi mostrado**, não a do DOM.
 *
 * Um `<div>` dentro de outro dentro de outro não significa nada para quem lê o retrato; o que
 * significa é que aquele botão "Adicionar" está dentro daquela linha da tabela. Contar só os
 * ancestrais que também entraram no retrato produz exatamente essa leitura, e é o que faltava
 * para o modelo saber a qual item pertence cada botão numa lista de itens iguais.
 */
function depthOf(element: Element, chosen: Set<Element>) {
  let depth = 0;
  let node = parentOf(element);
  while (node) {
    if (chosen.has(node)) depth += 1;
    node = parentOf(node);
  }
  return depth;
}

/** Varre na ordem do documento, separando o que se clica do que só situa. */
function collect(root: Document | ShadowRoot | Element, interactive: Element[], structure: Element[]) {
  const start = root instanceof Element ? root : ((root as Document).body ?? root);
  const walker = document.createTreeWalker(start as Node, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode as Element | null;
  while (node) {
    if (node instanceof Element) {
      if (node.hasAttribute("data-vela-ui")) { node = walker.nextSibling() as Element | null; continue; }
      if (node.shadowRoot) collect(node.shadowRoot, interactive, structure);
      if (interactive.length < HARD_LIMIT) {
        // O corte acontece **depois** da ordenação por viewport, não aqui: cortando na ordem do
        // documento, um menu de navegação com cem links consumia a cota sozinho e o conteúdo que
        // a pessoa quer nunca aparecia no retrato.
        //
        // A categoria é decidida antes da visibilidade. `isVisible` pede geometria e estilo
        // calculado — força layout — e era chamada para **todo** elemento da página, inclusive os
        // milhares de `div` e `span` que nunca entrariam no retrato. Olhar tag e atributos primeiro
        // é barato e deixa a medição cara só para quem é candidato.
        if (isInteractive(node)) { if (isVisible(node)) interactive.push(node); }
        else if (structure.length < MAX_STRUCTURE && isLandmark(node) && isVisible(node)) structure.push(node);
      }
    }
    node = walker.nextNode() as Element | null;
  }
}

/**
 * A moldura: seção, formulário, linha de tabela, título.
 *
 * Não leva ref porque não se clica nela — leva o nome, que é o que dá sentido ao que está dentro.
 * Um `[e412] button "Adicionar"` sozinho não diz nada; sob `listitem "Café moído 500g"`, diz tudo.
 */
function describeStructure(element: Element) {
  const role = roleOf(element);
  const tag = element.tagName.toLowerCase();
  const heading = /^h[1-6]$/.test(tag);
  const name = (heading ? (element.textContent ?? "") : accessibleName(element)).replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  const label = heading ? `${"#".repeat(Number(tag[1]))} ${name}` : `<${role === "generic" ? tag : role}${name ? ` name="${name.replace(/"/g, "'")}"` : ""}>`;
  return label;
}

function readableText(root: Document | Element = document) {
  const base = root instanceof Document ? root.body : root;
  let text = (base as HTMLElement).innerText ?? base.textContent ?? "";
  // Em páginas onde innerText falha ou vem vazio (ex: tudo no ShadowDOM), tentamos o fallback
  if (!text.trim()) {
    const chunks: string[] = [];
    const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
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

export type FindOptions = { query?: string; selector?: string; limit?: number; role?: string; hint?: string };

/**
 * Palavras que descrevem **o que a coisa é**, não como ela se chama.
 *
 * "Campo de busca" não é um texto que exista em lugar nenhum da página — é o papel de um elemento
 * cujo rótulo pode ser "Pesquisar", "Buscar produtos" ou nada. Procurar por substring nunca acha;
 * procurar pelo papel acha na primeira tentativa. Sem isto, a saída do modelo era rolar a página
 * relendo o retrato, que é o caminho mais lento e mais caro de não encontrar nada.
 */
const INTENTS: Array<{ termos: string[]; roles: string[]; selectors?: string[] }> = [
  { termos: ["busca", "buscar", "pesquisa", "pesquisar", "search", "procurar"], roles: ["searchbox", "textbox", "combobox"], selectors: ['input[type="search"]', 'input[name="q"]', '[role="search"] input'] },
  { termos: ["botao", "button"], roles: ["button"] },
  { termos: ["link", "links"], roles: ["link"] },
  { termos: ["caixa", "checkbox", "marcar", "desmarcar"], roles: ["checkbox", "switch"] },
  { termos: ["opcao", "radio"], roles: ["radio"] },
  { termos: ["campo", "input", "preencher", "digitar"], roles: ["textbox", "searchbox", "combobox"] },
  { termos: ["lista", "select", "combobox", "dropdown", "menu"], roles: ["combobox", "listbox", "menu", "menuitem"] },
  { termos: ["enviar", "submeter", "submit", "confirmar"], roles: ["button"], selectors: ['button[type="submit"]', 'input[type="submit"]'] },
  { termos: ["aba", "tab"], roles: ["tab"] },
  { termos: ["titulo", "cabecalho", "heading"], roles: ["heading"] },
];

/** Artigos e preposições não distinguem nada, e exigir que apareçam no elemento derruba acerto. */
const STOPWORDS = new Set(["de", "do", "da", "dos", "das", "o", "a", "os", "as", "um", "uma", "no", "na", "em", "para", "por", "com", "que", "e", "the", "of", "to", "for"]);

/** Plural simples é a diferença entre achar e não achar "produtos" numa página que diz "produto". */
const stem = (word: string) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);

function readIntent(query: string) {
  const tokens = fold(query).split(" ").filter(Boolean);
  const roles = new Set<string>();
  const selectors: string[] = [];
  const words: string[] = [];
  for (const token of tokens) {
    if (STOPWORDS.has(token)) continue;
    const intent = INTENTS.find((item) => item.termos.includes(token));
    if (intent) {
      for (const role of intent.roles) roles.add(role);
      if (intent.selectors) selectors.push(...intent.selectors);
      continue;
    }
    words.push(stem(token));
  }
  return { roles, selectors, words };
}

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
  const { query = "", selector, limit = 20, role, hint } = options;
  const needle = fold(query);
  const intent = readIntent(query);
  if (role) intent.roles.add(role.toLowerCase());
  const pool: Element[] = [];
  if (selector) {
    try { pool.push(...document.querySelectorAll(selector)); } catch { /* seletor inválido cai como zero resultados */ }
  } else {
    everyElement(document, pool, 12_000);
  }

  /** Um elemento que o próprio site marca como campo de busca vale mais que um que só parece. */
  const hinted = new Set<Element>();
  for (const candidate of intent.selectors) {
    try { for (const element of document.querySelectorAll(candidate)) hinted.add(element); } catch { /* seletor da tabela, sempre válido */ }
  }
  /*
   * O atalho lembrado de outra vez neste mesmo site. Entra como candidato forte, não como
   * resposta: se o site mudou e ele casa com outra coisa — ou com nada —, a varredura normal
   * decide, e o cache é esquecido lá fora. Exigir um único casamento visível é o que impede
   * um seletor genérico demais de sequestrar a busca.
   */
  let remembered: Element | null = null;
  if (hint) {
    try {
      const casam = document.querySelectorAll(hint);
      if (casam.length === 1 && isVisible(casam[0])) { remembered = casam[0]; hinted.add(casam[0]); }
    } catch { /* seletor guardado que deixou de ser válido */ }
  }

  const scored: Array<{ element: Element; score: number; text: string }> = [];
  /*
   * Visibilidade é conferida só em quem casou.
   *
   * Era o primeiro filtro, aplicado aos até doze mil elementos da varredura — e medir visibilidade
   * pede geometria e estilo calculado, que forçam layout. Casar texto e papel antes é o mesmo
   * resultado com a medição cara feita em dezenas de candidatos em vez de em milhares.
   */
  const visivel = (element: Element) => isVisible(element);
  for (const element of pool) {
    const name = accessibleName(element);
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    const attributes = [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("alt"), element.getAttribute("placeholder"), element.getAttribute("href")].filter(Boolean).join(" ");
    const elementRole = roleOf(element);
    const roleMatches = intent.roles.size === 0 || intent.roles.has(elementRole);

    if (needle) {
      const foldedName = fold(name);
      const haystack = `${foldedName} ${fold(text)} ${fold(attributes)}`;
      /*
       * Todas as palavras, em qualquer ordem, em qualquer um dos campos — em vez da frase inteira
       * como substring. "Adicionar ao carrinho" deixava de achar um botão escrito "Adicionar no
       * carrinho", e quem dita raramente repete a ordem exata do site.
       */
      const wordsHit = intent.words.length > 0 && intent.words.every((word) => haystack.includes(word));
      const phraseHit = haystack.includes(needle);
      // Quando a busca só descreve o papel ("campo de busca"), não há palavra a casar: o papel é
      // o critério inteiro, e exigir texto junto devolveria zero.
      const onlyRole = intent.words.length === 0 && intent.roles.size > 0;
      if (!wordsHit && !phraseHit && !(onlyRole && roleMatches)) continue;
      if (intent.roles.size > 0 && !roleMatches && !phraseHit) continue;
      if (!visivel(element)) continue;

      const exact = foldedName === needle ? 40 : 0;
      const inName = intent.words.length > 0 && intent.words.every((word) => foldedName.includes(word));
      const size = Math.min(20, Math.round(2000 / Math.max(20, text.length)));
      scored.push({
        element,
        score: exact + (inName ? 22 : 0) + (phraseHit ? 10 : 0) + (roleMatches && intent.roles.size ? 30 : 0) + (hinted.has(element) ? 25 : 0) + size + (isInteractive(element) ? 14 : 0),
        text: name || text,
      });
    } else if ((intent.roles.size === 0 || roleMatches) && visivel(element)) {
      scored.push({ element, score: (roleMatches && intent.roles.size ? 30 : 0) + (isInteractive(element) ? 10 : 0), text: name || text });
    }
  }

  // O atalho pode não casar o texto procurado (o rótulo mudou, a busca é por papel): ainda assim
  // é o melhor palpite que existe, e entra na disputa em vez de ficar de fora por tecnicismo.
  if (remembered && !scored.some((item) => item.element === remembered)) {
    scored.push({ element: remembered, score: 50, text: accessibleName(remembered) || (remembered.textContent ?? "").trim() });
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
    // O caminho até o melhor resultado, para não ser redescoberto na próxima conversa.
    bestSelector: winners[0] ? stableSelector(winners[0].element) : "",
  };
}

export type SnapshotOptions = { mode?: "outline" | "text"; offset?: number; budget?: number; bypassWireguard?: boolean; depth?: number; rootRef?: string };

/**
 * O retrato como árvore, e não como lista.
 *
 * A lista plana dizia o que existe e escondia a única coisa que o modelo não consegue deduzir:
 * a qual item cada botão pertence. Numa página de resultados com vinte "Adicionar" idênticos, ou
 * numa tabela com um "Editar" por linha, a lista obrigava a adivinhar pela ordem — e a ordem
 * mente sempre que o site reorganiza alguma coisa. O recuo resolve isso sem custar quase nada:
 * cada elemento aparece dentro do bloco a que pertence.
 *
 * A prioridade do viewport, que antes era **ordenação**, virou **poda**. Reordenar por "o que
 * está na tela primeiro" destruía a hierarquia — o filho vinha antes do pai, e o recuo passava a
 * mentir. Agora a ordem é sempre a do documento, e o que está fora da tela é o primeiro a ser
 * cortado quando o retrato não cabe.
 */
export function captureSnapshot(options: SnapshotOptions = {}) {
  const { mode = "outline", offset = 0, budget = DEFAULT_BUDGET, bypassWireguard = false, depth: maxDepth = 12, rootRef } = options;

  let root: Document | Element = document;
  let zoom = "";
  if (rootRef) {
    const resolution = resolveRef(rootRef);
    if (resolution.status !== "ok") return { content: "", truncated: false, nextOffset: 0, url: location.href, title: document.title, elementCount: 0, missingRoot: true };
    root = resolution.element;
    zoom = `(só o que está dentro de ${roleOf(resolution.element)} “${accessibleName(resolution.element).slice(0, 60)}”)`;
  }

  const interactive: Element[] = [];
  const structure: Element[] = [];
  collect(root, interactive, structure);

  // Cabe o que cabe: o que está na tela sobrevive primeiro, mas a ordem final é a do documento.
  const onScreen = interactive.filter((element) => { const rect = element.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight; });
  // Conjunto, e não `includes` numa lista: com mil elementos a busca linear fazia um milhão de
  // comparações a cada leitura.
  const naTela = new Set(onScreen);
  const offScreen = interactive.filter((element) => !naTela.has(element));
  const kept = new Set([...onScreen, ...offScreen].slice(0, MAX_NODES));
  const chosen = new Set<Element>([...structure, ...kept]);
  const ordered = [...interactive, ...structure].filter((element) => chosen.has(element));
  ordered.sort((first, second) => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);

  const lines: string[] = [];
  for (const element of ordered) {
    const level = depthOf(element, chosen);
    if (level > maxDepth) continue;
    const indent = "  ".repeat(level);
    lines.push(indent + (kept.has(element) ? describe(element, bypassWireguard) : describeStructure(element)));
    // As opções ficam sob o `<select>` a que pertencem, sem ref: `selectOption` escolhe pelo texto,
    // e dar um identificador a cada opção seria pagar token por um caminho que não se usa.
    if (element instanceof HTMLSelectElement && !isSensitive(element)) {
      for (const option of [...element.options].slice(0, 20)) {
        lines.push(`${indent}  option "${option.text.trim().replace(/"/g, "'").slice(0, 60)}"${option.selected ? " (selecionada)" : ""}`);
      }
      if (element.options.length > 20) lines.push(`${indent}  [mais ${element.options.length - 20} opções — use selectOption com o texto]`);
    }
  }

  const sections = [
    `url: ${location.href}`,
    `título: ${document.title}${zoom ? ` ${zoom}` : ""}`,
    "",
    "# Página",
    ...lines,
  ];
  if (interactive.length > kept.size) sections.push(`[${interactive.length - kept.size} elementos não couberam neste retrato — use find com o texto do que você procura em vez de rolar a página]`);
  sweep();

  /*
   * No modo texto, o texto vem **antes** da árvore.
   *
   * Vinha depois, e o orçamento é um só: numa página com muitos elementos a árvore consumia quase
   * tudo e o texto — a razão de ter pedido este modo — chegava cortado ou nem chegava. Sem o
   * conteúdo por texto, o modelo ia à captura de tela para enxergar o que estava escrito. Com `ref`
   * o texto é só daquele bloco, que é o jeito mais barato de ler um trecho da página.
   */
  const full = mode === "text"
    ? [...sections.slice(0, 3), "# Texto", readableText(root), "", ...sections.slice(3)].join("\n")
    : [...sections, "", "[Isto é estrutura e elementos. Para ler o conteúdo — preços, mensagens, parágrafos, tabelas — use extractMode \"text\" (com ref, só aquele bloco). Não capture a tela para ler texto.]"].join("\n");
  const slice = full.slice(offset, offset + budget);
  return {
    content: slice,
    truncated: offset + budget < full.length,
    nextOffset: offset + slice.length,
    url: location.href,
    title: document.title,
    elementCount: kept.size,
    missingRoot: false,
  };
}
