/**
 * O texto aparecendo enquanto a pessoa fala.
 *
 * O caminho em lote (`/v1/audio/transcriptions`) só responde quando a frase acabou: durante os
 * segundos em que se fala, a tela não tem nada a mostrar. É o silêncio que faz o usuário repetir
 * a frase achando que o microfone não pegou.
 *
 * O `/stt/stream` do servidor de voz resolve isso — Vosk devolvendo hipótese a cada bloco de
 * 250 ms. O que ele **não** resolve é a qualidade: a hipótese do Vosk é pior que a transcrição do
 * Whisper, e o que vira comando da agente precisa estar certo. Por isso os dois convivem com
 * papéis separados:
 *
 * - **O stream escreve na tela.** É rascunho, muda enquanto se fala, e nunca abre um turno.
 * - **O lote decide.** Continua sendo ele quem produz o texto final que a Vela vai obedecer.
 *
 * Consequência prática: o áudio sai duas vezes. Numa tailnet local isso custa quase nada, e a
 * alternativa — confiar o comando ao rascunho — trocaria latência por erro de interpretação.
 *
 * O protocolo está em `GET /stt/stream/schema`: PCM s16le mono em quadros binários, controle e
 * respostas em JSON de texto. O servidor recusa com código 1013 quando passa de seis conexões.
 *
 * Uma armadilha medida contra o servidor real: o `ready` **não** vem depois do `config`, vem depois
 * do primeiro quadro de áudio. Segurar o áudio esperando o `ready` trava os dois lados — o cliente
 * espera a permissão, o servidor espera o som. Por isso o áudio sai assim que o socket abre, e o
 * `ready` serve só para saber que a conexão vingou.
 */

type Handlers = {
  /** O servidor aceitou a conexão e já está ouvindo. */
  onReady: () => void;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
};

const RECONNECT_DELAY = 1500;
const MAX_RECONNECTS = 3;
/** Acima disto, a conexão funcionou e caiu — não conta contra o orçamento de tentativas. */
const HEALTHY_CONNECTION = 10_000;

export class SttStream {
  private socket: WebSocket | null = null;
  private closing = false;
  private reconnects = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** Áudio falado enquanto o socket ainda abria. Sem isto, o começo da primeira frase some. */
  private queue: ArrayBuffer[] = [];

  constructor(private url: string, private sampleRate: number, private handlers: Handlers) {}

  open() {
    this.closing = false;
    this.connect();
  }

  private connect() {
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      this.handlers.onError(error instanceof Error ? error.message : "Endereço de streaming inválido.");
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    const openedAt = Date.now();

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "config", sample_rate: this.sampleRate, words: false }));
      for (const frame of this.queue) socket.send(frame);
      this.queue.length = 0;
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      let message: { type?: string; text?: string; message?: string };
      try { message = JSON.parse(event.data) as typeof message; } catch { return; }
      if (message.type === "ready") this.handlers.onReady();
      if (message.type === "partial" && message.text) this.handlers.onPartial(message.text);
      // `final` fecha um segmento no meio da fala; `done` fecha a conexão inteira. Os dois são
      // texto em que dá para confiar — o que muda é só quando chegam.
      if ((message.type === "final" || message.type === "done") && message.text) this.handlers.onFinal(message.text);
      if (message.type === "error" && message.message) this.handlers.onError(message.message);
    };

    socket.onclose = (event: CloseEvent) => {
      this.socket = null;
      if (this.closing) return;
      // 1013 é o servidor dizendo que já tem seis streams. Reconectar em laço só piora a fila.
      if (event.code === 1013) { this.handlers.onError("O servidor de voz está com todas as conexões de streaming ocupadas."); return; }
      /*
       * O orçamento de três tentativas existe para um servidor que não está lá. Uma conexão que
       * viveu bastante e caiu é outra coisa: o servidor fecha o stream depois de 120 s sem áudio, e
       * uma conversa tem silêncio. Sem esta distinção, três pausas longas gastavam o orçamento e o
       * texto ao vivo morria pelo resto da sessão. Zerar no `ready` não resolveria — o `ready` só
       * vem quando alguém fala, que é justamente o que não estava acontecendo.
       */
      if (Date.now() - openedAt >= HEALTHY_CONNECTION) this.reconnects = 0;
      if (this.reconnects >= MAX_RECONNECTS) { this.handlers.onError("O texto ao vivo caiu; a transcrição final continua funcionando."); return; }
      this.reconnects += 1;
      this.retry = setTimeout(() => { this.retry = null; if (!this.closing) this.connect(); }, RECONNECT_DELAY);
    };

    socket.onerror = () => { /* o `onclose` que vem em seguida é quem decide o que fazer */ };
  }

  /** Quadro de áudio. Descarta em vez de acumular sem limite: rascunho velho não interessa. */
  push(samples: Float32Array) {
    if (this.closing) return;
    const socket = this.socket;
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    if (socket?.readyState === WebSocket.OPEN) { socket.send(buffer); return; }
    if (this.queue.length < 40) this.queue.push(buffer);
  }

  close() {
    this.closing = true;
    this.queue.length = 0;
    if (this.retry !== null) { clearTimeout(this.retry); this.retry = null; }
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "eof" }));
      socket.close();
    } catch { /* já estava fechado */ }
  }
}
