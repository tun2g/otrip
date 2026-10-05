import { createPrng, type CloudSeaParams, type LocationRecipe, type Terrain } from '@otrip/world';
import { BackSide, Color, Group, Mesh, ShaderMaterial, SphereGeometry, Vector2, Vector3 } from 'three';

import { analyseCloudTerrain } from './cloud-terrain';
import type { ResolvedSky } from './sky-palette';
import type { WorldWeather } from './weather-state';

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorld;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uHeight;
  uniform float uHalfSize;
  uniform float uMinHeight;
  uniform float uHeightRange;

  uniform float uDeckY;
  uniform float uThickness;
  uniform float uSwellScale;
  uniform float uBillow;
  uniform float uCrest;
  uniform float uSlack;
  uniform float uTopFeather;
  uniform float uBaseFeather;
  uniform float uShoreFeather;
  uniform float uPatchBar;
  uniform float uSigma;
  uniform float uDirect;
  uniform float uAmbient;
  uniform vec2 uDrift;
  uniform vec4 uSwell[CLOUD_SWELLS];
  uniform vec2 uSwellTime[CLOUD_SWELLS];

  uniform vec3 uSunDirection;
  uniform vec3 uSunLight;
  uniform vec3 uDawnLight;
  uniform vec3 uMoonLight;
  uniform vec3 uCloudLit;
  uniform vec3 uCloudShadow;
  uniform vec3 uHaze;

  uniform float uTime;
  uniform float uMaxDistance;
  uniform float uHazeFalloff;

  // Three gives a fragment shader viewMatrix and cameraPosition but not this
  // one. Declaring it is enough: the renderer sets every camera uniform it
  // finds by name, every frame, whichever stage declared it.
  uniform mat4 projectionMatrix;

#if CLOUD_SADDLES > 0
  uniform vec4 uSaddleA[CLOUD_SADDLES];
  uniform vec4 uSaddleB[CLOUD_SADDLES];
  uniform float uPlumeFloor;
#endif

  varying vec3 vWorld;

  /** How far toward the sun the single shadow sample reaches, in metres. */
  const float SHADOW_REACH = 430.0;
  /** Extinction along that sample. At this value 60 m of cloud halves the light. */
  const float SHADOW_SIGMA = 0.016;
  /** How much longer each march step is than the one before it. */
  const float STEP_GROWTH = 1.28;

  float hash(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  float valueNoise(vec3 p) {
    vec3 cell = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n00 = mix(hash(cell + vec3(0.0, 0.0, 0.0)), hash(cell + vec3(1.0, 0.0, 0.0)), f.x);
    float n10 = mix(hash(cell + vec3(0.0, 1.0, 0.0)), hash(cell + vec3(1.0, 1.0, 0.0)), f.x);
    float n01 = mix(hash(cell + vec3(0.0, 0.0, 1.0)), hash(cell + vec3(1.0, 0.0, 1.0)), f.x);
    float n11 = mix(hash(cell + vec3(0.0, 1.0, 1.0)), hash(cell + vec3(1.0, 1.0, 1.0)), f.x);

    return mix(mix(n00, n10, f.y), mix(n01, n11, f.y), f.z);
  }

  /** Henyey–Greenstein, normalised so isotropic scattering reads 1.0. */
  float henyey(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1.0e-4), 1.5);
  }

  /**
   * The long swells. Each one is a travelling wave with its own direction,
   * wavelength and phase speed — the same construction as an ocean swell, run
   * slow enough to read as something heavy. These are the ones the shadow test
   * needs; the shorter ones below only add texture.
   */
  float swellCoarse(vec2 xz) {
    float height = 0.0;
    for (int i = 0; i < CLOUD_SWELL_COARSE; i += 1) {
      vec4 wave = uSwell[i];
      height += sin(dot(xz, wave.xy) * wave.z + uSwellTime[i].x * uTime + uSwellTime[i].y) * wave.w;
    }
    return height * uSwellScale;
  }

  float swellFine(vec2 xz) {
    float height = 0.0;
    for (int i = CLOUD_SWELL_COARSE; i < CLOUD_SWELLS; i += 1) {
      vec4 wave = uSwell[i];
      height += sin(dot(xz, wave.xy) * wave.z + uSwellTime[i].x * uTime + uSwellTime[i].y) * wave.w;
    }
    return height * uSwellScale;
  }

  /**
   * The lumpy texture of the cloud top. Advected with the air mass rather than
   * travelling like the swells, because it is the medium, not a wave in it.
   */
  float billowAt(vec2 xz) {
    vec3 q = vec3((xz - uDrift * uTime) * 0.0082, uTime * 0.016);
    return (valueNoise(q) * 0.66 + valueNoise(q * 2.7) * 0.34 - 0.5) * 2.0 * uBillow;
  }

  float surfaceAt(vec2 xz) {
    return uDeckY + swellCoarse(xz) + swellFine(xz) + billowAt(xz);
  }

  float groundAt(vec2 xz) {
    vec2 uv = (xz + uHalfSize) / (2.0 * uHalfSize);
    float border = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
    float height = uMinHeight + texture2D(uHeight, clamp(uv, 0.0, 1.0)).r * uHeightRange;
    // Past the generated patch there is no hillside to stand in the way, so the
    // land is let go instead of being smeared outward by the clamp — which is
    // also what lets the sea run on to the horizon.
    return mix(uMinHeight, height, smoothstep(0.0, 0.006, border));
  }

  /**
   * Whether there is any sea here at all. A very large, very slow swell in the
   * cover is what opens a hole over one valley while the next stays full, and
   * closes it again twenty minutes later.
   */
  float patchAt(vec2 xz) {
    vec3 q = vec3((xz - uDrift * uTime) * 0.00048, uTime * 0.0042);
    float field = valueNoise(q) * 0.7 + valueNoise(q * 2.3) * 0.3;
    return smoothstep(uPatchBar - 0.13, uPatchBar + 0.13, field);
  }

  float deckDensity(vec3 p, float surface, float ground) {
    float below = surface - p.y;
    // A cloud top is wisps for its first few metres, not a lid.
    float top = smoothstep(0.0, uTopFeather, below);
    // And it has a base: under the inversion the air is clear again.
    float base = 1.0 - smoothstep(uThickness, uThickness + uBaseFeather, below);
    // Cloud pools and thins as the land rises through it. This feather is the
    // whole difference between an island with a shoreline and one cut out of
    // the deck with a knife.
    float shore = smoothstep(0.0, uShoreFeather, surface - ground);
    float lift = smoothstep(0.0, 18.0, p.y - ground);
    return top * base * shore * lift;
  }

#if CLOUD_SADDLES > 0
  /**
   * Thác mây. Where a pass on the ridge sits just under the deck, the sea pours
   * through the gap and falls down the emptier side. The fall accelerates as it
   * goes, spreads as it loses the walls of the gap, and thins out as it warms
   * on the way down.
   */
  float plumeAt(vec3 p, float ground, float churn) {
    float total = 0.0;
    for (int i = 0; i < CLOUD_SADDLES; i += 1) {
      vec4 gap = uSaddleA[i];
      vec4 run = uSaddleB[i];

      vec2 rel = p.xz - gap.xy;
      float along = dot(rel, run.xy);
      float across = dot(rel, vec2(-run.y, run.x));
      float fall = clamp(along / run.z, 0.0, 1.0);

      float spread = run.w * (1.0 + fall * 2.1);
      float lateral = 1.0 - smoothstep(spread * 0.42, spread, abs(across));
      // The head leaves at whatever height the sea stands over the lip and
      // drops away under gravity, flattening out along the slope at the bottom.
      float head = mix(gap.z, ground + uPlumeFloor, clamp(fall * fall * 1.3, 0.0, 1.0));
      float body = smoothstep(0.0, uTopFeather * 1.6, head - p.y) * smoothstep(0.0, 16.0, p.y - ground);

      total = max(total, step(0.0, along) * lateral * body * gap.w * (1.0 - smoothstep(0.55, 1.0, fall)));
    }
    return clamp(total * churn, 0.0, 1.0);
  }

  /**
   * Scrolling downward, because what reads as a fall is the texture moving down
   * the curtain rather than the curtain going anywhere.
   */
  float churnAt(vec3 p) {
    return clamp(0.42 + 1.05 * valueNoise(vec3(p.xz * 0.0105, p.y * 0.0105 - uTime * 0.085)), 0.0, 1.4);
  }
#endif

  vec3 shadeCloud(vec3 p, float surface, float density, vec3 sunDir, vec2 lobe) {
    float below = surface - p.y;
    float deep = clamp(below / max(uThickness, 1.0), 0.0, 1.0);

    // One sample toward the sun. On a surface made of swells that is exactly
    // the crest-and-trough contrast: a trough has the next crest standing
    // between it and a low sun, a crest has nothing in the way.
    vec3 toward = p + sunDir * SHADOW_REACH;
    float blocked = max((uDeckY + swellCoarse(toward.xz)) - toward.y, 0.0);
    float sunlight = exp(-(blocked * 0.85 + below * 0.6) * SHADOW_SIGMA);
    // Multiple scattering: light that reaches deep inside cloud has been turned
    // round many times before it leaves again. Without it a thick deck reads as
    // flat paint rather than as something with a volume.
    float powder = 1.0 - exp(-density * 6.0);

    // The sharp forward lobe belongs to a thin edge. Weighting it by thinness
    // keeps the sun's glow a path across the sea instead of a white field: a
    // deck this optically deep forward-scatters almost nothing.
    float phase = mix(lobe.x, lobe.y, 0.10 + 0.22 * (1.0 - powder));

    return mix(uCloudLit, uCloudShadow, pow(deep, 0.65)) * uAmbient +
      (uSunLight * phase * mix(0.4, 1.0, powder) + uDawnLight) * sunlight * uDirect +
      uMoonLight * sunlight * (1.0 - deep * 0.6);
  }

#if CLOUD_STEPS > 0
  /**
   * The sea, marched. Returns premultiplied colour in rgb, and the distance to
   * the first cloud it met in the out parameter.
   */
  vec4 sampleSea(vec3 dir, vec3 sunDir, vec2 lobe, out float hit) {
    hit = -1.0;
    // Near the horizontal the slab is thousands of kilometres deep and the
    // quotients below overflow.
    if (abs(dir.y) < 0.0012) return vec4(0.0);

    float toTop = (uDeckY + uCrest - cameraPosition.y) / dir.y;
    float toFloor = (uMinHeight - cameraPosition.y) / dir.y;
    float enter = max(min(toTop, toFloor), 40.0);
    float exit = min(max(toTop, toFloor), uMaxDistance);
    if (exit <= enter) return vec4(0.0);

    // A geometric march. The sea is a surface, so the samples that earn their
    // keep are the near ones; growing the step keeps the foreground swell
    // resolved while still reaching far enough out that the horizon is haze
    // rather than an edge. A stable per-pixel offset on the first step keeps
    // the slab from banding.
    float dt = (exit - enter) * (STEP_GROWTH - 1.0) / (pow(STEP_GROWTH, float(CLOUD_STEPS)) - 1.0);
    float t = enter + dt * hash(vec3(gl_FragCoord.xy, 11.0));

    float coverNear = patchAt((cameraPosition + dir * enter).xz);
    float coverFar = patchAt((cameraPosition + dir * (enter + dt * float(CLOUD_STEPS))).xz);

    vec3 scattered = vec3(0.0);
    float transmittance = 1.0;
    float depth = 0.0;
    float weight = 0.0;

    for (int i = 0; i < CLOUD_STEPS; i += 1) {
      if (transmittance < 0.02) break;

      vec3 p = cameraPosition + dir * t;
      float ground = groundAt(p.xz);
      // The ray has gone into the hillside. Nothing past it is visible, and
      // stopping here is what makes the sea pool behind a nearer ridge instead
      // of hanging in front of it.
      if (p.y < ground) break;

      float coarse = uDeckY + swellCoarse(p.xz);
      // Everything below the mean deck needs the full test; above it, the local
      // swell plus the most the detail can add is enough to rule the point out.
      if (p.y < max(coarse + uSlack, uDeckY)) {
        float surface = coarse + swellFine(p.xz) + billowAt(p.xz);
        float cover = mix(coverNear, coverFar, float(i) / float(CLOUD_STEPS));
        float density = deckDensity(p, surface, ground) * cover;
#if CLOUD_SADDLES > 0
        density = max(density, plumeAt(p, ground, churnAt(p)) * cover);
#endif

        if (density > 0.004) {
          vec3 light = shadeCloud(p, surface, density, sunDir, lobe);
          float stepTransmittance = exp(-density * uSigma * dt);
          float absorbed = transmittance * (1.0 - stepTransmittance);
          scattered += light * absorbed;
          depth += t * absorbed;
          weight += absorbed;
          if (hit < 0.0) hit = t;
          transmittance *= stepTransmittance;
        }
      }

      t += dt;
      dt *= STEP_GROWTH;
    }

    float opacity = 1.0 - transmittance;
    if (opacity < 0.003) return vec4(0.0);

    // Aerial perspective. The sea runs to the horizon, and without this it ends
    // in a hard bright rim where the march gives up.
    float haze = 1.0 - exp(-(weight > 0.0 ? depth / weight : exit) * uHazeFalloff);
    return vec4(mix(scattered, uHaze * opacity, haze), opacity);
  }
#else
  /**
   * The lowest tier gets the surface instead of the volume: solve where the ray
   * meets the swell and shade that one point. No marching, so no thickness and
   * no cloud waterfalls, but the swells, the shoreline and the lit crests all
   * survive — which is most of what makes it a sea.
   */
  vec4 sampleSea(vec3 dir, vec3 sunDir, vec2 lobe, out float hit) {
    hit = -1.0;
    if (abs(dir.y) < 0.0012) return vec4(0.0);

    // Two plane solves converge on the swell: the first lands on the mean
    // level, the second re-solves against the height the swell has there.
    float t = (uDeckY - cameraPosition.y) / dir.y;
    if (t <= 0.0) return vec4(0.0);
    t = (surfaceAt((cameraPosition + dir * t).xz) - cameraPosition.y) / dir.y;
    if (t <= 0.0 || t > uMaxDistance) return vec4(0.0);

    vec3 p = cameraPosition + dir * t;
    float surface = surfaceAt(p.xz);
    float ground = groundAt(p.xz);
    float opacity = patchAt(p.xz) * smoothstep(0.0, uShoreFeather, surface - ground) * 0.95;
    if (opacity < 0.004) return vec4(0.0);

    float offset = 30.0;
    vec3 normal = normalize(vec3(
      surfaceAt(p.xz - vec2(offset, 0.0)) - surfaceAt(p.xz + vec2(offset, 0.0)),
      2.0 * offset,
      surfaceAt(p.xz - vec2(0.0, offset)) - surfaceAt(p.xz + vec2(0.0, offset))
    ));

    // Cloud is nothing like lambertian: the falloff is broad, which is why a
    // real cloud sea keeps detail in its troughs instead of going flat black.
    float sunlight = pow(max(dot(normal, sunDir), 0.0), 0.65);
    // Seen from underneath there is no lit top, only the base of the deck.
    sunlight *= mix(1.0, 0.12, step(0.0, dir.y));

    vec3 colour = mix(uCloudShadow, uCloudLit, 0.26 + 0.74 * sunlight) * uAmbient +
      (uSunLight * mix(lobe.x, lobe.y, 0.18) * 0.6 + uDawnLight) * sunlight * uDirect +
      uMoonLight * (0.3 + 0.7 * sunlight);

    hit = t;
    float haze = 1.0 - exp(-t * uHazeFalloff);
    return vec4(mix(colour * opacity, uHaze * opacity, haze), opacity);
  }
#endif

  void main() {
    // Assigned on every path: a shader that writes this conditionally leaves it
    // undefined where it does not.
    gl_FragDepth = 1.0;

    vec3 dir = normalize(vWorld - cameraPosition);
    vec3 sunDir = normalize(uSunDirection);
    float cosSun = dot(dir, sunDir);
    vec2 lobe = vec2(henyey(cosSun, 0.18), henyey(cosSun, 0.78));

    float hit;
    vec4 sea = sampleSea(dir, sunDir, lobe, hit);
    if (sea.a < 0.003 || hit <= 0.0) discard;

    // Standing inside the deck would fill the screen with white. The scene's
    // own fog already carries being in mist, so the sea thins out around you.
    sea *= mix(1.0, 0.5, smoothstep(-20.0, 50.0, surfaceAt(cameraPosition.xz) - cameraPosition.y));

    // The depth of the cloud it actually met, not the shell this runs on: the
    // sea stands a couple of kilometres out and the shell tens, and without
    // this every ridge in front of the sea would be painted over.
    vec4 clip = projectionMatrix * viewMatrix * vec4(cameraPosition + dir * hit, 1.0);
    gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);

    gl_FragColor = sea;
  }
`;

/**
 * Wavelengths of the swells, longest first, in metres. Kilometre-scale: the
 * thing being modelled is a sea filling a valley system, not chop on a pond.
 */
const SWELL_WAVELENGTHS = [1850, 1180, 760, 470, 290, 175];
/** How many of them the sun shadow and the plume heads are solved against. */
const COARSE_SWELLS = 3;

/** Moonlight on a night sea. Matches the tint the sky dome gives the moon. */
const MOON = new Color('#9fb0d4');

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

export type CloudSea = {
  group: Group;
  /**
   * Where the deck rests in calm, average weather, in the same metres as the
   * terrain. Read off the heightfield rather than taken from the recipe, so it
   * is the altitude the sea will actually be at — which is what the camera
   * wants to be looking at.
   */
  altitude: number;
  /** @param daylight 0 at night .. 1 in full daylight, as `SkyState` reports it. */
  applySky: (colors: ResolvedSky, sunDirection: Vector3, daylight: number) => void;
  setWeather: (weather: WorldWeather) => void;
  update: (elapsed: number) => void;
  dispose: () => void;
};

/**
 * Biển mây. The reason anyone climbs Tà Xùa at five in the morning: a sea of
 * cloud filling the valleys with the ridges standing out of it as islands.
 *
 * It is modelled as a surface rather than as weather. The deck floats at an
 * altitude read off the terrain's own height distribution, so the summits come
 * through wherever the seed put them; travelling swells at several wavelengths
 * and directions give it crests that catch the sunrise and troughs that stay
 * blue; it fades where the ground climbs through it, so every island gets a
 * shoreline; and where a pass on the ridge sits just under the surface it pours
 * through and falls down the far side — thác mây.
 *
 * Deliberately not `day-clouds.ts`: that one is the weather overhead, this one
 * is the thing you stand above. They share no geometry.
 *
 * @param steps raymarch steps. 0 falls back to shading the surface alone.
 * @param swells how many swell components the surface is built from.
 */
export const createCloudSea = (
  terrain: Terrain,
  recipe: LocationRecipe,
  params: CloudSeaParams,
  steps: number,
  swells: number
): CloudSea => {
  const marchSteps = Math.max(0, Math.round(steps));
  const swellCount = Math.min(SWELL_WAVELENGTHS.length, Math.max(COARSE_SWELLS, Math.round(swells)));
  // Each pass costs a loop iteration per march step, so they are the first
  // thing to go: no march at all means no falls either.
  const wantedSaddles = marchSteps === 0 ? 0 : Math.min(4, Math.max(2, Math.round(marchSteps / 4)));

  const land = analyseCloudTerrain(terrain, params.altitude, wantedSaddles);
  const saddles = land.saddles;
  // However many the ridge actually offered. Compiling the loop to that, rather
  // than to what was asked for, is what keeps an unfilled slot — whose reach
  // would be zero, and divided by — out of the shader.
  const saddleCount = saddles.length;
  const random = createPrng(`${recipe.seed}:cloud-sea`);

  // Swell height scales with the layer's own depth: a deep deck has room for
  // big slow hills, a thin one is nearly flat.
  const swellTarget = params.thickness * 0.46;
  const lengths = SWELL_WAVELENGTHS.slice(0, swellCount);
  const weights = lengths.map((length) => Math.pow(length / lengths[0], 0.95));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);

  const swellData = new Float32Array(swellCount * 4);
  const swellTime = new Float32Array(swellCount * 2);
  // Real swell arrives mostly from one direction with crossing trains either
  // side of it; the dominant one runs straight downwind.
  const directionOffsets = lengths.map((_, index) => (index === 0 ? 0 : (random() * 2 - 1) * 0.78));
  let coarseAmplitude = 0;
  let fineAmplitude = 0;

  for (let i = 0; i < swellCount; i += 1) {
    const amplitude = (swellTarget * weights[i]) / weightTotal;
    const k = (Math.PI * 2) / lengths[i];
    swellData[i * 4 + 2] = k;
    swellData[i * 4 + 3] = amplitude;
    // Deep-water phase speed, scaled right down. A cloud sea is viscous: the
    // big swell wants a period of minutes, not of seconds.
    swellTime[i * 2] = k * Math.sqrt((9.81 * lengths[i]) / (Math.PI * 2)) * 0.06;
    swellTime[i * 2 + 1] = random() * Math.PI * 2;
    if (i < COARSE_SWELLS) coarseAmplitude += amplitude;
    else fineAmplitude += amplitude;
  }

  const billow = Math.max(6, params.thickness * 0.08);
  const saddleA = new Float32Array(Math.max(1, saddleCount) * 4);
  const saddleB = new Float32Array(Math.max(1, saddleCount) * 4);
  for (let i = 0; i < saddles.length; i += 1) {
    const saddle = saddles[i];
    saddleA[i * 4] = saddle.x;
    saddleA[i * 4 + 1] = saddle.z;
    saddleB[i * 4] = saddle.spillX;
    saddleB[i * 4 + 1] = saddle.spillZ;
    saddleB[i * 4 + 2] = saddle.reach;
    saddleB[i * 4 + 3] = saddle.width;
  }

  // The recipe's altitude is a wish about how deep the valleys should fill, not
  // a number of metres to be trusted — the same 280 m means something different
  // on every seed. The analysis reads it as the share of the land it would cover
  // on *this* heightfield, and the weather moves the deck around that.
  const nominalSubmerged = land.restingSubmerged;
  const resting = land.levelForSubmerged(nominalSubmerged);

  // The sea runs to the horizon, so the march has to reach much further than
  // the terrain patch does; past this the haze has taken it anyway.
  const maxDistance = terrain.size * 6;
  // The swell scale moves with the wind, so the headroom the march has to allow
  // for is the calmest-case amplitude times the windiest-case scale.
  const headroom = 1.3;

  const uniforms = {
    uHeight: { value: land.texture },
    uHalfSize: { value: terrain.size / 2 },
    uMinHeight: { value: land.minHeight },
    uHeightRange: { value: land.heightRange },

    uDeckY: { value: resting },
    uThickness: { value: params.thickness },
    uSwellScale: { value: 1 },
    uBillow: { value: billow },
    uCrest: { value: (coarseAmplitude + fineAmplitude) * headroom + billow },
    uSlack: { value: fineAmplitude * headroom + billow },
    uTopFeather: { value: 20 },
    uBaseFeather: { value: 30 },
    uShoreFeather: { value: Math.max(45, terrain.maxHeight * 0.08) },
    uPatchBar: { value: 0 },
    // Extinction per metre of solid cloud. At this value the deck is opaque
    // within a few tens of metres of its own surface, which is what separates a
    // sea from a haze.
    uSigma: { value: 0.028 },
    uDirect: { value: 1 },
    uAmbient: { value: 1 },
    uDrift: { value: new Vector2() },
    uSwell: { value: swellData },
    uSwellTime: { value: swellTime },

    uSunDirection: { value: new Vector3(0, 1, 0) },
    uSunLight: { value: new Color() },
    uDawnLight: { value: new Color() },
    uMoonLight: { value: new Color() },
    uCloudLit: { value: new Color() },
    uCloudShadow: { value: new Color() },
    uHaze: { value: new Color() },

    uTime: { value: 0 },
    uMaxDistance: { value: maxDistance },
    uHazeFalloff: { value: 1 / (terrain.size * 2.4) },

    uSaddleA: { value: saddleA },
    uSaddleB: { value: saddleB },
    uPlumeFloor: { value: 25 },
  };

  const material = new ShaderMaterial({
    defines: {
      CLOUD_STEPS: String(marchSteps),
      CLOUD_SWELLS: String(swellCount),
      CLOUD_SWELL_COARSE: String(COARSE_SWELLS),
      CLOUD_SADDLES: String(saddleCount),
    },
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: BackSide,
    transparent: true,
    premultipliedAlpha: true,
    // The shader writes its own depth, from the distance to the cloud it met,
    // so the test against the landscape is against the sea rather than against
    // this shell. Nothing is written back: it is a transparent pass.
    depthWrite: false,
    // The scene's own fog is total long before this shell's radius. Distance is
    // handled in the shader against the marched depth instead.
    fog: false,
  });

  // A shell, not a surface: every effect here is a function of the view ray,
  // and the slab the ray crosses is solved in the shader. A horizontal plane
  // would be edge-on exactly where the sea stretches away to the horizon.
  const geometry = new SphereGeometry(terrain.size * 6.1, 72, 36);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'cloud-sea-deck';
  mesh.frustumCulled = false;
  // After the day cloud shell: that one is tens of kilometres away and the sea
  // is a couple, so the sea has to paint over it.
  mesh.renderOrder = 10;

  const group = new Group();
  group.name = 'cloud-sea';
  group.add(mesh);

  const toward = new Vector2();
  let coverage = 1;

  /** @param speed km/h at ten metres, as the forecast reports it. */
  const aimSwells = (degrees: number, speed: number) => {
    const bearing = ((degrees + 180) * Math.PI) / 180;
    for (let i = 0; i < swellCount; i += 1) {
      const angle = bearing + directionOffsets[i];
      swellData[i * 4] = Math.sin(angle);
      swellData[i * 4 + 1] = -Math.cos(angle);
    }
    // The deck is a trapped inversion, not free air: it creeps downwind at a
    // fraction of the ten-metre wind rather than running with it.
    toward.set(Math.sin(bearing), -Math.cos(bearing));
    uniforms.uDrift.value.copy(toward).multiplyScalar(Math.max(speed, 3) * 0.2778 * 0.12);
  };

  // Aimed before the first frame, so the opening render is already a sea even
  // if it lands before any weather does.
  aimSwells(120, 8);

  const swellHeightAt = (x: number, z: number, elapsed: number): number => {
    let height = 0;
    for (let i = 0; i < swellCount; i += 1) {
      const at = i * 4;
      height +=
        Math.sin(
          (x * swellData[at] + z * swellData[at + 1]) * swellData[at + 2] +
            swellTime[i * 2] * elapsed +
            swellTime[i * 2 + 1]
        ) * swellData[at + 3];
    }
    return height * uniforms.uSwellScale.value;
  };

  return {
    group,
    altitude: resting,
    applySky: (colors, sunDirection, daylight) => {
      const night = 1 - daylight;
      uniforms.uSunDirection.value.copy(sunDirection);
      uniforms.uSunLight.value.copy(colors.sunCore).multiplyScalar(0.1 + daylight * 0.95);
      // Albedo scaled by the light that lands on it, never raw: a white cloud
      // sea is the most exposed surface in the scene to the mistake of glowing
      // in the dark.
      uniforms.uCloudLit.value.copy(colors.cloudLit).multiplyScalar(0.045 + daylight * 0.52);
      uniforms.uCloudShadow.value.copy(colors.cloudShadow).multiplyScalar(0.05 + daylight * 0.38);
      uniforms.uHaze.value.copy(colors.fog).multiplyScalar(0.12 + daylight * 0.88);
      uniforms.uMoonLight.value.copy(MOON).multiplyScalar(night * night * 0.11);

      // The deck starts catching the eastern sky well before the disc clears
      // the ridge — which is the entire reason for being up there at that hour.
      // Peaks just under the horizon and is gone once the sun is properly up.
      const dawn = Math.max(0, 1 - Math.abs(sunDirection.y + 0.05) / 0.26);
      uniforms.uDawnLight.value.copy(colors.sunGlow).multiplyScalar(dawn * 0.6);
    },
    setWeather: (weather) => {
      const moisture = clamp01((weather.humidity - 52) / 44);
      const gust = clamp01(weather.windSpeed / 38);
      // Solar heating is what breaks the inversion. That is why săn mây is a
      // dawn thing and why by midday there is nothing left to hunt.
      const burn = smoothstep(0.4, 0.95, weather.daylight);
      // Rain means the cloud is already around you and falling out of the sky.
      // There is no sea to stand above.
      const washedOut = smoothstep(0.03, 0.3, weather.rainIntensity);

      coverage = clamp01(0.2 + weather.cloudLow * 0.5 + moisture * 0.46 - gust * 0.3 - burn * 0.28) * (1 - washedOut);

      // How much of the land the sea swallows. A moist, still air mass fills
      // the valleys to the shoulders; a dry windy one leaves mist in the
      // bottoms only. Never past 0.85, so summits always break the surface.
      const submerged = Math.min(
        0.85,
        Math.max(
          0.16,
          nominalSubmerged + (moisture - 0.5) * 0.22 + (weather.cloudLow - 0.45) * 0.2 - gust * 0.12 - burn * 0.15
        )
      );

      uniforms.uDeckY.value = land.levelForSubmerged(submerged);
      uniforms.uThickness.value = params.thickness * (0.55 + coverage * 0.8);
      // At full cover nothing is carved out; as it drops, the holes take over.
      uniforms.uPatchBar.value = -0.2 + (1 - coverage) * 1.3;
      uniforms.uSwellScale.value = 0.7 + gust * 0.55;
      uniforms.uDirect.value = 1 - weather.skyOcclusion * 0.8;
      uniforms.uAmbient.value = 1 - weather.skyOcclusion * 0.35;

      aimSwells(weather.windDirection, weather.windSpeed);

      mesh.visible = coverage > 0.02;
    },
    update: (elapsed) => {
      uniforms.uTime.value = elapsed;

      const deck = uniforms.uDeckY.value;
      for (let i = 0; i < saddles.length; i += 1) {
        const saddle = saddles[i];
        const surface = deck + swellHeightAt(saddle.x, saddle.z, elapsed);
        const above = surface - saddle.height;
        // It only pours while the sea stands over the lip, and once the pass is
        // well under there is nothing falling left to see — it has become a
        // strait. Riding the swell is what makes the fall come and go.
        saddleA[i * 4 + 2] = surface;
        saddleA[i * 4 + 3] = smoothstep(2, 28, above) * (1 - smoothstep(70, 240, above)) * coverage;
      }
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
      land.dispose();
    },
  };
};
