/**
 * WebMCP: a página declara ferramentas semânticas em `document.modelContext` e a Vela as usa
 * em vez de imitar cliques. O mundo isolado do content script enxerga o que a página registrou,
 * então não é preciso injetar no mundo principal nem montar ponte de postMessage.
 *
 * Disponível no Chrome atrás de --enable-features=WebMCP, só em HTTPS.
 * `navigator.modelContext` foi descontinuado em favor de `document.modelContext`.
 */

export type PageTool = { name: string; description?: string; inputSchema?: unknown };

/** Assinatura verificada no Chrome 152: executeTool recebe o objeto vindo de getTools()
 *  e os argumentos como **string JSON** — objeto solto falha com "Failed to parse input arguments". */
type ModelContext = {
  getTools: () => Promise<PageTool[]>;
  executeTool: (tool: PageTool, args: string) => Promise<unknown>;
};

function modelContext(): ModelContext | null {
  const holder = document as unknown as { modelContext?: ModelContext };
  const legacy = navigator as unknown as { modelContext?: ModelContext };
  return holder.modelContext ?? legacy.modelContext ?? null;
}

export const supportsPageTools = () => modelContext() !== null;

export async function listPageTools(): Promise<PageTool[]> {
  const context = modelContext();
  if (!context) return [];
  try {
    const tools = await context.getTools();
    return Array.isArray(tools) ? tools.slice(0, 30) : [];
  } catch { return []; }
}

export async function callPageTool(name: string, args: unknown): Promise<{ ok: boolean; text: string }> {
  const context = modelContext();
  if (!context) return { ok: false, text: "Esta página não expõe ferramentas." };
  try {
    const tools = await context.getTools();
    const tool = tools.find((item) => item.name === name);
    if (!tool) return { ok: false, text: `A página não oferece a ferramenta “${name}”. Chame extractPage para ver as disponíveis.` };
    const result = await context.executeTool(tool, JSON.stringify(args ?? {}));
    return { ok: true, text: renderToolResult(result) };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : "A ferramenta da página falhou." };
  }
}

/** O retorno segue o formato MCP — mas chega como **string JSON**, não como objeto. */
function renderToolResult(result: unknown): string {
  if (typeof result === "string") {
    try { return renderToolResult(JSON.parse(result)); } catch { return result.slice(0, 6000); }
  }
  const shaped = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null;
  const parts = shaped?.content?.flatMap((item) => item?.text ? [item.text] : []) ?? [];
  if (parts.length) return parts.join("\n").slice(0, 6000);
  try { return JSON.stringify(result).slice(0, 6000); } catch { return "A ferramenta respondeu, mas o retorno não é legível."; }
}

export function describePageTools(tools: PageTool[]): string {
  if (!tools.length) return "";
  const lines = tools.map((tool) => {
    const schema = tool.inputSchema ? ` args=${JSON.stringify(tool.inputSchema).slice(0, 200)}` : "";
    return `- ${tool.name}: ${(tool.description ?? "").slice(0, 120)}${schema}`;
  });
  return ["", "# Ferramentas oferecidas pela página", ...lines].join("\n");
}
