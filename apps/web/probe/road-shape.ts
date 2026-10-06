import { createTerrain, LOCATIONS } from '@otrip/world';

import { resolvePois } from '@/scene/points-of-interest';
import { createRoadNetwork, type RoadKind, type RoadSample } from '@/scene/road-network';
import { planTown } from '@/scene/town-plan';

/**
 * How much the roads wind, and whether the fleet can still drive them.
 *
 * Sinuosity is the number the shape of a road is actually judged on: the length
 * driven over the straight line between the two ends. Everything else here is a
 * guard on it — a road that winds by spiking its curvature at four knots is not
 * a winding road, it is a broken one, so the distribution and the speed the
 * traffic model produces are printed beside it.
 */

const SEGMENTS = Number(process.env.SEG ?? 416);
const TAG = process.env.TAG ?? 'before';
const PLACES = ['ta-xua', 'hoi-an', 'trang-an', 'ho-tay'] as const;

/** Below this a sample is doing nothing: a 400 m radius is a straight road. */
const STRAIGHT = 1 / 400;

/** `vehicles.ts`'s own numbers, for the cornering law. Length is not read here. */
const FLEET = [
  { name: 'coach', cruise: 12, grip: 2.9, accel: 1, brake: 3.6, roads: ['main', 'secondary'] },
  { name: 'car', cruise: 13.5, grip: 4.6, accel: 2.6, brake: 5.8, roads: ['main', 'secondary'] },
  { name: 'truck', cruise: 10.4, grip: 3.3, accel: 1.4, brake: 4.2, roads: ['main', 'secondary', 'lane'] },
  { name: 'cyclo', cruise: 3.3, grip: 2.3, accel: 0.9, brake: 2.4, roads: ['secondary', 'lane'] },
  { name: 'bike', cruise: 11.5, grip: 5.2, accel: 3.4, brake: 5.4, roads: ['main', 'secondary', 'lane', 'trail'] },
] as const;

const quantile = (sorted: number[], at: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(at * (sorted.length - 1))))];

const radius = (k: number): string => (Math.abs(k) < 1e-6 ? '    inf' : `${(1 / Math.abs(k)).toFixed(0).padStart(7)}`);

/**
 * `vehicles.ts`'s longitudinal model, driven once round the road. Transcribed
 * rather than imported because the real one needs a scene; the bend law, the
 * look-ahead and the accel/brake limits are the lines that matter and they are
 * copied exactly. No leader, so this is the free-running speed the road allows.
 */
const drive = (
  sample: (distance: number, out: RoadSample) => RoadSample,
  total: number,
  spec: { cruise: number; grip: number; accel: number; brake: number }
): { mean: number; min: number } => {
  const here: RoadSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, curvature: 0 };
  const ahead: RoadSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, curvature: 0 };
  const delta = 0.05;
  let speed = spec.cruise;
  let distance = 0;
  // Two laps: the first settles the speed out of its arbitrary start, the second
  // is measured. Braking is causal, so a cold start reads the first bend wrong.
  for (let lap = 0; lap < 2; lap += 1) {
    let travelled = 0;
    let weighted = 0;
    let span = 0;
    let slowest = Infinity;
    while (travelled < total) {
      const look = Math.max(6, speed * 1.6);
      sample(distance, here);
      sample(distance + look, ahead);
      const bend = Math.abs(ahead.curvature) * 0.65 + Math.abs(here.curvature) * 0.35;
      let target = spec.cruise;
      if (bend > 1e-4) target = Math.min(target, Math.sqrt(spec.grip / bend));
      if (target > speed) speed = Math.min(target, speed + spec.accel * delta);
      else speed = Math.max(0, Math.max(target, speed - spec.brake * delta));
      const step = speed * delta;
      distance += step;
      travelled += step;
      weighted += speed * delta;
      span += delta;
      if (speed < slowest) slowest = speed;
      // A road the model brings to a standstill would never finish the lap.
      if (step < 1e-4) return { mean: 0, min: 0 };
    }
    if (lap === 1) return { mean: weighted / Math.max(1e-6, span), min: slowest };
  }
  return { mean: 0, min: 0 };
};

/**
 * Sinuosity over a sliding window, which is what a rider actually feels. The
 * end-to-end figure is dominated by topology — a trunk that goes round a lake
 * scores 1.18 while being dead straight everywhere — so the honest measure of
 * "winding" is the detour taken inside one window's worth of driving.
 */
const WINDOW = 500;

const localSinuosity = (points: Float32Array, cumulative: number[]): number => {
  const count = cumulative.length;
  let weighted = 0;
  let span = 0;
  // A road shorter than the window is measured whole rather than scored 1.
  if (cumulative[count - 1] < WINDOW) {
    const chord = Math.hypot(points[(count - 1) * 3] - points[0], points[(count - 1) * 3 + 2] - points[2]);
    return cumulative[count - 1] / Math.max(1, chord);
  }
  for (let i = 0; i < count; i += 1) {
    let j = i;
    while (j + 1 < count && cumulative[j] - cumulative[i] < WINDOW) j += 1;
    const along = cumulative[j] - cumulative[i];
    if (along < WINDOW * 0.9) break;
    const chord = Math.hypot(points[j * 3] - points[i * 3], points[j * 3 + 2] - points[i * 3 + 2]);
    weighted += (along / Math.max(1, chord)) * along;
    span += along;
  }
  return span > 0 ? weighted / span : 1;
};

type Group = {
  roads: number;
  length: number;
  straight: number;
  localWeighted: number;
  localSpan: number;
  curvatures: number[];
  straightLength: number;
  grades: number[];
  maxGrade: number;
};

const group = (): Group => ({
  roads: 0,
  length: 0,
  straight: 0,
  localWeighted: 0,
  localSpan: 0,
  curvatures: [],
  straightLength: 0,
  grades: [],
  maxGrade: 0,
});

for (const slug of PLACES) {
  const recipe = LOCATIONS[slug];
  if (!recipe) continue;
  const terrain = createTerrain(recipe, SEGMENTS);
  const plan = planTown(terrain, recipe, 1);
  const pois = resolvePois(terrain, recipe, plan.lots);
  const net = createRoadNetwork(terrain, recipe, pois, plan.lots);

  const groups = new Map<RoadKind, Group>();
  const scratch: RoadSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, curvature: 0 };
  const perRoad: string[] = [];
  const junctions: string[] = [];

  for (const road of net.roads) {
    const count = Math.floor(road.points.length / 3);
    if (count < 3) continue;
    const bucket = groups.get(road.kind) ?? group();
    groups.set(road.kind, bucket);

    const endToEnd = Math.hypot(
      road.points[(count - 1) * 3] - road.points[0],
      road.points[(count - 1) * 3 + 2] - road.points[2]
    );

    const cumulative: number[] = [0];
    for (let i = 1; i < count; i += 1) {
      cumulative.push(
        cumulative[i - 1] +
          Math.hypot(
            road.points[i * 3] - road.points[(i - 1) * 3],
            road.points[i * 3 + 2] - road.points[(i - 1) * 3 + 2]
          )
      );
    }
    const local = localSinuosity(road.points, cumulative);
    bucket.localWeighted += local * road.totalLength;
    bucket.localSpan += road.totalLength;

    const curvatures: number[] = [];
    let straightLength = 0;
    let worstGrade = 0;
    const grades: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const at = (road.totalLength * i) / (count - 1);
      net.sampleAt(road.index, Math.min(at, road.totalLength - 1e-4), scratch);
      const k = Math.abs(scratch.curvature);
      curvatures.push(k);
      bucket.curvatures.push(k);
      const run =
        i === 0
          ? 0
          : Math.hypot(
              road.points[i * 3] - road.points[(i - 1) * 3],
              road.points[i * 3 + 2] - road.points[(i - 1) * 3 + 2]
            );
      if (k < STRAIGHT) {
        straightLength += run;
        bucket.straightLength += run;
      }
      if (i > 0 && run > 0.01) {
        const grade = Math.abs(road.points[i * 3 + 1] - road.points[(i - 1) * 3 + 1]) / run;
        grades.push(grade);
        bucket.grades.push(grade);
        if (grade > worstGrade) worstGrade = grade;
      }
    }
    if (worstGrade > bucket.maxGrade) bucket.maxGrade = worstGrade;

    bucket.roads += 1;
    bucket.length += road.totalLength;
    bucket.straight += endToEnd;

    const sorted = curvatures.slice().sort((a, b) => a - b);
    perRoad.push(
      `    #${String(road.index).padStart(2)} ${road.kind.padEnd(9)} ${road.totalLength.toFixed(0).padStart(5)} m` +
        `  sinuosity ${(road.totalLength / Math.max(1, endToEnd)).toFixed(2)}` +
        `  local ${local.toFixed(3)}` +
        `  kmax ${quantile(sorted, 1).toFixed(4)} (r${radius(quantile(sorted, 1))} m)` +
        `  straight ${((straightLength / Math.max(1, road.totalLength)) * 100).toFixed(0)}%`
    );

    // How far a branch head finishes from the road it joins. Road 0 is the
    // trunk and starts nowhere in particular, so it has no junction to miss.
    if (road.index > 0) {
      let nearest = Infinity;
      for (const other of net.roads) {
        if (other.index === road.index) continue;
        const otherCount = Math.floor(other.points.length / 3);
        for (let j = 0; j < otherCount; j += 1) {
          const away = Math.hypot(other.points[j * 3] - road.points[0], other.points[j * 3 + 2] - road.points[2]);
          if (away < nearest) nearest = away;
        }
      }
      junctions.push(`#${road.index} ${road.kind} ${nearest.toFixed(1)} m`);
    }
  }

  console.log(`\n================ ${slug} ${TAG} ================`);
  console.log(`  ${net.roads.length} roads, ${net.decks.length} deck spans`);
  console.log(perRoad.join('\n'));
  console.log(
    '  kind       roads  length  sinuos   local   k50     k90     kmax    r(k90)  r(kmax) straight  grade50 gradeMax'
  );
  for (const kind of ['main', 'secondary', 'lane', 'trail'] as RoadKind[]) {
    const bucket = groups.get(kind);
    if (!bucket) continue;
    const sorted = bucket.curvatures.slice().sort((a, b) => a - b);
    const grades = bucket.grades.slice().sort((a, b) => a - b);
    console.log(
      `  ${kind.padEnd(10)} ${String(bucket.roads).padStart(5)} ${bucket.length.toFixed(0).padStart(7)}` +
        ` ${(bucket.length / Math.max(1, bucket.straight)).toFixed(3).padStart(7)}` +
        ` ${(bucket.localWeighted / Math.max(1, bucket.localSpan)).toFixed(3).padStart(7)}` +
        ` ${quantile(sorted, 0.5).toFixed(4)} ${quantile(sorted, 0.9).toFixed(4)} ${quantile(sorted, 1).toFixed(4)}` +
        ` ${radius(quantile(sorted, 0.9))} ${radius(quantile(sorted, 1))}` +
        ` ${((bucket.straightLength / Math.max(1, bucket.length)) * 100).toFixed(1).padStart(7)}%` +
        ` ${quantile(grades, 0.5).toFixed(3).padStart(8)} ${quantile(grades, 1).toFixed(3).padStart(8)}`
    );
  }

  console.log(`  junctions: ${junctions.length === 0 ? 'none' : junctions.join(', ')}`);

  const speeds: string[] = [];
  for (const kind of ['main', 'secondary', 'lane', 'trail'] as RoadKind[]) {
    const onKind = net.roads.filter((road) => road.kind === kind);
    if (onKind.length === 0) continue;
    for (const spec of FLEET) {
      if (!(spec.roads as readonly string[]).includes(kind)) continue;
      let meanSum = 0;
      let lengthSum = 0;
      let slowest = Infinity;
      for (const road of onKind) {
        const run = drive((distance, out) => net.sampleAt(road.index, distance, out), road.totalLength, spec);
        meanSum += run.mean * road.totalLength;
        lengthSum += road.totalLength;
        if (run.min < slowest) slowest = run.min;
      }
      speeds.push(
        `${kind}/${spec.name} ${(meanSum / Math.max(1, lengthSum)).toFixed(1)}/${slowest.toFixed(1)} of ${spec.cruise}`
      );
    }
  }
  console.log(`  speeds (mean/min m/s): ${speeds.join(', ')}`);

  net.dispose();
}
