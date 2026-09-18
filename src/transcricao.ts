/**
 * O que o modelo de transcrição devolve quando não houve fala.
 *
 * Numa sessão real ele devolveu ".", "so", "Thank you." e "E aí" para trechos de ruído e de
 * respiração. Cada um desses abriu um turno, e cada turno novo **interrompe o que está em
 * andamento** — então a Vela parava no meio de uma tarefa que já tinha dado certo e anunciava "não
 * consegui concluir essa". Quem falou não entendia nada: pela tela, ela tinha acabado de conseguir.
 *
 * Por isso o corte é aqui, antes de virar turno, e não numa camada esperta depois. Descartar uma
 * palavra solta legítima custa a pessoa repetir; aceitar ruído custa interromper trabalho e mentir
 * sobre o resultado.
 */

const ALUCINACOES = [
  /^legendas?\b.*amara\.org/i,
  /^obrigad[oa]( por assistir)?[.!]?$/i,
  /^(muito )?obrigad[oa] a? ?(todos|voc[êe]s)?[.!]?$/i,
  /^thank you( for watching)?[.!]?$/i,
  /^(thanks|bye|you|so|hmm+|uh+|ah+|mm+)[.!]?$/i,
  /^tchau[.!]?$/i,
  /^(é|eh|ah|oh|hum|uhum|ué|opa)[.…!]*$/i,
  /^[\s.,!?…\-–—"'`]*$/,
];

/**
 * Respostas curtas que são respostas de verdade.
 *
 * O corte por tamanho existe para barrar ruído, e "sim" tem três letras. Sem esta lista, confirmar
 * ou mandar parar por voz simplesmente não funcionaria.
 */
const RESPOSTAS_CURTAS = /^(sim|n[ãa]o|pare|para|continua|continue|ok(ei)?|isso|certo|espera|cancela|volta)[.!]?$/i;

const letras = (texto: string) => (texto.match(/\p{L}/gu) ?? []).length;

export type Veredito = { descartar: boolean; motivo?: string };

export function avaliarTranscricao(texto: string): Veredito {
  const limpo = texto.trim();
  if (!limpo) return { descartar: true, motivo: "transcrição vazia" };
  if (ALUCINACOES.some((padrao) => padrao.test(limpo))) {
    return { descartar: true, motivo: "reconhecido como alucinação do modelo de transcrição" };
  }
  if (letras(limpo) < 4 && !RESPOSTAS_CURTAS.test(limpo)) {
    return { descartar: true, motivo: "curta demais para ser um pedido" };
  }
  return { descartar: false };
}
