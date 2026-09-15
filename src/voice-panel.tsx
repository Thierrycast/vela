import { useEffect, useState } from "react";
import { Mic, RefreshCw } from "lucide-react";
import { AppSettings } from "./types";
import { ConnectionCheck, VoiceOption, checkVoiceEndpoint, listVoices } from "./provider";
import { Select } from "./select";
import { VisualPicker } from "./visual-picker";
import { ShaderEditor } from "./shader-editor";
import { VisualId, setCustomShader } from "./voice-visuals";

type MicrophoneState = "unknown" | "granted" | "denied" | "prompt" | "asking" | "error";

const LED: Record<MicrophoneState, string> = { unknown: "empty", granted: "ok", denied: "error", prompt: "empty", asking: "testing", error: "error" };
const LABEL: Record<MicrophoneState, string> = {
  unknown: "Não verificado",
  granted: "Liberado",
  denied: "Bloqueado pelo navegador",
  prompt: "Ainda não autorizado",
  asking: "Aguardando sua resposta…",
  error: "Falhou",
};

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{label}</strong>{description && <small>{description}</small>}</div><div className="setting-control">{children}</div></div>;
}

/**
 * Voz e chat falam com servidores diferentes. O gateway de texto não expõe transcrição nem
 * síntese, e exigir a chave dele para gravar deixava os botões de voz mortos sem dizer por quê.
 *
 * A outra armadilha: o runtime de voz vive num documento offscreen, e documento offscreen **não
 * consegue exibir o prompt de permissão do microfone**. A página de opções é uma página comum —
 * aqui o prompt aparece, e a permissão vale para a origem inteira da extensão.
 */
export function VoicePanel({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const [microphone, setMicrophone] = useState<MicrophoneState>("unknown");
  const [detail, setDetail] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionCheck | "testing" | null>(null);
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const { voice } = settings;

  // A miniatura de "Seu shader" no seletor lê o código do registro, não de uma prop: mantê-lo em
  // dia aqui é o que faz a opção mostrar o shader da pessoa em vez do exemplo.
  useEffect(() => { setCustomShader(voice.customShader); }, [voice.customShader]);

  // Sem isto, a lista só existia depois de um clique em Testar — e o campo ficava um texto livre
  // onde o usuário teria de adivinhar o nome de uma voz.
  useEffect(() => {
    if (!voice.baseUrl.trim()) return;
    let cancelled = false;
    void listVoices({ baseUrl: voice.baseUrl, apiKey: voice.apiKey })
      .then((list) => { if (!cancelled) setVoices(list); })
      .catch(() => { if (!cancelled) setVoices(null); });
    return () => { cancelled = true; };
  }, [voice.baseUrl, voice.apiKey]);

  useEffect(() => {
    void navigator.permissions?.query({ name: "microphone" as PermissionName })
      .then((status) => {
        setMicrophone(status.state as MicrophoneState);
        status.onchange = () => setMicrophone(status.state as MicrophoneState);
      })
      .catch(() => setMicrophone("unknown"));
  }, []);

  const patch = (next: Partial<AppSettings["voice"]>) => update({ voice: { ...voice, ...next } });

  const test = async () => {
    setConnection("testing");
    const endpoint = { baseUrl: voice.baseUrl, apiKey: voice.apiKey };
    const result = await checkVoiceEndpoint(endpoint);
    setConnection(result);
    if (result.ok) void listVoices(endpoint).then(setVoices).catch(() => setVoices(null));
  };

  const askForMicrophone = async () => {
    setMicrophone("asking");
    setDetail(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      setMicrophone("granted");
      setDetail("Pronto. O ditado e o Live Voice já podem gravar.");
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      setMicrophone(name === "NotAllowedError" ? "denied" : "error");
      setDetail(name === "NotAllowedError"
        ? "Você recusou, ou o Chrome já tinha bloqueado esta origem. Reveja no cadeado da barra de endereços desta página."
        : name === "NotFoundError" ? "Nenhum microfone encontrado nesta máquina." : "Não consegui acessar o microfone.");
    }
  };

  // O rótulo carrega motor e velocidade: escolher voz sem saber que uma demora o dobro da outra
  // é como o padrão ficou lento sem ninguém perceber.
  const voiceOptions = (voices ?? []).map((item) => ({
    value: item.id,
    label: item.label + (item.ratio !== undefined ? (item.ratio < 1 ? " · rápida" : " · lenta") : ""),
    hint: [item.engine, item.language, item.ratio !== undefined ? `gera em ${item.ratio.toFixed(2)}× a duração` : null].filter(Boolean).join(" · "),
  }));

  return <>
    <h1>Voz</h1>
    <p className="section-intro">A voz fala com um servidor próprio, separado do provider de texto — transcrição e síntese não passam pelo gateway do chat. O runtime continua vivo num documento offscreen mesmo com a sidebar fechada.</p>

    <h2 className="subsection">Aparência da voz</h2>
    <p className="picker-intro">Como a Vela se mostra enquanto ouve e fala. Cada opção passeia sozinha pelos estados: azul quando é você falando, âmbar quando é ela.</p>
    <VisualPicker value={voice.visual} onChange={(visual: VisualId) => patch({ visual })} />
    {voice.visual === "custom" && <ShaderEditor value={voice.customShader} onChange={(customShader) => patch({ customShader })} />}

    <h2 className="subsection">Durante a conversa</h2>
    <div className="settings-group">
      <Row label="Síntese em streaming" description="Toca enquanto o servidor gera, em vez de esperar o arquivo inteiro. Numa frase longa é a diferença entre responder e parecer travada.">
        <button className={`toggle ${voice.streamSpeech ? "on" : ""}`} role="switch" aria-checked={voice.streamSpeech} aria-label="Síntese em streaming" onClick={() => patch({ streamSpeech: !voice.streamSpeech })}><span /></button>
      </Row>
      <Row label="Janelinha flutuante na página" description="Uma segunda superfície por cima do site que você está lendo. O palco da voz já fica no painel, então ela só faz sentido com a barra lateral fechada.">
        <button className={`toggle ${voice.showPulse ? "on" : ""}`} role="switch" aria-checked={voice.showPulse} aria-label="Janelinha flutuante" onClick={() => patch({ showPulse: !voice.showPulse })}><span /></button>
      </Row>
      <Row label="Velocidade da fala" description="O servidor de voz fala num ritmo fixo por voz; isto acelera ou desacelera a reprodução no cliente, sem pedir outro arquivo.">
        <span className="model-inline">
          <input type="range" min={0.8} max={1.8} step={0.05} value={voice.speechRate} onChange={(event) => patch({ speechRate: Number(event.target.value) })} />
          <code>{voice.speechRate.toFixed(2)}×</code>
        </span>
      </Row>
    </div>

    <h2 className="subsection">Microfone</h2>
    <div className="settings-group">
      <Row label="Permissão" description="O runtime de voz roda num documento offscreen, que não consegue mostrar o pedido de permissão. Por isso ele é feito aqui, uma vez só.">
        <span className={`connection-led led-${LED[microphone]}`}><i />{LABEL[microphone]}</span>
        <button className="secondary-button" onClick={() => void askForMicrophone()} disabled={microphone === "asking" || microphone === "granted"}>
          <Mic size={14} /> {microphone === "granted" ? "Liberado" : "Permitir microfone"}
        </button>
      </Row>
      {detail && <Row label="Detalhe"><small className={microphone === "granted" ? "probe-ok" : "probe-off"}>{detail}</small></Row>}
    </div>

    <h2 className="subsection">Servidor de voz</h2>
    <div className="settings-group">
      <Row label="Endereço" description="Sem barra no fim. As rotas seguem o padrão da OpenAI: /v1/audio/speech e /v1/audio/transcriptions.">
        <input className="mono" value={voice.baseUrl} placeholder="http://SEU-SERVIDOR-DE-VOZ:8010" onChange={(event) => patch({ baseUrl: event.target.value })} />
      </Row>
      <Row label="Chave" description="Deixe vazio quando o servidor não pede autenticação, como no acesso pela Tailscale.">
        <input className="mono" type="password" value={voice.apiKey} placeholder="opcional" onChange={(event) => patch({ apiKey: event.target.value })} />
      </Row>
      <Row label="Conexão" description="Consulta /health e busca a lista de vozes disponíveis.">
        {connection && connection !== "testing" && <small className={connection.ok ? "probe-ok" : "probe-off"}>{connection.detail}</small>}
        <button className="secondary-button" onClick={() => void test()} disabled={connection === "testing" || !voice.baseUrl.trim()}>
          <RefreshCw size={13} /> {connection === "testing" ? "Testando…" : "Testar"}
        </button>
      </Row>
    </div>

    <h2 className="subsection">Modelos</h2>
    <div className="settings-group">
      <Row label="Transcrição" description="Modelo de /v1/audio/transcriptions. O whisper-large-v3-turbo sai pontuado e capitalizado.">
        <input className="mono" value={voice.transcriptionModel} onChange={(event) => patch({ transcriptionModel: event.target.value })} />
      </Row>
      <Row label="Síntese" description="Modelo de /v1/audio/speech.">
        <input className="mono" value={voice.speechModel} onChange={(event) => patch({ speechModel: event.target.value })} />
      </Row>
      <Row label="Voz" description={voices ? `${voices.length} voz(es) neste servidor, das mais rápidas para as mais lentas.` : "Teste a conexão para carregar a lista do servidor."}>
        {voiceOptions.length > 0
          ? <Select value={voice.speechVoice || voiceOptions[0].value} label="Voz" options={voiceOptions} onChange={(speechVoice) => patch({ speechVoice })} />
          : <input value={voice.speechVoice} placeholder="padrão do servidor" onChange={(event) => patch({ speechVoice: event.target.value })} />}
      </Row>
    </div>

    <h2 className="subsection">Transcrição incremental</h2>
    <div className="settings-group">
      <Row label="WebSocket" description="Mostra o texto aparecendo enquanto você fala, no modo de voz ao vivo. Áudio em PCM 16-bit, 16 kHz, mono. Em branco, desliga — a transcrição final continua igual.">
        <input className="mono" value={voice.streamingUrl} placeholder="ws://SEU-SERVIDOR-DE-VOZ:8010/stt/stream" onChange={(event) => patch({ streamingUrl: event.target.value })} />
      </Row>
    </div>
    <p className="maintenance-notice ok">O caminho incremental existe para dar retorno visual imediato, não precisão: o motor é o Vosk, que devolve minúsculas e sem pontuação. O texto que fica é sempre o do modelo de transcrição acima, ao fim do enunciado.</p>
  </>;
}
