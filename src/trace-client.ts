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
 */
import { TraceKind } from "./trace";

export function traceFrom(origin: string) {
  return (kind: TraceKind, label: string, extra: { data?: Record<string, unknown>; ok?: boolean; ms?: number; code?: string } = {}) => {
    void chrome.runtime?.sendMessage({ type: "trace:push", entry: { kind, label, from: origin, ...extra } }).catch(() => undefined);
  };
}

/** Mede um trecho e grava a duração junto do desfecho — mesma forma do `span` do background. */
export function spanFrom(origin: string) {
  const push = traceFrom(origin);
  return (kind: TraceKind, label: string, data?: Record<string, unknown>) => {
    const started = performance.now();
    return {
      end(extra: { data?: Record<string, unknown>; ok?: boolean; code?: string } = {}) {
        push(kind, label, { ms: Math.round(performance.now() - started), data, ...extra });
      },
    };
  };
}
