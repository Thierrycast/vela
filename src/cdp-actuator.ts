import { send, withSession } from "./cdp-session";

/**
 * Modo preciso: o clique e a tecla que o navegador considera **confiáveis**.
 *
 * O caminho DOM cobre a maioria dos casos — um `click()` não-confiável executa a activation
 * behavior de verdade (submete formulário, marca checkbox, segue link). O que ele nunca faz é a
 * ação padrão de teclado, e alguns sites checam `event.isTrusted` explicitamente. Aí a página
 * simplesmente não reage, e o resultado da ação sai como "sem efeito perceptível".
 *
 * Este módulo é a escalada para esses casos: os eventos vêm do CDP (`Input.*`), indistinguíveis
 * de uma pessoa usando o mouse.
 *
 * Três decisões que valem mais que o código:
 *
 * - **É escalada, não padrão.** Só entra depois de o caminho DOM ter tentado e nada ter mudado.
 *   Depurador anexado é caro e visível; usar sempre seria pagar isso em toda ação.
 * - **Quem decide anexar e soltar é `cdp-session.ts`**, não cada função daqui. O anexo começa
 *   pontual e, se a tarefa insistir no caminho confiável, se mantém até o fim do turno — o custo
 *   repetido de reanexar supera o incômodo da faixa de aviso a partir de um certo número de ações.
 * - **Nasce desligado.** `debugger` não pode ser permissão opcional (o Chrome recusa listá-la
 *   assim), então ela está no manifest desde a instalação — mas usar é escolha do usuário em
 *   Configurações → Agente. Permissão declarada não é permissão exercida.
 */

type Point = { x: number; y: number };
type Outcome = { ok: boolean; detail: string };

const indisponivel = (): Outcome => ({ ok: false, detail: "o depurador não pôde ser anexado a esta aba (o DevTools pode estar aberto nela)" });

/**
 * Um clique de verdade: mover, apertar, soltar — nessa ordem, como um mouse faz.
 *
 * `clickCount: 3` é o triplo clique, que seleciona o conteúdo do campo. É assim que se limpa um
 * campo pelo caminho confiável: `Input.insertText` substitui a seleção, então selecionar tudo
 * antes equivale a trocar o valor. Mais fiável que Ctrl+A, que depende do modificador certo por
 * sistema operacional.
 */
export async function preciseClick(tabId: number, point: Point, options: { clickCount?: number } = {}): Promise<Outcome> {
  return withSession(tabId, "action", async () => {
    try {
      const base = { x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: options.clickCount ?? 1, buttons: 1 };
      await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved", buttons: 0 });
      await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
      await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 });
      return { ok: true, detail: "clique confiável despachado" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "o comando de clique falhou" };
    }
  }, indisponivel);
}

/** Texto no elemento em foco. `Input.insertText` não simula teclas, mas passa por `isTrusted`. */
export async function preciseType(tabId: number, text: string): Promise<Outcome> {
  return withSession(tabId, "action", async () => {
    try {
      await send(tabId, "Input.insertText", { text });
      return { ok: true, detail: "texto inserido pelo caminho confiável" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "o comando de inserção falhou" };
    }
  }, indisponivel);
}

/**
 * Preencher um campo pelo caminho confiável, do foco ao texto, **num anexo só**.
 *
 * Digitar exige três gestos — pôr o cursor no campo, decidir o que fazer com o que já está lá, e
 * escrever — e cada um deles, se fosse uma chamada separada daqui, anexaria e desanexaria o
 * depurador por conta própria. Três vezes o custo do anexo e três piscadas da faixa de aviso para
 * uma ação que a pessoa percebe como única.
 *
 * `replace` seleciona o conteúdo com o triplo clique e deixa o `insertText` substituí-lo;
 * `append` clica e vai para o fim da linha, senão o texto entraria onde o clique caiu — no meio
 * da palavra em que o cursor por acaso parou.
 */
export async function preciseFill(tabId: number, point: Point, text: string, mode: "replace" | "append"): Promise<Outcome> {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  const clickCount = mode === "replace" ? 3 : 1;
  return withSession(tabId, "action", async () => {
   try {
    const base = { x, y, button: "left", clickCount, buttons: 1 };
    await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved", buttons: 0 });
    await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 });
    if (mode === "append") {
      const end = KEY_CODES.End;
      await send(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...end });
      await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...end });
    }
    await send(tabId, "Input.insertText", { text });
    return { ok: true, detail: `campo focado e preenchido pelo caminho confiável (${mode === "replace" ? "conteúdo anterior selecionado e substituído" : "acrescentado ao fim"})` };
   } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "o comando de preenchimento falhou" };
   }
  }, indisponivel);
}

const KEY_CODES: Record<string, { code: string; key: string; windowsVirtualKeyCode: number; text?: string }> = {
  Enter: { code: "Enter", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { code: "Tab", key: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", key: "ArrowRight", windowsVirtualKeyCode: 39 },
  Backspace: { code: "Backspace", key: "Backspace", windowsVirtualKeyCode: 8 },
  End: { code: "End", key: "End", windowsVirtualKeyCode: 35 },
  Home: { code: "Home", key: "Home", windowsVirtualKeyCode: 36 },
};

/** Tecla com ação padrão — é o caso que evento sintético nunca cobre. */
export async function preciseKey(tabId: number, key: string): Promise<Outcome> {
  const descriptor = KEY_CODES[key];
  if (!descriptor) return { ok: false, detail: `A tecla ${key} não está no mapa do modo preciso.` };
  return withSession(tabId, "action", async () => {
    try {
      await send(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...descriptor });
      if (descriptor.text) await send(tabId, "Input.dispatchKeyEvent", { type: "char", ...descriptor });
      await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...descriptor });
      return { ok: true, detail: `tecla ${key} despachada pelo caminho confiável` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "o comando de tecla falhou" };
    }
  }, indisponivel);
}

export { cdpAvailable } from "./cdp-session";
