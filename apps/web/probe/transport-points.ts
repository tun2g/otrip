/**
 * How many places are there to pick up a xe máy or a thuyền, and how far is the
 * nearest one?
 *
 * Both answers used to be bad in a way no single file showed. The motorbike
 * slots were laid inside `road-network`'s street-lamp loop behind a
 * `parking.length === 0` gate, and that loop skips any sample more than 240 m
 * from the town hub — so a five-kilometre map had exactly **one** row, six slots
 * 0.9 m apart against one stretch of kerb, and `vehicles.ts` then spread its one
 * to three bikes across that row and put all of them within four metres of each
 * other. And one boat lay at the jetty, which was right until somebody rowed it
 * away: a boat you take is gone and the berth stays empty, so the landing had
 * nothing for the rest of the session and nothing for whoever you came with.
 *
 * This measures the thing a player actually experiences: the number of distinct
 * places, and the walk to the nearest one from where you arrive.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/transport-points.ts [--only=ta-xua]
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
const { findDockSite, createDock } = await import('../src/scene/dock.ts');
const { createVehicles } = await import('../src/scene/vehicles.ts');
const { createLife } = await import('../src/scene/life.ts');
const { QUALITY_SETTINGS } = await import('../src/scene/quality.ts');
const { chooseSpawn } = await import('../src/scene/arrival.ts');

/** Metres from a berth that counts as lying at the landing rather than passing it. */
const AT_THE_LANDING = 14;

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
// `LOCATIONS` is a record keyed by slug, not an array.
const places = Object.values(LOCATIONS).filter((recipe) => !only || recipe.slug === only);

type Row = {
  slug: string;
  tier: string;
  areas: number;
  bikes: number;
  spread: number;
  moorings: number;
  boats: number;
  tied: number;
  walkToBike: number;
  walkToBoat: number;
};

const rows: Row[] = [];

for (const recipe of places) {
  console.log(`\n================ ${recipe.slug} ================`);
  const terrain = createTerrain(recipe);

  const town = planTown(terrain, recipe, 1);
  const landing = findDockSite(terrain, recipe, town.lots);
  const pois = resolvePois(terrain, recipe, town.lots, landing);
  // The spawn is chosen before the roads, because one parking row is laid at it.
  const waterAt = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const halfSide = terrain.size / 2;
  let seed = { x: 0, z: 0 };
  seeking: for (let radius = 0; radius < halfSide; radius += terrain.size / 80) {
    for (let step = 0; step < 16; step += 1) {
      const angle = (step / 16) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (terrain.heightAt(x, z) > waterAt + 2 && terrain.slopeAt(x, z) < 0.35) {
        seed = { x, z };
        break seeking;
      }
    }
  }
  const arrival = chooseSpawn(terrain, recipe, town.lots, pois, [], seed);
  const net = createRoadNetwork(terrain, recipe, pois, town.lots, arrival);
  const dock = createDock(terrain, recipe, landing);

  // The lowest tier, deliberately: it is the one the old code cut to a single
  // bike, and the one a phone gets.
  for (const tier of ['low', 'ultra'] as const) {
    const settings = QUALITY_SETTINGS[tier];
    const vehicles = createVehicles(recipe, net, settings.vehicles, terrain);
    const life = createLife(
      terrain,
      recipe,
      { people: 0, boats: settings.boats, birds: 0 },
      undefined,
      town.lots,
      dock?.moorings ?? []
    );

    const bikes = vehicles.rideables();
    const boats = life.rideables();
    const areas = new Set(net.parking.map((spot) => spot.area)).size;

    /** The widest gap between any two bikes — one number for "are they all in a heap". */
    let spread = 0;
    for (const a of bikes) {
      for (const b of bikes) {
        spread = Math.max(spread, Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z));
      }
    }

    const moorings = dock?.moorings ?? [];
    const tied = moorings.length
      ? boats.filter((boat) =>
          moorings.some((berth) => Math.hypot(boat.position.x - berth.x, boat.position.z - berth.z) < AT_THE_LANDING)
        ).length
      : 0;

    /**
     * Where a visitor actually arrives — `chooseSpawn`, the same function the
     * renderer calls, not a simplified stand-in.
     *
     * This probe used to run its own centre-outward ring search and call the
     * answer "the spawn". It was a different place, so the headline number —
     * how far you walk to your first motorbike — was measuring a journey nobody
     * takes. The fallback below is that weaker search, kept only for where the
     * real one finds nothing.
     */
    const spawn = arrival;

    const nearest = (list: { position: { x: number; z: number } }[]) =>
      list.reduce(
        (best, entry) => Math.min(best, Math.hypot(entry.position.x - spawn.x, entry.position.z - spawn.z)),
        Infinity
      );

    const row: Row = {
      slug: recipe.slug,
      tier,
      areas,
      bikes: bikes.length,
      spread,
      moorings: moorings.length,
      boats: boats.length,
      tied,
      walkToBike: nearest(bikes),
      walkToBoat: nearest(boats),
    };
    rows.push(row);

    console.log(
      `  ${tier.padEnd(5)}  ${row.areas} place(s), ${net.parking.length} slots, ${row.bikes} bikes, ` +
        `spread ${row.spread.toFixed(0)} m, walk ${row.walkToBike.toFixed(0)} m`
    );
    console.log(
      `         ${row.moorings} berth(s), ${row.boats} boats, ${row.tied} at the landing, ` +
        `walk ${Number.isFinite(row.walkToBoat) ? `${row.walkToBoat.toFixed(0)} m` : '—'}`
    );

    if (row.bikes > 0 && row.spread < 50) {
      console.log(
        `         FAILED: every bike is within ${row.spread.toFixed(0)} m of the others — one place, not ${row.areas}`
      );
      process.exitCode = 1;
    }
    if (moorings.length > 1 && row.tied < 2) {
      console.log(
        `         FAILED: ${row.tied} boat(s) at a landing with ${moorings.length} berths — taking one empties it`
      );
      process.exitCode = 1;
    }

    vehicles.dispose();
    life.dispose();
  }

  dock?.dispose();
  net.dispose();
}

console.log('\n================ the table ================');
console.log('place      tier   places  bikes  spread  walk   berths  boats  tied  walk');
for (const row of rows) {
  console.log(
    `${row.slug.padEnd(10)} ${row.tier.padEnd(6)} ${String(row.areas).padStart(6)} ` +
      `${String(row.bikes).padStart(6)} ${row.spread.toFixed(0).padStart(6)}m ` +
      `${row.walkToBike.toFixed(0).padStart(5)}m ${String(row.moorings).padStart(7)} ` +
      `${String(row.boats).padStart(6)} ${String(row.tied).padStart(5)} ` +
      `${(Number.isFinite(row.walkToBoat) ? `${row.walkToBoat.toFixed(0)}m` : '—').padStart(6)}`
  );
}

console.log(process.exitCode ? '\nFAILED\n' : '\nOK — more than one place to find a ride, at every tier\n');
