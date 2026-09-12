import { AgentEvent, AppSettings, TabSummary } from "./types";
import { runToolCall } from "./tool-runner";
import { isRestrictedUrl } from "./navigation";
import { TraceKind, readTrace } from "./trace";
import { loadSettings } from "./storage";

/**
 * Lado da extensão da ponte MCP. A extensão é sempre quem inicia a conexão, com long-polling
 * contra o processo `vela-bridge` em 127.0.0.1 — WebSocket exigiria liberar `ws://` no CSP e uma
 * dependência no processo local, enquanto `http://127.0.0.1:*` já está permitido.
 *
 * Nada aqui fura o gate de autonomia: `vela_act` passa pelo mesmo `runToolCall` da conversa, então
 * o modo Observar recusa e o modo Assistir espera a aprovação no painel.
 */
export type BridgeState = "off" | "connecting" | "on" | "offline" | "error";
export type BridgeStatus = { state: BridgeState; detail?: string; connectedAt?: number; calls: number; port?: number };

type Command = { id: string; tool: string; params: Record<string, unknown> };
type CommandResult = { id: string; ok: boolean; content: string };
type Hooks = { emit: (event: AgentEvent) => void; ask: (prompt: string) => Promise<string> };

const POLL_BACKOFF = [1_000, 2_000, 5_000, 10_000, 20_000];
const ALARM = "vela:bridge-keepalive";
/** Quantas portas acima da configurada a ponte pode ter escolhido. Igual à faixa do processo. */
const PORT_RANGE = 8;

let hooks: Hooks | null = null;
let status: BridgeStatus = { state: "off", calls: 0 };
let generation = 0;
let pollAbort: AbortController | null = null;
let poked = false;

export const bridgeStatus = () => status;
export function configureBridge(next: Hooks) { hooks = next; }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const poke = () => { poked = true; pollAbort?.abort(); };

function announce(text: string, kind: AgentEvent["kind"] = "status") {
  hooks?.emit({ kind, text });
}

/** Liga ou desliga conforme as preferências. Chamado no arranque e a cada mudança de settings. */
export async function syncBridge(settings?: AppSettings) {
  const current = settings ?? await loadSettings();
  const wanted = current.bridge.enabled && !!current.bridge.token;
  if (!wanted) { stopBridge(); return; }
  if (status.state === "on" || status.state === "connecting") return;
  startBridge(current);
}

export function stopBridge() {
  generation += 1;
  pollAbort?.abort();
  pollAbort = null;
  status = { state: "off", calls: 0 };
  void chrome.alarms?.clear(ALARM);
}

function startBridge(settings: AppSettings) {
  generation += 1;
  status = { state: "connecting", calls: 0 };
  void chrome.alarms?.create(ALARM, { periodInMinutes: 1 });
  void pump(generation, settings.bridge.port, settings.bridge.token);
}

/** O service worker morre com 30 s ociosos; o alarme o acorda e reata o long-poll. */
export function onKeepAliveAlarm(name: string) {
  if (name !== ALARM) return;
  if (status.state === "off") return;
  void syncBridge();
}

/**
 * Acha a ponte quando a porta configurada não responde.
 *
 * O processo `vela-bridge` anda pela faixa quando a porta preferida está ocupada — outra instância,
 * ou qualquer coisa da máquina. Sem esta sondagem, a extensão ficava batendo para sempre numa porta
 * vazia e o usuário tinha de descobrir o número no log e trocar à mão nos dois lados.
 *
 * `/hello` responde na hora (o `/poll` fica pendurado 25 s, não serve para perguntar "você está
 * aí?"), e o token é o que impede adotar um servidor qualquer que por acaso esteja na faixa: 401 é
 * uma ponte de outro token, e essa não é a nossa.
 */
async function discoverPort(base: number, token: string): Promise<number | null> {
  for (let port = base; port < base + PORT_RANGE; port += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/hello`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(700),
      });
      if (!response.ok) continue;
      const payload = await response.json() as { vela?: string };
      if (payload.vela === "bridge") return port;
    } catch { /* porta vazia, ou coisa que não é a ponte */ }
  }
  return null;
}

async function pump(mine: number, base: number, token: string) {
  let port = base;
  const outbox: CommandResult[] = [];
  let failures = 0;

  while (mine === generation) {
    pollAbort = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/poll`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ results: outbox.splice(0) }),
        signal: pollAbort.signal,
      });

      if (response.status === 401) {
        status = { state: "error", detail: "A ponte recusou o token. Gere um novo e reinicie o processo vela-bridge.", calls: status.calls, port };
        generation += 1;
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json() as { commands?: Command[] };
      if (status.state !== "on") {
        status = { state: "on", connectedAt: Date.now(), calls: status.calls, port };
        announce("Ponte MCP conectada. Um agente externo pode usar a Vela.");
      }
      failures = 0;

      for (const command of payload.commands ?? []) {
        void run(command).then((result) => { outbox.push(result); poke(); });
      }
    } catch (error) {
      if (poked) { poked = false; continue; }
      if (mine !== generation) return;

      /*
       * Antes de declarar offline: a ponte pode estar viva numa porta vizinha.
       *
       * A varredura parte sempre da porta **configurada**, nunca da que está em uso. A porta das
       * preferências é a intenção do usuário; a que vale agora é consequência de quem chegou
       * primeiro, e por isso vive em `status.port` e não nas settings. Se a descoberta gravasse nas
       * preferências, o ponto de partida andaria junto — e quando a porta preferida voltasse a
       * vagar, a extensão procuraria só acima dela e nunca mais acharia a ponte que voltou para casa.
       *
       * Só reata sem esperar quando a ponte mudou de lugar: se ela responde na mesma porta que
       * acabou de falhar, o problema é outro, e voltar direto ao laço viraria giro em falso.
       */
      const achada = await discoverPort(base, token);
      if (achada !== null && achada !== port && mine === generation) {
        announce(`A porta ${port} não respondeu; a ponte está na ${achada}.`);
        port = achada;
        status = { ...status, port };
        failures = 0;
        continue;
      }

      const detail = error instanceof Error ? error.message : "falha de rede";
      status = { state: "offline", detail: `O processo vela-bridge não respondeu (${detail}).`, calls: status.calls, port };
      await sleep(POLL_BACKOFF[Math.min(failures, POLL_BACKOFF.length - 1)]);
      failures += 1;
    }
  }
}

const LABELS: Record<string, string> = {
  vela_trace: "leu a trilha",
  vela_read_page: "leu a página",
  vela_act: "agiu na página",
  vela_search: "buscou na web",
  vela_fetch: "leu uma URL",
  vela_tabs: "listou as abas",
  vela_ask: "delegou uma tarefa",
};

async function run(command: Command): Promise<CommandResult> {
  status = { ...status, calls: status.calls + 1 };
  try {
    const content = await execute(command);
    announce(`Agente externo ${LABELS[command.tool] ?? command.tool}.`);
    return { id: command.id, ok: !content.startsWith("ERRO ["), content };
  } catch (error) {
    const text = error instanceof Error ? error.message : "Falha ao executar o pedido do agente externo.";
    announce(`Agente externo falhou: ${text}`, "error");
    return { id: command.id, ok: false, content: `ERRO [falha] ${text}` };
  }
}

async function execute(command: Command): Promise<string> {
  const settings = await loadSettings();
  const params = command.params ?? {};

  if (command.tool === "vela_ask") {
    const prompt = String(params.prompt ?? "").trim();
    if (!prompt) return "ERRO [unsupported] vela_ask precisa de um prompt.";
    if (!hooks) return "ERRO [falha] A ponte não foi inicializada.";
    return hooks.ask(prompt);
  }

  if (command.tool === "vela_trace") {
    const events = await readTrace({
      limit: Number(params.limit ?? 120),
      kinds: Array.isArray(params.kinds) ? params.kinds as TraceKind[] : undefined,
      search: typeof params.search === "string" ? params.search : undefined,
    });
    const wanted = params.onlyFailures ? events.filter((event) => event.ok === false) : events;
    if (!wanted.length) return "A trilha não tem eventos que batam com esse filtro.";
    return wanted.map((event) => {
      const parts = [new Date(event.at).toISOString().slice(11, 23), event.kind, event.label];
      if (event.ms !== undefined) parts.push(`${event.ms}ms`);
      if (event.ok === false) parts.push(`FALHOU${event.code ? ` [${event.code}]` : ""}`);
      return parts.join(" · ");
    }).join("\n");
  }

  if (command.tool === "vela_tabs") {
    const query = settings.context.outsideTabs ? {} : { lastFocusedWindow: true };
    const tabs = await chrome.tabs.query(query);
    const visible = tabs.flatMap<TabSummary>((tab) => tab.id === undefined || !tab.url || isRestrictedUrl(tab.url)
      ? []
      : [{ tabId: tab.id, title: (tab.title ?? "").slice(0, 80), url: tab.url, active: !!tab.active }]);
    if (!visible.length) return "Nenhuma aba visível para a Vela.";
    return visible.map((tab) => `[${tab.tabId}]${tab.active ? " (ativa)" : ""} ${tab.title} — ${tab.url}`).join("\n");
  }

  const call = toToolCall(command.tool, params);
  if (!call) return `ERRO [unsupported] Ferramenta desconhecida: ${command.tool}.`;
  const { content } = await runToolCall(call, settings);
  return content;
}

function toToolCall(tool: string, params: Record<string, unknown>) {
  const wrap = (name: string, args: unknown) => ({ id: `bridge-${Date.now()}`, name, arguments: JSON.stringify(args) });
  if (tool === "vela_read_page") return wrap("browser_action", { action: "extractPage", extractMode: params.mode, offset: params.offset });
  if (tool === "vela_act") return wrap("browser_action", params);
  if (tool === "vela_search") return wrap("web_search", params);
  if (tool === "vela_fetch") return wrap("web_fetch", params);
  return null;
}
