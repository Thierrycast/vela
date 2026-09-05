import { BrowserAction } from "./types";
import { performAction } from "./page-actions";
import { resolveRef } from "./page-snapshot";
import { TraceConfig, traceLayer } from "./trace-layer";
import { PulsePanel } from "./pulse";
import { MotionState } from "./motion-tokens";
import { VoiceVisualMetrics } from "./audio-metrics";

type VelaWindow = Window & { __velaLoaded?: boolean };
const velaWindow = window as VelaWindow;
const isTopFrame = window.top === window.self;

if (!velaWindow.__velaLoaded) {
  velaWindow.__velaLoaded = true;
  start();
}

const send = (message: unknown) => { try { void chrome.runtime.sendMessage(message).catch(() => undefined); } catch { /* contexto da extensão invalidado */ } };

function start() {

  traceLayer.setPauseHandler(() => send({ type: "agent:pause" }));

  chrome.runtime.onMessage.addListener((message: { type: string; action?: BrowserAction; actionId?: string; trace?: TraceConfig; ghost?: boolean; state?: string; motion?: string; sessionTitle?: string; metrics?: VoiceVisualMetrics; text?: string; id?: string; summary?: string; detail?: string; reason?: string; expected?: string }, _sender, sendResponse) => {
    if (message.type === "agent:ping") { sendResponse({ ok: true }); return false; }

    if (message.type === "trace:session") {
      if (message.state === "start") traceLayer.beginSession(message.trace ?? { cursor: true, border: true, highlight: true }, message.sessionTitle);
      else traceLayer.endSession();
      return false;
    }

    if (message.type === "agent:action" && message.action) {
      void runTracedAction(message.action, message.actionId ?? crypto.randomUUID(), message.trace ?? { cursor: true, border: true, highlight: true }, message.ghost ?? false).then(sendResponse);
      return true;
    }

    if (message.type === "agent:describe" && message.action) {
      const action = message.action as { ref?: string; selector?: string };
      const element = action.ref ? resolveRef(action.ref).element : action.selector ? document.querySelector(action.selector) : null;
      const label = element ? (element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
      sendResponse({ label });
      return false;
    }

    if (message.type === "agent:get-selection") { sendResponse({ text: (window.getSelection()?.toString() ?? "").trim().slice(0, 4000) }); return false; }

    if (isTopFrame && message.type.startsWith("pulse:")) {
      const panel = ensurePulse();
      if (message.type === "pulse:hide") panel.hide();
      if (message.type === "pulse:show") { panel.show(); panel.setState("listening", message.state ?? "Ouvindo"); }
      if (message.type === "pulse:set-state") panel.setState((message.motion ?? "listening") as MotionState, message.state ?? "Vela");
      if (message.type === "pulse:metrics" && message.metrics) panel.setMetrics(message.metrics);
      if (message.type === "pulse:transcript") panel.setTranscript(message.text ?? "");
      if (message.type === "pulse:approval" && message.id) panel.showApproval(message.id, message.summary ?? "", message.detail ?? "");
      if (message.type === "pulse:takeover") panel.showTakeover(message.reason ?? "", message.expected ?? "");
      if (message.type === "pulse:cards-close") panel.closeCards();
      return false;
    }

    return false;
  });

  if (isTopFrame) installLens();
}

async function runTracedAction(action: BrowserAction, actionId: string, trace: TraceConfig, ghost: boolean) {
  const target = "ref" in action && action.ref ? resolveRef(action.ref).element : "selector" in action && action.selector ? document.querySelector(action.selector) : null;
  traceLayer.begin(actionId, target, trace, ghost);
  if (action.type === "click") setTimeout(() => traceLayer.ripple(), 320);
  try {
    if (ghost) { await new Promise((resolve) => setTimeout(resolve, 650)); return { ok: false, code: "denied", summary: "Modo Observar: a ação foi mostrada mas não executada." }; }
    return await performAction(action);
  } finally {
    setTimeout(() => traceLayer.end(actionId), action.type === "click" ? 500 : 220);
  }
}

let pulse: PulsePanel | null = null;

function ensurePulse() {
  if (!pulse) {
    pulse = new PulsePanel({
      onStop: () => send({ type: "voice:stop-live" }),
      onMute: () => send({ type: "voice:toggle-mute" }),
      onApprove: (id, decision) => send({ type: "pulse:approval-resolve", id, decision }),
      onResume: () => send({ type: "pulse:takeover-resume" }),
    });
  }
  return pulse;
}

const LENS_ACTIONS: Array<{ intent: string; label: string }> = [
  { intent: "ask", label: "Perguntar" },
  { intent: "explain", label: "Explicar" },
  { intent: "summarize", label: "Resumir" },
  { intent: "context", label: "Usar como contexto" },
];

function installLens() {
  let host: HTMLDivElement | null = null;
  let root: ShadowRoot | null = null;

  const close = () => { host?.remove(); host = null; root = null; };

  const open = (rect: DOMRect, text: string) => {
    close();
    host = document.createElement("div");
    host.setAttribute("data-vela-ui", "lens");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `.mark{position:fixed;display:flex;align-items:center;gap:6px;background:#0d1012;color:#58d8cd;border:1px solid #252c30;border-radius:8px;padding:4px 7px;font:11px system-ui;box-shadow:0 5px 18px #0005;pointer-events:auto;cursor:pointer}.mark .dot{width:9px;height:9px;border:1.5px solid #58d8cd;border-radius:50%;border-left-color:transparent}.menu{position:fixed;display:none;flex-direction:column;background:#0d1012;border:1px solid #252c30;border-radius:9px;padding:4px;box-shadow:0 12px 32px #0007;pointer-events:auto;min-width:150px}.menu.open{display:flex}.menu button{border:0;background:transparent;color:#f1f4f4;text-align:left;padding:7px 9px;border-radius:6px;font:12px system-ui;cursor:pointer}.menu button:hover{background:#1b2125;color:#58d8cd}`;
    root.append(style);

    const top = rect.bottom + 44 > innerHeight ? rect.top - 32 : rect.bottom + 7;
    const left = Math.min(innerWidth - 120, Math.max(8, rect.left));

    const mark = document.createElement("button");
    mark.className = "mark";
    mark.innerHTML = `<span class="dot"></span>Vela`;
    mark.style.cssText += `left:${left}px;top:${top}px`;

    const menu = document.createElement("div");
    menu.className = "menu";
    menu.style.cssText += `left:${left}px;top:${top + 28}px`;
    for (const item of LENS_ACTIONS) {
      const button = document.createElement("button");
      button.textContent = item.label;
      button.addEventListener("click", () => {
        try { void chrome.runtime.sendMessage({ type: "lens:action", intent: item.intent, text: text.slice(0, 5000), url: location.href, title: document.title }).catch(() => undefined); } catch { /* contexto invalidado */ }
        close();
      });
      menu.append(button);
    }
    mark.addEventListener("click", () => menu.classList.toggle("open"));
    root.append(mark, menu);
    document.documentElement.append(host);
  };

  let timer = 0;
  document.addEventListener("mouseup", (event) => {
    if (host?.contains(event.target as Node)) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? "";
      if (text.length < 2 || !selection?.rangeCount) { close(); return; }
      const rects = selection.getRangeAt(0).getClientRects();
      const rect = rects.length ? rects[rects.length - 1] : selection.getRangeAt(0).getBoundingClientRect();
      open(rect, text);
    }, 180);
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  document.addEventListener("scroll", close, { passive: true });
}
