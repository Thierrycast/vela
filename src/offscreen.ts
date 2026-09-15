import { loadSettings } from "./storage";
import { VoiceEndpoint, prepareText, streamSpeech, synthesizeSpeech, transcribeAudio } from "./provider";
import { splitSentences } from "./reading-text";
import { UtteranceSegmenter } from "./vad";
import { VoiceMetricsAnalyzer } from "./audio-metrics";
import { encodeWav } from "./wav-encoder";
import { VoiceRuntimeState } from "./voice-runtime";
import { SttStream } from "./stt-stream";
import { spanFrom, traceFrom } from "./trace-client";
import { buildZip } from "./zip-writer";

const trace = traceFrom("offscreen");
const traceSpan = spanFrom("offscreen");

const SAMPLE_RATE = 16_000;
const MAX_PENDING = 3;
const HALLUCINATIONS = [/^legendas?\b.*amara\.org/i, /^obrigad[oa]\.?$/i, /^\.{2,}$/, /^tchau\.?$/i, /^\s*$/];

// O listener é registrado antes de qualquer await para o background poder fazer handshake.
chrome.runtime.onMessage.addListener((message: { type?: string; text?: string; id?: string; mode?: "live" | "dictation" }, _sender, sendResponse) => {
  if (message.type === "voice:ping") { sendResponse({ ok: true }); return false; }
  if (message.type === "voice:start") { void start(message.mode ?? "live"); return false; }
  // Precisa responder só depois de `stop()` terminar: se a gravação de depuração estiver ligada,
  // o zip é montado de forma assíncrona, e background.ts fecha o documento offscreen assim que
  // esta mensagem "resolve" — sem esperar, o documento morria no meio do download.
  if (message.type === "voice:stop") { void stop().then(() => sendResponse({ ok: true })); return true; }
  if (message.type === "voice:toggle-mute") { toggleMute(); return false; }
  if (message.type === "voice:speak" && message.text) { void speak(message.text, message.id); return false; }
  if (message.type === "voice:speak-stop") { streamingStop?.(); output?.pause(); output = null; return false; }
  if (message.type === "voice:debug-start") { startDebugRecording(); return false; }
  if (message.type === "voice:debug-stop") { void stopDebugRecording(); return false; }
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
/*
 * Enquanto a Vela fala, o microfone ouve a Vela pelos alto-falantes.
 *
 * Eram duas proteções e só uma existia. O turno estava coberto pelo `suspend()` do VAD, então a
 * fala dela nunca abriu um turno. O **rascunho na tela** não estava: `speakingUntil` só era
 * atribuído no `finally` de `speak()`, ou seja, depois de ela terminar — durante a fala ele
 * guardava um instante já passado, e o áudio seguia para o texto ao vivo. Com alto-falante de
 * verdade, a resposta dela aparecia na tela escrita como se fosse do usuário.
 *
 * `speaking` cobre a fala; `speakingUntil` cobre o rabo de eco depois dela.
 */
let speaking = false;
let speakingUntil = 0;
const pending: Blob[] = [];
let draining = false;
let live: SttStream | null = null;
let lastPartial = "";
// Janela de resumo do sinal de áudio, para a trilha não receber vinte eventos por segundo.
let samples = 0;
let peak = 0;
let sum = 0;
let windowStarted = 0;

/*
 * Modo de depuração: grava o que a sessão de voz realmente trocou — áudio do usuário por
 * enunciado, com a transcrição que ele virou, e o texto que a Vela falou — para reproduzir e
 * revisar depois. Existe porque "ela disse que não conseguia e depois fez" é um padrão que só
 * aparece olhando a sequência real de turnos, não um log de erro isolado.
 *
 * Fica em memória, nunca em chrome.storage — um áudio de alguns minutos passa longe do limite de
 * 10 MB da extensão — e vira um .zip baixado quando a gravação para.
 */
function extFromMime(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("ogg")) return "ogg";
  return "wav";
}

type DebugItem =
  | { kind: "user"; t: number; wav: Uint8Array; transcript: string; descartado: boolean }
  | { kind: "vela"; t: number; text: string; audio: Uint8Array | null; mime: string; leitura: boolean };
let debugRecording = false;
let debugItems: DebugItem[] = [];
let debugStartedAt = 0;

function reportDebugState() {
  void send({ type: "voice:debug-state", recording: debugRecording, items: debugItems.length });
}

function startDebugRecording() {
  if (!stream) { void send({ type: "voice:error", message: "Ligue o microfone (Live Voice ou ditado) antes de gravar a sessão de depuração." }); return; }
  if (debugRecording) return;
  debugRecording = true;
  debugItems = [];
  debugStartedAt = Date.now();
  trace("voice", "gravação de depuração iniciada");
  reportDebugState();
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function stopDebugRecording() {
  if (!debugRecording) return;
  debugRecording = false;
  const items = debugItems;
  debugItems = [];
  trace("voice", "gravação de depuração encerrada", { data: { itens: items.length } });
  reportDebugState();
  if (!items.length) return;

  const manifest: Array<Record<string, unknown>> = [];
  const files: Array<{ name: string; data: Uint8Array }> = [];
  let userIndex = 0;
  let velaIndex = 0;
  for (const item of items) {
    const relativeMs = item.t - debugStartedAt;
    if (item.kind === "user") {
      userIndex += 1;
      const name = `mic-${String(userIndex).padStart(3, "0")}.wav`;
      files.push({ name, data: item.wav });
      manifest.push({ tipo: "usuario", t_ms: relativeMs, arquivo: name, transcricao: item.transcript, descartado: item.descartado });
    } else {
      velaIndex += 1;
      const entry: Record<string, unknown> = { tipo: "vela", t_ms: relativeMs, texto: item.text, leitura: item.leitura };
      if (item.audio) {
        const name = `vela-${String(velaIndex).padStart(3, "0")}.${extFromMime(item.mime)}`;
        files.push({ name, data: item.audio });
        entry.arquivo = name;
      }
      manifest.push(entry);
    }
  }
  files.push({ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });

  const zip = buildZip(files);
  const url = URL.createObjectURL(zip);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vela-debug-${new Date(debugStartedAt).toISOString().replace(/[:.]/g, "-")}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

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
      if (debugRecording) {
        debugItems.push({ kind: "user", t: Date.now(), wav: await blobToBytes(blob), transcript: clean, descartado });
        reportDebugState();
      }
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
        const engolido = speaking || Date.now() < speakingUntil;
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

    /*
     * O texto ao vivo é opcional por definição: se o endereço não estiver configurado, ou se a
     * conexão cair, a transcrição em lote continua inteira. Ele nunca abre um turno — só escreve
     * na tela enquanto a pessoa fala.
     */
    const streamingUrl = (await loadSettings()).voice.streamingUrl.trim();
    if (mode === "live" && streamingUrl) {
      const connecting = traceSpan("voice", "texto ao vivo", { url: streamingUrl });
      let opened = false;
      live = new SttStream(streamingUrl, audio.sampleRate, {
        onReady: () => { if (!opened) { opened = true; connecting.end({ ok: true }); } },
        onPartial: (text) => {
          if (text === lastPartial) return;
          lastPartial = text;
          void send({ type: "voice:partial", text });
        },
        onFinal: (text) => { lastPartial = ""; trace("voice", "trecho fechado no texto ao vivo", { data: { texto: text } }); },
        onError: (message) => {
          if (!opened) { opened = true; connecting.end({ ok: false, code: "falha", data: { erro: message } }); }
          else trace("voice", "texto ao vivo falhou", { ok: false, data: { erro: message } });
        },
      });
      live.open();
    }

    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (muted) return;
      segmenter?.push(event.data);
      // Enquanto a Vela fala, o microfone ouve a própria Vela: mandar isso ao texto ao vivo
      // encheria a tela com a resposta dela mesma, escrita como se fosse do usuário.
      if (!speaking && Date.now() >= speakingUntil) live?.push(event.data);
    };
    await audio.resume();
    publish("listening");
  } catch (error) {
    void send({ type: "voice:error", message: error instanceof Error ? error.message : "Não foi possível acessar o microfone." });
    void stop();
  }
}

async function stop() {
  // Sem isto, encerrar a voz com a gravação de depuração ligada perdia tudo: o offscreen fecha
  // logo depois, e o zip nunca chegava a ser montado. Quem chama espera esta função inteira.
  if (debugRecording) await stopDebugRecording();
  if (telemetryTimer) self.clearInterval(telemetryTimer);
  telemetryTimer = 0;
  analyzer?.disconnect();
  analyzer = null;
  node?.port.close();
  node?.disconnect();
  node = null;
  segmenter = null;
  live?.close();
  live = null;
  lastPartial = "";
  pending.length = 0;
  void audio?.close();
  audio = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  output?.pause();
  output = null;
  muted = false;
  // Desligar a voz no meio de uma fala deixaria `speaking` preso em true, e o texto ao vivo
  // silenciado para sempre na próxima vez que o microfone abrisse.
  speaking = false;
  speakingUntil = 0;
  publish("idle");
}

/**
 * Um palco de áudio para uma fala: contexto, mixer, e o medidor que move o orb.
 *
 * O analisador fica na saída: o que a Vela fala move o orb do mesmo jeito que a sua voz move.
 */
function openSpeechStage() {
  const context = new AudioContext();
  const mixer = context.createGain();
  mixer.connect(context.destination);
  const meter = new VoiceMetricsAnalyzer(context, mixer);
  const meterTimer = self.setInterval(() => {
    void send({ type: "voice:telemetry", telemetry: { state: "speaking", metrics: meter.sample(), timestamp: Date.now() } });
  }, 50);
  const sources: AudioBufferSourceNode[] = [];

  // No modo de depuração, o que sai do mixer é gravado em paralelo ao que toca de verdade — sem
  // isso não há como revisar depois o que a Vela realmente falou, só o texto que ela pretendia.
  let recorder: MediaRecorder | null = null;
  const recordedChunks: Blob[] = [];
  let recordedDone: Promise<{ bytes: Uint8Array; mime: string } | null> = Promise.resolve(null);
  if (debugRecording) {
    try {
      const dest = context.createMediaStreamDestination();
      mixer.connect(dest);
      recorder = new MediaRecorder(dest.stream);
      const done = recorder;
      recordedDone = new Promise((resolve) => {
        done.onstop = () => {
          const mime = done.mimeType || "audio/webm";
          void new Blob(recordedChunks, { type: mime }).arrayBuffer().then((buffer) => resolve({ bytes: new Uint8Array(buffer), mime })).catch(() => resolve(null));
        };
        done.onerror = () => resolve(null);
      });
      recorder.ondataavailable = (event) => { if (event.data.size) recordedChunks.push(event.data); };
      recorder.start();
    } catch { recorder = null; }
  }

  const close = () => { self.clearInterval(meterTimer); meter.disconnect(); void context.close(); recorder?.stop(); };
  return { context, mixer, sources, close, recordedDone };
}

type SpeechStage = ReturnType<typeof openSpeechStage>;

/**
 * Agenda um WAV em streaming na linha do tempo do contexto, a partir de `playAt`.
 *
 * Cada pedaço de PCM vira um buffer agendado na sequência, e o relógio do AudioContext costura tudo
 * sem emenda audível. Devolve **quando o primeiro buffer começa** e onde a linha do tempo terminou —
 * é esse par que vira a janela de uma frase no destaque da leitura. Um lugar só lê cabeçalho e sobra
 * de byte: a leitura frase a frase e a fala inteira usam o mesmo agendador.
 */
async function scheduleWav(
  stage: SpeechStage,
  body: ReadableStream<Uint8Array>,
  from: number,
  onReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
  rate = 1,
): Promise<{ start: number | null; playAt: number }> {
  const { context, mixer, sources } = stage;
  const reader = body.getReader();
  onReader(reader);
  let playAt = from;
  let leftover = new Uint8Array(0);
  let sampleRate = 22_050;
  let channels = 1;
  let headerRead = false;
  let start: number | null = null;

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
      const header = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
      channels = header.getUint16(22, true) || 1;
      sampleRate = header.getUint32(24, true) || 22_050;
      offset = 44;
      headerRead = true;
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
    if (rate !== 1) node.playbackRate.value = rate;
    node.connect(mixer);
    playAt = Math.max(playAt, context.currentTime + 0.02);
    if (start === null) start = playAt;
    node.start(playAt);
    playAt += buffer.duration / rate;
    sources.push(node);

    leftover = merged.subarray(offset + samples * 2);
  }
  return { start, playAt };
}

/**
 * Espera o fim do que já foi agendado, senão o estado volta a "ocioso" com áudio tocando.
 *
 * Quem avisa é o último buffer, por `onended`, e não um `setTimeout` calculado: o relógio do
 * AudioContext e o do `setTimeout` correm separados, e a diferença aparecia como o orb continuando
 * âmbar depois de a fala ter acabado. O tempo calculado fica só como rede de segurança.
 */
async function waitScheduled(stage: SpeechStage, playAt: number) {
  const ultimo = stage.sources.at(-1);
  const restante = Math.max(0, playAt - stage.context.currentTime) * 1000;
  const fimDoAudio = traceSpan("voice", "fim da reprodução", { agendado: Math.round(restante) });
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (via: string) => { if (done) return; done = true; fimDoAudio.end({ ok: true, data: { via } }); resolve(); };
    if (ultimo) ultimo.onended = () => finish("onended");
    setTimeout(() => finish("tempo calculado"), restante + 400);
  });
}

/**
 * Toca o áudio enquanto ele ainda está sendo gerado.
 *
 * O caminho antigo esperava o arquivo inteiro: numa frase longa, isso é a diferença entre a Vela
 * responder e parecer travada.
 */
async function speakStreaming(endpoint: VoiceEndpoint, spoken: string, voice: string, rate: number): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const body = await streamSpeech(endpoint, spoken, voice);
  const stage = openSpeechStage();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  streamingStop = () => {
    void reader?.cancel().catch(() => undefined);
    for (const node of stage.sources) { try { node.stop(); } catch { /* já parou */ } }
  };
  try {
    const { playAt } = await scheduleWav(stage, body, stage.context.currentTime + 0.12, (r) => { reader = r; }, rate);
    await waitScheduled(stage, playAt);
  } finally {
    streamingStop = null;
    stage.close();
  }
  return stage.recordedDone;
}

/**
 * Lê uma mensagem **frase a frase**, dizendo ao painel onde a fala está.
 *
 * A síntese não devolve tempo de palavra. O que dá para medir com precisão é a janela de cada frase:
 * pedindo uma frase por vez, cada uma tem início e fim exatos na linha do tempo do contexto. Dentro
 * dela a palavra é estimada por fração de caracteres — e como a janela zera a cada frase, o erro não
 * acumula ao longo de um texto longo, que é onde uma estimativa única sobre a mensagem inteira
 * desalinharia.
 *
 * Pedir frase a frase não atrasa o primeiro som: o `/tts/stream` já fatia por frase do lado do
 * servidor, então o primeiro áudio sai no tempo da primeira frase de qualquer jeito. E como o piper
 * gera mais rápido do que fala, a frase seguinte chega antes de a atual terminar — sem buraco.
 *
 * O fatiamento vem de `reading-text.ts`, e as frases vão prontas para o painel: se cada ponta
 * fatiasse por conta própria, as listas divergiriam e o destaque apontaria para a frase errada.
 */
async function speakReading(endpoint: VoiceEndpoint, voice: string, text: string, id: string, rate: number): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const preparado = await prepareText(endpoint, text).catch(() => speakable(text));
  const frases = splitSentences(preparado);
  if (!frases.length) return null;

  const stage = openSpeechStage();
  const janelas: Array<{ start: number; end: number } | null> = [];
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelada = false;
  streamingStop = () => {
    cancelada = true;
    void reader?.cancel().catch(() => undefined);
    for (const node of stage.sources) { try { node.stop(); } catch { /* já parou */ } }
  };

  void send({ type: "voice:reading", phase: "start", id, sentences: frases });

  // A posição sai pelo relógio do áudio, não por contagem de tempo: é o único que sabe o que está
  // tocando de verdade agora.
  let ultimaChave = "";
  const posicao = self.setInterval(() => {
    const agora = stage.context.currentTime;
    const index = janelas.findIndex((janela) => janela !== null && agora >= janela.start && agora < janela.end);
    if (index < 0) return;
    const janela = janelas[index]!;
    const ratio = Math.min(1, Math.max(0, (agora - janela.start) / Math.max(0.001, janela.end - janela.start)));
    const chave = `${index}:${ratio.toFixed(2)}`;
    if (chave === ultimaChave) return;
    ultimaChave = chave;
    void send({ type: "voice:reading", phase: "position", id, index, ratio });
  }, 80);

  let playAt = stage.context.currentTime + 0.12;
  try {
    for (const frase of frases) {
      if (cancelada) break;
      try {
        const body = await streamSpeech(endpoint, frase, voice);
        const agendado = await scheduleWav(stage, body, playAt, (r) => { reader = r; }, rate);
        janelas.push(agendado.start === null ? null : { start: agendado.start, end: agendado.playAt });
        playAt = agendado.playAt;
      } catch (error) {
        if (cancelada) break;
        // Uma frase que falha não derruba a leitura: fica sem janela, e os índices continuam
        // alinhados com a lista que o painel recebeu.
        janelas.push(null);
        trace("voice", "frase pulada na leitura", { ok: false, data: { erro: error instanceof Error ? error.message : String(error) } });
      }
    }
    if (!cancelada) await waitScheduled(stage, playAt);
  } finally {
    self.clearInterval(posicao);
    streamingStop = null;
    void send({ type: "voice:reading", phase: "end", id });
    stage.close();
  }
  return stage.recordedDone;
}

let streamingStop: (() => void) | null = null;

async function speak(text: string, readingId?: string) {
  let url = "";
  const attempt = traceSpan("voice", "síntese", { chars: text.length, leitura: !!readingId });
  try {
    const { settings, endpoint } = await voiceTarget();
    const spoken = speakable(text);
    if (!spoken) { attempt.end({ ok: false, code: "vazio" }); return; }
    output?.pause();
    segmenter?.suspend();
    speaking = true;
    publish("speaking");

    const rate = settings.voice.speechRate || 1;

    // Leitura de uma mensagem do painel: frase a frase, para o destaque acompanhar a voz.
    if (readingId && settings.voice.streamSpeech) {
      try {
        const recorded = await speakReading(endpoint, settings.voice.speechVoice, text, readingId, rate);
        attempt.end({ ok: true, data: { modo: "leitura", voz: settings.voice.speechVoice, taxa: rate } });
        if (debugRecording) { debugItems.push({ kind: "vela", t: Date.now(), text, audio: recorded?.bytes ?? null, mime: recorded?.mime ?? "", leitura: true }); reportDebugState(); }
        return;
      } catch (error) {
        trace("voice", "leitura frase a frase caiu para a fala inteira", { ok: false, data: { erro: error instanceof Error ? error.message : String(error) } });
      }
    }

    if (settings.voice.streamSpeech) {
      try {
        const recorded = await speakStreaming(endpoint, spoken, settings.voice.speechVoice, rate);
        attempt.end({ ok: true, data: { modo: "streaming", voz: settings.voice.speechVoice, taxa: rate, texto: spoken.slice(0, 300) } });
        if (debugRecording) { debugItems.push({ kind: "vela", t: Date.now(), text, audio: recorded?.bytes ?? null, mime: recorded?.mime ?? "", leitura: false }); reportDebugState(); }
        return;
      } catch (error) {
        // Servidor sem /tts/stream ou stream interrompido: o arquivo inteiro ainda funciona.
        trace("voice", "streaming caiu para arquivo inteiro", { ok: false, code: "stream_indisponivel", data: { erro: error instanceof Error ? error.message : String(error) } });
      }
    }

    const blob = await synthesizeSpeech(endpoint, spoken, settings.voice.speechModel, settings.voice.speechVoice);
    attempt.end({ ok: true, data: { modo: "arquivo", voz: settings.voice.speechVoice, taxa: rate, bytes: blob.size, texto: spoken.slice(0, 300) } });
    if (debugRecording) { debugItems.push({ kind: "vela", t: Date.now(), text, audio: await blobToBytes(blob), mime: blob.type || "audio/wav", leitura: !!readingId }); reportDebugState(); }
    url = URL.createObjectURL(blob);
    output = new Audio(url);
    output.playbackRate = rate;
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
    speaking = false;
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
