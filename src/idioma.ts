/**
 * Que idioma é este texto — o suficiente para escolher uma voz.
 *
 * Não é detecção de idioma de verdade, e não precisa ser: a pergunta aqui é binária e tolerante a
 * erro ("falo isto com voz portuguesa ou inglesa?"), e uma biblioteca inteira para isso seria peso
 * morto num documento offscreen. Acento e palavras funcionais resolvem o caso real — respostas
 * curtas, ditas em voz alta, num dos dois idiomas em que a pessoa conversa.
 *
 * Empate devolve o padrão de quem chamou: sem sinal, trocar a voz seria pior que não trocar.
 */

const PORTUGUES = /[áàâãéêíóôõúüç]|\b(que|não|para|você|com|uma|isso|está|então|aqui|também|mais|como|fazer|página|obrigado|agora|tudo|bem)\b/gi;
const INGLES = /\b(the|and|you|for|with|this|that|is|are|was|were|to|of|it|your|from|have|has|will|can|about|page|here)\b/gi;

export type Idioma = "pt" | "en";

export function idiomaDoTexto(texto: string, padrao: Idioma = "pt"): Idioma {
  const limpo = texto.replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ");
  const pt = (limpo.match(PORTUGUES) ?? []).length;
  const en = (limpo.match(INGLES) ?? []).length;
  if (pt === en) return padrao;
  return pt > en ? "pt" : "en";
}

/** O prefixo que o servidor de voz usa no idioma de cada voz: `pt_BR`, `en_US`, `en_GB`… */
export const combinaComIdioma = (language: string | undefined, idioma: Idioma) =>
  !!language && language.toLowerCase().startsWith(idioma);
