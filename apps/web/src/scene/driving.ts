/**
 * What a driven vehicle does, as forces. No scene graph, no DOM, no world
 * queries — the walker keeps all three, because it is the only file that knows
 * what is under the wheels, and `vehicles.ts` keeps the drawing. This owns the
 * one thing neither of them had: a model in which the top speed falls out of the
 * power against the drag, the grip runs out before the steering does, and a hit
 * is an impulse rather than a multiplication.
 *
 * This is the public face of four files, so one import reaches all of it:
 * `driving-state.ts` holds what a machine is doing, `driving-tuning.ts` turns a
 * vehicle `Spec` into numbers, `driving-collision.ts` resolves a contact, and
 * this one integrates the step.
 *
 * It replaces three fudges at once.
 *
 * `RIDER_TOP = 9` was a clamp, and the user's complaint is that 9 m/s is 0.64 of
 * the 14 m/s travel stride: the machine was slower than running. There is no
 * clamp here below the governor — a Honda Wave 110 makes 6 kW and carries
 * 0.59 m² of drag area, and 23.6 m/s is where those two meet, which is the real
 * machine's 85 km/h and 1.69× the travel stride.
 *
 * `HILL_COST`/`HILL_FLOOR` scaled the target speed by the gradient and floored
 * it at 0.35, which is a stand-in for gravity along the slope. Gravity along the
 * slope is one term and it is in here, so the hill answer is now a consequence
 * rather than a guess — and a better one: the floor said a 0.60 gradient left a
 * Wave 3.15 m/s, where the force balance says 6.0, and on the 0.26 that
 * `road-network` actually cuts a carriageway to it says 11.0.
 *
 * `rideSpeed *= got / reach` is gone into `driving-collision.ts`.
 *
 * And it replaces a fourth, which arrived with the player's answer to the three
 * above: "xe sẽ không cố định tốc độ nha, sẽ có nhiều mode để tăng tốc" — the
 * bike should not have one fixed speed, there should be modes for accelerating.
 * `power / speed` was flat power, which is the envelope of a gearbox with
 * infinitely many ratios and therefore has no gears in it at all: infinite
 * torque at a standstill and peak power at every speed. There is a real torque
 * curve and a real six-speed box now, in `driving-tuning.ts`, and the limiter in
 * a low gear is what finally makes a ridge road rideable — measured on the flat
 * pull, the ridden machine at full throttle and full lock could not be made to
 * turn inside 191 m, which is why Tà Xùa and Tràng An collapsed to 8.44 and
 * 4.31 m/s sustained when the power went up. A gear is a speed limiter, and
 * measured on a 20 m bend held at full throttle, first gear keeps the machine on
 * it at 111% of its radius where the automatic runs 751% wide.
 *
 * Integration is explicit, so it is substepped internally at `DRIVE_STEP`: the
 * yaw equation's tyre damping is stiff at low speed — `(lf² + lr²)·C / (Iz·u)`
 * reaches 71 s⁻¹ for the Wave at the `CRAWL` floor — and the walker hands out
 * deltas of up to 0.1 s. Measured, a simulated minute at 60, 30, 15 and 10 fps
 * agrees on heading to 0.00° and on speed to 0.0000 m/s. A model that explodes
 * on a long frame explodes on a slow phone.
 */
import {
  ABSOLUTE_TOP,
  clamp,
  CRAWL,
  G,
  REVERSE_MAX,
  type DriveInput,
  type DriveState,
  type DriveSurface,
} from './driving-state';
import { AIR, engineTorque, REDLINE, SHIFT_TIME, TORQUE_PEAK, type DriveTuning } from './driving-tuning';

/**
 * Slip angle at which a tyre has given everything it has. A road tyre is done at
 * 8 to 10°; this is 9.2°. The brush-model curve below rises to the limit with an
 * initial slope of `3/SLIP_SAT`, so this also sets the cornering stiffness:
 * 3·0.96·809/0.16 = 14.6 kN/rad per axle on the Wave, which is the right order
 * for a 100-section tyre at 80 kg of load.
 */
const SLIP_SAT = 0.16;

/**
 * How much later a tyre saturates on bare ground. Loose surfaces build lateral
 * force over a much wider slip angle than asphalt — a tyre on gravel is still
 * gaining at 15 to 20° — which is why a dirt slide is lazy and an asphalt one
 * snaps.
 */
const LOOSE_SLIP = 1.6;

/** How much more a tyre costs to roll on bare ground than on a made surface. */
const ROLL_LOOSE = 3;

/**
 * Grip moved off the front axle and onto the rear, so that the front runs out
 * first. The linear bicycle model with load-proportional stiffness is exactly
 * neutral — `Wf/Cf = Wr/Cr = SLIP_SAT/3μ` whatever the weight distribution — and
 * every vehicle sold is built to understeer instead, because a driver who lifts
 * mid-corner in something that oversteers is a driver in a hedge. 6% is a gentle
 * push: the front washes out a little before the rear does, and the throttle,
 * the brakes and the handbrake can all still overturn it.
 */
const GRIP_BIAS = 0.06;

/**
 * The most lateral acceleration a two-wheeler can use, as a multiple of g —
 * which is the tangent of the furthest it can lean.
 *
 * This is the one place the model has to stop being a planar two-axle vehicle
 * and admit what it is. A car corners on its tyres; **a motorbike corners by
 * leaning**, and the lateral acceleration it can hold is `g·tan(lean)` whatever
 * the tyre underneath would allow. A road sportbike runs out of ground clearance
 * at about 50°, which is 1.19 g; a racer on slicks reaches 60 to 64°, 1.73 to
 * 2.05. **1.8 is 61°**, which is the top of what a racing motorcycle actually
 * achieves, and generous for something with a step-through's bodywork — but this
 * machine is already a fiction with 62 kW, and the measurement below is what
 * chose it rather than taste.
 *
 * `grip: 16.5` asks for 3.06 g. **No two-wheeler can use 3.06 g: it would have
 * to lean 72°.** Nothing in the model objected, so it used it, and the three
 * things the player reported are all that: a lateral force so large against a
 * 68.6 kg·m² yaw inertia that the machine snapped round inside half a second
 * ("ôm cua quá"), a response that swung 5.5× across the speed range because the
 * tyre saturated at the bottom of it and not at the top ("nhạy cảm tốc độ"), and
 * a braked machine with 16 rad/s of yaw authority and a rear axle too light to
 * argue ("mất kiểm soát").
 *
 * Swept against the two things it trades off, with everything else fixed. At
 * 1.43 g no gear could hold a 20 m bend at all — first ran 146% wide — which
 * makes a ridge road unrideable in the other direction. At 2.3 g both first and
 * second hold it but the brake-and-lock spin peaks at 14.1 rad/s. 1.8 holds the
 * bend in first at 109% of its radius and peaks at 11.8, and every value tested
 * recovers to 0.000 rad/s at every speed from 5 to 45 m/s. Second running wide
 * on a 20 m bend at 1.8 is not a defect: second is for a 30 m bend, and that is
 * the gear choice being worth something.
 *
 * It is applied to the **lateral** room only, so the friction budget becomes an
 * ellipse rather than a circle: the full `mu` lengthways, because braking and
 * traction do not need lean and the 3 g stop and the 1.87 g launch are real and
 * wanted, and `LEAN_LIMIT` sideways. That asymmetry is the physical difference
 * between a machine that leans and one that does not, and it is why this is here
 * rather than in a lowered `Spec.grip` — lowering the grip would have taken the
 * brakes and the drive down with it.
 */
const LEAN_LIMIT = 1.8;

/**
 * Radians of lock, and how fast the hands get there. 0.52 is 30°, the same cap
 * `vehicles.ts` clamps the drawn steering node to, so nothing asks for a wheel
 * angle the rig cannot show. 4 rad/s is a quick save — half a second of
 * lock-to-lock on a motorbike is 2 rad/s, and catching a slide is faster.
 */
const STEER_LOCK = 0.52;
const STEER_RATE = 4;

/**
 * How far past saturation the front tyre may be asked to go — the half-width of
 * the steering window, in multiples of `SLIP_SAT`. Exactly 1 would mean a player
 * holding the stick hard over got the tyre's peak and never more, which is safe
 * and deletes the thing the user asked for: the front washing out. A quarter
 * more is enough rope for it to run wide and still be a steering input rather
 * than a gamble.
 */
const STEER_MARGIN = 1.25;

/** m/s by which the rider's legs have stopped being what turns it. */
const PADDLE_FADE = 1;

/**
 * m/s² a rider walks it backwards at. Reverse is the one kinematic corner of the
 * model — approached at a rate rather than pushed by a force, because a rider's
 * 200 N means nothing to a coach and the point of reverse is that there is
 * always a way out of a dead end.
 */
const PADDLE_ACCEL = 1.2;

/** Throttle under which the drivetrain is dragging rather than driving. */
const THROTTLE_DEAD = 0.02;

/**
 * What a closed throttle drags, as a share of the torque the engine makes at
 * peak power, and the most it may come to.
 *
 * Pumping and friction losses are roughly a tenth to a sixth of full-load torque
 * at the same revs, so 0.15 of peak-power torque — 13% of the peak — rising
 * linearly with revs. The old number was 0.5, and the old comment said why: "a
 * model with no gears has nothing to tell it which ratio it is in, so the share
 * is set high and capped". There is a gearbox now, so the share is the real one
 * and the ratio does the rest.
 *
 * What that bought is the thing the old comment was reaching for and could not
 * reach. It claimed the Wave got "a bike in top and a bike in third"; measured,
 * it gave 0.8 m/s² at 20 m/s and 1.2 at 5 whatever gear the rider was in. Now,
 * measured on the same machine, it is **0.17 m/s² coasting at 20 m/s in top and
 * 0.72 at 5 m/s in first** — a bike in top and a bike in first — and a low gear
 * holding a descent back is the other half of why a ridge road is ridden in one.
 * The ridden machine's 62 kW makes that 0.33 and 1.19. A freewheel still falls
 * out of the same line without a flag: a bicycle's 243 W measures 0.04 m/s² in
 * top and 0.42 in its granny gear.
 */
const ENGINE_BRAKE = 0.15;
const ENGINE_CAP = 1.2;

/**
 * Share of the brake that pulling back on the throttle gives you. Back is still
 * the brake, because a player who pulls back expects to slow down and because
 * that is what the single axis did before there was a brake button; the
 * dedicated brake is stronger, which is the reason to reach for it.
 */
const PADDLE_BRAKE = 0.55;

/**
 * Seconds the load takes to move fore and aft. Real suspension, and it is also
 * what keeps the explicit integrator honest: the axle loads are computed from
 * the previous substep's surge, and a lag makes that lag physical rather than a
 * numerical artefact.
 */
const SURGE_LAG = 0.05;

/**
 * How much of the rear's friction circle a locked rear wheel actually takes.
 *
 * On four wheels a handbrake pulls a cable and the wheels stop, so 1 would be
 * right. On two it is the rear brake pedal, and a rider who genuinely locks the
 * rear at speed is not drifting, they are lowsiding — what a rider does is stab
 * and modulate it. Set at 1, measured on this model, the longest stab a xe máy
 * could be recovered from at 15 m/s was 0.3 s and 0.4 s was a spin with no way
 * back; the mechanic was a trap rather than a skill. Leaving a fifth of the
 * rear's grip is a rider feathering the pedal, which is what the input is.
 */
const HANDBRAKE_BITE = 0.8;

/**
 * How much of an axle's friction circle the foot brake may take, leaving the
 * rest for the tyre to steer with.
 *
 * `HANDBRAKE_BITE`'s argument, applied to the brake that is on all the time: a
 * locked wheel is not more braking, it is less braking and no steering. 0.85 is
 * a rider who can feel the tyre and an anti-lock system that targets the peak
 * rather than the lock, and it leaves `sqrt(1 − 0.85²) = 0.53` of the circle for
 * cornering — which is what stops a braked machine having a rear axle with
 * nothing in any direction.
 */
const BRAKE_BITE = 0.85;

/**
 * Boost: what it is worth, what fills it, and what empties it.
 *
 * It charges by drifting and by drafting because those are the two skills a
 * racing game is about, so the mechanic teaches itself — you earn the straight
 * by how well you took the corner, and by how close you dared sit to the bike in
 * front. Nothing charges it for merely holding the throttle open, which would
 * make it a second gear rather than a reward.
 *
 * The drift rate was 0.17/s to begin with, on the reading that six seconds of
 * sliding is a fair price. Measured, nobody slides for six seconds: a clean
 * 0.25 s stab-and-catch on a xe máy is about six tenths of a second of slide and
 * earned 6% of the meter, so filling it took seventeen corners. 0.45 made one
 * stab worth 16% and filled the meter in seven, which is a lap.
 *
 * Re-measured once the gearbox arrived, the same stab-and-catch earns 36% and
 * three of them fill it — and that is not the meter having changed. The catch
 * holds a quarter throttle, which used to deliver the whole of the engine's
 * force, because the flat-power term read only whether the throttle was past
 * `THROTTLE_DEAD`; it now delivers a quarter of it. So the machine is caught in
 * a low gear with the rear still working, which is more drift and less scrabble.
 * A slipstream fills it in 10.7 s, and 0.33/s of drain spends it in three. A hand off the
 * button keeps whatever is left, and `BOOST_ARM` stops it being stuttered a
 * tenth at a time.
 *
 * 60% more power is 17% more top speed, because top speed goes as the cube root
 * of power: the Wave's 23.6 m/s becomes 27.14 measured through the gearbox, a
 * little under the 27.99 flat power gave it, because a real box sits under that
 * envelope between its gears. The governor is lifted by `BOOST_TOP` so the
 * faster machines can use it too, and the ridden machine measures **63.00 m/s
 * boosted against 55.00 governed** — the pair the player asked for and the pair
 * the gearbox had to leave exactly alone.
 *
 * The worst case anywhere, every kind on every descent with the boost lit and a
 * slipstream, measures 65.000, which is `ABSOLUTE_TOP` to the millimetre, and
 * the room rejects nothing under `config.maxSpeed`'s 90.
 */
const BOOST_DRIFT = 0.45;
const BOOST_DRAFT = 0.125;
/**
 * The share of the governed top at which the meter charges at full rate.
 *
 * `pace` used to be `speed / tuning.limit`, which quietly tied the reward to a
 * number that has since trebled: the governor went from 25 m/s to 55, so a drift
 * at a village 20 m/s fell from 0.80 of full rate to 0.36 without anybody
 * touching the meter. The pace term is there to stop a machine earning boost
 * while it is barely moving, not to insist a rider be near 200 km/h before a
 * slide counts, so it saturates at a third of the top — 18.3 m/s — and a corner
 * taken properly at any sane road speed charges at the full rate.
 */
const BOOST_PACE = 0.33;
const BOOST_DRAIN = 0.33;
const BOOST_ARM = 0.25;
const BOOST_POWER = 0.6;
/**
 * m/s the boost adds to the governor. It was 3 against a 26 m/s limit; at 55 it
 * has to grow with it or lighting the meter is a rounding error. 8 is what takes
 * the top from 3.48× a running body to 3.98×, which is the top of the band the
 * player asked for — so the fourfold is the thing you earn by drifting, not the
 * thing you get for holding the throttle.
 */
const BOOST_TOP = 8;
/** How fast the flare lights and dies, for whatever `vehicles.ts` hangs on it. */
const BOOST_RAMP = 6;

/**
 * Body slip angle at which a slide starts counting as a drift, and where it
 * counts fully. 0.10 rad is 5.7°, which is past anything a tracking vehicle
 * carries; 0.45 is 26°, which is properly sideways.
 */
const DRIFT_SLIP = 0.1;
const DRIFT_FULL = 0.45;

/**
 * How much of its drag a vehicle loses sitting in another's wake. Measured on
 * cars at close quarters the trailing vehicle sees 25 to 40% less; a third is
 * the honest middle, and it makes `draft` do its physical job as well as its
 * game one.
 */
const DRAFT_SHELTER = 0.35;

/**
 * Seconds per integration substep. 1/240 keeps the stiffest term in the model —
 * the yaw damping at the `CRAWL` floor, 71 s⁻¹ on the Wave and 49 on a bicycle —
 * a factor of six inside the explicit stability bound of 2/h, which is what
 * makes a 10 fps frame and a 60 fps frame land in the same place. It is about
 * sixty floating-point operations a substep for one vehicle, so the walker's
 * worst 0.1 s frame costs twenty-four of them and nothing measurable.
 */
const DRIVE_STEP = 1 / 240;

/**
 * Revs the automatic will not let the engine fall below with the throttle shut:
 * where the torque curve has come back down to its peak-power value, which is
 * the bottom of the usable range and where a gearbox should give up on a gear.
 *
 * It is both ends of the **upshift** schedule's interpolation and the whole of
 * the downshift's, which is the asymmetry `autoShift` is built on. Shut, the box
 * upshifts out of a gear as soon as the one above will pull — on the ridden
 * machine that is 9.5 m/s into second — and that is what keeps the engine quiet
 * and the engine braking gentle for somebody pottering through Hội An. Wide open
 * it holds each gear to `tuning.shifts`, the crossover, and takes every newton
 * there is. Coming back down it is this end and only this end, whatever the
 * throttle is doing, because that is what makes hunting impossible.
 */
const AUTO_LUG = 0.5;

/**
 * How fast the gearbox believes a change of throttle, in reciprocal seconds:
 * an eighth of a second to believe an opening one, half a second a closing one.
 *
 * `DriveState.pull` is what these lag, and the note there says why it exists at
 * all. Why it is **asymmetric** is both measurements either side of it.
 *
 * Symmetric at half a second, the automatic took 0.72 s to 50 km/h against a
 * well-shifted rider's 0.50, because half a second after the throttle was
 * slammed open the box still believed it was at two-thirds and had already
 * upshifted out of first at 13.3 m/s instead of 15.31. A real transmission
 * answers a kickdown at once — that is the whole point of the cable — so going
 * up is quick.
 *
 * Symmetric at an eighth, a throttle modulated around a held speed put the
 * boundary back under the speed on every lift and the box hunted. Coming down
 * is therefore slow, which is also what the real thing does and for the same
 * reason: a gearbox that upshifted the instant a rider eased off mid-corner
 * would hand them an upshift in the middle of the bend.
 */
const AUTO_OPEN = 8;
const AUTO_SHUT = 2;

/**
 * Put it in a gear. Refused while a shift is still running, which is what makes
 * one key press one gear however long the frame was.
 */
const selectGear = (state: DriveState, tuning: DriveTuning, gear: number): void => {
  if (state.shiftFor > 0) return;
  const want = clamp(Math.round(gear), 1, tuning.gears.length);
  if (want === state.gear) return;
  state.gear = want;
  state.shiftFor = SHIFT_TIME;
};

/**
 * The automatic.
 *
 * One gear per call and no searching. It is called every substep, so a box that
 * has to walk from top down to second under braking takes four shifts and
 * `4 · SHIFT_TIME` to do it — and that cost is where a rider who shifted once,
 * early, under the brakes gets their corner back. An automatic cannot anticipate
 * a bend; that is not a handicap invented for the game, it is the reason people
 * buy the manual. In a straight line it shifts at the point the ratios were cut
 * for and nobody beats it, which is also true of the real thing.
 */
const autoShift = (state: DriveState, tuning: DriveTuning): void => {
  const top = tuning.gears.length;
  // Up the schedule the throttle has selected: wide open, hold the gear to the
  // crossover and take every newton it has; shut, upshift as soon as the gear
  // above will pull without lugging.
  if (state.gear < top) {
    const lug = AUTO_LUG * tuning.gears[state.gear];
    if (state.along > lug + (tuning.shifts[state.gear - 1] - lug) * state.pull) {
      selectGear(state, tuning, state.gear + 1);
      return;
    }
  }
  /**
   * Down at the lugging end of the boundary and nowhere else — the one place in
   * this function the throttle gets no vote, and the reason hunting is impossible
   * here rather than merely unlikely.
   *
   * The downshift point is `AUTO_LUG · gears[g − 1]` less the hysteresis, which
   * is strictly below the *lowest* speed the upshift through that same boundary
   * can happen at whatever the throttle is doing. So no sequence of inputs can
   * put the two tests on the same side of the speed, and the box cannot shift
   * back through a boundary it has just crossed.
   *
   * Measured, both of the versions that let the throttle move this end hunted:
   * a boundary interpolated with the raw throttle gave **96 gear changes in 20
   * seconds** at a held 16 m/s, and one interpolated with `pull` — the lagged
   * throttle, which exists because of that measurement — still gave 32 at 23 m/s,
   * because a lag that answers an opening throttle in an eighth of a second
   * sawtooths under a throttle that is being modulated to hold a speed.
   *
   * What it costs is the kickdown on the way down: ease off at 20 m/s, let the
   * box take fourth, then ask for everything, and it stays in fourth on 1,994 N
   * where second had 3,075. That is a real automatic, it is the measured reason
   * manual is worth having, and the rider has a paddle.
   */
  if (state.gear > 1) {
    const i = state.gear - 2;
    if (state.along < AUTO_LUG * tuning.gears[state.gear - 1] - tuning.shiftGap[i]) {
      selectGear(state, tuning, state.gear - 1);
    }
  }
};

/**
 * The tyre, as the brush model: force rises to the friction limit with an
 * initial slope of three and arrives there flat, at `sat` radians of slip.
 *
 * Flat at the top and not falling over, deliberately. A real tyre's curve drops
 * past its peak, and a drop is what makes a slide unrecoverable — the harder you
 * slide the less you have to catch it with. The plateau is what lets a slide be
 * held and steered out of, which is the skill the user asked for.
 */
const tyreForce = (alpha: number, limit: number, sat: number): number => {
  const s = Math.min(1, Math.abs(alpha) / sat);
  const used = 1 - (1 - s) ** 3;
  return (alpha < 0 ? 1 : -1) * used * limit;
};

/** How much of an axle's grip the slip angle is using, for the smoke. */
const tyreUse = (alpha: number, sat: number): number => Math.min(1, Math.abs(alpha) / sat);

const integrate = (
  state: DriveState,
  tuning: DriveTuning,
  input: DriveInput,
  surface: DriveSurface,
  h: number
): void => {
  const mass = tuning.mass;
  const speed = Math.abs(state.along);

  // --- the surface ----------------------------------------------------------
  const mu = tuning.mu * Math.max(0.05, surface.grip);
  const sat = SLIP_SAT * (surface.made ? 1 : LOOSE_SLIP);
  const crr = tuning.rollCrr * (surface.made ? 1 : ROLL_LOOSE);
  // The grade is rise over run, so the slope angle's sine and cosine come
  // straight out of it without a trigonometric call.
  const run = Math.sqrt(1 + surface.grade * surface.grade);
  const cosSlope = 1 / run;
  const sinSlope = surface.grade / run;

  // --- what each axle is carrying ------------------------------------------
  // Static split plus the transfer from the last substep's surge, which is what
  // makes the brakes load the front and the throttle unload it. Neither axle is
  // allowed to carry less than nothing: that cap is the wheelie and the stoppie,
  // and it is also what stops the launch force running away.
  /**
   * This is why the fast machine ploughs, and it is not a bug — do not "fix" it.
   *
   * Reported as a defect: at full lock at 49.6 m/s the front axle saturates, the
   * rear carries nothing, and the circle comes out at 287 m against the 82 m
   * that 3.06 g would allow. All true. The cause is three lines of arithmetic
   * with no slack in any of them. With the centre of mass at mid-wheelbase,
   * `lf = −lr`, so the steady yaw balance `lf·Ff + lr·Fr = 0` forces the axles
   * to make **equal** force and whichever runs out first caps the pair. At a held
   * speed the drive must balance the drag; that drive is a contact-patch force,
   * and it levers `D·cgHeight/wheelbase` off the front. At 49.6 m/s the ridden
   * machine is pushing hundreds of newtons of air — 880 N when the drag area was
   * a naked bike's 0.59 m², 477 N on the 0.32 m² fairing that this measurement
   * bought — and it levers that straight off the front axle.
   * So the lateral on offer is `2·μ·(1 − GRIP_BIAS)·loadFront/m`, never `μ·g`.
   *
   * Measured against that closed form in `probe/driving-model.ts`, within 5% at
   * every speed — the implementation is doing what the specification says, and
   * the specification costs grip as v²: **97% of the tyre at 15 m/s, 90% at 20,
   * 85% at 25, 74% at 35, 59% at 49.6.** A road is ridden in the top half of that
   * list, which is why this never showed until the governor went to 55.
   *
   * And the grip does reach the road. Shutting the throttle at 49.6 m/s finds
   * **99% of the tyre and a 25 m circle inside half a second**, because `surge`
   * goes to nothing and the front gets its load back. The throttle is the
   * steering on this machine, which is what it is on the real thing.
   *
   * The tempting fix is wrong in the direction it is tempting. Taking moments
   * about the rear patch, the front loses `D·h_cp/wheelbase` where `h_cp` is the
   * centre of aerodynamic pressure — on a bike with an upright rider that is the
   * chest and helmet at 1.0 to 1.1 m, about twice `cgHeight`. Using `cgHeight`
   * for both is the same as putting the drag at the centre of mass, and it is
   * already the kind assumption: the honest one roughly doubles the loss. What
   * actually buys cornering at speed is less drag area, and that is a `Spec`.
   */
  const load = mass * G * cosSlope;
  const shift = (mass * state.surge * tuning.cgHeight) / tuning.wheelbase;
  const loadFront = Math.max(0, (load * -tuning.lr) / tuning.wheelbase - shift);
  const loadRear = Math.max(0, (load * tuning.lf) / tuning.wheelbase + shift);

  const capFront = mu * (1 - GRIP_BIAS) * loadFront;
  const capRear = mu * (1 + GRIP_BIAS) * loadRear;
  // The lateral halves of the same two budgets, bounded by how far the machine
  // can lean rather than by what the tyre holds. See `LEAN_LIMIT`.
  const leanMu = Math.min(mu, LEAN_LIMIT * Math.max(0.05, surface.grip));
  const leanFront = leanMu * (1 - GRIP_BIAS) * loadFront;
  const leanRear = leanMu * (1 + GRIP_BIAS) * loadRear;

  // --- which way each axle is being dragged ---------------------------------
  // Read before anything is integrated, because the longitudinal forces below
  // need to know it: a locked rear wheel sliding straight ahead is a brake, and
  // the same wheel sliding sideways is not.
  //
  // Signed, so a machine rolling backwards answers its bars the other way about,
  // and floored, because `atan(w/u)` means nothing at a standstill.
  const den = Math.max(Math.abs(state.along), CRAWL);

  /**
   * How much lock the rider is allowed, expressed on the front tyre rather than
   * on the bars: the wheel may be pointed anywhere that keeps its own slip angle
   * inside `STEER_MARGIN` of saturation, which is a window `STEER_MARGIN·sat`
   * wide centred on the angle the wheel is already travelling at.
   *
   * Capping the bar angle directly — at `L·μg/u²`, the Ackermann angle for the
   * grip limit — is the version that could not be caught. It is the right cap
   * for a machine tracking straight and it is catastrophic in a slide: at 15 m/s
   * it allows 3.7° of lock, and catching a drift wants twenty or thirty degrees
   * of counter-steer. Measured, a xe máy put sideways by the handbrake could not
   * be recovered at all, because the one input that recovers it was locked out.
   *
   * Centring the window on the wheel's own travel angle frees exactly that: in a
   * drift the centre moves with the slide, so full lock into it is available,
   * while a machine going straight has the centre at zero and cannot ask the
   * front for more than it has. It is also self-limiting rather than a clamp —
   * as the yaw rate builds, the wheel's travel angle comes to meet the bars.
   */
  const centre = Math.atan((state.across + tuning.lf * state.turn) / den);
  const window = STEER_MARGIN * sat;
  const low = clamp(centre - window, -STEER_LOCK, STEER_LOCK);
  const high = clamp(centre + window, -STEER_LOCK, STEER_LOCK);
  /**
   * What the bar is asking for, as a **corner** and not as a wheel angle.
   *
   * It was `input.steer * STEER_LOCK` — the stick mapped straight onto the lock,
   * which is what a go-kart does and is the whole of the player's "nhạy cảm tốc
   * độ". A fixed angle is a fixed *curvature*, and curvature at a fixed lateral
   * limit is a speed: measured, full lock meant 12% of the tyre at 2 m/s, 44% at
   * 5, 43% at 10 and 34% at 50, with the sharpest response of the whole range at
   * 5 m/s and a 11.8× swing in how long a radian took to sweep. A rider cannot
   * build a habit against that.
   *
   * So the stick asks for a share of the lateral acceleration the machine can
   * hold, and the angle that delivers it is worked out here: `a = v²/R` and
   * `δ ≈ L/R` give `δ = L·a/v²`, plus the `SLIP_SAT` the front tyre needs to be
   * carrying to make the force at all. Half a stick is half the cornering at
   * every speed, which is the invariant a rider's hands actually learn.
   *
   * Offset from `centre` rather than from zero, which is what keeps the drift
   * recoverable: the ask is relative to where the front wheel is already
   * travelling, so in a slide full opposite stick is full counter-steer into it,
   * exactly as the window below intends. At low speed `centre` is large — the
   * yaw rate over the `CRAWL` floor — and the ask saturates against the window,
   * which is how the full-lock pivot in a lane survives this.
   */
  const asked = clamp(input.steer, -1, 1);
  const leanAsk = (tuning.wheelbase * Math.min(mu, LEAN_LIMIT * Math.max(0.05, surface.grip)) * G) / (den * den);
  const want = clamp(centre + asked * (leanAsk + sat), Math.min(low, high), Math.max(low, high));
  state.steer += clamp(want - state.steer, -STEER_RATE * h, STEER_RATE * h);
  const cosSteer = Math.cos(state.steer);
  const sinSteer = Math.sin(state.steer);

  const slipFront = Math.atan((state.across + tuning.lf * state.turn) / den) - state.steer;
  const slipRear = Math.atan((state.across + tuning.lr * state.turn) / den);

  // --- along the nose -------------------------------------------------------
  const lit = state.boosting;
  const throttle = clamp(input.throttle, -1, 1);
  const driving = Math.max(0, throttle);
  const power = tuning.power * (1 + BOOST_POWER * lit);
  const governed = tuning.limit + BOOST_TOP * lit;

  // --- the gearbox ----------------------------------------------------------
  state.shiftFor = Math.max(0, state.shiftFor - h);
  state.pull += (driving - state.pull) * Math.min(1, h * (driving > state.pull ? AUTO_OPEN : AUTO_SHUT));
  // Absent means automatic: see the note on `DriveInput.auto`.
  if ((input.auto ?? true) && state.shiftFor <= 0) autoShift(state, tuning);

  const gearPeak = tuning.gears[state.gear - 1];
  /**
   * Engine speed, in multiples of peak-power revs, straight off the road speed
   * and the ratio.
   *
   * Forward speed and not `speed`, which is a magnitude: a machine being walked
   * backwards has its clutch in and its engine idling, not its gearbox turning
   * the other way. Reverse is feet and stays feet.
   */
  const geared = Math.max(0, state.along) / gearPeak;
  /**
   * The clutch, which is what replaced `power / Math.max(speed, 0.5)`.
   *
   * `engineTorque` is zero at zero revs — that is what makes it an engine rather
   * than an idealisation — so something has to hold the engine up while the road
   * speed catches the gearing, and on a bike that something is the rider's left
   * hand. How far they slip it is how much throttle they are giving it, so the
   * floor is `TORQUE_PEAK · driving`: dumped wide open the engine sits on its
   * torque peak, which in first gear is 4,300 N and 1.87 g off the line. Eased
   * out at a quarter throttle it sits at 0.19 revs and pulls away gently, which
   * the old binary force could not do — anything past `THROTTLE_DEAD` used to
   * get the whole of the engine.
   *
   * The hand-over has no step in it, and that is not luck — the floor is the
   * gear's own torque peak, so the clutch stops slipping exactly where the
   * gearing arrives at the same number. On the ridden machine that is 10 m/s in
   * first.
   */
  const revs = Math.max(geared, TORQUE_PEAK * driving);
  state.engine = Math.min(1, revs / REDLINE);

  // Torque at the wheel, through the gear, and proportional to the throttle —
  // which the flat-power version was not: anything over `THROTTLE_DEAD` used to
  // get the whole of it. `power / gearPeak` is the force at peak power in this
  // gear, and that is exactly what `power / speed` would have given at that
  // speed, because flat power is the envelope this curve touches once per gear
  // and sits under in between.
  let drive = 0;
  if (driving > THROTTLE_DEAD && state.shiftFor <= 0 && geared <= REDLINE) {
    drive = (driving * power * engineTorque(revs)) / gearPeak;
  }
  const driveCap = mu * (tuning.driveFront ? loadFront : loadRear);
  if (drive > driveCap) drive = driveCap;
  // The governor cuts the drive and does not clamp the speed, so anything slower
  // than the limit still finds its own top out of the force balance.
  if (state.along > governed) drive = 0;

  let brake = clamp(input.brake, 0, 1);
  if (throttle < 0) brake = Math.max(brake, -throttle * PADDLE_BRAKE);
  state.brake += (brake - state.brake) * Math.min(1, h * 12);

  let retard = brake * tuning.brakeForce;
  // Engine braking, through the same gear and off the unboosted power — the
  // boost is more fuel, not more friction. Nothing drags while the clutch is
  // out, which is also what stops a chain of automatic downshifts under braking
  // from stacking engine braking on top of the brakes.
  if (driving <= THROTTLE_DEAD && speed > 0.1 && state.shiftFor <= 0) {
    retard += Math.min((ENGINE_BRAKE * tuning.power * geared) / gearPeak, ENGINE_CAP * mass);
  }
  // The whole machine cannot shed more than the tyres hold, whatever the brake
  // could manage on its own.
  retard = Math.min(retard, mu * load);

  const hand = clamp(input.handbrake, 0, 1);
  /**
   * A locked wheel's friction is not a brake, it is a magnitude pointed against
   * the way the patch is actually sliding — so how much of `capRear` goes into
   * slowing the machine and how much into resisting the slide is `cos` and `sin`
   * of the rear's own slip angle. At zero slip the handbrake takes the whole of
   * the rear's circle lengthways and leaves it nothing to corner with, which is
   * what a handbrake does.
   *
   * Treating it as a pure brake — `capRear` of retardation and no lateral force
   * left at any slip angle — is the version that spun: a motorbike with half
   * lock at 15 m/s reached 11.5 rad/s and never came back, because nothing in
   * the model objects to a vehicle rotating once its rear has no grip at all. A
   * real locked tyre dragged sideways grips sideways, and that is the term that
   * catches it.
   */
  const bite = hand * HANDBRAKE_BITE;
  const lockLong = bite * capRear * Math.abs(Math.cos(slipRear));
  const lockLat = -bite * capRear * Math.sin(slipRear);

  // The friction circle: whatever an axle is doing lengthways it cannot also do
  // sideways. This one coupling is most of what the user asked for — power
  // oversteer, a front that bites under braking, and a handbrake that lets go.
  /**
   * The brake cannot ask an axle for more than its tyre holds.
   *
   * It could, and that was the other half of the spin the player reported.
   * Traced at 18 m/s with full lock held and the brake applied: 1 g of
   * retardation on a machine whose centre of mass is 0.44 of its wheelbase up
   * transfers 1,000 N forward and leaves **128 N on the rear axle**, so `capRear`
   * falls to almost nothing — while the bias went on asking the rear for 858 N
   * of it. Past its circle a wheel is locked, which buys no more retardation and
   * costs the axle every scrap of lateral grip it had, so the rear went to zero
   * force in both directions and the saturated front spun the machine with
   * nothing at all opposing it.
   *
   * So each axle's share is capped at `BRAKE_BITE` of its own circle and the
   * rear's surplus is offered to the front, which still has the load. That is
   * brakeforce distribution — a rider's two fingers on a bike, an EBD valve on a
   * car — and it is the same idea as `HANDBRAKE_BITE`: take most of the circle,
   * never all of it, so the tyre can still be steered with.
   */
  const pushFront = tuning.driveFront ? drive : 0;
  const pushRear = tuning.driveFront ? 0 : drive;
  let brakeRear = retard * (1 - tuning.brakeBias);
  let brakeFront = retard * tuning.brakeBias;
  const takeRear = Math.max(0, BRAKE_BITE * capRear - pushRear);
  if (brakeRear > takeRear) {
    brakeFront += brakeRear - takeRear;
    brakeRear = takeRear;
  }
  brakeFront = Math.min(brakeFront, Math.max(0, BRAKE_BITE * capFront - pushFront));
  // What the machine actually sheds is what the tyres took, not what was asked
  // for, so `bleed` and `surge` below cannot decelerate it harder than the
  // ground can.
  retard = brakeFront + brakeRear;
  const longFront = brakeFront + pushFront;
  const longRear = brakeRear + pushRear;
  const roomFront = Math.min(leanFront, Math.sqrt(Math.max(0, capFront * capFront - longFront * longFront)));
  const roomRear = Math.min(leanRear, Math.sqrt(Math.max(0, capRear * capRear - longRear * longRear)));

  const forceFront = tyreForce(slipFront, roomFront, sat);
  // The rolling tyre and the locked one are two descriptions of the same tyre,
  // so they are mixed rather than added — and the lock is deliberately left out
  // of `roomRear` above, because taking it off the circle *and* adding the
  // locked force counts it twice: at 90° of rear slip that gave twice the
  // friction the tyre has.
  const forceRear = tyreForce(slipRear, roomRear, sat) * (1 - bite) + lockLat;

  state.frontSlide = tyreUse(slipFront, sat);
  state.rearSlide = Math.max(tyreUse(slipRear, sat), bite);

  // --- both axes, in the frame that is turning with the machine -------------
  /**
   * `d/dt (u f + w l)` with `f` and `l` turning at `r` comes out as
   * `(u̇ − w·r) f + (ẇ + u·r) l`, so the transport terms are `+w·r` along and
   * `−u·r` across. Both of them, or neither.
   *
   * Only the across one was here, and that is not a small error: with nothing
   * feeding the rotation back into the nose, a turn pumps energy into the slide
   * out of nothing. Measured on this model with the term missing — a xe máy held
   * at full lock at 5 m/s reached 11.6 rad/s of yaw and 142 m/s sideways after
   * six seconds, and went on climbing. With both terms a free body rotating
   * under no force keeps its velocity fixed in the world and its speed exactly
   * constant, which is the test to keep.
   */
  const transportAlong = state.across * state.turn;
  const transportAcross = -state.along * state.turn;

  // The front wheel's force is perpendicular to the wheel and the wheel is
  // turned, so some of it points backwards down the machine. That term is the
  // cornering drag, and without it a bend is free.
  const push = drive - G * sinSlope * mass - forceFront * sinSteer;
  const lateral = (forceFront * cosSteer + forceRear) / mass;
  state.lateral = lateral;

  let along = state.along + (push / mass + transportAlong) * h;
  let across = state.across + (lateral + transportAcross) * h;

  // Brakes and a locked wheel act along the nose, so they bleed `along` alone,
  // and as a bleed that cannot carry it through zero. As a signed force instead,
  // a long frame at low speed reverses the machine and then accelerates it
  // backwards, which is a model that explodes on a slow phone.
  const bleed = ((retard + lockLong) / mass) * h;
  if (along > 0) along = Math.max(0, along - bleed);
  else if (along < 0) along = Math.min(0, along + bleed);

  // Drag and rolling resistance act against the way it is actually travelling,
  // which in a slide is not the way it is pointing — so they come off both axes
  // together, as a decay of the whole velocity. Exponential rather than
  // subtracted, which is unconditionally stable and cannot add energy on a long
  // frame.
  const ground = Math.hypot(along, across);
  if (ground > 1e-4) {
    const shelter = 1 - DRAFT_SHELTER * clamp(surface.draft, 0, 1);
    // N·s/m: the quadratic drag's own speed term folds into the coefficient, and
    // the rolling resistance — a constant force — divides out of it.
    const sweep = 0.5 * AIR * tuning.dragArea * shelter * ground + (crr * load) / ground;
    const decay = Math.exp((-sweep / mass) * h);
    along *= decay;
    across *= decay;
  }

  // A decay asymptotes and never arrives, so a coast ends at a millimetre a
  // second for ever. Stiction finishes it: at a crawl, with nothing pushing
  // harder than the rolling resistance holds, it is stopped. The test is against
  // the push and not the speed alone, so a machine left on a 26% slope — where
  // gravity is 407 N against 32 N of rolling resistance — still rolls away.
  if (ground < 0.08 && Math.abs(push) < crr * load) {
    along = 0;
    across = 0;
  }

  // Reverse: feet on the ground, not a gear.
  if (throttle < 0 && along < 0.2) {
    along = Math.max(along - PADDLE_ACCEL * h, -tuning.reverse * -throttle);
  }

  // The ceilings are on the velocity, not on the nose speed. Clamping `along`
  // alone is what wrecked the spin: a machine fully sideways legitimately has a
  // large negative nose speed, and pinning it at `REVERSE_MAX` tore the velocity
  // vector apart halfway through a slide. The room's limit is on world speed
  // anyway, which is what this is.
  const total = Math.hypot(along, across);
  if (total > ABSOLUTE_TOP) {
    const back = ABSOLUTE_TOP / total;
    along *= back;
    across *= back;
  }
  // The rollback cap, and only while it really is rolling backwards: a rider who
  // cannot climb a slope has their feet down and the brakes on. One sliding
  // sideways is doing neither, so a slide is exempt.
  if (along < -REVERSE_MAX && Math.abs(across) < CRAWL) along = -REVERSE_MAX;

  state.along = along;
  state.across = across;

  /**
   * The load moves because the ground is pushing, so this is the net force up
   * the nose and not `d(along)/dt`.
   *
   * It was the rate of change, which is a differentiator over a 4 ms substep and
   * — worse — includes `across·turn`, the term by which a rotating body's nose
   * speed changes with no force on it at all. In a slide that oscillates fast,
   * so the axle loads oscillated with it: measured at full lock at 5 m/s, the
   * surge swung between −15.6 and +39.9 m/s², the friction circles swung with
   * it, and the whole thing fed itself.
   */
  const dirAlong = state.along > 0 ? 1 : state.along < 0 ? -1 : 0;
  state.surge += ((push - (retard + lockLong) * dirAlong) / mass - state.surge) * Math.min(1, h / SURGE_LAG);

  state.turn += ((tuning.lf * forceFront * cosSteer + tuning.lr * forceRear) / tuning.yawInertia) * h;

  // The rider's legs, on top of the tyres and faded out by walking pace.
  state.paddle = clamp(input.steer, -1, 1) * tuning.paddleRate * Math.max(0, 1 - speed / PADDLE_FADE);
  state.heading += (state.turn + state.paddle) * h;

  state.slip = Math.atan2(state.across, Math.max(Math.abs(state.along), CRAWL));

  // --- the meter ------------------------------------------------------------
  /**
   * How much of a drift this is.
   *
   * It was the slip angle alone. The slip angle is the *consequence* of a drift
   * and lags its cause, so this also reads the grip the **driven** axle has
   * given up, and takes whichever is larger. A rear stepping out registers the
   * moment it goes rather than once the machine has rotated far enough for the
   * angle to build.
   *
   * What this deliberately does **not** reward is the other axle. The dash probe
   * held full lock for four seconds, reported `slip 0.0°, slide 1.00/0.00` and
   * charged 0.002 of 1 — and that reading is correct: a front wash on a
   * rear-drive machine is understeer, the thing ploughing straight on with its
   * velocity still up its own nose. It is a mistake, not a drift, and a meter
   * that filled on it would be teaching the wrong hands. `driveFront` picks the
   * axle so a front-drive car's own drift is read the same way round.
   *
   * The 0.002 had a second cause which **was** a bug, and it is `pace` below.
   */
  const sliding = clamp((Math.abs(state.slip) - DRIFT_SLIP) / (DRIFT_FULL - DRIFT_SLIP), 0, 1);
  const drifting = Math.max(sliding, tuning.driveFront ? state.frontSlide : state.rearSlide);
  const pace = Math.min(1, speed / (tuning.limit * BOOST_PACE));
  const charge = drifting * pace * BOOST_DRIFT + clamp(surface.draft, 0, 1) * pace * BOOST_DRAFT;
  // Lit while it is held and there is something left; armed only above
  // `BOOST_ARM`, so it cannot be stuttered a tenth at a time.
  const alight = input.boost && state.boost > 0 && (state.boosting > 0.01 || state.boost >= BOOST_ARM);
  state.boost = clamp(state.boost + (charge - (alight ? BOOST_DRAIN : 0)) * h, 0, 1);
  state.boosting = clamp(state.boosting + ((alight ? 1 : 0) - state.boosting) * Math.min(1, h * BOOST_RAMP), 0, 1);
};

/**
 * One frame. Substepped internally at `DRIVE_STEP`, so the caller may hand over
 * whatever delta it has — including the walker's 0.1 s clamp — and get the same
 * answer.
 */
export const stepDrive = (
  state: DriveState,
  tuning: DriveTuning,
  input: DriveInput,
  surface: DriveSurface,
  delta: number
): void => {
  if (!(delta > 0)) return;
  /**
   * The shift is consumed here, once, before anything is substepped — the one
   * thing in this file that is deliberately per-frame rather than per-substep.
   *
   * Read inside `integrate` it would fire on every substep instead, and the
   * walker's 0.1 s delta clamp is twenty-four of those: one tap of the paddle at
   * 10 fps would walk the box from first to top and the gearbox would work worse
   * the slower the phone. A key press is a frame-boundary event and this is the
   * frame boundary.
   *
   * Only in manual, so the rider and the automatic can never both be holding the
   * lever.
   */
  if (input.shift && !(input.auto ?? true)) selectGear(state, tuning, state.gear + Math.sign(input.shift));
  // Capped at a second's worth. Past that the frame was not a frame and the only
  // thing worth protecting is that the numbers stay finite.
  const steps = Math.min(240, Math.max(1, Math.ceil(delta / DRIVE_STEP)));
  const h = delta / steps;
  for (let step = 0; step < steps; step += 1) integrate(state, tuning, input, surface, h);
};

export {
  ABSOLUTE_TOP,
  createDriveState,
  driveVelocityX,
  driveVelocityZ,
  type DriveInput,
  type DriveState,
  type DriveSurface,
} from './driving-state';
export {
  engineTorque,
  gearSpeeds,
  REDLINE,
  surfaceGrip,
  TORQUE_PEAK,
  tuneDrive,
  type DriveSpec,
  type DriveTuning,
} from './driving-tuning';
export {
  collideDrive,
  collideWorld,
  createImpact,
  createImpactor,
  readDriveBody,
  type Impact,
  type Impactor,
} from './driving-collision';
