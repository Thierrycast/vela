import { useEffect, useState } from "react";
import { Mic } from "lucide-react";
import { AppSettings } from "./types";

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
 * O runtime de voz vive num documento offscreen, e documento offscreen **não consegue exibir o
 * prompt de permissão do microfone**. Sem esta tela, `getUserMedia` falha lá dentro sem nenhuma
 * caixa de diálogo aparecer — e o botão de ditado parece simplesmente quebrado.
 *
 * A página de opções é uma página comum: aqui o prompt aparece, e a permissão concedida vale para
 * a origem inteira da extensão, inclusive para o offscreen.
 */
export function VoicePanel({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const [microphone, setMicrophone] = useState<MicrophoneState>("unknown");
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    void navigator.permissions?.query({ name: "microphone" as PermissionName })
      .then((status) => {
        setMicrophone(status.state as MicrophoneState);
        status.onchange = () => setMicrophone(status.state as MicrophoneState);
      })
      .catch(() => setMicrophone("unknown"));
  }, []);

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
        ? "Você recusou, ou o Chrome já tinha bloqueado esta origem. Reveja em Configurações do site, no cadeado da barra de endereços desta página."
        : name === "NotFoundError" ? "Nenhum microfone encontrado nesta máquina." : "Não consegui acessar o microfone.");
    }
  };

  return <>
    <h1>Voz</h1>
    <p className="section-intro">O Live Voice continua no documento offscreen mesmo com a sidebar fechada. Configure aqui o acesso ao microfone e os modelos de áudio encaminhados pelo OmniRoute.</p>

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

    <h2 className="subsection">Modelos</h2>
    <div className="settings-group">
      <Row label="Modelo de transcrição" description="Endpoint /api/v1/audio/transcriptions.">
        <input className="mono" value={settings.voice.transcriptionModel} onChange={(event) => update({ voice: { ...settings.voice, transcriptionModel: event.target.value } })} />
      </Row>
      <Row label="Modelo de fala" description="Endpoint /api/v1/audio/speech.">
        <input className="mono" value={settings.voice.speechModel} onChange={(event) => update({ voice: { ...settings.voice, speechModel: event.target.value } })} />
      </Row>
      <Row label="Voz">
        <input value={settings.voice.speechVoice} onChange={(event) => update({ voice: { ...settings.voice, speechVoice: event.target.value } })} />
      </Row>
    </div>
  </>;
}
