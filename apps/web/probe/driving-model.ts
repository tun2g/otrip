/**
 * Does the vehicle model actually do what its comments claim?
 *
 * `driving.ts` is pure: no terrain, no road network, no walker, no scene graph.
 * So unlike `motorbike-ride.ts` — which has to boot four real destinations to
 * answer anything, because the surface under the wheels is half the question —
 * this integrates the bare model and prints numbers against the machines they
 * came from. A physics model that has never been run is a guess.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/driving-model.ts
 */
import {
  ABSOLUTE_TOP,
  collideDrive,
  collideWorld,
  createDriveState,
  createImpact,
  createImpactor,
  driveVelocityX,
  driveVelocityZ,
  engineTorque,
  gearSpeeds,
  readDriveBody,
  REDLINE,
  stepDrive,
  surfaceGrip,
  TORQUE_PEAK,
  tuneDrive,
  type DriveInput,
  type DriveSpec,
  type DriveState,
  type DriveSurface,
} from '../src/scene/driving.ts';

const DELTA = 1 / 60;
const G = 9.81;

/**
 * `SPECS`, plus the seven fields this model needs it to carry. Every one of them
 * is sourced; the report carries the sources.
 *
 * Still transcribed rather than imported, and now by choice rather than by
 * necessity: it was written when `SPECS` was private to `vehicles.ts`, and it
 * has since moved to `vehicle-specs.ts` and been exported so that the kit, the
 * builders and `avatar-ride.ts` can all read it. Importing it would make this
 * probe agree with that table by construction, and agreeing with it is the one
 * thing this file is for — a transcription that has drifted is a failure anybody
 * can see, where an import that has drifted is a test that stopped testing.
 */
type Kind =
  | 'ridden'
  | 'motorbike'
  | 'motorbike-cargo'
  | 'car'
  | 'truck'
  | 'coach'
  | 'bicycle'
  | 'cyclo'
  | 'buffalo-cart';

const SPECS: Record<Kind, DriveSpec> = {
  /**
   * The machine the **player** rides, which is not in `SPECS` anywhere and was
   * not in this probe either — and that was a hole big enough to lose a feature
   * down. Every table below used to be about a stock 110 cc Wave making 5.3 kW
   * on a 0.96 g tyre, while the thing a player actually gets on makes 62 kW on a
   * 3.06 g tyre. The questions that matter — can it take a bend, what does a
   * hairpin cost — have different answers by a factor of twelve in power, and
   * this file was answering them about the wrong machine.
   *
   * `vehicles.ts` assembles it by laying `RIDDEN = { mass: 230, power: 62000,
   * grip: 16.5, dragArea: 0.32 }` over the motorbike's own spec, which is what
   * this is. The mass and the drag area arrived after this probe showed that
   * 0.59 m² — a naked Wave's frontal area, carried along while the power went up
   * twelvefold — was what bounded cornering at speed rather than the grip.
   */
  ridden: {
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
  },
  motorbike: {
    length: 1.95,
    width: 0.72,
    frontAxle: 0.62,
    rearAxle: -0.62,
    grip: 5.2,
    brake: 5.4,
    mass: 165,
    power: 5280,
    dragArea: 0.59,
    rollCrr: 0.02,
    massBias: 0.5,
    cgHeight: 0.55,
    driveFront: false,
  },
  'motorbike-cargo': {
    length: 1.95,
    width: 0.98,
    frontAxle: 0.62,
    rearAxle: -0.62,
    grip: 3.9,
    brake: 4.2,
    mass: 245,
    power: 5280,
    dragArea: 0.78,
    rollCrr: 0.022,
    massBias: 0.44,
    cgHeight: 0.62,
    driveFront: false,
  },
  car: {
    length: 4.3,
    width: 1.8,
    frontAxle: 1.3,
    rearAxle: -1.3,
    grip: 4.6,
    brake: 5.8,
    mass: 1240,
    power: 67000,
    dragArea: 0.65,
    rollCrr: 0.012,
    massBias: 0.55,
    cgHeight: 0.52,
    driveFront: true,
  },
  truck: {
    length: 5.4,
    width: 1.95,
    frontAxle: 1.52,
    rearAxle: -1.28,
    grip: 3.3,
    brake: 4.2,
    mass: 3400,
    power: 66000,
    dragArea: 2.6,
    rollCrr: 0.008,
    massBias: 0.44,
    cgHeight: 0.95,
    driveFront: false,
  },
  coach: {
    length: 10.5,
    width: 2.5,
    frontAxle: 3.1,
    rearAxle: -2.1,
    grip: 2.9,
    brake: 3.6,
    mass: 12000,
    power: 246000,
    dragArea: 4.1,
    rollCrr: 0.007,
    massBias: 0.4,
    cgHeight: 1.4,
    driveFront: false,
  },
  bicycle: {
    length: 1.75,
    width: 0.56,
    frontAxle: 0.53,
    rearAxle: -0.52,
    grip: 2.9,
    brake: 2.8,
    mass: 80,
    power: 243,
    dragArea: 0.4,
    rollCrr: 0.005,
    massBias: 0.45,
    cgHeight: 1.0,
    driveFront: false,
  },
  cyclo: {
    length: 2.9,
    width: 1.22,
    frontAxle: 0.95,
    rearAxle: -1.05,
    grip: 2.3,
    brake: 2.4,
    mass: 170,
    power: 171,
    dragArea: 0.9,
    rollCrr: 0.012,
    massBias: 0.62,
    cgHeight: 0.85,
    driveFront: false,
  },
  'buffalo-cart': {
    length: 4.2,
    width: 1.62,
    frontAxle: 1.9,
    rearAxle: -0.3,
    grip: 1.5,
    brake: 1.4,
    mass: 1050,
    power: 485,
    dragArea: 2.2,
    rollCrr: 0.045,
    massBias: 0.25,
    cgHeight: 1.1,
    driveFront: true,
  },
};

const KINDS = Object.keys(SPECS) as Kind[];

const idle = (): DriveInput => ({ throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: false });
const flat = (): DriveSurface => ({ grade: 0, grip: 1, made: true, draft: 0 });
const pad = (value: number, places = 2, width = 7) => value.toFixed(places).padStart(width);
const clamp = (v: number, low: number, high: number) => (v < low ? low : v > high ? high : v);

/** Holds a speed with a crude throttle, for the cornering runs. */
const hold = (state: DriveState, input: DriveInput, target: number) => {
  input.throttle = state.along < target ? 1 : 0;
  input.brake = state.along > target + 0.3 ? 0.2 : 0;
};

/** Speed over the ground, which in a slide is not the same as speed up the nose. */
const overGround = (state: DriveState) => Math.hypot(state.along, state.across);

console.log('================ 1. along the nose ================');
console.log('what the power and the drag agree on, flat, made surface, dry\n');
console.log('kind              0→50 km/h  0→80 km/h    top speed      governed  0→95% top');
for (const kind of KINDS) {
  const tuning = tuneDrive(SPECS[kind]);
  const state = createDriveState(0);
  const input = idle();
  input.throttle = 1;
  const surface = flat();

  let fifty = 0;
  let eighty = 0;
  let ninetyFive = 0;
  let top = 0;
  // Two minutes, which is long enough for a coach to get to its governor and for
  // a buffalo to get to its 1.07 m/s.
  for (let n = 0; n < 120 * 60; n += 1) {
    stepDrive(state, tuning, input, surface, DELTA);
    const t = (n + 1) * DELTA;
    if (fifty === 0 && state.along >= 50 / 3.6) fifty = t;
    if (eighty === 0 && state.along >= 80 / 3.6) eighty = t;
    top = Math.max(top, state.along);
  }
  // Second pass for the 95% time, now that the top is known.
  const again = createDriveState(0);
  for (let n = 0; n < 120 * 60 && ninetyFive === 0; n += 1) {
    stepDrive(again, tuning, input, surface, DELTA);
    if (again.along >= top * 0.95) ninetyFive = (n + 1) * DELTA;
  }

  console.log(
    `${kind.padEnd(16)} ${(fifty > 0 ? `${fifty.toFixed(2)} s` : '    —').padStart(9)}  ` +
      `${(eighty > 0 ? `${eighty.toFixed(2)} s` : '    —').padStart(9)}  ` +
      `${pad(top)} m/s ${pad(top * 3.6, 1, 6)} km/h  ` +
      `${top >= tuning.limit - 0.05 ? '    yes' : '     no'}  ${pad(ninetyFive, 1, 6)} s`
  );
}

console.log('\n================ 2. the gearbox ================');
console.log('what a gear is actually for, on the machine the player rides\n');
{
  const tuning = tuneDrive(SPECS.ridden);
  const gears = tuning.gears;
  /** What the tyre holds with the whole machine squatting on the back wheel. */
  const traction = tuning.mu * tuning.mass * G;

  /**
   * The force at the wheel in one gear at one road speed, wide open, exactly as
   * `driving.ts` works it out — including the clutch floor at the torque peak,
   * which is what stops first gear being a dead zone below 10 m/s.
   */
  const wheelForce = (gear: number, speed: number): number => {
    const peak = gears[gear - 1];
    const geared = Math.max(0, speed) / peak;
    if (geared > REDLINE) return 0;
    return (tuning.power * engineTorque(Math.max(geared, TORQUE_PEAK))) / peak;
  };

  /**
   * The ideal shift point worked out here rather than read off `tuning.shifts`,
   * so that a disagreement between the two is visible. The model's own figure is
   * this capped at the gear's limiter, which bites on first gear alone.
   */
  const crossover = (gear: number): number => {
    const p = gears[gear - 1];
    const q = gears[gear];
    return q ? (1.5 * p * q * (p + q)) / (p * p + p * q + q * q) : 0;
  };

  console.log(
    `  engine: peak torque ${engineTorque(TORQUE_PEAK).toFixed(3)}x the peak-power torque, at ` +
      `${TORQUE_PEAK} revs; limiter at ${REDLINE}`
  );
  console.log(
    `  tyre: ${traction.toFixed(0)} N, which is ${(tuning.mu * G).toFixed(1)} m/s2 — the cap every ` +
      `low-gear figure below runs into\n`
  );
  console.log('gear  ratio  peak power    limiter       at torque peak   at peak power    at limiter   shift up at');
  for (let gear = 1; gear <= gears.length; gear += 1) {
    const peak = gears[gear - 1];
    const atPeakTorque = wheelForce(gear, TORQUE_PEAK * peak);
    const cross = crossover(gear);
    console.log(
      `${String(gear).padStart(4)}  ${pad(gears[gears.length - 1] / peak, 2, 5)}  ${pad(peak, 2, 7)} m/s  ` +
        `${pad(peak * REDLINE, 2, 6)} m/s  ${pad(Math.min(atPeakTorque, traction), 0, 10)} N` +
        `${atPeakTorque > traction ? '*' : ' '}  ${pad(Math.min(tuning.power / peak, traction), 0, 11)} N  ` +
        `${pad(wheelForce(gear, peak * REDLINE), 0, 9)} N  ` +
        `${
          cross > 0
            ? `${pad(tuning.shifts[gear - 1], 2, 7)} m/s (${(cross / peak).toFixed(3)} revs ideal` +
              `${cross > peak * REDLINE ? ', held to the limiter' : ''})`
            : '      — top gear'
        }`
    );
  }
  console.log('* the engine asks for more than the tyre holds, so the tyre is what you get.');
  console.log('The crossover lands between 1.11 and 1.16 revs across the box, which is what the');
  console.log(`${REDLINE} limiter was set from: the ideal shift and the limiter are the same event.`);

  console.log('\nwhat a rider climbing out of a Tà Xùa hairpin feels — wheel force, N, wide open');
  console.log(`(capped at the tyre's ${traction.toFixed(0)} N; a blank is past that gear's limiter)`);
  console.log(`speed   ${gears.map((_, g) => `gear ${g + 1}`.padStart(9)).join('')}`);
  for (const speed of [10, 20, 30]) {
    const row = gears.map((_, g) => {
      const force = wheelForce(g + 1, speed);
      return (force > 0 ? Math.min(force, traction).toFixed(0) : '—').padStart(9);
    });
    console.log(`${String(speed).padStart(3)} m/s ${row.join('')}`);
  }
  const envelope = (speed: number) => Math.min(tuning.power / speed, traction);
  console.log(
    `flat power (before): ${[10, 20, 30].map((v) => `${v} m/s ${envelope(v).toFixed(0)} N`).join(', ')} — the ` +
      'envelope the box touches once per gear'
  );

  console.log('\n--- the Tà Xùa question: full throttle AND full lock, held to a steady state ---');
  console.log('A flat pull settled at 51.1 m/s on a 191 m radius and could not be made to turn');
  console.log('tighter at all, which is why the mountain roads collapsed when the power went up.');
  console.log('In a gear, the limiter is what bounds it — and that is what a low gear is for.\n');
  console.log('gear   settled    radius   needs      lateral  of the tyre   front  rear');
  for (let gear = 1; gear <= gears.length; gear += 1) {
    const state = createDriveState(0);
    const input = idle();
    input.auto = false;
    input.throttle = 1;
    const surface = flat();
    state.gear = gear;
    let arc = 0;
    let sweep = 0;
    let lateral = 0;
    let front = 0;
    let rear = 0;
    for (let n = 0; n < 24 * 60; n += 1) {
      input.steer = n > 2 * 60 ? 1 : 0;
      stepDrive(state, tuning, input, surface, DELTA);
      if (n < 22 * 60) continue;
      arc += Math.hypot(driveVelocityX(state), driveVelocityZ(state)) * DELTA;
      sweep += Math.abs(state.turn + state.paddle) * DELTA;
      lateral = Math.max(lateral, Math.abs(state.lateral));
      front = Math.max(front, state.frontSlide);
      rear = Math.max(rear, state.rearSlide);
    }
    const radius = sweep > 1e-5 ? arc / sweep : Infinity;
    const over = Math.hypot(state.along, state.across);
    console.log(
      `${String(gear).padStart(4)} ${pad(over, 1, 8)} m/s ${pad(radius, 1, 8)} m ` +
        `${pad((over * over) / (tuning.mu * G), 1, 7)} m ${pad(lateral, 2, 10)} m/s² ` +
        `${pad((lateral / (tuning.mu * G)) * 100, 0, 9)}%   ${pad(front, 2, 6)} ${pad(rear, 2, 5)}` +
        `${gear === state.gear ? '' : `  (ended in ${state.gear})`}`
    );
  }
  {
    // And the automatic, which has no idea there is a corner: it shifts on road
    // speed, so holding the throttle open through a bend walks it up the box.
    const state = createDriveState(0);
    const input = idle();
    const surface = flat();
    input.throttle = 1;
    let arc = 0;
    let sweep = 0;
    for (let n = 0; n < 24 * 60; n += 1) {
      input.steer = n > 2 * 60 ? 1 : 0;
      stepDrive(state, tuning, input, surface, DELTA);
      if (n < 22 * 60) continue;
      arc += Math.hypot(driveVelocityX(state), driveVelocityZ(state)) * DELTA;
      sweep += Math.abs(state.turn + state.paddle) * DELTA;
    }
    const over = Math.hypot(state.along, state.across);
    console.log(
      `auto ${pad(over, 1, 8)} m/s ${pad(sweep > 1e-5 ? arc / sweep : Infinity, 1, 8)} m ` +
        `${pad((over * over) / (tuning.mu * G), 1, 7)} m   — ended in gear ${state.gear}`
    );
  }
  console.log('"needs" is the radius the tyre alone would want at that speed, v²/μg — so a gear');
  console.log('whose settled radius is near it is a gear cornering at the limit rather than');
  console.log('running wide on power it cannot use.');

  console.log('\n--- a Tà Xùa bend: hold a 20 m radius at full throttle and try to stay on it ---');
  console.log('A 20 m bend is what a ridge road is made of, and this tyre holds 24.5 m/s round one.');
  console.log('The rider steers for the radius; whether they keep it is whether the gear lets them.\n');
  console.log('gear    settled   radius held   of the 20 m    on the road?');
  const bend = (label: string, hold: number | null) => {
    const radius = 20;
    const state = createDriveState(0);
    const input = idle();
    const surface = flat();
    input.throttle = 1;
    if (hold !== null) state.gear = hold;
    let arc = 0;
    let sweep = 0;
    for (let n = 0; n < 40 * 60; n += 1) {
      // Steer for the radius: the yaw rate a 20 m circle wants at this speed,
      // closed on with a proportional term, which is a rider's hands.
      const want = state.along / radius;
      input.steer = clamp((want - (state.turn + state.paddle)) * 4, -1, 1);
      if (hold === null) {
        input.auto = true;
      } else {
        input.auto = false;
        input.shift = state.gear < hold ? 1 : state.gear > hold ? -1 : 0;
      }
      stepDrive(state, tuning, input, surface, DELTA);
      input.shift = 0;
      if (n < 38 * 60) continue;
      arc += Math.hypot(driveVelocityX(state), driveVelocityZ(state)) * DELTA;
      sweep += Math.abs(state.turn + state.paddle) * DELTA;
    }
    const held = sweep > 1e-5 ? arc / sweep : Infinity;
    console.log(
      `${label.padEnd(7)} ${pad(Math.hypot(state.along, state.across), 1, 6)} m/s ` +
        `${pad(held, 1, 10)} m ${pad((held / radius) * 100, 0, 11)}%    ` +
        `${held < radius * 1.25 ? 'yes' : 'ran wide — off the road'}`
    );
  };
  bend('auto', null);
  for (let gear = 1; gear <= 3; gear += 1) bend(`${gear}`, gear);
  console.log('Running wide is the measured failure: the carriageway `road-network` cuts is a few');
  console.log('metres across, so 25% wide of a 20 m bend is in the trees. A gear whose limiter is');
  console.log("under the bend's own 24.5 m/s cannot run wide however long the throttle is held.");

  /** Full throttle from rest to a set of speeds, under one shift policy. */
  const sprint = (label: string, policy: (state: DriveState, input: DriveInput) => void) => {
    const state = createDriveState(0);
    const input = idle();
    input.throttle = 1;
    const surface = flat();
    const marks = [50, 100, 150].map((kph) => ({ kph, want: kph / 3.6, at: 0 }));
    let shifts = 0;
    let top = 0;
    for (let n = 0; n < 180 * 60; n += 1) {
      const was = state.gear;
      policy(state, input);
      stepDrive(state, tuning, input, surface, DELTA);
      input.shift = 0;
      if (state.gear !== was) shifts += 1;
      const now = (n + 1) * DELTA;
      for (const mark of marks) if (mark.at === 0 && state.along >= mark.want) mark.at = now;
      top = Math.max(top, state.along);
    }
    console.log(
      `  ${label.padEnd(34)}${marks
        .map((mark) => (mark.at > 0 ? `${mark.at.toFixed(2)} s` : '—').padStart(9))
        .join('')}  ${pad(top, 2)} m/s  ${String(shifts).padStart(2)} shifts`
    );
  };

  console.log('\n--- 0 to 50, 100 and 150 km/h, flat and dry, and the top it settles at ---');
  console.log('  policy                                0→50     0→100    0→150       top     shifts');
  console.log('  flat power, as it was before          0.37 s   1.23 s   3.13 s    55.00 m/s   —');
  sprint('automatic', () => {});
  sprint('manual, shifted at the crossover', (state, input) => {
    input.auto = false;
    const up = tuning.shifts[state.gear - 1];
    if (up !== undefined && state.along > up) input.shift = 1;
  });
  sprint('manual, held one gear too long', (state, input) => {
    input.auto = false;
    const peak = gears[state.gear - 1];
    if (state.gear < gears.length && state.along > peak * REDLINE) input.shift = 1;
  });
  sprint('manual, left in top the whole way', (state, input) => {
    input.auto = false;
    if (state.gear < gears.length) input.shift = 1;
  });
  console.log('  The automatic shifts at the point the ratios were cut for, so a straight line is');
  console.log('  the one place it cannot be beaten. What a rider has that it has not is the road');
  console.log('  ahead — see the corner-exit run below.');

  console.log('\n--- the governor and the boost, which the gearbox must not have moved ---');
  for (const [label, boosting] of [
    ['top gear, flat out', false],
    ['top gear, flat out with the boost lit', true],
  ] as [string, boolean][]) {
    const state = createDriveState(0);
    const input = idle();
    input.throttle = 1;
    input.boost = boosting;
    const surface = flat();
    let top = 0;
    for (let n = 0; n < 180 * 60; n += 1) {
      if (boosting) state.boost = 1;
      stepDrive(state, tuning, input, surface, DELTA);
      top = Math.max(top, state.along);
    }
    console.log(
      `  ${label.padEnd(40)} ${pad(top)} m/s  in gear ${state.gear} at ${(state.engine * 100).toFixed(0)}% of ` +
        'the rev range'
    );
  }
  console.log("  SPEED_LIMIT is 55 and BOOST_TOP adds 8, so those two are the player's 3.48x and");
  console.log('  3.98x a running body and are what must not have changed. Top gear is cut for the');
  console.log('  speed the power and the drag agree on, 55.91, so peak power lands at the cut.');

  console.log('\n--- four, five and six speeds over the same spread, each shifted perfectly ---');
  console.log('  Manual at the crossover, so the ratios are compared at their best rather than');
  console.log("  through the automatic's hysteresis.");
  for (const count of [4, 5, 6, 8]) {
    const speeds = gearSpeeds(gears[gears.length - 1], count);
    const box = { ...tuning, gears: speeds, shifts: [], shiftGap: [] } as unknown as typeof tuning;
    const crossings = speeds.slice(0, -1).map((p, i) => {
      const q = speeds[i + 1];
      return Math.min((1.5 * p * q * (p + q)) / (p * p + p * q + q * q), p * REDLINE);
    });
    const state = createDriveState(0);
    const input = idle();
    input.throttle = 1;
    input.auto = false;
    const surface = flat();
    const marks = [50, 100, 150].map((kph) => ({ kph, want: kph / 3.6, at: 0 }));
    for (let n = 0; n < 120 * 60; n += 1) {
      const up = crossings[state.gear - 1];
      input.shift = up !== undefined && state.along > up ? 1 : 0;
      stepDrive(state, box, input, surface, DELTA);
      const now = (n + 1) * DELTA;
      for (const mark of marks) if (mark.at === 0 && state.along >= mark.want) mark.at = now;
    }
    console.log(
      `  ${String(count)} speeds, steps up to ${(speeds[1] / speeds[0]).toFixed(2)}, first gear tops ` +
        `${(speeds[0] * REDLINE).toFixed(1)} m/s ` +
        `${marks.map((mark) => (mark.at > 0 ? `${mark.at.toFixed(2)} s` : '—').padStart(9)).join('')}`
    );
  }

  console.log('\n--- does the automatic hunt? gear changes over 20 s at a held speed ---');
  let worstHunt = 0;
  let worstWhere = '';
  for (const kind of KINDS) {
    const tune = tuneDrive(SPECS[kind]);
    for (const grade of [0, 0.1, 0.26]) {
      for (let target = 1; target <= Math.ceil(tune.gears[tune.gears.length - 1]); target += 1) {
        const state = createDriveState(0);
        const input = idle();
        const surface: DriveSurface = { grade, grip: 1, made: true, draft: 0 };
        input.throttle = 1;
        for (let n = 0; n < 60 * 60 && state.along < target; n += 1) stepDrive(state, tune, input, surface, DELTA);
        if (state.along < target - 0.5) break;
        let changes = 0;
        for (let n = 0; n < 20 * 60; n += 1) {
          const was = state.gear;
          hold(state, input, target);
          stepDrive(state, tune, input, surface, DELTA);
          if (state.gear !== was) changes += 1;
        }
        if (changes > worstHunt) {
          worstHunt = changes;
          worstWhere = `${kind} holding ${target} m/s on a ${(grade * 100).toFixed(0)}% grade`;
        }
      }
    }
  }
  console.log(
    `  worst case over every kind, every whole speed and three gradients: ${worstHunt} changes in 20 s` +
      `${worstHunt > 0 ? ` — ${worstWhere}` : ''}`
  );
  console.log('  (a throttle flapping on and off around a target will shift once or twice as the');
  console.log('  kickdown boundary moves with it; more than a handful would be the box oscillating.)');

  console.log('\n--- out of a hairpin: which gear, and what the automatic costs ---');
  console.log('40 m/s down to 12 m/s hard on the brakes, then wide open with half lock for 4 s.');
  console.log('The gear is what decides how much of the rear tyre is left to turn with.\n');
  const exit = (label: string, hold: number | null) => {
    const state = createDriveState(0);
    const input = idle();
    const surface = flat();
    input.throttle = 1;
    for (let n = 0; n < 120 * 60 && state.along < 40; n += 1) stepDrive(state, tuning, input, surface, DELTA);
    let shifts = 0;
    let dead = 0;
    let arrived = 0;
    let rear = 0;
    for (let n = 0; n < 16 * 60; n += 1) {
      const t = n * DELTA;
      const was = state.gear;
      if (hold === null) {
        input.auto = true;
      } else {
        // A rider holds one gear: the paddle is pressed only while the box is not
        // already in it, which is what a key press is.
        input.auto = false;
        input.shift = state.gear < hold ? 1 : state.gear > hold ? -1 : 0;
      }
      if (state.along > 12 && arrived === 0) {
        input.throttle = 0;
        input.brake = 1;
        input.steer = 0;
      } else {
        if (arrived === 0) arrived = t;
        input.throttle = 1;
        input.brake = 0;
        input.steer = 0.5;
      }
      stepDrive(state, tuning, input, surface, DELTA);
      input.shift = 0;
      if (state.gear !== was) shifts += 1;
      if (arrived > 0) {
        if (state.shiftFor > 0) dead += DELTA;
        rear = Math.max(rear, state.rearSlide);
      }
      if (arrived > 0 && t > arrived + 4) break;
    }
    console.log(
      `  ${label.padEnd(30)} out at ${pad(Math.hypot(state.along, state.across), 2, 6)} m/s in gear ` +
        `${state.gear}  ${String(shifts).padStart(2)} shifts  ${pad(dead, 2, 5)} s clutch out  ` +
        `rear ${pad(rear, 2, 5)} of its grip gone`
    );
  };
  exit('automatic', null);
  for (let gear = 1; gear <= gears.length; gear += 1) exit(`manual, held in ${gear}`, gear);

  console.log('\n--- the force step across a shift, which is what a gear count buys ---');
  console.log('Upshift at the limiter; the force before it against the force just after.\n');
  for (const count of [4, 5, 6, 8]) {
    const speeds = gearSpeeds(gears[gears.length - 1], count);
    const steps = speeds.slice(0, -1).map((p, i) => {
      const q = speeds[i + 1];
      const v = p * REDLINE;
      const before = (tuning.power * engineTorque(REDLINE)) / p;
      const after = (tuning.power * engineTorque(v / q)) / q;
      return (after / before - 1) * 100;
    });
    console.log(
      `  ${count} speeds: ${steps.map((d) => `${d.toFixed(1)}%`.padStart(8)).join('')}` +
        `   worst ${Math.min(...steps).toFixed(1)}%`
    );
  }
  console.log('  Six is where the worst step is inside 3%. Four drops a fifth of the force in one');
  console.log('  shift, which mid-corner on a 3 g tyre is a thing the rider feels as a stumble —');
  console.log('  and it is the reason to prefer six even though the straight-line table above');
  console.log('  says four is quicker, because fewer shifts means less time with the clutch out.');
}

console.log('\n================ 3. up the hill ================');
console.log('top speed on a grade, which is now gravity along the slope and not a floor\n');
const GRADES = [0, 0.05, 0.1, 0.2, 0.26, 0.6];
console.log(`kind            ${GRADES.map((g) => `${(g * 100).toFixed(0)}%`.padStart(8)).join('')}`);
for (const kind of KINDS) {
  const tuning = tuneDrive(SPECS[kind]);
  const row: string[] = [];
  for (const grade of GRADES) {
    const state = createDriveState(0);
    const input = idle();
    input.throttle = 1;
    const surface = { grade, grip: 1, made: true, draft: 0 };
    for (let n = 0; n < 90 * 60; n += 1) stepDrive(state, tuning, input, surface, DELTA);
    row.push(state.along.toFixed(2).padStart(8));
  }
  console.log(`${kind.padEnd(16)}${row.join('')}`);
}
console.log('m/s. 26% is the steepest a road-network carriageway is ever cut (GRADE_LIMIT);');
console.log("60% is the median gradient of the bare terrain under Tà Xùa's road, which is");
console.log('what the model would see if MADE_SURFACE ever failed to find the carriageway.');

console.log('\n================ 4. round the corner ================');
console.log('full lock held to a steady state on a made dry surface\n');
console.log('kind              speed     radius   lateral  of limit   front  rear   slip');
for (const kind of ['motorbike', 'car'] as Kind[]) {
  const tuning = tuneDrive(SPECS[kind]);
  for (const target of [5, 10, 15, 20]) {
    const state = createDriveState(0);
    const input = idle();
    const surface = flat();
    // Up to speed in a straight line first.
    input.throttle = 1;
    for (let n = 0; n < 60 * 60 && state.along < target; n += 1) stepDrive(state, tuning, input, surface, DELTA);
    input.steer = 1;
    // Twelve seconds is several laps of the tightest circle here and settles the
    // loosest; the last two are what gets measured.
    let arc = 0;
    let sweep = 0;
    let slip = 0;
    let front = 0;
    let rear = 0;
    let lateral = 0;
    for (let n = 0; n < 12 * 60; n += 1) {
      hold(state, input, target);
      stepDrive(state, tuning, input, surface, DELTA);
      if (n < 10 * 60) continue;
      arc += Math.hypot(driveVelocityX(state), driveVelocityZ(state)) * DELTA;
      sweep += Math.abs(state.turn + state.paddle) * DELTA;
      slip = Math.max(slip, Math.abs(state.slip));
      front = Math.max(front, state.frontSlide);
      rear = Math.max(rear, state.rearSlide);
      lateral = Math.max(lateral, Math.abs(state.lateral));
    }
    const radius = sweep > 1e-5 ? arc / sweep : Infinity;
    console.log(
      `${kind.padEnd(14)} ${pad(state.along, 1, 5)} m/s ${pad(radius, 1, 8)} m ` +
        `${pad(lateral, 2, 7)} m/s² ${pad((lateral / (tuning.mu * G)) * 100, 0, 7)}%  ` +
        `${pad(front, 2, 6)}  ${pad(rear, 2, 4)}  ${pad((slip * 180) / Math.PI, 1, 5)}°`
    );
  }
}

// Full lock saturates the front at any speed by construction — the steering
// window is `STEER_MARGIN` of saturation wide — so the question worth asking is
// at what speed a steady half-lock stops being held.
console.log('\nwhere the front gives up: half lock held, speed walked up half a metre at a time');
for (const kind of ['motorbike', 'car'] as Kind[]) {
  const tuning = tuneDrive(SPECS[kind]);
  let washed = 0;
  let reached = 0;
  for (let target = 4; target <= 26; target += 0.5) {
    const state = createDriveState(0);
    const input = idle();
    const surface = flat();
    input.throttle = 1;
    for (let n = 0; n < 90 * 60 && state.along < target; n += 1) stepDrive(state, tuning, input, surface, DELTA);
    if (state.along < target - 0.5) break;
    reached = target;
    input.steer = 0.5;
    let front = 0;
    for (let n = 0; n < 8 * 60; n += 1) {
      hold(state, input, target);
      stepDrive(state, tuning, input, surface, DELTA);
      if (n > 6 * 60) front = Math.max(front, state.frontSlide);
    }
    if (front >= 0.999 && washed === 0) washed = target;
  }
  console.log(
    `  ${kind.padEnd(12)} front saturated from ${washed > 0 ? `${washed.toFixed(1)} m/s up` : `nowhere up to ${reached.toFixed(1)} m/s`}`
  );
}

// How long a stab the mechanic forgives, which is the whole shape of it.
/**
 * Why the fast machine ploughs, which is the question `riders` raised when they
 * measured a 287 m turning circle against a 82 m theoretical minimum and
 * reported the front axle fully saturated with the rear doing nothing.
 *
 * It is not a defect in the model and it is not the model treating a motorbike
 * as a car. It is the drag, and the arithmetic below is a closed form rather
 * than a fit, so the implementation can be checked against the specification.
 *
 * With the centre of mass at mid-wheelbase, `lf = −lr`, so the steady-state yaw
 * balance `lf·Ff + lr·Fr = 0` forces the two axles to make **equal** force —
 * whichever runs out first caps the pair, and the other's grip is unreachable.
 * At a held speed the drive has to overcome the drag, that drive is a force at
 * the contact patch, and it levers `D·h/L` of load off the front. At 49.6 m/s
 * the ridden machine's 0.59 m² is pushing 880 N of air, which at
 * `0.55/1.24` takes 391 N off a 858 N front axle. So the available lateral is
 * `2·μ·(1 − GRIP_BIAS)·loadFront/m`, not `μ·g`, and the 3.06 g the `grip` spec
 * was chosen for is simply not on the table at that speed.
 *
 * The model is in fact **optimistic** here and must not be "fixed" in the
 * obvious direction. Taking moments about the rear contact patch, the front
 * loses `D·h_cp/L` where `h_cp` is the centre of aerodynamic pressure — and on
 * a bike with an upright rider that is the rider's chest and helmet at 1.0 to
 * 1.1 m, about twice the 0.55 m centre of mass. The real machine's front goes
 * very light indeed at 180 km/h, which is a thing riders of naked bikes will
 * tell you about. Using `cgHeight` for both is the same as assuming the drag
 * acts at the centre of mass, and it is the kind assumption.
 */
console.log('\nwhy the fast machine ploughs: the turning circle against what the throttle is doing');
console.log('Full lock at 49.6 m/s on the ridden machine, measured over the half second after the');
console.log("rider's wrist does something. 3.06 g would be an 80.4 m circle.\n");
{
  const tuning = tuneDrive(SPECS.ridden);
  const wrists: [string, (state: DriveState, input: DriveInput) => void][] = [
    ['holds it wide open', (_s, i) => ((i.throttle = 1), (i.brake = 0))],
    ['holds the speed', (s, i) => ((i.throttle = s.along < 49.6 ? 1 : 0), (i.brake = s.along > 49.9 ? 0.15 : 0))],
    ['shuts it', (_s, i) => ((i.throttle = 0), (i.brake = 0))],
    ['brakes a quarter', (_s, i) => ((i.throttle = 0), (i.brake = 0.25))],
  ];
  console.log('what the rider does      radius    lateral    of the tyre   front load   speed lost');
  for (const [label, wrist] of wrists) {
    const state = createDriveState(0);
    const input = idle();
    const surface = flat();
    input.throttle = 1;
    for (let n = 0; n < 300 * 60 && state.along < 49.6; n += 1) stepDrive(state, tuning, input, surface, DELTA);
    // The lock goes on at a held speed first, so what follows measures the wrist
    // and not the transient of turning in.
    input.steer = 1;
    for (let n = 0; n < 3 * 60; n += 1) {
      input.throttle = state.along < 49.6 ? 1 : 0;
      input.brake = state.along > 49.9 ? 0.15 : 0;
      stepDrive(state, tuning, input, surface, DELTA);
    }
    // Over the ground, not up the nose: in a corner `along` also falls because the
    // velocity rotates into `across`, so a nose-speed delta over-reads the
    // deceleration badly enough to imply more friction than the tyre has.
    const entry = overGround(state);
    let arc = 0;
    let sweep = 0;
    let lateral = 0;
    let surge = 0;
    for (let n = 0; n < 30; n += 1) {
      wrist(state, input);
      stepDrive(state, tuning, input, surface, DELTA);
      arc += Math.hypot(driveVelocityX(state), driveVelocityZ(state)) * DELTA;
      sweep += Math.abs(state.turn + state.paddle) * DELTA;
      lateral = Math.max(lateral, Math.abs(state.lateral));
      surge = state.surge;
    }
    const front = Math.max(0, tuning.mass * G * 0.5 - (tuning.mass * surge * tuning.cgHeight) / tuning.wheelbase);
    console.log(
      `  ${label.padEnd(20)} ${pad(sweep > 1e-5 ? arc / sweep : Infinity, 1, 7)} m ${pad(lateral, 2, 8)} m/s² ` +
        `${pad((lateral / (tuning.mu * G)) * 100, 0, 9)}%  ${pad(front, 0, 8)} N  ${pad(entry - overGround(state), 2, 8)} m/s`
    );
  }
  console.log('  The grip does reach the road: shutting the throttle finds 99% of the tyre and a');
  console.log('  25 m circle in half a second. 880 N of air is what the other 54% is being spent on.');

  console.log('\n  and at the speeds a road is actually ridden, holding the speed at full lock');
  for (const speed of [15, 20, 25, 30, 35, 49.6]) {
    const state = createDriveState(0);
    const input = idle();
    const surface = flat();
    input.throttle = 1;
    for (let n = 0; n < 300 * 60 && state.along < speed; n += 1) stepDrive(state, tuning, input, surface, DELTA);
    input.steer = 1;
    let arc = 0;
    let sweep = 0;
    let lateral = 0;
    for (let n = 0; n < 20 * 60; n += 1) {
      hold(state, input, speed);
      stepDrive(state, tuning, input, surface, DELTA);
      if (n < 18 * 60) continue;
      arc += Math.hypot(driveVelocityX(state), driveVelocityZ(state)) * DELTA;
      sweep += Math.abs(state.turn + state.paddle) * DELTA;
      lateral = Math.max(lateral, Math.abs(state.lateral));
    }
    // The closed form the measurement has to agree with: the drive balancing the
    // drag, levered off the front, with both axles held equal by the yaw balance.
    const drag = 0.5 * 1.165 * SPECS.ridden.dragArea * speed * speed + SPECS.ridden.rollCrr * tuning.mass * G;
    const loadFront = Math.max(0, tuning.mass * G * 0.5 - (drag * tuning.cgHeight) / tuning.wheelbase);
    const want = (2 * tuning.mu * 0.94 * loadFront) / tuning.mass;
    console.log(
      `    ${pad(speed, 1, 4)} m/s: ${pad(sweep > 1e-5 ? arc / sweep : Infinity, 1, 6)} m, ` +
        `${pad((lateral / (tuning.mu * G)) * 100, 0, 3)}% of the tyre — ` +
        `the closed form says ${pad(want, 2, 5)} m/s² and ${pad((speed * speed) / want, 1, 6)} m, ` +
        `and 3.06 g alone would say ${pad((speed * speed) / (tuning.mu * G), 1, 5)} m`
    );
  }
  console.log('  Measurement against closed form is within 5% everywhere, so the implementation is');
  console.log('  doing what the specification says. The specification is what costs the grip, and');
  console.log('  it costs it as v²: 97% of the tyre at 15 m/s, 85% at 25, 59% at 49.6.');

  console.log('\n  the boost meter after four seconds, which is the other half of the 4×');
  const charge = (label: string, speed: number, wrist: (state: DriveState, input: DriveInput, t: number) => void) => {
    const state = createDriveState(0);
    const input = idle();
    const surface = flat();
    input.throttle = 1;
    for (let n = 0; n < 300 * 60 && state.along < speed; n += 1) stepDrive(state, tuning, input, surface, DELTA);
    state.boost = 0;
    let slip = 0;
    let rear = 0;
    for (let n = 0; n < 4 * 60; n += 1) {
      wrist(state, input, n * DELTA);
      stepDrive(state, tuning, input, surface, DELTA);
      slip = Math.max(slip, Math.abs(state.slip));
      rear = Math.max(rear, state.rearSlide);
    }
    console.log(
      `    ${label.padEnd(44)} ${pad(state.boost * 100, 1, 5)}%  peak slip ${pad((slip * 180) / Math.PI, 1, 5)}° ` +
        ` peak rear ${pad(rear, 2, 4)}`
    );
  };
  charge('full lock at 49.6 m/s, wide open', 49.6, (_s, i) => ((i.steer = 1), (i.throttle = 1)));
  charge('full lock at 25 m/s, holding', 25, (s, i) => {
    i.steer = 1;
    hold(s, i, 25);
  });
  charge('a 0.25 s handbrake stab at 25 m/s, caught', 25, (s, i, t) => {
    i.handbrake = t < 0.25 ? 1 : 0;
    i.steer = t < 0.25 ? 0.6 : Math.max(-1, Math.min(1, -(s.slip * 3 + s.turn * 1.2)));
    i.throttle = t < 0.25 ? 0 : 1;
  });
  console.log('  The meter is not dead. What will not charge it is a *settled* understeering');
  console.log('  circle, where the rear carries 0.11 of its grip and the slip angle is zero — and');
  console.log('  that is the refusal `BOOST_DRIFT` argues for at length, not a defect: a front');
  console.log('  wash on a rear-driven machine is a mistake, and a meter that paid for it would be');
  console.log('  teaching the wrong hands.');
}

/**
 * The player's own repro, which is the bug this section exists for.
 *
 * "khi đang lái mà nhấn giữ a hoặc d thì nó bị nhạy cảm, ôm cua quá; nhấn phanh
 * nữa thì xe nó ngã xuống và quay tròn không kiểm soát được" — hold A or D and
 * it corners too hard; add the brake and it falls over and spins out of control.
 * `walker.ts` forces the throttle shut whenever the brake is applied, so the
 * input is full lock plus brake with no throttle.
 *
 * Measured before the fixes: **34.5 rad/s of yaw — 1,976°/s — and it never came
 * back.** Six seconds after every input was released it was still at 39 rad/s
 * and climbing, which is a model making energy. Three separate faults, all in
 * `driving.ts` and all now fixed; the comments on `den`, `BRAKE_BITE` and
 * `LEAN_LIMIT` carry one each.
 */
console.log('\nthe spin: hold full lock, then add the brake — the bug the player reported');
console.log('Before: 34.5 rad/s and it never recovered. The three faults were the signed slip');
console.log('denominator, a brake that could ask an axle for more than it holds, and a lateral');
console.log('limit no two-wheeler could lean to.\n');
{
  const tuning = tuneDrive(SPECS.ridden);
  console.log('speed   peak yaw        peak slip   released, 6 s later   verdict');
  for (const speed of [5, 10, 15, 20, 30, 45]) {
    const state = createDriveState(0);
    const input = idle();
    const surface = flat();
    input.throttle = 1;
    for (let n = 0; n < 400 * 60 && state.along < speed; n += 1) stepDrive(state, tuning, input, surface, DELTA);
    if (state.along < speed - 0.6) {
      console.log(`${pad(speed, 0, 5)} m/s  never reached`);
      continue;
    }
    let peak = 0;
    let slip = 0;
    for (let n = 0; n < 150; n += 1) {
      input.steer = 1;
      // A quarter second of lock first, then the brake on top, which is the
      // order the player's hands do it in.
      if (n >= 15) {
        input.throttle = 0;
        input.brake = 1;
      }
      stepDrive(state, tuning, input, surface, DELTA);
      peak = Math.max(peak, Math.abs(state.turn));
      slip = Math.max(slip, Math.abs(state.slip));
    }
    input.steer = 0;
    input.brake = 0;
    for (let n = 0; n < 6 * 60; n += 1) stepDrive(state, tuning, input, surface, DELTA);
    console.log(
      `${pad(speed, 0, 5)} m/s ${pad(peak, 2, 7)} rad/s ${pad((peak * 180) / Math.PI, 0, 7)}°/s ` +
        `${pad((slip * 180) / Math.PI, 0, 7)}°  ${pad(Math.abs(state.turn), 3, 12)} rad/s     ` +
        `${Math.abs(state.turn) < 0.05 ? 'recovers' : 'STILL TURNING'}`
    );
  }
  console.log('  It still spins, and it should: the handbrake exists to provoke one and the boost');
  console.log('  pays for it. The requirement is that it is recoverable, and a hard stop on full');
  console.log('  lock genuinely does put a bike down — "xe nó ngã xuống" was never the bug.');

  console.log('\nsteering authority: the lateral a full stick actually delivers, at each speed');
  console.log('This is the "nhạy cảm tốc độ" column. Before `LEAN_LIMIT` it read 12%, 44%, 43%,');
  console.log('40%, 38%, 34% of the tyre — sharpest at 5 m/s, a 11.8x swing in how long a radian');
  console.log('took to sweep, and nothing a rider could build a habit against.\n');
  console.log('speed    radius    lateral   of the tyre   of the lean limit');
  for (const speed of [2, 5, 10, 20, 35, 50]) {
    const state = createDriveState(0);
    const input = idle();
    const surface = flat();
    input.throttle = 1;
    for (let n = 0; n < 400 * 60 && state.along < speed; n += 1) stepDrive(state, tuning, input, surface, DELTA);
    if (state.along < speed - 0.6) {
      console.log(`${pad(speed, 0, 5)} m/s  never reached`);
      continue;
    }
    input.steer = 1;
    let arc = 0;
    let sweep = 0;
    let lateral = 0;
    for (let n = 0; n < 24 * 60; n += 1) {
      hold(state, input, speed);
      input.steer = 1;
      stepDrive(state, tuning, input, surface, DELTA);
      if (n < 22 * 60) continue;
      arc += Math.hypot(driveVelocityX(state), driveVelocityZ(state)) * DELTA;
      sweep += Math.abs(state.turn + state.paddle) * DELTA;
      lateral = Math.max(lateral, Math.abs(state.lateral));
    }
    console.log(
      `${pad(speed, 0, 5)} m/s ${pad(sweep > 1e-5 ? arc / sweep : Infinity, 1, 8)} m ${pad(lateral, 2, 9)} m/s² ` +
        `${pad((lateral / (tuning.mu * G)) * 100, 0, 9)}%  ${pad((lateral / (1.8 * G)) * 100, 0, 15)}%`
    );
  }
  console.log('  Flat in the quantity a rider feels. The radius still grows as v² — `R = v²/a` is');
  console.log('  not negotiable, and no steering map can make 50 m/s turn like 5 m/s.');
}

console.log('\nthe longest handbrake stab at 15 m/s with half lock that still comes back');
for (const kind of ['motorbike', 'car'] as Kind[])
  for (const made of [true, false]) {
    const tuning = tuneDrive(SPECS[kind]);
    const row: string[] = [];
    for (const stab of [0.2, 0.3, 0.5, 1, 2]) {
      const state = createDriveState(0);
      const input = idle();
      const surface: DriveSurface = { grade: 0, grip: surfaceGrip(made, 0), made, draft: 0 };
      input.throttle = 1;
      for (let n = 0; n < 90 * 60 && state.along < 15; n += 1) stepDrive(state, tuning, input, surface, DELTA);
      let peak = 0;
      let back = -1;
      for (let n = 0; n < 14 * 60; n += 1) {
        const t = n * DELTA;
        if (t < stab) {
          input.handbrake = 1;
          input.steer = 0.5;
          input.throttle = 0;
        } else {
          input.handbrake = 0;
          input.throttle = 0.25;
          input.steer = Math.max(-1, Math.min(1, -(state.slip * 3 + state.turn * 1.2)));
        }
        stepDrive(state, tuning, input, surface, DELTA);
        peak = Math.max(peak, Math.abs(state.slip));
        if (Math.abs(state.slip) > 0.05) back = -1;
        else if (back < 0 && t > stab) back = t;
      }
      row.push(
        `${stab.toFixed(1)}s→${((peak * 180) / Math.PI).toFixed(0)}°${back < 0 ? ' LOST' : ` in ${back.toFixed(1)}s`}`.padEnd(
          18
        )
      );
    }
    console.log(`  ${kind.padEnd(12)}${made ? 'made  ' : 'bare  '}${row.join('')}`);
  }

console.log('\n================ 5. a provoked drift ================');
console.log('15 m/s, handbrake on with 50% of left lock for a second, then caught\n');
for (const kind of ['motorbike', 'car'] as Kind[]) {
  for (const made of [true, false]) {
    const tuning = tuneDrive(SPECS[kind]);
    const state = createDriveState(0);
    const input = idle();
    const surface: DriveSurface = { grade: 0, grip: surfaceGrip(made, 0), made, draft: 0 };
    input.throttle = 1;
    for (let n = 0; n < 60 * 60 && state.along < 15; n += 1) stepDrive(state, tuning, input, surface, DELTA);
    const entry = state.along;

    let peak = 0;
    let sliding = 0;
    let spun = false;
    let recovered = -1;
    let worstTurn = 0;
    let exitSpeed = 0;
    for (let n = 0; n < 16 * 60; n += 1) {
      const t = n * DELTA;
      if (t < 1) {
        // Provoke: handbrake and half lock.
        input.handbrake = 1;
        input.steer = 0.5;
        input.throttle = 0;
      } else {
        // Catch it: steer into the slide, throttle eased, handbrake off. A
        // proportional term on the slip alone is bang-bang past ten degrees and
        // oscillates for ever on its own account, which is a bad test rig and
        // not a bad model; the yaw-rate term is the lead a rider's hands have.
        input.handbrake = 0;
        input.throttle = 0.25;
        input.steer = Math.max(-1, Math.min(1, -(state.slip * 3 + state.turn * 1.2)));
      }
      stepDrive(state, tuning, input, surface, DELTA);
      const slip = Math.abs(state.slip);
      peak = Math.max(peak, slip);
      worstTurn = Math.max(worstTurn, Math.abs(state.turn));
      if (slip > 0.1) {
        sliding += DELTA;
        recovered = -1;
        exitSpeed = overGround(state);
      } else if (recovered < 0 && t > 1) recovered = t;
    }
    spun = recovered < 0;
    console.log(
      `${kind.padEnd(12)} ${made ? 'made  ' : 'bare  '} peak slip ${pad((peak * 180) / Math.PI, 1, 5)}°  ` +
        `sliding ${pad(sliding, 2, 5)} s  over the ground ${pad(entry, 1, 5)} → ${pad(exitSpeed, 1, 5)} m/s ` +
        `(${pad(entry - exitSpeed, 1, 5)} lost)  worst yaw ${pad(worstTurn, 2, 5)} rad/s  ` +
        `${spun ? 'LOST IT' : 'caught'}, tracking again at ${recovered < 0 ? 'never' : `${recovered.toFixed(2)} s`} ` +
        `with ${pad((Math.abs(state.slip) * 180) / Math.PI, 2, 5)}° left`
    );
  }
}

console.log('\n================ 6. boost ================');
{
  const tuning = tuneDrive(SPECS.motorbike);
  const surface = flat();

  // What one stab-and-catch earns, and how many of them fill the meter.
  const state = createDriveState(0);
  const input = idle();
  input.throttle = 1;
  for (let n = 0; n < 90 * 60 && state.along < 18; n += 1) stepDrive(state, tuning, input, surface, DELTA);
  let drifts = 0;
  let first = 0;
  while (drifts < 40 && state.boost < 1) {
    const had = state.boost;
    for (let n = 0; n < 4 * 60; n += 1) {
      const t = n * DELTA;
      input.handbrake = t < 0.25 ? 1 : 0;
      input.steer = t < 0.25 ? 0.6 : Math.max(-1, Math.min(1, -(state.slip * 3 + state.turn * 1.2)));
      input.throttle = t < 0.25 ? 0 : 1;
      stepDrive(state, tuning, input, surface, DELTA);
    }
    drifts += 1;
    if (drifts === 1) first = state.boost - had;
  }
  console.log(
    `  one 0.25 s stab-and-catch on a xe máy earns ${(first * 100).toFixed(0)}% of the meter; ` +
      `${state.boost >= 1 ? `${drifts} of them fill it` : `40 of them only reach ${(state.boost * 100).toFixed(0)}%`}`
  );

  // Drafting.
  const drafting = createDriveState(0);
  const wake: DriveSurface = { grade: 0, grip: 1, made: true, draft: 1 };
  const held = idle();
  held.throttle = 1;
  let draftFill = 0;
  for (let n = 0; n < 120 * 60; n += 1) {
    stepDrive(drafting, tuning, held, wake, DELTA);
    if (draftFill === 0 && drafting.boost >= 1) draftFill = (n + 1) * DELTA;
  }
  console.log(
    `  sitting in a slipstream fills it in ${draftFill > 0 ? `${draftFill.toFixed(1)} s` : 'never'}, ` +
      `and the shelter alone takes the top speed to ${drafting.along.toFixed(2)} m/s`
  );

  // Top speed with it lit, and the absolute worst case anywhere.
  const lit = createDriveState(0);
  lit.boost = 1;
  const burn = idle();
  burn.throttle = 1;
  burn.boost = true;
  let litTop = 0;
  for (let n = 0; n < 120 * 60; n += 1) {
    lit.boost = 1;
    stepDrive(lit, tuning, burn, surface, DELTA);
    litTop = Math.max(litTop, lit.along);
  }
  console.log(`  flat out with it held lit (meter pinned full): ${litTop.toFixed(2)} m/s`);

  let worst = 0;
  let worstAt = '';
  for (const kind of KINDS) {
    const tune = tuneDrive(SPECS[kind]);
    for (const grade of [0, -0.1, -0.26, -0.6, -1]) {
      const run = createDriveState(0);
      run.boost = 1;
      const down: DriveSurface = { grade, grip: 1, made: true, draft: 1 };
      for (let n = 0; n < 180 * 60; n += 1) {
        run.boost = 1;
        stepDrive(run, tune, burn, down, DELTA);
      }
      if (run.along > worst) {
        worst = run.along;
        worstAt = `${kind} on a ${(grade * 100).toFixed(0)}% descent, boosting, in a slipstream`;
      }
    }
  }
  console.log(`  the fastest anything gets anywhere: ${worst.toFixed(3)} m/s — ${worstAt}`);
  // Against the ceilings as they stand, not as they stood: `ABSOLUTE_TOP` went
  // from 29 to 65 and the room's `maxSpeed` from 34 to 90 when the governor was
  // raised to 55, and this line was still testing the old pair.
  console.log(
    `  at or under ABSOLUTE_TOP's ${ABSOLUTE_TOP} m/s: ${worst <= ABSOLUTE_TOP + 1e-6 ? 'yes' : 'NO'}; ` +
      "the room rejects movement over config.maxSpeed's 90 m/s"
  );
}

console.log('\n================ 7. contact ================');
{
  const impact = createImpact();
  const other = createImpactor();

  /** Two machines, each resolving itself against the other's reported state. */
  const pair = (
    label: string,
    aKind: Kind,
    bKind: Kind,
    aHeading: number,
    bHeading: number,
    aSpeed: number,
    bSpeed: number,
    gap: number,
    offset: number
  ) => {
    const aTune = tuneDrive(SPECS[aKind]);
    const bTune = tuneDrive(SPECS[bKind]);
    const a = createDriveState(aHeading);
    const b = createDriveState(bHeading);
    a.along = aSpeed;
    b.along = bSpeed;
    let ax = 0;
    let az = 0;
    let bx = offset;
    let bz = gap;

    const momentum = () => ({
      x: aTune.mass * driveVelocityX(a) + bTune.mass * driveVelocityX(b),
      z: aTune.mass * driveVelocityZ(a) + bTune.mass * driveVelocityZ(b),
    });
    const before = momentum();
    const closing =
      (driveVelocityX(a) - driveVelocityX(b)) * ((bx - ax) / Math.hypot(bx - ax, bz - az)) +
      (driveVelocityZ(a) - driveVelocityZ(b)) * ((bz - az) / Math.hypot(bx - ax, bz - az));

    // Both sides read the other as it was, then both resolve — which is what two
    // clients do with each other's last reported transform.
    const aSaw = readDriveBody(b, bTune, bx, bz, { ...other });
    const bSaw = readDriveBody(a, aTune, ax, az, { ...other });
    let touched = 0;
    let spinA = 0;
    let spinB = 0;
    let shockA = 0;
    let shockB = 0;
    // A handful of passes, the way a game resolves over frames, so the mutual
    // push converges. Velocity only changes on the first, because afterwards the
    // pair are separating.
    for (let pass = 0; pass < 6; pass += 1) {
      if (collideDrive(a, aTune, ax, az, aSaw, impact)) {
        ax += impact.pushX;
        az += impact.pushZ;
        if (pass === 0) {
          spinA = impact.spin;
          shockA = impact.shock;
          touched += 1;
        }
      }
      if (collideDrive(b, bTune, bx, bz, bSaw, impact)) {
        bx += impact.pushX;
        bz += impact.pushZ;
        if (pass === 0) {
          spinB = impact.spin;
          shockB = impact.shock;
          touched += 1;
        }
      }
      aSaw.x = bx;
      aSaw.z = bz;
      aSaw.vx = driveVelocityX(b);
      aSaw.vz = driveVelocityZ(b);
      bSaw.x = ax;
      bSaw.z = az;
      bSaw.vx = driveVelocityX(a);
      bSaw.vz = driveVelocityZ(a);
    }
    const after = momentum();
    const span = Math.hypot(bx - ax, bz - az);
    const reach = aTune.radius + bTune.radius;
    const drift = Math.hypot(after.x - before.x, after.z - before.z);
    const scale = Math.hypot(before.x, before.z) || 1;

    console.log(`  ${label}`);
    console.log(
      `    closing ${closing.toFixed(2)} m/s along the normal; both parties resolved (${touched} of 2 saw a hit)`
    );
    console.log(
      `    ${aKind} ${aSpeed.toFixed(1)} → along ${a.along.toFixed(2)} across ${a.across.toFixed(2)} m/s, ` +
        `yaw kick ${spinA.toFixed(3)} rad/s, Δv ${shockA.toFixed(2)} m/s`
    );
    console.log(
      `    ${bKind} ${bSpeed.toFixed(1)} → along ${b.along.toFixed(2)} across ${b.across.toFixed(2)} m/s, ` +
        `yaw kick ${spinB.toFixed(3)} rad/s, Δv ${shockB.toFixed(2)} m/s`
    );
    console.log(
      `    separation ${span.toFixed(3)} m against a ${reach.toFixed(3)} m reach ` +
        `(${span >= reach - 1e-6 ? 'clear' : 'STILL OVERLAPPING'}); ` +
        `momentum drifted ${drift.toExponential(2)} kg·m/s on ${scale.toFixed(0)} ` +
        `(${((drift / scale) * 100).toExponential(1)}%)`
    );
  };

  pair('head-on, two xe máy at 15 m/s each', 'motorbike', 'motorbike', 0, Math.PI, 15, 15, 1.2, 0);
  pair('rear-end shunt, 5 m/s of closing speed', 'motorbike', 'motorbike', 0, 0, 13, 8, 1.2, 0);
  pair('xe máy into the flank of a coach', 'motorbike', 'coach', 0, Math.PI / 2, 18, 0, 3.6, 0);
  // Converging rather than parallel: two riders side by side closing on each
  // other at a shallow angle, which is the contact a race actually produces.
  pair('glancing, two xe máy converging at 20°', 'motorbike', 'motorbike', 0.35, -0.35, 16, 16, 0.6, 1.1);

  // The world: a post, which never moves and never gives anything back.
  console.log('\n  against the world, which is what replaces `rideSpeed *= got / reach`');
  console.log('  a 15 m/s xe máy against a post 1.6 m away, at a range of bearings off the nose');
  for (const bearing of [0, 20, 45, 70, 85]) {
    const tuning = tuneDrive(SPECS.motorbike);
    const state = createDriveState(0);
    state.along = 15;
    const angle = (bearing * Math.PI) / 180;
    collideWorld(state, tuning, 0, 0, Math.sin(angle) * 1.6, Math.cos(angle) * 1.6, impact);
    console.log(
      `    ${String(bearing).padStart(2)}° off the nose: closing ${pad(impact.closing, 2, 6)} m/s → along ` +
        `${pad(state.along, 2, 6)} across ${pad(state.across, 2, 6)} m/s, yaw kick ${pad(impact.spin, 3, 7)} rad/s, ` +
        `${pad(overGround(state), 2, 5)} m/s over the ground of the 15 it arrived at`
    );
  }
}

console.log('\n================ 8. energy and integration ================');
{
  const tuning = tuneDrive(SPECS.motorbike);

  // Coasting, with nothing held.
  const coast = createDriveState(0);
  coast.along = 20;
  const input = idle();
  const surface = flat();
  let gained = 0;
  let stopped = 0;
  let distance = 0;
  for (let n = 0; n < 120 * 60; n += 1) {
    const was = coast.along;
    stepDrive(coast, tuning, input, surface, DELTA);
    distance += coast.along * DELTA;
    if (coast.along > was + 1e-9) gained = Math.max(gained, coast.along - was);
    if (stopped === 0 && coast.along <= 0.01) stopped = (n + 1) * DELTA;
  }
  console.log(
    `  coasting from 20 m/s on the flat with nothing held: down to ${coast.along.toFixed(4)} m/s, ` +
      `stopped at ${stopped > 0 ? `${stopped.toFixed(1)} s` : 'never'} after ${distance.toFixed(0)} m`
  );
  console.log(`  worst single-step speed gain while coasting: ${gained.toExponential(2)} m/s (must be ~0)`);

  // The same minute at three frame rates, including the walker's 0.1 s clamp.
  console.log('\n  one simulated minute at full throttle with 60% of left lock, at three frame rates');
  const runs: { fps: number; state: DriveState }[] = [];
  for (const fps of [60, 30, 15, 10]) {
    const state = createDriveState(0);
    const drive = idle();
    drive.throttle = 1;
    drive.steer = 0.6;
    const step = 1 / fps;
    for (let n = 0; n < 60 * fps; n += 1) stepDrive(state, tuning, drive, surface, step);
    runs.push({ fps, state });
  }
  const base = runs[0].state;
  for (const run of runs) {
    const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
    console.log(
      `    ${String(run.fps).padStart(3)} fps: along ${pad(run.state.along)} across ${pad(run.state.across)} ` +
        `turn ${pad(run.state.turn, 4)} slip ${pad((run.state.slip * 180) / Math.PI, 2, 6)}°  ` +
        `heading off 60 fps by ${pad((Math.abs(wrap(run.state.heading - base.heading)) * 180) / Math.PI, 2, 6)}°, ` +
        `speed by ${pad(Math.abs(run.state.along - base.along), 4, 7)} m/s`
    );
  }

  // And a frame that is far too long on purpose.
  const brutal = createDriveState(0);
  const drive = idle();
  drive.throttle = 1;
  drive.steer = 1;
  drive.handbrake = 0.5;
  for (let n = 0; n < 60; n += 1) stepDrive(brutal, tuning, drive, surface, 0.5);
  console.log(
    `    thirty seconds in 0.5 s frames, full lock and half handbrake: along ${brutal.along.toFixed(2)} ` +
      `across ${brutal.across.toFixed(2)} turn ${brutal.turn.toFixed(3)} — finite: ` +
      `${[brutal.along, brutal.across, brutal.turn, brutal.heading].every(Number.isFinite) ? 'yes' : 'NO'}`
  );

  /**
   * One tap of the paddle is one gear, whatever the frame was.
   *
   * `stepDrive` consumes `DriveInput.shift` once before it substeps, and this is
   * why: the walker's delta clamp is 0.1 s, which is twenty-four substeps, so a
   * shift read inside `integrate` would walk the box from first to top on a
   * single key press and would do it worse the slower the phone.
   *
   * Three taps up and three back down, so neither end of the box can hide a
   * miscount behind its clamp: it has to arrive at four and come home to one.
   */
  console.log('\n  one tap of the paddle per frame: three up then three down, at four frame rates');
  const taps: string[] = [];
  for (const fps of [60, 30, 15, 10]) {
    const state = createDriveState(0);
    const paddle = idle();
    paddle.auto = false;
    const step = 1 / fps;
    /** One deliberate press, then long enough for the clutch to come home. */
    const tap = (way: -1 | 1) => {
      paddle.shift = way;
      stepDrive(state, tuning, paddle, surface, step);
      paddle.shift = 0;
      for (let m = 0; m < Math.ceil(0.3 * fps); m += 1) stepDrive(state, tuning, paddle, surface, step);
    };
    for (let n = 0; n < 3; n += 1) tap(1);
    const up = state.gear;
    for (let n = 0; n < 3; n += 1) tap(-1);
    taps.push(`${fps} fps → ${up} then ${state.gear}`);
  }
  console.log(
    `    ${taps.join(', ')} — ` +
      `${taps.every((t) => t.endsWith('4 then 1')) ? 'all four at 4 then 1' : 'WRONG, a tap is not one gear'}`
  );
}

console.log('\n================ 9. the derivations ================');
console.log('kind              mass    mu   brake g   Iz kg·m²   lf/lr m      paddle   radius');
for (const kind of KINDS) {
  const spec = SPECS[kind];
  const tuning = tuneDrive(spec);
  console.log(
    `${kind.padEnd(16)}${pad(tuning.mass, 0, 6)}  ${pad(tuning.mu, 2, 4)}  ` +
      `${pad(Math.min(tuning.brakeForce / (tuning.mass * G), tuning.mu), 2, 7)}  ` +
      `${pad(tuning.yawInertia, 0, 9)}  ${pad(tuning.lf, 2, 5)}/${pad(tuning.lr, 2, 5)}  ` +
      `${pad(tuning.paddleRate, 2, 6)} rad/s ${pad(tuning.radius, 2, 6)} m`
  );
}

console.log('\nsurface grip against dry asphalt');
for (const made of [true, false]) {
  for (const wet of [0, 0.5, 1]) {
    console.log(
      `  ${made ? 'made surface' : 'bare ground '}  rain ${wet.toFixed(1)}  →  ${surfaceGrip(made, wet).toFixed(3)}`
    );
  }
}

console.log('\nwhat the walker had before, for comparison:');
console.log('  RIDER_TOP 9 m/s clamp, 0.64 of the 14 m/s travel stride — the complaint');
console.log('  grip/v turn law, a steady-state circle with no slip angle and no way to drift');
console.log('  HILL_COST 1.4 / HILL_FLOOR 0.35: a 0.60 gradient left 9 × 0.35 = 3.15 m/s');
console.log('  rideSpeed *= got/reach on a contact: no normal, no yaw, no mass');
