/**
 * A escada de ferramentas, cumprida no código e não só pedida no prompt.
 *
 * O prompt sempre disse que a captura de tela não é a primeira leitura, e mesmo assim ela era: o
 * modelo pedia "o que tem nesta página" e ia direto ao `screenshot` — que custa segundos, milhares
 * de tokens de imagem e reconhecimento de letra em pixel — para ler um texto que já estava escrito
 * no DOM e sairia em milissegundos. Instrução que o modelo pode ignorar é sugestão; aqui ela vira
 * regra: **a captura só roda depois de uma leitura por texto no mesmo pedido.**
 *
 * A recusa não é um beco. Ela diz qual degrau tentar, e se o degrau barato não resolver, a captura
 * seguinte passa — é uma ordem, não uma proibição. E quando a própria pessoa pede a imagem ("tira
 * um print", "como está o layout"), não há o que subir: a captura roda direto.
 */

/*
 * Pedidos que são sobre pixel. "Tela" fica de fora de propósito: "o que tem na tela" é a pergunta
 * mais comum de leitura, e é justamente a que o texto responde melhor e mais rápido.
 */
const PEDIDO_VISUAL = /\b(print\w*|captur\w*|screenshot|imagem|imagens|foto\w*|visual\w*|apar[eê]ncia|layout|cores?|gr[aá]fico\w*|[ií]cones?|desenho\w*|design)\b/i;

/** As ações que leem a página por texto — qualquer uma delas conta como degrau tentado. */
const LEITURAS = new Set(["extractPage", "find", "evaluateScript", "pageTool"]);

let pedidoVisual = false;
let leuPorTexto = false;

/** Um pedido novo recomeça a escada: o que foi lido para o pedido anterior não conta para este. */
export function iniciarPedido(texto: string) {
  pedidoVisual = PEDIDO_VISUAL.test(texto);
  leuPorTexto = false;
}

export function registrarAcao(tipo: string, ok: boolean) {
  if (ok && LEITURAS.has(tipo)) leuPorTexto = true;
}

/** Devolve a recusa, ou `null` quando a captura pode rodar. */
export function recusaDaCaptura(): string | null {
  if (pedidoVisual || leuPorTexto) return null;
  return "ERRO [escada] Ainda não li esta página por texto neste pedido, e a captura de tela é o degrau mais caro: segundos de espera e milhares de tokens para reconhecer em pixel um texto que o DOM já tem. Leia primeiro — `find` se você sabe o que procura, `extractPage` com `extractMode: \"text\"` para ler o conteúdo, ou `extractPage` para ver os elementos. Se depois disso o que você precisa só existir em imagem (foto, gráfico, cor, layout), chame `screenshot` de novo e ela roda.";
}

export const pediuImagem = (texto: string) => PEDIDO_VISUAL.test(texto);
