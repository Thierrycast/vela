import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { VISUALS, VisualId } from "../../src/voice-visuals";
import { STATE_MOOD } from "../../src/gl-visual";
import { VoiceMetricsAnalyzer, VoiceVisualMetrics, emptyVoiceMetrics } from "../../src/audio-metrics";
import { MotionState } from "../../src/motion-tokens";
import { VoiceVisual } from "../../src/gl-visual";
import "../../src/tokens.css";
import "./lab.css";

const STATES: MotionState[] = ["idle", "listening", "thinking", "speaking", "acting", "error"];

/** O botão veste a cor do estado que representa: o controle vira legenda do que se vê. */
const cssColor = (state: MotionState) => {
  const [red, green, blue] = STATE_MOOD[state];
  return `rgb(${Math.round(red * 255)} ${Math.round(green * 255)} ${Math.round(blue * 255)})`;
};
/** Ruído 1D suave: base de tudo que precisa oscilar sem repetir. */
function noise1d(position: number) {
  const cell = Math.floor(position);
  const fraction = position - cell;
  const smooth = fraction * fraction * (3 - 2 * fraction);
  const at = (index: number) => { const value = Math.sin(index * 127.1) * 43758.5453; return value - Math.floor(value); };
  return at(cell) * (1 - smooth) + at(cell + 1) * smooth;
}

const STATE_LABEL: Record<string, string> = {
  idle: "Ocioso", listening: "Ouvindo você", thinking: "Pensando", speaking: "Falando", acting: "Agindo", error: "Erro",
};

type Source = "off" | "microphone" | "simulated";

/**
 * Laboratório de movimento por voz: os cinco visuais recebendo exatamente os mesmos sinais, ao
 * mesmo tempo, alimentados pelo microfone de verdade. Serve para escolher a estética falando,
 * não olhando screenshot — que é onde a decisão sempre travava.
 */
function Lab() {
  const [source, setSource] = useState<Source>("off");
  const [state, setState] = useState<MotionState>("listening");
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<VoiceVisualMetrics>(emptyVoiceMetrics());
  const [focus, setFocus] = useState<VisualId | null>(null);
  const liveMetrics = useRef<VoiceVisualMetrics>(emptyVoiceMetrics());

  useEffect(() => {
    if (source === "off") { liveMetrics.current = emptyVoiceMetrics(); setMetrics(emptyVoiceMetrics()); return; }

    let stopped = false;
    let timer = 0;
    let analyzer: VoiceMetricsAnalyzer | null = null;
    let context: AudioContext | null = null;
    let stream: MediaStream | null = null;

    const publish = (value: VoiceVisualMetrics) => {
      liveMetrics.current = value;
      setMetrics({ ...value });
    };

    if (source === "simulated") {
      // Fala falsa, mas não periódica: senoide dá um vai-e-vem que denuncia o loop na hora.
      // Frases e sílabas saem de ruído, com duração irregular — como fala de verdade.
      const started = performance.now();
      const tick = () => {
        if (stopped) return;
        const seconds = (performance.now() - started) / 1000;
        const frase = noise1d(seconds * 0.28) > 0.42 ? 1 : 0;
        const silaba = noise1d(seconds * 4.2) * noise1d(seconds * 7.9 + 31);
        const ataque = noise1d(seconds * 13.5 + 77);
        const energy = frase * Math.min(1, 0.12 + silaba * 1.5 + ataque * 0.2);
        publish({
          energy,
          bass: energy * (0.45 + noise1d(seconds * 1.7) * 0.5),
          mid: energy * (0.55 + noise1d(seconds * 3.3 + 12) * 0.45),
          high: energy * (0.25 + noise1d(seconds * 6.1 + 44) * 0.4),
          speaking: energy > 0.12,
        });
        timer = window.setTimeout(tick, 40);
      };
      tick();
      return () => { stopped = true; window.clearTimeout(timer); };
    }

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (stopped) { for (const track of stream.getTracks()) track.stop(); return; }
        context = new AudioContext();
        analyzer = new VoiceMetricsAnalyzer(context, context.createMediaStreamSource(stream));
        const tick = () => {
          if (stopped || !analyzer) return;
          publish({ ...analyzer.sample() });
          timer = window.setTimeout(tick, 40);
        };
        tick();
      } catch (problem) {
        const name = problem instanceof DOMException ? problem.name : "";
        setError(name === "NotAllowedError" ? "Permissão de microfone recusada." : name === "NotFoundError" ? "Nenhum microfone encontrado." : "Não consegui abrir o microfone.");
        setSource("off");
      }
    })();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      analyzer?.disconnect();
      void context?.close();
      if (stream) for (const track of stream.getTracks()) track.stop();
    };
  }, [source]);

  const visible = focus ? VISUALS.filter((visual) => visual.id === focus) : VISUALS;

  return <main className="lab">
    <header className="lab-bar">
      <div className="lab-title">
        <strong>Voice Motion Lab</strong>
        <small>Os mesmos sinais em todos os visuais, ao mesmo tempo.</small>
      </div>

      <div className="lab-group" role="group" aria-label="Fonte do sinal">
        {(["off", "microphone", "simulated"] as Source[]).map((item) => (
          <button key={item} className={source === item ? "on" : ""} onClick={() => { setError(null); setSource(item); }}>
            {item === "off" ? "Parado" : item === "microphone" ? "Microfone" : "Voz simulada"}
          </button>
        ))}
      </div>

      <div className="lab-group" role="group" aria-label="Estado do agente">
        {STATES.map((item) => (
          <button key={item} className={state === item ? "on" : ""} style={{ "--tom": cssColor(item) } as React.CSSProperties} onClick={() => setState(item)}>{STATE_LABEL[item]}</button>
        ))}
      </div>

      <div className="lab-readout">
        {(["energy", "bass", "mid", "high"] as const).map((key) => (
          <span key={key}><i>{key}</i><b style={{ transform: `scaleX(${Math.max(0.01, metrics[key]).toFixed(3)})` }} /></span>
        ))}
        <span className={`lab-vad ${metrics.speaking ? "on" : ""}`}>voz</span>
      </div>
    </header>

    {error && <p className="lab-error">{error}</p>}

    <div className={`lab-grid ${focus ? "focused" : ""}`}>
      {visible.map((visual) => (
        <figure key={visual.id} className={visual.id === "ambient-edge" ? "lab-cell edge" : "lab-cell"}>
          <VisualStage id={visual.id} state={state} metrics={liveMetrics} />
          <figcaption>
            <div>
              <strong>{visual.name}</strong>
              <small>{visual.description}</small>
              <code>{visual.technique}{visual.webgl ? " · WebGL" : ""}</code>
            </div>
            <button onClick={() => setFocus(focus === visual.id ? null : visual.id)}>{focus === visual.id ? "Ver todos" : "Isolar"}</button>
          </figcaption>
        </figure>
      ))}
    </div>
  </main>;
}

/** Cada palco tem seu próprio RAF; a leitura das métricas passa por ref para não re-renderizar a 25Hz. */
function VisualStage({ id, state, metrics }: { id: VisualId; state: MotionState; metrics: React.RefObject<VoiceVisualMetrics> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visualRef = useRef<VoiceVisual | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const entry = VISUALS.find((item) => item.id === id);
    if (!entry) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const visual = entry.create(canvas, { reducedMotion: reduced });
    setFailed("ok" in visual && !(visual as { ok: boolean }).ok);
    visual.start();
    visualRef.current = visual;

    const observer = new ResizeObserver(() => visual.resize());
    observer.observe(canvas);
    let raf = 0;
    const pump = () => { visual.setMetrics(metrics.current ?? emptyVoiceMetrics()); raf = requestAnimationFrame(pump); };
    pump();

    return () => { cancelAnimationFrame(raf); observer.disconnect(); visual.destroy(); visualRef.current = null; };
  }, [id, metrics]);

  useEffect(() => { visualRef.current?.setState(state); }, [state]);

  return <div className="lab-stage">
    <canvas ref={canvasRef} />
    {failed && <span className="lab-fallback">WebGL indisponível neste navegador</span>}
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Lab /></StrictMode>);
