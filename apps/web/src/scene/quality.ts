export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

/** How the frame is finished. 'sharp' is the default; 'pixel' is the stylised look. */
export type RenderStyle = 'sharp' | 'pixel';

export type QualitySettings = {
  /** Terrain grid divisions. Dominates triangle count. */
  segments: number;
  /** Fraction of the viewport the world is drawn at before being blitted up. */
  renderScale: number;
  maxPixelRatio: number;
  trees: number;
  cloudLayers: number;
  /** Raymarch steps through the cloud decks. 0 falls back to the cheap layers. */
  cloudSteps: number;
  people: number;
  /** Boats are built models now, not instances, so this is deliberately tiny. */
  boats: number;
  /** Hand-built trees standing in front of the viewer, above the cone field. */
  nearTrees: number;
  birds: number;
  /** Rain drops kept alive around the viewer. */
  raindrops: number;
  /** Vehicles across the whole road network. */
  vehicles: number;
  /** Streams traced down the terrain, and whether their spray is simulated. */
  streams: number;
  spray: boolean;
  /** Shadow map resolution; 0 turns shadows off entirely. */
  shadowMap: number;
  /**
   * Samples per radial pass of the crepuscular rays; 0 turns them off. Two
   * passes run, so the reach is roughly this squared rather than this, and the
   * cost is two full-screen passes at half resolution either way.
   */
  sunShafts: number;
  /** Villagers. Every one is a rigged figure now, so this is a much smaller
   * number than when they were instanced cones. */
  /** Grass tufts kept alive around the viewer. */
  grass: number;
};

/**
 * Rendering at 40–60% and upscaling kept weak devices alive but made everything
 * look soft, which is the first thing anyone notices. Sharp is now the default
 * and draws at full resolution; the pixel look is a style you choose, and it is
 * also what rescues a slow machine.
 */
export const QUALITY_SETTINGS: Record<QualityTier, QualitySettings> = {
  low: {
    segments: 192,
    renderScale: 0.6,
    maxPixelRatio: 1,
    trees: 3000,
    cloudLayers: 3,
    cloudSteps: 0,
    people: 24,
    boats: 2,
    nearTrees: 0,
    birds: 14,
    shadowMap: 0,
    grass: 4000,
    raindrops: 900,
    vehicles: 4,
    streams: 2,
    spray: false,
    sunShafts: 0,
  },
  medium: {
    segments: 288,
    renderScale: 0.85,
    maxPixelRatio: 1.5,
    trees: 7000,
    cloudLayers: 4,
    cloudSteps: 6,
    people: 40,
    boats: 3,
    nearTrees: 8,
    birds: 26,
    shadowMap: 1024,
    grass: 15000,
    raindrops: 2600,
    vehicles: 8,
    streams: 4,
    spray: true,
    sunShafts: 4,
  },
  high: {
    segments: 416,
    renderScale: 1,
    maxPixelRatio: 2,
    trees: 12000,
    cloudLayers: 5,
    cloudSteps: 10,
    people: 56,
    boats: 4,
    nearTrees: 14,
    birds: 42,
    shadowMap: 2048,
    grass: 32000,
    raindrops: 5200,
    vehicles: 12,
    streams: 6,
    spray: true,
    sunShafts: 6,
  },
  ultra: {
    segments: 560,
    renderScale: 1,
    maxPixelRatio: 2,
    trees: 17000,
    cloudLayers: 6,
    cloudSteps: 16,
    people: 64,
    boats: 5,
    nearTrees: 20,
    birds: 56,
    shadowMap: 4096,
    grass: 52000,
    raindrops: 8000,
    vehicles: 16,
    streams: 8,
    spray: true,
    sunShafts: 8,
  },
};

/** The pixel style always draws small, whatever the tier, because that is the look. */
export const PIXEL_RENDER_SCALE = 0.45;

const TIERS: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

/** Side of the probe target, in pixels. Big enough that fill rate, not setup, dominates. */
const PROBE_SIDE = 384;
/** Fragment-shader iterations per pixel. */
const PROBE_LOOP = 48;
/** Passes to time, and the budget that stops a slow machine being measured for a second. */
const PROBE_PASSES = 4;
const PROBE_BUDGET_MS = 45;

const PROBE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uSeed;
  void main() {
    // Work the driver cannot fold away: the result has to depend on the pixel
    // and on a uniform, or the compiler drops the loop and the probe measures
    // nothing at all.
    float acc = uSeed;
    for (int i = 0; i < ${PROBE_LOOP}; i += 1) {
      acc += sin(gl_FragCoord.x * 0.017 + acc) * cos(gl_FragCoord.y * 0.013 - acc);
    }
    gl_FragColor = vec4(fract(acc), 0.0, 0.0, 1.0);
  }
`;

type GpuProfile = {
  /** Unmasked renderer string, lowercased. Empty when the driver will not say. */
  renderer: string;
  maxTexture: number;
  webgl2: boolean;
  /** Milliseconds the GPU took over one fragment-heavy pass. 0 when unmeasurable. */
  fillMs: number;
};

/**
 * Builds a throwaway context, asks it what it is, and then makes it do some
 * work. Reading `hardwareConcurrency` alone put a sixteen-core laptop with Intel
 * integrated graphics on `ultra` and built the entire world at the wrong tier
 * before the first frame — the cores are not what draws the picture.
 */
const probeGpu = (): GpuProfile | null => {
  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;

  try {
    canvas = document.createElement('canvas');
    canvas.width = PROBE_SIDE;
    canvas.height = PROBE_SIDE;

    const gl2 = canvas.getContext('webgl2', { antialias: false, depth: false, powerPreference: 'high-performance' });
    gl = gl2 ?? canvas.getContext('webgl', { antialias: false, depth: false });
    if (!gl) return null;

    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '').toLowerCase() : '';

    return {
      renderer,
      maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) ?? 0),
      webgl2: gl2 !== null,
      fillMs: measureFill(gl),
    };
  } catch {
    return null;
  } finally {
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    canvas?.remove();
  }
};

/**
 * `readPixels` is the measurement, not `draw`: every GL call is queued, so
 * timing around the draw times the queueing. Reading one pixel back blocks until
 * the pass has actually been drawn, which is the only honest number available
 * without a timer-query extension.
 */
const measureFill = (gl: WebGLRenderingContext | WebGL2RenderingContext): number => {
  const program = gl.createProgram();
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  if (!program || !vertex || !fragment) return 0;

  gl.shaderSource(vertex, 'attribute vec2 aAt; void main() { gl_Position = vec4(aAt, 0.0, 1.0); }');
  gl.compileShader(vertex);
  gl.shaderSource(fragment, PROBE_FRAGMENT);
  gl.compileShader(fragment);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return 0;

  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const slot = gl.getAttribLocation(program, 'aAt');
  gl.enableVertexAttribArray(slot);
  gl.vertexAttribPointer(slot, 2, gl.FLOAT, false, 0, 0);

  const seed = gl.getUniformLocation(program, 'uSeed');
  const pixel = new Uint8Array(4);

  const pass = (index: number) => {
    gl.uniform1f(seed, index * 0.37);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  };

  // Discarded: the first pass pays for shader compilation and the first upload.
  pass(0);

  let elapsed = 0;
  let passes = 0;
  while (passes < PROBE_PASSES && elapsed < PROBE_BUDGET_MS) {
    const at = performance.now();
    pass(passes + 1);
    elapsed += performance.now() - at;
    passes += 1;
  }

  gl.deleteBuffer(buffer);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  gl.deleteProgram(program);

  return passes > 0 ? elapsed / passes : 0;
};

/** No hardware path at all, or one that will draw the world on the CPU. */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/;
/** Integrated and mobile parts that cannot hold a high tier whatever the core count says. */
const WEAK = /(?:^|\W)(?:hd|uhd) graphics|intel\(r\) hd|gma |mali-[tg]|adreno \((?:tm\) )?[3-5]|powervr|videocore/;
/** Parts that will hold the top tiers even if the measured pass is noisy. */
const STRONG = /rtx|gtx 1[0-9]{3}|radeon (?:rx|pro)|apple m[1-9]|arc a[0-9]|quadro|radeon r9/;

let detected: QualityTier | null = null;

/**
 * The tier the first load builds the world at. Measured once and remembered:
 * the probe costs a few milliseconds and the answer cannot change inside a
 * session.
 */
export const detectQuality = (): QualityTier => {
  if (typeof window === 'undefined') return 'medium';
  if (detected) return detected;

  const cores = navigator.hardwareConcurrency ?? 4;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const gpu = probeGpu();

  if (!gpu) {
    detected = coarsePointer ? 'low' : 'medium';
    return detected;
  }

  if (SOFTWARE.test(gpu.renderer) || !gpu.webgl2 || gpu.maxTexture < 8192) {
    detected = 'low';
    return detected;
  }

  // The measured pass is the only evidence about this machine rather than about
  // the name of the chip in it, so it sets the tier and the strings only clamp.
  let index =
    gpu.fillMs > 0 ? (gpu.fillMs < 2.2 ? 3 : gpu.fillMs < 5.5 ? 2 : gpu.fillMs < 15 ? 1 : 0) : coarsePointer ? 0 : 1;

  if (STRONG.test(gpu.renderer)) index = Math.max(index, 2);
  if (WEAK.test(gpu.renderer)) index = Math.min(index, 1);
  // A phone has the thermal budget of a phone whatever it benchmarks at in the
  // first second, and the shadow maps and grass counts above `medium` are what
  // kill it two minutes in.
  if (coarsePointer) index = Math.min(index, 1);
  if (cores <= 4) index = Math.min(index, 1);

  detected = TIERS[index] ?? 'medium';
  return detected;
};

export const QUALITY_LABELS: Record<QualityTier, string> = {
  low: 'Nhẹ',
  medium: 'Vừa',
  high: 'Cao',
  ultra: 'Tối đa',
};
