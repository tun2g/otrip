/**
 * What each kind of vehicle is, as numbers.
 *
 * Lifted out of `vehicles.ts` whole, because three files now need it and none of
 * them needs the other two: the builders in `vehicle-builds.ts` read the wheel
 * radius and the axles to draw a machine, `vehicle-kit.ts` reads them again to
 * hang the drawing on its pivots, and `avatar-ride.ts` reads the mass, the
 * length and `leanGain` to put a companion's bike where the room says it is.
 * `driving-tuning.ts` takes the same table structurally, as a `DriveSpec`, with
 * no import either way — which is the one reason none of these numbers is
 * written down twice.
 */

import type { RoadKind } from './road-network';

export const GRAVITY = 9.81;

export type VehicleKind =
  | 'motorbike'
  | 'motorbike-cargo'
  | 'car'
  | 'truck'
  | 'coach'
  | 'bicycle'
  | 'cyclo'
  | 'buffalo-cart';

export type Spec = {
  length: number;
  width: number;
  wheelRadius: number;
  /** Axle positions along Z, from the vehicle's own origin. */
  frontAxle: number;
  rearAxle: number;
  /**
   * Roll into a bend, as a multiple of the angle a free body would take. A
   * motorbike leans the whole of it; a car's suspension lets the body roll a
   * little the *other* way, which is why this is negative on four wheels.
   */
  leanGain: number;
  /** m/s on an open straight. */
  cruise: number;
  /** Lateral acceleration it will take through a bend, m/s². */
  grip: number;
  accel: number;
  brake: number;
  /**
   * What `driving.ts` needs that a drawing does not.
   *
   * `accel` above is still what the NPC fleet uses — it drives a target speed
   * approached at a constant rate, which is all a vehicle on rails needs. A
   * machine somebody is *holding the throttle of* is a different problem: the
   * force available has to fall as the speed rises, or the top speed is a clamp
   * rather than a balance, and a clamp is what made the ridden bike slower than
   * a jog. So these describe the machine and the top speed falls out.
   *
   * `mass` is kerb weight plus a rider. `power` is at the wheel, in watts.
   * `dragArea` is Cd·A in m². `rollCrr` is the rolling resistance coefficient.
   * `massBias` is the share of the mass on the front axle at rest, which with
   * `cgHeight` decides how much load moves under braking and acceleration —
   * that transfer is what makes the back end let go. `driveFront` says which
   * axle is driven, and is the reason a car understeers out of a corner where a
   * motorbike steps the rear out.
   */
  mass: number;
  power: number;
  dragArea: number;
  rollCrr: number;
  massBias: number;
  cgHeight: number;
  driveFront: boolean;
  steersFront: boolean;
  /** Whether the headlight turns with the bars. True only on two wheels. */
  lampOnSteer: boolean;
  /** Metres it wants between its nose and the tail in front. */
  gap: number;
  roads: RoadKind[];
};

export const SPECS: Record<VehicleKind, Spec> = {
  // Honda Wave: 1.95 m over the mudguards, 1.24 m wheelbase, 17-inch wheels. The
  // whole fleet is scaled against this one because it is what there are most of.
  motorbike: {
    length: 1.95,
    width: 0.72,
    wheelRadius: 0.215,
    frontAxle: 0.62,
    rearAxle: -0.62,
    leanGain: 1,
    cruise: 11.5,
    grip: 5.2,
    accel: 3.4,
    brake: 5.4,
    mass: 165,
    power: 5280,
    dragArea: 0.59,
    rollCrr: 0.02,
    massBias: 0.5,
    cgHeight: 0.55,
    driveFront: false,
    steersFront: true,
    lampOnSteer: true,
    gap: 6,
    roads: ['main', 'secondary', 'lane', 'trail'],
  },
  'motorbike-cargo': {
    length: 1.95,
    width: 0.98,
    wheelRadius: 0.215,
    frontAxle: 0.62,
    rearAxle: -0.62,
    leanGain: 0.82,
    cruise: 8.4,
    grip: 3.9,
    accel: 2.1,
    brake: 4.2,
    mass: 245,
    power: 5280,
    dragArea: 0.78,
    rollCrr: 0.022,
    massBias: 0.44,
    cgHeight: 0.62,
    driveFront: false,
    steersFront: true,
    lampOnSteer: true,
    gap: 7,
    roads: ['main', 'secondary', 'lane'],
  },
  car: {
    length: 4.3,
    width: 1.8,
    wheelRadius: 0.31,
    frontAxle: 1.3,
    rearAxle: -1.3,
    leanGain: -0.2,
    cruise: 13.5,
    grip: 4.6,
    accel: 2.6,
    brake: 5.8,
    mass: 1240,
    power: 67000,
    dragArea: 0.65,
    rollCrr: 0.012,
    massBias: 0.55,
    cgHeight: 0.52,
    driveFront: true,
    steersFront: true,
    lampOnSteer: false,
    gap: 11,
    roads: ['main', 'secondary'],
  },
  truck: {
    length: 5.4,
    width: 1.95,
    wheelRadius: 0.33,
    frontAxle: 1.52,
    rearAxle: -1.28,
    leanGain: -0.3,
    cruise: 10.4,
    grip: 3.3,
    accel: 1.4,
    brake: 4.2,
    mass: 3400,
    power: 66000,
    dragArea: 2.6,
    rollCrr: 0.008,
    massBias: 0.44,
    cgHeight: 0.95,
    driveFront: false,
    steersFront: true,
    lampOnSteer: false,
    gap: 15,
    roads: ['main', 'secondary', 'lane'],
  },
  coach: {
    length: 10.5,
    width: 2.5,
    wheelRadius: 0.52,
    frontAxle: 3.1,
    rearAxle: -2.1,
    leanGain: -0.34,
    cruise: 12,
    grip: 2.9,
    accel: 1,
    brake: 3.6,
    mass: 12000,
    power: 246000,
    dragArea: 4.1,
    rollCrr: 0.007,
    massBias: 0.4,
    cgHeight: 1.4,
    driveFront: false,
    steersFront: true,
    lampOnSteer: false,
    gap: 24,
    /**
     * Trunk roads only, now that the roads actually bend.
     *
     * Measured once `road-network` started producing real curvature: a rigid
     * 10.5 m body at the lane offset, yawed to the centreline tangent, needs a
     * centreline radius of 28 m to stay inside its own lane and 24 m to stay
     * inside the kerbs at all. Main roads are 7 m wide and their tightest bends
     * came out at 29 m (Hội An), 31 m (Tràng An) and 63 m (Hồ Tây), so a coach
     * fits — just. A secondary road is 5.5 m, which leaves the body far less to
     * swing into: the requirement there is 108 m, against a tightest 91 m at
     * Hội An, 58 m at Hồ Tây and 36 m at Tràng An.
     *
     * The alternative was to straighten the secondary roads back out to suit the
     * longest vehicle in the fleet, which is the wrong way round — a 10.5 m coach
     * on a 5.5 m village road was never plausible, and the kind of road it is is
     * the honest reason it does not go there. Where a destination has no trunk
     * road the roster substitutes a xe máy, which it already did for a location
     * with nothing sealed at all.
     */
    roads: ['main'],
  },
  bicycle: {
    length: 1.75,
    width: 0.56,
    wheelRadius: 0.34,
    frontAxle: 0.53,
    rearAxle: -0.52,
    leanGain: 0.85,
    cruise: 4.6,
    grip: 2.9,
    accel: 1.3,
    brake: 2.8,
    mass: 80,
    power: 243,
    dragArea: 0.4,
    rollCrr: 0.005,
    massBias: 0.45,
    cgHeight: 1.0,
    driveFront: false,
    steersFront: true,
    lampOnSteer: true,
    gap: 4,
    roads: ['main', 'secondary', 'lane'],
  },
  cyclo: {
    length: 2.9,
    width: 1.22,
    wheelRadius: 0.33,
    frontAxle: 0.95,
    rearAxle: -1.05,
    leanGain: 0.12,
    cruise: 3.3,
    grip: 2.3,
    accel: 0.9,
    brake: 2.4,
    mass: 170,
    power: 171,
    dragArea: 0.9,
    rollCrr: 0.012,
    massBias: 0.62,
    cgHeight: 0.85,
    driveFront: false,
    steersFront: false,
    lampOnSteer: false,
    gap: 6,
    roads: ['secondary', 'lane'],
  },
  'buffalo-cart': {
    length: 4.2,
    width: 1.62,
    wheelRadius: 0.6,
    frontAxle: 1.9,
    rearAxle: -0.3,
    leanGain: 0,
    cruise: 1.1,
    grip: 1.5,
    accel: 0.5,
    brake: 1.4,
    mass: 1050,
    power: 485,
    dragArea: 2.2,
    rollCrr: 0.045,
    massBias: 0.25,
    cgHeight: 1.1,
    driveFront: false,
    steersFront: false,
    lampOnSteer: false,
    gap: 9,
    roads: ['lane'],
  },
};
