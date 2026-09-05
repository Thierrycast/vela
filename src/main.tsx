import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bot, CircleStop, ExternalLink, Globe2, Layers3, Menu, Paperclip, Plus, Send, Settings2 } from "lucide-react";
import { AgentEvent, ChatMessage } from "./types";
import { SidecarInbound, SidecarPort, VoiceState, connectSidecar } from "./messages";
import type { ApprovalRequest } from "./approvals";
import { useSettings, useTheme } from "./use-settings";
import { ActivityTimeline, AgentStatus, ApprovalCard, ContextChip, DeveloperDetails, DictationButton, LiveVoiceButton, TakeoverCard, VelaIcon, VelaOrb, VelaState } from "./vela-components";
import "./tokens.css";
import "./vela.css";
import "./motion.css";

type Takeover = { reason: string; expected: string };

function App() {
  const { settings, update } = useSettings();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [telemetry, setTelemetry] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(true);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [dictating, setDictating] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [takeover, setTakeover] = useState<Takeover | null>(null);
  const [session, setSession] = useState<{ title: string; tabCount: number }>({ title: "", tabCount: 0 });
  const [history, setHistory] = useState<Array<{ id: string; title: string; updatedAt: number }>>([]);
  const portRef = useRef<SidecarPort | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useTheme(settings);

  useEffect(() => {
    const apply = (message: SidecarInbound) => {
      if (message.type === "chat:snapshot") { setMessages(message.messages); setEvents(message.events); setTelemetry(message.telemetry); setRunning(message.running); }
      if (message.type === "chat:message") setMessages((current) => [...current, message.message]);
      if (message.type === "chat:delta") setMessages((current) => current.map((item) => item.id === message.id ? { ...item, content: item.content + message.text } : item));
      if (message.type === "chat:patch") setMessages((current) => current.map((item) => item.id === message.id ? { ...item, ...message.patch } : item));
      if (message.type === "chat:reset") { setMessages([]); setEvents([]); setTelemetry([]); setAttachments([]); }
      if (message.type === "chat:event") setEvents((current) => [...current.slice(-60), message.event]);
      if (message.type === "chat:telemetry") setTelemetry((current) => [...current.slice(-5), message.text]);
      if (message.type === "chat:running") setRunning(message.running);
      if (message.type === "chat:approval") setApproval(message.request);
      if (message.type === "chat:approval-closed") setApproval((current) => current?.id === message.id ? null : current);
      if (message.type === "chat:takeover") setTakeover({ reason: message.reason, expected: message.expected });
      if (message.type === "chat:takeover-closed") setTakeover(null);
      if (message.type === "chat:session") setSession({ title: message.title, tabCount: message.tabCount });
      if (message.type === "chat:history") setHistory(message.items);
      if (message.type === "voice:state") { setVoiceState(message.state); if (message.state === "idle") setDictating(false); }
      if (message.type === "voice:error") { setVoiceState("error"); setDictating(false); setEvents((current) => [...current, { kind: "error", text: message.message }]); }
      if (message.type === "voice:transcript") { setInput((current) => `${current}${current ? " " : ""}${message.text}`); composerRef.current?.focus(); }
      if (message.type === "chat:prefill") { setInput(message.text); composerRef.current?.focus(); }
      if (message.type === "chat:attachments") setAttachments(message.items);
    };
    portRef.current = connectSidecar(apply, () => { portRef.current = null; });
    return () => { portRef.current?.disconnect(); portRef.current = null; };
  }, []);

  useEffect(() => { streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" }); }, [messages.length, running, approval, takeover]);

  const activeProvider = useMemo(() => settings.providers.find((item) => item.id === settings.activeProviderId), [settings]);
  const configured = !!activeProvider?.apiKey && !!activeProvider?.defaultModel;
  const bubbles = useMemo(() => messages.filter((item) => item.role === "user" || (item.role === "assistant" && (item.content.length > 0 || item.status === "streaming"))), [messages]);

  const agentState: VelaState = takeover ? "waiting" : approval ? "paused" : running ? "thinking"
    : voiceState === "listening" ? "listening" : voiceState === "speaking" ? "speaking" : voiceState === "error" ? "error" : "idle";

  const post = (message: Parameters<SidecarPort["post"]>[0]) => portRef.current?.post(message);

  const submit = () => {
    const text = input.trim();
    if (!text || running) return;
    post({ type: "chat:submit", text });
    setInput("");
  };
  const newChat = () => { post({ type: "chat:new" }); setMenuOpen(false); };
  const openMenu = () => { const next = !menuOpen; setMenuOpen(next); if (next) post({ type: "chat:history-request" }); };
  const openOptions = () => { if (typeof chrome !== "undefined") chrome.runtime?.openOptionsPage?.(); };
  const toggleLive = () => {
    post({ type: voiceState === "idle" ? "voice:start-live" : "voice:stop-live" });
    setEvents((current) => [...current, { kind: "status", text: voiceState === "idle" ? "Iniciando Live Voice…" : "Live Voice encerrado." }]);
  };
  const toggleDictation = () => {
    if (dictating) { post({ type: "voice:stop-live" }); setDictating(false); return; }
    post({ type: "voice:start-dictation" });
    setDictating(true);
  };

  return <main className="app-shell">
    <header className="topbar">
      <button className="icon-button" aria-label="Menu" onClick={openMenu}><Menu size={18} /></button>
      <span className="brand-mark"><VelaIcon size={15} /></span>
      <input
        className="session-title"
        value={session.title || settings.brand.appName}
        title={session.tabCount ? `${session.tabCount} aba(s) nesta tarefa` : "Clique para renomear a tarefa"}
        readOnly={!session.title}
        onChange={(event) => setSession((current) => ({ ...current, title: event.target.value }))}
        onBlur={() => { if (session.title) post({ type: "session:rename", title: session.title }); }}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
      <AgentStatus state={agentState} />
      <div className="topbar-actions">
        <button className="icon-button" aria-label="Nova conversa" onClick={newChat}><Plus size={18} /></button>
        <button className="icon-button" aria-label="Configurações" onClick={openOptions}><Settings2 size={17} /></button>
      </div>
    </header>
    {menuOpen && <aside className="popover">
      <button onClick={newChat}><Plus size={15} /> Nova tarefa</button>
      <button onClick={openOptions}><Settings2 size={15} /> Configurações</button>
      {history.length > 1 && <>
        <span className="popover-label">Conversas recentes</span>
        {history.slice(0, 10).map((item) => <button key={item.id} className="popover-history" onClick={() => { post({ type: "chat:open", id: item.id }); setMenuOpen(false); }}>{item.title}</button>)}
      </>}
    </aside>}

    <section className="conversation" ref={streamRef}>
      {bubbles.length === 0
        ? <div className="welcome">
            <div className="welcome-mark"><VelaOrb state={agentState} size={28} /></div>
            <h1>Como posso ajudar?</h1>
            <p>{configured ? "Converse, pesquise e deixe o agente cuidar do navegador." : "Configure um provider nas opções para começar."}</p>
            <div className="suggestions">
              <button onClick={() => setInput("Leia esta página e me diga o que dá para fazer aqui")}><Bot size={15} /> Ler a página atual</button>
              <button onClick={() => setInput("Pesquise por ")}><ExternalLink size={15} /> Pesquisar na web</button>
            </div>
          </div>
        : <div className="message-list">{bubbles.map((message) => <article className={`message ${message.role}`} key={message.id}>
            {message.role === "assistant" && <span className="avatar"><VelaOrb state={message.status === "streaming" ? "thinking" : "idle"} size={16} /></span>}
            <div className="message-content">{message.content || <span className="vela-loader" aria-label="Vela processando" />}</div>
          </article>)}</div>}

      {takeover && <TakeoverCard reason={takeover.reason} expected={takeover.expected} onResume={() => { post({ type: "takeover:resume" }); setTakeover(null); }} />}
      {approval && <ApprovalCard summary={approval.summary} detail={approval.detail} onDecide={(decision) => { post({ type: "approval:resolve", id: approval.id, decision }); setApproval(null); }} />}

      <ActivityTimeline items={events.map((event) => event.text)} open={activityOpen} onToggle={() => setActivityOpen((value) => !value)} />
      {(telemetry.length > 0 || bubbles.length > 0) && <DeveloperDetails provider={activeProvider?.name} model={activeProvider?.defaultModel} telemetry={telemetry} />}
    </section>

    <footer className="composer-wrap">
      <div className="context-strip">
        {settings.context.currentPage && <ContextChip tone="active"><Globe2 size={12} /> Página atual</ContextChip>}
        {session.tabCount > 0 && settings.context.sessionTabs && <ContextChip><Layers3 size={12} /> {session.tabCount} aba{session.tabCount > 1 ? "s" : ""}</ContextChip>}
        {attachments.map((item, index) => <ContextChip key={`${index}-${item.slice(0, 12)}`} title={item} onRemove={() => setAttachments((current) => current.filter((_, position) => position !== index))}>
          <span>{`Trecho · ${item.replace(/\s+/g, " ").slice(0, 22)}…`}</span>
        </ContextChip>)}
      </div>
      <div className="composer">
        <textarea ref={composerRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="Diga à Vela o que fazer..." rows={1} />
        <div className="composer-bar">
          <button className="icon-button" aria-label="Adicionar contexto" title="Selecione texto numa página e use o menu da Vela"><Paperclip size={17} /></button>
          <DictationButton active={dictating} onClick={toggleDictation} disabled={!configured} />
          <LiveVoiceButton active={voiceState !== "idle" && !dictating} onClick={toggleLive} disabled={!configured} />
          <label className="autonomy-select">
            <span className="sr-only">Autonomia</span>
            <select value={settings.agent.autonomy} onChange={(event) => update((current) => ({ agent: { ...current.agent, autonomy: event.target.value as typeof current.agent.autonomy } }))}>
              <option value="observe">Observar</option>
              <option value="assist">Assistir</option>
              <option value="auto">Auto</option>
            </select>
          </label>
          <span className="provider-label" title={activeProvider?.defaultModel}><span className={`status-dot ${configured ? "" : "off"}`} />{activeProvider?.name ?? "Sem provider"}</span>
          <div className="composer-actions">
            {running
              ? <button className="send-button stop" onClick={() => post({ type: "chat:abort" })} aria-label="Parar"><CircleStop size={17} /></button>
              : <button className="send-button" onClick={submit} disabled={!input.trim()} aria-label="Enviar"><Send size={16} /></button>}
          </div>
        </div>
      </div>
      <p className="disclaimer">Vela pode cometer erros. Verifique ações importantes.</p>
    </footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
