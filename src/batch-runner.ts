import { AgentEvent, AppSettings } from "./types";
import { ToolCall } from "./provider";
import { Emit } from "./messages";
import { requestApproval } from "./approvals";
import { span } from "./trace";

/**
 * Várias ações numa ida só ao modelo.
 *
 * O custo dominante de uma tarefa não é executar o clique — é a rodada inteira que precede cada
 * clique: a requisição ao modelo, o histórico reenviado, o tempo até o primeiro token. Uma tarefa
 * de doze passos pagava isso doze vezes, mesmo quando os passos eram óbvios desde o início
 * ("clicar no campo, digitar, Enter"). Aqui ela paga uma vez.
 *
 * Três regras que definem o que o lote é:
 *
 * - **Sequencial, nunca paralelo.** Cada passo muda a página para o seguinte; paralelizar seria
 *   clicar em três lugares de uma tela que já não existe.
 * - **Para no primeiro erro.** Um lote é uma previsão: "depois disto, aquilo". Quando um passo
 *   falha, a previsão está errada dali para a frente, e continuar executaria os passos seguintes
 *   contra uma página em estado desconhecido — que é exatamente como um lote transforma um erro
 *   pequeno num estrago grande.
 * - **Não aninha.** Um lote dentro de outro só serviria para escapar do teto de itens.
 */

/** Só ações de navegador entram. Memória, delegação e escrita de script não ganham nada em lote e
 *  perderiam a aprovação individual que cada uma tem hoje. */
const ALLOWED = new Set(["browser_action", "tab_manage"]);
const MAX_ITEMS = 10;

export type BatchItem = { name: string; input: Record<string, unknown> };
export type RunOne = (call: ToolCall, settings: AppSettings) => Promise<{ content: string; event: AgentEvent; image?: string }>;

const isError = (content: string) => content.startsWith("ERRO [");

function chavePlano(plano: string) {
  let resultado = 2166136261;
  for (let index = 0; index < plano.length; index += 1) {
    resultado ^= plano.charCodeAt(index);
    resultado = Math.imul(resultado, 16777619);
  }
  return (resultado >>> 0).toString(36);
}

/** O script vai no cartão (até um limite): aprovar código sem vê-lo não é aprovar. */
function scriptDe(item: BatchItem) {
  const script = typeof item.input.script === "string" ? item.input.script : "";
  return script ? `\n   código: ${script.slice(0, 600)}${script.length > 600 ? "…" : ""}` : "";
}

/** Uma linha por item, do jeito que o modelo precisa ler: o que era, e o que deu. */
function describeItem(item: BatchItem) {
  const action = typeof item.input.action === "string" ? item.input.action : item.input.op;
  const detalhe = [item.input.url, item.input.text, item.input.ref, item.input.selector, item.input.key, item.input.query]
    .filter((value) => typeof value === "string" && value)
    .map((value) => `“${String(value).slice(0, 40)}”`)
    .join(" ");
  return `${item.name}${action ? `/${action}` : ""}${detalhe ? ` ${detalhe}` : ""}`;
}

export async function runBatch(items: BatchItem[], settings: AppSettings, emit: Emit, runOne: RunOne): Promise<{ content: string; event: AgentEvent; image?: string }> {
  if (!Array.isArray(items) || !items.length) {
    return { content: "ERRO [unsupported] O lote veio vazio. Passe items como uma lista de {name, input}.", event: { kind: "error", text: "Lote vazio." } };
  }
  const invalid = items.find((item) => !ALLOWED.has(item?.name));
  if (invalid) {
    return {
      content: `ERRO [unsupported] “${invalid?.name}” não pode ir dentro de um lote. Só ${[...ALLOWED].join(" e ")} podem. Chame essa ferramenta separadamente.`,
      event: { kind: "error", text: `Ferramenta fora do lote: ${invalid?.name}.` },
    };
  }
  if (items.length > MAX_ITEMS) {
    return { content: `ERRO [unsupported] O lote tem ${items.length} itens e o máximo é ${MAX_ITEMS}. Previsões muito longas erram no meio; divida em dois lotes.`, event: { kind: "error", text: "Lote longo demais." } };
  }

  /*
   * Uma aprovação para o lote, não uma por item.
   *
   * Em modo Assistir, dez cartões em sequência para uma ação que a pessoa entende como uma só
   * anulariam o ganho: ela aprovaria no automático, que é pior do que não perguntar. O cartão
   * mostra o plano inteiro — e é por isso que ele pode valer por todos os passos.
   */
  const plano = items.map((item, index) => `${index + 1}. ${describeItem(item)}${scriptDe(item)}`).join("\n");
  if (settings.agent.autonomy === "assist") {
    /*
     * A chave é o plano, não a palavra "lote".
     *
     * Com uma chave fixa, "sempre nesta tarefa" num lote de três cliques aprovava de antemão todo
     * lote seguinte — inclusive um com navegação e script, rodando como Auto sem ninguém ver o
     * plano. Aprovar para a sessão vale para repetir **este** plano, que é o que a pessoa leu.
     */
    const decision = await requestApproval(`batch:${chavePlano(plano)}`, `Executar ${items.length} ações em sequência`, plano);
    if (decision === "unattended") return { content: "ERRO [denied] Não houve como pedir sua aprovação para o lote. Execute uma ação por vez ou peça ao usuário para abrir o painel.", event: { kind: "error", text: "Lote sem superfície de aprovação." } };
    if (decision === "deny") return { content: "ERRO [denied] O usuário não aprovou este lote. Explique o que pretendia fazer e pergunte como seguir.", event: { kind: "error", text: "Lote recusado pelo usuário." } };
  }

  /*
   * Aprovado o plano, os itens rodam como em Auto — mas só isso. O gate de ação irreversível
   * (comprar, pagar, excluir) continua valendo item a item, porque em Auto ele também vale: quem
   * aprovou uma sequência de passos não aprovou a compra que um deles pode disparar.
   */
  const itemSettings: AppSettings = settings.agent.autonomy === "assist"
    ? { ...settings, agent: { ...settings.agent, autonomy: "auto" } }
    : settings;

  const batchSpan = span("tool.call", `lote de ${items.length}`, { itens: items.map(describeItem) });
  const lines: string[] = [];
  let image: string | undefined;
  let failedAt = -1;

  for (const [index, item] of items.entries()) {
    emit({ type: "chat:event", event: { kind: "status", text: `Lote ${index + 1}/${items.length}: ${describeItem(item)}` } });
    const { content, event, image: shot } = await runOne({ id: `batch-${index}`, name: item.name, arguments: JSON.stringify(item.input ?? {}) }, itemSettings);
    if (shot) image = shot;
    lines.push(`${index + 1}. ${describeItem(item)} → ${content.replace(/\n+/g, " ").slice(0, 400)}`);
    if (isError(content) || event.kind === "error") { failedAt = index; break; }
  }

  const ok = failedAt < 0;
  batchSpan.end({ ok, data: { total: items.length, executados: lines.length, falhouNoItem: ok ? undefined : failedAt + 1 } });

  const restantes = items.length - (failedAt + 1);
  const naoRodaram = restantes <= 0 ? ""
    : restantes === 1 ? `; o item ${items.length} não rodou`
    : `; os itens ${failedAt + 2} a ${items.length} não rodaram`;
  const rodape = ok
    ? `\nOs ${items.length} passos rodaram. Leia os resultados acima antes do próximo lote.`
    : `\nO lote parou no item ${failedAt + 1}${naoRodaram}. A página está no estado em que o item ${failedAt + 1} a deixou — leia antes de tentar de novo, e não repita o lote inteiro às cegas.`;

  return {
    content: [lines.join("\n"), rodape].join("\n"),
    event: { kind: ok ? "result" : "error", text: ok ? `Lote de ${items.length} ações concluído.` : `Lote parou no item ${failedAt + 1} de ${items.length}.` },
    ...(image ? { image } : {}),
  };
}

/** Contagem para as estatísticas: quantas ações couberam numa ida só ao modelo. */
export const batchSize = (items: unknown) => Array.isArray(items) ? items.length : 0;
