import { STATE_CHARACTER, STATE_MOOD, ShaderVisual, ShaderVisualOptions, VoiceVisual } from "./gl-visual";
import { VelaOrbRenderer } from "./orb-renderer";
import { MotionState } from "./motion-tokens";
import { VoiceVisualMetrics, emptyVoiceMetrics } from "./audio-metrics";

/**
 * Os cinco visuais recebem exatamente os mesmos sinais. Trocar entre eles é trocar a classe;
 * nada acima muda. É o que permite decidir a estética falando no microfone em vez de olhando
 * screenshot.
 */

/** 04 — Blob líquido: metaballs em SDF, fundidas por smooth-min, com as coordenadas distorcidas. */
const LIQUID_BLOB = `
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / min(uResolution.x, uResolution.y);
  // Erro parte a silhueta em fatias que se afastam.
  uv = shatterAt(uv, uShatter);

  float breath = wander(3.7, 0.11) * 0.02;
  float base = 0.30 + breath - uInward * 0.055 + uEnergy * 0.085 + uBass * 0.04;

  float flow = uTime * 0.16;
  vec2 field = rotate(uv, uSpin);
  vec2 warped = warp(field * 1.6 + vec2(flow * 0.5, wander(9.1, 0.07) * 0.3), (0.22 + uTurbulence * 0.5) + uMid * 0.4, flow);

  float shape = circle(uv, vec2(0.0), base);
  for (int index = 0; index < 4; index++) {
    float seed = float(index) * 7.31;
    vec2 orbit = vec2(wander(seed, 0.13), wander(seed + 41.7, 0.11));
    vec2 center = rotate(orbit, uSpin * 1.4) * (0.13 + uMid * 0.16 + (1.0 - uCohesion) * 0.34);
    float radius = (0.085 + drift(seed + 3.3, 0.09) * 0.05) * (0.75 + uHigh * 0.85);
    shape = smoothMin(shape, circle(uv, center, radius), (0.03 + uCohesion * 0.11) + uEnergy * 0.06);
  }
  shape += (fbm(warped * 2.4) - 0.5) * (0.02 + uTurbulence * 0.05 + uHigh * 0.06);

  // O gesto do estado: ondas para dentro quando ouve, para fora quando fala.
  float ondas = ripple(uv, 2.6, 24.0) * (uWaveIn * -1.0 + uWaveOut) * (0.006 + uEnergy * 0.014);
  shape += ondas;

  float body = smoothstep(0.012, -0.012, shape);
  float rim = smoothstep(0.07, 0.0, abs(shape)) * (0.45 + uEnergy * 1.1);
  float glow = exp(-max(shape, 0.0) * 12.0) * (0.22 + uEnergy * 0.5);

  float depth = fbm(warped * 3.0 + flow);
  float faixas = bandsAt(field, 4.0) * 0.5 + 0.5;

  // Densidade, não claridade: energia escurece e satura o miolo.
  vec3 nucleo = uMood * (0.95 - uEnergy * 0.42) * (0.55 + depth * 0.5) * (1.0 + faixas * uBands * 0.28);
  vec3 borda = uMood * (1.15 + uEnergy * 0.35);
  vec3 color = nucleo * body + borda * rim * 0.9 + uMood * glow * 0.45;

  float alpha = clamp(body + rim * 0.8 + glow * 0.5, 0.0, 1.0) * uAlpha;
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

/** 05 — Campo de energia: fBm com domain warping ocupando a tela inteira, tipo aurora. */
const ENERGY_FIELD = `
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 point = rotate((uv - 0.5) * aspect, uSpin * 0.35);
  point = shatterAt(point, uShatter * 0.6);
  float flow = uTime * 0.09;

  vec2 wanderOffset = vec2(wander(2.3, 0.06), wander(17.7, 0.05)) * 0.4;
  vec2 warped = warp(point * 2.2 + wanderOffset + vec2(flow, flow * 0.4), 0.4 + uTurbulence * 0.7 + uBass * 0.9, flow);
  float field = fbm(warped * 1.8 + vec2(0.0, flow * 1.6));
  float ridge = abs(field - 0.5) * 2.0;
  float veil = pow(1.0 - ridge, 1.6 + (1.0 - uTurbulence) * 2.4 + uMid * 1.6);
  veil *= 1.0 + ripple(point, 2.0, 14.0) * (uWaveIn * -1.0 + uWaveOut) * 0.25;
  veil *= 1.0 + bandsAt(point, 3.0) * uBands * 0.3;

  float reach = 0.95 - uInward * 0.28;
  float center = 1.0 - smoothstep(0.0, reach, length(point));
  float intensity = veil * center * (0.24 + uEnergy * 1.35);

  vec3 color = uMood * (1.05 - uEnergy * 0.3) + uMood * pow(veil, 6.0) * uHigh * 0.7;
  float alpha = clamp(intensity, 0.0, 1.0) * uAlpha;
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

/** 02 — Mesh gradient: focos de cor que passeiam devagar, como o fundo do Kimi. */
const MESH_FIELD = `
vec3 blob(vec2 point, vec2 center, vec3 color, float radius, float strength) {
  float distance = length(point - center);
  return color * exp(-distance * distance / (radius * radius)) * strength;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 point = rotate((uv - 0.5) * aspect, uSpin * 0.25);
  point = shatterAt(point, uShatter * 0.5);
  float flow = uTime * 0.07;

  vec2 wanderOffset = (vec2(fbm(point * 1.2 + flow), fbm(point * 1.2 - flow + 3.1)) - 0.5) * (0.12 + uTurbulence * 0.3 + uMid * 0.3);
  vec2 field = point + wanderOffset;

  float lift = (0.3 + uEnergy * 0.85) * (1.0 + ripple(point, 1.8, 10.0) * (uWaveIn * -1.0 + uWaveOut) * 0.2);
  float spread = 0.42 - uInward * 0.14;
  float size = 0.44 - uInward * 0.08;

  vec3 quente = uMood * vec3(1.25, 0.9, 0.7);
  vec3 fria = uMood * vec3(0.7, 0.95, 1.2);

  vec3 color = vec3(0.0);
  color += blob(field, vec2(wander(1.1, 0.09), wander(5.4, 0.08)) * spread, fria, size, lift);
  color += blob(field, vec2(wander(13.2, 0.07), wander(23.8, 0.1)) * spread, quente, size * 0.9, lift * (0.6 + uAgent * 0.7));
  color += blob(field, vec2(wander(31.6, 0.11), wander(47.2, 0.06)) * spread * 0.8, uMood, size * 0.78, lift * 0.8);
  color += blob(field, vec2(wander(59.3, 0.05) * 0.2, -0.45 + uBass * 0.12), uMood, 0.5, lift * (0.4 + uListening * 0.9));

  // Satura em vez de estourar: sem isto, dois focos somados passam de 1.0 e viram branco.
  color = color / (1.0 + color * (0.35 + uEnergy * 0.55));

  float grain = (hash(gl_FragCoord.xy + uTime) - 0.5) * (0.012 + uTurbulence * 0.03);
  float alpha = clamp(max(max(color.r, color.g), color.b), 0.0, 1.0) * uAlpha;
  gl_FragColor = vec4((color + grain) * alpha, alpha);
}
`;

/** 03 — Orb suave: uma esfera só, deformada por ruído. O parente próximo do orb do ChatGPT. */
const SOFT_ORB = `
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / min(uResolution.x, uResolution.y);
  uv = shatterAt(uv, uShatter);
  float flow = uTime * 0.13;
  float radius = 0.31 + wander(2.9, 0.10) * 0.016 + uEnergy * 0.07 - uInward * 0.035;

  vec2 field = rotate(uv, uSpin);
  float angle = atan(field.y, field.x);
  float wobble = fbm(vec2(cos(angle), sin(angle)) * 2.4 + flow) - 0.5;
  float distance = length(uv) - radius - wobble * (0.02 + uTurbulence * 0.055 + uMid * 0.08);
  distance += ripple(uv, 2.2, 20.0) * (uWaveIn * -1.0 + uWaveOut) * (0.005 + uEnergy * 0.012);

  float edge = mix(0.075, 0.008, uCohesion);
  float body = smoothstep(edge, -0.02, distance);
  // O brilho interno para de puxar para o branco: vira um tom claro da própria cor.
  float sheen = smoothstep(0.05, -0.34, field.y + fbm(field * 3.0 + flow) * 0.2);
  float glow = exp(-max(distance, 0.0) * 9.0) * (0.22 + uEnergy * 0.55);
  float faixas = bandsAt(field, 5.0) * 0.5 + 0.5;

  vec3 nucleo = uMood * (0.9 - uEnergy * 0.38) * (1.0 + faixas * uBands * 0.22);
  vec3 alto = mix(uMood, uMood * 1.6 + vec3(0.12), 0.55);
  vec3 color = mix(nucleo, alto, sheen * (0.45 - uEnergy * 0.18)) * body + uMood * glow * 0.5;
  float alpha = clamp(body + glow * 0.55, 0.0, 1.0) * uAlpha;
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

/**
 * 01 — Ambient edge: o halo que percorre a borda do painel.
 *
 * Canvas 2D de propósito. É uma faixa fina na moldura de uma barra lateral que fica aberta o dia
 * inteiro — pagar um contexto WebGL por isso seria caro pelo que se vê.
 */
export class AmbientEdgeVisual implements VoiceVisual {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly options: Required<ShaderVisualOptions>;
  private readonly target = { energy: 0, bass: 0, mid: 0, high: 0 };
  private readonly current = { energy: 0, bass: 0, mid: 0, high: 0 };
  private state: MotionState = "idle";
  private time = 0;
  private raf = 0;
  private lastFrame = 0;
  private visible = true;

  constructor(canvas: HTMLCanvasElement, options: ShaderVisualOptions = {}) {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Canvas 2D indisponível");
    this.canvas = canvas;
    this.context = context;
    this.options = { signal: options.signal ?? "#58d8cd", accent: options.accent ?? "#8b7bf0", reducedMotion: options.reducedMotion ?? false };
    this.resize();
  }

  setState(state: MotionState) { this.state = state; }
  setMetrics(metrics: VoiceVisualMetrics = emptyVoiceMetrics()) {
    this.target.energy = metrics.energy; this.target.bass = metrics.bass; this.target.mid = metrics.mid; this.target.high = metrics.high;
  }
  setVisible(visible: boolean) { this.visible = visible; if (visible && !this.raf) this.start(); }
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  start() {
    if (this.raf) return;
    if (this.options.reducedMotion) { this.draw(0); return; }
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.render);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
  destroy() { this.stop(); }

  private render = (now: number) => {
    this.raf = 0;
    if (!this.visible) return;
    const delta = Math.min(48, now - this.lastFrame);
    this.lastFrame = now;
    this.time += delta / 1000;
    this.draw(delta);
    this.raf = requestAnimationFrame(this.render);
  };

  /** A cor vem do estado: erro em vermelho, agindo em âmbar, ouvindo em ciano. */
  private stateColor() {
    const [red, green, blue] = STATE_MOOD[this.state];
    const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0");
    return `#${channel(red)}${channel(green)}${channel(blue)}`;
  }

  private draw(delta: number) {
    const ease = Math.min(1, delta / 1000 * 8) || 1;
    for (const key of ["energy", "bass", "mid", "high"] as const) {
      this.current[key] += (this.target[key] - this.current[key]) * ease;
    }
    const rect = this.canvas.getBoundingClientRect();
    const { width, height } = rect;
    const ctx = this.context;
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";

    // A borda bebe da mesma tabela dos shaders: um estado tem um caráter só, em qualquer renderer.
    const character = STATE_CHARACTER[this.state];
    const speed = (STATE_SPEED[this.state] ?? 0.16) * (0.5 + character.pace * 0.5);
    // Sem microfone aberto não há energia nenhuma, e a borda ficaria apagada justamente quando o
    // agente está trabalhando. O estado sozinho já acende: energia é o que faz a luz respirar.
    const pulse = noiseAt(this.time * (0.22 + character.pace * 0.2)) * (0.18 + character.turbulence * 0.3);
    const stateEnergy = (STATE_ENERGY[this.state] ?? 0.12) * (0.72 + pulse);
    const intensity = stateEnergy + this.current.energy * 0.7;
    // Contrai quando ouve, espalha quando fala — o mesmo inward dos shaders.
    const spread = Math.max(width, height) * (0.5 - character.inward * 0.12 + this.current.bass * 0.28);

    // Dois focos em fases opostas percorrendo o perímetro: a luz nunca "pisca" ao dar a volta.
    for (let index = 0; index < 2; index += 1) {
      const phase = (this.time * speed + index * 0.5) % 1;
      const point = perimeterPoint(phase, width, height);
      const color = index === 0 ? this.stateColor() : this.options.accent;
      const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, spread);
      gradient.addColorStop(0, withAlpha(color, intensity * (index === 0 ? 1 : 0.62 + this.current.high * 0.5)));
      gradient.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.globalCompositeOperation = "source-over";
  }
}

const STATE_SPEED: Partial<Record<MotionState, number>> = {
  idle: 0.012, listening: 0.05, thinking: 0.055, speaking: 0.045, acting: 0.085, waiting: 0.03, paused: 0.01, error: 0.02, complete: 0.07,
};

const STATE_ENERGY: Partial<Record<MotionState, number>> = {
  idle: 0.05, listening: 0.30, thinking: 0.34, speaking: 0.38, acting: 0.46, waiting: 0.34, paused: 0.10, error: 0.30, complete: 0.40,
};

/** Ruído 1D com interpolação suave: oscila sem repetir, ao contrário de uma senoide. */
function noiseAt(position: number) {
  const cell = Math.floor(position);
  const fraction = position - cell;
  const smooth = fraction * fraction * (3 - 2 * fraction);
  const at = (index: number) => { const value = Math.sin(index * 127.1) * 43758.5453; return value - Math.floor(value); };
  return at(cell) * (1 - smooth) + at(cell + 1) * smooth;
}

/** Caminha pelo perímetro do retângulo com uma fase de 0 a 1. */
function perimeterPoint(phase: number, width: number, height: number) {
  const total = (width + height) * 2;
  const distance = phase * total;
  if (distance < width) return { x: distance, y: 0 };
  if (distance < width + height) return { x: width, y: distance - width };
  if (distance < width * 2 + height) return { x: width - (distance - width - height), y: height };
  return { x: 0, y: height - (distance - width * 2 - height) };
}

function withAlpha(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((char) => char + char).join("") : value;
  const number = parseInt(full, 16);
  return `rgba(${(number >> 16) & 255},${(number >> 8) & 255},${number & 255},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

export type VisualId = "ambient-edge" | "mesh-field" | "soft-orb" | "liquid-blob" | "energy-field" | "particle-orb" | "custom";

/**
 * O shader escrito pelo usuário mora em `settings.voice.customShader`, mas o registro de visuais é
 * um array de módulo que ninguém passa settings para. Threadar a string por seis componentes —
 * painel, palco, orb, miniatura, Pulse, opções — poluiria seis assinaturas por causa de um valor
 * que é preferência global, não estado de instância. Fica aqui, e quem carrega as settings avisa.
 */
let customSource = "";
export function setCustomShader(source: string) { customSource = source.trim(); }
export function getCustomShader() { return customSource; }

/**
 * O que a opção mostra enquanto ninguém escreveu nada — e o ponto de partida do editor. Curto de
 * propósito: ensina o contrato (uniforms do prelúdio, `gl_FragColor` com alpha) sem ser um shader
 * que a pessoa tenha medo de mexer.
 */
export const CUSTOM_STARTER = `void main() {
  // Coordenada centrada, com o lado menor valendo 1.
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / min(uResolution.x, uResolution.y);

  // uEnergy é o volume já suavizado; uBass, uMid e uHigh são as três bandas.
  float raio = 0.42 + uEnergy * 0.18 + fbm(uv * 2.0 + uTime * uPace * 0.3) * 0.06;
  float borda = smoothstep(raio, raio - 0.14, length(uv));

  // uMood é a cor do estado (azul ouvindo, âmbar falando); uSignal é a cor da marca.
  vec3 cor = mix(uSignal, uMood, 0.65) + uHigh * 0.25;

  gl_FragColor = vec4(cor * borda, borda * uAlpha);
}`;

export type VisualEntry = {
  id: VisualId;
  name: string;
  description: string;
  technique: string;
  webgl: boolean;
  create: (canvas: HTMLCanvasElement, options: ShaderVisualOptions) => VoiceVisual;
};

export const VISUALS: VisualEntry[] = [
  {
    id: "ambient-edge",
    name: "01 · Ambient Edge",
    description: "Luz percorrendo a borda do painel. Não desenha um objeto: acende a moldura.",
    technique: "canvas 2D · gradiente radial + blend aditivo",
    webgl: false,
    create: (canvas, options) => new AmbientEdgeVisual(canvas, options),
  },
  {
    id: "mesh-field",
    name: "02 · Mesh Field",
    description: "Campo de cor que se move devagar atrás do conteúdo, como o fundo do Kimi.",
    technique: "shader · focos gaussianos + domain warping",
    webgl: true,
    create: (canvas, options) => new ShaderVisual(canvas, MESH_FIELD, options),
  },
  {
    id: "soft-orb",
    name: "03 · Soft Orb",
    description: "Uma esfera só, deformada por ruído, com brilho interno. O parente do orb do ChatGPT.",
    technique: "shader · SDF de círculo + fBm na borda",
    webgl: true,
    create: (canvas, options) => new ShaderVisual(canvas, SOFT_ORB, options),
  },
  {
    id: "liquid-blob",
    name: "04 · Liquid Blob",
    description: "Bolhas internas que se fundem e se separam. É o mais “vivo” dos cinco.",
    technique: "shader · metaballs + smooth-min + domain warping",
    webgl: true,
    create: (canvas, options) => new ShaderVisual(canvas, LIQUID_BLOB, options),
  },
  {
    id: "energy-field",
    name: "05 · Energy Field",
    description: "Aurora abstrata ocupando a tela. Sem forma definida, só movimento e cor.",
    technique: "shader · fBm em cristas + domain warping",
    webgl: true,
    create: (canvas, options) => new ShaderVisual(canvas, ENERGY_FIELD, options),
  },
  {
    id: "particle-orb",
    name: "00 · Orb atual",
    description: "O que está no produto hoje, para comparação honesta.",
    technique: "canvas 2D · 72 partículas orbitais",
    webgl: false,
    create: (canvas, options) => new VelaOrbRenderer(canvas, { color: options.signal, reducedMotion: options.reducedMotion }),
  },
  {
    id: "custom",
    name: "06 · Seu shader",
    description: "O visual que você escrever. O código fica em Configurações → Voz, e vale para o painel, o palco e a janelinha.",
    technique: "shader · seu fragment, com o mesmo prelúdio dos outros",
    webgl: true,
    create: (canvas, options) => new ShaderVisual(canvas, customSource || CUSTOM_STARTER, options),
  },
];
