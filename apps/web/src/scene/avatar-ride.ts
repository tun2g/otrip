/**
 * A companion on a bike, drawn on a bike.
 *
 * `RemotePlayer` has carried `riding`, `heading` and `speed` for a while and
 * nothing drew any of them, so a friend doing 20 m/s was rendered as a jogger
 * covering 20 m/s — feet driven through the run clip at `MAX_CLIP_RATE` by the
 * distance they were measured to have moved. That is the single most visible
 * sign that multiplayer is not working, and it is what this file is for.
 *
 * The machine is the fleet's own rig, out of the fleet's own kit: one assembled
 * motorbike per seat in the room, built when the scene is, shown and hidden
 * rather than made and thrown away. Somebody mounting is a frame like any other
 * and must not be the frame that merges ninety parts of geometry or compiles a
 * shader — which is also why the kit is borrowed instead of a second set of
 * materials being built here.
 *
 * What the room does not send is a lean, a steering angle, a pitch or a wheel
 * rotation, and all four are derived here the way `vehicles.ts` derives them for
 * the fleet: off the rate the heading is turning, off the rate the height is
 * changing, and off `speed`.
 */
import { Group } from 'three';

import { createImpactor, tuneDrive, type Impactor } from './driving';
import { motorbikeBuild, PAINT } from './vehicle-builds';
import type { VehicleKit } from './vehicle-kit';
import { GRAVITY, SPECS, type VehicleKind } from './vehicle-specs';

/**
 * Seats in a room, from `trip.room.ts`'s own limit, which is the same eight
 * `avatars.ts` budgets rigged bodies for. Every one of them can be on a machine
 * at once, so every one of them gets a machine up front.
 */
const SEATS = 8;

/**
 * Metres the wheels sit clear of the surface, matching `vehicles.TYRE_LIFT`.
 * Not imported: that constant is private to the fleet and the number is a fact
 * about how a wheel is drawn, not a tuning the two have to share.
 */
const TYRE_LIFT = 0.01;

/**
 * How fast the derived quantities settle, per second.
 *
 * The room sends ten updates a second and `avatars.ts` eases between them, so
 * the heading arrives as a staircase: differencing it raw gives a yaw rate that
 * is zero for five frames and then enormous, which read as a bike snapping
 * upright and flicking back over. 6 is a sixth of a second, which is slower than
 * the 0.1 s between packets and so cannot see the staircase at all, and faster
 * than a bike takes to change its lean.
 */
const DERIVE_EASE = 6;

/**
 * Rad/s of yaw past which the lean is not believed.
 *
 * A companion who teleports — travelling to a landmark — arrives with a heading
 * that has nothing to do with the one before it, and `avatars.ts` snaps the
 * position rather than easing it. Differencing across that gives hundreds of
 * rad/s. 2 rad/s is 115°/s, which is a bike being thrown into a hairpin and is
 * well past anything `driving.ts` will produce at speed.
 */
const YAW_RATE_CAP = 2;

/** The lock the model actually has at the wheel, as `vehicles.place` clamps it. */
const STEER_CAP = 0.52;

/** Below this, m/s, the wheels are not turning and there is nothing to lean. */
const ROLLING = 0.2;

/** One companion's machine, as much of it as anything outside needs to touch. */
export type RiderRig = {
  /**
   * Puts the machine under a companion. `x`/`y`/`z` is where `avatars.ts` has
   * actually eased the body to — not the target the room sent, or the bike and
   * the rider it carries would drift apart by the whole of the easing error.
   */
  place: (x: number, y: number, z: number, heading: number, speed: number, delta: number) => void;
  /** Taken off the road and out of the picture, without being given up. */
  hide: () => void;
};

export type AvatarRides = {
  /**
   * The machines, in world space. The caller adds it to the scene itself, beside
   * `avatars.group` rather than inside it, for two separate reasons.
   *
   * It cannot go under the avatar it belongs to: an avatar's group carries the
   * rider's *view* yaw, and a bike points where the machine points — on a
   * left-hander those differ by the whole of the bend. And it must not go under
   * `avatars.group` either, because one child of that group means one player.
   * `probe/avatar-sync.ts` reads `group.children[0]` and `group.children.length`
   * to answer "is this companion in the room at all", and a machine sitting in
   * among the bodies silently makes both of those the wrong question.
   */
  group: Group;
  /**
   * A machine of this kind for this player, held until released. Null when every
   * seat's rig is already out, or when the kind is not one this builds — at
   * which point the walking body has to do, which is the old behaviour and not
   * a new failure.
   */
  claim: (id: string, kind: string) => RiderRig | null;
  release: (id: string) => void;
  /**
   * The riding companions as bodies a driven machine can hit. Rewritten in place
   * on every `place`, so this is read fresh each frame and never held.
   *
   * Only the ones actually being drawn are in it. A rig that has been claimed
   * but not yet placed is still at the origin, and a phantom motorbike in the
   * middle of the map is worse than a missing one.
   */
  traffic: () => readonly Impactor[];
  dispose: () => void;
};

/** What this can draw. Everything else falls back to the walking body. */
const DRAWN: VehicleKind[] = ['motorbike'];

type Seat = {
  rig: ReturnType<VehicleKit['assemble']>;
  body: Impactor;
  /** Who has it, or null while it is spare. */
  held: string | null;
  spin: number;
  /** Eased yaw rate, rad/s, and eased climb, metres risen per metre travelled. */
  yawRate: number;
  grade: number;
  /** Last frame's heading and height, to difference against. */
  wasHeading: number;
  wasY: number;
  /** Whether there is a last frame at all. */
  tracked: boolean;
};

/**
 * @param kit the fleet's own, from `Vehicles.kit`. Its materials are shared and
 *   its lifetime is the fleet's, so every rig here dies when the fleet does —
 *   which is the same teardown, and is why `dispose` below releases nothing the
 *   kit owns.
 */
export const createAvatarRides = (kit: VehicleKit): AvatarRides => {
  const group = new Group();
  group.name = 'avatar-rides';

  /**
   * A fixed sequence rather than the fleet's prng, so seat 3 is the same colour
   * every session and in every browser. It is the nearest this can get to a
   * per-person colour: the paint is baked into the merged vertex colours when
   * the rig is built, long before anybody has joined, so it cannot follow a
   * player the way `colourFor` does — but eight seats in eight colours still
   * tells two companions on bikes apart, and the name label says which is which.
   */
  const seats: Seat[] = [];
  for (let index = 0; index < SEATS; index += 1) {
    // `motorbikeBuild` still wants a prng — it dresses the rider out of it — so
    // each seat gets its own Lehmer sequence off its own index. Not shared with
    // the fleet's: drawing from that would make what the companions wear depend
    // on how many vehicles the quality tier happened to deal out.
    let state = index * 7919 + 1;
    const roll = () => {
      state = (state * 48271) % 2147483647;
      return state / 2147483647;
    };
    const rig = kit.assemble('motorbike', motorbikeBuild(PAINT[index % PAINT.length], false, roll, true));
    rig.group.name = `avatar-motorbike-${index}`;
    rig.group.visible = false;
    // The seated figure is the companion. It is the one thing a parked bike
    // hides and this never does: the walking body stands down for it.
    if (rig.rider) rig.rider.visible = true;
    if (rig.glow) rig.glow.visible = false;
    group.add(rig.group);
    seats.push({
      rig,
      body: createImpactor(),
      held: null,
      spin: 0,
      yawRate: 0,
      grade: 0,
      wasHeading: 0,
      wasY: 0,
      tracked: false,
    });
  }

  /** Whose seat is whose. */
  const held = new Map<string, Seat>();
  /** The bodies being drawn this frame, in place. */
  const bodies: Impactor[] = [];

  const spec = SPECS.motorbike;
  /**
   * The same numbers the machine the *player* rides is tuned from — `Spec` is a
   * `DriveSpec` structurally, which is the whole reason `driving-tuning.ts` takes
   * it that way. Taken rather than recomputed so a companion's bike cannot end
   * up a different size or a different weight from the one under the player.
   */
  const tuning = tuneDrive(spec);
  /**
   * The most a bike is leant over, and not a number anybody chose: `tuning.mu`
   * is the peak friction these tyres have on dry asphalt, and a two-wheeler
   * leans at exactly `atan(lateral/g)` — so the steepest lean the machine can
   * *make* is `atan(mu)`. On the Wave that is 0.963 g, which is 43.9°.
   *
   * A cap is needed because `speed × yawRate` is a derived product of two
   * network-supplied quantities and nothing guarantees their product is one this
   * machine could have produced. The fleet's own clamp is a flat 0.55 rad, which
   * is 31.5° and visibly short of where a bike really sits in a hairpin; it is
   * right for the fleet, whose lean comes off `speed² × curvature` and can blow
   * up on one bad road sample. Here the yaw rate is already bounded and eased, so
   * the honest limit is the physical one.
   */
  const leanCap = Math.atan(tuning.mu);
  const wheelbase = tuning.wheelbase;

  const park = (seat: Seat) => {
    seat.rig.group.visible = false;
    if (seat.rig.glow) seat.rig.glow.visible = false;
    if (seat.rig.tail) seat.rig.tail.material = kit.tailMaterial;
    seat.tracked = false;
    seat.yawRate = 0;
    seat.grade = 0;
    const at = bodies.indexOf(seat.body);
    if (at >= 0) bodies.splice(at, 1);
  };

  const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

  return {
    group,
    traffic: () => bodies,

    claim: (id, kind) => {
      const existing = held.get(id);
      if (existing) return rigFor(existing);
      if (!DRAWN.includes(kind as VehicleKind)) return null;
      const seat = seats.find((entry) => entry.held === null);
      if (!seat) return null;
      seat.held = id;
      held.set(id, seat);
      return rigFor(seat);
    },

    release: (id) => {
      const seat = held.get(id);
      if (!seat) return;
      park(seat);
      seat.held = null;
      held.delete(id);
    },

    dispose: () => {
      // The geometries and materials are the kit's, and the kit is the fleet's.
      // All this owns is the scene graph it built out of them.
      group.clear();
      held.clear();
      bodies.length = 0;
      seats.length = 0;
    },
  };

  function rigFor(seat: Seat): RiderRig {
    return {
      hide: () => park(seat),
      place: (x, y, z, heading, speed, delta) => {
        const rig = seat.rig;
        rig.group.visible = true;
        // Read before the position below overwrites it: this is where the
        // machine was drawn last frame, which is what the climb is measured over.
        const fromX = rig.group.position.x;
        const fromZ = rig.group.position.z;

        // The yaw rate, which is the whole of the lean and the steering, and the
        // climb, which is the pitch. Both are differences against last frame and
        // neither exists on the frame a companion appears or reappears, which is
        // what `tracked` is for — differencing against a zero leaves a bike on
        // its side at the moment it is first drawn.
        if (seat.tracked && delta > 0) {
          const turned = wrap(heading - seat.wasHeading) / delta;
          const rate = Math.abs(turned) > YAW_RATE_CAP ? 0 : turned;
          seat.yawRate += (rate - seat.yawRate) * (1 - Math.exp(-delta * DERIVE_EASE));
          // Metres risen per metre travelled, which is what the fleet's pitch is
          // taken from. Over the ground actually covered: dividing by the speed
          // the room *claims* puts a stationary companion on a cliff face.
          const ran = Math.hypot(x - fromX, z - fromZ);
          const climb = ran > 1e-3 ? (y - seat.wasY) / ran : seat.grade;
          seat.grade += (climb - seat.grade) * (1 - Math.exp(-delta * DERIVE_EASE));
        }
        seat.wasHeading = heading;
        seat.wasY = y;
        seat.tracked = true;

        rig.group.position.set(x, y + TYRE_LIFT, z);
        rig.group.rotation.y = heading;
        rig.group.rotation.x = -Math.atan(seat.grade);

        const rolling = Math.abs(speed) > ROLLING;
        /**
         * The angle a free body takes against the cornering force, which on two
         * wheels is the whole of it — the same form `vehicles.ts` leans the fleet
         * by, with `speed * yawRate` in place of `speed² * curvature` because a
         * companion has no centreline to have a curvature of. +Z rolls toward
         * −X, so the sign puts it into the corner.
         */
        const lateral = rolling ? speed * seat.yawRate : 0;
        rig.group.rotation.z = -Math.max(-leanCap, Math.min(leanCap, Math.atan(lateral / GRAVITY) * spec.leanGain));

        if (rig.steer) {
          // Ackermann off the yaw rate: the lock that would produce this rate at
          // this speed. Honest here in a way it is not for the local rider, who
          // can be sideways — a companion arrives as a position and a heading and
          // there is nothing in either that could describe a slide.
          const turn = rolling ? seat.yawRate / speed : 0;
          rig.steer.rotation.y = Math.max(-STEER_CAP, Math.min(STEER_CAP, Math.atan(wheelbase * turn)));
        }

        // Off `speed`, which is the one thing the room does tell us. The measured
        // ground speed `avatars.ts` derives is still the honest signal for a walk
        // cycle — nothing says whether somebody is running — but for a wheel it
        // is the worse of the two: it is the easing's own output, so a companion
        // whose packets are late has wheels that stall and then spin, while
        // `speed` is what their machine was actually doing when it was sent.
        seat.spin += (speed * delta) / spec.wheelRadius;
        rig.rearAxle.rotation.x = seat.spin;
        rig.frontAxle.rotation.x = seat.spin;

        if (rig.rider) {
          // The rider stays a little more upright than the machine, as the
          // fleet's do.
          rig.rider.rotation.z = -rig.group.rotation.z * 0.22;
        }
        // Lit with everything else: the kit's lamp and tail materials are shared,
        // so all this decides is whether this machine's own cone is drawn.
        if (rig.glow) rig.glow.visible = kit.lit() > 0.08;

        const body = seat.body;
        body.x = x;
        body.z = z;
        body.vx = Math.sin(heading) * speed;
        body.vz = Math.cos(heading) * speed;
        body.mass = tuning.mass;
        body.radius = tuning.radius;
        if (!bodies.includes(body)) bodies.push(body);
      },
    };
  }
};
