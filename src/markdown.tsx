import { Fragment, ReactNode, useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Markdown renderizado como elementos React, nunca por `innerHTML`.
 *
 * O texto do modelo carrega conteúdo que veio da página — território não confiável. Um
 * `dangerouslySetInnerHTML` aqui seria XSS servido pelo próprio site que a Vela acabou de ler.
 * Construir os nós à mão custa este arquivo e elimina a classe inteira de problema.
 *
 * Também é por isso que não entra biblioteca: qualquer uma delas devolve HTML.
 */

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g;

const safeHref = (url: string) => /^(https?:|mailto:)/i.test(url) ? url : undefined;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const token = match[0];
    const key = `${keyPrefix}-${index += 1}`;

    if (token.startsWith("`")) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**") || token.startsWith("__")) nodes.push(<strong key={key}>{inline(token.slice(2, -2), key)}</strong>);
    else if (token.startsWith("~~")) nodes.push(<del key={key}>{inline(token.slice(2, -2), key)}</del>);
    else if (token.startsWith("[")) {
      const cut = token.indexOf("](");
      const href = safeHref(token.slice(cut + 2, -1));
      const label = token.slice(1, cut);
      nodes.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer noopener">{label}</a> : <Fragment key={key}>{label}</Fragment>);
    } else if (token.startsWith("http")) nodes.push(<a key={key} href={token} target="_blank" rel="noreferrer noopener">{token}</a>);
    else nodes.push(<em key={key}>{inline(token.slice(1, -1), key)}</em>);

    cursor = start + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return <div className="md-code">
    <div className="md-code-head">
      <span>{language || "código"}</span>
      <button onClick={() => void copy()} aria-label="Copiar código">{copied ? <Check size={13} /> : <Copy size={13} />}</button>
    </div>
    <pre><code>{code}</code></pre>
  </div>;
}

const splitRow = (line: string) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
const isDivider = (line: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor];
    // A chave vem da posição da linha: estável entre renders e sem contador mutável no meio do render.
    const at = `md-${cursor}`;

    if (!line.trim()) { cursor += 1; continue; }

    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      cursor += 1;
      while (cursor < lines.length && !/^\s*```/.test(lines[cursor])) { body.push(lines[cursor]); cursor += 1; }
      cursor += 1;
      blocks.push(<CodeBlock key={at} code={body.join("\n")} language={fence[1]} />);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push(<hr key={at} />); cursor += 1; continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const Tag = `h${level + 2}` as "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={at} className={`md-h${level}`}>{inline(heading[2], at)}</Tag>);
      cursor += 1;
      continue;
    }

    if (line.includes("|") && cursor + 1 < lines.length && isDivider(lines[cursor + 1])) {
      const header = splitRow(line);
      cursor += 2;
      const rows: string[][] = [];
      while (cursor < lines.length && lines[cursor].includes("|") && lines[cursor].trim()) { rows.push(splitRow(lines[cursor])); cursor += 1; }
      blocks.push(<div className="md-table-wrap" key={at}>
        <table>
          <thead><tr>{header.map((cell, index) => <th key={index}>{inline(cell, `${at}-h${index}`)}</th>)}</tr></thead>
          <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex}>{inline(row[cellIndex] ?? "", `${at}-c${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>
        </table>
      </div>);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (cursor < lines.length && /^\s*>/.test(lines[cursor])) { body.push(lines[cursor].replace(/^\s*>\s?/, "")); cursor += 1; }
      blocks.push(<blockquote key={at}>{inline(body.join(" "), at)}</blockquote>);
      continue;
    }

    const bullet = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const items: ReactNode[] = [];
      while (cursor < lines.length) {
        const entry = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[cursor]);
        if (!entry || /\d/.test(entry[1]) !== ordered) break;
        const parts = [entry[2]];
        const itemAt = `${at}-i${cursor}`;
        cursor += 1;
        // Continuação indentada pertence ao mesmo item.
        while (cursor < lines.length && /^\s{2,}\S/.test(lines[cursor]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[cursor])) {
          parts.push(lines[cursor].trim());
          cursor += 1;
        }
        items.push(<li key={itemAt}>{inline(parts.join(" "), itemAt)}</li>);
      }
      blocks.push(ordered ? <ol key={at}>{items}</ol> : <ul key={at}>{items}</ul>);
      continue;
    }

    const paragraph: string[] = [];
    while (cursor < lines.length && lines[cursor].trim() && !/^\s*(```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[cursor]) && !(lines[cursor].includes("|") && isDivider(lines[cursor + 1] ?? ""))) {
      paragraph.push(lines[cursor]);
      cursor += 1;
    }
    if (!paragraph.length) { paragraph.push(lines[cursor]); cursor += 1; }
    blocks.push(<p key={at}>{inline(paragraph.join("\n"), at)}</p>);
  }

  return <div className="markdown">{blocks}</div>;
}
