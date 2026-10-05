import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type BufferGeometry as Geometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { Obstacle } from './obstacle-index';
import { deckChain } from './road-network';
import type { Platform } from './walker';

// Đường sắt Việt Nam is metre gauge throughout. Every dimension below is the
// real one, in metres, because a railway is the one object in the scene whose
// proportions a viewer already knows by heart.
/** Between the inner faces of the rails. */
const GAUGE = 1.0;
/** Rail centre to rail centre: gauge plus one rail head width. */
const RAIL_CENTRES = GAUGE + 0.065;
/** 43 kg/m rail, the Vietnamese mainline section. */
const RAIL_HEIGHT = 0.14;
const RAIL_HEAD_WIDTH = 0.07;
/** Standard rail length, so fishplates land where joints land. */
const RAIL_LENGTH = 12.5;

const SLEEPER_LENGTH = 1.8;
const SLEEPER_WIDTH = 0.22;
const SLEEPER_DEPTH = 0.16;
/** Bridge timbers are longer than track sleepers, and it shows. */
const BRIDGE_TIMBER_LENGTH = 2.4;

/** Depth of ballast under the sleeper, plus the shoulder it stands in. */
const BALLAST_DEPTH = 0.45;
const BALLAST_CROWN_HALF = 1.5;
/** Earthwork side slopes, run per unit rise. */
const FILL_SLOPE = 1.5;
const CUT_SLOPE = 1.2;
/** Drainage cess between the ballast toe and the foot of a cutting. */
const CESS = 0.8;

/** Rail top above formation level — what the earthworks have to carry. */
const RAIL_ABOVE_FORMATION = BALLAST_DEPTH + SLEEPER_DEPTH + RAIL_HEIGHT;

/** Ruling grade. A locomotive hauling five coaches will not do better. */
const MAX_GRADE = 0.025;
const MIN_RADIUS = 420;
/** Line speed the cant is calculated for, in m/s (70 km/h). */
const DESIGN_SPEED = 19.4;
/** Metre gauge cannot be canted much before a stopped train leans badly. */
const MAX_CANT = 0.075;

/** Rail level above the water on a bridge, so a sampan still fits under. */
const BRIDGE_CLEARANCE = 6;
/** Beyond this the embankment stops being an embankment and becomes a viaduct. */
const VIADUCT_FILL = 11;
const MAX_CUT = 11;

/**
 * How far the sleeper tops have to stand over the ground before they are
 * published as a surface. A noise floor, not a lip: the ballast is a made surface
 * wherever there is any of it, and a threshold at the walker's step height left
 * 310 m of the Hồ Tây line unpublished where the formation is on shallow fill and
 * the crest clears the ground by less than 35 cm — measured down to 2 cm. Walking
 * those, the body stood on the original ground with the sleepers around its
 * shins.
 *
 * The 859 m still left out is every one of it in cutting, measured: the ground
 * sits at or above the crest there, and `floorAt` taking the higher of the two
 * makes the ground the floor whether a span is published or not.
 */
const SURFACE_GAP = 0.04;
/** Stations of line carried past each end of a raised run. Ten metres. */
const DECK_APPROACH = 2;

const STATION_STEP = 5;
/** Coarser sampling while comparing candidate routes; the winner is resampled. */
const SURVEY_STEP = 20;
/** Stations at each end over which the line simply follows the ground off the map. */
const EDGE_TAPER = 30;

const UP = new Vector3(0, 1, 0);
const Y_AXIS = new Vector3(0, 1, 0);

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const wrapAngle = (angle: number): number => {
  let wrapped = angle;
  while (wrapped > Math.PI) wrapped -= Math.PI * 2;
  while (wrapped <= -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
};

/**
 * Heading is a bearing from +Z, so forward is `(sin h, 0, cos h)` and a vehicle
 * modelled along +Z needs only `rotation.y = h`. Local +X is then the right-hand
 * side of the direction of travel, which is what the cant sign depends on.
 */
const forwardX = (heading: number) => Math.sin(heading);
const forwardZ = (heading: number) => Math.cos(heading);
const rightX = (heading: number) => Math.cos(heading);
const rightZ = (heading: number) => -Math.sin(heading);

type Pose = { x: number; y: number; z: number; heading: number; roll: number; grade: number };

type Structure = 'grade' | 'fill' | 'cut' | 'bridge';

type Alignment = {
  count: number;
  step: number;
  length: number;
  x: Float64Array;
  z: Float64Array;
  y: Float64Array;
  heading: Float64Array;
  /** Signed roll angle, outer rail high. */
  roll: Float64Array;
  ground: Float64Array;
  structure: Structure[];
  at: (chainage: number, out: Pose) => Pose;
};

type Element =
  | { kind: 'line'; x: number; z: number; heading: number; length: number }
  | { kind: 'arc'; x: number; z: number; heading: number; length: number; curvature: number };

type PlanPoint = { x: number; z: number };

/**
 * Tangents joined by circular curves, which is how a railway is actually laid
 * out and the only construction that makes a minimum radius mean something. A
 * spline through the same points would quietly produce 40 m curves on a line
 * whose stock needs 400.
 */
const buildElements = (points: PlanPoint[], random: () => number): Element[] => {
  const elements: Element[] = [];
  const bearings: number[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    bearings.push(Math.atan2(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z));
  }

  const legLength = (i: number) => Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);

  let heading = bearings[0];
  let tangentIn = 0;

  for (let i = 0; i < points.length - 1; i += 1) {
    const leg = legLength(i);
    let tangentOut = 0;
    let turn = 0;
    let radius = 0;

    if (i + 1 <= points.length - 2) {
      turn = wrapAngle(bearings[i + 1] - heading);
      if (Math.abs(turn) > 2e-3) {
        // Half-tangents may never eat more than nine tenths of a leg between
        // them, which is what keeps the straights from going negative.
        const room = 0.45 * Math.min(leg, legLength(i + 1));
        radius = MIN_RADIUS * (1 + random() * 1.5);
        tangentOut = radius * Math.tan(Math.abs(turn) / 2);
        if (tangentOut > room) {
          tangentOut = room;
          radius = room / Math.tan(Math.abs(turn) / 2);
        }
      }
    }

    const straight = leg - tangentIn - tangentOut;
    if (straight > 0.25) {
      elements.push({
        kind: 'line',
        x: points[i].x + forwardX(heading) * tangentIn,
        z: points[i].z + forwardZ(heading) * tangentIn,
        heading,
        length: straight,
      });
    }

    if (tangentOut > 0) {
      const curvature = Math.sign(turn) / radius;
      elements.push({
        kind: 'arc',
        x: points[i].x + forwardX(heading) * (leg - tangentOut),
        z: points[i].z + forwardZ(heading) * (leg - tangentOut),
        heading,
        length: Math.abs(turn) * radius,
        curvature,
      });
      heading += turn;
    }

    tangentIn = tangentOut;
  }

  // Legs shorter than their own half-tangents produce no straight and no curve.
  // Returning an empty list would have `samplePlan` read `elements[0]`.
  if (elements.length === 0 && points.length >= 2) {
    const last = points.length - 1;
    const span = Math.hypot(points[last].x - points[0].x, points[last].z - points[0].z);
    elements.push({
      kind: 'line',
      x: points[0].x,
      z: points[0].z,
      heading: Math.atan2(points[last].x - points[0].x, points[last].z - points[0].z),
      length: Math.max(1, span),
    });
  }

  return elements;
};

type PlanSample = { x: number; z: number; heading: number; curvature: number };

const samplePlan = (elements: Element[], offsets: number[], chainage: number, out: PlanSample): PlanSample => {
  let index = 0;
  // `index < elements.length - 1` is the positive form on purpose: written as a
  // negation it admits a NaN chainage, and the body would then read past the end.
  while (index < elements.length - 1 && offsets[index + 1] <= chainage) index += 1;
  const element = elements[index];
  const u = Math.min(element.length, Math.max(0, chainage - offsets[index]));

  if (element.kind === 'line') {
    out.x = element.x + forwardX(element.heading) * u;
    out.z = element.z + forwardZ(element.heading) * u;
    out.heading = element.heading;
    out.curvature = 0;
    return out;
  }

  const k = element.curvature;
  const heading = element.heading + k * u;
  out.x = element.x + (Math.cos(element.heading) - Math.cos(heading)) / k;
  out.z = element.z + (Math.sin(heading) - Math.sin(element.heading)) / k;
  out.heading = heading;
  out.curvature = k;
  return out;
};

const boxBlur = (values: Float64Array, radius: number, passes: number): Float64Array => {
  let current = values;
  for (let pass = 0; pass < passes; pass += 1) {
    const source = current;
    const next = new Float64Array(source.length);
    for (let i = 0; i < source.length; i += 1) {
      let sum = 0;
      let count = 0;
      for (let d = -radius; d <= radius; d += 1) {
        const j = i + d;
        if (j < 0 || j >= source.length) continue;
        sum += source[j];
        count += 1;
      }
      next[i] = sum / count;
    }
    current = next;
  }
  return current;
};

/** Forces |dy/ds| <= MAX_GRADE everywhere. The backward sweep is what guarantees
 * it: each station is clamped against a neighbour that is never touched again. */
const limitGrade = (profile: Float64Array, step: number): void => {
  const limit = MAX_GRADE * step;
  for (let i = 1; i < profile.length; i += 1) {
    if (profile[i] > profile[i - 1] + limit) profile[i] = profile[i - 1] + limit;
    else if (profile[i] < profile[i - 1] - limit) profile[i] = profile[i - 1] - limit;
  }
  for (let i = profile.length - 2; i >= 0; i -= 1) {
    if (profile[i] > profile[i + 1] + limit) profile[i] = profile[i + 1] + limit;
    else if (profile[i] < profile[i + 1] - limit) profile[i] = profile[i + 1] - limit;
  }
};

/**
 * The vertical profile. A road can follow the ground; a railway cannot, so this
 * finds the lowest grade-limited line that still clears the water and never cuts
 * deeper than a cutting goes, under a ceiling that tightens towards the edges of
 * the map so the line leaves it near the ground rather than on a viaduct over
 * the rim where the heightfield sinks away.
 *
 * The ceiling used to be applied afterwards, by easing the solved profile back
 * onto the ground over the last thirty stations. That is a cliff, not a taper:
 * at Tà Xùa it eased two hundred metres of height over a hundred and fifty of
 * track and produced a 175% grade on a line specified for 2.5%. Bounds belong
 * inside the relaxation, with the grade sweep last so it is the constraint that
 * survives.
 */
const solveProfile = (ground: Float64Array, overWater: Uint8Array, step: number, waterLevel: number): Float64Array => {
  const count = ground.length;
  const target = new Float64Array(count);
  const lower = new Float64Array(count);
  const upper = new Float64Array(count);
  const taper = Math.max(4, Math.round((EDGE_TAPER * STATION_STEP) / step));

  for (let i = 0; i < count; i += 1) {
    target[i] = overWater[i] ? waterLevel + BRIDGE_CLEARANCE : ground[i] + RAIL_ABOVE_FORMATION;
    lower[i] = overWater[i] ? waterLevel + BRIDGE_CLEARANCE * 0.7 : ground[i] + RAIL_ABOVE_FORMATION - MAX_CUT;
    const fromEdge = Math.min(i, count - 1 - i);
    upper[i] = fromEdge >= taper ? Number.POSITIVE_INFINITY : target[i] + VIADUCT_FILL * clamp01(fromEdge / taper);
  }

  const blurRadius = Math.max(2, Math.round(190 / step));
  const profile = boxBlur(target, blurRadius, 2).slice();

  for (let pass = 0; pass < 14; pass += 1) {
    for (let i = 0; i < count; i += 1) {
      if (profile[i] < lower[i]) profile[i] = lower[i];
      if (profile[i] > upper[i]) profile[i] = upper[i];
    }
    limitGrade(profile, step);
  }

  // Averaging a bounded-slope sequence cannot steepen its interior, but the
  // window truncates at the ends, so the grade is re-imposed after it.
  const smoothed = boxBlur(profile, 2, 1);
  limitGrade(smoothed, step);
  return smoothed;
};

const cantAngleFor = (curvature: number): number => {
  if (curvature === 0) return 0;
  const radius = 1 / Math.abs(curvature);
  // Equilibrium cant, taken at nine tenths as practice does, capped at what
  // metre gauge tolerates.
  const cant = Math.min(MAX_CANT, (0.9 * RAIL_CENTRES * DESIGN_SPEED * DESIGN_SPEED) / (9.81 * radius));
  // A right-hand curve raises the left rail, which rolls the track toward -X.
  return -Math.sign(curvature) * Math.asin(cant / RAIL_CENTRES);
};

const buildAlignment = (
  points: PlanPoint[],
  random: () => number,
  terrain: Terrain,
  waterLevel: number,
  step: number
): Alignment => {
  const elements = buildElements(points, random);
  const offsets: number[] = [];
  let total = 0;
  for (const element of elements) {
    offsets.push(total);
    total += element.length;
  }

  const count = Math.max(2, Math.floor(total / step) + 1);
  const x = new Float64Array(count);
  const z = new Float64Array(count);
  const heading = new Float64Array(count);
  const curvature = new Float64Array(count);
  const ground = new Float64Array(count);
  const overWater = new Uint8Array(count);

  const sample: PlanSample = { x: 0, z: 0, heading: 0, curvature: 0 };
  for (let i = 0; i < count; i += 1) {
    samplePlan(elements, offsets, i * step, sample);
    x[i] = sample.x;
    z[i] = sample.z;
    heading[i] = sample.heading;
    curvature[i] = sample.curvature;
    ground[i] = terrain.heightAt(sample.x, sample.z);
    overWater[i] = ground[i] < waterLevel - 0.2 ? 1 : 0;
  }

  const y = solveProfile(ground, overWater, step, waterLevel);
  const roll = new Float64Array(count);
  for (let i = 0; i < count; i += 1) roll[i] = cantAngleFor(curvature[i]);

  const structure: Structure[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const fill = y[i] - RAIL_ABOVE_FORMATION - ground[i];
    if (overWater[i] || fill > VIADUCT_FILL) structure[i] = 'bridge';
    else if (fill > 0.7) structure[i] = 'fill';
    else if (fill < -1.1) structure[i] = 'cut';
    else structure[i] = 'grade';
  }
  // A four station bridge is a culvert with ambitions, and a four station gap in
  // the middle of one is worse. Short runs join whatever surrounds them.
  for (let pass = 0; pass < 2; pass += 1) {
    let runStart = 0;
    for (let i = 1; i <= count; i += 1) {
      if (i < count && structure[i] === structure[runStart]) continue;
      const length = i - runStart;
      const minimum = structure[runStart] === 'bridge' ? Math.ceil(26 / step) : Math.ceil(14 / step);
      if (length < minimum && runStart > 0) {
        const replacement = structure[runStart - 1];
        for (let j = runStart; j < i; j += 1) structure[j] = replacement;
      }
      runStart = i;
    }
  }

  const at = (chainage: number, out: Pose): Pose => {
    // A NaN chainage would survive every clamp below — `Math.min(a, NaN)` is NaN
    // and every comparison against NaN is false — and index the arrays with
    // `undefined`, poisoning the whole pose silently. Reject it at the door.
    const clamped = Number.isFinite(chainage) ? Math.min(total, Math.max(0, chainage)) : 0;
    const grid = clamped / step;
    const index = Math.max(0, Math.min(count - 2, Math.floor(grid)));
    const f = grid - index;
    out.x = x[index] + (x[index + 1] - x[index]) * f;
    out.z = z[index] + (z[index + 1] - z[index]) * f;
    out.y = y[index] + (y[index + 1] - y[index]) * f;
    out.heading = heading[index] + (heading[index + 1] - heading[index]) * f;
    out.roll = roll[index] + (roll[index + 1] - roll[index]) * f;
    out.grade = (y[index + 1] - y[index]) / step;
    return out;
  };

  return { count, step, length: total, x, z, y, heading, roll, ground, structure, at };
};

/** Deepest cutting the module will build. Past this a real line bores a tunnel,
 * which nothing here models. */
const CUT_CEILING = MAX_CUT * 2.5;
/** Tallest viaduct the truss design carries on dry land. */
const FILL_CEILING = VIADUCT_FILL * 3;
/** Longest single bridge. Cầu Long Biên is 1.7 km and is the longest in the country. */
const MAX_BRIDGE_RUN = 1800;
/** Past this the line is a bridge with some track attached, not a railway. */
const MAX_BRIDGE_SHARE = 0.55;

type Assessment = { buildable: boolean; cost: number; maxCut: number; maxDryFill: number; bridgeShare: number };

/**
 * What the earthworks cost, and whether they are earthworks at all. Depth of
 * cutting and height of fill are not soft preferences on a railway: a 230 m cut
 * is a tunnel and a 260 m embankment is not a thing that exists, so a corridor
 * demanding either is rejected rather than merely priced.
 */
const assessAlignment = (alignment: Alignment, waterLevel: number): Assessment => {
  const step = alignment.step;
  let cost = 0;
  let maxCut = 0;
  let maxDryFill = 0;
  let bridgeStations = 0;
  let run = 0;
  let longestRun = 0;

  for (let i = 0; i < alignment.count; i += 1) {
    const fill = alignment.y[i] - RAIL_ABOVE_FORMATION - alignment.ground[i];
    const overWater = alignment.ground[i] < waterLevel - 0.2;
    maxCut = Math.max(maxCut, -fill);
    if (overWater) cost += step * 46;
    else {
      maxDryFill = Math.max(maxDryFill, fill);
      if (fill > VIADUCT_FILL) cost += step * 30;
      else cost += Math.pow(Math.abs(fill), 1.35) * step * (fill > 0 ? 1 : 1.35);
    }

    if (overWater || fill > VIADUCT_FILL) {
      bridgeStations += 1;
      run += 1;
      longestRun = Math.max(longestRun, run);
    } else run = 0;
  }

  const bridgeShare = alignment.count > 0 ? bridgeStations / alignment.count : 1;
  const buildable =
    maxCut <= CUT_CEILING &&
    maxDryFill <= FILL_CEILING &&
    longestRun * step <= MAX_BRIDGE_RUN &&
    bridgeShare <= MAX_BRIDGE_SHARE;

  return { buildable, cost, maxCut, maxDryFill, bridgeShare };
};

/**
 * Route selection, done the way it is done on the ground: lay several corridors
 * across the patch, cost each one's earthworks and bridging, and build the
 * cheapest that still passes the town. Bridges are priced high per metre, which
 * is exactly what makes the line cross a river at its narrowest point instead of
 * wherever the seed first pointed it.
 *
 * Returns null when no corridor is buildable, which is a real answer and not a
 * defect — whether a place *has* a line is `recipe.railway`'s business, but
 * whether the ground can carry one is this function's, and a patch can fail the
 * second test while passing the first.
 */
const choosePlan = (
  terrain: Terrain,
  waterLevel: number,
  random: () => number,
  town: { x: number; z: number } | null
): PlanPoint[] | null => {
  const half = terrain.size / 2;
  const reach = half * 1.04;
  let best: PlanPoint[] | null = null;
  let bestCost = Infinity;

  const scratch: PlanPoint[] = [];

  for (let candidate = 0; candidate < 24; candidate += 1) {
    const bearing = (candidate % 8) * (Math.PI / 8) + random() * 0.12;
    const offset = ((Math.floor(candidate / 8) - 1) * 0.42 + (random() * 2 - 1) * 0.08) * half;

    const axisX = forwardX(bearing);
    const axisZ = forwardZ(bearing);
    const acrossX = rightX(bearing);
    const acrossZ = rightZ(bearing);

    scratch.length = 0;
    const legs = 4;
    for (let i = 0; i <= legs; i += 1) {
      const along = (i / legs - 0.5) * 2 * reach;
      // The ends stay on the corridor axis so the line leaves the map square on;
      // only the interior points of intersection wander.
      const lateral = offset + (i === 0 || i === legs ? 0 : (random() * 2 - 1) * half * 0.26);
      scratch.push({ x: axisX * along + acrossX * lateral, z: axisZ * along + acrossZ * lateral });
    }

    const plan = scratch.map((point) => ({ ...point }));
    const trial = buildAlignment(plan, createPrng(`survey:${candidate}`), terrain, waterLevel, SURVEY_STEP);
    const assessment = assessAlignment(trial, waterLevel);
    if (!assessment.buildable) continue;

    let cost = assessment.cost;
    let closestToTown = Infinity;
    if (town) {
      for (let i = 0; i < trial.count; i += 1) {
        closestToTown = Math.min(closestToTown, Math.hypot(trial.x[i] - town.x, trial.z[i] - town.z));
      }
      // A railway that misses the only settlement on the map is a railway nobody
      // built, so serving the town is worth real earthwork — but as a discount
      // on the cost, not a subtraction from it. Written as a flat bonus it was
      // worth up to 154,000 against route costs of 40,000, which bought the
      // Hồ Tây line a kilometre and a half of truss straight across the lake to
      // reach a town centre on the far shore.
      if (Number.isFinite(closestToTown)) cost *= 1 - 0.35 * clamp01((700 - closestToTown) / 700);
    }

    if (cost < bestCost) {
      bestCost = cost;
      best = plan;
    }
  }

  return best;
};

type Shop = {
  geometry: <T extends Geometry>(geometry: T) => T;
  material: <T extends Material>(material: T) => T;
  instanced: (geometry: Geometry, material: Material, count: number) => InstancedMesh;
  dispose: () => void;
};

const createShop = (): Shop => {
  const geometries: Geometry[] = [];
  const materials: Material[] = [];
  const instances: InstancedMesh[] = [];

  return {
    geometry: (geometry) => {
      geometries.push(geometry);
      return geometry;
    },
    material: (material) => {
      materials.push(material);
      return material;
    },
    instanced: (geometry, material, count) => {
      const mesh = new InstancedMesh(geometry, material, count);
      mesh.frustumCulled = false;
      instances.push(mesh);
      return mesh;
    },
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const mesh of instances) mesh.dispose();
    },
  };
};

/** Positions and indices for a strip of quads swept along the alignment. */
type Ribbon = { positions: number[]; indices: number[]; columns: number; rows: number; runStart: number };

const createRibbon = (columns: number): Ribbon => ({ positions: [], indices: [], columns, rows: 0, runStart: 0 });

const pushRibbonRow = (ribbon: Ribbon): void => {
  if (ribbon.rows > ribbon.runStart) {
    const previous = (ribbon.rows - 1) * ribbon.columns;
    const current = ribbon.rows * ribbon.columns;
    for (let c = 0; c < ribbon.columns - 1; c += 1) {
      const a = previous + c;
      const b = current + c;
      ribbon.indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  ribbon.rows += 1;
};

/**
 * Ends the current strip. `rows` has to keep counting, because it is the index
 * the next row's vertices land at: resetting it to zero quads the new run onto
 * the first run's vertices and throws a quad across the whole map.
 */
const breakRibbon = (ribbon: Ribbon): void => {
  ribbon.runStart = ribbon.rows;
};

const ribbonGeometry = (ribbon: Ribbon): BufferGeometry | null => {
  if (ribbon.indices.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(ribbon.positions), 3));
  geometry.setIndex(ribbon.indices);
  geometry.computeVertexNormals();
  return geometry;
};

/**
 * 43 kg/m rail in section, reduced to eight points. The web pinch is what reads
 * as rail rather than as a bar laid on its side.
 */
const RAIL_PROFILE: [number, number][] = [
  [-0.057, 0],
  [0.057, 0],
  [0.014, 0.042],
  [0.014, 0.112],
  [0.035, 0.14],
  [-0.035, 0.14],
  [-0.014, 0.112],
  [-0.014, 0.042],
];

type TrackGeometries = {
  ballast: BufferGeometry | null;
  railBody: BufferGeometry | null;
  railHead: BufferGeometry | null;
  fill: BufferGeometry | null;
  cut: BufferGeometry | null;
};

const buildTrackGeometries = (alignment: Alignment, terrain: Terrain): TrackGeometries => {
  const formation = -RAIL_ABOVE_FORMATION;
  const shoulder = -(RAIL_HEIGHT + SLEEPER_DEPTH);
  const toe = BALLAST_CROWN_HALF + FILL_SLOPE * BALLAST_DEPTH;

  const ballast = createRibbon(4);
  const railBody = createRibbon(RAIL_PROFILE.length * 2 + 2);
  const railHead = createRibbon(4);
  const fillLeft = createRibbon(2);
  const fillRight = createRibbon(2);
  const cutLeft = createRibbon(3);
  const cutRight = createRibbon(3);

  const place = (ribbon: Ribbon, i: number, across: number, up: number) => {
    const cant = alignment.roll[i];
    // Rotating the section by the cant angle is the difference between canted
    // track and track with one rail arbitrarily higher than the other.
    const a = across * Math.cos(cant) - up * Math.sin(cant);
    const u = across * Math.sin(cant) + up * Math.cos(cant);
    const h = alignment.heading[i];
    ribbon.positions.push(alignment.x[i] + rightX(h) * a, alignment.y[i] + u, alignment.z[i] + rightZ(h) * a);
  };

  let fillRun = false;
  let cutRun = false;

  for (let i = 0; i < alignment.count; i += 1) {
    const structure = alignment.structure[i];
    const fillHeight = alignment.y[i] + formation - alignment.ground[i];

    if (structure !== 'bridge') {
      place(ballast, i, -toe, formation);
      place(ballast, i, -BALLAST_CROWN_HALF, shoulder);
      place(ballast, i, BALLAST_CROWN_HALF, shoulder);
      place(ballast, i, toe, formation);
      pushRibbonRow(ballast);
    } else {
      // Finishing the strip here and restarting it after the bridge is what
      // stops a single quad spanning the gap at ballast level.
      breakRibbon(ballast);
    }

    for (const [index, rail] of [-RAIL_CENTRES / 2, RAIL_CENTRES / 2].entries()) {
      for (const [px, py] of RAIL_PROFILE) {
        place(railBody, i, rail + px, py - RAIL_HEIGHT);
      }
      if (index === 0) {
        // One degenerate column between the two rails keeps both in a single
        // strip without a visible web joining them.
        place(railBody, i, rail + 0.057, -RAIL_HEIGHT);
        place(railBody, i, RAIL_CENTRES / 2 - 0.057, -RAIL_HEIGHT);
      }
    }
    pushRibbonRow(railBody);

    place(railHead, i, -RAIL_CENTRES / 2 - RAIL_HEAD_WIDTH / 2, 0.0008);
    place(railHead, i, -RAIL_CENTRES / 2 + RAIL_HEAD_WIDTH / 2, 0.0008);
    place(railHead, i, RAIL_CENTRES / 2 - RAIL_HEAD_WIDTH / 2, 0.0008);
    place(railHead, i, RAIL_CENTRES / 2 + RAIL_HEAD_WIDTH / 2, 0.0008);
    pushRibbonRow(railHead);

    if (structure === 'fill' || (structure === 'grade' && fillRun && fillHeight > 0.1)) {
      const height = Math.max(0.05, fillHeight);
      const spread = toe + FILL_SLOPE * height;
      place(fillLeft, i, -toe, formation);
      place(fillLeft, i, -spread, formation - height);
      pushRibbonRow(fillLeft);
      place(fillRight, i, toe, formation);
      place(fillRight, i, spread, formation - height);
      pushRibbonRow(fillRight);
      fillRun = true;
    } else if (fillRun) {
      breakRibbon(fillLeft);
      breakRibbon(fillRight);
      fillRun = false;
    }

    if (structure === 'cut') {
      const depth = Math.max(0.3, -fillHeight);
      // Rock stands steeper than soil, and the terrain already knows which of
      // the two the line is cutting through.
      const ratio = terrain.slopeAt(alignment.x[i], alignment.z[i]) > 0.9 ? 0.55 : CUT_SLOPE;
      const crest = toe + CESS + ratio * depth;
      place(cutLeft, i, -toe, formation);
      place(cutLeft, i, -(toe + CESS), formation);
      place(cutLeft, i, -crest, formation + depth);
      pushRibbonRow(cutLeft);
      place(cutRight, i, toe, formation);
      place(cutRight, i, toe + CESS, formation);
      place(cutRight, i, crest, formation + depth);
      pushRibbonRow(cutRight);
      cutRun = true;
    } else if (cutRun) {
      breakRibbon(cutLeft);
      breakRibbon(cutRight);
      cutRun = false;
    }
  }

  const merge = (parts: (BufferGeometry | null)[]): BufferGeometry | null => {
    const present = parts.filter((part): part is BufferGeometry => part !== null);
    if (present.length === 0) return null;
    if (present.length === 1) return present[0];
    const merged = mergeGeometries(present);
    for (const part of present) part.dispose();
    return merged;
  };

  return {
    ballast: ribbonGeometry(ballast),
    railBody: ribbonGeometry(railBody),
    railHead: ribbonGeometry(railHead),
    fill: merge([ribbonGeometry(fillLeft), ribbonGeometry(fillRight)]),
    cut: merge([ribbonGeometry(cutLeft), ribbonGeometry(cutRight)]),
  };
};

const STRUT_DIR = new Vector3();
const STRUT_MID = new Vector3();
const STRUT_Q = new Quaternion();
const STRUT_SCALE = new Vector3();

/** A straight member between two world points, as a matrix for a unit box. */
const strutMatrix = (a: Vector3, b: Vector3, width: number, thickness: number, out: Matrix4): Matrix4 => {
  STRUT_DIR.subVectors(b, a);
  const length = STRUT_DIR.length() || 0.001;
  STRUT_MID.addVectors(a, b).multiplyScalar(0.5);
  STRUT_Q.setFromUnitVectors(Y_AXIS, STRUT_DIR.divideScalar(length));
  STRUT_SCALE.set(width, length, thickness);
  return out.compose(STRUT_MID, STRUT_Q, STRUT_SCALE);
};

type BridgeRun = { from: number; to: number };

type BridgePlan = {
  struts: Matrix4[];
  piers: { x: number; z: number; base: number; top: number; radius: number; inWater: boolean }[];
  caps: Matrix4[];
  timbers: Set<number>;
};

/**
 * Where the line crosses water or a ravine it goes onto a through truss: two
 * Warren trusses either side of the track, cross girders and stringers under it,
 * portal and top lateral bracing, standing on tapered piers. Every member is one
 * instance of the same box, so the whole bridge is a single draw call.
 */
const planBridges = (alignment: Alignment, terrain: Terrain, waterLevel: number): BridgePlan => {
  const runs: BridgeRun[] = [];
  let start = -1;
  for (let i = 0; i < alignment.count; i += 1) {
    if (alignment.structure[i] === 'bridge') {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push({ from: start, to: i - 1 });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ from: start, to: alignment.count - 1 });

  const struts: Matrix4[] = [];
  const caps: Matrix4[] = [];
  const piers: BridgePlan['piers'] = [];
  const timbers = new Set<number>();

  const pose: Pose = { x: 0, y: 0, z: 0, heading: 0, roll: 0, grade: 0 };
  const a = new Vector3();
  const b = new Vector3();

  const pointAt = (chainage: number, across: number, up: number, out: Vector3): Vector3 => {
    alignment.at(chainage, pose);
    return out.set(pose.x + rightX(pose.heading) * across, pose.y + up, pose.z + rightZ(pose.heading) * across);
  };

  const member = (sa: number, va: number, wa: number, sb: number, vb: number, wb: number, size: number) => {
    pointAt(sa, va, wa, a);
    pointAt(sb, vb, wb, b);
    struts.push(strutMatrix(a, b, size, size, new Matrix4()));
  };

  const DECK = -(RAIL_HEIGHT + SLEEPER_DEPTH);
  const STRINGER = DECK - 0.25;
  const CHORD = DECK - 1.0;
  const TRUSS_HALF = 2.2;

  for (const run of runs) {
    for (let i = run.from; i <= run.to; i += 1) timbers.add(i);

    const fromChainage = run.from * alignment.step;
    const toChainage = run.to * alignment.step;
    const total = toChainage - fromChainage;
    if (total < 12) continue;

    const spanCount = Math.max(1, Math.round(total / 34));
    const spanLength = total / spanCount;
    const trussed = spanLength >= 22;
    const height = Math.min(8.5, Math.max(4.6, spanLength / 6.5));
    const top = CHORD + height;

    for (let span = 0; span < spanCount; span += 1) {
      const s0 = fromChainage + span * spanLength;
      const s1 = s0 + spanLength;
      const panels = Math.max(4, Math.round(spanLength / 5.6));
      const panel = spanLength / panels;

      for (const side of [-TRUSS_HALF, TRUSS_HALF]) {
        member(s0, side, CHORD, s1, side, CHORD, 0.4);
        if (!trussed) {
          // A plate girder is one deep web, not a lattice.
          member(s0, side, CHORD + 0.75, s1, side, CHORD + 0.75, 1.5);
          continue;
        }
        member(s0, side, top, s1, side, top, 0.36);
        for (let p = 0; p <= panels; p += 1) {
          const s = s0 + p * panel;
          const end = p === 0 || p === panels;
          member(s, side, CHORD, s, side, top, end ? 0.42 : 0.26);
        }
        for (let p = 0; p < panels; p += 1) {
          const s = s0 + p * panel;
          if (p % 2 === 0) member(s, side, CHORD, s + panel, side, top, 0.24);
          else member(s, side, top, s + panel, side, CHORD, 0.24);
        }
      }

      // Cross girders carry the stringers, the stringers carry the sleepers.
      const crossStep = Math.max(2, panel / 2);
      for (let s = s0; s <= s1 + 0.01; s += crossStep) {
        member(Math.min(s, s1), -TRUSS_HALF, CHORD, Math.min(s, s1), TRUSS_HALF, CHORD, 0.34);
      }
      for (const rail of [-RAIL_CENTRES / 2, RAIL_CENTRES / 2]) {
        member(s0, rail, STRINGER, s1, rail, STRINGER, 0.46);
      }

      if (trussed) {
        for (let p = 0; p <= panels; p += 1) {
          const s = s0 + p * panel;
          member(s, -TRUSS_HALF, top, s, TRUSS_HALF, top, 0.26);
          if (p < panels) {
            member(s, -TRUSS_HALF, top, s + panel, TRUSS_HALF, top, 0.17);
            member(s, TRUSS_HALF, top, s + panel, -TRUSS_HALF, top, 0.17);
          }
        }
        // Portal bracing: the knee braces at the end posts are what keep a
        // through truss from reading as two flat ladders.
        for (const s of [s0, s1]) {
          const inward = s === s0 ? panel * 0.5 : -panel * 0.5;
          member(s, -TRUSS_HALF, top - 1.3, s + inward, -TRUSS_HALF, top, 0.2);
          member(s, TRUSS_HALF, top - 1.3, s + inward, TRUSS_HALF, top, 0.2);
        }
      }

      // A refuge walkway down one side, with a handrail.
      member(s0, TRUSS_HALF + 0.55, CHORD + 0.1, s1, TRUSS_HALF + 0.55, CHORD + 0.1, 0.9);
      member(s0, TRUSS_HALF + 0.95, CHORD + 1.15, s1, TRUSS_HALF + 0.95, CHORD + 1.15, 0.08);

      if (span < spanCount - 1) {
        alignment.at(s1, pose);
        const bed = terrain.heightAt(pose.x, pose.z);
        const inWater = bed < waterLevel - 0.2;
        piers.push({
          x: pose.x,
          z: pose.z,
          base: inWater ? bed - 1.5 : bed - 0.8,
          top: pose.y + CHORD - 0.55,
          radius: 1.35,
          inWater,
        });
        pointAt(s1, -TRUSS_HALF - 0.6, CHORD - 0.3, a);
        pointAt(s1, TRUSS_HALF + 0.6, CHORD - 0.3, b);
        caps.push(strutMatrix(a, b, 2.4, 0.55, new Matrix4()));
      }
    }

    // Abutments: a short buried wall at each end rather than a pier standing in
    // the open, because that is what the embankment hands the bridge to.
    for (const [chainage, direction] of [
      [fromChainage, -1],
      [toChainage, 1],
    ] as const) {
      alignment.at(chainage, pose);
      const bed = terrain.heightAt(pose.x, pose.z);
      pointAt(chainage + direction * 1.4, -TRUSS_HALF - 1.0, CHORD - 0.4, a);
      pointAt(chainage + direction * 1.4, TRUSS_HALF + 1.0, CHORD - 0.4, b);
      caps.push(strutMatrix(a, b, 3.2, 1.0, new Matrix4()));
      piers.push({
        x: pose.x + forwardX(pose.heading) * direction * 1.4,
        z: pose.z + forwardZ(pose.heading) * direction * 1.4,
        base: Math.min(bed, waterLevel) - 1.0,
        top: pose.y + CHORD - 0.6,
        radius: 1.9,
        inWater: false,
      });
    }
  }

  return { struts, piers, caps, timbers };
};

type Palette = {
  ballast: MeshStandardMaterial;
  railBody: MeshStandardMaterial;
  railHead: MeshStandardMaterial;
  timber: MeshStandardMaterial;
  fill: MeshStandardMaterial;
  rock: MeshStandardMaterial;
  steel: MeshStandardMaterial;
  concrete: MeshStandardMaterial;
  asphalt: MeshStandardMaterial;
  paintRed: MeshStandardMaterial;
  paintWhite: MeshStandardMaterial;
  bodyLoco: MeshStandardMaterial;
  bodyCoach: MeshStandardMaterial;
  bodyCream: MeshStandardMaterial;
  roof: MeshStandardMaterial;
  underframe: MeshStandardMaterial;
  tile: MeshStandardMaterial;
};

const createPalette = (shop: Shop, recipe: LocationRecipe): Palette => {
  const standard = (options: Record<string, unknown>) =>
    shop.material(new MeshStandardMaterial({ flatShading: true, metalness: 0, ...options }));

  const soil = new Color(recipe.ground.low).lerp(new Color('#6d5b45'), 0.6);

  return {
    ballast: standard({ color: '#6f6a62', roughness: 0.97 }),
    railBody: standard({ color: '#473f38', roughness: 0.62, metalness: 0.4 }),
    // The whole image of a railway at dusk is two bright lines, and this is the
    // material that makes them.
    railHead: standard({ color: '#bdb8ae', roughness: 0.2, metalness: 0.82 }),
    timber: standard({ color: '#4d4034', roughness: 0.93 }),
    fill: standard({ color: soil, roughness: 0.96 }),
    rock: standard({ color: recipe.ground.rock, roughness: 0.94 }),
    steel: standard({ color: '#5d6a6c', roughness: 0.56, metalness: 0.45 }),
    concrete: standard({ color: '#9b978f', roughness: 0.9 }),
    asphalt: standard({ color: '#3b3a38', roughness: 0.88 }),
    paintRed: standard({ color: '#b43328', roughness: 0.74 }),
    paintWhite: standard({ color: '#e6e1d6', roughness: 0.78 }),
    bodyLoco: standard({ color: '#9d3a2c', roughness: 0.6 }),
    bodyCoach: standard({ color: '#2e5574', roughness: 0.6 }),
    bodyCream: standard({ color: '#d9cfb4', roughness: 0.66 }),
    roof: standard({ color: '#8d9095', roughness: 0.72, metalness: 0.2 }),
    underframe: standard({ color: '#33363a', roughness: 0.84, metalness: 0.2 }),
    tile: standard({ color: recipe.ground.roof, roughness: 0.9, side: DoubleSide }),
  };
};

type Lamp = { material: MeshBasicMaterial; day: number; night: number };

type Vehicle = {
  body: Object3D;
  bogies: Object3D[];
  /** Metres between bogie centres. */
  bogieCentres: number;
  /** Coupled length, nose to nose. */
  pitch: number;
  wheelRadius: number;
  /** Indices into the train-wide wheel pool, grouped per bogie. */
  wheelSlots: number[][];
};

const SMOKE_LIFE = 8;
const SMOKE_PUFFS = 30;

const SMOKE_VERTEX = /* glsl */ `
  attribute float aBirth;
  attribute float aSeed;

  uniform float uTime;
  uniform float uPixelRatio;

  varying float vAge;
  varying float vSeed;

  void main() {
    float age = uTime - aBirth;
    vAge = age / ${SMOKE_LIFE.toFixed(1)};
    vSeed = aSeed;

    // Exhaust rises and is pulled apart; doing it here means the ring buffer is
    // only written when a puff is born.
    vec3 drift = vec3(sin(aSeed * 21.7) * 0.9, 1.15, cos(aSeed * 33.1) * 0.9) * age;
    vec4 view = viewMatrix * modelMatrix * vec4(position + drift, 1.0);
    gl_Position = projectionMatrix * view;
    gl_PointSize = (uPixelRatio * (70.0 + 900.0 * vAge)) / max(-view.z, 1.0);
  }
`;

const SMOKE_FRAGMENT = /* glsl */ `
  uniform float uOpacity;

  varying float vAge;
  varying float vSeed;

  void main() {
    if (vAge < 0.0 || vAge > 1.0) discard;
    float radius = length(gl_PointCoord - 0.5) * 2.0;
    if (radius > 1.0) discard;

    float core = pow(1.0 - radius, 1.7);
    float fade = (1.0 - vAge) * smoothstep(0.0, 0.08, vAge);
    float alpha = core * fade * uOpacity;
    gl_FragColor = vec4(mix(vec3(0.17, 0.16, 0.15), vec3(0.40, 0.39, 0.37), vSeed), alpha);
  }
`;

export type Railway = {
  group: Group;
  update: (elapsed: number) => void;
  setNight: (amount: number) => void;
  /** Embankments, bridges and the platform, for the walker's collision index. */
  obstacles: Obstacle[];
  /**
   * The formation where it stands clear of the ground — truss bridges and the
   * embankment crest — as walkable spans, for `walker.setPlatforms`. Narrow on
   * purpose: it is the width of the sleepers, and stepping off them on a bridge
   * is stepping off the bridge.
   */
  decks: Platform[];
  /**
   * False when there is no line here — either `recipe.railway` is null, or the
   * terrain cannot carry one at the ruling grade. The group is then empty on
   * purpose, not by accident.
   */
  built: boolean;
  dispose: () => void;
};

export type RailwayOptions = {
  /** Town buildings, so the station and the crossing land where people are. */
  buildings?: { x: number; z: number }[];
  /** Sleeper pitch in metres. 0.6 is real; raise it to buy back instances. */
  sleeperSpacing?: number;
};

/**
 * Tàu lửa đường ray. A metre gauge single track crossing the map on its own
 * alignment — grades under 2.5%, curves no tighter than four hundred metres,
 * carried on embankment, sunk in cutting and thrown over the water on a truss —
 * with a diesel and a rake of coaches that come through every few minutes and
 * bend properly through the curves because every bogie follows the rail itself.
 *
 * Builds nothing where `recipe.railway` is null. Most of Vietnam has no railway
 * anywhere near it, and a line that is not there is a worse error than a line
 * that is plain, because someone who has stood on the ridge knows.
 */
export const createRailway = (terrain: Terrain, recipe: LocationRecipe, options: RailwayOptions = {}): Railway => {
  const random = createPrng(`${recipe.seed}:railway`);
  const shop = createShop();
  const group = new Group();
  group.name = 'railway';

  const line = recipe.railway;
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const palette = createPalette(shop, recipe);
  const lamps: Lamp[] = [];
  const basic = (options_: Record<string, unknown>) => shop.material(new MeshBasicMaterial(options_));
  const lamp = (color: string, day: number, night: number): MeshBasicMaterial => {
    const material = basic({ color, transparent: true, opacity: day });
    lamps.push({ material, day, night });
    return material;
  };
  const glow = (color: string, night: number): MeshBasicMaterial => {
    const material = basic({ color, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false });
    lamps.push({ material, day: 0, night });
    return material;
  };

  const buildings = options.buildings ?? [];
  const townCentre = buildings.length
    ? buildings.reduce(
        (sum, building) => ({ x: sum.x + building.x / buildings.length, z: sum.z + building.z / buildings.length }),
        { x: 0, z: 0 }
      )
    : recipe.town
      ? { x: 0, z: 0 }
      : null;

  // Nothing has been added to the group yet, so bailing out only has to release
  // the palette the shop is already holding.
  const unbuilt = (): Railway => ({
    group,
    update: () => {},
    setNight: () => {},
    obstacles: [],
    decks: [],
    built: false,
    dispose: () => shop.dispose(),
  });

  if (!line) return unbuilt();

  const plan = choosePlan(terrain, waterLevel, random, townCentre);
  if (!plan) return unbuilt();

  const alignment = buildAlignment(
    plan,
    createPrng(`${recipe.seed}:railway:curves`),
    terrain,
    waterLevel,
    STATION_STEP
  );
  // The corridor was judged at the 20 m survey step; the 5 m stations can expose
  // a cutting the coarse pass sampled straight over.
  if (!assessAlignment(alignment, waterLevel).buildable) return unbuilt();

  const obstacles: Obstacle[] = [];
  const pose: Pose = { x: 0, y: 0, z: 0, heading: 0, roll: 0, grade: 0 };

  // --- permanent way -------------------------------------------------------
  const track = buildTrackGeometries(alignment, terrain);
  const addStatic = (geometry: BufferGeometry | null, material: Material, shadows: boolean) => {
    if (!geometry) return;
    const mesh = new Mesh(shop.geometry(geometry), material);
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  addStatic(track.fill, palette.fill, true);
  addStatic(track.cut, palette.rock, false);
  addStatic(track.ballast, palette.ballast, false);
  addStatic(track.railBody, palette.railBody, false);
  addStatic(track.railHead, palette.railHead, false);

  const bridges = planBridges(alignment, terrain, waterLevel);

  const sleeperSpacing = Math.max(0.4, options.sleeperSpacing ?? 0.6);
  const sleeperCount = Math.min(16000, Math.floor(alignment.length / sleeperSpacing));
  const sleeperGeometry = shop.geometry(new BoxGeometry(SLEEPER_LENGTH, SLEEPER_DEPTH, SLEEPER_WIDTH));
  const sleepers = shop.instanced(sleeperGeometry, palette.timber, sleeperCount);
  sleepers.receiveShadow = true;
  group.add(sleepers);

  const jointCount = Math.max(1, Math.floor(alignment.length / RAIL_LENGTH)) * 2;
  const fishplateGeometry = shop.geometry(new BoxGeometry(0.02, 0.1, 0.42));
  const fishplates = shop.instanced(fishplateGeometry, palette.railBody, jointCount);
  group.add(fishplates);

  {
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const euler = new Object3D();
    euler.rotation.order = 'YXZ';

    for (let i = 0; i < sleeperCount; i += 1) {
      const chainage = (i + 0.5) * sleeperSpacing;
      alignment.at(chainage, pose);
      const index = Math.min(alignment.count - 1, Math.round(chainage / alignment.step));
      const onBridge = bridges.timbers.has(index);

      euler.rotation.set(-Math.atan(pose.grade), pose.heading, pose.roll);
      euler.updateMatrix();
      quaternion.setFromRotationMatrix(euler.matrix);
      position.set(pose.x - UP.x * 0, pose.y - RAIL_HEIGHT - SLEEPER_DEPTH / 2, pose.z);
      // Bridge timbers are wider than track sleepers; the same geometry stretched
      // is the cheapest way to say so.
      scale.set(onBridge ? BRIDGE_TIMBER_LENGTH / SLEEPER_LENGTH : 1, 1, 1);
      sleepers.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    }
    sleepers.instanceMatrix.needsUpdate = true;

    scale.set(1, 1, 1);
    for (let joint = 0; joint < jointCount / 2; joint += 1) {
      alignment.at(joint * RAIL_LENGTH, pose);
      euler.rotation.set(0, pose.heading, pose.roll);
      euler.updateMatrix();
      quaternion.setFromRotationMatrix(euler.matrix);
      for (const [side, rail] of [-RAIL_CENTRES / 2 - 0.058, RAIL_CENTRES / 2 + 0.058].entries()) {
        position.set(
          pose.x + rightX(pose.heading) * rail,
          pose.y - RAIL_HEIGHT * 0.45,
          pose.z + rightZ(pose.heading) * rail
        );
        fishplates.setMatrixAt(joint * 2 + side, matrix.compose(position, quaternion, scale));
      }
    }
    fishplates.instanceMatrix.needsUpdate = true;
  }

  // --- bridges -------------------------------------------------------------
  if (bridges.struts.length > 0) {
    const strutGeometry = shop.geometry(new BoxGeometry(1, 1, 1));
    const struts = shop.instanced(strutGeometry, palette.steel, bridges.struts.length);
    struts.castShadow = true;
    bridges.struts.forEach((matrix, index) => struts.setMatrixAt(index, matrix));
    struts.instanceMatrix.needsUpdate = true;
    group.add(struts);
  }
  if (bridges.caps.length > 0) {
    const capGeometry = shop.geometry(new BoxGeometry(1, 1, 1));
    const caps = shop.instanced(capGeometry, palette.concrete, bridges.caps.length);
    caps.castShadow = true;
    bridges.caps.forEach((matrix, index) => caps.setMatrixAt(index, matrix));
    caps.instanceMatrix.needsUpdate = true;
    group.add(caps);
  }
  if (bridges.piers.length > 0) {
    // A four sided cylinder is a tapered box; ten sides is a river pier with the
    // rounded nose the current gives it.
    const squareGeometry = shop.geometry(new CylinderGeometry(0.78, 1, 1, 4));
    const roundGeometry = shop.geometry(new CylinderGeometry(0.8, 1, 1, 10));
    const land = bridges.piers.filter((pier) => !pier.inWater);
    const water = bridges.piers.filter((pier) => pier.inWater);
    const matrix = new Matrix4();
    const position = new Vector3();
    const scale = new Vector3();
    const identity = new Quaternion();

    for (const [geometry, set] of [
      [squareGeometry, land],
      [roundGeometry, water],
    ] as const) {
      if (set.length === 0) continue;
      const mesh = shop.instanced(geometry, palette.concrete, set.length);
      mesh.castShadow = true;
      set.forEach((pier, index) => {
        const height = Math.max(1.5, pier.top - pier.base);
        position.set(pier.x, pier.base + height / 2, pier.z);
        scale.set(pier.radius, height, pier.radius);
        mesh.setMatrixAt(index, matrix.compose(position, identity, scale));
        obstacles.push({ x: pier.x, z: pier.z, radius: pier.radius + 0.4, bottom: pier.base, top: pier.top });
      });
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    }
  }

  // --- lineside ------------------------------------------------------------
  const sideOf = (chainage: number, across: number, up: number, target: Object3D) => {
    alignment.at(chainage, pose);
    target.position.set(pose.x + rightX(pose.heading) * across, pose.y + up, pose.z + rightZ(pose.heading) * across);
    target.rotation.order = 'YXZ';
    target.rotation.set(0, pose.heading, 0);
  };

  const kilometreCount = Math.max(1, Math.floor(alignment.length / 1000));
  {
    const postGeometry = shop.geometry(new BoxGeometry(0.22, 0.95, 0.13));
    const posts = shop.instanced(postGeometry, palette.concrete, kilometreCount);
    posts.castShadow = true;
    const marker = new Object3D();
    const matrix = new Matrix4();
    for (let km = 0; km < kilometreCount; km += 1) {
      sideOf((km + 0.5) * 1000, 2.9, -RAIL_ABOVE_FORMATION + 0.4, marker);
      marker.updateMatrix();
      posts.setMatrixAt(km, matrix.copy(marker.matrix));
    }
    posts.instanceMatrix.needsUpdate = true;
    group.add(posts);
  }

  // Colour light signals, spaced as blocks. Their aspects are driven by where
  // the train actually is, which is the whole reason to have them.
  type Signal = { chainage: number; red: MeshBasicMaterial; yellow: MeshBasicMaterial; green: MeshBasicMaterial };
  const signals: Signal[] = [];
  {
    const mastGeometry = shop.geometry(new CylinderGeometry(0.1, 0.12, 5.4, 7));
    const headGeometry = shop.geometry(new BoxGeometry(0.46, 1.5, 0.3));
    const hoodGeometry = shop.geometry(new CylinderGeometry(0.19, 0.24, 0.26, 10, 1, true));
    const lensGeometry = shop.geometry(new CircleGeometry(0.15, 10));
    const boxGeometry = shop.geometry(new BoxGeometry(0.55, 0.7, 0.4));
    const ladderGeometry = shop.geometry(new BoxGeometry(0.3, 4.4, 0.04));
    const plateGeometry = shop.geometry(new BoxGeometry(0.34, 0.5, 0.03));

    const blocks = Math.max(2, Math.min(6, Math.round(alignment.length / 950)));
    for (let block = 0; block < blocks; block += 1) {
      const chainage = ((block + 0.5) / blocks) * alignment.length;
      const index = Math.min(alignment.count - 1, Math.round(chainage / alignment.step));
      if (alignment.structure[index] === 'bridge') continue;

      const post = new Object3D();
      sideOf(chainage, 3.4, -RAIL_ABOVE_FORMATION, post);
      group.add(post);

      const mast = new Mesh(mastGeometry, palette.steel);
      mast.position.y = 2.7;
      mast.castShadow = true;
      post.add(mast);
      const ladder = new Mesh(ladderGeometry, palette.steel);
      ladder.position.set(0.2, 2.4, 0);
      post.add(ladder);
      const relay = new Mesh(boxGeometry, palette.concrete);
      relay.position.set(0.7, 0.35, 0.3);
      post.add(relay);
      const plate = new Mesh(plateGeometry, palette.paintWhite);
      plate.position.set(0, 1.5, 0.16);
      post.add(plate);

      const head = new Mesh(headGeometry, palette.steel);
      head.position.y = 5.5;
      head.castShadow = true;
      post.add(head);

      const red = lamp('#ff3b22', 0.18, 1);
      const yellow = lamp('#ffb02e', 0.18, 1);
      const green = lamp('#3cff8c', 0.18, 1);
      [red, yellow, green].forEach((material, index_) => {
        const hood = new Mesh(hoodGeometry, palette.steel);
        hood.position.set(0, 6.0 - index_ * 0.48, 0.26);
        hood.rotation.x = Math.PI / 2;
        post.add(hood);
        const lens = new Mesh(lensGeometry, material);
        lens.position.set(0, 6.0 - index_ * 0.48, 0.3);
        post.add(lens);
      });

      signals.push({ chainage, red, yellow, green });
    }
  }

  // --- station -------------------------------------------------------------
  /** Chainage where the line comes closest to a point, ignoring the bridges. */
  const nearestChainage = (x: number, z: number): number => {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < alignment.count; i += 1) {
      if (alignment.structure[i] === 'bridge') continue;
      const distance = Math.hypot(alignment.x[i] - x, alignment.z[i] - z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i * alignment.step;
      }
    }
    return best;
  };

  const PLATFORM_LENGTH = 62;
  const platformSide = random() < 0.5 ? -1 : 1;
  const stationChainage =
    line.station && townCentre
      ? Math.min(
          alignment.length - PLATFORM_LENGTH,
          Math.max(PLATFORM_LENGTH, nearestChainage(townCentre.x, townCentre.z))
        )
      : null;

  if (stationChainage !== null) {
    const platform = new Object3D();
    sideOf(stationChainage, platformSide * (1.75 + 2.4), -RAIL_ABOVE_FORMATION, platform);
    group.add(platform);

    const slabGeometry = shop.geometry(new BoxGeometry(4.8, 0.42, PLATFORM_LENGTH));
    const slab = new Mesh(slabGeometry, palette.concrete);
    slab.position.y = RAIL_ABOVE_FORMATION - 0.21 - 0.15;
    slab.receiveShadow = true;
    slab.castShadow = true;
    platform.add(slab);

    const copingGeometry = shop.geometry(new BoxGeometry(0.3, 0.06, PLATFORM_LENGTH));
    const coping = new Mesh(copingGeometry, palette.paintWhite);
    coping.position.set(platformSide * -2.25, RAIL_ABOVE_FORMATION - 0.12, 0);
    platform.add(coping);

    const shelter = new Object3D();
    shelter.position.y = RAIL_ABOVE_FORMATION;
    platform.add(shelter);

    const postGeometry = shop.geometry(new CylinderGeometry(0.08, 0.08, 2.7, 6));
    for (let i = 0; i < 6; i += 1) {
      const post = new Mesh(postGeometry, palette.timber);
      post.position.set(i % 2 === 0 ? -1.7 : 1.5, 1.35, (Math.floor(i / 2) - 1) * 6.4);
      post.castShadow = true;
      shelter.add(post);
    }
    const backGeometry = shop.geometry(new BoxGeometry(0.12, 2.4, 13.4));
    const back = new Mesh(backGeometry, palette.paintWhite);
    back.position.set(1.55, 1.2, 0);
    back.castShadow = true;
    shelter.add(back);

    // A tiled pitched roof, built as two planes on a ridge the way the town's
    // roofs are, so the station belongs to the same place.
    const roofGeometry = shop.geometry(new BoxGeometry(2.6, 0.1, 14.2));
    for (const side of [-1, 1]) {
      const pitch = new Mesh(roofGeometry, palette.tile);
      pitch.position.set(side * 1.1, 2.95 + 0.42, 0);
      pitch.rotation.z = side * 0.3;
      pitch.castShadow = true;
      shelter.add(pitch);
    }
    const ridgeGeometry = shop.geometry(new BoxGeometry(0.3, 0.14, 14.4));
    const ridge = new Mesh(ridgeGeometry, palette.tile);
    ridge.position.y = 3.72;
    shelter.add(ridge);

    const benchGeometry = shop.geometry(new BoxGeometry(0.5, 0.08, 2.4));
    const benchLegGeometry = shop.geometry(new BoxGeometry(0.4, 0.42, 0.1));
    for (const offset of [-4.2, 4.2]) {
      const bench = new Mesh(benchGeometry, palette.timber);
      bench.position.set(0.9, 0.46, offset);
      shelter.add(bench);
      for (const leg of [-1, 1]) {
        const support = new Mesh(benchLegGeometry, palette.timber);
        support.position.set(0.9, 0.21, offset + leg * 1.0);
        shelter.add(support);
      }
    }

    const signPostGeometry = shop.geometry(new CylinderGeometry(0.05, 0.05, 2.3, 5));
    const boardGeometry = shop.geometry(new BoxGeometry(2.3, 0.5, 0.06));
    const sign = new Object3D();
    sign.position.set(platformSide * -1.2, RAIL_ABOVE_FORMATION, -PLATFORM_LENGTH * 0.3);
    platform.add(sign);
    for (const leg of [-0.9, 0.9]) {
      const stem = new Mesh(signPostGeometry, palette.steel);
      stem.position.set(0, 1.15, leg);
      sign.add(stem);
    }
    const board = new Mesh(boardGeometry, palette.paintWhite);
    board.position.y = 2.1;
    board.rotation.y = Math.PI / 2;
    sign.add(board);

    const lampPostGeometry = shop.geometry(new CylinderGeometry(0.07, 0.09, 4.2, 6));
    const shadeGeometry = shop.geometry(new ConeGeometry(0.42, 0.3, 10, 1, true));
    const bulbGeometry = shop.geometry(new CircleGeometry(0.3, 10));
    const haloGeometry = shop.geometry(new ConeGeometry(2.1, 4.4, 10, 1, true));
    const bulbMaterial = lamp('#ffd9a0', 0.1, 1);
    const haloMaterial = glow('#ffbe72', 0.22);
    for (const offset of [-PLATFORM_LENGTH * 0.34, PLATFORM_LENGTH * 0.34]) {
      const post = new Object3D();
      post.position.set(platformSide * 1.4, RAIL_ABOVE_FORMATION, offset);
      platform.add(post);
      const stem = new Mesh(lampPostGeometry, palette.steel);
      stem.position.y = 2.1;
      stem.castShadow = true;
      post.add(stem);
      const shade = new Mesh(shadeGeometry, palette.steel);
      shade.position.y = 4.25;
      post.add(shade);
      const bulb = new Mesh(bulbGeometry, bulbMaterial);
      bulb.position.y = 4.08;
      bulb.rotation.x = -Math.PI / 2;
      post.add(bulb);
      const halo = new Mesh(haloGeometry, haloMaterial);
      halo.position.y = 2.0;
      post.add(halo);
    }

    obstacles.push({
      x: platform.position.x,
      z: platform.position.z,
      radius: PLATFORM_LENGTH * 0.4,
      bottom: platform.position.y,
      top: platform.position.y + RAIL_ABOVE_FORMATION + 3.8,
    });
  }

  // --- level crossing ------------------------------------------------------
  const crossingAnchor = townCentre ?? { x: 0, z: 0 };
  const crossingChainage = Math.min(
    alignment.length - 80,
    Math.max(80, nearestChainage(crossingAnchor.x, crossingAnchor.z) + (stationChainage === null ? 0 : 230))
  );
  const booms: Object3D[] = [];
  const crossingLamps: MeshBasicMaterial[] = [];
  {
    const crossing = new Object3D();
    sideOf(crossingChainage, 0, -RAIL_ABOVE_FORMATION, crossing);
    group.add(crossing);

    const skew = random() * 0.6 - 0.3 + Math.PI / 2;
    const road = new Object3D();
    road.rotation.y = skew;
    crossing.add(road);

    const deckGeometry = shop.geometry(new BoxGeometry(7.2, 0.18, 30));
    const deck = new Mesh(deckGeometry, palette.asphalt);
    deck.position.y = RAIL_ABOVE_FORMATION - RAIL_HEIGHT - 0.09;
    deck.receiveShadow = true;
    road.add(deck);

    // The road surface is carried up to rail level between and outside the
    // rails, with the flangeways left open — that gap is the whole detail.
    const panelGeometry = shop.geometry(new BoxGeometry(7.4, 0.14, GAUGE - 0.1));
    const inner = new Mesh(panelGeometry, palette.timber);
    inner.position.y = RAIL_ABOVE_FORMATION - RAIL_HEIGHT * 0.5;
    road.add(inner);
    const outerGeometry = shop.geometry(new BoxGeometry(7.4, 0.14, 0.85));
    for (const side of [-1, 1]) {
      const outer = new Mesh(outerGeometry, palette.timber);
      outer.position.set(0, RAIL_ABOVE_FORMATION - RAIL_HEIGHT * 0.5, side * (RAIL_CENTRES / 2 + 0.52));
      road.add(outer);
    }

    const baseGeometry = shop.geometry(new BoxGeometry(0.6, 0.5, 0.6));
    const mastGeometry = shop.geometry(new CylinderGeometry(0.1, 0.12, 2.6, 7));
    const counterGeometry = shop.geometry(new BoxGeometry(0.34, 0.34, 0.5));
    const boomRedGeometry = shop.geometry(new BoxGeometry(0.1, 0.22, 1.1));
    const boomWhiteGeometry = shop.geometry(new BoxGeometry(0.1, 0.22, 0.9));
    const crossGeometry = shop.geometry(new BoxGeometry(0.1, 1.5, 0.22));
    const lensGeometry = shop.geometry(new CircleGeometry(0.17, 10));
    const warning = lamp('#ff2e18', 0.12, 1);
    crossingLamps.push(warning);
    const warningSecond = lamp('#ff2e18', 0.12, 1);
    crossingLamps.push(warningSecond);

    // Diagonally opposite corners, as a real crossing is gated.
    for (const [corner, lampMaterial] of [
      [1, warning],
      [-1, warningSecond],
    ] as const) {
      const gate = new Object3D();
      gate.position.set(corner * 4.6, RAIL_ABOVE_FORMATION - RAIL_HEIGHT, corner * -4.2);
      gate.rotation.y = corner > 0 ? 0 : Math.PI;
      road.add(gate);

      const base = new Mesh(baseGeometry, palette.concrete);
      base.position.y = 0.25;
      gate.add(base);
      const mast = new Mesh(mastGeometry, palette.paintWhite);
      mast.position.y = 1.6;
      mast.castShadow = true;
      gate.add(mast);

      for (const arm of [-1, 1]) {
        const cross = new Mesh(crossGeometry, palette.paintWhite);
        cross.position.set(0, 2.9, 0);
        cross.rotation.x = arm * 0.78;
        gate.add(cross);
      }
      const lens = new Mesh(lensGeometry, lampMaterial);
      lens.position.set(0, 2.3, 0.14);
      gate.add(lens);

      const boom = new Object3D();
      boom.position.set(0, 1.5, 0.18);
      gate.add(boom);
      booms.push(boom);

      const counterweight = new Mesh(counterGeometry, palette.paintWhite);
      counterweight.position.z = -0.6;
      boom.add(counterweight);
      // Five alternating blocks make a striped boom for the price of five boxes.
      for (let band = 0; band < 5; band += 1) {
        const red = band % 2 === 0;
        const block = new Mesh(red ? boomRedGeometry : boomWhiteGeometry, red ? palette.paintRed : palette.paintWhite);
        block.position.z = 0.55 + band * 1.0;
        block.castShadow = true;
        boom.add(block);
      }
    }
  }

  // --- the train -----------------------------------------------------------
  const carriageCount = Math.max(3, Math.min(9, Math.round(line.carriages)));
  const train = new Group();
  train.name = 'train';
  train.visible = false;
  group.add(train);

  const coachGlass = basic({ color: '#28333d' });
  lamps.push({ material: coachGlass, day: 1, night: 1 });
  const coachSpill = glow('#ffcf8a', 0.3);
  const headlightLens = lamp('#fff6de', 0.55, 1);
  const headlightBeam = glow('#ffeec2', 0.1);
  const tailLens = lamp('#ff2a14', 0.3, 1);

  /** Window glass at night is a warm interior, and by day a dark reflection. */
  const glassColours = { day: new Color('#28333d'), night: new Color('#ffd49a') };

  type Pool = { mesh: InstancedMesh; nodes: Object3D[] };
  const pools: Pool[] = [];
  const makePool = (geometry: Geometry, material: Material, count: number, shadows: boolean): Pool => {
    const mesh = shop.instanced(geometry, material, count);
    mesh.castShadow = shadows;
    train.add(mesh);
    return { mesh, nodes: [] };
  };

  const vehicleCount = carriageCount + 1;
  const wheelsPerVehicle = (index: number) => (index === 0 ? 6 : 4);
  let totalWheels = 0;
  for (let i = 0; i < vehicleCount; i += 1) totalWheels += wheelsPerVehicle(i);

  const wheelGeometry = shop.geometry(new CylinderGeometry(1, 1, 0.135, 14));
  wheelGeometry.rotateZ(Math.PI / 2);
  const flangeGeometry = shop.geometry(new CylinderGeometry(1, 1, 0.028, 14));
  flangeGeometry.rotateZ(Math.PI / 2);
  const wheelPool = makePool(wheelGeometry, palette.underframe, totalWheels, true);
  const flangePool = makePool(flangeGeometry, palette.railBody, totalWheels, false);
  const axleboxPool = makePool(shop.geometry(new BoxGeometry(0.26, 0.3, 0.34)), palette.underframe, totalWheels, false);
  const springPool = makePool(
    shop.geometry(new CylinderGeometry(0.11, 0.11, 0.34, 8)),
    palette.railBody,
    totalWheels * 2,
    false
  );

  /**
   * One carbody, merged down to a mesh per material. Six vehicles built as
   * loose boxes would be two hundred draw calls; merged, the whole train is
   * about twenty, and nothing is given up to get there.
   */
  const buildCarbody = (loco: boolean) => {
    const halfWidth = 1.45;
    const bodyLength = loco ? 16.4 : 19.0;
    const floor = 1.3;
    const sillTop = loco ? 3.55 : 3.5;
    const windowBottom = loco ? 2.55 : 2.15;
    const windowTop = loco ? 3.35 : 3.1;
    const paint: BufferGeometry[] = [];
    const cream: BufferGeometry[] = [];
    const dark: BufferGeometry[] = [];
    const metal: BufferGeometry[] = [];
    const glassParts: BufferGeometry[] = [];

    const slab = (
      into: BufferGeometry[],
      width: number,
      height: number,
      depth: number,
      x: number,
      y: number,
      z: number
    ) => {
      const box = new BoxGeometry(width, height, depth);
      box.translate(x, y, z);
      into.push(box);
    };

    slab(dark, halfWidth * 2 - 0.1, 0.42, bodyLength, 0, floor - 0.21, 0);
    // Below the windows, above the windows, and the two ends.
    slab(paint, halfWidth * 2, windowBottom - floor, bodyLength, 0, (floor + windowBottom) / 2, 0);
    slab(cream, halfWidth * 2, sillTop - windowTop, bodyLength, 0, (windowTop + sillTop) / 2, 0);
    for (const end of [-1, 1]) {
      slab(paint, halfWidth * 2, sillTop - floor, 0.3, 0, (floor + sillTop) / 2, (end * (bodyLength - 0.3)) / 2);
    }

    const pitch = 1.46;
    const windows = Math.floor((bodyLength - 2.6) / pitch);
    const windowSpan = windows * pitch;
    for (let w = 0; w < windows; w += 1) {
      const z = -windowSpan / 2 + (w + 0.5) * pitch;
      for (const side of [-1, 1]) {
        const pane = new BoxGeometry(0.06, windowTop - windowBottom - 0.1, pitch - 0.36);
        pane.translate(side * (halfWidth - 0.04), (windowBottom + windowTop) / 2, z);
        glassParts.push(pane);
      }
      if (w === 0) continue;
      for (const side of [-1, 1]) {
        const pillar = new BoxGeometry(0.1, windowTop - windowBottom, 0.36);
        pillar.translate(side * halfWidth, (windowBottom + windowTop) / 2, z - pitch / 2);
        cream.push(pillar);
      }
    }
    // The band has to be closed at both ends or the body reads as two shelves.
    for (const end of [-1, 1]) {
      for (const side of [-1, 1]) {
        const cap = new BoxGeometry(0.1, windowTop - windowBottom, (bodyLength - windowSpan) / 2);
        cap.translate(side * halfWidth, (windowBottom + windowTop) / 2, (end * (bodyLength + windowSpan)) / 4);
        cream.push(cap);
      }
    }

    // A cambered roof. Half a cylinder laid along the body is the shape, and a
    // flat lid is the thing that makes stock look like a shipping container.
    const roofShell = new CylinderGeometry(halfWidth, halfWidth, bodyLength, 14, 1, false, 0, Math.PI);
    roofShell.rotateZ(Math.PI / 2);
    roofShell.rotateY(Math.PI / 2);
    roofShell.scale(1, 0.42, 1);
    roofShell.translate(0, sillTop, 0);
    metal.push(roofShell);

    if (loco) {
      const cab = new BoxGeometry(halfWidth * 2 + 0.02, 0.5, 4.4);
      cab.translate(0, sillTop + 0.3, bodyLength / 2 - 2.6);
      cream.push(cab);
      for (const pane of [
        { w: 0.9, x: -0.46, z: bodyLength / 2 - 0.16 },
        { w: 0.9, x: 0.46, z: bodyLength / 2 - 0.16 },
      ]) {
        const screen = new BoxGeometry(pane.w, 1.0, 0.08);
        screen.translate(pane.x, 3.35, pane.z);
        glassParts.push(screen);
      }
      const nose = new BoxGeometry(halfWidth * 2 - 0.3, 1.1, 0.5);
      nose.translate(0, 1.9, bodyLength / 2 + 0.12);
      paint.push(nose);
      // Radiator grilles and roof fans — the bits that say diesel rather than
      // electric, from any distance where the shape is still legible.
      for (let g = 0; g < 4; g += 1) {
        const grille = new BoxGeometry(halfWidth * 2 + 0.06, 0.7, 0.5);
        grille.translate(0, 2.5, -bodyLength / 2 + 1.5 + g * 1.1);
        dark.push(grille);
      }
      for (const z of [-bodyLength / 2 + 2.2, -bodyLength / 2 + 4.4]) {
        const fan = new CylinderGeometry(0.62, 0.62, 0.24, 12);
        fan.translate(0, sillTop + 0.6, z);
        dark.push(fan);
      }
      const stack = new CylinderGeometry(0.28, 0.34, 0.6, 10);
      stack.translate(0, sillTop + 0.75, -bodyLength / 2 + 6.4);
      dark.push(stack);
      const pilot = new BoxGeometry(halfWidth * 2 - 0.2, 0.55, 0.22);
      pilot.translate(0, 0.78, bodyLength / 2 + 0.18);
      dark.push(pilot);
      for (const side of [-1, 1]) {
        const walkway = new BoxGeometry(0.22, 0.1, bodyLength - 1.2);
        walkway.translate(side * (halfWidth + 0.1), floor - 0.4, 0);
        dark.push(walkway);
        const handrail = new BoxGeometry(0.05, 0.05, bodyLength - 1.6);
        handrail.translate(side * (halfWidth + 0.16), floor + 0.55, 0);
        metal.push(handrail);
      }
    } else {
      for (const end of [-1, 1]) {
        const doorway = new BoxGeometry(0.1, 1.95, 0.9);
        doorway.translate(halfWidth, floor + 0.98, (end * (bodyLength - 2.4)) / 2);
        dark.push(doorway);
      }
      for (let vent = 0; vent < 5; vent += 1) {
        const cowl = new BoxGeometry(0.4, 0.22, 0.4);
        cowl.translate(0, sillTop + 0.58, (vent - 2) * 3.4);
        metal.push(cowl);
      }
      for (const side of [-1, 1]) {
        const rubbing = new BoxGeometry(0.07, 0.12, bodyLength - 0.8);
        rubbing.translate(side * (halfWidth + 0.02), windowBottom - 0.22, 0);
        metal.push(rubbing);
      }
    }

    const assemble = (parts: BufferGeometry[], material: Material, shadows: boolean): Mesh | null => {
      if (parts.length === 0) return null;
      const merged = mergeGeometries(parts);
      for (const part of parts) part.dispose();
      const mesh = new Mesh(shop.geometry(merged), material);
      mesh.castShadow = shadows;
      return mesh;
    };

    return {
      bodyLength,
      meshes: [
        assemble(paint, loco ? palette.bodyLoco : palette.bodyCoach, true),
        assemble(cream, palette.bodyCream, true),
        assemble(dark, palette.underframe, false),
        assemble(metal, palette.roof, false),
        assemble(glassParts, coachGlass, false),
      ].filter((mesh): mesh is Mesh => mesh !== null),
      glassBand: { bottom: windowBottom, top: windowTop, halfWidth },
    };
  };

  const locoKit = buildCarbody(true);
  const coachKit = buildCarbody(false);
  const spillGeometry = shop.geometry(
    new BoxGeometry(coachKit.glassBand.halfWidth * 2.5, coachKit.glassBand.top - coachKit.glassBand.bottom + 0.5, 17)
  );

  const bogieFrameGeometry = shop.geometry(new BoxGeometry(0.2, 0.4, 1));
  const bogieTransomGeometry = shop.geometry(new BoxGeometry(1.9, 0.3, 0.34));

  const vehicles: Vehicle[] = [];
  let wheelCursor = 0;

  for (let index = 0; index < vehicleCount; index += 1) {
    const loco = index === 0;
    const kit = loco ? locoKit : coachKit;
    const axles = loco ? 3 : 2;
    const wheelRadius = loco ? 0.5 : 0.43;
    const bogieCentres = loco ? 10.4 : 13.8;
    const wheelbase = loco ? 1.95 : 1.2;

    const body = new Object3D();
    body.rotation.order = 'YXZ';
    train.add(body);
    for (const mesh of kit.meshes) {
      // Geometry is shared between every coach, so each one needs its own mesh
      // around it and nothing more.
      const clone = new Mesh(mesh.geometry, mesh.material);
      clone.castShadow = mesh.castShadow;
      body.add(clone);
    }
    if (!loco) {
      const spill = new Mesh(spillGeometry, coachSpill);
      spill.position.y = (coachKit.glassBand.bottom + coachKit.glassBand.top) / 2;
      body.add(spill);
    }

    if (loco) {
      const lensGeometry = shop.geometry(new CircleGeometry(0.26, 12));
      const headlight = new Mesh(lensGeometry, headlightLens);
      headlight.position.set(0, 3.0, kit.bodyLength / 2 + 0.2);
      body.add(headlight);
      const beamGeometry = shop.geometry(new ConeGeometry(3.4, 54, 12, 1, true));
      const beam = new Mesh(beamGeometry, headlightBeam);
      beam.position.set(0, 2.7, kit.bodyLength / 2 + 27);
      beam.rotation.x = Math.PI / 2;
      body.add(beam);
      for (const side of [-1, 1]) {
        const marker = new Mesh(lensGeometry, headlightLens);
        marker.scale.setScalar(0.5);
        marker.position.set(side * 0.95, 1.95, kit.bodyLength / 2 + 0.16);
        body.add(marker);
      }
    }
    if (index === vehicleCount - 1) {
      const tailGeometry = shop.geometry(new CircleGeometry(0.17, 10));
      for (const side of [-1, 1]) {
        const tail = new Mesh(tailGeometry, tailLens);
        tail.position.set(side * 0.95, 1.9, -kit.bodyLength / 2 - 0.16);
        tail.rotation.y = Math.PI;
        body.add(tail);
      }
    }

    // Buffers and the screw coupling between vehicles. The coupling is rigid
    // and the gap is one metre, so the approximation costs nothing visible.
    const bufferShankGeometry = shop.geometry(new CylinderGeometry(0.08, 0.08, 0.3, 8));
    const bufferHeadGeometry = shop.geometry(new CylinderGeometry(0.17, 0.17, 0.07, 10));
    const couplerGeometry = shop.geometry(new BoxGeometry(0.1, 0.12, 1.0));
    for (const end of [-1, 1]) {
      const z = (end * kit.bodyLength) / 2;
      for (const side of [-1, 1]) {
        const shank = new Mesh(bufferShankGeometry, palette.underframe);
        shank.position.set(side * 0.62, 1.0, z + end * 0.15);
        shank.rotation.x = Math.PI / 2;
        body.add(shank);
        const head = new Mesh(bufferHeadGeometry, palette.railBody);
        head.position.set(side * 0.62, 1.0, z + end * 0.31);
        head.rotation.x = Math.PI / 2;
        body.add(head);
      }
      if (end === -1 && index < vehicleCount - 1) {
        const coupler = new Mesh(couplerGeometry, palette.underframe);
        coupler.position.set(0, 0.95, z - 0.5);
        body.add(coupler);
      }
    }

    const bogies: Object3D[] = [];
    const wheelSlots: number[][] = [];
    for (const end of [1, -1]) {
      const bogie = new Object3D();
      bogie.rotation.order = 'YXZ';
      train.add(bogie);
      bogies.push(bogie);

      for (const side of [-1, 1]) {
        const frame = new Mesh(bogieFrameGeometry, palette.underframe);
        frame.scale.z = wheelbase * (axles - 1) + 1.1;
        frame.position.set(side * 0.86, wheelRadius + 0.32, 0);
        frame.castShadow = true;
        bogie.add(frame);
      }
      for (const transomEnd of [-1, 1]) {
        const transom = new Mesh(bogieTransomGeometry, palette.underframe);
        transom.position.set(0, wheelRadius + 0.3, transomEnd * wheelbase * 0.5);
        bogie.add(transom);
      }

      const slots: number[] = [];
      for (let axle = 0; axle < axles; axle += 1) {
        const node = new Object3D();
        node.position.set(0, wheelRadius, (axle - (axles - 1) / 2) * wheelbase);
        node.scale.setScalar(wheelRadius);
        bogie.add(node);
        wheelPool.nodes.push(node);
        flangePool.nodes.push(node);
        slots.push(wheelCursor);

        for (const side of [-1, 1]) {
          const box = new Object3D();
          box.position.set(side * 0.74, wheelRadius, node.position.z);
          bogie.add(box);
          axleboxPool.nodes.push(box);
          const spring = new Object3D();
          spring.position.set(side * 0.74, wheelRadius + 0.26, node.position.z);
          bogie.add(spring);
          springPool.nodes.push(spring);
        }
        wheelCursor += 1;
      }
      wheelSlots.push(slots);
      void end;
    }

    vehicles.push({
      body,
      bogies,
      bogieCentres,
      pitch: kit.bodyLength + 1.0,
      wheelRadius,
      wheelSlots,
    });
  }

  // Axleboxes and springs are rigid on the bogie, so their matrices are written
  // once; only the wheels and the bogies themselves move after this.
  {
    const matrix = new Matrix4();
    for (const pool of [axleboxPool, springPool]) {
      pool.nodes.forEach((node, index) => {
        node.updateMatrix();
        pool.mesh.setMatrixAt(index, matrix.copy(node.matrix));
      });
      pool.mesh.instanceMatrix.needsUpdate = true;
      // They ride with the bogie, so the pool has to live under it in spirit;
      // parenting the instanced mesh to the train and writing world matrices
      // each frame is what actually achieves that.
      pool.mesh.visible = true;
    }
  }

  // --- exhaust -------------------------------------------------------------
  const smokePositions = new Float32Array(SMOKE_PUFFS * 3);
  const smokeBirth = new Float32Array(SMOKE_PUFFS).fill(-1000);
  const smokeSeed = new Float32Array(SMOKE_PUFFS);
  for (let i = 0; i < SMOKE_PUFFS; i += 1) smokeSeed[i] = random();

  const smokeGeometry = shop.geometry(new BufferGeometry());
  smokeGeometry.setAttribute('position', new BufferAttribute(smokePositions, 3));
  smokeGeometry.setAttribute('aBirth', new BufferAttribute(smokeBirth, 1));
  smokeGeometry.setAttribute('aSeed', new BufferAttribute(smokeSeed, 1));
  smokeGeometry.boundingSphere = null;

  const smokeMaterial = shop.material(
    new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0.5 },
        uPixelRatio: { value: typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio) },
      },
      vertexShader: SMOKE_VERTEX,
      fragmentShader: SMOKE_FRAGMENT,
      transparent: true,
      depthWrite: false,
    })
  );
  const smoke = new Points(smokeGeometry, smokeMaterial);
  smoke.name = 'exhaust';
  smoke.frustumCulled = false;
  group.add(smoke);
  let smokeCursor = 0;
  let nextPuff = 0;

  // --- somewhere to walk ---------------------------------------------------
  // Walking the line is how people here actually get along a valley, and it is
  // the only way onto the bridges: the flanks of an embankment are walls, so the
  // way up is along the formation from where it meets the ground.
  /** Top of the sleepers, which is what a foot lands on — bridge timber or not. */
  const crestOf = (i: number) => alignment.y[i] - RAIL_HEIGHT;
  const decks: Platform[] = [];
  const deckPoints: number[] = [];
  let raisedFrom = -1;
  for (let i = 0; i <= alignment.count; i += 1) {
    if (i < alignment.count && crestOf(i) - alignment.ground[i] > SURFACE_GAP) {
      if (raisedFrom < 0) raisedFrom = i;
      continue;
    }
    if (raisedFrom < 0) continue;
    // A run is already maximal in how far it stands clear, so carrying it two
    // stations further each way lands it under the ground rather than on it.
    const head = Math.max(0, raisedFrom - DECK_APPROACH);
    const tail = Math.min(alignment.count - 1, i - 1 + DECK_APPROACH);
    raisedFrom = -1;

    deckPoints.length = 0;
    for (let at = head; at <= tail; at += 1) deckPoints.push(alignment.x[at], crestOf(at), alignment.z[at]);
    deckChain(deckPoints, SLEEPER_LENGTH / 2, decks);
  }

  // --- obstacles -----------------------------------------------------------
  for (let i = 0; i < alignment.count; i += Math.max(1, Math.round(12 / alignment.step))) {
    const fill = alignment.y[i] - RAIL_ABOVE_FORMATION - alignment.ground[i];
    if (fill < 1.2) continue;
    // A bridge is piers and a deck. The piers are obstacles of their own, and a
    // cylinder from the bed to the parapet on top of them would both shove
    // anyone off the deck they are standing on and wall a swimmer out of the
    // whole river underneath it.
    if (alignment.structure[i] === 'bridge') continue;
    obstacles.push({
      x: alignment.x[i],
      z: alignment.z[i],
      radius: BALLAST_CROWN_HALF + FILL_SLOPE * Math.min(fill, VIADUCT_FILL) * 0.5,
      bottom: alignment.ground[i],
      // The crest, not the rails above it: `gatherContacts` ignores anything
      // whose top is within a step of the foot, so publishing the walking
      // surface makes an embankment a wall from the side and a floor from on
      // top. Carrying it 0.4 m higher made it a wall from both.
      top: crestOf(i),
    });
  }

  // --- running -------------------------------------------------------------
  const SPEED = 19.4;
  const DWELL = stationChainage === null ? 0 : 26;
  const trainLength = vehicles.reduce((sum, vehicle) => sum + vehicle.pitch, 0);
  const runLength = alignment.length + trainLength + 120;
  /** Seconds a whole pass takes, dwell included. */
  const passDuration = runLength / SPEED + DWELL;
  const gap = Math.max(60, line.headway) * (0.7 + random() * 0.6);
  const cycle = passDuration + gap;
  const phase = random() * cycle;

  const matrix = new Matrix4();
  const headPosition = new Vector3();
  const tailPosition = new Vector3();
  const spin = new Object3D();
  const worldScratch = new Matrix4();
  const frontPose: Pose = { x: 0, y: 0, z: 0, heading: 0, roll: 0, grade: 0 };
  const rearPose: Pose = { x: 0, y: 0, z: 0, heading: 0, roll: 0, grade: 0 };

  /** Distance run at time `t` into a pass, with the station stop folded in. */
  const chainageAt = (t: number): number => {
    if (stationChainage === null || DWELL <= 0) return t * SPEED - trainLength - 60;
    const stopAt = stationChainage + trainLength * 0.35;
    const arriveAt = (stopAt + trainLength + 60) / SPEED;
    if (t <= arriveAt) return t * SPEED - trainLength - 60;
    if (t <= arriveAt + DWELL) return stopAt;
    return stopAt + (t - arriveAt - DWELL) * SPEED;
  };

  let lastDistance = 0;
  let wheelAngle = 0;
  let night = 0;

  const update = (elapsed: number) => {
    const t = (elapsed + phase) % cycle;
    const running = t < passDuration;
    train.visible = running;
    smoke.visible = running || elapsed - nextPuff < SMOKE_LIFE;

    if (!running) {
      lastDistance = 0;
      for (const signal of signals) {
        signal.red.visible = false;
        signal.yellow.visible = false;
        signal.green.visible = true;
      }
      for (const boom of booms) boom.rotation.x = -1.35;
      for (const material of crossingLamps) material.visible = false;
      smokeMaterial.uniforms.uTime.value = elapsed;
      return;
    }

    const head = chainageAt(t);
    const speed = lastDistance === 0 ? SPEED : Math.abs(head - lastDistance);
    wheelAngle -= (head - lastDistance) / vehicles[0].wheelRadius;
    lastDistance = head;

    let nose = head;
    for (const vehicle of vehicles) {
      const centre = nose - vehicle.pitch / 2;
      const front = centre + vehicle.bogieCentres / 2;
      const rear = centre - vehicle.bogieCentres / 2;
      alignment.at(front, frontPose);
      alignment.at(rear, rearPose);
      headPosition.set(frontPose.x, frontPose.y, frontPose.z);
      tailPosition.set(rearPose.x, rearPose.y, rearPose.z);

      // The body rides the chord between its bogies while each bogie stays
      // tangent to the rail. That single distinction is what makes a train bend
      // through a curve instead of sliding round it as one rigid box.
      const dx = headPosition.x - tailPosition.x;
      const dy = headPosition.y - tailPosition.y;
      const dz = headPosition.z - tailPosition.z;
      const chord = Math.hypot(dx, dz) || 1;
      vehicle.body.position.set(
        (headPosition.x + tailPosition.x) / 2,
        (headPosition.y + tailPosition.y) / 2 - RAIL_HEIGHT,
        (headPosition.z + tailPosition.z) / 2
      );
      vehicle.body.rotation.set(-Math.atan2(dy, chord), Math.atan2(dx, dz), (frontPose.roll + rearPose.roll) / 2);

      vehicle.bogies.forEach((bogie, bogieIndex) => {
        const chainage = bogieIndex === 0 ? front : rear;
        const bogiePose = bogieIndex === 0 ? frontPose : rearPose;
        alignment.at(chainage, bogiePose);
        bogie.position.set(bogiePose.x, bogiePose.y - RAIL_HEIGHT, bogiePose.z);
        bogie.rotation.set(-Math.atan(bogiePose.grade), bogiePose.heading, bogiePose.roll);
        bogie.updateMatrixWorld(true);

        for (const slot of vehicle.wheelSlots[bogieIndex]) {
          const node = wheelPool.nodes[slot];
          spin.position.copy(node.position);
          spin.rotation.set(wheelAngle * (vehicles[0].wheelRadius / vehicle.wheelRadius), 0, 0);
          spin.scale.copy(node.scale);
          spin.updateMatrix();
          worldScratch.multiplyMatrices(bogie.matrixWorld, spin.matrix);
          wheelPool.mesh.setMatrixAt(slot, worldScratch);
          flangePool.mesh.setMatrixAt(slot, worldScratch);
        }
      });

      nose -= vehicle.pitch;
    }

    for (const pool of [wheelPool, flangePool]) pool.mesh.instanceMatrix.needsUpdate = true;
    for (const pool of [axleboxPool, springPool]) {
      pool.nodes.forEach((node, index) => {
        node.updateMatrixWorld(true);
        pool.mesh.setMatrixAt(index, node.matrixWorld);
      });
      pool.mesh.instanceMatrix.needsUpdate = true;
    }

    // Exhaust: a diesel under load on a rising grade makes smoke, and one
    // coasting downhill makes almost none.
    alignment.at(head - vehicles[0].pitch / 2, frontPose);
    const load = clamp01(0.25 + frontPose.grade * 28 + (speed < SPEED * 0.6 ? 0.5 : 0));
    if (elapsed >= nextPuff && load > 0.08) {
      smokePositions[smokeCursor * 3] = frontPose.x + forwardX(frontPose.heading) * -2.0;
      smokePositions[smokeCursor * 3 + 1] = frontPose.y + 4.6;
      smokePositions[smokeCursor * 3 + 2] = frontPose.z + forwardZ(frontPose.heading) * -2.0;
      smokeBirth[smokeCursor] = elapsed;
      smokeCursor = (smokeCursor + 1) % SMOKE_PUFFS;
      smokeGeometry.attributes.position.needsUpdate = true;
      smokeGeometry.attributes.aBirth.needsUpdate = true;
      nextPuff = elapsed + 0.22 / Math.max(0.15, load);
    }
    smokeMaterial.uniforms.uTime.value = elapsed;
    smokeMaterial.uniforms.uOpacity.value = 0.18 + load * 0.4;

    // Signalling: red behind the train, yellow approaching the red, green
    // beyond. Three lamps and one subtraction, and the line reads as worked.
    const tail = head - trainLength;
    for (const signal of signals) {
      const behind = signal.chainage > tail - 90 && signal.chainage < head + 30;
      const approach = signal.chainage >= head + 30 && signal.chainage < head + 1000;
      signal.red.visible = behind;
      signal.yellow.visible = !behind && approach;
      signal.green.visible = !behind && !approach;
    }

    const distanceToCrossing = Math.min(
      Math.abs(crossingChainage - head),
      Math.abs(crossingChainage - tail),
      crossingChainage > tail && crossingChainage < head ? 0 : Infinity
    );
    const closing = clamp01((260 - distanceToCrossing) / 60);
    for (const boom of booms) boom.rotation.x = -1.35 * (1 - closing);
    const flashing = closing > 0.02;
    for (const [index, material] of crossingLamps.entries()) {
      material.visible = flashing && (Math.floor(elapsed * 1.6) + index) % 2 === 0;
      material.opacity = night > 0.1 ? 1 : 0.5;
    }
  };

  const setNight = (amount: number) => {
    night = clamp01(amount);
    for (const entry of lamps) {
      entry.material.opacity = entry.day + (entry.night - entry.day) * night;
    }
    coachGlass.opacity = 1;
    coachGlass.color.copy(glassColours.day).lerp(glassColours.night, night);
    coachSpill.opacity = night * 0.3;
    headlightBeam.opacity = night * 0.1;
    // Rail heads are the brightest thing on the ground at dusk; after full dark
    // there is nothing left to catch, so the sheen goes with the light.
    palette.railHead.roughness = 0.2 + night * 0.35;
  };

  setNight(0);
  update(0);

  return {
    group,
    update,
    setNight,
    obstacles,
    decks,
    built: true,
    dispose: () => {
      shop.dispose();
      group.clear();
      train.clear();
    },
  };
};
