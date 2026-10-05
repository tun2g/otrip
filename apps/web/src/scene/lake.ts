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

import type { NatureSources } from './model-loader';
import type { ResolvedSky } from './sky-palette';
import { applyWindSway, WIND_SHADER_CHUNK, type Wind } from './wind';

/**
 * Metres a basin is allowed to hold. The heightfield has no outlets cut through
 * it, so filling every depression to its spill point turns Tà Xùa's enclosed
 * valleys into reservoirs three hundred metres deep. Capping the fill is the
 * difference between a tarn and a flood: measured, the ridge offers 167 hollows
 * that hold four metres and none that should hold more.
 */
const MAX_FILL = 4;
/**
 * Square metres of surface. On a delta a four-metre fill spreads across a
 * kilometre of near-level ground, which is a flooded plain rather than a pond,
 * so the lake stops growing and its level is read off the contour it reached.
 */
const MAX_AREA = 26_000;
const MIN_AREA = 110;
/**
 * Metres a lake must hold at its deepest, for its size. A flat basin filled
 * four metres at the cap comes out three hundred metres across and seventy
 * centimetres deep, which is a flooded paddy; standing water that wide is
 * water that found somewhere deep to sit.
 */
const depthNeededFor = (radius: number) => 0.5 + radius * 0.004;
/** Metres of bank above the waterline that reads as drying mud. */
const MUD_RISE = 1.1;
/** Basins grown into candidate lakes, largest first. Growing one is cheap. */
const BASINS_CONSIDERED = 72;
/** Vertices per side of a lake's sampling grid. */
const MAX_DIVISIONS = 56;
/** Metres of shore per reed clump, and square metres of surface per floating leaf. */
const REED_SPACING = 1.7;
const LEAF_SPACING = 13;
/** Metres of shore per rim boulder, where the shore is rock rather than mud. */
const STONE_SPACING = 11;
/**
 * Metres above sea level past which lotus stops being plausible. Sen is a lowland
 * plant: Hồ Tây's sen bách diệp sits at 10m, Tràng An at 7 and Hội An at 13, and
 * nothing above the mid-altitude valleys grows it — Mộc Châu at 1050m has none.
 *
 * `recipe.water` is not the test, which is why this needed a number of its own.
 * That field is the single river plane, and a tarn does not come from it: it comes
 * from a closed hollow in the heightfield, which is what the fill cap at the top
 * of this file was written for and what the upland slot below reserves. Tà Xùa's
 * eight tarns at 1602m are correct and were carrying 448 lily pads and 27 lotus
 * flowers; what belongs at that waterline is sedge and rock.
 */
const LOTUS_CEILING = 700;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * Budgets arrive from the quality tier by way of a settings object, so a missing
 * field reads as `undefined`. `Math.max(1, undefined)` is NaN and every
 * comparison against NaN is false, which means a `built < wanted` loop never
 * runs and the module silently builds nothing. Read it positively instead.
 */
const budgetOf = (value: number | undefined, fallback: number, low: number, high: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(clamp(value, low, high));
};

export type LakeBudget = {
  /** Lakes given a surface. Fewer on a weak device — never none where basins exist. */
  lakes: number;
  /** Reed clumps across every lake. Defaults to 70 each, shared out by shoreline. */
  reeds?: number;
  /** Floating leaves across every lake. Defaults to 56 each, shared out by surface. */
  pads?: number;
  /** Lotus blooms across every lake. Defaults to one per ten leaves. */
  blooms?: number;
};

/**
 * What main needs to keep other generators out of the water, and to put a sound
 * in the right place. The radius is the lake's own, not a courtesy margin.
 */
export type LakeInfo = {
  x: number;
  z: number;
  /** Water surface height, in the same metres as the terrain. */
  level: number;
  /** Metres at the deepest point. */
  depth: number;
  area: number;
  /** Metres from the centre to the furthest shore. */
  radius: number;
  reeds: number;
};

export type Lakes = {
  group: Group;
  /** Largest first. Keep-out circles for the town, roads and tree scatter. */
  lakes: LakeInfo[];
  applySky: (colors: ResolvedSky, sunDirection: Vector3, night: number, light: number) => void;
  update: (elapsed: number) => void;
  dispose: () => void;
};

// --- finding the basins -----------------------------------------------------

/** Binary min-heap over grid indices. Each cell is pushed at most once per pass. */
const createHeap = (capacity: number) => {
  const keys = new Float32Array(capacity);
  const values = new Int32Array(capacity);
  let size = 0;

  const swap = (a: number, b: number) => {
    const key = keys[a];
    keys[a] = keys[b];
    keys[b] = key;
    const value = values[a];
    values[a] = values[b];
    values[b] = value;
  };

  return {
    get size() {
      return size;
    },
    clear: () => {
      size = 0;
    },
    peek: () => keys[0],
    push: (key: number, value: number) => {
      if (size >= capacity) return;
      keys[size] = key;
      values[size] = value;
      let child = size;
      size += 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (keys[parent] <= keys[child]) break;
        swap(parent, child);
        child = parent;
      }
    },
    pop: () => {
      const top = values[0];
      size -= 1;
      keys[0] = keys[size];
      values[0] = values[size];
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        if (left >= size) break;
        const right = left + 1;
        const small = right < size && keys[right] < keys[left] ? right : left;
        if (keys[parent] <= keys[small]) break;
        swap(parent, small);
        parent = small;
      }
      return top;
    },
  };
};

/**
 * Priority flood: start from the rim, always step to the lowest cell seen so
 * far, and carry that level inward. A cell whose own ground is below the level
 * that reached it is in a depression, and the level is where its water would
 * stand before spilling. One pass over the whole grid, about 25 ms at the
 * highest tier, done once when the scene is built.
 */
const fillToSpill = (heights: Float32Array, side: number): Float32Array => {
  const spill = Float32Array.from(heights);
  const seen = new Uint8Array(side * side);
  const heap = createHeap(side * side);

  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      if (row > 0 && col > 0 && row < side - 1 && col < side - 1) continue;
      const index = row * side + col;
      seen[index] = 1;
      heap.push(heights[index], index);
    }
  }

  while (heap.size > 0) {
    const index = heap.pop();
    const row = (index / side) | 0;
    const col = index - row * side;
    const level = spill[index];
    for (let d = 0; d < 4; d += 1) {
      const r = row + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const c = col + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (r < 0 || c < 0 || r >= side || c >= side) continue;
      const next = r * side + c;
      if (seen[next] === 1) continue;
      seen[next] = 1;
      spill[next] = Math.max(heights[next], level);
      heap.push(spill[next], next);
    }
  }

  return spill;
};

type Basin = { id: number; spill: number; floor: number; floorIndex: number; cells: number };

/**
 * Depression cells grouped into basins. Two adjacent depressions spill at
 * different levels, so equality of the spill level is what separates them —
 * within one basin the flood assigns the same value to every cell.
 */
const labelBasins = (heights: Float32Array, spill: Float32Array, side: number) => {
  const owner = new Int32Array(side * side).fill(-1);
  const queue = new Int32Array(side * side);
  const basins: Basin[] = [];

  for (let seed = 0; seed < spill.length; seed += 1) {
    if (owner[seed] >= 0 || spill[seed] - heights[seed] <= 0) continue;
    const id = basins.length;
    const level = spill[seed];
    let floor = heights[seed];
    let floorIndex = seed;
    let head = 0;
    let tail = 0;
    queue[tail] = seed;
    tail += 1;
    owner[seed] = id;

    while (head < tail) {
      const index = queue[head];
      head += 1;
      if (heights[index] < floor) {
        floor = heights[index];
        floorIndex = index;
      }
      const row = (index / side) | 0;
      const col = index - row * side;
      for (let d = 0; d < 4; d += 1) {
        const r = row + (d === 0 ? -1 : d === 1 ? 1 : 0);
        const c = col + (d === 2 ? -1 : d === 3 ? 1 : 0);
        if (r < 0 || c < 0 || r >= side || c >= side) continue;
        const next = r * side + c;
        if (owner[next] >= 0 || spill[next] - heights[next] <= 0) continue;
        if (Math.abs(spill[next] - level) > 0.02) continue;
        owner[next] = id;
        queue[tail] = next;
        tail += 1;
      }
    }

    basins.push({ id, spill: level, floor, floorIndex, cells: tail });
  }

  return { owner, basins };
};

type Shape = {
  cells: Int32Array;
  level: number;
  depth: number;
  area: number;
  centreX: number;
  centreZ: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  radius: number;
};

/**
 * Water rising in one basin. Always floods the lowest cell on the shore next,
 * which is what a level surface does, and stops at the spill point, the fill
 * cap or the area cap — whichever comes first. The surface then sits at the
 * height of the cell it did not take, so every cell it did take is submerged.
 */
const growLake = (
  heights: Float32Array,
  side: number,
  step: number,
  owner: Int32Array,
  basin: Basin,
  heap: ReturnType<typeof createHeap>,
  visited: Int32Array,
  stamp: number,
  scratch: Int32Array,
  /** Square metres and metres of depth this one may reach, so no two come out alike. */
  areaCap: number,
  fillCap: number
): Shape | null => {
  const cellArea = step * step;
  const capacity = Math.max(1, Math.floor(areaCap / cellArea));
  const ceiling = Math.min(basin.spill, basin.floor + fillCap);
  const half = (side - 1) * step * 0.5;

  heap.clear();
  heap.push(heights[basin.floorIndex], basin.floorIndex);
  visited[basin.floorIndex] = stamp;

  let count = 0;
  let level = ceiling;

  while (heap.size > 0) {
    const next = heap.peek();
    if (next >= ceiling) {
      level = ceiling;
      break;
    }
    if (count >= capacity) {
      level = next;
      break;
    }

    const index = heap.pop();
    scratch[count] = index;
    count += 1;

    const row = (index / side) | 0;
    const col = index - row * side;
    for (let d = 0; d < 4; d += 1) {
      const r = row + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const c = col + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (r < 0 || c < 0 || r >= side || c >= side) continue;
      const neighbour = r * side + c;
      if (owner[neighbour] !== basin.id || visited[neighbour] === stamp) continue;
      visited[neighbour] = stamp;
      heap.push(heights[neighbour], neighbour);
    }
  }

  const area = count * cellArea;
  const depth = level - basin.floor;
  if (area < MIN_AREA) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let sumX = 0;
  let sumZ = 0;
  for (let i = 0; i < count; i += 1) {
    const index = scratch[i];
    const row = (index / side) | 0;
    const x = -half + (index - row * side) * step;
    const z = -half + row * step;
    sumX += x;
    sumZ += z;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const centreX = sumX / count;
  const centreZ = sumZ / count;
  const radius = Math.max(maxX - centreX, centreX - minX, maxZ - centreZ, centreZ - minZ) + step;
  if (depth < depthNeededFor(radius)) return null;

  return {
    cells: scratch.slice(0, count),
    level,
    depth,
    area,
    centreX,
    centreZ,
    minX,
    maxX,
    minZ,
    maxZ,
    radius,
  };
};

// --- the sampling grid shared by the surface and the bed --------------------

type Grid = {
  cols: number;
  rows: number;
  stepX: number;
  stepZ: number;
  minX: number;
  minZ: number;
  /** Water above ground at each vertex. Negative on the bank. */
  depth: Float32Array;
  /** The vertex sits over a cell of this lake, or next to one. */
  near: Uint8Array;
};

/**
 * Sampled finer than the heightfield, because the shoreline is a contour of the
 * same bilinear surface the terrain mesh is built from — so reading it at three
 * times the grid resolution puts the water's edge where the ground actually
 * crosses the level rather than on a staircase of cell boundaries.
 */
const buildGrid = (terrain: Terrain, shape: Shape, claimed: Int32Array, id: number): Grid => {
  const side = terrain.segments + 1;
  const step = terrain.size / terrain.segments;
  const half = terrain.size / 2;

  const spanX = shape.maxX - shape.minX + step * 2.5;
  const spanZ = shape.maxZ - shape.minZ + step * 2.5;
  const resolution = clamp(step / 3, 0.8, step);
  const cols = clamp(Math.round(spanX / resolution) + 1, 6, MAX_DIVISIONS);
  const rows = clamp(Math.round(spanZ / resolution) + 1, 6, MAX_DIVISIONS);
  const stepX = spanX / (cols - 1);
  const stepZ = spanZ / (rows - 1);
  const minX = shape.centreX - spanX / 2;
  const minZ = shape.centreZ - spanZ / 2;

  const depth = new Float32Array(cols * rows);
  const near = new Uint8Array(cols * rows);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = minX + col * stepX;
      const z = minZ + row * stepZ;
      const index = row * cols + col;
      depth[index] = shape.level - terrain.heightAt(x, z);

      // The lake was grown on the heightfield grid, so a vertex belongs to it
      // when the cell under it does. One cell of dilation carries the bank band
      // and the sub-cell shoreline, which both lie outside the flooded cells.
      const gridCol = Math.round((x + half) / step);
      const gridRow = Math.round((z + half) / step);
      let touching = 0;
      for (let dr = -1; dr <= 1 && touching === 0; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const r = gridRow + dr;
          const c = gridCol + dc;
          if (r < 0 || c < 0 || r >= side || c >= side) continue;
          if (claimed[r * side + c] === id) {
            touching = 1;
            break;
          }
        }
      }
      near[index] = touching;
    }
  }

  return { cols, rows, stepX, stepZ, minX, minZ, depth, near };
};

const buildSurface = (grid: Grid, level: number): BufferGeometry | null => {
  const { cols, rows, depth, near } = grid;
  const positions = new Float32Array(cols * rows * 3);
  const depths = new Float32Array(cols * rows);
  const indices: number[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      positions[index * 3] = grid.minX + col * grid.stepX;
      positions[index * 3 + 1] = level;
      positions[index * 3 + 2] = grid.minZ + row * grid.stepZ;
      depths[index] = depth[index];
    }
  }

  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      const a = row * cols + col;
      const b = a + 1;
      const c = (row + 1) * cols + col;
      const d = c + 1;
      if (near[a] + near[b] + near[c] + near[d] === 0) continue;
      // Entirely dry corners mean the quad is inland of the lake it borders.
      if (depth[a] <= 0 && depth[b] <= 0 && depth[c] <= 0 && depth[d] <= 0) continue;
      indices.push(a, c, d, a, d, b);
    }
  }

  if (indices.length === 0) return null;

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aDepth', new BufferAttribute(depths, 1));
  geometry.setIndex(indices);
  return geometry;
};

/**
 * The bed under the water and the mud band above it, as one geometry. Without
 * it you look through the surface at grass, and the shore is a line rather than
 * a margin. Alpha in the vertex colour is what dissolves the band into the
 * hillside: three alone makes a visible cut wherever the geometry stops.
 */
const buildBed = (terrain: Terrain, grid: Grid, silt: Color, wetMud: Color, dryMud: Color): BufferGeometry | null => {
  const { cols, rows, depth, near } = grid;
  const positions = new Float32Array(cols * rows * 3);
  const colors = new Float32Array(cols * rows * 4);
  const indices: number[] = [];
  const shade = new Color();

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const x = grid.minX + col * grid.stepX;
      const z = grid.minZ + row * grid.stepZ;
      positions[index * 3] = x;
      positions[index * 3 + 1] = terrain.heightAt(x, z) + 0.045;
      positions[index * 3 + 2] = z;

      let alpha: number;
      if (depth[index] >= 0) {
        shade.copy(wetMud).lerp(silt, clamp(depth[index] / 2.6, 0, 1));
        alpha = 1;
      } else {
        // Squared, because the few centimetres either side of the waterline
        // stay wet long after the rest of the bank has dried.
        const up = clamp(-depth[index] / MUD_RISE, 0, 1);
        shade.copy(wetMud).lerp(dryMud, up * up);
        alpha = 1 - up * up * up;
      }

      colors[index * 4] = shade.r;
      colors[index * 4 + 1] = shade.g;
      colors[index * 4 + 2] = shade.b;
      colors[index * 4 + 3] = alpha;
    }
  }

  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      const a = row * cols + col;
      const b = a + 1;
      const c = (row + 1) * cols + col;
      const d = c + 1;
      if (near[a] + near[b] + near[c] + near[d] === 0) continue;
      const highest = Math.max(depth[a], depth[b], depth[c], depth[d]);
      if (highest <= -MUD_RISE) continue;
      indices.push(a, c, d, a, d, b);
    }
  }

  if (indices.length === 0) return null;

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

// --- the surface shader -----------------------------------------------------

const SURFACE_VERTEX = /* glsl */ `
  #include <fog_pars_vertex>
  ${WIND_SHADER_CHUNK}

  attribute float aDepth;

  uniform float uTime;

  varying vec3 vWorld;
  varying float vDepth;
  varying float vChop;

  void main() {
    vDepth = aDepth;

    vec4 world = modelMatrix * vec4(position, 1.0);
    vChop = windGustAt(world.xz, uWindTime);
    // Standing water only moves because the air moves it, and it cannot heave
    // where it is an inch deep, or the surface lifts clear of the bed.
    float room = clamp(aDepth * 1.6, 0.0, 1.0);
    world.y += sin(world.x * 0.5 + world.z * 0.37 + uTime * 1.6) * 0.016 * vChop * room;

    vWorld = world.xyz;
    // Named, because <fog_vertex> reads mvPosition out of this scope and the
    // shader will not compile without it the moment fog is switched on.
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const SURFACE_FRAGMENT = /* glsl */ `
  #include <fog_pars_fragment>

  uniform float uTime;
  uniform float uRipple;
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
  varying float vChop;

  float hash12(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }

  void main() {
    if (vDepth <= 0.0) discard;

    // Four crossing swells, slower and finer than a river's: a pond has no
    // current to stretch them, so what is left is capillary ripple.
    float a = vWorld.x * 0.62 + uTime * 0.9;
    float b = vWorld.z * 0.54 - uTime * 0.74;
    float c = (vWorld.x + vWorld.z) * 0.33 + uTime * 1.3;
    float d = (vWorld.x - vWorld.z) * 0.41 - uTime * 1.1;
    float strength = uRipple * (0.3 + 0.7 * vChop);
    float slopeX = (cos(a) * 0.62 + cos(c) * 0.33 + cos(d) * 0.41) * 0.05 * strength;
    float slopeZ = (cos(b) * 0.54 + cos(c) * 0.33 - cos(d) * 0.41) * 0.05 * strength;
    vec3 normal = normalize(vec3(-slopeX, 1.0, -slopeZ));

    vec3 viewDir = normalize(cameraPosition - vWorld);
    // A fifth power rather than a cube: still water is far more mirror-like at
    // a grazing angle than moving water, and that is most of what a lake is.
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 5.0);

    vec3 base = mix(uShallow, uDeep, clamp(vDepth / 2.8, 0.0, 1.0));
    // A pale rim where the water runs out, which is what makes a shore read.
    base = mix(base, vec3(1.0), (1.0 - smoothstep(0.0, 0.9, vDepth)) * 0.4);
    // Body colour is albedo, not emission. Left unscaled, a pond keeps its
    // midday green after dark and glows against an unlit hillside.
    base *= uLight;

    // No render target to spare for a true reflection, so the sky is sampled
    // along the reflected ray: horizon colour near the grazing angle, zenith
    // looking down into it. That gradient is what a calm lake actually shows.
    vec3 reflected = reflect(-viewDir, normal);
    vec3 mirror = mix(uSky, uZenith, clamp(reflected.y, 0.0, 1.0)) * mix(0.25, 1.0, uLight);

    vec3 halfway = normalize(normalize(uSunDirection) + viewDir);
    float specular = pow(max(dot(normal, halfway), 0.0), 320.0);

    vec3 moonDir = -normalize(uSunDirection);
    vec3 moonHalf = normalize(moonDir + viewDir);
    float moonSpec = pow(max(dot(normal, moonHalf), 0.0), 150.0);

    // Glitter: quantised in space and flickering in time, so it reads as
    // individual wavelets catching the light rather than a smooth sheen.
    vec2 cell = floor(vWorld.xz * 2.1 + vec2(uTime * 0.4, uTime * 0.26));
    float glint = step(0.945, hash12(cell)) * (0.5 + 0.5 * sin(uTime * 6.0 + hash12(cell) * 37.0));
    float glintMask = pow(max(dot(normal, moonHalf), 0.0), 30.0);

    vec3 color = base + mirror * fresnel * 0.62 + uSunColor * specular * 2.0 * uLight;
    color += vec3(0.78, 0.86, 1.0) * (moonSpec * 1.5 + glint * glintMask * 0.8) * uNight;

    float alpha = clamp(0.44 + vDepth * 0.42, 0.0, 0.93);
    alpha = mix(alpha, 1.0, fresnel * 0.5);
    // Feather the contour, so the edge is a wet margin and not a cut.
    alpha *= smoothstep(0.0, 0.42, vDepth);

    gl_FragColor = vec4(color, alpha);
    #include <fog_fragment>
  }
`;

// --- what grows in it -------------------------------------------------------

/**
 * One reed blade, as a shallow V-section ribbon that rises, leans outward and
 * droops at the tip. A flat strip reads as a cut-out from the side; the fold is
 * what gives it an edge to catch the light on.
 */
const buildBlade = (
  angle: number,
  lean: number,
  height: number,
  width: number,
  plume: boolean,
  base: Color,
  tip: Color,
  seed: Color
): BufferGeometry => {
  // Four segments is enough for something this nearly straight, and a reed bed
  // is hundreds of clumps: at seven the fallback cost more triangles than the
  // terrain it stood on.
  const segments = 4;
  const positions = new Float32Array((segments + 1) * 3 * 3);
  const colors = new Float32Array((segments + 1) * 3 * 3);
  const indices: number[] = [];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const shade = new Color();

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const up = height * (t - 0.14 * t * t * t);
    const out = lean * height * t * t;
    // The plume is the top quarter fanning out and going over to seed.
    const swell = plume && t > 0.72 ? 1 + (t - 0.72) * 9 : 1;
    const w = width * (1 - t * 0.9) * swell;

    for (let j = -1; j <= 1; j += 1) {
      const index = (i * 3 + j + 1) * 3;
      const fold = Math.abs(j) * w * 0.45;
      positions[index] = cos * out - sin * j * w;
      positions[index + 1] = up + fold;
      positions[index + 2] = sin * out + cos * j * w;

      shade.copy(base).lerp(tip, t);
      if (plume && t > 0.72) shade.lerp(seed, clamp((t - 0.72) / 0.28, 0, 1));
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

/** A clump of reeds standing in the shallows, normalised to one metre tall. */
const buildReedClump = (random: () => number, foliage: Color): BufferGeometry => {
  const base = foliage.clone().lerp(new Color('#2f4426'), 0.55);
  const tip = foliage.clone().lerp(new Color('#cfd68a'), 0.45);
  const seed = new Color('#b89a63');

  const blades: BufferGeometry[] = [];
  for (let i = 0; i < 6; i += 1) {
    blades.push(
      buildBlade(
        (i / 6) * Math.PI * 2 + random() * 0.7,
        0.16 + random() * 0.3,
        0.62 + random() * 0.38,
        0.016 + random() * 0.014,
        random() < 0.4,
        base,
        tip,
        seed
      )
    );
  }

  const merged = mergeGeometries(blades);
  if (!merged) {
    for (const blade of blades.slice(1)) blade.dispose();
    return blades[0];
  }
  for (const blade of blades) blade.dispose();

  merged.computeBoundingBox();
  const box = merged.boundingBox;
  if (box) merged.scale(1, 1 / Math.max(0.1, box.max.y), 1);
  merged.computeVertexNormals();
  return merged;
};

/**
 * A lotus leaf floating on the surface: round, cleft to the middle on one side,
 * and turned up at the rim, which is the only reason you can tell it from a
 * green disc when the sun is overhead.
 */
const buildLeafGeometry = (): BufferGeometry => {
  const rim = 22;
  const notch = 0.5;
  const vertices = 1 + rim * 2;
  const positions = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const indices: number[] = [];
  const middle = new Color('#2f5a33');
  const edge = new Color('#6f9b4a');
  const vein = new Color('#8fae63');
  const shade = new Color();

  colors[0] = middle.r;
  colors[1] = middle.g;
  colors[2] = middle.b;

  for (let i = 0; i < rim; i += 1) {
    const angle = notch / 2 + (i / (rim - 1)) * (Math.PI * 2 - notch);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Twelve veins radiating from the cleft, as a gentle corrugation rather
    // than drawn lines: the rim scallops and the shading follows it.
    const ripple = 1 + Math.cos(angle * 12) * 0.035;

    for (let ring = 0; ring < 2; ring += 1) {
      const radius = (ring === 0 ? 0.52 : 1) * ripple;
      const index = (1 + i * 2 + ring) * 3;
      positions[index] = cos * radius;
      positions[index + 1] = ring === 0 ? 0.014 : 0.055;
      positions[index + 2] = sin * radius;

      shade.copy(middle).lerp(edge, ring === 0 ? 0.45 : 1);
      shade.lerp(vein, Math.max(0, Math.cos(angle * 12)) * 0.3);
      colors[index] = shade.r;
      colors[index + 1] = shade.g;
      colors[index + 2] = shade.b;
    }
  }

  for (let i = 0; i < rim - 1; i += 1) {
    const inner = 1 + i * 2;
    const outer = inner + 1;
    const nextInner = inner + 2;
    const nextOuter = outer + 2;
    indices.push(0, inner, nextInner);
    indices.push(inner, outer, nextOuter, inner, nextOuter, nextInner);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

/** One lotus petal: cupped, leaning out from the axis and curling back at the tip. */
const buildPetal = (angle: number, lean: number, length: number, width: number, root: Color, tip: Color) => {
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
    const radial = Math.sin(lean) * reach + length * 0.2 * t * t;
    const up = Math.cos(lean) * reach - length * 0.1 * t * t;
    const w = width * Math.sin(Math.PI * Math.min(1, t * 1.12)) ** 0.7;

    for (let j = -1; j <= 1; j += 1) {
      const lateral = j * w;
      const curl = j * j * w * 0.6;
      const index = (i * 3 + j + 1) * 3;
      positions[index] = cos * (radial - curl * 0.35) - sin * lateral;
      positions[index + 1] = up + curl * 0.55;
      positions[index + 2] = sin * (radial - curl * 0.35) + cos * lateral;

      shade.copy(root).lerp(tip, t ** 0.7);
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

/** A hexagonal prism, for the stem. Cheaper than a cylinder with the colour attribute added. */
const buildStem = (height: number, radius: number, color: Color): BufferGeometry => {
  const sides = 6;
  const positions = new Float32Array(sides * 2 * 3);
  const colors = new Float32Array(sides * 2 * 3);
  const indices: number[] = [];

  for (let i = 0; i < sides; i += 1) {
    const angle = (i / sides) * Math.PI * 2;
    for (let end = 0; end < 2; end += 1) {
      const index = (i * 2 + end) * 3;
      const taper = end === 0 ? 1 : 0.78;
      positions[index] = Math.cos(angle) * radius * taper;
      positions[index + 1] = end === 0 ? -height : 0;
      positions[index + 2] = Math.sin(angle) * radius * taper;
      colors[index] = color.r;
      colors[index + 1] = color.g;
      colors[index + 2] = color.b;
    }
  }

  for (let i = 0; i < sides; i += 1) {
    const a = i * 2;
    const b = ((i + 1) % sides) * 2;
    indices.push(a, b, b + 1, a, b + 1, a + 1);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return geometry;
};

/**
 * Hoa sen, in metres: eighteen centimetres across the open cup and ten tall,
 * on a stem that reaches down through the surface. Twenty-four petals in three
 * rings, a receptacle and the stem, merged into one geometry so every bloom on
 * every lake is a single draw call — the only way to afford a flower built
 * properly rather than a pink billboard.
 */
const BLOOM_STEM = 0.42;

const buildBloomGeometry = (): BufferGeometry => {
  const root = new Color('#e4799f');
  const tip = new Color('#fdf1f3');
  const parts: BufferGeometry[] = [];
  // Inner petals stand near upright and outer ones fall away, which is what
  // makes a cup. All leaning the same amount gives a pink daisy.
  const rings = [
    { count: 7, lean: 0.25, length: 0.108, width: 0.03, phase: 0 },
    { count: 8, lean: 0.6, length: 0.098, width: 0.03, phase: 0.4 },
    { count: 9, lean: 0.95, length: 0.092, width: 0.029, phase: 0.2 },
  ];

  for (const ring of rings) {
    for (let i = 0; i < ring.count; i += 1) {
      const angle = (i / ring.count) * Math.PI * 2 + ring.phase;
      parts.push(buildPetal(angle, ring.lean, ring.length, ring.width, root, tip));
    }
  }

  // The flat-topped seed head a lotus carries in the middle of the cup.
  const receptacle = buildStem(0.022, 0.016, new Color('#d8c15a'));
  receptacle.translate(0, 0.055, 0);
  parts.push(receptacle);
  parts.push(buildStem(BLOOM_STEM, 0.007, new Color('#4e7a3f')));

  const merged = mergeGeometries(parts);
  if (!merged) {
    for (const part of parts.slice(0, -1)) part.dispose();
    return parts[parts.length - 1];
  }
  for (const part of parts) part.dispose();

  merged.computeVertexNormals();
  return merged;
};

/** Injecting the block twice would redeclare the uniforms and fail to compile. */
const bobbed = new WeakSet<Material>();

/**
 * What a leaf does on moving water: heaves with the gust and tips as the swell
 * passes under it. Reuses the wind's own gust field, so a pond ruffles at the
 * same moment the grass on its bank does.
 */
const applyFloatBob = (material: Material, wind: Wind, heave: number, tilt: number): void => {
  if (bobbed.has(material)) return;
  bobbed.add(material);

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
           vec3 bobOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
         #else
           vec3 bobOrigin = vec3(0.0);
         #endif
         vec3 bobBase = (modelMatrix * vec4(bobOrigin, 1.0)).xyz;
         float bobGust = windGustAt(bobBase.xz, uWindTime);
         float bobPhase = uWindTime * (1.0 + bobGust * 1.5) + bobBase.x * 0.21 + bobBase.z * 0.17;
         float bobLift = sin(bobPhase) * ${heave.toFixed(4)} * (0.3 + bobGust);
         float bobTip = cos(bobPhase * 0.83) * ${tilt.toFixed(4)} * (0.3 + bobGust);
         transformed.y += bobLift + transformed.x * bobTip + transformed.z * bobTip * 0.6;
        `
      );
  };

  // `heave` and `tilt` are baked into the source rather than passed as uniforms,
  // and three's program cache key knows nothing about either — nor about the only
  // other difference between the leaf and the bloom material, their roughness. So
  // without this the blooms were handed the leaves' compiled shader: measured, the
  // two keys came out identical at Hội An, Hồ Tây and Tà Xùa, and the flowers
  // heaved at the leaves' 0.035 instead of nodding at their own 0.012.
  material.customProgramCacheKey = () => `${previousKey.call(material)}|bob:${heave}:${tilt}`;
  material.needsUpdate = true;
};

// --- the module -------------------------------------------------------------

type Placement = { x: number; y: number; z: number; scale: number; rotation: number };

const UP = new Vector3(0, 1, 0);

/**
 * Hồ, ao, đầm. Standing water the single river plane does not reach: every
 * closed hollow in the heightfield, flooded to the level it would actually hold
 * and given its own surface at that height, with reeds in the shallows and either
 * a muddy shore and lotus on the open water, or — above `LOTUS_CEILING`, where a
 * hollow is a tarn and not a pond — a stone shore and boulders at the waterline.
 *
 * Skips without complaint where the land has no hollows — Tràng An's karst is
 * towers standing in water that the river plane already covers, and honestly
 * offers two puddles at the highest tier and none at the lowest.
 */
export const createLakes = (
  terrain: Terrain,
  recipe: LocationRecipe,
  budget: LakeBudget,
  sources: NatureSources,
  wind: Wind
): Lakes => {
  const group = new Group();
  group.name = 'lakes';

  const side = terrain.segments + 1;
  const step = terrain.size / terrain.segments;
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const random = createPrng(`${recipe.seed}:lake`);

  const tarn = recipe.coords.elevation > LOTUS_CEILING;

  /**
   * A tarn is real and the comment at the top of this file is kept: the ridge
   * offers 167 hollows that hold four metres, and the six it filled came out
   * 36-69m across at 66-278m — valley floor, not crest. But 167 hollows is a
   * property of the noise, not of Sơn La, where standing water is rare and is
   * usually an ao somebody dug by a hamlet. Six scattered across 5.2km reads as
   * a lake district. Two, one of which `reserve` already pulls toward the
   * settlement, is the ridge — and the budget it frees goes into the stones and
   * reeds of the two that stay, which is this repo's trade every time.
   */
  const wanted = Math.min(budgetOf(budget.lakes, 4, 0, 12), tarn ? 2 : 12);
  const reedBudget = budgetOf(budget.reeds, wanted * (tarn ? 170 : 70), 0, 1800);
  const padBudget = tarn ? 0 : budgetOf(budget.pads, wanted * 56, 0, 1200);
  const bloomBudget = tarn ? 0 : budgetOf(budget.blooms, Math.round(padBudget / 10), 0, 48);
  // Fewer things than the lotus they replace, and each one bigger: nature-scatter
  // treats the lakes as a keep-out, so this is the only placer that knows where a
  // tarn's waterline is and nothing else can put a rock on it.
  const stoneBudget = tarn ? Math.round(clamp(wanted * 40, 0, 220)) : 0;

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const instanced: InstancedMesh[] = [];
  const lakes: LakeInfo[] = [];

  const uniforms = Object.assign(UniformsUtils.clone(UniformsLib.fog), wind.uniforms, {
    uTime: { value: 0 },
    uRipple: { value: clamp((recipe.water?.ripple ?? 0.3) * 0.55, 0.08, 0.4) },
    uDeep: { value: new Color(recipe.water?.deep ?? '#24393c').lerp(new Color('#1d3326'), 0.3) },
    uShallow: { value: new Color(recipe.water?.shallow ?? '#6d9b8f').lerp(new Color('#7fa473'), 0.28) },
    uSky: { value: new Color('#ffffff') },
    uZenith: { value: new Color('#ffffff') },
    uSunColor: { value: new Color('#ffffff') },
    uSunDirection: { value: new Vector3(0, 1, 0) },
    uNight: { value: 0 },
    uLight: { value: 1 },
  });

  const finish = (): Lakes => ({
    group,
    lakes,
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

  if (wanted === 0) return finish();

  const spill = fillToSpill(terrain.heights, side);
  const { owner, basins } = labelBasins(terrain.heights, spill, side);
  if (basins.length === 0) return finish();

  // Grow the roomiest basins only. A basin smaller than the area cap can never
  // beat one that fills it, and growing costs a heap pass each.
  const ranked = [...basins].sort((a, b) => b.cells - a.cells).slice(0, BASINS_CONSIDERED);
  const heap = createHeap(side * side);
  const visited = new Int32Array(side * side);
  const scratch = new Int32Array(side * side);

  const half = terrain.size / 2;
  // Past the recipe's own falloff the land is sinking towards the rim, which
  // exists to be hidden under the cloud line. Four of six lakes landed out
  // there before this test: the biggest hollows on a ridge are the artificial
  // ones at the border, and nobody walks to them.
  const inland = half * recipe.terrain.edgeFalloff;
  const townSpread = recipe.town ? recipe.town.spread * half : 0;
  /** Distance from the middle of the built-up area, as a fraction of its extent. */
  const townReach = (shape: Shape) =>
    townSpread > 0 ? Math.hypot(shape.centreX, shape.centreZ) / townSpread : Number.POSITIVE_INFINITY;

  const candidates: Shape[] = [];
  ranked.forEach((basin, pass) => {
    // Varied caps, or every pond on a delta comes out the same size and every
    // tarn on the ridge exactly four metres deep, which is the tell that a
    // number rather than the land decided it.
    const areaCap = MAX_AREA * (0.3 + random() * 0.7);
    const fillCap = MAX_FILL * (0.42 + random() * 0.58);
    const shape = growLake(
      terrain.heights,
      side,
      step,
      owner,
      basin,
      heap,
      visited,
      pass + 1,
      scratch,
      areaCap,
      fillCap
    );
    if (!shape) return;
    // Below the river plane's own level it is already water, drawn by water.ts.
    if (shape.level <= waterLevel + 0.8) return;
    if (Math.max(Math.abs(shape.centreX), Math.abs(shape.centreZ)) > inland) return;
    // Never in the middle of the old quarter: the town generator does not know
    // about the water, so a pond there would come up full of houses.
    if (townReach(shape) < 0.35) return;
    candidates.push(shape);
  });

  if (candidates.length === 0) return finish();

  let lowest = Infinity;
  let highest = -Infinity;
  for (const height of terrain.heights) {
    if (height < lowest) lowest = height;
    if (height > highest) highest = height;
  }
  const upland = lowest + (highest - lowest) * 0.35;

  const score = (shape: Shape) => shape.area * Math.sqrt(shape.depth);
  const separation = terrain.size * 0.07;
  const apart = (shape: Shape, against: Shape[]) =>
    against.every((other) => Math.hypot(other.centreX - shape.centreX, other.centreZ - shape.centreZ) > separation);

  const sorted = [...candidates].sort((a, b) => score(b) - score(a));
  const picked: Shape[] = [];
  for (const shape of sorted) {
    if (picked.length >= wanted) break;
    if (apart(shape, picked)) picked.push(shape);
  }

  /**
   * Two slots are spent on being somewhere rather than on being big: the ridge
   * would otherwise hold no water above the valley floors, and the village
   * would have none beside it, because by area the winners are always the broad
   * hollows in the middle of nowhere. One each, and only if the map offers it.
   */
  const reserve = (fits: (shape: Shape) => boolean) => {
    if (picked.length < 2 || picked.some(fits)) return;
    const kept = picked.slice(0, picked.length - 1);
    const swap = sorted.find((shape) => fits(shape) && apart(shape, kept));
    if (swap) picked.splice(picked.length - 1, 1, swap);
  };

  reserve((shape) => shape.level >= upland);
  reserve((shape) => townReach(shape) <= 1.15);

  // Claimed per picked lake, so a grid vertex can tell whose water it is over.
  const claimed = new Int32Array(side * side).fill(-1);
  picked.forEach((shape, index) => {
    for (const cell of shape.cells) claimed[cell] = index;
  });

  /**
   * A tarn sits in a rock basin, so its three bands come off `ground.rock` and run
   * grey; a delta pond sits in silt and comes off `ground.low` and runs warm brown.
   * Which of the two a shore is reads at a glance from much further off than any
   * boulder does, and it costs no geometry at all — the bands were already there.
   */
  const shore = tarn
    ? { base: recipe.ground.rock, deep: '#26262a', wet: '#3a3a36', dry: '#9c9a90' }
    : { base: recipe.ground.low, deep: '#2b2a21', wet: '#4d4030', dry: '#a2957a' };
  const silt = new Color(shore.base).lerp(new Color(shore.deep), 0.66);
  const wetMud = new Color(shore.base).lerp(new Color(shore.wet), 0.68);
  const dryMud = new Color(shore.base).lerp(new Color(shore.dry), 0.42);

  const surfaces: BufferGeometry[] = [];
  const beds: BufferGeometry[] = [];
  const reeds: Placement[] = [];
  const pads: Placement[] = [];
  const blooms: Placement[] = [];
  const stones: Placement[] = [];

  /**
   * Shared out by what each lake can actually hold, not evenly: Tràng An's two
   * puddles are three hundred square metres between them, and an even split of
   * the budget stood two hundred and seventy reed clumps in one of them. Reeds
   * go by shoreline, leaves by surface, and the budget only scales it down.
   */
  const reedWant = picked.map((shape) => Math.round((Math.PI * 2 * shape.radius) / REED_SPACING));
  const padWant = picked.map((shape) => Math.round(shape.area / LEAF_SPACING));
  const stoneWant = picked.map((shape) => Math.round((Math.PI * 2 * shape.radius) / STONE_SPACING));
  const reedTotal = reedWant.reduce((sum, want) => sum + want, 0);
  const padTotal = padWant.reduce((sum, want) => sum + want, 0);
  const stoneTotal = stoneWant.reduce((sum, want) => sum + want, 0);
  const reedScale = reedTotal > reedBudget ? reedBudget / reedTotal : 1;
  const padScale = padTotal > padBudget ? padBudget / padTotal : 1;
  const stoneScale = stoneTotal > stoneBudget ? stoneBudget / stoneTotal : 1;
  const perLakeBlooms = Math.floor(bloomBudget / picked.length);

  picked.forEach((shape, index) => {
    const perLakeReeds = Math.round(reedWant[index] * reedScale);
    const perLakePads = Math.round(padWant[index] * padScale);
    const perLakeStones = Math.round(stoneWant[index] * stoneScale);
    const grid = buildGrid(terrain, shape, claimed, index);
    const surface = buildSurface(grid, shape.level);
    if (!surface) return;
    surfaces.push(surface);

    const bed = buildBed(terrain, grid, silt, wetMud, dryMud);
    if (bed) beds.push(bed);

    // Rejection sampling over the lake's own box. Depth decides what grows
    // where: reeds root in the margin, leaves float where it is deep enough
    // not to ground them and shallow enough for a stem to reach the light.
    const spanX = shape.maxX - shape.minX + step;
    const spanZ = shape.maxZ - shape.minZ + step;
    const ownedAt = (x: number, z: number) => {
      const col = Math.round((x + half) / step);
      const row = Math.round((z + half) / step);
      if (col < 0 || row < 0 || col >= side || row >= side) return false;
      return claimed[row * side + col] === index;
    };

    let reedTries = 0;
    let reedsHere = 0;
    while (reedsHere < perLakeReeds && reedTries < perLakeReeds * 14) {
      reedTries += 1;
      const x = shape.minX - step / 2 + random() * spanX;
      const z = shape.minZ - step / 2 + random() * spanZ;
      if (!ownedAt(x, z)) continue;
      const ground = terrain.heightAt(x, z);
      const depth = shape.level - ground;
      if (depth < 0.04 || depth > 0.85) continue;
      if (terrain.slopeAt(x, z) > 0.9) continue;
      reeds.push({ x, y: ground, z, scale: 1.3 + random() * 0.95, rotation: random() * Math.PI * 2 });
      reedsHere += 1;
    }

    let stoneTries = 0;
    let stonesHere = 0;
    while (stonesHere < perLakeStones && stoneTries < perLakeStones * 20) {
      stoneTries += 1;
      const x = shape.minX - step / 2 + random() * spanX;
      const z = shape.minZ - step / 2 + random() * spanZ;
      if (!ownedAt(x, z)) continue;
      const ground = terrain.heightAt(x, z);
      const depth = shape.level - ground;
      // Only the margin, and only where the stone still breaks the surface: the
      // whole point of a rim boulder is the dry top and the wet line across it,
      // and one standing in half a metre of water is a lump you cannot see.
      if (depth < 0.02 || depth > 0.55) continue;
      // Settled a little into the bed rather than balanced on it, which is what a
      // rock that has been there since the ice did it looks like.
      // Metres tall, and the kit's rocks are wider than they are high. At 0.75 to
      // 1.8 the biggest came out three metres across on a tarn fifty metres
      // wide and read as glacial erratics rather than as a rim.
      stones.push({ x, y: ground - 0.14, z, scale: 0.42 + random() * 0.78, rotation: random() * Math.PI * 2 });
      stonesHere += 1;
    }

    let padTries = 0;
    let padsHere = 0;
    while (padsHere < perLakePads && padTries < perLakePads * 14) {
      padTries += 1;
      const x = shape.minX - step / 2 + random() * spanX;
      const z = shape.minZ - step / 2 + random() * spanZ;
      if (!ownedAt(x, z)) continue;
      const depth = shape.level - terrain.heightAt(x, z);
      if (depth < 0.3 || depth > 2.1) continue;
      pads.push({
        x,
        y: shape.level + 0.02,
        z,
        scale: 0.22 + random() * 0.28,
        rotation: random() * Math.PI * 2,
      });
      padsHere += 1;
      // A bloom stands among leaves, never alone on open water, and only where
      // its stem can still reach the bed — past that it would be a cut flower.
      if (blooms.length < (index + 1) * perLakeBlooms && depth < 1.3 && random() < 0.12) {
        blooms.push({
          x: x + (random() - 0.5) * 0.8,
          y: shape.level + 0.26,
          z: z + (random() - 0.5) * 0.8,
          scale: 0.86 + random() * 0.3,
          rotation: random() * Math.PI * 2,
        });
      }
    }

    lakes.push({
      x: shape.centreX,
      z: shape.centreZ,
      level: shape.level,
      depth: shape.depth,
      area: shape.area,
      radius: shape.radius,
      reeds: reedsHere,
    });
  });

  if (surfaces.length === 0) return finish();
  lakes.sort((a, b) => b.area - a.area);

  const surfaceMaterial = new ShaderMaterial({
    name: 'lake-surface',
    uniforms,
    vertexShader: SURFACE_VERTEX,
    fragmentShader: SURFACE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    fog: true,
  });
  materials.push(surfaceMaterial);

  // Merged: the level is baked into the vertices, so every lake shares one
  // material and one draw call. Culling a lake individually would save nothing
  // on a surface this cheap to rasterise.
  const mergedSurface = surfaces.length === 1 ? surfaces[0] : mergeGeometries(surfaces);
  if (surfaces.length > 1) for (const piece of surfaces) piece.dispose();
  if (mergedSurface) {
    geometries.push(mergedSurface);
    const mesh = new Mesh(mergedSurface, surfaceMaterial);
    mesh.name = 'lake-surface';
    mesh.renderOrder = 1;
    group.add(mesh);
  }

  if (beds.length > 0) {
    const bedMaterial = new MeshStandardMaterial({
      name: 'lake-bed',
      vertexColors: true,
      transparent: true,
      roughness: 0.52,
      metalness: 0,
      flatShading: true,
      // Laid four centimetres over ground sampled from the same heightfield,
      // which is inside the depth buffer's noise at a kilometre out.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: DoubleSide,
    });
    materials.push(bedMaterial);

    const mergedBed = beds.length === 1 ? beds[0] : mergeGeometries(beds);
    if (beds.length > 1) for (const piece of beds) piece.dispose();
    if (mergedBed) {
      geometries.push(mergedBed);
      const mesh = new Mesh(mergedBed, bedMaterial);
      mesh.name = 'lake-bed';
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  const matrix = new Matrix4();
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();

  const place = (list: Placement[], geometry: BufferGeometry, material: Material, metres: number, name: string) => {
    if (list.length === 0) return;
    const mesh = new InstancedMesh(geometry, material, list.length);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    list.forEach((item, i) => {
      position.set(item.x, item.y, item.z);
      quaternion.setFromAxisAngle(UP, item.rotation);
      scale.setScalar(metres * item.scale);
      mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    instanced.push(mesh);
  };

  if (reeds.length > 0) {
    // The CC0 kit ships two reed models and they beat anything procedural here,
    // so they are used when main has loaded them; a built clump stands in when
    // it has not, rather than the shallows coming up bare.
    const models = ['Reed001', 'Reed002'].map((name) => sources.get(name)).filter((source) => source !== undefined);

    if (models.length > 0) {
      models.forEach((source, which) => {
        const mine = reeds.filter((_, i) => i % models.length === which);
        if (mine.length === 0) return;
        const material = source.material.clone();
        (material as Material & { vertexColors?: boolean }).vertexColors = false;
        applyWindSway(material, wind, { amplitude: 0.1 * source.height, height: source.height, stiffness: 1.5 });
        materials.push(material);
        place(mine, source.geometry, material, 1 / source.height, `lake-reeds-${which}`);
      });
    } else {
      const clump = buildReedClump(random, new Color(recipe.ground.foliage));
      geometries.push(clump);
      const material = new MeshStandardMaterial({
        name: 'lake-reed-clump',
        vertexColors: true,
        roughness: 0.78,
        metalness: 0,
        side: DoubleSide,
      });
      applyWindSway(material, wind, { amplitude: 0.1, height: 1, stiffness: 1.5 });
      materials.push(material);
      place(reeds, clump, material, 1, 'lake-reeds');
    }
  }

  if (stones.length > 0) {
    // The kit's three rocks, and no procedural stand-in: if they have not loaded
    // the shore still reads stony on its own, so a fallback here would only buy a
    // worse boulder. No sway either, for the obvious reason.
    const models = ['Rock001', 'Rock002', 'Rock003']
      .map((name) => sources.get(name))
      .filter((source) => source !== undefined);

    models.forEach((source, which) => {
      const mine = stones.filter((_, i) => i % models.length === which);
      if (mine.length === 0) return;
      const material = source.material.clone();
      (material as Material & { vertexColors?: boolean }).vertexColors = false;
      materials.push(material);
      place(mine, source.geometry, material, 1 / source.height, `lake-stones-${which}`);
    });
  }

  if (pads.length > 0) {
    const leaf = buildLeafGeometry();
    geometries.push(leaf);
    const material = new MeshStandardMaterial({
      name: 'lake-leaf',
      vertexColors: true,
      roughness: 0.46,
      metalness: 0,
      side: DoubleSide,
    });
    // Local units: the leaf is built unit-radius and instanced at a quarter to
    // a half metre, so three centimetres here is one on the water.
    applyFloatBob(material, wind, 0.035, 0.09);
    materials.push(material);
    place(pads, leaf, material, 1, 'lake-leaves');
  }

  if (blooms.length > 0) {
    const bloom = buildBloomGeometry();
    geometries.push(bloom);
    const material = new MeshStandardMaterial({
      name: 'lake-bloom',
      vertexColors: true,
      roughness: 0.6,
      metalness: 0,
      side: DoubleSide,
    });
    // Already in metres, and held on a stem rather than floating, so it nods
    // rather than heaves.
    applyFloatBob(material, wind, 0.012, 0.05);
    materials.push(material);
    place(blooms, bloom, material, 1, 'lake-blooms');
  }

  return finish();
};
