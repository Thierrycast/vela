#!/usr/bin/env node
/**
 * Capturas da interface, para o README e para revisão visual.
 *
 * Usa o mesmo servidor de preview do `npm run ui` — a interface de verdade, com o `chrome.*`
 * substituído por um dublê — porque ferramenta nenhuma consegue fotografar uma página
 * `chrome-extension://`. O que sai daqui é o painel como ele aparece na barra lateral, na largura
 * real, e não uma montagem.
 *
 *   node tools/capturar-telas.mjs                 # sobe o preview sozinho e captura tudo
 *   node tools/capturar-telas.mjs --manter        # deixa o Chrome aberto no fim
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.VELA_CHROME ?? [process.env["ProgramFiles"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"].join("\\");
const PORTA_CHROME = 9360;
const PORTA_UI = 5178;
const SAIDA = join(REPO, "docs", "imagens");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const manter = process.argv.includes("--manter");

/** Cada tela: rota do preview, tamanho e o nome do arquivo. */
const TELAS = [
  { arquivo: "painel.png", url: `http://127.0.0.1:${PORTA_UI}/panel.html`, largura: 420, altura: 900 },
  { arquivo: "painel-aprovacao.png", url: `http://127.0.0.1:${PORTA_UI}/panel.html?estado=aprovacao`, largura: 420, altura: 900 },
  { arquivo: "painel-primeira-vez.png", url: `http://127.0.0.1:${PORTA_UI}/panel.html?estado=novo`, largura: 420, altura: 900 },
  { arquivo: "opcoes.png", url: `http://127.0.0.1:${PORTA_UI}/options.html`, largura: 1180, altura: 860 },
  // O seletor de modelo aberto: é onde o menu vazava para fora do painel e empurrava a interface.
  { arquivo: "painel-modelos.png", url: `http://127.0.0.1:${PORTA_UI}/panel.html`, largura: 420, altura: 900, clicar: ".model-label" },
];

async function esperarPorta(url, tentativas = 120) {
  for (let tentativa = 0; tentativa < tentativas; tentativa += 1) {
    try { await fetch(url); return true; } catch { await sleep(250); }
  }
  throw new Error(`nada respondeu em ${url}`);
}

function conectar(url) {
  return new Promise((pronto, falhou) => {
    const socket = new WebSocket(url);
    const esperando = new Map();
    let proximo = 0;
    socket.onmessage = (quadro) => {
      const dados = JSON.parse(quadro.data);
      const entrada = esperando.get(dados.id);
      if (!entrada) return;
      esperando.delete(dados.id);
      dados.error ? entrada.no(new Error(JSON.stringify(dados.error))) : entrada.ok(dados.result);
    };
    socket.onerror = falhou;
    socket.onopen = () => pronto({
      envia: (method, params = {}, sessionId) => new Promise((ok, no) => {
        const id = (proximo += 1);
        esperando.set(id, { ok, no });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      }),
      fecha: () => socket.close(),
    });
  });
}

const ui = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "ui"], { cwd: REPO, stdio: "ignore", shell: process.platform === "win32" });
await esperarPorta(`http://127.0.0.1:${PORTA_UI}/panel.html`);

const perfil = mkdtempSync(join(tmpdir(), "vela-telas-"));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORTA_CHROME}`,
  `--user-data-dir=${perfil}`,
  "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars",
  "--window-position=60,60", "--window-size=1280,960",
  "about:blank",
], { detached: true, stdio: "ignore" });

const versao = await (async () => {
  for (let tentativa = 0; tentativa < 90; tentativa += 1) {
    try { return await (await fetch(`http://127.0.0.1:${PORTA_CHROME}/json/version`)).json(); } catch { await sleep(250); }
  }
  throw new Error("o Chrome não abriu a porta de depuração");
})();

const navegador = await conectar(versao.webSocketDebuggerUrl);
mkdirSync(SAIDA, { recursive: true });

for (const tela of TELAS) {
  const { targetId } = await navegador.envia("Target.createTarget", { url: tela.url });
  const { sessionId } = await navegador.envia("Target.attachToTarget", { targetId, flatten: true });
  // Escala 2 para a imagem não ficar borrada num monitor comum.
  await navegador.envia("Emulation.setDeviceMetricsOverride", { width: tela.largura, height: tela.altura, deviceScaleFactor: 2, mobile: false }, sessionId);
  await sleep(1400);
  if (tela.clicar) {
    await navegador.envia("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(tela.clicar)})?.click()` }, sessionId);
    await sleep(700);
  }
  const { data } = await navegador.envia("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(join(SAIDA, tela.arquivo), Buffer.from(data, "base64"));
  console.log(`${tela.arquivo} — ${tela.largura}×${tela.altura}`);
  await navegador.envia("Target.closeTarget", { targetId });
}

if (!manter) {
  navegador.fecha();
  spawn("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
  await sleep(500);
}
ui.kill();
process.exit(0);
