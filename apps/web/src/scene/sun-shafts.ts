import {
  Color,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type Texture,
  type WebGLRenderer,
} from 'three';

import type { ResolvedSky } from './sky-palette';
import type { WorldWeather } from './weather-state';

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** What is allowed to cast a shaft, and from where. */
const MASK_SHADER = /* glsl */ `
  uniform sampler2D tSource;
  uniform vec3 uTint;
  uniform vec2 uSun;
  uniform float uAspect;
  uniform float uThreshold;
  uniform float uRamp;

  varying vec2 vUv;

  void main() {
    vec3 colour = texture2D(tSource, vUv).rgb;
    float brightness = max(colour.r, max(colour.g, colour.b));

    // The cut sits above a brightly sunlit hillside on purpose. Keep it lower
    // and every pale roof and every glint on the water streaks across the frame.
    // Both ends are a fraction of the sun's own brightness rather than fixed
    // numbers: a fixed cut is a bet on how bright the renderer happens to draw
    // the sky, and that bet was already lost once — measured at Tà Xùa at 06:00,
    // the whole HDR frame peaked at 0.95 against a cut of 1.15, so the mask came
    // back black and the effect silently did nothing.
    float lit = smoothstep(uThreshold, uThreshold + uRamp, brightness);
    // A shaft is light that came past an edge, so its source has to lie toward
    // the sun. Without this the whole image smears outward from one point.
    float reach = 1.0 - smoothstep(0.15, 1.0, length((vUv - uSun) * vec2(uAspect, 1.0)));

    // Half-desaturated before tinting: the rays then take the sun's own colour
    // rather than doubling up whatever happened to be bright underneath.
    gl_FragColor = vec4(mix(colour, vec3(brightness), 0.5) * uTint * (lit * reach), 1.0);
  }
`;

const BLUR_SHADER = /* glsl */ `
  uniform sampler2D tSource;
  uniform vec2 uSun;
  uniform float uStride;
  uniform float uDecay;

  varying vec2 vUv;

  void main() {
    // Walking toward the sun gathers whatever lies between this pixel and it,
    // which is what smears light outward. Where a ridge or a cloud stands in the
    // way the walk picks up nothing, and that gap is the shaft.
    vec2 advance = (vUv - uSun) * uStride;
    vec2 at = vUv;
    vec3 total = vec3(0.0);
    float weight = 1.0;
    float sum = 0.0;

    for (int i = 0; i < SUN_SHAFT_TAPS; i += 1) {
      total += texture2D(tSource, at).rgb * weight;
      sum += weight;
      weight *= uDecay;
      at -= advance;
    }

    gl_FragColor = vec4(total / max(sum, 1.0e-4), 1.0);
  }
`;

export type SunShafts = {
  setSize: (width: number, height: number) => void;
  /**
   * Builds the shaft texture from the same HDR source bloom reads. The camera is
   * what puts the sun on screen, so it has to come in per frame; always returns
   * a usable texture, and `strength` is only valid once this has run.
   */
  render: (renderer: WebGLRenderer, source: Texture, camera: Camera) => Texture;
  /** How hard to add it: 0 when the sun is down, behind you, or buried in cloud. */
  strength: () => number;
  setStrength: (value: number) => void;
  applySky: (colors: ResolvedSky, sunDirection: Vector3, sunElevation: number, weather: WorldWeather) => void;
  /**
   * The factors behind `strength`, separately. `strength` alone cannot tell a
   * sun behind the camera from an overcast sky from a disabled effect, and
   * guessing which it was has already cost a day.
   */
  diagnose: () => { taps: number; strength: number; conditions: number; framing: number; threshold: number };
  dispose: () => void;
};

/**
 * Where the cut sits as a fraction of the sun's own brightness, and how wide the
 * ramp above it is. Measured at Tà Xùa: a sunlit hillside sits at 0.68 in HDR
 * and the brightest sky at 0.95, so 0.8 of the sun's colour lands between them.
 */
const SOURCE_CUT = 0.8;
const SOURCE_RAMP = 0.35;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/**
 * Crepuscular rays. Screen space rather than cones of geometry, and that is the
 * whole argument for it: the occluders come out of the rendered image, so the
 * rays break around ridges, cloud edges, trees and a boat's canopy for free,
 * which no hand-placed cone can match. It is added in HDR alongside bloom, so it
 * is light going into the tone mapper rather than paint on a finished frame.
 *
 * @param taps samples per radial pass. 0 turns the effect off entirely.
 */
export const createSunShafts = (taps: number, initialStrength = 0.6): SunShafts => {
  let strength = initialStrength;
  /** What the weather and the sun's height earn the effect, 0..1. */
  let conditions = 0;
  /** What the camera earns it this frame: 0 with the sun behind or far off frame. */
  let framing = 0;
  let aspect = 1;

  const sunDirection = new Vector3(0, 1, 0);
  const sunUv = new Vector2(0.5, 0.5);
  const eye = new Vector3();
  const forward = new Vector3();
  const projected = new Vector3();

  // Something valid to hand back on the frames that do no work at all.
  const blank = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat);
  blank.needsUpdate = true;

  const makeTarget = () =>
    new WebGLRenderTarget(1, 1, { minFilter: LinearFilter, magFilter: LinearFilter, type: HalfFloatType });

  const mask = makeTarget();
  const coarse = makeTarget();
  const fine = makeTarget();

  const maskMaterial = new ShaderMaterial({
    uniforms: {
      tSource: { value: null },
      uTint: { value: new Color('#ffffff') },
      uSun: { value: sunUv },
      uAspect: { value: 1 },
      uThreshold: { value: 1 },
      uRamp: { value: 0.35 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: MASK_SHADER,
    depthTest: false,
    depthWrite: false,
  });

  const blurMaterial = new ShaderMaterial({
    defines: { SUN_SHAFT_TAPS: String(Math.max(1, Math.round(taps))) },
    uniforms: {
      tSource: { value: null },
      uSun: { value: sunUv },
      uStride: { value: 0.1 },
      uDecay: { value: 0.92 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: BLUR_SHADER,
    depthTest: false,
    depthWrite: false,
  });

  const geometry = new PlaneGeometry(2, 2);
  const quadScene = new Scene();
  const quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new Mesh(geometry, maskMaterial);
  quad.frustumCulled = false;
  quadScene.add(quad);

  const draw = (renderer: WebGLRenderer, material: ShaderMaterial, target: WebGLRenderTarget) => {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCamera);
  };

  /** Puts the sun on screen and reports how much of the effect this view earns. */
  const aim = (camera: Camera): number => {
    camera.getWorldPosition(eye);
    camera.getWorldDirection(forward);

    const facing = forward.dot(sunDirection);
    // Nothing streaks out of a sun behind your head.
    if (facing <= 0.02) return 0;

    projected.copy(sunDirection).multiplyScalar(1e6).add(eye).project(camera);
    sunUv.set(projected.x * 0.5 + 0.5, projected.y * 0.5 + 0.5);

    // A sun just past the edge of frame still throws rays right across it; one
    // far outside does not, and smearing from it only reads as a smudge.
    const away = Math.hypot((sunUv.x - 0.5) * aspect, sunUv.y - 0.5);
    return smoothstep(0.02, 0.3, facing) * (1 - smoothstep(0.78, 1.7, away));
  };

  return {
    setSize: (width, height) => {
      aspect = Math.max(width, 1) / Math.max(height, 1);
      maskMaterial.uniforms.uAspect.value = aspect;

      // Half resolution each way. Shafts are the smoothest thing in the frame,
      // so a quarter of the pixels costs nothing visible and three passes of it
      // stay inside the budget.
      const w = Math.max(1, Math.round(width * 0.5));
      const h = Math.max(1, Math.round(height * 0.5));
      mask.setSize(w, h);
      coarse.setSize(w, h);
      fine.setSize(w, h);
    },
    render: (renderer, source, camera) => {
      framing = aim(camera);
      if (taps < 1 || strength <= 0 || conditions <= 0 || framing <= 0) return blank;

      maskMaterial.uniforms.tSource.value = source;
      draw(renderer, maskMaterial, mask);

      // Two levels of the same radial walk. The first steps the whole way to the
      // sun in `taps` strides, the second fills the gaps between those strides,
      // so `taps` passes twice reach as far as `taps` squared taps would.
      blurMaterial.uniforms.tSource.value = mask.texture;
      blurMaterial.uniforms.uStride.value = 1 / taps;
      blurMaterial.uniforms.uDecay.value = 0.92;
      draw(renderer, blurMaterial, coarse);

      blurMaterial.uniforms.tSource.value = coarse.texture;
      blurMaterial.uniforms.uStride.value = 1 / (taps * taps);
      blurMaterial.uniforms.uDecay.value = 0.96;
      draw(renderer, blurMaterial, fine);

      renderer.setRenderTarget(null);
      return fine.texture;
    },
    strength: () => (taps < 1 ? 0 : strength * conditions * framing),
    setStrength: (value) => {
      strength = Math.max(0, value);
    },
    diagnose: () => ({
      taps,
      strength,
      conditions,
      framing,
      threshold: maskMaterial.uniforms.uThreshold.value as number,
    }),
    applySky: (colors, direction, sunElevation, weather) => {
      sunDirection.copy(direction).normalize();
      const tint = maskMaterial.uniforms.uTint.value;
      tint.copy(colors.sunGlow).lerp(colors.sunCore, 0.4);

      // Max channel, to match the `brightness` the mask measures.
      const sunLevel = Math.max(tint.r, tint.g, tint.b);
      maskMaterial.uniforms.uThreshold.value = Math.max(0.12, sunLevel * SOURCE_CUT);
      maskMaterial.uniforms.uRamp.value = Math.max(0.05, sunLevel * SOURCE_RAMP);

      // Rays belong to a low sun: a long slant through the air, and shadows long
      // enough to reach across the frame. At noon there is barely a shaft to be had.
      const low = 0.3 + 0.7 * (1 - smoothstep(18, 52, sunElevation));
      // No disc below the horizon, nothing to cast them. The minutes either side
      // of sunrise are the whole hour this app is built around, so the fade in
      // sits tight to it rather than reaching up into mid-morning.
      const up = smoothstep(-0.6, 2.5, sunElevation);
      // Broken cloud, and only broken cloud, is when rays actually happen: a
      // clear sky has nothing to break the light and an overcast one has no beam
      // left to break. Peaks across 0.40..0.70 cover and falls off both ways.
      const broken = smoothstep(0.12, 0.4, weather.cloudCover) * (1 - smoothstep(0.7, 0.95, weather.cloudCover));
      // A clear sky still carries a little glare around the disc, but that is a
      // haze bloom and not a ray, which is why it tops out so much lower.
      const glare = (1 - smoothstep(0.08, 0.4, weather.cloudCover)) * 0.22;
      // The deck's thickness has the final say, off the same figure sky-dome
      // uses to take the disc, the moon and the stars out: god rays through a
      // solid overcast are the clearest tell there is that a sky is faked. It
      // bites late on purpose — the mask is fed by a sun the dome has already
      // dimmed by this number, so matching it one for one would count the cloud
      // twice and leave nothing at the half cover where rays are at their best.
      const through = 1 - smoothstep(0.45, 0.82, weather.skyOcclusion);

      conditions = up * low * Math.max(broken, glare) * through;
    },
    dispose: () => {
      mask.dispose();
      coarse.dispose();
      fine.dispose();
      blank.dispose();
      geometry.dispose();
      maskMaterial.dispose();
      blurMaterial.dispose();
    },
  };
};
