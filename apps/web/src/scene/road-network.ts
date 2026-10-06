import { createNoise, createPrng, fbm2d, type LocationRecipe, type Terrain } from '@otrip/world';
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { findLandmasses } from './landmass';
import type { ResolvedPoi } from './points-of-interest';
import { applyWetLook, type WetLookOptions } from './rain';
import type { Platform } from './walker';

/** Vietnamese national standard lane, and the module's unit of width. */
const LANE = 3.5;

export type RoadKind = 'main' | 'secondary' | 'lane' | 'trail';

/**
 * Where something already stands. Only the position is wanted — the hub is the
 * densest cluster of these and the cart lanes run out to the outlying ones — so
 * this takes the town's planned lots as readily as its finished buildings, and
 * the lots are what the renderer has at the point the roads are surveyed.
 */
export type Standing = { x: number; z: number };

/**
 * The settlements, as places rather than as houses.
 *
 * `planTown` has built several per destination since the day it stopped being
 * gated on `recipe.town` — measured on the shipped recipes, 7 at Tà Xùa, 4 at
 * Hội An, 11 at Tràng An and 5 at Hồ Tây — and nothing downstream knew there
 * was more than one. `findHub` takes the densest, the trunk is routed out from
 * it and the three cart lanes go to the far edges *of that one*, so every other
 * hamlet on the map had no road to it, no track to its neighbour and no reason
 * for anyone to walk out: 20 along the west of the Tà Xùa ridge, and 32 on the
 * east bank of what was then a channel cutting Hồ Tây in two, built in full and
 * joined to nothing.
 *
 * Single-linked at the separation `points-of-interest` already uses to decide
 * two things are not the same place, and ordered largest first with the
 * coordinates breaking ties, because the order decides which hamlet gets the
 * lane when the budget runs out and it has to be the same order every time.
 */
const HAMLET_LINK = 260;
/** Fewer houses than this is an outlying farm, not somewhere a road goes. */
const HAMLET_MIN = 3;

type Settlement = { x: number; z: number; count: number };

const settlements = (buildings: readonly Standing[]): Settlement[] => {
  const owner = new Int32Array(buildings.length).fill(-1);
  const found: Settlement[] = [];
  const queue: number[] = [];

  for (let seed = 0; seed < buildings.length; seed += 1) {
    if (owner[seed] >= 0) continue;
    const id = found.length;
    const place = { x: 0, z: 0, count: 0 };
    owner[seed] = id;
    queue.length = 0;
    queue.push(seed);

    while (queue.length > 0) {
      const at = queue.pop() as number;
      place.x += buildings[at].x;
      place.z += buildings[at].z;
      place.count += 1;
      for (let other = 0; other < buildings.length; other += 1) {
        if (owner[other] >= 0) continue;
        if (Math.hypot(buildings[at].x - buildings[other].x, buildings[at].z - buildings[other].z) > HAMLET_LINK) {
          continue;
        }
        owner[other] = id;
        queue.push(other);
      }
    }

    place.x /= place.count;
    place.z /= place.count;
    found.push(place);
  }

  return found.filter((place) => place.count >= HAMLET_MIN).sort((a, b) => b.count - a.count || a.x - b.x || a.z - b.z);
};

/**
 * Metres per search cell. The step has to be finer than the feature it is meant
 * to resolve: at 50 m no switchback fits between two cells, every move up a
 * mountainside breaks the grade limit, and the search returns nothing at all.
 */
const GRID_STEP = 30;
/** Cap on divisions per side, which bounds the search at ~26k cells. */
const GRID_MAX = 160;
/** Rise over run the route finder is comfortable with; above this it pays. */
const COMFORT_GRADE = 0.085;
/** Rise over run it will not accept at all, which is what makes switchbacks. */
const GRADE_LIMIT = 0.26;
/** Metres of ordinary road one metre of bridge costs. Detours up to this, then crosses. */
const BRIDGE_COST = 26;
/** Longest water crossing any one route may carry. Beyond this it goes round. */
const BRIDGE_LIMIT = 440;
/** Terrain gradient above which no road can be cut. */
const CLIFF_SLOPE = 1.4;
/** Spacing of the resampled centreline, in metres. */
const SPACING = 7;
/**
 * Feature size of the going field, in metres, and how much of a road's cost it
 * decides.
 *
 * The cost field is what gives a route its shape, and on the delta it had
 * nothing to say: away from a hill `stepCost` reduces to the run itself, a
 * search over a uniform field returns the straight line, and the carriageway
 * came out 96 to 100% straight at Hội An, Tràng An and Hồ Tây — the whole bend
 * law in `vehicles.ts` was dead code there, every vehicle at cruise everywhere.
 * This is the term that stands for everything which makes flat ground
 * non-uniform and is not its shape: the paddy bunds, the graves, the plot that
 * was already somebody's. At 220 m the channels it opens are the length of a
 * road's bend rather than of a wobble, and 0.45 is as hard as it can push
 * before a branch starts failing its own admission test.
 */
const GOING_WAVE = 220;
const GOING_WEIGHT = 0.45;
/**
 * Terrain gradient at which the going field stops counting. Above this the land
 * decides and nothing else gets a vote — which is both true and load-bearing:
 * Tà Xùa has one corridor a grader could take, and an untempered field priced
 * it out of `trunkEnds`'s cost gate at seven of the twelve wavelengths tried,
 * taking the only drivable road on the mountain with it.
 */
const GOING_SLOPE = 0.35;
/**
 * Design radius per kind, in metres: the tightest bend the easing below will
 * leave in a carriageway. Set against the slowest-cornering vehicle
 * `vehicles.ts` admits on each — a xe khách corners at `sqrt(grip / curvature)`
 * with `grip` 2.9, which holds its 12 m/s cruise down to a 50 m radius, so a
 * design radius of 70 leaves it margin and the bends that come out tighter than
 * the design are the ones it has to brake for. A trail is left the hairpins a
 * path is entitled to.
 */
const EASE_RADIUS: Record<RoadKind, number> = { main: 70, secondary: 55, lane: 30, trail: 10 };
/**
 * Closest two knots of a carriageway may sit, as a multiple of the cell step.
 *
 * The radius cap below looks at one knot at a time, and two opposite deviations
 * in adjacent knots defeat it: each knot's own circle is comfortable while the
 * spline between them reverses in 60 m. Measured, that left 9 to 14 m radii on
 * four of the seven main roads. Thinning first bounds the shortest wavelength
 * the route can carry, and 2.5 cells took the worst bend on the Hội An trunk
 * from a 9 m radius to 49 m.
 */
const KNOT_APART = 2.5;
/** Height of a bridge deck above the water surface. */
const DECK_CLEARANCE = 2.4;
/**
 * How far the carriageway has to stand over the ground before it is published as
 * a floor. A noise floor, not a lip: the made surface is what a foot lands on
 * wherever there is one at all, and every kind carries a `lift` of 6 to 22 cm
 * before any fill, so a threshold at the walker's step height left the body
 * ankle-deep in asphalt along every draped length of every road. Publishing from
 * 4 cm up takes all four destinations to 100% of the carriageway within 10 cm of
 * the surface, against 18 to 35% before.
 */
const SURFACE_GAP = 0.04;
/** Crown of the camber at the centreline, in metres. */
const CAMBER = 0.07;
/** How far the shoulder spreads before it drops to the ground. */
const SHOULDER = 0.6;
/** Half-depth of a painted pedestrian crossing, in metres. */
const CROSSING_HALF = 2.3;
/**
 * How far the surveyed head of a branch may be pulled to reach the ribbon it
 * meets, and the metres of road that pull is spread over.
 *
 * A branch is surveyed from a cell on the trunk's cell path, but the trunk's own
 * ribbon is that path simplified and then eased laterally, so the two parted
 * company: measured across the four destinations the head of a branch finished
 * between 26 and 153 m from the road it branches off — on the ground, a lane
 * that stops in a field short of the highway. A pull spread over less is a step
 * the spline overshoots; 150 m is the length a branch really takes to swing onto
 * a carriageway. Counted in distance rather than in knots because `KNOT_APART`
 * makes the knot spacing variable.
 */
const TIE_REACH = 200;
const TIE_SPREAD = 150;

/**
 * Each kind sits a little higher than the one before it. Where a branch meets a
 * trunk the two ribbons overlap for one cell, and without the stagger that one
 * cell z-fights.
 */
const KINDS: Record<RoadKind, { width: number; lift: number; camber: number; shoulder: number }> = {
  main: { width: LANE * 2, lift: 0.14, camber: CAMBER, shoulder: SHOULDER },
  secondary: { width: 5.5, lift: 0.18, camber: CAMBER * 0.8, shoulder: SHOULDER },
  lane: { width: 3, lift: 0.22, camber: CAMBER * 0.5, shoulder: SHOULDER * 0.7 },
  // Đường mòn. Not a narrow road: no camber, no made surface, and the width
  // here is only the mean — every sample carries its own.
  trail: { width: 0.95, lift: 0.06, camber: 0, shoulder: 0.2 },
};

const KIND_ORDER: RoadKind[] = ['main', 'secondary', 'lane', 'trail'];

/** A path longer than this is not one walk, whatever the crest bonus thinks. */
const MAX_TRAIL_LENGTH = 2200;
/**
 * Trails the named places, the crest and the bank may have between them, and the
 * further tracks the hamlets may add on top. Split rather than one number so
 * that making room for the paths between the bản cannot hand a sixth path to a
 * viewpoint: the five is what those callers have always shared.
 */
const NAMED_TRAILS = 5;
const HAMLET_TRAILS = 4;

/** Shorter than this and a route is a scrap of ribbon, not somewhere you go. */
const MIN_LENGTH: Record<RoadKind, number> = { main: 160, secondary: 130, lane: 100, trail: 110 };

/** Worn width of a trail, in metres. A path, not a lane. */
const TRAIL_MIN_WIDTH = 0.6;
const TRAIL_MAX_WIDTH = 1.2;

export type RoadSample = {
  x: number;
  y: number;
  z: number;
  /** Unit tangent in the XZ plane. */
  tx: number;
  tz: number;
  /** Signed curvature in 1/m. Positive turns right, which is the inside lane here. */
  curvature: number;
};

export type Road = {
  index: number;
  kind: RoadKind;
  width: number;
  /** Centre of the right-hand lane as an offset from the centreline. Vietnam drives on the right. */
  laneOffset: number;
  totalLength: number;
  /** Distances along the road carrying a painted crossing, so traffic can stop at one. */
  crossings: number[];
  /**
   * The centreline as x, y, z triples at `SPACING` metres apart. Read-only: it is
   * the same buffer the ribbon was built from, and the map UI draws it directly.
   */
  points: Float32Array;
};

/**
 * Where a motorbike is left standing. Heading points the way the bike faces.
 *
 * `area` groups the slots of one row — bikes are left in a line against a kerb,
 * four or five of them 0.9 m apart, and that whole line is *one place you can go
 * to find a bike*. Without the grouping a caller spreading itself over the flat
 * array puts every bike it has within four metres of the others, which is what
 * left a five-kilometre map with exactly one place to pick one up.
 */
export type ParkingSpot = { x: number; y: number; z: number; heading: number; area: number };

export type RoadNetwork = {
  group: Group;
  roads: Road[];
  /** Position, tangent and curvature at a distance along a road. Wraps, and allocates nothing. */
  sampleAt: (roadIndex: number, distance: number, out: RoadSample) => RoadSample;
  parking: ParkingSpot[];
  /**
   * Every length of carriageway standing clear of the ground — bridges, their
   * approaches, and the fill a graded road is carried on — as walkable spans,
   * for `walker.setPlatforms`. Rectangles following the centreline rather than
   * one box per run: a curved deck described by one box would hang over the
   * water in the middle of the bend and fall short of the parapets at its ends.
   */
  decks: Platform[];
  update: (elapsed: number) => void;
  setNight: (amount: number) => void;
  /** Hands every carriageway the rain's wetness. Call once, with `rain.wetUniform`. */
  setWet: (wet: { value: number }) => void;
  dispose: () => void;
};

/**
 * Wet asphalt is the strongest thing rain does to a built landscape, and it is
 * the gloss that does it rather than the darkening — the surface is already near
 * black, so a mirror of the sky is all there is left to gain. A dirt lane is the
 * other way round: it goes to mud, which is most of a stop darker and no shinier.
 */
const WET_SURFACE: Record<RoadKind, WetLookOptions> = {
  main: { darken: 0.3, gloss: 0.9, pooling: 0.75 },
  secondary: { darken: 0.3, gloss: 0.9, pooling: 0.75 },
  lane: { darken: 0.46, gloss: 0.52, pooling: 0.8 },
  trail: { darken: 0.4, gloss: 0.38, pooling: 0.8 },
};

// --- geometry plumbing -------------------------------------------------------

export type Part = { geometry: BufferGeometry; color: string };

/**
 * One vertex-coloured geometry out of many primitives, consuming the sources. A
 * bridge with forty parts and a bridge with one both cost a single draw call
 * this way, and that is what pays for the detail everywhere in this module and
 * in `vehicles.ts`, which builds its bodywork the same way.
 */
export const mergeParts = (parts: Part[]): BufferGeometry | null => {
  const prepared: BufferGeometry[] = [];
  const tint = new Color();

  for (const part of parts) {
    const source = part.geometry;
    const position = source.getAttribute('position');
    const normal = source.getAttribute('normal');
    const uv = source.getAttribute('uv');
    const index = source.getIndex();

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(position.array), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normal.array), 3));
    geometry.setAttribute(
      'uv',
      uv
        ? new BufferAttribute(new Float32Array(uv.array), 2)
        : new BufferAttribute(new Float32Array(position.count * 2), 2)
    );

    tint.set(part.color);
    const colors = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i += 1) {
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3));

    // mergeGeometries refuses a mix of indexed and non-indexed inputs, so
    // anything arriving without an index gets a trivial one.
    if (index) {
      geometry.setIndex(Array.from(index.array));
    } else {
      const trivial = new Uint32Array(position.count);
      for (let i = 0; i < position.count; i += 1) trivial[i] = i;
      geometry.setIndex(new BufferAttribute(trivial, 1));
    }

    prepared.push(geometry);
    source.dispose();
  }

  if (prepared.length === 0) return null;
  const merged = mergeGeometries(prepared);
  for (const geometry of prepared) geometry.dispose();
  return merged;
};

export const box = (
  size: [number, number, number],
  at: [number, number, number],
  color: string,
  spin?: [number, number, number]
): Part => {
  const geometry = new BoxGeometry(size[0], size[1], size[2]);
  if (spin) {
    if (spin[0]) geometry.rotateX(spin[0]);
    if (spin[1]) geometry.rotateY(spin[1]);
    if (spin[2]) geometry.rotateZ(spin[2]);
  }
  geometry.translate(at[0], at[1], at[2]);
  return { geometry, color };
};

export const tube = (
  radii: [number, number],
  height: number,
  at: [number, number, number],
  color: string,
  spin?: [number, number, number],
  sides = 8
): Part => {
  const geometry = new CylinderGeometry(radii[0], radii[1], height, sides);
  if (spin) {
    if (spin[0]) geometry.rotateX(spin[0]);
    if (spin[1]) geometry.rotateY(spin[1]);
    if (spin[2]) geometry.rotateZ(spin[2]);
  }
  geometry.translate(at[0], at[1], at[2]);
  return { geometry, color };
};

/**
 * A cylinder from one point to another. Rotating the default +Y cylinder by the
 * polar angle and then the azimuth is what lets a rope sag and a stay lean,
 * neither of which lands on an axis.
 */
export const strut = (
  from: [number, number, number],
  to: [number, number, number],
  radius: number,
  color: string,
  sides = 5
): Part => {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const span = Math.hypot(dx, dy, dz) || 0.001;
  const geometry = new CylinderGeometry(radius, radius, span, sides);
  geometry.rotateX(Math.acos(Math.max(-1, Math.min(1, dy / span))));
  geometry.rotateY(Math.atan2(dx, dz));
  geometry.translate((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2);
  return { geometry, color };
};

// --- the search grid ---------------------------------------------------------

type Grid = {
  cols: number;
  step: number;
  /** World coordinate of the centre of cell 0. */
  origin: number;
  height: Float32Array;
  slope: Float32Array;
  water: Uint8Array;
  /** Metres this cell stands above the ring two cells out — how much of a crest it is. */
  prominence: Float32Array;
  /** Fraction of the eight neighbours that are water — how much of a bank it is. */
  bank: Float32Array;
  /** The largest prominence on the map, so the ridge bonus can be normalised. */
  relief: number;
  /** -1..1, mean zero: how hard the going is here beyond the shape of the land. */
  going: Float32Array;
};

const buildGrid = (terrain: Terrain, waterLevel: number, seed: string): Grid => {
  const cols = Math.min(GRID_MAX, Math.max(64, Math.round(terrain.size / GRID_STEP)));
  const step = terrain.size / cols;
  const origin = -terrain.size / 2 + step / 2;
  const height = new Float32Array(cols * cols);
  const slope = new Float32Array(cols * cols);
  const water = new Uint8Array(cols * cols);

  for (let row = 0; row < cols; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const x = origin + col * step;
      const z = origin + row * step;
      const y = terrain.heightAt(x, z);
      height[index] = y;
      slope[index] = terrain.slopeAt(x, z);
      water[index] = y < waterLevel + 0.5 ? 1 : 0;
    }
  }

  const bank = new Float32Array(cols * cols);
  for (let row = 1; row < cols - 1; row += 1) {
    for (let col = 1; col < cols - 1; col += 1) {
      const index = row * cols + col;
      if (water[index] === 1) continue;
      let wet = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          wet += water[(row + dr) * cols + col + dc];
        }
      }
      bank[index] = wet / 8;
    }
  }

  const prominence = new Float32Array(cols * cols);
  let relief = 0;
  const ring = [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
    [2, 2],
    [2, -2],
    [-2, 2],
    [-2, -2],
  ];
  for (let row = 2; row < cols - 2; row += 1) {
    for (let col = 2; col < cols - 2; col += 1) {
      const index = row * cols + col;
      let around = 0;
      for (const offset of ring) around += height[(row + offset[1]) * cols + col + offset[0]];
      const above = height[index] - around / ring.length;
      prominence[index] = above > 0 ? above : 0;
      if (prominence[index] > relief) relief = prominence[index];
    }
  }

  const goingNoise = createNoise(`${seed}:going`);
  const going = new Float32Array(cols * cols);
  let goingSum = 0;
  for (let row = 0; row < cols; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const value = fbm2d(goingNoise, (origin + col * step) / GOING_WAVE, (origin + row * step) / GOING_WAVE, {
        octaves: 2,
        frequency: 1,
        lacunarity: 2.7,
        gain: 0.32,
      });
      going[index] = value;
      goingSum += value;
    }
  }
  // Centred and normalised to -1..1. Zero mean is what keeps a route costed
  // through this field costed in metres of ordinary road, which is the unit the
  // admission tests in `trunkEnds`, `branchTo` and `addTrail` are calibrated in.
  const goingMean = goingSum / (cols * cols);
  let goingSpread = 1e-6;
  for (let i = 0; i < going.length; i += 1) {
    going[i] -= goingMean;
    if (Math.abs(going[i]) > goingSpread) goingSpread = Math.abs(going[i]);
  }
  for (let i = 0; i < going.length; i += 1) going[i] /= goingSpread;

  return { cols, step, origin, height, slope, water, bank, prominence, relief, going };
};

const cellOf = (grid: Grid, x: number, z: number): number => {
  const col = Math.min(grid.cols - 1, Math.max(0, Math.round((x - grid.origin) / grid.step)));
  const row = Math.min(grid.cols - 1, Math.max(0, Math.round((z - grid.origin) / grid.step)));
  return row * grid.cols + col;
};

/**
 * Knight moves as well as the eight neighbours. Restricted to 45° steps the
 * search produces staircases that survive smoothing as visible scallops.
 */
const MOVES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [2, 1],
  [2, -1],
  [-2, 1],
  [-2, -1],
  [1, 2],
  [1, -2],
  [-1, 2],
  [-1, -2],
];

const createHeap = () => {
  const nodes: number[] = [];
  const costs: number[] = [];

  const swap = (a: number, b: number) => {
    const node = nodes[a];
    const cost = costs[a];
    nodes[a] = nodes[b];
    costs[a] = costs[b];
    nodes[b] = node;
    costs[b] = cost;
  };

  return {
    isEmpty: () => nodes.length === 0,
    push: (node: number, cost: number) => {
      nodes.push(node);
      costs.push(cost);
      let child = nodes.length - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (costs[parent] <= costs[child]) break;
        swap(parent, child);
        child = parent;
      }
    },
    pop: (): number => {
      const top = nodes[0];
      const tailNode = nodes.pop();
      const tailCost = costs.pop();
      if (nodes.length > 0 && tailNode !== undefined && tailCost !== undefined) {
        nodes[0] = tailNode;
        costs[0] = tailCost;
        let parent = 0;
        for (;;) {
          const left = parent * 2 + 1;
          const right = left + 1;
          let smallest = parent;
          if (left < nodes.length && costs[left] < costs[smallest]) smallest = left;
          if (right < nodes.length && costs[right] < costs[smallest]) smallest = right;
          if (smallest === parent) break;
          swap(parent, smallest);
          parent = smallest;
        }
      }
      return top;
    },
  };
};

/**
 * What the thing being routed can take. A road and a đường mòn search the same
 * grid with the same code and disagree about every number in it: a path goes
 * straight up a pitch a grader could never cut, crosses ground no road could be
 * benched into, and refuses water outright because it has nothing to cross with.
 */
type Profile = {
  comfortGrade: number;
  gradeLimit: number;
  cliffSlope: number;
  /** How much the cost of cutting into a hillside counts. */
  slopeWeight: number;
  /** Metres of ordinary surface one metre of water costs. Infinity makes it impassable. */
  waterCost: number;
  /** Longest total water crossing one route may carry, in metres. */
  wetLimit: number;
  /** How strongly the route is pulled onto a local crest. 0 for anything wheeled. */
  ridgePull: number;
  /** How strongly it is pulled onto the bank, which is what makes a bờ hồ path. */
  shorePull: number;
  /** How much the going field counts. */
  goingWeight: number;
};

const ROAD_PROFILE: Profile = {
  comfortGrade: COMFORT_GRADE,
  gradeLimit: GRADE_LIMIT,
  cliffSlope: CLIFF_SLOPE,
  slopeWeight: 1.1,
  waterCost: BRIDGE_COST,
  wetLimit: BRIDGE_LIMIT,
  ridgePull: 0,
  shorePull: 0,
  goingWeight: GOING_WEIGHT,
};

const TRAIL_PROFILE: Profile = {
  comfortGrade: 0.34,
  gradeLimit: 1.05,
  cliffSlope: 2.2,
  slopeWeight: 0.3,
  waterCost: Infinity,
  wetLimit: 0,
  ridgePull: 0,
  shorePull: 0,
  goingWeight: GOING_WEIGHT,
};

/** The sống lưng khủng long profile: a path that would rather climb than leave the spine. */
const RIDGE_PROFILE: Profile = { ...TRAIL_PROFILE, ridgePull: 0.42 };

/** The bờ hồ profile: a path that would rather go round than lose sight of the water. */
const SHORE_PROFILE: Profile = { ...TRAIL_PROFILE, shorePull: 0.5 };

/**
 * Cost of one move, or Infinity where the move cannot be made at all. The grade
 * term is what gives a road its character: it gives up distance to stay on a
 * contour, and when it has to gain height it doubles back rather than driving
 * straight up.
 */
const stepCost = (grid: Grid, node: number, next: number, run: number, profile: Profile): number => {
  if (grid.slope[next] > profile.cliffSlope) return Infinity;
  const grade = Math.abs(grid.height[next] - grid.height[node]) / run;
  if (grade > profile.gradeLimit) return Infinity;
  const wet = grid.water[next] === 1;
  if (wet && !Number.isFinite(profile.waterCost)) return Infinity;

  let cost = run * (1 + (grade / profile.comfortGrade) ** 2 * 1.5);
  cost *= 1 + Math.min(grid.slope[next], 1.3) * profile.slopeWeight;
  if (profile.goingWeight > 0) {
    const temper = 1 - Math.min(1, grid.slope[next] / GOING_SLOPE);
    if (temper > 0) cost *= 1 + profile.goingWeight * grid.going[next] * temper;
  }
  if (wet) cost += run * profile.waterCost;
  if (profile.shorePull > 0) cost *= 1 - profile.shorePull * grid.bank[next];
  if (profile.ridgePull > 0 && grid.relief > 0.01) {
    // Reward the crest. Without this the search drops off the spine at the first
    // opportunity, because contouring the flank is always cheaper than walking
    // the top of it.
    const crest = Math.min(1, grid.prominence[next] / grid.relief);
    cost *= 1 - profile.ridgePull * crest;
  }
  return cost;
};

type Route = { cells: number[]; cost: number; /** Metres walked along the route, not cost. */ length: number };

/** Walks `came` back to the start. Null if the chain does not actually get there. */
const traceBack = (came: Int32Array, start: number, goal: number): number[] | null => {
  const cells: number[] = [];
  let node = goal;
  while (node !== -1) {
    cells.push(node);
    if (node === start) break;
    node = came[node];
  }
  if (cells[cells.length - 1] !== start) return null;
  cells.reverse();
  return cells;
};

/** A* between two cells, used for everything that branches off something else. */
const findRoute = (
  grid: Grid,
  start: number,
  goal: number,
  blocked: Uint8Array | null,
  profile: Profile
): Route | null => {
  const total = grid.cols * grid.cols;
  // A caller with no trunk to branch from passes undefined here. Left unchecked
  // the index arithmetic below turns that into NaN, NaN passes every bounds test
  // (every comparison against it is false), and the search pushes for ever.
  const valid = (cell: number) => Number.isInteger(cell) && cell >= 0 && cell < total;
  if (!valid(start) || !valid(goal) || start === goal) return null;

  const best = new Float32Array(total).fill(Infinity);
  const wet = new Float32Array(total).fill(Infinity);
  const walk = new Float32Array(total);
  const came = new Int32Array(total).fill(-1);
  const settled = new Uint8Array(total);
  const heap = createHeap();

  const goalCol = goal % grid.cols;
  const goalRow = (goal - goalCol) / grid.cols;
  // The going field discounts as well as charges, so a metre can cost less than
  // a metre and the straight-line heuristic stops being a lower bound — an
  // overestimate makes A* greedy, and a greedy A* returns the straight road this
  // whole field exists to bend. Scaling by the cheapest metre the profile can
  // produce restores the bound. (`shorePull` and `ridgePull` discount too and
  // are not counted here; that predates the going field and is left alone.)
  const cheapestMetre = 1 - profile.goingWeight;
  const heuristic = (node: number) => {
    const col = node % grid.cols;
    const row = (node - col) / grid.cols;
    return Math.hypot(col - goalCol, row - goalRow) * grid.step * cheapestMetre;
  };

  best[start] = 0;
  wet[start] = 0;
  heap.push(start, heuristic(start));

  while (!heap.isEmpty()) {
    const node = heap.pop();
    if (settled[node]) continue;
    if (node === goal) break;
    settled[node] = 1;

    const col = node % grid.cols;
    const row = (node - col) / grid.cols;

    for (const move of MOVES) {
      const nextCol = col + move[0];
      const nextRow = row + move[1];
      // Stated positively on purpose: a NaN fails this, where it would slip
      // through the negation of the same test.
      if (!(nextCol >= 0 && nextRow >= 0 && nextCol < grid.cols && nextRow < grid.cols)) continue;
      const next = nextRow * grid.cols + nextCol;
      if (settled[next]) continue;
      if (blocked && blocked[next] === 1 && next !== goal) continue;

      const run = Math.hypot(move[0], move[1]) * grid.step;
      const cost = stepCost(grid, node, next, run, profile);
      if (!Number.isFinite(cost)) continue;

      const crossed = wet[node] + (grid.water[next] === 1 ? run : 0);
      if (crossed > profile.wetLimit) continue;

      const tentative = best[node] + cost;
      if (tentative >= best[next]) continue;
      best[next] = tentative;
      wet[next] = crossed;
      walk[next] = walk[node] + run;
      came[next] = node;
      heap.push(next, tentative + heuristic(next));
    }
  }

  const cells = traceBack(came, start, goal);
  return cells ? { cells, cost: best[goal], length: walk[goal] } : null;
};

/**
 * Everything the grid lets you reach from one cell, in one pass.
 *
 * The trunk used to be planned by aiming at the four map borders, and that is
 * why this module built nothing anywhere. The border of every recipe is sunk by
 * `edgeFalloff` to height zero so the clouds can finish the horizon — which puts
 * it below the water line at Hội An, Tràng An and Hồ Tây, so the gate scan
 * rejected all 368 candidates on all four sides and every leg came back null.
 * Flooding outward instead asks the terrain how far a road can go rather than
 * telling it where to end up.
 */
type Field = { start: number; best: Float32Array; wet: Float32Array; reach: Float32Array; came: Int32Array };

const floodFrom = (grid: Grid, start: number, blocked: Uint8Array | null, profile: Profile): Field | null => {
  const total = grid.cols * grid.cols;
  if (!Number.isInteger(start) || start < 0 || start >= total) return null;

  const best = new Float32Array(total).fill(Infinity);
  const wet = new Float32Array(total).fill(Infinity);
  const reach = new Float32Array(total);
  const came = new Int32Array(total).fill(-1);
  const settled = new Uint8Array(total);
  const heap = createHeap();

  best[start] = 0;
  wet[start] = 0;
  heap.push(start, 0);

  while (!heap.isEmpty()) {
    const node = heap.pop();
    if (settled[node]) continue;
    settled[node] = 1;

    const col = node % grid.cols;
    const row = (node - col) / grid.cols;

    for (const move of MOVES) {
      const nextCol = col + move[0];
      const nextRow = row + move[1];
      if (!(nextCol >= 0 && nextRow >= 0 && nextCol < grid.cols && nextRow < grid.cols)) continue;
      const next = nextRow * grid.cols + nextCol;
      if (settled[next]) continue;
      if (blocked && blocked[next] === 1) continue;

      const run = Math.hypot(move[0], move[1]) * grid.step;
      const cost = stepCost(grid, node, next, run, profile);
      if (!Number.isFinite(cost)) continue;

      const crossed = wet[node] + (grid.water[next] === 1 ? run : 0);
      if (crossed > profile.wetLimit) continue;

      const tentative = best[node] + cost;
      if (tentative >= best[next]) continue;
      best[next] = tentative;
      wet[next] = crossed;
      reach[next] = reach[node] + run;
      came[next] = node;
      heap.push(next, tentative);
    }
  }

  return { start, best, wet, reach, came };
};

/**
 * Douglas–Peucker over the cell path. The grid's staircase is an artefact of the
 * search, not a bend anyone surveyed, and feeding it straight to a spline makes
 * the road wobble between the knots.
 */
const simplify = (points: Vector3[], tolerance: number): Vector3[] => {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: number[] = [0, points.length - 1];

  while (stack.length > 0) {
    const to = stack.pop();
    const from = stack.pop();
    if (from === undefined || to === undefined || to - from < 2) continue;

    const a = points[from];
    const b = points[to];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const span = Math.hypot(dx, dz) || 1;

    let worst = -1;
    let worstIndex = from;
    for (let i = from + 1; i < to; i += 1) {
      const away = Math.abs((points[i].x - a.x) * dz - (points[i].z - a.z) * dx) / span;
      if (away > worst) {
        worst = away;
        worstIndex = i;
      }
    }

    if (worst <= tolerance) continue;
    keep[worstIndex] = 1;
    stack.push(from, worstIndex, worstIndex, to);
  }

  return points.filter((_, index) => keep[index] === 1);
};

// --- the centreline ----------------------------------------------------------

type Centreline = {
  count: number;
  length: number;
  /** x, y, z per sample, already lifted off the graded surface. */
  points: Float32Array;
  /** tx, tz per sample, unit length. */
  tangents: Float32Array;
  curvature: Float32Array;
  cumulative: Float32Array;
  /** Raw terrain height under each sample, for shoulders and piers. */
  ground: Float32Array;
  bridge: Uint8Array;
};

const smoothPass = (values: Float32Array, scratch: Float32Array, passes: number) => {
  const last = values.length - 1;
  for (let pass = 0; pass < passes; pass += 1) {
    for (let i = 0; i <= last; i += 1) {
      scratch[i] = values[Math.max(0, i - 1)] * 0.25 + values[i] * 0.5 + values[Math.min(last, i + 1)] * 0.25;
    }
    values.set(scratch);
  }
};

const buildCentreline = (
  terrain: Terrain,
  grid: Grid,
  cells: number[],
  waterLevel: number,
  lift: number,
  kind: RoadKind,
  tie: { x: number; z: number } | null
): Centreline | null => {
  const raw = cells.map((cell) => {
    const col = cell % grid.cols;
    const row = (cell - col) / grid.cols;
    return new Vector3(grid.origin + col * grid.step, 0, grid.origin + row * grid.step);
  });

  // Finer than the cell step, where it used to be most of one. The staircase is
  // an artefact and has to go, but a tolerance that size went through the real
  // wander with it — the going field's channels are a dozen metres wide. What
  // keeps the staircase off the spline now is the thinning and the radius cap
  // below, which bound it by wavelength and by curvature instead of by amplitude.
  const simplified = simplify(raw, grid.step * 0.4);
  if (simplified.length < 2) return null;

  // Nothing closer than `KNOT_APART`, which bounds the shortest wavelength the
  // route can carry and so the tightest bend the spline can produce. A trail is
  // left alone: a hairpin every forty metres is what a path up a pitch is.
  const knots: Vector3[] = [];
  if (kind === 'trail') {
    knots.push(...simplified);
  } else {
    const apart = grid.step * KNOT_APART;
    knots.push(simplified[0]);
    for (let i = 1; i < simplified.length - 1; i += 1) {
      const last = knots[knots.length - 1];
      if (Math.hypot(simplified[i].x - last.x, simplified[i].z - last.z) >= apart) knots.push(simplified[i]);
    }
    // The last knot is where the road was asked to arrive, so it is kept
    // whatever its spacing; the one before it goes if it is crowding it.
    const tail = simplified[simplified.length - 1];
    const last = knots[knots.length - 1];
    if (knots.length > 1 && Math.hypot(tail.x - last.x, tail.z - last.z) < apart * 0.5) knots.pop();
    knots.push(tail);
  }
  if (knots.length < 2) return null;

  // Onto the finished ribbon, not the planning cell it was surveyed from. The
  // fade is 1 at index 0, so the junction stays exactly where it is put here and
  // the easing below leaves it there.
  if (tie) {
    const shiftX = tie.x - knots[0].x;
    const shiftZ = tie.z - knots[0].z;
    let along = 0;
    for (let i = 0; i < knots.length - 1 && along < TIE_SPREAD; i += 1) {
      const fade = 1 - along / TIE_SPREAD;
      along += Math.hypot(knots[i + 1].x - knots[i].x, knots[i + 1].z - knots[i].z);
      knots[i].x += shiftX * fade;
      knots[i].z += shiftZ * fade;
    }
  }

  // Lay each bend to the design radius, and leave the rest of the road alone.
  //
  // This used to be three passes of a lateral three-tap average over every
  // knot, which is a low-pass filter: it rounded the hairpins it was aimed at,
  // and it also erased every bend under about two hundred metres of wavelength,
  // which is most of the bends there are. That is why the carriageway came out
  // straight. Pulling a knot toward the chord of its neighbours flattens its
  // triangle and so opens its circumradius, so weighting the pull by how far
  // that radius falls short of `EASE_RADIUS` converges on a road whose tightest
  // corner is the one its traffic was specified for, with everything gentler
  // than that untouched. Deterministic: no randomness, and the early exit is on
  // the geometry, not on a pass count.
  const target = EASE_RADIUS[kind];
  for (let pass = 0; pass < 40; pass += 1) {
    let worst = 0;
    for (let i = 1; i < knots.length - 1; i += 1) {
      const ax = knots[i].x - knots[i - 1].x;
      const az = knots[i].z - knots[i - 1].z;
      const bx = knots[i + 1].x - knots[i].x;
      const bz = knots[i + 1].z - knots[i].z;
      const chord = Math.hypot(knots[i + 1].x - knots[i - 1].x, knots[i + 1].z - knots[i - 1].z);
      const area = Math.abs(ax * bz - az * bx) / 2;
      // Circumradius of the three knots. Collinear knots have none, and need none.
      const bendRadius = area > 1e-6 ? (Math.hypot(ax, az) * Math.hypot(bx, bz) * chord) / (4 * area) : Infinity;
      const pull = Math.min(1, Math.max(0, 1 - bendRadius / target));
      if (pull <= 0.001) continue;
      if (pull > worst) worst = pull;
      knots[i].x += ((knots[i - 1].x + knots[i + 1].x) / 2 - knots[i].x) * pull * 0.5;
      knots[i].z += ((knots[i - 1].z + knots[i + 1].z) / 2 - knots[i].z) * pull * 0.5;
    }
    if (worst < 0.02) break;
  }

  // Centripetal, not uniform. The knots are deliberately unevenly spaced — that
  // is what Douglas-Peucker and the thinning above are for — and a uniformly
  // parameterised Catmull-Rom overshoots on exactly that input: it was putting
  // 9 to 14 m radii into main roads whose knots were nowhere near that tight.
  const curve = new CatmullRomCurve3(knots, false, 'centripetal');
  const length = curve.getLength();
  if (!Number.isFinite(length) || length < SPACING * 3) return null;

  const count = Math.max(4, Math.round(length / SPACING) + 1);
  const spaced = curve.getSpacedPoints(count - 1);

  const ground = new Float32Array(count);
  const desired = new Float32Array(count);
  const bridge = new Uint8Array(count);

  for (let i = 0; i < count; i += 1) {
    const y = terrain.heightAt(spaced[i].x, spaced[i].z);
    ground[i] = y;
    if (y < waterLevel + 0.4) {
      bridge[i] = 1;
      desired[i] = waterLevel + DECK_CLEARANCE;
    } else {
      desired[i] = y;
    }
  }

  // A road is graded, not draped. Sixteen passes of a three-tap average is the
  // cut and fill; without it the ribbon ripples over every bump in the noise.
  const graded = desired.slice();
  const scratch = new Float32Array(count);
  smoothPass(graded, scratch, 16);

  // It may not drop below the ground it crosses or it disappears into the hill,
  // so the profile becomes an upper envelope — and an envelope has corners, which
  // a few more light passes take back out.
  for (let i = 0; i < count; i += 1) graded[i] = Math.max(graded[i], desired[i]);
  for (let pass = 0; pass < 3; pass += 1) {
    smoothPass(graded, scratch, 1);
    for (let i = 0; i < count; i += 1) graded[i] = Math.max(graded[i], desired[i]);
  }

  // Embankments taller than this are not built, they are bridged. Pulling the
  // profile back down stops a smoothed road from sailing over every small dip.
  for (let i = 0; i < count; i += 1) {
    if (bridge[i] === 1) continue;
    const fill = graded[i] - desired[i];
    if (fill > 4) graded[i] = desired[i] + 4 + (fill - 4) * 0.25;
  }
  smoothPass(graded, scratch, 1);
  for (let i = 0; i < count; i += 1) graded[i] = Math.max(graded[i], desired[i]);

  const points = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    points[i * 3] = spaced[i].x;
    points[i * 3 + 1] = graded[i] + lift;
    points[i * 3 + 2] = spaced[i].z;
  }

  const cumulative = new Float32Array(count);
  for (let i = 1; i < count; i += 1) {
    cumulative[i] =
      cumulative[i - 1] +
      Math.hypot(
        points[i * 3] - points[(i - 1) * 3],
        points[i * 3 + 1] - points[(i - 1) * 3 + 1],
        points[i * 3 + 2] - points[(i - 1) * 3 + 2]
      );
  }

  const tangents = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    const back = Math.max(0, i - 1);
    const ahead = Math.min(count - 1, i + 1);
    const tx = points[ahead * 3] - points[back * 3];
    const tz = points[ahead * 3 + 2] - points[back * 3 + 2];
    const span = Math.hypot(tx, tz) || 1;
    tangents[i * 2] = tx / span;
    tangents[i * 2 + 1] = tz / span;
  }

  const curvature = new Float32Array(count);
  for (let i = 1; i < count - 1; i += 1) {
    const ax = tangents[(i - 1) * 2];
    const az = tangents[(i - 1) * 2 + 1];
    const bx = tangents[(i + 1) * 2];
    const bz = tangents[(i + 1) * 2 + 1];
    const turn = Math.asin(Math.max(-1, Math.min(1, ax * bz - az * bx)));
    const span = cumulative[i + 1] - cumulative[i - 1];
    curvature[i] = span > 0.01 ? turn / span : 0;
  }
  curvature[0] = curvature[1];
  curvature[count - 1] = curvature[count - 2];

  return { count, length: cumulative[count - 1], points, tangents, curvature, cumulative, ground, bridge };
};

// --- surface ribbons ---------------------------------------------------------

type Sink = { positions: number[]; uvs: number[]; cross: number[]; indices: number[] };

const createSink = (): Sink => ({ positions: [], uvs: [], cross: [], indices: [] });

const sinkToGeometry = (sink: Sink): BufferGeometry | null => {
  if (sink.indices.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(sink.positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(sink.uvs), 2));
  geometry.setAttribute('aCross', new BufferAttribute(new Float32Array(sink.cross), 1));
  geometry.setIndex(sink.indices);
  geometry.computeVertexNormals();
  return geometry;
};

/**
 * Three vertices across — kerb, crown, kerb. The crown is the camber, and it is
 * the only reason the two halves of a wet road catch the light differently.
 * `uv` carries metres along in y and 0..1 across in x, so the shader can lay
 * markings out in real dimensions.
 */
const addSurface = (
  sink: Sink,
  line: Centreline,
  width: number,
  camber: number,
  crossField: Float32Array,
  widths: Float32Array | null
) => {
  const base = sink.positions.length / 3;

  for (let i = 0; i < line.count; i += 1) {
    const half = (widths ? widths[i] : width) / 2;
    const x = line.points[i * 3];
    const y = line.points[i * 3 + 1];
    const z = line.points[i * 3 + 2];
    const rx = -line.tangents[i * 2 + 1];
    const rz = line.tangents[i * 2];
    const s = line.cumulative[i];

    sink.positions.push(x - rx * half, y, z - rz * half, x, y + camber, z, x + rx * half, y, z + rz * half);
    sink.uvs.push(0, s, 0.5, s, 1, s);
    sink.cross.push(crossField[i], crossField[i], crossField[i]);
  }

  for (let i = 0; i < line.count - 1; i += 1) {
    const a = base + i * 3;
    const b = a + 3;
    sink.indices.push(a, a + 1, b + 1, a, b + 1, b, a + 1, a + 2, b + 2, a + 1, b + 2, b + 1);
  }
};

/**
 * A second line of wear running beside the first. A trail walked for years is
 * not a polyline: someone stepped off to pass, and then everyone did. `rejoin`
 * false leaves it as a fork that stops where it stops, which is the stub out to
 * a viewpoint nobody bothered to finish.
 */
const addBraid = (
  sink: Sink,
  line: Centreline,
  from: number,
  to: number,
  side: number,
  reach: number,
  width: number,
  rejoin: boolean
) => {
  const span = to - from;
  if (span < 2) return;
  const base = sink.positions.length / 3;

  for (let i = from; i <= to; i += 1) {
    const u = (i - from) / span;
    const fade = rejoin ? Math.sin(Math.PI * u) : Math.min(1, u * 3);
    // Never quite zero: a degenerate strip gives computeVertexNormals nothing to
    // work with. The shader's edge mask is what actually merges it back in.
    const half = (width * (0.1 + 0.9 * fade)) / 2;
    const offset = side * reach * fade;
    const x = line.points[i * 3];
    const y = line.points[i * 3 + 1];
    const z = line.points[i * 3 + 2];
    const rx = -line.tangents[i * 2 + 1];
    const rz = line.tangents[i * 2];
    const s = line.cumulative[i];

    const cx = x + rx * offset;
    const cz = z + rz * offset;
    sink.positions.push(cx - rx * half, y, cz - rz * half, cx, y, cz, cx + rx * half, y, cz + rz * half);
    sink.uvs.push(0, s, 0.5, s, 1, s);
    sink.cross.push(40, 40, 40);
  }

  for (let i = 0; i < span; i += 1) {
    const a = base + i * 3;
    const b = a + 3;
    sink.indices.push(a, a + 1, b + 1, a, b + 1, b, a + 1, a + 2, b + 2, a + 1, b + 2, b + 1);
  }
};

/** The skirt from each kerb down into the ground, so the ribbon never floats. */
const addShoulders = (
  sink: Sink,
  terrain: Terrain,
  line: Centreline,
  width: number,
  spread: number,
  widths: Float32Array | null
) => {
  for (const side of [-1, 1]) {
    const base = sink.positions.length / 3;
    for (let i = 0; i < line.count; i += 1) {
      const half = (widths ? widths[i] : width) / 2;
      const x = line.points[i * 3];
      const y = line.points[i * 3 + 1];
      const z = line.points[i * 3 + 2];
      const rx = -line.tangents[i * 2 + 1] * side;
      const rz = line.tangents[i * 2] * side;
      const s = line.cumulative[i];

      const footX = x + rx * (half + spread);
      const footZ = z + rz * (half + spread);
      const footY = Math.min(terrain.heightAt(footX, footZ), y) - 0.5;

      sink.positions.push(x + rx * half, y, z + rz * half, footX, footY, footZ);
      sink.uvs.push(0, s, 1, s);
      sink.cross.push(40, 40);
    }

    for (let i = 0; i < line.count - 1; i += 1) {
      const a = base + i * 2;
      const b = a + 2;
      // Wound for the left skirt; the right one comes out inside-out, which the
      // double-sided verge material covers.
      sink.indices.push(a, a + 1, b + 1, a, b + 1, b);
    }
  }
};

/**
 * A closed box section swept along part of a centreline: bridge beams, parapets
 * and guard rails are all this shape at different sizes.
 */
const boxRibbon = (
  line: Centreline,
  from: number,
  to: number,
  offset: number,
  halfWidth: number,
  top: number,
  bottom: number
): BufferGeometry | null => {
  const count = to - from + 1;
  if (count < 2) return null;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = from; i <= to; i += 1) {
    const x = line.points[i * 3];
    const y = line.points[i * 3 + 1];
    const z = line.points[i * 3 + 2];
    const rx = -line.tangents[i * 2 + 1];
    const rz = line.tangents[i * 2];
    const inner = offset - halfWidth;
    const outer = offset + halfWidth;
    const s = line.cumulative[i];

    positions.push(
      x + rx * inner,
      y + top,
      z + rz * inner,
      x + rx * outer,
      y + top,
      z + rz * outer,
      x + rx * outer,
      y + bottom,
      z + rz * outer,
      x + rx * inner,
      y + bottom,
      z + rz * inner
    );
    uvs.push(0, s, 0.34, s, 0.67, s, 1, s);
  }

  for (let i = 0; i < count - 1; i += 1) {
    const a = i * 4;
    const b = a + 4;
    for (let face = 0; face < 4; face += 1) {
      const next = (face + 1) % 4;
      indices.push(a + face, a + next, b + next, a + face, b + next, b + face);
    }
  }
  indices.push(0, 2, 1, 0, 3, 2);
  const tail = (count - 1) * 4;
  indices.push(tail, tail + 1, tail + 2, tail, tail + 2, tail + 3);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

// --- walkable spans ----------------------------------------------------------

/**
 * Overhang carried past the two ends of a chain. Its own first and last points
 * sit exactly on the boundary of the end rectangles, where `|along| > halfLength`
 * compares a number against itself and the answer is whichever way the rounding
 * fell: the head of a Hội An trail that begins 0.72 m up on fill fell through its
 * own first plank that way.
 */
const CHAIN_END = 0.05;
/**
 * How far the real surface may wander off a rectangle's axis, and how far off its
 * straight grade, before the rectangle has to break and a new one start.
 *
 * `floorAt` scans every span linearly a dozen times a frame, so the count is the
 * cost, and a 7 m sample step over a line that is straight for four hundred
 * metres spends fifty spans saying the same thing. Merging what one rectangle can
 * honestly describe took Hồ Tây from 1704 spans at 6.22 µs a call to 307 at 0.42,
 * and Hội An from 1644 at 6.91 to 568 at 2.47. Tràng An gains least — 1607 to 824
 * — because karst leaves nothing straight, which is the honest answer there.
 *
 * Those four readings are the merge's own before-and-after and are left as they
 * were measured. What the shipped recipes produce today is more road than they
 * had then — the hamlets are joined up and Hồ Tây has a ring round the lake —
 * so the counts have grown back without the merge losing anything: 905 spans at
 * 3.84 µs at Hồ Tây, 683 at 2.93 at Hội An, 1818 at 6.31 at Tràng An and 1266
 * at 4.07 at Tà Xùa, which had 522 at 1.87 before its bản were served.
 *
 * The drift is given back as width rather than dropped, so a merged span is never
 * narrower than the surface it stands for: it is the hole in the deck that
 * matters, not a hand's breadth of floor beside it. The settle is a tenth of the
 * walker's `STEP_UP`, which is the error it could feel.
 */
const CHAIN_DRIFT = 0.18;
const CHAIN_SETTLE = 0.04;

/**
 * A polyline on a walking surface — a bridge deck, the top of a line of sleepers
 * — as the chain of rectangles the walker stands on. `points` is x, y, z triples
 * at the surface itself. One rectangle covers as many samples as it can hold
 * within `CHAIN_DRIFT` and `CHAIN_SETTLE`; a curve therefore still gets a
 * rectangle per sample, where a box over the whole run would hang out over the
 * water on the inside of the bend.
 *
 * The chain is expected to run past the point where the surface meets the ground
 * at both ends: `floorAt` takes the higher of ground and span, so an approach
 * that carries on into the embankment is found rather than stepped over, and
 * there is no seam at the abutment at all.
 */
export const deckChain = (points: number[], halfWidth: number, out: Platform[]) => {
  const count = Math.floor(points.length / 3);
  if (count < 2) return;

  /** The farthest any sample between `a` and `b` strays from one rectangle, or null. */
  const strayBetween = (a: number, b: number): number | null => {
    const dx = points[b * 3] - points[a * 3];
    const dz = points[b * 3 + 2] - points[a * 3 + 2];
    const run = Math.hypot(dx, dz);
    if (run < 1e-4) return null;
    const axisX = dx / run;
    const axisZ = dz / run;
    const grade = (points[b * 3 + 1] - points[a * 3 + 1]) / run;
    let stray = 0;
    for (let k = a + 1; k < b; k += 1) {
      const kx = points[k * 3] - points[a * 3];
      const kz = points[k * 3 + 2] - points[a * 3 + 2];
      const across = Math.abs(kx * axisZ - kz * axisX);
      if (across > CHAIN_DRIFT) return null;
      if (Math.abs(points[k * 3 + 1] - points[a * 3 + 1] - grade * (kx * axisX + kz * axisZ)) > CHAIN_SETTLE) {
        return null;
      }
      if (across > stray) stray = across;
    }
    return stray;
  };

  // The sample each rectangle starts at, found greedily: the longest reach that
  // still holds is taken before the next one begins.
  const joints = [0];
  const strays: number[] = [];
  while (joints[joints.length - 1] < count - 1) {
    const from = joints[joints.length - 1];
    let to = from + 1;
    let stray = 0;
    while (to + 1 < count) {
      const reach = strayBetween(from, to + 1);
      if (reach === null) break;
      stray = reach;
      to += 1;
    }
    joints.push(to);
    strays.push(stray);
  }

  const spans = joints.length - 1;
  const axis = new Float64Array(spans * 2);
  const runs = new Float64Array(spans);
  for (let s = 0; s < spans; s += 1) {
    const dx = points[joints[s + 1] * 3] - points[joints[s] * 3];
    const dz = points[joints[s + 1] * 3 + 2] - points[joints[s] * 3 + 2];
    const run = Math.hypot(dx, dz);
    runs[s] = run;
    axis[s * 2] = run > 1e-4 ? dx / run : 0;
    axis[s * 2 + 1] = run > 1e-4 ? dz / run : 1;
  }

  // Two rectangles meeting at an angle leave a wedge open on the outside of the
  // turn, `halfWidth * sin(turn / 2)` deep, and the ground showing through that
  // wedge is a hole in the deck. For unit axes `|u(a) - u(b)|` is
  // `2 sin(turn / 2)`, which is the quantity wanted without unwrapping angles.
  const openedBy = (a: number, b: number): number =>
    Math.hypot(axis[a * 2] - axis[b * 2], axis[a * 2 + 1] - axis[b * 2 + 1]) / 2;

  for (let s = 0; s < spans; s += 1) {
    const run = runs[s];
    if (run < 1e-3) continue;
    const a = joints[s];
    const b = joints[s + 1];
    const low = points[a * 3 + 1];
    const high = points[b * 3 + 1];
    // Overlapping the neighbour rather than butting onto it only ever reads a
    // surface the neighbour was carrying anyway: both spans continue the same
    // graded profile, so the pair differ by a second difference of it.
    const pad =
      halfWidth * Math.max(s > 0 ? openedBy(s, s - 1) : 0, s < spans - 1 ? openedBy(s, s + 1) : 0) +
      (s === 0 || s === spans - 1 ? CHAIN_END : 0);
    out.push({
      x: (points[a * 3] + points[b * 3]) / 2,
      z: (points[a * 3 + 2] + points[b * 3 + 2]) / 2,
      yaw: Math.atan2(axis[s * 2], axis[s * 2 + 1]),
      halfWidth: halfWidth + strays[s],
      halfLength: run / 2 + pad,
      surfaceY: (low + high) / 2,
      grade: (high - low) / run,
    });
  }
};

// --- the surface shader ------------------------------------------------------

type Look = 'asphalt' | 'dirt' | 'trail' | 'verge';
type Markings = 'none' | 'dashed' | 'double-yellow';

const glsl3 = (color: Color, scale = 1) =>
  `vec3(${(color.r * scale).toFixed(4)}, ${(color.g * scale).toFixed(4)}, ${(color.b * scale).toFixed(4)})`;

const SURFACE_HELPERS = /* glsl */ `
  varying vec2 vRoad;
  varying float vCross;
  uniform float uRoadNight;

  float roadHash(vec2 p) {
    return fract(sin(dot(p, vec2(41.37, 289.13))) * 43758.5453);
  }

  float roadNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = roadHash(cell);
    float b = roadHash(cell + vec2(1.0, 0.0));
    float c = roadHash(cell + vec2(0.0, 1.0));
    float d = roadHash(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  /** 1 inside a stripe of the given half-width, falling off over its outer 45%. */
  float roadBand(float value, float centre, float halfWidth) {
    return 1.0 - smoothstep(halfWidth * 0.55, halfWidth, abs(value - centre));
  }
`;

/**
 * Asphalt, dirt and verge in one injected fragment. Everything is laid out in
 * metres off the ribbon's own `uv`, so a dashed line is three metres of paint
 * and six of gap whatever the road is doing, and the crossing attribute is the
 * signed distance to the nearest zebra — which is what lets the stop bars sit a
 * fixed set-back from it without a second mesh.
 */
const surfaceBody = (
  look: Look,
  markings: Markings,
  width: number,
  soil: Color,
  rock: Color,
  foliage: Color
): string => {
  if (look === 'trail') {
    // Across is normalised, not metric: a trail's width changes every sample, so
    // the ribbon's own 0..1 is the only thing that still means "the edge".
    return /* glsl */ `
      float roadAcross = (vRoad.x - 0.5) * 2.0;
      float roadAlong = vRoad.y;
      float earth = roadNoise(vec2(roadAcross * 0.9, roadAlong * 0.22));
      float grit = roadHash(floor(vec2(roadAcross * 5.0, roadAlong * 9.0)));
      vec3 roadSurface = mix(${glsl3(soil, 0.72)}, ${glsl3(rock, 0.98)}, earth);

      // The tread is where feet actually fall, and it is not the middle of the
      // measured width — it wanders from one side to the other.
      float wander = (roadNoise(vec2(7.3, roadAlong * 0.09)) - 0.5) * 0.9;
      float tread = 1.0 - smoothstep(0.0, 0.7, abs(roadAcross - wander));
      roadSurface *= 1.0 - tread * 0.2;
      roadSurface *= 0.86 + grit * 0.26;

      // Damp and mossy at the margins, where nothing treads.
      roadSurface = mix(roadSurface, ${glsl3(foliage, 0.62)}, smoothstep(0.5, 0.98, abs(roadAcross)) * 0.62);

      // Grass closes in from both sides at its own pace. Alpha-tested rather
      // than blended, so the edge is irregular without costing a sort.
      float encroach =
        roadNoise(vec2(roadAlong * 0.5, 13.0)) * 0.3 + roadNoise(vec2(roadAlong * 1.9, 31.0)) * 0.17;
      diffuseColor.a *= 1.0 - smoothstep(0.74 - encroach, 1.02 - encroach, abs(roadAcross));

      vec3 roadPaintColor = roadSurface;
      float roadPaint = 0.0;
    `;
  }

  if (look === 'verge') {
    return /* glsl */ `
      float vergeDepth = vRoad.x;
      float coarse = roadNoise(vec2(vergeDepth * 2.1, vRoad.y * 0.12));
      float fine = roadHash(floor(vec2(vergeDepth * 7.0, vRoad.y * 3.5)));
      vec3 roadSurface = mix(${glsl3(soil, 0.62)}, ${glsl3(rock, 0.86)}, coarse);
      roadSurface *= 0.88 + fine * 0.22;
      // Darker toward the toe of the slope: shadow plus whatever the rain washed
      // down, and it is what makes the skirt read as a bank instead of a wall.
      roadSurface *= mix(1.04, 0.66, vergeDepth);
      vec3 roadPaintColor = roadSurface;
      float roadPaint = 0.0;
    `;
  }

  if (look === 'dirt') {
    return /* glsl */ `
      float roadAcross = (vRoad.x - 0.5) * ${width.toFixed(3)};
      float roadAlong = vRoad.y;
      float mottle = roadNoise(vec2(roadAcross * 0.42, roadAlong * 0.11));
      float fine = roadHash(floor(vec2(roadAcross, roadAlong) * 6.5));
      vec3 roadSurface = mix(${glsl3(soil, 0.78)}, ${glsl3(rock, 1.08)}, mottle);
      // Two ruts with a crown between them, which is the whole silhouette of a
      // lane that only carts and bikes use.
      float rut = roadBand(abs(abs(roadAcross) - ${(width * 0.27).toFixed(3)}), 0.0, 0.46);
      roadSurface *= 1.0 - rut * 0.3;
      float crown = 1.0 - smoothstep(0.0, 0.34, abs(roadAcross));
      roadSurface = mix(roadSurface, ${glsl3(soil, 0.5)}, crown * 0.5 * mottle);
      roadSurface *= 0.9 + fine * 0.2;
      vec3 roadPaintColor = roadSurface;
      float roadPaint = 0.0;
    `;
  }

  const half = width * 0.5;
  const laneCentre = width * 0.25;
  const inner = half - 0.34;

  const centre =
    markings === 'double-yellow'
      ? /* glsl */ `float roadYellow = roadBand(abs(roadAcross), 0.115, 0.055);`
      : markings === 'dashed'
        ? /* glsl */ `
      float roadYellow = 0.0;
      // Three metres of paint, six of gap.
      roadWhite += roadBand(abs(roadAcross), 0.0, 0.075) * step(fract(roadAlong * 0.11111), 0.3334);`
        : /* glsl */ `float roadYellow = 0.0;`;

  return /* glsl */ `
    float roadAcross = (vRoad.x - 0.5) * ${width.toFixed(3)};
    float roadAlong = vRoad.y;

    float mottle = roadNoise(vec2(roadAcross * 0.11, roadAlong * 0.034));
    float repair = roadNoise(vec2(roadAcross * 0.34, roadAlong * 0.085));
    float grain = roadHash(floor(vec2(roadAcross, roadAlong) * 2.7));
    vec3 roadSurface = mix(vec3(0.0740, 0.0760, 0.0820), vec3(0.1500, 0.1480, 0.1450), mottle);
    // Patches where the surface has been cut open and laid again, which is most
    // of what stops asphalt reading as a flat grey plane.
    roadSurface = mix(roadSurface, vec3(0.1960, 0.1900, 0.1820), smoothstep(0.7, 0.94, repair) * 0.55);
    roadSurface *= 0.92 + grain * 0.17;

    // Polished wheel paths either side of each lane centre.
    float wheel = roadBand(abs(abs(roadAcross) - ${laneCentre.toFixed(3)}), 0.84, 0.36);
    roadSurface *= 1.0 - wheel * 0.14;

    float roadWhite = roadBand(abs(roadAcross), ${(half - 0.4).toFixed(3)}, 0.085);
    ${centre}

    // Pedestrian crossing. The stripes run with the traffic, repeating across the
    // road, and inside the band nothing else is painted.
    float inZebra = 1.0 - step(${CROSSING_HALF.toFixed(2)}, abs(vCross));
    float zebra = step(fract(roadAcross + 0.5), 0.52) * step(abs(roadAcross), ${inner.toFixed(3)});
    roadWhite = mix(roadWhite, zebra, inZebra);
    roadYellow *= 1.0 - inZebra;

    // One stop bar per direction, set back from the zebra. Traffic running with
    // the road keeps right, so its bar is on the right half.
    float barAt = ${(CROSSING_HALF + 1.4).toFixed(2)};
    roadWhite += roadBand(vCross, -barAt, 0.22) * step(0.07, roadAcross) * step(roadAcross, ${inner.toFixed(3)});
    roadWhite += roadBand(vCross, barAt, 0.22) * step(roadAcross, -0.07) * step(${(-inner).toFixed(3)}, roadAcross);

    float roadPaint = clamp(roadWhite + roadYellow, 0.0, 1.0);
    // Paint wears. A perfect decal is the thing that gives a render away.
    roadPaint *= 0.66 + 0.34 * roadNoise(vec2(roadAcross * 1.3, roadAlong * 0.5));
    vec3 roadPaintColor = mix(vec3(0.78, 0.78, 0.75), vec3(0.86, 0.55, 0.05), step(roadWhite + 0.001, roadYellow));
  `;
};

type Surface = { material: MeshStandardMaterial; night: { value: number } };

const createSurfaceMaterial = (
  look: Look,
  markings: Markings,
  width: number,
  soil: Color,
  rock: Color,
  foliage: Color
): Surface => {
  const night = { value: 0 };
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: look === 'asphalt' ? 0.88 : 0.96,
    metalness: 0,
    // Only a trail writes alpha, and it needs the chunk compiled in to do it.
    alphaTest: look === 'trail' ? 0.45 : 0,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRoadNight = night;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aCross;
         varying vec2 vRoad;
         varying float vCross;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vRoad = uv;
         vCross = aCross;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SURFACE_HELPERS}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         ${surfaceBody(look, markings, width, soil, rock, foliage)}
         // Multiplied, not assigned. There is no map and no vertex colour on this
         // material, so diffuseColor.rgb is vec3(1.0) here and the two are the same
         // dry — but anything else patched in ahead of this line writes into
         // diffuseColor too, and assigning threw the rain's wet darkening away.
         diffuseColor.rgb *= mix(roadSurface, roadPaintColor, roadPaint);`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = mix(roughnessFactor, 0.5, roadPaint);`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         // Road paint is retroreflective, and after dark it is the brightest thing
         // on the road. Nothing here casts a headlight beam, so the paint carries
         // its own faint glow instead.
         totalEmissiveRadiance += roadPaintColor * roadPaint * uRoadNight * 0.16;`
      );
  };

  // Three's default key is `onBeforeCompile.toString()`, and that source text is
  // the same for every surface this factory makes — `main`, `secondary` and
  // `lane` differ only in captured arguments. All three were being handed
  // whichever program compiled first, so a dirt lane came out as asphalt with a
  // centre line painted down it. `trail` and the verge escaped only by accident,
  // through alphaTest and side landing in three's key on their own.
  material.customProgramCacheKey = () => `road:${look}:${markings}:${width.toFixed(2)}`;

  return { material, night };
};

// --- routing plan ------------------------------------------------------------

/**
 * Nearest cell to a point that a road could actually start from. Tràng An picks
 * its hub from the POIs, the most central of which is a karst tower standing in
 * the lake: the cell has slope 2.5, every neighbour is either cliff or water,
 * and the search could not take one step out of it. A hub has to be somewhere
 * buildable or the whole network is planned from a place nothing can leave.
 */
const snapToBuildable = (grid: Grid, x: number, z: number, reach: number): { x: number; z: number } => {
  const start = cellOf(grid, x, z);
  if (grid.water[start] === 0 && grid.slope[start] < 0.5) return { x, z };

  let best = -1;
  let bestScore = Infinity;
  const total = grid.cols * grid.cols;
  for (let cell = 0; cell < total; cell += 1) {
    if (grid.water[cell] === 1 || grid.slope[cell] > 0.55) continue;
    const col = cell % grid.cols;
    const row = (cell - col) / grid.cols;
    if (col < 2 || row < 2 || col >= grid.cols - 2 || row >= grid.cols - 2) continue;
    const away = Math.hypot(cellX(grid, cell) - x, cellZ(grid, cell) - z);
    if (away > reach) continue;

    // A flat cell with cliffs on all four sides is a bench, not a hub: the
    // search can be planted there and still not take a single step out of it.
    let company = 0;
    for (let dr = -2; dr <= 2; dr += 1) {
      for (let dc = -2; dc <= 2; dc += 1) {
        const near = (row + dr) * grid.cols + col + dc;
        if (grid.water[near] === 0 && grid.slope[near] < CLIFF_SLOPE) company += 1;
      }
    }

    // Metres away, plus penalties in metres for tilt and for isolation.
    const score = away + grid.slope[cell] * 300 + (25 - company) * 90;
    if (score < bestScore) {
      bestScore = score;
      best = cell;
    }
  }
  return best >= 0 ? { x: cellX(grid, best), z: cellZ(grid, best) } : { x, z };
};

/** Densest cluster of houses, else the named town, else whatever is most central. */
const findHub = (
  terrain: Terrain,
  grid: Grid,
  buildings: readonly Standing[],
  pois: ResolvedPoi[]
): { x: number; z: number } => {
  if (buildings.length > 0) {
    let best = buildings[0];
    let bestCount = -1;
    for (const candidate of buildings) {
      let near = 0;
      for (const other of buildings) {
        if (Math.hypot(candidate.x - other.x, candidate.z - other.z) < 180) near += 1;
      }
      if (near > bestCount) {
        bestCount = near;
        best = candidate;
      }
    }
    return snapToBuildable(grid, best.x, best.z, terrain.size * 0.2);
  }

  const town = pois.find((poi) => poi.kind === 'town');
  if (town) return snapToBuildable(grid, town.x, town.z, terrain.size * 0.2);

  let closest: ResolvedPoi | null = null;
  for (const poi of pois) {
    if (!closest || Math.hypot(poi.x, poi.z) < Math.hypot(closest.x, closest.z)) closest = poi;
  }
  if (closest) return snapToBuildable(grid, closest.x, closest.z, terrain.size * 0.3);

  // Nothing named anywhere: the flattest cell in the middle of the map.
  let bestCell = cellOf(grid, 0, 0);
  let bestSlope = Infinity;
  const margin = Math.floor(grid.cols * 0.3);
  for (let row = margin; row < grid.cols - margin; row += 1) {
    for (let col = margin; col < grid.cols - margin; col += 1) {
      const index = row * grid.cols + col;
      if (grid.water[index] === 1) continue;
      if (grid.slope[index] < bestSlope) {
        bestSlope = grid.slope[index];
        bestCell = index;
      }
    }
  }
  const col = bestCell % grid.cols;
  return { x: grid.origin + col * grid.step, z: grid.origin + ((bestCell - col) / grid.cols) * grid.step };
};

const cellX = (grid: Grid, cell: number) => grid.origin + (cell % grid.cols) * grid.step;
const cellZ = (grid: Grid, cell: number) => grid.origin + Math.floor(cell / grid.cols) * grid.step;

/** Compass sectors the trunk's two ends are chosen from. */
const SECTORS = 8;

/**
 * The two ends of the trunk: the farthest the terrain lets a road get from the
 * hub, in two directions at least 135° apart. Cost per straight-line metre
 * throws away a cell that is only reachable by an absurd detour, so the trunk
 * runs along a shore rather than doubling back round a headland to touch it.
 */
const trunkEnds = (grid: Grid, field: Field, hubX: number, hubZ: number): [number, number] | null => {
  const cell = new Int32Array(SECTORS).fill(-1);
  const radius = new Float32Array(SECTORS);
  const total = grid.cols * grid.cols;

  for (let index = 0; index < total; index += 1) {
    if (!Number.isFinite(field.best[index])) continue;
    // The farthest cell a road can reach is routinely out in the water, because
    // the search is allowed to bridge up to `BRIDGE_LIMIT` to get anywhere. A
    // trunk may cross a river; it may not stop in one. Unchecked, the Hội An
    // highway ended 308 m out in the lake at the map corner, standing 27.8 m
    // over the bed on piers, and Hồ Tây did the same at both corners: a bridge
    // with land at one end only, which is a road there is no way to walk onto.
    // A cell with wet neighbours all round is the same thing one cell wide, so
    // an end on a one-cell islet is refused with it.
    if (grid.water[index] === 1 || grid.bank[index] > 0.75) continue;
    const away = Math.hypot(cellX(grid, index) - hubX, cellZ(grid, index) - hubZ);
    if (away < grid.step * 3) continue;
    if (field.best[index] / away > 14) continue;
    // Twice the straight line is already a road working round something. Past
    // that it is doubling back, and a trunk that doubles back is not a trunk.
    if (field.reach[index] / away > 1.6) continue;

    const turn = Math.atan2(cellZ(grid, index) - hubZ, cellX(grid, index) - hubX);
    const sector = Math.min(SECTORS - 1, Math.floor(((((turn / (Math.PI * 2)) % 1) + 1) % 1) * SECTORS));
    if (away > radius[sector]) {
      radius[sector] = away;
      cell[sector] = index;
    }
  }

  let pair: [number, number] | null = null;
  let reach = -1;
  for (let a = 0; a < SECTORS; a += 1) {
    if (cell[a] < 0) continue;
    for (let b = a + 1; b < SECTORS; b += 1) {
      if (cell[b] < 0) continue;
      const apart = Math.min(b - a, SECTORS - (b - a));
      if (apart < 3) continue;
      if (radius[a] + radius[b] > reach) {
        reach = radius[a] + radius[b];
        pair = [cell[a], cell[b]];
      }
    }
  }

  // Nothing opposite anything: take the single farthest end and let the trunk be
  // a dead-end road, which on a peninsula is what it really is.
  if (!pair) {
    let best = -1;
    let bestRadius = 0;
    for (let a = 0; a < SECTORS; a += 1) {
      if (cell[a] >= 0 && radius[a] > bestRadius) {
        bestRadius = radius[a];
        best = cell[a];
      }
    }
    return best >= 0 ? [best, best] : null;
  }
  return pair;
};

/**
 * The crest worth walking out to from here. The sống lưng khủng long is not a
 * route between two places — it is a spine you walk out along and come back the
 * way you came — so the ridge trail aims at the most prominent high ground a
 * sensible walk away rather than at another POI on the far side of the range.
 */
const crestTarget = (grid: Grid, from: number, minAway: number, maxAway: number): number => {
  const x = cellX(grid, from);
  const z = cellZ(grid, from);
  let best = -1;
  let bestScore = -Infinity;
  const total = grid.cols * grid.cols;

  for (let cell = 0; cell < total; cell += 1) {
    if (grid.water[cell] === 1 || grid.slope[cell] > TRAIL_PROFILE.cliffSlope) continue;
    const away = Math.hypot(cellX(grid, cell) - x, cellZ(grid, cell) - z);
    if (away < minAway || away > maxAway) continue;
    const score = grid.prominence[cell] + grid.height[cell] * 0.25;
    if (score > bestScore) {
      bestScore = score;
      best = cell;
    }
  }
  return best;
};

/**
 * Dry ground at the waterline a sensible walk away — where a bờ hồ path ends up.
 * Cells with almost all their neighbours wet are spits and sandbars, which is
 * not where anyone walks, so the band is deliberately narrow.
 */
const shoreTarget = (grid: Grid, from: number, minAway: number, maxAway: number): number => {
  const x = cellX(grid, from);
  const z = cellZ(grid, from);
  let best = -1;
  let bestScore = -Infinity;
  const total = grid.cols * grid.cols;

  for (let cell = 0; cell < total; cell += 1) {
    if (grid.water[cell] === 1 || grid.slope[cell] > TRAIL_PROFILE.cliffSlope) continue;
    if (grid.bank[cell] < 0.2 || grid.bank[cell] > 0.75) continue;
    const away = Math.hypot(cellX(grid, cell) - x, cellZ(grid, cell) - z);
    if (away < minAway || away > maxAway) continue;
    const score = grid.bank[cell] * 2 + away / maxAway;
    if (score > bestScore) {
      bestScore = score;
      best = cell;
    }
  }
  return best;
};

/** The cell of `cells` nearest a point, which is where a road crew would have branched. */
const nearestCell = (grid: Grid, cells: number[], x: number, z: number): { cell: number; away: number } => {
  let cell = cells[0];
  let away = Infinity;
  for (const candidate of cells) {
    const distance = Math.hypot(cellX(grid, candidate) - x, cellZ(grid, candidate) - z);
    if (distance < away) {
      away = distance;
      cell = candidate;
    }
  }
  return { cell, away };
};

// --- the module ---------------------------------------------------------------

type Built = { road: Road; line: Centreline; widths: Float32Array | null };

/**
 * Per-sample worn width for a trail. It is wider where the ground is soft and
 * pinches where it is hard; the random walk is what stops the two edges reading
 * as a pair of parallel lines, which is the whole difference between a path and
 * a very narrow road.
 */
const trailWidths = (count: number, random: () => number): Float32Array => {
  const widths = new Float32Array(count);
  let drift = 0;
  for (let i = 0; i < count; i += 1) {
    drift = Math.max(-1, Math.min(1, drift + (random() - 0.5) * 0.52));
    const slow = Math.sin(i * 0.23 + drift * 2) * 0.32;
    const t = Math.min(1, Math.max(0, 0.5 + drift * 0.42 + slow * 0.4));
    widths[i] = TRAIL_MIN_WIDTH + (TRAIL_MAX_WIDTH - TRAIL_MIN_WIDTH) * t;
  }
  // Both ends taper into the ground instead of stopping at a square edge.
  widths[0] *= 0.55;
  if (count > 1) widths[count - 1] *= 0.55;
  return widths;
};

export const createRoadNetwork = (
  terrain: Terrain,
  recipe: LocationRecipe,
  pois: ResolvedPoi[],
  buildings: readonly Standing[],
  /**
   * Where a visitor arrives, so one row of parked machines is laid beside it.
   *
   * Measured before this existed: the walk from the spawn to the nearest bike
   * was 174 m at Hội An and **854 m at Tà Xùa**, which is a ridge with two rows
   * over eight square kilometres. A ride you have to hike to is a ride most
   * people never take.
   */
  arrival?: { x: number; z: number }
): RoadNetwork => {
  const random = createPrng(`${recipe.seed}:roads`);
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const grid = buildGrid(terrain, waterLevel, recipe.seed);
  const hub = findHub(terrain, grid, buildings, pois);
  const hubCell = cellOf(grid, hub.x, hub.z);

  const group = new Group();
  group.name = 'roads';

  // --- plan the roads -------------------------------------------------------
  const field = floodFrom(grid, hubCell, null, ROAD_PROFILE);
  const ends = field ? trunkEnds(grid, field, hub.x, hub.z) : null;

  const mainCells: number[] = [];
  let trunkKind: RoadKind = 'main';
  if (field && ends) {
    const outbound = traceBack(field.came, hubCell, ends[0]);
    const inbound = ends[1] === ends[0] ? null : traceBack(field.came, hubCell, ends[1]);
    if (outbound) {
      for (let i = outbound.length - 1; i >= 0; i -= 1) mainCells.push(outbound[i]);
    }
    if (inbound) {
      for (let i = outbound ? 1 : 0; i < inbound.length; i += 1) mainCells.push(inbound[i]);
    }

    let outreach = 0;
    for (const cell of mainCells) {
      outreach = Math.max(outreach, Math.hypot(cellX(grid, cell) - hub.x, cellZ(grid, cell) - hub.z));
    }
    // What the trunk turns out to be depends on how far it got. Crossing a good
    // part of the map makes it a highway; a few hundred metres off a boat
    // landing in Tràng An is a dirt approach, and that is the honest answer
    // there. On the Tà Xùa ridge nothing drivable reaches even that far, and the
    // honest answer is no paved road at all — only đường mòn.
    if (outreach < terrain.size * 0.16) trunkKind = 'lane';
    if (mainCells.length < 6 || outreach < terrain.size * 0.07) mainCells.length = 0;
  }

  // Secondaries branch off the trunk rather than running beside it, so the trunk
  // is blocked for their search and only the junction cell is left open.
  const trunk = new Uint8Array(grid.cols * grid.cols);
  for (const cell of mainCells) trunk[cell] = 1;

  const spurs: { cells: number[]; kind: RoadKind }[] = [];

  /**
   * Đường vòng quanh hồ: the trunk's two ends joined back up round the far side.
   *
   * `trunkEnds` picks two cells at least 135° apart and `traceBack` draws one
   * route between them, so the carriageway a destination gets is always a line.
   * Round a lake that is the wrong shape — at Hồ Tây the trunk came out hugging
   * the north and east shore from the north-west corner to the south-east, and
   * the whole south-western shore had a dirt lane and a đường mòn and no way to
   * drive it. The real Hồ Tây has road all the way round; so does every lake
   * anybody lives beside.
   *
   * Gated on the basin because a ring is a statement about a closed body of
   * water. The admission is the one test that matters: the leg has to actually
   * go round, measured as its furthest departure from the trunk it is closing,
   * against the radius of the thing it is going round. A route that merely runs
   * beside the trunk for four kilometres is a second carriageway, not a ring.
   *
   * `secondary`, never `main`, for the reason the far-bank trunk was: there is
   * one highway per destination and `race-route` lays the race on the longest
   * sealed road.
   */
  const basin = recipe.terrain.basin;
  if (basin && mainCells.length >= 6) {
    const head = mainCells[0];
    const tail = mainCells[mainCells.length - 1];
    const open = trunk.slice();
    open[head] = 0;
    open[tail] = 0;
    const ring = findRoute(grid, head, tail, open, ROAD_PROFILE);
    if (ring) {
      let swing = 0;
      for (const cell of ring.cells) {
        swing = Math.max(swing, nearestCell(grid, mainCells, cellX(grid, cell), cellZ(grid, cell)).away);
      }
      if (swing > basin.radius * 0.8) {
        spurs.push({ cells: ring.cells, kind: 'secondary' });
        for (const cell of ring.cells) trunk[cell] = 1;
      }
    }
  }

  // No trunk means a spur has nothing to branch from; the POIs get trails instead.
  const named =
    mainCells.length > 0 ? pois.filter((poi) => Math.hypot(poi.x - hub.x, poi.z - hub.z) > 220).slice(0, 3) : [];

  const branchTo = (x: number, z: number, kind: RoadKind) => {
    const target = cellOf(grid, x, z);
    if (trunk[target] === 1) return;
    const junction = nearestCell(grid, mainCells, x, z);
    // A destination one cell off the trunk already has a road; branching to it
    // produces a forty-metre stub nobody would survey.
    if (junction.away < MIN_LENGTH[kind]) return;
    const open = trunk.slice();
    open[junction.cell] = 0;
    const route = findRoute(grid, junction.cell, target, open, ROAD_PROFILE);
    if (!route) return;
    // A route that costs forty times the straight line is a road nobody built:
    // an island reached by a two-kilometre causeway, most often.
    if (route.cost > Math.max(600, junction.away * 40)) return;
    if (route.length > junction.away * 2.6) return;
    spurs.push({ cells: route.cells, kind });
    for (const cell of route.cells) trunk[cell] = 1;
  };

  for (const poi of named) {
    branchTo(poi.x, poi.z, poi.kind === 'grove' || spurs.length >= 2 ? 'lane' : 'secondary');
  }

  // Dirt lanes out to the far edges of the village, where the carts go. Bearings
  // are bucketed first, so two lanes never leave in the same direction.
  if (buildings.length > 0 && mainCells.length > 0) {
    const edges = Array.from({ length: 6 }, () => ({ x: 0, z: 0, away: -1 }));
    for (const building of buildings) {
      const away = Math.hypot(building.x - hub.x, building.z - hub.z);
      if (away > terrain.size * 0.42) continue;
      const turn = Math.atan2(building.z - hub.z, building.x - hub.x);
      const sector = Math.min(5, Math.floor(((((turn / (Math.PI * 2)) % 1) + 1) % 1) * 6));
      if (away > edges[sector].away) edges[sector] = { x: building.x, z: building.z, away };
    }
    edges.sort((a, b) => b.away - a.away);
    for (const outlier of edges.slice(0, 3)) {
      if (outlier.away > 260) branchTo(outlier.x, outlier.z, 'lane');
    }
  }

  // --- the other hamlets ----------------------------------------------------
  const hamlets = settlements(buildings);

  /**
   * A lane out to a hamlet, from the nearest thing already surveyed.
   *
   * Separate from `branchTo` for two reasons. It leaves from a pool that grows
   * as lanes are laid, so the track to the third bản can leave the track to the
   * second instead of running all the way back to the highway — which is what a
   * valley of hamlets actually looks like, and what the comb of lanes all
   * touching the trunk does not. And it admits a longer road: `branchTo`'s 2.6
   * times the straight line is the right test for a spur out to a viewpoint,
   * which nobody would build if it had to work round a shoulder twice, and the
   * wrong one for the only way in and out of somewhere people live. The cost
   * ceiling is what still refuses a track that would have to be benched up a
   * mountainside for a kilometre.
   */
  const laneTo = (place: Settlement, pool: number[]): boolean => {
    const target = cellOf(grid, place.x, place.z);
    if (trunk[target] === 1 || pool.length === 0) return true;
    const junction = nearestCell(grid, pool, place.x, place.z);
    // Already as good as on it: a hamlet a hundred metres off the carriageway
    // does not need its own road, it needs the verge it already has.
    if (junction.away < MIN_LENGTH.lane) return true;
    const open = trunk.slice();
    open[junction.cell] = 0;
    const route = findRoute(grid, junction.cell, target, open, ROAD_PROFILE);
    if (!route) return false;
    if (route.cost > Math.max(1200, junction.away * 90)) return false;
    if (route.length > Math.max(400, junction.away * 3.6)) return false;
    spurs.push({ cells: route.cells, kind: 'lane' });
    for (const cell of route.cells) {
      trunk[cell] = 1;
      pool.push(cell);
    }
    return true;
  };

  /**
   * Which piece of dry ground each hamlet stands on, because it is not always a
   * piece any road can get to.
   *
   * Hồ Tây is what forced this and no longer needs it. Its recipe drew the lake
   * as a `river` of 990 m half-width with `amplitude: 0`, which has no ending, so
   * the water ran edge to edge of the 4200 m patch and the map was two
   * landmasses: 5.54 km² of west bank carrying 73 of the 105 houses and 5.11 km²
   * of east carrying the other 32, with 1325 m of water between them at the
   * narrowest row against a `BRIDGE_LIMIT` of 440. No route from the hub could
   * exist, so the east bank had no road, no lane, no parking and no traffic, and
   * a player opening the world map called that half chán. The recipe is a
   * `BasinParams` now and Hồ Tây is one landmass with a road round it.
   *
   * This stays because a second network is the right answer wherever the case
   * recurs, and it recurs cheaply: Tràng An's floodplain leaves seven landmasses
   * and Hội An's river two, and both are one parameter away from carrying a
   * hamlet the trunk cannot bridge to.
   */
  const land = recipe.water ? findLandmasses(terrain, recipe.water.level) : null;
  const homeJunctions: number[] = [...mainCells];
  for (const spur of spurs) for (const cell of spur.cells) homeJunctions.push(cell);

  /**
   * The landmasses the roads already surveyed stand on — which is not only the
   * hub's, because a road bridges and a walker does not.
   *
   * Asking whether a hamlet is on the hub's own landmass is the wrong question
   * and gave the wrong answer: Hội An is two pieces of ground either side of the
   * Thu Bồn, 325 m apart at the narrowest against a `BRIDGE_LIMIT` of 440, and
   * the trunk has always crossed it. Keyed on the hub, the south bank looked
   * stranded and got a second trunk of its own — 5536 m of asphalt laid along
   * the same corridor as the 5079 m highway already there, and the longer of the
   * two, which would have moved the race onto it.
   */
  const touched = new Set<number>();
  for (const cell of homeJunctions) {
    const ground = land ? land.at(cellX(grid, cell), cellZ(grid, cell)) : 0;
    if (ground >= 0) touched.add(ground);
  }

  const abroad = new Map<number, Settlement[]>();
  for (const place of hamlets) {
    const ground = land ? land.at(place.x, place.z) : 0;
    if (ground >= 0 && !touched.has(ground)) {
      const group = abroad.get(ground);
      if (group) group.push(place);
      else abroad.set(ground, [place]);
      continue;
    }
    laneTo(place, homeJunctions);
  }

  // One other landmass, not all of them: a second bank is a place, and the
  // dozens of one-cell rocks a karst floodplain leaves are not. Ordered by how
  // many houses stand there, so the one that gets the road is the one people
  // actually live on.
  const settled = [...abroad.values()].sort((a, b) => b.length - a.length)[0];
  if (settled) {
    const seat = settled.reduce((best, place) => (place.count > best.count ? place : best), settled[0]);
    const here = snapToBuildable(grid, seat.x, seat.z, terrain.size * 0.08);
    const seatCell = cellOf(grid, here.x, here.z);
    const local = floodFrom(grid, seatCell, null, ROAD_PROFILE);
    const localEnds = local ? trunkEnds(grid, local, here.x, here.z) : null;
    const localCells: number[] = [];

    if (local && localEnds) {
      const outbound = traceBack(local.came, seatCell, localEnds[0]);
      const inbound = localEnds[1] === localEnds[0] ? null : traceBack(local.came, seatCell, localEnds[1]);
      if (outbound) for (let i = outbound.length - 1; i >= 0; i -= 1) localCells.push(outbound[i]);
      if (inbound) for (let i = outbound ? 1 : 0; i < inbound.length; i += 1) localCells.push(inbound[i]);
    }

    if (localCells.length >= 6) {
      // `secondary`, never `main`: there is one highway per destination and
      // `race-route` lays the race on the longest sealed road, which must not
      // become a bank nobody can drive to.
      spurs.push({ cells: localCells, kind: 'secondary' });
      const localJunctions: number[] = [];
      for (const cell of localCells) {
        trunk[cell] = 1;
        localJunctions.push(cell);
      }
      for (const place of settled) laneTo(place, localJunctions);
    }
  }

  // --- build the centrelines -----------------------------------------------
  const trailRandom = createPrng(`${recipe.seed}:trails`);
  const built: Built[] = [];
  /**
   * The point on an already-built ribbon a new route's head should meet, if one
   * is close enough to be the junction it was surveyed for. Bridged samples are
   * no use: nothing joins a road in the middle of a span.
   */
  const tieFor = (cell: number): { x: number; z: number } | null => {
    const x = cellX(grid, cell);
    const z = cellZ(grid, cell);
    let tie: { x: number; z: number } | null = null;
    let nearest = TIE_REACH;
    for (const entry of built) {
      for (let i = 0; i < entry.line.count; i += 1) {
        if (entry.line.bridge[i] === 1) continue;
        const away = Math.hypot(entry.line.points[i * 3] - x, entry.line.points[i * 3 + 2] - z);
        if (away >= nearest) continue;
        nearest = away;
        tie = { x: entry.line.points[i * 3], z: entry.line.points[i * 3 + 2] };
      }
    }
    return tie;
  };

  const addRoad = (kind: RoadKind, cells: number[]) => {
    const spec = KINDS[kind];
    const line = buildCentreline(terrain, grid, cells, waterLevel, spec.lift, kind, tieFor(cells[0]));
    if (!line || line.length < MIN_LENGTH[kind]) return;

    // Crossings go where the road meets the settlement. Everything else on the
    // map is painted the same way, so this is the only place-dependent marking.
    const crossings: number[] = [];
    if (kind === 'main' || kind === 'secondary') {
      for (let i = 2; i < line.count - 2 && crossings.length < 2; i += 1) {
        if (line.bridge[i] === 1) continue;
        const away = Math.hypot(line.points[i * 3] - hub.x, line.points[i * 3 + 2] - hub.z);
        if (away > 160) continue;
        const distance = line.cumulative[i];
        if (crossings.some((other) => Math.abs(other - distance) < 95)) continue;
        crossings.push(distance);
      }
    }

    const widths = kind === 'trail' ? trailWidths(line.count, trailRandom) : null;

    built.push({
      road: {
        index: built.length,
        kind,
        width: spec.width,
        laneOffset: kind === 'trail' ? 0 : kind === 'lane' ? 0.35 : spec.width * 0.25,
        totalLength: line.length,
        crossings,
        points: line.points,
      },
      line,
      widths,
    });
  };

  if (mainCells.length >= 4) addRoad(trunkKind, mainCells);
  for (const spur of spurs) addRoad(spur.kind, spur.cells);

  // --- plan the trails ------------------------------------------------------
  // What a person on foot wants, in the order they want it: the summit, the
  // ridge, the water's edge, then the tea grove. A trail starts from whatever
  // the network already has — a road if there is one, the village if there is
  // not — and crosses ground no road could be benched into.
  const trails: number[][] = [];
  const onFoot: ResolvedPoi[] = [];
  for (const kind of ['summit', 'valley', 'shore', 'island', 'grove'] as const) {
    for (const poi of pois) if (poi.kind === kind) onFoot.push(poi);
  }

  const walked = trunk.slice();
  // Anchored on the ribbons that were laid, not on the cells they were planned
  // from. A spur the length test dropped still left its cells here, and a bờ hồ
  // path hung on one of those started 271 m from anything anyone could walk from
  // — the ghost of a road that was never built. Planning the trails after the
  // carriageways exist is also what lets a path start on the finished ribbon
  // rather than 241 m off it, which is how far the trunk's cell path and its
  // eased spline had drifted apart at Hồ Tây.
  const anchors: number[] = [];
  for (const entry of built) {
    for (let i = 0; i < entry.line.count; i += 1) {
      anchors.push(cellOf(grid, entry.line.points[i * 3], entry.line.points[i * 3 + 2]));
    }
  }
  if (anchors.length === 0) anchors.push(hubCell);

  const addTrail = (
    from: number,
    to: number,
    profile: Profile,
    minimum: number,
    slack: number,
    /**
     * Trails already laid at which this one is refused. A ceiling rather than
     * one constant because the named places and the hamlets are drawing on
     * different budgets: the five below is what the POIs, the crest and the bank
     * have always had between them, and raising it for the tracks between the
     * bản must not quietly hand a sixth path to a viewpoint.
     */
    ceiling: number
  ): boolean => {
    if (trails.length >= ceiling || walked[to] === 1) return false;
    const straight = Math.hypot(cellX(grid, to) - cellX(grid, from), cellZ(grid, to) - cellZ(grid, from));
    if (straight < minimum) return false;
    // A trail may cross a road, so nothing is blocked for its search — only the
    // destination has to be somewhere the network does not already go.
    const route = findRoute(grid, from, to, null, profile);
    if (!route || route.cost > Math.max(900, straight * 60)) return false;

    // A path that gains height cannot be judged on plan length: 270 m of climb
    // over 320 m of ground is a real pitch, and the zigzag that makes it
    // walkable is four times the straight line. One extra length per metre
    // climbed, and an absolute cap, because the crest bonus will otherwise
    // happily walk four kilometres of spine to somewhere one kilometre away.
    const climb = Math.abs(grid.height[to] - grid.height[from]);
    if (route.length > Math.min(MAX_TRAIL_LENGTH, straight * slack + climb * 6)) return false;

    trails.push(route.cells);
    for (const cell of route.cells) {
      walked[cell] = 1;
      anchors.push(cell);
    }
    return true;
  };

  // Approaches before spines: the trail that matters most is the one from the
  // road up to the summit, and routing the crest first would mark the summit as
  // already served and leave it with no way in.
  const crests = onFoot.filter((poi) => poi.kind === 'summit' || poi.kind === 'valley');
  for (const poi of onFoot) {
    const start = nearestCell(grid, anchors, poi.x, poi.z);
    const crest = poi.kind === 'summit' || poi.kind === 'valley';
    addTrail(
      start.cell,
      cellOf(grid, poi.x, poi.z),
      crest ? RIDGE_PROFILE : TRAIL_PROFILE,
      130,
      crest ? 2.8 : 2.0,
      NAMED_TRAILS
    );
  }

  // Then the spine itself, out along the crest from the high places.
  //
  // From the network, not from the POI. The approach above is what normally puts
  // the summit on the network, and where it succeeded `nearestCell` gives the
  // summit cell straight back; where it failed — a crest the ridge profile could
  // not reach at all — starting at the POI anyway left a spine adrift in the
  // mountains with no way onto it, 1.4 to 1.6 km from the nearest road at Tà Xùa.
  for (const crest of crests.slice(0, 2)) {
    const head = nearestCell(grid, anchors, crest.x, crest.z).cell;
    // Three hundred to seven hundred metres out. The real sống lưng is a stretch
    // of spine you walk and come back from, not a traverse of the whole range.
    const out = crestTarget(grid, head, terrain.size * 0.06, terrain.size * 0.13);
    if (out >= 0) addTrail(head, out, RIDGE_PROFILE, 170, 3.0, NAMED_TRAILS);
  }

  // And the bank, where there is one. A road that arrives at the water is not
  // the same thing as the path that runs along it.
  if (recipe.water) {
    // Same again: a bờ hồ path hung on a shore POI the network never reached
    // floated 1.9 km from any road at Hồ Tây, back when a channel cut the map in
    // two and the far half was served by nothing else.
    const bank = onFoot.find((poi) => poi.kind === 'shore');
    const head = nearestCell(grid, anchors, bank?.x ?? 0, bank?.z ?? 0).cell;
    const out = shoreTarget(grid, head, terrain.size * 0.09, terrain.size * 0.3);
    if (out >= 0) addTrail(head, out, SHORE_PROFILE, 150, 2.2, NAMED_TRAILS);
  }

  /**
   * And a đường mòn to every hamlet a lane could not reach.
   *
   * This is the half of the answer the carriageway cannot give. Tà Xùa has
   * seven bản and one drivable corridor: the trunk and its two lanes serve three
   * of them, and the other four — measured at (-255, 532), (-465, 1028),
   * (-19, -702) and (298, -1212) — stood on ground no grader could be benched
   * into, which is why the ridge came back 4% within reach of a road and 92%
   * with nothing at all. A path between two hamlets is how Bắc Yên is actually
   * joined up, and it is the thing that was missing rather than more road.
   *
   * Laid last, so a bản that already has a lane is left with its lane: `walked`
   * carries every cell of every carriageway planned above, and `addTrail`
   * refuses a destination the network already reaches.
   */
  for (const place of hamlets) {
    const start = nearestCell(grid, anchors, place.x, place.z);
    // The same slack the spine gets, and for the same reason the spine's comment
    // gives: `climb` is the net height difference between the two ends, which is
    // nothing at all for a path that drops into a ravine and climbs out of it,
    // and that is most paths on a ridge. Tà Xùa's bản of ten houses at
    // (-465, 1028) sits 509 m from the road, reached by 1427 m of zigzag — 2.80
    // times the straight line, refused by 74 m at 2.4 and laid at 3.0.
    // `MAX_TRAIL_LENGTH` is the backstop, not this.
    addTrail(start.cell, cellOf(grid, place.x, place.z), TRAIL_PROFILE, 130, 3.0, NAMED_TRAILS + HAMLET_TRAILS);
  }

  for (const trail of trails) addRoad('trail', trail);

  // --- surfaces -------------------------------------------------------------
  const soil = new Color(recipe.ground.low);
  const rock = new Color(recipe.ground.rock);
  const foliage = new Color(recipe.ground.foliage);

  const surfaces: Partial<Record<RoadKind, Surface>> = {};
  const surfaceOf = (kind: RoadKind): Surface => {
    const existing = surfaces[kind];
    if (existing) return existing;
    const made =
      kind === 'trail'
        ? createSurfaceMaterial('trail', 'none', KINDS.trail.width, soil, rock, foliage)
        : kind === 'lane'
          ? createSurfaceMaterial('dirt', 'none', KINDS.lane.width, soil, rock, foliage)
          : createSurfaceMaterial(
              'asphalt',
              kind === 'main' ? 'double-yellow' : 'dashed',
              KINDS[kind].width,
              soil,
              rock,
              foliage
            );
    surfaces[kind] = made;
    return made;
  };

  const verge = createSurfaceMaterial('verge', 'none', 1, soil, rock, foliage);
  verge.material.side = 2;

  const sinks: Partial<Record<RoadKind, Sink>> = {};
  const shoulderSink = createSink();
  const crossFields: Float32Array[] = [];

  for (const entry of built) {
    const spec = KINDS[entry.road.kind];
    const field = new Float32Array(entry.line.count).fill(40);
    for (let i = 0; i < entry.line.count; i += 1) {
      for (const crossing of entry.road.crossings) {
        const signed = entry.line.cumulative[i] - crossing;
        if (Math.abs(signed) < Math.abs(field[i])) field[i] = signed;
      }
    }
    crossFields.push(field);

    const sink = sinks[entry.road.kind] ?? createSink();
    sinks[entry.road.kind] = sink;
    addSurface(sink, entry.line, entry.road.width, spec.camber, field, entry.widths);
    addShoulders(shoulderSink, terrain, entry.line, entry.road.width, spec.shoulder, entry.widths);

    if (entry.road.kind !== 'trail') continue;

    // Braids on the gentle stretches and one fork that goes nowhere. A braid on
    // a staircase would read as a mistake, so steep sections are left alone.
    const line = entry.line;
    const reachSamples = Math.max(4, Math.round(34 / SPACING));
    let placed = 0;
    for (let attempt = 0; attempt < 14 && placed < 3; attempt += 1) {
      const from = 2 + Math.floor(trailRandom() * Math.max(1, line.count - reachSamples - 4));
      const to = Math.min(line.count - 2, from + reachSamples + Math.floor(trailRandom() * 3));
      if (to - from < 3) continue;

      let steepest = 0;
      for (let i = from; i < to; i += 1) {
        const run = line.cumulative[i + 1] - line.cumulative[i];
        if (run < 0.01) continue;
        steepest = Math.max(steepest, Math.abs(line.points[(i + 1) * 3 + 1] - line.points[i * 3 + 1]) / run);
      }
      if (steepest > 0.2) continue;

      const fork = placed === 2;
      addBraid(
        sink,
        line,
        from,
        to,
        trailRandom() < 0.5 ? -1 : 1,
        0.6 + trailRandom() * 0.75,
        TRAIL_MIN_WIDTH + trailRandom() * 0.3,
        !fork
      );
      placed += 1;
    }
  }

  const meshes: Mesh[] = [];
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [verge.material];

  for (const kind of KIND_ORDER) {
    const sink = sinks[kind];
    if (!sink) continue;
    const geometry = sinkToGeometry(sink);
    if (!geometry) continue;
    const mesh = new Mesh(geometry, surfaceOf(kind).material);
    mesh.name = `road-${kind}`;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    geometries.push(geometry);
    meshes.push(mesh);
    group.add(mesh);
  }
  for (const kind of KIND_ORDER) {
    const surface = surfaces[kind];
    if (surface) materials.push(surface.material);
  }

  const shoulderGeometry = sinkToGeometry(shoulderSink);
  if (shoulderGeometry) {
    const mesh = new Mesh(shoulderGeometry, verge.material);
    mesh.name = 'road-shoulders';
    mesh.receiveShadow = true;
    geometries.push(shoulderGeometry);
    meshes.push(mesh);
    group.add(mesh);
  }

  // --- bridges, furniture ---------------------------------------------------
  const structure: Part[] = [];
  const lenses: Part[] = [];
  const glows: Part[] = [];
  const wirePoints: number[] = [];
  const pools: { x: number; y: number; z: number }[] = [];
  const parking: ParkingSpot[] = [];
  const decks: Platform[] = [];
  /** Refilled per bridged run; `deckChain` reads it and keeps nothing. */
  const deckPoints: number[] = [];

  const CONCRETE = '#b3b0a8';
  const STEEL = '#9aa0a3';
  const DARK = '#3a3d40';
  const TIMBER = '#5d4a37';
  const STONE = '#8b887e';
  const ROPE = '#9a8a66';

  /** Risers are one box each, so the budget is stated rather than discovered. */
  let risersBuilt = 0;
  const MAX_RISERS = 420;

  const atSample = (line: Centreline, i: number, offset: number, rise = 0): [number, number, number] => [
    line.points[i * 3] - line.tangents[i * 2 + 1] * offset,
    line.points[i * 3 + 1] + rise,
    line.points[i * 3 + 2] + line.tangents[i * 2] * offset,
  ];

  const headingAt = (line: Centreline, i: number) => Math.atan2(line.tangents[i * 2], line.tangents[i * 2 + 1]);

  for (const entry of built) {
    const { line, road } = entry;
    const half = road.width / 2;

    // --- the carriageway as somewhere to walk -------------------------------
    // The whole made surface, not just the bridges. A road here is graded, not
    // draped, and it was only ever published where it crossed water: measured
    // against `terrain.heightAt`, 53% of the Tà Xùa samples and 40% of Tràng An's
    // stand more than half a metre over the ground, up to 6.9 and 14.3 m. Those
    // embankments were not floors at all, so the walker fell through the
    // carriageway to whatever was under it — on the approach to a crossing, down
    // to the riverbank, which is what the user saw as going into the water on the
    // road over it. Measured to 1.59 m of sink at Hội An and 14.29 m at Tràng An,
    // against a body 1.7 m tall.
    //
    // Clearance is read across the width, not down the centreline: a road cut as
    // a shelf into a slope sits on the ground at its crown and hangs over the fall
    // at its outer kerb — on Tràng An's karst, by up to 9.95 m three metres
    // sideways of a centreline whose own fill is 14 cm. Where the bank is instead
    // higher than the carriageway the extra span costs nothing, because `floorAt`
    // takes the ground over it anyway.
    const madeSurface = (i: number) => {
      if (line.bridge[i] === 1) return true;
      const y = line.points[i * 3 + 1];
      if (y - line.ground[i] > SURFACE_GAP) return true;
      for (const offset of [-half, half]) {
        const [kerbX, , kerbZ] = atSample(line, i, offset);
        if (y - terrain.heightAt(kerbX, kerbZ) > SURFACE_GAP) return true;
      }
      return false;
    };
    let madeFrom = -1;
    for (let i = 0; i <= line.count; i += 1) {
      if (i < line.count && madeSurface(i)) {
        if (madeFrom < 0) madeFrom = i;
        continue;
      }
      if (madeFrom < 0) continue;
      // One sample past each end, where the carriageway is already down on the
      // ground: `deckChain` wants the ramp to run out under the terrain so the
      // join is crossed rather than stepped over, and the run is already maximal
      // in how far it stands clear, so there is nothing further to carry it to.
      const head = Math.max(0, madeFrom - 1);
      const tail = Math.min(line.count - 1, i);
      madeFrom = -1;

      deckPoints.length = 0;
      for (let at = head; at <= tail; at += 1) {
        deckPoints.push(line.points[at * 3], line.points[at * 3 + 1], line.points[at * 3 + 2]);
      }
      // The carriageway's own width, which off a bridge is kerb to kerb and on
      // one is inside the parapets, whose inner faces stand three centimetres
      // outside it — not the beam, which is a quarter of a metre wider again and
      // has nothing on top of it.
      deckChain(deckPoints, half, decks);
    }

    if (road.kind === 'trail') {
      const widths = entry.widths;
      const widthAt = (i: number) => (widths ? widths[i] : road.width);

      // --- worn steps on the steep pitches ----------------------------------
      // A riser every half-metre of run where the pitch is too steep to walk.
      // Cut-in timber and set stone is how every mountain path in the north is
      // actually made passable, and it is the reason a trail can hold a grade a
      // road could not.
      for (let i = 0; i < line.count - 1 && risersBuilt < MAX_RISERS; i += 1) {
        const run = line.cumulative[i + 1] - line.cumulative[i];
        if (run < 0.2) continue;
        const rise = line.points[(i + 1) * 3 + 1] - line.points[i * 3 + 1];
        if (Math.abs(rise) / run < 0.24) continue;

        const risers = Math.min(16, Math.max(1, Math.round(run / 0.52)));
        for (let s = 0; s < risers && risersBuilt < MAX_RISERS; s += 1) {
          const t = (s + 0.5) / risers;
          const x = line.points[i * 3] + (line.points[(i + 1) * 3] - line.points[i * 3]) * t;
          const y = line.points[i * 3 + 1] + rise * t;
          const z = line.points[i * 3 + 2] + (line.points[(i + 1) * 3 + 2] - line.points[i * 3 + 2]) * t;
          const thick = 0.1 + trailRandom() * 0.07;
          structure.push(
            box(
              [widthAt(i) * (0.85 + trailRandom() * 0.3), thick, 0.2 + trailRandom() * 0.1],
              [x, y - thick * 0.3, z],
              trailRandom() < 0.55 ? STONE : TIMBER,
              [0, headingAt(line, i) + (trailRandom() - 0.5) * 0.3, (trailRandom() - 0.5) * 0.1]
            )
          );
          risersBuilt += 1;
        }
      }

      // --- rope handrail on the one exposed section -------------------------
      let railFrom = -1;
      let railTo = -1;
      let railSide = 1;
      for (let s = 0; s < 2; s += 1) {
        const side = s === 0 ? -1 : 1;
        let runStart = -1;
        for (let i = 0; i <= line.count; i += 1) {
          const probe = i < line.count ? atSample(line, i, side * (widthAt(i) / 2 + 2.2), 0) : null;
          const exposed = probe !== null && line.points[i * 3 + 1] - terrain.heightAt(probe[0], probe[2]) > 3;
          if (exposed && runStart < 0) runStart = i;
          if (exposed || runStart < 0) continue;
          if (i - runStart > railTo - railFrom) {
            railFrom = runStart;
            railTo = i - 1;
            railSide = side;
          }
          runStart = -1;
        }
      }

      if (railTo - railFrom >= 3) {
        const hand = 0.98;
        for (let i = railFrom; i <= railTo; i += 1) {
          const post = atSample(line, i, railSide * (widthAt(i) / 2 + 0.22), 0);
          structure.push(tube([0.045, 0.055], 1.14, [post[0], post[1] + 0.47, post[2]], TIMBER, undefined, 6));
          if (i === railTo) continue;

          // Three sub-spans a bay, because a rope drawn straight reads as a bar.
          const next = atSample(line, i + 1, railSide * (widthAt(i + 1) / 2 + 0.22), 0);
          const at = (t: number): [number, number, number] => [
            post[0] + (next[0] - post[0]) * t,
            post[1] + (next[1] - post[1]) * t + hand - 0.64 * t * (1 - t),
            post[2] + (next[2] - post[2]) * t,
          ];
          for (let span2 = 0; span2 < 3; span2 += 1) {
            structure.push(strut(at(span2 / 3), at((span2 + 1) / 3), 0.022, ROPE, 4));
          }
        }
      }

      // --- marker cairns ----------------------------------------------------
      // Đá xếp: flat stones shrinking upward, each turned a different way, the
      // top one painted. Put where you need to be told you are still on it.
      const cairnAt = (i: number) => {
        const at = atSample(line, i, (widthAt(i) / 2 + 0.45) * (trailRandom() < 0.5 ? -1 : 1), 0);
        let stacked = 0;
        const stones = 4 + Math.floor(trailRandom() * 3);
        for (let s = 0; s < stones; s += 1) {
          const taper = 1 - (s / stones) * 0.62;
          const thick = 0.07 + trailRandom() * 0.06;
          structure.push(
            box(
              [0.46 * taper, thick, 0.34 * taper],
              [at[0] + (trailRandom() - 0.5) * 0.05, at[1] + stacked + thick / 2, at[2] + (trailRandom() - 0.5) * 0.05],
              s === stones - 1 ? '#a8463a' : STONE,
              [0, trailRandom() * Math.PI, (trailRandom() - 0.5) * 0.14]
            )
          );
          stacked += thick;
        }
      };
      cairnAt(1);
      cairnAt(line.count - 2);
      if (line.count > 20) cairnAt(Math.floor(line.count / 2));

      continue;
    }

    // --- bridges: a deck beam, parapets both sides, piers to the bed --------
    let span = -1;
    for (let i = 0; i <= line.count; i += 1) {
      const wet = i < line.count && line.bridge[i] === 1;
      if (wet && span < 0) span = i;
      if (wet || span < 0) continue;

      const from = Math.max(0, span - 1);
      const to = Math.min(line.count - 1, i);
      span = -1;
      if (to - from < 2) continue;

      const beam = boxRibbon(line, from, to, 0, half + 0.25, -0.1, -1.0);
      if (beam) structure.push({ geometry: beam, color: CONCRETE });
      for (const side of [-1, 1]) {
        const parapet = boxRibbon(line, from, to, side * (half + 0.16), 0.13, 1.0, -0.12);
        if (parapet) structure.push({ geometry: parapet, color: CONCRETE });
        const rail = boxRibbon(line, from, to, side * (half + 0.16), 0.05, 1.08, 0.94);
        if (rail) structure.push({ geometry: rail, color: STEEL });
      }

      // Piers every eighteen metres, down past the bed so none of them hangs.
      const pierStep = Math.max(2, Math.round(18 / SPACING));
      for (let i2 = from + pierStep; i2 < to - 1; i2 += pierStep) {
        const deck = line.points[i2 * 3 + 1] - 1.0;
        const bed = line.ground[i2] - 1.2;
        const height = Math.max(1.5, deck - bed);
        for (const side of [-1, 1]) {
          const at = atSample(line, i2, side * half * 0.52, 0);
          structure.push(
            tube([0.52, 0.72], height, [at[0], bed + height / 2, at[2]], CONCRETE, undefined, 10),
            box([1.9, 0.5, 1.9], [at[0], bed + 0.25, at[2]], CONCRETE, [0, headingAt(line, i2), 0])
          );
        }
        // A cross-head tying the two piers together under the deck.
        const mid = atSample(line, i2, 0, 0);
        structure.push(
          box([road.width + 0.6, 0.45, 0.8], [mid[0], deck - 0.25, mid[2]], CONCRETE, [0, headingAt(line, i2), 0])
        );
      }
    }

    // --- guard rails on the drop side --------------------------------------
    const needsRail = new Uint8Array(line.count * 2);
    for (let i = 0; i < line.count; i += 1) {
      if (line.bridge[i] === 1) continue;
      for (let s = 0; s < 2; s += 1) {
        const side = s === 0 ? -1 : 1;
        const probe = atSample(line, i, side * (half + 4), 0);
        if (line.points[i * 3 + 1] - terrain.heightAt(probe[0], probe[2]) > 2.4) needsRail[i * 2 + s] = 1;
      }
    }

    for (let s = 0; s < 2; s += 1) {
      const side = s === 0 ? -1 : 1;
      let runStart = -1;
      for (let i = 0; i <= line.count; i += 1) {
        const on = i < line.count && needsRail[i * 2 + s] === 1;
        if (on && runStart < 0) runStart = i;
        if (on || runStart < 0) continue;
        const from = runStart;
        const to = i - 1;
        runStart = -1;
        if (to - from < 3) continue;

        const beam = boxRibbon(line, from, to, side * (half + 0.42), 0.045, 0.78, 0.46);
        if (beam) structure.push({ geometry: beam, color: STEEL });
        const postStep = Math.max(1, Math.round(3 / SPACING));
        for (let i2 = from; i2 <= to; i2 += postStep) {
          const at = atSample(line, i2, side * (half + 0.42), 0);
          structure.push(box([0.1, 0.9, 0.1], [at[0], at[1] + 0.34, at[2]], '#8d9295', [0, headingAt(line, i2), 0]));
        }
      }
    }

    if (road.kind !== 'main') continue;

    // --- kilometre markers --------------------------------------------------
    for (let marked = 1000; marked < line.length; marked += 1000) {
      let i = 0;
      while (i < line.count - 1 && line.cumulative[i] < marked) i += 1;
      if (line.bridge[i] === 1) continue;
      const at = atSample(line, i, half + 1.2, 0);
      const facing = headingAt(line, i);
      structure.push(
        box([0.28, 0.82, 0.16], [at[0], at[1] + 0.41, at[2]], '#e2ddd2', [0, facing, 0]),
        box([0.28, 0.26, 0.17], [at[0], at[1] + 0.95, at[2]], '#a8352a', [0, facing, 0]),
        {
          geometry: (() => {
            const cap = new CylinderGeometry(0.14, 0.14, 0.17, 10, 1, false, 0, Math.PI);
            cap.rotateX(Math.PI / 2);
            cap.rotateY(facing);
            cap.translate(at[0], at[1] + 1.08, at[2]);
            return cap;
          })(),
          color: '#a8352a',
        }
      );
    }

    // --- road signs ----------------------------------------------------------
    const signCount = 4;
    for (let n = 0; n < signCount; n += 1) {
      const i = Math.floor((0.14 + (n + random() * 0.6) * (0.72 / signCount)) * (line.count - 1));
      if (i < 1 || i >= line.count - 1 || line.bridge[i] === 1) continue;
      const at = atSample(line, i, half + 1.1, 0);
      const facing = headingAt(line, i) + Math.PI / 2;
      structure.push(tube([0.045, 0.055], 2.5, [at[0], at[1] + 1.25, at[2]], '#8f9498', undefined, 6));

      const plateY = at[1] + 2.3;
      if (n % 3 === 0) {
        // Speed limit: a red ring on a white disc.
        const ring = new CylinderGeometry(0.34, 0.34, 0.05, 18);
        ring.rotateX(Math.PI / 2);
        ring.rotateY(facing);
        ring.translate(at[0], plateY, at[2]);
        const face = new CylinderGeometry(0.26, 0.26, 0.06, 18);
        face.rotateX(Math.PI / 2);
        face.rotateY(facing);
        face.translate(at[0] - Math.sin(facing) * 0.02, plateY, at[2] + Math.cos(facing) * 0.02);
        structure.push({ geometry: ring, color: '#b0362b' }, { geometry: face, color: '#eae6dc' });
      } else if (n % 3 === 1) {
        // Warning triangle, point up.
        const plate = new ConeGeometry(0.42, 0.72, 3);
        plate.scale(1, 1, 0.1);
        plate.rotateY(facing);
        plate.translate(at[0], plateY, at[2]);
        const inlay = new ConeGeometry(0.31, 0.53, 3);
        inlay.scale(1, 1, 0.1);
        inlay.rotateY(facing);
        inlay.translate(at[0] - Math.sin(facing) * 0.03, plateY - 0.05, at[2] + Math.cos(facing) * 0.03);
        structure.push({ geometry: plate, color: '#b0362b' }, { geometry: inlay, color: '#e8dfaf' });
      } else {
        structure.push(
          box([1.15, 0.42, 0.06], [at[0], plateY, at[2]], '#2b5e86', [0, facing, 0]),
          box(
            [1.0, 0.07, 0.07],
            [at[0] - Math.sin(facing) * 0.04, plateY, at[2] + Math.cos(facing) * 0.04],
            '#e6e2d6',
            [0, facing, 0]
          )
        );
      }
    }

    // --- utility poles and sagging wires -------------------------------------
    const poleStep = Math.max(2, Math.round(42 / SPACING));
    const poleAt: [number, number, number][] = [];
    for (let i = 1; i < line.count - 1 && poleAt.length < 64; i += poleStep) {
      if (line.bridge[i] === 1) continue;
      const base = atSample(line, i, half + 2.6, 0);
      const facing = headingAt(line, i);
      const top = base[1] + 8.4;
      structure.push(tube([0.1, 0.16], 8.6, [base[0], base[1] + 4.3, base[2]], '#b4b2ab', undefined, 7));
      for (let arm = 0; arm < 2; arm += 1) {
        const armY = top - arm * 0.62;
        structure.push(
          box([1.6, 0.085, 0.1], [base[0], armY, base[2]], '#8e8b84', [0, facing + Math.PI / 2, 0]),
          box([0.1, 0.1, 0.1], [base[0], armY + 0.08, base[2]], '#d8d4c8')
        );
        for (const side of [-1, 1]) {
          const insulatorX = base[0] - Math.sin(facing + Math.PI / 2) * side * 0.68;
          const insulatorZ = base[2] + Math.cos(facing + Math.PI / 2) * side * 0.68;
          structure.push(tube([0.06, 0.07], 0.16, [insulatorX, armY + 0.12, insulatorZ], '#d9d5c6', undefined, 6));
        }
      }
      poleAt.push([base[0], top, base[2]]);
    }

    // Catenary sag between consecutive poles. A wire drawn straight is the
    // detail that makes a line of poles read as scenery rather than as cabling.
    for (let p = 0; p + 1 < poleAt.length; p += 1) {
      const a = poleAt[p];
      const b = poleAt[p + 1];
      const span2 = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (span2 > 90) continue;
      const sag = Math.min(1.1, span2 * 0.022);
      for (let wire = 0; wire < 4; wire += 1) {
        const lift = wire < 2 ? 0.12 : -0.5;
        const sway = wire % 2 === 0 ? 0.68 : -0.68;
        const normalX = -(b[2] - a[2]) / (span2 || 1);
        const normalZ = (b[0] - a[0]) / (span2 || 1);
        const segments = 8;
        for (let s = 0; s < segments; s += 1) {
          for (const t of [s / segments, (s + 1) / segments]) {
            wirePoints.push(
              a[0] + (b[0] - a[0]) * t + normalX * sway,
              a[1] + lift + (b[1] - a[1]) * t - sag * 4 * t * (1 - t),
              a[2] + (b[2] - a[2]) * t + normalZ * sway
            );
          }
        }
      }
    }

    // --- street lamps, a bus stop and a row of parked bikes near the town ----
    const lampStep = Math.max(2, Math.round(30 / SPACING));
    let lampSide = 1;
    let busStopDone = false;
    for (let i = 1; i < line.count - 1; i += lampStep) {
      if (Math.hypot(line.points[i * 3] - hub.x, line.points[i * 3 + 2] - hub.z) > 240) continue;
      if (line.bridge[i] === 1) continue;
      lampSide = -lampSide;

      const base = atSample(line, i, lampSide * (half + 0.9), 0);
      const facing = headingAt(line, i);
      const headY = base[1] + 7.2;
      structure.push(
        tube([0.085, 0.12], 7.2, [base[0], base[1] + 3.6, base[2]], '#8e9397', undefined, 7),
        box([0.4, 0.14, 0.4], [base[0], base[1] + 0.12, base[2]], '#8e9397', [0, facing, 0])
      );

      // The arm reaches out over the carriageway, which is what makes a lamp a
      // street lamp rather than a post with a bulb on it.
      const arm = new TorusGeometry(1.25, 0.055, 5, 7, Math.PI / 2);
      arm.rotateY(Math.PI / 2);
      arm.rotateZ(Math.PI / 2);
      arm.rotateY(facing + (lampSide > 0 ? Math.PI : 0));
      arm.translate(base[0], headY - 1.25, base[2]);
      structure.push({ geometry: arm, color: '#8e9397' });

      const reach = 1.25;
      const headX = base[0] - Math.sin(facing + Math.PI / 2) * -lampSide * reach;
      const headZ = base[2] + Math.cos(facing + Math.PI / 2) * -lampSide * reach;
      structure.push(box([0.6, 0.18, 0.3], [headX, headY + 0.02, headZ], DARK, [0, facing, 0]));
      lenses.push(box([0.46, 0.05, 0.22], [headX, headY - 0.1, headZ], '#ffd9a0', [0, facing, 0]));

      const halo = new SphereGeometry(0.42, 8, 6);
      halo.translate(headX, headY - 0.12, headZ);
      glows.push({ geometry: halo, color: '#ffcf96' });
      pools.push({ x: headX, y: line.points[i * 3 + 1] + 0.06, z: headZ });

      if (!busStopDone && lampSide > 0 && i > 3) {
        busStopDone = true;
        const stop = atSample(line, i, lampSide * (half + 2.6), 0);
        const cross = facing + Math.PI / 2;
        for (const along of [-1.6, 1.6]) {
          for (const across of [-0.65, 0.65]) {
            const px = stop[0] - Math.sin(facing) * along - Math.sin(cross) * across;
            const pz = stop[2] + Math.cos(facing) * along + Math.cos(cross) * across;
            structure.push(tube([0.05, 0.06], 2.5, [px, stop[1] + 1.25, pz], '#6d7276', undefined, 6));
          }
        }
        structure.push(
          box([3.8, 0.1, 1.7], [stop[0], stop[1] + 2.56, stop[2]], '#2f6b82', [0, facing, 0.03]),
          box(
            [3.5, 1.5, 0.07],
            [stop[0] - Math.sin(cross) * 0.68, stop[1] + 1.4, stop[2] + Math.cos(cross) * 0.68],
            '#d6cfbd',
            [0, facing, 0]
          ),
          box([3.1, 0.07, 0.42], [stop[0], stop[1] + 0.46, stop[2]], '#8a6a48', [0, facing, 0]),
          box(
            [0.1, 0.46, 0.1],
            [stop[0] - Math.sin(facing) * 1.3, stop[1] + 0.23, stop[2] + Math.cos(facing) * 1.3],
            '#6d7276'
          ),
          box(
            [0.1, 0.46, 0.1],
            [stop[0] + Math.sin(facing) * 1.3, stop[1] + 0.23, stop[2] - Math.cos(facing) * 1.3],
            '#6d7276'
          ),
          box(
            [0.6, 0.78, 0.05],
            [stop[0] - Math.sin(cross) * 1.9, stop[1] + 2.9, stop[2] + Math.cos(cross) * 1.9],
            '#2f6b82',
            [0, facing, 0]
          )
        );
      }
    }
  }

  // --- where bikes are left -------------------------------------------------
  /**
   * Rows of kerb-side slots, spread along the sealed network.
   *
   * This used to sit inside the street-lamp loop and fire **once**, on the first
   * lamp of the first road — and that loop skips any sample more than 240 m from
   * the town hub, because that is how far the lamps go. So a five-kilometre map
   * had exactly one place to find a motorbike, six slots 0.9 m apart against one
   * stretch of kerb, and a rider who left one anywhere else had no way back to a
   * second. It is a pass of its own now, with no connection to the lighting.
   *
   * Spaced rather than scattered: `PARK_APART` is the distance a person will walk
   * to a bike rather than giving up, judged against the 14 m/s travel stride that
   * is the alternative — 700 m is under a minute of it. The cap is there because
   * these are built rigs and not instances, and because a kerb lined with bikes
   * end to end is a dealership rather than a village.
   *
   * Measured as a straight line between rows and not as distance along the road,
   * which is stricter now the roads wind: two points 700 m apart as the crow
   * flies are further than that along a sinuous carriageway. That is the right
   * way round, because how far you are from a bike is a question about where you
   * are standing, not about the route.
   */
  const PARK_APART = 700;
  const PARK_SLOTS = 4;

  /**
   * Trunk roads first: a bike left on a main road is reachable from more of the
   * map than one up a lane, and the lane still gets a row once the mains are
   * spoken for.
   *
   * A trail is walked, so nothing is left on one — unless a trail is all there
   * is. The old fallback this replaces warned about exactly that case ("a ridge
   * hamlet whose trunk came out as a dirt lane would get none at all"), and the
   * fleet already grants that a Wave will go up a đường mòn, which is very much
   * a Vietnamese thing. All four destinations currently produce a main road, so
   * this branch is defensive rather than load-bearing — but a recipe is a few
   * numbers away from not producing one.
   */
  const sealed = built.filter((entry) => entry.road.kind !== 'trail');
  const parkable = (sealed.length > 0 ? sealed : built).sort(
    (a, b) => KIND_ORDER.indexOf(a.road.kind) - KIND_ORDER.indexOf(b.road.kind)
  );

  /**
   * How many rows, derived from how much sealed road there is to put them on.
   *
   * This was a flat five, written when a destination had three or four roads,
   * and five stopped delivering what `PARK_APART` says it is for the moment the
   * networks grew: the rows are laid greedily from the start of the trunk, so on
   * Hồ Tây's 14.7 km of sealed road all five landed in the first 2.8 km of the
   * highway and the whole ring round the lake had none. Measured from the
   * spawn, the nearest motorbike was **2183 m** away — on a map whose point is
   * that you can now drive round the water.
   *
   * One row per `2 * PARK_APART` of carriageway, floored at the old five so no
   * destination loses any, capped at nine because these are built rigs and a
   * kerb lined with bikes end to end is a dealership rather than a village. The
   * 700 m separation is what actually spaces them, and it is still what stops Tà
   * Xùa — 3.2 km of sealed road — from taking more than the two it has room for.
   *
   * And no one road may take more than its own length's share of them. The kind
   * order below is a preference and was being read as a monopoly: at Hồ Tây it
   * spent all nine rows walking the 6663 m highway from the north-east corner
   * round to the south-west, and the đường vòng that carries the other half of
   * the loop got none — which is how nine rows spread over 6 km of shore still
   * left the spawn 2183 m from a bike. A bike on a main road really is reachable
   * from more of the map than one up a lane; it is not reachable from the far
   * side of a lake.
   */
  let sealedLength = 0;
  for (const entry of parkable) sealedLength += entry.road.totalLength;
  const PARK_AREAS = Math.min(9, Math.max(5, Math.round(sealedLength / (PARK_APART * 2))));

  const laid: { x: number; z: number }[] = [];

  /**
   * The arrival row first, so the spacing rule lays the rest around it rather
   * than leaving it out. It is the one row whose position is not a function of
   * how the road happens to run: everything else is spaced every `PARK_APART`
   * from whatever came before, and this one is spaced from the person.
   */
  if (arrival) {
    let bestRoad: Built | null = null;
    let bestAt = -1;
    let bestGap = Infinity;
    for (const entry of parkable) {
      for (let i = 2; i < entry.line.count - 2; i += 1) {
        if (entry.line.bridge[i] === 1) continue;
        const gap = Math.hypot(entry.line.points[i * 3] - arrival.x, entry.line.points[i * 3 + 2] - arrival.z);
        if (gap >= bestGap) continue;
        bestGap = gap;
        bestRoad = entry;
        bestAt = i;
      }
    }

    if (bestRoad && bestAt >= 0) {
      const kerb = headingAt(bestRoad.line, bestAt);
      const edge = atSample(bestRoad.line, bestAt, -(bestRoad.road.width / 2 + 1.9), 0);
      for (let slot = 0; slot < PARK_SLOTS; slot += 1) {
        const along = (slot - (PARK_SLOTS - 1) / 2) * 0.9;
        parking.push({
          x: edge[0] - Math.sin(kerb) * along,
          y: bestRoad.line.points[bestAt * 3 + 1],
          z: edge[2] + Math.cos(kerb) * along,
          heading: kerb + Math.PI / 2,
          area: 0,
        });
      }
      laid.push({ x: bestRoad.line.points[bestAt * 3], z: bestRoad.line.points[bestAt * 3 + 2] });
    }
  }

  for (const entry of parkable) {
    if (laid.length >= PARK_AREAS) break;
    const { line, road } = entry;
    const stride = Math.max(1, Math.round(PARK_APART / SPACING));
    const share =
      sealedLength > 0 ? Math.max(1, Math.ceil((PARK_AREAS * road.totalLength) / sealedLength)) : PARK_AREAS;
    let here = 0;

    for (let i = 2; i < line.count - 2 && laid.length < PARK_AREAS && here < share; i += 1) {
      // Not on a bridge: there is no verge over a river, and a row of bikes on a
      // parapet is a row of bikes in the water.
      if (line.bridge[i] === 1) continue;
      const x = line.points[i * 3];
      const z = line.points[i * 3 + 2];
      if (laid.some((row) => Math.hypot(row.x - x, row.z - z) < PARK_APART)) continue;

      const kerb = headingAt(line, i);
      const edge = atSample(line, i, -(road.width / 2 + 1.9), 0);
      const area = laid.length;
      for (let slot = 0; slot < PARK_SLOTS; slot += 1) {
        const along = (slot - (PARK_SLOTS - 1) / 2) * 0.9;
        parking.push({
          x: edge[0] - Math.sin(kerb) * along,
          y: line.points[i * 3 + 1],
          z: edge[2] + Math.cos(kerb) * along,
          heading: kerb + Math.PI / 2,
          area,
        });
      }
      laid.push({ x, z });
      here += 1;
      i += stride;
    }
  }

  // --- assemble the built structures ---------------------------------------
  const structureGeometry = mergeParts(structure);
  let structureMaterial: MeshStandardMaterial | null = null;
  if (structureGeometry) {
    const material = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.84, metalness: 0 });
    structureMaterial = material;
    const mesh = new Mesh(structureGeometry, material);
    mesh.name = 'road-structures';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    geometries.push(structureGeometry);
    materials.push(material);
    meshes.push(mesh);
    group.add(mesh);
  }

  const lensGeometry = mergeParts(lenses);
  const lensMaterial = new MeshBasicMaterial({ color: new Color('#4a4134') });
  if (lensGeometry) {
    const mesh = new Mesh(lensGeometry, lensMaterial);
    mesh.name = 'road-lamp-lenses';
    geometries.push(lensGeometry);
    meshes.push(mesh);
    group.add(mesh);
  }
  materials.push(lensMaterial);

  const glowGeometry = mergeParts(glows);
  const glowMaterial = new MeshBasicMaterial({
    color: new Color('#ffcf96'),
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  let glowMesh: Mesh | null = null;
  if (glowGeometry) {
    glowMesh = new Mesh(glowGeometry, glowMaterial);
    glowMesh.name = 'road-lamp-glow';
    glowMesh.visible = false;
    geometries.push(glowGeometry);
    meshes.push(glowMesh);
    group.add(glowMesh);
  }
  materials.push(glowMaterial);

  // Light pools on the carriageway. Vertex alpha rather than a texture: three
  // detects a four-component colour attribute and fades the disc for free.
  let poolMesh: Mesh | null = null;
  const poolMaterial = new MeshBasicMaterial({
    color: new Color('#ffd4a0'),
    transparent: true,
    opacity: 0,
    vertexColors: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  if (pools.length > 0) {
    const ring = 14;
    const radius = 5.4;
    const positions = new Float32Array(pools.length * (ring + 1) * 3);
    const colors = new Float32Array(pools.length * (ring + 1) * 4);
    const indices: number[] = [];

    pools.forEach((pool, index) => {
      const base = index * (ring + 1);
      positions[base * 3] = pool.x;
      positions[base * 3 + 1] = pool.y;
      positions[base * 3 + 2] = pool.z;
      colors[base * 4] = 1;
      colors[base * 4 + 1] = 1;
      colors[base * 4 + 2] = 1;
      colors[base * 4 + 3] = 1;

      for (let step = 0; step < ring; step += 1) {
        const angle = (step / ring) * Math.PI * 2;
        const vertex = base + 1 + step;
        positions[vertex * 3] = pool.x + Math.cos(angle) * radius;
        positions[vertex * 3 + 1] = pool.y;
        positions[vertex * 3 + 2] = pool.z + Math.sin(angle) * radius;
        colors[vertex * 4] = 1;
        colors[vertex * 4 + 1] = 1;
        colors[vertex * 4 + 2] = 1;
        colors[vertex * 4 + 3] = 0;
        indices.push(base, base + 1 + ((step + 1) % ring), vertex);
      }
    });

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 4));
    geometry.setIndex(indices);
    poolMesh = new Mesh(geometry, poolMaterial);
    poolMesh.name = 'road-light-pools';
    poolMesh.visible = false;
    geometries.push(geometry);
    meshes.push(poolMesh);
    group.add(poolMesh);
  }
  materials.push(poolMaterial);

  const wireMaterial = new LineBasicMaterial({ color: new Color('#2a2c2e'), transparent: true, opacity: 0.85 });
  let wires: LineSegments | null = null;
  if (wirePoints.length > 0) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(wirePoints), 3));
    wires = new LineSegments(geometry, wireMaterial);
    wires.name = 'road-wires';
    geometries.push(geometry);
    group.add(wires);
  }
  materials.push(wireMaterial);

  // --- sampling -------------------------------------------------------------
  const lines = built.map((entry) => entry.line);
  const roads = built.map((entry) => entry.road);

  const sampleAt = (roadIndex: number, distance: number, out: RoadSample): RoadSample => {
    const line = lines[roadIndex];
    if (!line) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      out.tx = 0;
      out.tz = 1;
      out.curvature = 0;
      return out;
    }

    const wrapped = ((distance % line.length) + line.length) % line.length;
    let low = 0;
    let high = line.count - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (line.cumulative[mid] <= wrapped) low = mid;
      else high = mid;
    }

    const span = line.cumulative[high] - line.cumulative[low];
    const t = span > 1e-5 ? (wrapped - line.cumulative[low]) / span : 0;

    out.x = line.points[low * 3] + (line.points[high * 3] - line.points[low * 3]) * t;
    out.y = line.points[low * 3 + 1] + (line.points[high * 3 + 1] - line.points[low * 3 + 1]) * t;
    out.z = line.points[low * 3 + 2] + (line.points[high * 3 + 2] - line.points[low * 3 + 2]) * t;

    const tx = line.tangents[low * 2] + (line.tangents[high * 2] - line.tangents[low * 2]) * t;
    const tz = line.tangents[low * 2 + 1] + (line.tangents[high * 2 + 1] - line.tangents[low * 2 + 1]) * t;
    const unit = Math.hypot(tx, tz) || 1;
    out.tx = tx / unit;
    out.tz = tz / unit;
    out.curvature = line.curvature[low] + (line.curvature[high] - line.curvature[low]) * t;
    return out;
  };

  let lit = 0;

  return {
    group,
    roads,
    sampleAt,
    parking,
    decks,
    update: (elapsed) => {
      if (lit <= 0.02) return;
      // Sodium lamps are never quite steady, and a scene full of perfectly even
      // pools of light is the thing that reads as artificial after dark.
      const flicker = 0.94 + Math.sin(elapsed * 2.3) * 0.03 + Math.sin(elapsed * 7.1) * 0.03;
      glowMaterial.opacity = lit * 0.38 * flicker;
      poolMaterial.opacity = lit * 0.3 * flicker;
    },
    setNight: (amount) => {
      lit = Math.min(1, Math.max(0, amount));
      for (const kind of KIND_ORDER) {
        const surface = surfaces[kind];
        if (surface) surface.night.value = lit;
      }
      verge.night.value = lit;
      lensMaterial.color.setHex(lit > 0.25 ? 0xffe0ae : 0x4a4134);
      glowMaterial.opacity = lit * 0.38;
      poolMaterial.opacity = lit * 0.3;
      if (glowMesh) glowMesh.visible = lit > 0.04;
      if (poolMesh) poolMesh.visible = lit > 0.04;
      if (wires) wireMaterial.opacity = 0.85 - lit * 0.35;
    },
    setWet: (wet) => {
      for (const kind of KIND_ORDER) {
        const surface = surfaces[kind];
        if (surface) applyWetLook(surface.material, wet, WET_SURFACE[kind]);
      }
      applyWetLook(verge.material, wet, { darken: 0.36, gloss: 0.42, pooling: 0.8 });
      // Parapets, kerbs and bridge decks: concrete and stone, and the parapet is a
      // wall, which is what the pooling term is there to notice.
      if (structureMaterial) applyWetLook(structureMaterial, wet, { darken: 0.28, gloss: 0.55, pooling: 0.7 });
    },
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      group.clear();
      meshes.length = 0;
    },
  };
};
