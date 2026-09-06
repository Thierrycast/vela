import { useEffect, useState } from "react";
import { Mic, MicOff, X } from "lucide-react";
import { VelaOrb, VelaState } from "./vela-components";
import { VoiceVisualMetrics } from "./audio-metrics";

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
export function VoiceStage({ state, visual, focused, transcript, onToggleFocus, onToggleMute, muted, onClose }: {
  state: VelaState;
  visual?: string;
  focused: boolean;
  transcript?: string;
  onToggleFocus: () => void;
  onToggleMute: () => void;
  muted: boolean;
  onClose: () => void;
}) {
  // O offscreen transmite a telemetria para toda a extensão; ouvir aqui evita passar 20 amostras
  // por segundo pelo estado do painel, o que re-renderizaria a conversa inteira a cada uma.
  const [metrics, setMetrics] = useState<VoiceVisualMetrics | undefined>(undefined);
  useEffect(() => {
    const listener = (message: { type?: string; telemetry?: { metrics?: VoiceVisualMetrics } }) => {
      if (message?.type === "voice:telemetry" && message.telemetry?.metrics) setMetrics(message.telemetry.metrics);
    };
    chrome.runtime?.onMessage.addListener(listener);
    return () => chrome.runtime?.onMessage.removeListener(listener);
  }, []);

  const label = state === "listening" ? "Ouvindo você" : state === "speaking" ? "Falando" : state === "thinking" ? "Pensando" : "Ao vivo";

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
      {transcript && <p className="voice-transcript">{transcript}</p>}
    </>}

    <div className="voice-controls">
      <button className={`voice-control ${muted ? "mudo" : ""}`} onClick={onToggleMute} aria-label={muted ? "Reativar o microfone" : "Silenciar o microfone"}>
        {muted ? <MicOff size={16} /> : <Mic size={16} />}
      </button>
      <button className="voice-control encerrar" onClick={onClose} aria-label="Encerrar a conversa por voz"><X size={16} /></button>
    </div>
  </div>;
}
