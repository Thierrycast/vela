import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { ShaderVisual, shadersAvailable } from "./gl-visual";
import { MotionState } from "./motion-tokens";
import { VoiceVisualMetrics } from "./audio-metrics";
import { CUSTOM_STARTER } from "./voice-visuals";

const CICLO: MotionState[] = ["listening", "speaking", "thinking", "acting"];
/** Tempo sem digitar antes de recompilar. Recompilar a cada tecla mostra erro de linha incompleta. */
const PAUSA = 500;

type Estado = { ok: boolean; erro: string };

/**
 * Os cinco visuais de fábrica são classes: trocar de estética é trocar a classe, e isso serve
 * para quem compila o projeto. Para quem só usa, "plugável" tinha que significar escrever o
 * shader e ver acontecer — daí este editor.
 *
 * O que faz a diferença entre isso e um campo de texto é o retorno: o prévia roda o mesmo
 * `ShaderVisual` do produto, com o mesmo prelúdio e os mesmos uniforms, e o erro do compilador
 * aparece com o número de linha já descontado do prelúdio. Sem isso, um shader errado só cai
 * calado para o visual de reserva e não há como descobrir o porquê.
 */
export function ShaderEditor({ value, onChange }: { value: string; onChange: (source: string) => void }) {
  const [draft, setDraft] = useState(value || CUSTOM_STARTER);
  const [applied, setApplied] = useState(value || CUSTOM_STARTER);
  const [estado, setEstado] = useState<Estado>({ ok: true, erro: "" });
  const hostRef = useRef<HTMLDivElement>(null);

  // A pausa evita compilar `void main() {` sozinho e acusar erro de chave não fechada a cada tecla.
  useEffect(() => {
    const relogio = setTimeout(() => setApplied(draft), PAUSA);
    return () => clearTimeout(relogio);
  }, [draft]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !shadersAvailable()) return;

    const canvas = document.createElement("canvas");
    host.replaceChildren(canvas);
    const visual = new ShaderVisual(canvas, applied, { reducedMotion: false });
    setEstado({ ok: visual.ok, erro: visual.failure });
    if (!visual.ok) { visual.destroy(); host.replaceChildren(); return; }

    visual.start();
    const observer = new ResizeObserver(() => visual.resize());
    observer.observe(canvas);

    // Sinal sintético: sem microfone aberto nesta página, nada se moveria e o shader pareceria morto.
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

    return () => { cancelAnimationFrame(raf); window.clearInterval(relogio); observer.disconnect(); visual.destroy(); host.replaceChildren(); };
  }, [applied]);

  // Só grava o que compila: um shader quebrado salvo nas preferências derrubaria o visual no
  // painel e na janelinha, longe daqui, onde não há nem editor nem mensagem de erro.
  useEffect(() => { if (estado.ok && applied !== value) onChange(applied); }, [estado.ok, applied, value, onChange]);

  const restaurar = () => { setDraft(CUSTOM_STARTER); setApplied(CUSTOM_STARTER); };

  return <div className="shader-editor">
    <div className="shader-preview" ref={hostRef} />
    <div className="shader-code">
      <textarea
        className="mono"
        spellCheck={false}
        rows={16}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        aria-label="Fragment shader do visual"
      />
      <div className="shader-status">
        {estado.ok
          ? <span className="probe-ok">Compilou. O visual já está valendo no painel e na janelinha.</span>
          : <pre className="probe-off">{estado.erro || "O shader não compilou."}</pre>}
        <button className="secondary-button" type="button" onClick={restaurar}><RotateCcw size={14} /> Restaurar o exemplo</button>
      </div>
    </div>
    <p className="shader-help">
      O prelúdio já entra por cima do seu código: <code>uEnergy</code>, <code>uBass</code>, <code>uMid</code> e
      {" "}<code>uHigh</code> são o som; <code>uMood</code> e <code>uPace</code> vêm do estado (ouvindo, falando,
      pensando, agindo); <code>uSignal</code> e <code>uAccent</code> são as cores da marca; <code>uResolution</code>,
      {" "}<code>uTime</code> e <code>uAlpha</code> fecham o básico. <code>hash</code>, <code>noise</code> e
      {" "}<code>fbm</code> estão prontos. Escreva só o <code>void main()</code> e termine em <code>gl_FragColor</code>.
    </p>
  </div>;
}
