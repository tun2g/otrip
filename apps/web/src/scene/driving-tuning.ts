/**
 * One machine's numbers, derived once from its `Spec`.
 *
 * The point of this file is that almost nothing here is a new number. Eight
 * vehicle kinds already carry real dimensions and real per-kind tuning in
 * `vehicles.ts`, and four of the quantities the dynamics need — the tyres' peak
 * friction, the brakes' own strength, the brake bias and the yaw inertia — come
 * out of what is already written down. What a drawing genuinely cannot say is
 * the mass, the power, the drag area, the rolling resistance, the weight split,
 * the centre-of-mass height and which end is driven, and those seven are the
 * fields `Spec` has to gain.
 *
 * It also carries the engine's torque curve and the gearbox, which are a step's
 * worth of arithmetic rather than a derivation and would therefore belong in
 * `driving.ts`. They are here because the curve and the ratios are one design:
 * where the torque peaks is what decides where a gear should end, and a gearbox
 * cut for a different curve is cut wrong. Splitting them would put half the
 * justification in each file and leave neither readable.
 */
import { clamp, G } from './driving-state';

/**
 * kg/m³. Air at 30 °C and 1013 hPa, which is the delta and the coast: ρ =
 * p/(R·T) = 101325/(287·303). Tà Xùa at 1,400 m is thinner at about 1.03, worth
 * 11% more top speed up there, and not worth a field.
 *
 * Moved here from `driving.ts` — which still does the drag with it — because
 * `naturalTop` below has to solve the same drag balance to know what speed top
 * gear should be cut for.
 */
export const AIR = 1.165;

/**
 * What share of the available grip a vehicle uses when it is merely getting
 * along, which is what `Spec.grip` and `Spec.brake` record — the NPC fleet's
 * comfortable cornering and its comfortable braking, not the limit. Dividing by
 * it recovers the limit, and the four published tyre figures it has to agree
 * with say 0.55: a leaned motorbike on dry asphalt holds about 1.0 g
 * (5.2/9.81/0.55 = 0.96), a road car 0.85 (4.6 → 0.85), a light truck 0.6 to
 * 0.7 (3.3 → 0.61), a coach 0.5 to 0.6 (2.9 → 0.54). The same divisor turns
 * `Spec.brake` into the brake's own strength, and that cross-checks too: a Wave
 * gets 1.0 g of brake against 0.96 g of tyre, so it is tyre-limited by a hair,
 * which is what a bike with a front disc is; a bicycle gets 0.52 g against 0.54
 * of tyre, which is the brake being the weak link, which is what a bicycle is.
 *
 * **`mu` is a tyre figure and not a cornering figure, and the ridden machine's
 * `grip: 16.5` was chosen as though it were both.** The note in `vehicles.ts`
 * sizes it by `sqrt(mu·g·R)` — the whole friction circle pointed sideways — and
 * concludes a 125 m bend will hold 61.2 m/s. It will not. A steady corner has to
 * balance yaw, which with a mid-wheelbase centre of mass forces both axles to
 * make equal force, and it has to overcome drag, which levers load off the front
 * axle that then caps the pair. Measured, the machine gets 97% of `mu·g` at
 * 15 m/s, 85% at 25 and 59% at 49.6, and the long note on the load transfer in
 * `driving.ts` has the derivation and the closed form it was checked against.
 * Nothing is wrong with `mu`; what is wrong is reading it as a lateral limit.
 */
const CRUISE_SHARE = 0.55;

/**
 * Radius of gyration about the vertical axis, as a share of overall length.
 * Three measured machines: a 165 kg motorbike and rider is 40 kg·m², so 0.49 m
 * over 1.95 m of length = 0.25; a 1,500 kg saloon is about 2,500 kg·m², 1.29 m
 * over 4.3 = 0.30; a 12 t coach is about 1.5e5 kg·m², 3.54 m over 10.5 = 0.34.
 * One number for all three costs ±20% of yaw inertia, which moves how quickly a
 * slide starts and not whether it does.
 */
const GYRATION = 0.28;

/**
 * How far forward of the static weight split the brakes are biased. Brakes are
 * proportioned for the load under braking, not standing: the stop transfers
 * weight onto the front. 0.12 over `massBias` gives 62/38 on the Wave, 67/33 on
 * the car and 52/48 on the coach, which is where those three are built.
 */
const BRAKE_FORWARD = 0.12;

/**
 * m/s the governor holds.
 *
 * It was 25 — 90 km/h, the highest limit posted in Vietnam — on the reasoning
 * that the ridden machine never reached it anyway, since a 110 cc Wave's own
 * power and drag top out at 23.6. That reasoning was answered by measurement.
 *
 * **A top speed is not a journey.** Measured sustained over real road, the bike
 * holds 15.44 to 19.95 m/s depending on the destination; the carriageway is
 * about 1.13 times longer than the straight line a body on foot takes across
 * country; and `TRAVEL_SPEED` is a flat 14 m/s reached in 0.45 s. Point to
 * point, that made riding worth **1.01× running at Tà Xùa and 0.98× at Tràng
 * An** — a machine you get on to go slower. The player reported it twice before
 * the arithmetic was done the right way round, and they were right both times.
 *
 * 26 m/s — 94 km/h, a real 150 cc — was the first answer, and the player
 * rejected it too: they asked for **3× to 4×** running. So this is no longer a
 * motorbike that exists, and the comment should not pretend otherwise.
 *
 * 55 m/s is 198 km/h, and the boost's +8 takes it to 63 m/s, 227 km/h. Against
 * the 14 m/s travel stride and the 1.13 the carriageway costs over a straight
 * line, those are **3.48× and 3.98×** — the band that was asked for, with the
 * boost earning the top of it.
 *
 * The corner is what actually bounds the average, not this: at `grip` 5.2 a
 * 125 m bend held only 25.5 m/s, so raising the top alone would have produced a
 * machine that reached 198 km/h on a straight and then left the road at every
 * bend. The ridden machine's tyre limit goes up with the speed for that reason —
 * see the note on `mu` below and the `drive` spec in `vehicles.ts`.
 *
 * The engineering ceiling moved with it: the Colyseus room rejects any move
 * faster than `config.maxSpeed`, which is raised to 90 m/s to match, and
 * `ABSOLUTE_TOP` to 65. That bound is anti-nonsense rather than anti-cheat —
 * `handleRelocate` already grants any client a jump anywhere on the map twice a
 * second — so widening it gives away nothing that was being held.
 *
 * `driving.ts` cuts the drive force at this rather than clamping the speed, so a
 * machine with less power than it takes still finds its own top out of the power
 * and the drag — every vehicle but the ridden one is well under it.
 */
const SPEED_LIMIT = 55;

/**
 * Reverse, which is a rider walking it backwards and not a gear. 1 m/s is
 * walking pace, and it does not scale with mass: a vehicle that cannot back out
 * of a lane is the Hội An river bug in another costume.
 *
 * There is a gearbox below now, and reverse is still not in it. A xe máy has no
 * reverse gear — the rider puts their feet down and walks it — and the one
 * kinematic corner of this model is there so that a dead end is always escapable
 * at any power, including none. First gear backwards would be a different thing
 * that happens to look the same at 1 m/s and would break the moment the engine
 * had any say in it.
 */
const REVERSE_SPEED = 1;

/**
 * The engine's torque, against its own speed, as a share of the torque it makes
 * at peak power. `revs` is engine speed in the same units: 1 is peak power.
 *
 * This is the thing `driving.ts` did not have. Force there was `power / speed` —
 * a flat-power idealisation, which is the *envelope* of a gearbox with
 * infinitely many ratios: infinite torque at a standstill, peak power at every
 * speed, and therefore no reason for a gear to exist anywhere. A real
 * transmission touches that envelope once per gear, at peak power, and sits
 * under it everywhere else. That gap is what makes one gear right and the next
 * one wrong.
 *
 * It is the quadratic with three properties and no spare coefficients to argue
 * about: no torque at no revs, peak **power** at revs 1, and peak **torque** at
 * `TORQUE_PEAK`. Those three fix it completely — demanding the power peak at 1
 * gives `A + 2B + 3C = 0`, the torque peak at x gives `B = −2Cx`, and
 * normalising `τ(1) = 1` gives `A + B + C = 1`; at x = ¾ they come out as
 * `A = 0, B = 3, C = −2` exactly.
 *
 * So peak torque is 1.125× the torque at peak power and falls at three-quarter
 * revs, and against the two geared xe máy a Vietnamese rider actually buys that
 * is close: a Honda Winner X makes 11.5 kW at 9,000 rpm and 13.5 N·m at 7,000,
 * which is 1.11× at 0.78 revs, and a Yamaha Exciter 155 VVA 13.2 kW at 9,500
 * and 14.4 N·m at 8,000, which is 1.08× at 0.84. Both are six-speeds, which is
 * where `GEAR_COUNT` comes from.
 *
 * Floored at zero because the curve crosses it again at 1.5 revs and a negative
 * driving force is not an over-revving engine, it is a reversing one.
 */
export const engineTorque = (revs: number): number => Math.max(0, revs * (3 - 2 * revs));

/** Where `engineTorque` peaks, which is also where a shift should land you. */
export const TORQUE_PEAK = 0.75;

/**
 * Engine speed the limiter cuts the drive at, as a multiple of peak-power revs.
 *
 * Derived rather than borrowed from a bike's data sheet. The speed at which the
 * next gear up makes more force than the one you are in — the only shift point
 * that is not a matter of taste — falls out of `engineTorque` in closed form:
 * setting `τ(v/p)/p = τ(v/q)/q` for two gears peaking at `p` and `q` gives
 * `v = 1.5·p·q·(p+q)/(p² + pq + q²)`, and across this box's five steps that
 * lands the crossover between 1.11 and 1.16 revs. 1.15 is inside that band, so
 * the limiter and the ideal shift are the same event to within a percent, which
 * is what it means for a close-ratio box to be cut for its engine.
 *
 * It is what makes a low gear a low gear. Top gear's limiter is above the
 * governor and never arrives, so the governor is still what caps the machine;
 * first gear's is at 18.65 m/s on the ridden machine, under the roughly 22 m/s
 * a 20 m bend holds, and that is the whole answer to a ridge road — see
 * `GEAR_SPREAD`.
 */
export const REDLINE = 1.15;

/**
 * Six speeds, because the Winner X and the Exciter 155 both are — and the
 * measurement that was supposed to confirm that said the opposite, so the real
 * reason is the second one.
 *
 * `probe/driving-model.ts` runs four, five, six and eight over the same spread,
 * each shifted perfectly, and **four is the quickest**: 3.88 s to 150 km/h
 * against six's 4.32 and eight's 4.47. That is not the ratios, it is
 * `SHIFT_TIME` — three shifts cost 0.6 s with the clutch out where five cost
 * 1.0 — and by that measure the best gearbox is one gear.
 *
 * What a gear count actually buys is the **size of the step across a shift**,
 * which the same probe measures as the force before an upshift against the force
 * just after. Six speeds: the worst step is −2.7%, and three of the five are
 * gains. Four speeds: −20.3%, −13.6%, −7.1%. A fifth of the driving force
 * vanishing in one shift is a stumble, and on a machine with 3 g of grip whose
 * whole point is being ridden through bends, a stumble mid-corner is worse than
 * four tenths of a second on a drag strip. Eight speeds buys nothing — every
 * step is already a gain at six — and pays another 0.4 s of clutch for it.
 */
const GEAR_COUNT = 6;

/**
 * First gear against top, which is the one number that decides whether a
 * gearbox is worth having here.
 *
 * Top gear is not a choice: it is cut for `naturalTop`, the speed the power and
 * the drag agree on, so peak power arrives at the governor and the top speed is
 * whatever the machine's own physics says rather than whatever the box allows.
 *
 * 4.2 was first derived from the tyre. First gear wants to be as low as the rear
 * wheel can still use, its torque peak makes `1.125·P/peak`, the tyre holds
 * `μ·m·g`, and on the ridden machine as it then was — 175 kg on 0.59 m² — those
 * met at 13.31 m/s against a 55.9 m/s top, which is 4.20 exactly. **That
 * coincidence has since expired and the number has been kept anyway.** The
 * machine is now 230 kg on 0.32 m², so the tyre holds 6,900 N while first gear's
 * torque peak makes 4,300; restoring the old equality would want a spread of
 * 6.7.
 *
 * It is kept at 4.2 for two measured reasons, which are better reasons than the
 * coincidence was.
 *
 * **First gear's limiter lands under the speed a tight bend holds.** That is the
 * whole point of a gearbox here — see the note in `driving.ts` on why a flat
 * pull could not corner at all. A 20 m bend is what a ridge road is made of and
 * this tyre takes one at about 22 m/s; first gear's limiter is 18.65 m/s, and
 * measured on the fixed-radius run in `probe/driving-model.ts` first gear holds
 * that bend at 111% of its radius with the throttle wide open, where second runs
 * 149% wide and the automatic 751%. A spread of 6.7 would cap first at 11.6 m/s,
 * which holds the bend no better and is a gear you would be out of before the
 * apex.
 *
 * **And 6.7 would cost the smoothness six speeds were chosen for.** It widens
 * the steps from 1.43 to 1.57, which takes the worst force step across a shift
 * from −2.7% to about −11% — the thing `GEAR_COUNT` exists to keep small.
 *
 * What 4.2 gives up is launch grunt, and there is plenty to give: 4,300 N on
 * 230 kg is still 1.87 g off the line, where a real sportbike is wheelie-limited
 * at well under one.
 *
 * It is a constant and not derived per machine on purpose, because deriving it
 * from the tyre only means anything for something that can spin a wheel. A
 * bicycle's 243 W against its tyre would ask for a first gear peaking at
 * 0.65 m/s, which is not a gearbox, it is a winch. 4.2 is also where real bike
 * gearboxes sit, so one number serves the fleet and the fiction both: the
 * bicycle gets a 2.3 m/s granny gear and a 9.6 m/s top, which is a bicycle.
 */
const GEAR_SPREAD = 4.2;

/**
 * How much wider the step from first to second is than the step from fifth to
 * top. Every real box is cut this way round — the bottom gears are for starting
 * and the top ones for holding a speed — and 1.15 over five steps gives 1.43,
 * 1.38, 1.33, 1.29, 1.24.
 */
const GEAR_PROGRESSION = 1.15;

/**
 * Rad/s a stopped machine is walked round by the rider's own legs, and the mass
 * that is worth the whole of it. Carried over from `walker.ts` unchanged,
 * including the reason: measured at Hội An, riding north off the spawn put the
 * front wheel at the Thu Bồn, the step into the water was refused, the speed
 * went to nothing and with it the turn — and the only way out left was reverse.
 * 0.6 rad/s is 34°/s, about how long it takes to shuffle a Wave round in a lane.
 *
 * Scaled by what legs can actually shift, so the Wave keeps the whole 0.6, a
 * loaded cargo bike gets 0.49, and nobody paddles a coach.
 */
const PADDLE_RATE = 0.6;
const PADDLE_MASS = 200;

/** Dry asphalt is 1 by construction; everything else is measured against it. */
const GRIP_BARE = 0.62;
const GRIP_WET = 0.7;
const GRIP_MUD = 0.36;

/**
 * What a vehicle kind's `Spec` has to say for itself. Structural, so
 * `vehicles.ts` passes its own `SPECS[kind]` in with no import either way and
 * nothing is duplicated: `length`, `width`, the axles, `grip` and `brake` are
 * already there and are already sourced.
 */
export type DriveSpec = {
  length: number;
  width: number;
  /** Axle positions along Z from the vehicle's own origin, front positive. */
  frontAxle: number;
  rearAxle: number;
  /** Lateral acceleration it will take through a bend, m/s². The limit is `/CRUISE_SHARE`. */
  grip: number;
  /** Deceleration it brakes at in traffic, m/s². The limit is `/CRUISE_SHARE`. */
  brake: number;
  /** kg, as it is driven: kerb plus rider, passengers and whatever it is carrying. */
  mass: number;
  /** W at the driven wheel — the crank figure already through the drivetrain. */
  power: number;
  /** Cd·A, m². One number rather than two, because two is two guesses. */
  dragArea: number;
  /** Rolling resistance coefficient on a made surface. */
  rollCrr: number;
  /** Share of the static weight on the front axle. */
  massBias: number;
  /** Metres to the centre of mass, loaded. */
  cgHeight: number;
  /** Which end the power goes to. The buffalo counts as front-wheel drive. */
  driveFront: boolean;
};

/** Everything about a machine the dynamics need, resolved once from its spec. */
export type DriveTuning = {
  mass: number;
  /** kg·m² about the vertical axis. */
  yawInertia: number;
  /** Metres from the centre of mass to each axle. `lr` is negative. */
  lf: number;
  lr: number;
  wheelbase: number;
  cgHeight: number;
  /** Half-extents for the contact box, metres. */
  halfLength: number;
  halfWidth: number;
  /** Radius another body sees this one as, metres. */
  radius: number;
  power: number;
  dragArea: number;
  rollCrr: number;
  /** Peak tyre friction on dry asphalt. */
  mu: number;
  /** N the brakes can apply, before the tyres get a say. */
  brakeForce: number;
  /** Front share of the brake force. */
  brakeBias: number;
  driveFront: boolean;
  /**
   * The gearbox: road speed at which each gear reaches peak-power revs,
   * ascending, first gear first.
   *
   * Speeds rather than ratios, because a speed is what the step actually needs —
   * engine speed is `along / gears[gear - 1]` and the force is
   * `power · τ(revs) / gears[gear - 1]`, with no wheel radius, no final drive
   * and no rpm anywhere. The ratios are still in here and still read as a
   * gearbox: `gears[last] / gears[i]` is gear `i`'s ratio against top, and on
   * the ridden machine that is 4.20, 2.94, 2.13, 1.60, 1.24, 1.00.
   *
   * Each gear's own ceiling is `gears[i] · REDLINE`.
   */
  gears: readonly number[];
  /**
   * m/s at which each gear stops being the one that makes the most force, so
   * `shifts[i]` is the boundary between gear `i + 1` and gear `i + 2` and there
   * is one fewer of them than there are gears.
   *
   * This is what the automatic shifts on, and having it as a speed per boundary
   * rather than a rev threshold per gear is what makes hunting structurally
   * impossible: the gear it wants is a single-valued function of road speed, so
   * the upshift out of a gear and the downshift back into it are the *same*
   * number with only `SHIFT_GAP` between them, whatever the ratios are.
   *
   * The first version incremented the gear whenever the revs passed a threshold,
   * and it had both bugs that arrangement has. Measured, the Wave's 20% climb
   * fell from 12.97 m/s to 6.14 because the 0.2 s of lost drive in a shift cost
   * more speed on the hill than the 4% hysteresis the ratios happened to leave,
   * so the box sat at one boundary shifting up and down for ever; and the
   * buffalo cart's top speed fell from 1.04 m/s to 0.28, because first gear's
   * ideal shift point is past first gear's own limiter and the thing was waiting
   * at a speed it could never reach.
   */
  shifts: readonly number[];
  /**
   * m/s of hysteresis at each boundary in `shifts` — how far below it the speed
   * has to fall before the automatic will come back down through it.
   *
   * Derived, not chosen, because the thing it has to cover is the speed a shift
   * itself costs: the clutch is out for `SHIFT_TIME` with nothing driving, and a
   * box that loses more speed in a shift than its own hysteresis shifts straight
   * back and sits at the boundary for ever. See `shiftGaps`.
   */
  shiftGap: readonly number[];
  /** m/s the governor cuts drive at, before boost. */
  limit: number;
  /** m/s backwards, walking it. */
  reverse: number;
  /** Rad/s the rider's legs are worth at a standstill. */
  paddleRate: number;
};

/**
 * What the tyres have left, against dry asphalt.
 *
 * Wet asphalt is about 0.7 of dry and that is the figure everyone quotes; bare
 * ground is 0.62 of it dry, which is a hard dirt road's 0.55 against asphalt's
 * 0.9; wet bare ground is mud at 0.36. The fleet in `vehicles.ts` already slows
 * itself by `1 - wet*0.26` off the same `weather.rainIntensity`, so this is the
 * rider's half of the same weather.
 */
export const surfaceGrip = (made: boolean, wet: number): number => {
  const rain = clamp(wet, 0, 1);
  return made ? 1 + (GRIP_WET - 1) * rain : GRIP_BARE + (GRIP_MUD - GRIP_BARE) * rain;
};

/**
 * m/s the power and the drag agree on, which is what top gear is cut for.
 *
 * `P = ½ρ·CdA·v³ + Crr·m·g·v`, solved rather than guessed: Newton from the
 * cube root of the drag-only answer, which is already within a few per cent
 * because the rolling term is small at the top, and six iterations of a cubic
 * that well conditioned is exact to the last bit. Called once per vehicle.
 *
 * It is deliberately *not* clamped to the governor. On the ridden machine it
 * comes out at 55.9 against a 55 m/s governor, so peak power lands a metre a
 * second past the cut and the machine arrives at its limit pulling hard rather
 * than dying into it.
 */
const naturalTop = (spec: DriveSpec): number => {
  const drag = 0.5 * AIR * spec.dragArea;
  const roll = spec.rollCrr * spec.mass * G;
  let v = Math.cbrt(spec.power / drag);
  for (let n = 0; n < 6; n += 1) {
    v -= (drag * v * v * v + roll * v - spec.power) / (3 * drag * v * v + roll);
  }
  return v;
};

/**
 * The ratios, as the road speed each gear reaches peak-power revs at.
 *
 * A geometric run of steps whose product is `GEAR_SPREAD` and whose first is
 * `GEAR_PROGRESSION` times its last. Both constraints have closed forms: with
 * `s` steps and each `step[i] = first · q^i`, the progression fixes
 * `q = GEAR_PROGRESSION^(−1/(s−1))` and the spread then fixes `first`, because
 * the product of the run is `first^s · q^(s(s−1)/2)`.
 *
 * `count` is a parameter only so that `probe/driving-model.ts` can run four and
 * five speeds against six rather than taking `GEAR_COUNT` on trust. Nothing in
 * the app passes it.
 */
export const gearSpeeds = (top: number, count = GEAR_COUNT): number[] => {
  const steps = count - 1;
  const q = GEAR_PROGRESSION ** (-1 / (steps - 1));
  const first = (GEAR_SPREAD / q ** ((steps * (steps - 1)) / 2)) ** (1 / steps);
  const speeds = new Array<number>(count);
  speeds[steps] = top;
  for (let gear = steps - 1; gear >= 0; gear -= 1) speeds[gear] = speeds[gear + 1] / (first * q ** gear);
  return speeds;
};

/**
 * Seconds a shift takes, with the clutch out and nothing driving.
 *
 * A bike shift is a tenth to three tenths of a second depending on the rider and
 * whether there is a quickshifter; 0.2 is an ordinary good one. It costs the
 * same whoever asked for it, which matters: a manual rider cannot beat the
 * automatic by shifting *faster*, only by shifting **fewer times** and at better
 * moments. That is the whole skill and it is the real one.
 *
 * It doubles as the anti-hunt lockout, because an automatic that could shift
 * again before the clutch was home would oscillate on a gradient.
 */
export const SHIFT_TIME = 0.2;

/**
 * The share of a boundary's own speed that `shiftGaps` keeps back for the hill.
 *
 * Gravity along a slope is `g·sin θ` whatever the machine weighs, so it is the
 * one term in a shift's cost that no field of a `Spec` predicts and that has to
 * be allowed for as a fraction. Sized on the worst case the carriageway
 * allows — `GRADE_LIMIT`'s 26%, where gravity and the resistances come to about
 * 2.7 m/s², so a 0.2 s shift costs 0.54 m/s, which at the Wave's lowest
 * boundary — 6.46 m/s, measured — is 8.4%. The other term is the machine's own
 * resistances, and that one is derived.
 */
const SHIFT_GAP = 0.15;

/**
 * Where one gear hands over to the next.
 *
 * The crossover — the speed at which the next gear up starts making more force
 * than the one you are in — is the only shift point that is not a matter of
 * taste, and it falls out of `engineTorque` in closed form. Setting
 * `τ(v/p)/p = τ(v/q)/q` for gears peaking at `p` and `q`, the quadratic's common
 * factors cancel and leave `v = 1.5·p·q·(p + q)/(p² + pq + q²)`.
 *
 * Capped at the limiter, because an engine cannot be revved past it to reach an
 * ideal shift point. It bites on first gear only, whose crossover is at 1.164
 * revs against the limiter's 1.15 — and a box that waited for a speed its own
 * limiter forbids never leaves first gear at all.
 */
const shiftPoints = (gears: readonly number[]): number[] =>
  gears.slice(0, -1).map((p, i) => {
    const q = gears[i + 1];
    return Math.min((1.5 * p * q * (p + q)) / (p * p + p * q + q * q), p * REDLINE);
  });

/**
 * The hysteresis at each boundary, in m/s — two terms, one per cause.
 *
 * A shift costs speed: for `SHIFT_TIME` the clutch is out, nothing is driving,
 * and whatever is slowing the machine goes on slowing it. If that loss is larger
 * than the hysteresis then the downshift test is true the instant the clutch
 * comes home, and the box shifts back, and then up again, for ever. Measured
 * before this existed: the buffalo cart's top speed on the flat fell from
 * 1.04 m/s to 0.29, because it loses a third of its first boundary's speed in
 * every shift — 0.045 of rolling resistance against 485 W is a machine that
 * cannot afford a clutch at all.
 *
 * So the second term **is** that loss, out of the machine's own resistances at
 * the boundary speed: `(Crr·g + ½ρ·CdA·v²/m) · SHIFT_TIME`. It is what makes one
 * rule cover a 12-tonne coach and a cyclo, where a fraction of the speed cannot.
 *
 * The first term is for the hill, where the loss is gravity's and does not scale
 * with anything in the spec: 15% of the boundary speed covers `GRADE_LIMIT`'s
 * 26% — about 2.7 m/s² of gravity and resistance, so 0.54 m/s in a 0.2 s shift,
 * which at the Wave's lowest boundary of 6.46 m/s is 8.4%. It costs the rider
 * 2.3 m/s of dead band at the ridden machine's first-to-second boundary, which
 * is what an automatic gearbox feels like.
 */
const shiftGaps = (spec: DriveSpec, shifts: readonly number[]): number[] =>
  shifts.map((v) => SHIFT_GAP * v + (spec.rollCrr * G + (0.5 * AIR * spec.dragArea * v * v) / spec.mass) * SHIFT_TIME);

/** Called once per vehicle, never per frame. */
export const tuneDrive = (spec: DriveSpec): DriveTuning => {
  const wheelbase = spec.frontAxle - spec.rearAxle;
  // The centre of mass sits where `massBias` puts it, measured from the axles
  // rather than from the drawing's origin — which on a truck or a coach is not
  // mid-wheelbase at all.
  const lf = (1 - spec.massBias) * wheelbase;
  const lr = -spec.massBias * wheelbase;
  const legs = Math.min(1, PADDLE_MASS / spec.mass);
  // Capped at the governor, because a gear above it is a gear nobody can reach.
  // The ridden machine's power and drag agree on 68.12 m/s while the governor
  // cuts at 55, and measured before this cap the automatic topped out in **fifth**
  // with sixth never selected at all — a six-speed with five usable gears. Cut
  // for the governor instead, top gear's peak power lands exactly where the
  // machine is actually allowed to run.
  const gears = gearSpeeds(Math.min(naturalTop(spec), SPEED_LIMIT));
  const shifts = shiftPoints(gears);

  return {
    mass: spec.mass,
    yawInertia: spec.mass * (GYRATION * spec.length) ** 2,
    lf,
    lr,
    wheelbase,
    cgHeight: spec.cgHeight,
    halfLength: spec.length / 2,
    halfWidth: spec.width / 2,
    // The mean half-extent. A circle is wrong for a 10.5 m coach and right for
    // everything the walker's own world is made of, which is circles; the box in
    // `driving-collision.ts` is what keeps the contact itself honest.
    radius: (spec.length + spec.width) / 4,
    power: spec.power,
    dragArea: spec.dragArea,
    rollCrr: spec.rollCrr,
    mu: spec.grip / (G * CRUISE_SHARE),
    brakeForce: (spec.mass * spec.brake) / CRUISE_SHARE,
    brakeBias: Math.min(0.85, spec.massBias + BRAKE_FORWARD),
    driveFront: spec.driveFront,
    gears,
    shifts,
    shiftGap: shiftGaps(spec, shifts),
    limit: SPEED_LIMIT,
    reverse: REVERSE_SPEED,
    paddleRate: PADDLE_RATE * legs,
  };
};
