import { useEffect, useRef, useState } from "react";
import { Activity, Download, RotateCcw, Trash2, Upload } from "lucide-react";
import { AppSettings, LogEntry } from "./types";
import { clearLogs, loadLogs } from "./storage";
import { ActionStats, clearActionStats, loadActionStats } from "./action-stats";
import { clearRouteCache, routeCacheSize } from "./route-cache";
import { StorageSlice, buildBackup, clearSlice, formatBytes, measureStorage, resetPreferences, restoreBackup } from "./maintenance";
import { clearTrace, readTrace, toJsonl, traceSize } from "./trace";
import { blobsSize, clearBlobs } from "./trace-blobs";
function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{label}</strong>{description && <small>{description}</small>}</div><div className="setting-control">{children}</div></div>;
}

/** A barra existe para responder de relance "onde está o meu espaço", que uma lista de bytes não responde. */
function StorageBar({ slices }: { slices: StorageSlice[] }) {
  const total = slices.reduce((sum, slice) => sum + slice.bytes, 0);
  if (!total) return null;
  return <div className="storage-bar" role="img" aria-label={`Armazenamento usado: ${formatBytes(total)}`}>
    {slices.filter((slice) => slice.bytes > 0).map((slice, index) => (
      <span key={slice.key} className={`storage-slot slot-${index % 5}`} style={{ flexGrow: slice.bytes }} title={`${slice.label}: ${formatBytes(slice.bytes)}`} />
    ))}
  </div>;
}

export function AdvancedPanel({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<ActionStats | null>(null);
  const [slices, setSlices] = useState<StorageSlice[]>([]);
  const [includeKeys, setIncludeKeys] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [trace, setTrace] = useState<{ events: number; bytes: number } | null>(null);
  const [rotas, setRotas] = useState<number | null>(null);
  const [audios, setAudios] = useState<{ count: number; bytes: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    void loadLogs().then(setLogs);
    void loadActionStats().then(setStats);
    void measureStorage().then(setSlices);
    void traceSize().then(setTrace);
    void routeCacheSize().then(setRotas);
    void blobsSize().then(setAudios);
  };
  useEffect(refresh, []);

  const totalBytes = slices.reduce((sum, slice) => sum + slice.bytes, 0);

  const exportBackup = async () => {
    const backup = await buildBackup(includeKeys);
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `vela-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice({ tone: "ok", text: includeKeys ? "Backup exportado com as chaves dentro — guarde como se fosse uma senha." : "Backup exportado sem as chaves de API." });
  };

  const importBackup = async (file: File) => {
    try {
      const report = await restoreBackup(await file.text());
      refresh();
      setNotice({ tone: "ok", text: `Restaurado: ${report.providers} provider(s) e ${report.scripts} script(s).${report.keysKept ? " As chaves que já estavam aqui foram mantidas." : ""}` });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "Falha ao restaurar." });
    }
  };

  const exportarTrilha = async () => {
    const events = await readTrace();
    const url = URL.createObjectURL(new Blob([toJsonl(events)], { type: "application/x-ndjson" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `vela-trace-${new Date().toISOString().slice(0, 10)}.jsonl`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice({ tone: "ok", text: `${events.length} evento(s) exportado(s).` });
  };

  const wipe = async (slice: StorageSlice) => {
    await clearSlice(slice.key);
    refresh();
    setNotice({ tone: "ok", text: `${slice.label} apagado.` });
  };

  return <>
    <h1>Avançado</h1>
    <p className="section-intro">Os números que dizem se a Vela está acertando, o espaço que ela ocupa neste perfil e como levar essa configuração para outra máquina. Nada aqui sai do seu navegador.</p>

    <h2 className="subsection">Como as ações estão saindo</h2>
    <div className="settings-group">
      <Row label="Ações executadas" description="Quantas vezes a Vela agiu na página desde a última contagem."><span className="status-badge">{stats ? `${stats.total} ações` : "—"}</span></Row>
      {stats && stats.total > 0 && <>
        <Row label="Sem efeito perceptível" description="O clique saiu mas a página não reagiu. É esta a métrica que diz se vale declarar a permissão debugger e passar a usar CDP.">
          <span className={stats.noEffect / stats.total > 0.15 ? "probe-off" : "probe-ok"}>{stats.noEffect} de {stats.total} ({Math.round((stats.noEffect / stats.total) * 100)}%)</span>
        </Row>
        <Row label="Falhas" description={Object.entries(stats.byCode).map(([code, count]) => `${code}: ${count}`).join(" · ") || "nenhuma"}>
          <span className={stats.failures ? "probe-off" : "probe-ok"}>{stats.failures}</span>
        </Row>
        <Row label="Ações mais usadas" description={Object.entries(stats.byType).sort((first, second) => second[1] - first[1]).map(([type, count]) => `${type}: ${count}`).join(" · ")}>
          <button className="secondary-button" onClick={() => void clearActionStats().then(refresh)}>Zerar contagem</button>
        </Row>
      </>}
      {/* Idas ao modelo por tarefa é o número que mede fluidez: é ele que cai quando a Vela
          consegue prever dois passos à frente em vez de parar e perguntar a cada clique. */}
      {stats && stats.turns > 0 && <>
        <Row label="Idas ao modelo por tarefa" description={`${stats.turns} tarefa(s) concluída(s), ${stats.rounds} rodada(s) no total. Quanto menor, mais fluida a Vela está.`}>
          <span className={stats.rounds / stats.turns > 6 ? "probe-off" : "probe-ok"}>{(stats.rounds / stats.turns).toFixed(1)} por tarefa</span>
        </Row>
        <Row label="Ferramentas por rodada" description={stats.batchItems ? `${stats.batchItems} dessas ações vieram dentro de um lote.` : "Acima de 1 significa que ela agrupou trabalho em vez de gastar uma ida por ação."}>
          <span className="status-badge">{(stats.toolCalls / Math.max(1, stats.rounds)).toFixed(2)}</span>
        </Row>
      </>}
    </div>

    <h2 className="subsection">Rastreio completo</h2>
    <p className="picker-intro">A trilha normal diz o que aconteceu e quanto demorou. O rastreio completo diz <strong>por quê</strong>: guarda o prompt exato que o modelo leu, a resposta inteira que ele deu e o conteúdo integral de cada leitura de página — que é o material de uma revisão de verdade. Chaves e senhas continuam fora, sempre.</p>
    <div className="settings-group">
      <Row label="Áudio guardado" description="Trechos de fala e respostas faladas ficam no navegador, ligados aos eventos que os descrevem. Somem junto quando você apaga a trilha.">
        <span className="status-badge">{audios === null ? "—" : audios.count === 0 ? "nenhum" : `${audios.count} arquivo(s) · ${formatBytes(audios.bytes)}`}</span>
      </Row>
      <Row label="Gravar tudo" description="Ligue antes de reproduzir o problema, faça o teste, exporte o relatório e desligue. A trilha fica ordens de grandeza maior, passa a conter o conteúdo das páginas que você visitar e, na voz, o áudio do que foi falado.">
        <button className={`toggle ${settings.agent.fullTrace ? "on" : ""}`} role="switch" aria-checked={settings.agent.fullTrace} onClick={() => update({ agent: { ...settings.agent, fullTrace: !settings.agent.fullTrace } })}><span /></button>
      </Row>
    </div>

    <h2 className="subsection">Caminhos lembrados</h2>
    <p className="picker-intro">Por onde a Vela chega a cada coisa nos sites que você usa, para não redescobrir o mesmo caminho a cada conversa. É palpite conferido na hora, nunca resposta pronta, e some sozinho quando erra ou quando envelhece.</p>
    <div className="settings-group">
      <Row label="Caminhos guardados" description="Só domínio, o que se procurava e um seletor. Nada do conteúdo das páginas.">
        <span className="status-badge">{rotas === null ? "—" : rotas === 0 ? "nenhum ainda" : `${rotas} caminho(s)`}</span>
      </Row>
      <Row label="Esquecer tudo" description="Útil depois que um site muda de layout: ela reaprende do zero na próxima vez.">
        <button className="secondary-button" onClick={() => void clearRouteCache().then(refresh)} disabled={!rotas}>Esquecer caminhos</button>
      </Row>
    </div>

    <h2 className="subsection">Trilha de execução</h2>
    <p className="picker-intro">Cada requisição, chamada de ferramenta, ação na página e falha, com duração. É a matéria-prima para ajustar o que está lento ou errando — e não sai do seu navegador.</p>
    <div className="settings-group">
      <Row label="Eventos gravados" description="A trilha guarda os 20 mil mais recentes e descarta o resto.">
        <span className="status-badge">{trace ? `${trace.events} eventos · ${formatBytes(trace.bytes)}` : "—"}</span>
      </Row>
      <Row label="Visor em tempo real" description="Abre numa aba e mostra os eventos aparecendo, agrupados por turno, com filtro e busca.">
        <button className="secondary-button" onClick={() => void chrome.tabs?.create({ url: chrome.runtime.getURL("debug.html") })}>
          <Activity size={14} /> Abrir a trilha
        </button>
      </Row>
      <Row label="Exportar" description="Uma linha JSON por evento — o formato que ferramentas de análise leem direto.">
        <button className="secondary-button" onClick={() => void exportarTrilha()}><Download size={14} /> Exportar JSONL</button>
      </Row>
      <Row label="Apagar a trilha">
        <button className="secondary-button" onClick={() => void Promise.all([clearTrace(), clearBlobs()]).then(refresh)}><Trash2 size={14} /> Apagar</button>
      </Row>
    </div>

    <h2 className="subsection">Espaço usado</h2>
    <StorageBar slices={slices} />
    <div className="settings-group">
      {slices.map((slice) => <Row key={slice.key} label={slice.label} description={slice.description}>
        <span className="status-badge">{formatBytes(slice.bytes)}</span>
        <button className="icon-danger" hidden={!slice.clearable || slice.bytes === 0} onClick={() => void wipe(slice)} aria-label={`Apagar ${slice.label}`}><Trash2 size={15} /></button>
      </Row>)}
      <Row label="Total" description="O limite do chrome.storage.local é de 10 MB por extensão."><span className="status-badge">{formatBytes(totalBytes)}</span></Row>
    </div>

    <h2 className="subsection">Backup e restauração</h2>
    <div className="settings-group">
      <Row label="Incluir as chaves de API" description="Desligado, o arquivo é seguro de guardar em qualquer lugar. Ligado, ele vale como senha.">
        <button className={`toggle ${includeKeys ? "on" : ""}`} role="switch" aria-checked={includeKeys} onClick={() => setIncludeKeys(!includeKeys)}><span /></button>
      </Row>
      <Row label="Exportar" description="Preferências, providers e scripts num único arquivo JSON.">
        <button className="secondary-button" onClick={() => void exportBackup()}><Download size={14} /> Exportar</button>
      </Row>
      <Row label="Restaurar de um arquivo" description="Substitui preferências e scripts. Uma chave ausente no arquivo não apaga a que já está configurada aqui.">
        <button className="secondary-button" onClick={() => fileRef.current?.click()}><Upload size={14} /> Escolher arquivo</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importBackup(file); }} />
      </Row>
      <Row label="Restaurar padrões" description="Volta tema, agente, contexto e voz ao original. Providers e chaves ficam como estão.">
        <button className="secondary-button" onClick={() => void resetPreferences().then((restored) => { update(restored); refresh(); setNotice({ tone: "ok", text: "Preferências restauradas ao padrão." }); })}><RotateCcw size={14} /> Restaurar</button>
      </Row>
    </div>
    {notice && <p className={`maintenance-notice ${notice.tone}`}>{notice.text}</p>}

    <h2 className="subsection">Registros</h2>
    <div className="settings-group">
      <Row label="Eventos guardados" description={`${logs.length} entradas neste perfil. Os 250 mais recentes, sem conteúdo de página.`}>
        <button className="secondary-button" onClick={() => void clearLogs().then(refresh)}>Limpar registros</button>
      </Row>
    </div>
    {logs.length > 0 && <div className="log-preview">
      {logs.slice(-10).reverse().map((log) => <div key={log.id}>
        <code>{new Date(log.createdAt).toLocaleTimeString()}</code>
        <span className={`log-${log.level}`}>{log.level}</span>
        <span>{log.event}</span>
      </div>)}
    </div>}
  </>;
}
