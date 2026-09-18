import { AppSettings, ProviderProfile } from "./types";

/**
 * Qual modelo atende este pedido.
 *
 * Escolher um modelo só, nas configurações, e usá-lo para tudo paga o pior dos dois mundos: um
 * modelo forte responde "que horas são no Japão?" com a mesma latência que gastaria para planejar
 * uma compra em cinco abas. Quando o gateway é gratuito, o custo não é dinheiro — é **tempo até a
 * primeira palavra**, que é exatamente o que a pessoa sente, e é pior numa conversa falada.
 *
 * Três princípios, e eles explicam o resto do arquivo:
 *
 * 1. **Escada, não adivinhação.** A classe é escolhida no início do turno e só **sobe**. Trocar de
 *    modelo no meio de um raciocínio produz respostas que se contradizem entre rodadas, e ainda
 *    invalida o cache de prefixo do provider — pagando de novo o prompt inteiro.
 * 2. **Sinal barato, decisão explícita.** Nada de um modelo para classificar o pedido: isso somaria
 *    uma ida ao modelo justamente para economizar tempo de ida ao modelo. O que decide é o texto, o
 *    contexto do turno e o que já aconteceu nele.
 * 3. **O motivo vai junto.** Toda escolha entra na trilha com a razão. Roteamento que não se explica
 *    vira superstição na primeira vez que a resposta sai ruim.
 *
 * A pessoa continua no comando: o modo `fixo` usa o modelo escolhido por ela, como sempre foi.
 */

export type ClasseDeModelo = "rapido" | "conversa" | "navegacao" | "raciocinio" | "visao";

/** Da mais leve para a mais pesada. A escada só anda para a frente nesta ordem. */
const ORDEM: ClasseDeModelo[] = ["rapido", "conversa", "navegacao", "raciocinio"];

export type Decisao = { classe: ClasseDeModelo; modelo: string; motivo: string };

/*
 * Verbos e substantivos que dizem "isto é trabalho na página".
 *
 * A lista é curta de propósito: ela não precisa acertar todos os pedidos, só os frequentes. O caso
 * ambíguo cai em `navegacao`, que é o meio-termo — sabe usar ferramenta e não é o mais lento.
 */
const TRABALHO = /\b(abr[ea]|abrir|navega|acessa|entra|clica|clique|digita|preench|busca|procura|pesquis|compra|adiciona|carrinho|baixa|download|login|formul[áa]rio|envia|manda|agenda|marca|reserva|cadastr|lê|leia|ler|resum[ae]|extrai|copia|monitora|acompanha)\b/i;
/** Pedido que pede análise, não execução: comparar, decidir, explicar por quê. */
const RACIOCINIO = /\b(compar[ae]|analis|avalia|explica por ?qu[êe]|por ?qu[êe]|vale a pena|melhor op[çc][ãa]o|prós e contras|estrat[ée]gia|planeja|decide|qual deles|diferen[çc]a entre|revis[ae]|audita)\b/i;
/** Conversa curta: cumprimento, agradecimento, pergunta factual sem relação com a página. */
const CONVERSA = /^(oi|ol[áa]|e a[íi]|bom dia|boa tarde|boa noite|valeu|obrigad[oa]|tudo bem|beleza|certo|entendi|que horas|quem [ée]|o que [ée]|quanto [ée]|qual [ée] a capital)\b/i;

const limpar = (valor: string | undefined) => (valor ?? "").trim();

/**
 * O modelo de cada classe, com a herança que evita configuração vazia derrubar o turno: classe sem
 * modelo próprio cai para o padrão da pessoa, que é o que sempre funcionou.
 */
export function modeloDaClasse(classe: ClasseDeModelo, profile: ProviderProfile, settings: AppSettings): string {
  const escolhas = settings.agent.modelos;
  const padrao = limpar(profile.defaultModel);
  const porClasse: Record<ClasseDeModelo, string> = {
    rapido: limpar(escolhas?.rapido) || limpar(profile.fastModel),
    conversa: limpar(escolhas?.conversa) || limpar(profile.fastModel),
    navegacao: limpar(escolhas?.navegacao),
    raciocinio: limpar(escolhas?.raciocinio),
    visao: limpar(escolhas?.visao),
  };
  return porClasse[classe] || padrao;
}

export type Sinais = {
  /** O que a pessoa escreveu ou falou. */
  texto: string;
  /** Veio da voz? Aí a latência pesa mais: uma pausa de três segundos numa conversa falada é longa. */
  daVoz: boolean;
  /** O turno já carrega imagem (anexo ou captura)? Só um modelo com visão enxerga. */
  comImagem: boolean;
};

/** A classe do pedido, pelo que dá para saber antes de gastar a primeira ida ao modelo. */
export function classificarPedido({ texto, daVoz, comImagem }: Sinais): { classe: ClasseDeModelo; motivo: string } {
  if (comImagem) return { classe: "visao", motivo: "o turno tem imagem, e só um modelo com visão a enxerga" };
  const pedido = texto.trim();
  if (RACIOCINIO.test(pedido)) return { classe: "raciocinio", motivo: "o pedido é de análise ou comparação, não de execução" };
  if (TRABALHO.test(pedido)) return { classe: "navegacao", motivo: "o pedido é trabalho na página" };
  if (CONVERSA.test(pedido) || pedido.length <= 60) {
    return daVoz
      ? { classe: "rapido", motivo: "conversa curta por voz: o que importa é responder rápido" }
      : { classe: "conversa", motivo: "conversa curta, sem trabalho na página" };
  }
  return { classe: "navegacao", motivo: "pedido comum: o meio-termo entre rápido e forte" };
}

/**
 * A escada do turno: sobe de classe quando o caminho atual não está dando conta.
 *
 * Só sobe — e só por motivo observado, nunca por palpite. "Chamou ferramenta" é sinal de que a
 * tarefa é de trabalho e não de conversa; erro seguido e rodada que se acumula são sinal de que o
 * modelo atual está patinando, e insistir com ele é o jeito mais lento de chegar ao mesmo lugar.
 */
export function subirClasse(atual: ClasseDeModelo, evento: "chamou_ferramenta" | "erro_repetido" | "muitas_rodadas" | "desistiu"): { classe: ClasseDeModelo; motivo: string } | null {
  if (atual === "visao") return null;
  const indice = ORDEM.indexOf(atual);
  const alvo: Record<typeof evento, ClasseDeModelo> = {
    chamou_ferramenta: "navegacao",
    erro_repetido: "raciocinio",
    muitas_rodadas: "raciocinio",
    desistiu: "raciocinio",
  };
  const proxima = alvo[evento];
  if (ORDEM.indexOf(proxima) <= indice) return null;
  const motivos: Record<typeof evento, string> = {
    chamou_ferramenta: "o pedido virou trabalho na página",
    erro_repetido: "as tentativas estão falhando; subindo para um modelo mais forte",
    muitas_rodadas: "a tarefa passou de três rodadas sem concluir",
    desistiu: "o modelo desistiu em texto; um mais forte costuma concluir",
  };
  return { classe: proxima, motivo: motivos[evento] };
}

/** A decisão completa, já com o nome do modelo — é o que o loop usa e o que entra na trilha. */
export function decidir(sinais: Sinais, profile: ProviderProfile, settings: AppSettings): Decisao {
  if (settings.agent.modelRouting !== "auto") {
    return { classe: "navegacao", modelo: limpar(profile.defaultModel), motivo: "escolha fixa nas configurações" };
  }
  const { classe, motivo } = classificarPedido(sinais);
  return { classe, modelo: modeloDaClasse(classe, profile, settings), motivo };
}
