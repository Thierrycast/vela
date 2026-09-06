import { useState } from "react";
import { Check, Copy, Pencil, RefreshCw, RotateCcw, Volume2 } from "lucide-react";

// Ação é oferta, não convite: pequena e apagada, some no fundo até você procurar por ela.
const ICON = 12;

function ActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button className="message-action" onClick={onClick} aria-label={label} title={label}>{children}</button>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return <ActionButton label={copied ? "Copiado" : "Copiar"} onClick={() => void copy()}>
    {copied ? <Check size={ICON} /> : <Copy size={ICON} />}
  </ActionButton>;
}

export function AssistantActions({ text, onRegenerate, onSpeak, speaking }: {
  text: string;
  onRegenerate?: () => void;
  onSpeak: () => void;
  speaking: boolean;
}) {
  return <div className="message-actions">
    <CopyButton text={text} />
    <ActionButton label={speaking ? "Parar leitura" : "Ler em voz alta"} onClick={onSpeak}><Volume2 size={ICON} className={speaking ? "pulsing" : ""} /></ActionButton>
    {onRegenerate && <ActionButton label="Gerar outra resposta" onClick={onRegenerate}><RefreshCw size={ICON} /></ActionButton>}
  </div>;
}

export function UserActions({ text, onEdit, onResend }: { text: string; onEdit: () => void; onResend: () => void }) {
  return <div className="message-actions user">
    <CopyButton text={text} />
    <ActionButton label="Editar e enviar de novo" onClick={onEdit}><Pencil size={ICON} /></ActionButton>
    <ActionButton label="Enviar de novo" onClick={onResend}><RotateCcw size={ICON} /></ActionButton>
  </div>;
}

export function MessageEditor({ value, onCancel, onSubmit }: { value: string; onCancel: () => void; onSubmit: (text: string) => void }) {
  const [draft, setDraft] = useState(value);
  return <div className="message-editor">
    <textarea
      value={draft}
      autoFocus
      rows={Math.min(10, draft.split("\n").length + 1)}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (draft.trim()) onSubmit(draft.trim()); }
      }}
    />
    <div className="message-editor-actions">
      <button className="ghost" onClick={onCancel}>Cancelar</button>
      <button className="primary" onClick={() => draft.trim() && onSubmit(draft.trim())} disabled={!draft.trim()}>Enviar</button>
    </div>
  </div>;
}
