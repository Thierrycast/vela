import { RefObject, useEffect } from "react";
import { findSpan, wordFractions } from "./reading-text";

type ReadingMessage =
  | { type: "voice:reading"; phase: "start"; id: string; sentences: string[] }
  | { type: "voice:reading"; phase: "position"; id: string; index: number; ratio: number }
  | { type: "voice:reading"; phase: "end"; id: string };

type Palavra = { range: Range; from: number; to: number };

/** Folga em volta do texto: sem ela a borda arredondada encosta nos glifos e parece recortada. */
const FOLGA_X = 2;
const FOLGA_Y = 1;

/**
 * Acompanha a leitura em voz alta palavra a palavra, desenhando por cima da própria mensagem.
 *
 * ## Por que uma camada, e não a CSS Custom Highlight API
 *
 * A primeira versão usava `CSS.highlights`, como a extensão Vox. Ela pinta um `Range` sem tocar no
 * DOM, o que é ótimo — mas `::highlight()` só aceita cor, fundo e sombra: **nada de borda
 * arredondada, nada de padding, nada de transição**. O destaque saía como um retângulo duro colado
 * nas letras, e a palavra pulava de uma para a outra.
 *
 * Aqui os retângulos são desenhados numa camada `position: fixed` presa ao `document.body`, **fora da
 * árvore do React** — então a mensagem continua intocada, e o render dela nunca briga com nó que ele
 * não criou. A camada tem o tamanho da área de rolagem da conversa e corta o que passar dela, senão
 * a pílula apareceria por cima da barra do topo quando a frase rolasse para baixo dela.
 *
 * Isso compra três coisas que a API não dá: canto arredondado, translucidez e **a pílula deslizando**
 * de uma palavra para a próxima, em vez de piscar.
 *
 * ## De onde vem a posição
 *
 * O offscreen fala frase a frase e manda as frases prontas no início (`start`), depois
 * `{ index, ratio }` a cada ~80 ms (`position`). Aqui nada é fatiado: os nós de texto da mensagem
 * são achatados numa string, cada frase é **procurada** nela em ordem, e a palavra que cai no `ratio`
 * vira a pílula. Frase que não casa — um bloco de código, que a síntese troca por "trecho de código"
 * — fica sem destaque, e as seguintes continuam alinhadas.
 *
 * ## A cor
 *
 * Vem de `--signal`, que é o que `brand.accentColor` e o tema claro/escuro mudam. Trocar de tema ou de
 * cor de marca muda o destaque junto, sem ninguém lembrar dele.
 */
export function useReadingHighlight(scroller: RefObject<HTMLElement | null>, readingId: string | null) {
  useEffect(() => {
    let frases: Array<Range | null> = [];
    let palavras: Palavra[][] = [];
    let atual = -1;
    let palavraAtual: Range | null = null;
    let leituraId = "";
    let quadro = 0;

    const camada = document.createElement("div");
    camada.className = "reading-layer";
    camada.setAttribute("aria-hidden", "true");
    const pilula = document.createElement("div");
    pilula.className = "reading-word";
    camada.append(pilula);
    const linhas: HTMLDivElement[] = [];

    const desenhar = () => {
      quadro = 0;
      const area = scroller.current?.getBoundingClientRect();
      if (!area || !leituraId) { camada.hidden = true; return; }
      camada.hidden = false;
      Object.assign(camada.style, { left: `${area.left}px`, top: `${area.top}px`, width: `${area.width}px`, height: `${area.height}px` });

      // Uma faixa por linha da frase: uma caixa só em volta de uma frase de três linhas pintaria o
      // espaço vazio entre elas.
      const retangulos = atual >= 0 && frases[atual] ? mesclarLinhas([...frases[atual]!.getClientRects()]) : [];
      while (linhas.length < retangulos.length) {
        const linha = document.createElement("div");
        linha.className = "reading-line";
        camada.insertBefore(linha, pilula);
        linhas.push(linha);
      }
      linhas.forEach((linha, indice) => {
        const caixa = retangulos[indice];
        linha.hidden = !caixa;
        if (!caixa) return;
        posicionar(linha, caixa, area);
      });

      const caixa = palavraAtual?.getBoundingClientRect();
      if (!caixa || (!caixa.width && !caixa.height)) { pilula.dataset.visivel = "nao"; return; }
      posicionar(pilula, caixa, area);
      // A primeira aparição não desliza: sem isto a pílula viria voando do canto da tela.
      if (pilula.dataset.visivel !== "sim") {
        pilula.dataset.pronta = "nao";
        void pilula.offsetWidth;
      }
      pilula.dataset.visivel = "sim";
      requestAnimationFrame(() => { pilula.dataset.pronta = "sim"; });
    };

    const agendar = () => { if (!quadro) quadro = requestAnimationFrame(desenhar); };

    const limpar = () => {
      frases = []; palavras = []; atual = -1; palavraAtual = null; leituraId = "";
      pilula.dataset.visivel = "nao";
      camada.hidden = true;
    };

    const preparar = (id: string, sentencas: string[]) => {
      limpar();
      const alvo = document.querySelector(`[data-message-id="${CSS.escape(id)}"] .message-content`);
      if (!alvo) return;
      leituraId = id;

      const { texto, mapa } = achatar(alvo);
      let cursor = 0;
      for (const sentenca of sentencas) {
        const achado = findSpan(texto, sentenca, cursor);
        if (!achado) { frases.push(null); palavras.push([]); continue; }
        cursor = achado.ate;
        frases.push(intervalo(mapa, achado.de, achado.ate));
        palavras.push(wordFractions(texto, achado.de, achado.ate).flatMap((palavra) => {
          const range = intervalo(mapa, palavra.inicio, palavra.fim);
          return range ? [{ range, from: palavra.from, to: palavra.to }] : [];
        }));
      }
    };

    const mostrar = (index: number, ratio: number) => {
      if (index !== atual) {
        atual = index;
        const frase = frases[index];
        if (frase) rolarAte(frase, scroller.current);
      }
      /*
       * A última palavra que **já começou**, e não a que contém o ratio.
       *
       * As frações têm buracos onde ficam os espaços: "três" termina em 0,31 e "opções" começa em 0,33.
       * Procurar a palavra que contém o ratio devolvia nada nesse intervalo, e a pílula apagava e
       * acendia a cada espaço — medido na tela, um quadro pegou a frase destacada e a pílula sumida.
       * Segurar a anterior até a seguinte começar é o que faz ela deslizar em vez de piscar, e cobre
       * de graça o fim da frase, onde o ratio encosta em 1.
       */
      const lista = palavras[index] ?? [];
      let palavra: Palavra | undefined;
      for (const item of lista) { if (ratio >= item.from) palavra = item; else break; }
      palavraAtual = palavra?.range ?? null;
      agendar();
    };

    const ouvir = (message: ReadingMessage) => {
      if (message?.type !== "voice:reading") return;
      if (message.phase === "start") { preparar(message.id, message.sentences); agendar(); }
      else if (message.phase === "position" && message.id === leituraId) mostrar(message.index, message.ratio);
      else if (message.phase === "end" && message.id === leituraId) limpar();
    };

    document.body.append(camada);
    camada.hidden = true;
    const rolagem = scroller.current;
    rolagem?.addEventListener("scroll", agendar, { passive: true });
    window.addEventListener("resize", agendar);
    chrome.runtime?.onMessage.addListener(ouvir);
    limparDeFora = limpar;

    return () => {
      chrome.runtime?.onMessage.removeListener(ouvir);
      rolagem?.removeEventListener("scroll", agendar);
      window.removeEventListener("resize", agendar);
      if (quadro) cancelAnimationFrame(quadro);
      limparDeFora = null;
      camada.remove();
    };
  }, [scroller]);

  /*
   * O painel limpa por conta própria quando a leitura acaba do lado dele.
   *
   * Esperar só o `end` do offscreen deixava o destaque preso: parar a leitura com a voz desligada
   * **fecha o documento offscreen** (`stopSpeaking` em background.ts), e um documento fechado não roda
   * o `finally` que mandaria o `end`. O painel sabe que parou — `readingId` virou nulo — e isso basta.
   */
  useEffect(() => { if (readingId === null) limparDeFora?.(); }, [readingId]);
}

/** O `limpar` do efeito montado, para o segundo efeito conseguir chamá-lo sem remontar a camada. */
let limparDeFora: (() => void) | null = null;

/**
 * Junta os retângulos de uma mesma linha numa faixa contínua.
 *
 * `getClientRects()` não devolve uma caixa por linha: devolve uma por **caixa inline**. Um `**negrito**`
 * no meio da frase vira três retângulos na mesma linha — antes, dentro e depois dele — e com canto
 * arredondado cada emenda aparecia como um dente. Medido na tela: "Encontrei **três opções** no site."
 * saía em três faixas mordidas. Duas caixas são da mesma linha quando se sobrepõem na vertical por
 * mais da metade da menor.
 */
function mesclarLinhas(retangulos: DOMRect[]): DOMRect[] {
  const linhas: DOMRect[] = [];
  for (const caixa of retangulos) {
    if (!caixa.width || !caixa.height) continue;
    const indice = linhas.findIndex((linha) =>
      Math.min(linha.bottom, caixa.bottom) - Math.max(linha.top, caixa.top) > Math.min(linha.height, caixa.height) / 2);
    if (indice < 0) { linhas.push(DOMRect.fromRect(caixa)); continue; }
    const linha = linhas[indice];
    const esquerda = Math.min(linha.left, caixa.left);
    const topo = Math.min(linha.top, caixa.top);
    linhas[indice] = new DOMRect(esquerda, topo, Math.max(linha.right, caixa.right) - esquerda, Math.max(linha.bottom, caixa.bottom) - topo);
  }
  return linhas;
}

function posicionar(elemento: HTMLElement, caixa: DOMRect, area: DOMRect) {
  elemento.style.transform = `translate(${caixa.left - area.left - FOLGA_X}px, ${caixa.top - area.top - FOLGA_Y}px)`;
  elemento.style.width = `${caixa.width + FOLGA_X * 2}px`;
  elemento.style.height = `${caixa.height + FOLGA_Y * 2}px`;
}

type Pedaco = { no: Text; inicioNaString: number; tamanho: number };

/**
 * Achata os nós de texto numa string única, lembrando de onde veio cada pedaço.
 *
 * O espaço entre nós é acrescentado de propósito: sem ele, o fim de um parágrafo e o começo do
 * seguinte virariam uma palavra só, e a busca pela frase falharia na primeira quebra.
 */
function achatar(raiz: Element) {
  const caminhador = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT, {
    acceptNode: (no) => (no.nodeValue && no.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let texto = "";
  const mapa: Pedaco[] = [];
  let no: Node | null;
  while ((no = caminhador.nextNode())) {
    const valor = (no as Text).nodeValue ?? "";
    if (texto) texto += " ";
    mapa.push({ no: no as Text, inicioNaString: texto.length, tamanho: valor.length });
    texto += valor;
  }
  return { texto, mapa };
}

function posicaoNoNo(mapa: Pedaco[], posicao: number): { no: Text; deslocamento: number } | null {
  for (const parte of mapa) {
    if (posicao >= parte.inicioNaString && posicao <= parte.inicioNaString + parte.tamanho) {
      return { no: parte.no, deslocamento: posicao - parte.inicioNaString };
    }
  }
  const ultima = mapa.at(-1);
  return ultima ? { no: ultima.no, deslocamento: ultima.tamanho } : null;
}

function intervalo(mapa: Pedaco[], de: number, ate: number): Range | null {
  const comeco = posicaoNoNo(mapa, de);
  const termino = posicaoNoNo(mapa, ate);
  if (!comeco || !termino) return null;
  try {
    const range = document.createRange();
    range.setStart(comeco.no, comeco.deslocamento);
    range.setEnd(termino.no, termino.deslocamento);
    return range;
  } catch {
    return null;
  }
}

/**
 * Só rola quando a frase saiu de vista, e dentro da conversa — não da janela.
 *
 * Rolar a cada frase brigaria com quem resolveu olhar outra parte da conversa enquanto ouve.
 */
function rolarAte(range: Range, scroller: HTMLElement | null) {
  if (!scroller) return;
  const caixa = range.getBoundingClientRect();
  if (!caixa.height && !caixa.width) return;
  const area = scroller.getBoundingClientRect();
  if (caixa.top >= area.top && caixa.bottom <= area.bottom) return;
  const alvo = scroller.scrollTop + (caixa.top - area.top) - scroller.clientHeight * 0.35;
  scroller.scrollTo({ top: Math.max(0, alvo), behavior: "smooth" });
}
