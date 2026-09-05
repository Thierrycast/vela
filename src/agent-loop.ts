import { AgentEvent, ChatMessage } from "./types";
import { LoopSnapshot, SidecarInbound } from "./messages";
import { ToolCall, streamChat } from "./provider";
import { runToolCall } from "./tool-runner";
import { endTraceSessions } from "./agent";
import { appendLog, loadSettings } from "./storage";
import { collectBrowserContext, clearAttachments } from "./browser-context";
import * as conversation from "./conversation";

type Emit = (message: SidecarInbound) => void;

const MAX_ROUNDS = 8;
const newId = () => crypto.randomUUID();

let running = false;
let controller: AbortController | null = null;
let events: AgentEvent[] = [];
let telemetry: string[] = [];

export const isRunning = () => running;
export const abort = () => controller?.abort();

export async function snapshot(): Promise<LoopSnapshot> {
  return { messages: await conversation.all(), events, telemetry, running };
}

export async function reset() {
  abort();
  events = []; telemetry = [];
  await conversation.reset();
}

function record(event: AgentEvent, emit: Emit) {
  events = [...events.slice(-40), event];
  emit({ type: "chat:event", event });
}

async function addMessage(message: ChatMessage, emit: Emit) {
  await conversation.append(message);
  emit({ type: "chat:message", message });
}

/** Snapshots antigos são peso morto: o DOM já mudou e o modelo não deve consultá-los. */
async function compactSnapshots() {
  const messages = await conversation.all();
  const snapshots = messages.filter((item) => item.role === "tool" && item.content.includes("# Elementos interativos"));
  for (const message of snapshots.slice(0, -1)) {
    if (message.content.startsWith("[retrato anterior")) continue;
    await conversation.patch(message.id, { content: "[retrato anterior da página — descartado por estar obsoleto]" });
  }
}

export async function submit(text: string, emit: Emit) {
  if (running) return;
  const settings = await loadSettings();
  const profile = settings.providers.find((item) => item.id === settings.activeProviderId);
  running = true;
  controller = new AbortController();
  emit({ type: "chat:running", running: true });
  void appendLog({ level: "info", event: "chat.started", detail: `provider=${settings.activeProviderId}; model=${profile?.defaultModel || "unset"}` });

  await addMessage({ id: newId(), role: "user", content: text, createdAt: Date.now(), status: "complete" }, emit);
  await clearAttachments();

  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const assistant: ChatMessage = { id: newId(), role: "assistant", content: "", createdAt: Date.now(), status: "streaming" };
      await addMessage(assistant, emit);

      const calls: ToolCall[] = [];
      let failed = false;
      await compactSnapshots();
      const context = await collectBrowserContext(settings);

      for await (const event of streamChat(settings, await conversation.all(), context, controller.signal)) {
        if (event.type === "text") {
          await conversation.appendText(assistant.id, event.text);
          emit({ type: "chat:delta", id: assistant.id, text: event.text });
        }
        if (event.type === "telemetry") {
          const line = `${event.values["x-omniroute-provider"] ?? "provider"} · ${event.values["x-omniroute-latency-ms"] ?? "latência n/d"} ms`;
          telemetry = [...telemetry.slice(-5), line];
          emit({ type: "chat:telemetry", text: line });
          void appendLog({ level: "info", event: "chat.telemetry", detail: line });
        }
        if (event.type === "warning") record({ kind: "status", text: event.message }, emit);
        if (event.type === "tool_call") calls.push(event.call);
        if (event.type === "error") {
          failed = true;
          await conversation.patch(assistant.id, { content: event.message, status: "error" });
          emit({ type: "chat:patch", id: assistant.id, patch: { content: event.message, status: "error" } });
          void appendLog({ level: "error", event: "chat.provider_error", detail: event.message });
          void chrome.notifications.create({ type: "basic", iconUrl: "icons/icon-128.png", title: "Vela", message: event.message });
        }
      }

      if (failed || controller.signal.aborted) break;

      if (!calls.length) {
        await conversation.patch(assistant.id, { status: "complete" });
        emit({ type: "chat:patch", id: assistant.id, patch: { status: "complete" } });
        break;
      }

      const toolCalls = calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } }));
      await conversation.patch(assistant.id, { status: "complete", tool_calls: toolCalls });
      emit({ type: "chat:patch", id: assistant.id, patch: { status: "complete", tool_calls: toolCalls } });

      for (const call of calls) {
        const { content, event } = await runToolCall(call, settings);
        record(event, emit);
        void appendLog({ level: event.kind === "error" ? "error" : "info", event: event.kind === "error" ? "agent.tool_error" : "agent.tool_completed", detail: `${call.name}: ${content.slice(0, 200)}` });
        await addMessage({ id: newId(), role: "tool", tool_call_id: call.id, content, createdAt: Date.now(), status: event.kind === "error" ? "error" : "complete" }, emit);
      }

      if (round === MAX_ROUNDS - 1) {
        await addMessage({ id: newId(), role: "assistant", content: `Atingi o limite de ${MAX_ROUNDS} etapas nesta tarefa. Peça para continuar se quiser que eu siga.`, createdAt: Date.now(), status: "complete" }, emit);
      }
    }
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError" ? "Execução interrompida." : error instanceof Error ? error.message : "Falha inesperada na execução.";
    record({ kind: "error", text: message }, emit);
    void appendLog({ level: "error", event: "chat.unhandled_error", detail: message });
  } finally {
    running = false;
    controller = null;
    await endTraceSessions();
    await conversation.flush();
    emit({ type: "chat:running", running: false });
  }
}
