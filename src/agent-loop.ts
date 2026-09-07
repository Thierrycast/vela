import { AgentEvent, ChatMessage } from "./types";
import { LoopSnapshot, SidecarInbound } from "./messages";
import { ToolCall, streamChat } from "./provider";
import { runToolCall } from "./tool-runner";
import { endTraceSessions } from "./agent";
import { appendLog, loadSettings } from "./storage";
import { beginTurn, record as traceRecord, span } from "./trace";
import { collectBrowserContext, clearAttachments } from "./browser-context";
import * as conversation from "./conversation";

type Emit = (message: SidecarInbound) => void;

const newId = () => crypto.randomUUID();

/** Argumentos de tool chegam como texto; guardar cru na trilha atrapalha a leitura depois. */
function safeParse(raw: string): unknown {
  try { return JSON.parse(raw || "{}"); } catch { return raw.slice(0, 300); }
}

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

/** Devolve se o turno foi aceito: quem chama pela voz precisa saber que a fala se perdeu. */
export async function submit(text: string, emit: Emit): Promise<boolean> {
  if (running) return false;
  const settings = await loadSettings();
  const profile = settings.providers.find((item) => item.id === settings.activeProviderId);
  const maxRounds = Math.min(30, Math.max(2, Math.round(settings.agent.maxRounds || 8)));
  // Um id por turno costura tudo o que vem depois: rodadas, chamadas de tool, ações e falhas.
  beginTurn(newId());
  const turnSpan = span("turn", "turno completo", { autonomy: settings.agent.autonomy, maxRounds });
  const repeats = new Map<string, number>();
  traceRecord("user.input", text.slice(0, 200), { data: { length: text.length, model: profile?.defaultModel } });
  running = true;
  controller = new AbortController();
  emit({ type: "chat:running", running: true });
  void appendLog({ level: "info", event: "chat.started", detail: `provider=${settings.activeProviderId}; model=${profile?.defaultModel || "unset"}` });

  await addMessage({ id: newId(), role: "user", content: text, createdAt: Date.now(), status: "complete" }, emit);
  await clearAttachments();

  try {
    for (let round = 0; round < maxRounds; round += 1) {
      const roundSpan = span("model.request", `rodada ${round + 1}`, { round });
      let firstToken = 0;
      let chunks = 0;
      const started = performance.now();
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
        if (event.type === "text") { chunks += 1; if (!firstToken) firstToken = Math.round(performance.now() - started); }
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

      // Tempo até o primeiro token é a métrica que o usuário sente como "demorou para começar";
      // o total mede o custo da rodada. Separados, dizem coisas diferentes.
      roundSpan.end({ ok: !failed, data: { round, firstTokenMs: firstToken, chunks, calls: calls.length, chars: assistant.content.length } });
      if (failed || controller.signal.aborted) break;

      if (!calls.length) {
        // A resposta final inteira entra na trilha: é o lado "saída do modelo" do material de
        // ajuste fino, e sem ela sobram medições sem o que foi de fato dito.
        traceRecord("model.text", "resposta ao usuário", { ok: true, data: { texto: assistant.content, chars: assistant.content.length, round } });
        await conversation.patch(assistant.id, { status: "complete" });
        emit({ type: "chat:patch", id: assistant.id, patch: { status: "complete" } });
        break;
      }

      // Repetir a mesma chamada com os mesmos argumentos não produz resultado novo — produz o
      // loop observado: sete extractPage seguidos até estourar o teto de etapas. Avisar não
      // bastava, porque o aviso chega como texto e o modelo já estava decidido. A partir da
      // terceira vez a chamada **não roda**: ele recebe uma recusa que diz o que fazer no lugar.
      const blocked = new Set<string>();
      for (const call of calls) {
        const fingerprint = `${call.name}:${call.arguments}`;
        const seen = (repeats.get(fingerprint) ?? 0) + 1;
        repeats.set(fingerprint, seen);
        if (seen < 3) continue;
        blocked.add(call.id);
        traceRecord("tool.call", `repetição bloqueada: ${call.name}`, { ok: false, code: "repeticao", data: { name: call.name, vezes: seen, arguments: safeParse(call.arguments) } });
        if (seen === 3) record({ kind: "error", text: `${call.name} repetido sem mudar nada — bloqueei e pedi outro caminho.` }, emit);
      }

      const toolCalls = calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } }));
      await conversation.patch(assistant.id, { status: "complete", tool_calls: toolCalls });
      emit({ type: "chat:patch", id: assistant.id, patch: { status: "complete", tool_calls: toolCalls } });

      for (const call of calls) {
        if (blocked.has(call.id)) {
          const recusa = `ERRO [repeticao] Você já chamou ${call.name} com estes mesmos argumentos e o resultado foi o mesmo. Repetir não vai mudar nada. Se procura algo na página, use browser_action com action "find" e o texto que você espera encontrar. Se já tentou isso, explique ao usuário o que está impedindo e pergunte como seguir.`;
          await addMessage({ id: newId(), role: "tool", tool_call_id: call.id, content: recusa, createdAt: Date.now(), status: "error" }, emit);
          continue;
        }
        const callSpan = span("tool.call", call.name, { arguments: safeParse(call.arguments) });
        const { content, event } = await runToolCall(call, settings);
        callSpan.end({ ok: event.kind !== "error", data: { name: call.name, arguments: safeParse(call.arguments), result: content.slice(0, 600) } });
        record(event, emit);
        void appendLog({ level: event.kind === "error" ? "error" : "info", event: event.kind === "error" ? "agent.tool_error" : "agent.tool_completed", detail: `${call.name}: ${content.slice(0, 200)}` });
        await addMessage({ id: newId(), role: "tool", tool_call_id: call.id, content, createdAt: Date.now(), status: event.kind === "error" ? "error" : "complete" }, emit);
      }

      if (round === maxRounds - 2) {
        await conversation.append({
          id: newId(),
          role: "system",
          content: "Esta é a sua última etapa nesta tarefa. Pare de usar ferramentas e responda ao usuário agora, com o que você conseguiu até aqui e o que ficou faltando.",
          createdAt: Date.now(),
          status: "complete",
        });
      }
      if (round === maxRounds - 1) {
        record({ kind: "status", text: `Parei em ${maxRounds} etapas. Diga "continue" para eu seguir de onde parei.` }, emit);
        traceRecord("turn", "limite de etapas atingido", { ok: false, code: "max_rounds", data: { maxRounds } });
      }
    }
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError" ? "Execução interrompida." : error instanceof Error ? error.message : "Falha inesperada na execução.";
    traceRecord("error", message, { ok: false, code: "loop" });
    record({ kind: "error", text: message }, emit);
    void appendLog({ level: "error", event: "chat.unhandled_error", detail: message });
  } finally {
    turnSpan.end({ ok: true });
    running = false;
    controller = null;
    await endTraceSessions();
    await conversation.flush();
    emit({ type: "chat:running", running: false });
  }
  return true;
}
