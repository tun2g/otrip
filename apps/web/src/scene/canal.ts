import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { ResolvedSky } from './sky-palette';

/**
 * Kênh, mương, bờ. A delta has no brooks: the water in it was put where it is,
 * in straight cuts with earth banks and a path along the top, running almost
 * level to a river it drains into. Tracing steepest descent across Hội An built
 * a mountain stream network with Manning velocities and nothing to fall down —
 * right code for the wrong place. This is what is actually there.
 *
 * Dimensions are the real ones: a main canal is 12–18 m across the water and
 * 2.2–3 m deep, a field ditch 3–6 m and about a metre, earth batters lie at
 * about 1:1.4, and the longitudinal fall is on the order of 1:5000 — which is
 * why the surface has to be interpolated along the run rather than sampled off
 * the ground the way a stream's is.
 */

/** Metres of fall per metre of run. A canal is engineered flat; this is 1:5500. */
const GRADIENT = 0.00018;
/**
 * Metres the water surface sits below the lowest ground the route has reached so
 * far. This, not the river's level, is what the surface is measured from — a
 * delta canal follows the land's drainage, and the figure is the freeboard of a
 * channel that is full but not spilling into the field beside it.
 */
const CUT = 0.55;
/** Horizontal metres per vertical metre on an earth batter. */
const BATTER = 1.4;
/** Metres the bank path stands above the water. */
const FREEBOARD = 0.85;
/** Width of the path along the top of the bank, metres. */
const BERM = 2.2;
/** Metres the section blends out into the field beyond the path. */
const BLEND = 3.5;
/** Metres between cross-sections. Straight runs need far fewer than a stream. */
const STATION = 9;
/** Metres of straight run between junctions, before the bearing may change. */
const RUN = 85;
/** Degrees either side the next run may turn. Small, or it stops reading as dug. */
const TURN = 16;
const BEARINGS = 5;
/**
 * Metres of cut the route will accept before it stops. Nobody digs a canal
 * fifteen metres into a hillside, so this is what actually terminates a run and
 * keeps the network in the low ground where it belongs.
 */
const MAX_CUT = 3.2;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

const budgetOf = (value: number | undefined, fallback: number, low: number, high: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(clamp(value, low, high));
};

export type CanalBudget = {
  /** Channels dug, trunks first. Laterals come off whatever trunks exist. */
  channels: number;
  /** Plank crossings across the whole network. Defaults to one per two channels. */
  bridges?: number;
  /** Water hyacinth rosettes. Defaults to 90 per channel. */
  weed?: number;
};

export type Canals = {
  group: Group;
  /** Where a bank path crosses the water. Main may want these for the walker. */
  crossings: { x: number; z: number; span: number }[];
  /** Metres of channel dug, for reporting. */
  length: number;
  applySky: (colors: ResolvedSky, sunDirection: Vector3, night: number, light: number) => void;
  update: (elapsed: number) => void;
  dispose: () => void;
};

/**
 * The 95th percentile of slope over the whole map: does this landscape contain
 * steep ground anywhere? That is the question that separates a delta, which has
 * none, from karst and from a ridge, which are mostly flat and mostly steep
 * respectively but both have cliffs in them.
 *
 * It deliberately ignores the water level. The first version of this took the
 * median slope of the land above the water, which worked until another agent
 * moved Tràng An's level from 42 m to 14.5 m: that uncovered the flat plain
 * between the towers, swung the dry fraction from 12% to 86%, dropped the
 * statistic from 2.47 to 0.0048 and silently re-gated a karst valley as a delta.
 * Steep ground is steep whether it is flooded or not, so this cannot drift that
 * way again. Measured across all three terrain resolutions: ridge 2.15–3.08,
 * karst 1.15–2.21, the two deltas 0.29 and 0.10.
 */
export const slopeCeiling = (terrain: Terrain): number => {
  const half = terrain.size / 2;
  const samples = 80;
  const slopes = new Float64Array(samples * samples);
  for (let i = 0; i < samples; i += 1) {
    for (let j = 0; j < samples; j += 1) {
      const x = -half * 0.9 + (i / (samples - 1)) * half * 1.8;
      const z = -half * 0.9 + (j / (samples - 1)) * half * 1.8;
      slopes[i * samples + j] = terrain.slopeAt(x, z);
    }
  }
  slopes.sort();
  return slopes[Math.floor(0.95 * (slopes.length - 1))];
};

// --- routing ----------------------------------------------------------------

type Station = {
  x: number;
  z: number;
  along: number;
  surface: number;
  bed: number;
  halfWidth: number;
  depth: number;
  tangentX: number;
  tangentZ: number;
};

type Channel = {
  stations: Station[];
  trunk: boolean;
  length: number;
};

/**
 * Walks *down* the land from an inland head toward the water, in straight runs,
 * taking at each junction the small turn whose run ends lowest.
 *
 * The first version of this walked the other way — inland from a mouth on the
 * shoreline, with the water surface pinned just above the river. It built
 * nothing at all, at either delta, and the reason is worth keeping: the measured
 * dry-land slope is 0.046, so the ground climbs 3.9 m over one 85 m run, which
 * is past the cut this accepts before the first junction. A canal is not dug
 * uphill from a river; it is dug downhill to one, and its water surface follows
 * the land's own drainage rather than the river's level.
 */
const route = (
  terrain: Terrain,
  startX: number,
  startZ: number,
  bearing: number,
  maxLength: number,
  outfall: number,
  random: () => number
): { x: number; z: number }[] => {
  const half = terrain.size / 2;
  const onMap = (x: number, z: number) => Math.abs(x) <= half * 0.97 && Math.abs(z) <= half * 0.97;
  const points = [{ x: startX, z: startZ }];
  let heading = bearing;
  let along = 0;
  let stalls = 0;

  while (along < maxLength) {
    const from = points[points.length - 1];
    const here = terrain.heightAt(from.x, from.z);
    let bestX = Number.NaN;
    let bestZ = Number.NaN;
    let bestHeading = heading;
    let bestGround = Number.POSITIVE_INFINITY;

    for (let b = 0; b < BEARINGS; b += 1) {
      const turn = ((b / (BEARINGS - 1)) * 2 - 1) * TURN * (Math.PI / 180);
      const candidate = heading + turn;
      const x = from.x + Math.cos(candidate) * RUN;
      const z = from.z + Math.sin(candidate) * RUN;
      if (!onMap(x, z)) continue;

      // Score the whole run, not just its end: a run that climbs over a mound
      // and comes out low the far side is still a trench through a mound.
      let worst = -Infinity;
      for (let s = 1; s <= 4; s += 1) {
        const t = s / 4;
        const height = terrain.heightAt(from.x + Math.cos(candidate) * RUN * t, from.z + Math.sin(candidate) * RUN * t);
        if (height > worst) worst = height;
      }
      // A touch of noise, or every channel on the map finds the same bearing.
      const score = worst + (random() - 0.5) * 0.3;
      if (score < bestGround) {
        bestGround = score;
        bestX = x;
        bestZ = z;
        bestHeading = candidate;
      }
    }

    if (!Number.isFinite(bestX)) break;
    // A run that climbs more than the cut allows is a trench, not a canal.
    if (bestGround > here + MAX_CUT * 0.5) {
      stalls += 1;
      if (stalls > 1) break;
    }
    points.push({ x: bestX, z: bestZ });
    heading = bestHeading;
    along += RUN;
    // Reached the water: a drainage canal ends at its outfall.
    if (terrain.heightAt(bestX, bestZ) <= outfall + 0.3) break;
  }

  return points.length >= 3 ? points : [];
};

/**
 * Cross-sections along a routed line. The water surface is the running minimum
 * of the ground from the head down, less a constant cut — the drainage envelope
 * — forced to keep falling by at least the canal gradient. Monotone by
 * construction, so the water never runs uphill, and the cut is bounded by how
 * far the route ever climbs above its own lowest point so far.
 */
const station = (
  terrain: Terrain,
  points: { x: number; z: number }[],
  halfWidth: number,
  depth: number,
  outfall: number
): Station[] => {
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  const total = cumulative[cumulative.length - 1];
  if (total < STATION * 4) return [];

  const count = Math.round(total / STATION) + 1;
  const spine: { x: number; z: number; along: number; ground: number; tangentX: number; tangentZ: number }[] = [];
  let cursor = 0;

  for (let i = 0; i < count; i += 1) {
    const along = (i / (count - 1)) * total;
    while (cursor < cumulative.length - 2 && cumulative[cursor + 1] < along) cursor += 1;
    const span = Math.max(1e-4, cumulative[cursor + 1] - cumulative[cursor]);
    const t = clamp((along - cumulative[cursor]) / span, 0, 1);
    const x = points[cursor].x + (points[cursor + 1].x - points[cursor].x) * t;
    const z = points[cursor].z + (points[cursor + 1].z - points[cursor].z) * t;

    let tangentX = points[cursor + 1].x - points[cursor].x;
    let tangentZ = points[cursor + 1].z - points[cursor].z;
    const length = Math.hypot(tangentX, tangentZ) || 1;
    tangentX /= length;
    tangentZ /= length;

    spine.push({ x, z, along, ground: terrain.heightAt(x, z), tangentX, tangentZ });
  }

  const stations: Station[] = [];
  let envelope = Number.POSITIVE_INFINITY;
  let previous = Number.POSITIVE_INFINITY;

  for (let i = 0; i < spine.length; i += 1) {
    const at = spine[i];
    if (at.ground < envelope) envelope = at.ground;
    const fall = previous === Number.POSITIVE_INFINITY ? 0 : STATION * GRADIENT;
    const surface = Math.max(outfall + 0.1, Math.min(envelope - CUT, previous - fall));
    previous = surface;

    // A canal narrows at its head, where it is a ditch rather than a channel,
    // and the taper is what stops it starting in a square wall of water.
    const taper = 0.55 + 0.45 * Math.min(1, at.along / 110);
    stations.push({
      x: at.x,
      z: at.z,
      along: at.along,
      surface,
      bed: surface - depth,
      halfWidth: halfWidth * taper,
      depth,
      tangentX: at.tangentX,
      tangentZ: at.tangentZ,
    });
  }

  // The route climbed too far above its own drainage line to be a dug channel.
  const deepest = Math.max(...spine.map((at, i) => at.ground - stations[i].surface));
  if (deepest > MAX_CUT + CUT) return [];

  return stations;
};

// --- the earthworks ---------------------------------------------------------

/** Offsets and heights across one station, centre outwards. Mirrored by the caller. */
const SECTION_COLUMNS = 7;

/**
 * A trapezoidal channel with a path along each bank: flat bed, earth batter up
 * to the waterline, the batter continuing to the top of the cut, the path, then
 * a blend into the field. One geometry for the whole network.
 */
const buildEarthworks = (
  terrain: Terrain,
  channels: Channel[],
  silt: Color,
  bank: Color,
  field: Color
): BufferGeometry | null => {
  const pieces: BufferGeometry[] = [];
  const shade = new Color();

  for (const channel of channels) {
    const rows = channel.stations.length;
    const across = SECTION_COLUMNS * 2 - 1;
    const positions = new Float32Array(rows * across * 3);
    const colors = new Float32Array(rows * across * 3);
    const indices: number[] = [];

    for (let row = 0; row < rows; row += 1) {
      const at = channel.stations[row];
      const rightX = -at.tangentZ;
      const rightZ = at.tangentX;
      const bedHalf = Math.max(0.3, at.halfWidth - at.depth * BATTER);

      for (let column = 0; column < across; column += 1) {
        const step = column - (SECTION_COLUMNS - 1);
        const side = Math.sign(step) || 1;
        const rung = Math.abs(step);

        let offset: number;
        let y: number;
        let tone: number;

        if (rung === 0) {
          offset = 0;
          y = at.bed;
          tone = 0;
        } else if (rung === 1) {
          offset = bedHalf * 0.65;
          y = at.bed;
          tone = 0;
        } else if (rung === 2) {
          offset = bedHalf;
          y = at.bed;
          tone = 0.1;
        } else if (rung === 3) {
          offset = at.halfWidth;
          y = at.surface;
          tone = 0.45;
        } else {
          // The crest is the ground where the canal is bunded above the field,
          // and the top of the cut where it is dug into it — whichever is higher.
          const probe = at.halfWidth + FREEBOARD * BATTER;
          const ground = terrain.heightAt(at.x + rightX * side * probe, at.z + rightZ * side * probe);
          const crest = Math.max(ground, at.surface + FREEBOARD);
          const crestOffset = at.halfWidth + (crest - at.surface) * BATTER;
          if (rung === 4) {
            offset = crestOffset;
            y = crest;
            tone = 0.8;
          } else if (rung === 5) {
            offset = crestOffset + BERM;
            y = crest;
            tone = 0.95;
          } else {
            offset = crestOffset + BERM + BLEND;
            y = terrain.heightAt(at.x + rightX * side * offset, at.z + rightZ * side * offset);
            tone = 1;
          }
        }

        const x = at.x + rightX * side * offset;
        const z = at.z + rightZ * side * offset;
        const index = row * across + column;
        positions[index * 3] = x;
        positions[index * 3 + 1] = y + (rung >= 6 ? 0.04 : 0);
        positions[index * 3 + 2] = z;

        // Black silt on the bed, drying earth up the batter, trodden bank on the
        // path, and the field's own colour where it blends out.
        if (tone < 0.5) shade.copy(silt).lerp(bank, tone * 2);
        else shade.copy(bank).lerp(field, (tone - 0.5) * 2);
        colors[index * 3] = shade.r;
        colors[index * 3 + 1] = shade.g;
        colors[index * 3 + 2] = shade.b;
      }
    }

    for (let row = 0; row < rows - 1; row += 1) {
      for (let column = 0; column < across - 1; column += 1) {
        const a = row * across + column;
        const b = (row + 1) * across + column;
        indices.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }

    const piece = new BufferGeometry();
    piece.setAttribute('position', new BufferAttribute(positions, 3));
    piece.setAttribute('color', new BufferAttribute(colors, 3));
    piece.setIndex(indices);
    piece.computeVertexNormals();
    pieces.push(piece);
  }

  if (pieces.length === 0) return null;
  if (pieces.length === 1) return pieces[0];
  const merged = mergeGeometries(pieces);
  if (!merged) return pieces[0];
  for (const piece of pieces) piece.dispose();
  return merged;
};

/** The water itself: a flat strip at the surface, with the depth under it baked in. */
const buildWater = (channels: Channel[]): BufferGeometry | null => {
  const pieces: BufferGeometry[] = [];

  for (const channel of channels) {
    const rows = channel.stations.length;
    const across = 7;
    const positions = new Float32Array(rows * across * 3);
    const depths = new Float32Array(rows * across);
    const alongs = new Float32Array(rows * across);
    const sides = new Float32Array(rows * across);
    const indices: number[] = [];

    for (let row = 0; row < rows; row += 1) {
      const at = channel.stations[row];
      const rightX = -at.tangentZ;
      const rightZ = at.tangentX;
      const bedHalf = Math.max(0.3, at.halfWidth - at.depth * BATTER);

      for (let column = 0; column < across; column += 1) {
        const u = (column / (across - 1)) * 2 - 1;
        const offset = Math.abs(u) * at.halfWidth;
        const index = row * across + column;
        positions[index * 3] = at.x + rightX * Math.sign(u || 1) * offset;
        positions[index * 3 + 1] = at.surface;
        positions[index * 3 + 2] = at.z + rightZ * Math.sign(u || 1) * offset;
        // Depth follows the real trapezoid: full over the bed, running out up
        // the batter, which is what puts the pale margin exactly on the slope.
        depths[index] = at.depth * clamp((at.halfWidth - offset) / Math.max(0.01, at.halfWidth - bedHalf), 0, 1);
        alongs[index] = at.along;
        sides[index] = u;
      }
    }

    for (let row = 0; row < rows - 1; row += 1) {
      for (let column = 0; column < across - 1; column += 1) {
        const a = row * across + column;
        const b = (row + 1) * across + column;
        indices.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }

    const piece = new BufferGeometry();
    piece.setAttribute('position', new BufferAttribute(positions, 3));
    piece.setAttribute('aDepth', new BufferAttribute(depths, 1));
    piece.setAttribute('aAlong', new BufferAttribute(alongs, 1));
    piece.setAttribute('aSide', new BufferAttribute(sides, 1));
    piece.setIndex(indices);
    pieces.push(piece);
  }

  if (pieces.length === 0) return null;
  if (pieces.length === 1) return pieces[0];
  const merged = mergeGeometries(pieces);
  if (!merged) return pieces[0];
  for (const piece of pieces) piece.dispose();
  return merged;
};

const WATER_VERTEX = /* glsl */ `
  #include <fog_pars_vertex>

  attribute float aDepth;
  attribute float aAlong;
  attribute float aSide;

  varying vec3 vWorld;
  varying float vDepth;
  varying float vAlong;
  varying float vSide;

  void main() {
    vDepth = aDepth;
    vAlong = aAlong;
    vSide = aSide;

    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    // Named mvPosition because <fog_vertex> reads it out of this scope.
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  #include <fog_pars_fragment>

  uniform float uTime;
  uniform float uDrift;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uSky;
  uniform vec3 uZenith;
  uniform vec3 uSunColor;
  uniform vec3 uSunDirection;
  uniform float uNight;
  uniform float uLight;

  varying vec3 vWorld;
  varying float vDepth;
  varying float vAlong;
  varying float vSide;

  void main() {
    if (vDepth <= 0.0) discard;

    // Carried downstream very slowly, and crossways by nothing at all: a canal
    // has a current but no fetch, so there is no swell on it, only a crinkle.
    float travel = vAlong * 0.9 - uTime * uDrift;
    float a = travel * 1.7;
    float b = vSide * 9.0 + travel * 0.8;
    float slopeAlong = cos(a) * 0.018 + cos(travel * 0.63 + 1.7) * 0.012;
    float slopeAcross = cos(b) * 0.02;
    vec3 normal = normalize(vec3(-slopeAcross, 1.0, -slopeAlong));

    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 5.0);

    // Turbid: a delta canal carries silt, so the shallow margin is browner than
    // the middle rather than clearer, and nothing of the bed shows through.
    vec3 base = mix(uShallow, uDeep, clamp(vDepth / 1.6, 0.0, 1.0));
    base *= uLight;

    vec3 reflected = reflect(-viewDir, normal);
    vec3 mirror = mix(uSky, uZenith, clamp(reflected.y, 0.0, 1.0)) * mix(0.22, 1.0, uLight);

    vec3 halfway = normalize(normalize(uSunDirection) + viewDir);
    float specular = pow(max(dot(normal, halfway), 0.0), 260.0);
    vec3 moonHalf = normalize(-normalize(uSunDirection) + viewDir);
    float moonSpec = pow(max(dot(normal, moonHalf), 0.0), 140.0);

    vec3 color = base + mirror * fresnel * 0.66 + uSunColor * specular * 1.7 * uLight;
    color += vec3(0.76, 0.84, 1.0) * moonSpec * 1.3 * uNight;

    // Silty water is opaque almost at once; only the last few centimetres up the
    // batter are thin enough to see through.
    float alpha = clamp(0.55 + vDepth * 1.4, 0.0, 0.97);
    alpha *= smoothstep(0.0, 0.14, vDepth);

    gl_FragColor = vec4(color, alpha);
    #include <fog_fragment>
  }
`;

// --- what floats on it and what crosses it ----------------------------------

/** One fleshy hyacinth leaf: a cupped blade on a short swollen stalk. */
const buildHyacinthLeaf = (angle: number, lean: number, length: number, width: number, base: Color, tip: Color) => {
  const segments = 3;
  const positions = new Float32Array((segments + 1) * 3 * 3);
  const colors = new Float32Array((segments + 1) * 3 * 3);
  const indices: number[] = [];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const shade = new Color();

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const reach = length * t;
    const radial = Math.sin(lean) * reach;
    const up = Math.cos(lean) * reach;
    // Narrow at the stalk, round at the blade: the shape is a spoon.
    const w = width * Math.sin(Math.PI * clamp(t * 1.25, 0, 1)) ** 0.5;

    for (let j = -1; j <= 1; j += 1) {
      const curl = j * j * w * 0.5;
      const index = (i * 3 + j + 1) * 3;
      positions[index] = cos * (radial - curl * 0.3) - sin * j * w;
      positions[index + 1] = up + curl * 0.45;
      positions[index + 2] = sin * (radial - curl * 0.3) + cos * j * w;
      shade.copy(base).lerp(tip, t);
      colors[index] = shade.r;
      colors[index + 1] = shade.g;
      colors[index + 2] = shade.b;
    }
  }

  for (let i = 0; i < segments; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      const a = i * 3 + j;
      const b = (i + 1) * 3 + j;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return geometry;
};

/**
 * Bèo tây. A rosette of six spoon leaves about a hand across, and on one in
 * five a pale violet spike. Nothing says a Vietnamese canal faster, and it is
 * what fills the slow corners of one.
 */
const buildHyacinth = (flowering: boolean): BufferGeometry => {
  const base = new Color('#4f7a3c');
  const tip = new Color('#86b05a');
  const parts: BufferGeometry[] = [];

  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2 + (i % 2) * 0.3;
    parts.push(buildHyacinthLeaf(angle, 0.5 + (i % 3) * 0.12, 0.17, 0.052, base, tip));
  }
  if (flowering) {
    const spike = new Color('#b9a3d6');
    for (let i = 0; i < 3; i += 1) {
      const petal = buildHyacinthLeaf((i / 3) * Math.PI * 2, 0.22, 0.12, 0.02, spike, new Color('#e8ddf2'));
      petal.translate(0, 0.14, 0);
      parts.push(petal);
    }
  }

  const merged = mergeGeometries(parts);
  if (!merged) {
    for (const part of parts.slice(1)) part.dispose();
    return parts[0];
  }
  for (const part of parts) part.dispose();
  merged.computeVertexNormals();
  return merged;
};

/**
 * A plank crossing where a bank path meets the water. Baked into world space and
 * merged with every other one, because they never move and there are only a few.
 */
const buildBridge = (at: Station, timberShade: Color): BufferGeometry[] => {
  const pieces: BufferGeometry[] = [];
  const rightX = -at.tangentZ;
  const rightZ = at.tangentX;
  const span = at.halfWidth * 2 + 3.4;
  const deck = at.surface + FREEBOARD + 0.22;

  const box = (
    width: number,
    height: number,
    depth: number,
    offset: number,
    lift: number,
    forward: number,
    shade: Color
  ) => {
    const positions = new Float32Array(8 * 3);
    const colors = new Float32Array(8 * 3);
    const corners = [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ];
    corners.forEach((corner, i) => {
      // Local x runs across the canal, z along it.
      const across = offset + (corner[0] * width) / 2;
      const alongAxis = forward + (corner[2] * depth) / 2;
      positions[i * 3] = at.x + rightX * across + at.tangentX * alongAxis;
      positions[i * 3 + 1] = lift + (corner[1] * height) / 2;
      positions[i * 3 + 2] = at.z + rightZ * across + at.tangentZ * alongAxis;
      colors[i * 3] = shade.r;
      colors[i * 3 + 1] = shade.g;
      colors[i * 3 + 2] = shade.b;
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setIndex([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ]);
    geometry.computeVertexNormals();
    pieces.push(geometry);
    return geometry;
  };

  const rail = timberShade.clone().lerp(new Color('#c9b98f'), 0.3);
  for (const bearer of [-0.5, 0.5]) box(span, 0.16, 0.16, 0, deck - 0.12, bearer, timberShade);
  const planks = Math.max(6, Math.round(span / 0.46));
  for (let i = 0; i < planks; i += 1) {
    box(0.36, 0.06, 1.5, (i / (planks - 1) - 0.5) * span, deck, 0, timberShade);
  }
  // One bamboo handrail on two posts. Two rails would be a boardwalk.
  for (const end of [-1, 1]) box(0.09, 1.0, 0.09, end * span * 0.4, deck + 0.5, -0.62, rail);
  box(span * 0.82, 0.07, 0.07, 0, deck + 0.95, -0.62, rail);

  return pieces;
};

/**
 * A sluice where a lateral takes off: a concrete headwall with wing walls and a
 * vertical gate on a screw stem. This is the one piece of hard engineering in a
 * delta landscape and it is what makes the network read as managed.
 */
const buildSluice = (): BufferGeometry => {
  const concrete = new Color('#9a9589');
  const stained = new Color('#6f7267');
  const iron = new Color('#4a4038');
  const parts: BufferGeometry[] = [];

  const slab = (w: number, h: number, d: number, x: number, y: number, z: number, shade: Color) => {
    const positions = new Float32Array(8 * 3);
    const colors = new Float32Array(8 * 3);
    const corners = [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ];
    corners.forEach((corner, i) => {
      positions[i * 3] = x + (corner[0] * w) / 2;
      positions[i * 3 + 1] = y + (corner[1] * h) / 2;
      positions[i * 3 + 2] = z + (corner[2] * d) / 2;
      // Waterline staining: the bottom of a headwall is always darker.
      const wet = corner[1] < 0 ? 1 : 0.15;
      const tone = shade.clone().lerp(stained, wet * 0.75);
      colors[i * 3] = tone.r;
      colors[i * 3 + 1] = tone.g;
      colors[i * 3 + 2] = tone.b;
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setIndex([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ]);
    geometry.computeVertexNormals();
    parts.push(geometry);
  };

  // Headwall either side of a 1.2 m opening, wing walls splaying back, a sill,
  // the gate itself part raised, and the stem and handwheel above it.
  slab(0.9, 2.2, 0.35, -1.05, 0.2, 0, concrete);
  slab(0.9, 2.2, 0.35, 1.05, 0.2, 0, concrete);
  slab(0.7, 1.6, 0.3, -1.6, 0.1, 0.5, concrete);
  slab(0.7, 1.6, 0.3, 1.6, 0.1, 0.5, concrete);
  slab(3.0, 0.3, 0.9, 0, -0.95, 0, concrete);
  slab(2.6, 0.26, 0.5, 0, 1.42, 0, concrete);
  slab(1.25, 1.1, 0.07, 0, 0.1, -0.1, iron);
  slab(0.09, 1.3, 0.09, 0, 1.95, 0, iron);
  slab(0.55, 0.07, 0.09, 0, 2.55, 0, iron);

  const merged = mergeGeometries(parts);
  if (!merged) {
    for (const part of parts.slice(1)) part.dispose();
    return parts[0];
  }
  for (const part of parts) part.dispose();
  return merged;
};

// --- the module -------------------------------------------------------------

const UP = new Vector3(0, 1, 0);

export const createCanals = (terrain: Terrain, recipe: LocationRecipe, budget: CanalBudget): Canals => {
  const group = new Group();
  group.name = 'canals';

  const random = createPrng(`${recipe.seed}:canal`);
  const half = terrain.size / 2;
  const outfall = recipe.water?.level ?? 0;

  const wanted = budgetOf(budget.channels, 4, 0, 16);
  const bridgeCount = budgetOf(budget.bridges, Math.max(1, Math.round(wanted / 2)), 0, 8);
  const weedBudget = budgetOf(budget.weed, wanted * 90, 0, 1600);

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const instanced: InstancedMesh[] = [];
  const crossings: { x: number; z: number; span: number }[] = [];

  const uniforms = Object.assign(UniformsUtils.clone(UniformsLib.fog), {
    uTime: { value: 0 },
    uDrift: { value: 0.35 },
    uDeep: { value: new Color(recipe.water?.deep ?? '#2c3f33').lerp(new Color('#3b4a2c'), 0.42) },
    uShallow: { value: new Color(recipe.water?.shallow ?? '#6d8a6a').lerp(new Color('#7d7352'), 0.45) },
    uSky: { value: new Color('#ffffff') },
    uZenith: { value: new Color('#ffffff') },
    uSunColor: { value: new Color('#ffffff') },
    uSunDirection: { value: new Vector3(0, 1, 0) },
    uNight: { value: 0 },
    uLight: { value: 1 },
  });

  let dug = 0;
  const finish = (): Canals => ({
    group,
    crossings,
    length: Math.round(dug),
    applySky: (colors, sunDirection, night, light) => {
      uniforms.uSky.value.copy(colors.horizon);
      uniforms.uZenith.value.copy(colors.zenith);
      uniforms.uSunColor.value.copy(colors.sunCore);
      uniforms.uSunDirection.value.copy(sunDirection);
      uniforms.uNight.value = night;
      uniforms.uLight.value = light;
    },
    update: (elapsed) => {
      uniforms.uTime.value = elapsed;
    },
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const mesh of instanced) mesh.dispose();
      group.clear();
    },
  });

  if (wanted === 0 || !recipe.water) return finish();

  /**
   * Heads on dry land with room to fall to the outfall, found by scanning the
   * heightfield rather than by rejection sampling. Sampling a height band on a
   * delta hits about one per cent of throws, which with a separation rule found
   * almost nothing; a scan over cells in the band cannot miss what is there.
   */
  const step = terrain.size / terrain.segments;
  const side = terrain.segments + 1;
  const band: number[] = [];
  for (let index = 0; index < terrain.heights.length; index += 1) {
    const height = terrain.heights[index];
    if (height < outfall + 2.5 || height > outfall + 17) continue;
    const row = (index / side) | 0;
    const col = index - row * side;
    if (col < 6 || row < 6 || col > side - 7 || row > side - 7) continue;
    band.push(index);
  }

  const heads: { x: number; z: number; bearing: number }[] = [];
  const separation = terrain.size * 0.12;
  for (let attempt = 0; attempt < 6000 && heads.length < wanted * 3 && band.length > 0; attempt += 1) {
    const index = band[Math.floor(random() * band.length)];
    const row = (index / side) | 0;
    const x = -half + (index - row * side) * step;
    const z = -half + row * step;
    if (heads.some((other) => Math.hypot(other.x - x, other.z - z) < separation)) continue;

    // Downhill, which is where a drainage canal goes.
    const gradX = terrain.heightAt(x + step, z) - terrain.heightAt(x - step, z);
    const gradZ = terrain.heightAt(x, z + step) - terrain.heightAt(x, z - step);
    if (Math.hypot(gradX, gradZ) < 1e-5) continue;
    heads.push({ x, z, bearing: Math.atan2(-gradZ, -gradX) });
  }

  const channels: Channel[] = [];
  const trunkWanted = Math.max(1, Math.round(wanted * 0.45));

  for (const head of heads) {
    if (channels.length >= trunkWanted) break;
    const halfWidth = 6 + random() * 3;
    const depth = 2.2 + random() * 0.8;
    const points = route(terrain, head.x, head.z, head.bearing, terrain.size * 0.34, outfall, random);
    if (points.length === 0) continue;
    const stations = station(terrain, points, halfWidth, depth, outfall);
    if (stations.length < 5) continue;
    channels.push({ stations, trunk: true, length: stations[stations.length - 1].along });
  }

  // Laterals take off at right angles from a point along a trunk, which is where
  // a sluice goes, and run out into the fields.
  const junctions: Station[] = [];
  const trunks = channels.filter((channel) => channel.trunk);
  for (const trunk of trunks) {
    for (let i = 3; i < trunk.stations.length - 2 && channels.length < wanted; i += 1) {
      const at = trunk.stations[i];
      if (junctions.some((other) => Math.hypot(other.x - at.x, other.z - at.z) < 150)) continue;

      const hand = random() < 0.5 ? 1 : -1;
      const halfWidth = 1.8 + random() * 1.4;
      const depth = 0.95 + random() * 0.45;
      // A field ditch leaves the trunk square-on and drains back into it, so it
      // is routed outward from the bank and its stations are then reversed — the
      // envelope has to fall towards the junction, not away from it.
      const offX = -at.tangentZ * hand * (at.halfWidth + 1.5);
      const offZ = at.tangentX * hand * (at.halfWidth + 1.5);
      const bearing = Math.atan2(offZ, offX);
      const points = route(terrain, at.x + offX, at.z + offZ, bearing, terrain.size * 0.13, at.surface - depth, random);
      if (points.length === 0) continue;
      const stations = station(terrain, points.slice().reverse(), halfWidth, depth, at.surface - 0.08);
      if (stations.length < 5) continue;
      channels.push({ stations, trunk: false, length: stations[stations.length - 1].along });
      junctions.push(at);
    }
  }

  if (channels.length === 0) return finish();
  dug = channels.reduce((sum, channel) => sum + channel.length, 0);

  const silt = new Color(recipe.ground.low).lerp(new Color('#2a2a20'), 0.7);
  const bankShade = new Color(recipe.ground.low).lerp(new Color('#7d6a4c'), 0.55);
  const field = new Color(recipe.ground.low);

  const earth = buildEarthworks(terrain, channels, silt, bankShade, field);
  if (earth) {
    geometries.push(earth);
    const material = new MeshStandardMaterial({
      name: 'canal-earthworks',
      vertexColors: true,
      flatShading: true,
      roughness: 0.88,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: DoubleSide,
    });
    materials.push(material);
    const mesh = new Mesh(earth, material);
    mesh.name = 'canal-earthworks';
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);
  }

  const water = buildWater(channels);
  if (water) {
    geometries.push(water);
    const material = new ShaderMaterial({
      name: 'canal-water',
      uniforms,
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: true,
    });
    materials.push(material);
    const mesh = new Mesh(water, material);
    mesh.name = 'canal-water';
    mesh.renderOrder = 1;
    group.add(mesh);
  }

  // --- bridges, baked and merged -------------------------------------------
  const timberShade = new Color('#6b5540');
  const bridgePieces: BufferGeometry[] = [];
  const bridgeSpots: Station[] = [];
  for (const channel of channels) {
    for (let i = 2; i < channel.stations.length - 2; i += 1) {
      const at = channel.stations[i];
      if (bridgeSpots.some((other) => Math.hypot(other.x - at.x, other.z - at.z) < terrain.size * 0.08)) continue;
      bridgeSpots.push(at);
      break;
    }
  }
  // Widest water first: that is where a crossing is worth the planks.
  bridgeSpots.sort((a, b) => b.halfWidth - a.halfWidth);
  for (const at of bridgeSpots.slice(0, bridgeCount)) {
    bridgePieces.push(...buildBridge(at, timberShade));
    crossings.push({ x: at.x, z: at.z, span: at.halfWidth * 2 + 3.4 });
  }
  if (bridgePieces.length > 0) {
    const merged = mergeGeometries(bridgePieces);
    for (const piece of bridgePieces) piece.dispose();
    if (merged) {
      geometries.push(merged);
      const material = new MeshStandardMaterial({
        name: 'canal-bridge',
        vertexColors: true,
        flatShading: true,
        roughness: 0.9,
        metalness: 0,
      });
      materials.push(material);
      const mesh = new Mesh(merged, material);
      mesh.name = 'canal-bridges';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  const matrix = new Matrix4();
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();

  // --- sluices at the junctions -------------------------------------------
  if (junctions.length > 0) {
    const sluice = buildSluice();
    geometries.push(sluice);
    const material = new MeshStandardMaterial({
      name: 'canal-sluice',
      vertexColors: true,
      flatShading: true,
      roughness: 0.82,
      metalness: 0,
    });
    materials.push(material);
    const mesh = new InstancedMesh(sluice, material, junctions.length);
    mesh.name = 'canal-sluices';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    junctions.forEach((at, i) => {
      position.set(at.x, at.surface, at.z);
      quaternion.setFromAxisAngle(UP, -Math.atan2(at.tangentZ, at.tangentX));
      scale.setScalar(1);
      mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    instanced.push(mesh);
  }

  // --- water hyacinth ------------------------------------------------------
  const mats: { x: number; y: number; z: number; scale: number; rotation: number }[] = [];
  const perChannel = Math.max(0, Math.floor(weedBudget / channels.length));
  for (const channel of channels) {
    // Hyacinth rafts up against the banks and in the corners, not mid-channel
    // where what little current there is keeps it moving.
    let placed = 0;
    for (let attempt = 0; attempt < perChannel * 8 && placed < perChannel; attempt += 1) {
      const at = channel.stations[Math.floor(random() * channel.stations.length)];
      const side = random() < 0.5 ? -1 : 1;
      const out = (0.45 + random() * 0.5) * at.halfWidth;
      const rightX = -at.tangentZ;
      const rightZ = at.tangentX;
      mats.push({
        x: at.x + rightX * side * out,
        y: at.surface - 0.02,
        z: at.z + rightZ * side * out,
        scale: 0.8 + random() * 0.5,
        rotation: random() * Math.PI * 2,
      });
      placed += 1;
    }
  }

  if (mats.length > 0) {
    [false, true].forEach((flowering, which) => {
      // One in five flowers, which is about what a raft of it looks like.
      const mine = mats.filter((_, i) => (flowering ? i % 5 === 0 : i % 5 !== 0));
      if (mine.length === 0) return;
      const geometry = buildHyacinth(flowering);
      geometries.push(geometry);
      const material = new MeshStandardMaterial({
        name: flowering ? 'canal-hyacinth-flowering' : 'canal-hyacinth',
        vertexColors: true,
        roughness: 0.62,
        metalness: 0,
        side: DoubleSide,
      });
      materials.push(material);
      const mesh = new InstancedMesh(geometry, material, mine.length);
      mesh.name = `canal-hyacinth-${which}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mine.forEach((mat, i) => {
        position.set(mat.x, mat.y, mat.z);
        quaternion.setFromAxisAngle(UP, mat.rotation);
        scale.setScalar(mat.scale);
        mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
      });
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
      instanced.push(mesh);
    });
  }

  return finish();
};
