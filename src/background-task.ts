import { AppSettings, ChatMessage } from "./types";
import { Emit } from "./messages";
import { ToolCall, streamChat } from "./provider";
import { runToolCall } from "./tool-runner";
import { novaEscada } from "./tool-ladder";
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
/*
 * Cancelar é avançar a geração, não ligar uma chave.
 *
 * Era um booleano global, e a tarefa seguinte o voltava para `false` ao começar — "descancelando"
 * as que já tinham sido mandadas parar e ainda estavam no meio de uma rodada. Cada tarefa guarda
 * a geração em que nasceu; se ela mudou, a tarefa foi cancelada, e nada que venha depois desfaz isso.
 */
let geracao = 0;
const emAndamento = new Set<AbortController>();

/**
 * Quem sabe se a conversa principal está no meio de uma troca de ferramenta.
 *
 * Injetado pelo loop principal para não criar import circular. Ver `publicarResultado`.
 */
let conversaOcupada: () => boolean = () => false;
export function configureDelegation(options: { conversaOcupada: () => boolean }) {
  conversaOcupada = options.conversaOcupada;
}

export const isDelegatedRunning = () => running > 0;

/** O "parar" do painel vale para o que está em segundo plano também — senão a pessoa aperta parar
 *  e a Vela continua clicando em algum lugar que ela não está vendo. */
export function cancelDelegated() {
  geracao += 1;
  queue.length = 0;
  for (const controller of emAndamento) controller.abort();
  emAndamento.clear();
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
 * **O histórico da tarefa é dela, não da conversa.** Ela escrevia direto na conversa que o painel
 * mostra, em paralelo com o loop principal — e uma mensagem sua podia cair entre o
 * `assistant{tool_calls}` do loop e a resposta `tool` correspondente. Essa ordem é exigida pelo
 * formato da API, e o provedor recusava a conversa inteira dali em diante. Agora o andamento aparece
 * como eventos de status, e só o resultado entra na conversa — num momento em que ela está livre.
 *
 * Devolve o que dizer ao modelo que delegou: começou agora ou entrou na fila.
 */
export function runDelegatedTask(task: string, emit: Emit): "iniciada" | "na_fila" {
  const nascida = geracao;
  if (running >= MAX_CONCURRENT) {
    // Enfileirar em vez de recusar: o pedido já foi feito, e perdê-lo obrigaria a pessoa a
    // lembrar de repetir — justamente o que delegar existia para evitar.
    queue.push(() => execute(task, emit, nascida));
    return "na_fila";
  }
  void execute(task, emit, nascida);
  return "iniciada";
}

const status = (emit: Emit, text: string) => emit({ type: "chat:event", event: { kind: "status", text: `[segundo plano] ${text}` } });

async function publicarResultado(texto: string, ok: boolean, emit: Emit) {
  // Espera a conversa principal fechar a troca de ferramenta em curso; com teto, para um turno
  // travado não prender o resultado para sempre.
  const ate = Date.now() + 5 * 60_000;
  while (conversaOcupada() && Date.now() < ate) await new Promise((resolve) => setTimeout(resolve, 250));
  const mensagem: ChatMessage = { id: newId(), role: "assistant", content: `**Tarefa em segundo plano ${ok ? "concluída" : "interrompida"}.** ${texto}`, createdAt: Date.now(), status: ok ? "complete" : "error" };
  await conversation.append(mensagem);
  emit({ type: "chat:message", message: mensagem });
}

async function execute(task: string, emit: Emit, nascida: number): Promise<void> {
  if (nascida !== geracao) return;
  running += 1;
  const cancelada = () => nascida !== geracao;
  const turnId = newId();
  beginTurn(turnId);
  const turnSpan = span("turn", "tarefa em segundo plano", { tarefa: task.slice(0, 200) });
  traceRecord("user.input", `[segundo plano] ${task}`.slice(0, 200), { data: { length: task.length } });
  status(emit, `comecei: ${task.slice(0, 80)}`);

  const historico: ChatMessage[] = [{
    id: newId(),
    role: "user",
    // O briefing diz onde trabalhar, e nao so o que fazer: sem isso a tarefa de fundo disputa a
    // aba ativa com a pessoa, e ela ve a propria tela sendo levada embora no meio do que fazia.
    content: `[Tarefa em segundo plano] ${task}

Você está rodando por trás enquanto o usuário continua usando o navegador. Abra uma aba própria (navigate com newTab: true) e trabalhe nela passando o tabId nas ações — não roube a aba que está em foco. Ao terminar, responda em texto com o resultado.`,
    createdAt: Date.now(),
    status: "complete",
  }];

  const repeats = new Map<string, number>();
  // Escada própria: o que a conversa principal leu não vale como leitura desta tarefa, e vice-versa.
  const escada = novaEscada(task);
  let finalText = "";
  let ok = true;

  try {
    const carregadas: AppSettings = await loadSettings();
    // Uma tarefa de fundo não delega de novo: sem este corte, cada uma podia abrir outra, sem
    // limite de profundidade, até a fila encher de tarefas que ninguém pediu.
    const settings: AppSettings = { ...carregadas, capabilities: { ...carregadas.capabilities, delegate: false } };
    const profile = settings.providers.find((item) => item.id === settings.activeProviderId);
    if (!profile?.defaultModel) { finalText = "Nenhum modelo padrão configurado para tocar a tarefa em segundo plano."; ok = false; }
    else {
      for (let round = 0; round < MAX_DELEGATED_ROUNDS; round += 1) {
        if (cancelada()) { finalText = "A tarefa foi interrompida."; ok = false; break; }
        const assistant: ChatMessage = { id: newId(), role: "assistant", content: "", createdAt: Date.now(), status: "streaming" };
        const calls: ToolCall[] = [];
        let failed = false;
        const context = await collectBrowserContext(settings);
        const controller = new AbortController();
        emAndamento.add(controller);

        try {
          for await (const event of streamChat(settings, historico, context, controller.signal)) {
            if (event.type === "text") assistant.content += event.text;
            if (event.type === "tool_call") calls.push(event.call);
            if (event.type === "error") { failed = true; finalText = event.message; }
          }
        } finally {
          emAndamento.delete(controller);
        }
        if (cancelada()) { finalText = "A tarefa foi interrompida."; ok = false; break; }
        if (failed) { ok = false; break; }

        if (!calls.length) {
          finalText = assistant.content.trim();
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
        historico.push({ ...assistant, status: "complete", tool_calls: toolCalls });

        for (const call of calls) {
          if (cancelada()) break;
          if (blocked.has(call.id)) {
            const recusa = `ERRO [repeticao] Você já chamou ${call.name} com estes mesmos argumentos. Mude de abordagem ou conclua com o que já tem.`;
            historico.push({ id: newId(), role: "tool", tool_call_id: call.id, content: recusa, createdAt: Date.now(), status: "error" });
            continue;
          }
          const callSpan = span("tool.call", `[bg] ${call.name}`, { arguments: call.arguments.slice(0, 300) });
          const { content, event } = await runToolCall(call, settings, emit, escada);
          callSpan.end({ ok: event.kind !== "error", data: { result: content.slice(0, 300) } });
          status(emit, event.text);
          historico.push({ id: newId(), role: "tool", tool_call_id: call.id, content, createdAt: Date.now(), status: event.kind === "error" ? "error" : "complete" });
        }

        if (round === MAX_DELEGATED_ROUNDS - 1) { finalText = "A tarefa foi longe demais e parou por segurança."; ok = false; }
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
    if (proxima) void proxima();
  }

  // Cancelada pela pessoa, a tarefa não volta a falar: ela mesma mandou parar.
  if (cancelada()) return;
  await publicarResultado(finalText, ok, emit);

  // Falar o resultado é o ponto inteiro de rodar isto durante uma conversa por voz: sem isso, a
  // pessoa só saberia que terminou olhando a tela, o que anula a vantagem sobre esperar parado.
  if (finalText.trim()) {
    void chrome.runtime.sendMessage({ type: "voice:speak", text: `Terminei o que você me pediu para verificar: ${finalText}` }).catch(() => undefined);
  }
}
