import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Download, FileText, Flag, Package, Pause, Play, Trash2, Volume2 } from "lucide-react";
import { TraceEvent, TraceKind, toJsonl } from "./trace";
import { relatorioCompleto, relatorioDeUmTurno } from "./trace-report";
import { readBlob } from "./trace-blobs";
import { baixarArquivo, carimbo, montarPacote } from "./trace-package";
import { useTheme } from "./use-settings";
import { defaultSettings } from "./types";
import "./tokens.css";
import "./debug.css";

const KINDS: TraceKind[] = ["turn", "user.input", "model.prompt", "model.request", "model.response", "model.text", "tool.call", "model.tool", "action", "page.read", "navigation", "voice", "bridge", "ui", "error"];

const COLOR: Partial<Record<TraceKind, string>> = {
  turn: "roxo", "user.input": "azul", "model.request": "violeta", "model.prompt": "violeta",
  "model.response": "violeta", "tool.call": "ciano", "model.tool": "ciano",
  action: "ambar", "page.read": "verde", navigation: "verde", voice: "azul", bridge: "ciano", error: "vermelho",
};

const baixar = (nome: string, conteudo: string, tipo: string) => baixarArquivo(nome, conteudo, tipo);

const relative = (at: number, base: number) => {
  const delta = at - base;
  if (delta < 1000) return `+${delta}ms`;
  return `+${(delta / 1000).toFixed(1)}s`;
};

/**
 * Visor da trilha em tempo real.
 *
 * Existe porque `console.log` não serve para depurar um agente: o que interessa não é uma linha
 * solta, é a sequência — quanto o modelo demorou até o primeiro token, qual ação não surtiu
 * efeito, quantas rodadas o turno gastou. Aqui a leitura é por turno, com duração ao lado.
 */
function DebugPanel() {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [live, setLive] = useState(true);
  const [kinds, setKinds] = useState<Set<TraceKind>>(new Set());
  const [search, setSearch] = useState("");
  const [onlyFailures, setOnlyFailures] = useState(false);
  const [selected, setSelected] = useState<TraceEvent | null>(null);
  const [empacotando, setEmpacotando] = useState(false);
  const [audio, setAudio] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  useTheme(defaultSettings);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: "vela:debug" });
    port.onMessage.addListener((message: { type: string; events?: TraceEvent[]; event?: TraceEvent }) => {
      if (message.type === "trace:snapshot" && message.events) setEvents(message.events);
      if (message.type === "trace:event" && message.event) setEvents((current) => [...current.slice(-4000), message.event as TraceEvent]);
    });
    return () => port.disconnect();
  }, []);

  useEffect(() => {
    if (!live) return;
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [events, live]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return events.filter((event) =>
      (!kinds.size || kinds.has(event.kind))
      && (!onlyFailures || event.ok === false)
      && (!needle || `${event.label} ${event.kind} ${JSON.stringify(event.data ?? "")}`.toLowerCase().includes(needle)));
  }, [events, kinds, search, onlyFailures]);

  const turns = useMemo(() => {
    const map = new Map<string, TraceEvent[]>();
    for (const event of visible) {
      const list = map.get(event.turn) ?? [];
      list.push(event);
      map.set(event.turn, list);
    }
    return [...map.entries()];
  }, [visible]);

  const toggleKind = (kind: TraceKind) => setKinds((current) => {
    const next = new Set(current);
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    return next;
  });

  const exportar = () => baixar(`vela-trace-${carimbo()}.jsonl`, toJsonl(visible), "application/x-ndjson");

  /*
   * O relatório é o que se manda para alguém.
   *
   * O JSONL responde qualquer pergunta e não conta nada — para entender um turno seria preciso
   * reconstruir a ordem, casar chamada com resultado e somar durações na mão. Aqui isso já vem
   * feito, em Markdown, que atravessa conversa, issue e documento sem perder estrutura.
   *
   * `completo` só muda o que **cabe** no relatório: se o rastreio completo não estava ligado
   * quando o turno rodou, o prompt simplesmente não foi gravado e nenhuma opção o traz de volta.
   */
  const relatorio = (completo: boolean) => baixar(`vela-relatorio-${carimbo()}.md`, relatorioCompleto(visible, { completo }), "text/markdown");

  /* O pacote sai de `trace-package`, que é o mesmo caminho usado ao encerrar a gravação da voz. */
  const pacote = async () => {
    setEmpacotando(true);
    try {
      baixarArquivo(`vela-revisao-${carimbo()}.zip`, await montarPacote(visible, { completo: temPrompt }));
    } finally {
      setEmpacotando(false);
    }
  };
  // A trilha inteira, e não só a fatia do turno: a fala que abriu um turno de voz foi gravada
  // antes de ele existir, e só a adoção por enunciado a traz de volta para dentro dele.
  const relatorioDe = (turno: string) =>
    baixar(`vela-turno-${turno.slice(0, 8)}-${carimbo()}.md`, relatorioDeUmTurno(visible, turno, { completo: temPrompt }), "text/markdown");

  const limpar = () => { void chrome.runtime.sendMessage({ type: "trace:clear" }); setEvents([]); setSelected(null); };

  /**
   * Um marco na trilha antes de cada teste.
   *
   * Numa sessão de depuração a dois, a trilha vira uma fita longa em que tudo se parece. Uma
   * linha dizendo "agora vou testar X" separa os casos e é o que permite ler o arquivo depois
   * sem ter que adivinhar onde um teste terminou e o outro começou.
   */
  const marcar = () => {
    const nota = window.prompt("O que você vai testar agora?");
    if (!nota?.trim()) return;
    void chrome.runtime.sendMessage({ type: "trace:push", entry: { kind: "ui", label: `— ${nota.trim()} —`, from: "marco", data: { marco: true } } });
  };

  const failures = events.filter((event) => event.ok === false).length;
  // Só faz sentido oferecer o relatório completo quando há prompt gravado para entrar nele.
  const temPrompt = events.some((event) => event.kind === "model.prompt");

  return <main className="debug">
    <header className="debug-bar">
      <div className="debug-title">
        <strong>Trilha da Vela</strong>
        <small>{events.length} eventos · {turns.length} turno(s) · {failures} falha(s)</small>
      </div>

      <input className="debug-search" placeholder="Buscar em rótulo e payload…" value={search} onChange={(event) => setSearch(event.target.value)} />

      <div className="debug-group">
        <button className={live ? "on" : ""} onClick={() => setLive(!live)} title={live ? "Pausar a rolagem automática" : "Voltar a seguir"}>
          {live ? <Pause size={13} /> : <Play size={13} />} {live ? "Ao vivo" : "Pausado"}
        </button>
        <button className={onlyFailures ? "on" : ""} onClick={() => setOnlyFailures(!onlyFailures)}>Só falhas</button>
        <button onClick={marcar} title="Marca o início de um teste na trilha"><Flag size={13} /> Marcar</button>
        <button onClick={exportar}><Download size={13} /> JSONL</button>
        <button onClick={() => void pacote()} disabled={empacotando} title="Relatório, eventos e áudios num zip só — é o que se manda para alguém revisar">
          <Package size={13} /> {empacotando ? "Montando…" : "Pacote"}
        </button>
        <button onClick={() => relatorio(temPrompt)} title={temPrompt ? "Relatório em Markdown, com o prompt exato que o modelo leu" : "Relatório em Markdown. Ligue o rastreio completo em Avançado para incluir o prompt e o conteúdo integral das leituras."}>
          <FileText size={13} /> Relatório{temPrompt ? " completo" : ""}
        </button>
        <button onClick={limpar}><Trash2 size={13} /> Limpar</button>
      </div>
    </header>

    <div className="debug-kinds">
      {KINDS.map((kind) => (
        <button key={kind} className={`chip ${COLOR[kind] ?? ""} ${kinds.has(kind) ? "on" : ""}`} onClick={() => toggleKind(kind)}>
          {kind}<i>{events.filter((event) => event.kind === kind).length}</i>
        </button>
      ))}
      {kinds.size > 0 && <button className="chip clear" onClick={() => setKinds(new Set())}>limpar filtro</button>}
    </div>

    <div className="debug-body">
      <div className="debug-stream" ref={streamRef}>
        {turns.length === 0 && <p className="debug-empty">Nada ainda. Use a Vela numa aba e os eventos aparecem aqui na hora.</p>}
        {turns.map(([turn, list]) => {
          const base = list[0].at;
          const total = list.find((event) => event.kind === "turn")?.ms;
          return <section className="debug-turn" key={turn}>
            <header>
              <span className="debug-turn-id">{turn.slice(0, 8)}</span>
              <span>{new Date(base).toLocaleTimeString()}</span>
              {total !== undefined && <span className="debug-total">{(total / 1000).toFixed(1)}s no total</span>}
              <span className="debug-count">{list.length} eventos</span>
              <button className="debug-turn-report" onClick={() => relatorioDe(turn)} title="Relatório em Markdown só deste turno">relatório</button>
            </header>
            {list.map((event) => (
              <button
                key={event.id ?? `${event.at}-${event.label}`}
                className={`debug-row ${COLOR[event.kind] ?? ""} ${event.ok === false ? "falhou" : ""} ${selected === event ? "aberta" : ""}`}
                onClick={() => { setAudio(null); setSelected(selected === event ? null : event); }}
              >
                <span className="debug-at">{relative(event.at, base)}</span>
                <span className="debug-kind">{event.kind}</span>
                <span className="debug-label">{event.label}</span>
                {event.code && <span className="debug-code">{event.code}</span>}
                {event.ms !== undefined && <span className="debug-ms">{event.ms} ms</span>}
              </button>
            ))}
          </section>;
        })}
      </div>

      {selected && <aside className="debug-detail">
        <header>
          <strong>{selected.label}</strong>
          <button onClick={() => setSelected(null)}>×</button>
        </header>
        <dl>
          <dt>tipo</dt><dd>{selected.kind}</dd>
          <dt>origem</dt><dd>{selected.from}</dd>
          <dt>quando</dt><dd>{new Date(selected.at).toLocaleString()}</dd>
          {selected.ms !== undefined && <><dt>duração</dt><dd>{selected.ms} ms</dd></>}
          {selected.ok !== undefined && <><dt>desfecho</dt><dd className={selected.ok ? "bom" : "ruim"}>{selected.ok ? "ok" : `falhou${selected.code ? ` · ${selected.code}` : ""}`}</dd></>}
          <dt>turno</dt><dd className="mono">{selected.turn}</dd>
        </dl>
        {selected.blobId && <div className="debug-audio">
          <button onClick={() => void readBlob(selected.blobId!).then((item) => { if (item) setAudio(URL.createObjectURL(new Blob([item.bytes], { type: item.mime || "audio/wav" }))); })}>
            <Volume2 size={13} /> Ouvir o áudio deste evento
          </button>
          {/* A transcrição é interpretação; o áudio é o fato. Quando as duas discordam, é aqui que se resolve. */}
          {audio && <audio controls src={audio} autoPlay />}
        </div>}
        <pre>{JSON.stringify(selected.data ?? {}, null, 2)}</pre>
      </aside>}
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<DebugPanel />);
