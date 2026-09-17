import { record } from "./trace";

/**
 * Quem cuida do depurador: quando anexar, por quanto tempo, e quando soltar.
 *
 * Anexar custa duas coisas. Uma é tempo — entre cem e duzentos milissegundos por vez, que numa
 * tarefa com muitas escaladas vira meio segundo de espera por nada. A outra é visível: enquanto
 * anexado, o Chrome mostra a faixa "a Vela está depurando este navegador" no topo da janela.
 *
 * O desenho antigo pagava o primeiro custo para evitar o segundo, anexando e soltando a cada
 * ação. Funciona quando a escalada é rara; quando a tarefa inteira depende do caminho confiável,
 * paga o anexo dezenas de vezes e ainda pisca a faixa dezenas de vezes.
 *
 * A saída é não escolher de véspera: **começa pontual e promove sozinho**. Passadas algumas ações
 * na mesma aba dentro do mesmo turno, o custo repetido do anexo já superou o incômodo da faixa, e
 * a sessão passa a ficar de pé até o fim do turno. Tarefa curta nunca chega lá e a faixa quase não
 * aparece; tarefa longa paga o anexo uma vez.
 *
 * Nada disso acontece sem o interruptor `cdpSession`: sem ele, o comportamento é o pontual de
 * sempre. Permissão declarada não é permissão exercida.
 */

const PROTOCOL = "1.3";
/** Ações na mesma aba a partir das quais manter a sessão sai mais barato que reanexar. */
const PROMOTE_AFTER = 5;

type Holder = "action" | "observe";
type State = { attached: boolean; holders: Set<Holder>; actions: number; sticky: boolean; domains: Set<string> };

const states = new Map<number, State>();
let allowSticky = false;

const stateOf = (tabId: number): State => {
  const existing = states.get(tabId);
  if (existing) return existing;
  const fresh: State = { attached: false, holders: new Set(), actions: 0, sticky: false, domains: new Set() };
  states.set(tabId, fresh);
  return fresh;
};

export const cdpAvailable = () => typeof chrome !== "undefined" && !!chrome.debugger;

/** O turno decide se a promoção pode acontecer; a decisão não é por ação. */
export function configureSticky(enabled: boolean) { allowSticky = enabled; }

async function attach(tabId: number): Promise<boolean> {
  const state = stateOf(tabId);
  if (state.attached) return true;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
    state.attached = true;
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    /*
     * "Another debugger is already attached" é o caso real mais comum: o DevTools está aberto
     * naquela aba. Não há o que fazer além de degradar para o caminho DOM — e dizer por quê, para
     * o modelo não insistir numa escalada que nunca vai acontecer enquanto a janela estiver ali.
     */
    record("error", "não consegui anexar o depurador", { ok: false, code: "cdp", data: { tabId, message } });
    state.attached = false;
    return false;
  }
}

async function detach(tabId: number) {
  const state = states.get(tabId);
  if (!state?.attached) return;
  state.attached = false;
  state.domains.clear();
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
}

export function send(tabId: number, method: string, params: Record<string, unknown> = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/** Liga um domínio do protocolo uma vez só por sessão — `Network.enable` repetido é desperdício. */
export async function enableDomain(tabId: number, domain: string) {
  const state = stateOf(tabId);
  if (state.domains.has(domain)) return;
  await send(tabId, `${domain}.enable`);
  state.domains.add(domain);
}

/**
 * Empresta o depurador para um trecho de trabalho.
 *
 * Quem pede como `action` contribui para a promoção; quem pede como `observe` (a leitura de
 * console e de rede) segura a sessão enquanto durar, porque um buffer que só existe entre anexos
 * não registraria nada.
 */
export async function withSession<T>(tabId: number, holder: Holder, work: () => Promise<T>, onUnavailable: () => T): Promise<T> {
  if (!cdpAvailable()) return onUnavailable();
  const state = stateOf(tabId);
  if (holder === "action") state.actions += 1;
  if (allowSticky && state.actions >= PROMOTE_AFTER && !state.sticky) {
    state.sticky = true;
    record("action", "depurador fica anexado até o fim do turno", { data: { tabId, acoes: state.actions } });
  }

  const ready = await attach(tabId);
  if (!ready) return onUnavailable();
  state.holders.add(holder);
  try {
    return await work();
  } finally {
    if (holder === "action") state.holders.delete("action");
    if (!state.sticky && !state.holders.size) await detach(tabId);
  }
}

/**
 * Solta a gravação de console e rede daquela aba.
 *
 * Um observador não pode ser liberado no `finally` como a ação é: o buffer precisa continuar
 * recebendo eventos depois que a chamada que o ligou já respondeu — é esse o ponto de gravar.
 */
export async function releaseObserver(tabId: number) {
  const state = states.get(tabId);
  if (!state) return;
  state.holders.delete("observe");
  if (!state.sticky && !state.holders.size) await detach(tabId);
}

/** Quem quiser ser avisado de que a sessão acabou — hoje, a gravação de console e rede. */
const onEnd: Array<(tabId: number) => void> = [];
export const whenSessionEnds = (handler: (tabId: number) => void) => { onEnd.push(handler); };

/**
 * Fim do turno: nada de depurador anexado sobrando entre uma tarefa e outra.
 *
 * Avisar quem observava é obrigatório, e não cortesia. Desanexar apaga os domínios do protocolo
 * (`Network.enable` e companhia) mas não apaga a anotação de "esta aba está sendo observada" que
 * vive em `page-observability.ts` — e uma anotação sem gravação faz a leitura seguinte responder
 * "já estava gravando" sobre um buffer que ninguém estava alimentando. Silêncio que parece dado.
 */
export async function endCdpSessions() {
  for (const [tabId, state] of states) {
    state.sticky = false;
    state.actions = 0;
    state.holders.clear();
    await detach(tabId);
    for (const handler of onEnd) handler(tabId);
  }
  states.clear();
}

/** O usuário abriu o DevTools, fechou a aba, ou o Chrome soltou por conta própria. */
if (typeof chrome !== "undefined" && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    const state = states.get(source.tabId);
    if (!state) return;
    state.attached = false;
    state.domains.clear();
    record("error", "o depurador foi solto", { ok: false, code: "cdp", data: { tabId: source.tabId, reason } });
  });
}
