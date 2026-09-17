import { AppSettings, BrowserAction, BrowserContext, ChatMessage, ProviderProfile } from "./types";
import { buildStateBlock, buildSystemPrompt } from "./system-prompt";
import { getMemory } from "./storage";
import { isActionEnabled, isToolEnabled } from "./capabilities";
import { recordFull } from "./trace";

export type ToolCall = { id: string; name: string; arguments: string };
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "telemetry"; values: Record<string, string> }
  | { type: "warning"; message: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** A ordem aqui é a ordem em que o modelo lê as opções; as de leitura vêm antes das de ação. */
const BROWSER_ACTIONS: Array<BrowserAction["type"]> = ["navigate", "click", "type", "keyPress", "scroll", "extractPage", "find", "screenshot", "hover", "drag", "selectOption", "history", "waitFor", "wait", "pageTool", "evaluateScript"];

/** Só um `false` explícito tira a visão: perfil antigo sem o campo continua enxergando. */
const enxerga = (settings: AppSettings) => settings.providers.find((item) => item.id === settings.activeProviderId)?.capabilities?.vision !== false;

const browserActionTool = (settings: AppSettings) => ({
  type: "function",
  function: {
    name: "browser_action",
    description: "Opera uma aba — a ativa por padrão, ou a que você indicar em tabId. Leia do mais leve ao mais pesado: find quando souber o que procura; extractPage para os elementos e refs; extractPage com extractMode text para ler o conteúdo (preços, mensagens, artigos); screenshot só para o que existe apenas em imagem. Prefira pageTool a simular cliques.",
    parameters: {
      type: "object",
      properties: {
        // Habilidade desligada some do enum: anunciar uma ação que será recusada só gasta rodada.
        // Modelo sem visão não recebe `screenshot`: a captura viraria texto por conversão no gateway,
        // o caminho mais lento para o que o DOM já entrega escrito.
        action: { type: "string", enum: BROWSER_ACTIONS.filter((type) => isActionEnabled(settings, type) && (type !== "screenshot" || enxerga(settings))) },
        tabId: { type: "number", description: "Em qual aba agir. Omita para a aba ativa. Use o número mostrado em <abas_da_sessao> quando quiser trabalhar numa aba sem tirar o usuário da dele. Não passe junto com ref: o ref já sabe de que aba veio." },
        url: { type: "string", description: "Para navigate." },
        newTab: { type: "boolean", description: "Para navigate: abre em aba nova dentro da sessão." },
        ref: { type: "string", description: "Identificador de elemento, como e412, copiado de um extractPage ou de um find. Continua válido em releituras da mesma página e diz sozinho em que aba agir; deixa de valer quando aquela aba navega. Nunca deduza um ref a partir de outro." },
        selector: { type: "string", description: "Seletor CSS. Use apenas se o elemento não estiver no extractPage." },
        toRef: { type: "string", description: "Para drag: o elemento de destino, no mesmo quadro da origem." },
        toSelector: { type: "string", description: "Para drag: destino por seletor CSS." },
        label: { type: "string", description: "Para selectOption: o texto da opção como ele aparece na tela." },
        index: { type: "number", description: "Para selectOption: a posição da opção, quando o texto não ajuda." },
        direction: { type: "string", enum: ["back", "forward"], description: "Para history." },
        text: { type: "string", description: "Para type." },
        submit: { type: "boolean", description: "Para type: pressiona Enter ao final." },
        mode: { type: "string", enum: ["replace", "append"], description: "Para type. Padrão replace." },
        key: { type: "string", description: "Para keyPress, ex.: Enter, Tab, ArrowDown." },
        deltaX: { type: "number" }, deltaY: { type: "number" },
        milliseconds: { type: "number", description: "Para wait, máximo 10000." },
        gone: { type: "boolean", description: "Para waitFor: espera o texto ou o elemento DESAPARECER em vez de aparecer (um “carregando”, um modal)." },
        networkIdle: { type: "boolean", description: "Para waitFor: espera a página parar de fazer requisições." },
        timeoutMs: { type: "number", description: "Para waitFor: quanto esperar no máximo. Padrão 8000, teto 30000." },
        extractMode: { type: "string", enum: ["outline", "text"], description: "Para extractPage. outline traz só estrutura e elementos; text inclui o texto da página." },
        offset: { type: "number", description: "Para extractPage: continua a leitura a partir deste ponto quando o resultado veio truncado." },
        depth: { type: "number", description: "Para extractPage: até que profundidade descer na árvore da página. Menor = visão geral, maior = detalhe. Padrão 12." },
        query: { type: "string", description: "Para find: o texto a procurar na página inteira, mesmo fora da tela. Sem acento e sem caixa importa." },
        limit: { type: "number", description: "Para find: quantos resultados devolver. Padrão 20." },
        role: { type: "string", description: "Para find: restringe ao papel do elemento (button, link, textbox, searchbox, checkbox, combobox, tab, heading). Use quando souber o que a coisa é mas não como ela se chama." },
        toolName: { type: "string", description: "Para pageTool: nome exato de uma ferramenta listada em \"Ferramentas oferecidas pela página\"." },
        toolArguments: { type: "object", description: "Para pageTool: argumentos conforme o schema anunciado pela ferramenta." },
        script: { type: "string", description: "Para evaluateScript: código JavaScript rodado dentro da página. Enxerga o DOM e também o JavaScript do site (variáveis globais, estado de framework). Retorne um valor no final para lê-lo." },
      },
      required: ["action"],
    },
  },
});

const browserBatchTool = {
  type: "function",
  function: {
    name: "browser_batch",
    description: "Executa uma sequência de ações numa única chamada. Use sempre que você já souber dois ou mais passos à frente — navegar, clicar no campo, digitar, pressionar Enter, capturar. As ações rodam em ordem, uma depois da outra, e o lote para no primeiro erro, devolvendo o que rodou e o que não chegou a rodar. Não aninhe lotes.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Até 10 passos, na ordem em que devem acontecer.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", enum: ["browser_action", "tab_manage"], description: "A ferramenta deste passo." },
              input: { type: "object", description: "Os mesmos argumentos que você passaria ao chamá-la sozinha." },
            },
            required: ["name", "input"],
          },
        },
      },
      required: ["items"],
    },
  },
};

const readConsoleTool = {
  type: "function",
  function: {
    name: "read_console_messages",
    description: "Lê o que a página escreveu no console do navegador (console.log, erros de JavaScript, avisos). Serve para descobrir por que uma ação não teve efeito — o motivo costuma estar escrito ali. A gravação começa quando você chama isto pela primeira vez naquela aba: o que aconteceu antes não foi capturado, então chame, repita a ação, e leia de novo.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Aba a observar. Omita para a ativa." },
        query: { type: "string", description: "Filtra por um trecho do texto, ou por nível (error, warning, log). Recomendado: sem filtro vem muita coisa irrelevante." },
        limit: { type: "number", description: "Quantas mensagens devolver. Padrão 40." },
      },
    },
  },
};

const readNetworkTool = {
  type: "function",
  function: {
    name: "read_network_requests",
    description: "Lê as requisições que a página fez (XHR, fetch, documentos, imagens) com método, status e tamanho. É como se descobre o endereço que devolve os dados prontos de uma lista — chegar por ali resolve em um passo o que a interface resolveria em vários, sem rolagem nem paginação. A gravação começa quando você chama isto pela primeira vez naquela aba: chame, dispare a ação que quer observar, e leia de novo.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Aba a observar. Omita para a ativa." },
        query: { type: "string", description: "Filtra pelo endereço, por exemplo “/api/” ou o nome do recurso." },
        limit: { type: "number", description: "Quantas requisições devolver. Padrão 40." },
      },
    },
  },
};

const webSearchTool = {
  type: "function",
  function: {
    name: "web_search",
    description: "Pesquisa na web pelo gateway configurado. Use para descobrir URLs e fatos.",
    parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"] },
  },
};

const webFetchTool = {
  type: "function",
  function: {
    name: "web_fetch",
    description: "Lê o conteúdo de uma URL sem abrir aba. Prefira esta ferramenta quando só precisa ler; navigate é para quando precisa interagir.",
    parameters: { type: "object", properties: { url: { type: "string" }, max_length: { type: "number" } }, required: ["url"] },
  },
};

const requestUserTool = {
  type: "function",
  function: {
    name: "request_user",
    description: "Peça que o usuário assuma o controle: login, captcha, pagamento ou uma confirmação que só ele pode dar. A execução fica suspensa até ele retomar.",
    parameters: { type: "object", properties: { reason: { type: "string", description: "O que impede você de continuar." }, expected: { type: "string", description: "O que o usuário precisa fazer." } }, required: ["reason"] },
  },
};

const scriptWriteTool = {
  type: "function",
  function: {
    name: "script_write",
    description: "Cria ou reescreve uma automatização pessoal do usuário. O código deve começar com o bloco ==UserScript== (mesmo formato do Tampermonkey) declarando @name, @description, @version e @match. Scripts nunca rodam sozinhos: ficam guardados para o usuário executar quando quiser.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Código completo, incluindo o cabeçalho ==UserScript==." },
        replaces: { type: "string", description: "Nome exato de um script existente para substituir. Omita para criar um novo." },
      },
      required: ["code"],
    },
  },
};

const scriptListTool = {
  type: "function",
  function: {
    name: "script_list",
    description: "Lista as automatizações salvas do usuário, com nome, descrição, versão e alvos. Use antes de editar para saber o nome exato.",
    parameters: { type: "object", properties: {} },
  },
};

const tabManageTool = {
  type: "function",
  function: {
    name: "tab_manage",
    description: "Governa as abas da sessão da Vela — as que estão no grupo “Vela”. list mostra o que existe, activate traz uma para a frente, close fecha as que você indicar e closeOthers deixa só uma. Abas fora do grupo pertencem ao usuário e não podem ser fechadas.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "activate", "close", "closeOthers"] },
        tabId: { type: "number", description: "Para activate." },
        tabIds: { type: "array", items: { type: "number" }, description: "Para close." },
        keep: { type: "number", description: "Para closeOthers: a aba que fica." },
      },
      required: ["op"],
    },
  },
};

const settingsTool = {
  type: "function",
  function: {
    name: "vela_settings",
    description: "Lê e muda as preferências da própria Vela: voz da síntese, visual do orb, cursor, moldura de controle, tema. Chame sem argumentos para ver tudo com o valor atual, ou com field para ver as opções válidas daquele campo antes de escrever. Endereço de servidor, chaves e autonomia não passam por aqui.",
    parameters: {
      type: "object",
      properties: {
        field: { type: "string", description: "O campo. Omita para listar todos." },
        value: { type: "string", description: "O novo valor. Omita para apenas ler." },
      },
    },
  },
};

const memoryWriteTool = {
  type: "function",
  function: {
    name: "memory_write",
    description: "Grava uma informação persistente sobre o usuário, preferências ou fatos importantes. Use para aprender coisas que devem durar entre diferentes conversas.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Chave curta e descritiva (ex: 'usuario_nome', 'linkedin_url')." },
        value: { type: "string", description: "O conteúdo a ser memorizado." },
      },
      required: ["key", "value"],
    },
  },
};

const memoryReadTool = {
  type: "function",
  function: {
    name: "memory_read",
    description: "Lê informações persistentes gravadas anteriormente. Chame sem chave para listar tudo.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "A chave específica para ler. Omita para ver todas as chaves." },
      },
    },
  },
};

const memoryDeleteTool = {
  type: "function",
  function: {
    name: "memory_delete",
    description: "Apaga uma informação persistente gravada na memória.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "A chave específica para apagar. Ou '*' para apagar toda a memória." },
      },
      required: ["key"],
    },
  },
};

const delegateTaskTool = {
  type: "function",
  function: {
    name: "delegate_task",
    description: "Manda uma tarefa de várias etapas para rodar em segundo plano, numa aba própria, enquanto você continua conversando. Você responde ao usuário na hora (ex.: \"vou verificar isso\") e o resultado chega como mensagem nova quando terminar — falado em voz alta, se a conversa for por voz. Até duas tarefas rodam ao mesmo tempo; o resto espera em fila. Não use para algo que você resolve em poucas trocas: é para trabalho que exigiria muitas chamadas seguidas e deixaria o usuário esperando calado.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Descrição completa e autocontida da tarefa — quem for executá-la não vê o resto desta conversa, então inclua todo o contexto necessário." },
      },
      required: ["task"],
    },
  },
};

type ToolDefinition = { type: string; function: { name: string; description: string; parameters: Record<string, unknown> } };

export function buildTools(settings: AppSettings): ToolDefinition[] {
  const profile = settings.providers.find((item) => item.id === settings.activeProviderId);
  const tools: ToolDefinition[] = [browserActionTool(settings), ...(isToolEnabled(settings, "browser_batch") ? [browserBatchTool] : []), webSearchTool, tabManageTool, settingsTool, requestUserTool, scriptWriteTool, scriptListTool, memoryWriteTool, memoryReadTool, memoryDeleteTool];
  if (profile?.capabilities?.webFetch) tools.splice(2, 0, webFetchTool);
  if (isToolEnabled(settings, "read_console_messages")) tools.push(readConsoleTool);
  if (isToolEnabled(settings, "read_network_requests")) tools.push(readNetworkTool);
  /*
   * `delegate_task` é oferecida em qualquer conversa com a habilidade ligada — esperar calado é
   * ruim com ou sem voz. A exceção é dentro de uma tarefa de fundo: ela desliga `delegate` nas
   * próprias configurações (ver background-task.ts), então não delega de novo.
   */
  if (isToolEnabled(settings, "delegate_task")) tools.push(delegateTaskTool);
  return tools;
}

function apiUrl(profile: ProviderProfile, path: string) {
  return `${profile.baseUrl.replace(/\/$/, "").replace(/\/api\/v1$/, "")}/api/v1/${path}`;
}

async function responseDetail(response: Response) {
  const raw = await response.text().catch(() => "");
  try {
    const payload = JSON.parse(raw) as { error?: string | { message?: string }; message?: string };
    return typeof payload.error === "string" ? payload.error : payload.error?.message ?? payload.message ?? raw.slice(0, 240);
  } catch { return raw.slice(0, 240); }
}

export async function listModels(profile: ProviderProfile): Promise<Array<{ id: string; owned_by?: string }>> {
  const response = await fetch(apiUrl(profile, "models"), { headers: { Accept: "application/json", Authorization: `Bearer ${profile.apiKey}` } });
  if (!response.ok) { const detail = await responseDetail(response); throw new Error(`Não foi possível listar modelos (HTTP ${response.status})${detail ? `: ${detail}` : "."}`); }
  const payload = await response.json() as { data?: Array<{ id: string; owned_by?: string }> };
  return payload.data ?? [];
}

export type SearchResult = { title: string; url: string; snippet?: string };
export async function searchProvider(profile: ProviderProfile, query: string, maxResults = 5): Promise<SearchResult[]> {
  const response = await fetch(apiUrl(profile, "search"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${profile.apiKey}` },
    body: JSON.stringify({ query, max_results: maxResults, search_type: "web", content: { snippet: true, full_page: false, format: "text" } }),
  });
  if (!response.ok) { const detail = await responseDetail(response); throw new Error(`Busca falhou (HTTP ${response.status})${detail ? `: ${detail}` : "."}`); }
  const payload = await response.json() as { results?: SearchResult[] };
  return payload.results ?? [];
}

export async function fetchUrl(profile: ProviderProfile, url: string, maxLength = 8000): Promise<string> {
  const response = await fetch(apiUrl(profile, "web/fetch"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${profile.apiKey}` },
    body: JSON.stringify({ url, format: "markdown", max_length: maxLength }),
  });
  if (!response.ok) { const detail = await responseDetail(response); throw new Error(`web_fetch falhou (HTTP ${response.status})${detail ? `: ${detail}` : "."}`); }
  const payload = await response.json() as { content?: string; text?: string; markdown?: string; results?: Array<{ content?: string }> };
  const content = payload.content ?? payload.markdown ?? payload.text ?? payload.results?.[0]?.content ?? "";
  return content.slice(0, maxLength);
}

export type ConnectionCheck = { ok: boolean; detail: string; models?: number };

/** Uma requisição real responde três perguntas de uma vez: a chave foi salva, o gateway
 *  responde, e a credencial vale. É mais útil que um botão "salvar". */
export async function testConnection(profile: ProviderProfile): Promise<ConnectionCheck> {
  if (!profile.baseUrl.trim()) return { ok: false, detail: "Informe a URL base do gateway." };
  if (!profile.apiKey.trim()) return { ok: false, detail: "Informe a chave de API." };
  try {
    const models = await listModels(profile);
    if (!models.length) return { ok: false, detail: "Conectou, mas o gateway não listou nenhum modelo." };
    return { ok: true, detail: `Conectado — ${models.length} modelos disponíveis.`, models: models.length };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Não foi possível conectar." };
  }
}

export async function probeAudioEndpoints(profile: ProviderProfile): Promise<Record<string, number>> {
  const paths = ["audio/transcriptions", "audio/speech", "web/fetch"];
  const results: Record<string, number> = {};
  await Promise.all(paths.map(async (path) => {
    try {
      const response = await fetch(apiUrl(profile, path), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${profile.apiKey}` }, body: "{}" });
      results[path] = response.status;
    } catch { results[path] = 0; }
  }));
  return results;
}

export type VoiceEndpoint = { baseUrl: string; apiKey: string };

const voiceUrl = (endpoint: VoiceEndpoint, path: string) => `${endpoint.baseUrl.replace(/\/+$/, "")}/v1/${path}`;
const voiceHeaders = (endpoint: VoiceEndpoint): Record<string, string> => endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {};

export type VoiceOption = { id: string; label: string; engine: string; language?: string; ratio?: number };

/**
 * Lista as vozes com o identificador que o servidor realmente aceita.
 *
 * `/voices/names` só devolve as do motor padrão — as do piper ficam de fora e, sem o prefixo do
 * motor, o servidor recusa com "Unknown voice". `/voices` traz todos os motores e ainda o
 * benchmark, que é o que permite ordenar por velocidade em vez de por ordem alfabética.
 */
export async function listVoices(endpoint: VoiceEndpoint): Promise<VoiceOption[]> {
  const base = endpoint.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/voices`, { headers: { Accept: "application/json", ...voiceHeaders(endpoint) } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as {
    default?: string;
    engines?: Record<string, { voices?: Array<{ id?: string; name?: string; label?: string; language?: string; metrics?: { short?: { ratio?: number } } }> }>;
  };

  const options: VoiceOption[] = [];
  for (const [engine, motor] of Object.entries(payload.engines ?? {})) {
    for (const voice of motor.voices ?? []) {
      const id = voice.id ?? (voice.name ? `${engine}:${voice.name}` : null);
      if (!id) continue;
      options.push({ id, label: voice.label || voice.name || id, engine, language: voice.language ?? undefined, ratio: voice.metrics?.short?.ratio });
    }
  }
  if (options.length) {
    // Menor razão primeiro: abaixo de 1 o servidor gera mais rápido do que o áudio dura.
    return options.sort((first, second) => (first.ratio ?? 99) - (second.ratio ?? 99));
  }

  const nomes = await fetch(`${base}/voices/names`, { headers: { Accept: "application/json", ...voiceHeaders(endpoint) } }).then((r) => r.json()).catch(() => null) as { base?: string[]; custom?: string[] } | null;
  return [...(nomes?.base ?? []), ...(nomes?.custom ?? [])].map((name) => ({ id: name, label: name, engine: "desconhecido" }));
}
export async function checkVoiceEndpoint(endpoint: VoiceEndpoint): Promise<ConnectionCheck> {
  if (!endpoint.baseUrl.trim()) return { ok: false, detail: "Sem endereço configurado." };
  try {
    const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/health`, { headers: { Accept: "application/json", ...voiceHeaders(endpoint) } });
    if (!response.ok) return { ok: false, detail: `O servidor respondeu HTTP ${response.status}.` };
    const health = await response.json().catch(() => ({})) as { status?: string; version?: string };
    return { ok: true, detail: `Conectado${health.version ? ` — versão ${health.version}` : ""}.` };
  } catch {
    return { ok: false, detail: "Não consegui alcançar o servidor. Confira o endereço e se a Tailscale está de pé." };
  }
}

export async function transcribeAudio(endpoint: VoiceEndpoint, audio: Blob, model: string, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append("file", audio, "vela-fala.wav");
  form.append("model", model);
  form.append("language", "pt");
  const response = await fetch(voiceUrl(endpoint, "audio/transcriptions"), { method: "POST", headers: { Accept: "application/json", ...voiceHeaders(endpoint) }, body: form, signal });
  if (!response.ok) { const detail = await responseDetail(response); throw new Error(`Transcrição falhou (HTTP ${response.status})${detail ? `: ${detail}` : "."}`); }
  const payload = await response.json() as { text?: string; transcript?: string };
  return payload.text ?? payload.transcript ?? "";
}

/**
 * Abre o fluxo de áudio já em geração. Devolve o corpo cru: quem consome decide como tocar,
 * porque tocar PCM em pedaços é problema do lado que tem AudioContext.
 */
/**
 * O texto limpo que a síntese vai falar, sem sintetizar.
 *
 * O servidor tira Markdown, transforma item de lista em frase e narra tabela. É essa limpeza que
 * permite casar o que se ouve com o que está escrito: sem ela, um `## Título` ou uma lista partem a
 * frase no lugar errado e o destaque por palavra desalinha. `normalize: false` mantém "R$ 49,90" como
 * está na tela — expandido em "quarenta e nove reais", não acharia o trecho renderizado.
 */
export async function prepareText(endpoint: VoiceEndpoint, text: string): Promise<string> {
  const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/text/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...voiceHeaders(endpoint) },
    body: JSON.stringify({ text, sanitize: true, normalize: false }),
  });
  if (!response.ok) throw new Error(`Preparação do texto falhou (HTTP ${response.status}).`);
  const payload = await response.json() as { text?: string };
  return payload.text ?? text;
}

export async function streamSpeech(endpoint: VoiceEndpoint, input: string, voice: string): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/tts/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/wav", ...voiceHeaders(endpoint) },
    body: JSON.stringify({ text: input, voice: voice || undefined }),
  });
  if (!response.ok || !response.body) throw new Error(`A síntese em streaming falhou (HTTP ${response.status}).`);
  return response.body;
}

export async function synthesizeSpeech(endpoint: VoiceEndpoint, input: string, model: string, voice: string): Promise<Blob> {
  const response = await fetch(voiceUrl(endpoint, "audio/speech"), { method: "POST", headers: { "Content-Type": "application/json", Accept: "audio/*", ...voiceHeaders(endpoint) }, body: JSON.stringify({ input, model, voice: voice || undefined }) });
  if (!response.ok) { const detail = await responseDetail(response); throw new Error(`Síntese de voz falhou (HTTP ${response.status})${detail ? `: ${detail}` : "."}`); }
  return response.blob();
}

type WirePart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type WireMessage = { role: string; content: string | WirePart[]; tool_call_id?: string; tool_calls?: ChatMessage["tool_calls"] };

/**
 * Mensagem com imagem vira lista de partes, no formato que a API de chat espera. Só `user` a
 * recebe: `tool` aceita apenas texto, então a captura entra como uma mensagem do usuário logo
 * depois do resultado da ferramenta que a produziu.
 */
function wireContent(message: ChatMessage): string | WirePart[] {
  if (!message.images?.length) return message.content;
  return [
    { type: "text", text: message.content },
    ...message.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
  ];
}

function toWire(settings: AppSettings, messages: ChatMessage[], context: BrowserContext, memory: Record<string, string>): WireMessage[] {
  const history = messages
    .filter((message) => message.role !== "system")
    .filter((message) => !(message.role === "assistant" && !message.content && !message.tool_calls?.length))
    .map((message) => ({ role: message.role, content: wireContent(message), ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}), ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) }));
  return [
    { role: "system", content: buildSystemPrompt(settings, memory) },
    ...history,
    { role: "user", content: buildStateBlock(context) },
  ];
}

/**
 * A escada de tentativas, agora com a contagem de tokens no primeiro degrau.
 *
 * `stream_options: { include_usage: true }` e o que faz o gateway mandar o uso no ultimo pedaco do
 * stream — sem isso nao ha como saber quanto uma tarefa custou, e "quanto custou" e metade de
 * qualquer revisao de eficiencia. Nem todo gateway aceita o campo, entao ele entra como degrau:
 * quem recusa cai para o degrau sem ele, e a conversa segue.
 */
type Variant = { usage: boolean; sendParallelField: boolean; toolChoice: boolean; tools: boolean };
const VARIANTS: Variant[] = [
  { usage: true, sendParallelField: true, toolChoice: true, tools: true },
  { usage: false, sendParallelField: true, toolChoice: true, tools: true },
  { usage: false, sendParallelField: false, toolChoice: true, tools: true },
  { usage: false, sendParallelField: false, toolChoice: false, tools: true },
  { usage: false, sendParallelField: false, toolChoice: false, tools: false },
];

/*
 * O degrau que funcionou fica lembrado por gateway e modelo.
 *
 * Cada rodada recomeçava do primeiro degrau. Um gateway que recusa `stream_options` cobrava uma
 * requisição a mais — ida, recusa HTTP 400, volta — em **toda** rodada de **toda** tarefa, antes da
 * que de fato respondia: latência pura, somada ao tempo até o primeiro token que a pessoa sente.
 * Memória do service worker basta: se ele dormir, a primeira rodada seguinte reaprende em uma recusa.
 */
const degrauAceito = new Map<string, number>();

function nextVariant(current: number, errorText: string): number {
  if (/stream_options|include_usage/i.test(errorText) && current < 1) return 1;
  if (/parallel_tool_calls/i.test(errorText) && current < 2) return 2;
  if (/tool_choice/i.test(errorText) && current < 3) return 3;
  if (/tool|function|unsupported|invalid/i.test(errorText) && current < 4) return 4;
  return -1;
}

export async function* streamChat(
  settings: AppSettings,
  messages: ChatMessage[],
  context: BrowserContext,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const profile = settings.providers.find((item) => item.id === settings.activeProviderId);
  if (!profile) { yield { type: "error", message: "Nenhum provider ativo configurado." }; return; }
  if (!profile.apiKey) { yield { type: "error", message: "O provider ainda não está configurado. Abra as opções e adicione sua chave." }; return; }
  if (!profile.defaultModel) { yield { type: "error", message: "Nenhum modelo selecionado. Abra as opções e selecione um modelo válido." }; return; }

  const endpoint = apiUrl(profile, "chat/completions");
  const memory = await getMemory();
  const wire = toWire(settings, messages, context, memory);
  const tools = buildTools(settings);

  /*
   * O prompt exato, como ele sai daqui.
   *
   * É o dado que faltava para revisar uma decisão. Toda pergunta séria sobre por que a Vela fez
   * algo — por que insistiu, por que não viu o botão, por que respondeu sem agir — se responde
   * lendo o que ela leu, e isso nunca esteve gravado em lugar nenhum. Reconstruir depois é
   * impossível: o system prompt muda com as configurações, o bloco de estado é efêmero por
   * desenho, e o histórico foi compactado no caminho.
   *
   * Vai inteiro, e só no modo completo: em uso normal seriam dezenas de milhares de caracteres
   * por rodada, repetidos a cada rodada.
   */
  recordFull("model.prompt", `prompt enviado (${wire.length} mensagens)`, {
    data: {
      modelo: profile.defaultModel,
      ferramentas: tools.map((tool) => tool.function.name),
      caracteres: wire.reduce((soma, item) => soma + (typeof item.content === "string" ? item.content.length : JSON.stringify(item.content).length), 0),
      mensagens: wire.map((item) => ({
        papel: item.role,
        conteudo: typeof item.content === "string" ? item.content : item.content.map((parte) => parte.type === "text" ? parte.text : "[imagem]").join("\n"),
        ...(item.tool_calls ? { chamadas: item.tool_calls.map((chamada) => ({ nome: chamada.function.name, argumentos: chamada.function.arguments })) } : {}),
        ...(item.tool_call_id ? { respondendo: item.tool_call_id } : {}),
      })),
    },
  });
  const body = (variant: Variant) => JSON.stringify({
    model: profile.defaultModel,
    stream: true,
    ...(variant.usage ? { stream_options: { include_usage: true } } : {}),
    ...(variant.tools ? { tools } : {}),
    ...(variant.tools && variant.toolChoice ? { tool_choice: "auto" } : {}),
    ...(variant.tools && variant.sendParallelField ? { parallel_tool_calls: false } : {}),
    messages: wire,
  });

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), 120_000);
  const abortFromCaller = () => timeoutController.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener("abort", abortFromCaller); };

  let response: Response | null = null;
  const chaveDoDegrau = `${profile.baseUrl}|${profile.defaultModel}`;
  let variantIndex = degrauAceito.get(chaveDoDegrau) ?? 0;
  try {
    while (variantIndex >= 0 && variantIndex < VARIANTS.length) {
      let attempt: Response;
      try {
        attempt = await fetch(endpoint, {
          method: "POST",
          signal: timeoutController.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${profile.apiKey}` },
          body: body(VARIANTS[variantIndex]),
        });
      } catch (error) {
        cleanup();
        yield { type: "error", message: error instanceof DOMException && error.name === "AbortError" ? "A requisição foi cancelada ou excedeu 2 minutos." : error instanceof Error ? error.message : "Falha de rede." };
        return;
      }
      if (attempt.ok && attempt.body) { response = attempt; degrauAceito.set(chaveDoDegrau, variantIndex); break; }
      const detail = await responseDetail(attempt);
      if (attempt.status !== 400) { cleanup(); yield { type: "error", message: `Provider retornou HTTP ${attempt.status}${detail ? `: ${detail}` : "."}` }; return; }
      const next = nextVariant(variantIndex, detail);
      if (next < 0) { cleanup(); yield { type: "error", message: `Provider recusou a requisição: ${detail || "HTTP 400"}` }; return; }
      if (next === 4) yield { type: "warning", message: "Este modelo não aceita ferramentas; a Vela vai apenas conversar." };
      variantIndex = next;
    }
  } catch (error) {
    cleanup();
    yield { type: "error", message: error instanceof Error ? error.message : "Falha ao contatar o provider." };
    return;
  }

  if (!response?.body) { cleanup(); yield { type: "error", message: "O provider não devolveu um stream." }; return; }

  const telemetry: Record<string, string> = {};
  response.headers.forEach((value, key) => { if (key.toLowerCase().startsWith("x-omniroute-")) telemetry[key] = value; });
  if (Object.keys(telemetry).length) yield { type: "telemetry", values: telemetry };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map<number, ToolCall>();
  /*
   * A resposta inteira, acumulada aqui e gravada no fim.
   *
   * O painel mostra o texto final, mas o texto final é o que sobrou: a resposta que virou chamada
   * de ferramenta desaparece da conversa, e é justamente ela que explica a decisão. Aqui fica o
   * que o modelo devolveu, inclusive quando não devolveu nada legível.
   */
  let respostaCrua = "";
  let usoDeTokens: Record<string, unknown> | undefined;
  const flush = function* () { for (const call of toolCalls.values()) if (call.name) yield { type: "tool_call", call } as ChatEvent; };
  const registrarResposta = () => recordFull("model.response", "resposta do modelo", {
    data: {
      texto: respostaCrua,
      chamadas: [...toolCalls.values()].map((call) => ({ id: call.id, nome: call.name, argumentos: call.arguments })),
      tokens: usoDeTokens,
      telemetria: telemetry,
    },
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { registrarResposta(); yield* flush(); yield { type: "done" }; return; }
        try {
          const json = JSON.parse(payload) as { usage?: unknown; choices?: Array<{ finish_reason?: string; delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
          const delta = json.choices?.[0]?.delta;
          if (json.usage) usoDeTokens = json.usage as Record<string, unknown>;
          if (delta?.content) { respostaCrua += delta.content; yield { type: "text", text: delta.content }; }
          for (const item of delta?.tool_calls ?? []) {
            const index = item.index ?? 0;
            const current = toolCalls.get(index) ?? { id: item.id ?? `tool-${index}`, name: "", arguments: "" };
            if (item.id) current.id = item.id;
            if (item.function?.name) current.name += item.function.name;
            if (item.function?.arguments) current.arguments += item.function.arguments;
            toolCalls.set(index, current);
          }
        } catch { /* linha SSE que não é JSON */ }
      }
    }
    registrarResposta();
    yield* flush();
    yield { type: "done" };
  } finally {
    reader.releaseLock();
    cleanup();
  }
}
