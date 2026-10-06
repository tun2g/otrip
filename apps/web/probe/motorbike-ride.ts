/**
 * Can you actually ride the parked xe máy, and does it stay on the road?
 *
 * The machine is driven by `walker.ts` and drawn by `vehicles.ts`, so neither
 * file answers either question on its own: the speed is integrated against the
 * same `floorAt` the feet use, the step gate is the same one, and the thing that
 * matters — whether the wheels end up on the carriageway, under a bridge, or in
 * the river — only exists once the two are run together.
 *
 * So this boards a real parked bike at all four places and measures it against
 * the gait ladder it has to sit between, the circle it turns, the surface under
 * it across a span over water, the hillside it refuses, the wall it stops at, and
 * that getting off and on again leaves the world where it found it.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/motorbike-ride.ts [--only=ta-xua]
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

// `createWalker` binds keyboard, pointer and pointer-lock listeners the moment it
// is made, and the water shaders read `devicePixelRatio` behind a `typeof window`
// guard — so both are declared rather than left undefined.
const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
globals.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
globals.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  pointerLockElement: null,
  exitPointerLock: () => {},
};

const { createTerrain, LOCATIONS } = await import('@otrip/world');
const { PerspectiveCamera } = await import('three');
const { resolvePois } = await import('../src/scene/points-of-interest.ts');
const { createRoadNetwork } = await import('../src/scene/road-network.ts');
const { planTown } = await import('../src/scene/town-plan.ts');
const { createLife } = await import('../src/scene/life.ts');
const { createVehicles } = await import('../src/scene/vehicles.ts');
const { createWalker } = await import('../src/scene/walker.ts');

type Terrain = ReturnType<typeof createTerrain>;
type Network = ReturnType<typeof createRoadNetwork>;
type Road = Network['roads'][number];
type Platform = Network['decks'][number];
type Obstacle = { x: number; z: number; radius: number; bottom: number; top: number };

const SEGMENTS = 416;
const DELTA = 1 / 60;
/** `walker.ts`'s own, so the replica below answers what the walker answered. */
const STEP_UP = 0.4;

/** `walker.floorAt`, transcribed. The surface column of every table here. */
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

/** `findSpawn` from `world-renderer.ts`: where the walk starts. */
const findSpawn = (terrain: Terrain, waterLevel: number, buildings: { x: number; z: number; radius: number }[]) => {
  const half = terrain.size / 2;
  const clear = (x: number, z: number) => buildings.every((b) => Math.hypot(x - b.x, z - b.z) > b.radius + 14);
  for (let radius = 0; radius < half; radius += terrain.size / 80) {
    for (let step = 0; step < 16; step += 1) {
      const angle = (step / 16) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (terrain.heightAt(x, z) > waterLevel + 2 && terrain.slopeAt(x, z) < 0.35 && clear(x, z)) return { x, z };
    }
  }
  return { x: 0, z: 0 };
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

/** A repeatable sequence for the ground searches, so a run can be compared. */
const roller = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
};

const listener = { addEventListener: () => {}, removeEventListener: () => {} } as unknown as HTMLElement;
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const fixed = (value: number, places = 2) => value.toFixed(places).padStart(places + 4);

const only = process.argv.find((value) => value.startsWith('--only='))?.slice(7);
const slugs = ['ta-xua', 'hoi-an', 'trang-an', 'ho-tay'].filter((slug) => !only || slug === only);

type Row = {
  slug: string;
  spots: number;
  walk: number;
  top: number;
  reach: number;
  radius: number;
  pace: number;
  lean: number;
};
const rows: Row[] = [];

for (const slug of slugs) {
  const recipe = LOCATIONS[slug];
  if (!recipe) continue;
  const terrain = createTerrain(recipe, SEGMENTS);
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const plan = planTown(terrain, recipe, 1);
  const pois = resolvePois(terrain, recipe, plan.lots);
  const net = createRoadNetwork(terrain, recipe, pois, plan.lots);
  const vehicles = createVehicles(recipe, net, 16, terrain);
  const floorAt = makeFloorAt(terrain, net.decks);
  const spawn = findSpawn(
    terrain,
    waterLevel,
    plan.lots.map((lot) => ({ x: lot.x, z: lot.z, radius: 8 }))
  );

  console.log(`\n================ ${slug} ================`);
  const bikes = vehicles.rideables();
  if (bikes.length === 0) {
    console.log('  no parked bike at all');
    continue;
  }

  // --- 0. where the bikes ended up standing ---------------------------------
  // `road-network` puts a spot 1.9 m beyond the kerb and gives it the
  // centreline's height. Read before anything is ridden, so this is placement and
  // not the ride: `vehicles.stand` carries the spot in across the kerb until the
  // carriageway's deck is under it, and drops it on the ground if none is.
  {
    // Paired by proximity, not by index. `vehicles.ts` now puts one bike at the
    // head of each *row* — `ParkingSpot.area` — so the bike list and the slot
    // list no longer run in step, and indexing one by the other reported a bike
    // "carried 702 m" from a slot it had never been near, then ran off the end
    // of the array. Which slot a bike is standing on is a question about where
    // it is, so that is how it is asked.
    const areas = new Set(net.parking.map((spot) => spot.area)).size;
    console.log(
      `  ${areas} place${areas === 1 ? '' : 's'} to find one, ${net.parking.length} slots, ${bikes.length} bikes standing`
    );
    for (const [n, ridable] of bikes.entries()) {
      let spot = net.parking[0];
      let near = Infinity;
      for (const slot of net.parking) {
        const gap = Math.hypot(slot.x - ridable.position.x, slot.z - ridable.position.z);
        if (gap >= near) continue;
        near = gap;
        spot = slot;
      }
      const ground = terrain.heightAt(spot.x, spot.z);
      const stands = floorAt(ridable.position.x, ridable.position.z, ridable.position.y);
      console.log(
        `  spot ${n}: road-network said y ${spot.y.toFixed(2)} with ground ${ground.toFixed(2)} under it ` +
          `(${(spot.y - ground >= 0 ? '+' : '') + (spot.y - ground).toFixed(2)} m) → now standing at y ` +
          `${ridable.position.y.toFixed(2)}, carried ${Math.hypot(ridable.position.x - spot.x, ridable.position.z - spot.z).toFixed(2)} m, ` +
          `${(ridable.position.y - stands).toFixed(2)} m off the floor under it`
      );
    }
  }

  /** One obstacle, parked in front of the rider, to prove a contact stops it. */
  let post: Obstacle | null = null;
  const camera = new PerspectiveCamera(60, 16 / 9, 2, 4000);
  const walker = seeded(() =>
    createWalker(terrain, listener, spawn.x, spawn.z, [], undefined, 0, undefined, {
      water: recipe.water ?? null,
      platforms: net.decks,
      rideables: () => vehicles.rideables(),
      obstacles: { near: () => (post ? [post] : []) },
      reducedMotion: true,
    })
  );

  const bike = bikes[0];
  const at = () => ({ x: walker.position.x, z: walker.position.z });
  const away = (from: { x: number; z: number }) => Math.hypot(walker.position.x - from.x, walker.position.z - from.z);

  const run = (seconds: number, stick: { x: number; y: number }, each?: (n: number) => void) => {
    walker.setJoystick(stick);
    for (let n = 0; n < Math.round(seconds * 60); n += 1) {
      walker.update(DELTA, camera);
      each?.(n);
    }
  };
  const dismount = () => {
    walker.setJoystick(null);
    walker.interact();
    run(0.4, { x: 0, y: 0 });
  };
  const whyNot = () =>
    `walker (${walker.position.x.toFixed(1)}, ${walker.position.y.toFixed(1)}, ${walker.position.z.toFixed(1)}) ` +
    `bike (${bike.position.x.toFixed(1)}, ${bike.position.y.toFixed(1)}, ${bike.position.z.toFixed(1)}) ` +
    `gap ${Math.hypot(walker.position.x - bike.position.x, walker.position.z - bike.position.z).toFixed(2)} m, ` +
    `height difference ${(walker.position.y - (bike.position.y + bike.deckHeight)).toFixed(2)} m`;

  /**
   * Leaves whatever is being ridden, stands the bike somewhere, walks up to it
   * and presses E. Every measurement below starts from this, so none of them
   * inherits wherever the last one left off.
   */
  const start = (x: number, z: number, heading: number): string | null => {
    if (walker.riding()) dismount();
    bike.position.set(x, floorAt(x, z, Number.POSITIVE_INFINITY), z);
    bike.forward.set(Math.sin(heading), 0, Math.cos(heading));
    walker.teleport(x + bike.forward.x * 1.6, z + bike.forward.z * 1.6);
    // The boarding scan runs five times a second, not every frame, so standing
    // there for a fifth of a second is part of walking up to it.
    run(0.35, { x: 0, y: 0 });
    const offered = walker.prompt();
    walker.interact();
    run(0.05, { x: 0, y: 0 });
    if (!walker.riding()) throw new Error(`could not board: the prompt said "${offered}" — ${whyNot()}`);
    return offered;
  };

  const headingAlong = (entry: Road, i: number) =>
    Math.atan2(
      entry.points[(i + 1) * 3] - entry.points[i * 3],
      entry.points[(i + 1) * 3 + 2] - entry.points[i * 3 + 2]
    );

  /**
   * Rides a road the way a player rides one: pure pursuit, the bars turned toward
   * a point fifteen metres further along the centreline, and nothing but the two
   * axes the joystick has. Aiming at the next sample instead oscillated off the
   * embankment and stalled on the slope gate.
   */
  const follow = (
    entry: Road,
    from: number,
    seconds: number,
    each?: (n: number, sample: number, off: number) => void
  ) => {
    const count = Math.floor(entry.points.length / 3);
    const px = (i: number) => entry.points[i * 3];
    const pz = (i: number) => entry.points[i * 3 + 2];
    const spacing = Math.max(0.5, Math.hypot(px(1) - px(0), pz(1) - pz(0)));
    let sample = from;
    let done = false;
    run(seconds, { x: 0, y: 1 }, (n) => {
      if (done) return;
      let gap = Infinity;
      for (let i = Math.max(0, sample - 4); i < Math.min(count, sample + 40); i += 1) {
        const reach = Math.hypot(walker.position.x - px(i), walker.position.z - pz(i));
        if (reach < gap) {
          gap = reach;
          sample = i;
        }
      }
      if (sample >= count - 2) {
        // The road has run out. Carrying on would only measure a test rider
        // circling its last sample.
        done = true;
        walker.setJoystick({ x: 0, y: 0 });
        return;
      }
      const aim = Math.min(count - 1, sample + Math.ceil(15 / spacing));
      const wanted = Math.atan2(px(aim) - walker.position.x, pz(aim) - walker.position.z);
      walker.setJoystick({ x: -Math.max(-1, Math.min(1, wrap(wanted - walker.yaw) * 1.1)), y: 1 });
      each?.(n, sample, gap);
    });
  };

  // --- 1. the ladder it has to sit between -----------------------------------
  // The longest sealed road, from one end: the nearest one to the spawn is a
  // 70 m lane at Tà Xùa, and a rider who runs out of road after two seconds
  // measures nothing but the end of it.
  const trunk = net.roads
    .filter((entry) => entry.kind !== 'trail')
    .reduce((best, entry) => (best && best.totalLength >= entry.totalLength ? best : entry));
  const road = { road: trunk, at: 1, away: Math.hypot(trunk.points[3] - spawn.x, trunk.points[5] - spawn.z) };
  const offered = start(
    road.road.points[road.at * 3],
    road.road.points[road.at * 3 + 2],
    headingAlong(road.road, road.at)
  );
  let top = 0;
  let reach = 0;
  {
    /**
     * Speed over a tenth of a second, and the 95% mark taken against the top
     * this run actually reached.
     *
     * Both halves were wrong and both were invisible. The threshold was the
     * literal `8.55`, which is 95% of a 9 m/s top speed that no longer exists —
     * so the column went on being printed as "95% of it" while measuring the
     * time to a fixed 8.55 m/s. And the speed was one frame's displacement over
     * 1/60 s, which catches the machine settling onto the floor on the frame it
     * is boarded — `standY` eases at `STEP_EASE` and the first step is resolved
     * out of whatever the bike was parked inside — and reads as a motorbike
     * leaving the line at nearly a g. Measured here before the fix: 1.0 s to
     * 8.55 m/s at Tà Xùa, against the 2.3 s the model's own force curve gives.
     */
    const WINDOW = Math.max(1, Math.round(0.1 / DELTA));
    const trail: { x: number; z: number }[] = [at()];
    const series: number[] = [];
    follow(road.road, road.at, 10, () => {
      trail.push(at());
      const back = trail.length - 1 - WINDOW;
      if (back < 0) return;
      const then = trail[back];
      const now = trail[trail.length - 1];
      series.push(Math.hypot(now.x - then.x, now.z - then.z) / (WINDOW * DELTA));
    });
    for (const speed of series) if (speed > top) top = speed;
    const found = series.findIndex((speed) => speed >= top * 0.95);
    reach = found < 0 ? 0 : (found + WINDOW) * DELTA;
  }
  console.log(
    `  prompt walking up to it: "${offered}" | on the ${road.road.kind} road, ${road.away.toFixed(0)} m from the ` +
      `spawn: top ${top.toFixed(2)} m/s (${(top * 3.6).toFixed(1)} km/h), 95% of it at ${reach.toFixed(1)} s ` +
      `— against a 4.5 m/s jog and the 14 m/s travel stride`
  );

  // --- 2. the circle it turns ------------------------------------------------
  // On open level ground, because full lock on a shelf road puts the front wheel
  // off the carriageway inside a second and what gets measured then is the slope
  // gate rather than the tyres: measured that way at Tà Xùa, 2.8 m at 2.5 m/s.
  let radius = 0;
  let pace = 0;
  let lean = 0;
  {
    const roll = roller(0x51ed27);
    let flat = { x: spawn.x, z: spawn.z, worst: Infinity };
    for (let tries = 0; tries < 3000; tries += 1) {
      const x = (roll() * 2 - 1) * terrain.size * 0.35;
      const z = (roll() * 2 - 1) * terrain.size * 0.35;
      if (terrain.heightAt(x, z) < waterLevel + 3) continue;
      let worst = terrain.slopeAt(x, z);
      for (let step = 0; step < 8 && worst < flat.worst; step += 1) {
        const angle = (step / 8) * Math.PI * 2;
        for (const ring of [10, 20]) {
          const sx = x + Math.cos(angle) * ring;
          const sz = z + Math.sin(angle) * ring;
          worst = Math.max(worst, terrain.slopeAt(sx, sz));
          if (terrain.heightAt(sx, sz) < waterLevel + 2) worst = 99;
        }
      }
      if (worst < flat.worst) flat = { x, z, worst };
    }

    start(flat.x, flat.z, 0);
    run(6, { x: 0, y: 1 });
    let arc = 0;
    let sweep = 0;
    let last = { ...at(), yaw: walker.yaw };
    run(3, { x: 1, y: 1 }, () => {
      arc += away(last);
      sweep += Math.abs(wrap(walker.yaw - last.yaw));
      last = { ...at(), yaw: walker.yaw };
    });
    pace = arc / 3;
    const turned = sweep / 3;
    radius = turned > 1e-4 ? pace / turned : Infinity;
    lean = (Math.atan((pace * turned) / 9.81) * 180) / Math.PI;
    console.log(
      `  full lock on ground whose worst gradient within 20 m is ${flat.worst.toFixed(2)}: radius ` +
        `${radius.toFixed(1)} m at ${pace.toFixed(2)} m/s, ${lean.toFixed(0)}° of lean, ` +
        `${((pace * pace) / radius).toFixed(2)} m/s² against the tyres' 5.2`
    );
  }

  // --- 3. two hundred metres, then off, then on again ------------------------
  {
    // Where the machine was parked and how many rigs the scene holds, so the
    // obvious failure — the bike drawn both under the rider and back at the kerb
    // — is answered by a number rather than by reading the file.
    const kerb = { x: bike.position.x, z: bike.position.z };
    const rigs = vehicles.group.children.length;

    start(road.road.points[road.at * 3], road.road.points[road.at * 3 + 2], headingAlong(road.road, road.at));
    const from = at();
    let covered = 0;
    let last = from;
    let trail = 0;
    let frames = 0;
    let jerk = 0;
    let wasCamera = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    follow(road.road, road.at, 40, (n) => {
      covered += away(last);
      last = at();
      // The first second is the camera still converging on a body that was just
      // teleported in, which is not a thing a player ever does.
      if (n < 60) {
        wasCamera = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
        return;
      }
      trail += Math.hypot(
        camera.position.x - walker.position.x,
        camera.position.y - walker.position.y,
        camera.position.z - walker.position.z
      );
      jerk = Math.max(
        jerk,
        Math.hypot(camera.position.x - wasCamera.x, camera.position.y - wasCamera.y, camera.position.z - wasCamera.z)
      );
      wasCamera = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
      frames += 1;
    });
    console.log(
      `  camera under way: trailing ${(trail / frames).toFixed(1)} m on average (8.5 m standing, ` +
        `12.75 m flat out), worst single-frame move ${jerk.toFixed(2)} m against the ${(9 * DELTA).toFixed(2)} m ` +
        `the rider covers in a frame at top speed`
    );
    console.log(
      `  the kerb it came from: ${vehicles.group.children.length} rigs in the scene before and after ` +
        `(${rigs} before), and the machine is now ${Math.hypot(bike.position.x - kerb.x, bike.position.z - kerb.z).toFixed(0)} m ` +
        `from where it was standing — one rig, moved, not a second one drawn`
    );
    const leaving = walker.prompt();
    const stood = { x: bike.position.x, z: bike.position.z };
    dismount();
    const off = walker.riding();
    const drift = Math.hypot(bike.position.x - stood.x, bike.position.z - stood.z);
    const beside = Math.hypot(walker.position.x - bike.position.x, walker.position.z - bike.position.z);
    const again = walker.prompt();
    walker.interact();
    run(0.05, { x: 0, y: 0 });
    console.log(
      `  rode ${covered.toFixed(0)} m along it in 40 s (${(covered / 40).toFixed(2)} m/s average, ` +
        `${from.x.toFixed(0)},${from.z.toFixed(0)} to ${walker.position.x.toFixed(0)},` +
        `${walker.position.z.toFixed(0)}), then "${leaving}": riding ${off}, machine left standing ` +
        `${drift.toFixed(2)} m from where it stopped, rider ${beside.toFixed(2)} m off it\n` +
        `  beside it the prompt is "${again}" and pressing it gives riding ${walker.riding()}` +
        `${walker.riding() ? '' : ` — ${whyNot()}`}`
    );
  }

  // --- 3b. the same camera, on foot -----------------------------------------
  // The pull-back is new, so the jump it is blamed for has to be compared with
  // the jump that was already there: the same ground, the same sweep, at a jog.
  {
    if (walker.riding()) dismount();
    walker.teleport(road.road.points[road.at * 3], road.road.points[road.at * 3 + 2]);
    let wasCamera = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    let jerk = 0;
    let covered = 0;
    let last = at();
    run(12, { x: 0, y: 1 }, (n) => {
      covered += away(last);
      last = at();
      if (n < 60) {
        wasCamera = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
        return;
      }
      jerk = Math.max(
        jerk,
        Math.hypot(camera.position.x - wasCamera.x, camera.position.y - wasCamera.y, camera.position.z - wasCamera.z)
      );
      wasCamera = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    });
    console.log(
      `  on foot over the same ground: ${(covered / 12).toFixed(2)} m/s, worst single-frame camera move ` +
        `${jerk.toFixed(2)} m`
    );
  }

  // --- 4. a hillside --------------------------------------------------------
  {
    const roll = roller(0x9e3779b);
    let best = { x: 0, z: 0, heading: 0, slope: 0 };
    for (let tries = 0; tries < 4000; tries += 1) {
      const x = (roll() * 2 - 1) * terrain.size * 0.4;
      const z = (roll() * 2 - 1) * terrain.size * 0.4;
      if (terrain.heightAt(x, z) < waterLevel + 3) continue;
      if (terrain.slopeAt(x, z) > 0.2) continue;
      for (let turn = 0; turn < 8; turn += 1) {
        const heading = (turn / 8) * Math.PI * 2;
        const px = x + Math.sin(heading) * 26;
        const pz = z + Math.cos(heading) * 26;
        const slope = terrain.slopeAt(px, pz);
        if (slope > best.slope && terrain.heightAt(px, pz) > terrain.heightAt(x, z) + 6) {
          best = { x, z, heading, slope };
        }
      }
    }

    if (best.slope < 0.3) {
      console.log(`  nowhere beside level ground is steeper than ${best.slope.toFixed(2)} — no hill to refuse`);
    } else {
      start(best.x, best.z, best.heading);
      let worst = 0;
      run(14, { x: 0, y: 1 }, () => {
        worst = Math.max(worst, terrain.slopeAt(walker.position.x, walker.position.z));
      });
      const held = at();
      run(1, { x: 0, y: 1 });
      const still = away(held);
      const refusedX = walker.position.x + Math.sin(walker.yaw) * 1.5;
      const refusedZ = walker.position.z + Math.cos(walker.yaw) * 1.5;
      console.log(
        `  straight at a ${best.slope.toFixed(2)} hillside off level ground: steepest ground ridden ` +
          `${worst.toFixed(2)} (${((Math.atan(worst) * 180) / Math.PI).toFixed(0)}°), climbed ` +
          `${(terrain.heightAt(walker.position.x, walker.position.z) - terrain.heightAt(best.x, best.z)).toFixed(1)} m,` +
          ` then held: ${still.toFixed(2)} m in the last second against ground of ` +
          `${terrain.slopeAt(refusedX, refusedZ).toFixed(2)} ahead, where the limit is 0.45`
      );
      // Pinned is not stuck: feet down and walk it round, which is the only way
      // off anything that has taken the speed away.
      const pinned = walker.yaw;
      run(3, { x: 1, y: 0 });
      const turned = Math.abs((wrap(walker.yaw - pinned) * 180) / Math.PI);
      const before = at();
      run(4, { x: 0, y: 1 });
      console.log(
        `  held against it the bars still answer: ${turned.toFixed(0)}° round in three seconds with the throttle ` +
          `shut, then ${away(before).toFixed(0)} m away in four`
      );
    }
  }

  // --- 5. a wall in the way -------------------------------------------------
  {
    start(road.road.points[road.at * 3], road.road.points[road.at * 3 + 2], headingAlong(road.road, road.at));
    let last = at();
    let before = 0;
    let where = road.at;
    follow(road.road, road.at, 6, (_n, sample) => {
      before = away(last) / DELTA;
      last = at();
      where = sample;
    });
    /**
     * On the centreline two samples ahead, which at the published 7 m spacing is
     * about 14 m up the road.
     *
     * It used to be 14 m along `walker.yaw`, and that only coincided with the
     * road while the road was straight. Now that the roads bend — and now that a
     * rider arrives at 19 m/s instead of 9 — the heading after six seconds is
     * wherever the last corner left it, and the post was being planted in a
     * field: measured at Hồ Tây, the bike finished 51.33 m from a post it had
     * driven straight past, and its speed went *up* through the test.
     */
    const samples = Math.floor(road.road.points.length / 3);
    const ahead = Math.min(samples - 1, where + 2);
    post = {
      x: road.road.points[ahead * 3],
      z: road.road.points[ahead * 3 + 2],
      radius: 2,
      bottom: 0,
      top: 1000,
    };
    let into = 0;
    let gap = Infinity;
    // Still riding the road, so what stops it is the post and not the verge.
    follow(road.road, road.at, 6, () => {
      into = away(last) / DELTA;
      last = at();
      const reach = Math.hypot(walker.position.x - post!.x, walker.position.z - post!.z);
      if (reach < gap) gap = reach;
    });
    const pinned = at();
    run(2.5, { x: 1, y: 0 });
    run(3, { x: 0, y: 1 });
    console.log(
      `  a 2 m post 14 m up the road: ${before.toFixed(2)} m/s up to it, ${into.toFixed(2)} m/s against it, ` +
        `closest ${gap.toFixed(2)} m to its centre (2 m post + 0.45 shoulder); walked round and ridden away ` +
        `leaves it ${Math.hypot(walker.position.x - post.x, walker.position.z - post.z).toFixed(1)} m off, ` +
        `${away(pinned).toFixed(1)} m from where it was pinned`
    );
    post = null;
  }

  // --- 6. across a span over water ------------------------------------------
  if (recipe.water) {
    /** The carriageway standing highest over water: a bridge, by construction. */
    let span = { road: -1, at: 0, clearance: 0 };
    for (const entry of net.roads) {
      const count = Math.floor(entry.points.length / 3);
      for (let i = 0; i < count; i += 1) {
        const x = entry.points[i * 3];
        const z = entry.points[i * 3 + 2];
        if (terrain.heightAt(x, z) > waterLevel) continue;
        const clearance = entry.points[i * 3 + 1] - waterLevel;
        if (clearance > span.clearance) span = { road: entry.index, at: i, clearance };
      }
    }

    if (span.road < 0) console.log('  no carriageway over water here');
    else {
      const bridge = net.roads[span.road];
      const count = Math.floor(bridge.points.length / 3);
      const spacing = Math.max(
        0.5,
        Math.hypot(bridge.points[3] - bridge.points[0], bridge.points[5] - bridge.points[2])
      );
      const from = Math.max(1, span.at - Math.ceil(40 / spacing));
      start(bridge.points[from * 3], bridge.points[from * 3 + 2], headingAlong(bridge, from));

      let sank = 0;
      let dip = 0;
      let flew = 0;
      let frames = 0;
      let crossed = 0;
      let drift = 0;
      let lost = 0;
      const log: string[] = [];
      follow(bridge, from, 20, (n, sample, off) => {
        if (!walker.riding()) lost += 1;
        const surface = floorAt(walker.position.x, walker.position.z, walker.position.y);
        const bed = terrain.heightAt(walker.position.x, walker.position.z);
        const over = bike.position.y - surface;
        frames += 1;
        drift = Math.max(drift, off);
        if (over < -0.2) sank += 1;
        dip = Math.min(dip, over);
        if (over > 0.4) flew += 1;
        if (bed < waterLevel) crossed += 1;
        if (n % 30 === 0 && log.length < 20) {
          log.push(
            `    t=${fixed(n * DELTA, 1)}s  sample ${String(sample).padStart(4)}  bike y ${fixed(bike.position.y)}  ` +
              `surface ${fixed(surface)}  bed ${fixed(bed)}  water ${fixed(waterLevel)}  ` +
              `wheels over water ${fixed(bike.position.y - waterLevel)}  off centre ${fixed(off, 1)} m  ` +
              `${bed < waterLevel ? 'OVER THE WATER' : 'on the ground'}`
          );
        }
      });
      console.log(
        `  the span: road ${span.road} (${bridge.kind}, ${bridge.width.toFixed(1)} m wide), ` +
          `${span.clearance.toFixed(2)} m over the water at sample ${span.at} of ${count - 1}, entered at ${from}`
      );
      console.log(log.join('\n'));
      console.log(
        `  ${frames} frames: ${crossed} with water under the wheels, worst wander ${drift.toFixed(1)} m off the ` +
          `centreline, ${sank} more than 20 cm under the surface (worst ${dip.toFixed(2)} m, the eased step), ` +
          `${flew} more than 40 cm over it, ${lost} not riding`
      );
    }
  }

  // --- 7. and the boat is still a boat ---------------------------------------
  // `Rideable` is shared, and `steer` went optional so a machine could leave it
  // out — which is exactly the kind of change that breaks the thing it was not
  // aimed at. So the hull is rowed here too, through the same walker.
  if (recipe.water) {
    if (walker.riding()) dismount();
    const life = createLife(terrain, recipe, { people: 0, boats: 4, birds: 0 }, undefined, [], []);
    const hulls = life.rideables();
    if (hulls.length === 0) console.log('  no boat to check against');
    else {
      const hull = hulls[0];
      const rideBoth = () => [...hulls, ...vehicles.rideables()];
      const boatWalker = seeded(() =>
        createWalker(terrain, listener, hull.position.x, hull.position.z, [], undefined, 0, undefined, {
          water: recipe.water ?? null,
          platforms: net.decks,
          rideables: rideBoth,
          reducedMotion: true,
        })
      );
      let clock = 0;
      const tick = (seconds: number, stick: { x: number; y: number } | null) => {
        boatWalker.setJoystick(stick);
        for (let n = 0; n < Math.round(seconds * 60); n += 1) {
          clock += DELTA;
          life.update(clock);
          boatWalker.update(DELTA, camera);
        }
      };
      boatWalker.teleport(hull.position.x, hull.position.z);
      tick(0.4, null);
      const offer = boatWalker.prompt();
      boatWalker.interact();
      tick(0.1, null);
      const aboard = boatWalker.riding();
      const from = { x: hull.position.x, z: hull.position.z };
      tick(8, { x: 0, y: 1 });
      const way = Math.hypot(hull.position.x - from.x, hull.position.z - from.z) / 8;
      const leave = boatWalker.prompt();
      boatWalker.interact();
      tick(0.4, null);
      console.log(
        `  the boat: prompt "${offer}", aboard ${aboard}, rowed her at ${way.toFixed(2)} m/s for eight seconds, ` +
          `prompt aboard "${leave}", ashore ${!boatWalker.riding()}`
      );
      boatWalker.dispose();
    }
    life.dispose();
  }

  const walk = Math.min(...net.parking.map((spot) => Math.hypot(spot.x - spawn.x, spot.z - spawn.z)));
  rows.push({ slug, spots: net.parking.length, walk, top, reach, radius, pace, lean });
  if (walker.riding()) dismount();
  walker.dispose();
  vehicles.dispose();
}

console.log('\n================ the table ================');
console.log('place       spots  spawn→spot  top speed            0→95%  circle at speed');
for (const row of rows) {
  console.log(
    `${row.slug.padEnd(11)} ${String(row.spots).padStart(5)}  ${row.walk.toFixed(0).padStart(8)} m  ` +
      `${row.top.toFixed(2)} m/s ${(row.top * 3.6).toFixed(0).padStart(3)} km/h  ` +
      `${row.reach.toFixed(1).padStart(5)} s  ${row.radius.toFixed(1).padStart(5)} m at ` +
      `${row.pace.toFixed(1)} m/s, ${row.lean.toFixed(0)}° lean`
  );
}
