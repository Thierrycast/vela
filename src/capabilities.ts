import { AppSettings, BrowserAction, Capabilities } from "./types";

/**
 * O mapa entre o que o modelo pede e o interruptor que autoriza aquilo.
 *
 * Vive num módulo próprio porque é consultado nas duas pontas do mesmo fluxo — `provider.ts`
 * decide o que **anunciar** e `tool-runner.ts` decide o que **executar** — e as duas precisam
 * concordar. Quando divergem, o modelo recebe uma ferramenta no catálogo e uma recusa ao usá-la,
 * que é o pior dos dois mundos: ele insiste, porque o catálogo disse que dava.
 *
 * Ação ou ferramenta que não aparece aqui não tem interruptor: é parte do mínimo que a Vela é.
 * Ler a página, clicar, digitar e navegar não são habilidades opcionais — sem elas não há agente.
 */

export const CAPABILITY_LABELS: Record<keyof Capabilities, string> = {
  batch: "Ações em lote",
  waitFor: "Espera inteligente",
  scriptIsolated: "Injetar script (mundo isolado)",
  scriptMain: "Injetar script (mundo da página)",
  hover: "Passar o mouse por cima",
  drag: "Arrastar e soltar",
  history: "Voltar e avançar",
  cdpSession: "Depurador durante a tarefa",
  readConsole: "Ler o console da página",
  readNetwork: "Ler a rede da página",
  tabAddressing: "Agir em aba endereçada",
  routeCache: "Lembrar caminhos por site",
  domainGate: "Aprovar troca de domínio",
  delegate: "Tarefas em segundo plano",
};

const ACTION_CAPABILITY: Partial<Record<BrowserAction["type"], keyof Capabilities>> = {
  evaluateScript: "scriptIsolated",
  waitFor: "waitFor",
  hover: "hover",
  drag: "drag",
  history: "history",
};

/** `evaluateScript` tem dois interruptores, um por mundo: ver o DOM e ver o JavaScript do site
 *  são poderes diferentes, e quem concede um não concede o outro por tabela. */
export function scriptCapability(world: string | undefined): keyof Capabilities {
  return world === "main" ? "scriptMain" : "scriptIsolated";
}

const TOOL_CAPABILITY: Record<string, keyof Capabilities> = {
  delegate_task: "delegate",
  browser_batch: "batch",
};

export const actionCapability = (type: BrowserAction["type"]) => ACTION_CAPABILITY[type];
export const toolCapability = (name: string) => TOOL_CAPABILITY[name];

export function isEnabled(settings: AppSettings, capability: keyof Capabilities | undefined) {
  return capability === undefined || settings.capabilities[capability];
}

export const isActionEnabled = (settings: AppSettings, type: BrowserAction["type"]) =>
  isEnabled(settings, actionCapability(type));

export const isToolEnabled = (settings: AppSettings, name: string) =>
  isEnabled(settings, toolCapability(name));

/**
 * A recusa nomeia o interruptor e onde ele fica. Uma recusa que só diz "não posso" faz o modelo
 * tentar outro caminho para a mesma coisa; uma que diz qual chave está desligada faz ele explicar
 * ao usuário o que precisa acontecer — e isso o usuário resolve em dois cliques.
 */
export function refuse(capability: keyof Capabilities): string {
  return `ERRO [desativado] A habilidade “${CAPABILITY_LABELS[capability]}” está desligada nas configurações da Vela (Configurações → Habilidades). Não insista nesta chamada: resolva por outro caminho, ou diga ao usuário que ele precisa ligar essa habilidade para você conseguir.`;
}
