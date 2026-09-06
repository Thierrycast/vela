import { MotionState } from "./motion-tokens";
import { VoiceVisualMetrics, emptyVoiceMetrics } from "./audio-metrics";

/**
 * Interface comum a todo visual de voz. O orb em canvas 2D já a satisfaz, então trocar de
 * renderer é trocar a classe — nada acima precisa saber se por baixo há shader ou não.
 */
export type VoiceVisual = {
  setState(state: MotionState): void;
  setMetrics(metrics: VoiceVisualMetrics): void;
  setVisible(visible: boolean): void;
  resize(): void;
  start(): void;
  stop(): void;
  destroy(): void;
};

/**
 * Cada estado tem cor e ritmo próprios. Antes tudo era ciano andando na mesma cadência, e o
 * visual não dizia nada sobre o que estava acontecendo — só que algo estava.
 */
export const STATE_MOOD: Record<MotionState, [number, number, number]> = {
  idle: [0.35, 0.84, 0.80],
  listening: [0.35, 0.88, 0.99],
  thinking: [0.55, 0.52, 0.95],
  speaking: [0.45, 0.88, 0.72],
  acting: [0.99, 0.72, 0.35],
  waiting: [0.95, 0.76, 0.38],
  paused: [0.55, 0.60, 0.62],
  error: [0.95, 0.42, 0.42],
  complete: [0.52, 0.92, 0.62],
};

/** Ritmo por estado — o que o volume jamais deve controlar. */
export const STATE_PACE: Record<MotionState, number> = {
  idle: 0.45, listening: 0.8, thinking: 1.35, speaking: 1.0, acting: 1.6,
  waiting: 0.6, paused: 0.22, error: 0.5, complete: 1.1,
};

/** Ordem estável: o shader recebe o estado como número e compara com estes índices. */
export const STATE_INDEX: Record<MotionState, number> = {
  idle: 0, listening: 1, thinking: 2, speaking: 3, acting: 4, waiting: 5, paused: 6, error: 7, complete: 8,
};

const VERTEX = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

/**
 * Prelúdio compartilhado: ruído, fBm e as operações de SDF que dão o aspecto orgânico.
 *
 * O ruído é hash + interpolação em vez de textura de permutação — cabe em poucas linhas, não
 * precisa de asset, e a diferença visual depois do domain warping é invisível.
 */
export const GLSL_PRELUDE = `
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uEnergy;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uSpeaking;
uniform float uState;
uniform float uListening;
uniform float uAgent;
uniform vec3 uSignal;
uniform vec3 uAccent;
uniform float uAlpha;
uniform float uPace;
uniform vec3 uMood;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }


float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 5; octave++) {
    value += amplitude * noise(p);
    p *= 2.02;
    amplitude *= 0.5;
  }
  return value;
}

/** Oscilador sem período: soma de ruído em três escalas incomensuráveis entre si. */
float drift(float seed, float speed) {
  float t = uTime * speed;
  return (fbm(vec2(t, seed)) + fbm(vec2(t * 0.4142, seed + 11.3)) * 0.6 + fbm(vec2(t * 0.2361, seed + 27.9)) * 0.35) / 1.95;
}

/** O mesmo, centrado em zero: serve onde antes havia sin(). */
float wander(float seed, float speed) { return drift(seed, speed) * 2.0 - 1.0; }

/** Distorce as coordenadas com outro campo de ruído: é daqui que vem a sensação de líquido. */
vec2 warp(vec2 p, float amount, float time) {
  vec2 offset = vec2(fbm(p + vec2(0.0, time * 0.15)), fbm(p + vec2(5.2, 1.3 - time * 0.11)));
  return p + (offset - 0.5) * amount;
}

/** União suave de primitivas: funde as bolhas sem deixar a interseção dura aparecer. */
float smoothMin(float first, float second, float radius) {
  float amount = clamp(0.5 + 0.5 * (second - first) / radius, 0.0, 1.0);
  return mix(second, first, amount) - radius * amount * (1.0 - amount);
}

float circle(vec2 p, vec2 center, float radius) { return length(p - center) - radius; }
`;

type Uniforms = Record<string, WebGLUniformLocation | null>;

const parseColor = (hex: string): [number, number, number] => {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((char) => char + char).join("") : value;
  const number = parseInt(full, 16);
  return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255];
};

export type ShaderVisualOptions = { signal?: string; accent?: string; reducedMotion?: boolean };

/**
 * Um quad que cobre a tela e um fragment shader. Não há geometria, câmera nem cena — por isso
 * uma biblioteca 3D não se paga aqui: seria um runtime inteiro para desenhar um retângulo.
 */
export class ShaderVisual implements VoiceVisual {
  private readonly canvas: HTMLCanvasElement;
  private readonly fragment: string;
  private readonly options: Required<ShaderVisualOptions>;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: Uniforms = {};
  private buffer: WebGLBuffer | null = null;
  private readonly target = { energy: 0, bass: 0, mid: 0, high: 0, speaking: 0 };
  private readonly current = { energy: 0, bass: 0, mid: 0, high: 0, speaking: 0 };
  private state: MotionState = "idle";
  private stateValue = 0;
  private listening = 0;
  private agent = 0;
  private time = 0;
  private pace = 1;
  private readonly mood: [number, number, number] = [0, 0, 0];
  private raf = 0;
  private lastFrame = 0;
  private visible = true;
  private failed = false;

  constructor(canvas: HTMLCanvasElement, fragment: string, options: ShaderVisualOptions = {}) {
    this.canvas = canvas;
    this.fragment = `${GLSL_PRELUDE}\n${fragment}`;
    this.options = { signal: options.signal ?? "#58d8cd", accent: options.accent ?? "#8b7bf0", reducedMotion: options.reducedMotion ?? false };
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.setup();
  }

  /** Quem chama precisa saber se o shader subiu, para cair no renderer 2D em vez de mostrar nada. */
  get ok() { return !this.failed && !!this.program; }

  private onContextLost = (event: Event) => { event.preventDefault(); this.stop(); this.program = null; };
  private onContextRestored = () => { this.setup(); this.start(); };

  private setup() {
    const gl = this.canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: "low-power" });
    if (!gl) { this.failed = true; return; }
    this.gl = gl;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        this.failed = true;
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl.FRAGMENT_SHADER, this.fragment);
    if (!vertex || !fragment) return;

    const program = gl.createProgram();
    if (!program) { this.failed = true; return; }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { this.failed = true; return; }

    this.program = program;
    gl.useProgram(program);

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    for (const name of ["uResolution", "uTime", "uEnergy", "uBass", "uMid", "uHigh", "uSpeaking", "uState", "uListening", "uAgent", "uSignal", "uAccent", "uAlpha", "uPace", "uMood"]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.resize();
  }

  setState(state: MotionState) { this.state = state; }
  setMetrics(metrics: VoiceVisualMetrics = emptyVoiceMetrics()) {
    this.target.energy = metrics.energy;
    this.target.bass = metrics.bass;
    this.target.mid = metrics.mid;
    this.target.high = metrics.high;
    this.target.speaking = metrics.speaking ? 1 : 0;
  }
  setVisible(visible: boolean) { this.visible = visible; if (visible && !this.raf) this.start(); }

  resize() {
    const gl = this.gl;
    if (!gl) return;
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  start() {
    if (this.raf || !this.program) return;
    if (this.options.reducedMotion) { this.draw(0); return; }
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.render);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
  destroy() {
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    const gl = this.gl;
    if (gl && this.program) gl.deleteProgram(this.program);
    if (gl && this.buffer) gl.deleteBuffer(this.buffer);
    this.program = null;
  }

  private render = (now: number) => {
    this.raf = 0;
    if (!this.visible) return;
    const delta = Math.min(48, now - this.lastFrame);
    this.lastFrame = now;
    this.pace += (STATE_PACE[this.state] - this.pace) * Math.min(1, delta / 1000 * 2.2);
    this.time += (delta / 1000) * this.pace;
    this.draw(delta);
    this.raf = requestAnimationFrame(this.render);
  };

  /**
   * Segundo estágio de suavização, depois do envelope do analisador. É o que dá massa: o valor
   * persegue o alvo em vez de saltar para ele, e o objeto deixa de tremer como um VU meter.
   */
  private draw(delta: number) {
    const gl = this.gl;
    if (!gl || !this.program) return;
    const ease = Math.min(1, delta / 1000 * 9);
    for (const key of ["energy", "bass", "mid", "high", "speaking"] as const) {
      this.current[key] += (this.target[key] - this.current[key]) * (ease || 1);
    }
    const target = STATE_MOOD[this.state];
    for (let channel = 0; channel < 3; channel += 1) {
      this.mood[channel] += (target[channel] - this.mood[channel]) * Math.min(1, delta / 1000 * 2.6);
    }
    const index = STATE_INDEX[this.state];
    this.stateValue += (index - this.stateValue) * Math.min(1, delta / 1000 * 6);
    this.listening += ((this.state === "listening" ? 1 : 0) - this.listening) * Math.min(1, delta / 1000 * 5);
    this.agent += ((this.state === "speaking" ? 1 : 0) - this.agent) * Math.min(1, delta / 1000 * 5);

    gl.useProgram(this.program);
    gl.uniform2f(this.uniforms.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.uTime, this.time);
    gl.uniform1f(this.uniforms.uEnergy, this.current.energy);
    gl.uniform1f(this.uniforms.uBass, this.current.bass);
    gl.uniform1f(this.uniforms.uMid, this.current.mid);
    gl.uniform1f(this.uniforms.uHigh, this.current.high);
    gl.uniform1f(this.uniforms.uSpeaking, this.current.speaking);
    gl.uniform1f(this.uniforms.uState, this.stateValue);
    gl.uniform1f(this.uniforms.uListening, this.listening);
    gl.uniform1f(this.uniforms.uAgent, this.agent);
    gl.uniform1f(this.uniforms.uAlpha, 1);
    gl.uniform1f(this.uniforms.uPace, this.pace);
    gl.uniform3fv(this.uniforms.uMood, this.mood);
    gl.uniform3fv(this.uniforms.uSignal, parseColor(this.options.signal));
    gl.uniform3fv(this.uniforms.uAccent, parseColor(this.options.accent));

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
