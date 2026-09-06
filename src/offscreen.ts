import { loadSettings } from "./storage";
import { VoiceEndpoint, streamSpeech, synthesizeSpeech, transcribeAudio } from "./provider";
import { UtteranceSegmenter } from "./vad";
import { VoiceMetricsAnalyzer } from "./audio-metrics";
import { encodeWav } from "./wav-encoder";
import { VoiceRuntimeState } from "./voice-runtime";
import { spanFrom, traceFrom } from "./trace-client";

const trace = traceFrom("offscreen");
const traceSpan = spanFrom("offscreen");

const SAMPLE_RATE = 16_000;
const MAX_PENDING = 3;
const HALLUCINATIONS = [/^legendas?\b.*amara\.org/i, /^obrigad[oa]\.?$/i, /^\.{2,}$/, /^tchau\.?$/i, /^\s*$/];

// O listener é registrado antes de qualquer await para o background poder fazer handshake.
chrome.runtime.onMessage.addListener((message: { type?: string; text?: string; mode?: "live" | "dictation" }, _sender, sendResponse) => {
  if (message.type === "voice:ping") { sendResponse({ ok: true }); return false; }
  if (message.type === "voice:start") { void start(message.mode ?? "live"); return false; }
  if (message.type === "voice:stop") { stop(); return false; }
  if (message.type === "voice:toggle-mute") { toggleMute(); return false; }
  if (message.type === "voice:speak" && message.text) { void speak(message.text); return false; }
  if (message.type === "voice:speak-stop") { streamingStop?.(); output?.pause(); output = null; return false; }
  return false;
});

let state: VoiceRuntimeState = "idle";
let mode: "live" | "dictation" = "live";
let stream: MediaStream | null = null;
let audio: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let segmenter: UtteranceSegmenter | null = null;
let output: HTMLAudioElement | null = null;
let analyzer: VoiceMetricsAnalyzer | null = null;
let telemetryTimer = 0;
let muted = false;
let speakingUntil = 0;
const pending: Blob[] = [];
let draining = false;
// Janela de resumo do sinal de áudio, para a trilha não receber vinte eventos por segundo.
let samples = 0;
let peak = 0;
let sum = 0;
let windowStarted = 0;

const send = (message: unknown) => chrome.runtime.sendMessage(message).catch(() => undefined);
const publish = (next: VoiceRuntimeState) => {
  if (next !== state) trace("voice", `estado: ${state} → ${next}`, { data: { de: state, para: next, mode } });
  state = next;
  void send({ type: "voice:state", state, timestamp: Date.now() });
};

/** A voz tem servidor próprio: o gateway de texto não expõe transcrição nem síntese. */
async function voiceTarget() {
  const settings = await loadSettings();
  const endpoint: VoiceEndpoint = { baseUrl: settings.voice.baseUrl, apiKey: settings.voice.apiKey };
  if (!endpoint.baseUrl.trim()) throw new Error("Configure o servidor de voz em Configurações → Voz.");
  return { settings, endpoint };
}

function toggleMute() {
  muted = !muted;
  stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  publish(muted ? "paused" : "listening");
}

async function drain() {
  if (draining) return;
  draining = true;
  while (pending.length) {
    const blob = pending.shift()!;
    const attempt = traceSpan("voice", "transcrição", { bytes: blob.size, fila: pending.length });
    try {
      const { settings, endpoint } = await voiceTarget();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const text = await transcribeAudio(endpoint, blob, settings.voice.transcriptionModel).finally(() => clearTimeout(timer));
      const clean = text.trim();
      const descartado = !clean || HALLUCINATIONS.some((pattern) => pattern.test(clean));
      attempt.end({ ok: !descartado, code: descartado ? "descartado" : undefined, data: { texto: clean, bytes: blob.size, modelo: settings.voice.transcriptionModel } });
      if (!descartado) {
        void send({ type: "voice:transcript", text: clean, final: true, timestamp: Date.now() });
        if (mode === "live") publish("thinking");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao transcrever áudio.";
      attempt.end({ ok: false, code: "falha", data: { erro: message } });
      void send({ type: "voice:error", message });
    }
  }
  draining = false;
}

async function start(nextMode: "live" | "dictation") {
  if (stream) { trace("voice", "start ignorado: microfone já aberto", { data: { mode: nextMode } }); return; }
  mode = nextMode;
  const opening = traceSpan("voice", "abrir microfone", { mode: nextMode });
  windowStarted = Date.now();
  samples = 0; peak = 0; sum = 0;
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      opening.end({ ok: true });
    } catch (error) {
      // Documento offscreen não exibe o prompt de permissão: sem a liberação prévia feita na
      // página de opções, isto falha calado e o botão de voz parece quebrado.
      const name = error instanceof DOMException ? error.name : "";
      opening.end({ ok: false, code: name || "falha" });
      throw new Error(name === "NotAllowedError"
        ? "O microfone não está liberado para a Vela. Abra Configurações → Voz e clique em “Permitir microfone”."
        : name === "NotFoundError" ? "Nenhum microfone encontrado nesta máquina." : "Não consegui abrir o microfone.", { cause: error });
    }
    audio = new AudioContext({ sampleRate: SAMPLE_RATE });
    await audio.audioWorklet.addModule(chrome.runtime.getURL("vela-capture-worklet.js"));
    const source = audio.createMediaStreamSource(stream);
    node = new AudioWorkletNode(audio, "vela-capture");
    source.connect(node);

    analyzer = new VoiceMetricsAnalyzer(audio, source);
    telemetryTimer = self.setInterval(() => {
      if (!analyzer) return;
      const metrics = analyzer.sample();
      // Um resumo a cada dois segundos, não vinte eventos por segundo: o que se quer saber depois
      // é se o sinal existiu e com que força, não cada amostra.
      samples += 1;
      peak = Math.max(peak, metrics.energy);
      sum += metrics.energy;
      if (Date.now() - windowStarted >= 2000) {
        trace("voice", "sinal do microfone", { data: { amostras: samples, pico: Number(peak.toFixed(3)), media: Number((sum / samples).toFixed(3)), mudo: muted, estado: state } });
        samples = 0; peak = 0; sum = 0; windowStarted = Date.now();
      }
      void send({ type: "voice:telemetry", telemetry: { state, metrics, timestamp: Date.now() } });
    }, 50);

    segmenter = new UtteranceSegmenter({
      onStart: () => { trace("voice", "fala começou"); if (mode === "live") publish("listening"); },
      onEnd: (chunks) => {
        const amostras = chunks.reduce((total, item) => total + item.length, 0);
        const engolido = Date.now() < speakingUntil;
        trace("voice", engolido ? "fala ignorada (a Vela estava falando)" : "fala terminou", {
          ok: !engolido,
          data: { segundos: Number((amostras / (audio?.sampleRate ?? SAMPLE_RATE)).toFixed(2)) },
        });
        if (engolido) return;
        if (pending.length >= MAX_PENDING) { pending.shift(); void send({ type: "voice:error", message: "Transcrição atrasada; um trecho foi descartado." }); }
        pending.push(encodeWav(chunks, audio?.sampleRate ?? SAMPLE_RATE));
        void drain();
      },
    }, { sampleRate: audio.sampleRate });

    node.port.onmessage = (event: MessageEvent<Float32Array>) => { if (!muted) segmenter?.push(event.data); };
    await audio.resume();
    publish("listening");
  } catch (error) {
    void send({ type: "voice:error", message: error instanceof Error ? error.message : "Não foi possível acessar o microfone." });
    stop();
  }
}

function stop() {
  if (telemetryTimer) self.clearInterval(telemetryTimer);
  telemetryTimer = 0;
  analyzer?.disconnect();
  analyzer = null;
  node?.port.close();
  node?.disconnect();
  node = null;
  segmenter = null;
  pending.length = 0;
  void audio?.close();
  audio = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  output?.pause();
  output = null;
  muted = false;
  publish("idle");
}

/**
 * Toca o áudio enquanto ele ainda está sendo gerado.
 *
 * O caminho antigo esperava o arquivo inteiro: numa frase longa, isso é a diferença entre a Vela
 * responder e parecer travada. Aqui cada pedaço de PCM vira um buffer agendado na sequência —
 * o relógio do AudioContext costura tudo sem emenda audível.
 */
async function speakStreaming(endpoint: VoiceEndpoint, spoken: string, voice: string) {
  const body = await streamSpeech(endpoint, spoken, voice);
  const context = new AudioContext();
  // Um analisador na saída: o que a Vela fala move o orb do mesmo jeito que a sua voz move.
  const mixer = context.createGain();
  mixer.connect(context.destination);
  const meter = new VoiceMetricsAnalyzer(context, mixer);
  const meterTimer = self.setInterval(() => {
    void send({ type: "voice:telemetry", telemetry: { state: "speaking", metrics: meter.sample(), timestamp: Date.now() } });
  }, 50);
  const reader = body.getReader();
  let leftover = new Uint8Array(0);
  let sampleRate = 22_050;
  let channels = 1;
  let headerRead = false;
  let playAt = 0;
  const sources: AudioBufferSourceNode[] = [];

  streamingStop = () => { void reader.cancel().catch(() => undefined); for (const node of sources) { try { node.stop(); } catch { /* já parou */ } } };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(leftover.length + value.length);
      merged.set(leftover);
      merged.set(value, leftover.length);
      let offset = 0;

      // O cabeçalho WAV chega no primeiro pedaço e traz a taxa real; assumir 22.05k daria
      // um áudio acelerado ou arrastado conforme a voz escolhida.
      if (!headerRead) {
        if (merged.length < 44) { leftover = merged; continue; }
        const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
        channels = view.getUint16(22, true) || 1;
        sampleRate = view.getUint32(24, true) || 22_050;
        offset = 44;
        headerRead = true;
        playAt = context.currentTime + 0.12;
      }

      // PCM de 16 bits: sobra de byte ímpar fica para o próximo pedaço.
      const usable = merged.length - offset;
      const samples = Math.floor(usable / 2 / channels) * channels;
      if (samples <= 0) { leftover = merged.subarray(offset); continue; }

      const view = new DataView(merged.buffer, merged.byteOffset + offset, samples * 2);
      const frames = samples / channels;
      const buffer = context.createBuffer(channels, frames, sampleRate);
      for (let channel = 0; channel < channels; channel += 1) {
        const target = buffer.getChannelData(channel);
        for (let frame = 0; frame < frames; frame += 1) {
          target[frame] = view.getInt16((frame * channels + channel) * 2, true) / 32768;
        }
      }

      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(mixer);
      playAt = Math.max(playAt, context.currentTime + 0.02);
      node.start(playAt);
      playAt += buffer.duration;
      sources.push(node);

      leftover = merged.subarray(offset + samples * 2);
    }

    // Espera o fim do que já foi agendado, senão o estado volta a "ocioso" com áudio tocando.
    const restante = Math.max(0, playAt - context.currentTime) * 1000;
    await new Promise((resolve) => setTimeout(resolve, restante + 120));
  } finally {
    self.clearInterval(meterTimer);
    meter.disconnect();
    streamingStop = null;
    void context.close();
  }
}

let streamingStop: (() => void) | null = null;

async function speak(text: string) {
  let url = "";
  const attempt = traceSpan("voice", "síntese", { chars: text.length });
  try {
    const { settings, endpoint } = await voiceTarget();
    const spoken = speakable(text);
    if (!spoken) { attempt.end({ ok: false, code: "vazio" }); return; }
    output?.pause();
    segmenter?.suspend();
    publish("speaking");

    if (settings.voice.streamSpeech) {
      try {
        await speakStreaming(endpoint, spoken, settings.voice.speechVoice);
        attempt.end({ ok: true, data: { modo: "streaming", voz: settings.voice.speechVoice, texto: spoken.slice(0, 300) } });
        return;
      } catch (error) {
        // Servidor sem /tts/stream ou stream interrompido: o arquivo inteiro ainda funciona.
        trace("voice", "streaming caiu para arquivo inteiro", { ok: false, code: "stream_indisponivel", data: { erro: error instanceof Error ? error.message : String(error) } });
      }
    }

    const blob = await synthesizeSpeech(endpoint, spoken, settings.voice.speechModel, settings.voice.speechVoice);
    attempt.end({ ok: true, data: { modo: "arquivo", voz: settings.voice.speechVoice, bytes: blob.size, texto: spoken.slice(0, 300) } });
    url = URL.createObjectURL(blob);
    output = new Audio(url);
    await new Promise<void>((resolve, reject) => {
      output!.onended = () => resolve();
      output!.onerror = () => reject(new Error("Falha ao reproduzir a resposta."));
      void output!.play().catch(reject);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao sintetizar voz.";
    attempt.end({ ok: false, code: "falha", data: { erro: message } });
    void send({ type: "voice:error", message });
  } finally {
    if (url) URL.revokeObjectURL(url);
    speakingUntil = Date.now() + 250;
    segmenter?.resume();
    // Sem microfone aberto, esta foi uma leitura avulsa: o runtime volta a ocioso em vez de
    // ficar preso em "falando" para sempre.
    publish(stream ? "listening" : "idle");
  }
}

/** O que se fala não é o que se lê: markdown e blocos de código não viram áudio. */
function speakable(text: string) {
  const clean = text
    .replace(/```[\s\S]*?```/g, " trecho de código ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 600 ? `${clean.slice(0, 600)}…` : clean;
}
