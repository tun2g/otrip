/**
 * Is there a first-person view from the saddle, and is it worth having?
 *
 * The user: "lái xe có cả góc nhìn thứ 3 thứ nhất nữa nha, chứ nhìn mỗi nhân
 * vật không thì hơi chán" — riding wants both views, because staring at the
 * character is dull.
 *
 * Three separate questions, and they have different answers:
 *
 *   1. does V work astride a machine at all
 *   2. where does the first-person camera actually sit, against where the rider
 *      whose eyes it is supposed to be is drawn
 *   3. what of the machine can be seen from there
 *
 * The third is the one that decides whether the view is worth having, and it is
 * answered by the near plane rather than by anything in `walker.ts`: the whole
 * machine sits between 0.8 and 1.6 m from the rider's eyes, and the scene's near
 * plane is 2 m. So this measures those distances off the built rig rather than
 * taking them from the build source, and prints them against the plane.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/ride-view.ts
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Object3D as Node } from 'three';

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
const { Box3, PerspectiveCamera, Vector3 } = await import('three');
const { resolvePois } = await import('../src/scene/points-of-interest.ts');
const { createRoadNetwork } = await import('../src/scene/road-network.ts');
const { planTown } = await import('../src/scene/town-plan.ts');
const { createVehicles } = await import('../src/scene/vehicles.ts');
const { createWalker } = await import('../src/scene/walker.ts');
const { createVehicleKit } = await import('../src/scene/vehicle-kit.ts');
const { motorbikeBuild } = await import('../src/scene/vehicle-builds.ts');
const { COCKPIT_LAYER } = await import('../src/scene/vehicle-kit.ts');

type Terrain = ReturnType<typeof createTerrain>;
type Network = ReturnType<typeof createRoadNetwork>;
type Platform = Network['decks'][number];

const SEGMENTS = 416;
const DELTA = 1 / 60;
const STEP_UP = 0.4;
/** The world camera's own, which the cockpit pass exists because of. */
const NEAR_PLANE = 2;
/** `world-renderer.COCKPIT_NEAR`, the second pass's. */
const COCKPIT_NEAR = 0.15;
/**
 * The eye height the walker will use on foot *here*.
 *
 * `walker.ts` takes it as `human ? EYE_HEIGHT : PERSON_HEIGHT * 0.9`, and this
 * probe passes no `humanSource` because the rig is a GLB and there is no fetch
 * out here — so the body on foot is the stylised fallback at 2.8 m and its eye
 * is 2.52, not the rigged model's 1.64. Worth writing down rather than asserting
 * 1.64 and calling the difference a bug, which is what the first run of this did.
 *
 * Astride a machine it does not apply at all: `headHeight` is `SADDLE_EYE`
 * whichever body the walker has, because the figure in the saddle is the
 * machine's own and is the same size either way.
 */
const FALLBACK_EYE = 2.8 * 0.9;

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
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${claim.padEnd(48)} ${shown}`);
};

// =============================================================================
console.log('\n=== where the machine is, measured off the rig it draws =====================');
/**
 * Off the assembled rig and not off the build source, because the assembler is
 * what rebases every part list into the frame of the node that carries it — the
 * bars are given in vehicle coordinates and hung off `steer` at the front axle,
 * so reading the build's own numbers would miss that shift entirely.
 */
const eyeOf = (() => {
  const kit = createVehicleKit();
  let state = 1;
  const roll = () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
  const rig = kit.assemble('motorbike', motorbikeBuild('#b23a2e', false, roll, true));
  rig.group.updateMatrixWorld(true);

  const spanOf = (node: Node | null) => {
    if (!node) return null;
    const box = new Box3().setFromObject(node);
    return box.isEmpty() ? null : box;
  };

  const rider = spanOf(rig.rider);
  const steer = spanOf(rig.steer);
  const front = spanOf(rig.frontAxle);
  const whole = spanOf(rig.group)!;

  // The seated figure's eyes: `seatedRider` puts a 0.1 m sphere scaled 1.14 in Y
  // at the head, so the top of the rider's box is the crown and the eyes sit
  // about a radius below it.
  const crown = rider ? rider.max.y : 0;
  const eyes = crown - 0.1;
  console.log(`  the whole machine spans y ${whole.min.y.toFixed(2)} to ${whole.max.y.toFixed(2)} m`);
  console.log(`  the seated rider's crown is at y ${crown.toFixed(2)}, so its eyes are about ${eyes.toFixed(2)} m`);

  const from = new Vector3(0, eyes, rider ? (rider.min.z + rider.max.z) / 2 : 0);
  const reach = (box: InstanceType<typeof Box3> | null) => {
    if (!box) return Number.NaN;
    // Nearest point of the box to the eye point, which is what a near plane cuts.
    const near = new Vector3(
      Math.max(box.min.x, Math.min(from.x, box.max.x)),
      Math.max(box.min.y, Math.min(from.y, box.max.y)),
      Math.max(box.min.z, Math.min(from.z, box.max.z))
    );
    return near.distanceTo(from);
  };

  const rows: [string, number][] = [
    ['the bars, mirrors and fork', reach(steer)],
    ['the front wheel', reach(front)],
    ['the rider you are inside', reach(rider)],
    ['the nearest of the whole machine', reach(whole)],
  ];
  console.log(`\n  from those eyes, the nearest point of each, against a ${NEAR_PLANE} m near plane:`);
  for (const [what, span] of rows) {
    console.log(
      `    ${what.padEnd(34)} ${span.toFixed(2)} m   ${span < NEAR_PLANE ? 'INSIDE — not drawn' : 'visible'}`
    );
  }
  /**
   * Reported rather than asserted, because it is not a statement about
   * `walker.ts`.
   *
   * Nothing of the machine clears a 2 m near plane from the saddle — the bars
   * are 0.30 m from the rider's eyes and the front wheel 1.26 m — so "the bars
   * in frame" is decided by `world-renderer.ts:575`, which builds the one camera
   * the scene has. A probe that failed on it would be red for ever on somebody
   * else's decision, and a probe that stayed quiet about it would let a
   * first-person ride ship with an empty screen. So it prints what each
   * candidate plane would buy, and the assertion is only that this probe is
   * measuring against the plane the renderer actually uses.
   */
  const atWorld = rows.filter(([, span]) => span >= NEAR_PLANE).length;
  const atCockpit = rows.filter(([what, span]) => span >= COCKPIT_NEAR && what !== 'the rider you are inside').length;
  console.log(`\n  at the world's ${NEAR_PLANE} m plane:   ${atWorld} of ${rows.length} visible`);
  console.log(
    `  at the cockpit's ${COCKPIT_NEAR} m plane: ${atCockpit} of ${rows.length - 1} visible (the rider is hidden, not clipped)`
  );
  check(
    'the cockpit pass can see the bars',
    rows.find(([what]) => what === 'the bars, mirrors and fork')![1] >= COCKPIT_NEAR,
    `${rows.find(([what]) => what === 'the bars, mirrors and fork')![1].toFixed(2)} m against a ${COCKPIT_NEAR} m plane`
  );
  check(
    'and the world pass still cannot, which is why there are two',
    atWorld === 0,
    `${atWorld} of ${rows.length} at ${NEAR_PLANE} m`
  );
  console.log(
    `    — a global ${COCKPIT_NEAR} m plane would take the depth buffer from about 3 cm of\n` +
      '      resolution at a kilometre to 40 cm and z-fight on distant terrain, which is\n' +
      '      why the cockpit is a second pass with the depth cleared in front of it.'
  );

  kit.dispose();
  return eyes;
})();

// =============================================================================
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

const camera = new PerspectiveCamera(60, 16 / 9, NEAR_PLANE, 4000);
const bike = vehicles.rideables()[0];
const walker = seeded(() =>
  createWalker(terrain, listener, px(1), pz(1), [], undefined, 0, undefined, {
    water: recipe.water ?? null,
    platforms: net.decks,
    rideables: () => vehicles.rideables(),
    reducedMotion: true,
  })
);

/**
 * What the walker last said the view was. A one-slot array rather than a `let`,
 * because it is only ever written inside the callback and TypeScript then
 * narrows the variable to its initial value at every comparison below.
 */
const seen: ('first' | 'third')[] = ['third'];
walker.onViewChange((next) => {
  seen[0] = next;
});

const run = (seconds: number, stick: { x: number; y: number } | null, each?: (n: number) => void) => {
  walker.setJoystick(stick);
  for (let n = 0; n < Math.round(seconds * 60); n += 1) {
    walker.update(DELTA, camera);
    each?.(n);
  }
};

const mount = (at: number) => {
  const heading = headingAt(at);
  bike.position.set(px(at), floorAt(px(at), pz(at), Number.POSITIVE_INFINITY), pz(at));
  bike.forward.set(Math.sin(heading), 0, Math.cos(heading));
  walker.teleport(px(at) + bike.forward.x * 1.6, pz(at) + bike.forward.z * 1.6);
  run(0.35, { x: 0, y: 0 });
  walker.interact();
  run(0.05, { x: 0, y: 0 });
  if (!walker.riding()) throw new Error('could not board');
};

/** Metres the lens sits over the body's own feet. */
const lens = () => camera.position.y - walker.position.y;

/**
 * Radians the horizon is tilted by, from the camera's own right vector.
 *
 * Not `camera.rotation.z`, which is what this probe tried first and which
 * reported 180.00° on a level camera: `lookAt` writes a quaternion and the Euler
 * decomposition of it puts most of a downward-looking rig's rotation in Z. The
 * roll is a property of where screen-right points, and screen-right on a level
 * camera is horizontal — so `asin` of its vertical component is the whole of it.
 */
const horizonRoll = () => {
  const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  return Math.asin(Math.max(-1, Math.min(1, right.y)));
};

console.log('\n=== V astride a machine ====================================================');
mount(1);
run(1.5, { x: 0, y: 0 });
{
  const third = lens();
  walker.setView('first');
  run(1.5, { x: 0, y: 0 });
  const first = lens();
  check('the view switches while riding', seen[0] === 'first', `onViewChange said "${seen[0]}"`);
  check(
    'and the lens comes down to one height',
    Math.abs(first - third) > 0.01,
    `${third.toFixed(2)} → ${first.toFixed(2)} m`
  );
  console.log(`  third person: the lens sits ${third.toFixed(2)} m over the wheels`);
  console.log(`  first person: ${first.toFixed(2)} m, against the drawn rider's eyes at ${eyeOf.toFixed(2)} m`);
  check(
    'it is at the eyes of the rider it is supposed to be',
    Math.abs(first - eyeOf) < 0.1,
    `${Math.abs(first - eyeOf).toFixed(2)} m out`
  );

  walker.setView('third');
  run(1.5, { x: 0, y: 0 });
  check('and back again', seen[0] === 'third' && Math.abs(lens() - third) < 0.2, `${lens().toFixed(2)} m`);
}

console.log('\n=== the view survives getting on and off ===================================');
{
  walker.setView('first');
  run(0.5, { x: 0, y: 0 });
  walker.interact();
  run(0.6, { x: 0, y: 0 });
  check(
    'off the bike, still first person',
    !walker.riding() && seen[0] === 'first',
    `riding=${walker.riding()}, view=${seen[0]}`
  );
  // Printed over several settles, because the pivot chases the body's own eased
  // height at `PIVOT_RISE` and a dismount moves the body sideways and down at
  // once: read one frame after stepping off it is still somewhere between the
  // saddle it left and the ground it landed on.
  const settle: string[] = [];
  for (const wait of [0, 0.5, 1, 2]) {
    run(wait, { x: 0, y: 0 });
    settle.push(`${wait === 0 ? 'at once' : `${wait.toFixed(1)}s`} ${lens().toFixed(2)}`);
  }
  console.log(
    `  on foot in first person the lens settles: ${settle.join(', ')} m, against this body's own ` +
      `${FALLBACK_EYE.toFixed(2)} m eye (1.64 once the rigged model is loaded)`
  );
  // Decomposed, because 2.52 m is not a height a standing body has: if the rig
  // is at zero distance the lens is straight above the feet, so a horizontal
  // offset means `orbit` never reached zero and the extra height is the rig
  // still being behind the shoulder rather than the eye height being wrong.
  const behind = Math.hypot(camera.position.x - walker.position.x, camera.position.z - walker.position.z);
  console.log(
    `    camera y ${camera.position.y.toFixed(2)}, body y ${walker.position.y.toFixed(2)}, ` +
      `floor under the body ${floorAt(walker.position.x, walker.position.z, Number.POSITIVE_INFINITY).toFixed(2)}, ` +
      `rig ${behind.toFixed(2)} m behind the body`
  );
  check(
    "and ends up at this body's own eye height",
    Math.abs(lens() - FALLBACK_EYE) < 0.05,
    `${lens().toFixed(2)} m of ${FALLBACK_EYE.toFixed(2)}`
  );
  mount(1);
  run(0.6, { x: 0, y: 0 });
  check(
    'back on, still first person',
    walker.riding() && seen[0] === 'first',
    `riding=${walker.riding()}, view=${seen[0]}`
  );

  walker.setView('third');
  run(0.5, { x: 0, y: 0 });
  walker.interact();
  run(0.6, { x: 0, y: 0 });
  check('and third person survives it too', !walker.riding() && seen[0] === 'third', `view=${seen[0]}`);
}

console.log('\n=== uncommanded camera movement, both views =================================');
/**
 * The number that caught the 8.33 m jump at Tà Xùa. The character's place in the
 * frame is not the question from the saddle, but a camera that moves when nobody
 * asked it to still is — and it is the whole of what the dizziness complaint is
 * about.
 */
{
  const ride = (label: string, which: 'first' | 'third') => {
    mount(1);
    walker.setView(which);
    run(0.5, { x: 0, y: 0 });

    const count = Math.floor(trunk.points.length / 3);
    const spacing = Math.max(0.5, Math.hypot(px(1) - px(0), pz(1) - pz(0)));
    let sample = 1;
    let done = false;
    let was = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    let worst = 0;
    let worstRoll = 0;
    let trail = 0;
    let frames = 0;
    // The tilt of the horizon, which is the motion the comfort setting exists to
    // keep off it.
    let wasRoll = horizonRoll();

    run(30, { x: 0, y: 1 }, (n) => {
      if (!done) {
        let gap = Infinity;
        for (let i = Math.max(0, sample - 4); i < Math.min(count, sample + 40); i += 1) {
          const reach = Math.hypot(walker.position.x - px(i), walker.position.z - pz(i));
          if (reach < gap) {
            gap = reach;
            sample = i;
          }
        }
        if (sample >= count - 2) {
          done = true;
          walker.setJoystick({ x: 0, y: 0 });
        } else {
          const aim = Math.min(count - 1, sample + Math.ceil(15 / spacing));
          const wanted = Math.atan2(px(aim) - walker.position.x, pz(aim) - walker.position.z);
          const off = Math.atan2(Math.sin(wanted - walker.yaw), Math.cos(wanted - walker.yaw));
          walker.setJoystick({ x: -Math.max(-1, Math.min(1, off * 1.1)), y: 1 });
        }
      }
      // The first second is the rig converging on a body that was teleported in.
      if (n < 60) {
        was = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
        wasRoll = horizonRoll();
        return;
      }
      worst = Math.max(
        worst,
        Math.hypot(camera.position.x - was.x, camera.position.y - was.y, camera.position.z - was.z)
      );
      worstRoll = Math.max(worstRoll, Math.abs(horizonRoll() - wasRoll));
      trail += Math.hypot(
        camera.position.x - walker.position.x,
        camera.position.y - walker.position.y,
        camera.position.z - walker.position.z
      );
      was = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
      wasRoll = horizonRoll();
      frames += 1;
    });

    console.log(
      `  ${label.padEnd(26)} worst single-frame move ${worst.toFixed(2)} m, worst roll change ` +
        `${((worstRoll * 180) / Math.PI).toFixed(3)}°, trailing ${(trail / Math.max(1, frames)).toFixed(2)} m`
    );
    walker.setJoystick(null);
    return { worst, worstRoll };
  };

  const third = ride('third person', 'third');
  const first = ride('first person', 'first');
  check(
    'first person never translates more than a frame of travel',
    first.worst < 1,
    `${first.worst.toFixed(2)} m against the 0.42 m a rider covers in a frame at 25 m/s`
  );
  check(
    'and the horizon stays level with camera motion off',
    first.worstRoll < 1e-9,
    `${((first.worstRoll * 180) / Math.PI).toFixed(4)}° of roll`
  );
  console.log(`  third person's worst was ${third.worst.toFixed(2)} m, for comparison`);
}

console.log('\n=== the cockpit layer, and the figure you would be inside ===================');
/**
 * The two halves of the cockpit pass that can be checked without a GL context.
 *
 * `COCKPIT_LAYER` is what the second pass draws, so exactly one machine may be
 * on it — the one being ridden — and it has to come off again when the rider
 * gets off, or a bike left at the kerb goes on being drawn in front of the next
 * rider's face. And the seated figure has to disappear from its own eyes.
 */
{
  const bikes = vehicles.rideables();
  /** Every rig in the fleet's group that is on the cockpit layer. */
  const onLayer = () => {
    const found: string[] = [];
    vehicles.group.traverse((node) => {
      if (node.layers.isEnabled(COCKPIT_LAYER) && node.parent === vehicles.group) found.push(node.name);
    });
    return found;
  };
  /** The seated figure on a rideable's rig: the node with meshes under it. */
  const riderOf = (at: { x: number; y: number; z: number }) => {
    let rig: Node | null = null;
    let near = Infinity;
    for (const child of vehicles.group.children) {
      const reach = Math.hypot(child.position.x - at.x, child.position.z - at.z);
      if (reach < near) {
        near = reach;
        rig = child;
      }
    }
    if (!rig) return null;
    for (const child of rig.children) {
      if (child.type !== 'Object3D') continue;
      let meshes = 0;
      child.traverse((node) => {
        if ((node as { isMesh?: boolean }).isMesh) meshes += 1;
      });
      // The rider is the only bare Object3D carrying geometry that is not an
      // axle: the axles sit at the spec's own axle offsets along Z.
      if (meshes > 0 && Math.abs(child.position.z) < 0.5 && child.position.y === 0) return child;
    }
    return null;
  };

  // Off whatever the sections above left the rider on: the layer is state on the
  // rig, so "at rest" has to be arranged rather than assumed.
  if (walker.riding()) {
    walker.setJoystick(null);
    walker.interact();
    run(0.5, { x: 0, y: 0 });
  }
  check('nothing is on the cockpit layer at rest', onLayer().length === 0, `${onLayer().length} rigs`);

  mount(1);
  run(0.3, { x: 0, y: 0 });
  check('exactly one machine goes on it when ridden', onLayer().length === 1, `${onLayer().length} rigs`);
  check('and it is a parked xe máy, the one taken', onLayer()[0] === 'motorbike-parked', `"${onLayer()[0]}"`);

  const rider = riderOf({ x: walker.position.x, y: walker.position.y, z: walker.position.z });
  check('the rig has a seated figure to hide', rider !== null, rider ? rider.type : 'not found');
  if (rider) {
    walker.setView('third');
    run(0.3, { x: 0, y: 0 });
    check('drawn in third person', rider.visible, String(rider.visible));
    walker.setView('first');
    run(0.3, { x: 0, y: 0 });
    check('and gone from its own eyes', !rider.visible, String(rider.visible));
    walker.setView('third');
    run(0.3, { x: 0, y: 0 });
    check('and back when the view goes out again', rider.visible, String(rider.visible));
  }

  walker.setJoystick(null);
  walker.interact();
  run(0.5, { x: 0, y: 0 });
  check('it comes off the layer when parked', onLayer().length === 0, `${onLayer().length} rigs`);
  check('and the figure is put away with it', rider !== null && !rider.visible, String(rider?.visible));
  void bikes;
}

console.log('\n=== and with camera motion on ==============================================');
{
  walker.setCameraMotion(true);
  mount(1);
  walker.setView('first');
  run(0.5, { x: 0, y: 0 });
  // Full lock at speed, which is where a bike is leant over hardest.
  run(3, { x: 0, y: 1 });
  let worstRoll = 0;
  run(4, { x: 1, y: 1 }, () => {
    worstRoll = Math.max(worstRoll, Math.abs(horizonRoll()));
  });
  console.log(`  first person, motion on: ${((worstRoll * 180) / Math.PI).toFixed(2)}° of roll at full lock`);
  check(
    'the machine leaning is carried to the horizon',
    worstRoll > 0.01,
    `${((worstRoll * 180) / Math.PI).toFixed(2)}°`
  );
  walker.setCameraMotion(false);
}

walker.dispose();
vehicles.dispose();
console.log(failures ? `\nFAILED — ${failures} check${failures === 1 ? '' : 's'}\n` : '\nOK\n');
if (failures) process.exitCode = 1;
