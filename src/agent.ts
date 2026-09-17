import { ActionResult, Autonomy, BrowserAction } from "./types";
import { isPdf, isRestrictedUrl, restrictionReason, waitForContentScript, waitForNavigation } from "./navigation";
import { loadSettings } from "./storage";
import { approvalKey, describeAction, isRisky, requestApproval } from "./approvals";
import { span } from "./trace";
import { adoptTab } from "./session";
import { isSessionTab } from "./tab-manager";
import { preciseClick, preciseFill, preciseHover, preciseKey } from "./cdp-actuator";
import { cdpAvailable } from "./cdp-session";
import { allocateRefs, resolveRoute } from "./ref-registry";
import { evaluateInMainWorld } from "./script-world";
import { gateNavigation, noteSource } from "./domain-policy";
import { HOST_ACCESS_MISSING, hasHostAccess } from "./permissions";
import { forgetRoute, recallRoute, rememberRoute } from "./route-cache";
import { recordFull } from "./trace";

// `hover` entra aqui porque passar o mouse nao modifica a pagina — pedir aprovacao para cada
// passagem de mouse em modo Assistir tornaria o modo inutilizavel em qualquer site com menu.
const READ_ONLY: Array<BrowserAction["type"]> = ["extractPage", "find", "scroll", "wait", "waitFor", "screenshot", "hover"];
/** As acoes em que o cursor viaja ate o alvo: sao as que a pessoa precisa ver acontecer. */
const CURSOR_ACTIONS: Array<BrowserAction["type"]> = ["click", "type", "keyPress", "hover", "drag", "selectOption"];
// `waitFor` tem teto próprio dentro da página (30 s); a margem aqui é para a resposta voltar.
const TIMEOUTS: Record<BrowserAction["type"], number> = { extractPage: 12_000, find: 12_000, screenshot: 10_000, click: 8_000, type: 12_000, keyPress: 6_000, scroll: 5_000, wait: 14_000, waitFor: 34_000, hover: 8_000, drag: 12_000, selectOption: 8_000, history: 12_000, navigate: 20_000, pageTool: 20_000, evaluateScript: 15_000 };

export const isReadOnly = (action: BrowserAction) => READ_ONLY.includes(action.type);

const failure = (code: Extract<ActionResult, { ok: false }>["code"], summary: string): ActionResult => ({ ok: false, code, summary });

const tracedTabs = new Set<number>();

/** A borda e a pílula são estado de sessão, não de ação — senão piscam a cada passo. */
async function beginTrace(tabId: number) {
  if (tracedTabs.has(tabId)) return;
  tracedTabs.add(tabId);
  try { await chrome.tabs.sendMessage(tabId, { type: "trace:session", state: "start", trace: await traceConfig() }); } catch { tracedTabs.delete(tabId); }
}

export async function endTraceSessions() {
  for (const tabId of tracedTabs) {
    try { await chrome.tabs.sendMessage(tabId, { type: "trace:session", state: "stop" }); } catch { /* aba fechada */ }
  }
  tracedTabs.clear();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

async function sendToTab(tabId: number, message: unknown, timeoutMs: number, frameId = 0): Promise<ActionResult> {
  const attempt = () => chrome.tabs.sendMessage(tabId, message, { frameId }) as Promise<ActionResult>;
  const withTimeout = (promise: Promise<ActionResult>) => Promise.race([
    promise,
    new Promise<ActionResult>((resolve) => setTimeout(() => resolve(failure("timeout", `A página não respondeu em ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs)),
  ]);
  try {
    return await withTimeout(attempt());
  } catch {
    const ready = await waitForContentScript(tabId, 4);
    if (!ready) return failure("no_content_script", "A Vela não consegue agir nesta página (script de conteúdo indisponível).");
    try { return await withTimeout(attempt()); } catch (error) { return failure("no_content_script", error instanceof Error ? error.message : "Falha ao falar com a página."); }
  }
}

/**
 * Traduz o ref público que o modelo escreveu no endereço interno: aba, frame e número local.
 *
 * Um ref é autorroteável — ele sabe de qual aba e de qual frame veio —, e é por isso que o modelo
 * não precisa (nem deve) dizer onde o elemento está. Quando a tradução falha, o texto do erro é a
 * parte que importa: ele é a instrução que faz o modelo se recuperar em uma rodada em vez de duas.
 */
type Routed =
  | { ok: true; tabId: number; frameId: number; ref: string | undefined }
  | { ok: false; failure: ActionResult };

/**
 * Sem ref, quem decide a aba é `tabId` — e a regra de quem pode ser endereçada é a mesma de
 * `tab_manage`: só as abas do grupo da Vela. Endereçar por número é o caminho por onde um engano
 * passaria despercebido, porque não há nada na tela confirmando onde a ação caiu.
 */
async function routeTab(action: BrowserAction, activeId: number | undefined): Promise<Routed> {
  if (action.tabId === undefined || action.tabId === activeId) {
    return { ok: true, tabId: activeId ?? -1, frameId: 0, ref: undefined };
  }
  if (!(await loadSettings()).capabilities.tabAddressing) {
    return { ok: false, failure: failure("denied", "Agir numa aba pelo número está desligado nas configurações da Vela (Configurações → Habilidades). Traga a aba para a frente com tab_manage e trabalhe nela, ou peça ao usuário para ligar essa habilidade.") };
  }
  if (!(await isSessionTab(action.tabId))) {
    return { ok: false, failure: failure("denied", `A aba ${action.tabId} não é da sessão da Vela — ela é do usuário, e você não age nela por número. Use tab_manage com op "list" para ver quais abas são suas.`) };
  }
  return { ok: true, tabId: action.tabId, frameId: 0, ref: undefined };
}

function routeRef(ref: string | undefined, fallbackTabId: number): Routed {
  if (!ref) return { ok: true, tabId: fallbackTabId, frameId: 0, ref: undefined };
  const lookup = resolveRoute(ref);
  if (lookup.status === "ok") return { ok: true, tabId: lookup.route.tabId, frameId: lookup.route.frameId, ref: `#${lookup.route.localId}` };
  if (lookup.status === "legacy") {
    return { ok: false, failure: failure("ref_desconhecido", `“${ref}” é o formato antigo de ref e não existe mais. Os refs agora são como e412 e vêm da última leitura da página. Chame extractPage.`) };
  }
  if (lookup.status === "navigated") {
    // A URL de origem pode faltar quando o primeiro commit daquele frame aconteceu antes de o
    // service worker subir. Dizer "navegou de  para X" seria pior que não dizer de onde.
    const trajeto = lookup.from ? `de ${safeHost(lookup.from)} para ${safeHost(lookup.to)}` : `para ${safeHost(lookup.to)}`;
    return { ok: false, failure: failure("page_gone", `A aba ${lookup.tabId} navegou ${trajeto} depois que você leu a página. Todos os refs daquela leitura, incluindo ${ref}, deixaram de existir. Chame extractPage nesta aba antes de agir.`) };
  }
  return { ok: false, failure: failure("ref_desconhecido", `Não existe nenhum elemento ${ref}. Refs só vêm de um extractPage ou de um find — não os deduza a partir de outros refs nem os invente. Leia a página e use o ref exatamente como ele apareceu.`) };
}

/** Checkout, login e captcha vivem em iframes de outra origem: sem ler todos, o agente é cego. */
async function readAllFrames(tabId: number, tabUrl: string | undefined, action: Extract<BrowserAction, { type: "extractPage" }>): Promise<ActionResult> {
  let frames: Array<{ frameId: number; url: string }> = [];
  try { frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? []; } catch { /* sem permissão nesta aba */ }
  const usable = frames.filter((frame) => !isRestrictedUrl(frame.url)).slice(0, 10);
  if (!usable.length) usable.push({ frameId: 0, url: "" });

  const parts: string[] = [];
  let total = 0;
  let anySuccess = false;

  for (const frame of usable) {
    const result = await sendToTab(tabId, { type: "agent:action", action, actionId: crypto.randomUUID() }, TIMEOUTS.extractPage, frame.frameId);
    if (!result?.ok || !result.content) continue;
    anySuccess = true;
    const labelled = allocateRefs(result.content, { tabId, frameId: frame.frameId, epoch: result.epoch ?? "" });
    parts.push(frame.frameId === 0 ? labelled : `\n--- iframe f${frame.frameId} (${safeHost(frame.url)}) ---\n${labelled}`);
    total += 1;
  }

  if (!anySuccess) return failure("no_content_script", "Não consegui ler nenhum frame desta página.");
  // A aba encabeça o bloco em vez de aparecer dentro de cada ref: o modelo precisa saber onde
  // está agindo uma vez, não cento e cinquenta vezes.
  const header = `## aba ${tabId} — ${safeHost(tabUrl ?? "")}`;
  const content = [header, ...parts].join("\n");
  // Todo endereço que aparece numa página lida fica marcado como ideia **da página** — ver
  // `domain-policy.ts`. É essa marca que distingue "o usuário pediu" de "o site mandou".
  noteSource("page", content);
  return { ok: true, summary: `Página lida em ${total} frame(s).`, content, url: tabUrl };
}

function safeHost(url: string) {
  try { return new URL(url).host; } catch { return url.slice(0, 40); }
}

function originOf(url: string | undefined) {
  try { return url ? new URL(url).origin : "página desconhecida"; } catch { return "página desconhecida"; }
}

/**
 * O rótulo que vai no cartão de aprovação.
 *
 * `status` importa tanto quanto o texto: se o ref virou outro elemento, o cartão **não pode** ser
 * exibido com o rótulo antigo. Aprovar "Cancelar pedido #1043" e a Vela cancelar o #2211 é falha
 * de segurança, não de usabilidade — quem autorizou autorizou outra coisa.
 */
async function targetLabel(tabId: number, frameId: number, action: BrowserAction, ref: string | undefined) {
  if (!("ref" in action) && !("selector" in action)) return { label: "", changed: false };
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "agent:describe", action: { ...action, ref } }, { frameId }) as Promise<{ label?: string; status?: string }>,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 800)),
    ]);
    return { label: response?.label ?? "", changed: response?.status === "changed" };
  } catch { return { label: "", changed: false }; }
}

/**
 * Reduz a captura antes de mandá-la ao modelo.
 *
 * Numa janela grande a imagem crua passa de 250 KB em base64, e isso viaja em toda rodada
 * seguinte do turno. Mil e duzentos pixels de largura preservam texto de interface legível — que
 * é o motivo de capturar — por cerca de metade do peso.
 */
const MAX_WIDTH = 1200;
async function shrink(dataUrl: string): Promise<string> {
  try {
    // `fetch` de uma data URL é barrado pelo `connect-src` do manifest — o base64 vira bytes aqui.
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    if (bitmap.width <= MAX_WIDTH) { bitmap.close(); return dataUrl; }
    const scale = MAX_WIDTH / bitmap.width;
    const canvas = new OffscreenCanvas(MAX_WIDTH, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) { bitmap.close(); return dataUrl; }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let encoded = "";
    for (const byte of buffer) encoded += String.fromCharCode(byte);
    return `data:image/jpeg;base64,${btoa(encoded)}`;
  } catch {
    // Redimensionar é otimização; falhar aqui não pode custar a captura.
    return dataUrl;
  }
}

/*
 * A escalada para o modo preciso.
 *
 * O caminho DOM já tentou e a página não se mexeu. Duas explicações cabem: o alvo era mesmo
 * inerte (um `<div>` decorativo), ou o site exige `event.isTrusted` e ignorou o evento sintético.
 * Só o segundo caso tem conserto, e o conserto é repetir a ação pelo CDP.
 *
 * Três limites deliberados:
 *
 * - **Só no frame de cima.** `Input.dispatchMouseEvent` fala em coordenadas do viewport da aba;
 *   o retângulo lido dentro de um iframe é relativo ao iframe. Somar as duas origens dá certo até
 *   o primeiro iframe rolado ou transformado — melhor não escalar do que clicar no lugar errado.
 * - **Verifica depois.** Sem `agent:watch` a resposta seria "cliquei de novo", que não é informação.
 *   Com ele, ou a página reagiu e isso é dito, ou não reagiu e o modelo para de insistir.
 * - **Nunca troca a falha por uma pior.** Se a escalada não conseguir nada, devolve o resultado
 *   original inalterado.
 */
const NO_EFFECT = "sem efeito perceptível";
/** O hover do caminho DOM nao acende `:hover`; e esta frase que pede o ponteiro de verdade. */
const HOVER_NADA = "nada mudou na página";
const KEY_IGNORED = "tecla despachada";

function wantsEscalation(action: BrowserAction, result: ActionResult): boolean {
  if (!result.ok) return false;
  if (action.type === "click" || action.type === "type") return result.summary.includes(NO_EFFECT);
  if (action.type === "hover") return result.summary.includes(HOVER_NADA);
  if (action.type === "keyPress") return result.summary.includes(KEY_IGNORED);
  return false;
}

/** O valor que o campo tem **agora**, lido depois da escalada. Sem isto a resposta seria
 *  "tentei de novo", que não é informação — com isto, ou o texto entrou e isso é dito, ou não
 *  entrou e o modelo para de insistir neste campo. */
async function readValue(tabId: number, action: BrowserAction): Promise<string | null> {
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "agent:value", action }, { frameId: 0 }) as Promise<{ value?: string } | null>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
    ]);
    return response?.value ?? null;
  } catch { return null; }
}

async function watchPage(tabId: number, milliseconds: number): Promise<{ mutated: boolean; navigated: boolean }> {
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "agent:watch", milliseconds }, { frameId: 0 }) as Promise<{ mutated: boolean; navigated: boolean }>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), milliseconds + 800)),
    ]);
    return response ?? { mutated: false, navigated: false };
  } catch {
    return { mutated: false, navigated: false };
  }
}

async function escalate(tabId: number, action: BrowserAction, result: ActionResult): Promise<ActionResult> {
  const attempt = span("action", `modo preciso: ${action.type}`, { action });

  let dispatched: { ok: boolean; detail: string };
  if (action.type === "click" || action.type === "type") {
    const point = await chrome.tabs.sendMessage(tabId, { type: "agent:locate", action }, { frameId: 0 })
      .catch(() => null) as { x: number; y: number } | null;
    if (!point) {
      attempt.end({ ok: false, data: { motivo: "o alvo não pôde ser localizado na tela" } });
      return result;
    }
    if (action.type === "type") {
      dispatched = await preciseFill(tabId, point, action.text, action.mode ?? "replace");
      if (!dispatched.ok) {
        attempt.end({ ok: false, data: { detail: dispatched.detail } });
        return { ...result, summary: `${result.summary} Tentei repetir pelo modo preciso e não deu: ${dispatched.detail}.` };
      }
      // Digitação se confere lendo o campo, não observando a página: um campo preenchido pode não
      // mudar nada em volta, e `agent:watch` diria "nada mudou" sobre uma digitação bem-sucedida.
      const value = await readValue(tabId, action);
      const landed = value !== null && (action.mode === "append" ? value.includes(action.text) : value.trim() === action.text.trim());
      attempt.end({ ok: landed, data: { detail: dispatched.detail, value } });
      return landed
        ? { ok: true, summary: `Preenchi o campo pelo modo preciso (evento confiável): ele agora tem “${(value ?? "").slice(0, 60)}”.` }
        : { ...result, summary: `${result.summary} Repeti pelo modo preciso (evento confiável) e o campo continua ${value === null ? "ilegível" : `com “${value.slice(0, 60)}”`} — este campo não aceita ser preenchido por fora. Peça ao usuário (request_user) ou procure outro caminho.` };
    }
    dispatched = await preciseClick(tabId, point);
  } else if (action.type === "hover") {
    const point = await chrome.tabs.sendMessage(tabId, { type: "agent:locate", action }, { frameId: 0 })
      .catch(() => null) as { x: number; y: number } | null;
    if (!point) {
      attempt.end({ ok: false, data: { motivo: "o alvo não pôde ser localizado na tela" } });
      return result;
    }
    dispatched = await preciseHover(tabId, point);
  } else if (action.type === "keyPress") {
    dispatched = await preciseKey(tabId, action.key);
  } else {
    attempt.end({ ok: false, data: { motivo: "ação sem escalada definida" } });
    return result;
  }

  if (!dispatched.ok) {
    attempt.end({ ok: false, data: { detail: dispatched.detail } });
    return { ...result, summary: `${result.summary} Tentei repetir pelo modo preciso e não deu: ${dispatched.detail}.` };
  }

  const reaction = await watchPage(tabId, 700);
  attempt.end({ ok: true, data: { ...reaction, detail: dispatched.detail } });

  if (reaction.navigated) return { ...result, summary: `${result.summary} Repeti pelo modo preciso (evento confiável) e a página navegou; releia com extractPage.` };
  if (reaction.mutated) return { ...result, summary: `${result.summary} Repeti pelo modo preciso (evento confiável) e a página reagiu; releia com extractPage para ver o que mudou.` };
  return { ...result, summary: `${result.summary} Repeti pelo modo preciso (evento confiável) e ainda assim nada mudou — este alvo provavelmente não faz o que você espera. Procure outro caminho.` };
}

export async function executeAction(action: BrowserAction, autonomy: Autonomy): Promise<ActionResult> {
  const actionId = crypto.randomUUID();
  const actionSpan = span("action", action.type, { action });
  const result = await runAction(action, autonomy);
  actionSpan.end({
    ok: result.ok,
    code: result.ok ? undefined : result.code,
    actionId,
    data: { action, summary: result.summary, noEffect: result.ok && result.summary.includes("sem efeito perceptível") },
  });
  /*
   * O que a página devolveu, inteiro e sem recorte.
   *
   * O resumo da ação diz "página lida: 40 elementos"; o que o modelo leu foram os quarenta
   * elementos. Numa revisão de "por que ela não clicou no botão certo", a resposta está na lista,
   * não no resumo dela. Só no modo completo, porque é o maior payload que a Vela produz.
   */
  if (result.ok && result.content) {
    recordFull("page.read", `conteúdo devolvido por ${action.type}`, { actionId, data: { url: result.url, conteudo: result.content, caracteres: result.content.length } });
  }
  return result;
}

async function runAction(action: BrowserAction, autonomy: Autonomy): Promise<ActionResult> {
  const denied = autonomy === "observe" && !isReadOnly(action);
  const active = await activeTab();

  /*
   * O ref decide em que aba a ação acontece — ele guarda de onde foi lido. Sem ref, a aba é a
   * ativa, como sempre foi. Isso elimina uma classe inteira de erro silencioso: antes, um ref
   * lido na aba A e usado depois que o usuário trocou para a aba B era aplicado em B, onde o
   * número por acaso apontava para outro elemento.
   */
  const refInAction = "ref" in action ? action.ref : undefined;
  const routed = refInAction ? routeRef(refInAction, active?.id ?? -1) : await routeTab(action, active?.id);
  if (!routed.ok) return routed.failure;
  // Ref e tabId juntos, discordando, é engano de quem escreveu: o ref já sabe onde mora, e adivinhar
  // qual dos dois vale acertaria metade das vezes.
  if (refInAction && action.tabId !== undefined && action.tabId !== routed.tabId) {
    return failure("ref_desconhecido", `Você passou tabId ${action.tabId} junto com o ref ${refInAction}, que foi lido na aba ${routed.tabId}. Um ref pertence à aba onde apareceu — omita o tabId quando usar um ref.`);
  }
  if (routed.tabId < 0) return failure("no_tab", "Nenhuma aba ativa disponível.");
  const tab = routed.tabId === active?.id ? active : await chrome.tabs.get(routed.tabId).catch(() => null);
  if (!tab?.id) return failure("page_gone", `A aba ${routed.tabId}, onde esse elemento foi lido, não existe mais. Leia a página de novo na aba em que você quer trabalhar.`);
  const frameId = routed.frameId;
  let localAction = routed.ref !== undefined && "ref" in action ? { ...action, ref: routed.ref } : action;

  /*
   * Arrastar tem dois alvos, e o destino também é um ref público que precisa de tradução. Exigir
   * que os dois estejam no mesmo frame não é limitação inventada: as coordenadas do gesto são
   * relativas ao documento, e arrastar de um frame para outro não tem significado único.
   */
  if (action.type === "drag" && action.toRef) {
    const destino = routeRef(action.toRef, tab.id);
    if (!destino.ok) return destino.failure;
    if (destino.tabId !== tab.id || destino.frameId !== frameId) {
      return failure("unsupported", `Não dá para arrastar entre páginas ou quadros diferentes: ${action.ref ?? "a origem"} e ${action.toRef} não estão no mesmo lugar.`);
    }
    localAction = { ...localAction, toRef: destino.ref } as BrowserAction;
  }

  // Sem acesso aos sites, nada disto funciona — e a recusa precisa dizer que o conserto está numa
  // tela de configurações, não em outro caminho dentro da página.
  if (!(await hasHostAccess())) return failure("denied", HOST_ACCESS_MISSING);

  // Recusas baratas vêm antes da aprovação: não faz sentido consultar o usuário
  // sobre uma ação que já vai falhar por causa da página.
  if (action.type !== "navigate") {
    if (isRestrictedUrl(tab.url)) return failure("restricted_url", `Não dá para agir em ${tab.url ?? "esta página"}: ${restrictionReason(tab.url)}. Explique isso ao usuário e peça para ele abrir a página onde quer que você trabalhe.`);
    if (isPdf(tab.url) && action.type === "extractPage") return failure("unsupported", "Esta aba é um PDF; o leitor de página não funciona aqui. Use web_fetch nesta URL.");
  }

  if (!isReadOnly(action) && !denied) {
    const { label, changed } = await targetLabel(tab.id, frameId, localAction, routed.ref);
    // Um cartão de aprovação com rótulo obsoleto faria o usuário autorizar uma coisa e a Vela
    // executar outra. Diante de dúvida sobre o que o ref virou, não se pergunta: recusa-se.
    if (changed) return failure("ref_changed", `O elemento ${"ref" in action ? action.ref : ""} não é mais o que era quando você o leu. Não fiz nada. Chame find com o texto do que você procura para pegar o ref atual.`);
    const origin = originOf(tab.url);
    if (autonomy === "assist" || isRisky(action, label)) {
      const decision = await requestApproval(approvalKey(action, origin), describeAction(action, label), origin);
      // `unattended` deixou de significar "o painel está fechado": a aprovação vai ao painel, ao
      // Pulse da aba e, em último caso, a uma notificação. Chegar aqui significa que nenhuma das
      // três coube — e a única das três que o sistema pode bloquear é a notificação.
      if (decision === "unattended") return failure("denied", "Não houve como pedir sua aprovação: o painel está fechado, a aba não aceita a janelinha da Vela e as notificações do Chrome parecem bloqueadas. Peça ao usuário para abrir o painel, liberar as notificações, ou mudar a autonomia para Auto.");
      if (decision === "deny") return failure("denied", "O usuário não aprovou esta ação. Explique o que pretendia fazer e peça orientação, sem repetir a mesma chamada.");
    }
  }

  if (action.type === "navigate") {
    if (denied) return failure("denied", "Modo Observar: navegação bloqueada. Descreva o passo ao usuário ou peça para trocar a autonomia.");
    /*
     * O endereço veio da própria página? Então quem teve a ideia foi ela, e não o usuário. Ver
     * `domain-policy.ts` — é a única defesa real contra uma página instruir o agente a levar a
     * sessão logada da pessoa para outro lugar.
     */
    const gate = await gateNavigation(action.url, tab.url, (await loadSettings()).capabilities.domainGate);
    if (!gate.allowed) return failure("denied", gate.reason);
    let targetId = tab.id;
    if (action.newTab) {
      const created = await chrome.tabs.create({ url: action.url, active: false, openerTabId: tab.id });
      if (!created.id) return failure("nav_error", "Não foi possível abrir a aba.");
      targetId = created.id;
      // `chrome.tabs.create` feito pela própria extensão não dispara onCreatedNavigationTarget,
      // então a aba precisa ser adotada à mão ou fica de fora do grupo da tarefa.
      await adoptTab(created.id);
    } else {
      await chrome.tabs.update(tab.id, { url: action.url });
    }
    const outcome = await waitForNavigation(targetId, TIMEOUTS.navigate);
    if (!outcome.ok) return failure("nav_error", `Falha ao navegar para ${action.url}: ${outcome.error ?? "erro desconhecido"}.`);
    await waitForContentScript(targetId);
    return { ok: true, summary: `Abri ${outcome.url ?? action.url}${outcome.partial ? " (ainda carregando)" : ""}. Chame extractPage para ler a página.`, navigatedTo: outcome.url ?? action.url };
  }

  /*
   * Voltar e avançar passam pela API de abas, não por `history.back()` na página: a pilha de
   * navegação é da aba, e o content script só enxerga o documento em que está — num site que
   * substituiu o histórico, mexer de dentro anda para um lugar diferente do botão do navegador.
   */
  if (action.type === "history") {
    if (denied) return failure("denied", "Modo Observar: navegação bloqueada.");
    const urlAntes = tab.url;
    try {
      if (action.direction === "back") await chrome.tabs.goBack(tab.id);
      else await chrome.tabs.goForward(tab.id);
    } catch {
      return failure("nav_error", action.direction === "back" ? "Não há para onde voltar nesta aba." : "Não há para onde avançar nesta aba.");
    }
    await waitForNavigation(tab.id, 8_000);
    await waitForContentScript(tab.id);
    const depois = await chrome.tabs.get(tab.id).catch(() => null);
    return { ok: true, summary: `${action.direction === "back" ? "Voltei" : "Avancei"} para ${depois?.url ?? "a página anterior"}${depois?.url === urlAntes ? " (a URL não mudou)" : ""}. Chame extractPage para ler.`, navigatedTo: depois?.url };
  }

  if (action.type === "extractPage") return readAllFrames(tab.id, tab.url, action);

  /*
   * O mundo da página é território do site, não da extensão — por isso a injeção sai do content
   * script e passa pelo background, que é quem tem `chrome.scripting`. O gate de aprovação já
   * aconteceu acima, junto com o das outras ações que modificam a página.
   */
  if (action.type === "evaluateScript") {
    const outcome = await evaluateInMainWorld(tab.id, frameId, action.script);
    return outcome.ok
      ? { ok: true, summary: "Script executado no mundo da página.", content: outcome.text }
      : failure("unsupported", outcome.text);
  }

  /*
   * A captura é o único caminho para o que existe só em pixel — legenda dentro de miniatura,
   * gráfico, imagem sem texto alternativo. Ela não substitui o retrato: o retrato diz o que dá
   * para clicar, a captura diz o que a página parece. Por isso a resposta manda olhar os dois.
   *
   * JPEG a 55% e no máximo uma captura viva no histórico: imagem custa caro em contexto, e duas
   * telas quase idênticas ocupam o dobro sem dizer nada a mais.
   */
  if (action.type === "screenshot") {
    if (tab.windowId === undefined) return failure("no_tab", "A aba ativa não pertence a nenhuma janela.");
    /*
     * `captureVisibleTab` fotografa a aba **visível** da janela, não a que foi endereçada. Numa
     * aba de segundo plano ela devolveria a imagem de outra página sem avisar — o tipo de erro que
     * o modelo não teria como perceber, porque a imagem parece legítima.
     */
    if (!tab.active) return failure("unsupported", `A aba ${tab.id} não está em foco, e a captura só alcança a aba visível — ela devolveria a imagem de outra página. Use tab_manage (activate) para trazê-la à frente, ou leia com extractPage, que funciona em segundo plano.`);
    try {
      const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 });
      if (!raw) return failure("unsupported", "O Chrome não devolveu a captura desta aba.");
      const image = await shrink(raw);
      return { ok: true, summary: "Capturei a tela visível. Ela mostra só o que está na janela agora — role e capture de novo para ver o resto.", image };
    } catch (error) {
      return failure("unsupported", `Não consegui capturar esta aba: ${error instanceof Error ? error.message : "erro desconhecido"}.`);
    }
  }

  if (CURSOR_ACTIONS.includes(action.type)) await beginTrace(tab.id);

  /*
   * A busca começa pelo caminho que já funcionou neste site, quando existe um.
   *
   * O atalho não decide nada: ele entra como candidato na varredura normal (ver `findElements`).
   * O que ele economiza é a chance de a pontuação escolher outro elemento parecido — que é o erro
   * caro, porque leva a agir no lugar errado em vez de simplesmente não achar.
   */
  const usaCache = (await loadSettings()).capabilities.routeCache;
  let comCache = localAction;
  if (usaCache && action.type === "find" && action.query && tab.url) {
    const lembrado = await recallRoute(tab.url, action.query);
    if (lembrado) comCache = { ...localAction, hint: lembrado } as BrowserAction;
  }

  const urlBefore = tab.url;
  const raw = await sendToTab(tab.id, {
    type: "agent:action",
    action: comCache,
    actionId: crypto.randomUUID(),
    ghost: denied,
    trace: await traceConfig(),
  }, TIMEOUTS[action.type], frameId);

  if (!raw?.ok) return raw ?? failure("timeout", "Sem resposta da página.");

  // Refs também voltam de `find`, não só do retrato. Antes, só a leitura de página os reescrevia,
  // e os do find saíam sem identificação de frame — funcionavam por acaso, enquanto o alvo
  // estivesse no frame de cima.
  const result: ActionResult = raw.content
    ? { ...raw, content: allocateRefs(raw.content, { tabId: tab.id, frameId, epoch: raw.epoch ?? "" }) }
    : raw;
  // Todo endereço que aparece numa página lida fica marcado como ideia **da página**.
  if (result.ok && result.content) noteSource("page", result.content);

  /*
   * O atalho é atualizado pelo desfecho, não pela intenção: a busca que achou grava o caminho, e
   * a que não achou apaga o que estava guardado. Um atalho que mente uma vez custa mais do que
   * nunca ter existido, porque será tentado com confiança na próxima.
   */
  if (usaCache && action.type === "find" && action.query && tab.url) {
    if (result.ok && result.bestSelector) void rememberRoute(tab.url, action.query, result.bestSelector);
    else if (!result.ok) void forgetRoute(tab.url, action.query);
  }

  // Coordenada de viewport só faz sentido numa aba que está renderizando: em segundo plano o
  // layout pode estar desatualizado, e o clique confiável cairia no lugar errado.
  if (frameId === 0 && tab.active && wantsEscalation(action, result) && cdpAvailable() && (await loadSettings()).agent.preciseMode) {
    return escalate(tab.id, localAction, result);
  }

  // Clique pode disparar navegação implícita; sem detectar isso o próximo snapshot vem da página velha.
  if (action.type === "click" || (action.type === "type" && action.submit) || action.type === "keyPress") {
    const outcome = await Promise.race([
      waitForNavigation(tab.id, 1200),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1300)),
    ]);
    if (outcome && outcome.ok && outcome.url && outcome.url !== urlBefore) {
      await waitForContentScript(tab.id);
      return { ...result, summary: `${result.summary} A página navegou para ${outcome.url}; releia com extractPage.`, navigatedTo: outcome.url };
    }
  }
  return result;
}

async function traceConfig() {
  const settings = await loadSettings();
  return { cursor: settings.agent.showCursor, border: settings.agent.showControlBorder, highlight: settings.agent.showTargetHighlights, speed: settings.agent.cursorSpeed };
}
