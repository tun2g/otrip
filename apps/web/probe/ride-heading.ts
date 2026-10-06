/**
 * Does the view follow the machine's nose, and does it hold still when the nose
 * does?
 *
 * The player's complaint: "khi lái xe thì góc nhìn nên đổi theo cái đầu xe chứ,
 * chứ vừa lái mà vừa rê chuột để đổi góc nhìn quá là khó" — when riding, the view
 * should turn with the machine's nose; steering and dragging the mouse at the
 * same time is too hard. At the 55 m/s these machines now reach it is not
 * something a person can do at all.
 *
 * The two numbers are opposed and both have to be right, which is the whole
 * reason this file exists rather than a single reading:
 *
 *   1. **the lag**, degrees between where the lens points and where the machine
 *      points, with a steering input held and no mouse at all. Large means the
 *      rider is still being asked to mouse-follow their own corner.
 *   2. **the drift**, degrees of camera rotation per frame while holding a
 *      *straight* line. This one must stay near zero. A camera that turns when
 *      the machine is not turning is the uncommanded motion the whole comfort
 *      pass was about, and buying the steering fix with it would be a trade and
 *      not a fix.
 *
 * Turning the bars is a command, so following it is not uncommanded motion —
 * but only exactly as far as the bars actually turned. The drift number is what
 * keeps that distinction honest, and it is reported next to the machine's own
 * per-frame heading change, because a follower cannot be blamed for transmitting
 * a heading that is itself jittering.
 *
 * Three more cases, because a view that only follows is as bad as one that never
 * does:
 *
 *   - **the flick**: 90° of mouse, then nothing. The view has to come back, and
 *     the rate it comes back at is a pan the player did not ask for the shape of,
 *     so its peak is reported in degrees a second.
 *   - **the drag**: the mouse held against the follower. Riding through a place
 *     and looking at it is most of why the bike is here; if the follower wins
 *     this, the feature has eaten the camera.
 *   - **paddling**: stopped, bars hard over. Somebody standing at a kerb looking
 *     around must not have the view taken off them.
 *
 * Every case is run in third person and again from the saddle, because the rig
 * lags in one and not the other.
 *
 * Measured at Hồ Tây, which is the usable bench for this: flat, with 900 m of
 * rideable ground straight ahead, so every case holds its speed for the whole
 * eight seconds. Tà Xùa is run too and most of its cases stall — a straight line
 * held at steer zero there meets ground the machine refuses within a couple of
 * hundred metres — which is itself the right reading, because at a standstill the
 * follower correctly does almost nothing.
 *
 * Third person, before `RIDE_FOLLOW` and after:
 *
 *   - straight, no mouse, 55 m/s: 0.0000°/frame median, 0.000° worst, 0.0°/s
 *     peak, 0.0° turned in all — **identical** either way. The comfort number is
 *     not what paid for this.
 *   - a corner held at 55 m/s: 55.4° of lag → 2.9°. At a part throttle, where
 *     the same bars swing the nose round four times as fast: 133.4° → 13.9°.
 *   - 90° of mouse then let go: the view never came back; now 1.85 s, at a peak
 *     of 68.8°/s, which is `RIDE_FOLLOW_SWEEP` to the decimal.
 *   - the mouse held at 60°/s for four seconds: 240.0° asked, 240.0° delivered.
 *   - stopped with the bars hard over: the nose swings 0.939°/frame and the lens
 *     turns 9.5° in six seconds.
 *
 * From the saddle the lag is half of each of those — 1.4° and 6.9° — which is
 * `RIDE_FOLLOW_EYES`, and deliberate: the lens there is the rider's head.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/ride-heading.ts
 *   … probe/ride-heading.ts --only=ho-tay
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { PerspectiveCamera as Lens } from 'three';

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

type Bus = {
  addEventListener: (type: string, handler: (event: never) => void) => void;
  removeEventListener: (type: string, handler: (event: never) => void) => void;
  emit: (type: string, event: unknown) => void;
};

const createBus = (extra: Record<string, unknown> = {}): Bus & Record<string, unknown> => {
  const handlers = new Map<string, Set<(event: never) => void>>();
  return {
    ...extra,
    addEventListener: (type, handler) => {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
    },
    removeEventListener: (type, handler) => handlers.get(type)?.delete(handler),
    emit: (type, event) => {
      for (const handler of [...(handlers.get(type) ?? [])]) handler(event as never);
    },
  };
};

const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
const windowBus = createBus({ devicePixelRatio: 1 });
globals.window = windowBus;
const documentBus = createBus({ pointerLockElement: null, exitPointerLock: () => {} });
globals.document = documentBus;

const { createTerrain, LOCATIONS, LOCATION_SLUGS } = await import('@otrip/world');
const { PerspectiveCamera, Vector3 } = await import('three');
const { createRoadNetwork } = await import('../src/scene/road-network.ts');
const { createVehicles } = await import('../src/scene/vehicles.ts');
const { planTown } = await import('../src/scene/town-plan.ts');
const { resolvePois } = await import('../src/scene/points-of-interest.ts');
const { createWalker } = await import('../src/scene/walker.ts');

type Terrain = ReturnType<typeof createTerrain>;
type Walker = ReturnType<typeof createWalker>;

const argument = (name: string, fallback: string): string => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const only = argument('only', '');

const SEGMENTS = 416;
const DELTA = 1 / 60;
const STEP_UP = 0.4;
/** Radians per pixel the walker turns at, copied from `walker.ts`. */
const BASE_SENSITIVITY = 0.0022;
/** Seconds of throttle before anything is read, so the machine is at its pace. */
const SPOOL = 8;

const DEGREES = 180 / Math.PI;
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const fixed = (value: number, places = 2): string => (Number.isFinite(value) ? value.toFixed(places) : '—');

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

const canvasBus = createBus({ setPointerCapture: () => {}, requestPointerLock: () => {} });
const listener = canvasBus as unknown as HTMLElement;
/** Per walker, not per run: `walker.ts` binds the lock handler at construction. */
const grabPointer = () => {
  documentBus.pointerLockElement = listener;
  documentBus.emit('pointerlockchange', {});
};

/** Mouse travel in pixels for a wanted turn in radians, at the player's own rate. */
const turnBy = (radians: number) =>
  windowBus.emit('mousemove', { movementX: -radians / BASE_SENSITIVITY, movementY: 0 });

const makeFloorAt = (terrain: Terrain, platforms: ReturnType<typeof createRoadNetwork>['decks']) => {
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
 * Where the lens actually points, in world yaw.
 *
 * Read off the quaternion `lookAt` wrote rather than off `walker.viewYaw`, so
 * the number is the picture and not the intention — anything the rig does to the
 * camera after the aim is in here too. `viewYaw` is read alongside it and the
 * disagreement is printed, which is what says the reading can be trusted.
 */
const aim = new Vector3();
const lensYaw = (camera: Lens): number => {
  aim.set(0, 0, -1).applyQuaternion(camera.quaternion);
  return Math.atan2(aim.x, aim.z);
};

type Case = {
  label: string;
  /** Degrees between the lens and the nose, averaged over the last second. */
  lag: number;
  /** The worst that difference ever got, degrees. */
  worstLag: number;
  /** Degrees the lens turned per frame, worst and median, over the measured run. */
  worstTurn: number;
  medianTurn: number;
  /** And the machine's own heading, so a jittering nose is not blamed on the rig. */
  worstNose: number;
  /** Degrees a second the lens turned at its fastest. */
  peakRate: number;
  /**
   * Degrees the lens turned in total over the window, summed frame by frame.
   *
   * Not the angle between where it started and where it finished, which is what
   * this was first: that wraps at 180°, so four seconds of dragging at 60°/s —
   * 240° of hand — reported 120° and read as the follower having eaten half of
   * it. Summing never wraps and is the number the drag case is about.
   */
  swept: number;
  /** Seconds until the lens was within `SETTLED` of the nose, or NaN. */
  settledIn: number;
  /** Median m/s over the measured window, not the speed it finished at. */
  speed: number;
  /** Seconds of that window, so a case that ran out of road says so. */
  measured: number;
  /** How far `viewYaw` and the lens disagreed about the yaw, degrees. */
  disagree: number;
};

/** Degrees the lens counts as back on the nose. */
const SETTLED = 5;

const median = (values: number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Runs the machine under a held input and reports what the lens did.
 *
 * Collected per frame and reduced afterwards rather than accumulated live,
 * because the window that means anything is not known until the run is over: a
 * straight line held at steer zero rides off the carriageway and sooner or
 * later meets water or a gradient the machine refuses, and the frames after
 * that are a parked bike. Reducing at the end lets the window be "while it was
 * actually riding" — from `measureFrom`, and only while the speed is still
 * within half of the fastest this run managed.
 *
 * Without it, a case that drowned in Hồ Tây reported a lag of 0.0° and a drift
 * of 0.000°/frame and looked like a pass.
 */
const drive = (
  walker: Walker,
  camera: Lens,
  label: string,
  seconds: number,
  stick: { x: number; y: number },
  measureFrom: number,
  mouse?: (frame: number) => boolean,
  /**
   * The stick held during the spool-up, before measurement starts. Straight by
   * default, and that matters: held from the first frame instead, a cornering
   * case spends eight seconds turning at a speed too low for the follower to
   * answer and the lag it reports is the one it accumulated getting up to speed.
   * Measured that way, a hard corner read 129.7° of lag where the steady state
   * is a third of it.
   */
  spoolStick: { x: number; y: number } = { x: 0, y: 1 },
  /** Gate the window to the frames the machine was *not* moving, for paddling. */
  slow = false
): Case => {
  const frames = Math.round(seconds * 60);
  type Sample = { turn: number; nosed: number; lag: number; speed: number; handed: boolean; frame: number };
  const samples: Sample[] = [];

  walker.setJoystick(spoolStick);
  let wasLens = lensYaw(camera);
  let wasNose = walker.yaw;
  let disagree = 0;

  for (let frame = 0; frame < frames; frame += 1) {
    // Whether the probe's own hand moved this frame. The rotation statistics
    // skip those frames, because a flick injected by this file is not the rig
    // turning the view and would otherwise be reported as a 5,400°/s pan.
    const handed = mouse?.(frame) ?? false;
    if (frame === measureFrom) walker.setJoystick(stick);
    walker.update(DELTA, camera);

    const lens = lensYaw(camera);
    const nose = walker.yaw;
    disagree = Math.max(disagree, Math.abs(wrap(walker.viewYaw - lens)) * DEGREES);
    if (frame >= measureFrom) {
      samples.push({
        turn: Math.abs(wrap(lens - wasLens)) * DEGREES,
        nosed: Math.abs(wrap(nose - wasNose)) * DEGREES,
        lag: Math.abs(wrap(nose - lens)) * DEGREES,
        speed: Math.abs(walker.telemetry()?.speed ?? 0),
        handed,
        frame,
      });
    }
    wasLens = lens;
    wasNose = nose;
  }

  const peak = samples.reduce((best, sample) => Math.max(best, sample.speed), 0);
  // Riding cases are judged on the frames they were still at speed; the paddling
  // case is judged on the frames it was not, because a machine rolling away down
  // a gradient is not somebody standing at a kerb looking around.
  const floor = peak > 2 ? peak * 0.5 : -1;
  const live = samples.filter((sample) => (slow ? sample.speed <= 1 : sample.speed >= floor));
  const held = live.filter((sample) => !sample.handed);
  const tail = live.slice(-60);

  const out: Case = {
    label,
    lag: tail.length > 0 ? tail.reduce((sum, sample) => sum + sample.lag, 0) / tail.length : Number.NaN,
    worstLag: live.reduce((worst, sample) => Math.max(worst, sample.lag), 0),
    worstTurn: held.reduce((worst, sample) => Math.max(worst, sample.turn), 0),
    medianTurn: median(held.map((sample) => sample.turn)),
    worstNose: live.reduce((worst, sample) => Math.max(worst, sample.nosed), 0),
    peakRate: held.reduce((worst, sample) => Math.max(worst, sample.turn / DELTA), 0),
    swept: live.reduce((sum, sample) => sum + sample.turn, 0),
    settledIn: Number.NaN,
    speed: median(live.map((sample) => sample.speed)),
    measured: live.length / 60,
    disagree,
  };
  const first = live.length > 0 ? live[0].frame : 0;
  for (const sample of live) {
    if (sample.lag <= SETTLED) {
      out.settledIn = (sample.frame - first) * DELTA;
      break;
    }
  }
  return out;
};

const report = (entry: Case) => {
  console.log(
    `    ${entry.label.padEnd(26)} ${fixed(entry.speed, 1).padStart(5)} m/s over ${fixed(entry.measured, 1).padStart(
      4
    )} s · lag ${fixed(entry.lag, 1).padStart(6)}° (worst ${fixed(entry.worstLag, 1)}°) · lens turned ${fixed(entry.medianTurn, 4)}°/frame median, ${fixed(
      entry.worstTurn,
      3
    )}° worst, peak ${fixed(entry.peakRate, 1)}°/s · the nose turned ${fixed(
      entry.worstNose,
      3
    )}°/frame worst · turned ${fixed(entry.swept, 1)}° in all${
      Number.isNaN(entry.settledIn) ? '' : ` · back on the nose in ${fixed(entry.settledIn, 2)} s`
    }`
  );
};

const probe = (slug: string) => {
  const recipe = LOCATIONS[slug];
  if (!recipe) {
    console.error(`Không có location ${slug}`);
    return;
  }

  const terrain = createTerrain(recipe, SEGMENTS);
  const plan = planTown(terrain, recipe, 1);
  const pois = resolvePois(terrain, recipe, plan.lots);
  const net = createRoadNetwork(terrain, recipe, pois, plan.lots);
  const vehicles = createVehicles(recipe, net, 16, terrain);
  const floorAt = makeFloorAt(terrain, net.decks);

  const trunk = net.roads
    .filter((entry) => entry.kind !== 'trail')
    .reduce(
      (best, entry) => (best && best.totalLength >= entry.totalLength ? best : entry),
      null as (typeof net.roads)[number] | null
    );
  if (!trunk) {
    console.log(`\n=== ${slug}: no made road, nothing to ride ===`);
    vehicles.dispose();
    return;
  }

  /**
   * A start with a long straight run ahead of it.
   *
   * The drift case has to hold a genuinely straight line, which means steer zero
   * and so no road to follow — whatever is ahead of the nose is what the machine
   * gets. Picking the road's flattest sample and hoping, which is what this did
   * first, put the machine into Hồ Tây: it rode off the carriageway, `ridable`
   * refused the water, and three of the six cases were measured at 0.0 m/s
   * while reporting a lag of 0.0° as though the rig had passed.
   *
   * So each sample's own tangent is marched instead, and the one with the
   * longest rideable run wins. Rideable here is the ground the machine's own
   * tests allow: out of the water and under a gradient it will take.
   */
  const count = Math.floor(trunk.points.length / 3);
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const RUN_STEP = 6;
  const RUN_WANTED = 900;
  let at = 1;
  let longest = -1;
  let gentlest = Infinity;
  for (let i = 1; i < count - 2; i += 1) {
    const x = trunk.points[i * 3];
    const z = trunk.points[i * 3 + 2];
    const bearing = Math.atan2(trunk.points[(i + 1) * 3] - x, trunk.points[(i + 1) * 3 + 2] - z);
    let clear = 0;
    while (clear < RUN_WANTED) {
      const ahead = clear + RUN_STEP;
      const px = x + Math.sin(bearing) * ahead;
      const pz = z + Math.cos(bearing) * ahead;
      if (Math.abs(px) > terrain.size / 2 - 40 || Math.abs(pz) > terrain.size / 2 - 40) break;
      if (terrain.heightAt(px, pz) <= waterLevel + 1) break;
      if (terrain.slopeAt(px, pz) > 0.5) break;
      clear = ahead;
    }
    // The longest run wins, and among runs that are long enough the flattest
    // start does — because the paddling case has to begin genuinely stopped, and
    // on the 0.386 gradient the first version of this picked, the machine simply
    // rolled away down it and there was nothing stationary left to measure.
    const slope = terrain.slopeAt(x, z);
    const enough = clear >= RUN_WANTED && longest >= RUN_WANTED;
    if (enough ? slope < gentlest : clear > longest) {
      longest = clear;
      gentlest = slope;
      at = i;
    }
  }
  const roadX = trunk.points[at * 3];
  const roadZ = trunk.points[at * 3 + 2];
  const heading = Math.atan2(trunk.points[(at + 1) * 3] - roadX, trunk.points[(at + 1) * 3 + 2] - roadZ);
  const flattest = terrain.slopeAt(roadX, roadZ);
  const machine = vehicles.rideables()[0];
  if (!machine) {
    console.log(`\n=== ${slug}: no machine parked, nothing to ride ===`);
    vehicles.dispose();
    return;
  }

  console.log(
    `\n=== ${slug} · starting at ${fixed(roadX, 1)},${fixed(roadZ, 1)} on a gradient of ${fixed(
      flattest,
      3
    )}, with ${longest} m of rideable ground straight ahead ===`
  );

  /**
   * A walker astride the machine, built fresh for each case.
   *
   * One walker cannot be re-pointed between cases, because the only way to move
   * it is `teleport` and `teleport` parks the machine and clears `drive` — the
   * first version of this probe did exactly that and measured six cases of a
   * body on foot, every one of them at 0.0 m/s.
   */
  const boarded = (view: 'first' | 'third'): { walker: Walker; camera: Lens } | null => {
    const camera = new PerspectiveCamera(52, 16 / 9, 2, 40_000) as Lens;
    const walker = seeded(() =>
      createWalker(terrain, listener, roadX, roadZ, [], undefined, heading, undefined, {
        water: recipe.water ?? null,
        platforms: net.decks,
        rideables: () => vehicles.rideables(),
        obstacles: { near: () => [] },
        reducedMotion: true,
      })
    );
    grabPointer();
    walker.setView(view);

    machine.position.set(roadX, floorAt(roadX, roadZ, Number.POSITIVE_INFINITY), roadZ);
    machine.forward.set(Math.sin(heading), 0, Math.cos(heading));
    walker.teleport(roadX + machine.forward.x * 1.6, roadZ + machine.forward.z * 1.6);
    walker.setJoystick({ x: 0, y: 0 });
    for (let frame = 0; frame < 24; frame += 1) walker.update(DELTA, camera);
    walker.interact();
    for (let frame = 0; frame < 6; frame += 1) walker.update(DELTA, camera);
    if (!walker.riding()) {
      walker.dispose();
      return null;
    }
    // The view starts where the machine is pointed, so a case measures what the
    // rig does with the input and not its arrival from the spawn bearing.
    turnBy(wrap(heading - walker.viewYaw));
    return { walker, camera };
  };

  const spool = Math.round(SPOOL * 60);

  for (const view of ['third', 'first'] as const) {
    console.log(`  ${view} person`);

    type Plan = {
      name: string;
      seconds: number;
      stick: { x: number; y: number };
      from: number;
      mouse?: (frame: number) => boolean;
      spool?: { x: number; y: number };
      slow?: boolean;
    };

    const plans: Plan[] = [
      // The straight line first: it is the number that must stay near zero.
      { name: 'straight, no mouse', seconds: SPOOL + 8, stick: { x: 0, y: 1 }, from: spool },
      { name: 'gentle corner held', seconds: SPOOL + 8, stick: { x: 0.35, y: 1 }, from: spool },
      { name: 'hard corner held', seconds: SPOOL + 8, stick: { x: 1, y: 1 }, from: spool },
      // Ninety degrees of mouse, then nothing: the view has to come back.
      {
        name: 'flick 90°, then let go',
        seconds: SPOOL + 8,
        stick: { x: 0, y: 1 },
        from: spool,
        // Over nine frames rather than one: 10° a frame is 600°/s, which is a
        // fast flick of a real wrist, and a 90° teleport of the view is not an
        // input any hand can make.
        mouse: (frame) => {
          if (frame < spool || frame >= spool + 9) return false;
          turnBy(Math.PI / 2 / 9);
          return true;
        },
      },
      // A hard corner at a moderate throttle, which is where the lag is worst: at
      // 55 m/s full bars is still a wide arc the machine takes at 7°/s, while the
      // same bars at a third of that speed swing the nose round at ten times the
      // rate and a first-order follower sits `rate` behind it.
      {
        name: 'hard corner, part throttle',
        seconds: SPOOL + 8,
        stick: { x: 1, y: 0.4 },
        from: spool,
        spool: { x: 0, y: 0.4 },
      },
      // The mouse held against it, which is riding through a place and looking at
      // it. 60°/s is an unhurried pan.
      {
        name: 'mouse held at 60°/s',
        seconds: SPOOL + 4,
        stick: { x: 0, y: 1 },
        from: spool,
        mouse: (frame) => {
          if (frame < spool) return false;
          turnBy((60 / DEGREES) * DELTA);
          return true;
        },
      },
      // Stopped with the bars hard over, which is somebody looking around.
      // Stopped and paddled round by the rider's feet, which is what the bars do
      // with no throttle. Spooled with nothing held so it is genuinely stopped,
      // and judged only on the frames it stayed that way.
      {
        name: 'stopped, bars hard over',
        seconds: 8,
        stick: { x: 1, y: 0 },
        from: 120,
        spool: { x: 0, y: 0 },
        slow: true,
      },
    ];

    for (const plan of plans) {
      const rig = boarded(view);
      if (!rig) {
        console.log(`    ${plan.name}: could not board`);
        continue;
      }
      report(
        drive(rig.walker, rig.camera, plan.name, plan.seconds, plan.stick, plan.from, plan.mouse, plan.spool, plan.slow)
      );
      rig.walker.dispose();
    }
  }

  vehicles.dispose();
};

for (const slug of only ? only.split(',') : [...LOCATION_SLUGS]) probe(slug);
