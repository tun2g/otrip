/**
 * Is a companion on a bike drawn on a bike?
 *
 * The bug this answers is the one the user has reported three times as
 * "multiplayer is not working". `RemotePlayer` has carried `riding`, `heading`
 * and `speed` for a while and nothing drew any of them, so a friend doing 20 m/s
 * was rendered as a jogger covering 20 m/s — feet driven through the run clip at
 * `MAX_CLIP_RATE` by the distance they were measured to have moved. You could
 * see somebody's legs sprinting along a road at 73 km/h.
 *
 * So this boots `avatars` with a riding companion and measures the four things
 * that have to be true: the walking body is hidden, a vehicle rig is shown, it
 * is pointed at the room's `heading` and not at the rider's view yaw, and its
 * wheels turn at the room's `speed` rather than at the easing's output. Then it
 * checks what the rigs cost — they must all exist before anybody mounts — and
 * that `dispose` lets go of every geometry and every material.
 *
 * No terrain and no model: `createAvatars` needs a canvas it is allowed to fail
 * to get a context from, and `createVehicleKit` needs nothing at all.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/avatar-ride.ts
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Types statically, values through the dynamic imports below: the three.js
// classes have to be loaded after `window` is stubbed, and a type import is
// erased before it can run anything.
import type { Mesh as MeshNode, Object3D as Node } from 'three';

import type { RemotePlayer } from '../src/scene/avatars.ts';

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

/** As `probe/avatar-sync.ts` stubs it: the 2D context comes back null, which
 *  `paintLabel` is written to survive, so the label is still placed and sized. */
const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
globals.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
globals.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({ width: 0, height: 0, getContext: () => null }),
};

const { Mesh } = await import('three');
const { createAvatars } = await import('../src/scene/avatars.ts');
const { createAvatarRides } = await import('../src/scene/avatar-ride.ts');
const { createVehicleKit } = await import('../src/scene/vehicle-kit.ts');

let failures = 0;
const check = (claim: string, got: unknown, want: unknown, tolerance = 0) => {
  const ok = typeof got === 'number' && typeof want === 'number' ? Math.abs(got - want) <= tolerance : got === want;
  if (!ok) failures += 1;
  const shown = typeof got === 'number' ? got.toFixed(4) : String(got);
  const wanted = typeof want === 'number' ? want.toFixed(4) : String(want);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${claim.padEnd(58)} ${shown}${ok ? '' : `  (wanted ${wanted})`}`);
};

const player = (fields: Partial<RemotePlayer>): RemotePlayer =>
  ({
    id: 'friend',
    name: 'Bình',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    heading: 0,
    riding: '',
    speed: 0,
    racing: false,
    lap: 0,
    check: 0,
    bestMs: 0,
    finishedMs: 0,
    ...fields,
  }) as RemotePlayer;

/** Everything in a subtree that is actually drawn, and what it is drawn with. */
const drawn = (root: Node) => {
  const meshes: MeshNode[] = [];
  const geometries = new Set<object>();
  const materials = new Set<object>();
  root.traverse((node: Node) => {
    if (!(node instanceof Mesh)) return;
    meshes.push(node);
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      materials.add(material);
    }
  });
  // Visibility is inherited, so a hidden parent hides the mesh under it.
  const shown = meshes.filter((mesh) => {
    let node: Node | null = mesh;
    while (node) {
      if (!node.visible) return false;
      node = node.parent;
    }
    return true;
  });
  return { meshes, shown, geometries, materials };
};

const kit = createVehicleKit();
const rides = createAvatarRides(kit);
const avatars = createAvatars(undefined, rides);

/**
 * The avatars, and only the avatars. `rides.group` is added to the scene beside
 * this one and not inside it, so that one child here still means one player —
 * which is the invariant `probe/avatar-sync.ts` reads `children.length` against.
 */
const people = () => avatars.group.children;
const machines = () => rides.group.children.filter((node) => node.visible);

console.log('\n--- the rigs exist before anybody mounts -------------------------------');
{
  // The hard requirement: a room holds eight and all eight machines are built
  // when the scene is. The frame somebody mounts on must not be the frame that
  // merges ninety parts of geometry or compiles a shader.
  check('machines assembled up front', rides.group.children.length, 8);
  check('none of them drawn yet', machines().length, 0);
  check('and none of them in among the bodies', people().length, 0);
  const built = drawn(rides.group);
  check('one merged body per machine, nothing instanced', built.geometries.size >= 8, true);
  // The whole point of borrowing the kit rather than building a second set.
  check('and every one of them shares the kit materials', built.materials.size <= 5, true);
  console.log(
    `       ${built.meshes.length} meshes over ${built.geometries.size} geometries and ` +
      `${built.materials.size} materials, 0 shown`
  );
}

console.log('\n--- a companion on foot is a body, as before ---------------------------');
avatars.sync([player({ x: 10, y: 0, z: 0, yaw: 1.2 })]);
avatars.update(1 / 60, { x: 0, z: 0 });
{
  const body = people()[0];
  check('a walking body is shown', drawn(body).shown.length > 0, true);
  check('and no machine with it', machines().length, 0);
}

console.log('\n--- the same companion, now riding ------------------------------------');
// 20 m/s on a heading of 1.0 rad while looking somewhere else entirely, which is
// the case the two yaws exist for: a rider on a left-hander has their head down
// the exit of the bend the machine is still pointed into.
const HEADING = 1;
const SPEED = 20;
const VIEW = 2.4;
avatars.sync([player({ x: 10, y: 0, z: 0, yaw: VIEW, heading: HEADING, speed: SPEED, riding: 'motorbike' })]);
avatars.update(1 / 60, { x: 0, z: 0 });
{
  const body = people()[0];
  check('the walking body is hidden', drawn(body).shown.length, 0);
  // Not removed — the label is a child of the same group and has to survive, or
  // a companion on a bike becomes a companion you cannot find.
  const label = body.children.find((node) => node.type === 'Sprite');
  check('the name label survives it', label?.visible, true);

  const shown = machines();
  check('exactly one machine is drawn', shown.length, 1);
  const machine = shown[0];
  check('it is a motorbike', machine.name.startsWith('avatar-motorbike'), true);
  check('drawn where the body was eased to, x', machine.position.x, body.position.x, 1e-9);
  check('                                   z', machine.position.z, body.position.z, 1e-9);
  check("pointed at the room's heading", machine.rotation.y, HEADING, 1e-9);
  check('which is not the view yaw', Math.abs(machine.rotation.y - VIEW) > 1, true);
  check("the rider's own body still carries the view yaw", body.rotation.y !== HEADING, true);
  const rider = machine.children.find((node) => node.type === 'Object3D' && drawn(node).meshes.length > 0);
  check("and the machine's own seated figure is on it", rider !== undefined && rider.visible, true);
}

console.log('\n--- the wheels turn at the speed the room sent -------------------------');
{
  const machine = machines()[0];
  // The rear axle is the first child the assembler adds after the two bodywork
  // meshes, at the spec's own rear-axle Z.
  const axle = machine.children.find((node) => node.type === 'Object3D' && node.position.z < -0.5)!;
  const was = axle.rotation.x;
  const DELTA = 1 / 60;
  avatars.update(DELTA, { x: 0, z: 0 });
  const turned = axle.rotation.x - was;
  // 17-inch wheel, 0.215 m radius, from `SPECS.motorbike`. 20 m/s over a 60th of
  // a second is 0.333 m of road, which is 1.550 rad of wheel.
  const wanted = (SPEED * DELTA) / 0.215;
  check('rad of wheel per frame at 20 m/s', turned, wanted, 1e-6);
  console.log(`       ${turned.toFixed(4)} rad = ${(SPEED * DELTA).toFixed(3)} m of road on a 0.215 m wheel`);

  // And the one the brief asked about: a companion whose packets stop arriving
  // has a measured ground speed of nothing, but the machine was still doing 20.
  // Easing cannot see that and `speed` can, which is why the wheel reads it.
  const parked = people()[0];
  for (let frame = 0; frame < 30; frame += 1) avatars.update(DELTA, { x: 0, z: 0 });
  const stalled = axle.rotation.x;
  avatars.update(DELTA, { x: 0, z: 0 });
  check('still turning once the position has stopped moving', axle.rotation.x - stalled, wanted, 1e-6);
  console.log(
    `       the body has not moved for half a second (${parked.position.x.toFixed(3)} m) and the wheel has not stopped`
  );
}

console.log('\n--- leaning into the bend --------------------------------------------');
{
  const DELTA = 1 / 60;
  /** Holds a steady yaw rate for two seconds and reports the lean it settles at. */
  const leanAt = (rate: number, speed: number) => {
    let heading = HEADING;
    for (let frame = 0; frame < 120; frame += 1) {
      heading += rate * DELTA;
      avatars.sync([player({ x: 10, y: 0, z: 0, yaw: VIEW, heading, speed, riding: 'motorbike' })]);
      avatars.update(DELTA, { x: 0, z: 0 });
    }
    return (-machines()[0].rotation.z * 180) / Math.PI;
  };

  // 0.3 rad/s at 20 m/s is 6 m/s² of lateral, which the Wave's tyres can make
  // (their limit is 0.963 g), so this is the unclamped arithmetic: a two-wheeler
  // leans at exactly atan(lateral/g).
  const easy = leanAt(0.3, SPEED);
  check('degrees of lean at 0.3 rad/s and 20 m/s', easy, 31.4, 0.6);
  console.log(`       ${easy.toFixed(1)}° — atan(20 × 0.3 / 9.81) is 31.4°`);
  check(
    'and the bars are turned into it',
    machines()[0].children.some((node) => Math.abs(node.rotation.y) > 0.01),
    true
  );

  // And past the limit. 1.5 rad/s at 20 m/s is 30 m/s², three times what these
  // tyres hold — a product of two numbers off the network that no real machine
  // could have produced — and it has to clamp at the lean the tyres can make
  // rather than lie the bike flat on the road at 72°.
  const hard = leanAt(1.5, SPEED);
  check('clamped at the tyres own limit past it', hard, 43.9, 0.6);
  console.log(`       ${hard.toFixed(1)}° at 30 m/s² of lateral — atan(mu) on a Wave is 43.9°, atan(30/9.81) is 71.9°`);

  // Standing still there is nothing to lean against, whatever the heading does.
  const still = leanAt(1, 0);
  check('upright at a standstill', still, 0, 1e-9);
}

console.log('\n--- stepping off puts the body back ----------------------------------');
avatars.sync([player({ x: 10, y: 0, z: 0, yaw: VIEW, heading: HEADING, speed: 0, riding: '' })]);
avatars.update(1 / 60, { x: 0, z: 0 });
{
  const body = people()[0];
  check('the walking body is shown again', drawn(body).shown.length > 0, true);
  check('and the machine is gone', machines().length, 0);
  check('with its seat handed back', rides.traffic().length, 0);
}

console.log('\n--- eight seats, and a ninth rider keeps their legs -------------------');
{
  const room = [];
  for (let n = 0; n < 9; n += 1) {
    room.push(
      player({ id: `rider-${n}`, name: `Người ${n}`, x: n * 6, z: 0, heading: 0, speed: 8, riding: 'motorbike' })
    );
  }
  avatars.sync(room);
  avatars.update(1 / 60, { x: 0, z: 0 });
  check('machines drawn for a room of nine', machines().length, 8);
  const bodies = people().filter((node) => drawn(node).shown.length > 0);
  check('and the ninth is still a walking body', bodies.length, 1);
  check('all eight are bodies traffic can hit', rides.traffic().length, 8);
  console.log(
    `       the ninth rider at x ${bodies[0].position.x.toFixed(0)} m is drawn on foot rather than not at all`
  );
}

console.log('\n--- an unknown kind falls back rather than failing --------------------');
{
  avatars.sync([player({ id: 'boatman', x: 4, z: 4, riding: 'thuyen', speed: 2 })]);
  avatars.update(1 / 60, { x: 0, z: 0 });
  const body = people()[0];
  check('a kind this cannot draw keeps its walking body', drawn(body).shown.length > 0, true);
  check('and claims no machine', machines().length, 0);
}

console.log('\n--- dispose lets go of everything ------------------------------------');
{
  const before = drawn(rides.group);
  const geometries = [...before.geometries] as { dispose: () => void; attributes?: unknown }[];
  const materials = [...before.materials] as { dispose: () => void }[];
  let releasedGeometries = 0;
  let releasedMaterials = 0;
  for (const geometry of geometries) {
    const real = geometry.dispose.bind(geometry);
    geometry.dispose = () => {
      releasedGeometries += 1;
      real();
    };
  }
  for (const material of materials) {
    const real = material.dispose.bind(material);
    material.dispose = () => {
      releasedMaterials += 1;
      real();
    };
  }

  avatars.dispose();
  // The kit is the fleet's and is disposed with it, which is the whole of what
  // `avatar-ride.dispose` does *not* do: it hands back the scene graph and
  // leaves the shared geometry and the shared shaders to their owner.
  check('the machines are off the scene graph', rides.group.children.length, 0);
  check('their geometries not yet released', releasedGeometries, 0);
  kit.dispose();
  check('the kit releases every geometry it merged', releasedGeometries, geometries.length);
  check('and every material these rigs are drawn with', releasedMaterials, materials.length);
  console.log(`       ${releasedGeometries} geometries and ${releasedMaterials} materials`);
}

console.log(failures ? `\nFAILED — ${failures} check${failures === 1 ? '' : 's'}\n` : '\nOK\n');
if (failures) process.exitCode = 1;
