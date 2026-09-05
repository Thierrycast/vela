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
  | { type: "chat:prefill"; text: string }
  | { type: "chat:attachments"; items: string[] }
  | { type: "chat:approval"; request: ApprovalRequest }
  | { type: "chat:approval-closed"; id: string }
  | { type: "chat:takeover"; reason: string; expected: string }
  | { type: "chat:takeover-closed" }
  | { type: "chat:session"; title: string; tabCount: number }
  | { type: "chat:history"; items: Array<{ id: string; title: string; updatedAt: number }> };

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
  | { type: "session:rename"; title: string };

export type SidecarPort = {
  post: (message: SidecarOutbound) => void;
  disconnect: () => void;
};

export function connectSidecar(onMessage: (message: SidecarInbound) => void, onDisconnect?: () => void): SidecarPort | null {
  if (typeof chrome === "undefined" || !chrome.runtime?.connect) return null;
  const port = chrome.runtime.connect({ name: SIDECAR_PORT });
  port.onMessage.addListener((message) => onMessage(message as SidecarInbound));
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; onDisconnect?.(); });
  return { post: (message) => port.postMessage(message), disconnect: () => port.disconnect() };
}
