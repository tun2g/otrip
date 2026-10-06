/**
 * Is the ridden machine faster than running, point to point?
 *
 * The player has said three times that it is not, and has twice been answered
 * with a top speed. A top speed is not a journey: a body on foot crosses country
 * in a straight line at a flat `TRAVEL_SPEED` of 14 m/s, reached in 0.45 s, while
 * a machine follows a carriageway that is longer than the straight line, brakes
 * for every bend, and takes seconds to spool up. So this measures the only thing
 * that settles the argument — **straight-line displacement over elapsed time**,
 * which is directly comparable to the runner, rather than distance along a road,
 * which is not.
 *
 * It also separates two things `probe/motorbike-ride.ts` cannot. That probe's
 * rider is pure pursuit aiming at a point **15 m** along the centreline, which
 * was tuned against a machine doing 9 to 20 m/s. At 50 m/s, 15 m is 0.3 s of
 * lookahead — no human rides that way and no controller can hold a road with it.
 * So every route here is driven at several lookaheads, stated as *seconds* of
 * travel, and the spread between them is the measure of how much of any slowness
 * belongs to the machine and how much to the hand on the bars.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/ride-pace.ts [--only=ta-xua]
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
  pointerLockElement: null,
  exitPointerLock: () => {},
};

const { createTerrain, LOCATIONS } = await import('@otrip/world');
const { PerspectiveCamera } = await import('three');
const { resolvePois } = await import('../src/scene/points-of-interest.ts');
const { createRoadNetwork } = await import('../src/scene/road-network.ts');
const { planTown } = await import('../src/scene/town-plan.ts');
const { createVehicles } = await import('../src/scene/vehicles.ts');
const { createWalker } = await import('../src/scene/walker.ts');

type Terrain = ReturnType<typeof createTerrain>;
type Network = ReturnType<typeof createRoadNetwork>;
type Road = Network['roads'][number];
type Platform = Network['decks'][number];

/** `walker.MADE_SURFACE`: clearance over bare ground that marks a carriageway. */
const MADE_SURFACE = 0.04;
const SEGMENTS = 416;
const DELTA = 1 / 60;
const STEP_UP = 0.4;
/** `walker.ts`'s own, which is what the machine has to beat. */
const TRAVEL_SPEED = 14;
/** Seconds each run lasts. Long enough that the spool-up is amortised. */
const RUN_FOR = 40;
/**
 * The lateral acceleration the ridden machine can actually hold, m/s².
 *
 * Not the tyre. It was `RIDDEN.grip / CRUISE_SHARE` — 30 m/s², what the rubber
 * would give — and that became wrong the moment `driving.ts` gained
 * `LEAN_LIMIT`: no two-wheeler can use 3.06 g sideways, because holding it means
 * leaning 72°, and a racing motorcycle runs out at 61°. So the honest ceiling is
 * `g · tan(61°)` = 17.7, and the tyre is only the ceiling lengthways, where the
 * stop and the launch still get all of it.
 *
 * The cost of the stale number was that this rider braked for every bend against
 * a figure 1.3 times what the machine can hold, entered each one too fast, ran
 * wide, and was then stopped dead by the hillside — which is most of why this
 * probe reported 0.98× at Tràng An and called it the machine being slow.
 *
 * Transcribed rather than imported, for the same reason `probe/driving-model.ts`
 * transcribes `SPECS`: the point of this probe is to check the machine against a
 * figure, and importing the figure makes it agree by construction. Which is also
 * why it went stale — a transcription has to be re-read when its source moves.
 */
const RIDDEN_TYRE = 9.81 * Math.tan(1.064);

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
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

const only = process.argv.find((value) => value.startsWith('--only='))?.slice(7);
const slugs = ['ta-xua', 'hoi-an', 'trang-an', 'ho-tay'].filter((slug) => !only || slug === only);

console.log(
  `\nStraight-line displacement over ${RUN_FOR} s, against a runner's ${TRAVEL_SPEED} m/s in a straight line.\n` +
    'Lookahead is stated in seconds of travel; `motorbike-ride.ts` uses a fixed 15 m, which is\n' +
    'the 0.3 s column at 50 m/s and the 1.0 s column at 15.'
);

type Row = { slug: string; best: number; bestAt: string; wander: number; stuck: boolean };
const rows: Row[] = [];

for (const slug of slugs) {
  const recipe = LOCATIONS[slug];
  if (!recipe) continue;
  const terrain = createTerrain(recipe, SEGMENTS);
  const plan = planTown(terrain, recipe, 1);
  const pois = resolvePois(terrain, recipe, plan.lots);
  const net = createRoadNetwork(terrain, recipe, pois, plan.lots);
  const floorAt = makeFloorAt(terrain, net.decks);
  const vehicles = createVehicles(recipe, net, 16, terrain);
  const bike = vehicles.rideables()[0];
  if (!bike) {
    console.log(`\n${slug}: no parked bike`);
    continue;
  }

  const trunk = net.roads
    .filter((entry) => entry.kind !== 'trail')
    .reduce((best, entry) => (best && best.totalLength >= entry.totalLength ? best : entry));
  const px = (i: number) => trunk.points[i * 3];
  const pz = (i: number) => trunk.points[i * 3 + 2];
  const count = Math.floor(trunk.points.length / 3);
  const spacing = Math.max(0.5, Math.hypot(px(1) - px(0), pz(1) - pz(0)));

  const camera = new PerspectiveCamera(60, 16 / 9, 2, 4000);
  const walker = seeded(() =>
    createWalker(terrain, listener, px(1), pz(1), [], undefined, 0, undefined, {
      water: recipe.water ?? null,
      platforms: net.decks,
      rideables: () => vehicles.rideables(),
      reducedMotion: true,
    })
  );
  /** Hoisted: the bend law is asked once a frame and must not allocate. */
  const here = { x: 0, y: 0, z: 0, tx: 0, tz: 1, curvature: 0 };

  console.log(`\n================ ${slug} ================`);
  console.log(`  the ${trunk.kind} road: ${trunk.totalLength.toFixed(0)} m over ${count} samples`);
  console.log(
    `  lookahead   road covered   road avg   straight line   point-to-point   vs running   worst wander     off carriageway`
  );

  let best = 0;
  let bestAt = '';
  let bestWander = 0;
  let anyStuck = false;

  /**
   * @param seconds of lookahead
   * @param lift whether the rider brakes for the bend ahead rather than holding
   *   the throttle open.
   *
   * The second one is the measurement that was missing. `motorbike-ride.ts`
   * never lifts, which measures the worst case, and with 62 kW the worst case is
   * a machine that leaves the road at the first corner. A rider brakes, and the
   * new model's whole argument is that braking is a skill — so the honest
   * headline is what a rider who uses it gets, with the full-throttle figure
   * beside it as the floor.
   *
   * The target speed is the bend law the NPC fleet already drives by:
   * `sqrt(grip / curvature)` against the curvature of the road at the aim point,
   * which is the one place in this repo that already knows how fast a corner can
   * be taken. Nothing new is invented and nothing is tuned by feel.
   */
  const ride = (seconds: number, lift: boolean) => {
    // Remounted from the same spot each time, so the only thing that differs
    // between the rows is the hand on the bars.
    if (walker.riding()) {
      walker.setJoystick(null);
      walker.interact();
      for (let n = 0; n < 24; n += 1) walker.update(DELTA, camera);
    }
    const at = 1;
    const heading = Math.atan2(px(at + 1) - px(at), pz(at + 1) - pz(at));
    bike.position.set(px(at), floorAt(px(at), pz(at), Number.POSITIVE_INFINITY), pz(at));
    bike.forward.set(Math.sin(heading), 0, Math.cos(heading));
    walker.teleport(px(at) + bike.forward.x * 1.6, pz(at) + bike.forward.z * 1.6);
    walker.setJoystick({ x: 0, y: 0 });
    for (let n = 0; n < 24; n += 1) walker.update(DELTA, camera);
    walker.interact();
    for (let n = 0; n < 3; n += 1) walker.update(DELTA, camera);
    if (!walker.riding()) throw new Error(`${slug}: could not board`);

    const from = { x: walker.position.x, z: walker.position.z };
    let along = 0;
    let last = { x: walker.position.x, z: walker.position.z };
    let sample = at;
    let wander = 0;
    let done = false;
    // Frames spent going nowhere, which is what "stuck" means rather than "slow".
    let still = 0;
    /**
     * And frames spent off a published carriageway, which is what decides
     * whether a stall is a crash or the slope gate. `RIDER_CLIMB` refuses a
     * machine any bare ground over a 0.45 gradient, against the 1.15 a body on
     * foot will scramble up — so a bike that overshoots a bend on a shelf road
     * does not merely leave the lane, it stops dead on the hillside beyond it.
     */
    let offRoad = 0;

    walker.setJoystick({ x: 0, y: 1 });
    for (let n = 0; n < Math.round(RUN_FOR * 60); n += 1) {
      walker.update(DELTA, camera);
      const moved = Math.hypot(walker.position.x - last.x, walker.position.z - last.z);
      along += moved;
      if (moved / DELTA < 1) still += 1;
      const floor = floorAt(walker.position.x, walker.position.z, walker.position.y);
      if (floor <= terrain.heightAt(walker.position.x, walker.position.z) + MADE_SURFACE) offRoad += 1;
      last = { x: walker.position.x, z: walker.position.z };

      if (done) continue;
      let gap = Infinity;
      for (let i = Math.max(0, sample - 4); i < Math.min(count, sample + 400); i += 1) {
        const reach = Math.hypot(walker.position.x - px(i), walker.position.z - pz(i));
        if (reach < gap) {
          gap = reach;
          sample = i;
        }
      }
      wander = Math.max(wander, gap);
      if (sample >= count - 2) {
        done = true;
        walker.setJoystick({ x: 0, y: 0 });
        continue;
      }
      // The aim point, as a time rather than a distance: a rider looks a second
      // or two up the road whatever speed they are doing, and the fixed 15 m the
      // other probe uses is 0.3 s of that at 50 m/s.
      const speed = along / ((n + 1) * DELTA);
      const lead = Math.max(12, Math.max(speed, 8) * seconds);
      const aim = Math.min(count - 1, sample + Math.ceil(lead / spacing));
      const wanted = Math.atan2(px(aim) - walker.position.x, pz(aim) - walker.position.z);
      const steer = -Math.max(-1, Math.min(1, wrap(wanted - walker.yaw) * 1.1));

      let throttle = 1;
      if (lift) {
        // How fast the corner at the aim point can be taken, by `vehicles.ts`'s
        // own bend law — `sqrt(hold / curvature)` — against what the machine can
        // actually lean to rather than what its tyres could grip. Sampled at the
        // aim point so the rider brakes for the bend they are about to be in.
        net.sampleAt(trunk.index, (aim / Math.max(1, count - 1)) * trunk.totalLength, here);
        const bend = Math.abs(here.curvature);
        const hold = bend > 1e-5 ? Math.sqrt(RIDDEN_TYRE / bend) : Infinity;
        const now = Math.hypot(walker.body().vx, walker.body().vz);
        // Full throttle under the limit, off it approaching, and on the brake
        // over it. −1 is the brake while it is rolling, which is the one key a
        // rider uses for both.
        throttle = now < hold * 0.9 ? 1 : now < hold * 1.05 ? 0 : -1;
      }
      walker.setJoystick({ x: steer, y: throttle });
    }

    const straight = Math.hypot(walker.position.x - from.x, walker.position.z - from.z);
    const pace = straight / RUN_FOR;
    const ratio = pace / TRAVEL_SPEED;
    const stuck = still > RUN_FOR * 60 * 0.25;
    anyStuck = anyStuck || stuck;
    if (pace > best) {
      best = pace;
      bestAt = `${seconds.toFixed(1)} s`;
      bestWander = wander;
    }
    console.log(
      `  ${seconds.toFixed(1)} s`.padEnd(14) +
        `${along.toFixed(0)} m`.padStart(12) +
        `${(along / RUN_FOR).toFixed(1)} m/s`.padStart(11) +
        `${straight.toFixed(0)} m`.padStart(16) +
        `${pace.toFixed(1)} m/s`.padStart(17) +
        `${ratio.toFixed(2)}x`.padStart(13) +
        `${wander.toFixed(1)} m`.padStart(15) +
        `${((offRoad / (RUN_FOR * 60)) * 100).toFixed(0)}% off road`.padStart(16) +
        (stuck ? `   stalled ${((still / (RUN_FOR * 60)) * 100).toFixed(0)}% of frames` : '')
    );
  };

  for (const lift of [false, true]) {
    console.log(`  --- ${lift ? 'braking for the bend' : 'throttle held open throughout'} ---`);
    for (const seconds of [0.3, 1.5, 2.5]) ride(seconds, lift);
  }

  rows.push({ slug, best, bestAt, wander: bestWander, stuck: anyStuck });
  walker.dispose();
  vehicles.dispose();
}

console.log('\n================ best of each, which is what a competent rider gets ================');
console.log('place       point-to-point   vs running   at lookahead   worst wander   verdict');
for (const row of rows) {
  // A lane is 3.0 m wide and a trunk road 7.0, so a wander past about 5 m is off
  // the carriageway whatever road it was.
  const verdict = row.best < TRAVEL_SPEED ? 'SLOWER THAN RUNNING' : row.wander > 8 ? 'fast but off the road' : 'ok';
  console.log(
    row.slug.padEnd(12) +
      `${row.best.toFixed(1)} m/s`.padStart(13) +
      `${(row.best / TRAVEL_SPEED).toFixed(2)}x`.padStart(13) +
      row.bestAt.padStart(15) +
      `${row.wander.toFixed(1)} m`.padStart(15) +
      '   ' +
      verdict
  );
}
console.log('');
