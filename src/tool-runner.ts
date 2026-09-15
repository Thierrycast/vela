import { ActionResult, AgentEvent, AppSettings, BrowserAction } from "./types";
import { ToolCall, fetchUrl, searchProvider } from "./provider";
import { executeAction } from "./agent";
import { recordAction, recordBatch } from "./action-stats";
import { findScriptByName, listScripts, saveScript } from "./script-store";
import { parseMetadata } from "./user-script";
import { requestTakeover } from "./approvals";
import { manageTabs } from "./tab-manager";
import { readSetting, writeSetting } from "./settings-tool";
import { getMemory, setMemory } from "./storage";
import { Emit } from "./messages";
import { runDelegatedTask } from "./background-task";
import { CAPABILITY_LABELS, actionCapability, isEnabled, refuse, scriptCapability, toolCapability } from "./capabilities";
import { BatchItem, batchSize, runBatch } from "./batch-runner";

type ToolArguments = {
  action?: BrowserAction["type"]; url?: string; newTab?: boolean; ref?: string; selector?: string;
  text?: string; submit?: boolean; mode?: "replace" | "append"; key?: string;
  deltaX?: number; deltaY?: number; milliseconds?: number; extractMode?: "outline" | "text"; offset?: number;
  gone?: boolean; networkIdle?: boolean; timeoutMs?: number;
  toolName?: string; toolArguments?: unknown;
  query?: string; limit?: number; max_results?: number; max_length?: number; reason?: string; expected?: string;
  code?: string; replaces?: string; world?: string;
  op?: "list" | "activate" | "close" | "closeOthers"; tabId?: number; tabIds?: number[]; keep?: number;
  field?: string; value?: string; script?: string; task?: string;
  toRef?: string; toSelector?: string; label?: string; index?: number; direction?: string; items?: unknown; role?: string;
};

const SEARCH_BUDGET = 4000;

function summarizeSearch(results: Array<{ title: string; url: string; snippet?: string }>) {
  const text = results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${(result.snippet ?? "").replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
  return text.length > SEARCH_BUDGET ? `${text.slice(0, SEARCH_BUDGET)}\n[resultados truncados]` : text;
}

function toBrowserAction(args: ToolArguments): BrowserAction | null {
  switch (args.action) {
    case "navigate": return args.url ? { type: "navigate", url: args.url, newTab: args.newTab } : null;
    case "click": return { type: "click", ref: args.ref, selector: args.selector };
    case "type": return args.text !== undefined ? { type: "type", ref: args.ref, selector: args.selector, text: args.text, submit: args.submit, mode: args.mode } : null;
    case "keyPress": return args.key ? { type: "keyPress", key: args.key, ref: args.ref } : null;
    case "scroll": return { type: "scroll", deltaX: args.deltaX, deltaY: args.deltaY };
    case "extractPage": return { type: "extractPage", mode: args.extractMode, offset: args.offset };
    case "find": return { type: "find", query: args.query, selector: args.selector, limit: args.limit, role: args.role };
    case "screenshot": return { type: "screenshot" };
    case "wait": return { type: "wait", milliseconds: args.milliseconds ?? 1000 };
    case "waitFor": return { type: "waitFor", text: args.text, selector: args.selector, gone: args.gone, networkIdle: args.networkIdle, timeoutMs: args.timeoutMs };
    case "hover": return { type: "hover", ref: args.ref, selector: args.selector };
    case "drag": return { type: "drag", ref: args.ref, selector: args.selector, toRef: args.toRef, toSelector: args.toSelector };
    case "selectOption": return { type: "selectOption", ref: args.ref, selector: args.selector, label: args.label, value: args.value, index: args.index };
    case "history": return { type: "history", direction: args.direction === "forward" ? "forward" : "back" };
    case "pageTool": return args.toolName ? { type: "pageTool", name: args.toolName, arguments: args.toolArguments } : null;
    case "evaluateScript": return args.script ? { type: "evaluateScript", script: args.script, world: args.world === "main" ? "main" : "isolated" } : null;
    default: return null;
  }
}

function renderActionResult(result: ActionResult): string {
  if (!result.ok) return `ERRO [${result.code}] ${result.summary}`;
  const parts = [result.summary];
  if (result.content) {
    parts.push("", result.content);
    if (result.truncated) parts.push(`[truncado — continue com offset=${result.nextOffset}]`);
  }
  return parts.join("\n");
}

export async function runToolCall(call: ToolCall, settings: AppSettings, emit: Emit): Promise<{ content: string; event: AgentEvent; image?: string }> {
  try {
    const args = JSON.parse(call.arguments || "{}") as ToolArguments;
    const profile = settings.providers.find((item) => item.id === settings.activeProviderId);

    // A ferramenta desligada nem foi anunciada (ver buildTools); chegar aqui significa que o
    // modelo a chamou de memória, e a recusa precisa dizer qual chave está desligada.
    const toolGate = toolCapability(call.name);
    if (toolGate && !isEnabled(settings, toolGate)) {
      return { content: refuse(toolGate), event: { kind: "error", text: `${CAPABILITY_LABELS[toolGate]}: habilidade desligada.` } };
    }

    if (call.name === "browser_batch") {
      // O lote não se executa: ele reentra aqui, item a item. É o que garante que cada passo
      // continue passando pelos mesmos gates (autonomia, habilidade, ação irreversível) que
      // passaria se o modelo o tivesse chamado sozinho.
      const result = await runBatch((args as { items?: BatchItem[] }).items ?? [], settings, emit, (item, itemSettings) => runToolCall(item, itemSettings, emit));
      void recordBatch(batchSize((args as { items?: unknown }).items));
      return result;
    }

    if (call.name === "browser_action") {
      const action = toBrowserAction(args);
      if (!action) return { content: `ERRO [unsupported] Argumentos insuficientes para ${args.action ?? "browser_action"}.`, event: { kind: "error", text: `Chamada inválida de ${args.action ?? "browser_action"}.` } };
      const actionGate = action.type === "evaluateScript" ? scriptCapability(action.world) : actionCapability(action.type);
      if (actionGate && !isEnabled(settings, actionGate)) {
        return { content: refuse(actionGate), event: { kind: "error", text: `${CAPABILITY_LABELS[actionGate]}: habilidade desligada.` } };
      }
      if (action.type === "extractPage") action.bypassWireguard = settings.agent.bypassWireguard;
      const result = await executeAction(action, settings.agent.autonomy);
      void recordAction(action, result);
      return {
        content: renderActionResult(result),
        event: { kind: result.ok ? "result" : "error", text: result.summary, action },
        // A imagem sobe separada: resposta de ferramenta é texto, então a captura entra depois,
        // numa mensagem do usuário.
        ...(result.ok && result.image ? { image: result.image } : {}),
      };
    }

    if (call.name === "web_search" && args.query) {
      if (!profile) throw new Error("Provider ativo não encontrado.");
      const results = await searchProvider(profile, args.query, args.max_results ?? 5);
      return { content: summarizeSearch(results), event: { kind: "result", text: `Busca: ${results.length} resultado(s) para “${args.query}”.` } };
    }

    if (call.name === "web_fetch" && args.url) {
      if (!profile) throw new Error("Provider ativo não encontrado.");
      const content = await fetchUrl(profile, args.url, args.max_length ?? 8000);
      return { content: content || "[a página não devolveu conteúdo legível]", event: { kind: "result", text: `Li ${args.url}` } };
    }

    if (call.name === "tab_manage" && args.op) {
      const command = args.op === "activate" ? { op: "activate" as const, tabId: args.tabId ?? -1 }
        : args.op === "close" ? { op: "close" as const, tabIds: args.tabIds ?? [] }
        : args.op === "closeOthers" ? { op: "closeOthers" as const, keep: args.keep ?? -1 }
        : { op: "list" as const };
      const result = await manageTabs(command);
      return result.ok
        ? { content: [result.summary, result.content].filter(Boolean).join("\n"), event: { kind: "result", text: result.summary } }
        : { content: `ERRO [denied] ${result.summary}`, event: { kind: "error", text: result.summary } };
    }

    if (call.name === "vela_settings") {
      if (!args.value) {
        const text = await readSetting(args.field);
        return { content: text, event: { kind: "result", text: args.field ? `Consultei a configuração ${args.field}.` : "Listei as configurações." } };
      }
      if (!args.field) return { content: "ERRO [unsupported] Diga qual campo mudar.", event: { kind: "error", text: "Configuração sem campo." } };
      const result = await writeSetting(args.field, args.value);
      return result.ok
        ? { content: result.summary, event: { kind: "result", text: result.summary } }
        : { content: `ERRO [unsupported] ${result.summary}`, event: { kind: "error", text: result.summary } };
    }

    if (call.name === "request_user" && args.reason) {
      const expected = args.expected ?? "Conclua a etapa manualmente e retome quando estiver pronto.";
      const attended = await requestTakeover(args.reason, expected);
      return attended
        ? { content: "O usuário retomou o controle. Releia a página com extractPage antes de continuar.", event: { kind: "status", text: `Vez do usuário: ${args.reason}` } }
        : { content: "ERRO [denied] Não há interface aberta para pedir intervenção. Explique ao usuário o que ele precisa fazer.", event: { kind: "error", text: "Pedido de intervenção sem painel aberto." } };
    }

    if (call.name === "script_list") {
      const scripts = await listScripts();
      if (!scripts.length) return { content: "O usuário ainda não tem nenhum script salvo.", event: { kind: "result", text: "Nenhum script salvo." } };
      const lines = scripts.map((script) => {
        const meta = parseMetadata(script.code);
        return `- ${meta.name} (v${meta.version}${script.enabled ? "" : ", desativado"}) — ${meta.description || "sem descrição"} — alvos: ${meta.matches.join(", ")}`;
      });
      return { content: lines.join("\n"), event: { kind: "result", text: `${scripts.length} script(s) salvos.` } };
    }

    if (call.name === "script_write" && args.code) {
      if (!/==UserScript==/.test(args.code)) {
        return { content: "ERRO [unsupported] O código precisa começar com o bloco ==UserScript== declarando @name, @description e @match.", event: { kind: "error", text: "Script sem cabeçalho de metadados." } };
      }
      const meta = parseMetadata(args.code);
      const existing = args.replaces ? await findScriptByName(args.replaces) : await findScriptByName(meta.name);
      const now = Date.now();
      const script = existing
        ? { ...existing, code: args.code, updatedAt: now }
        : { id: crypto.randomUUID(), code: args.code, enabled: false, createdAt: now, updatedAt: now };
      await saveScript(script);
      const text = existing
        ? `Script “${meta.name}” atualizado. O usuário pode revisar e executar em Configurações → Scripts.`
        : `Script “${meta.name}” salvo, ainda desativado. O usuário precisa revisar e habilitar em Configurações → Scripts antes de executar.`;
      return { content: text, event: { kind: "result", text } };
    }

    if (call.name === "memory_write" && args.key && args.value) {
      /*
       * Memória é permanente e entra sozinha no system prompt de toda conversa futura — o canal
       * mais direto de prompt injection persistente que a Vela tem: uma página maliciosa manda
       * "memorize isto" uma vez, e o efeito sobrevive à aba, à conversa e ao chat:new. Modo
       * Observar bloqueia como qualquer outra escrita; os tetos existem para a mesma memória não
       * inchar o prompt (e o custo) indefinidamente.
       */
      if (settings.agent.autonomy === "observe") return { content: "ERRO [denied] Modo Observar: gravação na memória bloqueada.", event: { kind: "error", text: "Modo Observar bloqueou a gravação na memória." } };
      const memory = await getMemory();
      const MAX_ENTRIES = 60;
      const MAX_KEY = 80;
      const MAX_VALUE = 2000;
      if (!(args.key in memory) && Object.keys(memory).length >= MAX_ENTRIES) return { content: `ERRO [unsupported] Memória cheia (${MAX_ENTRIES} chaves). Apague algo com memory_delete antes de gravar mais.`, event: { kind: "error", text: "Memória cheia." } };
      const key = args.key.slice(0, MAX_KEY);
      const value = args.value.slice(0, MAX_VALUE);
      memory[key] = value;
      await setMemory(memory);
      return { content: `Memorizado: ${key} = ${value}`, event: { kind: "result", text: `Gravei ${key} na memória.` } };
    }

    if (call.name === "memory_read") {
      const memory = await getMemory();
      if (args.key) {
        const val = memory[args.key];
        return val ? { content: val, event: { kind: "result", text: `Li ${args.key} da memória.` } }
                   : { content: "ERRO [not_found] Chave não existe na memória.", event: { kind: "error", text: "Chave não encontrada." } };
      }
      const keys = Object.keys(memory);
      if (!keys.length) return { content: "A memória está vazia.", event: { kind: "result", text: "Memória vazia." } };
      return { content: keys.map((k) => `${k}: ${memory[k]}`).join("\n"), event: { kind: "result", text: "Li toda a memória." } };
    }

    if (call.name === "memory_delete" && args.key) {
      if (settings.agent.autonomy === "observe") return { content: "ERRO [denied] Modo Observar: apagar da memória bloqueado.", event: { kind: "error", text: "Modo Observar bloqueou a exclusão na memória." } };
      if (args.key === "*") {
        await setMemory({});
        return { content: "Toda a memória foi apagada.", event: { kind: "result", text: "Apaguei toda a memória." } };
      }
      const memory = await getMemory();
      if (args.key in memory) {
        delete memory[args.key];
        await setMemory(memory);
        return { content: `Chave apagada: ${args.key}`, event: { kind: "result", text: `Apaguei ${args.key}.` } };
      }
      return { content: "ERRO [not_found] Chave não existe na memória.", event: { kind: "error", text: "Chave não encontrada." } };
    }

    if (call.name === "delegate_task" && args.task) {
      if (settings.agent.autonomy === "observe") return { content: "ERRO [denied] Modo Observar: não é possível delegar tarefas.", event: { kind: "error", text: "Modo Observar bloqueou a delegação." } };
      // Roda por conta própria, sem bloquear este turno — o modelo rápido responde e a conversa
      // continua; o robusto trabalha por trás e o resultado chega como mensagem nova quando pronto.
      void runDelegatedTask(args.task, emit);
      const text = `Delegado em segundo plano: ${args.task.slice(0, 80)}`;
      return { content: "Tarefa delegada para execução em segundo plano com o modelo robusto. Responda ao usuário agora dizendo que vai cuidar disso, e continue a conversa normalmente — o resultado chega como uma mensagem nova quando terminar. Não espere por ele nem repita o pedido.", event: { kind: "result", text } };
    }

    const unknown = `ERRO [unsupported] Ferramenta ou argumentos inválidos: ${call.name}.`;
    return { content: unknown, event: { kind: "error", text: `Chamada inválida: ${call.name}.` } };
  } catch (error) {
    const text = error instanceof Error ? error.message : "Falha ao executar a ferramenta.";
    return { content: `ERRO [falha] ${text}`, event: { kind: "error", text } };
  }
}
