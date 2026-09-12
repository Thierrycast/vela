import { useEffect, useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { AppSettings } from "./types";
import { BridgeStatus } from "./bridge";

const STATE_LABEL: Record<BridgeStatus["state"], string> = {
  off: "Desligada",
  connecting: "Procurando a ponte…",
  on: "Conectada",
  offline: "Processo vela-bridge fora do ar",
  error: "Erro",
};

const LED: Record<BridgeStatus["state"], string> = { off: "empty", connecting: "testing", on: "ok", offline: "testing", error: "error" };

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{label}</strong>{description && <small>{description}</small>}</div><div className="setting-control">{children}</div></div>;
}

function Snippet({ title, note, code }: { title: string; note: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return <div className="snippet">
    <div className="snippet-head">
      <div><strong>{title}</strong><small>{note}</small></div>
      <button className="secondary-button" onClick={() => void copy()}><Copy size={13} /> {copied ? "Copiado" : "Copiar"}</button>
    </div>
    <pre>{code}</pre>
  </div>;
}

export function BridgePanel({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const [status, setStatus] = useState<BridgeStatus>({ state: "off", calls: 0 });
  const { bridge } = settings;

  useEffect(() => {
    const ask = () => { void chrome.runtime?.sendMessage({ type: "bridge:status" }).then((value: BridgeStatus) => { if (value) setStatus(value); }).catch(() => undefined); };
    ask();
    const timer = setInterval(ask, 2000);
    return () => clearInterval(timer);
  }, []);

  const patch = (next: Partial<AppSettings["bridge"]>) => update({ bridge: { ...bridge, ...next } });
  const path = bridge.scriptPath.trim() || "<caminho do repositório>/bridge/vela-bridge.mjs";
  const env = bridge.port === 8792
    ? { VELA_BRIDGE_TOKEN: bridge.token || "<gere o token acima>" }
    : { VELA_BRIDGE_TOKEN: bridge.token || "<gere o token acima>", VELA_BRIDGE_PORT: String(bridge.port) };

  const claudeSnippet = JSON.stringify({ mcpServers: { vela: { command: "node", args: [path], env } } }, null, 2);
  const codexSnippet = [
    "[mcp_servers.vela]",
    'command = "node"',
    `args = ["${path.replace(/\\/g, "\\\\")}"]`,
    `env = { ${Object.entries(env).map(([key, value]) => `${key} = "${value}"`).join(", ")} }`,
  ].join("\n");

  return <>
    <h1>Ponte MCP</h1>
    <p className="section-intro">Deixa outros agentes — Codex, Claude Code — usarem a Vela como ferramenta: ler a página, agir nela, buscar na web ou delegar uma tarefa inteira ao modelo que você já configurou aqui, no seu navegador logado.</p>

    <h2 className="subsection">Estado</h2>
    <div className="settings-group">
      <Row label="Ligar a ponte" description="A extensão conecta sozinha ao processo vela-bridge quando ele estiver rodando.">
        <span className={`connection-led led-${LED[status.state]}`}><i />{STATE_LABEL[status.state]}</span>
        <button className={`toggle ${bridge.enabled ? "on" : ""}`} role="switch" aria-checked={bridge.enabled} aria-label="Ligar a ponte" onClick={() => patch({ enabled: !bridge.enabled })}><span /></button>
      </Row>
      {status.detail && <Row label="Detalhe"><small className="probe-off">{status.detail}</small></Row>}
      <Row label="Chamadas atendidas" description="Quantos pedidos de agentes externos a Vela executou desde que a ponte subiu.">
        <span className="status-badge">{status.calls}</span>
      </Row>
      <Row label="Porta local" description="Só 127.0.0.1. A ponte nunca escuta na rede. Se esta porta estiver ocupada, o processo anda até sete casas acima e a extensão acha sozinha.">
        <input className="mono" type="number" min={1024} max={65535} value={bridge.port} onChange={(event) => patch({ port: Number(event.target.value) || 8792 })} />
      </Row>
      {/* A porta preferida é o que você pediu; esta é onde a ponte coube. Mostrar as duas evita o
          diagnóstico errado de "configurei 8792 e não conecta" quando ela está viva na 8794. */}
      {status.port !== undefined && status.port !== bridge.port && <Row label="Porta em uso" description="A configurada estava ocupada quando o processo subiu.">
        <span className="status-badge">{status.port}</span>
      </Row>}
    </div>

    <h2 className="subsection">Token</h2>
    <div className="settings-group">
      <Row label="Token de pareamento" description="Um endpoint local sem autenticação deixaria qualquer processo da máquina dirigir o seu navegador logado. Este token é o que impede isso.">
        <input className="mono" type="password" value={bridge.token} readOnly placeholder="ainda não gerado" />
        <button className="secondary-button" onClick={() => patch({ token: crypto.randomUUID().replace(/-/g, "") })}><RefreshCw size={13} /> {bridge.token ? "Gerar outro" : "Gerar"}</button>
      </Row>
      <Row label="Caminho do vela-bridge.mjs" description="Onde o arquivo está nesta máquina. Só serve para montar os trechos de configuração abaixo.">
        <input className="mono" value={bridge.scriptPath} placeholder="C:\\…\\browser-ai\\bridge\\vela-bridge.mjs" onChange={(event) => patch({ scriptPath: event.target.value })} />
      </Row>
    </div>

    <h2 className="subsection">Configurar o agente de fora</h2>
    <Snippet title="Claude Code" note="em .mcp.json do projeto, ou ~/.claude.json" code={claudeSnippet} />
    <Snippet title="Codex" note="em ~/.codex/config.toml" code={codexSnippet} />
    <p className="bridge-warning">O agente externo herda o seu navegador logado. O modo de autonomia continua valendo: em <strong>Observar</strong> ele só lê, e em <strong>Assistir</strong> cada ação espera a sua aprovação no painel — com o painel fechado, a ação é recusada em vez de acontecer sem ninguém olhando.</p>
  </>;
}
