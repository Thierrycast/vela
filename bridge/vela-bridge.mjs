#!/usr/bin/env node
/**
 * Ponte entre a extensão Vela e agentes que falam MCP (Codex, Claude Code, e afins).
 *
 * São dois servidores no mesmo processo:
 *   - MCP por stdio, que é o que o agente de fora enxerga;
 *   - HTTP em 127.0.0.1, que é como a extensão se conecta.
 *
 * A extensão é quem inicia a conexão, por long-polling: um `POST /poll` fica pendurado até
 * aparecer comando ou estourar o tempo. Isso evita WebSocket — que exigiria uma dependência e
 * uma mudança no CSP da extensão, onde `ws://` não está liberado e `http://127.0.0.1:*` está.
 *
 * Sem dependências: só `node:http` e `node:crypto`.
 */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).flatMap((item) => {
  const match = /^--([^=]+)=(.*)$/.exec(item);
  return match ? [[match[1], match[2]]] : [];
}));

const PORT = Number(args.port ?? process.env.VELA_BRIDGE_PORT ?? 8792);
const TOKEN = args.token ?? process.env.VELA_BRIDGE_TOKEN ?? "";
const POLL_TIMEOUT = 25_000;
const CALL_TIMEOUT = 180_000;
const OFFLINE_AFTER = 40_000;

if (!TOKEN) {
  process.stderr.write([
    "vela-bridge: falta o token.",
    "",
    "Abra a Vela → Configurações → Ponte MCP, copie o token e passe-o em",
    "VELA_BRIDGE_TOKEN (ou --token=...). Sem isso qualquer processo da máquina",
    "poderia dirigir o seu navegador logado.",
    "",
  ].join("\n"));
  process.exit(1);
}

const log = (text) => process.stderr.write(`vela-bridge: ${text}\n`);

const state = {
  queue: [],
  waiting: [],
  pending: new Map(),
  lastPollAt: 0,
};

const isOnline = () => Date.now() - state.lastPollAt < OFFLINE_AFTER;

function flushQueue() {
  while (state.waiting.length && state.queue.length) {
    const response = state.waiting.shift();
    clearTimeout(response.timer);
    respond(response.http, 200, { commands: state.queue.splice(0, 8) });
  }
}

/** Enfileira um comando para a extensão e espera o resultado dela. */
function callExtension(tool, params) {
  if (!isOnline()) return Promise.reject(new Error("A extensão Vela não está conectada a esta ponte. Abra o Chrome e ligue a ponte em Configurações → Ponte MCP."));
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error("A extensão não respondeu a tempo. Uma aprovação pendente no painel da Vela pode estar segurando a ação."));
    }, CALL_TIMEOUT);
    state.pending.set(id, { resolve, reject, timer });
    state.queue.push({ id, tool, params });
    flushQueue();
  });
}

// --- HTTP local: o lado da extensão -------------------------------------------------

const respond = (http, status, body) => {
  const payload = JSON.stringify(body);
  http.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  http.end(payload);
};

function authorized(request) {
  const header = request.headers.authorization ?? "";
  const offered = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(TOKEN);
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

const readBody = (request) => new Promise((resolve) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); }
  });
});

const httpServer = createServer(async (request, http) => {
  if (request.method === "OPTIONS") {
    http.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "POST" });
    http.end();
    return;
  }
  if (!authorized(request)) return respond(http, 401, { error: "token inválido" });
  http.setHeader("access-control-allow-origin", "*");

  if (request.method !== "POST" || !request.url.startsWith("/poll")) return respond(http, 404, { error: "rota desconhecida" });

  const body = await readBody(request);
  const first = state.lastPollAt === 0;
  state.lastPollAt = Date.now();
  if (first) log("extensão conectada.");

  for (const result of body.results ?? []) {
    const entry = state.pending.get(result.id);
    if (!entry) continue;
    clearTimeout(entry.timer);
    state.pending.delete(result.id);
    entry.resolve(result);
  }

  if (state.queue.length) return respond(http, 200, { commands: state.queue.splice(0, 8) });

  const waiter = { http, timer: 0 };
  waiter.timer = setTimeout(() => {
    state.waiting = state.waiting.filter((item) => item !== waiter);
    respond(http, 200, { commands: [] });
  }, POLL_TIMEOUT);
  state.waiting.push(waiter);
  http.on("close", () => {
    clearTimeout(waiter.timer);
    state.waiting = state.waiting.filter((item) => item !== waiter);
  });
});

httpServer.on("error", (error) => {
  log(error.code === "EADDRINUSE"
    ? `a porta ${PORT} já está em uso. Feche a outra ponte ou escolha outra porta com --port=.`
    : `falha no servidor local: ${error.message}`);
  process.exit(1);
});
httpServer.listen(PORT, "127.0.0.1", () => log(`ouvindo em http://127.0.0.1:${PORT} — aguardando a extensão.`));

// --- MCP por stdio: o lado do agente de fora ----------------------------------------

const TEXT = { type: "string" };

const TOOLS = [
  {
    name: "vela_read_page",
    description: "Lê a aba ativa do Chrome do usuário e devolve título, URL, estrutura e a lista de elementos interativos, cada um com um identificador [ref_N_M]. Use estes refs em vela_act. Campos sensíveis (senha, código de verificação, cartão) chegam como [valor omitido].",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["outline", "text"], description: "outline devolve os elementos interativos; text devolve o conteúdo legível." },
        offset: { type: "number", description: "Continuação de uma leitura truncada." },
      },
    },
  },
  {
    name: "vela_act",
    description: "Age na aba ativa do Chrome do usuário. Os refs vêm da última chamada de vela_read_page e expiram quando a página muda. O modo de autonomia configurado na Vela continua valendo: em Observar a ação é recusada, e em Assistir ela espera aprovação humana no painel.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "click", "type", "keyPress", "scroll", "wait", "pageTool"] },
        url: { ...TEXT, description: "Para navigate." },
        newTab: { type: "boolean" },
        ref: { ...TEXT, description: "Identificador do elemento, como ref_3_12." },
        text: { ...TEXT, description: "Para type." },
        submit: { type: "boolean", description: "Envia o formulário depois de digitar." },
        mode: { type: "string", enum: ["replace", "append"] },
        key: { ...TEXT, description: "Para keyPress, como Enter ou Escape." },
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        milliseconds: { type: "number", description: "Para wait." },
        toolName: { ...TEXT, description: "Para pageTool: nome exato da ferramenta oferecida pela página." },
        toolArguments: { type: "object", description: "Argumentos da ferramenta da página." },
      },
      required: ["action"],
    },
  },
  {
    name: "vela_search",
    description: "Busca na web usando o provider configurado na Vela (OmniRoute), sem abrir aba.",
    inputSchema: { type: "object", properties: { query: TEXT, max_results: { type: "number" } }, required: ["query"] },
  },
  {
    name: "vela_fetch",
    description: "Lê o conteúdo de uma URL pelo provider da Vela, sem abrir aba no navegador do usuário.",
    inputSchema: { type: "object", properties: { url: TEXT, max_length: { type: "number" } }, required: ["url"] },
  },
  {
    name: "vela_tabs",
    description: "Lista as abas que a Vela enxerga no Chrome do usuário, respeitando as preferências de contexto dela.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vela_trace",
    description: "Lê a trilha de execução da Vela: requisições ao modelo, chamadas de ferramenta, ações na página e falhas, com duração. Use para descobrir o que ficou lento ou o que falhou, em vez de adivinhar pelo resultado final.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Quantos eventos mais recentes trazer. Padrão 120." },
        kinds: { type: "array", items: TEXT, description: "Filtra por tipo: turn, user.input, model.request, tool.call, action, error." },
        onlyFailures: { type: "boolean", description: "Só o que falhou." },
        search: TEXT,
      },
    },
  },
  {
    name: "vela_ask",
    description: "Delega uma tarefa inteira à Vela: ela usa o modelo configurado nela e o navegador logado do usuário, executa os passos e devolve a resposta final. Prefira esta ferramenta quando o objetivo é o resultado, não o controle passo a passo.",
    inputSchema: { type: "object", properties: { prompt: { ...TEXT, description: "O objetivo em uma ou duas frases, como você pediria a uma pessoa." } }, required: ["prompt"] },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function callTool(name, args) {
  if (!TOOLS.some((tool) => tool.name === name)) throw new Error(`Ferramenta desconhecida: ${name}`);
  const result = await callExtension(name, args ?? {});
  return { content: [{ type: "text", text: result.content ?? "" }], isError: result.ok === false };
}

async function dispatch(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "vela-bridge", version: "0.1.0" },
      instructions: "A Vela é uma extensão do Chrome do usuário. Leia a página com vela_read_page antes de agir com vela_act, e use os refs exatamente como vieram. Para tarefas inteiras, prefira vela_ask.",
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    try {
      return reply(id, await callTool(params?.name, params?.arguments));
    } catch (error) {
      return reply(id, { content: [{ type: "text", text: error.message }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `Método não suportado: ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let cut = buffer.indexOf("\n");
  while (cut >= 0) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (line) {
      try { void dispatch(JSON.parse(line)); } catch { log("linha ilegível no stdin, ignorada."); }
    }
    cut = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
