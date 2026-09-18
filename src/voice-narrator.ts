/**
 * A resposta começa a ser falada enquanto ainda está sendo escrita.
 *
 * Numa conversa por voz, a Vela só abria a boca quando o turno inteiro terminava: o modelo gerava
 * todas as frases, o turno fechava, e só então a resposta ia para a síntese. Numa resposta de três
 * frases, a pessoa esperava em silêncio a geração das três para ouvir a primeira — e silêncio numa
 * conversa falada é lido como "não me ouviu".
 *
 * Aqui cada frase completa vai para a fila de fala assim que chega. O que sobrar no fim do turno —
 * a última frase, ou o texto que não fechou em frase — é falado depois, pela mesma fila, na ordem.
 *
 * Duas coisas não são faladas no caminho:
 * - **desistência do modelo rápido.** "Não consigo" pode ser descartado pelo loop e refeito pelo
 *   modelo robusto; falado antes, a pessoa ouviria uma recusa que nunca aconteceu de verdade;
 * - **bloco de código aberto.** Uma frase partida no meio de um bloco leria código em voz alta.
 */

/** Espelha `DECLINE_PATTERN` do loop: o que ele pode descartar, a narração não antecipa. */
const DESISTENCIA = /\b(não consigo|não posso|não tenho como|não é poss[íi]vel|não tenho acesso|não sei como fazer|infelizmente não)\b/i;
/** Frase curta demais sai picotada na síntese ("Ok." sozinho vira uma requisição inteira). */
const MINIMO = 24;

/** Até onde o texto já forma frases completas, a partir de `inicio`. Zero quando ainda não forma. */
export function fimDeFrases(texto: string, inicio: number): number {
  let fim = 0;
  const fronteira = /([.!?…]["”')\]]?)(\s+)|\n\s*\n/g;
  fronteira.lastIndex = inicio;
  for (let casamento = fronteira.exec(texto); casamento; casamento = fronteira.exec(texto)) {
    const pontuacao = casamento.index;
    // "1." de lista numerada e "R$ 24.90" não fecham frase.
    if (casamento[1] && /\d/.test(texto[pontuacao - 1] ?? "")) continue;
    const candidato = casamento.index + casamento[0].length;
    if (((texto.slice(0, candidato).match(/```/g) ?? []).length) % 2 === 1) continue;
    if (candidato - inicio >= MINIMO) fim = candidato;
  }
  return fim;
}

export function criarNarrador(falar: (texto: string) => void) {
  const acumulado = new Map<string, string>();
  const falado = new Map<string, number>();
  return {
    /** Um pedaço novo da mensagem `id`. Fala o que já fechou em frase. */
    pedaco(id: string, texto: string) {
      const atual = (acumulado.get(id) ?? "") + texto;
      acumulado.set(id, atual);
      const inicio = falado.get(id) ?? 0;
      const fim = fimDeFrases(atual, inicio);
      if (!fim) return;
      const trecho = atual.slice(inicio, fim);
      if (DESISTENCIA.test(trecho)) return;
      falado.set(id, fim);
      if (trecho.trim()) falar(trecho.trim());
    },
    /** O que ainda não foi falado da mensagem final. */
    restante(id: string, conteudo: string) {
      return conteudo.slice(falado.get(id) ?? 0).trim();
    },
    jaFalou: (id: string) => (falado.get(id) ?? 0) > 0,
    /** A mensagem foi descartada: o que foi falado dela não conta mais para nada. */
    esquecer(id: string) { falado.delete(id); acumulado.delete(id); },
  };
}
