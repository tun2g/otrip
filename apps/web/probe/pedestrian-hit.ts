/**
 * Can a vehicle hit a person, and can a person be an obstacle to one?
 *
 * The user, after the first round of collision work: "với lại chưa xử lý va chạm
 * giữa các xe, giữa nhân vật với xe" — between vehicles, and between the
 * character and vehicles — and then "kể cả các xe do map sinh ra nha", including
 * the ones the map generates. The first half was built and never wired. This
 * second half was not built at all: on foot the walker resolved against
 * `gatherContacts` only, which is buildings, trunks and lineside structures, all
 * of it static. A xe khách at 12 m/s went straight through a pedestrian.
 *
 * There is no health in this app and there must not be, so being hit is a shove
 * and a loss of footing: knocked clear, gait back to a standstill, and `GAIT_RAMP`
 * seconds to get back up to a jog. What this measures is who moved, how far, and
 * what each lost.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/pedestrian-hit.ts
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Impactor } from '../src/scene/driving.ts';

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
const { createImpactor } = await import('../src/scene/driving.ts');

type Terrain = ReturnType<typeof createTerrain>;
type Network = ReturnType<typeof createRoadNetwork>;
type Platform = Network['decks'][number];

const SEGMENTS = 416;
const DELTA = 1 / 60;
const STEP_UP = 0.4;
/** `walker.SHOULDER`, which is the radius a body on foot is resolved at. */
const SHOULDER = 0.45;

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

const SLUG = 'hoi-an';
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
const headingAt = (i: number) => Math.atan2(px(i + 1) - px(i), pz(i + 1) - pz(i));

console.log(`\nAt ${SLUG}, on the ${trunk.kind} road: ${trunk.totalLength.toFixed(0)} m.`);

/** One body that is not a walker, placed and driven by hand. */
const prop = (mass: number, radius: number) => {
  const body = createImpactor();
  body.mass = mass;
  body.radius = radius;
  return {
    body,
    put: (x: number, z: number, vx = 0, vz = 0) => {
      body.x = x;
      body.z = z;
      body.vx = vx;
      body.vz = vz;
    },
  };
};

/**
 * Which way the stick walks.
 *
 * On foot the stick is **camera-relative** — the walker builds its heading from
 * the camera yaw and the stick — and this probe never moves the mouse, so the
 * mapping is one fixed rotation for the whole run. Measured once rather than
 * assumed: the first version of this probe set `{x: 0, y: 1}` and believed the
 * body was walking down the road, when it was walking whatever direction the
 * walker happened to be created facing. Every test then measured two things
 * moving past each other on different lines, and reported a coach that missed by
 * 6.75 m as a coach that did not brake.
 */
const stickBasis = (() => {
  const camera = new PerspectiveCamera(60, 16 / 9, 2, 4000);
  const walker = seeded(() =>
    createWalker(terrain, listener, px(1), pz(1), [], undefined, 0, undefined, {
      water: recipe.water ?? null,
      platforms: net.decks,
      reducedMotion: true,
    })
  );
  const read = (x: number, y: number) => {
    walker.teleport(px(1), pz(1));
    walker.setJoystick(null);
    for (let n = 0; n < 30; n += 1) walker.update(DELTA, camera);
    const from = { x: walker.position.x, z: walker.position.z };
    walker.setJoystick({ x, y });
    for (let n = 0; n < 90; n += 1) walker.update(DELTA, camera);
    const dx = walker.position.x - from.x;
    const dz = walker.position.z - from.z;
    const span = Math.hypot(dx, dz) || 1;
    return { x: dx / span, z: dz / span };
  };
  const ahead = read(0, 1);
  const side = read(1, 0);
  walker.dispose();
  return { ahead, side };
})();

/** The stick that walks toward a point, in the basis measured above. */
const toward = (fromX: number, fromZ: number, atX: number, atZ: number) => {
  const dx = atX - fromX;
  const dz = atZ - fromZ;
  const span = Math.hypot(dx, dz) || 1;
  const ux = dx / span;
  const uz = dz / span;
  // The basis is orthonormal to within what a walk measures, so a projection on
  // each axis recovers the stick.
  const y = ux * stickBasis.ahead.x + uz * stickBasis.ahead.z;
  const x = ux * stickBasis.side.x + uz * stickBasis.side.z;
  const scale = Math.max(Math.abs(x), Math.abs(y)) || 1;
  return { x: x / scale, y: y / scale };
};

console.log(
  `  the stick's basis: {0,1} walks (${stickBasis.ahead.x.toFixed(2)}, ${stickBasis.ahead.z.toFixed(2)}), ` +
    `{1,0} walks (${stickBasis.side.x.toFixed(2)}, ${stickBasis.side.z.toFixed(2)})`
);

const onFoot = (traffic: () => readonly Impactor[]) => {
  const camera = new PerspectiveCamera(60, 16 / 9, 2, 4000);
  const walker = seeded(() =>
    createWalker(terrain, listener, px(1), pz(1), [], undefined, 0, undefined, {
      water: recipe.water ?? null,
      platforms: net.decks,
      rideables: () => vehicles.rideables(),
      traffic: [traffic],
      reducedMotion: true,
    })
  );
  return {
    walker,
    camera,
    step: () => walker.update(DELTA, camera),
    run: (seconds: number, stick: { x: number; y: number } | null, each?: () => void) => {
      walker.setJoystick(stick);
      for (let n = 0; n < Math.round(seconds * 60); n += 1) {
        walker.update(DELTA, camera);
        each?.();
      }
    },
  };
};

// =============================================================================
console.log('\n=== a coach into somebody standing in the lane ==============================');
/**
 * 12 t at 12 m/s, which is `SPECS.coach`'s mass and about its cruise, driven at
 * a body standing still.
 *
 * In two halves, because the first attempt conflated them. While the coach is
 * still coming it **bulldozes** the body down the road — which is correct, and
 * is what 12 tonnes that has not braked does to 75 kg — and measuring the total
 * displacement over ten seconds of that reported 83.70 m and read as the body
 * being launched. So the coach is stopped once it has made contact, and the
 * distance the body travels *after* that is the knock on its own.
 */
{
  const coach = prop(12000, 3.25);
  const me = onFoot(() => [coach.body]);
  const at = 40;
  const heading = headingAt(at);
  const standX = px(at);
  const standZ = pz(at);
  me.walker.teleport(standX, standZ);
  me.run(0.5, null);

  const from = { x: me.walker.position.x, z: me.walker.position.z };
  let along = -40;
  const SPEED = 12;
  let closest = Infinity;
  let worstOverlap = 0;
  let hit = -1;
  const clear = SHOULDER + coach.body.radius;
  me.walker.setJoystick(null);

  /**
   * Driven until its centre is two metres past where the body was standing, so
   * the whole of the contact happens inside the loop.
   *
   * Contact is the frame the body comes out resolved at exactly the reach, not a
   * frame where it is merely near: the first version tested `span < clear + 0.3`,
   * which fires on the approach before the collision has run and reported a
   * contact that had not happened yet with 0.00 m of everything.
   */
  for (let frame = 0; frame < 900 && along < 2; frame += 1) {
    along += SPEED * DELTA;
    coach.put(
      standX + Math.sin(heading) * along,
      standZ + Math.cos(heading) * along,
      Math.sin(heading) * SPEED,
      Math.cos(heading) * SPEED
    );
    me.step();
    const span = Math.hypot(me.walker.position.x - coach.body.x, me.walker.position.z - coach.body.z);
    closest = Math.min(closest, span);
    if (span < clear) worstOverlap = Math.max(worstOverlap, clear - span);
    // The body was standing still, so the first frame it has moved at all is the
    // frame it was hit. Testing the gap instead needs a tolerance, and there is
    // no right one: the separation puts the body at exactly the reach and the
    // knock then carries it further out, so `<= clear + 0.01` missed it entirely
    // once the knock started working.
    if (hit < 0 && Math.hypot(me.walker.position.x - from.x, me.walker.position.z - from.z) > 0.05) hit = frame;
  }
  const bulldozed = Math.hypot(me.walker.position.x - from.x, me.walker.position.z - from.z);
  const hitAt = { x: me.walker.position.x, z: me.walker.position.z };

  // --- and once it has stopped, the knock on its own ---
  coach.put(coach.body.x, coach.body.z, 0, 0);
  for (let frame = 0; frame < 240; frame += 1) {
    me.step();
    const span = Math.hypot(me.walker.position.x - coach.body.x, me.walker.position.z - coach.body.z);
    closest = Math.min(closest, span);
    if (span < clear) worstOverlap = Math.max(worstOverlap, clear - span);
  }
  const slid = Math.hypot(me.walker.position.x - hitAt.x, me.walker.position.z - hitAt.z);

  console.log(
    `  the two reach ${clear.toFixed(2)} m; closest ${closest.toFixed(2)} m, worst overlap ${worstOverlap.toFixed(3)} m`
  );
  console.log(
    `  contact on frame ${hit}; bulldozed ${bulldozed.toFixed(2)} m while it kept coming, ` +
      `then slid ${slid.toFixed(2)} m once it stopped`
  );
  check('the coach does not drive through them', hit >= 0, `contact on frame ${hit}`);
  check('and never leaves them inside it', worstOverlap < 0.05, `${worstOverlap.toFixed(3)} m`);
  check(
    'the knock alone carries them clear, not down the street',
    slid > 0.1 && slid < 6,
    `${slid.toFixed(2)} m, against the 2 m a 6 m/s knock fading at 3/s carries`
  );
  me.walker.dispose();
}

// =============================================================================
console.log('\n=== and the gait falls off the ladder =======================================');
{
  const coach = prop(12000, 3.25);
  const me = onFoot(() => [coach.body]);
  const at = 40;
  const heading = headingAt(at);
  const standX = px(at);
  const standZ = pz(at);
  me.walker.teleport(standX, standZ);
  me.run(0.3, null);

  // Up to a jog, walking down the road: the gait climbs while the input is held,
  // so four seconds of it puts the body at the top of the ladder. Steered with
  // the measured stick basis rather than `{0,1}`, which walks whichever way the
  // walker was created facing.
  const downRoad = { x: standX + Math.sin(heading) * 400, z: standZ + Math.cos(heading) * 400 };
  const stick = toward(standX, standZ, downRoad.x, downRoad.z);
  coach.put(standX + Math.sin(heading) * 900, standZ + Math.cos(heading) * 900);
  me.run(4, stick);
  const beforeHit = Math.hypot(me.walker.body().vx, me.walker.body().vz);

  // Then a coach down the same line, coming the other way.
  // 40 m of gap closing at 12 m/s plus whatever the body is doing: the first
  // version started at 90 m and ran 300 frames, which closes 60 m and misses.
  let along = 40;
  let afterHit = beforeHit;
  let hit = false;
  me.walker.setJoystick(stick);
  for (let frame = 0; frame < 400 && !hit; frame += 1) {
    along -= 12 * DELTA;
    const fromX = me.walker.position.x;
    const fromZ = me.walker.position.z;
    coach.put(
      fromX + Math.sin(heading) * along,
      fromZ + Math.cos(heading) * along,
      -Math.sin(heading) * 12,
      -Math.cos(heading) * 12
    );
    me.step();
    const span = Math.hypot(me.walker.position.x - coach.body.x, me.walker.position.z - coach.body.z);
    if (span <= SHOULDER + coach.body.radius + 0.01) {
      hit = true;
      // Two frames on, so the gait reset is in the speed rather than being read
      // on the frame the collision was still resolving.
      me.step();
      me.step();
      afterHit = Math.hypot(me.walker.body().vx, me.walker.body().vz);
    }
  }

  // And how long it takes to get going again, which is the whole of the penalty.
  coach.put(standX + Math.sin(heading) * 2000, standZ + Math.cos(heading) * 2000);
  let recovered = -1;
  me.walker.setJoystick(stick);
  for (let frame = 0; frame < 600; frame += 1) {
    me.step();
    const body = me.walker.body();
    if (Math.hypot(body.vx, body.vz) > beforeHit * 0.9) {
      recovered = frame * DELTA;
      break;
    }
  }

  console.log(`  walking at ${beforeHit.toFixed(2)} m/s, hit, then ${afterHit.toFixed(2)} m/s`);
  console.log(`  back to ${(beforeHit * 0.9).toFixed(2)} m/s after ${recovered.toFixed(2)} s on foot again`);
  check('it is hit at all', hit, hit ? 'yes' : 'the two never met');
  check(
    'being hit costs the gait',
    afterHit < beforeHit * 0.6,
    `${afterHit.toFixed(2)} of ${beforeHit.toFixed(2)} m/s`
  );
  check(
    'and it is got back, not lost',
    recovered > 0.2 && recovered < 4,
    `${recovered.toFixed(2)} s, against GAIT_RAMP's 1.6 s to a jog`
  );
  me.walker.dispose();
}

// =============================================================================
console.log('\n=== walking into something parked ===========================================');
/**
 * Measured before changing anything, because it may be deliberate. A parked xe
 * máy is a `Rideable`, not a contact, so a body walks through the bike it is
 * about to get on — and `BOARD_REACH` is 2.5 m, so a solid bike would be
 * something the rider has to get *past* to reach the prompt. The question is
 * whether the prompt still works when it is solid.
 */
{
  const bike = vehicles.rideables()[0];
  const me = onFoot(() => []);
  const at = 40;
  const heading = headingAt(at);
  bike.position.set(px(at), floorAt(px(at), pz(at), Number.POSITIVE_INFINITY), pz(at));
  bike.forward.set(Math.sin(heading), 0, Math.cos(heading));
  // Walked straight at it from 12 m back.
  const startX = px(at) - Math.sin(heading) * 12;
  const startZ = pz(at) - Math.cos(heading) * 12;
  me.walker.teleport(startX, startZ);
  me.run(0.4, null);
  let nearest = Infinity;
  let through = false;
  me.run(6, toward(startX, startZ, bike.position.x, bike.position.z), () => {
    const span = Math.hypot(me.walker.position.x - bike.position.x, me.walker.position.z - bike.position.z);
    nearest = Math.min(nearest, span);
    // Past it, on the far side, having started 12 m short of it.
    const along =
      (me.walker.position.x - bike.position.x) * Math.sin(heading) +
      (me.walker.position.z - bike.position.z) * Math.cos(heading);
    if (along > 1) through = true;
  });
  console.log(`  walked to within ${nearest.toFixed(2)} m of a parked xe máy; went through it: ${through}`);
  console.log(`  the prompt where they ended up: ${JSON.stringify(me.walker.prompt())}`);
  check('a parked bike is walked through today', through, 'measured, not assumed — see the verdict in the report');
  me.walker.dispose();
}

// =============================================================================
console.log('\n=== the fleet brakes for a pedestrian, through the real wiring ===============');
/**
 * The same arrangement `world-renderer.ts` now builds: the fleet is handed
 * `walker.body` and the walker is handed `vehicles.traffic`, with nothing
 * hand-placed. Which is the thing that was missing — all of this existed and
 * none of it was connected.
 */
{
  const fleet = createVehicles(recipe, net, 16, terrain);
  const camera = new PerspectiveCamera(60, 16 / 9, 2, 4000);
  const walker = seeded(() =>
    createWalker(terrain, listener, px(1), pz(1), [], undefined, 0, undefined, {
      water: recipe.water ?? null,
      platforms: net.decks,
      rideables: () => fleet.rideables(),
      traffic: [fleet.traffic],
      reducedMotion: true,
    })
  );
  fleet.watch(() => walker.body());

  let elapsed = 0;
  fleet.update(elapsed);
  // The fastest vehicle, and where it is going, off the public list.
  let target = fleet.traffic()[0];
  for (const body of fleet.traffic()) {
    if (Math.hypot(body.vx, body.vz) > Math.hypot(target.vx, target.vz)) target = body;
  }
  const pace = Math.hypot(target.vx, target.vz);
  // Planted on its own centreline sample, 40 m up the road, by walking the road
  // rather than the tangent: 40 m of tangent leaves a bending carriageway.
  let sample = 0;
  let near = Infinity;
  const count = Math.floor(trunk.points.length / 3);
  for (let i = 0; i < count; i += 1) {
    const reach = Math.hypot(target.x - px(i), target.z - pz(i));
    if (reach < near) {
      near = reach;
      sample = i;
    }
  }
  const spacing = Math.max(0.5, Math.hypot(px(1) - px(0), pz(1) - pz(0)));
  const forward = target.vx * (px(sample + 1) - px(sample)) + target.vz * (pz(sample + 1) - pz(sample)) >= 0 ? 1 : -1;
  const plant = Math.max(1, Math.min(count - 2, sample + forward * Math.round(40 / spacing)));
  /**
   * At the vehicle's own lateral offset from the centreline, not on it.
   *
   * An agent sits at `centreline ± lane`, and the gap law tests `|side| <
   * spec.width/2 + body.radius` — 0.81 m for a xe máy against a person. A lane
   * offset is up to 1.8 m on a 7 m road, so a body standing on the bare
   * centreline is outside the half-lane and the vehicle is right not to brake
   * for it. Measured that way this test reported no braking at all.
   */
  const span0 = Math.hypot(px(sample + 1) - px(sample), pz(sample + 1) - pz(sample)) || 1;
  const tx = ((px(sample + 1) - px(sample)) / span0) * forward;
  const tz = ((pz(sample + 1) - pz(sample)) / span0) * forward;
  const lane = (target.x - px(sample)) * -tz + (target.z - pz(sample)) * tx;
  const pspan = Math.hypot(px(plant + 1) - px(plant), pz(plant + 1) - pz(plant)) || 1;
  const ptx = ((px(plant + 1) - px(plant)) / pspan) * forward;
  const ptz = ((pz(plant + 1) - pz(plant)) / pspan) * forward;
  console.log(`  the vehicle rides ${lane.toFixed(2)} m right of the centreline; the body is planted there too`);
  walker.teleport(px(plant) - ptz * lane, pz(plant) + ptx * lane);
  walker.setJoystick(null);
  for (let n = 0; n < 30; n += 1) walker.update(DELTA, camera);

  let slowest = pace;
  let closest = Infinity;
  for (let frame = 0; frame < 420; frame += 1) {
    elapsed += DELTA;
    fleet.update(elapsed);
    walker.update(DELTA, camera);
    slowest = Math.min(slowest, Math.hypot(target.vx, target.vz));
    closest = Math.min(closest, Math.hypot(target.x - walker.position.x, target.z - walker.position.z));
  }

  console.log(
    `  a vehicle doing ${pace.toFixed(2)} m/s, a person ${Math.hypot(px(plant) - target.x, pz(plant) - target.z).toFixed(0)} m up its lane`
  );
  console.log(`  it slowed to ${slowest.toFixed(2)} m/s and closed to ${closest.toFixed(1)} m`);
  check(
    'the fleet brakes for a person on foot',
    slowest < pace - 0.5,
    `${slowest.toFixed(2)} from ${pace.toFixed(2)} m/s`
  );
  check('and does not reverse to do it', slowest >= 0, `${slowest.toFixed(2)} m/s`);
  walker.dispose();
  fleet.dispose();
}

vehicles.dispose();
console.log(failures ? `\nFAILED — ${failures} check${failures === 1 ? '' : 's'}\n` : '\nOK\n');
if (failures) process.exitCode = 1;
