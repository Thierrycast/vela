/**
 * A trilha para quem não é o background.
 *
 * O IndexedDB da trilha vive no service worker; painel, offscreen e conteúdo não escrevem nele
 * direto — se escrevessem, cada superfície teria seu próprio banco e a ordem dos eventos entre
 * elas se perderia, que é justamente o que se quer ver quando algo quebra na fronteira (a voz
 * captura no offscreen, o turno roda no background, o orb desenha no painel).
 *
 * Perder um evento aqui é aceitável: o background pode estar dormindo. Perder a sessão inteira
 * porque um `sendMessage` rejeitou não é — por isso todo envio engole a falha.
 *
 * O **nível de detalhe** é a exceção que precisa viajar. Quem decide se o rastreio é completo é a
 * configuração, lida no background; mas quem sabe se aquele payload é grande demais para o nível
 * normal é quem está gravando, aqui. Sem essa cópia local, ou o offscreen manda tudo sempre (e o
 * uso normal fica caro), ou não manda nada (e o modo completo não serve para a voz, que é
 * justamente onde ele mais importa).
 */
import { TraceEvent, TraceDetail, TraceKind } from "./trace";

let detalhe: TraceDetail = "normal";
export const setClientDetail = (nivel: TraceDetail) => { detalhe = nivel; };
export const clientDetail = () => detalhe;

type Extra = Partial<Pick<TraceEvent, "data" | "ok" | "ms" | "code" | "round" | "callId" | "actionId" | "blobId">>;

export function traceFrom(origin: string) {
  return (kind: TraceKind, label: string, extra: Extra = {}) => {
    void chrome.runtime?.sendMessage({ type: "trace:push", entry: { kind, label, from: origin, ...extra } }).catch(() => undefined);
  };
}

/** O que só existe no rastreio completo — payloads grandes, conteúdo, áudio. */
export function fullTraceFrom(origin: string) {
  const push = traceFrom(origin);
  return (kind: TraceKind, label: string, extra: Extra = {}) => {
    if (detalhe === "completo") push(kind, label, extra);
  };
}

/** Mede um trecho e grava a duração junto do desfecho — mesma forma do `span` do background. */
export function spanFrom(origin: string) {
  const push = traceFrom(origin);
  return (kind: TraceKind, label: string, data?: Record<string, unknown>) => {
    const started = performance.now();
    return {
      end(extra: Extra = {}) {
        push(kind, label, { ms: Math.round(performance.now() - started), data, ...extra });
      },
    };
  };
}
