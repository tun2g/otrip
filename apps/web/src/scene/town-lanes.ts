import type { Prng, Terrain } from '@otrip/world';

/**
 * The geometry a village is laid out on: finding ground that will take a
 * building, and tracing a lane across it. Kept apart from the planner because
 * none of it knows what a building is — it is all terrain and arclength.
 */

export type Point = { x: number; z: number };

export const gradient = (terrain: Terrain, x: number, z: number): Point => {
  const step = terrain.size / terrain.segments;
  return {
    x: (terrain.heightAt(x + step, z) - terrain.heightAt(x - step, z)) / (2 * step),
    z: (terrain.heightAt(x, z + step) - terrain.heightAt(x, z - step)) / (2 * step),
  };
};

/** Highest and lowest ground under a footprint, on a 3x3 grid of samples. */
export const padUnder = (
  terrain: Terrain,
  x: number,
  z: number,
  yaw: number,
  width: number,
  depth: number
): { high: number; low: number } => {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;

  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const lx = (-0.5 + i / 2) * width;
      const lz = (-0.5 + j / 2) * depth;
      const height = terrain.heightAt(x + lx * cos + lz * sin, z - lx * sin + lz * cos);
      if (height > high) high = height;
      if (height < low) low = height;
    }
  }
  return { high, low };
};

/**
 * Walks a seed point up or down the gradient until it reaches the height band a
 * settlement wants, then shuffles sideways to the flattest ground nearby.
 *
 * Rejection sampling alone is not enough: at Tràng An barely a fifth of a
 * percent of the map is both dry and gentle, so a thousand random points find
 * nothing while a dozen gradient steps land on the shore apron every time.
 */
export const seekSite = (
  terrain: Terrain,
  start: Point,
  low: number,
  high: number,
  random: Prng
): { x: number; z: number; slope: number } => {
  let at = start;
  const limit = terrain.size / 2 - 60;

  for (let step = 0; step < 24; step += 1) {
    const here = terrain.heightAt(at.x, at.z);
    if (here >= low && here <= high) break;
    const slope = gradient(terrain, at.x, at.z);
    const length = Math.hypot(slope.x, slope.z);
    if (length < 1e-4) break;

    const target = here < low ? low : high;
    const uphill = here < low ? 1 : -1;
    const reach = Math.min(90, Math.max(10, Math.abs(target - here) / length));
    const next = { x: at.x + (uphill * slope.x * reach) / length, z: at.z + (uphill * slope.z * reach) / length };
    if (Math.max(Math.abs(next.x), Math.abs(next.z)) > limit) break;
    at = next;
  }

  // Then a few rings of 8 probes, keeping whichever is flattest and still in
  // band. This is what turns "somewhere on the shore" into "a buildable pad".
  let best = { x: at.x, z: at.z, slope: terrain.slopeAt(at.x, at.z) };
  for (let ring = 0; ring < 2; ring += 1) {
    const reach = 44 / (ring + 1);
    const turn = random() * Math.PI * 2;
    for (let i = 0; i < 6; i += 1) {
      const angle = turn + (i / 6) * Math.PI * 2;
      const x = best.x + Math.cos(angle) * reach;
      const z = best.z + Math.sin(angle) * reach;
      if (Math.max(Math.abs(x), Math.abs(z)) > limit) continue;
      const height = terrain.heightAt(x, z);
      if (height < low || height > high) continue;
      const slope = terrain.slopeAt(x, z);
      if (slope < best.slope) best = { x, z, slope };
    }
  }
  return best;
};

/**
 * Traces one arm of a lane. Each step turns a little towards the local contour,
 * so the lane runs along the hill rather than straight up it — which is why the
 * houses hung off it end up on ground they can actually stand on.
 */
export const traceArm = (
  terrain: Terrain,
  start: Point,
  heading: Point,
  nodes: number,
  stride: number,
  usable: (x: number, z: number) => boolean
): Point[] => {
  const points: Point[] = [start];
  let at = start;
  let dir = heading;

  for (let i = 1; i < nodes; i += 1) {
    const slope = gradient(terrain, at.x, at.z);
    const length = Math.hypot(slope.x, slope.z);
    if (length > 0.02) {
      let cx = -slope.z / length;
      let cz = slope.x / length;
      if (cx * dir.x + cz * dir.z < 0) {
        cx = -cx;
        cz = -cz;
      }
      const bx = dir.x * 0.62 + cx * 0.38;
      const bz = dir.z * 0.62 + cz * 0.38;
      const blended = Math.hypot(bx, bz);
      dir = { x: bx / blended, z: bz / blended };
    }

    const next = { x: at.x + dir.x * stride, z: at.z + dir.z * stride };
    if (!usable(next.x, next.z)) break;
    at = next;
    points.push(at);
  }

  return points;
};

export type Lane = { points: Point[]; length: number };

export const makeLane = (points: Point[]): Lane => {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return { points, length };
};

/** Position and unit tangent at arclength `at` along the lane. */
export const alongLane = (lane: Lane, at: number): { x: number; z: number; tx: number; tz: number } => {
  let walked = 0;
  for (let i = 1; i < lane.points.length; i += 1) {
    const a = lane.points[i - 1];
    const b = lane.points[i];
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    if (span < 1e-6) continue;
    if (walked + span >= at || i === lane.points.length - 1) {
      const t = Math.min(1, Math.max(0, (at - walked) / span));
      return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        tx: (b.x - a.x) / span,
        tz: (b.z - a.z) / span,
      };
    }
    walked += span;
  }
  return { x: lane.points[0].x, z: lane.points[0].z, tx: 1, tz: 0 };
};
