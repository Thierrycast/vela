/**
 * Metadados moram dentro do código, no bloco `==UserScript==` — o mesmo formato do Tampermonkey
 * e do Greasemonkey. Assim nome, descrição e alvos são uma coisa só com o script: a IA escreve
 * um texto, o usuário edita o mesmo texto, e nada fica fora de sincronia.
 */
export type ScriptMetadata = {
  name: string;
  description: string;
  version: string;
  author: string;
  matches: string[];
  excludes: string[];
  runAt: "document-start" | "document-end" | "document-idle";
};

const DEFAULTS: ScriptMetadata = {
  name: "Script sem nome",
  description: "",
  version: "1.0",
  author: "",
  matches: [],
  excludes: [],
  runAt: "document-idle",
};

const BLOCK = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/;

export function parseMetadata(code: string): ScriptMetadata {
  const block = BLOCK.exec(code);
  if (!block) return { ...DEFAULTS };

  const meta: ScriptMetadata = { ...DEFAULTS, matches: [], excludes: [] };
  for (const line of block[1].split("\n")) {
    const entry = /^\s*\/\/\s*@(\S+)\s+(.*)$/.exec(line);
    if (!entry) continue;
    const key = entry[1].toLowerCase();
    const value = entry[2].trim();
    if (!value) continue;
    if (key === "name") meta.name = value;
    else if (key === "description") meta.description = value;
    else if (key === "version") meta.version = value;
    else if (key === "author") meta.author = value;
    else if (key === "match" || key === "include") meta.matches.push(value);
    else if (key === "exclude") meta.excludes.push(value);
    else if (key === "run-at") {
      const normalized = value.replace("_", "-");
      if (normalized === "document-start" || normalized === "document-end" || normalized === "document-idle") meta.runAt = normalized;
    }
  }
  if (!meta.matches.length) meta.matches = ["<all_urls>"];
  return meta;
}

export function scriptTemplate(name = "Novo script"): string {
  return [
    "// ==UserScript==",
    `// @name         ${name}`,
    "// @version      1.0",
    "// @description  Descreva em uma frase o que este script faz.",
    "// @match        https://exemplo.com/*",
    "// @run-at       document-idle",
    "// ==/UserScript==",
    "",
    "// O código roda na página, no mundo isolado da extensão.",
    "// Retorne um valor para vê-lo no resultado da execução.",
    "return document.title;",
    "",
  ].join("\n");
}

/** Resumo curto dos alvos, para a vitrine não virar uma parede de padrões. */
export function describeTargets(matches: string[]): string {
  if (!matches.length) return "nenhum alvo";
  if (matches.includes("<all_urls>") || matches.includes("*://*/*")) return "todas as páginas";
  const hosts = matches.map((pattern) => {
    const cleaned = pattern.replace(/^\*:\/\/|^https?:\/\//, "").replace(/\/.*$/, "");
    return cleaned.replace(/^\*\./, "") || pattern;
  });
  const unique = [...new Set(hosts)];
  return unique.length <= 2 ? unique.join(", ") : `${unique.slice(0, 2).join(", ")} +${unique.length - 2}`;
}
