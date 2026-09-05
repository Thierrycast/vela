import { MotionState } from "./motion-tokens";
import { VoiceVisualMetrics, emptyVoiceMetrics } from "./audio-metrics";

type OrbOptions = { color?: string; reducedMotion?: boolean };
type OrbTarget = { energy: number; bass: number; mid: number; high: number };

const TAU = Math.PI * 2;
const clamp = (n: number, min = 0, max = 1) => Math.max(min, Math.min(max, n));
const lerp = (a: number, b: number, amount: number) => a + (b - a) * amount;

function hash(index: number) { const x = Math.sin(index * 12.9898) * 43758.5453; return x - Math.floor(x); }

/** Canvas renderer. It owns its RAF loop and never schedules React state updates per frame. */
export class VelaOrbRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly particles: Float32Array;
  private readonly options: Required<OrbOptions>;
  private readonly target: OrbTarget = { energy: 0, bass: 0, mid: 0, high: 0 };
  private current: OrbTarget = { energy: 0, bass: 0, mid: 0, high: 0 };
  private state: MotionState = "idle";
  private frame = 0;
  private raf = 0;
  private lastTime = 0;
  private visible = true;

  constructor(canvas: HTMLCanvasElement, options: OrbOptions = {}) {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Canvas 2D indisponível");
    this.canvas = canvas;
    this.context = context;
    this.options = { color: options.color ?? "#58d8cd", reducedMotion: options.reducedMotion ?? false };
    this.particles = new Float32Array(72 * 4);
    for (let i = 0; i < 72; i += 1) {
      this.particles[i * 4] = hash(i);
      this.particles[i * 4 + 1] = 0.72 + hash(i + 101) * 0.27;
      this.particles[i * 4 + 2] = hash(i + 203) * TAU;
      this.particles[i * 4 + 3] = 0.35 + hash(i + 307) * 0.65;
    }
    this.resize();
  }

  setState(state: MotionState) { this.state = state; }
  setMetrics(metrics: VoiceVisualMetrics = emptyVoiceMetrics()) {
    this.target.energy = clamp(metrics.energy); this.target.bass = clamp(metrics.bass); this.target.mid = clamp(metrics.mid); this.target.high = clamp(metrics.high);
  }
  setVisible(visible: boolean) { this.visible = visible; if (visible && !this.raf) this.start(); }
  resize() { const rect = this.canvas.getBoundingClientRect(); const ratio = Math.min(2, window.devicePixelRatio || 1); this.canvas.width = Math.max(1, Math.round(rect.width * ratio)); this.canvas.height = Math.max(1, Math.round(rect.height * ratio)); this.context.setTransform(ratio, 0, 0, ratio, 0, 0); }
  start() { if (this.raf || this.options.reducedMotion) { if (this.options.reducedMotion) this.draw(0); return; } this.lastTime = performance.now(); this.raf = requestAnimationFrame(this.render); }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
  destroy() { this.stop(); }

  private render = (time: number) => { this.raf = 0; if (!this.visible) return; const delta = Math.min(48, time - this.lastTime); this.lastTime = time; this.frame += delta / 1000; this.draw(this.frame); this.raf = requestAnimationFrame(this.render); };
  private draw(time: number) {
    const rect = this.canvas.getBoundingClientRect(); const width = rect.width; const height = rect.height; const cx = width / 2; const cy = height / 2; const radius = Math.min(width, height) * 0.35;
    const ctx = this.context; ctx.clearRect(0, 0, width, height);
    const stateMotion = this.state === "thinking" ? 0.2 : this.state === "acting" ? 0.36 : this.state === "speaking" ? 0.28 : this.state === "listening" ? 0.12 : this.state === "idle" ? 0.035 : 0.055;
    const stateEnergy = this.state === "error" ? 0.12 : this.state === "complete" ? 0.35 : 0;
    this.current.energy = lerp(this.current.energy, this.target.energy + stateEnergy, 0.08); this.current.bass = lerp(this.current.bass, this.target.bass, 0.08); this.current.mid = lerp(this.current.mid, this.target.mid, 0.08); this.current.high = lerp(this.current.high, this.target.high, 0.08);
    const breathe = Math.sin(time * (this.state === "idle" ? 1.2 : 2.4)) * (0.015 + this.current.energy * 0.035);
    const dynamicRadius = radius * (1 + breathe + this.current.bass * 0.035);
    ctx.lineWidth = 0.7; ctx.strokeStyle = this.options.color; ctx.globalAlpha = 0.32 + this.current.energy * 0.35;
    ctx.beginPath(); ctx.arc(cx, cy, dynamicRadius, -0.7 + time * stateMotion, 4.55 + time * stateMotion); ctx.stroke();
    ctx.globalAlpha = 0.78;
    for (let i = 0; i < 72; i += 1) {
      const offset = i * 4; const orbit = this.particles[offset + 1]; const angle = this.particles[offset + 2] + time * (stateMotion + this.particles[offset] * 0.018) * (this.state === "acting" ? 1 + this.particles[offset] : 1);
      const noise = Math.sin(angle * 3.1 + time * 0.7 + i) * 0.018 + Math.sin(angle * 7.3 - time * 0.4) * 0.009;
      const distance = dynamicRadius * (orbit + noise + this.current.mid * 0.025 * Math.sin(angle * 5));
      const x = cx + Math.cos(angle) * distance; const y = cy + Math.sin(angle) * distance;
      const size = 0.7 + this.current.high * this.particles[offset + 3] * 1.3; ctx.globalAlpha = 0.18 + this.particles[offset + 3] * 0.45 + this.current.high * 0.25; ctx.fillRect(x, y, size, size);
    }
    const core = 2.2 + this.current.energy * 3.5; ctx.globalAlpha = 0.85; ctx.fillStyle = this.options.color; ctx.beginPath(); ctx.arc(cx + Math.cos(time * stateMotion) * this.current.mid * 2, cy + Math.sin(time * stateMotion) * this.current.mid * 2, core, 0, TAU); ctx.fill();
    if (this.state === "complete") { ctx.globalAlpha = Math.max(0, 1 - (time % 1.1)); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, dynamicRadius * (1.05 + (time % 1.1) * 0.12), 0, TAU); ctx.stroke(); }
    if (this.state === "error") { ctx.globalAlpha = 0.4; ctx.beginPath(); ctx.moveTo(cx - dynamicRadius * .55, cy); ctx.lineTo(cx + dynamicRadius * .55, cy); ctx.stroke(); }
  }
}
