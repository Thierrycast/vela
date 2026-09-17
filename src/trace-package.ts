import { TraceEvent, toJsonl } from "./trace";
import { listBlobs, readBlob } from "./trace-blobs";
import { relatorioCompleto } from "./trace-report";
import { buildZip } from "./zip-writer";

/**
 * O pacote de revisão: relatório, eventos e áudios num arquivo só.
 *
 * Um relatório que diz "áudio a3f8c1" e um arquivo solto numa pasta são duas coisas que se perdem
 * uma da outra no caminho até quem vai revisar. Junto, o zip é autocontido: abre, lê o Markdown, e
 * os arquivos citados estão ali do lado com o mesmo nome.
 *
 * Mora fora do painel porque quem monta o pacote não é só ele: a sessão de voz também termina
 * entregando um — e duas montagens paralelas seriam dois formatos divergindo em silêncio, que é
 * exatamente o problema que o relatório existe para resolver.
 */

export const carimbo = (at = Date.now()) => new Date(at).toISOString().replace(/[:.]/g, "-");

const extensaoDe = (mime: string) => (mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : mime.includes("ogg") ? "ogg" : mime.includes("webm") ? "webm" : "wav");

/**
 * Só entram os áudios **citados por estes eventos**. Empacotar a store inteira encheria o zip de
 * fala de outra sessão, e o relatório apontaria para arquivos que não explicam nada do que ele
 * conta.
 */
export async function montarPacote(eventos: TraceEvent[], options: { completo: boolean }): Promise<Blob> {
  const citados = new Set(eventos.map((evento) => evento.blobId).filter((id): id is string => !!id));
  const entradas: Array<{ name: string; data: Uint8Array }> = [
    { name: "relatorio.md", data: new TextEncoder().encode(relatorioCompleto(eventos, { completo: options.completo })) },
    { name: "eventos.jsonl", data: new TextEncoder().encode(toJsonl(eventos)) },
  ];
  for (const audio of await listBlobs()) {
    if (!citados.has(audio.id)) continue;
    const completo = await readBlob(audio.id);
    if (!completo) continue;
    const apelido = audio.label.replace(/[^\p{L}\d]+/gu, "-").slice(0, 40);
    entradas.push({ name: `audio/${audio.id.slice(0, 8)}-${apelido}.${extensaoDe(completo.mime)}`, data: new Uint8Array(completo.bytes) });
  }
  return buildZip(entradas);
}

/** Baixa o que foi montado na hora — nada disso passa por servidor nenhum. */
export function baixarArquivo(nome: string, conteudo: Blob | string, tipo = "application/octet-stream") {
  const blob = typeof conteudo === "string" ? new Blob([conteudo], { type: tipo }) : conteudo;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = nome;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
