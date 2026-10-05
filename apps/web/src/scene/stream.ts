import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type Material,
} from 'three';

import { createCanals, slopeCeiling } from './canal';
import type { ResolvedSky } from './sky-palette';

/** Directions probed at each step of the descent. */
const PROBE_DIRECTIONS = 16;
/** How strongly a stream keeps going the way it was going. 0 zig-zags down the gradient, 1 ignores the land. */
const INERTIA = 0.45;
/** Metres a stream may climb to leave a hollow — the pool behind the sill is full and spilling over it. */
const SILL = 0.6;
const MAX_SILLS = 5;
/** Metres between ribbon cross-sections. */
const SECTION = 3.5;
const MIN_HALF_WIDTH = 0.5;
/** A fall needs this much channel above its lip, or the water appears out of nothing at a cliff edge. */
const LIP_REACH = 22;
/**
 * Metres of drop in one sheet. The tallest single fall in Vietnam is around
 * seventy; past that the terrain is a mountainside, not a cliff, and the honest
 * reading is a long cascade — which the ribbon's own white water already gives.
 */
const MAX_FALL_DROP = 70;
const MIN_FALL_DROP = 2.5;
/** Samples taken across a fall for the rock face behind it. */
const FALL_PROFILE = 24;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * Budgets arrive from the quality tier, which arrives from a settings object.
 * A missing field reads as `undefined`, `Math.max` turns it into NaN, and every
 * comparison against NaN is false — so `built < wanted` is never true and the
 * module silently builds nothing. Read it positively instead, and fall back.
 */
const budgetOf = (value: number | undefined, fallback: number, low: number, high: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(clamp(value, low, high));
};

/**
 * Manning's formula, which is what makes the water race down a pitch and loiter
 * in a flat reach: speed goes as the square root of the grade and the two-thirds
 * power of the depth. The coefficient is for a rough natural bed.
 */
const speedAt = (grade: number, depth: number) =>
  clamp(20 * Math.sqrt(Math.max(grade, 0.004)) * depth ** (2 / 3), 0.3, 9);

const depthAt = (flow: number) => 0.1 + 0.06 * Math.sqrt(flow);
const halfWidthAt = (flow: number) => 0.7 + 1.1 * Math.sqrt(flow);

type Node = { x: number; z: number; y: number };

type Channel = {
  nodes: Node[];
  /** Cumulative horizontal distance from the source, per node. */
  along: number[];
  /** Discharge at each node, in units of one source stream. */
  flow: number[];
  /** Where this channel joins another, if it does. */
  joins: { channel: number; node: number } | null;
  total: number;
  length: number;
};

/**
 * A steep pitch the terrain put in a stream's path. `waterfall.ts` turns the
 * best of these into real falls; the ribbon renders all of them as white water,
 * so the ones left over read as chutes rather than disappearing.
 */
export type StreamFall = {
  lip: Vector3;
  base: Vector3;
  drop: number;
  /** Horizontal distance from lip to base. A plumb fall has a short run. */
  run: number;
  /** Half-width of the water at the lip, metres. */
  halfWidth: number;
  flow: number;
  /** Unit flow direction at the lip, in XZ. */
  direction: Vector3;
  /** Bed heights sampled lip to base, for the rock face behind the sheet. */
  profile: Float32Array;
  /** Grade of the reach below the base. Near zero it pools; steep and it races on. */
  landing: number;
  /** How much steeper the face is than the reaches above and below it. */
  contrast: number;
  /** Highest first. `waterfall.ts` takes them in order. */
  score: number;
};

export type StreamBudget = {
  /** Channels given a ribbon. The network is always traced in full — this is what gets built. */
  streams: number;
  /** Instanced stones across every bed. Defaults to eighteen per stream. */
  boulders?: number;
  /** Small built cascades at the sharpest drops that are not full waterfalls. Defaults to one per stream. */
  cascades?: number;
  /** Stepping stones and plank bridges where a stream meets a path. Defaults to one per three streams. */
  crossings?: number;
};

export type Streams = {
  group: Group;
  /** Steep pitches found along the built streams, best first. */
  falls: StreamFall[];
  applySky: (colors: ResolvedSky, sunDirection: Vector3, night: number, light: number) => void;
  update: (elapsed: number) => void;
  dispose: () => void;
};

// --- finding the beds -------------------------------------------------------

/**
 * Streams are found, not drawn: start high, step to the steepest descent, and
 * stop at the water, the map edge or a hollow with no way out. The inertia term
 * is scaled by the best grade on offer rather than being absolute, because a
 * fixed bonus that meanders nicely on a 900 m ridge marches straight across a
 * delta where every grade is a fiftieth of that.
 */
const traceNetwork = (terrain: Terrain, recipe: LocationRecipe): Channel[] => {
  const step = terrain.size / terrain.segments;
  const half = terrain.size / 2;
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const random = createPrng(`${recipe.seed}:stream`);
  const maxLength = terrain.size * 0.45;

  let lowest = Infinity;
  let highest = -Infinity;
  for (const height of terrain.heights) {
    if (height < lowest) lowest = height;
    if (height > highest) highest = height;
  }

  const spacing = terrain.size * 0.022;
  const sources: Node[] = [];
  const sourceFloor = lowest + (highest - lowest) * 0.5;
  for (let attempt = 0; attempt < 40_000 && sources.length < 220; attempt += 1) {
    const x = (random() * 2 - 1) * half * 0.92;
    const z = (random() * 2 - 1) * half * 0.92;
    const y = terrain.heightAt(x, z);
    if (y < sourceFloor || y <= waterLevel + 3) continue;
    if (sources.some((other) => Math.hypot(other.x - x, other.z - z) < spacing)) continue;
    sources.push({ x, y, z });
  }
  // Highest first, so the long trunks are traced before the side gullies and
  // the tributaries are the ones that run into them.
  sources.sort((a, b) => b.y - a.y);

  // A claim grid is how two streams notice each other: whoever arrives second
  // in a cell stops there and becomes a tributary of whoever was already in it.
  const claimSize = step * 1.5;
  const claimSide = Math.ceil(terrain.size / claimSize) + 1;
  const claim = new Int32Array(claimSide * claimSide).fill(-1);
  /** Positively bounded: a point is on the map only if it proves it is. */
  const onMap = (x: number, z: number, margin = 1) => Math.abs(x) <= half * margin && Math.abs(z) <= half * margin;
  /**
   * Returns -1 rather than clamping an out-of-range or non-integer index. A
   * clamp hides NaN — `Math.max(0, NaN)` is NaN and the bounds check that
   * follows it is false, so the search would carry on against a cell that does
   * not exist and never terminate on it.
   */
  const claimAt = (x: number, z: number) => {
    const column = Math.floor((x + half) / claimSize);
    const row = Math.floor((z + half) / claimSize);
    if (!Number.isInteger(column) || !Number.isInteger(row)) return -1;
    if (column < 0 || column >= claimSide || row < 0 || row >= claimSide) return -1;
    return row * claimSide + column;
  };

  const channels: Channel[] = [];

  for (const source of sources) {
    const nodes: Node[] = [{ ...source }];
    const owned: number[] = [];
    const id = channels.length;
    let directionX = 0;
    let directionZ = 0;
    let length = 0;
    let sills = 0;
    let joins: { channel: number; node: number } | null = null;

    for (let taken = 0; taken < 400; taken += 1) {
      const current = nodes[nodes.length - 1];
      let nextX = Number.NaN;
      let nextZ = Number.NaN;
      let nextY = Number.NaN;
      let nextCell = -1;

      // Three reaches: a smoothed heightfield has pits a single step cannot get
      // out of, and a longer stride steps over them the way a real stream does.
      for (const reach of [step, step * 2.2, step * 4]) {
        const allowance = sills < MAX_SILLS ? SILL : 0;
        let steepest = -Infinity;
        for (let d = 0; d < PROBE_DIRECTIONS; d += 1) {
          const angle = (d / PROBE_DIRECTIONS) * Math.PI * 2;
          const x = current.x + Math.cos(angle) * reach;
          const z = current.z + Math.sin(angle) * reach;
          if (!onMap(x, z)) continue;
          const cell = claimAt(x, z);
          if (cell < 0 || claim[cell] === id) continue;
          const grade = (current.y - terrain.heightAt(x, z)) / reach;
          if (grade > steepest) steepest = grade;
        }
        if (steepest * reach <= -allowance) continue;

        let best = -Infinity;
        for (let d = 0; d < PROBE_DIRECTIONS; d += 1) {
          const angle = (d / PROBE_DIRECTIONS) * Math.PI * 2;
          const unitX = Math.cos(angle);
          const unitZ = Math.sin(angle);
          const x = current.x + unitX * reach;
          const z = current.z + unitZ * reach;
          if (!onMap(x, z)) continue;
          const cell = claimAt(x, z);
          if (cell < 0 || claim[cell] === id) continue;
          const y = terrain.heightAt(x, z);
          const grade = (current.y - y) / reach;
          if (grade * reach <= -allowance) continue;
          const score = grade + INERTIA * Math.abs(steepest) * (unitX * directionX + unitZ * directionZ);
          if (score > best) {
            best = score;
            nextX = x;
            nextZ = z;
            nextY = y;
            nextCell = cell;
          }
        }
        if (best > -Infinity) break;
      }

      if (!Number.isFinite(nextY)) break;
      if (nextY > current.y) sills += 1;

      const occupant = claim[nextCell];
      if (occupant >= 0) {
        const trunk = channels[occupant];
        let node = 0;
        let nearest = Infinity;
        for (let i = 0; i < trunk.nodes.length; i += 1) {
          const distance = Math.hypot(trunk.nodes[i].x - nextX, trunk.nodes[i].z - nextZ);
          if (distance < nearest) {
            nearest = distance;
            node = i;
          }
        }
        joins = { channel: occupant, node };
        break;
      }

      claim[nextCell] = id;
      owned.push(nextCell);

      const stride = Math.hypot(nextX - current.x, nextZ - current.z);
      directionX = (nextX - current.x) / stride;
      directionZ = (nextZ - current.z) / stride;
      length += stride;
      nodes.push({ x: nextX, y: nextY, z: nextZ });

      if (nextY <= waterLevel) break;
      if (!onMap(nextX, nextZ, 0.99)) break;
      if (length > maxLength) break;
    }

    const drop = nodes[0].y - nodes[nodes.length - 1].y;
    if (nodes.length < 4 || (length < 55 && drop < 12)) {
      // Give the cells back, or a stub nobody renders blocks a real stream.
      for (const cell of owned) claim[cell] = -1;
      continue;
    }

    const along = [0];
    for (let i = 1; i < nodes.length; i += 1) {
      along.push(along[i - 1] + Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z));
    }
    channels.push({ nodes, along, flow: [], joins, total: 0, length });
  }

  // Discharge. A tributary always joins a channel traced before it, so resolving
  // newest first is enough — no cycles are possible and no sorting is needed.
  const tributaries: { from: number; node: number }[][] = channels.map(() => []);
  channels.forEach((channel, index) => {
    if (channel.joins) tributaries[channel.joins.channel].push({ from: index, node: channel.joins.node });
  });
  for (let i = channels.length - 1; i >= 0; i -= 1) {
    const channel = channels[i];
    channel.total = 1 + tributaries[i].reduce((sum, t) => sum + channels[t.from].total, 0);
    const ordered = [...tributaries[i]].sort((a, b) => a.node - b.node);
    let carried = 1;
    let next = 0;
    channel.flow = channel.nodes.map((_, node) => {
      while (next < ordered.length && ordered[next].node <= node) {
        carried += channels[ordered[next].from].total;
        next += 1;
      }
      return carried;
    });
  }

  return channels;
};

/**
 * A waterfall is a step in the profile, not merely a steep slope. The threshold
 * comes out of the channels' own grade distribution, because the same absolute
 * number that finds cliffs on a karst tower finds the entire mountainside on a
 * ridge; and the pitch has to be measurably steeper than the reaches above and
 * below it, which is what separates a lip from a long chute.
 */
const detectFalls = (terrain: Terrain, channels: Channel[]): { byChannel: StreamFall[][]; cliffGrade: number } => {
  const gradeOver = (channel: Channel, from: number, to: number) => {
    const run = channel.along[to] - channel.along[from];
    return run <= 0.01 ? 0 : (channel.nodes[from].y - channel.nodes[to].y) / run;
  };
  const reachAbove = (channel: Channel, at: number) => {
    let i = at;
    while (i > 0 && channel.along[at] - channel.along[i] < 34) i -= 1;
    return i === at ? 0 : gradeOver(channel, i, at);
  };
  const reachBelow = (channel: Channel, at: number) => {
    let i = at;
    while (i < channel.nodes.length - 1 && channel.along[i] - channel.along[at] < 34) i += 1;
    return i === at ? 0 : gradeOver(channel, at, i);
  };

  const grades: number[] = [];
  for (const channel of channels) {
    for (let i = 1; i < channel.nodes.length; i += 1) grades.push(gradeOver(channel, i - 1, i));
  }
  grades.sort((a, b) => a - b);
  const steepTail = grades.length > 0 ? grades[Math.floor(0.86 * (grades.length - 1))] : 0;
  const cliffGrade = Math.max(0.62, steepTail * 0.92);

  const byChannel: StreamFall[][] = channels.map(() => []);

  channels.forEach((channel, index) => {
    let from = -1;
    const flush = (to: number) => {
      if (from < 0) return;
      const start = from;
      from = -1;
      if (channel.along[start] < LIP_REACH) return;

      // Clip downward from the lip so one sheet never exceeds a believable drop.
      let end = to;
      while (end > start + 1 && channel.nodes[start].y - channel.nodes[end].y > MAX_FALL_DROP) end -= 1;
      const drop = channel.nodes[start].y - channel.nodes[end].y;
      if (drop < MIN_FALL_DROP) return;

      const run = channel.along[end] - channel.along[start];
      const lipNode = channel.nodes[start];
      const baseNode = channel.nodes[end];
      const above = reachAbove(channel, start);
      const landing = reachBelow(channel, end);
      const face = run <= 0.01 ? 99 : drop / run;
      const contrast = face / Math.max(0.05, Math.max(above, landing));

      const direction = new Vector3(baseNode.x - lipNode.x, 0, baseNode.z - lipNode.z);
      if (direction.lengthSq() < 1e-6) direction.set(1, 0, 0);
      direction.normalize();

      const profile = new Float32Array(FALL_PROFILE);
      for (let i = 0; i < FALL_PROFILE; i += 1) {
        const t = i / (FALL_PROFILE - 1);
        profile[i] = terrain.heightAt(lipNode.x + direction.x * run * t, lipNode.z + direction.z * run * t);
      }

      const flow = channel.flow[end];
      // Tall, plumb, well-fed and landing somewhere flat enough to hold a pool.
      const score =
        (drop * Math.sqrt(flow) * Math.min(2.2, contrast)) / ((1 + run / Math.max(1, drop)) * (1 + landing * 0.6));

      byChannel[index].push({
        lip: new Vector3(lipNode.x, lipNode.y, lipNode.z),
        base: new Vector3(baseNode.x, baseNode.y, baseNode.z),
        drop,
        run,
        halfWidth: halfWidthAt(flow),
        flow,
        direction,
        profile,
        landing,
        contrast,
        score,
      });
    };

    for (let i = 1; i < channel.nodes.length; i += 1) {
      if (gradeOver(channel, i - 1, i) >= cliffGrade) {
        if (from < 0) from = i - 1;
      } else {
        flush(i - 1);
      }
    }
    flush(channel.nodes.length - 1);
  });

  return { byChannel, cliffGrade };
};

// --- the bed, cross-section by cross-section --------------------------------

type Section = {
  x: number;
  z: number;
  /** Bed height at the centre line. */
  bed: number;
  /** Water surface height at the centre line. */
  surface: number;
  tangentX: number;
  tangentZ: number;
  halfLeft: number;
  halfRight: number;
  along: number;
  travel: number;
  grade: number;
  flow: number;
  depth: number;
  speed: number;
  foam: number;
};

/**
 * Lays the water out across the land. The edges are found by marching outward
 * until the ground rises through the surface, so the ribbon ends exactly where
 * the water would and sits in the channel rather than on top of it. Marching
 * from the centre also guarantees nothing between the two edges is above the
 * surface, which is what stops the terrain poking through the sheet.
 */
const buildSections = (terrain: Terrain, channel: Channel, waterLevel: number): Section[] => {
  const points: { x: number; z: number }[] = channel.nodes.map((node) => ({ x: node.x, z: node.z }));
  // Laplacian smoothing rather than a spline: a spline through nodes eighteen
  // metres apart overshoots into the hillside on a hairpin, and this cannot.
  for (let pass = 0; pass < 3; pass += 1) {
    const source = points.map((point) => ({ ...point }));
    for (let i = 1; i < points.length - 1; i += 1) {
      points[i].x = source[i].x * 0.5 + (source[i - 1].x + source[i + 1].x) * 0.25;
      points[i].z = source[i].z * 0.5 + (source[i - 1].z + source[i + 1].z) * 0.25;
    }
  }

  const smoothed = [0];
  for (let i = 1; i < points.length; i += 1) {
    smoothed.push(smoothed[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  const total = smoothed[smoothed.length - 1];
  if (total < SECTION * 3) return [];

  const count = Math.max(4, Math.round(total / SECTION) + 1);
  const raw: { x: number; z: number; bed: number; along: number; flow: number }[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const along = (i / (count - 1)) * total;
    while (cursor < smoothed.length - 2 && smoothed[cursor + 1] < along) cursor += 1;
    const span = Math.max(1e-4, smoothed[cursor + 1] - smoothed[cursor]);
    const t = clamp((along - smoothed[cursor]) / span, 0, 1);
    const x = points[cursor].x + (points[cursor + 1].x - points[cursor].x) * t;
    const z = points[cursor].z + (points[cursor + 1].z - points[cursor].z) * t;
    const flow = channel.flow[cursor] + (channel.flow[cursor + 1] - channel.flow[cursor]) * t;
    raw.push({ x, z, bed: terrain.heightAt(x, z), along, flow });
  }

  // One box pass over the bed profile. The grid-scale wobble in the heightfield
  // is below the resolution of anything water does, and leaving it in makes the
  // surface look like corrugated iron.
  const bed = raw.map((sample) => sample.bed);
  for (let i = 1; i < bed.length - 1; i += 1) {
    bed[i] = raw[i - 1].bed * 0.25 + raw[i].bed * 0.5 + raw[i + 1].bed * 0.25;
  }

  const sections: Section[] = [];
  let travel = 0;

  for (let i = 0; i < raw.length; i += 1) {
    const sample = raw[i];
    const previous = raw[Math.max(0, i - 1)];
    const next = raw[Math.min(raw.length - 1, i + 1)];
    const span = Math.max(0.01, next.along - previous.along);
    const grade = Math.max(0, (bed[Math.max(0, i - 1)] - bed[Math.min(bed.length - 1, i + 1)]) / span);

    let tangentX = next.x - previous.x;
    let tangentZ = next.z - previous.z;
    const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
    tangentX /= tangentLength;
    tangentZ /= tangentLength;

    const depth = depthAt(sample.flow);
    // Depth is measured off the bed, not off the horizontal, so a pitch keeps a
    // sheet of water on it instead of a wedge that pinches out as it steepens.
    const surface = bed[i] + depth * Math.sqrt(1 + grade * grade);

    const rightX = -tangentZ;
    const rightZ = tangentX;
    const maxHalf = halfWidthAt(sample.flow);
    const edges: number[] = [];
    for (const side of [1, -1]) {
      let found = MIN_HALF_WIDTH;
      for (let out = 0.2; out <= maxHalf; out += 0.2) {
        if (terrain.heightAt(sample.x + rightX * side * out, sample.z + rightZ * side * out) > surface) break;
        found = out;
      }
      edges.push(Math.max(MIN_HALF_WIDTH, found));
    }

    const speed = speedAt(grade, depth);
    if (i > 0) travel += (sample.along - previous.along) / speed;

    sections.push({
      x: sample.x,
      z: sample.z,
      bed: bed[i],
      surface,
      tangentX,
      tangentZ,
      halfLeft: edges[1],
      halfRight: edges[0],
      along: sample.along,
      travel,
      grade,
      flow: sample.flow,
      depth,
      speed,
      // White water where the grade is steep, and nothing at all where it is
      // not: this one number is the difference between a stream and a canal.
      foam: clamp((grade - 0.1) / 0.45, 0, 1),
    });
  }

  // A stream that reaches the water should stop at it, not slide under it.
  if (Number.isFinite(waterLevel)) {
    const end = sections.findIndex((section) => section.surface < waterLevel - 0.1);
    if (end > 4) return sections.slice(0, end);
    if (end >= 0) return [];
  }
  return sections;
};

type RibbonAttributes = {
  geometry: BufferGeometry;
  /** Where each section's centre ended up, for placing boulders and crossings. */
  sections: Section[];
};

const buildRibbon = (sections: Section[]): RibbonAttributes => {
  const across = 5;
  const rows = sections.length;
  const positions = new Float32Array(rows * across * 3);
  const side = new Float32Array(rows * across);
  const along = new Float32Array(rows * across);
  const travel = new Float32Array(rows * across);
  const foam = new Float32Array(rows * across);
  const depth = new Float32Array(rows * across);
  const speed = new Float32Array(rows * across);
  const tangent = new Float32Array(rows * across * 2);
  const indices: number[] = [];

  for (let row = 0; row < rows; row += 1) {
    const section = sections[row];
    const rightX = -section.tangentZ;
    const rightZ = section.tangentX;
    // Taper the spring and the mouth so the ribbon does not begin and end with
    // a hard square edge sitting on the grass.
    const ends = Math.min(1, row / 2.5, (rows - 1 - row) / 2.5);

    for (let column = 0; column < across; column += 1) {
      const u = (column / (across - 1)) * 2 - 1;
      const reach = (u < 0 ? section.halfLeft : section.halfRight) * Math.abs(u) * (0.35 + 0.65 * ends);
      const index = row * across + column;
      positions[index * 3] = section.x + rightX * Math.sign(u) * reach;
      positions[index * 3 + 1] = section.surface;
      positions[index * 3 + 2] = section.z + rightZ * Math.sign(u) * reach;
      side[index] = u;
      along[index] = section.along;
      travel[index] = section.travel;
      // The water breaks white where it rubs the bank as well as where it falls.
      foam[index] = clamp(section.foam + Math.abs(u) ** 3 * 0.35, 0, 1);
      depth[index] = section.depth * (1 - Math.abs(u) ** 2.2);
      speed[index] = section.speed;
      tangent[index * 2] = section.tangentX;
      tangent[index * 2 + 1] = section.tangentZ;
    }
  }

  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < across - 1; column += 1) {
      const a = row * across + column;
      const b = (row + 1) * across + column;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aSide', new BufferAttribute(side, 1));
  geometry.setAttribute('aLength', new BufferAttribute(along, 1));
  geometry.setAttribute('aTravel', new BufferAttribute(travel, 1));
  geometry.setAttribute('aFoam', new BufferAttribute(foam, 1));
  geometry.setAttribute('aDepth', new BufferAttribute(depth, 1));
  geometry.setAttribute('aSpeed', new BufferAttribute(speed, 1));
  geometry.setAttribute('aTangent', new BufferAttribute(tangent, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return { geometry, sections };
};

/**
 * The bed under the water and the banks beside it, as one geometry. Wet rock
 * where the water runs, drying out into mud and gravel at the margin — without
 * this the ribbon is a strip of blue lying on a green hill.
 */
const buildBedAndBanks = (terrain: Terrain, sections: Section[], wet: Color, dry: Color): BufferGeometry => {
  const across = 9;
  const rows = sections.length;
  const positions = new Float32Array(rows * across * 3);
  const colors = new Float32Array(rows * across * 3);
  const indices: number[] = [];
  const shade = new Color();

  for (let row = 0; row < rows; row += 1) {
    const section = sections[row];
    const rightX = -section.tangentZ;
    const rightZ = section.tangentX;

    for (let column = 0; column < across; column += 1) {
      const u = (column / (across - 1)) * 2 - 1;
      const edge = u < 0 ? section.halfLeft : section.halfRight;
      // Out to the water's edge over the inner half, then a bank of the same
      // width again beyond it, so the seam is always covered.
      const inside = Math.min(1, Math.abs(u) * 2);
      const outside = Math.max(0, Math.abs(u) * 2 - 1);
      const bank = 0.5 + 0.6 * edge;
      const reach = edge * inside + bank * outside;
      const x = section.x + rightX * Math.sign(u) * reach;
      const z = section.z + rightZ * Math.sign(u) * reach;

      // Under the water, follow the bed; past the edge, climb to the real
      // ground, which is what keeps the bank in the hillside.
      const ground = terrain.heightAt(x, z);
      const y = outside > 0 ? Math.max(section.surface - 0.06, ground + 0.05) : section.bed + 0.03;

      const index = row * across + column;
      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;

      shade.copy(wet).lerp(dry, clamp(outside * 1.6, 0, 1));
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

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

// --- shaders ----------------------------------------------------------------

const VERTEX_SHADER = /* glsl */ `
  #include <fog_pars_vertex>

  attribute float aSide;
  attribute float aLength;
  attribute float aTravel;
  attribute float aFoam;
  attribute float aDepth;
  attribute float aSpeed;
  attribute vec2 aTangent;

  uniform float uTime;

  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vTangent;
  varying float vSide;
  varying float vLength;
  varying float vPhase;
  varying float vFoam;
  varying float vDepth;
  varying float vSpeed;

  void main() {
    vSide = aSide;
    vLength = aLength;
    vFoam = aFoam;
    vDepth = aDepth;
    vSpeed = aSpeed;
    vTangent = aTangent;
    // Travel time, not distance: a feature is carried at the local speed, so the
    // pattern stretches where the water accelerates rather than shearing across
    // the boundary between a slow reach and a fast one.
    vPhase = aTravel - uTime;

    vec3 local = position;
    // Chop, held off the edges so the ribbon keeps meeting the bank where it was
    // built to meet it.
    float interior = 1.0 - abs(aSide);
    local.y += sin((vPhase * 0.9 + aSide * 0.3) * 6.283) * 0.03 * interior * min(1.0, aSpeed * 0.3);

    vec4 world = modelMatrix * vec4(local, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  #include <fog_pars_fragment>

  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uSky;
  uniform vec3 uSunColor;
  uniform vec3 uSunDirection;
  uniform float uNight;
  uniform float uLight;

  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vTangent;
  varying float vSide;
  varying float vLength;
  varying float vPhase;
  varying float vFoam;
  varying float vDepth;
  varying float vSpeed;

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
    // Three sine layers, so the slope is analytic and costs no extra samples.
    // Two are carried along with the water; the middle one is locked to
    // distance down the bed, which is how a standing wave behind a rock stays
    // put while the foam streams through it.
    float carried = vPhase * 0.9;
    float p1 = (carried + vSide * 0.3) * 6.283;
    float p2 = (vLength * 0.22 + vSide * 0.8) * 6.283;
    float p3 = (vPhase * 2.1 - vSide * 1.1) * 6.283;

    float dSide = cos(p1) * 0.3 * 0.5 + cos(p2) * 0.8 * 0.3 - cos(p3) * 1.1 * 0.2;
    float dLength = cos(p2) * 0.22 * 0.3 - (cos(p1) * 0.5 + cos(p3) * 0.4) * 0.9 / max(vSpeed, 0.3);

    vec3 up = normalize(vNormal);
    vec3 flow = normalize(vec3(vTangent.x, 0.0, vTangent.y));
    vec3 across = normalize(cross(up, flow));
    vec3 downstream = cross(across, up);
    float relief = 0.9 * min(1.0, 0.3 + vSpeed * 0.2);
    vec3 normal = normalize(up - across * dSide * relief - downstream * dLength * relief);

    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);

    // Foam: the grade sets how much, and a noise field carried with the water
    // breaks it into patches instead of a flat wash of white.
    float churn = valueNoise(vec2(vSide * 2.2, carried * 2.6)) * 0.6
                + valueNoise(vec2(vSide * 5.5, carried * 5.2)) * 0.4;
    float crest = smoothstep(0.35, 0.95, sin(p1) * 0.5 + 0.5 + sin(p3) * 0.25);
    float white = clamp(vFoam * (0.45 + churn * 0.85) + vFoam * crest * 0.5, 0.0, 1.0);
    white = clamp(white + smoothstep(0.55, 1.0, vFoam) * 0.45, 0.0, 1.0);

    vec3 body = mix(uShallow, uDeep, clamp(vDepth / 0.9, 0.0, 1.0)) * uLight;
    vec3 foam = vec3(0.92, 0.95, 0.96) * mix(0.55, 1.0, uLight);
    vec3 color = mix(body, foam, white);

    vec3 halfway = normalize(normalize(uSunDirection) + viewDir);
    float specular = pow(max(dot(normal, halfway), 0.0), 90.0);

    vec3 moonHalf = normalize(-normalize(uSunDirection) + viewDir);
    float moonSpec = pow(max(dot(normal, moonHalf), 0.0), 50.0);

    color += uSky * fresnel * 0.35 * (1.0 - white * 0.7);
    color += uSunColor * specular * 1.4 * (1.0 - white * 0.5);
    color += vec3(0.74, 0.83, 1.0) * moonSpec * 1.1 * uNight;

    // Shallow calm water is see-through; white water is not, because what you
    // are looking at there is air.
    float alpha = clamp(0.3 + vDepth * 1.5, 0.0, 0.85);
    alpha = mix(alpha, 0.97, white);
    // Feather the very edge, so the shoreline is a wet margin and not a cut.
    alpha *= smoothstep(1.0, 0.86, abs(vSide));

    gl_FragColor = vec4(color, alpha);
    #include <fog_fragment>
  }
`;

// --- built pieces: boulders, cascades, crossings ----------------------------

type StreamKit = {
  boulder: BufferGeometry;
  cobble: BufferGeometry;
  cascadeLip: BufferGeometry;
  cascadeSheet: BufferGeometry;
  foamDisc: BufferGeometry;
  plank: BufferGeometry;
  stringer: BufferGeometry;
  post: BufferGeometry;
  rail: BufferGeometry;
  slab: BufferGeometry;
  dispose: () => void;
};

const createKit = (): StreamKit => {
  const geometries: BufferGeometry[] = [];
  const keep = <T extends BufferGeometry>(geometry: T): T => {
    geometries.push(geometry);
    return geometry;
  };

  const boulder = keep(new IcosahedronGeometry(1, 1));
  // Squash them: a river boulder is worn flat on top, not a ball.
  boulder.scale(1, 0.62, 0.86);
  const cobble = keep(new IcosahedronGeometry(1, 0));
  cobble.scale(1, 0.45, 0.82);

  // A rounded edge the water bends over, and the short apron below it.
  const cascadeLip = keep(new CylinderGeometry(0.34, 0.34, 1, 10, 1, true, 0, Math.PI));
  cascadeLip.rotateZ(Math.PI / 2);
  const cascadeSheet = keep(new BoxGeometry(1, 1, 0.06));
  cascadeSheet.translate(0, -0.5, 0);
  const foamDisc = keep(new SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2));
  foamDisc.scale(1, 0.18, 1);

  const plank = keep(new BoxGeometry(1, 0.07, 0.34));
  const stringer = keep(new BoxGeometry(1, 0.16, 0.14));
  const post = keep(new CylinderGeometry(0.055, 0.065, 1, 6));
  const rail = keep(new CylinderGeometry(0.045, 0.045, 1, 5));
  rail.rotateZ(Math.PI / 2);
  const slab = keep(new CylinderGeometry(1, 0.86, 0.4, 7));

  return {
    boulder,
    cobble,
    cascadeLip,
    cascadeSheet,
    foamDisc,
    plank,
    stringer,
    post,
    rail,
    slab,
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
    },
  };
};

/**
 * Steepest ground (p95 of slope) above which a landscape makes its own streams.
 * Measured at every terrain resolution: ridge 2.15–3.08, karst 1.15–2.21, the
 * two deltas 0.29 and 0.10 — so there is a factor of nearly four of clear air
 * either side of this and the exact value is not load-bearing.
 */
const UPLAND_SLOPE = 0.6;

export const createStreams = (
  terrain: Terrain,
  recipe: LocationRecipe,
  budget: StreamBudget,
  /** Points where something walkable crosses the water, so it gets a bridge. */
  paths: { x: number; z: number }[] = []
): Streams => {
  /**
   * A delta drains through cuts somebody dug, not through brooks. Steepest
   * descent across Hội An happily built 58 meshes of mountain stream with
   * Manning's-formula velocities and nothing to fall down: right code, wrong
   * place. Dispatch on what the land does, and let `canal.ts` answer for flat
   * ground. The entry point is deliberately the same one, so main wires one
   * module and the terrain decides which it gets.
   */
  // Karst is the second case the slope test cannot see. Tràng An's towers are as
  // steep as any mountain — the tracer found 6 channels, built 108 meshes of brook
  // and handed `createWaterfalls` 3 cascades — but limestone drains through itself,
  // not down its own face. There is no stream and no waterfall anywhere in the
  // complex; the water is the still flooded floor between the towers, which is
  // what the channel network is.
  //
  // A canal needs somewhere to drain to, so flat ground with no water on the
  // map keeps the stream tracer rather than getting a network that goes nowhere.
  if (recipe.water && (recipe.terrain.profile === 'karst' || slopeCeiling(terrain) < UPLAND_SLOPE)) {
    const canals = createCanals(terrain, recipe, {
      channels: budget.streams,
      bridges: budget.crossings,
      weed: budget.boulders,
    });
    return {
      group: canals.group,
      // Flat ground offers nothing to fall off, which is the honest answer and
      // is what stops `createWaterfalls` putting a cliff on a delta.
      falls: [],
      applySky: canals.applySky,
      update: canals.update,
      dispose: canals.dispose,
    };
  }

  const group = new Group();
  group.name = 'streams';

  const random = createPrng(`${recipe.seed}:stream-build`);
  const channels = traceNetwork(terrain, recipe);
  const { byChannel } = detectFalls(terrain, channels);

  const wanted = budgetOf(budget.streams, 4, 1, 24);
  const boulderCount = budgetOf(budget.boulders, wanted * 18, 0, 600);
  const cascadeCount = budgetOf(budget.cascades, Math.min(6, wanted), 0, 24);
  const crossingCount = budgetOf(budget.crossings, clamp(Math.ceil(wanted / 3), 1, 3), 0, 12);

  // Pick the trunks, then make sure the channels carrying the best pitches are
  // in too: a waterfall with no stream above it is a tap in a cliff.
  const picked: number[] = [];
  const add = (index: number) => {
    if (picked.length < wanted && !picked.includes(index)) picked.push(index);
  };

  const withFalls = channels
    .map((_, index) => index)
    .filter((index) => byChannel[index].length > 0)
    .sort((a, b) => Math.max(...byChannel[b].map((f) => f.score)) - Math.max(...byChannel[a].map((f) => f.score)));
  for (const index of withFalls.slice(0, Math.ceil(wanted * 0.5))) add(index);

  const byVolume = channels
    .map((_, index) => index)
    .sort((a, b) => channels[b].total * channels[b].length - channels[a].total * channels[a].length);
  for (const index of byVolume) add(index);

  // Where the channels terminate: a stream ends at the river, not in it.
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;

  const materials: Material[] = [];
  const geometries: BufferGeometry[] = [];
  const kit = createKit();

  const makeStandard = (options: Record<string, unknown>) => {
    const material = new MeshStandardMaterial({ flatShading: true, metalness: 0, ...options });
    materials.push(material);
    return material;
  };

  const wetRock = new Color(recipe.ground.rock).multiplyScalar(0.44);
  const dryBank = new Color(recipe.ground.low).lerp(new Color('#8d8268'), 0.45);
  const bedMaterial = makeStandard({
    name: 'stream-bed',
    vertexColors: true,
    roughness: 0.42,
    // The bed is laid a few centimetres over ground it samples at the same
    // resolution, which is inside the depth buffer's noise at a kilometre.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: DoubleSide,
  });
  const boulderMaterial = makeStandard({
    name: 'stream-boulder',
    color: wetRock.clone().multiplyScalar(1.25),
    roughness: 0.46,
  });
  const cobbleMaterial = makeStandard({
    name: 'stream-cobble',
    color: new Color(recipe.ground.rock).multiplyScalar(0.8),
    roughness: 0.78,
  });
  const timber = makeStandard({ name: 'stream-timber', color: '#6b5540', roughness: 0.9 });
  const rope = makeStandard({ name: 'stream-rope', color: '#8d8268', roughness: 0.96 });
  const foamMaterial = makeStandard({
    name: 'stream-foam',
    color: '#eef3f4',
    roughness: 0.55,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
  });
  const sheetMaterial = makeStandard({
    name: 'stream-cascade-sheet',
    color: '#dfeef0',
    roughness: 0.3,
    transparent: true,
    opacity: 0.7,
    side: DoubleSide,
    depthWrite: false,
  });

  const uniforms = Object.assign(UniformsUtils.clone(UniformsLib.fog), {
    uTime: { value: 0 },
    uDeep: { value: new Color(recipe.water?.deep ?? '#2c4a4a').lerp(new Color('#ffffff'), 0.22) },
    uShallow: { value: new Color(recipe.water?.shallow ?? '#73a89c').lerp(new Color('#ffffff'), 0.3) },
    uSky: { value: new Color('#ffffff') },
    uSunColor: { value: new Color('#ffffff') },
    uSunDirection: { value: new Vector3(0, 1, 0) },
    uNight: { value: 0 },
    uLight: { value: 1 },
  });
  const surfaceMaterial = new ShaderMaterial({
    name: 'stream-surface',
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    fog: true,
  });
  materials.push(surfaceMaterial);

  const falls: StreamFall[] = [];
  const built: Section[][] = [];

  for (const index of picked) {
    const sections = buildSections(terrain, channels[index], waterLevel);
    if (sections.length < 5) continue;

    const ribbon = buildRibbon(sections);
    geometries.push(ribbon.geometry);
    const surface = new Mesh(ribbon.geometry, surfaceMaterial);
    surface.name = 'stream-surface';
    surface.renderOrder = 1;
    group.add(surface);

    const bed = buildBedAndBanks(terrain, sections, wetRock, dryBank);
    geometries.push(bed);
    const bedMesh = new Mesh(bed, bedMaterial);
    bedMesh.receiveShadow = true;
    group.add(bedMesh);

    built.push(sections);
    // Pitches on a stream that was not built would be falls hanging in the air.
    for (const fall of byChannel[index]) falls.push(fall);
  }

  falls.sort((a, b) => b.score - a.score);

  // --- boulders and cobbles in the bed --------------------------------------
  const stones: { x: number; y: number; z: number; scale: number; rotation: number; sunk: boolean }[] = [];
  const totalSections = built.reduce((sum, sections) => sum + sections.length, 0);
  if (totalSections > 0) {
    for (let attempt = 0; attempt < boulderCount * 6 && stones.length < boulderCount; attempt += 1) {
      const sections = built[Math.floor(random() * built.length)];
      const section = sections[Math.floor(random() * sections.length)];
      const side = random() < 0.5 ? -1 : 1;
      const edge = side < 0 ? section.halfLeft : section.halfRight;
      const out = (0.15 + random() * 1.15) * edge;
      const rightX = -section.tangentZ;
      const rightZ = section.tangentX;
      const x = section.x + rightX * side * out;
      const z = section.z + rightZ * side * out;
      // Bigger rock in fast water — the slow reaches are where the fines settle.
      const scale = (0.22 + random() * 0.5) * (0.7 + Math.min(1.4, section.speed * 0.22));
      stones.push({
        x,
        y: terrain.heightAt(x, z) - scale * 0.3,
        z,
        scale,
        rotation: random() * Math.PI * 2,
        sunk: out < edge,
      });
    }
  }

  const bigStones = stones.filter((stone) => stone.scale > 0.4);
  const smallStones = stones.filter((stone) => stone.scale <= 0.4);
  const matrix = new Matrix4();
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  const up = new Vector3(0, 1, 0);

  const placeStones = (list: typeof stones, geometry: BufferGeometry, material: Material): InstancedMesh | null => {
    if (list.length === 0) return null;
    const mesh = new InstancedMesh(geometry, material, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    list.forEach((stone, i) => {
      position.set(stone.x, stone.y, stone.z);
      quaternion.setFromAxisAngle(up, stone.rotation);
      scale.setScalar(stone.scale);
      mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    return mesh;
  };

  const boulderMesh = placeStones(bigStones, kit.boulder, boulderMaterial);
  const cobbleMesh = placeStones(smallStones, kit.cobble, cobbleMaterial);

  // --- small cascades at the sharpest drops that are not waterfalls ---------
  const cascadeSpots: Section[] = [];
  for (const sections of built) {
    for (let i = 2; i < sections.length - 2; i += 1) {
      const section = sections[i];
      if (section.grade < 0.3) continue;
      if (section.grade < sections[i - 1].grade || section.grade < sections[i + 1].grade) continue;
      if (falls.some((fall) => Math.hypot(fall.lip.x - section.x, fall.lip.z - section.z) < 14)) continue;
      if (cascadeSpots.some((other) => Math.hypot(other.x - section.x, other.z - section.z) < 22)) continue;
      cascadeSpots.push(section);
    }
  }
  cascadeSpots.sort((a, b) => b.grade * b.flow - a.grade * a.flow);

  for (const spot of cascadeSpots.slice(0, cascadeCount)) {
    const width = spot.halfLeft + spot.halfRight;
    const drop = clamp(spot.grade * 2.2, 0.35, 2.2);
    const node = new Group();
    node.position.set(spot.x, spot.surface, spot.z);
    node.rotation.y = -Math.atan2(spot.tangentZ, spot.tangentX);

    const lip = new Mesh(kit.cascadeLip, sheetMaterial);
    lip.scale.set(1, width, 1);
    lip.rotation.x = Math.PI;
    node.add(lip);

    const sheet = new Mesh(kit.cascadeSheet, sheetMaterial);
    sheet.scale.set(width * 0.94, drop, 1);
    sheet.position.set(0, -0.1, 0.3);
    sheet.rotation.x = -0.22;
    node.add(sheet);

    const foam = new Mesh(kit.foamDisc, foamMaterial);
    foam.scale.setScalar(width * 0.75);
    foam.position.set(0, -drop + 0.05, 0.55 + width * 0.3);
    node.add(foam);

    // A lintel of wet rock under the lip, so the water is falling off something.
    const ledge = new Mesh(kit.boulder, boulderMaterial);
    ledge.scale.set(width * 0.6, drop * 0.7, 0.55);
    ledge.position.set(0, -drop * 0.55, 0.12);
    ledge.castShadow = true;
    node.add(ledge);

    group.add(node);
  }

  // --- crossings ------------------------------------------------------------
  const townSpread = recipe.town ? recipe.town.spread * (terrain.size / 2) : 0;
  const crossingSpots: { section: Section; bridge: boolean }[] = [];

  const flatEnough = (section: Section) => section.grade < 0.14;
  const nearTown = (section: Section) => townSpread > 0 && Math.hypot(section.x, section.z) < townSpread;

  for (const point of paths) {
    let best: Section | null = null;
    let nearest = 12;
    for (const sections of built) {
      for (const section of sections) {
        const distance = Math.hypot(section.x - point.x, section.z - point.z);
        if (distance < nearest) {
          nearest = distance;
          best = section;
        }
      }
    }
    if (best && flatEnough(best)) crossingSpots.push({ section: best, bridge: true });
  }

  if (crossingSpots.length < crossingCount) {
    const candidates: Section[] = [];
    for (const sections of built) {
      for (const section of sections) {
        if (!flatEnough(section)) continue;
        if (crossingSpots.some((spot) => Math.hypot(spot.section.x - section.x, spot.section.z - section.z) < 60)) {
          continue;
        }
        if (candidates.some((other) => Math.hypot(other.x - section.x, other.z - section.z) < 60)) continue;
        candidates.push(section);
      }
    }
    // Where people already are first, then the widest water, which is where a
    // crossing is worth building.
    candidates.sort((a, b) => {
      const townBias = (nearTown(b) ? 1000 : 0) - (nearTown(a) ? 1000 : 0);
      return townBias + (b.halfLeft + b.halfRight) - (a.halfLeft + a.halfRight);
    });
    for (const section of candidates) {
      if (crossingSpots.length >= crossingCount) break;
      // A plank bridge needs somewhere to land its ends; a narrow brook gets
      // stones, which is what anyone would actually put there.
      crossingSpots.push({ section, bridge: nearTown(section) || section.halfLeft + section.halfRight > 3.2 });
    }
  }

  for (const spot of crossingSpots.slice(0, crossingCount)) {
    const section = spot.section;
    const rightX = -section.tangentZ;
    const rightZ = section.tangentX;
    const span = section.halfLeft + section.halfRight + 1.6;
    const node = new Group();
    node.position.set(section.x, 0, section.z);
    node.rotation.y = -Math.atan2(section.tangentZ, section.tangentX);

    if (spot.bridge) {
      const deck = section.surface + 0.52;
      for (const offset of [-0.42, 0.42]) {
        const stringer = new Mesh(kit.stringer, timber);
        stringer.scale.x = span;
        stringer.position.set(0, deck - 0.12, offset);
        stringer.rotation.y = Math.PI / 2;
        stringer.castShadow = true;
        node.add(stringer);
      }
      const planks = Math.max(5, Math.round(span / 0.42));
      for (let i = 0; i < planks; i += 1) {
        const plank = new Mesh(kit.plank, timber);
        plank.scale.x = 1.15;
        plank.rotation.y = Math.PI / 2;
        plank.position.set((i / (planks - 1) - 0.5) * span, deck, 0);
        plank.castShadow = true;
        node.add(plank);
      }
      // One handrail, lashed on. Two would be a boardwalk, not a farm crossing.
      for (const end of [-1, 1]) {
        const post = new Mesh(kit.post, timber);
        post.scale.y = 1.05;
        post.position.set(end * span * 0.42, deck + 0.52, -0.5);
        post.castShadow = true;
        node.add(post);
      }
      const handrail = new Mesh(kit.rail, rope);
      handrail.scale.x = span * 0.84;
      handrail.position.set(0, deck + 1.0, -0.5);
      node.add(handrail);

      // Abutments, so the deck is carried by something.
      for (const end of [-1, 1]) {
        const pad = new Mesh(kit.slab, cobbleMaterial);
        const x = end * span * 0.5;
        pad.scale.set(0.75, 1, 0.75);
        pad.position.set(x, terrain.heightAt(section.x + rightX * x, section.z + rightZ * x) + 0.1, 0);
        pad.castShadow = true;
        node.add(pad);
      }
    } else {
      const stones = Math.max(3, Math.round(span / 0.75));
      for (let i = 0; i < stones; i += 1) {
        const t = i / (stones - 1) - 0.5;
        const x = t * span;
        const stone = new Mesh(kit.slab, cobbleMaterial);
        const stepScale = 0.34 + ((i * 7) % 5) * 0.03;
        stone.scale.set(stepScale, 1, stepScale * 0.9);
        stone.position.set(
          x,
          Math.max(terrain.heightAt(section.x + rightX * x, section.z + rightZ * x), section.surface - 0.1) + 0.12,
          ((i % 2) - 0.5) * 0.22
        );
        stone.rotation.y = i * 1.17;
        stone.castShadow = true;
        node.add(stone);
      }
    }

    group.add(node);
  }

  return {
    group,
    falls,
    applySky: (colors, sunDirection, night, light) => {
      uniforms.uSky.value.copy(colors.horizon);
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
      boulderMesh?.dispose();
      cobbleMesh?.dispose();
      kit.dispose();
      group.clear();
    },
  };
};
