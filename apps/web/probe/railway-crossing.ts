/**
 * Can you get onto the railway, does the line wall a road off, and what happens
 * when the train arrives?
 *
 * The reported bug, in the player's words: "chưa đi lên được đường ray, chưa xử
 * lí va chạm với xe lửa" — you cannot get up onto the track, and nothing happens
 * when the train comes. The screenshot behind it is a carriageway running at the
 * camera with the formation crossing it on a raised bank, a hard edge from kerb
 * to kerb, and the road carrying on untouched on the far side.
 *
 * None of that can be read off `railway.ts` alone. The barrier is the product of
 * three files that never mention each other: the embankment publishes obstacle
 * cylinders, the crest publishes walkable spans, and `walker.ts` decides with
 * `STEP_UP` and `gatherContacts` which of the two a body meets. So this builds
 * the real alignment from the real seeds, reproduces `world-renderer.ts`'s own
 * pipeline up to the point `createRailway` is called, and then walks a real
 * `createWalker` at it and runs a real train into it.
 *
 * Every measurement is taken twice, against `legacyFormation` below — the deck
 * and obstacle rules as they stood when the report came in — and against
 * `buildRailFormation`, so the fix is shown to be a fix rather than asserted.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/railway-crossing.ts [--only=ho-tay]
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

// `createWalker` binds keyboard, pointer and pointer-lock listeners the moment
// it is made, and the smoke shader reads `devicePixelRatio` behind a
// `typeof window` guard — so both are declared rather than left undefined.
const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
globals.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
globals.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  pointerLockElement: null,
  exitPointerLock: () => {},
  createElement: () => ({ width: 0, height: 0, getContext: () => null }),
};

const { createPrng, createTerrain, LOCATIONS } = await import('@otrip/world');
const { PerspectiveCamera } = await import('three');
const { collectGroundClaims } = await import('../src/scene/ground-claims.ts');
const { createObstacleIndex } = await import('../src/scene/obstacle-index.ts');
const { resolvePois } = await import('../src/scene/points-of-interest.ts');
const { createRailway } = await import('../src/scene/railway.ts');
const { buildAlignment, choosePlan, RAIL_ABOVE_FORMATION, RAIL_HEIGHT, SLEEPER_LENGTH, STATION_STEP } =
  await import('../src/scene/railway-alignment.ts');
const { buildRailFormation, findRailCrossings, FORMATION_STEP } = await import('../src/scene/railway-formation.ts');
const { createRoadNetwork, deckChain } = await import('../src/scene/road-network.ts');
const { createVehicles } = await import('../src/scene/vehicles.ts');
const { createTownMeshes } = await import('../src/scene/town-meshes.ts');
const { planTown, yieldToClaims } = await import('../src/scene/town-plan.ts');
const { createWalker } = await import('../src/scene/walker.ts');

type Terrain = ReturnType<typeof createTerrain>;
type Alignment = ReturnType<typeof buildAlignment>;
type Network = ReturnType<typeof createRoadNetwork>;
type Platform = Network['decks'][number];
type Obstacle = { x: number; z: number; radius: number; bottom: number; top: number };
type Formation = { decks: Platform[]; obstacles: Obstacle[] };

const SEGMENTS = 416;
const DELTA = 1 / 60;
/** `walker.ts`'s own, so the replica below answers what the walker answered. */
const STEP_UP = 0.4;
/** `walker.ts`'s `SHOULDER`: the radius a contact is tested against on foot. */
const SHOULDER = 0.45;

if (FORMATION_STEP !== STEP_UP) {
  throw new Error(`railway-formation's FORMATION_STEP is ${FORMATION_STEP}, walker.ts's STEP_UP is ${STEP_UP}`);
}

/** `walker.floorAt`, transcribed, so a table of surfaces can be read without a frame. */
const makeFloorAt = (terrain: Terrain, platforms: Platform[]) => {
  const decks = platforms.map((platform) => ({
    platform,
    alongX: Math.sin(platform.yaw),
    alongZ: Math.cos(platform.yaw),
    grade: platform.grade ?? 0,
    reachSquared: (platform.halfLength + platform.halfWidth) ** 2,
  }));
  return (x: number, z: number, reference: number): number => {
    let best = terrain.heightAt(x, z);
    for (const deck of decks) {
      const dx = x - deck.platform.x;
      const dz = z - deck.platform.z;
      if (dx * dx + dz * dz > deck.reachSquared) continue;
      const along = dx * deck.alongX + dz * deck.alongZ;
      if (Math.abs(along) > deck.platform.halfLength) continue;
      if (Math.abs(dx * deck.alongZ - dz * deck.alongX) > deck.platform.halfWidth) continue;
      const surface = deck.platform.surfaceY + deck.grade * along;
      if (surface <= best || surface > reference + STEP_UP) continue;
      best = surface;
    }
    return best;
  };
};

/**
 * The formation as `railway.ts` published it when the report came in: spans at
 * sleeper width wherever the crest cleared the ground at all, and cylinders every
 * 12 m of chainage only where the fill passed 1.2 m.
 *
 * Kept verbatim rather than described, because the whole claim below is a
 * comparison against it and a paraphrase would be a comparison against a
 * paraphrase.
 */
const legacyFormation = (alignment: Alignment): Formation => {
  const decks: Platform[] = [];
  const obstacles: Obstacle[] = [];
  const crestOf = (i: number) => alignment.y[i] - RAIL_HEIGHT;

  const deckPoints: number[] = [];
  let raisedFrom = -1;
  for (let i = 0; i <= alignment.count; i += 1) {
    if (i < alignment.count && crestOf(i) - alignment.ground[i] > 0.04) {
      if (raisedFrom < 0) raisedFrom = i;
      continue;
    }
    if (raisedFrom < 0) continue;
    const head = Math.max(0, raisedFrom - 2);
    const tail = Math.min(alignment.count - 1, i - 1 + 2);
    raisedFrom = -1;
    deckPoints.length = 0;
    for (let at = head; at <= tail; at += 1) deckPoints.push(alignment.x[at], crestOf(at), alignment.z[at]);
    deckChain(deckPoints, SLEEPER_LENGTH / 2, decks);
  }

  for (let i = 0; i < alignment.count; i += Math.max(1, Math.round(12 / alignment.step))) {
    const fill = alignment.y[i] - RAIL_ABOVE_FORMATION - alignment.ground[i];
    if (fill < 1.2) continue;
    if (alignment.structure[i] === 'bridge') continue;
    obstacles.push({
      x: alignment.x[i],
      z: alignment.z[i],
      radius: 1.5 + 1.5 * Math.min(fill, 11) * 0.5,
      bottom: alignment.ground[i],
      top: crestOf(i),
    });
  }
  return { decks, obstacles };
};

/** The spawn scatter is `Math.random`; held to one sequence so runs compare. */
const seeded = <T>(build: () => T): T => {
  const real = Math.random;
  let state = 0x2f6e2b1;
  Math.random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  try {
    return build();
  } finally {
    Math.random = real;
  }
};

const listener = { addEventListener: () => {}, removeEventListener: () => {} } as unknown as HTMLElement;

/**
 * The stick that walks a body toward a point on the ground.
 *
 * On foot the step is **camera**-relative and not body-relative: `walker.ts`
 * builds `forward` from `cameraYaw` and screen-right as `(-forward.z, 0,
 * forward.x)`, then takes the stick's y along the first and its x along the
 * second. Steering by `walker.yaw` the way `probe/motorbike-ride.ts` steers a
 * machine therefore does not walk a body anywhere — it reported every crossing
 * blocked at a closest approach of 45 m from 44 m out, which is a body that
 * never set off.
 */
const toward = (walker: { position: { x: number; z: number }; viewYaw: number }, x: number, z: number) => {
  const dx = x - walker.position.x;
  const dz = z - walker.position.z;
  const span = Math.hypot(dx, dz) || 1;
  const sin = Math.sin(walker.viewYaw);
  const cos = Math.cos(walker.viewYaw);
  return { x: (-dx * cos + dz * sin) / span, y: (dx * sin + dz * cos) / span };
};

const deg = (radians: number) => `${((radians * 180) / Math.PI).toFixed(0)}°`;
const only = process.argv.find((value) => value.startsWith('--only='))?.slice(7);
const slugs = ['ta-xua', 'hoi-an', 'trang-an', 'ho-tay'].filter((slug) => !only || slug === only);

for (const slug of slugs) {
  const recipe = LOCATIONS[slug];
  if (!recipe) continue;
  console.log(`\n================ ${slug} ================`);
  if (!recipe.railway) {
    console.log('  recipe.railway is null — no line here, and nothing to measure');
    continue;
  }

  const terrain = createTerrain(recipe, SEGMENTS);
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;

  // `world-renderer.ts`'s own order, because the railway's alignment depends on
  // where the houses finally stand: the plan is made, the roads are routed to
  // it, the lots that ended up on a carriageway step off it, and only then is
  // the town built and its centroid handed to `createRailway`.
  const plan = planTown(terrain, recipe, 1);
  const pois = resolvePois(terrain, recipe, plan.lots);
  const net = createRoadNetwork(terrain, recipe, pois, plan.lots);
  yieldToClaims(terrain, recipe, plan, collectGroundClaims({ roads: net.roads }));
  const town = createTownMeshes(terrain, recipe, { plan });
  const railway = createRailway(terrain, recipe, { buildings: town.buildings, roads: net.roads });

  if (!railway.built) {
    console.log('  the recipe asks for a line and the terrain refused it — createRailway returned unbuilt');
    continue;
  }

  // The same two draws `createRailway` makes, in the same order, so this is the
  // line the renderer drew and not a second opinion about where one could go.
  const townCentre = town.buildings.length
    ? town.buildings.reduce(
        (sum, building) => ({
          x: sum.x + building.x / town.buildings.length,
          z: sum.z + building.z / town.buildings.length,
        }),
        { x: 0, z: 0 }
      )
    : null;
  const corridor = choosePlan(terrain, waterLevel, createPrng(`${recipe.seed}:railway`), townCentre);
  if (!corridor) throw new Error('choosePlan disagreed with createRailway about whether a line is buildable');
  const alignment = buildAlignment(
    corridor,
    createPrng(`${recipe.seed}:railway:curves`),
    terrain,
    waterLevel,
    STATION_STEP
  );

  const crossings = findRailCrossings(alignment, net.roads);
  const before = legacyFormation(alignment);
  const after = buildRailFormation(alignment, crossings);
  // The piers and the station platform are pushed on by `railway.ts` itself, so
  // its obstacle list is this one plus those; the spans are all from here.
  if (after.decks.length !== railway.decks.length || after.obstacles.length > railway.obstacles.length) {
    throw new Error(
      `the formation built here (${after.obstacles.length} obstacles, ${after.decks.length} spans) does not match ` +
        `what createRailway published (${railway.obstacles.length}, ${railway.decks.length}) — the replica has drifted`
    );
  }

  const crestOf = (i: number) => alignment.y[i] - RAIL_HEIGHT;
  const fillAt = (i: number) => alignment.y[i] - RAIL_ABOVE_FORMATION - alignment.ground[i];
  const stationOf = (chainage: number) => Math.min(alignment.count - 1, Math.round(chainage / alignment.step));

  const histogram: Record<string, number> = {};
  for (let i = 0; i < alignment.count; i += 1) {
    histogram[alignment.structure[i]] = (histogram[alignment.structure[i]] ?? 0) + 1;
  }
  console.log(
    `  line ${(alignment.length / 1000).toFixed(2)} km at ${alignment.step} m stations — ` +
      Object.entries(histogram)
        .map(([kind, count]) => `${kind} ${((count / alignment.count) * 100).toFixed(0)}%`)
        .join(', ')
  );
  console.log(
    `  formation: ${before.obstacles.length} obstacles and ${before.decks.length} spans before, ` +
      `${after.obstacles.length} and ${after.decks.length} after`
  );

  /** Everything a run of the measurements needs, so the two can be run side by side. */
  const view = (formation: Formation) => ({
    formation,
    floorAt: makeFloorAt(terrain, [...net.decks, ...formation.decks]),
    solids: createObstacleIndex(formation.obstacles),
  });
  const runs = [
    { label: 'before', ...view(before) },
    { label: 'after ', ...view(after) },
  ];

  // --- 1. where the line meets a carriageway --------------------------------
  const kinds = crossings.reduce<Record<string, number>>((count, crossing) => {
    count[crossing.kind] = (count[crossing.kind] ?? 0) + 1;
    return count;
  }, {});
  console.log(
    `\n  --- ${crossings.length} place${crossings.length === 1 ? '' : 's'} the line meets a carriageway: ` +
      `${Object.entries(kinds)
        .map(([kind, count]) => `${count} ${kind}`)
        .join(', ')} ---`
  );

  for (const [n, crossing] of crossings.entries()) {
    const station = stationOf(crossing.chainage);
    const ground = terrain.heightAt(crossing.x, crossing.z);
    console.log(
      `  ${n + 1}. ${crossing.road.kind.padEnd(9)} ch ${crossing.chainage.toFixed(0).padStart(5)} m  ` +
        `${crossing.structure.padEnd(6)} ${crossing.kind.padEnd(7)} skew ${deg(crossing.skew).padStart(4)}  ` +
        `fill ${fillAt(station).toFixed(2).padStart(6)} m  road ${crossing.roadSurface.toFixed(2)} m → ` +
        `crest ${crossing.crest.toFixed(2)} m, a ${(crossing.crest - crossing.roadSurface).toFixed(2)} m step, ` +
        `ramp ${crossing.run.toFixed(1)} m each side`
    );
    // Which cylinders stand over the carriageway, at the height a body walking
    // the road has its feet. `gatherContacts` ignores a solid whose top is within
    // one step, so this is the test the walker itself applies.
    for (const run of runs) {
      const found = run.solids.near(crossing.x, crossing.z) as Obstacle[];
      const walled = found.filter(
        (solid) =>
          solid.top > ground + STEP_UP &&
          Math.hypot(crossing.x - solid.x, crossing.z - solid.z) < solid.radius + SHOULDER
      );
      const surface = run.floorAt(crossing.x, crossing.z, crossing.roadSurface);
      console.log(
        `       ${run.label}: ${walled.length} cylinder(s) walling a body at ground level, ` +
          `floor under a body arriving at road level ${surface.toFixed(2)} m ` +
          `(${(crossing.crest - surface).toFixed(2)} m below the crest)`
      );
    }
  }

  // --- 2. getting onto the formation ----------------------------------------
  /**
   * A station a body standing on the ground beside the formation can climb onto:
   * the step from the ground to the crest inside `STEP_UP`, with nothing solid
   * holding the body out at arm's length while it tries.
   */
  const boardable = (run: (typeof runs)[number], i: number): boolean => {
    const rise = crestOf(i) - alignment.ground[i];
    if (rise <= 0 || rise > STEP_UP) return false;
    for (const solid of run.solids.near(alignment.x[i], alignment.z[i]) as Obstacle[]) {
      if (solid.top <= alignment.ground[i] + STEP_UP) continue;
      if (Math.hypot(alignment.x[i] - solid.x, alignment.z[i] - solid.z) < solid.radius + SHOULDER) return false;
    }
    return true;
  };

  console.log('\n  --- getting up onto the formation ---');
  for (const run of runs) {
    let count = 0;
    for (let i = 0; i < alignment.count; i += 1) if (boardable(run, i)) count += 1;
    // Where the formation can be stepped onto from the ground beside it, which
    // is a property of the alignment and so is the same before and after. The
    // crossings are the other way up and they cannot be answered by a single
    // `floorAt`: a ramp is reachable because a body walking it carries its own
    // reference up with it, and asked in one shot from road level `floorAt`
    // rightly refuses the crest. The walk below is what answers that.
    const reaches = crossings.map((crossing) => {
      let nearest = Infinity;
      for (let i = 0; i < alignment.count; i += 1) {
        if (!boardable(run, i)) continue;
        nearest = Math.min(nearest, Math.abs(i * alignment.step - crossing.chainage));
      }
      return nearest;
    });
    console.log(
      `  ${run.label}: ${count} of ${alignment.count} stations can be stepped onto from the ground ` +
        `(${((count / alignment.count) * 100).toFixed(0)}% of the line); from each crossing the nearest way up is ` +
        reaches.map((reach) => (Number.isFinite(reach) ? `${reach.toFixed(0)} m` : 'nowhere')).join(', ')
    );
  }

  // --- 3. walking the road across the line ----------------------------------
  const camera = new PerspectiveCamera(60, 16 / 9, 2, 4000);

  /**
   * Walks a real body from `from` to `to`, reporting how near it got to `at`, the
   * floor it was standing on when it was nearest, and whether it ever reached the
   * far side of the line.
   */
  const walkPast = (
    run: (typeof runs)[number],
    from: { x: number; z: number },
    to: { x: number; z: number },
    at: { x: number; z: number; chainage: number },
    seconds = 30,
    /** Waypoints to follow on the way, so a body can be held to a carriageway. */
    via: { x: number; z: number }[] = []
  ) => {
    const walker = seeded(() =>
      createWalker(terrain, listener, from.x, from.z, [], undefined, 0, undefined, {
        water: recipe.water ?? null,
        platforms: [...net.decks, ...run.formation.decks],
        obstacles: run.solids,
        reducedMotion: true,
      })
    );
    walker.teleport(from.x, from.z);
    const station = stationOf(at.chainage);
    const a = Math.max(0, station - 2);
    const b = Math.min(alignment.count - 1, station + 2);
    const sideOf = (x: number, z: number) =>
      Math.sign(
        (x - alignment.x[a]) * (alignment.z[b] - alignment.z[a]) -
          (z - alignment.z[a]) * (alignment.x[b] - alignment.x[a])
      );
    const began = sideOf(walker.position.x, walker.position.z);

    let closest = Infinity;
    let floorThere = walker.position.y;
    let crossed = false;
    const route = [...via, to];
    let leg = 0;
    for (let frame = 0; frame < Math.round(seconds * 60); frame += 1) {
      while (
        leg < route.length - 1 &&
        Math.hypot(walker.position.x - route[leg].x, walker.position.z - route[leg].z) < 4
      ) {
        leg += 1;
      }
      walker.setJoystick(toward(walker, route[leg].x, route[leg].z));
      walker.update(DELTA, camera);
      const reach = Math.hypot(walker.position.x - at.x, walker.position.z - at.z);
      if (reach < closest) {
        closest = reach;
        floorThere = walker.position.y;
      }
      if (sideOf(walker.position.x, walker.position.z) !== began) crossed = true;
      if (Math.hypot(walker.position.x - to.x, walker.position.z - to.z) < 3) break;
    }
    return { crossed, closest, floorThere };
  };

  console.log('\n  --- walking the road at the line, from 44 m out ---');
  for (const [n, crossing] of crossings.entries()) {
    const road = crossing.road;
    const samples = Math.floor(road.points.length / 3);
    const spacing = road.totalLength / Math.max(1, samples - 1);
    const at = (distance: number) => {
      const i = Math.max(0, Math.min(samples - 1, Math.round(distance / spacing)));
      return { x: road.points[i * 3], z: road.points[i * 3 + 2] };
    };
    const from = at(crossing.roadDistance - 44);
    const to = at(crossing.roadDistance + 44);
    if (Math.hypot(from.x - to.x, from.z - to.z) < 10) {
      console.log(`  crossing ${n + 1}: the road is too short either side of it to walk at`);
      continue;
    }
    // Every 6 m of carriageway as a waypoint. Aimed straight at a point 88 m
    // along instead, a body cuts the bend: at the 3 m lane it passed 1.95 m from
    // the crossing, which is outside the lane and so outside its ramp, and the
    // walk reported going through a crossing it had never been on.
    const via: { x: number; z: number }[] = [];
    for (let offset = -38; offset <= 44; offset += 6) via.push(at(crossing.roadDistance + offset));
    for (const run of runs) {
      const walk = walkPast(run, from, to, crossing, 30, via);
      console.log(
        `  crossing ${n + 1} ${run.label}: ${walk.crossed ? 'crossed' : 'BLOCKED'}, nearest ` +
          `${walk.closest.toFixed(2)} m, standing at ${walk.floorThere.toFixed(2)} m against a crest at ` +
          `${crossing.crest.toFixed(2)} m — ${
            walk.closest > 3
              ? 'stopped short of it'
              : walk.floorThere > crossing.crest - 0.45
                ? 'ON the formation'
                : `THROUGH it, ${(crossing.crest - walk.floorThere).toFixed(2)} m under the sleepers`
          }`
      );
    }
  }

  console.log('\n  --- and beside the ramp: is the hole in the bank wider than the road? ---');
  for (const [n, crossing] of crossings.entries()) {
    if (crossing.kind !== 'level') continue;
    // Parallel to the road, one and a half metres outside the carriageway, which
    // is off the ramp and so over whatever the bank is doing there. A body that
    // gets across here has walked through the earthwork beside the crossing
    // rather than over it.
    const sideX = Math.cos(crossing.roadHeading);
    const sideZ = -Math.sin(crossing.roadHeading);
    const push = crossing.road.width / 2 + 1.5;
    const aheadX = Math.sin(crossing.roadHeading);
    const aheadZ = Math.cos(crossing.roadHeading);
    const at = { x: crossing.x + sideX * push, z: crossing.z + sideZ * push, chainage: crossing.chainage };
    for (const run of runs) {
      const walk = walkPast(
        run,
        { x: at.x - aheadX * 26, z: at.z - aheadZ * 26 },
        { x: at.x + aheadX * 26, z: at.z + aheadZ * 26 },
        at,
        24
      );
      console.log(
        `  crossing ${n + 1} ${run.label}: ${push.toFixed(1)} m off the centreline — ` +
          `${walk.crossed ? 'GOT THROUGH' : 'held outside'}, nearest ${walk.closest.toFixed(2)} m, ` +
          `standing at ${walk.floorThere.toFixed(2)} m against a crest at ${crossing.crest.toFixed(2)} m`
      );
    }
  }

  // --- 4. the embankment must still be a wall -------------------------------
  /**
   * The deepest fill on the line that is not a bridge and not inside a crossing,
   * walked at square from both sides. A body that gets to the far side there has
   * walked through an earthwork, which is the failure the crossings must not
   * have introduced.
   */
  let deepest = -1;
  for (let i = 0; i < alignment.count; i += 1) {
    if (alignment.structure[i] === 'bridge') continue;
    if (crossings.some((crossing) => Math.abs(i * alignment.step - crossing.chainage) < 30)) continue;
    // On dry land, and with dry land either side of it. The deepest fill on the
    // line is 9.2 m at Hồ Tây and the ground under it is 10 cm below the lake, so
    // the first answer to this was a body that swam up to the bank and was
    // reported held outside it for the wrong reason.
    if (alignment.ground[i] < waterLevel + 1.5) continue;
    const nx = Math.cos(alignment.heading[i]);
    const nz = -Math.sin(alignment.heading[i]);
    if (terrain.heightAt(alignment.x[i] - nx * 26, alignment.z[i] - nz * 26) < waterLevel + 1.5) continue;
    if (terrain.heightAt(alignment.x[i] + nx * 26, alignment.z[i] + nz * 26) < waterLevel + 1.5) continue;
    if (deepest < 0 || fillAt(i) > fillAt(deepest)) deepest = i;
  }
  if (deepest >= 0) {
    const nx = Math.cos(alignment.heading[deepest]);
    const nz = -Math.sin(alignment.heading[deepest]);
    const at = { x: alignment.x[deepest], z: alignment.z[deepest], chainage: deepest * alignment.step };
    console.log(
      `\n  --- the bank at its deepest, ch ${at.chainage.toFixed(0)} m, ${fillAt(deepest).toFixed(2)} m of fill, ` +
        `crest ${(crestOf(deepest) - alignment.ground[deepest]).toFixed(2)} m over the ground ---`
    );
    for (const run of runs) {
      const walk = walkPast(
        run,
        { x: at.x - nx * 26, z: at.z - nz * 26 },
        { x: at.x + nx * 26, z: at.z + nz * 26 },
        at,
        24
      );
      console.log(
        `  ${run.label}: ${walk.crossed ? 'WALKED THROUGH THE BANK' : 'held outside it'}, nearest ` +
          `${walk.closest.toFixed(2)} m, standing at ${walk.floorThere.toFixed(2)} m ` +
          `(ground ${alignment.ground[deepest].toFixed(2)} m, crest ${crestOf(deepest).toFixed(2)} m)`
      );
    }
  }

  // --- 5. nobody stands in mid-air beside a bridge --------------------------
  let bridged = -1;
  for (let i = 0; i < alignment.count; i += 1) {
    if (alignment.structure[i] !== 'bridge') continue;
    if (bridged < 0 || crestOf(i) - alignment.ground[i] > crestOf(bridged) - alignment.ground[bridged]) bridged = i;
  }
  if (bridged >= 0) {
    const nx = Math.cos(alignment.heading[bridged]);
    const nz = -Math.sin(alignment.heading[bridged]);
    const at = { x: alignment.x[bridged], z: alignment.z[bridged] };
    console.log(
      `\n  --- off the side of the deepest truss, ch ${(bridged * alignment.step).toFixed(0)} m, ` +
        `deck ${(crestOf(bridged) - alignment.ground[bridged]).toFixed(1)} m over the bed ---`
    );
    for (const run of runs) {
      const walker = seeded(() =>
        createWalker(terrain, listener, at.x, at.z, [], undefined, 0, undefined, {
          water: recipe.water ?? null,
          platforms: [...net.decks, ...run.formation.decks],
          obstacles: run.solids,
          reducedMotion: true,
        })
      );
      walker.teleport(at.x, at.z);
      const boarded = walker.position.y;
      for (let frame = 0; frame < 60 * 7; frame += 1) {
        walker.setJoystick(toward(walker, at.x + nx * 20, at.z + nz * 20));
        walker.update(DELTA, camera);
      }
      const off = Math.hypot(walker.position.x - at.x, walker.position.z - at.z);
      const aloft = walker.position.y > crestOf(bridged) - 0.6 && off > SLEEPER_LENGTH;
      console.log(
        `  ${run.label}: boarded at ${boarded.toFixed(2)} m, walked ${off.toFixed(1)} m off the centreline and ended ` +
          `at ${walker.position.y.toFixed(2)} m — crest ${crestOf(bridged).toFixed(2)} m, ground under it there ` +
          `${terrain.heightAt(walker.position.x, walker.position.z).toFixed(2)} m, ` +
          `${aloft ? 'STANDING IN MID-AIR' : 'off the deck, as it should be'}`
      );
    }
  }

  // --- 6. the train as an Impactor ------------------------------------------
  console.log('\n  --- the train as something that can be hit ---');
  // `createRailway` calls `update(0)` itself, so by the time anything here runs
  // the first frame has already been taken: "before the first update" has to be
  // asked of a clock where the train is not on the map, which is between passes.
  let atRest = -1;
  let atRestAt = 0;
  for (let elapsed = 0; elapsed < 1800 && atRest < 0; elapsed += 0.5) {
    railway.update(elapsed);
    if (railway.traffic().length === 0) {
      atRest = 0;
      atRestAt = elapsed;
    }
  }
  let bodies = railway.traffic();
  let foundAt = 0;
  // The pass is phased by the seed, so the train is somewhere in a cycle a few
  // minutes long; stepped rather than solved, which is also how the renderer
  // reaches it.
  for (let elapsed = 0; elapsed < 1800 && bodies.length === 0; elapsed += 0.5) {
    railway.update(elapsed);
    bodies = railway.traffic();
    foundAt = elapsed;
  }
  {
    const sample = bodies[0];
    console.log(
      `  between passes, at t=${atRestAt.toFixed(1)}s: ${atRest < 0 ? 'never idle' : atRest} bodies. ` +
        `Running at t=${foundAt.toFixed(1)}s: ` +
        `${bodies.length} bodies` +
        (sample
          ? `, mass ${(sample.mass / 1000).toFixed(0)} t each, radius ${sample.radius.toFixed(2)} m, ` +
            `speed ${Math.hypot(sample.vx, sample.vz).toFixed(1)} m/s`
          : '')
    );
    if (bodies.length > 0) {
      let span = 0;
      let widest = 0;
      for (let n = 1; n < bodies.length; n += 1) {
        const gap = Math.hypot(bodies[n].x - bodies[n - 1].x, bodies[n].z - bodies[n - 1].z);
        widest = Math.max(widest, gap);
        span += gap;
      }
      console.log(
        `  the rake covers ${span.toFixed(1)} m of rail in ${bodies.length} circles, the widest gap between ` +
          `consecutive centres ${widest.toFixed(2)} m against a ${(2 * bodies[0].radius).toFixed(2)} m diameter — ` +
          `${widest <= 2 * bodies[0].radius + 1e-6 ? 'continuous' : 'A HOLE TO STAND IN'}`
      );
      railway.update(foundAt);
      console.log(
        `  the array is the same object every call: ${railway.traffic() === bodies ? 'yes' : 'NO — reallocated'}`
      );
    }
  }

  // --- 7. a body the train hits ---------------------------------------------
  /**
   * Stood on the crest with the train coming, and left there. There is no death
   * and no health anywhere in this app, so the question is only what being hit
   * does to where a body is and how fast it is going — and that nothing ends up
   * inside anything, which is the one outcome that would be worse than nothing
   * happening at all.
   */
  console.log('\n  --- what the train does to whoever is in front of it ---');
  {
    const run = runs[1];
    const vehicles = createVehicles(recipe, net, 16, terrain);
    const floorAt = run.floorAt;
    const bike = vehicles.rideables()[0] ?? null;

    /**
     * Winds the clock to a moment the head of the train is inside `reach` of a
     * point, so the hit happens inside the frames that are then run rather than
     * two minutes after them. Stepped rather than solved, which is also how the
     * renderer gets there.
     */
    const windToApproach = (x: number, z: number, reach: number): number | null => {
      for (let step = 0; step < 60000; step += 1) {
        const elapsed = step * 0.05;
        railway.update(elapsed);
        const live = railway.traffic();
        if (live.length === 0) continue;
        if (Math.hypot(live[0].x - x, live[0].z - z) < reach) return elapsed;
      }
      return null;
    };

    /** Runs the walker and the train together, reporting what moved and how far. */
    const struck = (walker: ReturnType<typeof createWalker>, label: string, from: number) => {
      const startX = walker.position.x;
      const startZ = walker.position.z;
      const startY = walker.position.y;
      const startSpeed = walker.telemetry()?.speed ?? 0;
      const astride = walker.riding();
      let elapsed = from;
      let peak = 0;
      let lastX = startX;
      let lastZ = startZ;
      let nearest = Infinity;
      let inside = 0;
      let trainLost = 0;
      for (let frame = 0; frame < 60 * 14; frame += 1) {
        elapsed += DELTA;
        railway.update(elapsed);
        const live = railway.traffic();
        walker.update(DELTA, camera);
        peak = Math.max(peak, Math.hypot(walker.position.x - lastX, walker.position.z - lastZ) / DELTA);
        lastX = walker.position.x;
        lastZ = walker.position.z;
        for (const body of live) {
          const gap = Math.hypot(walker.position.x - body.x, walker.position.z - body.z);
          nearest = Math.min(nearest, gap);
          if (gap < body.radius + SHOULDER - 0.02) inside += 1;
          trainLost = Math.max(trainLost, 19.4 - Math.hypot(body.vx, body.vz));
        }
      }
      let deepest = 0;
      for (const solid of run.formation.obstacles) {
        if (solid.top <= walker.position.y + STEP_UP) continue;
        deepest = Math.max(
          deepest,
          solid.radius + SHOULDER - Math.hypot(walker.position.x - solid.x, walker.position.z - solid.z)
        );
      }
      const moved = Math.hypot(walker.position.x - startX, walker.position.z - startZ);
      const ride = walker.telemetry();
      console.log(
        `  ${label}: moved ${moved.toFixed(2)} m, peak ${peak.toFixed(2)} m/s, ` +
          `${startY.toFixed(2)} m → ${walker.position.y.toFixed(2)} m` +
          (astride
            ? ride
              ? `, still astride at ${ride.speed.toFixed(2)} m/s from ${startSpeed.toFixed(2)}`
              : ', thrown off the machine'
            : '')
      );
      console.log(
        `       the train lost ${trainLost.toFixed(3)} m/s of its 19.4; nearest the body came to a coach centre ` +
          `${nearest.toFixed(2)} m; frames left inside one ${inside}; deepest inside anything solid ` +
          `${deepest.toFixed(3)} m`
      );
    };

    const makeWalker = (x: number, z: number) =>
      seeded(() =>
        createWalker(terrain, listener, x, z, [], undefined, 0, undefined, {
          water: recipe.water ?? null,
          platforms: [...net.decks, ...run.formation.decks],
          obstacles: run.solids,
          rideables: () => vehicles.rideables(),
          traffic: [railway.traffic],
          reducedMotion: true,
        })
      );

    // A station on earthwork, clear of the ends of the line, with the formation
    // standing over the ground so the body is genuinely up on the crest.
    let target = -1;
    for (let i = 0; i < alignment.count; i += 1) {
      if (alignment.structure[i] !== 'grade' && alignment.structure[i] !== 'fill') continue;
      if (crestOf(i) - alignment.ground[i] <= 0.04) continue;
      if (i * alignment.step < 600 || i * alignment.step > alignment.length - 600) continue;
      target = i;
      break;
    }

    if (target < 0) console.log('  no station on earthwork clear of the ends of the line to stand on');
    else {
      const sideX = Math.cos(alignment.heading[target]);
      const sideZ = -Math.sin(alignment.heading[target]);
      // Dead on the rails, and then a metre and a quarter to one side of them —
      // still on the crest, which is 3 m wide now, and where a person waiting for
      // a train actually stands. The two differ in kind and not in degree: on the
      // centreline the normal from the body to the nearest coach runs *along* the
      // rail, so the whole impulse is longitudinal and the body is picked up and
      // carried; off to one side the normal has a lateral component and the body
      // is thrown clear.
      for (const across of [0, 1.25]) {
        const x = alignment.x[target] + sideX * across;
        const z = alignment.z[target] + sideZ * across;
        const at = windToApproach(x, z, 110);
        if (at === null) {
          console.log(`  the train never came within 110 m of ch ${(target * alignment.step).toFixed(0)} m`);
          continue;
        }
        const walker = makeWalker(x, z);
        walker.teleport(x, z);
        walker.setJoystick(null);
        struck(walker, `on foot, ${across.toFixed(2)} m off the centreline`, at);
      }

      // And a rider, stopped astride a xe máy on a level crossing with the train
      // coming, which is the case `collideDrive` and the mass are for.
      const crossing = crossings.find((entry) => entry.kind === 'level');
      if (!bike) console.log('  no parked xe máy to ride at it');
      else if (!crossing) console.log('  no level crossing on this line to be caught on');
      else {
        const heading = crossing.roadHeading;
        bike.position.set(crossing.x, floorAt(crossing.x, crossing.z, Number.POSITIVE_INFINITY), crossing.z);
        bike.forward.set(Math.sin(heading), 0, Math.cos(heading));
        const walker = makeWalker(crossing.x, crossing.z);
        walker.teleport(crossing.x + bike.forward.x * 1.6, crossing.z + bike.forward.z * 1.6);
        // The boarding scan runs five times a second, so standing there for a
        // fifth of a second is part of walking up to it.
        walker.setJoystick({ x: 0, y: 0 });
        for (let frame = 0; frame < 24; frame += 1) walker.update(DELTA, camera);
        walker.interact();
        for (let frame = 0; frame < 6; frame += 1) walker.update(DELTA, camera);
        if (!walker.riding()) console.log(`  could not board the xe máy on the crossing: "${walker.prompt()}"`);
        else {
          // No second teleport here. `walker.teleport` parks whatever is being
          // ridden and clears the ride, so moving the rider onto the rails that
          // way put a body on foot there and the run below measured a pedestrian
          // while calling it a rider. Boarding already slaves the walker to the
          // machine, and the machine is standing on the crossing.
          walker.setJoystick({ x: 0, y: 0 });
          for (let frame = 0; frame < 12; frame += 1) walker.update(DELTA, camera);
          const at = windToApproach(walker.position.x, walker.position.z, 110);
          if (at === null) console.log('  the train never came within 110 m of the crossing');
          else struck(walker, 'astride a xe máy stalled on the crossing', at);
        }
      }
    }
    vehicles.dispose();
  }

  console.log('  nobody died, because there is no health and no death anywhere in this app');

  // And that the crossings were actually drawn. Built a second time without the
  // roads, which is the call `world-renderer.ts` made before this change: the
  // difference is the asphalt, the flangeway timbers and the gates.
  {
    const bare = createRailway(terrain, recipe, { buildings: town.buildings });
    console.log(
      `\n  the scene carries ${railway.group.children.length} objects with the roads handed in and ` +
        `${bare.group.children.length} without, for ${crossings.filter((entry) => entry.kind === 'level').length} ` +
        `level crossing(s); ${bare.crossings.length} crossings are found without them`
    );
    bare.dispose();
  }

  railway.dispose();
}
