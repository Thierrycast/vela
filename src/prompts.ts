export type LensIntent = "ask" | "explain" | "summarize" | "context";

export type LensPayload = { intent: LensIntent; text: string; url: string; title: string };

export function lensPrompt({ intent, text, url, title }: LensPayload): string {
  const source = `“${title}” (${url})`;
  const quote = `\n\n"""\n${text}\n"""`;
  if (intent === "explain") return `Explique, de forma direta, o trecho selecionado de ${source}:${quote}`;
  if (intent === "summarize") return `Resuma em até 5 tópicos o trecho selecionado de ${source}:${quote}`;
  return `Sobre este trecho de ${source}:${quote}\n\n`;
}

export function attachmentText({ text, url, title }: LensPayload): string {
  return `Trecho selecionado em “${title}” (${url}):\n${text}`;
}
