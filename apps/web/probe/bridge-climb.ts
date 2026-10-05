import { createTerrain, LOCATIONS, type Terrain } from '@otrip/world';

import { createDock, findDockSite } from '@/scene/dock';
import { resolvePois } from '@/scene/points-of-interest';
import { createRailway } from '@/scene/railway';
import { createRoadNetwork } from '@/scene/road-network';
import { planTown } from '@/scene/town-plan';
import { afloatAt, WADE_DEPTH, wadeDrag } from '@/scene/swimming';
import type { Platform } from '@/scene/walker';

const SEGMENTS = Number(process.env.SEG ?? 416);
/** `walker.ts`'s own constants. */
const STEP_UP = 0.4;
const SPACING = 7;
/** `walker.ts`'s own gait ladder, for the speed on a deck over the river. */
const STROLL_SPEED = 1.4;
const SWIM_SPEED = 1.1;

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

/**
 * A body actually walking a path, not a body teleported onto it. `footY` carries
 * from step to step exactly as the walker's does — `footY = floorAt(...)` every
 * frame, against last frame's floor — which is the whole point: a surface more
 * than `STEP_UP` over the foot is invisible to `floorAt`, so the only way to
 * learn whether a deck can be reached is to try to arrive at it on foot.
 *
 * Stepped at 5 cm, which is finer than any frame the walker renders (a stroll at
 * 1.4 m/s is 2.3 cm a frame at 60 fps but 23 cm at 6 fps): the finer the step the
 * more help a continuous ramp gives, so a failure here is a failure at any
 * frame rate.
 */
const STEP = 0.05;

type Walk = {
  /** Metres the body ended up under the surface it was trying to walk on, worst case. */
  worst: number;
  /** Distance along the path where that happened. */
  worstAt: number;
  /** Distance along the path where the body first fell more than a step short. */
  lostAt: number;
  /** Shortfall at the end of the path. */
  ending: number;
  length: number;
};

/**
 * Walks `path` (x, y, z triples — y is the surface meant to be walked on) from a
 * standing start on the terrain at its head, and reports where the body failed to
 * keep up with it.
 */
const walkPath = (floorAt: (x: number, z: number, reference: number) => number, path: number[]): Walk => {
  const count = Math.floor(path.length / 3);
  let footY = Math.min(path[1], floorAt(path[0], path[2], Number.POSITIVE_INFINITY));
  const out: Walk = { worst: 0, worstAt: 0, lostAt: Number.POSITIVE_INFINITY, ending: 0, length: 0 };
  let travelled = 0;

  for (let i = 0; i < count - 1; i += 1) {
    const ax = path[i * 3];
    const ay = path[i * 3 + 1];
    const az = path[i * 3 + 2];
    const bx = path[(i + 1) * 3];
    const by = path[(i + 1) * 3 + 1];
    const bz = path[(i + 1) * 3 + 2];
    const run = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(run / STEP));
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const z = az + (bz - az) * t;
      footY = floorAt(x, z, footY);
      const short = y - footY;
      travelled += run / steps;
      if (short > out.worst) {
        out.worst = short;
        out.worstAt = travelled;
      }
      if (short > STEP_UP && travelled < out.lostAt) out.lostAt = travelled;
      out.ending = short;
    }
  }
  out.length = travelled;
  return out;
};

const metres = (value: number) => (Number.isFinite(value) ? `${value.toFixed(1)}m` : '—');

for (const slug of ['ta-xua', 'hoi-an', 'trang-an', 'ho-tay']) {
  const recipe = LOCATIONS[slug];
  if (!recipe?.water) continue;
  const terrain = createTerrain(recipe, SEGMENTS);
  const plan = planTown(terrain, recipe, 1);
  const landing = findDockSite(terrain, recipe, plan.lots);
  const pois = resolvePois(terrain, recipe, plan.lots, landing);
  const net = createRoadNetwork(terrain, recipe, pois, plan.lots);
  const rail = createRailway(terrain, recipe, { buildings: plan.lots.map((lot) => ({ x: lot.x, z: lot.z })) });
  const dock = createDock(terrain, recipe, landing);

  const platforms = [...(dock?.platforms ?? []), ...net.decks, ...rail.decks];
  const floorAt = makeFloorAt(terrain, indexPlatforms(platforms));
  const level = recipe.water.level;

  console.log(`\n=== ${slug} ===`);

  // --- every bridge, from both ends ----------------------------------------
  // A bridge is a run of carriageway over water. The walk starts where the road
  // is within a step of the ground — the only place a body on the ground can get
  // onto it — and runs to the middle of the span.
  const rows: string[] = [];
  let bridges = 0;
  let blocked = 0;
  let stranded = 0;
  for (const road of net.roads) {
    const count = Math.floor(road.points.length / 3);
    const overWater = (i: number) => terrain.heightAt(road.points[i * 3], road.points[i * 3 + 2]) < level + 0.4;
    const clearance = (i: number) =>
      road.points[i * 3 + 1] - terrain.heightAt(road.points[i * 3], road.points[i * 3 + 2]);

    let from = -1;
    for (let i = 0; i <= count; i += 1) {
      if (i < count && overWater(i)) {
        if (from < 0) from = i;
        continue;
      }
      if (from < 0) continue;
      const head = from;
      const tail = i - 1;
      from = -1;
      // A one-sample puddle crossing is not a bridge anybody notices.
      if ((tail - head + 1) * SPACING < 14) continue;
      bridges += 1;
      const mid = Math.round((head + tail) / 2);

      for (const side of ['near', 'far'] as const) {
        const dir = side === 'near' ? -1 : 1;
        const end = side === 'near' ? head : tail;
        // Out from the span until the carriageway is back within a step of the
        // ground. That is the boarding point, and how far away it is is the
        // answer to "how do I get up there".
        let board = end;
        let found = false;
        for (let at = end; at >= 0 && at < count; at += dir) {
          if (clearance(at) <= STEP_UP) {
            board = at;
            found = true;
            break;
          }
        }
        const along = (from: number): number[] => {
          const path: number[] = [];
          for (let at = from; dir > 0 ? at >= mid : at <= mid; at -= dir) {
            path.push(road.points[at * 3], road.points[at * 3 + 1], road.points[at * 3 + 2]);
          }
          return path;
        };
        const crown = along(board);
        if (Math.floor(crown.length / 3) < 2) continue;
        const walk = walkPath(floorAt, crown);

        // And now the journey the player actually makes: in from the field, over
        // the kerb, then along. Boarding is tested off the road rather than on the
        // crown because the ground four metres out is not the ground under the
        // centreline — a road whose crown sits on the terrain can still stand
        // clear of the verge beside it, and the walk up a bridge begins there.
        let onFoot = -1;
        for (let at = end; at >= 0 && at < count && Math.abs(at - end) * SPACING <= 400; at += dir) {
          const path = along(at);
          if (Math.floor(path.length / 3) < 2) continue;
          const cx = path[0];
          const cz = path[2];
          const nextAt = Math.min(count - 1, Math.max(0, at + 1));
          const tangentX = road.points[nextAt * 3] - cx;
          const tangentZ = road.points[nextAt * 3 + 2] - cz;
          const span = Math.hypot(tangentX, tangentZ) || 1;
          let reached = false;
          for (const sideways of [1, -1]) {
            const outX = (-tangentZ / span) * sideways * (road.width / 2 + 6);
            const outZ = (tangentX / span) * sideways * (road.width / 2 + 6);
            const fieldY = terrain.heightAt(cx + outX, cz + outZ);
            // Dry land only. A body that has to swim to the toe of the embankment
            // has not found a way onto the road, and the first run of this probe
            // counted those: it reported a way on 28 m from an abutment whose
            // verge is under the river.
            if (level - fieldY > WADE_DEPTH) continue;
            const field = [cx + outX, fieldY, cz + outZ, ...path];
            if (walkPath(floorAt, field).worst <= STEP_UP) reached = true;
          }
          if (reached) {
            onFoot = at;
            break;
          }
        }

        const ok = walk.worst <= STEP_UP;
        if (!ok) blocked += 1;
        if (onFoot < 0) stranded += 1;
        rows.push(
          `  ${road.kind} #${road.index} span@${head}-${tail} ${side.padEnd(4)} ` +
            `crown ${found ? `${metres(Math.abs(board - end) * SPACING)} out` : 'road ends on fill'} ` +
            `${ok ? 'walks up' : 'BLOCKED'} worst ${walk.worst.toFixed(2)}m | ` +
            `from the field ${onFoot < 0 ? 'NO WAY ON within 400m' : `${metres(Math.abs(onFoot - end) * SPACING)} out`}`
        );
      }
    }
  }
  console.log(
    `  bridges ${bridges}, crown approaches blocked ${blocked} of ${bridges * 2}, no way on from the field ${stranded}`
  );
  for (const row of rows) console.log(row);

  // --- the railway, same question ------------------------------------------
  // No alignment is exported, so the formation is walked off its own spans. They
  // come out of `deckChain` in order and each raised run is one call, so a tip
  // that does not meet the next span's tip is the end of a run — walking across
  // that gap would be walking on nothing, and counting it as a shortfall was how
  // this probe first read 79 m of missing deck on a line that has none.
  if (rail.built && rail.decks.length > 0) {
    // `inset` pulls the sample a hair inside the last plank. At exactly
    // `halfLength` the footprint test compares a float against itself and the
    // probe loses it rather than the deck: that read as 79.09 m of missing deck
    // at the lake end of the Hồ Tây viaduct, whose own bed is 79 m down.
    const tips = (span: Platform, end: -1 | 1, inset = 0) => {
      const alongX = Math.sin(span.yaw);
      const alongZ = Math.cos(span.yaw);
      const along = (span.halfLength - inset) * end;
      return [span.x + alongX * along, span.surfaceY + (span.grade ?? 0) * along, span.z + alongZ * along];
    };
    const runs: Platform[][] = [[rail.decks[0]]];
    for (let i = 1; i < rail.decks.length; i += 1) {
      const [px, , pz] = tips(rail.decks[i - 1], 1);
      const [nx, , nz] = tips(rail.decks[i], -1);
      if (Math.hypot(nx - px, nz - pz) > 1) runs.push([]);
      runs[runs.length - 1].push(rail.decks[i]);
    }

    let worst = 0;
    let worstRun = -1;
    let worstAt = 0;
    let worstLength = 0;
    for (let r = 0; r < runs.length; r += 1) {
      const path: number[] = [];
      for (const span of runs[r]) {
        path.push(...tips(span, -1, 0.01));
        path.push(...tips(span, 1, 0.01));
      }
      const back: number[] = [];
      for (let i = Math.floor(path.length / 3) - 1; i >= 0; i -= 1) {
        back.push(path[i * 3], path[i * 3 + 1], path[i * 3 + 2]);
      }
      for (const walk of [walkPath(floorAt, path), walkPath(floorAt, back)]) {
        if (walk.worst <= worst) continue;
        worst = walk.worst;
        worstRun = r;
        worstAt = walk.worstAt;
        worstLength = walk.length;
      }
    }
    console.log(
      `  railway ${rail.decks.length} spans in ${runs.length} raised runs, both ends each: ` +
        `worst ${worst.toFixed(2)}m (run ${worstRun} at ${metres(worstAt)}/${metres(worstLength)})`
    );
  }

  // --- the jetty, same question --------------------------------------------
  if (dock) {
    const [approach, deckSpan] = dock.platforms;
    const alongX = Math.sin(approach.yaw);
    const alongZ = Math.cos(approach.yaw);
    const grade = approach.grade ?? 0;
    const path: number[] = [];
    // To just inside the last plank. At exactly `halfLength` the footprint test
    // compares a float against itself and the probe loses it, which read as 2.64 m
    // of missing deck at Tràng An where the 0.5 m stride happened to land there.
    const end = approach.halfLength + deckSpan.halfLength * 2 - 0.01;
    for (let along = -approach.halfLength + 0.01; along <= end; along = Math.min(end, along + 0.5)) {
      const surface = along <= approach.halfLength ? approach.surfaceY + grade * along : deckSpan.surfaceY;
      path.push(approach.x + alongX * along, surface, approach.z + alongZ * along);
      if (along >= end) break;
    }
    const walk = walkPath(floorAt, path);
    console.log(
      `  jetty: worst ${walk.worst.toFixed(2)}m at ${metres(walk.worstAt)}/${metres(walk.length)}, ends ${walk.ending.toFixed(2)}m short`
    );
  }

  // --- what must stay unclimbable -------------------------------------------
  // `floorAt` can only ever hand back a surface within `STEP_UP` of the foot, so
  // nothing is scaled in one bound by construction. What the spans could still do
  // is lay a staircase of legal steps up the flank of an embankment, which is a
  // wall on screen. Walked broadside at every span: the gain per 5 cm of travel is
  // the thing to look at, because a flank the body arrives on top of over a
  // continuous rise of ground is a bank and not a wall.
  let flanks = 0;
  let scaled = 0;
  let steepest = 0;
  let boarded = 0;
  for (const span of platforms) {
    const alongX = Math.sin(span.yaw);
    const alongZ = Math.cos(span.yaw);
    const grade = span.grade ?? 0;
    const steps = Math.max(1, Math.ceil(span.halfLength / 4));
    for (let s = -steps; s <= steps; s += 1) {
      const along = (span.halfLength * s) / steps;
      const cx = span.x + alongX * along;
      const cz = span.z + alongZ * along;
      const surface = span.surfaceY + grade * along;
      for (const side of [-1, 1]) {
        const outX = span.halfWidth + 6;
        const startX = cx + alongZ * outX * side;
        const startZ = cz - alongX * outX * side;
        if (surface - terrain.heightAt(startX, startZ) <= STEP_UP) continue;
        flanks += 1;
        let footY = terrain.heightAt(startX, startZ);
        let onGround = true;
        const run = Math.hypot(cx - startX, cz - startZ);
        const count = Math.ceil(run / STEP);
        for (let k = 1; k <= count; k += 1) {
          const t = k / count;
          const px = startX + (cx - startX) * t;
          const pz = startZ + (cz - startZ) * t;
          const next = floorAt(px, pz, footY);
          if (next - footY > steepest) steepest = next - footY;
          // The step that takes a body standing on the ground up onto a span. It
          // can only ever be a span within `STEP_UP` of the ground at that very
          // point, which is what makes the flank of an embankment a wall and the
          // toe of it a way up: there is no staircase of legal steps up a fill,
          // because the ground under a fill does not rise.
          if (onGround) {
            const over = next - terrain.heightAt(px, pz);
            if (over > boarded) boarded = over;
          }
          onGround = next <= terrain.heightAt(px, pz) + 1e-6;
          footY = next;
        }
        if (surface - footY < 0.05) scaled += 1;
      }
    }
  }
  console.log(
    `  flanks over a step high: ${flanks} walked at broadside, ${scaled} ended on the deck, ` +
      `steepest single 5 cm gain ${steepest.toFixed(3)}m, highest step from the ground onto a span ` +
      `${boarded.toFixed(3)}m (cap ${STEP_UP})`
  );

  // --- the gait on the deck ------------------------------------------------
  // `walker.depthAt` reads `floorAt`, so a body on an unpublished deck over the
  // river is swimming and the ladder pulls the whole target to `SWIM_SPEED`. The
  // target is recomputed here off the real `afloat` to say it in m/s rather than
  // in metres of floor: the walk across every bridge, at a stroll.
  let slowest = STROLL_SPEED;
  let wettest = 0;
  let deckSamples = 0;
  for (const span of platforms) {
    const alongX = Math.sin(span.yaw);
    const alongZ = Math.cos(span.yaw);
    const grade = span.grade ?? 0;
    const steps = Math.max(2, Math.ceil(span.halfLength));
    for (let s = -steps; s <= steps; s += 1) {
      const along = (span.halfLength * s * 0.999) / steps;
      const sx = span.x + alongX * along;
      const sz = span.z + alongZ * along;
      const surface = span.surfaceY + grade * along;
      // Only where there is river under the span at all; the rest of a graded
      // road has no water to be pulled into.
      if (terrain.heightAt(sx, sz) >= level) continue;
      deckSamples += 1;
      const depth = Math.max(0, level - floorAt(sx, sz, surface));
      const afloat = afloatAt(depth);
      let target = STROLL_SPEED;
      if (depth > WADE_DEPTH) target *= wadeDrag(depth);
      target += (SWIM_SPEED - target) * afloat;
      if (target < slowest) slowest = target;
      if (depth > wettest) wettest = depth;
    }
  }
  console.log(
    `  stroll across every span over water: ${deckSamples} samples, deepest water under the foot ` +
      `${wettest.toFixed(2)}m, slowest target ${slowest.toFixed(2)} m/s (walk ${STROLL_SPEED}, swim ${SWIM_SPEED})`
  );

  // --- nothing publishes a roof --------------------------------------------
  // A house is horizontal collision only; `floorAt` knows no building surface at
  // all, so the one way onto a roof would be a span laid over a footprint.
  let roofs = 0;
  for (const lot of plan.lots) {
    if (floorAt(lot.x, lot.z, Number.POSITIVE_INFINITY) > terrain.heightAt(lot.x, lot.z) + STEP_UP) roofs += 1;
  }
  console.log(`  spans standing over a house footprint: ${roofs} of ${plan.lots.length}`);
}
