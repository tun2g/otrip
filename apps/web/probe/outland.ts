/**
 * Is there anywhere to go out there, and does anything take you?
 *
 * `land-coverage.ts` answers how much of the land has something within reach of
 * it, which is a share of an area. This answers the question underneath the
 * complaint it was written for — "sao nửa map bên kia chán vậy" — which is not
 * about a percentage: it is whether there is a reason to walk out and whether
 * anything goes there.
 *
 * So it counts **places**, not cells. A place is one of the recipe's named
 * landmarks or one of the settlements `planTown` actually built — the latter
 * being the thing nothing downstream used to know about: the generator has been
 * putting four to twelve hamlets on every map and joining only the densest of
 * them to the roads. For each one it reports how far it is from the carriageway
 * or the đường mòn, whether it has anything at its centre, and the walk to it
 * from where a visitor arrives.
 *
 * It fails when a settlement of three houses or more stands further from the
 * network than `STRANDED`, because that is a place with no way to it, which is a
 * different and worse thing from open country.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/outland.ts [--only=ho-tay]
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
const { findLandmasses } = await import('../src/scene/landmass.ts');

/** Houses within this of each other are one settlement. Matches `road-network`. */
const HAMLET_LINK = 260;
/** Fewer houses than this is an outlying farm, not a place. Matches `road-network`. */
const HAMLET_MIN = 3;
/**
 * Further than this from the network and a settlement has no way to it.
 *
 * Deliberately slacker than `land-coverage`'s 150 m "near a road": a bản four
 * hundred metres up the hill from the lane is a bản with a lane, and the walk up
 * is the point. Past that there is no route at all, which is what this fails on.
 */
const STRANDED = 400;

const only = process.argv.find((argument) => argument.startsWith('--only='))?.slice(7);
const places = Object.values(LOCATIONS).filter((recipe) => !only || recipe.slug === only);

const away = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

const nearest = <T extends { x: number; z: number }>(list: readonly T[], to: { x: number; z: number }): number => {
  let best = Infinity;
  for (const entry of list) best = Math.min(best, away(entry, to));
  return best;
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

type Row = {
  slug: string;
  named: number;
  hamlets: number;
  shrines: number;
  joined: number;
  worst: number;
  walkFirst: number;
  walkSecond: number;
  spacing: number;
  onFoot: number;
};
const rows: Row[] = [];
let failures = 0;

for (const recipe of places) {
  const terrain = createTerrain(recipe);
  const town = planTown(terrain, recipe, 1);
  const landing = findDockSite(terrain, recipe, town.lots);
  const pois = resolvePois(terrain, recipe, town.lots, landing);
  const net = createRoadNetwork(terrain, recipe, pois, town.lots);

  console.log(`\n================ ${recipe.slug} ================`);

  // --- the settlements, grouped the way `road-network` groups them ----------
  const owner = new Int32Array(town.lots.length).fill(-1);
  const groups: { x: number; z: number; count: number; shrine: boolean }[] = [];
  for (let seed = 0; seed < town.lots.length; seed += 1) {
    if (owner[seed] >= 0) continue;
    const id = groups.length;
    const group = { x: 0, z: 0, count: 0, shrine: false };
    owner[seed] = id;
    const queue = [seed];
    while (queue.length > 0) {
      const at = queue.pop() as number;
      group.x += town.lots[at].x;
      group.z += town.lots[at].z;
      group.count += 1;
      if (town.lots[at].type === 'mieu') group.shrine = true;
      for (let other = 0; other < town.lots.length; other += 1) {
        if (owner[other] >= 0) continue;
        if (away(town.lots[at], town.lots[other]) > HAMLET_LINK) continue;
        owner[other] = id;
        queue.push(other);
      }
    }
    group.x /= group.count;
    group.z /= group.count;
    groups.push(group);
  }
  const hamlets = groups.filter((group) => group.count >= HAMLET_MIN).sort((a, b) => b.count - a.count);

  // Every road's centreline, thinned the way `land-coverage` thins it.
  const network: { x: number; z: number }[] = [];
  for (const road of net.roads) {
    const count = Math.floor(road.points.length / 3);
    for (let i = 0; i < count; i += 3) network.push({ x: road.points[i * 3], z: road.points[i * 3 + 2] });
  }

  /**
   * Where a visitor arrives. `world-renderer`'s own search is a private closure,
   * so this is the same rule rebuilt, including its fallback: rings out from the
   * first landmark on dry gentle ground that stands above its own surroundings
   * and has a clear sight line toward that landmark, and failing that the
   * renderer's `findSpawn` — centre-outward, off the cliffs and clear of
   * anybody's house. Tràng An takes the fallback, which is why its spawn is in
   * the middle of the floodplain rather than out by the summit.
   */
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const first = pois[0];
  const ringAverage = (x: number, z: number, radius: number) => {
    let total = 0;
    for (let step = 0; step < 8; step += 1) {
      const angle = (step / 8) * Math.PI * 2;
      total += terrain.heightAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
    }
    return total / 8;
  };
  const hasOutlook = (x: number, z: number) => {
    const eye = terrain.heightAt(x, z) + 2.5;
    const toward = Math.atan2(first.x - x, first.z - z);
    for (let step = 15; step <= 80; step += 15) {
      if (terrain.heightAt(x + Math.sin(toward) * step, z + Math.cos(toward) * step) > eye + 6) return false;
    }
    return true;
  };
  // The renderer's fallback, verbatim in rule: the first dry, gentle, unbuilt
  // ground on a ring walking out from the middle of the map.
  let spawn = { x: 0, z: 0 };
  fallback: for (let radius = 0; radius < terrain.size / 2; radius += terrain.size / 80) {
    for (let step = 0; step < 16; step += 1) {
      const angle = (step / 16) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (terrain.heightAt(x, z) <= waterLevel + 2 || terrain.slopeAt(x, z) >= 0.35) continue;
      if (!town.lots.every((lot) => away(lot, { x, z }) > lot.radius + 14)) continue;
      spawn = { x, z };
      break fallback;
    }
  }

  search: for (let radius = 260; radius < 900; radius += 45) {
    for (let step = 0; step < 24; step += 1) {
      const angle = (step / 24) * Math.PI * 2;
      const x = first.x + Math.cos(angle) * radius;
      const z = first.z + Math.sin(angle) * radius;
      if (Math.abs(x) > terrain.size / 2 - 40 || Math.abs(z) > terrain.size / 2 - 40) continue;
      if (terrain.heightAt(x, z) <= waterLevel + 2) continue;
      if (terrain.slopeAt(x, z) > 0.3) continue;
      if (terrain.heightAt(x, z) < ringAverage(x, z, terrain.size * 0.035) + terrain.maxHeight * 0.02) continue;
      if (!hasOutlook(x, z)) continue;
      spawn = { x, z };
      break search;
    }
  }

  /**
   * The headline: how much of the land you could stand on can you actually walk
   * to from where you arrive?
   *
   * Hồ Tây answered 48% to this, and that is the whole of the complaint in one
   * number — not that the far side was dull, but that a third of the houses were
   * on an island with a kilometre and a third of water round it. The recipe drew
   * the largest lake in Hanoi as a channel running edge to edge of the patch.
   *
   * The denominator is `land-coverage`'s walkable set, dry and under a 0.6
   * gradient, so the two probes agree on what counts as land. The flood that
   * fills it is allowed up to `CLIMB_SLOPE` from `walker.ts`, because a steep
   * saddle is something a walker crosses and must not read as a coastline — and
   * over `network.decks`, because a bridge is a floor. Without the decks Hội An
   * reads 49%: the Thu Bồn cuts it in two and the trunk has always crossed it,
   * so the number would be measuring the river rather than the walk.
   */
  const CLIMB_SLOPE = 1.15;
  const REACH_STEP = 20;
  const reachCols = Math.floor(terrain.size / REACH_STEP);
  const reachHalf = terrain.size / 2;
  // 0 impassable, 1 crossable, 2 crossable and somewhere a place could be
  const ground = new Uint8Array(reachCols * reachCols);
  for (let row = 0; row < reachCols; row += 1) {
    for (let col = 0; col < reachCols; col += 1) {
      const x = -reachHalf + (col + 0.5) * REACH_STEP;
      const z = -reachHalf + (row + 0.5) * REACH_STEP;
      if (terrain.heightAt(x, z) <= waterLevel + 1) continue;
      const gradient = terrain.slopeAt(x, z);
      if (gradient > CLIMB_SLOPE) continue;
      ground[row * reachCols + col] = gradient <= 0.6 ? 2 : 1;
    }
  }
  let standable = 0;
  for (const cell of ground) if (cell === 2) standable += 1;

  // Every deck span stamped onto the grid as crossable ground. Counted as
  // passage only, never as somewhere a place could be: a bridge is a way over,
  // not a piece of country.
  for (const deck of net.decks) {
    const alongX = Math.sin(deck.yaw);
    const alongZ = Math.cos(deck.yaw);
    const steps = Math.max(2, Math.ceil(deck.halfLength / (REACH_STEP / 2)));
    for (let i = -steps; i <= steps; i += 1) {
      const along = (i / steps) * deck.halfLength;
      for (let side = -1; side <= 1; side += 1) {
        const across = side * deck.halfWidth;
        const x = deck.x + alongX * along - alongZ * across;
        const z = deck.z + alongZ * along + alongX * across;
        const col = Math.floor((x + reachHalf) / REACH_STEP);
        const row = Math.floor((z + reachHalf) / REACH_STEP);
        if (col < 0 || row < 0 || col >= reachCols || row >= reachCols) continue;
        const at = row * reachCols + col;
        if (ground[at] === 0) ground[at] = 1;
      }
    }
  }

  const seen = new Uint8Array(ground.length);
  const cellAt = (at: { x: number; z: number }) =>
    Math.min(reachCols - 1, Math.max(0, Math.floor((at.z + reachHalf) / REACH_STEP))) * reachCols +
    Math.min(reachCols - 1, Math.max(0, Math.floor((at.x + reachHalf) / REACH_STEP)));
  /**
   * Where the flood starts. Normally the spawn — but `world-renderer`'s own
   * fallback samples sixteen bearings on each of forty rings, and on a karst
   * floodplain threaded with towers that can miss every time and return the
   * middle of the map, which at Tràng An is a limestone flank at a gradient
   * above `CLIMB_SLOPE`. Flooding from a cell nobody can stand on answers 0% to
   * a question about the country, so it falls back to the largest settlement and
   * says which it used.
   */
  let from = cellAt(spawn);
  let floodedFrom = 'the spawn';
  if (ground[from] === 0 && hamlets.length > 0) {
    from = cellAt(hamlets[0]);
    floodedFrom = 'the main settlement, the spawn being on ground nobody can stand on';
  }
  const start = from;
  let reached = 0;
  if (ground[start] > 0) {
    const queue = [start];
    seen[start] = 1;
    while (queue.length > 0) {
      const at = queue.pop() as number;
      if (ground[at] === 2) reached += 1;
      const col = at % reachCols;
      const row = (at - col) / reachCols;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const nc = col + dc;
          const nr = row + dr;
          if (nc < 0 || nr < 0 || nc >= reachCols || nr >= reachCols) continue;
          const next = nr * reachCols + nc;
          if (ground[next] === 0 || seen[next] === 1) continue;
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
  }
  const onFoot = standable > 0 ? (reached / standable) * 100 : 0;
  console.log(
    `  walkable land ${((standable * REACH_STEP * REACH_STEP) / 1e6).toFixed(2)} km², ` +
      `of which ${onFoot.toFixed(0)}% can be reached on foot from ${floodedFrom} ` +
      `(${((reached * REACH_STEP * REACH_STEP) / 1e6).toFixed(2)} km²)`
  );

  const land = recipe.water ? findLandmasses(terrain, recipe.water.level) : null;
  const homeGround = land ? land.at(spawn.x, spawn.z) : 0;
  /**
   * The same tolerance `resolvePois` uses, and for the same reason: the landmass
   * flood is on a ~20 m grid and a jetty stands at the waterline, so Hồ Tây's
   * "Bờ hồ" — 260 m from the spawn on the same bank — reads as open water on the
   * point alone and was reported as being on the far side of the lake.
   */
  const onHomeGround = (at: { x: number; z: number }): boolean => {
    if (!land) return true;
    if (land.at(at.x, at.z) === homeGround) return true;
    const reach = terrain.size / 90;
    for (let step = 0; step < 8; step += 1) {
      const angle = (step / 8) * Math.PI * 2;
      if (land.at(at.x + Math.cos(angle) * reach, at.z + Math.sin(angle) * reach) === homeGround) return true;
    }
    return false;
  };
  console.log(
    `  spawn (${spawn.x.toFixed(0)}, ${spawn.z.toFixed(0)})` +
      (land ? `  on landmass ${homeGround} of ${land.count}, ${(land.area[homeGround] / 1e6).toFixed(2)} km²` : '')
  );

  for (const poi of pois) {
    const walk = away(poi, spawn);
    console.log(
      `  landmark  ${poi.name.padEnd(22)} ${poi.kind.padEnd(7)} road ${nearest(network, poi).toFixed(0).padStart(5)} m  ` +
        `walk ${walk.toFixed(0).padStart(5)} m` +
        (onHomeGround(poi) ? '' : '  OFF THE SPAWN LANDMASS') +
        (poi.fallback ? `  fallback=${poi.fallback}` : '')
    );
  }

  let joined = 0;
  let worst = 0;
  for (const hamlet of hamlets) {
    const road = nearest(network, hamlet);
    if (road <= STRANDED) joined += 1;
    else worst = Math.max(worst, road);
    console.log(
      `  hamlet    ${String(hamlet.count).padStart(3)} houses  ${hamlet.shrine ? 'miếu  ' : '      '} ` +
        `(${hamlet.x.toFixed(0).padStart(6)}, ${hamlet.z.toFixed(0).padStart(6)})  road ${road.toFixed(0).padStart(5)} m  ` +
        `walk ${away(hamlet, spawn).toFixed(0).padStart(5)} m` +
        (road > STRANDED ? '  STRANDED' : '')
    );
  }

  // Spacing between everything there is to go to, nearest-neighbour. A median
  // well under the map's half-extent is what "somewhere to go next" looks like.
  const destinations = [...pois.map((poi) => ({ x: poi.x, z: poi.z })), ...hamlets];
  const gaps: number[] = [];
  for (const one of destinations) {
    let best = Infinity;
    for (const other of destinations) {
      if (one === other) continue;
      best = Math.min(best, away(one, other));
    }
    if (Number.isFinite(best)) gaps.push(best);
  }

  const walks = destinations.map((place) => away(place, spawn)).sort((a, b) => a - b);
  const row: Row = {
    slug: recipe.slug,
    named: pois.length,
    hamlets: hamlets.length,
    shrines: hamlets.filter((hamlet) => hamlet.shrine).length,
    joined,
    worst,
    walkFirst: walks[0] ?? 0,
    walkSecond: walks[1] ?? 0,
    spacing: median(gaps),
    onFoot,
  };
  rows.push(row);

  console.log(
    `  ${row.named} landmarks + ${row.hamlets} settlements = ${destinations.length} places, ` +
      `${row.shrines} with a miếu, ${row.joined}/${row.hamlets} joined to the network`
  );
  console.log(
    `  nearest place to the spawn ${row.walkFirst.toFixed(0)} m, next ${row.walkSecond.toFixed(0)} m, ` +
      `median gap between places ${row.spacing.toFixed(0)} m`
  );

  // 90 rather than 95 because Tà Xùa answers 92 and is right to: a ridge with
  // 900 m of relief has shelves of gentle ground behind faces steeper than
  // `CLIMB_SLOPE`, and 0.67 km² of them is the mountain being a mountain. The
  // gate is here to catch a piece of country with no way to it at all, which is
  // what Hồ Tây was at 48%.
  if (row.onFoot < 90) {
    console.log(`  FAILED: ${(100 - row.onFoot).toFixed(0)}% of the land you could stand on cannot be walked to`);
    failures += 1;
  }
  if (row.joined < row.hamlets) {
    console.log(`  FAILED: ${row.hamlets - row.joined} settlement(s) with no road or path inside ${STRANDED} m`);
    failures += 1;
  }

  net.dispose();
}

console.log('\nplace      landmarks  hamlets  miếu  joined  walk to 1st  to 2nd  median gap  on foot');
for (const row of rows) {
  console.log(
    `${row.slug.padEnd(10)} ${String(row.named).padStart(9)} ${String(row.hamlets).padStart(8)} ` +
      `${String(row.shrines).padStart(5)} ${`${row.joined}/${row.hamlets}`.padStart(7)} ` +
      `${`${row.walkFirst.toFixed(0)} m`.padStart(12)} ${`${row.walkSecond.toFixed(0)} m`.padStart(7)} ` +
      `${`${row.spacing.toFixed(0)} m`.padStart(11)} ${`${row.onFoot.toFixed(0)}%`.padStart(8)}`
  );
}
console.log('');
if (failures > 0) process.exitCode = 1;
