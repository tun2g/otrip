/**
 * Does the dash read the machine, or does it read zeroes?
 *
 * The user's request: "lái xe kì vọng phải thấy vận tốc bao nhiêu, tăng ga hạ ga
 * các kiểu" — riding, they expect to see how fast they are going and what the
 * throttle is doing. `walker.telemetry()` is what answers it, and it is eleven
 * numbers copied out of a `DriveState` that nothing outside that file could see.
 *
 * A read-out is worth less than nothing if it is wrong, so this rides a real
 * machine on real terrain and checks each field against something independent of
 * it: the speed against the ground the walker actually covered, the full scale
 * against `tuneDrive`'s own answer, the pedals against the stick that was held,
 * and the gradient against the terrain. It also pins the two things the dash's
 * author has to know: the object is reused, and it is null on foot and afloat.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/ride-dash.ts
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
const { createLife } = await import('../src/scene/life.ts');
const { createVehicles } = await import('../src/scene/vehicles.ts');
const { createWalker } = await import('../src/scene/walker.ts');
const { tuneDrive } = await import('../src/scene/driving.ts');

type Terrain = ReturnType<typeof createTerrain>;
type Network = ReturnType<typeof createRoadNetwork>;
type Platform = Network['decks'][number];

const SEGMENTS = 416;
const DELTA = 1 / 60;
const STEP_UP = 0.4;

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

let failures = 0;
const check = (claim: string, pass: boolean, shown: string) => {
  if (!pass) failures += 1;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${claim.padEnd(50)} ${shown}`);
};

const SLUG = 'ta-xua';
const recipe = LOCATIONS[SLUG];
const terrain = createTerrain(recipe, SEGMENTS);
const plan = planTown(terrain, recipe, 1);
const pois = resolvePois(terrain, recipe, plan.lots);
const net = createRoadNetwork(terrain, recipe, pois, plan.lots);
const floorAt = makeFloorAt(terrain, net.decks);
const vehicles = createVehicles(recipe, net, 16, terrain);

const trunk = net.roads
  .filter((entry) => entry.kind !== 'trail')
  .reduce((best, entry) => (best && best.totalLength >= entry.totalLength ? best : entry));
const px = (i: number) => trunk.points[i * 3];
const pz = (i: number) => trunk.points[i * 3 + 2];

const camera = new PerspectiveCamera(60, 16 / 9, 2, 4000);
const bike = vehicles.rideables()[0];
const walker = seeded(() =>
  createWalker(terrain, listener, px(1), pz(1), [], undefined, 0, undefined, {
    water: recipe.water ?? null,
    platforms: net.decks,
    rideables: () => vehicles.rideables(),
    reducedMotion: true,
  })
);

const run = (seconds: number, stick: { x: number; y: number } | null, keys?: { space?: boolean }) => {
  walker.setJoystick(stick);
  void keys;
  for (let n = 0; n < Math.round(seconds * 60); n += 1) walker.update(DELTA, camera);
};

console.log(`\nAt ${SLUG}, on the ${trunk.kind} road.`);

console.log('\n--- on foot there is no dash ------------------------------------------');
run(0.2, null);
check('null while walking', walker.telemetry() === null, String(walker.telemetry()));

console.log('\n--- astride one, before the throttle -----------------------------------');
{
  const at = 1;
  const heading = Math.atan2(px(at + 1) - px(at), pz(at + 1) - pz(at));
  bike.position.set(px(at), floorAt(px(at), pz(at), Number.POSITIVE_INFINITY), pz(at));
  bike.forward.set(Math.sin(heading), 0, Math.cos(heading));
  walker.teleport(px(at) + bike.forward.x * 1.6, pz(at) + bike.forward.z * 1.6);
  run(0.35, { x: 0, y: 0 });
  walker.interact();
  run(0.05, { x: 0, y: 0 });
  if (!walker.riding()) throw new Error('could not board');

  const dash = walker.telemetry();
  check('a dash appears', dash !== null, dash ? 'yes' : 'null');
  if (!dash) throw new Error('no telemetry astride a machine');
  check('labelled in Vietnamese', dash.noun === 'xe máy', `"${dash.noun}"`);
  // `tuneDrive` is asked for the figure rather than told one, so the dial's full
  // scale and the physics' own ceiling cannot drift apart.
  const limit = tuneDrive(bike.machine!.drive).limit;
  check("full scale is the machine's own", Math.abs(dash.topSpeed - limit) < 1e-9, `${dash.topSpeed} m/s`);
  check(
    'stopped, so nothing is asked of it',
    dash.throttle === 0 && dash.brake === 0,
    `throttle ${dash.throttle}, brake ${dash.brake}`
  );
  check(
    'every field is a number',
    Object.values(dash).every((v) => typeof v === 'string' || Number.isFinite(v)),
    'all finite'
  );
}

console.log('\n--- the same object every call, so it must not be held -----------------');
{
  const first = walker.telemetry();
  const second = walker.telemetry();
  check('one object, refilled', first === second, 'identical reference');
  // Which is the thing the dash's author has to know: read the fields out, do
  // not keep the object. Shown rather than asserted in prose.
  const held = first!;
  const copied = held.speed;
  run(1, { x: 0, y: 1 });
  // Refilled on the *call*, not on the frame — so a held reference is stale
  // until somebody asks again, and is then overwritten in place. Both of those
  // are reasons to read the fields out and not keep the object.
  check('a held reference is stale until the next call', held.speed === copied, `still ${held.speed.toFixed(2)} m/s`);
  const fresh = walker.telemetry()!;
  check(
    'and is then overwritten in place',
    held === fresh && held.speed !== copied,
    `${copied.toFixed(2)} → ${held.speed.toFixed(2)} m/s on the same object`
  );
}

console.log('\n--- full throttle ------------------------------------------------------');
{
  const from = { x: walker.position.x, z: walker.position.z };
  run(4, { x: 0, y: 1 });
  // Against the ground actually covered, which is the one reading in here that
  // owes nothing to the model that produced it — and read *after* the frame it
  // describes. Taken before, the dash is one frame older than the displacement
  // and the two disagreed by 11% on a climb, which is the machine accelerating
  // in between rather than the read-out being wrong.
  const before = { x: walker.position.x, z: walker.position.z };
  walker.update(DELTA, camera);
  const covered = Math.hypot(walker.position.x - before.x, walker.position.z - before.z) / DELTA;
  const dash = walker.telemetry()!;
  console.log(
    `       speed ${dash.speed.toFixed(2)} m/s, ground covered ${covered.toFixed(2)} m/s, ` +
      `throttle ${dash.throttle.toFixed(2)}, grade ${dash.grade.toFixed(3)}, ` +
      `slip ${((dash.slip * 180) / Math.PI).toFixed(1)}°, slide ${dash.frontSlide.toFixed(2)}/${dash.rearSlide.toFixed(2)}`
  );
  check('the throttle reads wide open', dash.throttle > 0.99, `${dash.throttle.toFixed(2)}`);
  check('and no brake with it', dash.brake === 0, `${dash.brake}`);
  check('it is moving', dash.speed > 4, `${dash.speed.toFixed(2)} m/s`);
  // Within a tenth: `speed` is the nose speed and the ground reading is the
  // whole velocity, so a machine at any slip angle reads slightly higher.
  check(
    'the speed is the ground it covers',
    Math.abs(dash.speed - covered) < Math.max(0.3, covered * 0.1),
    `${dash.speed.toFixed(2)} against ${covered.toFixed(2)} m/s`
  );
  check('under its own full scale', dash.speed <= dash.topSpeed, `${dash.speed.toFixed(2)} of ${dash.topSpeed}`);
  check(
    'the gradient is the hill it is on',
    Math.abs(dash.grade) < 0.5,
    `${dash.grade.toFixed(3)} m risen per metre, against the 0.45 a machine refuses`
  );
  check('and it went somewhere', Math.hypot(walker.position.x - from.x, walker.position.z - from.z) > 20, 'yes');
}

console.log('\n--- off the throttle, onto the brake -----------------------------------');
{
  const was = walker.telemetry()!.speed;
  run(0.5, { x: 0, y: -1 });
  const dash = walker.telemetry()!;
  console.log(
    `       ${was.toFixed(2)} → ${dash.speed.toFixed(2)} m/s, brake ${dash.brake.toFixed(2)}, throttle ${dash.throttle.toFixed(2)}`
  );
  check('the brake reads applied', dash.brake > 0.99, `${dash.brake.toFixed(2)}`);
  check('and the throttle shut with it', dash.throttle === 0, `${dash.throttle}`);
  check('it is slowing', dash.speed < was, `−${(was - dash.speed).toFixed(2)} m/s`);
}

console.log('\n--- the boost meter ----------------------------------------------------');
{
  // Driven straight first, then on full lock. `driving.ts` charges the meter off
  // `sliding * pace * BOOST_DRIFT + draft * pace * BOOST_DRAFT`, and the second
  // term is dead: `walker.ts` sets `driveSurface.draft = 0` with a comment saying
  // so. Which leaves drifting as the only thing that fills it, so a dash whose
  // boost gauge never moves in a straight line is correct and not broken.
  run(3, { x: 0, y: 1 });
  const straight = walker.telemetry()!.boost;
  run(4, { x: 1, y: 1 });
  const dash = walker.telemetry()!;
  console.log(
    `       meter ${dash.boost.toFixed(3)}, lit ${dash.boosting.toFixed(3)}; ` +
      `${straight.toFixed(3)} after three seconds in a straight line`
  );
  check('straight ahead it charges nothing', straight === 0, `${straight.toFixed(3)}`);
  /**
   * The gauge was dead and is not any more.
   *
   * `driving.ts` charges the meter off `drifting · pace · BOOST_DRIFT`, and
   * `drifting` used to be the slip angle alone. With the ridden machine's 3.06 g
   * of tyre the machine understeers rather than drifts — full lock saturates the
   * *front* axle, as the numbers below still show — so it developed no slip
   * angle and the meter read 0.000 after four seconds of trying. That mattered
   * beyond the gauge: the boosted top speed is a quarter of the speed the player
   * was promised and none of it was reachable.
   *
   * It now reads the larger of the slip angle and the **driven** axle's slide,
   * which on a bike is the rear, and the rear does let go at full lock once the
   * front has washed out. Measured: 0.147 of the meter in four seconds against
   * `BOOST_ARM`'s 0.25, so about seven seconds of drifting arms it.
   */
  check(
    'on full lock it charges, so the gauge is alive',
    dash.boost > 0,
    `${dash.boost.toFixed(3)} after four seconds of it — front axle ${dash.frontSlide.toFixed(2)} gone, ` +
      `driven axle ${dash.rearSlide.toFixed(2)}, slip ${((dash.slip * 180) / Math.PI).toFixed(1)}°: it understeers ` +
      `rather than drifts, and only the driven axle and the slip angle charge the meter`
  );
  check('the meter is a fraction', dash.boost >= 0 && dash.boost <= 1, `${dash.boost.toFixed(3)}`);
  check('and so is how much of it is lit', dash.boosting >= 0 && dash.boosting <= 1, `${dash.boosting.toFixed(3)}`);
  check(
    'both axle-grip figures are fractions',
    dash.frontSlide >= 0 && dash.frontSlide <= 1 && dash.rearSlide >= 0 && dash.rearSlide <= 1,
    `${dash.frontSlide.toFixed(2)} / ${dash.rearSlide.toFixed(2)}`
  );
}

console.log('\n--- getting off puts it away -------------------------------------------');
{
  walker.setJoystick(null);
  walker.interact();
  run(0.4, { x: 0, y: 0 });
  check('not riding', !walker.riding(), String(walker.riding()));
  check('and no dash', walker.telemetry() === null, String(walker.telemetry()));
}

console.log('\n--- a hull has no dash, which is a decision ----------------------------');
{
  // A boat has no throttle pedal, no brake, no axles and no gradient under it,
  // so eight of the eleven numbers would be zeroes dressed as readings. It
  // reports nothing rather than reporting nonsense; if a hull should have its
  // own read-out it wants its own shape, not this one with the holes in it.
  // Built at Hội An rather than here: Tà Xùa is a ridge with no water on it, so
  // there is no hull to board and the claim would go untested.
  const wet = LOCATIONS['hoi-an'];
  const wetTerrain = createTerrain(wet, SEGMENTS);
  const life = createLife(wetTerrain, wet, { people: 0, boats: 4, birds: 0 });
  const hulls = life.rideables();
  if (hulls.length === 0) console.log('  no boat here to check against');
  else {
    const hull = hulls[0];
    const boatCamera = new PerspectiveCamera(60, 16 / 9, 2, 4000);
    const sailor = seeded(() =>
      createWalker(wetTerrain, listener, hull.position.x, hull.position.z, [], undefined, 0, undefined, {
        water: wet.water ?? null,
        rideables: () => hulls,
        reducedMotion: true,
      })
    );
    let clock = 0;
    const tick = (seconds: number) => {
      for (let n = 0; n < Math.round(seconds * 60); n += 1) {
        clock += DELTA;
        life.update(clock);
        sailor.update(DELTA, boatCamera);
      }
    };
    sailor.teleport(hull.position.x, hull.position.z);
    tick(0.4);
    sailor.interact();
    tick(0.1);
    check('aboard her', sailor.riding(), String(sailor.riding()));
    check('and still no dash', sailor.telemetry() === null, String(sailor.telemetry()));
    sailor.dispose();
  }
  life.dispose();
}

walker.dispose();
vehicles.dispose();
console.log(failures ? `\nFAILED — ${failures} check${failures === 1 ? '' : 's'}\n` : '\nOK\n');
if (failures) process.exitCode = 1;
