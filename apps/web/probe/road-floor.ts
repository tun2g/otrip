import { createTerrain, LOCATIONS, type Terrain } from '@otrip/world';

import { resolvePois } from '@/scene/points-of-interest';
import { createRailway } from '@/scene/railway';
import { createRoadNetwork } from '@/scene/road-network';
import { planTown } from '@/scene/town-plan';
import type { Platform } from '@/scene/walker';

const SEGMENTS = Number(process.env.SEG ?? 416);
/** `walker.ts`'s own constant. A floor this far under the foot cannot be felt. */
const STEP_UP = 0.4;

type Deck = { platform: Platform; alongX: number; alongZ: number; grade: number; reachSquared: number };

const indexPlatforms = (list: Platform[]): Deck[] =>
  list.map((platform) => ({
    platform,
    alongX: Math.sin(platform.yaw),
    alongZ: Math.cos(platform.yaw),
    grade: platform.grade ?? 0,
    reachSquared: (platform.halfLength + platform.halfWidth) ** 2,
  }));

/** `walker.ts`'s `floorAt`, transcribed, so the probe measures what the walker sees. */
const makeFloorAt =
  (terrain: Terrain, decks: Deck[]) =>
  (x: number, z: number, reference: number): number => {
    let best = terrain.heightAt(x, z);
    for (let index = 0; index < decks.length; index += 1) {
      const deck = decks[index];
      const dx = x - deck.platform.x;
      const dz = z - deck.platform.z;
      if (dx * dx + dz * dz > deck.reachSquared) continue;
      const along = dx * deck.alongX + dz * deck.alongZ;
      if (Math.abs(along) > deck.platform.halfLength) continue;
      const across = dx * deck.alongZ - dz * deck.alongX;
      if (Math.abs(across) > deck.platform.halfWidth) continue;
      const surface = deck.platform.surfaceY + deck.grade * along;
      if (surface <= best || surface > reference + STEP_UP) continue;
      best = surface;
    }
    return best;
  };

type Tally = { n: number; tight: number; step: number; worst: number; where: string };
const tally = (): Tally => ({ n: 0, tight: 0, step: 0, worst: 0, where: '' });
const note = (into: Tally, error: number, where: string) => {
  into.n += 1;
  if (error < 0.1) into.tight += 1;
  if (error < STEP_UP) into.step += 1;
  if (error > into.worst) {
    into.worst = error;
    into.where = where;
  }
};
const show = (label: string, t: Tally) =>
  t.n === 0
    ? `${label} n/a`
    : `${label} ${((t.tight / t.n) * 100).toFixed(1)}% <10cm, ${((t.step / t.n) * 100).toFixed(1)}% <step, worst ${t.worst.toFixed(2)}m${t.where ? ` (${t.where})` : ''}`;

for (const slug of ['ta-xua', 'hoi-an', 'trang-an', 'ho-tay']) {
  const recipe = LOCATIONS[slug];
  if (!recipe) continue;
  const terrain = createTerrain(recipe, SEGMENTS);
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const plan = planTown(terrain, recipe, 1);
  const pois = resolvePois(terrain, recipe, plan.lots);
  const net = createRoadNetwork(terrain, recipe, pois, plan.lots);
  const rail = createRailway(terrain, recipe, { buildings: plan.lots.map((lot) => ({ x: lot.x, z: lot.z })) });

  const platforms = [...net.decks, ...rail.decks];
  const floorAt = makeFloorAt(terrain, indexPlatforms(platforms));

  // --- walking the carriageway ---------------------------------------------
  const road = tally();
  const overWater = tally();
  /**
   * Samples of road surface above the waterline whose floor is below it. These
   * are the ones the user reported: `walker.depthAt` reads `floorAt`, so a body
   * standing on an unpublished embankment over low ground is swimming, and the
   * gait ladder drops it to the waterline — on the road, in the water.
   */
  let drySamples = 0;
  let drowned = 0;
  for (const entry of net.roads) {
    const count = Math.floor(entry.points.length / 3);
    for (let i = 0; i < count; i += 1) {
      const x = entry.points[i * 3];
      const y = entry.points[i * 3 + 1];
      const z = entry.points[i * 3 + 2];
      const next = Math.min(count - 1, i + 1);
      const dx = entry.points[next * 3] - x;
      const dz = entry.points[next * 3 + 2] - z;
      const run = Math.hypot(dx, dz) || 1;
      const normalX = -dz / run;
      const normalZ = dx / run;
      // Centreline and both kerbs, 30 cm inside the edge: a span narrower than
      // the carriageway drops the walker off the side of the road.
      const edge = Math.max(0, entry.width / 2 - 0.3);
      for (const offset of [0, edge, -edge]) {
        const sx = x + normalX * offset;
        const sz = z + normalZ * offset;
        const floor = floorAt(sx, sz, y);
        const error = y - floor;
        const where = `${entry.kind} #${entry.index}@${i}`;
        note(road, error, where);
        if (terrain.heightAt(sx, sz) < waterLevel) note(overWater, error, where);
        if (y > waterLevel) {
          drySamples += 1;
          if (floor < waterLevel) drowned += 1;
        }
      }
    }
  }

  // --- the spans' own surfaces, densely -----------------------------------
  // Every square metre of every published span, to catch a gap between two
  // rectangles or a merged one that does not hold the surface it stands for.
  const integrity = (list: Platform[]): Tally => {
    const into = tally();
    for (const span of list) {
      const alongX = Math.sin(span.yaw);
      const alongZ = Math.cos(span.yaw);
      const steps = Math.max(2, Math.ceil(span.halfLength));
      for (let s = -steps; s <= steps; s += 1) {
        // Just inside the tip. At exactly `halfLength` the footprint test is a
        // float comparison against itself, which the probe loses rather than the
        // deck — and the outermost tip of the overlap pad is past the road
        // anyway. Measured, every failure at 1.000 was interior-clean at 0.999.
        const along = (span.halfLength * s * 0.999) / steps;
        for (const across of [0, span.halfWidth * 0.9, span.halfWidth * -0.9]) {
          const sx = span.x + alongX * along + alongZ * across;
          const sz = span.z + alongZ * along - alongX * across;
          const surface = span.surfaceY + (span.grade ?? 0) * along;
          note(into, surface - floorAt(sx, sz, surface), '');
        }
      }
    }
    return into;
  };

  // --- under the spans -----------------------------------------------------
  // Swimming or wading under a bridge: the floor has to stay the bed. Sampled
  // every metre along each span rather than at its centre, because a merged span
  // can be four hundred metres long and only cross the river in the middle.
  let pulled = 0;
  let underTested = 0;
  for (const span of platforms) {
    const alongX = Math.sin(span.yaw);
    const alongZ = Math.cos(span.yaw);
    const steps = Math.max(2, Math.ceil(span.halfLength));
    for (let s = -steps; s <= steps; s += 1) {
      const along = (span.halfLength * s) / steps;
      const sx = span.x + alongX * along;
      const sz = span.z + alongZ * along;
      const bed = terrain.heightAt(sx, sz);
      if (span.surfaceY + (span.grade ?? 0) * along - bed < 2) continue;
      underTested += 1;
      if (floorAt(sx, sz, bed) > bed + 0.01) pulled += 1;
    }
  }

  // --- cost ----------------------------------------------------------------
  const probes = new Float64Array(20000);
  const half = terrain.size / 2;
  for (let i = 0; i < probes.length; i += 1) probes[i] = Math.random() * terrain.size - half;
  for (let pass = 0; pass < 3; pass += 1) {
    for (let i = 0; i < probes.length; i += 2) floorAt(probes[i], probes[i + 1], 1e9);
  }
  const start = performance.now();
  for (let i = 0; i < probes.length; i += 2) floorAt(probes[i], probes[i + 1], 1e9);
  const micros = ((performance.now() - start) / (probes.length / 2)) * 1000;

  console.log(`\n=== ${slug} ===`);
  console.log(`  ${show('road   ', road)}`);
  console.log(`  ${show('over water', overWater)}`);
  console.log(
    `  in the water while on the road: ${drowned} of ${drySamples} dry-road samples (${((drowned / Math.max(1, drySamples)) * 100).toFixed(2)}%)`
  );
  console.log(`  ${show('road spans', integrity(net.decks))}`);
  console.log(`  ${show('rail spans', integrity(rail.decks))}`);
  console.log(`  under spans: ${underTested} tested, ${pulled} pulled up`);
  console.log(
    `  spans ${net.decks.length} road + ${rail.decks.length} rail = ${platforms.length}, floorAt ${micros.toFixed(2)} us/call`
  );
}
