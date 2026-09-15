/**
 * Rodar o script do modelo **no mundo da página**, e não ao lado dele.
 *
 * O `evaluateScript` de sempre roda no mundo isolado: enxerga o DOM, que é compartilhado, e não
 * enxerga nada do JavaScript do site — nem uma variável global que a página definiu, nem o estado
 * interno de um framework, nem o objeto que guarda o carrinho. Para a maioria dos casos isso
 * basta e é o modo certo, porque nada do que o modelo escrever pode interferir no site.
 *
 * Há um resto que só existe no mundo da página, e é onde o degrau final da escada costumava
 * morrer: componente que só reage a um método interno, dado que nunca chega ao DOM, estado que a
 * página guarda em memória. Este módulo alcança esse resto.
 *
 * Duas consequências que justificam o interruptor próprio e o pedido de aprovação:
 *
 * - **É poder de site, não de extensão.** O código roda com a mesma autoridade do JavaScript da
 *   página, numa aba onde a pessoa está logada.
 * - **A página pode impedir.** Um site com CSP estrito bloqueia a construção dinâmica de função,
 *   e aí a resposta diz isso com todas as letras em vez de devolver um erro opaco — o modelo
 *   precisa saber que o caminho não existe naquele site, não que o script dele estava errado.
 */

type Outcome = { ok: boolean; text: string };

/**
 * O corpo injetado é autocontido de propósito: o Chrome serializa esta função e a executa do
 * outro lado, onde nada do módulo existe. Serializar ali dentro também é obrigatório — o retorno
 * atravessa um clone estruturado, e um `Element` ou um `Map` não sobrevivem à travessia.
 */
function injected(source: string) {
  const describe = (value: unknown, depth = 0): string => {
    if (value === undefined) return "Script executado sem retorno explícito.";
    if (value === null) return "null";
    if (typeof value === "bigint") return `${value.toString()}n`;
    if (typeof value === "function") return value.toString().slice(0, 300);
    if (typeof value !== "object") return String(value);
    if (value instanceof Element) {
      const attrs = value.getAttributeNames().map((name) => `${name}="${(value.getAttribute(name) ?? "").slice(0, 80)}"`).join(" ");
      const text = (value.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      return `<${value.tagName.toLowerCase()}${attrs ? ` ${attrs}` : ""}>${text ? ` texto="${text}"` : ""}`;
    }
    if (value instanceof Node) return (value.textContent ?? "").slice(0, 300);
    if (depth > 2) return "[…]";
    if (value instanceof Map) return describe(Object.fromEntries(value), depth + 1);
    if (value instanceof Set) return describe([...value], depth + 1);
    if (Array.isArray(value) || value instanceof NodeList || value instanceof HTMLCollection) {
      const list = Array.from(value as ArrayLike<unknown>);
      return `[${list.length} item(ns)] ${list.slice(0, 30).map((item) => describe(item, depth + 1)).join(" | ").slice(0, 1500)}`;
    }
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
  };

  try {
    const run = new Function(`return (async () => { ${source} })();`) as () => Promise<unknown>;
    return Promise.resolve(run())
      .then((value) => ({ ok: true, text: describe(value) }))
      .catch((error: unknown) => ({ ok: false, text: error instanceof Error ? error.message : String(error) }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // "unsafe-eval" é o sintoma de CSP estrito, e a recuperação é outra: não adianta reescrever o
    // script, porque nenhum script construído em tempo de execução vai rodar naquele site.
    const csp = /unsafe-eval|Content Security Policy|EvalError/i.test(message);
    return Promise.resolve({ ok: false, text: csp ? `__CSP__${message}` : message });
  }
}

export async function evaluateInMainWorld(tabId: number, frameId: number, source: string): Promise<Outcome> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      func: injected,
      args: [source],
    });
    const outcome = result?.result as Outcome | undefined;
    if (!outcome) return { ok: false, text: "O script rodou no mundo da página mas não devolveu nada legível." };
    if (!outcome.ok && outcome.text.startsWith("__CSP__")) {
      return { ok: false, text: `Este site proíbe executar código montado na hora (Content Security Policy), então nenhum script seu vai rodar no mundo da página aqui. Não reescreva o script: use world "isolated" para mexer no DOM, ou resolva pela interface. Detalhe do navegador: ${outcome.text.slice(7, 200)}` };
    }
    return outcome;
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : "Não consegui injetar o script no mundo da página." };
  }
}
