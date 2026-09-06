import { AgentCursorMotion } from "./cursor-motion";

export type CursorSpeed = "natural" | "fast" | "instant";
export type TraceConfig = { cursor: boolean; border: boolean; highlight: boolean; speed?: CursorSpeed };

const ARRIVAL_TOLERANCE = 6;
const TRAVEL_DEADLINE: Record<CursorSpeed, number> = { natural: 450, fast: 220, instant: 0 };

/**
 * As cores desta camada são as mesmas de `STATE_MOOD` em gl-visual.ts: ciano é o estado
 * `acting` e âmbar é o `waiting`. A moldura acesa e o visual de voz descrevem o mesmo momento,
 * então precisam falar a mesma língua — se um mudar de tom, o outro muda junto.
 *
 * Ficam literais aqui porque este arquivo vira CSS dentro de um shadow root na página do
 * usuário, onde não há tokens nem imports para resolver.
 *
 * A moldura é uma **linha fina com luz**, não uma faixa larga: a espessura vem do halo — quatro
 * camadas de sombra da mesma cor, da mais fechada à mais aberta — enquanto o traço em si tem 1px
 * e o `sweep` que gira ocupa 2px. Uma faixa grossa tapa o conteúdo e parece moldura de foto; o
 * halo diz "sob controle" sem disputar espaço com a página.
 */
const STYLE = `
.border{position:fixed;inset:0;pointer-events:none;opacity:0;transition:opacity 380ms cubic-bezier(.2,.8,.2,1);z-index:0}
.border.on{opacity:1}
.border:before{content:"";position:absolute;inset:0;box-shadow:inset 0 0 0 1px #58d8cdd9,inset 0 0 9px #58d8cd8c,inset 0 0 26px #58d8cd47,inset 0 0 70px #58d8cd1f;animation:vela-breathe 3.8s ease-in-out infinite}
.sweep{position:absolute;inset:0;overflow:hidden;padding:2px;-webkit-mask:linear-gradient(#000,#000) content-box,linear-gradient(#000,#000);-webkit-mask-composite:xor;mask:linear-gradient(#000,#000) content-box,linear-gradient(#000,#000);mask-composite:exclude;filter:drop-shadow(0 0 5px #58d8cd) drop-shadow(0 0 14px #58d8cdaa);animation:vela-glow 3.8s ease-in-out infinite}
.sweep i{position:absolute;left:50%;top:50%;width:230vmax;height:230vmax;margin:-115vmax;background:conic-gradient(from 0deg,#58d8cdcc 0 46%,#c9fff8 62%,#58d8cdcc 78% 100%);animation:vela-sweep 9s linear infinite}
.border.waiting:before{box-shadow:inset 0 0 0 1px #e4b65ed9,inset 0 0 9px #e4b65e8c,inset 0 0 26px #e4b65e47,inset 0 0 70px #e4b65e1f}
.border.waiting .sweep{filter:drop-shadow(0 0 5px #e4b65e) drop-shadow(0 0 14px #e4b65eaa)}
.border.waiting .sweep i{background:conic-gradient(from 0deg,#e4b65ecc 0 46%,#fff0cc 62%,#e4b65ecc 78% 100%)}
@keyframes vela-breathe{0%,100%{opacity:.5}50%{opacity:1}}
@keyframes vela-glow{0%,100%{opacity:.72}50%{opacity:1}}
@keyframes vela-sweep{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.border:before,.sweep,.sweep i{animation:none}}
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
  private arrivals: Array<{ resolve: () => void; deadline: number; timer: number }> = [];
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
    if (config.border && !this.border) {
      this.border = document.createElement("div");
      this.border.className = "border";
      const sweep = document.createElement("div");
      sweep.className = "sweep";
      sweep.append(document.createElement("i"));
      this.border.append(sweep);
      root.append(this.border);
      // Um quadro para o browser aplicar o estado inicial: sem isso a transição não roda e a
      // moldura aparece estalando em vez de acender.
      requestAnimationFrame(() => this.border?.classList.add("on"));
    }
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
    this.releaseArrivals();
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

  /** Devolve a chegada do cursor: a ação espera por ela, então a animação é o agir. */
  begin(actionId: string, target: Element | null, config: TraceConfig, ghost = false): Promise<void> {
    if (!this.sessionActive || window.top !== window.self || !target) return Promise.resolve();
    const root = this.ensure();
    const speed = config.speed ?? "natural";
    this.cursor?.classList.toggle("ghost", ghost);
    this.motion.setSpeed(speed === "fast" ? "fast" : "natural");

    const rect = target.getBoundingClientRect();
    if (config.highlight) {
      const highlight = document.createElement("div");
      highlight.className = "target";
      highlight.style.cssText += `left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px`;
      root.append(highlight);
      this.highlights.set(actionId, highlight);
    }

    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    if (speed === "instant" || !config.cursor || !this.cursor) { this.motion.jumpTo(point); this.startLoop(); return Promise.resolve(); }

    this.motion.setTarget(point);
    this.startLoop();
    return new Promise<void>((resolve) => {
      const entry = { resolve: () => { clearTimeout(entry.timer); resolve(); }, deadline: performance.now() + TRAVEL_DEADLINE[speed], timer: 0 };
      // Backstop: sem isto, um loop parado deixaria a ação esperando para sempre.
      entry.timer = setTimeout(() => { this.arrivals = this.arrivals.filter((item) => item !== entry); resolve(); }, TRAVEL_DEADLINE[speed] + 60) as unknown as number;
      this.arrivals.push(entry);
    });
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
    if (!this.highlights.size && !this.arrivals.length) this.stopLoop();
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
      if (this.arrivals.length) {
        const arrived = this.motion.distanceToTarget <= ARRIVAL_TOLERANCE;
        const stillTravelling: typeof this.arrivals = [];
        for (const arrival of this.arrivals) {
          if (arrived || now >= arrival.deadline) arrival.resolve(); else stillTravelling.push(arrival);
        }
        this.arrivals = stillTravelling;
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private releaseArrivals() { const pending = this.arrivals; this.arrivals = []; for (const arrival of pending) arrival.resolve(); }

  private stopLoop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}

export const traceLayer = new TraceLayer();
