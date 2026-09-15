export type ThemeMode = "light" | "dark" | "system";

export type BrandTheme = {
  appName: string;
  accentColor: string;
  logoText: string;
};

export type ProviderCapabilities = { streaming: boolean; tools: boolean; vision: boolean; audio: boolean; webFetch: boolean };

export type ProviderProfile = {
  id: string;
  name: string;
  baseUrl: string;
  protocol: "omnirouter" | "openai-compatible" | "custom";
  apiKey: string;
  defaultModel: string;
  fastModel: string;
  enabled: boolean;
  capabilities: ProviderCapabilities;
};

export type Autonomy = "observe" | "assist" | "auto";
export type CursorSpeed = "natural" | "fast" | "instant";

/**
 * Cada habilidade da agente tem interruptor próprio.
 *
 * Autonomia responde "quanto ela pode agir sem perguntar"; isto responde outra pergunta —
 * "o que ela sabe fazer". São independentes: quem confia a ponto de deixar em Auto não
 * necessariamente quer que ela injete JavaScript no mundo da página, e quem quer o depurador
 * anexado não necessariamente quer a leitura de rede junto.
 *
 * O interruptor vale nas duas pontas: a ferramenta desligada **não é anunciada** ao modelo
 * (`buildTools`) e, se ele insistir mesmo assim, a chamada é recusada (`runToolCall`). Anunciar
 * e não executar seria pior que não anunciar — o modelo gastaria rodadas tentando.
 *
 * O que nasce desligado nasce assim porque concede poder novo: script no mundo da página,
 * depurador anexado pela tarefa inteira, leitura de console e de rede, e cache que guarda
 * caminho de site entre sessões. Poder novo não se concede sozinho.
 */
export type Capabilities = {
  /** Várias ações numa só chamada, em sequência. */
  batch: boolean;
  /** Esperar por texto, elemento ou rede parada em vez de chutar milissegundos. */
  waitFor: boolean;
  /** evaluateScript no mundo isolado: vê o DOM, não vê o estado da página. */
  scriptIsolated: boolean;
  /** evaluateScript no mundo da página: vê variável, framework e o que estiver em memória. */
  scriptMain: boolean;
  hover: boolean;
  drag: boolean;
  /** Voltar e avançar no histórico da aba. */
  history: boolean;
  /** Manter o depurador anexado durante a tarefa, em vez de por ação. */
  cdpSession: boolean;
  readConsole: boolean;
  readNetwork: boolean;
  /** Agir numa aba endereçada por número, sem tirar o foco do usuário. */
  tabAddressing: boolean;
  /** Lembrar por onde se chega a cada coisa em cada site. */
  routeCache: boolean;
  /** Pedir aprovação quando a própria página mandar ir para outro domínio. */
  domainGate: boolean;
  /** Tocar uma tarefa de várias etapas em segundo plano. */
  delegate: boolean;
};

export type AppSettings = {
  theme: ThemeMode;
  brand: BrandTheme;
  activeProviderId: string;
  providers: ProviderProfile[];
  agent: {
    autonomy: Autonomy;
    showCursor: boolean;
    showControlBorder: boolean;
    showTargetHighlights: boolean;
    cursorSpeed: CursorSpeed;
    maxRounds: number;
    /** Repetir a ação por evento confiável (CDP) quando o caminho DOM não surtiu efeito. */
    preciseMode: boolean;
    /** Desabilita o bloqueio e pedido de intervenção do usuário para senhas e formulários sensíveis. */
    bypassWireguard: boolean;
  };
  capabilities: Capabilities;
  context: { currentPage: boolean; selection: boolean; sessionTabs: boolean; outsideTabs: boolean };
  bridge: { enabled: boolean; port: number; token: string; scriptPath: string };
  /** A voz fala com outro servidor que não o do chat: o gateway de texto não serve áudio. */
  voice: {
    baseUrl: string;
    apiKey: string;
    transcriptionModel: string;
    speechModel: string;
    speechVoice: string;
    streamingUrl: string;
    /** Toca enquanto o servidor gera, em vez de esperar o arquivo inteiro. */
    streamSpeech: boolean;
    /** Multiplicador de velocidade da fala (1 = ritmo do servidor). Ajustado no cliente porque o
     *  servidor de voz não expõe controle de taxa — o piper fala num ritmo fixo por voz. */
    speechRate: number;
    /** A janelinha flutuante na página. Desligada por padrão: o palco fica no painel. */
    showPulse: boolean;
    /** Qual visual representa a Vela quando ela ouve e fala. Ver voice-visuals.ts. */
    visual: string;
    /** Fragment shader escrito pelo usuário, usado quando `visual` é "custom". Vazio = o exemplo. */
    customShader: string;
  };
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Capturas da tela anexadas à mensagem, como data URL. Só fazem sentido em `role: "user"`. */
  images?: string[];
  createdAt: number;
  status?: "streaming" | "complete" | "error";
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

export type BrowserAction =
  | { type: "navigate"; url: string; newTab?: boolean }
  | { type: "click"; ref?: string; selector?: string }
  | { type: "type"; ref?: string; selector?: string; text: string; submit?: boolean; mode?: "replace" | "append" }
  | { type: "keyPress"; key: string; ref?: string }
  | { type: "scroll"; deltaX?: number; deltaY?: number }
  | { type: "extractPage"; mode?: "outline" | "text"; offset?: number; bypassWireguard?: boolean }
  | { type: "find"; query?: string; selector?: string; limit?: number }
  | { type: "screenshot" }
  | { type: "pageTool"; name: string; arguments?: unknown }
  | { type: "evaluateScript"; script: string }
  | { type: "wait"; milliseconds: number }
  /** Espera por uma condição da página, não por um número que o modelo chutou. */
  | { type: "waitFor"; text?: string; selector?: string; gone?: boolean; networkIdle?: boolean; timeoutMs?: number };

/*
 * `stale_snapshot` saiu com o fim dos refs por leitura: não existe mais "o retrato mudou", porque
 * o ref não pertence ao retrato. No lugar entraram três causas que antes se confundiam numa só —
 * a página trocou (`page_gone`), o ref virou outro elemento (`ref_changed`) e o ref nunca existiu
 * ou é de um formato que não se usa mais (`ref_desconhecido`). A recuperação de cada uma é
 * diferente, e é por isso que o código precisa distingui-las.
 */
export type ActionErrorCode =
  | "no_tab" | "restricted_url" | "no_content_script" | "timeout"
  | "page_gone" | "ref_changed" | "ref_desconhecido"
  | "element_not_found" | "element_not_interactable" | "nav_error" | "aborted" | "denied" | "unsupported";

export type ActionSuccess = {
  ok: true;
  summary: string;
  content?: string;
  /** Captura da aba, em data URL, quando a ação foi `screenshot`. */
  image?: string;
  /** Identifica o documento que respondeu. O background usa para saber se os refs que ele tem
   *  em mãos pertencem a esta página ou a uma que já foi substituída. */
  epoch?: string;
  truncated?: boolean;
  nextOffset?: number;
  url?: string;
  title?: string;
  navigatedTo?: string;
};
export type ActionFailure = { ok: false; code: ActionErrorCode; summary: string };
export type ActionResult = ActionSuccess | ActionFailure;

export type TabSummary = { tabId: number; title: string; url: string; active: boolean };

export type BrowserContext = {
  page?: { url: string; title: string };
  selection?: string;
  attachments: string[];
  tabs: TabSummary[];
  autonomy: Autonomy;
};

export type AgentEvent = {
  kind: "status" | "action" | "result" | "error";
  text: string;
  action?: BrowserAction;
};

export type LogEntry = {
  id: string;
  level: "info" | "warn" | "error";
  event: string;
  detail?: string;
  createdAt: number;
};

export const defaultSettings: AppSettings = {
  theme: "system",
  brand: { appName: "Vela", accentColor: "", logoText: "V" },
  activeProviderId: "omniroute",
  providers: [{
    id: "omniroute",
    name: "OmniRoute",
    baseUrl: "https://SEU-GATEWAY/",
    protocol: "omnirouter",
    apiKey: "",
    defaultModel: "",
    fastModel: "",
    enabled: true,
    capabilities: { streaming: true, tools: true, vision: true, audio: false, webFetch: false },
  }],
  agent: {
    autonomy: "assist",
    showCursor: true,
    showControlBorder: true,
    showTargetHighlights: true,
    cursorSpeed: "natural",
    maxRounds: 12,
    preciseMode: false,
    bypassWireguard: false,
  },
  capabilities: {
    batch: true,
    waitFor: true,
    scriptIsolated: true,
    scriptMain: false,
    hover: true,
    drag: true,
    history: true,
    cdpSession: false,
    readConsole: false,
    readNetwork: false,
    tabAddressing: true,
    routeCache: false,
    domainGate: true,
    delegate: true,
  },
  context: { currentPage: true, selection: true, sessionTabs: true, outsideTabs: false },
  bridge: { enabled: false, port: 8792, token: "", scriptPath: "" },
  voice: {
    baseUrl: "http://SEU-SERVIDOR-DE-VOZ:8010",
    apiKey: "",
    transcriptionModel: "groq/whisper-large-v3-turbo",
    speechModel: "tts-1",
    speechVoice: "piper:pt_BR-cadu-medium",
    streamSpeech: true,
    speechRate: 1.15,
    showPulse: false,
    streamingUrl: "ws://SEU-SERVIDOR-DE-VOZ:8010/stt/stream",
    visual: "liquid-blob",
    customShader: "",
  },
};
