import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FileText, Layers, Menu, Paperclip, Plus, Search, Send, Settings2, Square, WifiOff } from "lucide-react";
import { AgentEvent, ChatMessage } from "./types";
import { SidecarInbound, SidecarPort, VoiceState, connectSidecar } from "./messages";
import type { ApprovalRequest } from "./approvals";
import { useSettings, useTheme } from "./use-settings";
import { ActivityTimeline, AgentStatus, AmbientEdge, ApprovalCard, ContextChip, DeveloperDetails, DictationButton, LiveVoiceButton, TakeoverCard, VelaOrb, VelaState } from "./vela-components";
import { AssistantActions, MessageEditor, UserActions } from "./message-actions";
import { Markdown } from "./markdown";
import { VelaMark } from "./vela-mark";
import { Select } from "./select";
import { playAttentionChime } from "./chime";
import "./tokens.css";
import "./vela.css";
import "./motion.css";

type Takeover = { reason: string; expected: string };

/** Uma escala só para todo ícone do painel — a espessura vem do CSS, em `.app-shell svg`. */
const ICON = { action: 17, inline: 14, chip: 13 } as const;
const ATTACHMENT_LIMIT = 20_000;

const AUTONOMY_OPTIONS = [
  { value: "observe" as const, label: "Observar", hint: "só lê, nunca age" },
  { value: "assist" as const, label: "Assistir", hint: "pede aprovação" },
  { value: "auto" as const, label: "Auto", hint: "age sozinha" },
];

/** O anexo guarda `<cabeçalho>:\n<texto>`; o chip mostra só o começo do texto. */
const attachmentPreview = (item: string) => {
  const lineBreak = item.indexOf("\n");
  const text = (lineBreak >= 0 ? item.slice(lineBreak + 1) : item).replace(/\s+/g, " ").trim();
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
};

function App() {
  const { settings, update } = useSettings();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [telemetry, setTelemetry] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(true);
  const [input, setInput] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuLeaving, setMenuLeaving] = useState(false);
  const [activityOpen, setActivityOpen] = useState(true);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [dictating, setDictating] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [takeover, setTakeover] = useState<Takeover | null>(null);
  const [session, setSession] = useState<{ title: string; tabCount: number }>({ title: "", tabCount: 0 });
  const [history, setHistory] = useState<Array<{ id: string; title: string; updatedAt: number }>>([]);
  const portRef = useRef<SidecarPort | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLElement>(null);

  useTheme(settings);

  /** Fechar com animação exige manter montado até o fim dela; por isso o estado de saída. */
  const closeMenu = useCallback(() => {
    setMenuLeaving(true);
    setTimeout(() => { setMenuOpen(false); setMenuLeaving(false); }, 130);
  }, []);

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
      if (message.type === "chat:approval") { setApproval(message.request); playAttentionChime("approval"); }
      if (message.type === "chat:approval-closed") setApproval((current) => current?.id === message.id ? null : current);
      if (message.type === "chat:takeover") { setTakeover({ reason: message.reason, expected: message.expected }); playAttentionChime("takeover"); }
      if (message.type === "chat:takeover-closed") setTakeover(null);
      if (message.type === "chat:session") setSession({ title: message.title, tabCount: message.tabCount });
      if (message.type === "chat:history") setHistory(message.items);
      if (message.type === "chat:speaking" && !message.speaking) setSpeakingId(null);
      if (message.type === "voice:state") { setVoiceState(message.state); if (message.state === "idle") { setDictating(false); setSpeakingId(null); } }
      if (message.type === "voice:error") { setVoiceState("error"); setDictating(false); setSpeakingId(null); setEvents((current) => [...current, { kind: "error", text: message.message }]); }
      if (message.type === "voice:transcript") { setInput((current) => `${current}${current ? " " : ""}${message.text}`); composerRef.current?.focus(); }
      if (message.type === "chat:prefill") { setInput(message.text); composerRef.current?.focus(); }
      if (message.type === "chat:attachments") setAttachments(message.items);
    };
    portRef.current = connectSidecar(apply, setConnected);
    return () => { portRef.current?.disconnect(); portRef.current = null; };
  }, []);

  // Popover fecha ao clicar fora e no Escape — comportamento esperado de qualquer menu.
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.("[aria-label='Menu']")) return;
      closeMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") closeMenu(); };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOnOutside); document.removeEventListener("keydown", closeOnEscape); };
  }, [menuOpen, closeMenu]);

  useEffect(() => { streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" }); }, [messages.length, running, approval, takeover]);

  const activeProvider = useMemo(() => settings.providers.find((item) => item.id === settings.activeProviderId), [settings]);
  const configured = !!activeProvider?.apiKey && !!activeProvider?.defaultModel;
  // Voz e chat falam com servidores diferentes: exigir a chave do chat para gravar deixava os
  // botões desabilitados sem explicação — e o pedido de permissão do microfone nunca acontecia.
  const voiceReady = !!settings.voice.baseUrl.trim();
  const bubbles = useMemo(() => messages.filter((item) => item.role === "user" || (item.role === "assistant" && (item.content.length > 0 || item.status === "streaming"))), [messages]);
  const lastAssistantId = useMemo(() => [...bubbles].reverse().find((item) => item.role === "assistant")?.id ?? null, [bubbles]);

  const agentState: VelaState = takeover ? "waiting" : approval ? "paused" : running ? "thinking"
    : voiceState === "listening" ? "listening" : voiceState === "speaking" ? "speaking" : voiceState === "error" ? "error" : "idle";

  const post = (message: Parameters<SidecarPort["post"]>[0]) => portRef.current?.post(message) ?? false;

  const submit = () => {
    const text = input.trim();
    if (!text || running) return;
    // Só limpa o campo se a mensagem realmente saiu: com a porta caída, apagar seria perder o texto.
    if (post({ type: "chat:submit", text })) setInput("");
  };
  const newChat = () => { post({ type: "chat:new" }); closeMenu(); };
  const openMenu = () => {
    if (menuOpen) { closeMenu(); return; }
    setMenuLeaving(false);
    setMenuOpen(true);
    post({ type: "chat:history-request" });
  };
  const openOptions = () => { if (typeof chrome !== "undefined") chrome.runtime?.openOptionsPage?.(); };

  const toggleLive = () => {
    const starting = voiceState === "idle";
    post({ type: starting ? "voice:start-live" : "voice:stop-live" });
    setEvents((current) => {
      const text = starting ? "Iniciando Live Voice…" : "Live Voice encerrado.";
      return current.at(-1)?.text === text ? current : [...current, { kind: "status", text }];
    });
  };
  const toggleDictation = () => {
    if (dictating) { post({ type: "voice:stop-live" }); setDictating(false); return; }
    post({ type: "voice:start-dictation" });
    setDictating(true);
  };

  const speak = (message: ChatMessage) => {
    if (speakingId === message.id) { post({ type: "chat:speak-stop" }); setSpeakingId(null); return; }
    if (post({ type: "chat:speak", text: message.content })) setSpeakingId(message.id);
  };

  /** Editar, reenviar e gerar outra resposta são a mesma operação: a linha do tempo volta a um
   *  ponto e segue de lá. Anexar correções ao fim confundiria o modelo e o histórico. */
  const rewind = (id: string, text?: string) => { post({ type: "chat:rewind", id, text }); setEditingId(null); };
  const regenerate = (assistantId: string) => post({ type: "chat:rewind", id: assistantId });

  const attachFile = async (file: File) => {
    const text = (await file.text()).slice(0, ATTACHMENT_LIMIT);
    if (!text.trim()) { setEvents((current) => [...current, { kind: "error", text: `“${file.name}” não tem texto legível.` }]); return; }
    post({ type: "chat:attach", name: file.name, text });
  };

  return <main className="app-shell">
    <AmbientEdge state={agentState} />
    <header className="topbar">
      <button className="icon-button" aria-label="Menu" onClick={openMenu}><Menu size={ICON.action} /></button>
      <span className="brand-mark"><VelaMark size={ICON.action} /></span>
      <input
        className="session-title"
        value={session.title || settings.brand.appName}
        title={session.tabCount ? `${session.tabCount} aba(s) nesta tarefa` : "Clique para renomear a tarefa"}
        readOnly={!session.title}
        onChange={(event) => setSession((current) => ({ ...current, title: event.target.value }))}
        onBlur={() => { if (session.title) post({ type: "session:rename", title: session.title }); }}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
      {agentState !== "idle" && <AgentStatus state={agentState} />}
      <div className="topbar-actions">
        <button className="icon-button" aria-label="Nova conversa" onClick={newChat}><Plus size={ICON.action} /></button>
        <button className="icon-button" aria-label="Configurações" onClick={openOptions}><Settings2 size={ICON.action} /></button>
      </div>
    </header>
    {!connected && <div className="offline-banner"><WifiOff size={ICON.chip} /> Reconectando ao agente…</div>}
    {menuOpen && <aside className={`popover ${menuLeaving ? "leaving" : ""}`} ref={menuRef}>
      <span className="popover-label">Conversas recentes</span>
      {history.length > 0
        ? history.slice(0, 10).map((item) => <button key={item.id} className="popover-history" onClick={() => { post({ type: "chat:open", id: item.id }); closeMenu(); }}>{item.title}</button>)
        : <p className="popover-empty">Nenhuma tarefa anterior ainda.</p>}
    </aside>}

    <section className="conversation" ref={streamRef}>
      {bubbles.length === 0
        ? <div className="welcome">
            <div className="welcome-mark"><VelaOrb state={agentState} size={64} visual={settings.voice.visual} /></div>
            <h1>Como posso ajudar?</h1>
            <p>{configured ? "Converse, pesquise e deixe o agente cuidar do navegador." : "Configure um provider nas opções para começar."}</p>
            <div className="suggestions">
              <button onClick={() => setInput("Leia esta página e me diga o que dá para fazer aqui")}><FileText size={ICON.inline} /> Ler a página atual</button>
              <button onClick={() => setInput("Pesquise por ")}><Search size={ICON.inline} /> Pesquisar na web</button>
            </div>
          </div>
        : <div className="message-list">{bubbles.map((message) => <article className={`message ${message.role}`} key={message.id}>
            {message.role === "assistant" && <span className="avatar"><VelaOrb state={message.status === "streaming" ? "thinking" : "idle"} size={16} /></span>}
            {editingId === message.id
              ? <MessageEditor value={message.content} onCancel={() => setEditingId(null)} onSubmit={(text) => rewind(message.id, text)} />
              : <div className="message-body">
                  <div className="message-content">
                    {message.content
                      ? (message.role === "assistant" ? <Markdown text={message.content} /> : message.content)
                      : <span className="vela-loader" aria-label="Vela processando" />}
                  </div>
                  {message.content && message.status !== "streaming" && (message.role === "assistant"
                    ? <AssistantActions text={message.content} speaking={speakingId === message.id} onSpeak={() => speak(message)} onRegenerate={message.id === lastAssistantId && !running ? () => regenerate(message.id) : undefined} />
                    : <UserActions text={message.content} onEdit={() => setEditingId(message.id)} onResend={() => rewind(message.id)} />)}
                </div>}
          </article>)}</div>}

      {takeover && <TakeoverCard reason={takeover.reason} expected={takeover.expected} onResume={() => { post({ type: "takeover:resume" }); setTakeover(null); }} />}
      {approval && <ApprovalCard summary={approval.summary} detail={approval.detail} onDecide={(decision) => { post({ type: "approval:resolve", id: approval.id, decision }); setApproval(null); }} />}

      <ActivityTimeline items={events.map((event) => event.text)} open={activityOpen} onToggle={() => setActivityOpen((value) => !value)} />
      {(telemetry.length > 0 || bubbles.length > 0) && <DeveloperDetails provider={activeProvider?.name} model={activeProvider?.defaultModel} telemetry={telemetry} />}
    </section>

    <footer className="composer-wrap">
      <div className="context-strip">
        {settings.context.currentPage && <ContextChip tone="active"><VelaMark size={ICON.chip} /> Página atual</ContextChip>}
        {session.tabCount > 0 && settings.context.sessionTabs && <ContextChip><Layers size={ICON.chip} /> {session.tabCount} aba{session.tabCount > 1 ? "s" : ""}</ContextChip>}
        {attachments.map((item, index) => <ContextChip key={`${index}-${item.slice(0, 12)}`} title={item} onRemove={() => post({ type: "chat:detach", index })}>
          <span>{`Trecho · ${attachmentPreview(item)}`}</span>
        </ContextChip>)}
      </div>
      <div className="composer">
        <textarea ref={composerRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="Diga à Vela o que fazer..." rows={1} />
        <div className="composer-bar">
          <button className="icon-button" aria-label="Anexar arquivo de texto" title="Anexar arquivo de texto (.md, .txt, .json, .csv)" onClick={() => fileRef.current?.click()}><Paperclip size={ICON.action} /></button>
          <input ref={fileRef} type="file" hidden accept=".txt,.md,.markdown,.json,.csv,.log,.yml,.yaml,text/*"
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void attachFile(file); }} />
          <DictationButton active={dictating} onClick={toggleDictation} disabled={!voiceReady} />
          <LiveVoiceButton active={voiceState !== "idle" && !dictating} onClick={toggleLive} disabled={!voiceReady} />
          <Select compact label="Autonomia" value={settings.agent.autonomy} options={AUTONOMY_OPTIONS}
            onChange={(autonomy) => update((current) => ({ agent: { ...current.agent, autonomy } }))} />
          <button className="model-label" onClick={openOptions} title={configured ? `${activeProvider?.name} · ${activeProvider?.defaultModel} — clique para trocar` : "Configure um provider nas opções"}>
            <span className={`status-dot ${configured ? "" : "off"}`} />{activeProvider?.defaultModel || "sem modelo"}
          </button>
          <div className="composer-actions">
            {running
              ? <button className="send-button stop" onClick={() => post({ type: "chat:abort" })} aria-label="Parar"><Square size={13} fill="currentColor" /></button>
              : <button className="send-button" onClick={submit} disabled={!input.trim()} aria-label="Enviar"><Send size={ICON.inline} /></button>}
          </div>
        </div>
      </div>
    </footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
