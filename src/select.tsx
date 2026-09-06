import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export type SelectOption<T extends string> = { value: T; label: string; hint?: string };

/**
 * Select próprio. O nativo não aceita estilo do menu, abre com a aparência do sistema e
 * quebra o desenho da barra lateral. Este abre com transição e fecha ao clicar fora ou no Escape.
 */
export function Select<T extends string>({ value, options, onChange, compact = false, label }: {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  compact?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); return; }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const index = options.findIndex((option) => option.value === value);
      const next = event.key === "ArrowDown" ? Math.min(index + 1, options.length - 1) : Math.max(index - 1, 0);
      onChange(options[next].value);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", closeOnOutside); document.removeEventListener("keydown", onKey); };
  }, [open, options, value, onChange]);

  return <div className={`vela-select ${compact ? "compact" : ""} ${open ? "open" : ""}`} ref={rootRef}>
    <button type="button" className="vela-select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-label={label} onClick={() => setOpen((state) => !state)}>
      <span>{current?.label}</span>
      <ChevronDown size={compact ? 13 : 15} />
    </button>
    {open && <ul className="vela-select-list" id={listId} role="listbox">
      {options.map((option) => (
        <li key={option.value}>
          <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? "selected" : ""}
            onClick={() => { onChange(option.value); setOpen(false); }}>
            <span>{option.label}</span>
            {option.hint && <small>{option.hint}</small>}
          </button>
        </li>
      ))}
    </ul>}
  </div>;
}
