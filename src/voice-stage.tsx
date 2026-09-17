import { useEffect, useState } from "react";
import { Circle, Mic, MicOff, Square, X } from "lucide-react";
import { VelaOrb, VelaState } from "./vela-components";
import { VoiceVisualMetrics } from "./audio-metrics";
import { traceFrom } from "./trace-client";

const trace = traceFrom("painel");

/**
 * O palco da voz dentro do painel.
 *
 * Em **foco**, o orb ocupa a conversa e o que se ouve é o assunto. Ao tocar nele, ele encolhe e
 * desce até o rodapé, e a conversa volta a aparecer — é o gesto do ChatGPT, e funciona porque
 * durante uma conversa falada a última coisa que se quer é escolher entre ver o orb ou ver o
 * texto.
 *
 * O mesmo componente serve aos dois estados: o que muda é a classe, então a transição é contínua
 * em vez de uma troca de tela.
 */
export function VoiceStage({ state, visual, focused, transcript, transcriptFinal = true, onToggleFocus, onToggleMute, muted, onClose, mode = "live", debugRecording, debugItems = 0, onToggleDebug }: {
  state: VelaState;
  visual?: string;
  focused: boolean;
  transcript?: string;
  /** `false` enquanto o texto na tela é o rascunho do reconhecedor rápido (Vosk) — pior de
   *  propósito, existe só para a tela não ficar muda enquanto a pessoa fala. `true` quando já é
   *  o texto final (Whisper), que é o que de fato vira turno. Sem essa distinção visual, o
   *  rascunho pior passa a impressão de que a transcrição inteira é ruim. */
  transcriptFinal?: boolean;
  onToggleFocus: () => void;
  onToggleMute: () => void;
  muted: boolean;
  onClose: () => void;
  /**
   * `live` é conversa: microfone aberto, dá para silenciar e encerrar. `leitura` é a Vela lendo uma
   * mensagem que você pediu — não há microfone para silenciar, e "encerrar a conversa" seria a ação
   * errada: o que se quer é parar a leitura.
   */
  mode?: "live" | "leitura";
  /** Grava a sessão (áudio do mic por enunciado + fala da Vela + transcrições) e baixa um .zip ao
   *  parar — para revisar depois um comportamento estranho sem depender de descrever de memória. */
  debugRecording?: boolean;
  debugItems?: number;
  onToggleDebug?: () => void;
}) {
  // O offscreen transmite a telemetria para toda a extensão; ouvir aqui evita passar 20 amostras
  // por segundo pelo estado do painel, o que re-renderizaria a conversa inteira a cada uma.
  const [metrics, setMetrics] = useState<VoiceVisualMetrics | undefined>(undefined);
  useEffect(() => {
    // Um resumo periódico do que chegou: "o orb não reage" pode ser telemetria que não chega ou
    // renderer que ignora o sinal, e só o contador separa os dois.
    let recebidas = 0;
    let pico = 0;
    const listener = (message: { type?: string; telemetry?: { metrics?: VoiceVisualMetrics } }) => {
      if (message?.type !== "voice:telemetry" || !message.telemetry?.metrics) return;
      recebidas += 1;
      pico = Math.max(pico, message.telemetry.metrics.energy);
      setMetrics(message.telemetry.metrics);
    };
    chrome.runtime?.onMessage.addListener(listener);
    const resumo = setInterval(() => {
      trace("ui", "telemetria no palco", { data: { amostras: recebidas, pico: Number(pico.toFixed(3)) } });
      recebidas = 0; pico = 0;
    }, 3000);
    return () => { chrome.runtime?.onMessage.removeListener(listener); clearInterval(resumo); };
  }, []);

  const label = mode === "leitura" ? "Lendo em voz alta"
    : state === "listening" ? "Ouvindo você" : state === "speaking" ? "Falando" : state === "thinking" ? "Pensando" : "Ao vivo";

  return <div className={`voice-stage ${focused ? "focada" : "compacta"}`}>
    <button
      className="voice-orb"
      onClick={onToggleFocus}
      aria-label={focused ? "Recolher e ver a conversa" : "Ver a voz em foco"}
      title={focused ? "Recolher e ver a conversa" : "Ver a voz em foco"}
    >
      <VelaOrb state={state} size={focused ? 190 : 46} metrics={metrics} visual={visual} />
    </button>

    {focused && <>
      <span className="voice-label">{label}</span>
      {transcript && <p className={`voice-transcript ${transcriptFinal ? "" : "rascunho"}`}>{transcript}</p>}
    </>}

    <div className="voice-controls">
      {mode === "leitura"
        ? <button className="voice-control encerrar" onClick={onClose} aria-label="Parar a leitura" title="Parar a leitura"><Square size={13} fill="currentColor" /></button>
        : <>
          <button className={`voice-control ${muted ? "mudo" : ""}`} onClick={onToggleMute} aria-label={muted ? "Reativar o microfone" : "Silenciar o microfone"}>
            {muted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          {onToggleDebug && (
            <button
              className={`voice-control ${debugRecording ? "gravando" : ""}`}
              onClick={onToggleDebug}
              aria-label={debugRecording ? `Parar a gravação e baixar o pacote de revisão (${debugItems} fala(s))` : "Gravar esta sessão para revisar depois"}
              title={debugRecording ? `Gravando — ${debugItems} fala(s). Clique para parar e baixar o zip com relatório, eventos e áudios.` : "Liga o rastreio completo e, ao parar, baixa o pacote de revisão: relatório, eventos e os áudios da conversa"}
            >
              <Circle size={14} fill={debugRecording ? "currentColor" : "none"} />
            </button>
          )}
          <button className="voice-control encerrar" onClick={onClose} aria-label="Encerrar a conversa por voz"><X size={16} /></button>
        </>}
    </div>
  </div>;
}
