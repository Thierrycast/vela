import { ActionResult, AgentEvent, AppSettings, BrowserAction } from "./types";
import { ToolCall, fetchUrl, searchProvider } from "./provider";
import { executeAction } from "./agent";
import { saveScript } from "./script-store";
import { requestTakeover } from "./approvals";

type ToolArguments = {
  action?: BrowserAction["type"]; url?: string; newTab?: boolean; ref?: string; selector?: string;
  text?: string; submit?: boolean; mode?: "replace" | "append"; key?: string;
  deltaX?: number; deltaY?: number; milliseconds?: number; extractMode?: "outline" | "text"; offset?: number;
  query?: string; max_results?: number; max_length?: number; reason?: string; expected?: string;
  name?: string; description?: string; code?: string; matches?: string[];
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
    case "wait": return { type: "wait", milliseconds: args.milliseconds ?? 1000 };
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

    if (call.name === "request_user" && args.reason) {
      const expected = args.expected ?? "Conclua a etapa manualmente e retome quando estiver pronto.";
      const attended = await requestTakeover(args.reason, expected);
      return attended
        ? { content: "O usuário retomou o controle. Releia a página com extractPage antes de continuar.", event: { kind: "status", text: `Vez do usuário: ${args.reason}` } }
        : { content: "ERRO [denied] Não há interface aberta para pedir intervenção. Explique ao usuário o que ele precisa fazer.", event: { kind: "error", text: "Pedido de intervenção sem painel aberto." } };
    }

    if (call.name === "script_create" && args.name && args.code) {
      const now = Date.now();
      const script = {
        id: crypto.randomUUID(), name: args.name.slice(0, 120),
        description: args.description?.slice(0, 500) ?? "Criado pela Vela.",
        matches: args.matches?.length ? args.matches.slice(0, 20) : ["<all_urls>"],
        code: args.code, enabled: true, createdAt: now, updatedAt: now,
      };
      await saveScript(script);
      const text = `Script “${script.name}” salvo em Configurações → Scripts para revisão e execução manual.`;
      return { content: text, event: { kind: "result", text } };
    }

    const unknown = `ERRO [unsupported] Ferramenta ou argumentos inválidos: ${call.name}.`;
    return { content: unknown, event: { kind: "error", text: `Chamada inválida: ${call.name}.` } };
  } catch (error) {
    const text = error instanceof Error ? error.message : "Falha ao executar a ferramenta.";
    return { content: `ERRO [falha] ${text}`, event: { kind: "error", text } };
  }
}
