import { createPrng, type LocationRecipe, type Terrain, type TerrainProfile } from '@otrip/world';
import {
  AdditiveBlending,
  BackSide,
  CircleGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Material,
} from 'three';

import type { ResolvedSky } from './sky-palette';
import { WIND_SHADER_CHUNK, type Wind } from './wind';

// The box and the shell are both sized to contain the camera rather than the
// walker: the third-person camera trails 8.5m behind and can be pulled out to
// 26, and rain that stops short of it is rain you are looking at from outside.
/** Half-extent of the box of falling rain carried around the viewer, in metres. */
const RADIUS = 30;
/** Height of the recycling column: a drop leaving the bottom reappears at the top. */
const COLUMN = 26;
/** How far above the viewer's feet the column starts, in metres. */
const CEILING = 16;
/** Where splashes are placed, in metres around the viewer. */
const SPLASH_RADIUS = 18;
/** Seconds a splash ring lives. */
const SPLASH_LIFE = 0.85;
/** Radius of the mist shell around the viewer, in metres. */
const VEIL_RADIUS = 34;
const EYE = 1.6;

// The near column and the veil are both 30-odd metres across, carried by
// `follow`. The default camera is the orbit a kilometre out, so a forecast of
// "Mưa phùn" used to render as a perfectly dry valley with a bubble of rain
// somewhere in the middle of it. The far field is the rain you see at range:
// curtains standing on the land across the whole map, drifting downwind.
/** Metres from the camera at which a curtain starts to exist; inside it the near column owns the view. */
const FAR_FADE = 55;
/** Metres a curtain spans across the view, and how tall it stands. */
const FAR_WIDTH = 130;
const FAR_WIDTH_SPREAD = 190;
const FAR_HEIGHT = 170;
const FAR_HEIGHT_SPREAD = 260;
/** Fraction of the mean wind a curtain is carried at — slower than a drop, being a whole squall. */
const FAR_DRIFT = 0.55;
/** Metres the foot of a curtain is sunk into the land, so its bottom edge never floats. */
const FAR_SINK = 8;
/** Metres either side used to read the slope a splash lies on. */
const SLOPE_STEP = 0.8;
/** Seconds of a strike, leader to afterglow. */
const FLASH_LIFE = 0.42;
/** Time constants in seconds: soaked in under a minute, dry in several. */
const WET_SECONDS = 18;
const DRY_SECONDS = 210;

const UP = new Vector3(0, 1, 0);
const STREAK_DAY = new Color('#9fb6cf');
const STREAK_NIGHT = new Color('#49607c');
const SPLASH_COLOUR = new Color('#bcd0e2');

type Mood = {
  /** Fall speed at full intensity, m/s. Real drops do 2 m/s drizzling, 9 m/s at 5mm. */
  fall: number;
  /** Fraction of the wind speed a drop picks up — this is what slants the rain. */
  slant: number;
  /** Drop size, as a multiplier on streak width and splash radius. */
  drop: number;
  /** How hard gust fronts carve the rain into curtains. */
  sheet: number;
  veil: number;
  /** Strikes per minute at full intensity. */
  lightning: number;
};

/**
 * Rain is not one thing in Vietnam. In the delta it is warm, fat and falls
 * nearly straight down onto standing water, and it thunders. On a ridge at
 * 1600m it arrives sideways out of the cloud you are already standing inside,
 * in sheets, and hardly lands at all.
 */
const MOODS: Record<TerrainProfile, Mood> = {
  ridge: { fall: 6.4, slant: 0.75, drop: 0.85, sheet: 0.85, veil: 1.4, lightning: 1.2 },
  karst: { fall: 7.6, slant: 0.5, drop: 1, sheet: 0.5, veil: 1, lightning: 1.6 },
  lowland: { fall: 8.6, slant: 0.38, drop: 1.25, sheet: 0.4, veil: 0.85, lightning: 2.4 },
};

/**
 * Every drop's whole life is in the vertex shader: its fall wraps modulo the
 * column height and its home wraps into the box around the viewer, so `update`
 * writes uniforms and nothing else. Nothing is respawned, nothing is allocated,
 * and the drop count can be cut by lowering `count` alone.
 */
const STREAK_VERTEX = /* glsl */ `
  ${WIND_SHADER_CHUNK}

  attribute vec3 aDrop;
  attribute vec2 aSeed;

  uniform float uTime;
  uniform vec3 uCentre;
  uniform float uFall;
  uniform float uSlant;
  uniform float uLength;
  uniform float uWidth;
  uniform float uSheet;

  varying vec2 vQuad;
  varying float vFade;

  void main() {
    float speed = uFall * (0.8 + aSeed.x * 0.4);

    // Carried downwind as it falls. The wrap below absorbs the drift, so it can
    // run all day without the field walking off into the distance.
    vec2 drift = uWindDirection * (uWindSpeed * uSlant * uTime);
    vec2 home = aDrop.xz + drift;
    vec2 span = vec2(${(RADIUS * 2).toFixed(1)});
    vec2 xz = home + floor((uCentre.xz - home) / span + 0.5) * span;

    float fallen = mod(aDrop.y + uTime * speed, ${COLUMN.toFixed(1)});
    vec3 head = vec3(xz.x, uCentre.y + ${CEILING.toFixed(1)} - fallen, xz.y);

    // The streak lies along the drop's own path, so wind slants it for free, and
    // a faster drop draws a longer one.
    vec3 travel = vec3(uWindDirection.x, 0.0, uWindDirection.y) * (uWindSpeed * uSlant) - vec3(0.0, speed, 0.0);
    vec3 fallDir = normalize(travel);
    float streak = length(travel) * uLength * (0.7 + aSeed.y * 0.6);

    vec3 toEye = cameraPosition - head;
    float dist = length(toEye);
    toEye /= max(dist, 0.001);

    vec3 side = cross(fallDir, toEye);
    float sideLength = length(side);
    // Looking straight down the rain's path there is no billboard plane, and the
    // streak is a dot from there anyway, so any perpendicular will do.
    side = sideLength > 0.001 ? side / sideLength : vec3(1.0, 0.0, 0.0);

    // A streak thinner than a pixel renders as nothing at all, which emptied out
    // the far half of the box; widening with distance keeps it populated.
    float width = uWidth * mix(1.0, 2.4, clamp(dist / ${RADIUS.toFixed(1)}, 0.0, 1.0));
    vec3 world = head + side * (position.x * width) - fallDir * (uv.y * streak);

    float near = smoothstep(0.5, 2.6, dist);
    float far = 1.0 - smoothstep(${(RADIUS * 0.6).toFixed(1)}, ${RADIUS.toFixed(1)}, dist);
    float born = smoothstep(0.0, 2.0, fallen);
    // Sheets. The gust front thins the rain behind it, so curtains sweep across
    // the hillside instead of the whole sky falling evenly — and because the
    // front comes from the shared wind field, the grass bends in the same ones.
    float sheet = mix(1.0, 0.25 + 1.1 * windGustAt(xz, uWindTime), uSheet);

    vFade = near * far * born * sheet;
    vQuad = vec2(position.x * 2.0, uv.y);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const STREAK_FRAGMENT = /* glsl */ `
  uniform vec3 uColour;
  uniform float uOpacity;
  uniform float uFlash;

  varying vec2 vQuad;
  varying float vFade;

  void main() {
    float across = 1.0 - abs(vQuad.x);
    if (across <= 0.0) discard;
    // Bright at the drop and fading up the tail. That gradient is the only thing
    // separating a falling drop from a scratch on the lens.
    float tail = pow(1.0 - vQuad.y, 1.5);
    float alpha = pow(across, 1.6) * tail * vFade * uOpacity;
    gl_FragColor = vec4(uColour * (1.0 + uFlash * 2.5), alpha);
  }
`;

/**
 * One disc per splash, carrying two expanding crests drawn analytically in the
 * fragment shader. The CPU only ever writes where a splash is and when it
 * started; the growth and the fade are free.
 */
const SPLASH_VERTEX = /* glsl */ `
  attribute float aBirth;
  attribute float aSeed;
  attribute float aWater;

  uniform float uTime;
  uniform float uRadius;

  varying float vRadial;
  varying float vAge;
  varying float vWater;

  void main() {
    float age = clamp((uTime - aBirth) / ${SPLASH_LIFE.toFixed(2)}, 0.0, 1.0);
    // On water the ring spreads wide and keeps going; on soil the crown collapses
    // where it landed.
    float reach = uRadius * mix(1.0, 2.4, aWater) * (0.7 + aSeed * 0.6);
    // sqrt: fast out of the impact, then stalling, which is how a crown dies.
    float radius = reach * (0.18 + 0.82 * sqrt(age));

    vRadial = length(position.xz);
    vAge = age;
    vWater = aWater;

    // Lifted clear of the surface it sits on, and rising a little as it spreads.
    vec3 local = vec3(position.x * radius, 0.03 + age * 0.04, position.z * radius);
    gl_Position = projectionMatrix * viewMatrix * instanceMatrix * vec4(local, 1.0);
  }
`;

const SPLASH_FRAGMENT = /* glsl */ `
  uniform vec3 uColour;
  uniform float uOpacity;

  varying float vRadial;
  varying float vAge;
  varying float vWater;

  void main() {
    // Two crests out of one disc: the rim of the splash and the ripple chasing it.
    float rimEdge = (vRadial - 0.86) * 9.0;
    float innerEdge = (vRadial - 0.42) * 7.0;
    float rim = exp(-rimEdge * rimEdge);
    float inner = exp(-innerEdge * innerEdge) * mix(0.25, 0.6, vWater);
    // The impact itself, gone in the first fifth of a second.
    float strike = (1.0 - smoothstep(0.0, 0.3, vRadial)) * (1.0 - smoothstep(0.0, 0.25, vAge)) * 0.8;

    float fade = (1.0 - vAge) * (1.0 - vAge);
    float alpha = (rim + inner + strike) * fade * uOpacity;
    if (alpha <= 0.002) discard;
    gl_FragColor = vec4(uColour, alpha);
  }
`;

const VEIL_VERTEX = /* glsl */ `
  varying vec3 vLocal;
  varying float vInside;

  void main() {
    vLocal = normalize(position);
    // The veil only exists for someone standing in it. Seen from across the
    // valley — orbiting the map, say — a grey shell would hang over the viewer's
    // feet like a bubble, so it fades out once the camera is outside it.
    float away = length(cameraPosition - modelMatrix[3].xyz);
    vInside = 1.0 - smoothstep(${(VEIL_RADIUS * 0.95).toFixed(2)}, ${(VEIL_RADIUS * 1.7).toFixed(2)}, away);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const VEIL_FRAGMENT = /* glsl */ `
  ${WIND_SHADER_CHUNK}

  uniform vec3 uColour;
  uniform float uDensity;
  uniform float uTime;
  uniform float uFlash;

  varying vec3 vLocal;
  varying float vInside;

  void main() {
    // Thick towards the horizon and thin overhead: looking up through rain you
    // still see sky, looking out you see a wall of it.
    float horizon = pow(1.0 - abs(vLocal.y), 1.7);
    // Shreds of mist blowing past, from crossing waves rather than a texture —
    // at this opacity there is nothing a texture would add.
    float drift = dot(vLocal.xz, uWindDirection) * 4.0 - uTime * (0.6 + uWindSpeed * 0.25);
    float shred = 0.55 + 0.45 * sin(drift) * sin(drift * 0.37 + vLocal.y * 5.0 + uTime * 0.2);

    float alpha = uDensity * horizon * shred * vInside;
    if (alpha <= 0.002) discard;
    gl_FragColor = vec4(uColour * (1.0 + uFlash * 1.8), clamp(alpha, 0.0, 0.92));
  }
`;

/**
 * One curtain is a vertical sheet standing on the land, billboarded about Y in
 * the shader so it always faces the camera. The CPU writes only where each one
 * stands; its shape, its softness and the gust blowing through it are the
 * fragment shader's.
 */
const FAR_VERTEX = /* glsl */ `
  ${WIND_SHADER_CHUNK}

  attribute vec2 aSize;
  attribute float aFar;

  varying vec2 vUv;
  varying float vFade;
  varying float vGust;
  varying float vSeed;

  void main() {
    vec3 origin = instanceMatrix[3].xyz;
    vec2 toEye = cameraPosition.xz - origin.xz;
    float away = length(toEye);
    vec2 across = away > 0.001 ? normalize(vec2(-toEye.y, toEye.x)) : vec2(1.0, 0.0);

    vec3 world =
      origin + vec3(across.x, 0.0, across.y) * (position.x * aSize.x) + vec3(0.0, uv.y * aSize.y, 0.0);

    // A sheet a few metres from the eye is a grey wall across the screen, and
    // that ground already has the near column on it.
    vFade = smoothstep(${FAR_FADE.toFixed(1)}, ${(FAR_FADE * 3).toFixed(1)}, away);
    vGust = windGustAt(world.xz, uWindTime);
    vSeed = aFar;
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const FAR_FRAGMENT = /* glsl */ `
  uniform vec3 uColour;
  uniform float uDensity;
  uniform float uTime;
  uniform float uFlash;

  varying vec2 vUv;
  varying float vFade;
  varying float vGust;
  varying float vSeed;

  void main() {
    // Dense at the foot and feathering out towards the cloud base it hangs from,
    // with the very bottom edge softened so it does not cut a line on the hill.
    float column = (1.0 - smoothstep(0.3, 1.0, vUv.y)) * smoothstep(0.0, 0.07, vUv.y);
    // No seam where one curtain crosses the next.
    float across = sin(vUv.x * 3.1415927);
    float shred = 0.55 + 0.45 * sin(vUv.x * 11.0 + vSeed * 6.2831853 + uTime * 0.45 + vGust * 5.0);

    float alpha = uDensity * column * pow(across, 1.4) * shred * vFade * (0.3 + vGust * 1.0);
    if (alpha <= 0.003) discard;
    gl_FragColor = vec4(uColour * (1.0 + uFlash * 1.6), clamp(alpha, 0.0, 0.85));
  }
`;

export type WetLookOptions = {
  /** Fraction of the albedo lost when soaked. Wet soil and asphalt lose about 40%. */
  darken?: number;
  /** Fraction of the material's roughness taken away when soaked. */
  gloss?: number;
  /** 0 wets every face alike; 1 wets only what faces the sky, because water runs off a wall. */
  pooling?: number;
};

/** Patching twice would redeclare the uniform and fail to compile. */
const wetted = new WeakSet<Material>();

/**
 * Hands a material the rain's wetness, the way `applyWindSway` hands it the wind.
 * The drops are the smaller half of rain: what sells it is the ground going dark
 * and glossy and staying that way for minutes after the shower has passed, which
 * is the curve `wetness()` already describes and nothing was reading.
 *
 * Works on anything three compiles itself, so a MeshStandardMaterial off a loaded
 * model is fine. Flat ground takes the full effect and a wall takes almost none.
 */
export const applyWetLook = (material: Material, wet: { value: number }, options: WetLookOptions = {}): void => {
  if (wetted.has(material)) return;
  wetted.add(material);

  const darken = Math.min(0.9, Math.max(0, options.darken ?? 0.38));
  const gloss = Math.min(0.95, Math.max(0, options.gloss ?? 0.72));
  const pooling = Math.min(1, Math.max(0, options.pooling ?? 0.65));

  // Chained rather than assigned: a material can already be swayed by the wind,
  // and overwriting either hook would silently drop that patch.
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;

  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.uWetness = wet;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWetUp;')
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `#include <beginnormal_vertex>
         #ifdef USE_INSTANCING
           vec3 wetNormal = mat3(instanceMatrix) * objectNormal;
         #else
           vec3 wetNormal = objectNormal;
         #endif
         vWetUp = normalize(mat3(modelMatrix) * wetNormal).y;`
      );

    // A MeshBasicMaterial or a hand-written ShaderMaterial has none of the anchors
    // below, so the patch would apply to nothing and the surface would simply
    // never look wet. Silently producing nothing is the failure that costs most.
    for (const anchor of ['#include <map_fragment>', '#include <roughnessmap_fragment>']) {
      if (!shader.fragmentShader.includes(anchor)) {
        console.warn(`[otrip] applyWetLook: material has no ${anchor}; it will not look wet`);
      }
    }

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
         uniform float uWetness;
         varying float vWetUp;
         float wetAmount() {
           // A sixty-degree face ends up about half wet, which is where the water
           // stops running off fast enough to matter.
           return uWetness * mix(1.0, smoothstep(-0.1, 0.55, vWetUp), ${pooling.toFixed(3)});
         }`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>\n diffuseColor.rgb *= 1.0 - ${darken.toFixed(3)} * wetAmount();`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
         // Floored, because a perfectly smooth surface collapses the highlight to
         // a pinpoint and reads as plastic rather than as water.
         roughnessFactor = max(0.045, mix(roughnessFactor, roughnessFactor * ${(1 - gloss).toFixed(3)}, wetAmount()));`
      );
  };

  material.customProgramCacheKey = () => `${previousKey.call(material)}|wet:${darken}:${gloss}:${pooling}`;
  material.needsUpdate = true;
};

export type Rain = {
  group: Group;
  /** Carries the column, the splash field and the veil to the viewer. Call it every frame. */
  follow: (x: number, z: number) => void;
  update: (elapsed: number) => void;
  /** 0 is a clear sky and costs nothing; 1 is a monsoon downpour. */
  setIntensity: (value: number) => void;
  applySky: (colors: ResolvedSky, night: number) => void;
  /**
   * 0..1, how wet the world is. Climbs while it rains and drains over minutes
   * after, because a road stays dark and shiny long after the sky has cleared.
   */
  wetness: () => number;
  /**
   * The same value as a uniform, to hand to `applyWetLook`. Shared, so every wet
   * material dries on exactly the same curve as every other.
   */
  wetUniform: { value: number };
  /** 0..1 lightning, to add to the light for a frame. Zero almost always. */
  flash: () => number;
  dispose: () => void;
};

/**
 * Mưa. Rain you can stand in: streaks falling past you with the wind in them,
 * rings where they land on the ground and on the water, and the near air going
 * grey. @param budget streaks at full intensity — the quality tier's knob.
 */
export const createRain = (terrain: Terrain, recipe: LocationRecipe, wind: Wind, budget: number): Rain => {
  const random = createPrng(`${recipe.seed}:rain`);
  const mood = MOODS[recipe.terrain.profile];
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;

  const group = new Group();
  group.name = 'rain';
  group.visible = false;

  const maxDrops = Math.max(64, Math.round(budget));
  const maxSplashes = Math.min(240, Math.max(40, Math.round(budget * 0.05)));

  // The shaders work in world space and read `cameraPosition`, so the group has
  // to stay at the origin: everything is positioned by uniform instead.
  const centre = new Vector3();

  const flashUniform = { value: 0 };
  const timeUniform = { value: 0 };

  const streakGeometry = new PlaneGeometry(1, 1);
  const drops = new Float32Array(maxDrops * 3);
  const dropSeeds = new Float32Array(maxDrops * 2);
  for (let i = 0; i < maxDrops; i += 1) {
    drops[i * 3] = random() * RADIUS * 2;
    drops[i * 3 + 1] = random() * COLUMN;
    drops[i * 3 + 2] = random() * RADIUS * 2;
    dropSeeds[i * 2] = random();
    dropSeeds[i * 2 + 1] = random();
  }
  streakGeometry.setAttribute('aDrop', new InstancedBufferAttribute(drops, 3));
  streakGeometry.setAttribute('aSeed', new InstancedBufferAttribute(dropSeeds, 2));

  const streakMaterial = new ShaderMaterial({
    uniforms: {
      ...wind.uniforms,
      uTime: timeUniform,
      uCentre: { value: centre },
      uFall: { value: mood.fall },
      uSlant: { value: mood.slant },
      uLength: { value: 0.07 },
      uWidth: { value: 0.022 * mood.drop },
      uSheet: { value: mood.sheet },
      uColour: { value: STREAK_DAY.clone() },
      uOpacity: { value: 0 },
      uFlash: flashUniform,
    },
    vertexShader: STREAK_VERTEX,
    fragmentShader: STREAK_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });

  const streaks = new InstancedMesh(streakGeometry, streakMaterial, maxDrops);
  streaks.name = 'rain-streaks';
  streaks.frustumCulled = false;
  streaks.renderOrder = 22;
  group.add(streaks);

  const splashGeometry = new CircleGeometry(1, 16);
  splashGeometry.rotateX(-Math.PI / 2);
  const births = new Float32Array(maxSplashes).fill(-1000);
  const splashSeeds = new Float32Array(maxSplashes);
  const onWater = new Float32Array(maxSplashes);
  const birthAttribute = new InstancedBufferAttribute(births, 1).setUsage(DynamicDrawUsage);
  const seedAttribute = new InstancedBufferAttribute(splashSeeds, 1).setUsage(DynamicDrawUsage);
  const waterAttribute = new InstancedBufferAttribute(onWater, 1).setUsage(DynamicDrawUsage);
  splashGeometry.setAttribute('aBirth', birthAttribute);
  splashGeometry.setAttribute('aSeed', seedAttribute);
  splashGeometry.setAttribute('aWater', waterAttribute);

  const splashMaterial = new ShaderMaterial({
    uniforms: {
      uTime: timeUniform,
      uRadius: { value: 0.18 * mood.drop },
      uColour: { value: SPLASH_COLOUR.clone() },
      uOpacity: { value: 0 },
    },
    vertexShader: SPLASH_VERTEX,
    fragmentShader: SPLASH_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });

  const splashes = new InstancedMesh(splashGeometry, splashMaterial, maxSplashes);
  splashes.name = 'rain-splashes';
  splashes.frustumCulled = false;
  splashes.renderOrder = 20;
  splashes.instanceMatrix.setUsage(DynamicDrawUsage);
  group.add(splashes);

  const veilGeometry = new SphereGeometry(VEIL_RADIUS, 20, 14);
  const veilMaterial = new ShaderMaterial({
    uniforms: {
      ...wind.uniforms,
      uTime: timeUniform,
      uColour: { value: new Color('#c3cdd6') },
      uDensity: { value: 0 },
      uFlash: flashUniform,
    },
    vertexShader: VEIL_VERTEX,
    fragmentShader: VEIL_FRAGMENT,
    transparent: true,
    side: BackSide,
    depthWrite: false,
  });

  const veil = new Mesh(veilGeometry, veilMaterial);
  veil.name = 'rain-veil';
  veil.renderOrder = 21;
  group.add(veil);

  const matrix = new Matrix4();
  const position = new Vector3();
  const normal = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3(1, 1, 1);
  const upright = new Quaternion();

  const half = terrain.size / 2;

  /** The surface a curtain stands on: the lake, where there is one, not its bed. */
  const surfaceAt = (x: number, z: number) => {
    const ground = terrain.heightAt(x, z);
    return ground < waterLevel ? waterLevel : ground;
  };

  // Enough curtains to cover a few square kilometres without becoming soup. The
  // drop budget is the only tier knob there is, so the count rides on it.
  const farCount = Math.min(40, Math.max(12, Math.round(budget / 260)));
  const farGeometry = new PlaneGeometry(1, 1);
  const farSizes = new Float32Array(farCount * 2);
  const farSeeds = new Float32Array(farCount);
  const curtains: { x: number; z: number }[] = [];
  for (let i = 0; i < farCount; i += 1) {
    farSizes[i * 2] = FAR_WIDTH + random() * FAR_WIDTH_SPREAD;
    farSizes[i * 2 + 1] = FAR_HEIGHT + random() * FAR_HEIGHT_SPREAD;
    farSeeds[i] = random();
    curtains.push({ x: (random() * 2 - 1) * half, z: (random() * 2 - 1) * half });
  }
  farGeometry.setAttribute('aSize', new InstancedBufferAttribute(farSizes, 2));
  farGeometry.setAttribute('aFar', new InstancedBufferAttribute(farSeeds, 1));

  const farMaterial = new ShaderMaterial({
    uniforms: {
      ...wind.uniforms,
      uTime: timeUniform,
      uColour: { value: new Color('#c3cdd6') },
      uDensity: { value: 0 },
      uFlash: flashUniform,
    },
    vertexShader: FAR_VERTEX,
    fragmentShader: FAR_FRAGMENT,
    transparent: true,
    depthWrite: false,
  });

  const far = new InstancedMesh(farGeometry, farMaterial, farCount);
  far.name = 'rain-far';
  far.frustumCulled = false;
  far.renderOrder = 18;
  far.instanceMatrix.setUsage(DynamicDrawUsage);
  group.add(far);

  const layOutCurtains = () => {
    for (let i = 0; i < farCount; i += 1) {
      const curtain = curtains[i];
      if (!curtain) continue;
      position.set(curtain.x, surfaceAt(curtain.x, curtain.z) - FAR_SINK, curtain.z);
      far.setMatrixAt(i, matrix.compose(position, upright, scale));
    }
    far.instanceMatrix.needsUpdate = true;
  };

  layOutCurtains();

  const placeSplash = (index: number, elapsed: number) => {
    // Biased outward so the density is even across the disc instead of piling up
    // on the viewer's feet.
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random()) * SPLASH_RADIUS;
    const x = Math.min(half, Math.max(-half, centre.x + Math.cos(angle) * distance));
    const z = Math.min(half, Math.max(-half, centre.z + Math.sin(angle) * distance));

    const ground = terrain.heightAt(x, z);
    const water = ground < waterLevel;

    if (water) {
      normal.copy(UP);
    } else {
      // Rings lie along the slope. A horizontal disc cuts into the hill on a
      // ridge, which is most of what you are standing on at Tà Xùa.
      normal
        .set(
          terrain.heightAt(x - SLOPE_STEP, z) - terrain.heightAt(x + SLOPE_STEP, z),
          2 * SLOPE_STEP,
          terrain.heightAt(x, z - SLOPE_STEP) - terrain.heightAt(x, z + SLOPE_STEP)
        )
        .normalize();
    }

    position.set(x, water ? waterLevel : ground, z);
    quaternion.setFromUnitVectors(UP, normal);
    splashes.setMatrixAt(index, matrix.compose(position, quaternion, scale));

    births[index] = elapsed;
    splashSeeds[index] = random();
    onWater[index] = water ? 1 : 0;
  };

  let intensity = 0;
  let wet = 0;
  const wetUniform = { value: 0 };
  let flash = 0;
  let previous = 0;
  let cursor = 0;
  let pending = 0;
  let nextStrike = 6;
  let struckAt = -100;

  const setIntensity = (value: number) => {
    intensity = Math.min(1, Math.max(0, value));
    group.visible = intensity > 0.015;

    // Drizzle is sparse and short; a downpour is not twice as dense, it is ten
    // times as dense, so the count runs ahead of the dial.
    const curve = Math.pow(intensity, 0.72);
    streaks.count = Math.max(1, Math.round(maxDrops * curve));
    splashes.count = Math.max(1, Math.round(maxSplashes * curve));
    cursor %= splashes.count;

    streakMaterial.uniforms.uOpacity.value = 0.16 + curve * 0.4;
    // Bigger drops fall faster and streak longer, so heavy rain reads as heavy
    // before you have counted anything.
    streakMaterial.uniforms.uFall.value = mood.fall * (0.68 + intensity * 0.46);
    streakMaterial.uniforms.uLength.value = 0.055 + curve * 0.035;
    splashMaterial.uniforms.uOpacity.value = 0.3 + curve * 0.5;
    veilMaterial.uniforms.uDensity.value = curve * 0.34 * mood.veil;
    // Drizzle at range is not a few hard shafts, it is most of the valley gone
    // soft, so the count stays high while the density drops away.
    far.count = Math.max(1, Math.round(farCount * Math.min(1, 0.45 + curve * 0.55)));
    farMaterial.uniforms.uDensity.value = curve * 0.4 * mood.veil;
  };

  const follow = (x: number, z: number) => {
    centre.set(Math.min(half, Math.max(-half, x)), terrain.heightAt(x, z), Math.min(half, Math.max(-half, z)));
    veil.position.set(centre.x, centre.y + EYE, centre.z);
  };

  return {
    group,
    follow,
    setIntensity,
    update: (elapsed) => {
      const delta = Math.min(0.1, Math.max(0, elapsed - previous));
      previous = elapsed;

      // Wetness has to keep draining long after the last drop, so it runs even
      // when there is nothing to draw.
      const target = Math.min(1, intensity * 1.7);
      const tau = target > wet ? WET_SECONDS : DRY_SECONDS;
      wet += (target - wet) * (1 - Math.exp(-delta / tau));
      // Written before the visibility bail-out: the ground stays dark for minutes
      // after the last drop, so drying has to run when there is nothing to draw.
      wetUniform.value = wet;

      const age = elapsed - struckAt;
      flash =
        age >= 0 && age < FLASH_LIFE
          ? // A dim leader, then the return stroke a tenth of a second behind it.
            Math.min(1, Math.exp(-age * 11) * 0.5 + Math.exp(-Math.abs(age - 0.11) * 16))
          : 0;

      if (!group.visible) return;

      timeUniform.value = elapsed;

      // Only a real downpour thunders, and the delta thunders harder than the ridge.
      if (intensity > 0.55 && elapsed > nextStrike) {
        struckAt = elapsed;
        nextStrike = elapsed + (55 + random() * 105) / Math.max(0.25, mood.lightning * (intensity - 0.5) * 2);
      }

      // The ring buffer is kept exactly saturated: one new splash for every one
      // that has finished. The cap stops a dropped frame firing a burst.
      pending += delta * (splashes.count / SPLASH_LIFE);
      let placed = 0;
      while (pending >= 1 && placed < 12) {
        pending -= 1;
        placed += 1;
        placeSplash(cursor, elapsed);
        cursor = (cursor + 1) % splashes.count;
      }

      // The squall crosses the whole map, so the curtains walk downwind and wrap
      // at the edge rather than being carried around the viewer: seen from the
      // orbit camera the far rain has to move across the land, not with you.
      const drift = wind.speed * FAR_DRIFT * delta;
      if (drift > 0) {
        for (const curtain of curtains) {
          curtain.x += wind.direction.x * drift;
          curtain.z += wind.direction.y * drift;
          if (curtain.x > half) curtain.x -= terrain.size;
          else if (curtain.x < -half) curtain.x += terrain.size;
          if (curtain.z > half) curtain.z -= terrain.size;
          else if (curtain.z < -half) curtain.z += terrain.size;
        }
        layOutCurtains();
      }

      if (placed > 0) {
        splashes.instanceMatrix.needsUpdate = true;
        birthAttribute.needsUpdate = true;
        seedAttribute.needsUpdate = true;
        waterAttribute.needsUpdate = true;
      }
    },
    applySky: (colors, night) => {
      const dark = Math.min(1, Math.max(0, night));
      streakMaterial.uniforms.uColour.value.copy(STREAK_DAY).lerp(STREAK_NIGHT, dark);
      splashMaterial.uniforms.uColour.value.copy(SPLASH_COLOUR).lerp(STREAK_NIGHT, dark * 0.8);
      // The veil is air, so it has to be the colour of the air: taking the fog
      // colour is what keeps it from being a grey smear at sunset.
      veilMaterial.uniforms.uColour.value.copy(colors.fog).lerp(colors.cloudShadow, 0.3);
      // A curtain across the valley is lit by the same sky, only further into it.
      farMaterial.uniforms.uColour.value.copy(colors.fog).lerp(colors.cloudShadow, 0.45);
    },
    wetness: () => wet,
    wetUniform,
    flash: () => flash,
    dispose: () => {
      streakGeometry.dispose();
      splashGeometry.dispose();
      veilGeometry.dispose();
      farGeometry.dispose();
      streakMaterial.dispose();
      splashMaterial.dispose();
      veilMaterial.dispose();
      farMaterial.dispose();
      streaks.dispose();
      splashes.dispose();
      far.dispose();
      group.clear();
    },
  };
};
