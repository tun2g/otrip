import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  Group,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  RGBAFormat,
  RepeatWrapping,
  Vector3,
  type Material,
} from 'three';

import { applyWetLook } from './rain';
import { applyWindSway, type Wind } from './wind';

/** Metres between height samples in a field's local grid. Sets how fine a contour is traced. */
const CELL = 2.2;
/** Metres between geometry stations along a contour, after resampling. */
const STATION = 3;
/** Contour fragments shorter than this are noise in the heightfield, not a terrace. */
const MIN_CONTOUR = 18;
/** Metres over which a field's edge sinks back into the natural hillside. */
const TAPER = 8;
/** Furthest a bed may reach uphill before the march gives up. */
const MAX_RUN = 24;
const MIN_RUN = 1.8;
/** Metres between the straight bunds of a plain paddy. See `plotBund`. */
const PLOT_SPACING = MAX_RUN * 1.15;
/** The earth lip along the outer edge of a bed, and the wider ones people walk. */
const BUND_WIDTH = 0.52;
const PATH_WIDTH = 1.15;
const BUND_HEIGHT = 0.34;
/** Fill between the cut bed and the natural ground, so the bed never shows terrain through it. */
const BED_LIFT = 0.12;
/** Metres the riser is buried below the contour, so its foot never floats. */
const FOOTING = 0.3;
/** Metres between rows of transplanted rice. The real spacing is 0.2m; this is what we can afford. */
const ROW = 1.15;

const TAU = Math.PI * 2;
const UP = new Vector3(0, 1, 0);

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

type Stage = 'flooded' | 'shoots' | 'ripe' | 'dry';

export type TerraceField = {
  x: number;
  z: number;
  radius: number;
  /** Height of one riser, in metres. Derived from the hillside's own slope. */
  rise: number;
  /** Contour steps cut into this hillside. */
  levels: number;
  /** Individual beds — one contour run at one level. */
  beds: number;
  flooded: number;
  /** Square metres of bed surface. */
  area: number;
};

export type Terraces = {
  group: Group;
  /** What was actually placed. Read by the headless probe; nothing in the scene needs it. */
  fields: TerraceField[];
  update: (elapsed: number) => void;
  /**
   * Hands the mud of the unflooded beds the rain's wetness. Only the beds: a
   * flooded one is already a mirror, and the rice growing in it is foliage that
   * water runs off.
   */
  setWet: (wet: { value: number }) => void;
  dispose: () => void;
};

export type TerraceBudget = {
  /** Hillsides to terrace across the whole map. */
  fields: number;
  /** Rice tufts shared out between every planted bed. */
  crops: number;
};

// --- site selection --------------------------------------------------------

type Site = { x: number; z: number; radius: number; slope: number; score: number };

/**
 * A terraced hillside needs a slope you can actually step, consistently facing
 * one way. A saddle or a cliff shoulder gives contours that spiral and knot, so
 * the gradient has to agree with itself across the whole patch before the site
 * is taken.
 *
 * Flat paddy is the same search with a different band of slope, and that is the
 * whole difference between the two: below 5% the uphill march further down finds
 * fifteen to twenty metres of ground inside one bund height, so a bed comes out
 * as a wide level plot with a low lip, which is what a delta paddy is. Above 7%
 * the same march stops after a couple of metres and the hillside steps. Nothing
 * else in the module needs to know which kind it is building.
 */
const findSites = (terrain: Terrain, recipe: LocationRecipe, wanted: number): Site[] => {
  if (wanted <= 0 || recipe.farming === 'none') return [];

  const paddy = recipe.farming === 'paddy';
  const random = createPrng(`${recipe.seed}:terrace-sites`);
  const half = terrain.size / 2;
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  // Paddy is irrigated by gravity off the nearest channel, so it sits just above
  // the water rather than anywhere on the hill; `terrain.maxHeight * 0.08` is a
  // relief fraction and on a 200m karst patch that is 16m of climb the water
  // would never make.
  const lowest = paddy ? waterLevel + 1.5 : Math.max(waterLevel + 5, terrain.maxHeight * 0.08);
  const highest = paddy ? waterLevel + terrain.maxHeight * 0.12 : recipe.scatter.treeLine * 0.88;
  if (highest <= lowest) return [];
  // The town generator runs after this one and does not know where a field is, so
  // the field has to stay out of the built-up area or houses land in the rice.
  const townSpread = recipe.town ? recipe.town.spread * half : 0;

  const step = Math.max(26, terrain.size / 110);
  const reach = half * 0.78;
  const probe = 22;
  const candidates: Site[] = [];

  const gradient = (x: number, z: number, into: { x: number; z: number }): number => {
    const dx = terrain.heightAt(x + 4, z) - terrain.heightAt(x - 4, z);
    const dz = terrain.heightAt(x, z + 4) - terrain.heightAt(x, z - 4);
    const length = Math.hypot(dx, dz);
    if (length < 1e-5) {
      into.x = 0;
      into.z = 0;
      return 0;
    }
    into.x = dx / length;
    into.z = dz / length;
    return length / 8;
  };

  const centre = { x: 0, z: 0 };
  const neighbour = { x: 0, z: 0 };

  for (let z = -reach; z <= reach; z += step) {
    for (let x = -reach; x <= reach; x += step) {
      const y = terrain.heightAt(x, z);
      if (y < lowest || y > highest) continue;
      if (townSpread > 0 && Math.hypot(x, z) < townSpread * 0.9) continue;

      const slope = gradient(x, z, centre);
      // No floor under the paddy band: a level plain reads 0 and a level plain is
      // where the rice is. The build handles a site with no fall of its own.
      if (paddy ? slope > 0.05 : slope < 0.07 || slope > 0.52) continue;

      let agreement = 0;
      let usable = true;
      for (let i = 0; i < 4; i += 1) {
        const angle = (i / 4) * TAU;
        const nx = x + Math.cos(angle) * probe;
        const nz = z + Math.sin(angle) * probe;
        const near = gradient(nx, nz, neighbour);
        const nearHeight = terrain.heightAt(nx, nz);
        if (near < (paddy ? 0 : 0.04) || near > (paddy ? 0.09 : 0.72)) {
          usable = false;
          break;
        }
        if (nearHeight < lowest - (paddy ? 2 : 12) || nearHeight > highest + (paddy ? 4 : 25)) {
          usable = false;
          break;
        }
        agreement += centre.x * neighbour.x + centre.z * neighbour.z;
      }
      if (!usable) continue;
      agreement /= 4;
      // Flat ground has no aspect to agree about: on a 1% fall the gradient
      // direction is noise, and asking it to agree rejects every paddy site.
      if (!paddy && agreement < 0.55) continue;

      // North is -Z and east is +X, so a hillside falling south or east takes the
      // sun all morning — which is where people actually terrace.
      const aspect = paddy ? 0.5 : 0.5 + 0.5 * (-centre.z * 0.7 - centre.x * 0.3);
      const slopeFit = paddy ? 1 - slope / 0.05 : 1 - Math.abs(slope - 0.26) / 0.3;
      // Terraces nobody walks past are wasted geometry; the viewer starts near
      // the middle of the map.
      const visibility = 1 - clamp(Math.hypot(x, z) / (half * 0.8), 0, 1);

      candidates.push({
        x,
        z,
        radius: 0,
        slope,
        score: slopeFit * 1.1 + agreement * 0.9 + aspect * 0.7 + visibility * 1.3,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const taken: Site[] = [];
  for (const candidate of candidates) {
    if (taken.length >= wanted) break;
    const radius = 62 + random() * 36;
    const clear = taken.every(
      (site) => Math.hypot(site.x - candidate.x, site.z - candidate.z) > (site.radius + radius) * 1.15
    );
    if (!clear) continue;
    taken.push({ ...candidate, radius });
  }

  return taken;
};

// --- contour extraction ----------------------------------------------------

type Grid = { x0: number; z0: number; side: number; heights: Float32Array; min: number; max: number };

const sampleGrid = (terrain: Terrain, site: Site): Grid => {
  const side = Math.max(8, Math.round((site.radius * 2) / CELL) + 1);
  const x0 = site.x - site.radius;
  const z0 = site.z - site.radius;
  const heights = new Float32Array(side * side);
  let min = Infinity;
  let max = -Infinity;

  for (let r = 0; r < side; r += 1) {
    for (let c = 0; c < side; c += 1) {
      const h = terrain.heightAt(x0 + c * CELL, z0 + r * CELL);
      heights[r * side + c] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }

  return { x0, z0, side, heights, min, max };
};

type Chain = { x: number[]; z: number[]; closed: boolean };

/**
 * Marching squares. Every crossing lives on a named grid edge, so a cell can
 * link its two endpoints by index and the segments assemble into whole lines
 * without any coordinate matching — which is what keeps a contour continuous
 * instead of breaking into the shards that make a terrace look like boxes.
 */
const traceContour = (grid: Grid, level: number): Chain[] => {
  const { side, heights, x0, z0 } = grid;
  const cells = side - 1;
  if (cells < 2) return [];

  const at = (r: number, c: number): number => heights[r * side + c];

  const hEdge = new Int32Array(side * cells).fill(-1);
  const vEdge = new Int32Array(cells * side).fill(-1);
  const px: number[] = [];
  const pz: number[] = [];

  for (let r = 0; r < side; r += 1) {
    for (let c = 0; c < cells; c += 1) {
      const a = at(r, c);
      const b = at(r, c + 1);
      if (a < level === b < level) continue;
      hEdge[r * cells + c] = px.length;
      px.push(x0 + (c + (level - a) / (b - a)) * CELL);
      pz.push(z0 + r * CELL);
    }
  }
  for (let r = 0; r < cells; r += 1) {
    for (let c = 0; c < side; c += 1) {
      const a = at(r, c);
      const b = at(r + 1, c);
      if (a < level === b < level) continue;
      vEdge[r * side + c] = px.length;
      px.push(x0 + c * CELL);
      pz.push(z0 + (r + (level - a) / (b - a)) * CELL);
    }
  }

  const count = px.length;
  if (count < 4) return [];

  const link = new Int32Array(count * 2).fill(-1);
  const join = (a: number, b: number) => {
    if (a < 0 || b < 0 || a === b) return;
    if (link[a * 2] < 0) link[a * 2] = b;
    else if (link[a * 2 + 1] < 0) link[a * 2 + 1] = b;
    if (link[b * 2] < 0) link[b * 2] = a;
    else if (link[b * 2 + 1] < 0) link[b * 2 + 1] = a;
  };

  for (let r = 0; r < cells; r += 1) {
    for (let c = 0; c < cells; c += 1) {
      const top = hEdge[r * cells + c];
      const bottom = hEdge[(r + 1) * cells + c];
      const left = vEdge[r * side + c];
      const right = vEdge[r * side + c + 1];
      const mask =
        (at(r, c) >= level ? 1 : 0) |
        (at(r, c + 1) >= level ? 2 : 0) |
        (at(r + 1, c + 1) >= level ? 4 : 0) |
        (at(r + 1, c) >= level ? 8 : 0);

      switch (mask) {
        case 1:
        case 14:
          join(top, left);
          break;
        case 2:
        case 13:
          join(top, right);
          break;
        case 4:
        case 11:
          join(right, bottom);
          break;
        case 7:
        case 8:
          join(left, bottom);
          break;
        case 3:
        case 12:
          join(left, right);
          break;
        case 6:
        case 9:
          join(top, bottom);
          break;
        case 5:
        case 10: {
          // The ambiguous cell. The average of the four corners decides whether
          // the two matching corners are one ridge or two separate bumps.
          const inside = (at(r, c) + at(r, c + 1) + at(r + 1, c) + at(r + 1, c + 1)) / 4 >= level;
          if ((mask === 5) === inside) {
            join(top, right);
            join(left, bottom);
          } else {
            join(top, left);
            join(right, bottom);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const used = new Uint8Array(count);
  const chains: Chain[] = [];

  const walk = (start: number): number[] => {
    const order: number[] = [];
    let cursor = start;
    while (cursor >= 0 && used[cursor] === 0) {
      used[cursor] = 1;
      order.push(cursor);
      const a = link[cursor * 2];
      const b = link[cursor * 2 + 1];
      cursor = a >= 0 && used[a] === 0 ? a : b >= 0 && used[b] === 0 ? b : -1;
    }
    return order;
  };

  const emit = (order: number[], closed: boolean) => {
    if (order.length < 3) return;
    const x = order.map((i) => px[i]);
    const z = order.map((i) => pz[i]);
    if (closed) {
      x.push(x[0]);
      z.push(z[0]);
    }
    chains.push({ x, z, closed });
  };

  // Open lines first, from their free ends, so a line that runs off the grid is
  // never entered halfway and split into two.
  for (let i = 0; i < count; i += 1) {
    if (used[i] === 1 || link[i * 2] < 0 || link[i * 2 + 1] >= 0) continue;
    emit(walk(i), false);
  }
  for (let i = 0; i < count; i += 1) {
    if (used[i] === 1 || link[i * 2] < 0) continue;
    emit(walk(i), true);
  }

  return chains;
};

/**
 * One straight bund across a level plain, for the paddy that has no contour to
 * follow. Spacing matches what the uphill march downstream finds on dead-flat
 * ground — `MAX_RUN * 1.15` — so a plot fills the gap to its neighbour exactly
 * rather than leaving a strip of bare terrain or lapping over it.
 */
const plotBund = (site: Site, bearing: number, index: number, total: number): Chain[] => {
  const dirX = Math.cos(bearing);
  const dirZ = Math.sin(bearing);
  const offset = (index - (total - 1) / 2) * PLOT_SPACING;
  const baseX = site.x - dirZ * offset;
  const baseZ = site.z + dirX * offset;
  const span = Math.sqrt(Math.max(0, site.radius * site.radius - offset * offset));
  if (span * 2 < MIN_CONTOUR) return [];

  const x: number[] = [];
  const z: number[] = [];
  for (let along = -span; along <= span; along += STATION) {
    x.push(baseX + dirX * along);
    z.push(baseZ + dirZ * along);
  }
  return x.length >= 4 ? [{ x, z, closed: false }] : [];
};

const smooth = (chain: Chain): void => {
  const { x, z, closed } = chain;
  const n = x.length;
  if (n < 5) return;

  for (let pass = 0; pass < 2; pass += 1) {
    const sx = x.slice();
    const sz = z.slice();
    for (let i = closed ? 0 : 1; i < n - 1; i += 1) {
      const prev = i === 0 ? n - 2 : i - 1;
      const next = i + 1;
      x[i] = sx[prev] * 0.25 + sx[i] * 0.5 + sx[next] * 0.25;
      z[i] = sz[prev] * 0.25 + sz[i] * 0.5 + sz[next] * 0.25;
    }
    if (closed) {
      x[n - 1] = x[0];
      z[n - 1] = z[0];
    }
  }
};

const resample = (chain: Chain, step: number): Chain | null => {
  const { x, z } = chain;
  let total = 0;
  for (let i = 1; i < x.length; i += 1) total += Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  if (total < MIN_CONTOUR) return null;

  const out: Chain = { x: [x[0]], z: [z[0]], closed: chain.closed };
  let carried = 0;
  for (let i = 1; i < x.length; i += 1) {
    const dx = x[i] - x[i - 1];
    const dz = z[i] - z[i - 1];
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    let travelled = step - carried;
    while (travelled <= length) {
      const t = travelled / length;
      out.x.push(x[i - 1] + dx * t);
      out.z.push(z[i - 1] + dz * t);
      travelled += step;
    }
    carried = length - (travelled - step);
  }
  return out.x.length >= 4 ? out : null;
};

/**
 * A circular field edge reads as a stamp. Two harmonics on the radius give the
 * ragged boundary a real field has where it meets scrub and rock.
 */
const createEdge = (site: Site, phase: number, phase2: number) => {
  return (x: number, z: number): boolean => {
    const dx = x - site.x;
    const dz = z - site.z;
    const angle = Math.atan2(dz, dx);
    const limit = site.radius * (0.76 + 0.15 * Math.sin(angle * 2 + phase) + 0.09 * Math.sin(angle * 3 + phase2));
    return dx * dx + dz * dz <= limit * limit;
  };
};

/** Splits a resampled contour into the runs that fall inside the field. */
const clipToField = (chain: Chain, inside: (x: number, z: number) => boolean): Chain[] => {
  const runs: Chain[] = [];
  let current: Chain | null = null;

  for (let i = 0; i < chain.x.length; i += 1) {
    if (inside(chain.x[i], chain.z[i])) {
      if (!current) current = { x: [], z: [], closed: false };
      current.x.push(chain.x[i]);
      current.z.push(chain.z[i]);
    } else if (current) {
      runs.push(current);
      current = null;
    }
  }
  if (current) runs.push(current);

  // A loop that never left the field is still a loop.
  if (chain.closed && runs.length === 1 && runs[0].x.length === chain.x.length) runs[0].closed = true;

  return runs.filter((run) => run.x.length * STATION >= MIN_CONTOUR);
};

// --- geometry --------------------------------------------------------------

type Builder = { position: number[]; color: number[]; uv: number[]; index: number[] };

const createBuilder = (): Builder => ({ position: [], color: [], uv: [], index: [] });

const pushVertex = (builder: Builder, x: number, y: number, z: number, color: Color): number => {
  const index = builder.position.length / 3;
  builder.position.push(x, y, z);
  builder.color.push(color.r, color.g, color.b);
  builder.uv.push(x / 3, z / 3);
  return index;
};

const pushQuad = (builder: Builder, a: number, b: number, c: number, d: number): void => {
  builder.index.push(a, b, c, a, c, d);
};

const finishGeometry = (builder: Builder, withUv: boolean): BufferGeometry | null => {
  if (builder.index.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(builder.position), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(builder.color), 3));
  if (withUv) geometry.setAttribute('uv', new BufferAttribute(new Float32Array(builder.uv), 2));
  geometry.setIndex(builder.index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
};

/**
 * One rice tuft: blades splayed from a single root, shaded dark at the base and
 * bright at the tip so a field has depth even before the light reaches it.
 */
const createTuftGeometry = (height: number, lean: number, base: Color, tip: Color): BufferGeometry => {
  const position: number[] = [];
  const color: number[] = [];
  const blades = 4;

  for (let i = 0; i < blades; i += 1) {
    const angle = (i / blades) * TAU + 0.6;
    const spread = 0.04;
    position.push(Math.cos(angle + 0.6) * spread, 0, Math.sin(angle + 0.6) * spread);
    position.push(Math.cos(angle - 0.6) * spread, 0, Math.sin(angle - 0.6) * spread);
    position.push(Math.cos(angle) * lean, height, Math.sin(angle) * lean);
    color.push(base.r, base.g, base.b, base.r, base.g, base.b, tip.r, tip.g, tip.b);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(color), 3));
  geometry.computeVertexNormals();
  return geometry;
};

/**
 * A tileable ripple, as a normal map. Still water at dawn is the whole point of
 * a flooded bed, so the amplitude is deliberately small — this is the breath on
 * a mirror, not a sea.
 */
const createRippleNormal = (size = 64): DataTexture => {
  const data = new Uint8Array(size * size * 4);
  const wave = (u: number, v: number): number =>
    Math.sin(u * TAU * 2) * 0.5 + Math.sin((u * 2 + v * 3) * TAU) * 0.3 + Math.sin(v * TAU * 3 + 1.7) * 0.2;

  const e = 1 / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const dx = ((wave(u + e, v) - wave(u - e, v)) / (2 * e)) * 0.06;
      const dz = ((wave(u, v + e) - wave(u, v - e)) / (2 * e)) * 0.06;
      const length = Math.hypot(dx, dz, 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((-dz / length) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((1 / length) * 0.5 * 255 + 127.5);
      data[i + 3] = 255;
    }
  }

  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
};

type Tuft = { x: number; y: number; z: number; scale: number; rotation: number; ripe: boolean };

/**
 * Ruộng bậc thang. Each riser traces a line of constant height, so the pattern
 * the hillside shows is its own shape — that is the whole image, and it is why
 * the beds come from marching squares over the real heightfield rather than
 * from a grid laid on top of it.
 *
 * Nothing here touches the heightfield: `packages/world/src/terrain.ts` is
 * shared with the server for height validation, so every bed is fill standing
 * on untouched ground.
 */
export const createTerraces = (
  terrain: Terrain,
  recipe: LocationRecipe,
  budget: TerraceBudget,
  wind: Wind
): Terraces => {
  const group = new Group();
  group.name = 'terraces';

  const fields: TerraceField[] = [];
  const paddy = recipe.farming === 'paddy';
  const sites = findSites(terrain, recipe, budget.fields);

  const earth = createBuilder();
  const water = createBuilder();
  const tufts: Tuft[] = [];
  // Candidates are thinned to the budget afterwards, so collecting a few times
  // the budget keeps the spread even without building a million-entry array.
  const cropCeiling = Math.max(1, budget.crops) * 4;

  const random = createPrng(`${recipe.seed}:terraces`);

  // Laterite, pulled a little towards the location's own ground so a karst
  // valley and a Sơn La ridge do not share one soil.
  const bare = new Color(recipe.ground.rock);
  const riser = new Color('#8a5f3a').lerp(bare, 0.18);
  const riserShade = new Color('#6a4629').lerp(bare, 0.14);
  const path = new Color('#b09272').lerp(bare, 0.2);
  const dryBed = new Color('#7d6b4e');
  const wetBed = new Color('#4a4132');
  const greenBed = new Color('#56802f');
  const ripeBed = new Color('#9c7f32');
  const spill = new Color('#9fb4b0');
  const tint = new Color();

  const scratch = { x: 0, z: 0 };

  for (const site of sites) {
    const grid = sampleGrid(terrain, site);
    const rise = clamp(site.slope * 6, 0.45, 1.5);
    const range = grid.max - grid.min;
    // A dead-level plain has no contour to follow, and that is exactly where most
    // paddy is: of 2301 sample cells in Tràng An's irrigable band, 1177 fall by
    // less than 1%. There the bunds are straight lines somebody chose, not the
    // ground's own shape, so the plots come off a bearing instead of out of
    // marching squares. A hillside never takes this path — it has a contour, and
    // the contour is the whole image.
    const straight = paddy && range < rise * 4;
    if (!straight && range < rise * 4) continue;

    const levels = straight ? Math.floor((site.radius * 2) / PLOT_SPACING) : Math.min(48, Math.floor(range / rise) - 1);
    if (levels < (straight ? 2 : 4)) continue;

    const inside = createEdge(site, random() * TAU, random() * TAU);
    // Drawn only on the path that uses it, so adding plain paddy did not shift
    // the stream of a hillside that was already placed.
    const bearing = straight ? random() * TAU : 0;
    const pathEvery = 4 + Math.floor(random() * 4);
    const pathOffset = Math.floor(random() * pathEvery);

    const field: TerraceField = {
      x: site.x,
      z: site.z,
      radius: site.radius,
      rise,
      levels: 0,
      beds: 0,
      flooded: 0,
      area: 0,
    };

    for (let step = 0; step < levels; step += 1) {
      const contourLevel = grid.min + (step + 0.5) * rise;
      // Beds at one level tend to be at the same stage — one owner, one planting
      // week — so the hillside bands instead of flickering bed to bed.
      const levelRoll = random();
      const isPath = (step + pathOffset) % pathEvery === 0;

      const chains = straight ? plotBund(site, bearing, step, levels) : traceContour(grid, contourLevel);
      let placedAtLevel = false;

      for (const chain of chains) {
        smooth(chain);
        const even = resample(chain, STATION);
        if (!even) continue;

        for (const run of clipToField(even, inside)) {
          // Resampling leaves a loop a step short of its own start, so close the
          // ring explicitly or every terrace on a knoll shows one seam.
          if (run.closed) {
            run.x.push(run.x[0]);
            run.z.push(run.z[0]);
          }
          const count = run.x.length;
          if (count < 4) continue;

          // Walk the run so that the uphill side is always on the same hand.
          // Flipping the normal instead would flip the winding with it and turn
          // every bed inside out.
          let vote = 0;
          for (let i = 1; i < count; i += 1) {
            const tx = run.x[i] - run.x[i - 1];
            const tz = run.z[i] - run.z[i - 1];
            const length = Math.hypot(tx, tz);
            if (length < 1e-5) continue;
            const nx = tz / length;
            const nz = -tx / length;
            vote +=
              terrain.heightAt(run.x[i] + nx * 5, run.z[i] + nz * 5) -
              terrain.heightAt(run.x[i] - nx * 5, run.z[i] - nz * 5);
          }
          // On a level plain the vote is measuring noise, and letting noise flip
          // every other bund makes neighbouring plots march into each other. The
          // bunds already share one bearing, so leaving the hand alone is what
          // keeps the plots side by side.
          if (!straight && vote < 0) {
            run.x.reverse();
            run.z.reverse();
          }

          // A plain's plot is level at its own ground, not at a contour the
          // hillside does not have.
          let level = contourLevel;
          if (straight) {
            let sum = 0;
            for (let i = 0; i < count; i += 1) sum += terrain.heightAt(run.x[i], run.z[i]);
            level = sum / count;
          }

          const roll = levelRoll * 0.55 + random() * 0.45;
          const stage: Stage = roll < 0.3 ? 'flooded' : roll < 0.55 ? 'shoots' : roll < 0.8 ? 'ripe' : 'dry';
          const wet = stage === 'flooded' || stage === 'shoots';
          const depth = wet ? 0.06 + random() * 0.1 : 0;
          const bund = isPath ? PATH_WIDTH : BUND_WIDTH;
          const spillAt = wet && count > 8 && random() < 0.45 ? 2 + Math.floor(random() * (count - 5)) : -1;

          const bedColor =
            stage === 'flooded' ? wetBed : stage === 'shoots' ? greenBed : stage === 'ripe' ? ripeBed : dryBed;

          let previous: { a: number; b: number; c: number; d1: number; d2: number; e: number } | null = null;
          let previousWater: { front: number; back: number } | null = null;
          let previousWidth = 0;
          let area = 0;

          for (let i = 0; i < count; i += 1) {
            const x = run.x[i];
            const z = run.z[i];

            const prevX = run.x[Math.max(0, i - 1)];
            const prevZ = run.z[Math.max(0, i - 1)];
            const nextX = run.x[Math.min(count - 1, i + 1)];
            const nextZ = run.z[Math.min(count - 1, i + 1)];
            let tx = nextX - prevX;
            let tz = nextZ - prevZ;
            const length = Math.hypot(tx, tz);
            if (length < 1e-5) continue;
            tx /= length;
            tz /= length;
            scratch.x = tz;
            scratch.z = -tx;

            const taper = run.closed ? 1 : clamp((Math.min(i, count - 1 - i) * STATION) / TAPER, 0, 1);

            // How far uphill the ground climbs one riser is exactly how wide the
            // bed can be: gentle ground gives a wide bed, steep ground a narrow
            // one, with no width constant anywhere in the module.
            let reach = 0;
            while (
              reach < MAX_RUN &&
              terrain.heightAt(x + scratch.x * (reach + 0.9), z + scratch.z * (reach + 0.9)) < level + rise
            ) {
              reach += 0.9;
            }
            const width = clamp(reach, MIN_RUN, MAX_RUN) * 1.15 * taper;

            const bedY = level + BED_LIFT + rise * taper;
            const notch = i === spillAt ? 0.3 : 1;
            const lip = BUND_HEIGHT * taper * notch;
            const outX = x - scratch.x * bund;
            const outZ = z - scratch.z * bund;
            // The riser stands on the contour but its outer face is a bund's width
            // downhill of it, where the natural ground is already lower. Burying
            // the foot by that much is what stops a wide path bund from floating.
            const footing = FOOTING + bund * 1.3;

            tint.copy(riser).lerp(riserShade, 0.5 + 0.5 * Math.sin(x * 0.21 + z * 0.17 + step));
            const a = pushVertex(earth, outX, bedY + lip, outZ, isPath ? path : tint);
            const b = pushVertex(earth, outX, level + BED_LIFT - footing, outZ, riserShade);
            const c = pushVertex(earth, x, bedY + lip, z, isPath ? path : tint);
            tint.copy(bedColor).lerp(riserShade, 0.35);
            const d1 = pushVertex(earth, x, bedY, z, tint);
            tint.copy(bedColor).multiplyScalar(0.94 + 0.12 * Math.sin(x * 0.37 - z * 0.29));
            const d2 = pushVertex(earth, x, bedY, z, tint);
            const e = pushVertex(earth, x + scratch.x * width, bedY, z + scratch.z * width, tint);

            if (previous) {
              pushQuad(earth, previous.a, previous.b, b, a);
              pushQuad(earth, previous.a, a, c, previous.c);
              pushQuad(earth, previous.c, c, d1, previous.d1);
              pushQuad(earth, previous.d2, d2, e, previous.e);
              area += ((previousWidth + width) / 2) * STATION;
            }

            if (wet && width > MIN_RUN) {
              const waterY = bedY + depth;
              const backOffset = Math.max(0.1, width - 0.08);
              tint.copy(wetBed).multiplyScalar(0.9 + 0.2 * Math.sin(x * 0.13 + z * 0.11));
              const front = pushVertex(water, x + scratch.x * 0.06, waterY, z + scratch.z * 0.06, tint);
              const back = pushVertex(water, x + scratch.x * backOffset, waterY, z + scratch.z * backOffset, tint);
              if (previousWater) pushQuad(water, previousWater.front, front, back, previousWater.back);
              previousWater = { front, back };

              // Where a bed overflows, the water goes over the bund and down the
              // riser into the bed below. A notch without the fall is just a dent.
              if (i === spillAt) {
                const chuteX = outX - scratch.x * 0.05;
                const chuteZ = outZ - scratch.z * 0.05;
                const s0 = pushVertex(water, chuteX + tx * 0.35, waterY, chuteZ + tz * 0.35, spill);
                const s1 = pushVertex(water, chuteX - tx * 0.35, waterY, chuteZ - tz * 0.35, spill);
                const s2 = pushVertex(water, chuteX - tx * 0.35, bedY - rise * 0.92, chuteZ - tz * 0.35, tint);
                const s3 = pushVertex(water, chuteX + tx * 0.35, bedY - rise * 0.92, chuteZ + tz * 0.35, tint);
                pushQuad(water, s0, s1, s2, s3);
              }
            } else {
              previousWater = null;
            }

            if ((stage === 'shoots' || stage === 'ripe') && i % 2 === 0 && width > ROW && tufts.length < cropCeiling) {
              const rows = Math.min(9, Math.floor(width / ROW));
              for (let r = 0; r < rows; r += 1) {
                const along = 0.55 + r * ROW + (random() - 0.5) * 0.3;
                if (along > width - 0.2) continue;
                tufts.push({
                  x: x + scratch.x * along + tx * (random() - 0.5) * 1.6,
                  y: bedY,
                  z: z + scratch.z * along + tz * (random() - 0.5) * 1.6,
                  scale: 0.75 + random() * 0.5,
                  rotation: random() * TAU,
                  ripe: stage === 'ripe',
                });
              }
            }

            previous = { a, b, c, d1, d2, e };
            previousWidth = width;
          }

          if (area > 0) {
            field.beds += 1;
            field.area += area;
            if (wet) field.flooded += 1;
            placedAtLevel = true;
          }
        }
      }

      if (placedAtLevel) field.levels += 1;
    }

    if (field.beds > 0) fields.push(field);
  }

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const meshes: Mesh[] = [];

  const earthGeometry = finishGeometry(earth, false);
  let earthMaterial: MeshStandardMaterial | null = null;
  if (earthGeometry) {
    const material = new MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.95,
      metalness: 0,
    });
    earthMaterial = material;
    const mesh = new Mesh(earthGeometry, material);
    mesh.name = 'terrace-beds';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    geometries.push(earthGeometry);
    materials.push(material);
    meshes.push(mesh);
  }

  const ripple = createRippleNormal();
  const waterGeometry = finishGeometry(water, true);
  if (waterGeometry) {
    // A dark body under a smooth surface: almost all of what you see is the sky
    // arriving through the fresnel term, which is what makes a flooded bed a
    // mirror rather than a puddle of paint.
    const material = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.07,
      metalness: 0.08,
      envMapIntensity: 1.7,
      normalMap: ripple,
      side: DoubleSide,
    });
    material.normalScale.set(0.22, 0.22);
    const mesh = new Mesh(waterGeometry, material);
    mesh.name = 'terrace-water';
    mesh.receiveShadow = true;
    group.add(mesh);
    geometries.push(waterGeometry);
    materials.push(material);
    meshes.push(mesh);
  }

  // Share the budget out across whatever was placed, keeping an even spread
  // rather than filling the first field and starving the last.
  const stride = budget.crops > 0 && tufts.length > budget.crops ? Math.ceil(tufts.length / budget.crops) : 1;
  const kept = stride === 1 ? tufts : tufts.filter((_, index) => index % stride === 0);

  const matrix = new Matrix4();
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();

  const crops: { ripe: boolean; geometry: BufferGeometry; height: number }[] = [
    { ripe: false, geometry: createTuftGeometry(0.4, 0.14, new Color('#3c5b22'), new Color('#86b746')), height: 0.4 },
    { ripe: true, geometry: createTuftGeometry(0.78, 0.3, new Color('#8a7230'), new Color('#d8bc5a')), height: 0.78 },
  ];

  for (const crop of crops) {
    const mine = kept.filter((tuft) => tuft.ripe === crop.ripe);
    if (mine.length === 0) {
      crop.geometry.dispose();
      continue;
    }

    const material = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0,
      side: DoubleSide,
    });
    applyWindSway(material, wind, { amplitude: 0.1 * crop.height, height: crop.height, stiffness: 1.4 });

    const mesh = new InstancedMesh(crop.geometry, material, mine.length);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;

    mine.forEach((tuft, index) => {
      position.set(tuft.x, tuft.y, tuft.z);
      quaternion.setFromAxisAngle(UP, tuft.rotation);
      scale.set(tuft.scale, tuft.scale * (0.85 + (index % 7) / 18), tuft.scale);
      mesh.setMatrixAt(index, matrix.compose(position, quaternion, scale));
    });
    mesh.instanceMatrix.needsUpdate = true;

    group.add(mesh);
    geometries.push(crop.geometry);
    materials.push(material);
    meshes.push(mesh);
  }

  return {
    group,
    fields,
    update: (elapsed) => {
      // The mirror is the picture, so the ripple only has to keep it from
      // looking like glass: a few centimetres a second across the bed.
      ripple.offset.set(elapsed * 0.009, elapsed * 0.013);
    },
    // A dry bed is bare worked earth, so it takes the rain harder than grass
    // does; the risers between them are walls and the pooling term knows it.
    setWet: (wet) => {
      if (earthMaterial) applyWetLook(earthMaterial, wet, { darken: 0.44, gloss: 0.6, pooling: 0.72 });
    },
    dispose: () => {
      for (const mesh of meshes) {
        if (mesh instanceof InstancedMesh) mesh.dispose();
      }
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      ripple.dispose();
      group.clear();
    },
  };
};
