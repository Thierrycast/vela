import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { AudioLines, Check, ChevronDown, Mic, Radio } from "lucide-react";
import { VelaOrbRenderer } from "./orb-renderer";
import { AmbientEdgeVisual, VISUALS } from "./voice-visuals";
import { VoiceVisual, shadersAvailable } from "./gl-visual";
import { MotionState } from "./motion-tokens";
import { VoiceVisualMetrics } from "./audio-metrics";

export type VelaState = MotionState;

export function VelaOrb({ state = "idle", size = 34, metrics, visual }: { state?: VelaState; size?: number; metrics?: VoiceVisualMetrics; visual?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<VoiceVisual | null>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Abaixo de 24px o shader é desperdício: nesse tamanho nada do detalhe aparece.
    const entry = size >= 24 ? VISUALS.find((item) => item.id === visual) : undefined;
    // Sonda num canvas descartável: pedir "webgl" aqui e falhar deixaria este canvas incapaz de
    // receber o contexto 2D do renderer de reserva.
    const wanted = entry && (!entry.webgl || shadersAvailable()) ? entry : undefined;
    const candidate = wanted?.create(canvasRef.current, { reducedMotion: reduced });
    const usable = candidate && (!("ok" in candidate) || (candidate as { ok: boolean }).ok);
    if (candidate && !usable) candidate.destroy();
    const renderer = usable ? candidate : new VelaOrbRenderer(canvasRef.current, { reducedMotion: reduced });
    renderer.start(); rendererRef.current = renderer;
    const observer = new ResizeObserver(() => renderer.resize()); observer.observe(canvasRef.current);
    const visibility = new IntersectionObserver(([entry]) => renderer.setVisible(entry.isIntersecting)); visibility.observe(canvasRef.current);
    return () => { observer.disconnect(); visibility.disconnect(); renderer.destroy(); rendererRef.current = null; };
  }, [visual, size]);
  useEffect(() => { rendererRef.current?.setState(state); }, [state]);
  useEffect(() => { if (metrics) rendererRef.current?.setMetrics(metrics); }, [metrics]);
  return <canvas ref={canvasRef} className={`vela-orb-canvas state-${state}`} style={{ width: size, height: size }} aria-label={`Vela: ${state}`} role="img" />;
}

const STATE_LABEL: Partial<Record<VelaState, string>> = {
  idle: "Ocioso", listening: "Ouvindo", thinking: "Pensando", speaking: "Falando",
  acting: "Agindo", waiting: "Sua vez", paused: "Pausado", error: "Erro", complete: "Pronto",
};

export function AgentStatus({ state }: { state: VelaState }) {
  return <span className={`agent-status state-${state}`}><span className="status-dot" />{STATE_LABEL[state] ?? "Vela"}</span>;
}

export function ContextChip({ children, onRemove, tone = "default", title }: { children: ReactNode; onRemove?: () => void; tone?: "default" | "active"; title?: string }) {
  return <span className={`context-chip ${tone}`} title={title}>{children}{onRemove && <button onClick={onRemove} aria-label="Remover contexto">×</button>}</span>;
}

export function ActivityTimeline({ items, open, onToggle }: { items: string[]; open: boolean; onToggle: () => void }) {
  if (!items.length) return null;
  return <section className="activity-panel">
    <button className="activity-header" onClick={onToggle} aria-expanded={open}>
      <span><Radio size={14} /> Atividade do agente</span>
      <span className="activity-count">{items.length} eventos <ChevronDown size={14} /></span>
    </button>
    {open && <div className="activity-list">{items.map((item, index) => <div className="activity-item" key={`${index}-${item.slice(0, 24)}`}><span className="activity-marker" />{item}</div>)}</div>}
  </section>;
}

export function DeveloperDetails({ provider, model, telemetry }: { provider?: string; model?: string; telemetry: string[] }) {
  return <details className="developer-details"><summary>Detalhes de desenvolvimento</summary><div>
    <span>provider <b>{provider || "—"}</b></span>
    <span>modelo <b>{model || "—"}</b></span>
    {telemetry.map((line, index) => <span key={`${index}-${line}`}>{line}</span>)}
  </div></details>;
}

export function DictationButton({ active = false, onClick, disabled = false }: { active?: boolean; onClick?: () => void; disabled?: boolean }) {
  return <button className={`voice-button ${active ? "active" : ""}`} onClick={onClick} disabled={disabled} aria-label={active ? "Parar ditado" : "Ditado por voz"} title={disabled ? "Configure o provider para usar voz" : "Ditado por voz"}><Mic size={16} /></button>;
}

export function LiveVoiceButton({ active = false, onClick, disabled = false }: { active?: boolean; onClick?: () => void; disabled?: boolean }) {
  return <button className={`live-button ${active ? "active" : ""}`} onClick={onClick} disabled={disabled} aria-label={active ? "Parar Live Voice" : "Iniciar Live Voice"} title="Live Voice"><AudioLines size={16} /> <span>Live</span></button>;
}

export function ApprovalCard({ summary, detail, onDecide }: { summary: string; detail: string; onDecide: (decision: "allow" | "deny" | "allow-session") => void }) {
  return <div className="approval-card">
    <div className="approval-head"><span className="approval-mark"><Check size={12} /></span><div><strong>{summary}</strong><p>{detail}</p></div></div>
    <div className="approval-actions">
      <button className="ghost" onClick={() => onDecide("deny")}>Recusar</button>
      <button className="ghost" onClick={() => onDecide("allow-session")}>Sempre nesta tarefa</button>
      <button className="primary" onClick={() => onDecide("allow")}>Aprovar</button>
    </div>
  </div>;
}

export function TakeoverCard({ reason, expected, onResume }: { reason: string; expected: string; onResume: () => void }) {
  return <div className="takeover-card">
    <div><span className="takeover-mark">!</span><div><strong>Sua vez</strong><p>{reason}</p><p>{expected}</p></div></div>
    <button onClick={onResume}>Retomar</button>
  </div>;
}

/**
 * A moldura do painel acende conforme o agente trabalha. É a mesma camada do 01 do laboratório,
 * usada aqui em regime baixo: só existe quando há algo acontecendo, e some no ocioso — uma
 * barra lateral fica aberta o dia inteiro, e luz constante viraria ruído.
 */
export function AmbientEdge({ state, metrics }: { state: VelaState; metrics?: VoiceVisualMetrics }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visualRef = useRef<AmbientEdgeVisual | null>(null);
  const awake = state !== "idle";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--signal").trim() || undefined;
    const visual = new AmbientEdgeVisual(canvas, { signal: accent, reducedMotion: reduced });
    visualRef.current = visual;
    const observer = new ResizeObserver(() => visual.resize());
    observer.observe(canvas);
    return () => { observer.disconnect(); visual.destroy(); visualRef.current = null; };
  }, []);

  useEffect(() => { visualRef.current?.setState(state); }, [state]);
  useEffect(() => { if (metrics) visualRef.current?.setMetrics(metrics); }, [metrics]);
  useEffect(() => {
    const visual = visualRef.current;
    if (!visual) return;
    visual.setVisible(awake);
    if (awake) visual.start(); else visual.stop();
  }, [awake]);

  return <canvas ref={canvasRef} className={`ambient-edge ${awake ? "awake" : ""}`} aria-hidden="true" />;
}
