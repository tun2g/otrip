/**
 * Where the 8.33 m single-frame camera move at Tà Xùa comes from.
 *
 * `probe/motorbike-ride.ts` reports the number and does not decompose it. The
 * rig puts the lens at `pivot − line·orbit + eyeLift`, so a one-frame
 * translation is one of exactly four things: the body moved, the pivot snapped
 * to it, the view direction turned, or `orbit` changed. This measures all four
 * on the frame it happens, and the answer is the fourth.
 *
 * Measured, riding Tà Xùa's trunk road at 19.61 m/s, frame 1857 → 1858:
 *
 *   the body moved         0.332 m
 *   the rig's length went  8.45 m → 0.74 m   (−7.71 m)
 *   the view yaw turned    0.000°
 *   the lens was clearing  5.94 m of ground → 0.41 m
 *
 * So it is `orbit = Math.min(orbit, standoff)` in `walker.ts` — the ground
 * clamp, which is deliberately *not* eased, on the stated grounds that "a
 * hillside does not pass by in five frames and holding two metres out against
 * one puts the lens inside it". The clamp did its job: the lens ended 0.41 m
 * clear of a surface that had risen 3.46 m across the rig line in one frame.
 *
 * It is **not** the first-person fallback, which was the standing hypothesis.
 * `eyeLift` is `(headHeight − pivotHeight) × …`, at most 1.35 − 1.04 = 0.31 m on
 * a saddle; `FIRST_PERSON_AFTER` only ever holds the rig *out*, and `orbit`'s
 * own approach is eased at `TUCK_IN`. Nothing on that path can move a camera
 * eight metres.
 *
 * Two further numbers, which are the reason this file was kept rather than
 * deleted once the question was answered:
 *
 *   - it is 2 frames of 2340, and 26 move the lens more than half a metre. Hội
 *     An, over the same distance at a higher speed, has none at all. This is one
 *     kind of ground, not a camera that lurches everywhere.
 *   - but the lens spends 271 frames of 2340 — 11.6% of a Tà Xùa ride — inside
 *     the two metres the body cannot be drawn in. `walker.ts` records the same
 *     share for the Tà Xùa *walk* as 0.6%. Riding the same ground is twenty
 *     times worse, because the rig trails 8.5 m behind a body going twenty times
 *     faster into terrain the sweep can only see 8.5 m of.
 *
 * Which was as far as this file could see, and it named the mover rather than
 * the cause. `orbit = Math.min(orbit, standoff)` is what moved the lens, but the
 * reason the surface "had risen 3.46 m across the rig line in one frame" is that
 * the rig line was falling: `PIVOT_RISE` is a quarter-second follower on the
 * pivot's height, and at 34 m/s up a Tà Xùa gradient it lags further below the
 * body than the pivot stands above its feet, so the orbit centre itself goes
 * underground and the clamp obediently draws the lens in towards it.
 * `probe/lens-ground.ts` has that measurement and `PIVOT_SINK` in `walker.ts` is
 * the cap it argued for. With it, on this probe's own ride:
 *
 *   - the worst single-frame camera move 8.07 m → 4.51 m at Tà Xùa, and
 *     8.61 m → 0.93 m at Hội An, where the machine now reaches 55 m/s.
 *   - the worst swing of the body across the frame 58.42° → 16.00° and
 *     58.05° → 1.75°. The Hội An frame is a 0.03° dolly along the rig line.
 *   - frames inside the two metres the body cannot be drawn in: 140 → 5 at Tà
 *     Xùa and 4 → 0 at Hội An. 140 is what this probe read immediately before
 *     the cap went in; the 271 above was read off an earlier `walker.ts` and
 *     something between the two states had already halved it.
 *
 * Then `RIDE_FOLLOW` landed — the view coming round to the machine's nose — and
 * moved these again, in the direction nobody expected of a feature whose whole
 * job is to turn the camera. Tà Xùa's worst single-frame move 4.51 m → 0.82 m,
 * its worst swing 16.00° → 2.41°, and its last five frames inside the two metres
 * to none at all; Hội An's worst swing 1.75° → 1.01°.
 *
 * The reason is this probe's own subject. It steers along the trunk road, and
 * before the follower the lens stayed pointed at the bearing the machine was
 * boarded on while the road bent away underneath it — so the rig trailed
 * *across* the hillside, where the ground is what the sweep has to shorten for.
 * Pointed along the nose it trails back down the road instead, which is the one
 * direction at Tà Xùa guaranteed to be clear. A camera aimed where the vehicle
 * is going has less to collide with, and that is most of what these two
 * measurements have been about all evening.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/camera-jump.ts
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

for (const slug of ['ta-xua', 'hoi-an']) {
  const recipe = LOCATIONS[slug];
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

  const camera = new PerspectiveCamera(60, 16 / 9, 2, 4000);
  const walker = seeded(() =>
    createWalker(terrain, listener, spawn.x, spawn.z, [], undefined, 0, undefined, {
      water: recipe.water ?? null,
      platforms: net.decks,
      rideables: () => vehicles.rideables(),
      obstacles: { near: () => [] },
      reducedMotion: true,
    })
  );

  const bikes = vehicles.rideables();
  const bike = bikes[0];
  const run = (seconds: number, stick: { x: number; y: number }, each?: (n: number) => void) => {
    walker.setJoystick(stick);
    for (let n = 0; n < Math.round(seconds * 60); n += 1) {
      walker.update(DELTA, camera);
      each?.(n);
    }
  };

  const trunk = net.roads
    .filter((entry) => entry.kind !== 'trail')
    .reduce((best, entry) => (best && best.totalLength >= entry.totalLength ? best : entry));
  const headingAlong = (entry: Road, i: number) =>
    Math.atan2(
      entry.points[(i + 1) * 3] - entry.points[i * 3],
      entry.points[(i + 1) * 3 + 2] - entry.points[i * 3 + 2]
    );

  const at = 1;
  const x = trunk.points[at * 3];
  const z = trunk.points[at * 3 + 2];
  const heading = headingAlong(trunk, at);
  bike.position.set(x, floorAt(x, z, Number.POSITIVE_INFINITY), z);
  bike.forward.set(Math.sin(heading), 0, Math.cos(heading));
  walker.teleport(x + bike.forward.x * 1.6, z + bike.forward.z * 1.6);
  run(0.35, { x: 0, y: 0 });
  walker.interact();
  run(0.05, { x: 0, y: 0 });
  if (!walker.riding()) {
    console.log(`${slug}: could not board`);
    continue;
  }

  const count = Math.floor(trunk.points.length / 3);
  const px = (i: number) => trunk.points[i * 3];
  const pz = (i: number) => trunk.points[i * 3 + 2];
  const spacing = Math.max(0.5, Math.hypot(px(1) - px(0), pz(1) - pz(0)));
  let sample = at;
  let done = false;

  type Shot = {
    n: number;
    cam: [number, number, number];
    pos: [number, number, number];
    /** |camera − body|, which is the rig's own length plus the pivot's lag. */
    rig: number;
    /** The surface under the lens, and how far the lens clears it. */
    under: number;
    clear: number;
    speed: number;
    yaw: number;
  };
  let was: Shot | null = null;
  let worst = 0;
  /** The two frames either side of the worst move. A one-slot array, because
   *  `let` assigned inside the callback loses its narrowing at the print below. */
  const worstPair: { before: Shot; after: Shot }[] = [];
  let frames = 0;
  /**
   * How many frames moved the lens more than this *multiple of what the body
   * moved* in the same frame.
   *
   * Fixed metres, which is what this counted first, stopped meaning anything
   * once the machine got fast: at 50 m/s a sixtieth of a second is 0.84 m of
   * honest travel, so "frames over 0.5 m" went from 26 to 1,857 of 2,340 at Hội
   * An without a single one of them being uncommanded. A camera that trails a
   * body rigidly moves exactly as far as the body does, so the excess over that
   * is the whole of what there is to complain about.
   */
  const bands = [2, 4, 8, 16];
  const over = bands.map(() => 0);
  let hidden = 0;
  /** The most the camera→body direction turned in one frame, degrees. */
  let swung = 0;

  run(40, { x: 0, y: 1 }, (n) => {
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
        walker.setJoystick({ x: -Math.max(-1, Math.min(1, wrap(wanted - walker.yaw) * 1.1)), y: 1 });
      }
    }

    const floor = floorAt(camera.position.x, camera.position.z, walker.position.y);
    const now: Shot = {
      n,
      cam: [camera.position.x, camera.position.y, camera.position.z],
      pos: [walker.position.x, walker.position.y, walker.position.z],
      rig: Math.hypot(
        camera.position.x - walker.position.x,
        camera.position.y - walker.position.y,
        camera.position.z - walker.position.z
      ),
      under: floor,
      clear: camera.position.y - floor,
      speed: was ? Math.hypot(walker.position.x - was.pos[0], walker.position.z - was.pos[2]) / DELTA : 0,
      yaw: walker.viewYaw,
    };
    if (n >= 60 && was) {
      const move = Math.hypot(now.cam[0] - was.cam[0], now.cam[1] - was.cam[1], now.cam[2] - was.cam[2]);
      if (move > worst) {
        worst = move;
        worstPair[0] = { before: was, after: now };
      }
      const travelled = Math.hypot(now.pos[0] - was.pos[0], now.pos[1] - was.pos[1], now.pos[2] - was.pos[2]);
      // Against a floor, so a standing body does not make every band infinite.
      const excess = move / Math.max(0.02, travelled);
      for (let b = 0; b < bands.length; b += 1) if (excess > bands[b]) over[b] += 1;
      if (now.rig < 2) hidden += 1;

      // Along the rig line or across it. A dolly leaves the body exactly where
      // it was in the frame; a swing is the motion that makes somebody ill.
      const look = (shot: Shot) => {
        const dx = shot.pos[0] - shot.cam[0];
        const dy = shot.pos[1] - shot.cam[1];
        const dz = shot.pos[2] - shot.cam[2];
        const span = Math.hypot(dx, dy, dz) || 1;
        return [dx / span, dy / span, dz / span];
      };
      const a = look(was);
      const b = look(now);
      swung = Math.max(
        swung,
        (Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI
      );
      frames += 1;
    }
    was = now;
  });

  console.log(`\n================ ${slug} ================`);
  console.log(`  ${frames} frames measured, worst single-frame camera move ${worst.toFixed(2)} m`);
  if (worstPair.length > 0) {
    const { before, after } = worstPair[0];
    const body = Math.hypot(after.pos[0] - before.pos[0], after.pos[1] - before.pos[1], after.pos[2] - before.pos[2]);
    console.log(`  frame ${before.n} → ${after.n}`);
    console.log(`    the body moved         ${body.toFixed(3)} m (${after.speed.toFixed(2)} m/s)`);
    console.log(
      `    the rig's length went  ${before.rig.toFixed(2)} m → ${after.rig.toFixed(2)} m  (Δ ${(after.rig - before.rig).toFixed(2)} m)`
    );
    console.log(`    the view yaw turned    ${(Math.abs(wrap(after.yaw - before.yaw)) * 57.2958).toFixed(3)}°`);
    console.log(`    the lens was clearing  ${before.clear.toFixed(2)} m of ground → ${after.clear.toFixed(2)} m`);
    console.log(`    camera y               ${before.cam[1].toFixed(2)} → ${after.cam[1].toFixed(2)}`);
    console.log(`    body y                 ${before.pos[1].toFixed(2)} → ${after.pos[1].toFixed(2)}`);
    console.log(`    surface under the lens ${before.under.toFixed(2)} → ${after.under.toFixed(2)}`);
    const look = (shot: Shot) => {
      const dx = shot.pos[0] - shot.cam[0];
      const dy = shot.pos[1] - shot.cam[1];
      const dz = shot.pos[2] - shot.cam[2];
      const span = Math.hypot(dx, dy, dz) || 1;
      return [dx / span, dy / span, dz / span];
    };
    const a = look(before);
    const b = look(after);
    const turn = (Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
    console.log(
      `    the body in the frame  moved ${turn.toFixed(2)}° — ${turn < 2 ? 'a dolly along the rig line' : 'a swing across it'}`
    );
  }
  console.log(
    `  frames the lens moved over ${bands.map((band, i) => `${band}x the body: ${over[i]}`).join(', ')} ` +
      `— worst swing of the body in the frame ${swung.toFixed(2)}°`
  );
  console.log(`  frames with the lens inside the 2 m the body cannot be drawn in: ${hidden} of ${frames}`);

  vehicles.dispose();
  walker.dispose();
}
