import { ActionResult, AgentEvent, AppSettings, BrowserAction } from "./types";
import { ToolCall, fetchUrl, searchProvider } from "./provider";
import { executeAction } from "./agent";
import { recordAction } from "./action-stats";
import { findScriptByName, listScripts, saveScript } from "./script-store";
import { parseMetadata } from "./user-script";
import { requestTakeover } from "./approvals";
import { manageTabs } from "./tab-manager";
import { readSetting, writeSetting } from "./settings-tool";

type ToolArguments = {
  action?: BrowserAction["type"]; url?: string; newTab?: boolean; ref?: string; selector?: string;
  text?: string; submit?: boolean; mode?: "replace" | "append"; key?: string;
  deltaX?: number; deltaY?: number; milliseconds?: number; extractMode?: "outline" | "text"; offset?: number;
  toolName?: string; toolArguments?: unknown;
  query?: string; limit?: number; max_results?: number; max_length?: number; reason?: string; expected?: string;
  code?: string; replaces?: string;
  op?: "list" | "activate" | "close" | "closeOthers"; tabId?: number; tabIds?: number[]; keep?: number;
  field?: string; value?: string;
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
    case "find": return { type: "find", query: args.query, selector: args.selector, limit: args.limit };
    case "wait": return { type: "wait", milliseconds: args.milliseconds ?? 1000 };
    case "pageTool": return args.toolName ? { type: "pageTool", name: args.toolName, arguments: args.toolArguments } : null;
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

export async function runToolCall(call: ToolCall, settings: AppSettings): Promise<{ content: string; event: AgentEvent }> {
  try {
    const args = JSON.parse(call.arguments || "{}") as ToolArguments;
    const profile = settings.providers.find((item) => item.id === settings.activeProviderId);

    if (call.name === "browser_action") {
      const action = toBrowserAction(args);
      if (!action) return { content: `ERRO [unsupported] Argumentos insuficientes para ${args.action ?? "browser_action"}.`, event: { kind: "error", text: `Chamada inválida de ${args.action ?? "browser_action"}.` } };
      const result = await executeAction(action, settings.agent.autonomy);
      void recordAction(action, result);
      return {
        content: renderActionResult(result),
        event: { kind: result.ok ? "result" : "error", text: result.summary, action },
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

    const unknown = `ERRO [unsupported] Ferramenta ou argumentos inválidos: ${call.name}.`;
    return { content: unknown, event: { kind: "error", text: `Chamada inválida: ${call.name}.` } };
  } catch (error) {
    const text = error instanceof Error ? error.message : "Falha ao executar a ferramenta.";
    return { content: `ERRO [falha] ${text}`, event: { kind: "error", text } };
  }
}
