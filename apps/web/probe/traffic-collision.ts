/**
 * Do vehicles actually hit each other now?
 *
 * The user's report, verbatim: "chưa có xử lí va chạm giữa các vật thể như xe,
 * xe máy". `driving-collision.ts` has had the whole answer for a while and was
 * never called with anything that moves — `walker.ts`'s machine branch resolved
 * against static circles only, so the NPC fleet and the other players were not
 * solid and you drove straight through a coach.
 *
 * `probe/driving-model.ts` already drives the bare model and asserts momentum
 * conservation on body-against-body impacts. What is missing, and what this is,
 * is the same thing **through the walker**, with the world's own collision in the
 * loop: real terrain, a real carriageway, the step gate, the substepping and the
 * positional push all present, because that is where it either works or does not.
 *
 * Two riders are two real walkers, each handed the other as traffic — which is
 * exactly the arrangement `collideDrive` is written for, two clients each
 * resolving their own machine against the other's reported position and velocity.
 * So the momentum residual this prints is a measurement of that claim and not of
 * a convenience.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/traffic-collision.ts
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
/** `SPECS.motorbike.mass`, which is what both riders are on. */
const BIKE_MASS = 165;

/** `walker.floorAt`, transcribed — the same replica `motorbike-ride.ts` uses. */
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
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${claim.padEnd(52)} ${shown}`);
};

// --- the world, built once ----------------------------------------------------
const SLUG = 'hoi-an';
const recipe = LOCATIONS[SLUG];
const terrain = createTerrain(recipe, SEGMENTS);
const plan = planTown(terrain, recipe, 1);
const pois = resolvePois(terrain, recipe, plan.lots);
const net = createRoadNetwork(terrain, recipe, pois, plan.lots);
const floorAt = makeFloorAt(terrain, net.decks);
const vehicles = createVehicles(recipe, net, 16, terrain);

/** The longest sealed road, from one end — `motorbike-ride.ts`'s own choice. */
const trunk = net.roads
  .filter((entry) => entry.kind !== 'trail')
  .reduce((best, entry) => (best && best.totalLength >= entry.totalLength ? best : entry));
const px = (i: number) => trunk.points[i * 3];
const pz = (i: number) => trunk.points[i * 3 + 2];
const headingAt = (i: number) => Math.atan2(px(i + 1) - px(i), pz(i + 1) - pz(i));

console.log(`\nAt ${SLUG}, on the ${trunk.kind} road: ${trunk.totalLength.toFixed(0)} m, flat enough to measure on.`);

/**
 * One rider: a walker, its own camera, its own parked bike, and whatever bodies
 * it is told are traffic. The bike is one of the fleet's own `rideables`, moved
 * to where the rider is wanted — which is what `motorbike-ride.ts` does too.
 */
const rider = (index: number, traffic: () => readonly Impactor[]) => {
  const camera = new PerspectiveCamera(60, 16 / 9, 2, 4000);
  const bike = vehicles.rideables()[index];
  const walker = seeded(() =>
    createWalker(terrain, listener, px(1), pz(1), [], undefined, 0, undefined, {
      water: recipe.water ?? null,
      platforms: net.decks,
      rideables: () => vehicles.rideables(),
      obstacles: { near: () => [] },
      traffic: [traffic],
      reducedMotion: true,
    })
  );

  const mount = (x: number, z: number, heading: number) => {
    bike.position.set(x, floorAt(x, z, Number.POSITIVE_INFINITY), z);
    bike.forward.set(Math.sin(heading), 0, Math.cos(heading));
    walker.teleport(x + bike.forward.x * 1.6, z + bike.forward.z * 1.6);
    walker.setJoystick({ x: 0, y: 0 });
    // The boarding scan runs five times a second, not every frame.
    for (let n = 0; n < 24; n += 1) walker.update(DELTA, camera);
    walker.interact();
    for (let n = 0; n < 3; n += 1) walker.update(DELTA, camera);
    if (!walker.riding()) throw new Error(`rider ${index} could not board`);
  };

  const speed = () => {
    const body = walker.body();
    return Math.hypot(body.vx, body.vz);
  };

  return { walker, camera, bike, mount, speed, step: () => walker.update(DELTA, camera) };
};

/** A body that is not a walker — a coach, a stopped bike — held still or moving. */
const prop = (mass: number, radius: number) => {
  const body = createImpactor();
  body.mass = mass;
  body.radius = radius;
  const put = (x: number, z: number, vx = 0, vz = 0) => {
    body.x = x;
    body.z = z;
    body.vx = vx;
    body.vz = vz;
  };
  return { body, put };
};

const gap = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
/** How far inside the other body the rider ever got. Zero is the whole claim. */
const reach0 = (run: { reach: number; closest: number }) => Math.max(0, run.reach - run.closest);

// =============================================================================
/**
 * The frame the impact happened on, found from the velocity rather than from the
 * geometry.
 *
 * Three geometric detectors were tried and all three were wrong. The centre
 * distance never dips below the sum of the radii, because each client pushes its
 * own machine the whole of the overlap and the step resolves it before anything
 * can observe it; a threshold loose enough to catch a shunt (which settles at
 * 1.33 m against a 0.90 m reach, the striker being pushed out again every frame
 * it holds the throttle) fires a frame or two *before* the impulse, and reported
 * the speed lost to it as −0.01 m/s. The impulse is a step change in velocity,
 * so the honest way to find it is to look for a step change in velocity.
 */
const impactFrame = (velocities: { vx: number; vz: number }[]): number => {
  let at = -1;
  let worst = 0;
  for (let i = 1; i < velocities.length; i += 1) {
    const change = Math.hypot(velocities[i].vx - velocities[i - 1].vx, velocities[i].vz - velocities[i - 1].vz);
    if (change <= worst) continue;
    worst = change;
    at = i;
  }
  // A machine under power changes velocity by at most its own traction in a
  // frame — a Wave makes about 4 m/s², so 0.07 m/s at a 60th of a second. 2 m/s
  // in one frame is an impact and nothing else.
  return worst > 2 ? at : -1;
};

console.log('\n=== two real riders, each resolving its own machine ==========================');
/**
 * The networked claim, with two actual walkers.
 *
 * 80 m apart and steering at each other. 260 m was tried first and is too far:
 * the main road's tightest bend at Hội An is 29 m, two riders left to converge
 * over a quarter of a kilometre of it missed each other and re-engaged at 50°,
 * and the "head-on" then closed at 16.40 m/s rather than at the 38 the two
 * speeds add up to. Eighty metres is about two seconds and they cannot miss.
 */
{
  const SETTLE = 10;
  const snapA = createImpactor();
  const snapB = createImpactor();
  const copy = (into: Impactor, from: Impactor) => {
    into.x = from.x;
    into.z = from.z;
    into.vx = from.vx;
    into.vz = from.vz;
    into.mass = from.mass;
    into.radius = from.radius;
  };

  /**
   * Each rider sees the other as the other was at the top of the frame.
   *
   * Two things made this necessary and both were measured. `Walker.body`
   * rewrites one hoisted `Impactor` and hands it back by reference, so holding
   * the struct and reading its fields later reads whatever the last caller left
   * there — done that way the pair overlapped by 0.61 m and no impulse was
   * detected at all, because each was resolving against a velocity of zero. And
   * calling straight through is worse than it looks: A steps first, takes its
   * impulse and separates the pair by the whole of the overlap, so when B steps
   * there is no overlap left and B is never hit — 9.43 m/s to A and 0.10 to B
   * on the same contact.
   *
   * Neither is what two clients a network apart do. Each of those resolves its
   * own machine against the other's *last reported* state, a snapshot taken
   * before either moved. So that is what this hands them.
   */
  const a = rider(0, () => [snapB]);
  const b = rider(1, () => [snapA]);

  const at = 40;
  const heading = headingAt(at);
  a.mount(px(at) - Math.sin(heading) * 40, pz(at) - Math.cos(heading) * 40, heading);
  b.mount(px(at) + Math.sin(heading) * 40, pz(at) + Math.cos(heading) * 40, heading + Math.PI);

  const aim = (who: ReturnType<typeof rider>, target: { x: number; z: number }) => {
    const wanted = Math.atan2(target.x - who.walker.position.x, target.z - who.walker.position.z);
    const off = Math.atan2(Math.sin(wanted - who.walker.yaw), Math.cos(wanted - who.walker.yaw));
    who.walker.setJoystick({ x: -Math.max(-1, Math.min(1, off * 1.1)), y: 1 });
  };

  const va: { vx: number; vz: number }[] = [];
  const vb: { vx: number; vz: number }[] = [];
  const gaps: number[] = [];
  const FRAMES = 400;
  for (let frame = 0; frame < FRAMES; frame += 1) {
    copy(snapA, a.walker.body());
    copy(snapB, b.walker.body());
    aim(a, b.walker.position);
    aim(b, a.walker.position);
    a.step();
    b.step();
    const pa = a.walker.body();
    const pb = b.walker.body();
    va.push({ vx: pa.vx, vz: pa.vz });
    vb.push({ vx: pb.vx, vz: pb.vz });
    gaps.push(gap(a.walker.position, b.walker.position));
  }

  const reach = a.walker.body().radius + b.walker.body().radius;
  const hit = impactFrame(va);
  const speedOf = (v: { vx: number; vz: number }) => Math.hypot(v.vx, v.vz);
  const momentumAt = (i: number) => Math.hypot((va[i].vx + vb[i].vx) * BIKE_MASS, (va[i].vz + vb[i].vz) * BIKE_MASS);
  const from = Math.max(0, hit - SETTLE);
  const to = Math.min(FRAMES - 1, hit + SETTLE);
  const kickA = Math.hypot(va[hit].vx - va[hit - 1].vx, va[hit].vz - va[hit - 1].vz);
  const kickB = Math.hypot(vb[hit].vx - vb[hit - 1].vx, vb[hit].vz - vb[hit - 1].vz);
  const closing = Math.hypot(va[hit - 1].vx - vb[hit - 1].vx, va[hit - 1].vz - vb[hit - 1].vz);
  // Over the impact and its aftermath, not the whole run: the two go on leaning
  // against each other for seconds afterwards with the throttles still open,
  // and that steady-state grind is a different measurement from the crash.
  const window = gaps.slice(Math.max(0, hit - 5), Math.min(FRAMES, hit + SETTLE + 1));
  const closest = window.reduce((low, value) => Math.min(low, value), Infinity);
  const overlap = Math.max(0, reach - closest);

  console.log(`  impact on frame ${hit}, closing at ${closing.toFixed(2)} m/s; the bodies reach ${reach.toFixed(2)} m`);
  console.log(
    `  closest ${closest.toFixed(2)} m — ${overlap.toFixed(2)} m inside, ${((overlap / reach) * 100).toFixed(0)}% of the reach`
  );
  console.log(
    `  rider A ${speedOf(va[from]).toFixed(2)} → ${speedOf(va[to]).toFixed(2)} m/s, ${kickA.toFixed(2)} in the impulse frame`
  );
  console.log(
    `  rider B ${speedOf(vb[from]).toFixed(2)} → ${speedOf(vb[to]).toFixed(2)} m/s, ${kickB.toFixed(2)} in the impulse frame`
  );
  console.log(
    `  momentum ${momentumAt(hit - 1).toFixed(0)} → ${momentumAt(hit).toFixed(0)} kg·m/s across that frame, ` +
      `${momentumAt(to).toFixed(0)} ten frames on once the tyres have had it`
  );

  check('they make contact at all', hit > 0, `frame ${hit}`);
  check(
    'and separate rather than pass through each other',
    overlap < reach * 0.35,
    `${overlap.toFixed(2)} m of ${reach.toFixed(2)}`
  );
  /**
   * The residual overlap is a frame of approach, not a failure to resolve. Each
   * client's push clears the overlap *its snapshot showed*, and at a 38 m/s
   * closing speed the pair has come another 0.64 m together by the time the push
   * is applied — so about half a frame's worth is left over and is gone the next
   * frame. That is a property of resolving against a snapshot, which is the only
   * version of this that can work over a network.
   */
  check(
    'and the overlap is gone within a few frames',
    gaps[Math.min(FRAMES - 1, hit + 6)] >= reach - 0.02,
    `${gaps[Math.min(FRAMES - 1, hit + 6)].toFixed(2)} m six frames later, against a ${reach.toFixed(2)} m reach`
  );
  check(
    'both lose speed',
    speedOf(va[to]) < speedOf(va[from]) && speedOf(vb[to]) < speedOf(vb[from]),
    `−${(speedOf(va[from]) - speedOf(va[to])).toFixed(2)} and −${(speedOf(vb[from]) - speedOf(vb[to])).toFixed(2)} m/s`
  );
  check(
    'and the impulse is equal and opposite',
    Math.abs(kickA - kickB) < Math.max(1.5, Math.max(kickA, kickB) * 0.2),
    `${kickA.toFixed(2)} against ${kickB.toFixed(2)} m/s — ${Math.abs(kickA - kickB).toFixed(2)} apart`
  );

  a.walker.dispose();
  b.walker.dispose();
}

// =============================================================================
console.log('\n=== a head-on and a shunt do not read alike =================================');
/**
 * The same rider at the same speed into the same body, once oncoming and once
 * receding — so the closing speed is the only thing that differs and it is a
 * number this probe sets rather than one it has to hope for.
 *
 * This is the thing `walker.ts` used to be unable to express at all. The old
 * answer was `rideSpeed *= got / reach`, the share of the intended step that
 * survived, which knows nothing about which way the other thing was going.
 */
{
  const SETTLE = 10;
  /**
   * @param otherSpeed along the rider's own heading, so negative is oncoming.
   * @param gap0 metres between the rider and the body at the start. It has to
   *   differ between the two: an oncoming body closes at the sum of the speeds
   *   and covers 270 m in nine seconds, while a receding one is closed on at the
   *   difference, and starting that one as far away meant the rider never caught
   *   it inside the run at all — twenty seconds at 11 m/s of closing is 220 m.
   */
  const closingRun = (label: string, otherSpeed: number, gap0: number) => {
    // A xe máy's own mass and reach, so the only variable is the velocity.
    const other = prop(165, 0.6675);
    const a = rider(0, () => [other.body]);
    const at = 40;
    const heading = headingAt(at);
    const RUN_UP = 150;
    a.mount(px(at) - Math.sin(heading) * RUN_UP, pz(at) - Math.cos(heading) * RUN_UP, heading);

    a.walker.setJoystick({ x: 0, y: 1 });
    const velocities: { vx: number; vz: number }[] = [];
    const FRAMES = 1200;
    // Driven along the rider's own heading, so a negative speed is oncoming.
    // Started far enough up the road that it arrives at the rider rather than
    // the rider at it, and placed each frame rather than integrated — this is
    // a stand-in for a remote machine, and that is what one is.
    // Measured from the rider's own mount point, which sits `RUN_UP` before the
    // sample the offsets below are taken from.
    let along = gap0;
    for (let frame = 0; frame < FRAMES; frame += 1) {
      along += otherSpeed * DELTA;
      other.put(
        px(at) + Math.sin(heading) * (along - RUN_UP),
        pz(at) + Math.cos(heading) * (along - RUN_UP),
        Math.sin(heading) * otherSpeed,
        Math.cos(heading) * otherSpeed
      );
      a.step();
      const live = a.walker.body();
      velocities.push({ vx: live.vx, vz: live.vz });
    }

    const hit = impactFrame(velocities);
    const speedOf = (i: number) => Math.hypot(velocities[i].vx, velocities[i].vz);
    const kick =
      hit > 0
        ? Math.hypot(velocities[hit].vx - velocities[hit - 1].vx, velocities[hit].vz - velocities[hit - 1].vz)
        : 0;
    const closing = hit > 0 ? speedOf(hit - 1) - otherSpeed : 0;
    console.log(
      `  ${label.padEnd(30)} rider at ${speedOf(Math.max(0, hit - 1)).toFixed(2)} m/s into a body doing ` +
        `${otherSpeed.toFixed(1)}: closing ${closing.toFixed(2)}, impulse ${kick.toFixed(2)} m/s, ` +
        `settled at ${speedOf(Math.min(FRAMES - 1, hit + SETTLE)).toFixed(2)}`
    );
    a.walker.dispose();
    return { hit, kick, closing };
  };

  const headOn = closingRun('head-on, oncoming at 12 m/s', -12, 270);
  const shunt = closingRun('a shunt, the leader at 8 m/s', 8, 90);
  check('both are hit', headOn.hit > 0 && shunt.hit > 0, `frames ${headOn.hit} and ${shunt.hit}`);
  check(
    'the head-on closes faster',
    headOn.closing > shunt.closing * 1.5,
    `${headOn.closing.toFixed(2)} m/s against ${shunt.closing.toFixed(2)}`
  );
  // Both impulses are `(1 + RESTITUTION) * closing / inverse`, so against the
  // same body the ratio of the two is the ratio of the closing speeds.
  check(
    'and costs the rider proportionately more',
    headOn.kick > shunt.kick * 1.5,
    `${headOn.kick.toFixed(2)} m/s against ${shunt.kick.toFixed(2)} — a ratio of ` +
      `${(headOn.kick / Math.max(0.01, shunt.kick)).toFixed(2)} against the closing speeds' ` +
      `${(headOn.closing / Math.max(0.01, shunt.closing)).toFixed(2)}`
  );
}

// =============================================================================
console.log('\n=== a xe máy into a xe khách ================================================');
// `SPECS.coach`: 12,000 kg, 10.5 m long, 2.5 m wide, so `DriveTuning.radius` —
// the mean half-extent — is (10.5 + 2.5)/4 = 3.25 m. Against a xe máy's 0.67.
{
  const SETTLE = 10;
  const measure = (label: string, mass: number, radius: number) => {
    const other = prop(mass, radius);
    const a = rider(0, () => [other.body]);
    const at = 40;
    const heading = headingAt(at);
    // 150 m of run-up, which is about eight seconds and so the whole of the
    // machine's acceleration curve: at 60 m it only reached 6 m/s, and a crash
    // measured at a third of the top speed measures a third of the crash.
    const RUN_UP = 150;
    a.mount(px(at) - Math.sin(heading) * RUN_UP, pz(at) - Math.cos(heading) * RUN_UP, heading);
    // Parked squarely on the centreline, not moving.
    other.put(px(at), pz(at));
    a.walker.setJoystick({ x: 0, y: 1 });

    const velocities: { vx: number; vz: number }[] = [];
    const gaps: number[] = [];
    const FRAMES = 900;
    for (let frame = 0; frame < FRAMES; frame += 1) {
      a.step();
      // Read through `body()` each frame rather than holding the struct it
      // returns: it rewrites one hoisted `Impactor` in place.
      const live = a.walker.body();
      velocities.push({ vx: live.vx, vz: live.vz });
      gaps.push(gap(a.walker.position, other.body));
    }

    const reach = a.walker.body().radius + radius;
    const hit = impactFrame(velocities);
    const speedOf = (i: number) => Math.hypot(velocities[i].vx, velocities[i].vz);
    const from = Math.max(0, hit - SETTLE);
    const to = Math.min(FRAMES - 1, hit + SETTLE);
    /**
     * The one-frame velocity change, which is where the mass split lives.
     *
     * Over any longer window both of these read as a wall and the comparison
     * says nothing: a prop does not move, so a rider holding the throttle
     * overlaps it again on the next frame and is given another impulse, every
     * frame, until it has stopped. Measured over ten frames the 165 kg bike cost
     * 18.55 m/s and the 12 t coach 16.84 — the wrong way round, and entirely an
     * artefact of that. One frame apart, the other body's own inverse mass is
     * the whole of the difference.
     */
    const kick =
      hit > 0
        ? Math.hypot(velocities[hit].vx - velocities[hit - 1].vx, velocities[hit].vz - velocities[hit - 1].vz)
        : 0;
    // Over the impact and its aftermath, not the whole run: afterwards the
    // rider sits against an immovable prop with the throttle still open.
    const window = gaps.slice(Math.max(0, hit - 5), Math.min(FRAMES, hit + SETTLE * 4));
    const closest = window.reduce((low, value) => Math.min(low, value), Infinity);
    // How far it was pushed back out, which is the bounce.
    const bounced = window.reduce((most, value) => Math.max(most, value - closest), 0);

    console.log(
      `  ${label.padEnd(22)} hit at ${speedOf(Math.max(0, hit - 1)).toFixed(2)} m/s; ${kick.toFixed(2)} m/s ` +
        `of it went in the impulse frame, settling at ${speedOf(to).toFixed(2)}\n` +
        `  ${''.padEnd(22)} reach ${reach.toFixed(2)} m, closest ${closest.toFixed(2)}, ` +
        `overlap ${Math.max(0, reach - closest).toFixed(3)}, pushed back out ${bounced.toFixed(2)} m`
    );
    a.walker.dispose();
    return { hit, kick, closest, reach, bounced, before: speedOf(from), after: speedOf(to) };
  };

  const coach = measure('into a 12 t xe khách', 12000, 3.25);
  const bike = measure('into a 165 kg xe máy', 165, 0.67);
  check(
    'both are hit rather than driven through',
    coach.hit > 0 && bike.hit > 0,
    `frames ${coach.hit} and ${bike.hit}`
  );
  check(
    'neither leaves the rider inside the other body',
    reach0(coach) < 0.05 && reach0(bike) < 0.05,
    `${reach0(coach).toFixed(3)} m and ${reach0(bike).toFixed(3)} m of overlap`
  );
  // 12,000 kg against 165 gives the pair an inverse mass 1.4% off the bike's own,
  // so the coach takes essentially the whole impulse and another bike takes half
  // of it. The ratio that falls out is therefore close to two.
  check(
    'the coach costs the rider about twice what a bike does',
    coach.kick > bike.kick * 1.6,
    `${coach.kick.toFixed(2)} m/s against ${bike.kick.toFixed(2)} — a ratio of ${(coach.kick / Math.max(0.01, bike.kick)).toFixed(2)}`
  );
  check(
    'and the rider is the one that bounces',
    coach.bounced > 0.05,
    `${coach.bounced.toFixed(2)} m back off the coach`
  );
}

// =============================================================================
console.log('\n=== and the fleet brakes for somebody in its lane ===========================');
// The other half of the report. An agent's target speed came only off the bend
// and off the agent in front of it, so a bike stopped in the lane was not in the
// calculation at all and a coach drove through it at cruise.
{
  /**
   * Where a vehicle is, in road terms. The fleet publishes world positions, so
   * the lane it is in has to be recovered: the nearest centreline sample, which
   * way along the line it is travelling, and how far to the side it sits.
   *
   * The first attempt planted the rider 34 m along the vehicle's *velocity
   * vector* and measured no braking at all, which was right — the main road's
   * tightest bend at Hội An is 29 m, so 34 m of tangent leaves the carriageway
   * entirely, and the gap law is a lane test. Following the centreline is the
   * only form of this that puts the rider where the vehicle is actually going.
   */
  const onRoad = (body: { x: number; z: number; vx: number; vz: number }) => {
    let road = trunk;
    let sample = 0;
    let near = Infinity;
    for (const entry of net.roads) {
      const count = Math.floor(entry.points.length / 3);
      for (let i = 0; i < count; i += 1) {
        const reach = Math.hypot(body.x - entry.points[i * 3], body.z - entry.points[i * 3 + 2]);
        if (reach >= near) continue;
        near = reach;
        road = entry;
        sample = i;
      }
    }
    const qx = (i: number) => road.points[i * 3];
    const qz = (i: number) => road.points[i * 3 + 2];
    const count = Math.floor(road.points.length / 3);
    const next = Math.min(count - 1, sample + 1);
    const span = Math.hypot(qx(next) - qx(sample), qz(next) - qz(sample)) || 1;
    const tx = (qx(next) - qx(sample)) / span;
    const tz = (qz(next) - qz(sample)) / span;
    // +1 with the centreline, −1 against it, which is the fleet's own `dir`.
    const dir = body.vx * tx + body.vz * tz >= 0 ? 1 : -1;
    // Metres to the right of travel, which is (−fz, fx) on the travel tangent.
    const offX = body.x - qx(sample);
    const offZ = body.z - qz(sample);
    const lane = offX * -(tz * dir) + offZ * (tx * dir);
    return { road, sample, dir, lane, count, qx, qz, off: near };
  };

  /** A point `metres` further along that road in the vehicle's own lane. */
  const ahead = (where: ReturnType<typeof onRoad>, metres: number) => {
    const { road, sample, dir, lane, count, qx, qz } = where;
    const spacing = Math.max(0.5, Math.hypot(qx(1) - qx(0), qz(1) - qz(0)));
    const target = Math.max(1, Math.min(count - 2, sample + dir * Math.round(metres / spacing)));
    const span = Math.hypot(qx(target + 1) - qx(target), qz(target + 1) - qz(target)) || 1;
    const tx = ((qx(target + 1) - qx(target)) / span) * dir;
    const tz = ((qz(target + 1) - qz(target)) / span) * dir;
    return { x: qx(target) - tz * lane, z: qz(target) + tx * lane, heading: Math.atan2(-tx, -tz) };
  };

  const a = rider(0, () => []);

  // A reference fleet, two ticks in, only to choose which vehicle to watch.
  vehicles.update(0);
  vehicles.update(DELTA);
  let target = vehicles.traffic()[0];
  for (const body of vehicles.traffic()) {
    if (Math.hypot(body.vx, body.vz) > Math.hypot(target.vx, target.vz)) target = body;
  }
  const where = onRoad(target);
  const pace = Math.hypot(target.vx, target.vz);
  // Far enough up the road to be outside the gap law at the start — a motorbike
  // wants `6 + speed*0.9`, about 17 m at 12 m/s — and reached well before the end.
  const PLANT = 40;
  const spot = ahead(where, PLANT);

  console.log(
    `  watching a vehicle doing ${pace.toFixed(2)} m/s on the ${where.road.kind} road, ` +
      `${where.lane.toFixed(2)} m right of the centreline (${where.off.toFixed(2)} m off the nearest sample)`
  );

  a.mount(spot.x, spot.z, spot.heading);
  a.walker.setJoystick({ x: 0, y: 0 });
  for (let n = 0; n < 30; n += 1) a.step();
  const planted = Math.hypot(a.walker.position.x - target.x, a.walker.position.z - target.z);
  console.log(`  the rider is stopped ${planted.toFixed(0)} m up that lane at ${a.speed().toFixed(2)} m/s, facing it`);

  /**
   * @param watching whether the fleet is told where the player is.
   *
   * The fleet is rebuilt rather than rewound: `update` takes a monotonic elapsed
   * and every agent's queue position is state, so the control run and the
   * measured run have to start from the same deal of the same seed.
   */
  const trial = (watching: boolean) => {
    const fresh = createVehicles(recipe, net, 16, terrain);
    fresh.watch(watching ? () => a.walker.body() : null);
    let elapsed = 0;
    fresh.update(elapsed);
    let mine = fresh.traffic()[0];
    for (const body of fresh.traffic()) if (gap(body, target) < gap(mine, target)) mine = body;
    const series: number[] = [];
    const gaps: number[] = [];
    for (let frame = 0; frame < 480; frame += 1) {
      elapsed += DELTA;
      fresh.update(elapsed);
      series.push(Math.hypot(mine.vx, mine.vz));
      gaps.push(gap(mine, a.walker.position));
    }
    fresh.dispose();
    return { series, gaps };
  };

  const control = trial(false);
  const braked = trial(true);
  const lowest = (series: number[]) => series.reduce((low, value) => Math.min(low, value), Infinity);

  console.log(
    `  unwatched: ${control.series[0].toFixed(2)} → ${control.series[control.series.length - 1].toFixed(2)} m/s, ` +
      `slowest ${lowest(control.series).toFixed(2)}, closed to ${lowest(control.gaps).toFixed(1)} m`
  );
  console.log(
    `  watched:   ${braked.series[0].toFixed(2)} → ${braked.series[braked.series.length - 1].toFixed(2)} m/s, ` +
      `slowest ${lowest(braked.series).toFixed(2)}, closed to ${lowest(braked.gaps).toFixed(1)} m`
  );
  check(
    'the vehicle got near enough for the gap law to apply',
    lowest(braked.gaps) < 30,
    `closed to ${lowest(braked.gaps).toFixed(1)} m`
  );
  check(
    'and it slows for a rider stopped in its lane',
    lowest(braked.series) < lowest(control.series) - 0.5,
    `${lowest(braked.series).toFixed(2)} m/s against ${lowest(control.series).toFixed(2)} unwatched`
  );
  check(
    'braking rather than stopping dead or reversing',
    lowest(braked.series) >= 0,
    `${lowest(braked.series).toFixed(2)} m/s, never negative`
  );

  /**
   * And on foot, which is why `Vehicles.watch` takes a body rather than a ride.
   *
   * A coach driving through somebody standing in the lane is the same bug as a
   * coach driving through somebody on a bike; braking for one and not the other
   * would have fixed the symptom the user happened to name. `Walker.body` reports
   * the shoulders and 75 kg on foot and the machine's own box astride one, so the
   * gap law gets a radius either way and nothing needs a special case.
   */
  a.walker.interact();
  // And put back in the lane. Swinging off a machine stands the rider
  // `DISMOUNT_STEP` — 1.1 m — to its left, which is outside the half-lane the
  // gap law tests: measured, the fleet correctly did *not* brake for a person
  // standing 1.1 m to the side of its path, and the first version of this check
  // read that as the on-foot case being unhandled.
  a.walker.teleport(spot.x, spot.z);
  for (let n = 0; n < 30; n += 1) a.step();
  const onFoot = a.walker.body();
  console.log(
    `  the same rider, now off the bike: riding=${a.walker.riding()}, ` +
      `radius ${onFoot.radius.toFixed(2)} m against ${BIKE_MASS} kg of machine's 0.67, mass ${onFoot.mass} kg`
  );
  const walking = trial(true);
  console.log(
    `  on foot:   ${walking.series[0].toFixed(2)} → ${walking.series[walking.series.length - 1].toFixed(2)} m/s, ` +
      `slowest ${lowest(walking.series).toFixed(2)}, closed to ${lowest(walking.gaps).toFixed(1)} m`
  );
  check(
    'it slows for somebody on foot in the lane too',
    lowest(walking.series) < lowest(control.series) - 0.5,
    `${lowest(walking.series).toFixed(2)} m/s against ${lowest(control.series).toFixed(2)} unwatched`
  );

  a.walker.dispose();
}

vehicles.dispose();
console.log(failures ? `\nFAILED — ${failures} check${failures === 1 ? '' : 's'}\n` : '\nOK\n');
if (failures) process.exitCode = 1;
