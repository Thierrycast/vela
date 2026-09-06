/**
 * Faz a UI real da Vela rodar fora da extensão, em localhost, para ferramentas de review de
 * interface — que não conseguem abrir páginas `chrome-extension://`.
 *
 * Não é um mock de conveniência: é a mesma UI, os mesmos componentes e o mesmo CSS. Só o
 * `chrome.*` é substituído por um dublê que responde estado realista.
 */
import { AgentEvent, ChatMessage, defaultSettings } from "../../src/types";

type Listener = (message: unknown) => void;

const params = new URLSearchParams(location.search);
const scenario = params.get("estado") ?? "conversa";

// A barra lateral do Chrome é redimensionável; o review pode fixar a largura que quiser.
const larguraPedida = Number(params.get("largura"));
if (Number.isFinite(larguraPedida) && larguraPedida >= 260 && larguraPedida <= 640) {
  document.documentElement.style.setProperty("--largura-do-painel", `${larguraPedida}px`);
}

const settings = {
  ...defaultSettings,
  brand: { ...defaultSettings.brand, appName: "Vela" },
  providers: [{ ...defaultSettings.providers[0], apiKey: "chave-de-exemplo", defaultModel: "auto/best-coding" }],
};

const message = (role: ChatMessage["role"], content: string): ChatMessage =>
  ({ id: crypto.randomUUID(), role, content, createdAt: Date.now(), status: "complete" });

const conversation: ChatMessage[] = scenario === "vazio" ? [] : [
  message("user", "pesquise notebooks bons para desenvolvimento e abra o primeiro resultado"),
  message("assistant", "Encontrei três opções bem avaliadas. Abri a primeira: um notebook com 32 GB de RAM e tela de 14 polegadas, por R$ 8.400. Quer que eu compare com as outras duas antes de você decidir?"),
  message("user", "compara sim"),
  message("assistant", "Comparando as três agora. A diferença principal está na tela e na garantia — vou abrir cada uma e trazer os números."),
];

const events: AgentEvent[] = scenario === "vazio" ? [] : [
  { kind: "result", text: "Busca: 5 resultado(s) para “notebook desenvolvimento”." },
  { kind: "result", text: "Abri https://loja.exemplo.com/notebook-pro. Chame extractPage para ler a página." },
  { kind: "result", text: "Página lida em 2 frame(s)." },
  { kind: "result", text: "Cliquei em button “Ver especificações” — a página reagiu." },
  { kind: "error", text: "O snapshot mudou. Chame extractPage de novo antes de agir." },
];

// Mesmo formato que attachmentText() produz: cabeçalho, quebra de linha, texto.
const SAMPLE_ATTACHMENT = "Trecho selecionado em “Loja Exemplo” (https://loja.exemplo.com):\nO frete grátis vale para pedidos acima de R$ 299 em todo o Brasil.";

const panelMessages: unknown[] = [
  { type: "chat:snapshot", messages: conversation, events, telemetry: ["omniroute · 842 ms"], running: scenario === "executando" },
  { type: "chat:session", title: scenario === "vazio" ? "" : "pesquise notebooks bons para de", tabCount: 3 },
  { type: "chat:attachments", items: scenario === "vazio" ? [] : [SAMPLE_ATTACHMENT] },
];

if (scenario === "aprovacao") {
  panelMessages.push({ type: "chat:approval", request: { id: "a1", summary: "Clicar em “Finalizar compra”", detail: "https://loja.exemplo.com" } });
}
if (scenario === "suavez") {
  panelMessages.push({ type: "chat:takeover", reason: "A loja pede login para concluir o pedido.", expected: "Entre na sua conta e clique em Retomar." });
}

const store: Record<string, unknown> = {
  "vela:settings": settings,
  "vela:brand-renamed": true,
  "vela:logs": events.map((event, index) => ({ id: String(index), level: event.kind === "error" ? "error" : "info", event: event.kind === "error" ? "agent.tool_error" : "agent.tool_completed", createdAt: Date.now() - index * 60_000 })),
  "vela:action-stats": { total: 46, noEffect: 4, failures: 3, byCode: { stale_snapshot: 2, element_not_found: 1 }, byType: { click: 22, type: 9, extractPage: 15 }, since: Date.now() - 86_400_000 },
};

const noop = () => undefined;
const listeners: Listener[] = [];

(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    id: "preview",
    getManifest: () => ({ version: "0.1.0", name: "Vela" }),
    openOptionsPage: () => { location.href = "/options.html"; },
    sendMessage: async () => undefined,
    lastError: undefined,
    onMessage: { addListener: (fn: Listener) => listeners.push(fn), removeListener: noop },
    connect: () => {
      const inbound: Listener[] = [];
      setTimeout(() => { for (const item of panelMessages) for (const fn of inbound) fn(item); }, 60);
      return {
        name: "vela:sidecar",
        postMessage: (outgoing: { type: string; text?: string }) => {
          if (outgoing.type !== "chat:submit" || !outgoing.text) return;
          const sent = message("user", outgoing.text);
          for (const fn of inbound) fn({ type: "chat:message", message: sent });
          const reply: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "", createdAt: Date.now(), status: "streaming" };
          for (const fn of inbound) fn({ type: "chat:message", message: reply });
          const texto = "Esta é a UI de review: o provider não é chamado aqui. Todo o resto — estados, movimento e layout — é o mesmo da extensão.";
          let index = 0;
          const timer = setInterval(() => {
            const chunk = texto.slice(index, index + 3);
            index += 3;
            for (const fn of inbound) fn({ type: "chat:delta", id: reply.id, text: chunk });
            if (index >= texto.length) { clearInterval(timer); for (const fn of inbound) fn({ type: "chat:patch", id: reply.id, patch: { status: "complete" } }); }
          }, 24);
        },
        disconnect: noop,
        onMessage: { addListener: (fn: Listener) => inbound.push(fn), removeListener: noop },
        onDisconnect: { addListener: noop, removeListener: noop },
      };
    },
  },
  storage: {
    local: {
      get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
      set: async (values: Record<string, unknown>) => { Object.assign(store, values); },
      remove: async (key: string) => { delete store[key]; },
    },
    session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    onChanged: { addListener: noop, removeListener: noop },
  },
  permissions: { getAll: async () => ({ permissions: ["tabs", "scripting", "webNavigation", "tabGroups", "offscreen", "notifications", "storage", "sidePanel", "activeTab"] }) },
  commands: { getAll: async () => [{ name: "toggle-side-panel", shortcut: "Alt+V" }] },
  tabs: { query: async () => [{ id: 1, url: "https://loja.exemplo.com", title: "Loja Exemplo", active: true }], create: async () => ({ id: 2 }), sendMessage: async () => undefined },
};
