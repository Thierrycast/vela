/**
 * A Vela mexendo nas próprias configurações.
 *
 * "Troque para a voz do Cadu" é um pedido que morria em "abra Configurações → Voz e escolha na
 * lista" — o que é pior pela voz, justamente onde o pedido nasce.
 *
 * O que ela pode mudar é uma **lista branca**, não o objeto de settings inteiro: endereço de
 * provider, chave de API e a porta da ponte ficam de fora porque mudá-los desliga a Vela ou
 * manda os dados do usuário para outro lugar — e nenhuma frase falada deveria conseguir isso.
 * Autonomia também fica de fora: é o freio que autoriza a própria agente a agir, e quem afrouxa
 * o freio não pode ser quem ele segura.
 */
import { AppSettings } from "./types";
import { loadSettings, saveSettings } from "./storage";
import { VISUALS } from "./voice-visuals";
import { listVoices } from "./provider";

type Field = {
  ler: (settings: AppSettings) => string;
  escrever: (settings: AppSettings, value: string) => string | null;
  descricao: string;
  opcoes?: (settings: AppSettings) => Promise<string[]>;
};

const boolean = (value: string) => /^(1|sim|true|ligad[oa]|on)$/i.test(value.trim());

export const SETTINGS_FIELDS: Record<string, Field> = {
  voz: {
    descricao: "A voz usada na síntese, como piper:pt_BR-cadu-medium.",
    ler: (settings) => settings.voice.speechVoice,
    escrever: (settings, value) => { settings.voice.speechVoice = value.trim(); return null; },
    opcoes: async (settings) => (await listVoices({ baseUrl: settings.voice.baseUrl, apiKey: settings.voice.apiKey }))
      .map((item) => `${item.id}${item.ratio !== undefined ? ` (gera em ${item.ratio.toFixed(2)}× a duração)` : ""}`),
  },
  visual: {
    descricao: `Como a Vela se mostra ao ouvir e falar. Um de: ${VISUALS.map((item) => item.id).join(", ")}.`,
    ler: (settings) => settings.voice.visual,
    escrever: (settings, value) => {
      const found = VISUALS.find((item) => item.id === value.trim());
      if (!found) return `“${value}” não é um visual. Escolha entre: ${VISUALS.map((item) => item.id).join(", ")}.`;
      settings.voice.visual = found.id;
      return null;
    },
    opcoes: async () => VISUALS.map((item) => item.id),
  },
  "voz-em-streaming": {
    descricao: "Tocar a fala enquanto o servidor gera, em vez de esperar o arquivo inteiro.",
    ler: (settings) => String(settings.voice.streamSpeech),
    escrever: (settings, value) => { settings.voice.streamSpeech = boolean(value); return null; },
  },
  "janelinha-na-pagina": {
    descricao: "A janelinha flutuante sobre a página (o Pulse), útil com a barra lateral fechada.",
    ler: (settings) => String(settings.voice.showPulse),
    escrever: (settings, value) => { settings.voice.showPulse = boolean(value); return null; },
  },
  cursor: {
    descricao: "Mostrar o cursor da Vela se movendo na página enquanto ela age.",
    ler: (settings) => String(settings.agent.showCursor),
    escrever: (settings, value) => { settings.agent.showCursor = boolean(value); return null; },
  },
  "moldura-de-controle": {
    descricao: "A moldura acesa em volta da página enquanto a Vela está no comando.",
    ler: (settings) => String(settings.agent.showControlBorder),
    escrever: (settings, value) => { settings.agent.showControlBorder = boolean(value); return null; },
  },
  "destaque-do-alvo": {
    descricao: "Destacar o elemento antes de clicar nele.",
    ler: (settings) => String(settings.agent.showTargetHighlights),
    escrever: (settings, value) => { settings.agent.showTargetHighlights = boolean(value); return null; },
  },
  "velocidade-do-cursor": {
    descricao: "natural, fast ou instant.",
    ler: (settings) => settings.agent.cursorSpeed,
    escrever: (settings, value) => {
      const clean = value.trim().toLowerCase();
      if (clean !== "natural" && clean !== "fast" && clean !== "instant") return "Use natural, fast ou instant.";
      settings.agent.cursorSpeed = clean;
      return null;
    },
    opcoes: async () => ["natural", "fast", "instant"],
  },
  "maximo-de-etapas": {
    descricao: "Quantas rodadas de ferramenta a Vela pode gastar num pedido, de 2 a 30.",
    ler: (settings) => String(settings.agent.maxRounds),
    escrever: (settings, value) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 2 || parsed > 30) return "O máximo de etapas vai de 2 a 30.";
      settings.agent.maxRounds = Math.round(parsed);
      return null;
    },
  },
  tema: {
    descricao: "light, dark ou system.",
    ler: (settings) => settings.theme,
    escrever: (settings, value) => {
      const clean = value.trim().toLowerCase();
      if (clean !== "light" && clean !== "dark" && clean !== "system") return "Use light, dark ou system.";
      settings.theme = clean;
      return null;
    },
    opcoes: async () => ["light", "dark", "system"],
  },
};

export async function readSetting(field?: string): Promise<string> {
  const settings = await loadSettings();
  if (!field) {
    return Object.entries(SETTINGS_FIELDS).map(([name, item]) => `- ${name}: ${item.ler(settings)} — ${item.descricao}`).join("\n");
  }
  const item = SETTINGS_FIELDS[field];
  if (!item) return `ERRO [unsupported] Não existe a configuração “${field}”. Disponíveis: ${Object.keys(SETTINGS_FIELDS).join(", ")}.`;
  const options = item.opcoes ? await item.opcoes(settings).catch(() => []) : [];
  const list = options.length ? `\nOpções: ${options.slice(0, 40).join(", ")}` : "";
  return `${field}: ${item.ler(settings)}${list}`;
}

export async function writeSetting(field: string, value: string): Promise<{ ok: boolean; summary: string }> {
  const item = SETTINGS_FIELDS[field];
  if (!item) return { ok: false, summary: `Não existe a configuração “${field}”. Disponíveis: ${Object.keys(SETTINGS_FIELDS).join(", ")}.` };
  const settings = await loadSettings();
  const before = item.ler(settings);
  const problem = item.escrever(settings, value);
  if (problem) return { ok: false, summary: problem };
  await saveSettings(settings);
  return { ok: true, summary: `Mudei ${field} de ${before} para ${item.ler(settings)}.` };
}
