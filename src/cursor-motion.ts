import { motionTokens } from "./motion-tokens";

export type CursorPoint = { x: number; y: number };

/** Natural cursor movement with critically damped interpolation and no React updates per frame. */
export class AgentCursorMotion {
  private position: CursorPoint = { x: 0, y: 0 };
  private velocity: CursorPoint = { x: 0, y: 0 };
  private target: CursorPoint = { x: 0, y: 0 };
  private paused = false;
  private clickUntil = 0;
  private stiffness: number = motionTokens.spring.cursorStiffness;
  setSpeed(speed: "natural" | "fast") { this.stiffness = speed === "fast" ? 0.3 : motionTokens.spring.cursorStiffness; }
  setTarget(target: CursorPoint) { this.target = target; }
  jumpTo(target: CursorPoint) { this.target = target; this.position = { ...target }; this.velocity = { x: 0, y: 0 }; }
  /** Distância até o alvo: quem espera a chegada precisa saber quando parar de esperar. */
  get distanceToTarget() { return Math.hypot(this.target.x - this.position.x, this.target.y - this.position.y); }
  setPaused(paused: boolean) { this.paused = paused; }
  click(now = performance.now()) { this.clickUntil = now + 180; }
  step(deltaMs: number, now = performance.now()) {
    if (this.paused) return { ...this.position, compression: 0 };
    const dt = Math.min(32, deltaMs) / 16.67; const factor = 1 - Math.pow(1 - this.stiffness, dt);
    this.velocity.x += (this.target.x - this.position.x) * factor; this.velocity.y += (this.target.y - this.position.y) * factor; this.velocity.x *= motionTokens.spring.cursorDamping; this.velocity.y *= motionTokens.spring.cursorDamping;
    this.position.x += this.velocity.x; this.position.y += this.velocity.y;
    return { ...this.position, compression: Math.max(0, (this.clickUntil - now) / 180) };
  }
  get current() { return { ...this.position }; }
}
