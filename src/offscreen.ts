import { loadSettings } from "./storage";
import { AppSettings } from "./types";
import { VoiceEndpoint, VoiceOption, listVoices, prepareText, streamSpeech, synthesizeSpeech, transcribeAudio } from "./provider";
import { Idioma, combinaComIdioma, idiomaDoTexto } from "./idioma";
import { avaliarTranscricao } from "./transcricao";
import { splitSentences } from "./reading-text";
import { UtteranceSegmenter } from "./vad";
import { VoiceMetricsAnalyzer } from "./audio-metrics";
import { encodeWav } from "./wav-encoder";
import { VoiceRuntimeState } from "./voice-runtime";
import { SttStream } from "./stt-stream";
import { clientDetail, fullTraceFrom, setClientDetail, spanFrom, traceFrom } from "./trace-client";
import { readTrace } from "./trace";
import { baixarArquivo, carimbo, montarPacote } from "./trace-package";
import { saveBlob } from "./trace-blobs";

const trace = traceFrom("offscreen");
const traceSpan = spanFrom("offscreen");
const traceFull = fullTraceFrom("offscreen");

/**
 * O áudio guardado junto do evento que o descreve.
 *
 * A transcrição é a interpretação do que foi dito; o áudio é o que foi dito. Quando as duas
 * discordam — e numa conversa falada isso acontece o tempo todo — só o trecho original resolve.
 * Devolve o id que o evento carrega; sem rastreio completo, devolve nada e não custa nada.
 */
const guardarAudio = (label: string, bytes: ArrayBuffer | Uint8Array, mime: string, turn = "voz") =>
  saveBlob({ turn, mime, label, bytes });

const SAMPLE_RATE = 16_000;
const MAX_PENDING = 3;

// O listener é registrado antes de qualquer await para o background poder fazer handshake.
chrome.runtime.onMessage.addListener((message: { type?: string; text?: string; id?: string; mode?: "live" | "dictation" }, _sender, sendResponse) => {
  if (message.type === "voice:ping") { sendResponse({ ok: true }); return false; }
  if (message.type === "voice:start") { void start(message.mode ?? "live"); return false; }
  // Precisa responder só depois de `stop()` terminar: se a gravação de depuração estiver ligada,
  // o zip é montado de forma assíncrona, e background.ts fecha o documento offscreen assim que
  // esta mensagem "resolve" — sem esperar, o documento morria no meio do download.
  if (message.type === "voice:stop") { void stop().then(() => sendResponse({ ok: true })); return true; }
  if (message.type === "voice:toggle-mute") { toggleMute(); return false; }
  // Ler uma mensagem é um pedido novo: o que estava na fila da narração não fala por cima dela.
  if (message.type === "voice:speak" && message.text) { pararFala(); void speak(message.text, message.id); return false; }
  if (message.type === "voice:speak-queue" && message.text) { enfileirarFala(message.text); return false; }
  if (message.type === "voice:speak-stop") { pararFala(); return false; }
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
/** Cada trecho na fila carrega de que enunciado ele veio: a fila pode ter mais de um. */
const pending: Array<{ wav: Blob; enunciado: string }> = [];
let draining = false;
let live: SttStream | null = null;
let lastPartial = "";
// Janela de resumo do sinal de áudio, para a trilha não receber vinte eventos por segundo.
let samples = 0;
let peak = 0;
let sum = 0;
let windowStarted = 0;

/*
 * Gravar a sessão de voz é ligar o rastreio completo e, ao parar, baixar o pacote de revisão.
 *
 * Antes existiam dois gravadores: este, que juntava áudio do microfone e da fala num zip próprio,
 * e a trilha, que sabia tudo o mais — modelo, prompt, ferramentas, o que a Vela pensou. Quem
 * revisava tinha metade da história em cada arquivo e nenhuma forma de casar as duas, porque o zip
 * não carregava turno nem carimbo da trilha. Hoje o botão do palco liga o mesmo interruptor de
 * Avançado; o áudio já entra na trilha com o evento que o descreve, e o que sai no fim é um pacote
 * só, com relatório, eventos e áudios que se referenciam por id.
 */
let debugRecording = false;
let debugStartedAt = 0;
let debugCount = 0;

function reportDebugState() {
  void send({ type: "voice:debug-state", recording: debugRecording, items: debugCount });
}

/** Conta o que já daria para revisar — fala ouvida ou dita —, para o botão dizer que está vivo. */
function contarDebug() {
  if (!debugRecording) return;
  debugCount += 1;
  reportDebugState();
}

function startDebugRecording() {
  if (!stream) { void send({ type: "voice:error", message: "Ligue o microfone (Live Voice ou ditado) antes de gravar a sessão de depuração." }); return; }
  if (debugRecording) return;
  debugRecording = true;
  debugCount = 0;
  debugStartedAt = Date.now();
  setClientDetail("completo");
  trace("voice", "gravação de depuração iniciada");
  reportDebugState();
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function stopDebugRecording() {
  if (!debugRecording) return;
  debugRecording = false;
  const desde = debugStartedAt;
  trace("voice", "gravação de depuração encerrada", { data: { itens: debugCount } });
  reportDebugState();
  try {
    // A trilha vive no background e é gravada em lotes de 400 ms. Ler no instante do clique
    // perderia justamente os últimos eventos — os do enunciado que motivou parar a gravação.
    await new Promise((resolve) => self.setTimeout(resolve, 700));
    const eventos = (await readTrace({ since: desde, limit: 20_000 })).sort((a, b) => a.at - b.at);
    if (!eventos.length) return;
    baixarArquivo(`vela-voz-${carimbo(desde)}.zip`, await montarPacote(eventos, { completo: true }));
  } catch (erro) {
    void send({ type: "voice:error", message: erro instanceof Error ? erro.message : "Falha ao montar o pacote da sessão." });
  }
}

const send = (message: unknown) => chrome.runtime.sendMessage(message).catch(() => undefined);
const publish = (next: VoiceRuntimeState) => {
  if (next !== state) trace("voice", `estado: ${state} → ${next}`, { data: { de: state, para: next, mode } });
  state = next;
  void send({ type: "voice:state", state, timestamp: Date.now() });
};

/** A voz tem servidor próprio: o gateway de texto não expõe transcrição nem síntese. */
/*
 * As preferências vêm do background, não do storage.
 *
 * Um documento offscreen só enxerga `chrome.runtime`: `chrome.storage` não existe aqui, e
 * `loadSettings()` devolvia os padrões **em silêncio**. Toda a voz rodava com eles — servidor,
 * modelo de transcrição, voz, velocidade da fala e o nível de rastreio —, então trocar a voz nas
 * Configurações não mudava nada e o modo completo nunca gravava áudio. Nada disso dava erro: os
 * padrões funcionam, só não são os que a pessoa escolheu.
 */
async function carregarSettings(): Promise<AppSettings> {
  const resposta = await chrome.runtime.sendMessage({ type: "settings:get" }).catch(() => null) as AppSettings | null;
  return resposta ?? await loadSettings();
}

async function voiceTarget() {
  const settings = await carregarSettings();
  /*
   * O offscreen é outro contexto: o nível de rastreio decidido no background não chega sozinho até
   * aqui. Sincronizar neste ponto cobre todo o pipeline de voz — captura, transcrição e síntese
   * passam por `voiceTarget` antes de qualquer coisa —, e evita um protocolo novo só para isto.
   */
  setClientDetail(settings.agent.fullTrace ? "completo" : "normal");
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
    const { wav: blob, enunciado: deQualFala } = pending.shift()!;
    // A medição da transcrição começa depois de o áudio ser guardado: começando antes, ela somava o
    // tempo de gravar no disco e, no relatório, a transcrição aparecia antes do próprio microfone.
    let attempt: ReturnType<typeof traceSpan> | null = null;
    try {
      const { settings, endpoint } = await voiceTarget();
      /*
       * O trecho de fala, como ele chegou ao servidor de transcrição.
       *
       * É a única prova do que foi realmente dito: a partir daqui tudo é interpretação. Guardado
       * antes da transcrição de propósito — se a chamada falhar, o áudio ainda existe para
       * explicar por quê.
       */
      const audioId = await guardarAudio(`fala do usuário (${(blob.size / 1024).toFixed(0)} kB)`, await blobToBytes(blob), blob.type || "audio/wav");
      traceFull("audio.capture", "trecho de fala capturado", { blobId: audioId, data: { enunciado: deQualFala, bytes: blob.size, mime: blob.type, modeloAlvo: settings.voice.transcriptionModel } });
      attempt = traceSpan("stt.result", "transcrição", { enunciado: deQualFala, bytes: blob.size, fila: pending.length });
      /*
       * O limite de 20 s precisa chegar ao `fetch`.
       *
       * O controlador existia, disparava e não cancelava nada: o sinal nunca era entregue à
       * requisição. Um servidor de transcrição que travasse segurava a fila inteira para sempre —
       * a pessoa continuava falando e nenhum trecho seguinte era transcrito.
       */
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const text = await transcribeAudio(endpoint, blob, settings.voice.transcriptionModel, controller.signal, settings.voice.transcriptionLanguage).finally(() => clearTimeout(timer));
      const clean = text.trim();
      const veredito = avaliarTranscricao(clean);
      const descartado = veredito.descartar;
      /*
        * O que o STT devolveu, incluindo o que foi descartado e por quê.
        *
        * Descarte silencioso é o pior caso para revisar: a pessoa fala, nada acontece, e não há
        * registro de que houve fala. Aqui fica o texto bruto, a decisão e o áudio que a originou.
        */
      attempt.end({
        ok: !descartado,
        code: descartado ? "descartado" : undefined,
        blobId: audioId,
        data: { enunciado: deQualFala, texto: clean, bruto: text, bytes: blob.size, modelo: settings.voice.transcriptionModel, descartado, motivo: veredito.motivo },
      });
      contarDebug();
      if (!descartado) {
        void send({ type: "voice:transcript", text: clean, final: true, timestamp: Date.now(), enunciado: deQualFala });
        if (mode === "live") publish("thinking");
      }
    } catch (error) {
      const expirou = error instanceof DOMException && error.name === "AbortError";
      const message = expirou ? "A transcrição não respondeu em 20 s; o trecho foi descartado." : error instanceof Error ? error.message : "Falha ao transcrever áudio.";
      (attempt ?? traceSpan("stt.result", "transcrição", { enunciado: deQualFala, bytes: blob.size })).end({ ok: false, code: expirou ? "tempo_esgotado" : "falha", data: { enunciado: deQualFala, erro: message } });
      void send({ type: "voice:error", message });
    }
  }
  draining = false;
}

async function start(nextMode: "live" | "dictation") {
  if (stream) { trace("voice", "start ignorado: microfone já aberto", { data: { mode: nextMode } }); return; }
  mode = nextMode;
  // O nível de rastreio é sincronizado aqui, antes do primeiro trecho de fala: quem descobria o
  // nível só na primeira transcrição perdia o que veio antes dela. `rastreio` no evento diz, em
  // quem for revisar, se esta sessão estava sendo guardada por inteiro ou só medida.
  await voiceTarget().catch(() => undefined);
  const opening = traceSpan("voice", "abrir microfone", { mode: nextMode, rastreio: clientDetail() });
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
      onStart: () => { enunciado = crypto.randomUUID(); trace("voice", "fala começou", { data: { enunciado } }); if (mode === "live") publish("listening"); },
      onEnd: (chunks) => {
        const amostras = chunks.reduce((total, item) => total + item.length, 0);
        const engolido = speaking || Date.now() < speakingUntil;
        trace("voice", engolido ? "fala ignorada (a Vela estava falando)" : "fala terminou", {
          ok: !engolido,
          data: { enunciado, segundos: Number((amostras / (audio?.sampleRate ?? SAMPLE_RATE)).toFixed(2)) },
        });
        if (engolido) return;
        if (pending.length >= MAX_PENDING) { pending.shift(); void send({ type: "voice:error", message: "Transcrição atrasada; um trecho foi descartado." }); }
        pending.push({ wav: encodeWav(chunks, audio?.sampleRate ?? SAMPLE_RATE), enunciado });
        void drain();
      },
    }, { sampleRate: audio.sampleRate });

    /*
     * O texto ao vivo é opcional por definição: se o endereço não estiver configurado, ou se a
     * conexão cair, a transcrição em lote continua inteira. Ele nunca abre um turno — só escreve
     * na tela enquanto a pessoa fala.
     */
    const streamingUrl = (await carregarSettings()).voice.streamingUrl.trim();
    if (mode === "live" && streamingUrl) {
      const connecting = traceSpan("voice", "texto ao vivo", { url: streamingUrl });
      let opened = false;
      live = new SttStream(streamingUrl, audio.sampleRate, {
        onReady: () => { if (!opened) { opened = true; connecting.end({ ok: true }); } },
        onPartial: (text) => {
          if (text === lastPartial) return;
          lastPartial = text;
          // O rascunho muda a cada palavra: no nível normal isso seria centenas de eventos por
          // frase. No completo é justamente o que mostra como a transcrição foi se corrigindo.
          traceFull("stt.partial", "rascunho da fala", { data: { enunciado, texto: text } });
          void send({ type: "voice:partial", text });
        },
        onFinal: (text) => { lastPartial = ""; trace("stt.partial", "trecho fechado no texto ao vivo", { ok: true, data: { enunciado, texto: text, fechado: true } }); },
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

  // No rastreio completo, o que sai do mixer é gravado em paralelo ao que toca de verdade — sem
  // isso não há como revisar depois o que a Vela realmente falou, só o texto que ela pretendia.
  // O gate é o nível de detalhe, e não mais um modo próprio: era o que fazia o áudio da fala em
  // streaming faltar na trilha justamente quando alguém tinha ligado o rastreio para vê-lo.
  let recorder: MediaRecorder | null = null;
  const recordedChunks: Blob[] = [];
  let recordedDone: Promise<{ bytes: Uint8Array; mime: string } | null> = Promise.resolve(null);
  if (clientDetail() === "completo") {
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

/*
 * O enunciado tem nome proprio.
 *
 * A fala e gravada aqui e o turno so nasce depois, no background, quando a transcricao chega — o
 * que deixava a captura, os rascunhos e a transcricao carimbados como "sem turno", fora do
 * relatorio do turno que eles mesmos abriram. Quem revisava via a resposta da Vela sem a pergunta
 * que a causou. Este id viaja junto da transcricao e costura os dois lados sem adivinhar por
 * proximidade no tempo.
 */
let enunciado = "";

let streamingStop: (() => void) | null = null;

/*
 * A voz acompanha o idioma da resposta.
 *
 * Numa sessão real a Vela respondeu português com voz inglesa — sai um sotaque que atrapalha a
 * compreensão e passa a impressão de que ela não entendeu o pedido. A lista de vozes do servidor já
 * diz o idioma de cada uma e vem ordenada da mais rápida para a mais lenta, então escolher é pegar
 * a primeira que combina. A lista é buscada uma vez por sessão: pedir a cada frase somaria uma ida
 * ao servidor no caminho mais sensível a latência que existe aqui.
 */
let vozesConhecidas: VoiceOption[] | null = null;

async function vozParaIdioma(endpoint: VoiceEndpoint, idioma: Idioma, atual: string): Promise<string> {
  const daAtual = vozesConhecidas?.find((item) => item.id === atual);
  if (daAtual && combinaComIdioma(daAtual.language, idioma)) return atual;
  if (!vozesConhecidas) vozesConhecidas = await listVoices(endpoint).catch(() => []);
  const atualConhecida = vozesConhecidas.find((item) => item.id === atual);
  // Sem saber o idioma da voz configurada, não se troca nada: o palpite erraria para os dois lados.
  if (atualConhecida && combinaComIdioma(atualConhecida.language, idioma)) return atual;
  const candidata = vozesConhecidas.find((item) => combinaComIdioma(item.language, idioma));
  return candidata?.id ?? atual;
}

/*
 * Fila de fala: frases que chegam enquanto a resposta ainda está sendo escrita.
 *
 * `voice:speak` interrompe o que estiver tocando — é o certo para "leia esta mensagem", e o errado
 * para a narração em pedaços, em que a segunda frase cortaria a primeira. A fila toca uma depois da
 * outra; parar a fala avança a geração, e o que estava esperando na fila não toca mais.
 */
let filaDeFala: Promise<void> = Promise.resolve();
let geracaoDeFala = 0;
/*
 * Quem encerra a reprodução em curso quando alguém manda parar.
 *
 * Sem isto a fila **travava para sempre**: a reprodução de arquivo só terminava pelo `onended`, e
 * `pause()` não dispara evento nenhum. A promessa daquele item nunca se resolvia, e como a fila é um
 * encadeamento, tudo o que viesse depois — o resto da resposta, e a fala de todos os turnos
 * seguintes — ficava esperando atrás de algo que não ia acabar nunca. Em silêncio.
 */
let encerrarReproducao: (() => void) | null = null;

function pararFala() {
  geracaoDeFala += 1;
  falasNaFila = 0;
  streamingStop?.();
  output?.pause();
  output = null;
  encerrarReproducao?.();
  encerrarReproducao = null;
  speaking = false;
  speakingUntil = Date.now() + 500;
  segmenter?.resume();
}

/*
 * Quantas falas ainda vão sair. Enquanto for maior que zero, o microfone continua suspenso.
 *
 * `speaking` era ligado dentro de cada `speak` e desligado no fim dele — e entre uma frase da
 * narração e a seguinte havia uma fresta em que o VAD voltava a ouvir. Com alto-falante aberto, foi
 * por essa fresta que a **própria voz da Vela** entrou como fala do usuário ("Conseguiu sim, você
 * está no site do Mercado Livre" transcrito como pedido), abrindo um turno que interrompeu o que
 * estava em andamento.
 */
let falasNaFila = 0;

function enfileirarFala(texto: string) {
  const minha = geracaoDeFala;
  falasNaFila += 1;
  segmenter?.suspend();
  speaking = true;
  filaDeFala = filaDeFala
    .then(() => (minha === geracaoDeFala ? speak(texto) : undefined))
    .catch(() => undefined)
    .finally(() => {
      falasNaFila = Math.max(0, falasNaFila - 1);
      if (falasNaFila === 0) {
        speaking = false;
        speakingUntil = Date.now() + 700;
        segmenter?.resume();
      }
    });
}

async function speak(text: string, readingId?: string) {
  let url = "";
  // A síntese é medida a partir do pedido, não antes dele: começando antes, somava a leitura das
  // preferências e aparecia no relatório antes do próprio "mandou falar".
  let attempt = traceSpan("tts.audio", "síntese", { chars: text.length, leitura: !!readingId });
  try {
    const { settings, endpoint } = await voiceTarget();
    const spoken = speakable(text);
    /*
     * O idioma é do texto, não da configuração: numa conversa que troca de idioma no meio, a voz
     * troca junto — e volta sozinha quando o assunto volta.
     */
    let voz = settings.voice.speechVoice;
    if (settings.voice.followLanguage && spoken) {
      voz = await vozParaIdioma(endpoint, idiomaDoTexto(spoken), voz);
      if (voz !== settings.voice.speechVoice) trace("voice", "voz trocada para acompanhar o idioma", { data: { de: settings.voice.speechVoice, para: voz } });
    }
    /*
     * O que se manda falar não é o que se escreveu.
     *
     * `speakable` tira markdown, bloco de código e link; o servidor ainda normaliza por cima. Numa
     * revisão de "por que ela falou isso", a diferença entre o texto da tela e o texto falado é
     * exatamente o que costuma explicar — e ela não existia em lugar nenhum antes.
     */
    traceFull("tts.request", "texto enviado para falar", {
      data: { original: text, falado: spoken, voz, modelo: settings.voice.speechModel, taxa: settings.voice.speechRate, leitura: !!readingId, streaming: settings.voice.streamSpeech },
    });
    attempt = traceSpan("tts.audio", "síntese", { chars: text.length, leitura: !!readingId });
    if (!spoken) { attempt.end({ ok: false, code: "vazio", data: { original: text } }); return; }
    output?.pause();
    segmenter?.suspend();
    speaking = true;
    publish("speaking");

    const rate = settings.voice.speechRate || 1;

    // Leitura de uma mensagem do painel: frase a frase, para o destaque acompanhar a voz.
    if (readingId && settings.voice.streamSpeech) {
      try {
        const recorded = await speakReading(endpoint, voz, text, readingId, rate);
        const audioId = recorded ? await guardarAudio("resposta falada (leitura)", recorded.bytes, recorded.mime || "audio/wav") : undefined;
        attempt.end({ ok: true, blobId: audioId, data: { modo: "leitura", voz, taxa: rate, bytes: recorded?.bytes.byteLength, falado: spoken } });
        contarDebug();
        return;
      } catch (error) {
        trace("voice", "leitura frase a frase caiu para a fala inteira", { ok: false, data: { erro: error instanceof Error ? error.message : String(error) } });
      }
    }

    if (settings.voice.streamSpeech) {
      try {
        // A reprodução em streaming também precisa de `tts.play`: sem ela o relatório mostrava o
        // áudio pronto e nunca dizia se ele chegou a tocar — que é a pergunta de quem não ouviu nada.
        const tocando = traceSpan("tts.play", "reprodução", { modo: "streaming", taxa: rate });
        const recorded = await speakStreaming(endpoint, spoken, settings.voice.speechVoice, rate).finally(() => tocando.end({ ok: true }));
        const audioId = recorded ? await guardarAudio("resposta falada (streaming)", recorded.bytes, recorded.mime || "audio/wav") : undefined;
        attempt.end({ ok: true, blobId: audioId, data: { modo: "streaming", voz, taxa: rate, bytes: recorded?.bytes.byteLength, falado: spoken } });
        contarDebug();
        return;
      } catch (error) {
        // Servidor sem /tts/stream ou stream interrompido: o arquivo inteiro ainda funciona.
        trace("voice", "streaming caiu para arquivo inteiro", { ok: false, code: "stream_indisponivel", data: { erro: error instanceof Error ? error.message : String(error) } });
      }
    }

    const blob = await synthesizeSpeech(endpoint, spoken, settings.voice.speechModel, voz);
    const audioId = await guardarAudio("resposta falada (arquivo)", await blobToBytes(blob), blob.type || "audio/wav");
    attempt.end({ ok: true, blobId: audioId, data: { modo: "arquivo", voz, taxa: rate, bytes: blob.size, falado: spoken } });
        contarDebug();
    url = URL.createObjectURL(blob);
    output = new Audio(url);
    output.playbackRate = rate;
    const tocando = traceSpan("tts.play", "reprodução", { bytes: blob.size, taxa: rate });
    await new Promise<void>((resolve, reject) => {
      // `encerrarReproducao` é o resolve guardado para quem mandar parar: pausar o áudio não dispara
      // `onended`, e sem uma saída a fila de fala ficaria parada atrás desta promessa.
      encerrarReproducao = resolve;
      output!.onended = () => resolve();
      output!.onerror = () => reject(new Error("Falha ao reproduzir a resposta."));
      void output!.play().catch(reject);
    }).finally(() => { encerrarReproducao = null; });
    // Quanto durou de fato na caixa de som: é o número que a pessoa sente como "ela falou por
    // muito tempo", e ele não se deduz do tamanho do arquivo nem da duração da síntese.
    tocando.end({ ok: true, blobId: audioId, data: { segundos: output?.duration } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao sintetizar voz.";
    attempt.end({ ok: false, code: "falha", data: { erro: message } });
    void send({ type: "voice:error", message });
  } finally {
    if (url) URL.revokeObjectURL(url);
    // Só religa o microfone quando não sobrou nada na fila: no meio da narração, religar deixava a
    // Vela ouvindo a si mesma entre uma frase e a outra.
    if (falasNaFila === 0) {
      speaking = false;
      speakingUntil = Date.now() + 500;
      segmenter?.resume();
    }
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
