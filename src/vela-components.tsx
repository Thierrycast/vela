import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { AudioLines, Check, ChevronDown, Mic, Radio } from "lucide-react";
import { VelaOrbRenderer } from "./orb-renderer";
import { AmbientEdgeVisual, VISUALS } from "./voice-visuals";
import { VoiceVisual, shadersAvailable } from "./gl-visual";
import { MotionState } from "./motion-tokens";
import { VoiceVisualMetrics } from "./audio-metrics";
import { traceFrom } from "./trace-client";

const trace = traceFrom("painel");

export type VelaState = MotionState;

export function VelaOrb({ state = "idle", size = 34, metrics, visual }: { state?: VelaState; size?: number; metrics?: VoiceVisualMetrics; visual?: string }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const rendererRef = useRef<VoiceVisual | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Abaixo de 24px o shader é desperdício: nesse tamanho nada do detalhe aparece.
    const entry = size >= 24 ? VISUALS.find((item) => item.id === visual) : undefined;

    const build = () => {
      const canvas = document.createElement("canvas");
      host.replaceChildren(canvas);
      return canvas;
    };

    let renderer: VoiceVisual | null = null;
    let canvas = build();
    if (entry && (!entry.webgl || shadersAvailable())) {
      const candidate = entry.create(canvas, { reducedMotion: reduced });
      if (!("ok" in candidate) || (candidate as { ok: boolean }).ok) renderer = candidate;
      else {
        // O shader não compilou e o canvas ficou preso ao contexto WebGL: o de reserva precisa
        // de um elemento novo, senão getContext("2d") devolve null e lança.
        candidate.destroy();
        canvas = build();
      }
    }
    const reserva = !renderer;
    if (!renderer) renderer = new VelaOrbRenderer(canvas, { reducedMotion: reduced });
    // Qual renderer realmente subiu. Sem isto, "o orb não reage" é indistinguível de "o shader
    // não compilou e caiu na reserva 2D", que se parecem na tela e têm causas opostas.
    trace("ui", "orb montado", { data: { visual: visual ?? "(nenhum)", size, reserva, webgl: entry?.webgl ?? false, shaders: shadersAvailable() } });

    const active = renderer;
    active.start();
    rendererRef.current = active;
    active.setState(state);
    const observer = new ResizeObserver(() => active.resize()); observer.observe(canvas);
    const visibility = new IntersectionObserver(([item]) => active.setVisible(item.isIntersecting)); visibility.observe(canvas);
    return () => { observer.disconnect(); visibility.disconnect(); active.destroy(); rendererRef.current = null; host.replaceChildren(); };
    // `state` entra só na montagem; mudanças dele são aplicadas pelo efeito seguinte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visual, size]);
  useEffect(() => { rendererRef.current?.setState(state); }, [state]);
  useEffect(() => { if (metrics) rendererRef.current?.setMetrics(metrics); }, [metrics]);
  return <span ref={hostRef} className={`vela-orb-canvas state-${state}`} style={{ width: size, height: size }} aria-label={`Vela: ${state}`} role="img" />;
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

export function ActivityTimeline({ items, open, onToggle }: { items: Array<{ text: string; kind: string }>; open: boolean; onToggle: () => void }) {
  if (!items.length) return null;
  return <section className="activity-panel">
    <button className="activity-header" onClick={onToggle} aria-expanded={open}>
      <span><Radio size={14} /> Atividade do agente</span>
      <span className="activity-count">{items.length} eventos <ChevronDown size={14} /></span>
    </button>
    {open && <div className="activity-list">{items.map((item, index) => <div className={`activity-item ${item.kind}`} key={`${index}-${item.text.slice(0, 24)}`}><span className="activity-marker" />{item.text}</div>)}</div>}
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
  return <button className={`voice-button ${active ? "active" : ""}`} onClick={onClick} disabled={disabled} aria-label={active ? "Parar ditado" : "Ditado por voz"} title={disabled ? "Configure o servidor de voz em Configurações → Voz" : "Ditado por voz"}><Mic size={16} /></button>;
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
