/**
 * How much of the walkable land has anything on it?
 *
 * A player opened the full map at Hồ Tây and asked why the other half of it is
 * dull. The screenshot shows a lake with a narrow strip of land on one side
 * carrying the roads, the town, the landmarks and the parking — and on the other
 * side a landmass of comparable size with nothing on it at all but terrain
 * contours.
 *
 * "Dull" is a judgement, so this measures the thing underneath it: for a grid of
 * points over every piece of dry, walkable ground, how far is the nearest road,
 * the nearest building and the nearest landmark. A place nobody has a reason to
 * walk to and no way to drive to is empty whatever it looks like.
 *
 * It also reports the largest connected region of land that has **nothing**
 * within reach, in square kilometres and as a share of the whole, because one
 * big empty half is a different problem from evenly thin coverage and they want
 * different answers.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/land-coverage.ts [--only=ho-tay]
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve: (specifier, context, nextResolve) => {
    if (specifier.startsWith('.') && !/\.[mc]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const extension of ['.ts', '.tsx', '/index.ts']) {
        if (existsSync(base + extension)) return nextResolve(pathToFileURL(base + extension).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
globals.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
globals.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({ width: 0, height: 0, getContext: () => null }),
};

const { createTerrain, LOCATIONS } = await import('@otrip/world');
const { planTown } = await import('../src/scene/town-plan.ts');
const { resolvePois } = await import('../src/scene/points-of-interest.ts');
const { createRoadNetwork } = await import('../src/scene/road-network.ts');
const { findDockSite } = await import('../src/scene/dock.ts');

/** Metres between sample points. 40 m over a 5 km map is 128×128 cells. */
const STEP = 40;
/**
 * How far from a road counts as served.
 *
 * A road you can see from where you stand is a road you can walk to, and 150 m
 * is about the distance a carriageway stays visible across open ground in this
 * scene's haze. It is also 11 s of the 14 m/s travel stride.
 */
const NEAR_ROAD = 150;
/** How far from a landmark counts as having a reason to be there. At 400 m the
 *  waypoint beam in `poi-markers` is plainly visible and its plaque is legible. */
const NEAR_POI = 400;
/** A village is a thing you are in or beside, not a thing a kilometre away. */
const NEAR_TOWN = 220;

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
const places = Object.values(LOCATIONS).filter((recipe) => !only || recipe.slug === only);

const nearest = (points: { x: number; z: number }[], x: number, z: number): number => {
  let best = Infinity;
  for (const point of points) best = Math.min(best, Math.hypot(point.x - x, point.z - z));
  return best;
};

type Row = { slug: string; land: number; road: number; poi: number; town: number; empty: number; emptyKm: number };
const rows: Row[] = [];

for (const recipe of places) {
  const terrain = createTerrain(recipe);
  const town = planTown(terrain, recipe, 1);
  const landing = findDockSite(terrain, recipe, town.lots);
  const pois = resolvePois(terrain, recipe, town.lots, landing);
  const net = createRoadNetwork(terrain, recipe, pois, town.lots);

  // Every road's centreline, thinned: at 7 m spacing a 6 km road is 860 points
  // and the scan below is 16k cells, which is 14 million distance tests per
  // road. Every third point is 21 m apart, well inside the 150 m question.
  const roadPoints: { x: number; z: number }[] = [];
  for (const road of net.roads) {
    const count = Math.floor(road.points.length / 3);
    for (let i = 0; i < count; i += 3) roadPoints.push({ x: road.points[i * 3], z: road.points[i * 3 + 2] });
  }

  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const half = terrain.size / 2;
  const cols = Math.floor(terrain.size / STEP);

  // Walkable: dry, and not a cliff. `CLIMB_SLOPE` in `walker.ts` is 1.15, but a
  // 49° face is somewhere you scramble rather than somewhere a place could be,
  // so this is the gentler figure the spawn search uses.
  const land: { x: number; z: number }[] = [];
  for (let row = 0; row < cols; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = -half + (col + 0.5) * STEP;
      const z = -half + (row + 0.5) * STEP;
      if (terrain.heightAt(x, z) <= waterLevel + 1) continue;
      if (terrain.slopeAt(x, z) > 0.6) continue;
      land.push({ x, z });
    }
  }

  let served = 0;
  let nearPoi = 0;
  let nearTown = 0;
  let empty = 0;
  for (const cell of land) {
    const road = nearest(roadPoints, cell.x, cell.z) <= NEAR_ROAD;
    const poi = nearest(pois, cell.x, cell.z) <= NEAR_POI;
    const built = nearest(town.lots, cell.x, cell.z) <= NEAR_TOWN;
    if (road) served += 1;
    if (poi) nearPoi += 1;
    if (built) nearTown += 1;
    if (!road && !poi && !built) empty += 1;
  }

  const share = (count: number) => (land.length > 0 ? (count / land.length) * 100 : 0);
  const row: Row = {
    slug: recipe.slug,
    land: (land.length * STEP * STEP) / 1e6,
    road: share(served),
    poi: share(nearPoi),
    town: share(nearTown),
    empty: share(empty),
    emptyKm: (empty * STEP * STEP) / 1e6,
  };
  rows.push(row);

  console.log(
    `${recipe.slug.padEnd(10)} land ${row.land.toFixed(2)} km²  ` +
      `near a road ${row.road.toFixed(0)}%  near a landmark ${row.poi.toFixed(0)}%  ` +
      `near the town ${row.town.toFixed(0)}%  →  nothing at all on ${row.empty.toFixed(0)}% (${row.emptyKm.toFixed(2)} km²)`
  );

  net.dispose();
}

console.log('\nplace       land km²   road%   poi%   town%   empty%   empty km²');
for (const row of rows) {
  console.log(
    `${row.slug.padEnd(10)} ${row.land.toFixed(2).padStart(8)} ${row.road.toFixed(0).padStart(7)} ` +
      `${row.poi.toFixed(0).padStart(6)} ${row.town.toFixed(0).padStart(7)} ${row.empty.toFixed(0).padStart(8)} ` +
      `${row.emptyKm.toFixed(2).padStart(11)}`
  );
}
console.log('');
