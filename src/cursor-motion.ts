export type CursorPoint = { x: number; y: number };

/** Natural cursor movement with critically damped interpolation and no React updates per frame. */
export class AgentCursorMotion {
  private position: CursorPoint = { x: 0, y: 0 };
  private velocity: CursorPoint = { x: 0, y: 0 };
  private target: CursorPoint = { x: 0, y: 0 };
  private paused = false;
  private clickUntil = 0;
  private stiffness: number = 0.15; // Smooth exponential decay (LERP)
  setSpeed(speed: "natural" | "fast") { this.stiffness = speed === "fast" ? 0.35 : 0.15; }
  setTarget(target: CursorPoint) { this.target = target; }
  jumpTo(target: CursorPoint) { this.target = target; this.position = { ...target }; this.velocity = { x: 0, y: 0 }; }
  /** Distância até o alvo: quem espera a chegada precisa saber quando parar de esperar. */
  get distanceToTarget() { return Math.hypot(this.target.x - this.position.x, this.target.y - this.position.y); }
  setPaused(paused: boolean) { this.paused = paused; }
  click(now = performance.now()) { this.clickUntil = now + 180; }
  step(deltaMs: number, now = performance.now()) {
    if (this.paused) return { ...this.position, compression: 0 };
    const dt = Math.min(32, deltaMs) / 16.67; 
    // Minimalistic smooth transition (LERP) em vez de mola. Zera o overshoot ("chacoalho").
    const factor = 1 - Math.pow(1 - this.stiffness, dt);
    this.position.x += (this.target.x - this.position.x) * factor; 
    this.position.y += (this.target.y - this.position.y) * factor; 
    return { ...this.position, compression: Math.max(0, (this.clickUntil - now) / 180) };
  }
  get current() { return { ...this.position }; }
}
