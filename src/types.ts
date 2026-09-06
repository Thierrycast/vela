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
  enabled: boolean;
  capabilities: ProviderCapabilities;
};

export type Autonomy = "observe" | "assist" | "auto";
export type CursorSpeed = "natural" | "fast" | "instant";

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
  };
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
  };
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
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
  | { type: "extractPage"; mode?: "outline" | "text"; offset?: number }
  | { type: "pageTool"; name: string; arguments?: unknown }
  | { type: "wait"; milliseconds: number };

export type ActionErrorCode =
  | "no_tab" | "restricted_url" | "no_content_script" | "timeout" | "stale_snapshot"
  | "element_not_found" | "element_not_interactable" | "nav_error" | "aborted" | "denied" | "unsupported";

export type ActionSuccess = {
  ok: true;
  summary: string;
  content?: string;
  snapshotId?: number;
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
    enabled: true,
    capabilities: { streaming: true, tools: true, vision: true, audio: false, webFetch: false },
  }],
  agent: { autonomy: "assist", showCursor: true, showControlBorder: true, showTargetHighlights: true, cursorSpeed: "natural", maxRounds: 8 },
  context: { currentPage: true, selection: true, sessionTabs: true, outsideTabs: false },
  bridge: { enabled: false, port: 8792, token: "", scriptPath: "" },
  voice: {
    baseUrl: "http://SEU-SERVIDOR-DE-VOZ:8010",
    apiKey: "",
    transcriptionModel: "groq/whisper-large-v3-turbo",
    speechModel: "tts-1",
    speechVoice: "",
    streamingUrl: "ws://SEU-SERVIDOR-DE-VOZ:8010/stt/stream",
  },
};
