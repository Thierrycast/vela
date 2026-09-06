#!/usr/bin/env node
/**
 * Dirige a Vela como se fosse uma pessoa e devolve a trilha do que aconteceu.
 *
 * Existe porque testar um agente lendo a resposta final não diz nada sobre o caminho: onde
 * demorou, qual ação não surtiu efeito, quantas rodadas foram gastas. Aqui um roteiro é executado
 * do lado de fora — Chrome real, extensão real, página real — e a saída é o trace, não uma
 * captura de tela.
 *
 * Uso:
 *   node tools/drive.mjs                          # roteiro padrão
 *   node tools/drive.mjs --roteiro=meu.json       # roteiro próprio
 *   node tools/drive.mjs --manter                 # não fecha o Chrome no fim
 *   node tools/drive.mjs --saida=trace.jsonl      # grava a trilha
 *
 * Um roteiro é uma lista de passos:
 *   { "acao": "abrirPagina", "url": "https://exemplo.com" }
 *   { "acao": "definirSettings", "patch": { "agent": { "autonomy": "auto" } } }
 *   { "acao": "digitar", "texto": "leia esta página" }
 *   { "acao": "clicar", "seletor": "[aria-label=\"Nova conversa\"]" }
 *   { "acao": "esperar", "ms": 3000 }
 *   { "acao": "esperarParar", "ate": 60000 }
 *   { "acao": "conferir", "js": "document.querySelectorAll('.message').length > 0", "nome": "há mensagens" }
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.VELA_CHROME ?? [process.env["ProgramFiles"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"].join("\\");
const PORT = 9350;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const flags = Object.fromEntries(process.argv.slice(2).map((item) => {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(item);
  return match ? [match[1], match[2] ?? true] : [item, true];
}));

const ROTEIRO_PADRAO = [
  { acao: "definirSettings", patch: { agent: { autonomy: "auto", maxRounds: 4 } } },
  { acao: "abrirPagina", url: "https://example.com" },
  { acao: "esperar", ms: 1500 },
  { acao: "digitar", texto: "leia esta página e me diga o título" },
  { acao: "esperarParar", ate: 90_000 },
  { acao: "conferir", nome: "a Vela respondeu", js: "document.querySelectorAll('.message.assistant').length > 0" },
];

const roteiro = flags.roteiro ? JSON.parse(readFileSync(String(flags.roteiro), "utf8")) : ROTEIRO_PADRAO;

// --- CDP mínimo ---------------------------------------------------------------------
let nextId = 0;
function connect(url) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(url);
    const waiting = new Map();
    const problems = [];
    socket.onmessage = (frame) => {
      const data = JSON.parse(frame.data);
      if (data.id && waiting.has(data.id)) {
        const entry = waiting.get(data.id);
        waiting.delete(data.id);
        data.error ? entry.reject(new Error(JSON.stringify(data.error))) : entry.resolve(data.result);
        return;
      }
      if (data.method === "Runtime.exceptionThrown") {
        const detail = data.params.exceptionDetails;
        problems.push(String(detail.exception?.description ?? detail.text).split("\n")[0]);
      }
    };
    socket.onerror = fail;
    socket.onopen = () => done({
      problems,
      send: (method, params = {}, sessionId) => new Promise((ok, no) => {
        const id = nextId += 1;
        waiting.set(id, { resolve: ok, reject: no });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      }),
      close: () => socket.close(),
    });
  });
}

async function version() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  throw new Error("O Chrome não abriu a porta de depuração.");
}

// --- sessão -------------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), "vela-drive-"));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check",
  // A janela fica visível de propósito: dá para acompanhar o roteiro rodando.
  "--window-position=60,60", "--window-size=1400,960",
  "about:blank",
], { detached: true, stdio: "ignore" });

const browser = await connect((await version()).webSocketDebuggerUrl);
const { id: extensionId } = await browser.send("Extensions.loadUnpacked", { path: join(REPO, "dist") });
console.log(`extensão carregada: ${extensionId}`);

await browser.send("Target.setDiscoverTargets", { discover: true });
await sleep(1500);

const attach = async (targetId) => {
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  await browser.send("Runtime.enable", {}, sessionId);
  return sessionId;
};
const evaluate = async (sessionId, expression) => {
  const result = await browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};

const { targetInfos } = await browser.send("Target.getTargets");
const worker = targetInfos.find((target) => target.type === "service_worker" && target.url.includes(extensionId));
if (!worker) throw new Error("O service worker da extensão não subiu.");
const workerSession = await attach(worker.targetId);

const { targetId: panelTarget } = await browser.send("Target.createTarget", { url: `chrome-extension://${extensionId}/index.html` });
const panelSession = await attach(panelTarget);
await browser.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false }, panelSession);
await sleep(2500);

// --- passos -------------------------------------------------------------------------
const resultados = [];

/** Digitar é no React: mexer só no `value` não dispara onChange, e a mensagem nunca sai. */
const DIGITAR = (texto) => `(async () => {
  const area = document.querySelector(".composer textarea");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(area, ${JSON.stringify(texto)});
  area.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((done) => setTimeout(done, 120));
  area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return "enviado";
})()`;

for (const [indice, passo] of roteiro.entries()) {
  const rotulo = `${indice + 1}. ${passo.acao}`;
  try {
    if (passo.acao === "definirSettings") {
      await evaluate(workerSession, `(async () => {
        const atual = (await chrome.storage.local.get("vela:settings"))["vela:settings"] ?? {};
        const patch = ${JSON.stringify(passo.patch ?? {})};
        const merged = { ...atual };
        for (const [chave, valor] of Object.entries(patch)) {
          merged[chave] = valor && typeof valor === "object" && !Array.isArray(valor) ? { ...(atual[chave] ?? {}), ...valor } : valor;
        }
        await chrome.storage.local.set({ "vela:settings": merged });
        return "ok";
      })()`);
      console.log(`${rotulo} → aplicado`);
    } else if (passo.acao === "abrirPagina") {
      await browser.send("Target.createTarget", { url: passo.url });
      await sleep(passo.ms ?? 2000);
      console.log(`${rotulo} → ${passo.url}`);
    } else if (passo.acao === "digitar") {
      await evaluate(panelSession, DIGITAR(passo.texto));
      console.log(`${rotulo} → "${passo.texto}"`);
    } else if (passo.acao === "clicar") {
      await evaluate(panelSession, `(() => { const alvo = document.querySelector(${JSON.stringify(passo.seletor)}); if (!alvo) throw new Error("sem alvo: ${passo.seletor}"); alvo.click(); return "ok"; })()`);
      console.log(`${rotulo} → ${passo.seletor}`);
    } else if (passo.acao === "esperar") {
      await sleep(passo.ms ?? 1000);
      console.log(`${rotulo} → ${passo.ms ?? 1000}ms`);
    } else if (passo.acao === "esperarParar") {
      const limite = Date.now() + (passo.ate ?? 60_000);
      let parado = false;
      while (Date.now() < limite) {
        await sleep(700);
        // O botão de parar só existe enquanto o loop roda: é o sinal mais honesto de "terminou".
        parado = !(await evaluate(panelSession, `!!document.querySelector(".send-button.stop")`));
        if (parado) break;
      }
      console.log(`${rotulo} → ${parado ? "terminou" : "ainda rodando ao estourar o tempo"}`);
    } else if (passo.acao === "conferir") {
      const valor = await evaluate(panelSession, `(() => { try { return !!(${passo.js}); } catch { return false; } })()`);
      resultados.push({ nome: passo.nome ?? passo.js, passou: valor });
      console.log(`${rotulo} → ${passo.nome ?? passo.js}: ${valor ? "passou" : "FALHOU"}`);
    } else {
      console.log(`${rotulo} → passo desconhecido, ignorado`);
    }
  } catch (error) {
    console.log(`${rotulo} → ERRO: ${error.message}`);
    resultados.push({ nome: rotulo, passou: false, erro: error.message });
  }
}

// --- colheita -----------------------------------------------------------------------
await sleep(1200);
const trilha = await evaluate(workerSession, `(async () => {
  const banco = await new Promise((done) => {
    const pedido = indexedDB.open("vela-trace", 1);
    pedido.onsuccess = () => done(pedido.result);
    pedido.onerror = () => done(null);
  });
  if (!banco) return "[]";
  const eventos = await new Promise((done) => {
    const pedido = banco.transaction("events", "readonly").objectStore("events").getAll();
    pedido.onsuccess = () => done(pedido.result);
    pedido.onerror = () => done([]);
  });
  return JSON.stringify(eventos);
})()`);

const eventos = JSON.parse(trilha);
console.log(`\n── trilha: ${eventos.length} evento(s)`);

const porTipo = {};
for (const evento of eventos) porTipo[evento.kind] = (porTipo[evento.kind] ?? 0) + 1;
console.log("  por tipo:", Object.entries(porTipo).map(([tipo, total]) => `${tipo}=${total}`).join(" "));

const lentos = eventos.filter((evento) => evento.ms !== undefined).sort((a, b) => b.ms - a.ms).slice(0, 5);
if (lentos.length) {
  console.log("  mais demorados:");
  for (const evento of lentos) console.log(`    ${evento.ms}ms  ${evento.kind}  ${evento.label}`);
}

const falhas = eventos.filter((evento) => evento.ok === false);
console.log(`  falhas: ${falhas.length}`);
for (const falha of falhas.slice(0, 8)) console.log(`    ${falha.kind} · ${falha.label}${falha.code ? ` [${falha.code}]` : ""}`);

if (browser.problems.length) console.log(`  exceções no painel: ${browser.problems.length}`, browser.problems.slice(0, 4));

if (flags.saida) {
  writeFileSync(String(flags.saida), eventos.map((evento) => JSON.stringify(evento)).join("\n"));
  console.log(`  trilha gravada em ${flags.saida}`);
}

const reprovados = resultados.filter((item) => !item.passou);
console.log(`\n${resultados.length - reprovados.length}/${resultados.length} verificações passaram`);

if (!flags.manter) {
  browser.close();
  spawn("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
  await sleep(700);
} else {
  console.log("\nChrome mantido aberto (--manter). Feche-o quando terminar.");
}

process.exit(reprovados.length ? 1 : 0);
