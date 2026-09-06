export type VoiceVisualMetrics = { energy: number; bass: number; mid: number; high: number; speaking: boolean };

const EMPTY: VoiceVisualMetrics = { energy: 0, bass: 0, mid: 0, high: 0, speaking: false };
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Audio analysis is deliberately independent from React and the renderer.
 * Call sample() at roughly 20–30Hz; the orb interpolates between samples.
 */
export class VoiceMetricsAnalyzer {
  readonly metrics: VoiceVisualMetrics = { ...EMPTY };
  private readonly context: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly data: Uint8Array;
  private readonly bands: { bass: [number, number]; mid: [number, number]; high: [number, number] } = { bass: [0.02, 0.12], mid: [0.12, 0.48], high: [0.48, 0.92] };
  private gate = 0.075;
  private speakingHold = 0;
  private previousEnergy = 0;

  constructor(context: AudioContext, source: AudioNode) {
    this.context = context;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.72;
    this.data = new Uint8Array(this.analyser.frequencyBinCount);
    source.connect(this.analyser);
  }

  sample(): VoiceVisualMetrics {
    this.analyser.getByteFrequencyData(this.data as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < this.data.length; i += 1) sum += this.data[i] / 255;
    const rawEnergy = this.data.length ? sum / this.data.length : 0;
    const gated = rawEnergy < this.gate ? 0 : clamp((rawEnergy - this.gate) / (1 - this.gate));
    const band = (range: [number, number]) => {
      const start = Math.floor(this.data.length * range[0]);
      const end = Math.max(start + 1, Math.floor(this.data.length * range[1]));
      let value = 0;
      for (let i = start; i < end; i += 1) value += this.data[i] / 255;
      return clamp(value / (end - start) * 2.2);
    };
    const bass = band(this.bands.bass);
    const mid = band(this.bands.mid);
    const high = band(this.bands.high);
    // Voz tem corpo nos graves e médios; estalo de tecla espalha energia para os agudos.
    const voiced = bass + mid > high * 1.35;
    // E some tão rápido quanto chegou: um salto seguido de queda imediata não é sílaba.
    const sustained = gated > 0.16 && this.previousEnergy > 0.08;
    this.previousEnergy = gated;
    const next = { energy: gated, bass, mid, high, speaking: voiced && sustained };
    const attack = 0.32;
    const release = 0.12;
    (Object.keys(next) as Array<keyof VoiceVisualMetrics>).forEach((key) => {
      if (key === "speaking") return;
      const target = next[key] as number;
      const current = this.metrics[key] as number;
      const factor = target > current ? attack : release;
      (this.metrics[key] as number) = current + (target - current) * factor;
    });
    // Segurar por ~320ms evita piscar entre sílabas da mesma frase.
    this.speakingHold = next.speaking ? 8 : Math.max(0, this.speakingHold - 1);
    this.metrics.speaking = this.speakingHold > 0;
    return this.metrics;
  }

  disconnect() { this.analyser.disconnect(); }
  get sampleRate() { return this.context.sampleRate; }
}

export function emptyVoiceMetrics(): VoiceVisualMetrics { return { ...EMPTY }; }
