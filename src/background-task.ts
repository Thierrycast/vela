import { AppSettings, ChatMessage } from "./types";
import { Emit } from "./messages";
import { ToolCall, streamChat } from "./provider";
import { runToolCall } from "./tool-runner";
import { loadSettings } from "./storage";
import { beginTurn, record as traceRecord, span } from "./trace";
import { collectBrowserContext } from "./browser-context";
import * as conversation from "./conversation";

const newId = () => crypto.randomUUID();
const MAX_DELEGATED_ROUNDS = 20;

let delegatedRunning = false;
export const isDelegatedRunning = () => delegatedRunning;

/**
 * O segundo fio de execução do Live Voice.
 *
 * A ideia que motivou isto: numa conversa falada, uma tarefa de várias etapas trava a fala — o
 * modelo rápido que conduz o turno-a-turno não é robusto o bastante para tocá-la sozinho, e
 * esperar o modelo robusto responder por voz junto com tool calling deixaria a conversa muda por
 * segundos ou minutos. Em vez disso, `delegate_task` (ver tool-runner.ts) devolve o controle ao
 * modelo rápido imediatamente, e este arquivo toca a tarefa de verdade — sempre com o modelo
 * padrão (o robusto, que precisa suportar tool calling), nunca com o rápido — enquanto a pessoa
 * pode seguir conversando. `settings` é recarregado do zero aqui, e não recebido de quem chamou:
 * durante um turno de voz o `defaultModel` do provider ativo fica temporariamente trocado pelo
 * rápido (ver agent-loop.ts), e usar essa cópia por engano faria a tarefa "robusta" rodar no
 * mesmo modelo que não deu conta dela na hora.
 *
 * Escreve na mesma conversa que a UI já mostra — sem isso o resultado ficaria invisível — mas só
 * uma tarefa por vez: uma segunda chamada enquanto a primeira roda vira um aviso, não uma fila.
 */
export async function runDelegatedTask(task: string, emit: Emit): Promise<void> {
  if (delegatedRunning) {
    const busy: ChatMessage = { id: newId(), role: "assistant", content: `Já tem uma tarefa rodando em segundo plano; não posso começar "${task}" agora. Espere ela terminar e peça de novo.`, createdAt: Date.now(), status: "complete" };
    await conversation.append(busy);
    emit({ type: "chat:message", message: busy });
    return;
  }
  delegatedRunning = true;
  const turnId = newId();
  beginTurn(turnId);
  const turnSpan = span("turn", "tarefa em segundo plano (live voice)", { tarefa: task.slice(0, 200) });
  traceRecord("user.input", `[segundo plano] ${task}`.slice(0, 200), { data: { length: task.length } });

  const brief: ChatMessage = { id: newId(), role: "user", content: `[Tarefa delegada em segundo plano durante uma conversa por voz] ${task}`, createdAt: Date.now(), status: "complete" };
  await conversation.append(brief);
  emit({ type: "chat:message", message: brief });

  const repeats = new Map<string, number>();
  let finalText = "";
  let ok = true;

  try {
    const settings: AppSettings = await loadSettings();
    const profile = settings.providers.find((item) => item.id === settings.activeProviderId);
    if (!profile?.defaultModel) { finalText = "Nenhum modelo padrão configurado para tocar a tarefa em segundo plano."; ok = false; }
    else {
      for (let round = 0; round < MAX_DELEGATED_ROUNDS; round += 1) {
        const assistant: ChatMessage = { id: newId(), role: "assistant", content: "", createdAt: Date.now(), status: "streaming" };
        await conversation.append(assistant);
        emit({ type: "chat:message", message: assistant });

        const calls: ToolCall[] = [];
        let failed = false;
        const context = await collectBrowserContext(settings);
        const controller = new AbortController();

        for await (const event of streamChat(settings, await conversation.all(), context, controller.signal)) {
          if (event.type === "text") { await conversation.appendText(assistant.id, event.text); emit({ type: "chat:delta", id: assistant.id, text: event.text }); }
          if (event.type === "tool_call") calls.push(event.call);
          if (event.type === "error") {
            failed = true;
            await conversation.patch(assistant.id, { content: event.message, status: "error" });
            emit({ type: "chat:patch", id: assistant.id, patch: { content: event.message, status: "error" } });
            finalText = event.message;
          }
        }
        if (failed) { ok = false; break; }

        if (!calls.length) {
          const current = await conversation.messageById(assistant.id);
          finalText = current?.content.trim() ?? "";
          await conversation.patch(assistant.id, { status: "complete" });
          emit({ type: "chat:patch", id: assistant.id, patch: { status: "complete" } });
          if (!finalText) { finalText = "Terminei sem responder nada em texto."; ok = false; }
          break;
        }

        const blocked = new Set<string>();
        for (const call of calls) {
          const fingerprint = `${call.name}:${call.arguments}`;
          const seen = (repeats.get(fingerprint) ?? 0) + 1;
          repeats.set(fingerprint, seen);
          if (seen >= 3) blocked.add(call.id);
        }

        const toolCalls = calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } }));
        await conversation.patch(assistant.id, { status: "complete", tool_calls: toolCalls });
        emit({ type: "chat:patch", id: assistant.id, patch: { status: "complete", tool_calls: toolCalls } });

        for (const call of calls) {
          if (blocked.has(call.id)) {
            const recusa = `ERRO [repeticao] Você já chamou ${call.name} com estes mesmos argumentos. Mude de abordagem ou conclua com o que já tem.`;
            const toolMsg: ChatMessage = { id: newId(), role: "tool", tool_call_id: call.id, content: recusa, createdAt: Date.now(), status: "error" };
            await conversation.append(toolMsg);
            emit({ type: "chat:message", message: toolMsg });
            continue;
          }
          const callSpan = span("tool.call", `[bg] ${call.name}`, { arguments: call.arguments.slice(0, 300) });
          const { content, event } = await runToolCall(call, settings, emit);
          callSpan.end({ ok: event.kind !== "error", data: { result: content.slice(0, 300) } });
          const toolMsg: ChatMessage = { id: newId(), role: "tool", tool_call_id: call.id, content, createdAt: Date.now(), status: event.kind === "error" ? "error" : "complete" };
          await conversation.append(toolMsg);
          emit({ type: "chat:message", message: toolMsg });
        }

        if (round === MAX_DELEGATED_ROUNDS - 1) { finalText = "A tarefa em segundo plano foi longe demais e parou por segurança."; ok = false; }
      }
    }
  } catch (error) {
    ok = false;
    finalText = error instanceof Error ? error.message : "Falha inesperada na tarefa em segundo plano.";
  } finally {
    turnSpan.end({ ok });
    delegatedRunning = false;
  }

  // Falar o resultado é o ponto inteiro de rodar isto durante uma conversa por voz: sem isso, a
  // pessoa só saberia que terminou olhando a tela, o que anula a vantagem sobre esperar parado.
  if (finalText.trim()) {
    void chrome.runtime.sendMessage({ type: "voice:speak", text: `Terminei o que você me pediu para verificar: ${finalText}` }).catch(() => undefined);
  }
}
