import { BrowserAction } from "./types";
import { Target, performAction, resolveTarget } from "./page-actions";
import { epoch, resolveRef } from "./element-registry";
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

  chrome.runtime.onMessage.addListener((message: { type: string; action?: BrowserAction; actionId?: string; trace?: TraceConfig; ghost?: boolean; state?: string; motion?: string; sessionTitle?: string; metrics?: VoiceVisualMetrics; text?: string; id?: string; summary?: string; detail?: string; reason?: string; expected?: string; visual?: string; shader?: string; milliseconds?: number }, _sender, sendResponse) => {
    // O epoch identifica este documento. O background compara com o que gravou junto de cada ref:
    // se mudou, o content script recarregou e os refs daquela leitura morreram com ele.
    if (message.type === "agent:ping") { sendResponse({ ok: true, epoch: epoch() }); return false; }

    if (message.type === "trace:session") {
      if (message.state === "start") traceLayer.beginSession(message.trace ?? { cursor: true, border: true, highlight: true }, message.sessionTitle);
      else traceLayer.endSession();
      return false;
    }

    /*
     * Toda ação responde, inclusive quando quebra.
     *
     * Este listener devolve `true` para prometer uma resposta assíncrona; se a promessa rejeitar,
     * o canal fecha sem resposta e quem pediu recebe "the message channel closed before a response
     * was received" — uma mensagem que não diz nada sobre o que de fato falhou, e que o modelo lê
     * como "a página não respondeu". O erro real vale muito mais que o silêncio.
     */
    if (message.type === "agent:action" && message.action) {
      void runTracedAction(message.action, message.actionId ?? crypto.randomUUID(), message.trace ?? { cursor: true, border: true, highlight: true }, message.ghost ?? false)
        .catch((error: unknown) => ({ ok: false, code: "unsupported", summary: `A ação ${message.action?.type} quebrou dentro da página: ${error instanceof Error ? error.message : String(error)}` }))
        .then(sendResponse);
      return true;
    }

    /*
     * O rótulo do cartão de aprovação. `status` viaja junto porque um ref que virou outro elemento
     * não pode ser mostrado com o nome antigo: a pessoa aprovaria uma coisa e a Vela faria outra.
     */
    if (message.type === "agent:describe" && message.action) {
      const action = message.action as { ref?: string; selector?: string };
      const resolution = action.ref ? resolveRef(action.ref) : null;
      const element = resolution ? (resolution.status === "ok" ? resolution.element : null) : action.selector ? document.querySelector(action.selector) : null;
      const label = element ? (element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
      sendResponse({ label, status: resolution?.status ?? "ok" });
      return false;
    }

    /*
     * O modo preciso dispara o clique pelo CDP, que fala em coordenadas de viewport — o ref só
     * existe aqui dentro. Esta mensagem traduz um no outro, e de quebra rola o elemento para a
     * tela: coordenada de algo fora do viewport aponta para o lugar errado.
     */
    if (message.type === "agent:locate" && message.action) {
      const action = message.action as { ref?: string; selector?: string };
      // A conferência de assinatura é obrigatória aqui: esta resposta vira uma coordenada de tela
      // e um clique confiável do CDP. Errar o elemento aqui é clicar de verdade no lugar errado.
      const resolved = resolveTarget(action);
      const element = resolved.element;
      if (!(element instanceof Element)) { sendResponse(null); return false; }
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0;
      sendResponse(visible ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null);
      return false;
    }

    /* O valor atual de um campo. A escalada da digitação se confere lendo o campo: uma página
     * pode aceitar o texto sem mexer em mais nada, e aí `agent:watch` diria que nada aconteceu. */
    if (message.type === "agent:value" && message.action) {
      const action = message.action as { ref?: string; selector?: string };
      const element = resolveTarget(action).element;
      const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
        ? element.value
        : element instanceof HTMLElement && element.isContentEditable ? (element.textContent ?? "")
        : null;
      sendResponse({ value });
      return false;
    }

    /* Observa por um tempo e diz se a página reagiu — é assim que a escalada sabe se valeu. */
    if (message.type === "agent:watch") {
      const before = location.href;
      let mutated = false;
      const observer = new MutationObserver(() => { mutated = true; });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      setTimeout(() => {
        observer.disconnect();
        sendResponse({ mutated, navigated: location.href !== before });
      }, Math.min(Math.max(Number(message.milliseconds) || 500, 100), 3000));
      return true;
    }

    if (message.type === "agent:get-selection") { sendResponse({ text: (window.getSelection()?.toString() ?? "").trim().slice(0, 4000) }); return false; }

    if (isTopFrame && message.type.startsWith("pulse:")) {
      const panel = ensurePulse();
      if (message.type === "pulse:hide") panel.hide();
      if (message.type === "pulse:show") { if (message.visual) panel.setVisual(message.visual, message.shader); panel.show(); panel.setState("listening", message.state ?? "Ouvindo"); }
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

/** `keyPress` sem ref é legítimo — vai para o elemento em foco. Só se resolve o que foi endereçado. */
const addressed = (action: BrowserAction) => ("ref" in action && !!action.ref) || ("selector" in action && !!action.selector);

async function runTracedAction(action: BrowserAction, actionId: string, trace: TraceConfig, ghost: boolean) {
  /*
   * O alvo é resolvido **uma vez** e reaproveitado pela ação.
   *
   * Antes eram duas resoluções separadas — uma aqui, para o cursor mirar, outra dentro de
   * `performAction` — com um `scrollIntoView` e um quadro de animação entre elas. Numa lista
   * virtualizada isso basta para a linha ser reciclada no intervalo, e aí o cursor mira um item
   * e a ação acerta outro.
   */
  const resolved: Target | undefined = addressed(action) ? resolveTarget(action as { ref?: string; selector?: string }) : undefined;
  if (resolved?.error) return resolved.error;
  const target = resolved?.element ?? null;

  // Rola antes de mirar: senão o cursor persegue a posição que o elemento tinha.
  /*
   * Esperar um quadro só faz sentido numa aba visível.
   *
   * Aba em segundo plano não desenha, e `requestAnimationFrame` nela simplesmente não dispara até a
   * aba voltar à frente. Agir numa aba pelo `tabId` — o que o lote multi-aba faz o tempo todo —
   * parava aqui até estourar o limite da ação e voltava "a página não respondeu", numa página que
   * estava perfeitamente pronta. O teto curto garante que ninguém fique preso esperando pintura.
   */
  if (target) {
    target.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    if (document.visibilityState === "visible") await Promise.race([new Promise((resolve) => requestAnimationFrame(resolve)), new Promise((resolve) => setTimeout(resolve, 50))]);
  }

  // A viagem do cursor é o caminho da ação, não um enfeite paralelo.
  await traceLayer.begin(actionId, target, trace, ghost);
  if (action.type === "click") traceLayer.ripple();

  try {
    if (ghost) { await new Promise((resolve) => setTimeout(resolve, 350)); return { ok: false, code: "denied", summary: "Modo Observar: a ação foi mostrada mas não executada." }; }
    // O epoch acompanha toda resposta: é por ele que o background sabe se os refs que acabou de
    // receber vieram do mesmo documento em que ele os registrou.
    const result = await performAction(action, resolved);
    return { ...result, epoch: epoch() };
  } finally {
    setTimeout(() => traceLayer.end(actionId), action.type === "click" ? 400 : 200);
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
  // Clique fora fecha o menu do Lens; o próprio host é blindado por composedPath.
  document.addEventListener("pointerdown", (event) => {
    if (!host) return;
    if (event.composedPath().includes(host)) return;
    close();
  }, true);
}
