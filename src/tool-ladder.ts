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
 *
 * **Cada pedido tem a sua escada.** Era um estado só, global ao service worker, e as tarefas de
 * fundo rodam ao mesmo tempo que a conversa: a leitura de uma destravava a captura da outra, e uma
 * mensagem nova no painel zerava a escada de uma tarefa que já tinha lido a página. Agora o pedido
 * carrega a própria escada, e quem executa a ferramenta recebe qual é.
 */

/*
 * Pedidos que são sobre pixel. "Tela" fica de fora de propósito: "o que tem na tela" é a pergunta
 * mais comum de leitura, e é justamente a que o texto responde melhor e mais rápido.
 */
const PEDIDO_VISUAL = /\b(print\w*|captur\w*|screenshot|imagem|imagens|foto\w*|visual\w*|apar[eê]ncia|layout|cores?|gr[aá]fico\w*|[ií]cones?|desenho\w*|design)\b/i;

/** As ações que leem a página por texto — qualquer uma delas conta como degrau tentado. */
const LEITURAS = new Set(["extractPage", "find", "evaluateScript", "pageTool"]);

export type Escada = { visual: boolean; leu: boolean };

/** A escada de um pedido novo. `texto` é o que a pessoa pediu, como ela pediu. */
export const novaEscada = (texto: string): Escada => ({ visual: PEDIDO_VISUAL.test(texto), leu: false });

export function registrarAcao(escada: Escada | undefined, tipo: string, ok: boolean) {
  if (escada && ok && LEITURAS.has(tipo)) escada.leu = true;
}

/** Devolve a recusa, ou `null` quando a captura pode rodar. */
export function recusaDaCaptura(escada: Escada | undefined): string | null {
  // Sem escada (a ponte MCP, um agente de fora pedindo a imagem direto), não há pedido a escalar.
  if (!escada || escada.visual || escada.leu) return null;
  return "ERRO [escada] Ainda não li esta página por texto neste pedido, e a captura de tela é o degrau mais caro: segundos de espera e milhares de tokens para reconhecer em pixel um texto que o DOM já tem. Leia primeiro — `find` se você sabe o que procura, `extractPage` com `extractMode: \"text\"` para ler o conteúdo, ou `extractPage` para ver os elementos. Se depois disso o que você precisar só existir em imagem (foto, gráfico, cor, layout), chame `screenshot` de novo e ela roda.";
}
