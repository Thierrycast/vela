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
/**
 * Duas tarefas de fundo ao mesmo tempo, e as demais esperam em fila.
 *
 * O limite não é técnico, é de atenção: cada tarefa age no navegador da pessoa, e três agentes
 * mexendo em abas ao mesmo tempo produzem uma tela que ninguém consegue acompanhar — nem o
 * usuário, nem o próprio modelo quando for ler o resultado. Fila é honesta; recusar seria perder
 * o pedido, e rodar tudo junto seria transformar ajuda em confusão.
 */
const MAX_CONCURRENT = 2;

let running = 0;
const queue: Array<() => Promise<void>> = [];
let cancelled = false;

export const isDelegatedRunning = () => running > 0;
export const delegatedQueueSize = () => queue.length;

/** O "parar" do painel vale para o que está em segundo plano também — senão a pessoa aperta parar
 *  e a Vela continua clicando em algum lugar que ela não está vendo. */
export function cancelDelegated() {
  cancelled = true;
  queue.length = 0;
}

/**
 * O segundo fio de execução.
 *
 * Nasceu para o Live Voice: numa conversa falada, uma tarefa de várias etapas deixa a conversa
 * muda por minutos, e o modelo rápido que conduz o turno-a-turno não dá conta de tocá-la sozinho.
 * `delegate_task` devolve o controle a quem está conversando na hora, e este arquivo toca a tarefa
 * de verdade — sempre com o modelo padrão, o robusto — enquanto a pessoa segue falando.
 *
 * Deixou de ser só da voz porque o problema não era da voz: **esperar calado é ruim em qualquer
 * conversa**. Uma comparação de preços em cinco lojas, uma coleta de dados numa lista longa, uma
 * inscrição que depende de um e-mail chegar — em todas elas a pessoa fica olhando para uma tela
 * parada sem poder pedir mais nada. Agora ela pede, e continua conversando.
 *
 * `settings` é recarregado do zero aqui, e não recebido de quem chamou: durante um turno de voz o
 * `defaultModel` do provider ativo fica temporariamente trocado pelo rápido (ver agent-loop.ts), e
 * usar essa cópia por engano faria a tarefa "robusta" rodar no mesmo modelo que não deu conta dela.
 *
 * Escreve na mesma conversa que a UI já mostra — sem isso o resultado ficaria invisível.
 */
export async function runDelegatedTask(task: string, emit: Emit): Promise<void> {
  cancelled = false;
  if (running >= MAX_CONCURRENT) {
    // Enfileirar em vez de recusar: o pedido já foi feito, e perdê-lo obrigaria a pessoa a
    // lembrar de repetir — justamente o que delegar existia para evitar.
    queue.push(() => execute(task, emit));
    const aviso: ChatMessage = { id: newId(), role: "assistant", content: `Anotei “${task.slice(0, 80)}” na fila — já tenho ${running} tarefa(s) rodando em segundo plano. Começo assim que uma delas terminar.`, createdAt: Date.now(), status: "complete" };
    await conversation.append(aviso);
    emit({ type: "chat:message", message: aviso });
    return;
  }
  await execute(task, emit);
}

async function execute(task: string, emit: Emit): Promise<void> {
  running += 1;
  const turnId = newId();
  beginTurn(turnId);
  const turnSpan = span("turn", "tarefa em segundo plano", { tarefa: task.slice(0, 200) });
  traceRecord("user.input", `[segundo plano] ${task}`.slice(0, 200), { data: { length: task.length } });

  const brief: ChatMessage = {
    id: newId(),
    role: "user",
    // O briefing diz onde trabalhar, e nao so o que fazer: sem isso a tarefa de fundo disputa a
    // aba ativa com a pessoa, e ela ve a propria tela sendo levada embora no meio do que fazia.
    content: `[Tarefa em segundo plano] ${task}

Você está rodando por trás enquanto o usuário continua usando o navegador. Abra uma aba própria (navigate com newTab: true) e trabalhe nela passando o tabId nas ações — não roube a aba que está em foco. Ao terminar, responda em texto com o resultado.`,
    createdAt: Date.now(),
    status: "complete",
  };
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
        if (cancelled) { finalText = "A tarefa em segundo plano foi interrompida."; ok = false; break; }
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
    running -= 1;
    // A próxima da fila entra agora, não no próximo pedido do usuário.
    const proxima = queue.shift();
    if (proxima && !cancelled) void proxima();
  }

  // Falar o resultado é o ponto inteiro de rodar isto durante uma conversa por voz: sem isso, a
  // pessoa só saberia que terminou olhando a tela, o que anula a vantagem sobre esperar parado.
  if (finalText.trim()) {
    void chrome.runtime.sendMessage({ type: "voice:speak", text: `Terminei o que você me pediu para verificar: ${finalText}` }).catch(() => undefined);
  }
}
