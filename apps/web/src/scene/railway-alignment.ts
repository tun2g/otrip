/**
 * The survey: where a metre gauge single track can be laid across a patch of
 * this terrain, and what shape it takes once it is.
 *
 * Split out of `railway.ts`, which is the scenery and the train. The division is
 * that nothing in here knows what a railway looks like — it knows what one
 * costs, what grade a locomotive will pull and how tight a curve metre gauge
 * stock will take, and it hands back a centreline with a structure against every
 * station. `railway.ts` builds the ballast, the trusses and the rake on top of
 * it; `railway-formation.ts` turns the same centreline into the ground a body
 * walks on. Both of those are drawing or collision work and neither has any
 * business re-deciding where the line goes.
 *
 * It is also the way in for the probes. `probe/railway-crossing.ts` builds this
 * alignment from the same seeds the renderer does, which is the only way to
 * measure a crossing or an embankment against the line it belongs to without
 * standing up a WebGL context.
 */
import { createPrng, type Terrain } from '@otrip/world';

// Đường sắt Việt Nam is metre gauge throughout. Every dimension below is the
// real one, in metres, because a railway is the one object in the scene whose
// proportions a viewer already knows by heart.
/** Between the inner faces of the rails. */
export const GAUGE = 1.0;
/** Rail centre to rail centre: gauge plus one rail head width. */
export const RAIL_CENTRES = GAUGE + 0.065;
/** 43 kg/m rail, the Vietnamese mainline section. */
export const RAIL_HEIGHT = 0.14;
export const RAIL_HEAD_WIDTH = 0.07;
/** Standard rail length, so fishplates land where joints land. */
export const RAIL_LENGTH = 12.5;

export const SLEEPER_LENGTH = 1.8;
export const SLEEPER_WIDTH = 0.22;
export const SLEEPER_DEPTH = 0.16;
/** Bridge timbers are longer than track sleepers, and it shows. */
export const BRIDGE_TIMBER_LENGTH = 2.4;

/** Depth of ballast under the sleeper, plus the shoulder it stands in. */
export const BALLAST_DEPTH = 0.45;
export const BALLAST_CROWN_HALF = 1.5;
/** Earthwork side slopes, run per unit rise. */
export const FILL_SLOPE = 1.5;
export const CUT_SLOPE = 1.2;
/** Drainage cess between the ballast toe and the foot of a cutting. */
export const CESS = 0.8;

/** Rail top above formation level — what the earthworks have to carry. */
export const RAIL_ABOVE_FORMATION = BALLAST_DEPTH + SLEEPER_DEPTH + RAIL_HEIGHT;

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
export const VIADUCT_FILL = 11;
const MAX_CUT = 11;

export const STATION_STEP = 5;
/** Coarser sampling while comparing candidate routes; the winner is resampled. */
const SURVEY_STEP = 20;
/** Stations at each end over which the line simply follows the ground off the map. */
const EDGE_TAPER = 30;

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

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
export const forwardX = (heading: number) => Math.sin(heading);
export const forwardZ = (heading: number) => Math.cos(heading);
export const rightX = (heading: number) => Math.cos(heading);
export const rightZ = (heading: number) => -Math.sin(heading);

export type Pose = { x: number; y: number; z: number; heading: number; roll: number; grade: number };

export type Structure = 'grade' | 'fill' | 'cut' | 'bridge';

export type Alignment = {
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

export const buildAlignment = (
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
export const assessAlignment = (alignment: Alignment, waterLevel: number): Assessment => {
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
export const choosePlan = (
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
