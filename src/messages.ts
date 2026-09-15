import { AgentEvent, ChatMessage } from "./types";
import type { ApprovalDecision, ApprovalRequest } from "./approvals";

export const SIDECAR_PORT = "vela:sidecar";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "paused" | "error";

export type LoopSnapshot = { messages: ChatMessage[]; events: AgentEvent[]; telemetry: string[]; running: boolean };

export type SidecarInbound =
  | ({ type: "chat:snapshot" } & LoopSnapshot)
  | { type: "chat:message"; message: ChatMessage }
  | { type: "chat:delta"; id: string; text: string }
  | { type: "chat:patch"; id: string; patch: Partial<ChatMessage> }
  | { type: "chat:reset" }
  | { type: "chat:event"; event: AgentEvent }
  | { type: "chat:telemetry"; text: string }
  | { type: "chat:running"; running: boolean }
  | { type: "voice:state"; state: VoiceState }
  | { type: "voice:error"; message: string }
  | { type: "voice:transcript"; text: string }
  /** Rascunho do que está sendo falado agora. Nunca vira turno; some quando o final chega. */
  | { type: "voice:partial"; text: string }
  | { type: "chat:prefill"; text: string }
  | { type: "chat:attachments"; items: string[] }
  | { type: "chat:approval"; request: ApprovalRequest }
  | { type: "chat:approval-closed"; id: string }
  | { type: "chat:takeover"; reason: string; expected: string }
  | { type: "chat:takeover-closed" }
  | { type: "chat:session"; title: string; tabCount: number }
  | { type: "chat:history"; items: Array<{ id: string; title: string; updatedAt: number }> }
  | { type: "chat:speaking"; speaking: boolean }
  | { type: "voice:debug-state"; recording: boolean; items: number };

export type SidecarOutbound =
  | { type: "chat:submit"; text: string }
  | { type: "chat:abort" }
  | { type: "chat:new" }
  | { type: "voice:start-live" }
  | { type: "voice:stop-live" }
  | { type: "approval:resolve"; id: string; decision: ApprovalDecision }
  | { type: "takeover:resume" }
  | { type: "voice:start-dictation" }
  | { type: "chat:history-request" }
  | { type: "chat:open"; id: string }
  | { type: "chat:forget"; id: string }
  | { type: "session:rename"; title: string }
  | { type: "chat:rewind"; id: string; text?: string }
  /** `id` é a mensagem lida: com ele o painel sabe onde pintar o destaque palavra a palavra. */
  | { type: "chat:speak"; text: string; id?: string }
  | { type: "chat:speak-stop" }
  | { type: "chat:attach"; name: string; text: string }
  | { type: "chat:detach"; index: number }
  | { type: "voice:debug-start" }
  | { type: "voice:debug-stop" };

/** Assinatura compartilhada por quem avisa a UI: o loop principal, ferramentas que fazem trabalho
 *  assíncrono depois de já terem respondido (como delegar uma tarefa), e a ponte MCP. */
export type Emit = (message: SidecarInbound) => void;

export type SidecarPort = {
  post: (message: SidecarOutbound) => boolean;
  disconnect: () => void;
};

/**
 * O service worker do MV3 é descartado com 30 s ociosos e leva a porta junto. Sem reconexão, o
 * painel continua aberto com uma porta morta: `postMessage` não lança, a mensagem simplesmente
 * some, e o usuário fica digitando no vazio. Por isso a porta se reabre sozinha, e `post` avisa
 * quando não conseguiu entregar — quem chama decide se limpa o campo ou não.
 */
export function connectSidecar(
  onMessage: (message: SidecarInbound) => void,
  onConnectionChange?: (connected: boolean) => void,
): SidecarPort {
  let port: chrome.runtime.Port | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer = 0;

  const open = () => {
    if (closed || typeof chrome === "undefined" || !chrome.runtime?.connect) return;
    try {
      port = chrome.runtime.connect({ name: SIDECAR_PORT });
    } catch {
      port = null;
      schedule();
      return;
    }
    attempt = 0;
    onConnectionChange?.(true);
    port.onMessage.addListener((message) => onMessage(message as SidecarInbound));
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      onConnectionChange?.(false);
      schedule();
    });
  };

  const schedule = () => {
    if (closed || retryTimer) return;
    const delay = Math.min(250 * 2 ** attempt, 4000);
    attempt += 1;
    retryTimer = setTimeout(() => { retryTimer = 0; open(); }, delay) as unknown as number;
  };

  open();

  return {
    post: (message) => {
      if (!port) { schedule(); return false; }
      try { port.postMessage(message); return true; }
      catch { port = null; onConnectionChange?.(false); schedule(); return false; }
    },
    disconnect: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      port?.disconnect();
      port = null;
    },
  };
}
