import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Points,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type Material,
} from 'three';

import type { ResolvedSky } from './sky-palette';
import type { StreamFall } from './stream';

const GRAVITY = 9.81;

/**
 * Metres of free fall before a coherent sheet of water tears into strands and
 * droplets. Below this a fall is a glassy curtain; a sixty-metre fall is a
 * curtain for its first fifteen metres and rain for the rest, which is the whole
 * reason a tall fall looks nothing like a scaled-up small one.
 */
const BREAKUP_LENGTH = 14;

/** Resolution of the falling sheet: down the fall, then across it. */
const SHEET_ROWS = 26;
const SHEET_COLUMNS = 13;

const POOL_RINGS = 11;
const POOL_SEGMENTS = 40;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

export type WaterfallBudget = {
  /** How many falls are built. The rest stay as the stream's own white water. */
  falls: number;
  /**
   * Mist density, not a particle count: 0 turns the spray off without losing
   * the fall, 1 is normal. How many puffs a fall needs is a function of its
   * drop, which only this module knows, so the caller only says how much.
   */
  spray?: number;
};

/** Mist puffs for a fall of this drop at density 1. A 70 m fall is a weather system. */
const mistCount = (drop: number) => Math.round(70 + drop * 9);
/** Points across every fall, so ultra with six falls cannot flood the frame. */
const MIST_CEILING = 2600;

/** What main needs in order to put the sound of a fall in the right place. */
export type WaterfallSound = {
  x: number;
  y: number;
  z: number;
  /** Metres of drop. A four-metre cascade is a trickle; a sixty-metre fall is a roar. */
  drop: number;
  /** Metres at which it should have faded to nothing. */
  radius: number;
  /** 0..1 relative loudness at the pool. */
  gain: number;
};

export type Waterfalls = {
  group: Group;
  /** One per built fall, loudest first. */
  sounds: WaterfallSound[];
  applySky: (colors: ResolvedSky, sunDirection: Vector3, night: number, light: number) => void;
  /** Metres per second in XZ. The spray drifts with it. */
  setWind: (x: number, z: number) => void;
  update: (elapsed: number) => void;
  dispose: () => void;
};

type Shaped = {
  fall: StreamFall;
  /** Speed the water leaves the lip at, from the horizontal distance it covers. */
  launch: number;
  impact: number;
  /** Fraction of the drop at which the sheet stops being a sheet. */
  breakup: number;
  poolRadius: number;
  poolY: number;
};

/**
 * Everything about a fall that scales with its drop, worked out once. The sheet,
 * the strand count, the pool and the mist all read off this, which is what makes
 * a four-metre cascade a different object from a sixty-metre fall rather than
 * the same object at a different size.
 */
const shape = (fall: StreamFall, waterLevel: number): Shaped => {
  const flightTime = Math.sqrt((2 * fall.drop) / GRAVITY);
  return {
    fall,
    launch: clamp(fall.run / flightTime, 1.0, 7),
    impact: Math.sqrt(2 * GRAVITY * fall.drop),
    breakup: clamp(BREAKUP_LENGTH / fall.drop, 0.12, 1),
    // Scoured out by the falling water, so it grows with the drop and the
    // discharge — and shrinks where the ground below is too steep to hold one.
    poolRadius: (1.4 + 0.92 * Math.sqrt(fall.drop) * (0.6 + 0.4 * Math.sqrt(fall.flow))) / (1 + fall.landing * 0.8),
    poolY: Math.max(fall.base.y, waterLevel) + 0.07,
  };
};

/**
 * Where the cliff is, as a function of how far down the fall you are. The bed
 * profile is sampled lip to base, so inverting it gives the horizontal distance
 * at which the rock has dropped to a given height — which is what the sheet has
 * to clear.
 */
const faceDistanceAt = (fall: StreamFall, height: number): number => {
  const samples = fall.profile.length;
  for (let i = 0; i < samples; i += 1) {
    if (fall.profile[i] <= height) {
      if (i === 0) return 0;
      const above = fall.profile[i - 1];
      const below = fall.profile[i];
      const t = above - below < 1e-4 ? 0 : (above - height) / (above - below);
      return (fall.run * (i - 1 + t)) / (samples - 1);
    }
  }
  return fall.run;
};

// --- the rock behind the water ----------------------------------------------

/**
 * A concave alcove standing clear of the hillside. It is built from the bed
 * profile and pushed downstream, which is what guarantees it is outside the
 * terrain: at any given height, moving downhill moves to lower ground. The
 * edges stand further out than the middle, so the fall sits in a recess rather
 * than against a flat wall.
 */
const buildRockFace = (terrain: Terrain, fall: StreamFall, rock: Color): BufferGeometry => {
  const rows = fall.profile.length;
  const columns = 9;
  const positions = new Float32Array(rows * columns * 3);
  const colors = new Float32Array(rows * columns * 3);
  const indices: number[] = [];
  const shade = new Color();
  const acrossX = -fall.direction.z;
  const acrossZ = fall.direction.x;
  const span = fall.halfWidth * 2.1 + 1.2;

  for (let row = 0; row < rows; row += 1) {
    const down = row / (rows - 1);
    const height = fall.profile[row];
    for (let column = 0; column < columns; column += 1) {
      const u = (column / (columns - 1)) * 2 - 1;
      const outward = 0.55 + 1.35 * u * u;
      const alongRun = (fall.run * row) / (rows - 1) + outward;
      const x = fall.lip.x + fall.direction.x * alongRun + acrossX * u * span;
      const z = fall.lip.z + fall.direction.z * alongRun + acrossZ * u * span;
      // A side wall can stand higher than the centre line, so lift the edge
      // clear of it rather than letting the face sink into the gully it is in.
      const ground = terrain.heightAt(x, z);
      const y = Math.min(fall.lip.y + 1.5, Math.max(height, ground + 0.12));

      const index = row * columns + column;
      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;

      // Permanently wet behind the water and in the splash zone, drying out at
      // the margins. Wet rock is darker than dry rock by a long way.
      const wet = (1 - Math.min(1, Math.abs(u) * 1.5)) * 0.75 + smoothstep(0.55, 1, down) * 0.35;
      shade.copy(rock).multiplyScalar(1 - clamp(wet, 0, 1) * 0.55);
      colors[index * 3] = shade.r;
      colors[index * 3 + 1] = shade.g;
      colors[index * 3 + 2] = shade.b;
    }
  }

  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const a = row * columns + column;
      const b = (row + 1) * columns + column;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

// --- the falling water ------------------------------------------------------

type SheetAttributes = {
  positions: number[];
  fallen: number[];
  across: number[];
  flight: number[];
  broken: number[];
  thickness: number[];
  indices: number[];
};

const emptySheet = (): SheetAttributes => ({
  positions: [],
  fallen: [],
  across: [],
  flight: [],
  broken: [],
  thickness: [],
  indices: [],
});

/**
 * The sheet. Each row is a parcel of water that left the lip at the same moment:
 * its horizontal travel is the launch speed times the time of flight, and where
 * the cliff bulges out past that parabola the water lands on rock and runs down
 * it instead. It thins as it speeds up — continuity, nothing more — and fans out
 * once it has fallen far enough to come apart.
 */
const addSheet = (into: SheetAttributes, shaped: Shaped): void => {
  const { fall } = shaped;
  const base = into.positions.length / 3;
  const acrossX = -fall.direction.z;
  const acrossZ = fall.direction.x;

  for (let row = 0; row < SHEET_ROWS; row += 1) {
    const down = row / (SHEET_ROWS - 1);
    const fallen = down * fall.drop;
    const flight = Math.sqrt((2 * fallen) / GRAVITY);
    const speed = Math.max(0.6, GRAVITY * flight);
    const height = fall.lip.y - fallen;
    const alongRun = Math.max(shaped.launch * flight, faceDistanceAt(fall, height) + 0.3);
    const broken = smoothstep(shaped.breakup, Math.min(1, shaped.breakup + 0.45), down);
    // Thickness falls as the speed rises, which is why a tall fall is a slab at
    // the top and a veil at the bottom.
    const thickness = clamp(shaped.launch / speed, 0.08, 1);
    const halfWidth = fall.halfWidth * (1 - 0.22 * down) * (1 + 1.25 * broken);

    for (let column = 0; column < SHEET_COLUMNS; column += 1) {
      const u = (column / (SHEET_COLUMNS - 1)) * 2 - 1;
      // The curtain is a shallow arc, bowed back into the alcove at its edges.
      const bow = u * u * fall.halfWidth * 0.45;
      const reach = alongRun - bow;
      into.positions.push(
        fall.lip.x + fall.direction.x * reach + acrossX * u * halfWidth,
        height,
        fall.lip.z + fall.direction.z * reach + acrossZ * u * halfWidth
      );
      into.fallen.push(down);
      into.across.push(u);
      into.flight.push(flight);
      into.broken.push(broken);
      into.thickness.push(thickness);
    }
  }

  for (let row = 0; row < SHEET_ROWS - 1; row += 1) {
    for (let column = 0; column < SHEET_COLUMNS - 1; column += 1) {
      const a = base + row * SHEET_COLUMNS + column;
      const b = base + (row + 1) * SHEET_COLUMNS + column;
      into.indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
};

/**
 * Separate ropes of water below the breakup point. A sheet that merely goes
 * transparent still reads as a sheet; what a tall fall actually does is split
 * into a handful of strands that wander independently, and these are them.
 */
const addStrands = (into: SheetAttributes, shaped: Shaped, random: () => number): void => {
  const { fall } = shaped;
  const count = clamp(Math.round(2 + fall.drop / 9), 3, 8);
  const acrossX = -fall.direction.z;
  const acrossZ = fall.direction.x;
  const rows = 10;

  for (let strand = 0; strand < count; strand += 1) {
    const home = (strand / (count - 1)) * 2 - 1;
    const wander = (random() * 2 - 1) * 0.5;
    const width = fall.halfWidth * (0.1 + random() * 0.14);
    const base = into.positions.length / 3;

    for (let row = 0; row < rows; row += 1) {
      const t = row / (rows - 1);
      // Start a little above the breakup, so a strand grows out of the sheet
      // instead of appearing beside it.
      const down = shaped.breakup * 0.85 + (1 - shaped.breakup * 0.85) * t;
      const fallen = down * fall.drop;
      const flight = Math.sqrt((2 * fallen) / GRAVITY);
      const speed = Math.max(0.6, GRAVITY * flight);
      const height = fall.lip.y - fallen;
      const alongRun = Math.max(shaped.launch * flight, faceDistanceAt(fall, height) + 0.32);
      const offset = (home + wander * t) * fall.halfWidth * (1 + 1.1 * t);

      for (const side of [-1, 1]) {
        into.positions.push(
          fall.lip.x + fall.direction.x * alongRun + acrossX * (offset + side * width),
          height,
          fall.lip.z + fall.direction.z * alongRun + acrossZ * (offset + side * width)
        );
        into.fallen.push(down);
        into.across.push(side);
        into.flight.push(flight);
        into.broken.push(clamp(0.45 + t * 0.55, 0, 1));
        into.thickness.push(clamp(shaped.launch / speed, 0.08, 1) * 0.8);
      }
    }

    for (let row = 0; row < rows - 1; row += 1) {
      const a = base + row * 2;
      into.indices.push(a, a + 2, a + 3, a, a + 3, a + 1);
    }
  }
};

/**
 * The lip: the last couple of metres of streambed, where the water stops being
 * a stream and becomes a fall. It accelerates and draws down over the edge,
 * which is a visible thing — the surface goes from rippled to glassy right there.
 */
const addLip = (into: SheetAttributes, terrain: Terrain, shaped: Shaped): void => {
  const { fall } = shaped;
  const base = into.positions.length / 3;
  const acrossX = -fall.direction.z;
  const acrossZ = fall.direction.x;
  const rows = 6;
  const approach = 3.2;

  for (let row = 0; row < rows; row += 1) {
    const t = row / (rows - 1);
    const alongRun = -approach * (1 - t) + 0.45 * t * t;
    const x = fall.lip.x + fall.direction.x * alongRun;
    const z = fall.lip.z + fall.direction.z * alongRun;
    const bed = terrain.heightAt(x, z);
    // Still water piles up behind the crest and fast water draws down over it,
    // which is what makes the edge read as an edge.
    const y = Math.max(bed, fall.lip.y) + 0.14 * (1 - t) - 0.1 * t;
    const halfWidth = fall.halfWidth * (1 - 0.1 * t);

    for (let column = 0; column < SHEET_COLUMNS; column += 1) {
      const u = (column / (SHEET_COLUMNS - 1)) * 2 - 1;
      // Convex across, so the crest catches the light along one line.
      const crown = (1 - u * u) * 0.07;
      into.positions.push(x + acrossX * u * halfWidth, y + crown, z + acrossZ * u * halfWidth);
      into.fallen.push(0);
      into.across.push(u);
      // Negative flight time: upstream of the lip, and the streaks arrive from
      // there rather than starting at the edge.
      into.flight.push(-0.6 * (1 - t));
      into.broken.push(0);
      into.thickness.push(1);
    }
  }

  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < SHEET_COLUMNS - 1; column += 1) {
      const a = base + row * SHEET_COLUMNS + column;
      const b = base + (row + 1) * SHEET_COLUMNS + column;
      into.indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
};

const sheetGeometry = (attributes: SheetAttributes): BufferGeometry => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(attributes.positions), 3));
  geometry.setAttribute('aFallen', new BufferAttribute(new Float32Array(attributes.fallen), 1));
  geometry.setAttribute('aAcross', new BufferAttribute(new Float32Array(attributes.across), 1));
  geometry.setAttribute('aFlight', new BufferAttribute(new Float32Array(attributes.flight), 1));
  geometry.setAttribute('aBroken', new BufferAttribute(new Float32Array(attributes.broken), 1));
  geometry.setAttribute('aThickness', new BufferAttribute(new Float32Array(attributes.thickness), 1));
  geometry.setIndex(attributes.indices);
  geometry.computeVertexNormals();
  return geometry;
};

const SHEET_VERTEX = /* glsl */ `
  #include <fog_pars_vertex>

  attribute float aFallen;
  attribute float aAcross;
  attribute float aFlight;
  attribute float aBroken;
  attribute float aThickness;

  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vFallen;
  varying float vAcross;
  varying float vFlight;
  varying float vBroken;
  varying float vThickness;

  void main() {
    vFallen = aFallen;
    vAcross = aAcross;
    vFlight = aFlight;
    vBroken = aBroken;
    vThickness = aThickness;

    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const SHEET_FRAGMENT = /* glsl */ `
  #include <fog_pars_fragment>

  uniform float uTime;
  uniform vec3 uSky;
  uniform vec3 uSunColor;
  uniform vec3 uSunDirection;
  uniform vec3 uBody;
  uniform float uNight;
  uniform float uLight;
  /** Ropes of water across the sheet. A wide fall is ribbed more finely. */
  uniform float uRibs;

  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vFallen;
  varying float vAcross;
  varying float vFlight;
  varying float vBroken;
  varying float vThickness;

  float hash12(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }

  float valueNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash12(cell), hash12(cell + vec2(1.0, 0.0)), f.x),
      mix(hash12(cell + vec2(0.0, 1.0)), hash12(cell + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  void main() {
    // Time of flight, not distance fallen. A mark on the water is carried by a
    // parcel that is accelerating, so holding its flight time constant while
    // uTime advances moves it down the sheet exactly as gravity would — and the
    // streaks stretch on their own as they go, with nothing else driving it.
    float carried = vFlight - uTime;

    float ribId = floor(vAcross * uRibs);
    float rib = fract(vAcross * uRibs);
    float ribShade = 0.55 + 0.45 * sin(rib * 6.283 + hash12(vec2(ribId, 3.1)) * 6.283);

    float streak = valueNoise(vec2(vAcross * uRibs * 1.4 + ribId, carried * 7.0)) * 0.6
                 + valueNoise(vec2(vAcross * uRibs * 3.1, carried * 15.0)) * 0.4;

    vec3 viewDir = normalize(cameraPosition - vWorld);
    vec3 sunDir = normalize(uSunDirection);
    vec3 normal = normalize(vNormal);

    // A sheet of water is lit from behind as much as from in front: standing
    // where the sun is on the far side of the fall is what makes it glow.
    float through = pow(max(dot(-viewDir, sunDir), 0.0), 2.2);
    float fresnel = pow(1.0 - abs(dot(normal, viewDir)), 3.0);
    vec3 halfway = normalize(sunDir + viewDir);
    float specular = pow(max(abs(dot(normal, halfway)), 0.0), 60.0);

    // Near the lip it is a coherent sheet with the colour of the water in it;
    // past breakup it is air with water in it, which is white.
    vec3 glass = mix(uBody, vec3(1.0), 0.35 + streak * 0.3);
    vec3 white = vec3(0.95, 0.97, 0.99);
    vec3 color = mix(glass, white, clamp(vBroken + 0.25 + streak * 0.3, 0.0, 1.0));
    color *= (0.55 + 0.45 * ribShade) * mix(0.1, 1.0, uLight);
    color += uSunColor * (through * (0.35 + vBroken * 0.9) + specular * 0.8) * uLight;
    color += uSky * fresnel * 0.3;
    color += vec3(0.7, 0.8, 1.0) * fresnel * 0.5 * uNight;

    // Nearly solid where it is thick and slow; where it has come apart, the
    // gaps between the drops are most of it.
    float alpha = clamp(0.3 + vThickness * 0.72, 0.0, 1.0);
    alpha *= mix(1.0, 0.42, vBroken);
    alpha *= mix(1.0, smoothstep(0.12, 0.72, streak), vBroken);
    // Feather the sides, or the curtain has a cut edge against the rock, and
    // the very bottom, where it is mist rather than water.
    alpha *= smoothstep(1.0, 0.72, abs(vAcross));
    alpha *= 1.0 - smoothstep(0.93, 1.0, vFallen) * 0.65;

    gl_FragColor = vec4(color, alpha);
    #include <fog_fragment>
  }
`;

// --- the plunge pool --------------------------------------------------------

/**
 * A disc of churned water at the foot of the fall. Where the ground stands
 * above the pool's surface the vertex is faded out rather than clipped, so the
 * pool fits whatever basin the terrain actually left there — including none.
 */
const buildPool = (terrain: Terrain, shaped: Shaped): BufferGeometry => {
  const centre = shaped.fall.base.clone().addScaledVector(shaped.fall.direction, shaped.poolRadius * 0.35);
  const count = (POOL_RINGS + 1) * POOL_SEGMENTS;
  const positions = new Float32Array(count * 3);
  const radius = new Float32Array(count);
  const angle = new Float32Array(count);
  const fit = new Float32Array(count);
  const indices: number[] = [];

  for (let ring = 0; ring <= POOL_RINGS; ring += 1) {
    const t = ring / POOL_RINGS;
    const r = t * shaped.poolRadius;
    for (let segment = 0; segment < POOL_SEGMENTS; segment += 1) {
      const theta = (segment / POOL_SEGMENTS) * Math.PI * 2;
      const x = centre.x + Math.cos(theta) * r;
      const z = centre.z + Math.sin(theta) * r;
      const index = ring * POOL_SEGMENTS + segment;
      positions[index * 3] = x;
      positions[index * 3 + 1] = shaped.poolY;
      positions[index * 3 + 2] = z;
      radius[index] = t;
      angle[index] = theta;
      fit[index] = clamp((shaped.poolY - terrain.heightAt(x, z)) / 0.35, 0, 1);
    }
  }

  for (let ring = 0; ring < POOL_RINGS; ring += 1) {
    for (let segment = 0; segment < POOL_SEGMENTS; segment += 1) {
      const next = (segment + 1) % POOL_SEGMENTS;
      const a = ring * POOL_SEGMENTS + segment;
      const b = ring * POOL_SEGMENTS + next;
      const c = (ring + 1) * POOL_SEGMENTS + segment;
      const d = (ring + 1) * POOL_SEGMENTS + next;
      indices.push(a, c, d, a, d, b);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aRadius', new BufferAttribute(radius, 1));
  geometry.setAttribute('aAngle', new BufferAttribute(angle, 1));
  geometry.setAttribute('aFit', new BufferAttribute(fit, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

const POOL_VERTEX = /* glsl */ `
  #include <fog_pars_vertex>

  attribute float aRadius;
  attribute float aAngle;
  attribute float aFit;

  uniform float uTime;
  uniform float uRadius;

  varying vec3 vWorld;
  varying float vRadius;
  varying float vAngle;
  varying float vFit;
  varying float vSlope;

  void main() {
    vRadius = aRadius;
    vAngle = aAngle;
    vFit = aFit;

    // Rings travelling outward from the impact, dying away as they go.
    float metres = aRadius * uRadius;
    float phase = (metres * 1.5 - uTime * 1.65) * 6.283;
    float decay = exp(-metres * 0.12) * smoothstep(0.08, 0.3, aRadius);
    float amplitude = 0.055 * decay;
    vSlope = cos(phase) * 1.5 * 6.283 * amplitude;

    vec3 local = position;
    local.y += sin(phase) * amplitude;

    vec4 world = modelMatrix * vec4(local, 1.0);
    vWorld = world.xyz;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const POOL_FRAGMENT = /* glsl */ `
  #include <fog_pars_fragment>

  uniform float uTime;
  uniform float uRadius;
  uniform vec3 uBody;
  uniform vec3 uSky;
  uniform vec3 uSunColor;
  uniform vec3 uSunDirection;
  uniform float uNight;
  uniform float uLight;
  /** Fraction of the radius taken by the boil where the plunging jet surfaces. */
  uniform float uBoil;

  varying vec3 vWorld;
  varying float vRadius;
  varying float vAngle;
  varying float vFit;
  varying float vSlope;

  float hash12(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }

  float valueNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash12(cell), hash12(cell + vec2(1.0, 0.0)), f.x),
      mix(hash12(cell + vec2(0.0, 1.0)), hash12(cell + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  void main() {
    float metres = vRadius * uRadius;
    // Foam is dragged outward from the impact, so the churn is sampled in a
    // frame that is itself moving outward.
    vec2 drift = vec2(vAngle * 2.4, metres * 0.55 - uTime * 0.9);
    float churn = valueNoise(drift * 2.0) * 0.55 + valueNoise(drift * 4.7) * 0.45;

    // Three things make the ring: white water boiling up where the jet
    // surfaces, the raft of foam the current pushes out from it, and the swirl
    // of streaks between them.
    float boil = 1.0 - smoothstep(0.0, uBoil, vRadius);
    float ring = smoothstep(uBoil * 0.55, uBoil * 1.15, vRadius) * (1.0 - smoothstep(uBoil * 1.1, 0.92, vRadius));
    float foam = clamp(boil * 1.15 + ring * (0.35 + churn * 0.75), 0.0, 1.0);
    foam = clamp(foam * (0.45 + churn * 0.8) + boil * 0.55, 0.0, 1.0);

    vec3 normal = normalize(vec3(-vSlope * cos(vAngle), 1.0, -vSlope * sin(vAngle)));
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
    vec3 sunDir = normalize(uSunDirection);
    vec3 halfway = normalize(sunDir + viewDir);
    float specular = pow(max(dot(normal, halfway), 0.0), 110.0);

    vec3 color = mix(uBody * uLight, vec3(0.93, 0.96, 0.97) * mix(0.12, 1.0, uLight), foam);
    color += uSky * fresnel * 0.4 * (1.0 - foam * 0.6);
    color += uSunColor * specular * 1.5 * (1.0 - foam * 0.5);
    color += vec3(0.76, 0.85, 1.0) * fresnel * 0.4 * uNight;

    float alpha = clamp(0.42 + foam * 0.55, 0.0, 0.97) * vFit;
    // Nothing to see past the edge of the disturbance.
    alpha *= 1.0 - smoothstep(0.78, 1.0, vRadius);

    gl_FragColor = vec4(color, alpha);
    #include <fog_fragment>
  }
`;

// --- spray and mist ---------------------------------------------------------

const MIST_VERTEX = /* glsl */ `
  #include <fog_pars_vertex>

  attribute float aSeed;
  attribute float aAngle;
  attribute float aRing;
  attribute float aDuration;
  attribute float aOffset;

  uniform float uTime;
  uniform float uRadius;
  uniform float uRise;
  uniform float uTau;
  uniform vec3 uWind;
  uniform float uSize;
  uniform float uPixelRatio;

  varying vec3 vWorld;
  varying float vFade;

  void main() {
    // The whole system is one expression of uTime, so a thousand particles cost
    // nothing per frame on the CPU and nothing is ever re-uploaded.
    float life = fract((uTime + aOffset) / aDuration);
    float age = life * aDuration;

    // Thrown up by the impact and stopped by drag: a rise that flattens off
    // rather than a ballistic arc, because mist has no momentum to speak of.
    float rise = uRise * uTau * (1.0 - exp(-age / uTau));
    float spread = (0.2 + aRing * 0.8) * uRadius + age * 0.45;
    vec3 local = vec3(cos(aAngle) * spread, rise, sin(aAngle) * spread);
    local += uWind * age;
    // A slow curl, so the cloud boils instead of inflating like a balloon.
    local.x += sin(age * 1.3 + aSeed * 31.0) * 0.5;
    local.z += cos(age * 1.1 + aSeed * 17.0) * 0.5;

    vec4 world = modelMatrix * vec4(position + local, 1.0);
    vWorld = world.xyz;
    // Named mvPosition because <fog_vertex> reads it from this scope. Without
    // the pair of fog includes here the fragment stage declares and reads
    // vFogDepth that this stage never wrote, and the program will not link.
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>

    vFade = smoothstep(0.0, 0.1, life) * (1.0 - smoothstep(0.45, 1.0, life));
    float distance = max(-mvPosition.z, 1.0);
    // Puffs expand as they rise, which is most of what says vapour rather than dust.
    gl_PointSize = (uSize * uPixelRatio * (0.3 + life * 1.9)) / distance;
  }
`;

const MIST_FRAGMENT = /* glsl */ `
  #include <fog_pars_fragment>

  uniform vec3 uSunColor;
  uniform vec3 uSunDirection;
  uniform vec3 uSky;
  uniform float uNight;
  uniform float uLight;
  uniform float uBow;

  varying vec3 vWorld;
  varying float vFade;

  /** Red at one end, violet at the other. Faint by design. */
  vec3 spectrum(float t) {
    return 0.5 + 0.5 * cos(6.283 * (t * 0.82 + vec3(0.0, 0.33, 0.67)));
  }

  void main() {
    float radius = length(gl_PointCoord - 0.5) * 2.0;
    if (radius > 1.0) discard;
    // No hard rim: a cloud of droplets has no edge.
    float body = pow(1.0 - radius, 1.7);

    vec3 ray = normalize(vWorld - cameraPosition);
    vec3 sunDir = normalize(uSunDirection);

    // Mist is seen by scattering, so it is brightest looking into the sun.
    float forward = pow(max(dot(ray, sunDir), 0.0), 3.0);
    vec3 color = mix(vec3(0.86, 0.90, 0.94), vec3(1.0), forward);
    color = mix(color * 0.25, color, uLight);
    color += uSunColor * forward * 0.9 * uLight;
    color += uSky * 0.25;
    color += vec3(0.62, 0.72, 1.0) * 0.3 * uNight;

    // The bow is a cone of forty-two degrees about the antisolar point, which
    // is why one only ever appears with the sun low and at your back. Computed
    // from the real angle rather than painted on, so it sits where it belongs
    // and sweeps across the spray as you walk around the fall.
    float theta = acos(clamp(dot(ray, -sunDir), -1.0, 1.0));
    float band = smoothstep(0.699, 0.713, theta) * (1.0 - smoothstep(0.735, 0.749, theta));
    float hue = clamp((theta - 0.703) / 0.042, 0.0, 1.0);
    color += spectrum(hue) * band * uBow * 0.55;

    gl_FragColor = vec4(color, body * vFade * 0.3);
    #include <fog_fragment>
  }
`;

type SkyUniforms = {
  uSky: { value: Color };
  uSunColor: { value: Color };
  uSunDirection: { value: Vector3 };
  uNight: { value: number };
  uLight: { value: number };
};

const buildMist = (
  shaped: Shaped,
  count: number,
  random: () => number
): {
  points: Points;
  geometry: BufferGeometry;
  material: ShaderMaterial;
  time: { value: number };
  sky: SkyUniforms;
  bow: { value: number };
  wind: { value: Vector3 };
} => {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const angles = new Float32Array(count);
  const rings = new Float32Array(count);
  const durations = new Float32Array(count);
  const offsets = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    seeds[i] = random();
    angles[i] = random() * Math.PI * 2;
    // Square root, so the ring is evenly covered instead of crowding the middle.
    rings[i] = Math.sqrt(random());
    durations[i] = 1.8 + random() * 3.4;
    // Spread the birth times, or the whole cloud pulses as one.
    offsets[i] = random() * 8;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  geometry.setAttribute('aAngle', new BufferAttribute(angles, 1));
  geometry.setAttribute('aRing', new BufferAttribute(rings, 1));
  geometry.setAttribute('aDuration', new BufferAttribute(durations, 1));
  geometry.setAttribute('aOffset', new BufferAttribute(offsets, 1));
  // Every particle sits at the origin and is moved by the shader, so a bounding
  // sphere computed from the attribute is a point and would cull the cloud.
  geometry.boundingSphere = null;

  const time = { value: 0 };
  const bow = { value: 0 };
  const wind = { value: new Vector3(0.6, 0, 0.25) };
  const sky: SkyUniforms = {
    uSky: { value: new Color('#ffffff') },
    uSunColor: { value: new Color('#ffffff') },
    uSunDirection: { value: new Vector3(0, 1, 0) },
    uNight: { value: 0 },
    uLight: { value: 1 },
  };

  const uniforms = Object.assign(UniformsUtils.clone(UniformsLib.fog), sky, {
    uTime: time,
    uBow: bow,
    uWind: wind,
    uRadius: { value: shaped.poolRadius },
    // A sixty-metre fall hits at thirty-four metres a second and throws its
    // spray twenty metres up; a four-metre one lifts a wisp.
    uRise: { value: 1.5 + shaped.impact * 0.18 },
    uTau: { value: 1.3 + shaped.fall.drop * 0.01 },
    uSize: { value: 150 + shaped.fall.drop * 2.4 },
    uPixelRatio: { value: typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio) },
  });

  const material = new ShaderMaterial({
    name: 'waterfall-mist',
    uniforms,
    vertexShader: MIST_VERTEX,
    fragmentShader: MIST_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    fog: true,
  });

  const points = new Points(geometry, material);
  points.name = 'waterfall-mist';
  points.position.copy(shaped.fall.base).addScaledVector(shaped.fall.direction, shaped.poolRadius * 0.3);
  points.position.y = shaped.poolY;
  points.frustumCulled = false;

  return { points, geometry, material, time, sky, bow, wind };
};

/**
 * Thác. Where a stream crosses a cliff the water leaves the ground, and that is
 * a different object from a stream: a lip, a curtain that thins and comes apart
 * as it accelerates, wet rock behind it, a pool boiling at the bottom and a
 * column of spray standing over the whole thing. Built from the drop the
 * terrain actually offers, so a four-metre cascade and a sixty-metre fall are
 * not the same model at two sizes.
 */
export const createWaterfalls = (
  terrain: Terrain,
  recipe: LocationRecipe,
  /** Candidates from `createStreams`, best first. */
  candidates: StreamFall[],
  budget: WaterfallBudget
): Waterfalls => {
  const group = new Group();
  group.name = 'waterfalls';

  const random = createPrng(`${recipe.seed}:waterfall`);
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;

  // A budget that arrives as undefined becomes NaN, and `chosen.length >= NaN`
  // is false for every length — so the cap would never bite and every candidate
  // on the map would be built. Read it positively and fall back.
  const wanted =
    typeof budget.falls === 'number' && Number.isFinite(budget.falls) ? Math.round(clamp(budget.falls, 0, 12)) : 2;
  const found = Array.isArray(candidates) ? candidates : [];

  // Spread them over the map. Four falls in one gully is one fall seen four
  // times; four in four valleys is four places worth walking to.
  const separation = terrain.size * 0.1;
  const chosen: StreamFall[] = [];
  for (const candidate of found) {
    if (chosen.length >= wanted) break;
    if (candidate.drop < 2.5) continue;
    if (chosen.some((other) => other.lip.distanceTo(candidate.lip) < separation)) continue;
    chosen.push(candidate);
  }

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const times: { value: number }[] = [];
  const skies: SkyUniforms[] = [];
  const bows: { value: number }[] = [];
  const winds: { value: Vector3 }[] = [];
  const sounds: WaterfallSound[] = [];

  const rockMaterial = new MeshStandardMaterial({
    name: 'waterfall-rock',
    vertexColors: true,
    flatShading: true,
    // Wet rock is the shiniest natural surface in the scene by a wide margin.
    roughness: 0.3,
    metalness: 0,
    side: DoubleSide,
  });
  materials.push(rockMaterial);

  const rockColor = new Color(recipe.ground.rock);
  const bodyColor = new Color(recipe.water?.shallow ?? '#6f9f98').lerp(new Color('#ffffff'), 0.25);
  const poolColor = new Color(recipe.water?.deep ?? '#2f4a4c').lerp(new Color('#ffffff'), 0.2);
  // Mist scales with the drop, so the big fall gets a column of spray and a
  // small one a wisp, rather than every fall getting an identical cloud. The
  // ceiling is applied as one factor across all of them, so the relative sizes
  // survive being trimmed.
  const density = typeof budget.spray === 'number' && Number.isFinite(budget.spray) ? clamp(budget.spray, 0, 2) : 0;
  const wantedMist = chosen.reduce((sum, fall) => sum + mistCount(fall.drop), 0) * density;
  const mistScale = wantedMist > MIST_CEILING ? MIST_CEILING / wantedMist : 1;

  const makeSky = (): SkyUniforms => ({
    uSky: { value: new Color('#ffffff') },
    uSunColor: { value: new Color('#ffffff') },
    uSunDirection: { value: new Vector3(0, 1, 0) },
    uNight: { value: 0 },
    uLight: { value: 1 },
  });

  for (const fall of chosen) {
    const shaped = shape(fall, waterLevel);
    const node = new Group();
    node.name = 'waterfall';
    group.add(node);

    const face = buildRockFace(terrain, fall, rockColor);
    geometries.push(face);
    const faceMesh = new Mesh(face, rockMaterial);
    faceMesh.receiveShadow = true;
    faceMesh.castShadow = true;
    node.add(faceMesh);

    const attributes = emptySheet();
    addLip(attributes, terrain, shaped);
    addSheet(attributes, shaped);
    // Only a fall tall enough to come apart has strands to come apart into.
    if (fall.drop > 10) addStrands(attributes, shaped, random);
    const sheet = sheetGeometry(attributes);
    geometries.push(sheet);

    const sheetTime = { value: 0 };
    const sheetSky = makeSky();
    const sheetMaterial = new ShaderMaterial({
      name: 'waterfall-sheet',
      uniforms: Object.assign(UniformsUtils.clone(UniformsLib.fog), sheetSky, {
        uTime: sheetTime,
        uBody: { value: bodyColor.clone() },
        uRibs: { value: clamp(Math.round(2 + fall.halfWidth * 1.6), 2, 9) },
      }),
      vertexShader: SHEET_VERTEX,
      fragmentShader: SHEET_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: true,
    });
    materials.push(sheetMaterial);
    times.push(sheetTime);
    skies.push(sheetSky);

    const sheetMesh = new Mesh(sheet, sheetMaterial);
    sheetMesh.renderOrder = 2;
    node.add(sheetMesh);

    const pool = buildPool(terrain, shaped);
    geometries.push(pool);
    const poolTime = { value: 0 };
    const poolSky = makeSky();
    const poolMaterial = new ShaderMaterial({
      name: 'waterfall-pool',
      uniforms: Object.assign(UniformsUtils.clone(UniformsLib.fog), poolSky, {
        uTime: poolTime,
        uRadius: { value: shaped.poolRadius },
        uBody: { value: poolColor.clone() },
        // A bigger fall drives its jet deeper, so it surfaces further out.
        uBoil: { value: clamp(0.18 + fall.drop * 0.004, 0.18, 0.4) },
      }),
      vertexShader: POOL_VERTEX,
      fragmentShader: POOL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: true,
    });
    materials.push(poolMaterial);
    times.push(poolTime);
    skies.push(poolSky);

    const poolMesh = new Mesh(pool, poolMaterial);
    poolMesh.renderOrder = 1;
    node.add(poolMesh);

    if (density > 0) {
      const share = Math.round(mistCount(fall.drop) * density * mistScale);
      // Below a dozen puffs it is not mist, it is litter.
      if (share >= 12) {
        const mist = buildMist(shaped, share, random);
        node.add(mist.points);
        geometries.push(mist.geometry);
        materials.push(mist.material);
        times.push(mist.time);
        skies.push(mist.sky);
        bows.push(mist.bow);
        winds.push(mist.wind);
      }
    }

    sounds.push({
      x: fall.base.x,
      y: shaped.poolY,
      z: fall.base.z,
      drop: fall.drop,
      // Sound carries a long way off a big fall.
      radius: 28 + fall.drop * 2.6,
      gain: clamp(0.28 + fall.drop / 55, 0.28, 1),
    });
  }

  sounds.sort((a, b) => b.gain - a.gain);

  return {
    group,
    sounds,
    applySky: (colors, sunDirection, night, light) => {
      for (const sky of skies) {
        sky.uSky.value.copy(colors.horizon);
        sky.uSunColor.value.copy(colors.sunCore);
        sky.uSunDirection.value.copy(sunDirection);
        sky.uNight.value = night;
        sky.uLight.value = light;
      }
      // A bow needs the sun up but low: a high sun puts the whole forty-two
      // degree cone underground, which is why there is never one at noon.
      const elevation = sunDirection.y;
      const strength = elevation <= 0 ? 0 : (1 - smoothstep(0.08, 0.45, elevation)) * smoothstep(0, 0.04, elevation);
      for (const bow of bows) bow.value = strength * light;
    },
    setWind: (x, z) => {
      for (const wind of winds) wind.value.set(x, 0, z);
    },
    update: (elapsed) => {
      for (const time of times) time.value = elapsed;
    },
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      group.clear();
    },
  };
};
