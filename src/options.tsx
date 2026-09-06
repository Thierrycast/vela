import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, FileCode2, KeyRound, Palette, Plug, Plus, RefreshCw, Shield, SlidersHorizontal, Trash2, Wifi } from "lucide-react";
import { createRoot } from "react-dom/client";
import { defaultSettings, ProviderProfile, ThemeMode } from "./types";
import { loadConversations } from "./storage";
import { useSettings, useTheme } from "./use-settings";
import { ConnectionCheck, listModels, probeAudioEndpoints, testConnection } from "./provider";
import { VelaMark } from "./vela-mark";
import { Select } from "./select";
import { ScriptsPanel } from "./scripts-panel";
import { AdvancedPanel } from "./advanced-panel";
import { BridgePanel } from "./bridge-panel";
import "./tokens.css";
import "./vela-options.css";

const PERMISSION_LABELS: Record<string, string> = {
  tabs: "Ver título e URL das abas.",
  scripting: "Injetar o leitor de página quando precisa agir.",
  webNavigation: "Saber quando uma página terminou de carregar.",
  tabGroups: "Agrupar as abas de uma tarefa.",
  offscreen: "Manter o runtime de voz vivo com o painel fechado.",
  notifications: "Avisar quando algo falha em segundo plano.",
  storage: "Guardar conversas e configurações neste perfil.",
};

const sections = ["Geral", "Aparência", "Agente", "Navegador", "Contexto", "Voz", "Providers", "Scripts", "Ponte MCP", "Permissões", "Atalhos", "Avançado"] as const;
type Section = typeof sections[number];

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) { return <div className="setting-row"><div><strong>{label}</strong>{description && <small>{description}</small>}</div><div className="setting-control">{children}</div></div>; }
function ConnectionLed({ check, hasKey }: { check: ConnectionCheck | "testing" | undefined; hasKey: boolean }) {
  const state = !hasKey ? "empty" : check === "testing" ? "testing" : check === undefined ? "empty" : check.ok ? "ok" : "error";
  const label = { empty: "Sem chave configurada", testing: "Testando conexão…", ok: "Conectado", error: "Falha na conexão" }[state];
  return <span className={`connection-led led-${state}`} title={label}><i />{label}</span>;
}

function ConnectionDetail({ check }: { check: ConnectionCheck | "testing" | undefined }) {
  if (!check || check === "testing") return null;
  return <small className={check.ok ? "probe-ok" : "probe-off"}>{check.detail}</small>;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) { return <button className={`toggle ${checked ? "on" : ""}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span /></button>; }

function Options() {
  const { settings, update, saved } = useSettings(420);
  const [section, setSection] = useState<Section>("Aparência");
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [loadingModels, setLoadingModels] = useState<string | null>(null);
  const [conversationCount, setConversationCount] = useState(0);
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [shortcut, setShortcut] = useState<string>("");
  const [probe, setProbe] = useState<Record<string, { rotulo: string; ok: boolean }> | null>(null);
  const [probing, setProbing] = useState(false);
  const [connection, setConnection] = useState<Record<string, ConnectionCheck | "testing">>({});
  const tested = useRef(new Set<string>());
  useEffect(() => {
    void loadConversations().then((list) => setConversationCount(list.length));
    if (typeof chrome !== "undefined") {
      void chrome.permissions?.getAll?.().then((granted) => setPermissions(granted.permissions ?? [])).catch(() => setPermissions(null));
      void chrome.commands?.getAll?.().then((commands) => setShortcut(commands.find((item) => item.name === "toggle-side-panel")?.shortcut || ""));
    }
  }, []);
  useTheme(settings);
  const updateProvider = (id: string, patch: Partial<ProviderProfile>) => update((current) => ({ providers: current.providers.map((provider) => provider.id === id ? { ...provider, ...patch } : provider) }));
  const addProvider = () => { const provider: ProviderProfile = { ...defaultSettings.providers[0], id: `provider-${Date.now()}`, name: "Novo provider", baseUrl: "", protocol: "openai-compatible", apiKey: "", defaultModel: "" }; update((current) => ({ providers: [...current.providers, provider], activeProviderId: provider.id })); };
  const refreshModels = async (provider: ProviderProfile) => { setLoadingModels(provider.id); try { const result = await listModels(provider); const ids = result.map((model) => model.id); setModels((current) => ({ ...current, [provider.id]: ids })); if (!provider.defaultModel && ids[0]) updateProvider(provider.id, { defaultModel: ids[0] }); } catch { setModels((current) => ({ ...current, [provider.id]: [] })); } finally { setLoadingModels(null); } };
  const checkConnection = async (provider: ProviderProfile) => {
    setConnection((current) => ({ ...current, [provider.id]: "testing" }));
    const result = await testConnection(provider);
    setConnection((current) => ({ ...current, [provider.id]: result }));
    if (result.models) void listModels(provider).then((list) => setModels((current) => ({ ...current, [provider.id]: list.map((model) => model.id) }))).catch(() => undefined);
  };

  useEffect(() => {
    if (section !== "Providers") return;
    for (const provider of settings.providers) {
      const fingerprint = `${provider.id}:${provider.baseUrl}:${provider.apiKey.slice(-6)}`;
      if (!provider.apiKey || tested.current.has(fingerprint)) continue;
      tested.current.add(fingerprint);
      void checkConnection(provider);
    }
  }, [section, settings.providers]);

  const runProbe = async (provider: ProviderProfile) => {
    setProbing(true);
    try {
      const status = await probeAudioEndpoints(provider);
      const label = (code: number) => {
        if (code === 0) return { rotulo: "inalcançável", ok: false };
        if (code === 404 || code === 405) return { rotulo: "não existe neste gateway", ok: false };
        if (code === 401 || code === 403) return { rotulo: "existe — falta credencial", ok: false };
        if (code === 400 || code === 422) return { rotulo: "existe e responde", ok: true };
        return { rotulo: `existe (HTTP ${code})`, ok: true };
      };
      setProbe(Object.fromEntries(Object.entries(status).map(([path, code]) => [path, label(code)])));
      const exists = (code: number) => code !== 0 && code !== 404 && code !== 405;
      updateProvider(provider.id, { capabilities: { ...provider.capabilities, webFetch: exists(status["web/fetch"] ?? 0), audio: exists(status["audio/transcriptions"] ?? 0) } });
    } finally { setProbing(false); }
  };
  const activeProvider = useMemo(() => settings.providers.find((provider) => provider.id === settings.activeProviderId), [settings]);
  const content = (() => {
    if (section === "Geral") return <><h1>Geral</h1><p className="section-intro">Identidade e estado deste perfil da Vela.</p><div className="settings-group"><Row label="Nome do produto" description="Aparece na topbar e nas notificações."><input value={settings.brand.appName} onChange={(event) => update({ brand: { ...settings.brand, appName: event.target.value } })} /></Row><Row label="Versão"><span className="status-badge">{typeof chrome !== "undefined" ? chrome.runtime?.getManifest?.()?.version ?? "—" : "—"}</span></Row><Row label="Provider ativo"><span className="status-badge">{activeProvider?.name ?? "nenhum"}</span></Row><Row label="Conversas guardadas" description="O histórico fica só neste perfil do navegador."><span className="status-badge">{conversationCount ? `${conversationCount} conversa(s)` : "nenhuma ainda"}</span></Row></div></>;
    if (section === "Navegador") return <><h1>Navegador</h1><p className="section-intro">Onde a Vela fica presente e como ela organiza as abas de uma tarefa.</p><div className="settings-group"><Row label="Presença em todas as páginas" description="Ligado, o menu de seleção fica disponível em qualquer site. Desligado, a Vela só entra na aba quando você pede uma tarefa."><Toggle checked={settings.context.selection} onChange={(value) => update({ context: { ...settings.context, selection: value } })} /></Row><Row label="Abas da tarefa" description="Abas abertas pela Vela entram num grupo do Chrome com o nome da tarefa."><Toggle checked={settings.context.sessionTabs} onChange={(value) => update({ context: { ...settings.context, sessionTabs: value } })} /></Row><Row label="Abas fora da tarefa" description="Deixa a Vela enxergar também abas que você abriu."><Toggle checked={settings.context.outsideTabs} onChange={(value) => update({ context: { ...settings.context, outsideTabs: value } })} /></Row></div></>;
    if (section === "Permissões") return <><h1>Permissões</h1><p className="section-intro">O que a Vela pode fazer no navegador. Concedidas na instalação.</p><div className="settings-group">{["tabs", "scripting", "webNavigation", "tabGroups", "offscreen", "notifications", "storage"].map((name) => <Row key={name} label={name} description={PERMISSION_LABELS[name]}><span className={`connection-led led-${permissions === null ? "empty" : permissions.includes(name) ? "ok" : "error"}`}><i />{permissions === null ? "—" : permissions.includes(name) ? "concedida" : "ausente"}</span></Row>)}<Row label="debugger" description="Necessária para cliques indistinguíveis de humanos. O Chrome não aceita pedi-la depois da instalação: ou vem no manifest desde o começo, com aviso no diálogo, ou não existe."><span className="connection-led led-empty"><i />não declarada</span></Row></div></>;
    if (section === "Atalhos") return <><h1>Atalhos</h1><p className="section-intro">O Chrome é quem guarda os atalhos de extensão.</p><div className="settings-group"><Row label="Abrir a Vela"><span className="status-badge">{shortcut || "sem atalho definido"}</span></Row><Row label="Alterar" description="Abre a tela de atalhos do Chrome, onde a troca é feita."><button className="secondary-button" onClick={() => void chrome.tabs?.create({ url: "chrome://extensions/shortcuts" })}>Abrir atalhos do Chrome</button></Row></div></>;
    if (section === "Aparência") return <><h1>Aparência</h1><p className="section-intro">A identidade Vela permanece discreta; o sinal aparece quando o agente está presente.</p><div className="settings-group"><Row label="Tema" description="Escolha como a interface deve aparecer."><Select value={settings.theme} label="Tema" options={[{ value: "system" as ThemeMode, label: "Seguir sistema" }, { value: "dark" as ThemeMode, label: "Escuro" }, { value: "light" as ThemeMode, label: "Claro" }]} onChange={(theme) => update({ theme })} /></Row><Row label="Nome do produto"><input value={settings.brand.appName} onChange={(event) => update({ brand: { ...settings.brand, appName: event.target.value } })} /></Row><Row label="Cor de sinal" description="Usada para foco, voz e controle do navegador."><span className="color-control"><input type="color" value={settings.brand.accentColor || "#58d8cd"} onChange={(event) => update({ brand: { ...settings.brand, accentColor: event.target.value } })} /><code>{settings.brand.accentColor || "automático"}</code>{settings.brand.accentColor && <button className="secondary-button" onClick={() => update({ brand: { ...settings.brand, accentColor: "" } })}>Restaurar</button>}</span></Row></div></>;
    if (section === "Agente") return <><h1>Agente</h1><p className="section-intro">Defina quanto controle a Vela pode exercer e quais sinais visuais deseja ver.</p><div className="settings-group"><Row label="Autonomia"><Select value={settings.agent.autonomy} label="Autonomia" options={[{ value: "observe" as const, label: "Observar", hint: "só lê, nunca age" }, { value: "assist" as const, label: "Assistir", hint: "pede aprovação" }, { value: "auto" as const, label: "Auto", hint: "age sozinha" }]} onChange={(autonomy) => update({ agent: { ...settings.agent, autonomy } })} /></Row><Row label="Cursor da Vela" description="O cursor viaja até o alvo e a ação dispara na chegada."><Toggle checked={settings.agent.showCursor} onChange={(value) => update({ agent: { ...settings.agent, showCursor: value } })} /></Row><Row label="Velocidade do cursor" description="Instantâneo não espera o trajeto."><Select value={settings.agent.cursorSpeed} label="Velocidade do cursor" options={[{ value: "natural" as const, label: "Natural", hint: "até 450 ms de trajeto" }, { value: "fast" as const, label: "Rápido", hint: "até 220 ms" }, { value: "instant" as const, label: "Instantâneo", hint: "sem espera" }]} onChange={(cursorSpeed) => update({ agent: { ...settings.agent, cursorSpeed } })} /></Row><Row label="Borda de controle"><Toggle checked={settings.agent.showControlBorder} onChange={(value) => update({ agent: { ...settings.agent, showControlBorder: value } })} /></Row><Row label="Destaque de alvo"><Toggle checked={settings.agent.showTargetHighlights} onChange={(value) => update({ agent: { ...settings.agent, showTargetHighlights: value } })} /></Row></div></>;
    if (section === "Contexto") return <><h1>Contexto</h1><p className="section-intro">Escolha o que a Vela pode usar na tarefa atual.</p><div className="settings-group"><Row label="Página atual" description="URL, título e conteúdo relevante."><Toggle checked={settings.context.currentPage} onChange={(value) => update({ context: { ...settings.context, currentPage: value } })} /></Row><Row label="Texto selecionado"><Toggle checked={settings.context.selection} onChange={(value) => update({ context: { ...settings.context, selection: value } })} /></Row><Row label="Abas da sessão"><Toggle checked={settings.context.sessionTabs} onChange={(value) => update({ context: { ...settings.context, sessionTabs: value } })} /></Row><Row label="Abas fora da sessão"><Toggle checked={settings.context.outsideTabs} onChange={(value) => update({ context: { ...settings.context, outsideTabs: value } })} /></Row></div></>;
    if (section === "Voz") return <><h1>Voz</h1><p className="section-intro">Live Voice continua no documento offscreen mesmo quando a sidebar fecha. Configure os modelos de áudio encaminhados pelo OmniRoute.</p><div className="settings-group"><Row label="Modelo de transcrição" description="Endpoint /api/v1/audio/transcriptions."><input className="mono" value={settings.voice.transcriptionModel} onChange={(event) => update({ voice: { ...settings.voice, transcriptionModel: event.target.value } })} /></Row><Row label="Modelo de fala" description="Endpoint /api/v1/audio/speech."><input className="mono" value={settings.voice.speechModel} onChange={(event) => update({ voice: { ...settings.voice, speechModel: event.target.value } })} /></Row><Row label="Voz"><input value={settings.voice.speechVoice} onChange={(event) => update({ voice: { ...settings.voice, speechVoice: event.target.value } })} /></Row><Row label="Runtime"><span className="status-badge">Offscreen ativo</span></Row></div></>;
    if (section === "Providers") return <><h1>Providers</h1><p className="section-intro">Configuração técnica da conexão. As chaves ficam no armazenamento local deste perfil.</p><div className="provider-toolbar"><span>{settings.providers.length} provider(s)</span><button className="secondary-button" onClick={addProvider}><Plus size={14} /> Adicionar</button></div>{settings.providers.map((provider) => <div className="provider-section" key={provider.id}><div className="provider-section-head"><label className="provider-radio"><input type="radio" checked={activeProvider?.id === provider.id} onChange={() => update({ activeProviderId: provider.id })} /><strong>{provider.name}</strong><ConnectionLed check={connection[provider.id]} hasKey={!!provider.apiKey} /></label>{provider.id !== "omniroute" && <button className="icon-danger" onClick={() => update({ providers: settings.providers.filter((item) => item.id !== provider.id) })} aria-label="Remover provider"><Trash2 size={15} /></button>}</div><div className="settings-grid"><label>Nome<input value={provider.name} onChange={(event) => updateProvider(provider.id, { name: event.target.value })} /></label><label>Base URL<input className="mono" value={provider.baseUrl} onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })} /></label><label>Protocolo<Select value={provider.protocol} label="Protocolo" options={[{ value: "omnirouter" as const, label: "OmniRoute" }, { value: "openai-compatible" as const, label: "OpenAI-compatible" }, { value: "custom" as const, label: "Custom" }]} onChange={(protocol) => updateProvider(provider.id, { protocol })} /></label><label><span><KeyRound size={12} /> Chave de API {provider.apiKey && <em className={`field-state ${saved ? "just-saved" : ""}`}>{saved ? "✓ salva" : "salva automaticamente"}</em>}</span><div className="model-inline"><input type="password" value={provider.apiKey} placeholder="cole a chave aqui" onChange={(event) => updateProvider(provider.id, { apiKey: event.target.value })} /><button className="secondary-button" onClick={() => void checkConnection(provider)} disabled={connection[provider.id] === "testing" || !provider.apiKey}>{connection[provider.id] === "testing" ? "Testando…" : "Testar"}</button></div><ConnectionDetail check={connection[provider.id]} /></label><label>Modelo padrão<div className="model-inline"><input className="mono" list={`models-${provider.id}`} value={provider.defaultModel} onChange={(event) => updateProvider(provider.id, { defaultModel: event.target.value })} /><button className="secondary-button" onClick={() => void refreshModels(provider)} disabled={loadingModels === provider.id}><RefreshCw size={13} />{loadingModels === provider.id ? "..." : "Modelos"}</button></div><datalist id={`models-${provider.id}`}>{(models[provider.id] ?? []).map((model) => <option value={model} key={model} />)}</datalist>{models[provider.id]?.length ? <small>{models[provider.id].length} modelos encontrados</small> : null}</label></div><div className="settings-group"><Row label="Diagnóstico" description="Descobre quais endpoints este gateway realmente expõe. Habilita web_fetch e voz."><button className="secondary-button" onClick={() => void runProbe(provider)} disabled={probing || !provider.apiKey}>{probing ? "Sondando…" : "Sondar endpoints"}</button></Row>{probe && <div className="probe-table">{Object.entries(probe).map(([path, status]) => <div key={path}><code>{path}</code><span className={status.ok ? "probe-ok" : "probe-off"}><i /> {status.rotulo}</span></div>)}</div>}</div></div>)}</>;
    if (section === "Scripts") return <ScriptsPanel />;
    if (section === "Ponte MCP") return <BridgePanel settings={settings} update={update} />;
    if (section === "Avançado") return <AdvancedPanel settings={settings} update={update} />;
    return <><h1>{section}</h1><p className="section-intro">Esta área está preparada para a próxima etapa da Vela.</p><div className="settings-group"><Row label="Estado"><span className="status-badge pending">Em preparação</span></Row></div></>;
  })();
  return <main className="vela-options"><header className="options-topbar"><div className="settings-brand"><span className="vela-mini-mark"><VelaMark size={17} /></span><div><strong>{settings.brand.appName}</strong><small>Preferências</small></div></div><span className={`saved-indicator ${saved ? "visible" : ""}`}><Check size={14} /> Salvo</span></header><div className="settings-layout"><nav className="settings-nav" aria-label="Seções de configurações">{sections.map((item) => <button className={section === item ? "active" : ""} onClick={() => setSection(item)} key={item}><span>{item === "Aparência" ? <Palette size={15} /> : item === "Providers" ? <Wifi size={15} /> : item === "Scripts" ? <FileCode2 size={15} /> : item === "Ponte MCP" ? <Plug size={15} /> : item === "Permissões" ? <Shield size={15} /> : item === "Avançado" ? <SlidersHorizontal size={15} /> : <ChevronRight size={15} />}</span>{item}</button>)}</nav><section className="settings-main">{content}</section></div></main>;
}
createRoot(document.getElementById("root")!).render(<Options />);
