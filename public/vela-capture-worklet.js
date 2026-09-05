// Script clássico: o escopo de AudioWorklet não suporta import.
class VelaCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.pendingFrames = 0;
    this.blockSize = 320;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    this.pending.push(new Float32Array(channel));
    this.pendingFrames += channel.length;
    if (this.pendingFrames >= this.blockSize) {
      const merged = new Float32Array(this.pendingFrames);
      let offset = 0;
      for (const chunk of this.pending) { merged.set(chunk, offset); offset += chunk.length; }
      this.pending = [];
      this.pendingFrames = 0;
      this.port.postMessage(merged, [merged.buffer]);
    }
    return true;
  }
}

registerProcessor("vela-capture", VelaCaptureProcessor);
