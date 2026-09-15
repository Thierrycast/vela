export type UtteranceEvents = {
  onStart: () => void;
  onEnd: (chunks: Float32Array[], reason: "silêncio" | "limite") => void;
  onLevel?: (level: number, speaking: boolean) => void;
};

export type VadOptions = {
  sampleRate: number;
  preRollMs?: number;
  hangoverMs?: number;
  attackMs?: number;
  minUtteranceMs?: number;
  maxUtteranceMs?: number;
};

/**
 * Segmenta a fala por silêncio, não por relógio. Cada enunciado vira um buffer completo,
 * com pre-roll — o ataque da primeira palavra não é cortado.
 */
export class UtteranceSegmenter {
  private readonly frameMs: number;
  private readonly preRollFrames: number;
  private readonly attackFrames: number;
  private readonly hangoverFrames: number;
  private readonly minFrames: number;
  private readonly maxFrames: number;

  private readonly ring: Float32Array[] = [];
  private current: Float32Array[] = [];
  private speaking = false;
  private aboveCount = 0;
  private silenceCount = 0;
  private noiseFloor = 0.01;
  private calibrationFrames = 0;
  private suspended = false;

  constructor(private readonly events: UtteranceEvents, options: VadOptions) {
    const frames = 320;
    this.frameMs = (frames / options.sampleRate) * 1000;
    const toFrames = (ms: number) => Math.max(1, Math.round(ms / this.frameMs));
    this.preRollFrames = toFrames(options.preRollMs ?? 300);
    this.attackFrames = toFrames(options.attackMs ?? 130);
    this.hangoverFrames = toFrames(options.hangoverMs ?? 1500);
    this.minFrames = toFrames(options.minUtteranceMs ?? 350);
    this.maxFrames = toFrames(options.maxUtteranceMs ?? 15_000);
  }

  suspend() { this.suspended = true; this.reset(); }
  resume() { this.suspended = false; }
  get isSpeaking() { return this.speaking; }

  private reset() {
    this.speaking = false;
    this.aboveCount = 0;
    this.silenceCount = 0;
    this.current = [];
  }

  push(samples: Float32Array) {
    if (this.suspended) return;

    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
    const level = Math.sqrt(sum / samples.length);

    if (this.calibrationFrames < 12) {
      this.calibrationFrames += 1;
      this.noiseFloor = this.noiseFloor * 0.7 + level * 0.3;
      return;
    }

    const startThreshold = Math.max(0.02, this.noiseFloor * 2.8);
    const endThreshold = Math.max(0.012, this.noiseFloor * 1.7);
    this.events.onLevel?.(Math.min(1, level * 6), this.speaking);

    if (!this.speaking) {
      this.noiseFloor = this.noiseFloor * 0.995 + level * 0.005;
      this.ring.push(samples);
      if (this.ring.length > this.preRollFrames) this.ring.shift();
      this.aboveCount = level > startThreshold ? this.aboveCount + 1 : 0;
      if (this.aboveCount >= this.attackFrames) {
        this.speaking = true;
        this.silenceCount = 0;
        this.current = [...this.ring];
        this.ring.length = 0;
        this.events.onStart();
      }
      return;
    }

    this.current.push(samples);
    this.silenceCount = level > endThreshold ? 0 : this.silenceCount + 1;

    if (this.current.length >= this.maxFrames) { this.finish("limite"); return; }
    if (this.silenceCount >= this.hangoverFrames) this.finish("silêncio");
  }

  private finish(reason: "silêncio" | "limite") {
    const chunks = this.current;
    const voicedFrames = chunks.length - this.silenceCount;
    this.reset();
    if (voicedFrames >= this.minFrames) this.events.onEnd(chunks, reason);
  }
}
