import { useEffect, useRef } from "react";
import { VISUALS, VisualId } from "./voice-visuals";
import { VoiceVisual, shadersAvailable } from "./gl-visual";
import { MotionState } from "./motion-tokens";
import { VoiceVisualMetrics } from "./audio-metrics";

const CICLO: MotionState[] = ["listening", "speaking", "thinking", "acting"];

/**
 * Escolher o visual da Vela por uma lista de nomes seria adivinhação. Cada opção mostra a si
 * mesma, animada, passeando pelos estados — é o mesmo princípio do Voice Motion Lab, reduzido ao
 * que cabe numa tela de preferências.
 */
export function VisualPicker({ value, onChange }: { value: string; onChange: (visual: VisualId) => void }) {
  return <div className="visual-picker">
    {VISUALS.filter((item) => item.id !== "ambient-edge").map((item) => (
      <button
        key={item.id}
        type="button"
        className={`visual-option ${value === item.id ? "chosen" : ""}`}
        aria-pressed={value === item.id}
        onClick={() => onChange(item.id)}
      >
        <VisualPreview id={item.id} />
        <span>
          <strong>{item.name.replace(/^\d+ · /, "")}</strong>
          <small>{item.technique}</small>
        </span>
      </button>
    ))}
  </div>;
}

/** Cada miniatura roda seu próprio loop e cicla os estados sozinha, para mostrar o caráter. */
function VisualPreview({ id }: { id: VisualId }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visualRef = useRef<VoiceVisual | null>(null);
  // O aviso de falha é alternado por ref: virar estado obrigaria a chamar setState dentro do
  // efeito, e a mensagem não participa de mais nada no render.
  const noticeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const entry = VISUALS.find((item) => item.id === id);
    if (!entry) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const show = (visible: boolean) => { if (noticeRef.current) noticeRef.current.hidden = !visible; };
    if (entry.webgl && !shadersAvailable()) { show(true); return; }
    const visual = entry.create(canvas, { reducedMotion: reduced });
    show("ok" in visual && !(visual as { ok: boolean }).ok);
    visual.start();
    visualRef.current = visual;

    const observer = new ResizeObserver(() => visual.resize());
    observer.observe(canvas);

    // Sinal sintético só para a miniatura respirar: sem microfone, nada se moveria.
    let raf = 0;
    const inicio = performance.now();
    const pulso = () => {
      const segundos = (performance.now() - inicio) / 1000;
      const onda = (Math.sin(segundos * 1.7) * 0.5 + 0.5) * (Math.sin(segundos * 0.6) * 0.5 + 0.5);
      const metrics: VoiceVisualMetrics = { energy: onda * 0.8, bass: onda * 0.6, mid: onda * 0.75, high: onda * 0.4, speaking: onda > 0.2 };
      visual.setMetrics(metrics);
      raf = requestAnimationFrame(pulso);
    };
    pulso();

    let passo = 0;
    visual.setState(CICLO[0]);
    const relogio = window.setInterval(() => { passo += 1; visual.setState(CICLO[passo % CICLO.length]); }, 2600);

    return () => { cancelAnimationFrame(raf); window.clearInterval(relogio); observer.disconnect(); visual.destroy(); visualRef.current = null; };
  }, [id]);

  return <span className="visual-stage">
    <canvas ref={canvasRef} />
    <em ref={noticeRef} hidden>sem WebGL</em>
  </span>;
}
