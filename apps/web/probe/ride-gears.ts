/**
 * Does choosing gears well beat the automatic on a mountain road, and by how
 * much?
 *
 * `probe/driving-model.ts` answers the straight-line version and the answer is
 * **0.01 s over 0–150 km/h** — the automatic shifts at the force crossover the
 * ratios were cut for, so a drag race against it is unwinnable, which is also
 * true of the real thing. That left the question of where the skill actually
 * lives, and the bare model says a 20 m bend: first gear holds one at 109% of
 * its radius with the throttle wide open where the automatic runs 1,258% wide.
 *
 * A bend in isolation is not a road, though. This drives a real one.
 *
 * It exists separately from `probe/ride-pace.ts`, which measures the same pace
 * over the same roads, for one reason: **that probe rides through `walker.ts`,
 * and `walker.ts` has no shift input wired yet**, so every run it does is in
 * automatic and it cannot ask the question. This drives `stepDrive` directly
 * with its own rider, which costs it the walker's collision and water handling —
 * so the numbers here are about the drivetrain and the road, and `ride-pace.ts`
 * stays the authority on what a player actually experiences.
 *
 * The rider is the same one `ride-pace.ts` uses, deliberately: aim at a point a
 * stated number of *seconds* up the centreline, and take the bend at the speed
 * `vehicles.ts`'s own bend law allows. Only the gearbox differs between rows.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/ride-gears.ts [--only=trang-an]
 */
import type { DriveInput, DriveSpec, DriveState, DriveSurface } from '../src/scene/driving.ts';
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
globals.document = { addEventListener: () => {}, removeEventListener: () => {} };

const { createTerrain, LOCATIONS } = await import('@otrip/world');
const { resolvePois } = await import('../src/scene/points-of-interest.ts');
const { createRoadNetwork } = await import('../src/scene/road-network.ts');
const { planTown } = await import('../src/scene/town-plan.ts');
const { createDriveState, driveVelocityX, driveVelocityZ, REDLINE, stepDrive, surfaceGrip, tuneDrive } =
  await import('../src/scene/driving.ts');

type Terrain = ReturnType<typeof createTerrain>;

/** `walker.GRADE_PROBE`: how far ahead the gradient under the wheels is read. */
const GRADE_PROBE = 2;
const SEGMENTS = 416;
const DELTA = 1 / 60;
const RUN_FOR = 40;
/** `walker.TRAVEL_SPEED`, which is what the machine has to beat. */
const TRAVEL_SPEED = 14;

/**
 * The ridden machine, transcribed from `RIDDEN` in `vehicles.ts` laid over the
 * motorbike's own spec — the same transcription, and for the same reason, as
 * `probe/driving-model.ts`: a probe that imports the figure it is checking
 * agrees with it by construction.
 */
const RIDDEN: DriveSpec = {
  length: 1.95,
  width: 0.72,
  frontAxle: 0.62,
  rearAxle: -0.62,
  grip: 16.5,
  brake: 5.4,
  mass: 230,
  power: 62000,
  dragArea: 0.32,
  rollCrr: 0.02,
  massBias: 0.5,
  cgHeight: 0.55,
  driveFront: false,
};

/**
 * m/s² the machine can actually hold sideways, which is **not** its tyre figure.
 *
 * `ride-pace.ts` brakes for every bend against `16.5 / 0.55 = 30 m/s²`, the
 * tyre's own limit, and that was right when it was written. It is now nearly
 * double what the machine can use: `LEAN_LIMIT` in `driving.ts` bounds the
 * lateral at `1.8 g` because a two-wheeler corners by leaning and 30 m/s² would
 * need 72° of it. A rider braking against 30 enters every bend at 1.4 times the
 * speed it can be held at, runs wide, and ends up on the hillside — which is a
 * large part of why that probe reads Tràng An at 0.98× running.
 *
 * So this one brakes against the honest figure, and prints both so the gap is
 * visible rather than argued about.
 */
const LEAN_LATERAL = 1.8 * 9.81;
const TYRE_LATERAL = 16.5 / 0.55;

const makeFloorAt = (terrain: Terrain) => (x: number, z: number) => terrain.heightAt(x, z);

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

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const pad = (value: number, places = 1, width = 7) => value.toFixed(places).padStart(width);

const only = process.argv.find((value) => value.startsWith('--only='))?.slice(7);
const slugs = ['trang-an', 'ta-xua', 'hoi-an', 'ho-tay'].filter((slug) => !only || slug === only);

const tuning = tuneDrive(RIDDEN);

/**
 * How a row chooses its gear. `null` is the automatic, a number holds that gear,
 * and `'bend'` is the rider: the lowest gear whose limiter still clears the
 * speed the corner ahead can be taken at, which is the most force available that
 * does not cap the machine below its own corner speed.
 */
type Policy = null | number | 'bend';

console.log(
  `\nStraight-line displacement over ${RUN_FOR} s against a runner's ${TRAVEL_SPEED} m/s, with only the\n` +
    `gearbox differing between rows. The rider aims 1.5 s up the centreline and brakes for the\n` +
    `bend ahead by \`sqrt(lateral / curvature)\`, against ${LEAN_LATERAL.toFixed(1)} m/s² — what \`LEAN_LIMIT\` allows —\n` +
    `rather than the tyre's ${TYRE_LATERAL.toFixed(1)}.`
);
console.log(
  `\nFirst gear's limiter is ${(tuning.gears[0] * REDLINE).toFixed(1)} m/s, second's ` +
    `${(tuning.gears[1] * REDLINE).toFixed(1)}, third's ${(tuning.gears[2] * REDLINE).toFixed(1)}.`
);

for (const slug of slugs) {
  const recipe = LOCATIONS[slug];
  if (!recipe) continue;
  const terrain = createTerrain(recipe, SEGMENTS);
  const plan = seeded(() => planTown(terrain, recipe, 1));
  const pois = seeded(() => resolvePois(terrain, recipe, plan.lots));
  const net = seeded(() => createRoadNetwork(terrain, recipe, pois, plan.lots));
  const floorAt = makeFloorAt(terrain);

  const trunk = net.roads
    .filter((entry) => entry.kind !== 'trail')
    .reduce((best, entry) => (best && best.totalLength >= entry.totalLength ? best : entry));
  const px = (i: number) => trunk.points[i * 3];
  const pz = (i: number) => trunk.points[i * 3 + 2];
  const count = Math.floor(trunk.points.length / 3);
  const spacing = Math.max(0.5, Math.hypot(px(1) - px(0), pz(1) - pz(0)));
  const here = { x: 0, y: 0, z: 0, tx: 0, tz: 1, curvature: 0 };

  // The tightest bend on the trunk, which is what bounds the whole run.
  let tightest = Infinity;
  for (let i = 0; i < count; i += 1) {
    net.sampleAt(trunk.index, (i / Math.max(1, count - 1)) * trunk.totalLength, here);
    const bend = Math.abs(here.curvature);
    if (bend > 1e-5) tightest = Math.min(tightest, 1 / bend);
  }

  console.log(`\n================ ${slug} ================`);
  console.log(
    `  the ${trunk.kind} road: ${trunk.totalLength.toFixed(0)} m, tightest radius ${tightest.toFixed(0)} m, ` +
      `which holds ${Math.sqrt(LEAN_LATERAL * tightest).toFixed(1)} m/s`
  );
  console.log('  gearbox            straight line   point to point   vs running   worst wander   off carriageway');

  const ride = (policy: Policy) => {
    const state: DriveState = createDriveState(Math.atan2(px(2) - px(1), pz(2) - pz(1)));
    const input: DriveInput = {
      throttle: 0,
      brake: 0,
      steer: 0,
      handbrake: 0,
      boost: false,
      shift: 0,
      auto: policy === null,
    };
    const surface: DriveSurface = { grade: 0, grip: 1, made: true, draft: 0 };
    let x = px(1);
    let z = pz(1);
    const fromX = x;
    const fromZ = z;
    let sample = 1;
    let wander = 0;
    let offRoad = 0;
    let done = false;

    for (let n = 0; n < Math.round(RUN_FOR * 60); n += 1) {
      const floor = floorAt(x, z);
      const ahead = floorAt(x + Math.sin(state.heading) * GRADE_PROBE, z + Math.cos(state.heading) * GRADE_PROBE);
      surface.grade = (ahead - floor) / GRADE_PROBE;
      if (!done) {
        let gap = Infinity;
        for (let i = Math.max(0, sample - 4); i < Math.min(count, sample + 400); i += 1) {
          const reach = Math.hypot(x - px(i), z - pz(i));
          if (reach < gap) {
            gap = reach;
            sample = i;
          }
        }
        wander = Math.max(wander, gap);
        // On the carriageway or off it, measured as distance from the centreline
        // against the road's own published width — no terrain archaeology, and
        // the one test that cannot be argued with. Nothing here models leaving
        // the road as a crash; this rig is about the drivetrain, so a large
        // off-carriageway share means a row has gone cross-country rather than
        // fast, and it invalidates the pace printed beside it.
        const on = gap <= trunk.width / 2;
        if (!on) offRoad += 1;
        surface.made = on;
        surface.grip = surfaceGrip(on, 0);
        if (sample >= count - 2) done = true;
      }

      if (done) {
        input.throttle = 0;
        input.brake = 1;
        input.steer = 0;
      } else {
        const speed = Math.max(0, state.along);
        const lead = Math.max(12, Math.max(speed, 8) * 1.5);
        const aim = Math.min(count - 1, sample + Math.ceil(lead / spacing));
        const wanted = Math.atan2(px(aim) - x, pz(aim) - z);
        // Positive to the rider's left, which is `DriveInput.steer`'s own
        // convention. `ride-pace.ts` passes the opposite sign because it goes
        // through `walker.ts`, which negates the joystick on the way in — copying
        // its value here steered away from every aim point and put the rider
        // 1,232 m off the road on the first run.
        input.steer = Math.max(-1, Math.min(1, wrap(wanted - state.heading) * 1.1));

        net.sampleAt(trunk.index, (aim / Math.max(1, count - 1)) * trunk.totalLength, here);
        const bend = Math.abs(here.curvature);
        const hold = bend > 1e-5 ? Math.sqrt(LEAN_LATERAL / bend) : Infinity;
        if (speed < hold * 0.9) {
          input.throttle = 1;
          input.brake = 0;
        } else if (speed < hold * 1.05) {
          input.throttle = 0;
          input.brake = 0;
        } else {
          input.throttle = 0;
          input.brake = 1;
        }

        // The gearbox, and the only thing that differs between rows.
        input.shift = 0;
        if (policy === 'bend') {
          /**
           * The gear for the **tightest bend in the next three seconds**, not for
           * the one under the wheels.
           *
           * Gearing for the aim point alone was the first version and it was no
           * better than the automatic: on a straight it takes top, and by the
           * time the corner is the aim point it is far too late for a gear to be
           * what saves you. Three seconds is what a rider reads, and the gear is
           * chosen as a *limiter* — the lowest one whose own limiter clears the
           * corner's speed, so the engine cannot carry the machine past what the
           * bend will hold however long the throttle is down.
           */
          let worst = Infinity;
          const scan = Math.max(30, speed * 3);
          for (let i = sample; i < Math.min(count, sample + Math.ceil(scan / spacing)); i += 2) {
            net.sampleAt(trunk.index, (i / Math.max(1, count - 1)) * trunk.totalLength, here);
            const turn = Math.abs(here.curvature);
            if (turn > 1e-5) worst = Math.min(worst, Math.sqrt(LEAN_LATERAL / turn));
          }
          const target = worst === Infinity ? tuning.limit : worst;
          let want = tuning.gears.length;
          for (let g = 0; g < tuning.gears.length; g += 1) {
            if (tuning.gears[g] * REDLINE >= target) {
              want = g + 1;
              break;
            }
          }
          input.shift = state.gear < want ? 1 : state.gear > want ? -1 : 0;
        } else if (typeof policy === 'number') {
          input.shift = state.gear < policy ? 1 : state.gear > policy ? -1 : 0;
        }
      }

      stepDrive(state, tuning, input, surface, DELTA);
      input.shift = 0;
      x += driveVelocityX(state) * DELTA;
      z += driveVelocityZ(state) * DELTA;
    }

    const straight = Math.hypot(x - fromX, z - fromZ);
    const pace = straight / RUN_FOR;
    const label = policy === null ? 'automatic' : policy === 'bend' ? 'manual, bend-aware' : `held in ${policy}`;
    console.log(
      `  ${label.padEnd(20)} ${pad(straight, 0, 9)} m ${pad(pace, 2, 14)} m/s ` +
        `${pad(pace / TRAVEL_SPEED, 2, 11)}×  ${pad(wander, 1, 12)} m ${pad((offRoad / (RUN_FOR * 60)) * 100, 0, 13)}%`
    );
    return { ratio: pace / TRAVEL_SPEED, off: offRoad / (RUN_FOR * 60), label };
  };

  /**
   * A row is only comparable if it stayed on the road. Twenty per cent is
   * generous — the fixed-gear rows come in at 3 to 14% and everything else at
   * 67 to 84% — and the gap is wide enough that the threshold is not a judgement
   * call.
   */
  const ON_ROAD = 0.2;
  const runs = [ride(null), ride('bend'), ...[1, 2, 3].map((gear) => ride(gear))];
  const auto = runs[0];
  const kept = runs.filter((run) => run.off <= ON_ROAD).sort((a, b) => b.ratio - a.ratio)[0];
  if (!kept) {
    console.log('  nothing stayed on the carriageway here, so there is no pace to quote');
  } else {
    console.log(
      `  best row that stayed on the road: **${kept.label}, ${kept.ratio.toFixed(2)}× running** at ` +
        `${(kept.off * 100).toFixed(0)}% off. The automatic reports ${auto.ratio.toFixed(2)}× and spends ` +
        `${(auto.off * 100).toFixed(0)}% of it off the carriageway, which is not a lap.`
    );
  }
}

console.log('\nNo collision and no slope gate in this rig — see the header. A row with a large');
console.log('off-carriageway share has not gone faster, it has gone cross-country, and');
console.log('`probe/ride-pace.ts` through `walker.ts` is what says whether that survives contact.');
