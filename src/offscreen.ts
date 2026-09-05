import { loadSettings } from "./storage";
import { synthesizeSpeech, transcribeAudio } from "./provider";
import { UtteranceSegmenter } from "./vad";
import { VoiceMetricsAnalyzer } from "./audio-metrics";
import { encodeWav } from "./wav-encoder";
import { VoiceRuntimeState } from "./voice-runtime";

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

const send = (message: unknown) => chrome.runtime.sendMessage(message).catch(() => undefined);
const publish = (next: VoiceRuntimeState) => { state = next; void send({ type: "voice:state", state, timestamp: Date.now() }); };

async function activeProfile() {
  const settings = await loadSettings();
  const profile = settings.providers.find((item) => item.id === settings.activeProviderId);
  if (!profile?.apiKey) throw new Error("Configure o provider antes de usar a voz.");
  return { settings, profile };
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
    try {
      const { settings, profile } = await activeProfile();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const text = await transcribeAudio(profile, blob, settings.voice.transcriptionModel || profile.defaultModel).finally(() => clearTimeout(timer));
      const clean = text.trim();
      if (clean && !HALLUCINATIONS.some((pattern) => pattern.test(clean))) {
        void send({ type: "voice:transcript", text: clean, final: true, timestamp: Date.now() });
        if (mode === "live") publish("thinking");
      }
    } catch (error) {
      void send({ type: "voice:error", message: error instanceof Error ? error.message : "Falha ao transcrever áudio." });
    }
  }
  draining = false;
}

async function start(nextMode: "live" | "dictation") {
  if (stream) return;
  mode = nextMode;
  try {
    await activeProfile();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    audio = new AudioContext({ sampleRate: SAMPLE_RATE });
    await audio.audioWorklet.addModule(chrome.runtime.getURL("vela-capture-worklet.js"));
    const source = audio.createMediaStreamSource(stream);
    node = new AudioWorkletNode(audio, "vela-capture");
    source.connect(node);

    analyzer = new VoiceMetricsAnalyzer(audio, source);
    telemetryTimer = self.setInterval(() => {
      if (!analyzer) return;
      void send({ type: "voice:telemetry", telemetry: { state, metrics: analyzer.sample(), timestamp: Date.now() } });
    }, 50);

    segmenter = new UtteranceSegmenter({
      onStart: () => { if (mode === "live") publish("listening"); },
      onEnd: (chunks) => {
        if (Date.now() < speakingUntil) return;
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

async function speak(text: string) {
  let url = "";
  try {
    const { settings, profile } = await activeProfile();
    const spoken = speakable(text);
    if (!spoken) return;
    const blob = await synthesizeSpeech(profile, spoken, settings.voice.speechModel || profile.defaultModel, settings.voice.speechVoice || "alloy");
    url = URL.createObjectURL(blob);
    output?.pause();
    output = new Audio(url);
    segmenter?.suspend();
    publish("speaking");
    await new Promise<void>((resolve, reject) => {
      output!.onended = () => resolve();
      output!.onerror = () => reject(new Error("Falha ao reproduzir a resposta."));
      void output!.play().catch(reject);
    });
  } catch (error) {
    void send({ type: "voice:error", message: error instanceof Error ? error.message : "Falha ao sintetizar voz." });
  } finally {
    if (url) URL.revokeObjectURL(url);
    speakingUntil = Date.now() + 250;
    segmenter?.resume();
    if (stream) publish("listening");
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
