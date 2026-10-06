/**
 * Where a driven vehicle has got to, what the rider is asking of it, and what
 * the world outside the model is doing to it.
 *
 * Separate from `driving.ts` so that `driving-collision.ts` can take a state
 * apart without importing the integrator — the step depends on the state and the
 * collision depends on the state, and neither should depend on the other.
 * `driving.ts` re-exports all of this, so nothing outside needs to know.
 */

export const clamp = (value: number, low: number, high: number) => (value < low ? low : value > high ? high : value);

export const G = 9.81;

/**
 * m/s the slip-angle denominator is floored at. `atan(w/u)` has no meaning at a
 * standstill; below this the rider's feet are doing the turning anyway.
 */
export const CRAWL = 1;

/**
 * The hard ceiling on speed over the ground, which gravity does not get a vote
 * on. The governor in `driving.ts` cuts drive force rather than clamping, so a
 * long descent can still run past it: a Wave coasting down a 1:4 grade balances
 * drag against gravity at 32 m/s, which is absurd on a 100 cc underbone.
 *
 * It was 29, against a 25 m/s governor and a 28 m/s boosted ceiling. The
 * governor is 55 now and `BOOST_TOP` takes it to 63, so this went to 65 with
 * them and the comment's arithmetic went stale: 65 leaves the boosted governor's
 * 63 two metres a second of headroom, and the room's `config.maxSpeed` — raised
 * to 90 in the same pass — twenty-five. Measured in `probe/driving-model.ts`,
 * the fastest anything reaches anywhere, every kind on every descent with the
 * boost lit and a slipstream, is 65.000: this is the thing that is binding, as
 * it should be.
 */
export const ABSOLUTE_TOP = 65;

/**
 * m/s backwards, as a ceiling rather than as reverse's own target.
 *
 * Nothing is driven backwards fast, but a machine can still be rolled backwards
 * by gravity: measured on this model, a Wave on a 26% climb has 666 N of
 * traction against 832 N of gravity, cannot hold itself, and with only drag and
 * rolling resistance to stop it slides back down to the clamp. 29 m/s backwards
 * down a hillside is not a vehicle, it is a bug with a camera attached — a rider
 * who cannot climb a slope puts a foot down and the brakes on at walking pace,
 * and 4 m/s is that, generously.
 *
 * It is applied only while the machine really is rolling backwards. Clamping
 * `along` unconditionally is what wrecked the first spin: a machine fully
 * sideways legitimately has a large negative nose speed, and pinning it here
 * tore the velocity vector apart halfway through a slide.
 */
export const REVERSE_MAX = 4;

/**
 * The lateral component of `q` relative to `p`, positive to the rider's left.
 *
 * World forward at heading `h` is `(sin h, cos h)` and the rider's left is
 * `(cos h, −sin h)`, which `walker.ts` relies on when it stands a dismounting
 * rider at `+cos`, `−sin`. In that frame the scalar cross that reads +1 for
 * forward × left is `p.z·q.x − p.x·q.z`, and the other sign — the one a
 * right-handed habit reaches for — turns every yaw kick the wrong way.
 */
export const cross = (px: number, pz: number, qx: number, qz: number) => pz * qx - px * qz;

/**
 * Where a machine has got to, in its own frame. Mutable and integrated in place:
 * nothing in `stepDrive` allocates.
 */
export type DriveState = {
  /** m/s along its own nose. Negative is being walked backwards. */
  along: number;
  /** m/s to the rider's left. Non-zero is a slide. */
  across: number;
  /** Radians about Y, the way `Object3D.rotation.y` reads it. */
  heading: number;
  /** Rad/s the tyres are turning it at, positive to the left. */
  turn: number;
  /** Rad/s the rider's legs are adding on top, and the only kinematic term here. */
  paddle: number;
  /**
   * Radians the velocity lies to the left of the nose. Negative in a left-hand
   * drift, where the tail has stepped out to the right and the machine is
   * pointing left of where it is going.
   */
  slip: number;
  /** Radians of lock actually at the wheel, positive to the left. */
  steer: number;
  /** m/s² along the nose, lagged. Drives the load transfer. */
  surge: number;
  /** m/s² to the left. What the body should be leaning against. */
  lateral: number;
  /** 0 to 1, how much of each axle's grip is gone. */
  frontSlide: number;
  rearSlide: number;
  /**
   * Which gear, counted from 1 the way a rider counts them — `tuning.gears` is
   * indexed `gear - 1`. One representation, because two is a bug waiting.
   *
   * Never 0 and never negative: reverse is the rider's feet and has no gear, so
   * a machine being walked backwards is in first with the clutch in.
   */
  gear: number;
  /**
   * Engine speed, 0 to 1 of the rev range, where 1 is the limiter. Peak power
   * is at 0.87 of it and peak torque at 0.65 — which is where they sit on a real
   * tacho, just short of the red.
   *
   * This is what a dash can draw. A bare gear number can only be printed.
   */
  engine: number;
  /**
   * The throttle as the **gearbox** sees it, 0 to 1, lagged.
   *
   * A real automatic reads the throttle through a valve or a filter and not off
   * the rider's wrist, and this is that. It is here because the shift schedule
   * moves with the throttle — wide open the box will drop a gear to find the
   * force, shut it takes the tallest one that does not lug — and a boundary that
   * can move 6 m/s in one frame is a boundary a modulated throttle will sit on
   * and oscillate across. Measured before it existed: a bang-bang throttle
   * holding the ridden machine at 16 m/s shifted **96 times in 20 seconds**.
   *
   * Lagged at about half a second, which is six times slower than `brake`'s own
   * filter. The force the engine makes is off the raw throttle, as it should be:
   * this is only what the box believes you are asking for.
   */
  pull: number;
  /**
   * Seconds of a shift left to run. The clutch is out while it is positive, so
   * there is no drive and no engine braking either, and nothing may shift again
   * until it expires — which is also what stops an automatic hunting.
   */
  shiftFor: number;
  /** 0 to 1 of brake actually applied, for the brake light. */
  brake: number;
  /** 0 to 1 in the meter. */
  boost: number;
  /** 0 to 1 lit, ramped, for an exhaust flare. */
  boosting: number;
};

/** What the rider is asking for. Steering is positive to the left, like `turn`. */
export type DriveInput = {
  /** −1 to 1. Negative is the brake, then walking it backwards. */
  throttle: number;
  /** 0 to 1, the real brake — so you can brake and steer instead of reversing. */
  brake: number;
  /** −1 to 1, positive to the rider's left. */
  steer: number;
  /** 0 to 1. Drags the rear at its friction limit, which is how you provoke a slide. */
  handbrake: number;
  /** Held, not pressed. Lights the boost if there is enough in the meter. */
  boost: boolean;
  /**
   * One gear up or one gear down, as an **edge**: set it on the keypress and
   * clear it after the frame.
   *
   * `stepDrive` consumes it once, before it substeps, and `integrate` never sees
   * it. That is not tidiness — a shift read per substep would walk the box from
   * first to top inside a single 10 fps frame, because the walker's 0.1 s delta
   * is twenty-four substeps and the key would still be down for all of them.
   *
   * Ignored while the gearbox is automatic, so the two can never fight over the
   * same gear. `walker.ts` should clear `auto` on the first press rather than
   * making the rider find a mode key before the paddle does anything.
   */
  shift?: -1 | 0 | 1;
  /**
   * The gearbox shifts itself. **Absent means automatic**, because most people
   * opening Hội An to look at lanterns should not have to row a gearbox to get
   * out of the car park, and because every other caller of `stepDrive` — the
   * probes — wants a machine that drives itself.
   */
  auto?: boolean;
};

/**
 * Everything about the situation the model cannot work out for itself, all of it
 * from the caller because all of it lives outside this file: the gradient and
 * what is under the wheels are the walker's, the rain is `vehicles.setWeather`'s,
 * and who is in front is whatever is tracking the other racers.
 */
export type DriveSurface = {
  /** Metres risen per metre travelled, under the wheels. */
  grade: number;
  /** Multiplier on the tyres' dry-asphalt limit. `surfaceGrip` builds it. */
  grip: number;
  /** A graded carriageway, as `MADE_SURFACE` clearance over the terrain decides. */
  made: boolean;
  /** 0 to 1, how deeply it is sitting in another vehicle's wake. */
  draft: number;
};

export const createDriveState = (heading: number): DriveState => ({
  along: 0,
  across: 0,
  heading,
  turn: 0,
  paddle: 0,
  slip: 0,
  steer: 0,
  surge: 0,
  lateral: 0,
  frontSlide: 0,
  rearSlide: 0,
  gear: 1,
  engine: 0,
  pull: 0,
  shiftFor: 0,
  brake: 0,
  boost: 0,
  boosting: 0,
});

/** World velocity, which is the nose and the slide added together. */
export const driveVelocityX = (state: DriveState): number =>
  state.along * Math.sin(state.heading) + state.across * Math.cos(state.heading);
export const driveVelocityZ = (state: DriveState): number =>
  state.along * Math.cos(state.heading) - state.across * Math.sin(state.heading);
