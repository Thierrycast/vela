/**
 * Onde a frase termina, e onde a palavra termina — decidido num lugar só.
 *
 * O destaque da leitura depende de duas pontas concordarem: o offscreen fala frase a frase e diz
 * "estou na frase 3, a 40% dela", e o painel acha a frase 3 no texto renderizado e pinta a palavra
 * que cai nos 40%. Se cada ponta fatiasse o texto por conta própria, as listas divergiriam na
 * primeira abreviação ou reticência, e o destaque passaria a apontar para a frase errada — um erro
 * que só aparece no meio de um texto longo. Por isso o offscreen fatia aqui e **manda as frases
 * prontas**; o painel nunca fatia, só procura.
 */

/**
 * Quebra em frases.
 *
 * Quebra de linha sempre fecha frase: o `/text/prepare` transforma item de lista e título em linha
 * própria, e juntar dois itens numa frase só faria o destaque atravessar a lista. Dentro da linha,
 * fecha em `.`, `!`, `?` e `…` **seguidos de espaço** — o espaço é o que protege "R$ 1.500,00" e
 * "v2.7.0", que têm ponto e não são fim de frase.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((linha) => linha.split(/(?<=[.!?…])\s+/))
    .map((frase) => frase.trim())
    .filter((frase) => /[\p{L}\p{N}]/u.test(frase));
}

/** Normaliza para comparar: o texto renderizado tem quebras e espaços que a limpeza colapsou. */
export const normalizeSpaces = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * Acha `alvo` dentro de `texto` a partir de `inicio`, tolerando diferença de espaço em branco.
 *
 * Comparar direto falharia: a tela tem quebra de linha onde o texto limpo tem um espaço só. A busca
 * anda caractere a caractere tratando qualquer sequência de espaço como um espaço.
 *
 * É **sequencial e nunca volta atrás**: as frases chegam na ordem em que são faladas, então cada uma
 * começa depois de onde a anterior terminou. Isso também impede casar com uma repetição anterior da
 * mesma frase.
 *
 * Quando não casa, tenta de novo sem a pontuação final: o `/text/prepare` põe ponto em título e em
 * item de lista ("Frete grátis."), e esse ponto não existe na tela.
 */
export function findSpan(texto: string, alvo: string, inicio: number): { de: number; ate: number } | null {
  const tentativas = [normalizeSpaces(alvo)];
  const semPontuacao = tentativas[0].replace(/[.!?…:;,]+$/u, "");
  if (semPontuacao && semPontuacao !== tentativas[0]) tentativas.push(semPontuacao);

  for (const procurado of tentativas) {
    const achado = buscar(texto, procurado, inicio);
    if (achado) return achado;
  }
  return null;
}

function buscar(texto: string, procurado: string, apartirDe: number): { de: number; ate: number } | null {
  if (!procurado) return null;
  for (let comeco = apartirDe; comeco < texto.length; comeco += 1) {
    if (/\s/.test(texto[comeco])) continue;
    let noTexto = comeco;
    let noAlvo = 0;
    while (noAlvo < procurado.length && noTexto < texto.length) {
      const doAlvo = procurado[noAlvo];
      if (/\s/.test(doAlvo)) {
        if (!/\s/.test(texto[noTexto])) break;
        while (noTexto < texto.length && /\s/.test(texto[noTexto])) noTexto += 1;
        noAlvo += 1;
        continue;
      }
      if (texto[noTexto] !== doAlvo) break;
      noTexto += 1;
      noAlvo += 1;
    }
    if (noAlvo >= procurado.length) return { de: comeco, ate: noTexto };
  }
  return null;
}

/**
 * As palavras de um trecho, com a fração de caracteres onde cada uma começa e termina.
 *
 * A síntese não devolve tempo de palavra, então a posição dentro da frase é estimada por caractere:
 * a 40% do áudio da frase, a fala está perto do caractere 40%. A frase é curta e cada uma tem sua
 * própria janela de tempo medida, então o erro não acumula — ele zera a cada frase.
 */
export function wordFractions(texto: string, de: number, ate: number): Array<{ inicio: number; fim: number; from: number; to: number }> {
  const total = ate - de;
  if (total <= 0) return [];
  const palavras: Array<{ inicio: number; fim: number; from: number; to: number }> = [];
  let posicao = de;
  while (posicao < ate) {
    while (posicao < ate && /\s/.test(texto[posicao])) posicao += 1;
    if (posicao >= ate) break;
    const inicio = posicao;
    while (posicao < ate && !/\s/.test(texto[posicao])) posicao += 1;
    palavras.push({ inicio, fim: posicao, from: (inicio - de) / total, to: (posicao - de) / total });
  }
  return palavras;
}
