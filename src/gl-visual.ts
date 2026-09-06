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
  idle: [0.32, 0.55, 0.58],
  // Quem está falando é a informação mais importante da tela, então "você" e "ela" ficam em
  // extremos opostos de temperatura: azul frio contra âmbar quente. Matizes vizinhos não servem.
  listening: [0.20, 0.58, 1.00],
  thinking: [0.60, 0.38, 0.94],
  speaking: [1.00, 0.64, 0.20],
  // Agindo usa exatamente o ciano da moldura de controle: são a mesma coisa acontecendo.
  acting: [0.345, 0.847, 0.804],
  waiting: [0.93, 0.80, 0.42],
  paused: [0.48, 0.53, 0.55],
  error: [0.42, 0.07, 0.15],
  complete: [0.35, 0.90, 0.55],
};

/**
 * O caráter do movimento, por estado. Ritmo é só a velocidade; o resto é o jeito de se mover.
 *
 * - `inward` positivo contrai (o usuário fala e a forma absorve), negativo expande (a Vela emite)
 * - `spin` gira o campo interno sem mexer na silhueta — é o que faz "pensando" parecer pensar
 * - `turbulence` mede a agitação da superfície
 * - `cohesion` abaixo de 1 deixa as partes se soltarem: é como o erro se desfaz
 */
export type StateCharacter = {
  pace: number;
  spin: number;
  inward: number;
  turbulence: number;
  cohesion: number;
  /** Ondas concêntricas viajando para o centro — a forma absorve o que você diz. */
  waveIn: number;
  /** Ondas saindo do centro — a forma emite. */
  waveOut: number;
  /** Faixas girando por dentro sem mexer na silhueta. */
  bands: number;
  /** Fatias angulares deslocadas: a forma perde a inteireza. */
  shatter: number;
};

export const STATE_CHARACTER: Record<MotionState, StateCharacter> = {
  idle:      { pace: 0.40, spin:  0.08, inward:  0.00, turbulence: 0.22, cohesion: 1.00, waveIn: 0.00, waveOut: 0.10, bands: 0.00, shatter: 0.00 },
  listening: { pace: 0.85, spin:  0.16, inward:  0.75, turbulence: 0.38, cohesion: 1.00, waveIn: 1.00, waveOut: 0.00, bands: 0.00, shatter: 0.00 },
  thinking:  { pace: 1.30, spin:  1.00, inward:  0.18, turbulence: 0.42, cohesion: 0.96, waveIn: 0.00, waveOut: 0.00, bands: 1.00, shatter: 0.00 },
  speaking:  { pace: 1.00, spin:  0.32, inward: -0.65, turbulence: 0.52, cohesion: 1.00, waveIn: 0.00, waveOut: 1.00, bands: 0.00, shatter: 0.00 },
  acting:    { pace: 1.70, spin:  0.55, inward: -0.28, turbulence: 0.85, cohesion: 0.90, waveIn: 0.00, waveOut: 0.45, bands: 0.55, shatter: 0.00 },
  waiting:   { pace: 0.55, spin:  0.04, inward:  0.30, turbulence: 0.18, cohesion: 1.00, waveIn: 0.35, waveOut: 0.00, bands: 0.00, shatter: 0.00 },
  paused:    { pace: 0.20, spin:  0.00, inward:  0.10, turbulence: 0.08, cohesion: 1.00, waveIn: 0.00, waveOut: 0.00, bands: 0.00, shatter: 0.00 },
  error:     { pace: 0.55, spin: -0.45, inward:  0.15, turbulence: 1.00, cohesion: 0.50, waveIn: 0.00, waveOut: 0.00, bands: 0.00, shatter: 1.00 },
  complete:  { pace: 1.05, spin:  0.22, inward: -0.42, turbulence: 0.30, cohesion: 1.00, waveIn: 0.00, waveOut: 0.80, bands: 0.00, shatter: 0.00 },
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
uniform float uSpin;
uniform float uInward;
uniform float uTurbulence;
uniform float uCohesion;
uniform float uWaveIn;
uniform float uWaveOut;
uniform float uBands;
uniform float uShatter;

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

/**
 * Ondas concêntricas viajando para dentro ou para fora. A amplitude é modulada por ruído para a
 * onda não virar um metrônomo visível.
 */
float ripple(vec2 p, float speed, float density) {
  float distance = length(p);
  float phase = distance * density - uTime * speed;
  return sin(phase) * (0.6 + drift(distance * 3.0, 0.8) * 0.7);
}

/** Faixas girando por dentro: o desenho de "pensando". */
float bandsAt(vec2 p, float count) {
  float angle = atan(p.y, p.x);
  return sin(angle * count + uSpin * 5.0 + drift(angle, 0.5) * 2.0);
}

/** Desloca fatias angulares em direções aleatórias: a forma deixa de ser uma só. */
vec2 shatterAt(vec2 p, float amount) {
  if (amount < 0.001) return p;
  float slice = floor((atan(p.y, p.x) + 3.14159) / 0.9);
  vec2 kick = vec2(hash(vec2(slice, 1.7)), hash(vec2(slice, 9.3))) - 0.5;
  return p + kick * amount * (0.05 + drift(slice, 0.7) * 0.09);
}

vec2 rotate(vec2 p, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return mat2(c, -s, s, c) * p;
}
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
 * WebGL disponível? Testado num canvas descartável de propósito: um canvas só aceita um tipo de
 * contexto para sempre, então sondar no canvas real o queimaria para o renderer 2D de reserva.
 */
export function shadersAvailable(): boolean {
  try {
    const probe = document.createElement("canvas");
    return !!probe.getContext("webgl", { failIfMajorPerformanceCaveat: false });
  } catch {
    return false;
  }
}

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
  private spinAngle = 0;
  private readonly character: StateCharacter = { ...STATE_CHARACTER.idle };
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

    for (const name of ["uResolution", "uTime", "uEnergy", "uBass", "uMid", "uHigh", "uSpeaking", "uState", "uListening", "uAgent", "uSignal", "uAccent", "uAlpha", "uPace", "uMood", "uSpin", "uInward", "uTurbulence", "uCohesion", "uWaveIn", "uWaveOut", "uBands", "uShatter"]) {
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
    // Transição contínua entre caracteres: trocar de estado não pode dar um salto na forma.
    const target = STATE_CHARACTER[this.state];
    const blend = Math.min(1, delta / 1000 * 2.2);
    for (const key of ["pace", "spin", "inward", "turbulence", "cohesion", "waveIn", "waveOut", "bands", "shatter"] as const) {
      this.character[key] += (target[key] - this.character[key]) * blend;
    }
    this.time += (delta / 1000) * this.character.pace;
    this.spinAngle += (delta / 1000) * this.character.spin;
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
    const mood = STATE_MOOD[this.state];
    for (let channel = 0; channel < 3; channel += 1) {
      this.mood[channel] += (mood[channel] - this.mood[channel]) * Math.min(1, delta / 1000 * 2.6);
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
    gl.uniform1f(this.uniforms.uPace, this.character.pace);
    gl.uniform1f(this.uniforms.uSpin, this.spinAngle);
    gl.uniform1f(this.uniforms.uInward, this.character.inward);
    gl.uniform1f(this.uniforms.uTurbulence, this.character.turbulence);
    gl.uniform1f(this.uniforms.uCohesion, this.character.cohesion);
    gl.uniform1f(this.uniforms.uWaveIn, this.character.waveIn);
    gl.uniform1f(this.uniforms.uWaveOut, this.character.waveOut);
    gl.uniform1f(this.uniforms.uBands, this.character.bands);
    gl.uniform1f(this.uniforms.uShatter, this.character.shatter);
    gl.uniform3fv(this.uniforms.uMood, this.mood);
    gl.uniform3fv(this.uniforms.uSignal, parseColor(this.options.signal));
    gl.uniform3fv(this.uniforms.uAccent, parseColor(this.options.accent));

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
