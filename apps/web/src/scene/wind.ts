import { createPrng, type LocationRecipe, type TerrainProfile } from '@otrip/world';
import { Vector2, type Material } from 'three';

/** Metres between gust fronts travelling downwind. */
const FRONT_WAVELENGTH = 90;
const FRONT_FREQUENCY = (Math.PI * 2) / FRONT_WAVELENGTH;
/** km/h that reads as a full gale, so strength 1. */
const FULL_SCALE = 45;
/** Degrees the northeast monsoon comes from. Half the Vietnamese year is this wind. */
const MONSOON_FROM = 48;
const DEG = Math.PI / 180;

/**
 * What the air does before the forecast arrives, and how turbulent the terrain
 * makes it. A ridge at 1600m accelerates and breaks the flow; a delta town sits
 * behind its own trees and gets a soft, shifting breeze.
 */
const PROFILES: Record<TerrainProfile, { speed: number; gustiness: number; wander: number }> = {
  ridge: { speed: 27, gustiness: 0.55, wander: 0.16 },
  karst: { speed: 11, gustiness: 0.3, wander: 0.5 },
  lowland: { speed: 15, gustiness: 0.36, wander: 0.42 },
};

/** Live weather, in the units Open-Meteo reports. Either field may be absent. */
export type WindConditions = {
  /** km/h at 10m. */
  windSpeed?: number;
  /** Degrees meteorological — the direction the wind comes FROM, 0 = north. */
  windDirection?: number;
};

export type WindUniforms = {
  uWindTime: { value: number };
  /** Unit vector in world xz pointing where the wind blows TO. */
  uWindDirection: { value: Vector2 };
  /** 0..1 — the mean wind with its squall envelope, before the travelling front. */
  uWindStrength: { value: number };
  /** Metres per second. Gust fronts cross the ground at this speed. */
  uWindSpeed: { value: number };
};

export type Wind = {
  update: (elapsed: number) => void;
  /** Unit, world xz, pointing downwind. Mutated in place — hold the reference. */
  direction: Vector2;
  /** 0..1, gusting. */
  strength: number;
  /** Mean wind in m/s. Steady: the gusting lives in `strength` and `gust`. */
  speed: number;
  /** The gust at one spot on the ground, 0..1. */
  gust: (elapsed: number, x: number, z: number) => number;
  setConditions: (conditions: WindConditions) => void;
  uniforms: WindUniforms;
};

/**
 * Shared with every shader that moves in the wind: the uniform block plus
 * `windGustAt`, which is the same function `wind.gust` runs on the CPU. One
 * definition is why the grass, a boat and the rain all feel the same gust at the
 * same moment instead of each inventing its own clock.
 *
 * Preprocessor-guarded because the patches that inject it chain rather than
 * overwrite, so one material can take two of them. A second copy of these
 * declarations is a compile error, and a vertex shader that fails to compile
 * takes the whole mesh with it without anything in the scene going red.
 */
export const WIND_SHADER_CHUNK = /* glsl */ `
  #ifndef OTRIP_WIND
  #define OTRIP_WIND
  uniform float uWindTime;
  uniform vec2 uWindDirection;
  uniform float uWindStrength;
  uniform float uWindSpeed;

  float windGustAt(vec2 at, float time) {
    // Gust fronts travel downwind, so the phase at a point is how far along the
    // wind axis it lies, less how far the front has already come. Two
    // wavelengths, so the fronts never settle into a visible beat.
    float phase = (dot(at, uWindDirection) - time * uWindSpeed) * ${FRONT_FREQUENCY.toFixed(6)};
    float front = 0.5 + 0.5 * (sin(phase) * 0.62 + sin(phase * 0.41 + 2.1) * 0.38);
    return clamp(uWindStrength * (0.45 + 1.05 * front), 0.0, 1.0);
  }
  #endif
`;

const frontAt = (phase: number) => 0.5 + 0.5 * (Math.sin(phase) * 0.62 + Math.sin(phase * 0.41 + 2.1) * 0.38);

/**
 * One wind field for the whole world. Every module that sways reads this rather
 * than inventing its own sine: a gust that crosses the hillside has to cross the
 * grass, the trees and the boats on the river as one thing, and nothing shared
 * between them can do that except the field itself.
 */
export const createWind = (recipe: LocationRecipe): Wind => {
  const random = createPrng(`${recipe.seed}:wind`);
  const profile = PROFILES[recipe.terrain.profile];

  // Each place sits in its own terrain, so the monsoon arrives a little off the
  // regional bearing. Seeded, so it is the same wind on every reload.
  let fromAngle = (MONSOON_FROM + (random() - 0.5) * 70) * DEG;
  let mean = profile.speed / FULL_SCALE;
  let travel = profile.speed / 3.6;

  const direction = new Vector2(0, 1);

  const uniforms: WindUniforms = {
    uWindTime: { value: 0 },
    uWindDirection: { value: direction },
    uWindStrength: { value: mean },
    uWindSpeed: { value: travel },
  };

  const wind: Wind = {
    direction,
    strength: mean,
    speed: travel,
    uniforms,
    gust: (elapsed, x, z) => {
      // The Vector2 holds world x and world z, so `y` here is depth, not height.
      const along = x * direction.x + z * direction.y;
      const phase = (along - elapsed * travel) * FRONT_FREQUENCY;
      return Math.min(1, Math.max(0, wind.strength * (0.45 + 1.05 * frontAt(phase))));
    },
    setConditions: ({ windSpeed, windDirection }) => {
      if (windSpeed !== undefined) {
        const speed = Math.max(0, windSpeed);
        mean = Math.min(1, Math.max(0.02, speed / FULL_SCALE));
        // The front's travel speed is deliberately the ten-minute mean and not
        // the gusting value: feeding a wobbling speed into the phase makes every
        // front shimmer in place instead of crossing the ground.
        travel = speed / 3.6;
        wind.speed = travel;
        uniforms.uWindSpeed.value = travel;
      }
      if (windDirection !== undefined) fromAngle = windDirection * DEG;
    },
    update: (elapsed) => {
      // The bearing wanders over minutes, and a light wind wanders further than
      // a monsoon that has a whole valley to keep it straight.
      const swing = (Math.sin(elapsed * 0.047) * 0.62 + Math.sin(elapsed * 0.0163 + 1.9) * 0.38) * profile.wander;
      const angle = fromAngle + swing;
      // Meteorological degrees count clockwise from north, and north is -Z, so a
      // wind FROM `angle` blows towards (-sin, +cos).
      direction.set(-Math.sin(angle), Math.cos(angle));

      // Squalls: the mean itself rises and falls over tens of seconds, and the
      // travelling fronts ride on top of that.
      const squall = Math.sin(elapsed * 0.21) * 0.6 + Math.sin(elapsed * 0.073 + 2.4) * 0.4;
      wind.strength = Math.min(1, Math.max(0.02, mean + squall * profile.gustiness * (0.25 + mean * 0.5)));

      uniforms.uWindTime.value = elapsed;
      uniforms.uWindStrength.value = wind.strength;
    },
  };

  return wind;
};

export type WindSwayOptions = {
  /**
   * How far the tip travels downwind at full strength, in the geometry's own
   * units. Instance scale multiplies it, so a blade scaled up sways further.
   */
  amplitude?: number;
  /** Height over which the bend ramps to full, in the geometry's own units. */
  height?: number;
  /** 1 bends evenly from the root (grass); 2+ keeps the lower stem rigid (a sapling). */
  stiffness?: number;
};

/** Injecting the block twice would redeclare the uniforms and fail to compile. */
const swayed = new WeakSet<Material>();

/**
 * Hands a material the wind. Works on anything three compiles itself —
 * MeshStandardMaterial off a loaded model included — and on instanced meshes it
 * reads each instance's own position, so neighbours bend out of phase and a gust
 * is visible crossing a hillside rather than the whole field pulsing at once.
 */
export const applyWindSway = (material: Material, wind: Wind, options: WindSwayOptions = {}): void => {
  if (swayed.has(material)) return;
  swayed.add(material);

  const amplitude = options.amplitude ?? 0.12;
  const height = Math.max(0.05, options.height ?? 1);
  const stiffness = options.stiffness ?? 1;

  // Chained rather than assigned, the same way `applyWetLook` chains onto this:
  // a material can already carry another patch, and overwriting either hook
  // would silently drop it.
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;

  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.uWindTime = wind.uniforms.uWindTime;
    shader.uniforms.uWindDirection = wind.uniforms.uWindDirection;
    shader.uniforms.uWindStrength = wind.uniforms.uWindStrength;
    shader.uniforms.uWindSpeed = wind.uniforms.uWindSpeed;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_SHADER_CHUNK}`)
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
         #ifdef USE_INSTANCING
           vec3 windOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
         #else
           vec3 windOrigin = vec3(0.0);
         #endif
         vec3 windBase = (modelMatrix * vec4(windOrigin, 1.0)).xyz;

         float windGust = windGustAt(windBase.xz, uWindTime);
         float windBend = pow(clamp(transformed.y / ${height.toFixed(4)}, 0.0, 1.0), ${stiffness.toFixed(3)}) * ${amplitude.toFixed(4)};
         float windRate = 1.3 + uWindStrength * 3.2;
         // Offsetting the phase by where the plant stands is what turns a field
         // of identical models into a field that ripples.
         float windPhase = dot(windBase.xz, vec2(0.41, 0.27));
         float windWave =
           sin(uWindTime * windRate + windPhase) * 0.45 + sin(uWindTime * windRate * 0.63 + windPhase * 1.7) * 0.28;

         vec2 windPush = uWindDirection * (windGust + windWave * (0.22 + windGust * 0.7));
         vec2 windCross =
           vec2(-uWindDirection.y, uWindDirection.x) *
           cos(uWindTime * windRate * 0.81 + windPhase) *
           0.24 *
           (0.3 + windGust);
         vec2 windOffset = (windPush + windCross) * windBend;

         transformed.xz += windOffset;
         // A stem that bends does not stretch: the tip drops by about d²/2h.
         // Without this a hard gust visibly grows the grass.
         transformed.y -= dot(windOffset, windOffset) / ${(2 * height).toFixed(4)};`
      );
  };

  // Three keys its program cache on the material's own settings, so without this
  // every swayed material would be handed the first one's compiled shader and
  // the whole world would sway with one amplitude.
  material.customProgramCacheKey = () => `${previousKey.call(material)}|wind:${amplitude}:${height}:${stiffness}`;
  material.needsUpdate = true;
};
