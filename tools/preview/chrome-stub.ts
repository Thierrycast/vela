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

/*
 * `?estado=novo` é quem acabou de instalar: sem provider, sem modelo, sem nada configurado.
 *
 * É o estado mais difícil de ver durante o desenvolvimento (a máquina de quem desenvolve está
 * sempre configurada) e o primeiro que qualquer pessoa encontra.
 */
const recemInstalada = scenario === "novo";

const settings = {
  ...defaultSettings,
  brand: { ...defaultSettings.brand, appName: "Vela" },
  providers: [{ ...defaultSettings.providers[0], apiKey: recemInstalada ? "" : "chave-de-exemplo", defaultModel: recemInstalada ? "" : "auto/best-coding" }],
  bridge: { enabled: true, port: 8792, token: "3f9c1ad24b7e40aab2e6c8d51f07be93", scriptPath: "C:\\Users\\voce\\projetos\\browser-ai\\bridge\\vela-bridge.mjs" },
};

const message = (role: ChatMessage["role"], content: string): ChatMessage =>
  ({ id: crypto.randomUUID(), role, content, createdAt: Date.now(), status: "complete" });

const conversation: ChatMessage[] = scenario === "vazio" || recemInstalada ? [] : [
  message("user", "pesquise notebooks bons para desenvolvimento e abra o primeiro resultado"),
  message("assistant", "Encontrei três opções bem avaliadas. Abri a primeira: um notebook com 32 GB de RAM e tela de 14 polegadas, por R$ 8.400. Quer que eu compare com as outras duas antes de você decidir?"),
  message("user", "compara sim"),
  message("assistant", [
    "Comparando as três agora:",
    "",
    "### Quadro comparativo",
    "",
    "| Modelo | RAM | Tela | Preço |",
    "|---|---|---|---|",
    "| **Notebook Pro** | 32 GB | 14\" | R$ 8.400 |",
    "| **Ultra 14** | 16 GB | 14\" | R$ 6.900 |",
    "| **Studio 15** | 32 GB | 15,6\" | R$ 9.100 |",
    "",
    "Alguns pontos que pesam:",
    "",
    "- O *Ultra 14* é o único com 16 GB — apertado para rodar `docker` e IDE juntos",
    "- O **Studio 15** tem a melhor tela, mas é 300 g mais pesado",
    "- Só o Pro tem garantia de 3 anos ([ver política](https://exemplo.com/garantia))",
    "",
    "```js",
    "const melhorCustoBeneficio = modelos",
    "  .filter((item) => item.ram >= 32)",
    "  .sort((primeiro, segundo) => primeiro.preco - segundo.preco)[0];",
    "```",
    "",
    "> Os três estavam em estoque agora há pouco.",
    "",
    "---",
    "",
    "Quer que eu abra algum deles?",
  ].join("\n")),
];

const events: AgentEvent[] = scenario === "vazio" || recemInstalada ? [] : [
  { kind: "result", text: "Busca: 5 resultado(s) para “notebook desenvolvimento”." },
  { kind: "result", text: "Abri https://loja.exemplo.com/notebook-pro. Chame extractPage para ler a página." },
  { kind: "result", text: "Página lida em 2 frame(s)." },
  { kind: "result", text: "Cliquei em button “Ver especificações” — a página reagiu." },
  { kind: "error", text: "Esse elemento agora é outro: quando você o leu era “Pedido #1043”. Chame find com esse texto." },
  { kind: "error", text: "Configure o servidor de voz em Configurações → Voz." },
];

// Mesmo formato que attachmentText() produz: cabeçalho, quebra de linha, texto.
const SAMPLE_ATTACHMENT = "Trecho selecionado em “Loja Exemplo” (https://loja.exemplo.com):\nO frete grátis vale para pedidos acima de R$ 299 em todo o Brasil.";

const panelMessages: unknown[] = [
  { type: "chat:snapshot", messages: conversation, events, telemetry: ["omniroute · 842 ms"], running: scenario === "executando" },
  { type: "chat:session", title: scenario === "vazio" || recemInstalada ? "" : "pesquise notebooks bons para de", tabCount: recemInstalada ? 0 : 3 },
  { type: "chat:attachments", items: scenario === "vazio" || recemInstalada ? [] : [SAMPLE_ATTACHMENT] },
  // Histórico com títulos longos: é onde o menu de conversas quebrava.
  { type: "chat:history", items: [
    { id: "h1", title: "Leia esta página e me diga o que dá para fazer aqui", updatedAt: Date.now() },
    { id: "h2", title: "scrole para baixo", updatedAt: Date.now() - 3_600_000 },
    { id: "h3", title: "clique no quarto item e vá até os comentários", updatedAt: Date.now() - 7_200_000 },
    { id: "h4", title: "Leia esta página e me diga o que dá para fazer aqui", updatedAt: Date.now() - 10_800_000 },
    { id: "h5", title: "Leia esta página e me diga o que dá para fazer aqui", updatedAt: Date.now() - 14_400_000 },
    { id: "h6", title: "pesquise notebooks bons para desenvolvimento", updatedAt: Date.now() - 18_000_000 },
  ] },
];

if (scenario === "aprovacao") {
  panelMessages.push({ type: "chat:approval", request: { id: "a1", summary: "Clicar em “Finalizar compra”", detail: "https://loja.exemplo.com" } });
}
if (scenario === "voz") {
  panelMessages.push({ type: "voice:state", state: "listening" });
  // Telemetria falsa em 20Hz: o palco escuta o runtime, então o dublê precisa emitir de verdade.
  const inicio = Date.now();
  setInterval(() => {
    const segundos = (Date.now() - inicio) / 1000;
    const onda = (Math.sin(segundos * 1.9) * 0.5 + 0.5) * (Math.sin(segundos * 0.7) * 0.5 + 0.5);
    for (const fn of listeners) fn({ type: "voice:telemetry", telemetry: { state: "listening", metrics: { energy: onda, bass: onda * 0.7, mid: onda * 0.8, high: onda * 0.4, speaking: onda > 0.2 } } });
  }, 50);
}
if (scenario === "suavez") {
  panelMessages.push({ type: "chat:takeover", reason: "A loja pede login para concluir o pedido.", expected: "Entre na sua conta e clique em Retomar." });
}

const userScript = (lines: string[]) => lines.join("\n");

const sampleScripts = [
  {
    id: "s1",
    enabled: true,
    createdAt: Date.now() - 12 * 86_400_000,
    updatedAt: Date.now() - 3 * 3_600_000,
    code: userScript([
      "// ==UserScript==",
      "// @name         Preço por grama",
      "// @version      1.4",
      "// @description  Calcula e mostra o preço por grama ao lado de cada produto da listagem.",
      "// @match        https://loja.exemplo.com/*",
      "// @run-at       document-idle",
      "// ==/UserScript==",
      "",
      "const cards = document.querySelectorAll(\".produto\");",
      "return cards.length;",
    ]),
  },
  {
    id: "s2",
    enabled: false,
    createdAt: Date.now() - 2 * 86_400_000,
    updatedAt: Date.now() - 40 * 60_000,
    code: userScript([
      "// ==UserScript==",
      "// @name         Limpar distrações",
      "// @version      1.0",
      "// @description  Esconde banners, pop-ups de newsletter e barras fixas em qualquer página.",
      "// @match        <all_urls>",
      "// ==/UserScript==",
      "",
      "return document.title;",
    ]),
  },
  {
    id: "s3",
    enabled: true,
    createdAt: Date.now() - 30 * 86_400_000,
    updatedAt: Date.now() - 9 * 86_400_000,
    code: userScript([
      "// ==UserScript==",
      "// @name         Copiar tabela como CSV",
      "// @version      2.1",
      "// @author       Vela",
      "// @description  Adiciona um botão que exporta a primeira tabela da página em CSV.",
      "// @match        https://relatorios.exemplo.com/*",
      "// @match        https://painel.exemplo.com/*",
      "// ==/UserScript==",
      "",
      "return \"CSV pronto\";",
    ]),
  },
];

const store: Record<string, unknown> = {
  "vela:settings": settings,
  "vela:brand-renamed": true,
  "vela:logs": events.map((event, index) => ({ id: String(index), level: event.kind === "error" ? "error" : "info", event: event.kind === "error" ? "agent.tool_error" : "agent.tool_completed", createdAt: Date.now() - index * 60_000 })),
  "vela:user-scripts": sampleScripts,
  "vela:action-stats": { total: 46, noEffect: 4, failures: 3, turns: 9, rounds: 31, toolCalls: 46, batchItems: 12, byCode: { ref_changed: 2, element_not_found: 1 }, byType: { click: 22, type: 9, extractPage: 15 }, since: Date.now() - 86_400_000 },
};

const noop = () => undefined;
const listeners: Listener[] = [];

(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    id: "preview",
    getManifest: () => ({ version: "0.1.0", name: "Vela" }),
    openOptionsPage: () => { location.href = "/options.html"; },
    sendMessage: async (outgoing: { type?: string } = {}) => outgoing.type === "bridge:status" ? { state: "on", connectedAt: Date.now() - 420_000, calls: 12 } : undefined,
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
      get: async (key: string | string[] | null) => {
        if (key === null || key === undefined) return { ...store };
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.filter((item) => item in store).map((item) => [item, store[item]]));
      },
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
