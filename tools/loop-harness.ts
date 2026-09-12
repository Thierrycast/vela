import * as agentLoop from "../src/agent-loop";
import * as conversation from "../src/conversation";
import { SidecarInbound } from "../src/messages";
import { ActionResult, AppSettings, BrowserAction, defaultSettings } from "../src/types";
import { configureApprovals, resolveApproval } from "../src/approvals";
import { addAttachment, listAttachments } from "../src/browser-context";

const emitted: SidecarInbound[] = [];
let autoDecision: "allow" | "deny" = "allow";
/** Quantas superfícies o painel falso simula. Zero é "ninguém conseguiu mostrar o cartão". */
let superficies = 1;
const emit = async (message: SidecarInbound) => {
  emitted.push(message);
  // Painel falso: responde a pedidos de aprovação imediatamente.
  if (message.type === "chat:approval" && superficies > 0) setTimeout(() => resolveApproval(message.request.id, autoDecision), 0);
  return superficies;
};
configureApprovals(emit);
const wire: string[] = [];

function sseStream(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
}

/** Página falsa: responde `agent:action` como o content script responderia. */
function fakePage(): (message: { type: string; action?: BrowserAction }, frameId?: number) => ActionResult | { ok: boolean } {
  let snapshotId = 0;
  return (message, frameId = 0) => {
    if (message.type === "agent:action" && message.action?.type === "extractPage") {
      snapshotId += 1;
      const nome = frameId === 0 ? "Continuar" : "Pagar agora";
      return { ok: true, summary: "lido", snapshotId, content: `# Elementos interativos
[ref_${snapshotId}_0]<button name="${nome}" />` };
    }
    if (message.type === "agent:action" && message.action && "ref" in message.action && message.action.ref) {
      return { ok: true, summary: `frame ${frameId} recebeu ${message.action.ref}` };
    }
    if (message.type === "agent:ping") return { ok: true };
    // O modo preciso pergunta onde o alvo está e, depois, se a página reagiu.
    if (message.type === "agent:locate") return { x: 120, y: 340 } as unknown as ActionResult;
    if (message.type === "agent:watch") return { mutated: true, navigated: false } as unknown as ActionResult;
    if (message.type !== "agent:action" || !message.action) return { ok: true };
    const action = message.action;
    if (action.type === "click" && action.ref && !action.ref.startsWith(`ref_${snapshotId}_`)) {
      return { ok: false, code: "stale_snapshot", summary: "O snapshot mudou. Chame extractPage de novo antes de agir." };
    }
    // O alvo que o caminho DOM não move: é ele que provoca a escalada para o modo preciso.
    if (action.type === "click" && action.selector === "#inerte") return { ok: true, summary: "Cliquei em button “Inerte” — sem efeito perceptível." };
    if (action.type === "click") return { ok: true, summary: "Cliquei em button “Enviar” — a página reagiu." };
    if (action.type === "type") return { ok: true, summary: "Digitei em textbox “Buscar” (valor agora: “notebook”)." };
    return { ok: true, summary: `Ação ${action.type} concluída.` };
  };
}

const cdpLog: string[] = [];

function installChrome(store: Record<string, unknown>, page: ReturnType<typeof fakePage>) {
  const navListeners: Array<(details: { tabId: number; frameId: number; url: string }) => void> = [];
  const sessionStore: Record<string, unknown> = { "vela:session": { groupId: 1, title: "teste", tabIds: [7] } };
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: { get: async (key: string) => (key in store ? { [key]: store[key] } : {}), set: async (values: Record<string, unknown>) => { Object.assign(store, values); }, remove: async (key: string) => { delete store[key]; } },
      // A sessão precisa existir de verdade: sem ela, tab_manage recusa por "não há grupo" e o
      // teste não chega a exercitar a regra que importa — fechar aba de fora é proibido.
      session: {
        get: async (key: string) => (key in sessionStore ? { [key]: sessionStore[key] } : {}),
        set: async (values: Record<string, unknown>) => { Object.assign(sessionStore, values); },
        remove: async (key: string) => { delete sessionStore[key]; },
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    notifications: { create: async () => "id" },
    tabs: {
      query: async () => [{ id: 7, windowId: 1, url: "https://exemplo.com", title: "Exemplo", active: true }],
      remove: async () => undefined,
      // Um pixel JPEG de mentira: o que importa no teste é o caminho da imagem até a mensagem.
      captureVisibleTab: async () => "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
      update: async () => { setTimeout(() => navListeners.forEach((fn) => fn({ tabId: 7, frameId: 0, url: "https://destino.com" })), 10); },
      create: async () => ({ id: 8 }),
      get: async () => ({ id: 7, url: "https://exemplo.com" }),
      sendMessage: async (_tabId: number, message: { type: string; action?: BrowserAction }, options?: { frameId?: number }) => page(message, options?.frameId ?? 0),
    },
    webNavigation: {
      getAllFrames: async () => [{ frameId: 0, url: "https://loja.com/checkout" }, { frameId: 9, url: "https://pagamentos.com/form" }],
      onCompleted: { addListener: (fn: typeof navListeners[number]) => navListeners.push(fn), removeListener: () => undefined },
      onErrorOccurred: { addListener: () => undefined, removeListener: () => undefined },
      onHistoryStateUpdated: { addListener: () => undefined, removeListener: () => undefined },
      onReferenceFragmentUpdated: { addListener: () => undefined, removeListener: () => undefined },
    },
    runtime: { sendMessage: async () => undefined, lastError: undefined },
    scripting: { executeScript: async () => [{ result: "ok" }] },
    debugger: {
      attach: async () => { cdpLog.push("attach"); },
      detach: async () => { cdpLog.push("detach"); },
      sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => { cdpLog.push(`${method}:${params.type ?? params.key ?? ""}`); },
    },
  };
}

const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const toolCall = (id: string, name: string, args: unknown) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

async function run(name: string, rounds: string[][], settings: Partial<AppSettings> = {}, decision: "allow" | "deny" = "allow", surfaces = 1, antes?: () => Promise<void>) {
  emitted.length = 0; wire.length = 0; cdpLog.length = 0; autoDecision = decision; superficies = surfaces;
  const store: Record<string, unknown> = {
    "vela:settings": { ...defaultSettings, ...settings, providers: [{ ...defaultSettings.providers[0], apiKey: "k", defaultModel: "m" }] },
  };
  installChrome(store, fakePage());
  await agentLoop.reset();
  // Preparo que depende do `chrome` falso já instalado — anexo no storage, por exemplo.
  await antes?.();

  let call = 0;
  (globalThis as Record<string, unknown>).fetch = async (_url: string, init: { body: string }) => {
    wire.push(init.body);
    const chunks = rounds[Math.min(call, rounds.length - 1)];
    call += 1;
    return new Response(sseStream(chunks), { status: 200, headers: { "x-omniroute-provider": "teste" } });
  };

  await agentLoop.submit("mensagem de teste", emit);

  const messages = await conversation.all();
  console.log(`\n=== ${name} ===`);
  console.log("rodadas:", call);
  for (const message of messages) {
    const label = message.role === "tool" ? "tool " : message.role === "assistant" ? "assist" : "user ";
    const extra = message.tool_calls ? ` [tools: ${message.tool_calls.map((t) => t.function.name).join(",")}]` : "";
    console.log(`  ${label} ${JSON.stringify(message.content.replace(/\n/g, " ").slice(0, 110))}${extra}`);
  }
}

// 1. Loop completo com refs: extrai, digita, clica.
await run("agente lendo e agindo (auto)", [
  [delta("Vou ler a página."), toolCall("c1", "browser_action", { action: "extractPage" }), DONE],
  [delta("Agora digito."), toolCall("c2", "browser_action", { action: "type", ref: "ref_1_0", text: "notebook", submit: false }), DONE],
  [delta("Pronto, encontrei."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

// 2. Modo Assistir com recusa do usuário.
await run("assistir com recusa", [
  [delta("Vou clicar."), toolCall("c1", "browser_action", { action: "click", ref: "ref_1_1" }), DONE],
  [delta("Ok, não vou insistir."), DONE],
], {}, "deny");

// 2b. Nenhuma superfície aceitou o cartão: aí sim a recusa é por `unattended`, e a mensagem tem de
// dizer o que fazer. Antes isto era decidido por adivinhação — o gate olhava se o painel estava
// aberto e recusava sem nem tentar entregar.
await run("assistir sem superfície nenhuma", [
  [delta("Vou clicar."), toolCall("c1", "browser_action", { action: "click", ref: "ref_1_1" }), DONE],
  [delta("Entendi, ninguém podia aprovar."), DONE],
], {}, "allow", 0);

// 3. Ref obsoleto: o modelo precisa receber o erro, não um sucesso falso.
await run("ref obsoleto devolve erro", [
  [delta("Clicando."), toolCall("c1", "browser_action", { action: "click", ref: "ref_99_3" }), DONE],
  [delta("Vou reler então."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

// 4. Modo Observar recusa mutação.
await run("modo observar bloqueia", [
  [delta("Vou clicar."), toolCall("c1", "browser_action", { action: "navigate", url: "https://x.com" }), DONE],
  [delta("Entendi, não posso agir."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "observe" } });

// 5. iframes: refs de frames diferentes não podem colidir.
await run("iframes com refs por frame", [
  [delta("Lendo tudo."), toolCall("c1", "browser_action", { action: "extractPage" }), DONE],
  [delta("Clicando no iframe."), toolCall("c2", "browser_action", { action: "click", ref: "f9.ref_2_0" }), DONE],
  [delta("Feito."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

// 6. Fechar aba fora do grupo da Vela precisa ser recusado, não ignorado.
await run("tab_manage só alcança o grupo da Vela", [
  [delta("Fechando."), toolCall("c1", "tab_manage", { op: "close", tabIds: [99] }), DONE],
  [delta("Não posso fechar essa."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

// 7. Trocar a voz pela conversa, sem mandar o usuário abrir as configurações.
await run("vela_settings troca o visual", [
  [delta("Trocando."), toolCall("c1", "vela_settings", { field: "visual", value: "mesh-field" }), DONE],
  [delta("Pronto, troquei."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

// 8. Campo fora da lista branca é recusado com a lista do que existe.
await run("vela_settings recusa campo fora da lista", [
  [delta("Mudando a chave."), toolCall("c1", "vela_settings", { field: "apiKey", value: "roubada" }), DONE],
  [delta("Não consigo mexer nisso."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

// 8.5. Insistir na mesma chamada não pode continuar rodando: a partir da terceira vez é recusa.
await run("repetição idêntica é bloqueada", [
  [delta("Lendo."), toolCall("c1", "browser_action", { action: "extractPage" }), DONE],
  [delta("Lendo de novo."), toolCall("c2", "browser_action", { action: "extractPage" }), DONE],
  [delta("E de novo."), toolCall("c3", "browser_action", { action: "extractPage" }), DONE],
  [delta("Ok, vou procurar."), toolCall("c4", "browser_action", { action: "find", query: "continuar" }), DONE],
  [delta("Achei."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

// 8.6. A captura vira mensagem do usuário com imagem — resposta de ferramenta não carrega imagem.
await run("screenshot anexa a imagem ao histórico", [
  [delta("Vou olhar a tela."), toolCall("c1", "browser_action", { action: "screenshot" }), DONE],
  [delta("Vi o que precisava."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });
{
  const messages = await conversation.all();
  const comImagem = messages.filter((item) => item.images?.length);
  console.log("mensagens com imagem:", comImagem.length, "| papel:", comImagem[0]?.role, "| texto:", JSON.stringify(comImagem[0]?.content));
}

// 9. O system prompt e o bloco de estado chegam ao provider?
const body = JSON.parse(wire[0]) as { messages: Array<{ role: string; content: string }> };
console.log("\n=== prompt enviado ===");
console.log("primeira mensagem:", body.messages[0].role, "|", body.messages[0].content.slice(0, 80).replace(/\n/g, " "), "…");
console.log("última mensagem:", body.messages[body.messages.length - 1].role, "|", body.messages[body.messages.length - 1].content.replace(/\n/g, " ").slice(0, 140));
console.log("menciona autonomia observar:", /MODO OBSERVAR/.test(body.messages[0].content));

// 10. A lista de conversas segue o uso, não a criação: quem recebeu mensagem por último sobe.
console.log("\n=== ordem das conversas recentes ===");
await conversation.reset();
await conversation.append({ id: "m1", role: "user", content: "primeira conversa", createdAt: Date.now(), status: "complete" });
await conversation.reset();
await conversation.append({ id: "m2", role: "user", content: "segunda conversa", createdAt: Date.now(), status: "complete" });
const primeiraPassada = await conversation.list();
console.log("depois de criar as duas:", primeiraPassada.map((item) => item.title));
// Voltar à antiga e escrever nela precisa trazê-la de volta ao topo.
await conversation.open(primeiraPassada[1].id);
await new Promise((resolve) => setTimeout(resolve, 5));
await conversation.append({ id: "m3", role: "user", content: "mais uma na antiga", createdAt: Date.now(), status: "complete" });
console.log("depois de escrever na antiga:", (await conversation.list()).map((item) => item.title));

// 15. Apagar conversa: o histórico só abria, e uma tarefa de teste ficava para sempre na lista.
console.log("\n=== apagar conversa ===");
const antesDeApagar = await conversation.list();
const alvo = antesDeApagar.find((item) => item.title === "segunda conversa");
console.log("apagando:", JSON.stringify(alvo?.title), await conversation.remove(alvo?.id ?? ""));
console.log("sobrou:", (await conversation.list()).map((item) => item.title).slice(0, 3));
console.log("id inexistente:", await conversation.remove("nao-existe"));

// A ativa apagada é o caso perigoso: a tela ficaria mostrando mensagens que já não existem.
const ativa = (await conversation.list())[0];
await conversation.open(ativa.id);
const resultado = await conversation.remove(ativa.id);
console.log("apaguei a que estava aberta:", resultado);
console.log("a conversa ativa agora tem", (await conversation.all()).length, "mensagens");

// E apagar tudo não pode ressuscitar nada: lista vazia é o sinal de cache frio em `ensure`.
for (const item of await conversation.list()) await conversation.remove(item.id);
console.log("depois de apagar todas:", (await conversation.list()).length, "na lista e", (await conversation.all()).length, "mensagens abertas");

// 13. Escalada para o modo preciso: clique sem efeito vira clique confiável, e a resposta diz o que mudou.
await run("modo preciso repete o clique inerte", [
  [delta("Vou clicar."), toolCall("c1", "browser_action", { action: "click", selector: "#inerte" }), DONE],
  [delta("Agora a página reagiu."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto", preciseMode: true } });
console.log("CDP:", cdpLog.join(" → ") || "(não escalou)");

// 14. Com o modo preciso desligado, o mesmo clique não anexa depurador nenhum.
await run("modo preciso desligado não anexa nada", [
  [delta("Vou clicar."), toolCall("c1", "browser_action", { action: "click", selector: "#inerte" }), DONE],
  [delta("Não deu."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto", preciseMode: false } });
console.log("CDP:", cdpLog.join(" → ") || "(não escalou)");

// 17. O anexo tem de chegar ao modelo. O chip aparece na tira, o arquivo entra no storage — mas
// nada disso importa se ele não estiver no corpo da requisição.
await run("anexo chega ao modelo", [
  [delta("Li o anexo."), DONE],
], {}, "allow", 1, async () => {
  await addAttachment("Arquivo anexado “notas.md”:\nA REUNIÃO FOI ADIADA PARA OUTUBRO");
});
const corpo = wire[0] ?? "";
console.log("anexo no corpo enviado:", corpo.includes("ADIADA PARA OUTUBRO") ? "sim" : "NÃO — o modelo nunca viu o arquivo");
console.log("tag <anexo> presente:", corpo.includes("anexo") ? "sim" : "não");
// E some depois: anexo é contexto do turno, não permanente.
console.log("anexos restantes depois do turno:", (await listAttachments()).length);
