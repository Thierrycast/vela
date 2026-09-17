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
/** Os refs que a última resposta de ferramenta mostrou, na ordem em que o modelo os veria. Um
 *  cenário que clica no que acabou de ler só descobre o número aqui — ele é atribuído em execução. */
let ultimosRefs: string[] = [];
const emit = async (message: SidecarInbound) => {
  emitted.push(message);
  if (message.type === "chat:message" && message.message.role === "tool") {
    ultimosRefs = [...message.message.content.matchAll(/\be\d+\b/g)].map((match) => match[0]);
  }
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
  // Um documento tem epoch; os refs que ele emite são locais a ele. Quem traduz para o ref
  // público (e1, e2...) é o background — é essa tradução que os cenários exercitam.
  const epoch = "documento-1";
  return (message, frameId = 0) => {
    if (message.type === "agent:action" && message.action?.type === "extractPage") {
      const nome = frameId === 0 ? "Continuar" : "Pagar agora";
      return { ok: true, summary: "lido", epoch, content: `# Elementos interativos
[#1]<button name="${nome}" />` };
    }
    if (message.type === "agent:action" && message.action && "ref" in message.action && message.action.ref) {
      return { ok: true, summary: `frame ${frameId} recebeu ${message.action.ref}`, epoch };
    }
    if (message.type === "agent:ping") return { ok: true, epoch };
    // O modo preciso pergunta onde o alvo está e, depois, se a página reagiu.
    if (message.type === "agent:locate") return { x: 120, y: 340 } as unknown as ActionResult;
    if (message.type === "agent:watch") return { mutated: true, navigated: false } as unknown as ActionResult;
    // A digitação se confere lendo o campo: o travado devolve vazio até o CDP escrever nele.
    if (message.type === "agent:value") return { value: textoInserido ?? "" } as unknown as ActionResult;
    if (message.type !== "agent:action" || !message.action) return { ok: true };
    const action = message.action;
    // O alvo que o caminho DOM não move: é ele que provoca a escalada para o modo preciso.
    if (action.type === "click" && action.selector === "#inerte") return { ok: true, summary: "Cliquei em button “Inerte” — sem efeito perceptível." };
    if (action.type === "click") return { ok: true, summary: "Cliquei em button “Enviar” — a página reagiu." };
    // Menu feito em CSS puro: `:hover` e estado do navegador, nao evento, e nao acende com
    // evento sintetico. E o caso que so o ponteiro de verdade resolve.
    if (action.type === "hover") return { ok: true, summary: "Passei o mouse sobre button “Minha conta” — nada mudou na página." };
    // Campo que ignora evento sintético: o caminho DOM sai sem efeito e a escalada tem de entrar.
    if (action.type === "type" && action.selector === "#travado") return { ok: true, summary: "Tentei digitar em textbox “Travado” e o campo continua com “” — sem efeito perceptível." };
    if (action.type === "type") return { ok: true, summary: "Digitei em textbox “Buscar” (valor agora: “notebook”)." };
    return { ok: true, summary: `Ação ${action.type} concluída.` };
  };
}

const cdpLog: string[] = [];
/** As chaves de cada gravação no storage: é o que mostra se a conversa grava só o que mudou. */
const gravacoes: string[][] = [];
/** O que o caminho confiável conseguiu escrever no campo travado. Null enquanto ninguém escreveu. */
let textoInserido: string | null = null;

function installChrome(store: Record<string, unknown>, page: ReturnType<typeof fakePage>) {
  const navListeners: Array<(details: { tabId: number; frameId: number; url: string }) => void> = [];
  const sessionStore: Record<string, unknown> = { "vela:session": { groupId: 1, title: "teste", tabIds: [7] } };
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (key: string | string[] | null) => key === null ? { ...store } : Object.fromEntries((Array.isArray(key) ? key : [key]).filter((item) => item in store).map((item) => [item, store[item]])),
        set: async (values: Record<string, unknown>) => { Object.assign(store, values); gravacoes.push(Object.keys(values)); },
        remove: async (key: string | string[]) => { for (const item of Array.isArray(key) ? key : [key]) delete store[item]; },
      },
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
      // A sessao tem duas abas: a 7 esta em foco e a 8 fica atras. E a 8 que exercita o
      // enderecamento por numero — com a 7 a regra nem chega a ser consultada, porque ela e a ativa.
      query: async (consulta?: { groupId?: number; active?: boolean }) => {
        const ativa = { id: 7, windowId: 1, url: "https://exemplo.com", title: "Exemplo", active: true };
        const fundo = { id: 8, windowId: 1, url: "https://exemplo.com/outra", title: "Outra", active: false };
        return consulta?.groupId !== undefined ? [ativa, fundo] : [ativa];
      },
      remove: async () => undefined,
      // Um pixel JPEG de mentira: o que importa no teste é o caminho da imagem até a mensagem.
      captureVisibleTab: async () => "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
      update: async () => { setTimeout(() => navListeners.forEach((fn) => fn({ tabId: 7, frameId: 0, url: "https://destino.com" })), 10); },
      create: async () => ({ id: 8 }),
      // Devolve a aba pedida, senao o cenario de enderecamento por numero acabaria lendo a 7
      // e passando por verdadeiro sem ter exercitado nada.
      get: async (id: number) => ({ id, url: id === 8 ? "https://exemplo.com/outra" : "https://exemplo.com" }),
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
      sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
        cdpLog.push(`${method}:${params.type ?? params.key ?? ""}`);
        // O campo travado só aceita texto pelo caminho confiável — é isso que o cenário prova.
        if (method === "Input.insertText") textoInserido = String(params.text ?? "");
      },
    },
  };
}

const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const toolCall = (id: string, name: string, args: unknown) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

/** Um chunk pode ser uma função: os refs públicos são atribuídos em tempo de execução, então um
 *  cenário que precisa clicar no que acabou de ler só descobre o número na hora. */
type Chunk = string | (() => string);

async function run(name: string, rounds: Chunk[][], settings: Partial<AppSettings> = {}, decision: "allow" | "deny" = "allow", surfaces = 1, antes?: () => Promise<void>, pedido = "mensagem de teste") {
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
    const chunks = rounds[Math.min(call, rounds.length - 1)].map((chunk) => typeof chunk === "function" ? chunk() : chunk);
    call += 1;
    return new Response(sseStream(chunks), { status: 200, headers: { "x-omniroute-provider": "teste" } });
  };

  await agentLoop.submit(pedido, emit);

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
  [delta("Agora digito."), toolCall("c2", "browser_action", { action: "type", ref: "e1", text: "notebook", submit: false }), DONE],
  [delta("Pronto, encontrei."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

// 2. Modo Assistir com recusa do usuário.
await run("assistir com recusa", [
  [delta("Vou clicar."), toolCall("c1", "browser_action", { action: "click", ref: "e1" }), DONE],
  [delta("Ok, não vou insistir."), DONE],
], {}, "deny");

// 2b. Nenhuma superfície aceitou o cartão: aí sim a recusa é por `unattended`, e a mensagem tem de
// dizer o que fazer. Antes isto era decidido por adivinhação — o gate olhava se o painel estava
// aberto e recusava sem nem tentar entregar.
await run("assistir sem superfície nenhuma", [
  [delta("Vou clicar."), toolCall("c1", "browser_action", { action: "click", ref: "e1" }), DONE],
  [delta("Entendi, ninguém podia aprovar."), DONE],
], {}, "allow", 0);

// 3. Ref que nunca existiu, e ref do formato antigo (que ainda chega pelo histórico salvo): os
// dois precisam de mensagens diferentes, porque a recuperação é diferente.
await run("ref inexistente devolve erro", [
  [delta("Clicando."), toolCall("c1", "browser_action", { action: "click", ref: "e999" }), DONE],
  [delta("Vou reler então."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

await run("ref do formato antigo e reconhecido", [
  [delta("Clicando."), toolCall("c1", "browser_action", { action: "click", ref: "f5.ref_3_12" }), DONE],
  [delta("Entendi, formato velho."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

// 4. Modo Observar recusa mutação.
await run("modo observar bloqueia", [
  [delta("Vou clicar."), toolCall("c1", "browser_action", { action: "navigate", url: "https://x.com" }), DONE],
  [delta("Entendi, não posso agir."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "observe" } });

// 5. iframes: dois frames emitem o mesmo número local e o ref público tem de separá-los. O
// segundo ref da leitura é o do iframe — e clicar nele precisa chegar ao frame 9, não ao 0.
await run("iframes com refs por frame", [
  [delta("Lendo tudo."), toolCall("c1", "browser_action", { action: "extractPage" }), DONE],
  [delta("Clicando no iframe."), () => toolCall("c2", "browser_action", { action: "click", ref: ultimosRefs[1] ?? "e0" }), DONE],
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
  [delta("Vou ler antes."), toolCall("c0", "browser_action", { action: "extractPage" }), DONE],
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

// 15. Digitação que não pega pelo caminho DOM escala para o confiável — e a resposta afirma o
// valor lido do campo, não a intenção de ter digitado.
cdpLog.length = 0;
textoInserido = null;
await run("modo preciso preenche o campo travado", [
  [delta("Vou digitar."), toolCall("c1", "browser_action", { action: "type", selector: "#travado", text: "notebook" }), DONE],
  [delta("Pronto."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto", preciseMode: true } });
console.log("CDP:", cdpLog.join(" → ") || "(não escalou)");
console.log("texto que chegou ao campo:", textoInserido ?? "(nenhum)");

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

// 18b. O lote: varias acoes numa ida so ao modelo, parando no primeiro erro.
await run("lote executa em sequencia", [
  [delta("Vou fazer tudo de uma vez."), toolCall("c1", "browser_batch", { items: [
    { name: "browser_action", input: { action: "navigate", url: "https://exemplo.com" } },
    { name: "browser_action", input: { action: "extractPage" } },
    { name: "browser_action", input: { action: "click", selector: "#enviar" } },
  ] }), DONE],
  [delta("Pronto."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

// O lote para no primeiro erro e diz o que nao chegou a rodar: continuar executaria os passos
// seguintes contra uma pagina em estado desconhecido.
await run("lote para no primeiro erro", [
  [delta("Sequencia."), toolCall("c1", "browser_batch", { items: [
    { name: "browser_action", input: { action: "extractPage" } },
    { name: "browser_action", input: { action: "click", ref: "e999" } },
    { name: "browser_action", input: { action: "click", selector: "#enviar" } },
  ] }), DONE],
  [delta("Entendi onde parou."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

// O rodape e a parte que importa quando o lote quebra: ele diz onde parou e o que nao rodou.
{
  const ultima = [...(await conversation.all())].reverse().find((message) => message.role === "tool");
  console.log("rodapé:", (ultima?.content ?? "").split("\n").filter(Boolean).pop());
}

// Ferramenta que nao e de navegador nao entra no lote.
await run("lote recusa ferramenta de fora", [
  [delta("Tentando."), toolCall("c1", "browser_batch", { items: [
    { name: "memory_write", input: { key: "a", value: "b" } },
  ] }), DONE],
  [delta("Ok, chamo separado."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

// Habilidade desligada: a ferramenta nem e anunciada, e a chamada de memoria e recusada com o
// nome da chave que precisa ser ligada.
await run("habilidade desligada recusa a chamada", [
  [delta("Vou agrupar."), toolCall("c1", "browser_batch", { items: [
    { name: "browser_action", input: { action: "extractPage" } },
  ] }), DONE],
  [delta("Entendi."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" }, capabilities: { ...defaultSettings.capabilities, batch: false } });

// 18c. Endereçar aba por numero: so as abas da sessao, e o ref manda sobre o tabId.
await run("aba de fora e recusada", [
  [delta("Lendo a outra aba."), toolCall("c1", "browser_action", { action: "extractPage", tabId: 99 }), DONE],
  [delta("Entendi, nao e minha."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

await run("aba da sessao e aceita por numero", [
  [delta("Lendo a aba de tras."), toolCall("c1", "browser_action", { action: "extractPage", tabId: 8 }), DONE],
  [delta("Pronto."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" } });

// 18d. Hover que nao acendeu o menu escala para o ponteiro de verdade.
cdpLog.length = 0;
await run("modo preciso move o ponteiro de verdade", [
  [delta("Vou passar o mouse."), toolCall("c1", "browser_action", { action: "hover", selector: "#menu-conta" }), DONE],
  [delta("Agora abriu."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto", preciseMode: true } });
console.log("CDP:", cdpLog.join(" → ") || "(nao escalou)");

// 18e. Habilidade de enderecar aba desligada: o tabId deixa de ser aceito, e a recusa diz onde ligar.
await run("aba por numero com a habilidade desligada", [
  [delta("Lendo a outra aba."), toolCall("c1", "browser_action", { action: "extractPage", tabId: 8 }), DONE],
  [delta("Entendi."), DONE],
], { agent: { ...defaultSettings.agent, autonomy: "auto" }, capabilities: { ...defaultSettings.capabilities, tabAddressing: false } });

// 18f. A regra do "so mudou o numero": ela existe para contador, e nao pode engolir identificador.
// Medida numa lista virtualizada de verdade, a versao ingenua deixava "Pedido #1043" virar
// "Pedido #9001" sem reclamar — o clique errado silencioso que a assinatura existe para barrar.
console.log("\n=== contador muda, identificador nao ===");
{
  const { compareForTest } = await import("../src/element-registry");
  const casos: Array<[string, string, string]> = [
    ["3 novas mensagens", "4 novas mensagens", "drifted"],
    ["Notificações (3)", "Notificações (12)", "drifted"],
    ["Pedido #1043", "Pedido #9001", "recycled"],
    ["NF 8842", "NF 9911", "recycled"],
    ["Item 12 de 340", "Item 13 de 340", "recycled"],
    ["Salvar", "Salvar", "identical"],
  ];
  for (const [antes, depois, esperado] of casos) {
    const obtido = compareForTest(antes, depois);
    console.log(`  “${antes}” → “${depois}”: ${obtido}${obtido === esperado ? "" : `  ESPERAVA ${esperado}`}`);
  }
}

// 18. O registro de refs, exercitado direto — é lógica pura e não precisa do loop inteiro.
// O que importa aqui é a **estabilidade**: o mesmo elemento, relido, tem de receber o mesmo ref.
// Sem isso, todo clique depois de uma releitura exigiria uma rodada só para reconquistar o alvo.
console.log("\n=== registro de refs ===");
{
  const { allocateRefs, evictFrame, resolveRoute } = await import("../src/ref-registry");
  const frame = { tabId: 7, frameId: 0, epoch: "doc-a" };
  const primeira = allocateRefs('[#1]<button name="Continuar" />', frame);
  const segunda = allocateRefs('[#1]<button name="Continuar" />', frame);
  console.log("primeira leitura:", primeira.trim());
  console.log("segunda leitura :", segunda.trim());
  console.log("ref estável entre releituras:", primeira === segunda ? "sim" : "NÃO — a releitura renumerou o elemento");

  // Outro frame com o mesmo número local não pode colidir com o primeiro.
  const outroFrame = allocateRefs('[#1]<button name="Pagar" />', { tabId: 7, frameId: 9, epoch: "doc-b" });
  console.log("frame diferente, mesmo número local:", outroFrame.trim(), outroFrame === primeira ? "COLIDIU" : "(sem colisão)");

  const ref = /e(\d+)/.exec(primeira)?.[0] ?? "e1";
  console.log("resolve:", JSON.stringify(resolveRoute(ref)));
  console.log("formato antigo:", JSON.stringify(resolveRoute("f5.ref_3_12")));
  console.log("nunca existiu:", JSON.stringify(resolveRoute("e9999")));

  // Depois da navegação o ref não vira "desconhecido": vira "aquela aba saiu de X para Y", que é
  // a diferença entre o modelo adivinhar o que houve e saber exatamente o que reler.
  await evictFrame(7, 0, "https://exemplo.com/lista");
  await evictFrame(7, 0, "https://exemplo.com/detalhe");
  console.log("depois de navegar:", JSON.stringify(resolveRoute(ref)));
}

// 19. O relatorio: a trilha virada narrativa.
//
// O que se confere aqui nao e o texto bonito — e se a costura funciona. Sem round, callId e
// actionId ligando os eventos, o relatorio teria de adivinhar pela ordem qual acao pertence a qual
// chamada, e e justamente isso que um lote com cinco acoes desmonta.
console.log("\n=== relatorio de um turno ===");
{
  const { relatorioDoTurno } = await import("../src/trace-report");
  const agora = Date.now();
  const evento = (extra: Record<string, unknown>) => ({ at: agora, turn: "t1", from: "background", ...extra }) as never;
  const eventos = [
    evento({ kind: "user.input", label: "busque cafe", data: { texto: "busque café moído na loja", model: "modelo-x", autonomia: "auto", habilidades: ["batch", "waitFor"] } }),
    evento({ kind: "model.prompt", label: "prompt enviado (3 mensagens)", round: 1, data: { mensagens: [{ papel: "system", conteudo: "Você é a Vela…" }, { papel: "user", conteudo: "busque café moído na loja" }], caracteres: 42, ferramentas: ["browser_action", "browser_batch"] } }),
    evento({ kind: "model.response", label: "resposta do modelo", round: 1, data: { texto: "Vou buscar.", chamadas: [{ id: "c1", nome: "browser_batch", argumentos: '{"items":[]}' }], tokens: { total_tokens: 1234 } } }),
    evento({ kind: "model.request", label: "rodada 1", round: 1, ms: 2400, data: { firstTokenMs: 380, chars: 11 } }),
    evento({ kind: "tool.call", label: "browser_batch", round: 1, callId: "c1", ms: 3100, ok: true, data: { name: "browser_batch", arguments: { items: 2 }, result: "1. navegou 2. clicou" } }),
    evento({ kind: "model.tool", label: "resultado de browser_batch", round: 1, callId: "c1", ok: true, data: { name: "browser_batch", resultado: "1. browser_action/navigate → Abri a loja\n2. browser_action/click → Cliquei em Buscar" } }),
    evento({ kind: "action", label: "navigate", round: 1, callId: "c1", ms: 900, ok: true, data: { summary: "Abri a loja." } }),
    evento({ kind: "action", label: "click", round: 1, callId: "c1", ms: 420, ok: true, data: { summary: "Cliquei em button “Buscar” — sem efeito perceptível.", noEffect: true } }),
    evento({ kind: "model.text", label: "resposta ao usuário", round: 2, ok: true, data: { texto: "Achei três opções de café moído." } }),
    evento({ kind: "turn", label: "turno completo", ms: 7200, ok: true, data: { rounds: 2, toolCalls: 1 } }),
  ];
  const texto = relatorioDoTurno(eventos, { completo: true });
  const linhas = texto.split("\n");
  console.log(linhas.slice(0, 14).join("\n"));
  console.log(`  … (${linhas.length} linhas no total)`);
  for (const esperado of ["Pedido:", "2 rodada(s)", "1234", "sem efeito", "Como foi, rodada a rodada", "O que o modelo leu", "Resposta final"]) {
    console.log(`  contém “${esperado}”: ${texto.includes(esperado) ? "sim" : "NAO"}`);
  }
}

// 20. O pipeline de voz no relatorio: do microfone a caixa de som.
//
// Numa conversa falada o texto e o meio, nao a ponta: entre o que a pessoa disse e o que a Vela
// leu ha um modelo de transcricao, e entre o que ela respondeu e o que se ouviu ha outro de
// sintese. O que se confere aqui e se o relatorio conta essa parte — inclusive o descarte
// silencioso, que antes nao deixava rastro nenhum.
console.log("\n=== relatorio de uma conversa falada ===");
{
  const { relatorioDoTurno } = await import("../src/trace-report");
  const agora = Date.now();
  const evento = (extra: Record<string, unknown>) => ({ at: agora, turn: "t2", from: "offscreen", ...extra }) as never;
  const eventos = [
    evento({ kind: "audio.capture", label: "trecho de fala capturado", blobId: "aaaabbbb-1111", data: { bytes: 48_000, mime: "audio/wav" } }),
    evento({ kind: "stt.result", label: "transcrição", ms: 640, ok: true, blobId: "aaaabbbb-1111", data: { texto: "abre o carrinho", bruto: " abre o carrinho ", modelo: "whisper-turbo", descartado: false } }),
    evento({ kind: "user.input", label: "entrada por voz", from: "background", data: { origem: "voz", texto: "abre o carrinho", model: "modelo-rapido", autonomia: "auto" } }),
    evento({ kind: "model.text", label: "resposta ao usuário", from: "background", round: 1, ok: true, data: { texto: "Abri o carrinho: são **três** itens." } }),
    evento({ kind: "tts.request", label: "texto enviado para falar", data: { original: "Abri o carrinho: são **três** itens.", falado: "Abri o carrinho: são três itens.", voz: "piper:pt_BR-cadu-medium", streaming: true } }),
    evento({ kind: "tts.audio", label: "síntese", ms: 820, ok: true, blobId: "ccccdddd-2222", data: { modo: "streaming", bytes: 96_000, voz: "piper:pt_BR-cadu-medium" } }),
    evento({ kind: "tts.play", label: "reprodução", ms: 2100, ok: true, blobId: "ccccdddd-2222", data: { segundos: 2.1 } }),
    evento({ kind: "stt.result", label: "transcrição", ms: 300, ok: false, code: "descartado", blobId: "eeeeffff-3333", data: { texto: "obrigado", modelo: "whisper-turbo", descartado: true, motivo: "reconhecido como alucinação do modelo de transcrição" } }),
    evento({ kind: "turn", label: "turno completo", from: "background", ms: 5400, ok: true }),
  ];
  const texto = relatorioDoTurno(eventos, { completo: true });
  const secao = texto.slice(texto.indexOf("## A conversa falada"));
  console.log(secao.split("\n").slice(0, 16).join("\n"));
  for (const esperado of ["Entrou por:** voz", "whisper-turbo", "escrito:", "falado:", "descartado", "tocou"]) {
    console.log(`  contém “${esperado}”: ${texto.includes(esperado) ? "sim" : "NAO"}`);
  }
}

// A fala que abriu um turno e gravada antes de o turno existir, com o carimbo "sem-turno". O
// relatorio a traz de volta pelo id do enunciado — e so por ele: uma fala de outro enunciado,
// gravada no mesmo segundo, precisa continuar de fora.
console.log("\n=== a fala volta para o turno que ela abriu ===");
{
  const { relatorioCompleto } = await import("../src/trace-report");
  const agora = Date.now();
  const evento = (extra: Record<string, unknown>) => ({ at: agora, from: "offscreen", ...extra }) as never;
  const eventos = [
    evento({ kind: "audio.capture", label: "trecho de fala capturado", turn: "sem-turno", blobId: "aaaa1111", data: { enunciado: "fala-1", bytes: 40_000 } }),
    evento({ kind: "stt.result", label: "transcrição", turn: "sem-turno", ms: 500, ok: true, data: { enunciado: "fala-1", texto: "abre o carrinho", modelo: "whisper" } }),
    evento({ kind: "stt.result", label: "transcrição", turn: "sem-turno", ms: 300, ok: false, code: "descartado", data: { enunciado: "fala-2", texto: "obrigado", descartado: true } }),
    evento({ kind: "ui", label: "orb montado", turn: "sem-turno" }),
    evento({ kind: "user.input", label: "abre o carrinho", turn: "t9", from: "background", data: { origem: "voz", enunciado: "fala-1", texto: "abre o carrinho" } }),
    evento({ kind: "turn", label: "turno completo", turn: "t9", from: "background", ms: 900, ok: true }),
  ];
  const texto = relatorioCompleto(eventos, { completo: true });
  const turno = texto.slice(texto.indexOf("# Turno t9"), texto.indexOf("# Fora de qualquer turno"));
  const fora = texto.slice(texto.indexOf("# Fora de qualquer turno"));
  console.log(`  captura dentro do turno: ${turno.includes("**microfone**") ? "sim" : "NAO"}`);
  console.log(`  transcrição dentro do turno: ${turno.includes("abre o carrinho") && turno.includes("**transcrição**") ? "sim" : "NAO"}`);
  console.log(`  fala de outro enunciado ficou de fora: ${!turno.includes("obrigado") && fora.includes("transcrição") ? "sim" : "NAO"}`);
  console.log(`  evento de painel ficou de fora: ${fora.includes("orb montado") ? "sim" : "NAO"}`);
}

// O retrato escreve links sem esquema (href="host/caminho"). Se o gate so reconhecesse https://,
// nenhum link lido numa pagina contaria como ideia da pagina — e a navegacao sugerida por ela
// passaria sem confirmacao.
console.log("\n=== gate de dominio reconhece link sem esquema ===");
{
  const { classify, noteSource, resetDomainMemory } = await import("../src/domain-policy");
  resetDomainMemory();
  noteSource("user", "abre github.com e procura a vela");
  noteSource("page", '[e3]<link name="Oferta" href="golpe-exemplo.com.br/promo" /> versão v1.2');
  console.log(`  link do retrato conta como da página: ${classify("https://golpe-exemplo.com.br/login") === "page" ? "sim" : "NAO"}`);
  console.log(`  domínio digitado sem https conta como do usuário: ${classify("https://github.com/x") === "user" ? "sim" : "NAO"}`);
  console.log(`  número de versão não vira domínio: ${classify("https://v1.2") === "unknown" ? "sim" : "NAO"}`);
}

// A escada de leitura. O modelo que vai direto à captura para ler texto recebe a recusa com o degrau
// barato; depois de ler por texto, a mesma captura roda. E se a pessoa pediu a imagem, não há
// escada a subir.
console.log("\n=== escada: captura antes de ler é adiada ===");
{
  await run("captura direto", [
    [delta("Vou olhar."), toolCall("c1", "browser_action", { action: "screenshot" }), DONE],
    [delta("Lendo por texto."), toolCall("c2", "browser_action", { action: "extractPage", extractMode: "text" }), DONE],
    [delta("Agora sim, a imagem."), toolCall("c3", "browser_action", { action: "screenshot" }), DONE],
    [delta("Pronto."), DONE],
  ], { agent: { ...defaultSettings.agent, autonomy: "auto" } }, "allow", 1, undefined, "o que tem nesta página?");
  const tools = (await conversation.all()).filter((item) => item.role === "tool");
  console.log(`  primeira captura recusada com o degrau barato: ${tools[0]?.content.startsWith("ERRO [escada]") ? "sim" : "NAO"}`);
  console.log(`  captura depois da leitura por texto rodou: ${(await conversation.all()).some((item) => item.images?.length) ? "sim" : "NAO"}`);

  await run("pedido visual", [
    [delta("Tirando o print."), toolCall("c1", "browser_action", { action: "screenshot" }), DONE],
    [delta("Pronto."), DONE],
  ], { agent: { ...defaultSettings.agent, autonomy: "auto" } }, "allow", 1, undefined, "tira um print dessa página");
  console.log(`  pedido de imagem captura direto: ${(await conversation.all()).some((item) => item.images?.length) ? "sim" : "NAO"}`);

  await run("modelo sem visão", [
    [delta("Lendo."), toolCall("c1", "browser_action", { action: "extractPage" }), DONE],
    [delta("Olhando."), toolCall("c2", "browser_action", { action: "screenshot" }), DONE],
    [delta("Pronto."), DONE],
  ], { agent: { ...defaultSettings.agent, autonomy: "auto" } }, "allow", 1, async () => {
    const atual = (await chrome.storage.local.get("vela:settings"))["vela:settings"] as AppSettings;
    await chrome.storage.local.set({ "vela:settings": { ...atual, providers: atual.providers.map((item) => ({ ...item, capabilities: { ...item.capabilities, vision: false } })) } });
  });
  const enviado = JSON.parse(wire[0]) as { tools: Array<{ function: { name: string; parameters: { properties: { action?: { enum?: string[] } } } } }> };
  const acoes = enviado.tools.find((tool) => tool.function.name === "browser_action")?.function.parameters.properties.action?.enum ?? [];
  const recusou = (await conversation.all()).some((item) => item.role === "tool" && item.content.includes("não enxerga imagens"));
  console.log(`  sem visão, screenshot nem é oferecido e é recusado se pedido: ${!acoes.includes("screenshot") && acoes.includes("extractPage") && recusou ? "sim" : "NAO"}`);
}

// Resultados grandes de pedidos anteriores não viajam de novo em toda rodada do pedido seguinte.
console.log("\n=== contexto: resultado grande de pedido anterior é resumido ===");
{
  await run("pedido longo", [
    [delta("Lendo."), toolCall("c1", "browser_action", { action: "extractPage" }), DONE],
    [delta("Li."), DONE],
  ], { agent: { ...defaultSettings.agent, autonomy: "auto" } });
  const lido = (await conversation.all()).find((item) => item.role === "tool")!;
  await conversation.patch(lido.id, { content: `${lido.content}${"x".repeat(5_000)}` });
  wire.length = 0;
  (globalThis as Record<string, unknown>).fetch = async (_url: string, init: { body: string }) => {
    wire.push(init.body);
    return new Response(sseStream([delta("Ok."), DONE]), { status: 200 });
  };
  await agentLoop.submit("e agora?", emit);
  const corpo = JSON.parse(wire[0]) as { messages: Array<{ role: string; content: string }> };
  const antigo = corpo.messages.find((item) => item.role === "tool")?.content ?? "";
  console.log(`  resultado anterior chegou resumido: ${antigo.length < 1_000 && antigo.includes("resumido") ? "sim" : "NAO"} (${antigo.length} caracteres)`);
}

// O degrau aceito pelo gateway é lembrado: a recusa de `stream_options` custa uma ida só, não uma
// por rodada.
console.log("\n=== provedor: degrau aceito é lembrado ===");
{
  let tentativas = 0;
  await run("gateway sem stream_options", [[delta("Ok."), DONE]], { agent: { ...defaultSettings.agent, autonomy: "auto" } });
  (globalThis as Record<string, unknown>).fetch = async (_url: string, init: { body: string }) => {
    tentativas += 1;
    if (init.body.includes("stream_options")) return new Response(JSON.stringify({ error: "stream_options is not supported" }), { status: 400 });
    return new Response(sseStream([delta("Ok."), DONE]), { status: 200 });
  };
  await agentLoop.submit("um", emit);
  const primeira = tentativas;
  await agentLoop.submit("dois", emit);
  console.log(`  primeira vez aprende com uma recusa, a segunda vai direto: ${primeira === 2 && tentativas === 3 ? "sim" : "NAO"} (${primeira}, ${tentativas - primeira})`);
}

// A conversa grava só o que mudou, e o formato antigo de chave única migra sozinho.
console.log("\n=== armazenamento: grava só a conversa que mudou ===");
{
  const loja: Record<string, unknown> = {
    "vela:settings": { ...defaultSettings, providers: [{ ...defaultSettings.providers[0], apiKey: "k", defaultModel: "m" }] },
    "vela:conversations": [
      { id: "antiga-1", title: "antiga um", updatedAt: 1, messages: [{ id: "a", role: "user", content: "um", createdAt: 1, status: "complete" }] },
      { id: "antiga-2", title: "antiga dois", updatedAt: 2, messages: [{ id: "b", role: "user", content: "dois", createdAt: 2, status: "complete" }] },
    ],
  };
  installChrome(loja, fakePage());
  const modulo = await import("../src/storage");
  const indice = await modulo.loadConversationIndex();
  console.log(`  migrou para chave por conversa: ${indice.length === 2 && "vela:conversa:antiga-1" in loja && !("vela:conversations" in loja) ? "sim" : "NAO"}`);
  gravacoes.length = 0;
  await modulo.saveConversationChanges(indice, [{ id: "antiga-2", title: "antiga dois", updatedAt: 3, messages: [] }], []);
  const chaves = gravacoes.flat();
  console.log(`  gravou só a conversa alterada e o índice: ${chaves.includes("vela:conversa:antiga-2") && !chaves.includes("vela:conversa:antiga-1") ? "sim" : "NAO"}`);
}

// A narração: a resposta começa a ser falada enquanto ainda está sendo escrita, sem repetir o que já
// foi falado no fim do turno, sem antecipar uma desistência que o loop pode descartar, e sem ler
// código em voz alta.
console.log("\n=== voz: a resposta é falada enquanto é escrita ===");
{
  const { criarNarrador } = await import("../src/voice-narrator");
  const ditas: string[] = [];
  const narrador = criarNarrador((frase) => ditas.push(frase));
  const resposta = "Abri o carrinho e conferi os itens. São três produtos no total. O frete sai por vinte reais";
  for (const pedaco of resposta.match(/.{1,7}/g) ?? []) narrador.pedaco("m1", pedaco);
  console.log(`  falou antes de terminar: ${ditas.length >= 2 ? "sim" : "NAO"} (${ditas.length} trecho(s))`);
  console.log(`  primeira frase inteira: ${ditas[0] === "Abri o carrinho e conferi os itens." ? "sim" : "NAO"}`);
  console.log(`  o fim que não fechou frase sobra para o final: ${narrador.restante("m1", resposta) === "O frete sai por vinte reais" ? "sim" : "NAO"}`);

  const comRecusa = criarNarrador((frase) => ditas.push(`recusa:${frase}`));
  comRecusa.pedaco("m2", "Não consigo fazer isso agora, desculpe. ");
  console.log(`  desistência do modelo rápido não é falada: ${!ditas.some((item) => item.startsWith("recusa:")) ? "sim" : "NAO"}`);

  const comCodigo = criarNarrador(() => undefined);
  const trecho = "Olha o exemplo:\n```js\nconst x = 1. Isso aqui. \n";
  comCodigo.pedaco("m3", trecho);
  console.log(`  bloco de código aberto não vira fala: ${comCodigo.jaFalou("m3") === false ? "sim" : "NAO"}`);
}
