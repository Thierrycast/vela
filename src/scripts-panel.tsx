import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileCode2, Play, Plus, Trash2 } from "lucide-react";
import { UserScript, deleteScript, listScripts, newScript, saveScript } from "./script-store";
import { describeTargets, parseMetadata } from "./user-script";

const relativeTime = (timestamp: number) => {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.round(hours / 24)} d`;
};

export function ScriptsPanel() {
  const [scripts, setScripts] = useState<UserScript[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => { void listScripts().then(setScripts); }, []);

  const open = scripts.find((script) => script.id === openId) ?? null;

  const persist = async (script: UserScript) => {
    const saved = { ...script, updatedAt: Date.now() };
    setScripts((current) => current.map((item) => item.id === saved.id ? saved : item));
    await saveScript(saved);
  };

  const create = async () => {
    const script = newScript();
    setScripts((current) => [...current, script]);
    await saveScript(script);
    setOpenId(script.id);
  };

  const remove = async (id: string) => {
    await deleteScript(id);
    setScripts((current) => current.filter((item) => item.id !== id));
    setOpenId(null);
  };

  /** Salva antes de executar: o autosave tem 500 ms de espera e rodar código velho seria mentira. */
  const run = async (script: UserScript) => {
    await persist(script);
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) { setStatus("Nenhuma aba ativa encontrada."); return; }
    const result = await chrome.runtime.sendMessage({ type: "script:run", scriptId: script.id, tabId: tab.id }) as { ok?: boolean; result?: Array<{ result?: string }>; error?: string };
    setStatus(result.ok ? `Executado: ${result.result?.[0]?.result ?? "sem retorno"}` : result.error ?? "Falha ao executar.");
  };

  if (open) return <ScriptEditor key={open.id} script={open} status={status} onBack={() => { setOpenId(null); setStatus(null); }} onChange={persist} onRun={run} onDelete={remove} />;

  return <>
    <h1>Scripts</h1>
    <p className="section-intro">Automatizações que rodam na aba atual quando você manda. A Vela pode criar e editar, mas nunca executa sozinha.</p>
    <div className="section-toolbar">
      <span>{scripts.length ? `${scripts.length} script(s)` : "Nenhum script ainda"}{status ? ` · ${status}` : ""}</span>
      <button className="secondary-button" onClick={() => void create()}><Plus size={14} /> Novo script</button>
    </div>

    {scripts.length === 0
      ? <div className="empty-scripts"><FileCode2 size={22} /><span>Peça à Vela para criar um, ou comece do zero.</span></div>
      : <div className="script-grid">
          {scripts.map((script) => {
            const meta = parseMetadata(script.code);
            return <button className="script-card" key={script.id} onClick={() => setOpenId(script.id)}>
              <div className="script-card-head">
                <strong>{meta.name}</strong>
                <span className={`script-state ${script.enabled ? "on" : ""}`}>{script.enabled ? "disponível" : "desativado"}</span>
              </div>
              <p>{meta.description || "Sem descrição."}</p>
              <div className="script-card-foot">
                <code>{describeTargets(meta.matches)}</code>
                <span>v{meta.version} · {relativeTime(script.updatedAt)}</span>
              </div>
            </button>;
          })}
        </div>}
  </>;
}

function ScriptEditor({ script, status, onBack, onChange, onRun, onDelete }: {
  script: UserScript;
  status: string | null;
  onBack: () => void;
  onChange: (script: UserScript) => Promise<void>;
  onRun: (script: UserScript) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [code, setCode] = useState(script.code);
  const [saved, setSaved] = useState(false);
  const gutterRef = useRef<HTMLDivElement>(null);
  const meta = useMemo(() => parseMetadata(code), [code]);
  const lines = useMemo(() => code.split("\n").length, [code]);

  useEffect(() => {
    if (code === script.code) return;
    const timer = setTimeout(() => { void onChange({ ...script, code }).then(() => { setSaved(true); setTimeout(() => setSaved(false), 1200); }); }, 500);
    return () => clearTimeout(timer);
  }, [code, script, onChange]);

  // Tab dentro do editor indenta, não pula para o próximo campo.
  const indentOnTab = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const area = event.currentTarget;
    const { selectionStart, selectionEnd, value } = area;
    area.value = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
    area.selectionStart = area.selectionEnd = selectionStart + 2;
    setCode(area.value);
  };

  return <div className="script-editor-screen">
    <div className="script-editor-head">
      <button className="secondary-button" onClick={onBack}><ArrowLeft size={14} /> Voltar</button>
      <div className="script-editor-title">
        <strong>{meta.name}</strong>
        <small>v{meta.version} · {describeTargets(meta.matches)} · {meta.runAt}</small>
      </div>
      <span className={`field-state ${saved ? "just-saved" : ""}`}>{saved ? "✓ salvo" : "salva automaticamente"}</span>
      <button className="icon-danger" onClick={() => void onDelete(script.id)} aria-label="Excluir script"><Trash2 size={15} /></button>
    </div>

    <div className="script-editor-bar">
      <span className="script-enabled">
        <button className={`toggle ${script.enabled ? "on" : ""}`} role="switch" aria-checked={script.enabled} aria-label="Disponível para execução" onClick={() => void onChange({ ...script, enabled: !script.enabled })}><span /></button>
        Disponível para execução
      </span>
      <button className="secondary-button" onClick={() => void onRun({ ...script, code })} disabled={!script.enabled}><Play size={13} /> Executar na aba atual</button>
    </div>

    {meta.description && <p className="script-editor-description">{meta.description}</p>}
    {status && <p className="script-editor-status">{status}</p>}

    <div className="code-area">
      <div className="code-gutter" ref={gutterRef}>{Array.from({ length: lines }, (_, index) => <span key={index}>{index + 1}</span>)}</div>
      <textarea
        value={code}
        spellCheck={false}
        onChange={(event) => setCode(event.target.value)}
        onKeyDown={indentOnTab}
        onScroll={(event) => { if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop; }}
      />
    </div>
    <p className="script-editor-hint">O cabeçalho <code>==UserScript==</code> define nome, descrição e onde o script pode rodar — o mesmo formato do Tampermonkey.</p>
  </div>;
}
