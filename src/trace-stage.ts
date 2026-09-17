import { TraceEvent, TraceKind, currentTurnId, record, recordFull, span, traceDetail } from "./trace";
import { saveBlob } from "./trace-blobs";

/**
 * O jeito único de instrumentar uma etapa.
 *
 * Antes, cada ponto do código decidia sozinho o que gravar: um media com `span`, outro anota com
 * `record`, um terceiro esquece de fechar o span quando dá erro, e cada um inventa o nome do campo
 * — `texto`, `text`, `conteudo`, `resultado`. O resultado é uma trilha que só quem escreveu
 * consegue ler, e um relatório que precisa conhecer caso a caso para montar a narrativa.
 *
 * `runStage` embrulha qualquer etapa assíncrona e garante o mesmo contrato para todas: quem
 * (origem e turno), quando (início e duração), o quê (etapa do vocabulário fechado), com que
 * entrada, com que saída, e o que deu errado quando deu. Uma etapa nunca fica sem fecho — nem
 * quando lança, que é justamente quando mais interessa saber onde parou.
 *
 * O custo fica onde deve: `entrada` e `saida` só são gravadas no rastreio completo. No normal,
 * sobra a medição — etapa, duração, desfecho —, que é barata e continua respondendo "o que está
 * lento" sem guardar o conteúdo de nada.
 */

export type StageMeta = {
  /** O que identifica esta execução para quem for ler: modelo usado, voz, aba, tamanho. */
  [campo: string]: unknown;
};

type StageOptions = {
  /** Dados grandes: o texto que entrou, o payload que saiu. Só no rastreio completo. */
  entrada?: unknown;
  /** Costura: a rodada, a chamada ou a ação a que esta etapa pertence. */
  round?: number;
  callId?: string;
  actionId?: string;
};

/** O que a etapa devolve para a trilha, além do valor que devolve a quem chamou. */
export type StageResult = { saida?: unknown; meta?: StageMeta; blobId?: string; ok?: boolean; code?: string };

/**
 * Executa a etapa medindo e gravando. O retorno é o da função — a instrumentação não muda o fluxo.
 *
 * `descrever` traduz o resultado em o que deve ser gravado. Existe porque só quem chama sabe o que
 * no retorno importa: de uma transcrição importa o texto, de uma síntese importam os bytes e o
 * formato, e gravar o objeto inteiro por padrão encheria a trilha de ruído.
 */
export async function runStage<T>(
  kind: TraceKind,
  label: string,
  meta: StageMeta,
  fn: () => Promise<T>,
  descrever?: (valor: T) => StageResult,
  options: StageOptions = {},
): Promise<T> {
  const medida = span(kind, label, meta);
  if (options.entrada !== undefined) {
    recordFull(kind, `${label} · entrada`, { data: { entrada: options.entrada, ...meta }, round: options.round, callId: options.callId, actionId: options.actionId });
  }
  try {
    const valor = await fn();
    const descrito = descrever?.(valor) ?? {};
    medida.end({
      ok: descrito.ok ?? true,
      code: descrito.code,
      round: options.round,
      callId: options.callId,
      actionId: options.actionId,
      blobId: descrito.blobId,
      data: { ...meta, ...(descrito.meta ?? {}), ...(traceDetail() === "completo" && descrito.saida !== undefined ? { saida: descrito.saida } : {}) },
    });
    return valor;
  } catch (erro) {
    // Uma etapa que lança precisa aparecer na trilha como etapa que lançou, e não sumir: é o
    // buraco que faz um relatório terminar no meio sem explicar por quê.
    medida.end({
      ok: false,
      code: "excecao",
      round: options.round,
      callId: options.callId,
      actionId: options.actionId,
      data: { ...meta, erro: erro instanceof Error ? erro.message : String(erro) },
    });
    throw erro;
  }
}

/** Uma etapa que não envolve espera: só o registro, com o mesmo contrato. */
export function noteStage(kind: TraceKind, label: string, meta: StageMeta = {}, extra: Partial<TraceEvent> = {}) {
  record(kind, label, { ...extra, data: { ...meta, ...(extra.data ?? {}) } });
}

/**
 * Guarda um áudio e devolve o id para o evento que o descreve.
 *
 * Separado de `runStage` porque nem toda etapa produz áudio e porque o custo é de outra ordem:
 * quem grava precisa decidir explicitamente que aquele trecho vale ser guardado.
 */
export async function attachAudio(label: string, bytes: ArrayBuffer | Uint8Array, mime: string): Promise<string | undefined> {
  return saveBlob({ turn: currentTurnId(), mime, label, bytes });
}
