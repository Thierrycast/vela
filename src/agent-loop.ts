import { AgentEvent, ChatMessage } from "./types";
import { Emit, LoopSnapshot } from "./messages";
import { ToolCall, streamChat } from "./provider";
import { runToolCall } from "./tool-runner";
import { endTraceSessions } from "./agent";
import { configureSticky, endCdpSessions } from "./cdp-session";
import { appendLog, loadSettings } from "./storage";
import { beginCall, beginRound, beginTurn, configureTrace, record as traceRecord, recordFull, span } from "./trace";
import { collectBrowserContext, clearAttachments } from "./browser-context";
import { recordTurn } from "./action-stats";
import { cancelDelegated, configureDelegation } from "./background-task";
import { noteSource, resetDomainMemory } from "./domain-policy";
import { novaEscada } from "./tool-ladder";
import { ClasseDeModelo, decidir, modeloDaClasse, subirClasse } from "./roteador-de-modelo";
import * as conversation from "./conversation";

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

/*
 * Parar o turno e parar tudo são pedidos diferentes.
 *
 * `abort` interrompe só o turno em curso — é o que acontece quando a pessoa fala por cima numa
 * conversa de voz, e as tarefas de fundo existem justamente para continuar enquanto ela fala.
 * `abortAll` é o botão de parar: a pessoa quer a Vela quieta, inclusive no que ela não está vendo.
 */
export const abort = () => { controller?.abort(); };
export const abortAll = () => { abort(); cancelDelegated(); };

// Resultado de tarefa de fundo só entra na conversa quando nenhum turno está no meio de uma troca
// de ferramenta — ver background-task.ts.
configureDelegation({ conversaOcupada: () => running });

export async function snapshot(): Promise<LoopSnapshot> {
  return { messages: await conversation.all(), events, telemetry, running };
}

export async function reset() {
  // Conversa nova encerra também o que estava em segundo plano: o resultado pertence à conversa
  // anterior e cairia, sem contexto nenhum, na que acabou de começar.
  abortAll();
  events = []; telemetry = [];
  /*
   * Conversa nova, decisões novas: o que o usuário autorizou visitar na conversa anterior não
   * continua valendo aqui. Manter a memória de proveniência entre conversas iria alargando o que
   * passa sem confirmação até o gate não significar mais nada.
   */
  resetDomainMemory();
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

/**
 * Só a captura mais recente continua sendo enviada.
 *
 * Imagem custa caro em contexto e duas telas quase idênticas ocupam o dobro sem dizer nada a
 * mais — e a antiga ainda mente, porque a página já rolou desde então.
 */
async function compactImages() {
  const messages = await conversation.all();
  for (const message of messages) {
    if (message.images?.length) await conversation.patch(message.id, { images: undefined, content: "[captura anterior — descartada por estar desatualizada]" });
  }
}

/**
 * Retratos antigos saem do contexto, mas os refs deles continuam valendo.
 *
 * O motivo mudou junto com o registro de refs. Antes o retrato velho era **perigoso**: ele
 * convidava a usar refs que já tinham morrido. Agora é só **redundante** — ele mente sobre o
 * estado (o que estava marcado, o que estava na tela), enquanto os identificadores que mostrou
 * seguem perfeitamente utilizáveis. Como retrato continua sendo o maior consumidor de contexto do
 * turno, ele sai; mas o texto que fica no lugar precisa dizer que os refs sobrevivem. Dizer o
 * contrário ensinaria o modelo a reler a página a cada passo — exatamente o hábito que o registro
 * de refs existe para curar.
 */
async function compactSnapshots() {
  const messages = await conversation.all();
  const extractCallIds = new Set<string>();
  
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        if (call.function?.name === "browser_action" && call.function?.arguments?.includes('"extractPage"')) {
          extractCallIds.add(call.id);
        }
      }
    }
  }

  const snapshots = messages.filter((item) => item.role === "tool" && item.tool_call_id && extractCallIds.has(item.tool_call_id));

  /*
   * A compactação é por aba, não global.
   *
   * Guardar só a última leitura do histórico inteiro funcionava quando havia uma aba só. Com o
   * lote multi-aba, ler a aba B apagaria a leitura da aba A no mesmo instante — e o modelo, que
   * está trabalhando nas duas, ficaria cego de um lado sem entender por quê. A aba vem do próprio
   * conteúdo, que começa com o cabeçalho escrito por `readAllFrames`.
   */
  const porAba = new Map<string, typeof snapshots>();
  for (const message of snapshots) {
    const aba = /^## aba (\d+)/m.exec(message.content)?.[1] ?? "?";
    porAba.set(aba, [...(porAba.get(aba) ?? []), message]);
  }

  for (const message of [...porAba.values()].flatMap((lista) => lista.slice(0, -1))) {
    if (message.content.startsWith("[leitura anterior")) continue;
    await conversation.patch(message.id, { content: "[leitura anterior da página, removida para poupar contexto. Os refs que ela mostrou continuam válidos enquanto aquela aba não navegar — releia só se precisar ver o estado atual da página.]" });
  }
}

/**
 * Resultados grandes de pedidos anteriores viram um resumo curto.
 *
 * Cada rodada reenvia a conversa inteira. Uma leitura de texto de dez mil caracteres, uma lista de
 * `find`, a saída de um script — tudo o que um pedido de meia hora atrás produziu continuava indo ao
 * modelo em toda rodada de todo pedido seguinte, custando tokens e tempo até o primeiro token sem
 * ajudar em nada: a página já mudou, e o que importava daquele resultado está na resposta que a Vela
 * deu. O pedido atual fica intacto; dos anteriores sobra o começo, que basta para lembrar o que foi
 * feito, e o aviso de que o resto saiu.
 */
const LIMITE_ANTERIOR = 1_500;

async function compactarTurnosAnteriores(inicioDoTurno: string) {
  const messages = await conversation.all();
  const inicio = messages.findIndex((message) => message.id === inicioDoTurno);
  if (inicio <= 0) return;
  for (const message of messages.slice(0, inicio)) {
    if (message.role !== "tool" || message.content.length <= LIMITE_ANTERIOR) continue;
    await conversation.patch(message.id, { content: `${message.content.slice(0, 500)}\n[resultado de um pedido anterior, resumido para poupar contexto — ${message.content.length} caracteres no original. Se precisar desse dado de novo, leia outra vez.]` });
  }
}

/** Devolve se o turno foi aceito: quem chama pela voz precisa saber que a fala se perdeu. */
/** Respostas em que o modelo rápido desiste em texto puro, sem tentar nenhuma ferramenta.
 *  Não precisa ser precisa: um falso positivo só custa uma repetição extra com o modelo robusto,
 *  que — se a recusa era mesmo correta (senha, captcha) — chega à mesma conclusão. */
const DECLINE_PATTERN = /\b(não consigo|não posso|não tenho como|não é poss[íi]vel|não tenho acesso|não sei como fazer|infelizmente não)\b/i;

export async function submit(text: string, emit: Emit, options: { useFastModel?: boolean; origem?: string; enunciado?: string } = {}): Promise<boolean> {
  if (running) return false;
  const settings = await loadSettings();
  const profile = settings.providers.find((item) => item.id === settings.activeProviderId);
  /*
   * Qual modelo atende este turno — e como ele sobe se a tarefa exigir.
   *
   * O modo `fixo` é o de sempre: vale o que a pessoa escolheu. No `auto`, a classe do pedido decide
   * o ponto de partida (uma pergunta curta não paga a latência de um modelo de raciocínio) e a
   * escada sobe sozinha diante de sinal observado: virou trabalho na página, as tentativas estão
   * falhando, a tarefa passou de três rodadas, o modelo desistiu em texto. Só sobe, nunca desce:
   * trocar de cabeça no meio de um raciocínio produz respostas que se contradizem entre rodadas.
   *
   * A escada da voz continua existindo por dentro disto: começar rápido numa conversa falada é o
   * mesmo princípio, e agora é uma classe entre outras em vez de um caso especial.
   */
  const automatico = settings.agent.modelRouting === "auto" && !!profile;
  let classeAtual: ClasseDeModelo = "navegacao";
  const trocarModelo = (modelo: string, classe: ClasseDeModelo, motivo: string) => {
    if (!profile || !modelo || modelo === profile.defaultModel) return;
    classeAtual = classe;
    settings.providers = settings.providers.map((p) => p.id === profile.id ? { ...p, defaultModel: modelo } : p);
    traceRecord("model.request", `modelo escolhido: ${modelo}`, { data: { classe, motivo, modelo } });
  };

  const fastModelId = options.useFastModel ? profile?.fastModel?.trim() : "";
  const robustModelId = profile?.defaultModel;
  const usingFastModel = !automatico && !!(fastModelId && robustModelId);
  let onFastModel = usingFastModel;
  let escalatedByRefusal = false;
  const escalate = (motivo: "chamou_ferramenta" | "erro_repetido" | "muitas_rodadas" | "desistiu" = "chamou_ferramenta") => {
    if (automatico && profile) {
      const subida = subirClasse(classeAtual, motivo);
      if (subida) trocarModelo(modeloDaClasse(subida.classe, profile, settings), subida.classe, subida.motivo);
      return;
    }
    if (!profile || !robustModelId || !onFastModel) return;
    onFastModel = false;
    settings.providers = settings.providers.map((p) => p.id === profile.id ? { ...p, defaultModel: robustModelId } : p);
  };
  if (usingFastModel && profile) {
    settings.providers = settings.providers.map((p) => p.id === profile.id ? { ...p, defaultModel: fastModelId! } : p);
  }
  if (automatico && profile) {
    const decisao = decidir({ texto: text, daVoz: options.origem === "voz", comImagem: false }, profile, settings);
    classeAtual = decisao.classe;
    trocarModelo(decisao.modelo, decisao.classe, decisao.motivo);
  }
  const maxRounds = 100;
  // Um id por turno costura tudo o que vem depois: rodadas, chamadas de tool, ações e falhas.
  beginTurn(newId());
  const turnSpan = span("turn", "turno completo", { autonomy: settings.agent.autonomy, maxRounds });
  const repeats = new Map<string, number>();
  /*
   * Rodadas e chamadas por turno são a medida da reforma de navegação: uma tarefa que antes
   * gastava oito idas ao modelo e agora gasta duas só aparece aqui. O `round` já ia para a trilha
   * em cada `model.request`, mas somá-lo depois exigiria reconstruir o turno evento a evento.
   */
  let roundsUsed = 0;
  let toolCallsMade = 0;
  /*
   * A pergunta inteira, e o estado em que ela foi feita.
   *
   * Duzentos caracteres bastam para reconhecer um turno numa lista; não bastam para revisá-lo —
   * o pedido que produziu um comportamento estranho costuma ser justamente o longo. E sem saber
   * com que autonomia, que modelo e que habilidades a Vela estava operando, o mesmo texto explica
   * duas execuções diferentes.
   */
  traceRecord("user.input", text.slice(0, 120), {
    data: {
      texto: text,
      length: text.length,
      // A origem nasce fora do turno (quem chamou sabe se veio da voz, da lente ou da ponte) e
      // precisa entrar aqui dentro: gravada antes, ela ficava carimbada como "sem turno" e o
      // relatório dizia "entrou por texto" em toda conversa falada.
      origem: options.origem ?? "texto",
      // O id da fala que abriu este turno: e por ele que o relatorio traz a captura, os rascunhos
      // e a transcricao — gravados antes de o turno existir — para dentro da narrativa dele.
      enunciado: options.enunciado,
      model: profile?.defaultModel,
      roteamento: settings.agent.modelRouting,
      autonomia: settings.agent.autonomy,
      modoPreciso: settings.agent.preciseMode,
      habilidades: Object.entries(settings.capabilities).filter(([, ligada]) => ligada).map(([nome]) => nome),
      versao: typeof chrome !== "undefined" ? chrome.runtime?.getManifest?.()?.version : undefined,
    },
  });
  // A promoção do depurador é decisão do turno, não de cada ação: quem liga a habilidade aceita
  // ver a faixa de aviso durante uma tarefa que insista no caminho confiável.
  configureSticky(settings.capabilities.cdpSession);
  // O nível é decidido por turno: ligar o rastreio completo no meio de uma tarefa gravaria metade.
  configureTrace({ detail: settings.agent.fullTrace ? "completo" : "normal" });
  // O que o usuário escreveu é decisão dele: endereços que ele mencionou passam sem confirmação.
  noteSource("user", text);
  // A escada de ferramentas é deste pedido: uma tarefa de fundo tem a sua, e uma não destrava a outra.
  const escada = novaEscada(text);
  running = true;
  controller = new AbortController();
  emit({ type: "chat:running", running: true });
  void appendLog({ level: "info", event: "chat.started", detail: `provider=${settings.activeProviderId}; model=${profile?.defaultModel || "unset"}` });

  const pedidoId = newId();
  await addMessage({ id: pedidoId, role: "user", content: text, createdAt: Date.now(), status: "complete" }, emit);
  let selecaoDoTurno: string | undefined;

  try {
    for (let round = 0; round < maxRounds; round += 1) {
      roundsUsed += 1;
      beginRound(round + 1);
      const roundSpan = span("model.request", `rodada ${round + 1}`, { round });
      let firstToken = 0;
      let chunks = 0;
      const started = performance.now();
      const assistant: ChatMessage = { id: newId(), role: "assistant", content: "", createdAt: Date.now(), status: "streaming" };
      await addMessage(assistant, emit);

      const calls: ToolCall[] = [];
      let failed = false;
      await compactSnapshots();
      if (round === 0) await compactarTurnosAnteriores(pedidoId);
      const context = await collectBrowserContext(settings, { lerSelecao: round === 0 });
      if (round === 0) selecaoDoTurno = context.selection;
      else context.selection = selecaoDoTurno;

      // Chamou ferramenta na rodada anterior: o pedido virou trabalho na página. Passou de três
      // rodadas: está patinando. Os dois são motivo para subir um degrau — e só para subir.
      if (round > 0 && onFastModel) escalate("chamou_ferramenta");
      if (automatico && round === 1 && toolCallsMade > 0) escalate("chamou_ferramenta");
      if (automatico && round === 4) escalate("muitas_rodadas");

      for await (const event of streamChat(settings, await conversation.all(), context, controller.signal)) {
        if (event.type === "text") {
          chunks += 1;
          if (!firstToken) firstToken = Math.round(performance.now() - started);
          // `assistant` é a mesma referência guardada em conversation.messages — appendText já
          // soma o texto ao objeto de verdade. Somar aqui também duplicava cada token gravado.
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
          assistant.content = event.message;
          await conversation.patch(assistant.id, { content: event.message, status: "error" });
          emit({ type: "chat:patch", id: assistant.id, patch: { content: event.message, status: "error" } });
          void appendLog({ level: "error", event: "chat.provider_error", detail: event.message });
          // Notificação é permissão opcional: sem ela, `chrome.notifications` nem existe, e o erro do
          // provedor virava um TypeError que escondia a mensagem original.
          void chrome.notifications?.create({ type: "basic", iconUrl: "icons/icon-128.png", title: "Vela", message: event.message }).catch(() => undefined);
        }
      }

      // Tempo até o primeiro token é a métrica que o usuário sente como "demorou para começar";
      // o total mede o custo da rodada. Separados, dizem coisas diferentes.
      roundSpan.end({ ok: !failed, data: { round, firstTokenMs: firstToken, chunks, calls: calls.length, chars: assistant.content.length } });
      if (failed || controller.signal.aborted) break;

      if (!calls.length) {
        /*
         * O modelo rápido pode desistir em texto puro, sem chamar nenhuma ferramenta — e nesse
         * caso o laço ia parar aqui, aceitando a recusa como resposta final. É o bug relatado como
         * "ela fala que não consegue, depois vai lá e faz": a escalada por rodada (acima) só ajuda
         * quando a rodada anterior *chamou* uma ferramenta; se a primeira resposta já foi uma
         * desistência em prosa, nunca havia rodada seguinte para escalar. Aqui a recusa nem chega a
         * ser mostrada: apaga a mensagem e tenta de novo, uma vez só, com o modelo robusto.
         */
        if ((onFastModel || automatico) && !escalatedByRefusal && DECLINE_PATTERN.test(assistant.content)) {
          escalatedByRefusal = true;
          escalate("desistiu");
          await conversation.truncateFrom(assistant.id);
          /*
           * Numa conversa falada, esta resposta pode já ter sido dita em voz alta.
           *
           * A narração fala frase a frase enquanto o modelo escreve, e a desistência costuma vir na
           * segunda frase ("Vou verificar. Infelizmente não tenho acesso."): quando o loop descobre
           * e descarta, o começo já saiu pelo alto-falante. Avisar quem está falando é o que permite
           * emendar — em vez de a pessoa ouvir uma recusa e, logo depois, a resposta certa, sem
           * entender o que aconteceu no meio.
           */
          emit({ type: "chat:descartada", id: assistant.id });
          emit({ type: "chat:snapshot", ...(await snapshot()) });
          traceRecord("turn", "recusa do modelo rápido descartada; tentando com o robusto", { data: { texto: assistant.content.slice(0, 200) } });
          round -= 1;
          continue;
        }
        if (!assistant.content.trim()) {
          const errorMsg = "O modelo encerrou a resposta prematuramente sem enviar texto ou ferramentas.";
          await conversation.patch(assistant.id, { content: errorMsg, status: "error" });
          emit({ type: "chat:patch", id: assistant.id, patch: { content: errorMsg, status: "error" } });
        } else {
          // A resposta final inteira entra na trilha: é o lado "saída do modelo" do material de
          // ajuste fino, e sem ela sobram medições sem o que foi de fato dito.
          traceRecord("model.text", "resposta ao usuário", { ok: true, round: round + 1, data: { texto: assistant.content, chars: assistant.content.length } });
          await conversation.patch(assistant.id, { status: "complete" });
          emit({ type: "chat:patch", id: assistant.id, patch: { status: "complete" } });
        }
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
        if (seen === 3) {
          record({ kind: "error", text: `${call.name} repetido sem mudar nada — bloqueei e pedi outro caminho.` }, emit);
          escalate("erro_repetido");
        }
      }

      toolCallsMade += calls.length;
      const toolCalls = calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } }));
      await conversation.patch(assistant.id, { status: "complete", tool_calls: toolCalls });
      emit({ type: "chat:patch", id: assistant.id, patch: { status: "complete", tool_calls: toolCalls } });

      for (const call of calls) {
        if (blocked.has(call.id)) {
          const recusa = `ERRO [repeticao] Você já chamou ${call.name} com estes mesmos argumentos e o resultado foi o mesmo. Repetir não vai mudar nada. Se procura algo na página, use browser_action com action "find" e o texto que você espera encontrar. Se já tentou isso, explique ao usuário o que está impedindo e pergunte como seguir.`;
          await addMessage({ id: newId(), role: "tool", tool_call_id: call.id, content: recusa, createdAt: Date.now(), status: "error" }, emit);
          continue;
        }
        beginCall(call.id);
        const callSpan = span("tool.call", call.name, { arguments: safeParse(call.arguments) });
        const { content, event, image } = await runToolCall(call, settings, emit, escada);
        callSpan.end({ ok: event.kind !== "error", callId: call.id, data: { name: call.name, arguments: safeParse(call.arguments), result: content.slice(0, 600) } });
        /*
         * O resultado inteiro, separado do resumo.
         *
         * Seiscentos caracteres cobrem o "deu certo ou não" e escondem exatamente o que importa
         * numa revisão: o retrato da página que o modelo leu antes de decidir. O elemento que ele
         * não viu estava no trecho cortado — e é impossível saber disso lendo o trecho que ficou.
         */
        recordFull("model.tool", `resultado de ${call.name}`, { ok: event.kind !== "error", callId: call.id, data: { name: call.name, resultado: content, temImagem: !!image } });
        beginCall(undefined);
        record(event, emit);
        void appendLog({ level: event.kind === "error" ? "error" : "info", event: event.kind === "error" ? "agent.tool_error" : "agent.tool_completed", detail: `${call.name}: ${content.slice(0, 200)}` });
        await addMessage({ id: newId(), role: "tool", tool_call_id: call.id, content, createdAt: Date.now(), status: event.kind === "error" ? "error" : "complete" }, emit);
        // Resposta de ferramenta é texto puro; a captura entra logo depois como mensagem do
        // usuário, que é o único papel que aceita imagem.
        if (image) {
          await compactImages();
          await addMessage({ id: newId(), role: "user", content: "[captura da tela visível]", images: [image], createdAt: Date.now(), status: "complete" }, emit);
        }
      }

      /*
       * O teto de 100 é trava de segurança, não conversa — ninguém deve sentir ele no uso normal.
       * Mas sem aviso nenhum, uma tarefa realmente travada (que varia os argumentos a cada
       * chamada, escapando do bloqueio de repetição acima) gastaria as 100 rodadas em silêncio.
       * Um empurrão às 80 dá 20 rodadas de folga para o modelo se recompor sozinho — não é ordem
       * de parar, é lembrete de que insistir sem mudar de estratégia não é gastar bem o que sobrou.
       */
      if (round === maxRounds - 20) {
        await conversation.append({ id: newId(), role: "system", content: "Esta tarefa já vai longe (muitas rodadas). Se não está progredindo, pare, explique ao usuário o que tentou e o que falta, e pergunte como seguir — em vez de continuar tentando variações da mesma abordagem.", createdAt: Date.now(), status: "complete" });
        record({ kind: "status", text: "Tarefa longa — avisei o modelo para reavaliar o caminho." }, emit);
      }
      if (round === maxRounds - 1) traceRecord("turn", "teto de segurança de rodadas atingido", { ok: false, code: "max_rounds", data: { maxRounds } });
    }
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError" ? "Execução interrompida." : error instanceof Error ? error.message : "Falha inesperada na execução.";
    traceRecord("error", message, { ok: false, code: "loop" });
    record({ kind: "error", text: message }, emit);
    void appendLog({ level: "error", event: "chat.unhandled_error", detail: message });
  } finally {
    /*
     * O anexo é contexto **deste** turno, e some quando ele acaba.
     *
     * A limpeza acontecia logo depois de gravar a mensagem do usuário, antes da primeira rodada —
     * ou seja, antes de `collectBrowserContext` ler os anexos. O arquivo virava chip na tira,
     * entrava no storage, e era apagado sem nunca ter sido enviado: o recurso inteiro não fazia
     * nada. Limpar aqui mantém o anexo disponível em todas as rodadas do turno e o descarta depois.
     */
    await clearAttachments();
    turnSpan.end({ ok: true, data: { rounds: roundsUsed, toolCalls: toolCallsMade } });
    void recordTurn(roundsUsed, toolCallsMade);
    running = false;
    controller = null;
    await endTraceSessions();
    await endCdpSessions();
    await conversation.flush();
    emit({ type: "chat:running", running: false });
  }
  return true;
}
