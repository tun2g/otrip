/**
 * What happens when a driven vehicle hits something — the named gap in the
 * user's report, who said there is no collision handling between cars and
 * motorbikes at all.
 *
 * It replaces `rideSpeed *= got / reach` in `walker.ts`, which scaled the speed
 * by how much of the intended step survived. That charges a long shallow scrape
 * along a wall exactly what it charges a square hit into one, it has no notion
 * of what the other thing weighs, and it never once changes which way the
 * machine is pointing. Here a contact is a normal impulse, a tangential scrub
 * and a yaw kick off the real lever arm, so a hit knocks you off line.
 */
import {
  ABSOLUTE_TOP,
  clamp,
  cross,
  driveVelocityX,
  driveVelocityZ,
  REVERSE_MAX,
  type DriveState,
} from './driving-state';
import type { DriveTuning } from './driving-tuning';

/**
 * How much of a closing speed comes back. Vehicles are not billiard balls: most
 * of the energy goes into the structure, and measured restitution for car-to-car
 * impacts is 0.1 to 0.2.
 */
const RESTITUTION = 0.15;

/**
 * Friction across the contact, as a share of the normal impulse — bodywork
 * scraping and tyres being dragged sideways. This is where a glancing blow's
 * speed goes and where the yaw kick comes from.
 */
const SCRUB = 0.45;

/**
 * Rad/s the most one contact may put on the yaw. The lever arm is taken at the
 * corner of the body's box, which is where a rigid body would be struck and not
 * where a vehicle is: bodywork crushes and the patch spreads, so the real arm is
 * much shorter. Uncapped, a xe máy clipping a post half off centre at 15 m/s
 * came away at 18.4 rad/s — 1,056°/s, a blender. 2.5 rad/s is 143°/s, which is
 * being spun hard and still being a vehicle, and it also keeps a scrape along a
 * wall — which arrives as many impulses in a row — from accumulating into one.
 */
const SPIN_CAP = 2.5;

/** One contact, filled in by the helpers below. Reused, so nothing allocates. */
export type Impact = {
  hit: boolean;
  /** Unit normal at the contact, pointing from this body toward the other. */
  nx: number;
  nz: number;
  /** Closing speed along the normal before the impulse. Positive is an impact. */
  closing: number;
  /** Metres this body has to move to clear the overlap. The caller owns position. */
  pushX: number;
  pushZ: number;
  /** m/s this body's velocity changed by — for a bang, a shake, a dent. */
  shock: number;
  /** Rad/s put on this body's yaw. */
  spin: number;
};

/** The other party to a contact, as a circle with mass. `Infinity` is the world. */
export type Impactor = {
  x: number;
  z: number;
  /** World velocity, m/s. */
  vx: number;
  vz: number;
  mass: number;
  radius: number;
};

export const createImpact = (): Impact => ({
  hit: false,
  nx: 0,
  nz: 0,
  closing: 0,
  pushX: 0,
  pushZ: 0,
  shock: 0,
  spin: 0,
});

export const createImpactor = (): Impactor => ({ x: 0, z: 0, vx: 0, vz: 0, mass: 1, radius: 1 });

/** This machine as something another body can hit, at the position the caller holds. */
export const readDriveBody = (
  state: DriveState,
  tuning: DriveTuning,
  x: number,
  z: number,
  out: Impactor
): Impactor => {
  out.x = x;
  out.z = z;
  out.vx = driveVelocityX(state);
  out.vz = driveVelocityZ(state);
  out.mass = tuning.mass;
  out.radius = tuning.radius;
  return out;
};

/**
 * The impulse, once the geometry is known. `gap` is the unit normal pointing
 * from this machine toward whatever it hit, `arm` is the contact point relative
 * to its own centre of mass, `rel` is the other body's velocity relative to this
 * one, and `inverse` is the pair's combined inverse mass.
 *
 * The lever arm is why this takes a contact point at all. Between two circles
 * the arm is parallel to the normal, the cross product is identically zero, and
 * no impulse can ever put a yaw kick on anything: a motorbike T-boned across the
 * back wheel would lose speed and go on pointing exactly where it was. With the
 * contact on the body's own box, a hit on the flank spins you and a square one
 * on the nose stops you, which is the difference the user is asking for.
 */
const strike = (
  state: DriveState,
  tuning: DriveTuning,
  gapX: number,
  gapZ: number,
  armX: number,
  armZ: number,
  relX: number,
  relZ: number,
  inverse: number,
  out: Impact
): void => {
  // A head-on and a rear-end shunt differ by nothing but this number.
  const closing = -(relX * gapX + relZ * gapZ);
  out.closing = closing;
  out.shock = 0;
  out.spin = 0;
  if (closing <= 0 || inverse <= 0) return;

  const normalImpulse = ((1 + RESTITUTION) * closing) / inverse;
  // Tangential: the impulse that would stop the two scrubbing across each other,
  // limited by friction. This is where a glancing blow's speed goes, and it is
  // the whole of the yaw kick.
  const tanX = -gapZ;
  const tanZ = gapX;
  const sliding = relX * tanX + relZ * tanZ;
  const limit = SCRUB * normalImpulse;
  const tanImpulse = clamp(sliding / inverse, -limit, limit);

  const pushX = -gapX * normalImpulse + tanX * tanImpulse;
  const pushZ = -gapZ * normalImpulse + tanZ * tanImpulse;
  const dvx = pushX / tuning.mass;
  const dvz = pushZ / tuning.mass;

  // Back into the machine's frame, where the rest of the model lives.
  const sin = Math.sin(state.heading);
  const cos = Math.cos(state.heading);
  state.along = clamp(state.along + dvx * sin + dvz * cos, -REVERSE_MAX, ABSOLUTE_TOP);
  state.across += dvx * cos - dvz * sin;

  const spin = clamp(cross(armX, armZ, pushX, pushZ) / tuning.yawInertia, -SPIN_CAP, SPIN_CAP);
  state.turn += spin;

  out.shock = Math.hypot(dvx, dvz);
  out.spin = spin;
};

/**
 * The contact point on this machine's box nearest to a point outside it. Carried
 * on the `Impact` rather than returned, so this allocates nothing; both callers
 * read the two numbers back immediately and then overwrite them.
 */
const armAhead = (state: DriveState, tuning: DriveTuning, toX: number, toZ: number, out: Impact): void => {
  const sin = Math.sin(state.heading);
  const cos = Math.cos(state.heading);
  const ahead = clamp(toX * sin + toZ * cos, -tuning.halfLength, tuning.halfLength);
  const left = clamp(toX * cos - toZ * sin, -tuning.halfWidth, tuning.halfWidth);
  out.pushX = ahead * sin + left * cos;
  out.pushZ = ahead * cos - left * sin;
};

/**
 * This machine against another body — another racer, a parked bike, one of the
 * fleet.
 *
 * One-sided on purpose. The impulse is computed from the pair's combined inverse
 * mass against a normal taken between the two centres, so two clients each
 * resolving their own machine against the other's reported position and velocity
 * apply impulses that are exactly equal and exactly opposite, and momentum comes
 * out conserved with neither of them owning the other. That is also the only
 * version of this that can work over a network.
 *
 * `out.pushX`/`pushZ` are metres the caller must move it by, split by mass so the
 * lighter one does the moving — a motorbike into a coach is 98.6% of the push.
 * Position belongs to the walker and this does not take it.
 */
export const collideDrive = (
  state: DriveState,
  tuning: DriveTuning,
  selfX: number,
  selfZ: number,
  other: Impactor,
  out: Impact
): boolean => {
  const toX = other.x - selfX;
  const toZ = other.z - selfZ;
  const span = Math.hypot(toX, toZ);
  const reach = tuning.radius + other.radius;
  if (span >= reach) {
    out.hit = false;
    return false;
  }

  let gapX: number;
  let gapZ: number;
  if (span < 1e-4) {
    // Dead centre has no direction to separate along, so take the nose.
    gapX = Math.sin(state.heading);
    gapZ = Math.cos(state.heading);
  } else {
    gapX = toX / span;
    gapZ = toZ / span;
  }

  armAhead(state, tuning, toX, toZ, out);
  const armX = out.pushX;
  const armZ = out.pushZ;

  const selfV = 1 / tuning.mass;
  const otherV = Number.isFinite(other.mass) && other.mass > 0 ? 1 / other.mass : 0;
  const inverse = selfV + otherV;
  const overlap = reach - span;

  out.hit = true;
  out.nx = gapX;
  out.nz = gapZ;
  out.pushX = (-gapX * overlap * selfV) / inverse;
  out.pushZ = (-gapZ * overlap * selfV) / inverse;

  strike(
    state,
    tuning,
    gapX,
    gapZ,
    armX,
    armZ,
    other.vx - driveVelocityX(state),
    other.vz - driveVelocityZ(state),
    inverse,
    out
  );
  return true;
};

/**
 * This machine against something that does not move: a house, a trunk, a signal
 * post, a pier — whatever `walker.gatherContacts` put in the way. `hitX`/`hitZ`
 * are the obstacle's centre, which is `contactX[worstContact]` and
 * `contactZ[worstContact]` at the moment `slideAlong` refuses a step.
 *
 * The closing speed along the normal is what costs — a glancing blow has almost
 * none of it and a square one has all of it — and the tangential scrub against
 * the real lever arm is what knocks the nose round.
 *
 * There is no overlap test and no positional push: the walker resolves the step
 * before this is called and never lets a body end up inside a contact, so the
 * caller's own `got < reach` is the trigger and the position is already right.
 */
export const collideWorld = (
  state: DriveState,
  tuning: DriveTuning,
  selfX: number,
  selfZ: number,
  hitX: number,
  hitZ: number,
  out: Impact
): boolean => {
  const toX = hitX - selfX;
  const toZ = hitZ - selfZ;
  armAhead(state, tuning, toX, toZ, out);
  const armX = out.pushX;
  const armZ = out.pushZ;

  // The normal runs from the contact on the bodywork to the obstacle, not
  // between the two centres. There is no other party here whose normal has to be
  // the exact opposite of this one, so it can be the honest one — and it has to
  // be: between the centres, a post passing a metre down the machine's flank
  // reads as nearly head-on, and a scrape costs what a crash costs. Measured, a
  // post 45° off the nose costs 1.8 m/s of 15 that way and 12.0 the other.
  let gapX = toX - armX;
  let gapZ = toZ - armZ;
  const span = Math.hypot(gapX, gapZ);
  if (span < 1e-4) {
    out.hit = false;
    return false;
  }
  gapX /= span;
  gapZ /= span;

  out.hit = true;
  out.nx = gapX;
  out.nz = gapZ;
  out.pushX = 0;
  out.pushZ = 0;
  // Immovable: the pair's inverse mass is the machine's own.
  strike(state, tuning, gapX, gapZ, armX, armZ, -driveVelocityX(state), -driveVelocityZ(state), 1 / tuning.mass, out);
  return true;
};
