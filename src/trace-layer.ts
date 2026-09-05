import { AgentCursorMotion } from "./cursor-motion";

export type TraceConfig = { cursor: boolean; border: boolean; highlight: boolean };

const STYLE = `
.border{position:fixed;inset:1px;border:2px solid #58d8cd;box-shadow:inset 0 0 22px #58d8cd22;opacity:.8;transition:opacity 220ms ease;pointer-events:none}
.border.waiting{border-color:#e4b65e;box-shadow:inset 0 0 22px #e4b65e22}
.pill{position:fixed;top:9px;left:50%;transform:translateX(-50%);background:#0d1012;color:#f1f4f4;border:1px solid #252c30;border-radius:999px;padding:6px 10px;font:11px system-ui;box-shadow:0 5px 18px #0005;display:flex;align-items:center;gap:7px;pointer-events:auto}
.pill i{width:5px;height:5px;border-radius:50%;background:#58d8cd;box-shadow:0 0 0 3px #143a36}
.pill button{pointer-events:auto;border:0;border-left:1px solid #252c30;background:none;color:#9aa4a5;padding:0 0 0 7px;cursor:pointer;font:inherit}
.cursor{position:fixed;width:17px;height:17px;border:1.5px solid #79e9df;border-radius:50%;transform:translate(-50%,-50%);transition:opacity 180ms ease;filter:drop-shadow(0 0 4px #58d8cd66);pointer-events:none}
.cursor:after{content:"";position:absolute;left:50%;top:50%;width:4px;height:4px;border-radius:50%;background:#58d8cd;transform:translate(-50%,-50%)}
.cursor.ghost{border-style:dashed;opacity:.65}
.target{position:fixed;border:2px solid #58d8cd;border-radius:5px;box-shadow:0 0 0 3px #143a3666;transition:opacity 130ms ease;pointer-events:none}
.ripple{position:fixed;width:18px;height:18px;border:1px solid #79e9df;border-radius:50%;transform:translate(-50%,-50%);animation:ripple 420ms cubic-bezier(.16,1,.3,1) forwards;pointer-events:none}
@keyframes ripple{to{opacity:0;transform:translate(-50%,-50%) scale(3.2)}}
@media(prefers-reduced-motion:reduce){.ripple{animation:none;opacity:0}}
`;

class TraceLayer {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private border: HTMLDivElement | null = null;
  private pill: HTMLDivElement | null = null;
  private cursor: HTMLDivElement | null = null;
  private readonly highlights = new Map<string, HTMLDivElement>();
  private readonly motion = new AgentCursorMotion();
  private frame = 0;
  private lastTick = 0;
  private sessionActive = false;
  private paused = false;
  private onPause: (() => void) | null = null;

  private ensure() {
    if (this.root) return this.root;
    this.host = document.createElement("div");
    this.host.setAttribute("data-vela-ui", "trace");
    this.host.style.cssText = "position:fixed;inset:0;z-index:2147483645;pointer-events:none";
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.root.append(style);
    document.documentElement.append(this.host);
    return this.root;
  }

  setPauseHandler(handler: () => void) { this.onPause = handler; }

  beginSession(config: TraceConfig, label = "Vela está controlando") {
    if (window.top !== window.self) return;
    const root = this.ensure();
    this.sessionActive = true;
    this.paused = false;
    if (config.border && !this.border) { this.border = document.createElement("div"); this.border.className = "border"; root.append(this.border); }
    if (!this.pill) {
      this.pill = document.createElement("div");
      this.pill.className = "pill";
      this.pill.innerHTML = `<i></i><span>${label}</span><button type="button">Pausar</button>`;
      this.pill.querySelector("button")?.addEventListener("click", () => this.togglePause());
      root.append(this.pill);
    }
    if (config.cursor && !this.cursor) {
      this.cursor = document.createElement("div");
      this.cursor.className = "cursor";
      this.motion.setTarget({ x: innerWidth / 2, y: innerHeight / 2 });
      root.append(this.cursor);
    }
  }

  endSession() {
    this.sessionActive = false;
    this.stopLoop();
    this.border?.remove(); this.border = null;
    this.pill?.remove(); this.pill = null;
    this.cursor?.remove(); this.cursor = null;
    for (const node of this.highlights.values()) node.remove();
    this.highlights.clear();
  }

  private togglePause() {
    this.paused = !this.paused;
    this.motion.setPaused(this.paused);
    const label = this.pill?.querySelector("span");
    if (label) label.textContent = this.paused ? "Vela pausada" : "Vela está controlando";
    const button = this.pill?.querySelector("button");
    if (button) button.textContent = this.paused ? "Retomar" : "Pausar";
    if (this.paused) this.onPause?.();
  }

  setWaiting(waiting: boolean, label = "Sua vez") {
    this.border?.classList.toggle("waiting", waiting);
    const span = this.pill?.querySelector("span");
    if (span && waiting) span.textContent = label;
  }

  begin(actionId: string, target: Element | null, config: TraceConfig, ghost = false) {
    if (!this.sessionActive || window.top !== window.self) return;
    const root = this.ensure();
    this.cursor?.classList.toggle("ghost", ghost);
    if (target) {
      const rect = target.getBoundingClientRect();
      if (config.highlight) {
        const highlight = document.createElement("div");
        highlight.className = "target";
        highlight.style.cssText += `left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px`;
        root.append(highlight);
        this.highlights.set(actionId, highlight);
      }
      this.motion.setTarget({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }
    this.startLoop();
  }

  ripple() {
    if (!this.sessionActive || !this.root || !this.cursor) return;
    this.motion.click();
    const point = this.motion.current;
    const node = document.createElement("div");
    node.className = "ripple";
    node.style.left = `${point.x}px`;
    node.style.top = `${point.y}px`;
    this.root.append(node);
    setTimeout(() => node.remove(), 500);
  }

  end(actionId: string) {
    this.highlights.get(actionId)?.remove();
    this.highlights.delete(actionId);
    if (!this.highlights.size) this.stopLoop();
  }

  private startLoop() {
    if (this.frame || !this.cursor) return;
    this.lastTick = performance.now();
    const tick = (now: number) => {
      const point = this.motion.step(now - this.lastTick, now);
      this.lastTick = now;
      if (this.cursor) {
        this.cursor.style.left = `${point.x}px`;
        this.cursor.style.top = `${point.y}px`;
        this.cursor.style.transform = `translate(-50%,-50%) scale(${1 - point.compression * 0.3})`;
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stopLoop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}

export const traceLayer = new TraceLayer();
