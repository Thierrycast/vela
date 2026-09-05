import { VelaOrbRenderer } from "./orb-renderer";
import { VoiceVisualMetrics } from "./audio-metrics";
import { MotionState } from "./motion-tokens";

const POSITION_KEY = "vela:pulse-position";

const STYLE = `
:host{all:initial}
.panel{position:fixed;left:0;top:0;width:312px;background:#0d1012;color:#f1f4f4;border:1px solid #252c30;border-radius:15px;box-shadow:0 16px 50px #0008;padding:10px;font:13px/1.45 system-ui,sans-serif;pointer-events:auto;letter-spacing:normal;text-align:left;direction:ltr}
.head{display:flex;align-items:center;justify-content:space-between;color:#9aa4a5;font-size:11px;cursor:grab;user-select:none}
.head.dragging{cursor:grabbing}
.head b{font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:10px}
.head .controls{display:flex;gap:2px}
button{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;border-radius:6px;padding:3px 6px}
button:hover{background:#1b2125;color:#f1f4f4}
.body{display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 8px 12px}
.state{font-size:12px;color:#9aa4a5}
.transcript{margin:0;font-size:11px;color:#687274;text-align:center;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:0}
.actions{display:flex;justify-content:center;gap:8px;border-top:1px solid #252c30;padding-top:9px}
.actions button{color:#9aa4a5;font-size:12px}
.actions button.on{color:#58d8cd}
.card{border-top:1px solid #252c30;margin-top:9px;padding-top:9px}
.card strong{display:block;font-size:12px}
.card p{margin:3px 0 0;font-size:11px;color:#9aa4a5}
.card .row{display:flex;gap:6px;justify-content:flex-end;margin-top:9px}
.card .row button{border:1px solid #252c30;font-size:11px}
.card .row .primary{background:#58d8cd;border-color:#58d8cd;color:#062220;font-weight:600}
.waiting strong{color:#e4b65e}
.mini{width:auto;padding:6px 12px;border-radius:999px;display:flex;align-items:center;gap:9px}
.mini .body,.mini .actions,.mini .card,.mini .head b,.mini .transcript{display:none}
.mini .mini-row{display:flex;align-items:center;gap:9px}
.mini-row{display:none}
`;

type PulseHandlers = { onStop: () => void; onMute: () => void; onApprove: (id: string, decision: string) => void; onResume: () => void };

export class PulsePanel {
  private readonly root: ShadowRoot;
  private readonly panel: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: VelaOrbRenderer;
  private readonly stateLabel: HTMLSpanElement;
  private readonly transcript: HTMLParagraphElement;
  private readonly cardSlot: HTMLDivElement;
  private readonly miniLabel: HTMLSpanElement;
  private position = { x: 0, y: 0 };
  private minimized = false;

  constructor(private readonly handlers: PulseHandlers) {
    const host = document.createElement("div");
    host.setAttribute("data-vela-ui", "pulse");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483644;pointer-events:none";
    this.root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;

    this.panel = document.createElement("div");
    this.panel.className = "panel";
    this.panel.hidden = true;
    this.panel.innerHTML = `
      <div class="head"><b>Pulse</b><span class="mini-row"><span class="mini-state"></span></span><span class="controls"><button class="min" aria-label="Minimizar">—</button><button class="close" aria-label="Fechar">×</button></span></div>
      <div class="body"><canvas class="orb" width="64" height="64" style="width:64px;height:64px"></canvas><span class="state">Live Voice</span><p class="transcript"></p></div>
      <div class="actions"><button class="mute">Microfone</button><button class="stop">Encerrar</button></div>
      <div class="cards"></div>`;

    this.root.append(style, this.panel);
    document.documentElement.append(host);

    this.canvas = this.panel.querySelector(".orb") as HTMLCanvasElement;
    this.stateLabel = this.panel.querySelector(".state") as HTMLSpanElement;
    this.transcript = this.panel.querySelector(".transcript") as HTMLParagraphElement;
    this.cardSlot = this.panel.querySelector(".cards") as HTMLDivElement;
    this.miniLabel = this.panel.querySelector(".mini-state") as HTMLSpanElement;
    this.renderer = new VelaOrbRenderer(this.canvas, { reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches });
    this.renderer.start();

    this.panel.querySelector(".close")?.addEventListener("click", () => { this.hide(); handlers.onStop(); });
    this.panel.querySelector(".stop")?.addEventListener("click", () => { this.hide(); handlers.onStop(); });
    this.panel.querySelector(".min")?.addEventListener("click", () => this.toggleMinimize());
    const mute = this.panel.querySelector(".mute") as HTMLButtonElement;
    mute.addEventListener("click", () => { mute.classList.toggle("on"); handlers.onMute(); });

    this.installDrag();
    void this.restorePosition();
  }

  private async restorePosition() {
    try {
      const stored = await chrome.storage.local.get(POSITION_KEY);
      const saved = stored[POSITION_KEY] as { x: number; y: number } | undefined;
      this.position = saved ?? { x: innerWidth - 340, y: innerHeight - 260 };
    } catch { this.position = { x: innerWidth - 340, y: innerHeight - 260 }; }
    this.applyPosition();
  }

  private applyPosition() {
    const width = this.minimized ? 190 : 312;
    this.position.x = Math.min(Math.max(8, this.position.x), Math.max(8, innerWidth - width - 8));
    this.position.y = Math.min(Math.max(8, this.position.y), Math.max(8, innerHeight - 80));
    this.panel.style.transform = `translate3d(${Math.round(this.position.x)}px, ${Math.round(this.position.y)}px, 0)`;
  }

  private installDrag() {
    const head = this.panel.querySelector(".head") as HTMLElement;
    let origin = { x: 0, y: 0, px: 0, py: 0 };
    let dragging = false;
    head.addEventListener("pointerdown", (event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      dragging = true;
      head.classList.add("dragging");
      head.setPointerCapture(event.pointerId);
      origin = { x: event.clientX, y: event.clientY, px: this.position.x, py: this.position.y };
    });
    head.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      this.position = { x: origin.px + (event.clientX - origin.x), y: origin.py + (event.clientY - origin.y) };
      this.applyPosition();
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      head.classList.remove("dragging");
      try { void chrome.storage.local.set({ [POSITION_KEY]: this.position }); } catch { /* contexto invalidado */ }
    };
    head.addEventListener("pointerup", stop);
    head.addEventListener("pointercancel", stop);
    addEventListener("resize", () => this.applyPosition());
  }

  private toggleMinimize() {
    this.minimized = !this.minimized;
    this.panel.classList.toggle("mini", this.minimized);
    (this.panel.querySelector(".mini-row") as HTMLElement).style.display = this.minimized ? "flex" : "none";
    this.applyPosition();
  }

  show() { this.panel.hidden = false; this.renderer.resize(); }
  hide() { this.panel.hidden = true; this.clearCards(); }

  setState(state: MotionState, label: string) {
    this.renderer.setState(state);
    this.stateLabel.textContent = label;
    this.miniLabel.textContent = label;
    this.panel.classList.toggle("waiting", state === "waiting");
  }

  setMetrics(metrics: VoiceVisualMetrics) { this.renderer.setMetrics(metrics); }
  setTranscript(text: string) { this.transcript.textContent = text; }
  private clearCards() { this.cardSlot.replaceChildren(); }

  showApproval(id: string, summary: string, detail: string) {
    this.clearCards();
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<strong></strong><p></p><div class="row"><button class="deny">Recusar</button><button class="primary allow">Aprovar</button></div>`;
    (card.querySelector("strong") as HTMLElement).textContent = summary;
    (card.querySelector("p") as HTMLElement).textContent = detail;
    card.querySelector(".deny")?.addEventListener("click", () => { this.clearCards(); this.handlers.onApprove(id, "deny"); });
    card.querySelector(".allow")?.addEventListener("click", () => { this.clearCards(); this.handlers.onApprove(id, "allow"); });
    this.cardSlot.append(card);
    this.show();
    if (this.minimized) this.toggleMinimize();
  }

  showTakeover(reason: string, expected: string) {
    this.clearCards();
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<strong>Sua vez</strong><p class="reason"></p><p class="expected"></p><div class="row"><button class="primary resume">Retomar</button></div>`;
    (card.querySelector(".reason") as HTMLElement).textContent = reason;
    (card.querySelector(".expected") as HTMLElement).textContent = expected;
    card.querySelector(".resume")?.addEventListener("click", () => { this.clearCards(); this.handlers.onResume(); });
    this.cardSlot.append(card);
    this.show();
    if (this.minimized) this.toggleMinimize();
  }

  closeCards() { this.clearCards(); }
}
