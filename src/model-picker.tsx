import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Search } from "lucide-react";
import { AppSettings } from "./types";
import { listModels } from "./provider";

/**
 * Troca de modelo sem sair da conversa.
 *
 * O botão dizia "clique para trocar" e abria a página inteira de configurações — o que, num
 * painel lateral, é perder a conversa de vista para mexer num campo. Aqui a lista é a mesma do
 * gateway, buscada só quando o menu abre.
 *
 * Com mais de mil modelos, a busca não é enfeite: uma lista rolável dessa altura é inútil sem
 * filtro. O que aparece sem digitar nada são os recentes mais o atual, que cobrem o uso normal.
 */
const RECENT_KEY = "vela:recent-models";
const MAX_RECENT = 5;
const MAX_SHOWN = 60;

export function ModelPicker({ settings, update, configured }: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  configured: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const provider = settings.providers.find((item) => item.id === settings.activeProviderId);
  const current = provider?.defaultModel ?? "";

  useEffect(() => {
    void chrome.storage?.local.get(RECENT_KEY).then((stored) => setRecent((stored?.[RECENT_KEY] as string[]) ?? []));
  }, []);

  useEffect(() => {
    if (!open || !provider) return;
    searchRef.current?.focus();
    if (models) return;
    let cancelled = false;
    void listModels(provider)
      .then((list) => { if (!cancelled) { setModels(list.map((item) => item.id)); setFailure(null); } })
      .catch((error: unknown) => { if (!cancelled) setFailure(error instanceof Error ? error.message : "Não consegui listar os modelos."); });
    return () => { cancelled = true; };
  }, [open, provider, models]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", closeOnOutside); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      const base = [current, ...recent].filter(Boolean);
      return [...new Set(base)];
    }
    return (models ?? []).filter((item) => item.toLowerCase().includes(needle)).slice(0, MAX_SHOWN);
  }, [query, models, recent, current]);

  const choose = (model: string) => {
    if (!provider) return;
    update({ providers: settings.providers.map((item) => item.id === provider.id ? { ...item, defaultModel: model } : item) });
    const next = [model, ...recent.filter((item) => item !== model)].slice(0, MAX_RECENT);
    setRecent(next);
    void chrome.storage?.local.set({ [RECENT_KEY]: next });
    setOpen(false);
    setQuery("");
  };

  const total = models?.length ?? 0;

  return <div className="model-picker" ref={rootRef}>
    <button
      className="model-label"
      onClick={() => setOpen((value) => !value)}
      aria-haspopup="listbox"
      aria-expanded={open}
      title={configured ? `${provider?.name} · ${current} — clique para trocar` : "Configure um provider nas opções"}
    >
      <span className={`status-dot ${configured ? "" : "off"}`} />{current || "sem modelo"}
    </button>

    {open && <div className="model-menu" role="listbox">
      <div className="model-search">
        <Search size={13} />
        <input
          ref={searchRef}
          value={query}
          placeholder={total ? `Buscar entre ${total} modelos…` : "Buscar modelo…"}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {failure && <p className="model-empty">{failure}</p>}
      {!failure && !models && <p className="model-empty">Carregando a lista do gateway…</p>}
      {!failure && models && !shown.length && <p className="model-empty">{query ? "Nenhum modelo com esse nome." : "Digite para buscar."}</p>}

      <ul>
        {shown.map((model) => (
          <li key={model}>
            <button role="option" aria-selected={model === current} className={model === current ? "selected" : ""} onClick={() => choose(model)}>
              <span>{model}</span>
              {model === current && <Check size={13} />}
            </button>
          </li>
        ))}
      </ul>
    </div>}
  </div>;
}
