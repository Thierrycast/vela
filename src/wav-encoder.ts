/** PCM 16-bit mono em contêiner RIFF: aceito por qualquer API compatível com Whisper. */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string) => { for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index)); };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, total * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}
