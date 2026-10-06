import type { Terrain, WaterParams } from '@otrip/world';
import { Color, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Vector3, type AnimationClip } from 'three';

import {
  collideDrive,
  collideWorld,
  createDriveState,
  createImpact,
  createImpactor,
  driveVelocityX,
  driveVelocityZ,
  readDriveBody,
  stepDrive,
  surfaceGrip,
  tuneDrive,
  type DriveInput,
  type DriveState,
  type DriveSurface,
  type DriveTuning,
  type Impactor,
} from './driving';
import { createHuman, type Human, type HumanSource } from './human';
import type { Machine, Rideable, Ridden } from './life';
import type { Obstacle } from './obstacle-index';
import { createPersonParts, PERSON_HEIGHT } from './person';
import {
  afloatAt,
  CLIMB_SLOPE,
  createSwimEffects,
  createWaterline,
  WADE_DEPTH,
  wadeDrag,
  type SwimEffects,
  type SwimFrame,
  type Waterline,
} from './swimming';
import type { Building } from './town-meshes';

/**
 * The gait ladder, m/s. These are the speeds a person actually moves at: the
 * previous 13 and 26 were 47 and 94 km/h on a 1.78 m rig playing one walk
 * cycle, which is why the feet skated.
 */
const STROLL_SPEED = 1.4;
const WALK_SPEED = 2.4;
/**
 * The top of the ladder, picked off the cadence rather than by feel. With the
 * clip rate tied to the ground, steps a minute are `120·speed/stride`, and the
 * run clip's real stride is 3.587 m over 0.625 s — so 4.5 m/s is 150 steps a
 * minute at 0.78 of the rate the clip was drawn at, which is a jog.
 *
 * It was 3.9 for a while, on the reading that 4.5 came to 207 steps a minute.
 * That figure came off a stride of 2.604 m, which was the widest the toes ever
 * split doubled — fair for a walk and 27% short for a run, where the split
 * happens in mid-air. On the measured stride 3.9 is 130 steps a minute at 0.68
 * rate: a body covering 1.8 m a step at a walking cadence, which is the loping,
 * low-gravity run the slower number was meant to avoid.
 */
const JOG_SPEED = 4.5;
/**
 * Destinations are kilometres apart, so there still has to be a way to cover
 * ground — but it is not a run and is not dressed up as one. Holding Shift
 * widens the lens and strengthens the motion, and the legs are driven faster
 * than any clip was authored for, which reads as travelling rather than as a
 * human sprinting at 50 km/h.
 */
const TRAVEL_SPEED = 14;
/** Seconds of held input to climb from a standing start up to a jog. */
const GAIT_RAMP = 1.6;
/** Seconds for the gait to unwind once the input stops. */
const GAIT_RELEASE = 0.6;
/** Seconds to ease into and out of travel mode. */
const TRAVEL_IN = 0.45;
const TRAVEL_OUT = 0.3;

/**
 * Ground speed above which the run clip replaces the walk clip — above the
 * fastest the walk cycle can be stretched to without mincing, below the slowest
 * the run cycle reads as anything but slow motion.
 *
 * The geometric mean of the two clips' own measured speeds, 1.750 and 5.740
 * m/s, so neither is stretched further than the other at the swap — each by
 * 1.81. There is no point in the band that flatters both: the clips are a factor
 * of 3.3 apart, so wherever the swap goes, one side is a 217-step-a-minute
 * scurry and the other a 106-step lope. It sits in the middle because the gait
 * ramp crosses it in about half a second on the way to a jog and nothing rests
 * there — a stick held half over does, which is the one case this is a
 * compromise for and not an answer.
 */
const RUN_CLIP_AT = 3.17;
/**
 * The most and least the clips are stretched. The rig's cycles measure 1.000 s
 * walking and 0.625 s running and cover 1.750 m and 3.587 m of ground, so the
 * ladder asks for 0.78 at a jog and 2.44 at travel speed: the cap bites in
 * travel mode on purpose. 2.25 is 432 steps a minute, which is already past
 * anything a body does. It leaves the feet 8% behind the ground at 14 m/s, which
 * is the one place in the ladder they do not keep up and is the price of a speed
 * no clip was drawn for.
 */
const MAX_CLIP_RATE = 2.25;
const MIN_CLIP_RATE = 0.35;

/** Half a degree. The sway a walking body carries the horizon through. */
const STRIDE_ROLL = 0.0087;

const SWIM_SPEED = 1.1;
/** Swimming hard. A trained swimmer is 1.7 m/s; this is a day out. */
const SWIM_FAST = 1.6;
/** Afloat enough that the feet no longer decide where the body is. */
const SWIMMING = 0.45;

/** Eye height on the 1.78 m rig. */
const EYE_HEIGHT = 1.64;
/**
 * Chest height on the same rig, and the point the camera orbits about.
 *
 * Taken from the two heights this file already measures off the body: the waist
 * `FLOAT_PIVOT` the floating body tips about at 0.9 m, and the eyes at 1.64 m.
 * Half way between them is the sternum, which is where a third-person rig wants
 * its centre: aim at the eyes and the whole body hangs below the middle of the
 * frame, aim at the feet and the whole of it is above.
 */
const CHEST_HEIGHT = 1.27;
/**
 * The chest as a share of the eye height, 0.774, which is how it is carried onto
 * the two bodies that are only ever described by their eyes: the primitive
 * fallback figure, whose rig is `PERSON_HEIGHT` rather than 1.78 m, and a rider
 * sitting at `SADDLE_EYE`.
 */
const CHEST_SHARE = CHEST_HEIGHT / EYE_HEIGHT;
/**
 * How far the body's origin sits below the surface once it is floating. Which
 * also settles where the camera goes when following a swimmer: the chest of a
 * body drawn 1 m under is `CHEST_HEIGHT - FLOAT_DRAFT` = 0.27 m above the
 * waterline, within five centimetres of where the rig used to put the eyes by a
 * constant of its own, so the orbit needs no special case for water.
 */
const FLOAT_DRAFT = 1;
/** Height of the hinge the floating body tips about — roughly the waist. */
const FLOAT_PIVOT = 0.9;
/** How far forward a swimmer lies once they are moving. Nearly prone, head up. */
const FLOAT_PITCH = 1.45;
/** Share of that lie kept when they are not going anywhere, which is treading. */
const TREAD_PITCH = 0.45;
/**
 * Metres a breaststroke cycle carries you. A stroke is long and the glide is
 * most of it, so tying the phase to the ground the way the walk is tied to it
 * gives 0.7 strokes a second at a cruise and 1.0 swimming hard — which is what
 * a person in a river does.
 */
const STROKE_REACH = 1.6;
/** Strokes a second with nowhere to go: sculling to stay up rather than frozen. */
const TREAD_RATE = 0.42;
/** Seconds for a soaked body to dry off once it is out of the water. */
const DRY_TIME = 14;

/**
 * The tallest thing that can be stepped straight up: a kerb, a deck lip, the
 * tread of a stair. Anything higher needs a ramp — which is why a graded
 * platform extends past where it meets the ground at each end, so there is a
 * stretch where the two surfaces agree and no step exists at all.
 */
const STEP_UP = 0.4;
/** How fast the feet settle onto a new surface, per second. */
const STEP_EASE = 14;
/** Metres outside a deck's own extents that the walker can reach to board. */
const BOARD_REACH = 2.5;
/** How far to the machine's left a rider stands once they have swung off. */
const DISMOUNT_STEP = 1.1;
/**
 * Eye height astride a xe máy — and now the eye height of the figure that is
 * actually drawn there rather than an estimate of one.
 *
 * It was 1.35, derived as "the saddle at 0.86 m plus a sitting body". Measured
 * off the assembled rig by `probe/ride-view.ts`, the seated figure
 * `motorbikeBuild` puts on that saddle has its crown at 1.75 m and so its eyes
 * at about 1.65 — `seatedRider` stacks a 0.5 m torso and a 0.24 m neck on a hip
 * at 0.86, which comes to 0.3 m more than the estimate allowed for. The estimate
 * was never visibly wrong while the camera only ever orbited from eight metres
 * out; it became wrong the moment there was a first-person ride, because then the
 * lens is supposed to *be* those eyes and instead sat 0.30 m inside the rider's
 * neck.
 *
 * Both views read it. First person puts the lens here; third person orbits
 * `SADDLE_EYE * CHEST_SHARE`, so correcting it also lifts the third-person aim
 * point off the rider's stomach and onto their sternum. Measured against the
 * ride probe, the third-person change is 0.3 m of pivot height on an 8.5 m rig —
 * 2.0° of aim — and it moves no other figure in that report.
 *
 * It is still only the camera: the rider you see is the machine's own seated
 * figure, never the walking avatar, which stands down astride anything.
 */
const SADDLE_EYE = 1.65;
/**
 * How much of the machine's lean the rider's head takes, for the horizon.
 *
 * 0.22, and not a new number: `vehicles.ts` already rolls every NPC rider's body
 * at `-agent.group.rotation.z * 0.22` against the machine under it, with the
 * reason that "the rider stays a little more upright than the machine". A head
 * is a head whichever view is looking through it, so the horizon in first person
 * tilts by exactly what that figure's head tilts by in third — had this been a
 * number of its own, the two views would have disagreed about where the rider's
 * head was and only one of them could have been right.
 *
 * At the 0.55 rad the fleet clamps a two-wheeler's lean to, 0.22 is 6.9° of
 * horizon. That is unmistakably a motorbike and nowhere near the 31° the machine
 * itself is doing.
 */
const RIDER_HEAD_SHARE = 0.22;
/** For the lean only: the same 9.81 `vehicles.ts` and `driving-state.ts` use. */
const GRAVITY = 9.81;
/**
 * How much further the camera trails at a machine's top speed. 8.5 m frames a
 * body at walking pace; at 9 m/s the same 8.5 m is a metre of road ahead of the
 * front wheel, so it opens to 12.75 m, which puts the next bend in the picture.
 */
const RIDE_PULLBACK = 0.5;
/**
 * How fast the view comes round to the machine's nose at its top speed, per
 * second, scaled down with the speed by the same `rideBack` that lets the camera
 * out.
 *
 * 2.5 is picked off the lag it leaves rather than off how it reads at a
 * standstill, because a follower trailing a steady corner settles at a constant
 * `yawRate / rate` behind the nose and that lag is the whole complaint. A bend
 * taken at 40 m/s on a 100 m radius turns the machine at 0.4 rad/s, so 2.5
 * leaves 9° — the nose is in the picture and the rider is not steering from the
 * mouse. Faster fights somebody trying to look at the lake while they ride;
 * slower and a corner arrives before the view does.
 *
 * The speed weighting does the rest: at a third of top speed the rate is a third
 * of this, so the view returns over about a second and a half, which is loose
 * enough to sightsee through.
 */
const RIDE_FOLLOW = 2.5;
/** How much tighter that coupling is from the saddle, where the lens is a head. */
const RIDE_FOLLOW_EYES = 2;
/**
 * How fast the follower comes back after the player takes their hand off the
 * view, per second.
 *
 * 3 is a third of a second to fall to `1/e` of its strength and about a second
 * to be fully back, which is the judgement in this whole feature: a shorter
 * number fights a slow deliberate pan, and a longer one leaves the view pointing
 * off into a field after a glance because the next corner arrived first.
 */
const RIDE_FOLLOW_HAND = 3;
/**
 * The most that recentring may turn the view, rad/s.
 *
 * Only ever bites on a large offset: the exponential's own peak rate is
 * `rate × error`, which for a rider who has looked right round behind them is
 * 7.9 rad/s — 450°/s of pan nobody asked for the shape of. 1.2 rad/s is 69°/s,
 * which brings a half turn back in two and a half seconds and is inside the
 * range a hand pans at, so the return reads as the view coming round rather
 * than as being snatched.
 */
const RIDE_FOLLOW_SWEEP = 1.2;
/** Metres ahead a rider reads the gradient to know what the engine will hold. */
const GRADE_PROBE = 4;

/**
 * Metres of clearance over the bare ground that marks a made surface.
 *
 * `road-network` publishes a deck wherever the carriageway stands more than 4 cm
 * clear of the terrain at its crown or either kerb, which is 100% of Tà Xùa's
 * centreline samples, 99.9% of Tràng An's, 98.2% of Hội An's and 100% of Hồ
 * Tây's. Anything carried by one of those is graded and can be ridden whatever
 * the hillside under it is doing — which matters: the terrain beneath Tà Xùa's
 * road has a median gradient of 0.60 and reaches 2.64, so reading the hill
 * instead of the road would refuse a motorbike the whole of Bắc Yên.
 */
const MADE_SURFACE = 0.04;
/**
 * The gradient and the crawl-speed pivot used to be fudged here and are now the
 * model's.
 *
 * `HILL_COST`/`HILL_FLOOR` scaled a target speed by the slope ahead — a stand-in
 * for gravity, which `driving.ts` is handed the real gradient and applies
 * directly. `PADDLE_RATE` was the rate a stopped machine is walked round by the
 * rider's feet; `tuneDrive` derives it, and its reason for existing is recorded
 * there, because it is load-bearing: measured at Hội An, riding north off the
 * spawn put the front wheel at the Thu Bồn, the step into the water was refused,
 * the speed went to nothing and with it the turn, and the only way out left was
 * reverse.
 */

/** How far off the helm a body lands when it comes over the gunwale. */
const DECK_MARGIN = 2;
/** How far a disembarking walker will be carried to find a deck or a bank. */
const LANDING_REACH = 14;

/**
 * How far to the player's right the rig sits, at `DEFAULT_DISTANCE`. The body
 * then stands 3.7° left of the view axis, which measures 0.075 of the way to the
 * left edge of a 16:9 frame and is what leaves the place you are walking into
 * unobstructed by your own back.
 *
 * Carried as a share of the distance rather than as a flat metre offset, so the
 * angle is what is constant: a fixed offset swings the body across the frame
 * every time the rig shortens, which is the same complaint as the pitch one with
 * the axes swapped.
 */
const CAMERA_SHOULDER = 0.55;
/**
 * The least the lens may clear the ground by.
 *
 * All it has to do is keep the lens from passing under the surface: a camera is
 * a point, nothing inside the scene's 2 m near plane is drawn at all, and a lens
 * 30 cm over the grass is a view along the grass — which is anyway what a
 * hillside behind you forces an orbit into. What it costs is avatar, because on
 * a slope the clearance comes straight off the distance the rig is allowed: the
 * share of the Tà Xùa walk the body is hidden for measures 2.7% at 0.6 m and
 * 0.6% at 0.3, and 0.15 buys nothing further — 0.6% again. The knee is here.
 *
 * It was 1.4 m when the ground *lifted* the camera rather than stopping it. An
 * orbit cannot lift — lifting is what slid the body off the frame — so the
 * number has to be one a lens can live with, and 1.4 is above `CHEST_HEIGHT`
 * itself, which would refuse the rig on a flat field.
 */
const CAMERA_CLEARANCE = 0.3;
/**
 * And over water, where the floor is the surface. A floating body's chest sits
 * `CHEST_HEIGHT - FLOAT_DRAFT` = 0.27 m above the waterline, so anything much
 * larger than this means a swimmer is followed in first person.
 */
const WATER_SKIM = 0.25;
const OCCLUSION_SAMPLES = 10;
/**
 * How fast the rig shortens when something gets between it and the body, and how
 * fast it lets back out, per second.
 *
 * In at 20 — a twentieth of a second — because the alternative to shortening is
 * a wall drawn over the avatar. Out at 5, a fifth of a second, because a camera
 * that snaps back to eight metres the moment you clear a doorway is its own kind
 * of nausea: the body is back in the picture either way, and the slower number
 * is the difference between the view opening and the view lurching.
 */
const TUCK_IN = 20;
const TUCK_OUT = 5;
/**
 * How fast the pivot chases the body, horizontally and vertically, per second.
 *
 * Horizontally 30 is a thirtieth of a second, which is rigid at any speed a body
 * walks at — 8 cm of lag at `WALK_SPEED`, and that lag lies along the direction
 * of travel, which in a trailing camera is depth rather than anything you can
 * see. It exists for `depenetrate`, which can shove the body most of a metre
 * sideways in a frame.
 *
 * Vertically 4 against `STEP_EASE`'s 14: the feet resolve a kerb in a fourteenth
 * of a second, which reads as a firm step when you are watching the feet and as
 * a jolt when the same motion moves the entire frame. The camera reads the
 * body's own eased height rather than the raw floor, so the two never disagree
 * about where the body is — it just arrives there a quarter of a second later.
 */
const PIVOT_CHASE = 30;
const PIVOT_RISE = 4;
/**
 * How far the pivot may sink below the height the body puts it at, in metres.
 *
 * This is the whole of the fix for the view the player photographed — a hillside
 * drawn across the lower half of the frame with the figure behind it — and the
 * reason it is a cap on the lag rather than a faster `PIVOT_RISE` is that the
 * lag is harmless at every rate of climb that number was tuned against and
 * fatal above it.
 *
 * A first-order follower trailing a steady climb settles at `rate / PIVOT_RISE`
 * of lag, and `pivotHeight` is 1.27. A body strolling up a 0.2 gradient lags
 * 0.07 m, which is why the number stood as long as it did. A body running up one
 * of Tà Xùa's 1.1 gradients — the steepest `CLIMB_SLOPE` allows — climbs at
 * 4.95 m/s and lags 1.24 m, which is the pivot's entire height above the feet;
 * on a machine at the 34 m/s the ride measures, a 0.2 gradient does it.
 *
 * So the orbit centre passes below the body's own feet and into the hill, and
 * from there the sweep has nothing left to offer: shortening the rig moves the
 * lens *towards* a pivot that is itself underground. Which is exactly what the
 * worst frames show. The sweep reported 1.10 m of deficit at Tà Xùa and 1.74 m
 * at Tràng An — blocked at every sample it took — drew the rig in to 1.74 m and
 * 2.10 m, and still left the lens 0.80 m and 1.44 m under the surface.
 *
 * Measured by `probe/lens-ground.ts` over a 45 s ride, three 90 s walks and
 * twenty 12 s legs of 0.7-to-1.1 hillside at each of the four destinations,
 * before and after. The lens inside the terrain:
 *
 *   - riding: Tà Xùa 2.92% of frames and 0.70 m under at worst, Tràng An 1.06%
 *     and 1.04 m. Both 0.00% and nothing after.
 *   - running the steep legs: Tà Xùa 1.15% and 0.80 m, Tràng An 2.08% and
 *     1.44 m. Both 0.00% and nothing after.
 *   - the gentle walks, and every pass at Hội An and Hồ Tây, which are flat:
 *     0.00% before and after. There is no lag without a climb.
 *
 * And the whole figure drawn behind the ground, which is the picture that was
 * sent: riding, Tà Xùa 2.46% of frames and 0.51 m over the sight line to the
 * head, Tràng An 0.72% and 0.84 m — both to 0.00%.
 *
 * None of it was the sweep, which is why `OCCLUSION_SAMPLES` and
 * `CAMERA_CLEARANCE` are untouched. Re-run at twenty times the sweep's own
 * resolution, every worst frame at every destination agrees with the ten samples
 * to within 0.11 m: there is no crest hiding between them.
 *
 * `STEP_UP`, because that is the tallest thing the lag exists to absorb: a kerb,
 * a deck lip, a stair tread. Everything higher is a ramp the body takes
 * gradually, and a cap no shallower than the step it is smoothing cannot
 * reintroduce the jolt `PIVOT_RISE` is there to prevent.
 *
 * Downward only, and that asymmetry is load-bearing. A pivot drifting *above*
 * the body — a fast descent, a hull dropping out from under a boarding, the
 * heave of a boat — costs the rig nothing: the lens gains clearance and the
 * sweep gains room. It is the downward drift that buries the orbit centre, and
 * capping only that leaves `PIVOT_SNAP`'s eased arrival intact for exactly the
 * cases its own note lists.
 *
 * It costs nothing in comfort and gives some back, because a pivot that is where
 * the body is cannot be caught up with in a lurch. By `probe/camera-jump.ts` on
 * the same Tà Xùa ride: the worst single-frame camera move 8.07 m → 4.51 m, the
 * worst swing of the body across the frame 58.42° → 16.00°, the frames moving
 * the lens more than twice as far as the body moved 34 → 16, and the frames with
 * the rig inside the two metres a body cannot be drawn in 140 → 5 of 2,340. At
 * Hội An, where the machine reaches 55 m/s, 8.61 m → 0.93 m and 58.05° → 1.75°.
 * By `scripts/walker-camera.ts`, which is what guards the framing: the chest
 * holds x -0.075 y 0.000 across ±1.2 rad of pitch at every distance, with 0.000
 * of spread and 0.000°/frame of uncommanded swing, before and after alike.
 */
const PIVOT_SINK = STEP_UP;
/**
 * Lag the pivot stops easing and simply arrives, in metres. Larger than any step,
 * kerb, boat heave or hull drop, and smaller than a teleport, a boarding or a
 * fall — where easing would leave the camera hanging over the place the body
 * used to be and the body itself out of the picture.
 */
const PIVOT_SNAP = 2.5;
/**
 * Metres out the aim point is put. `camera.lookAt` needs a point and the rig has
 * a direction; anything far enough that the float error in the direction is
 * below a pixel will do, and 40 m is what this file has always used.
 */
const AIM_REACH = 40;
/**
 * How fast the avatar's own yaw follows the heading it is given, per second. A
 * reversal comes within ten degrees of the new heading in 0.29 s, which is about
 * as fast as a body can plant a foot and swing its hips round — set instantly, as
 * it was, a flick of the stick spun the body on the spot, which is only ever
 * visible in third person and is exactly what the rig puts in front of you.
 */
const BODY_TURN = 10;
/**
 * Seconds the rig holds its ground at `FIRST_PERSON_UNDER` against something
 * built before it gives in and comes the rest of the way to the eyes.
 *
 * Giving in on the first blocked frame is what made a doorway, a lamp post or a
 * tree you walk past read as "the character has disappeared" — and the solid
 * branch of the sweep is quantised to `standoff/OCCLUSION_SAMPLES`, 0.85 m steps
 * at the default distance, with the threshold sitting between step 2 at 1.70 and
 * step 3 at 2.55, so a block that moves by one sample is the whole difference
 * between a camera drawn in and an avatar gone. Waiting instead means a graze
 * costs a few frames of clipped shoulder, which is much the smaller problem,
 * while a camera genuinely pinned against a wall still ends up at the eyes.
 * Recovery is immediate: one clear frame and the rig is let back out.
 *
 * It is only ever the built world that gets this patience. The ground is obeyed
 * the frame it is found, because a hillside does not pass by in five frames and
 * holding two metres out against one puts the lens inside it.
 */
const FIRST_PERSON_AFTER = 0.4;
/**
 * Under this the avatar fills the lens — and the scene's near plane is 2 m, so
 * below it the body is sliced open around the camera rather than merely large.
 * Which is why this is not the knob to turn when the avatar goes missing.
 */
const FIRST_PERSON_UNDER = 2;
/**
 * How wide the walker is against a building. A `Building.radius` is the
 * circumradius of a rectangular footprint, so on the long side of a house it
 * already stands a couple of metres off the wall; the figure is tuned for that
 * slack and does not mean the body is 2.4 m across.
 */
const BODY_RADIUS = 1.2;
/**
 * How wide the walker is against something whose radius is the real thing — a
 * trunk, a pier, a ballast shoulder. Carrying `BODY_RADIUS` onto those would
 * put an invisible 2.4 m bollard round every tree in the forest.
 */
const SHOULDER = 0.45;
/**
 * Trunk radius as a share of the crown radius `nature-scatter` publishes.
 * Measured off the six tree models the forest is built from: the trunk
 * cross-section 1.5 m up a 17 m tree is 0.040 (TreeHigh003) to 0.089
 * (TreeMed001) of model height, mean 0.066, against a published crown radius of
 * 0.30 of height. So a 17 m tree is a 1.1 m-radius post, not a 5.1 m one.
 */
const TRUNK_SHARE = 0.22;
/**
 * What a body on foot weighs, kg, as something a vehicle has to reckon with.
 *
 * It is only ever read by whatever is braking for the walker, never by the
 * walker: a person struck by a coach is not a collision this models, and the
 * figure exists so the fleet's gap law has a radius and a mass to work from
 * rather than a special case for "the player, on foot".
 */
const BODY_MASS = 75;
/**
 * m/s the most a body is knocked back by being hit, and how fast that bleeds off.
 *
 * The user asked for collisions between a person and a vehicle. There is no
 * health anywhere in this app and there must not be — it is a place people open
 * to breathe in — so being hit is a shove and a loss of footing rather than
 * damage: you are knocked clear, the gait falls back to a standstill, and you
 * get up and start again. `GAIT_RAMP`'s 1.6 s back to a jog is what "getting up"
 * costs, and it is the whole of the penalty.
 *
 * 6 m/s decaying at 3 per second carries a body about 2 m, which is knocked
 * sprawling and not launched. The cap matters: the honest impulse from 12 tonnes
 * at 12 m/s into 75 kg is most of the coach's momentum and would throw a person
 * the length of the street, which stops reading as a traffic accident and starts
 * reading as a bug.
 */
const KNOCK_MAX = 6;
const KNOCK_FADE = 3;
/** Below this, m/s, the knock is spent and stops being integrated. */
const KNOCK_DONE = 0.2;
/** How far out obstacles are collected. Any one frame's step stays inside it. */
const GATHER_REACH = 8;
/**
 * Metres per collision substep. Long enough that a frame costs a handful of
 * tests, short enough that nothing on the ladder can step clean over the
 * narrowest thing in the scene — a 0.9 m-wide signal post.
 */
const SUBSTEP = 0.8;
/** The most contacts one neighbourhood is resolved against. */
const CONTACT_LIMIT = 48;
/** Shoves out of the worst overlap, then the next; four resolves a crevice. */
const PUSH_PASSES = 4;

const MIN_DISTANCE = 0;
const MAX_DISTANCE = 26;
// A real 1.78m person needs a close camera to read; the old distance was tuned
// for a 2.8m stylised figure.
const DEFAULT_DISTANCE = 8.5;
/**
 * Walking starts in third person: on a mountainside an eye-level view is a view
 * of the mountainside, while a camera a few metres up and back shows the place
 * you are standing in. V drops into first person, where looking up and down is
 * most obvious.
 */
const START_DISTANCE = DEFAULT_DISTANCE;

/** Radians per pixel of mouse travel at sensitivity 1. */
const BASE_SENSITIVITY = 0.0022;
// Nearly straight down to nearly straight up. The old ±60° made looking at the
// sky feel like the camera was refusing to move.
const MIN_PITCH = -1.4;
const MAX_PITCH = 1.4;
/**
 * Where the pitch starts, which on an orbit rig is also where the camera starts:
 * 16.4° above the body looking down at it.
 *
 * `atan(2.5 / 8.5)` — the 2.5 m the rig this replaced stood the camera over the
 * head at the default distance, recovered as an angle. It was 0.07 rad, which on
 * a rig that lifted the camera by a constant meant "aim level from up there" and
 * on an orbit means "sit at chest height"; and chest height 8.5 m behind a body
 * walking downhill is inside the hillside. Measured at Tà Xùa, the walk from the
 * spawn hides the avatar for 4.5% of itself at 0.07 and 0.6% at 0.29, where the
 * camera sits 3.7 m over the feet — which is where it has always been.
 */
const START_PITCH = -0.29;

// The action only. How you trigger it is an input-device question, and the UI
// is the only layer that knows whether there is a keyboard — it composes
// "Nhấn E để lên lái thuyền" on a pointer device and "Chạm để …" on touch.
const boardPrompt = (noun: string) => `lên lái ${noun}`;
/**
 * Getting off. "Xuống thuyền" would be wrong in the other direction — it is how
 * you say boarding a boat — so a hull keeps the bare word and a machine, where
 * there is no such reading, says which.
 */
const PROMPT_LEAVE = 'xuống';
const PROMPT_DISMOUNT = 'xuống xe';
const PROMPT_ASHORE = 'lên bờ';

/** Clip names that would let a swimmer be animated rather than only posed. */
const SWIM_CLIPS = ['swim', 'tread', 'float'];

export type Joystick = { x: number; y: number };

/**
 * Whether a point is inside a building's walls.
 *
 * The rectangle itself, not the circle around it — which is the whole of the
 * difference: a camera 8.5 m behind a walker in a village street has a clear
 * view down the lane while sitting well inside the circle drawn through the
 * corners of the houses either side, and was being pulled in to 1.70 m for it.
 *
 * `town-lanes` lays a lot out as `lx` across `width` and `lz` along `depth`,
 * placed at `lx·(cos yaw, −sin yaw) + lz·(sin yaw, cos yaw)`. Those axes are
 * orthonormal, so projecting onto them inverts the placement exactly.
 */
const insideBuilding = (building: Building, x: number, z: number): boolean => {
  const dx = x - building.x;
  const dz = z - building.z;
  const sin = Math.sin(building.yaw);
  const cos = Math.cos(building.yaw);
  const across = dx * cos - dz * sin;
  const along = dx * sin + dz * cos;
  return Math.abs(across) < building.width / 2 && Math.abs(along) < building.depth / 2;
};

/**
 * The slice of `ObstacleIndex` the walker uses. The third argument is an array
 * to fill, so the per-frame query allocates nothing once the index supports it;
 * either way it is the return value that gets read, never the array passed in.
 */
export type ObstacleQuery = {
  near: (x: number, z: number, into?: Obstacle[]) => Obstacle[];
};

/**
 * A flat surface above the ground that can be stood on — a jetty deck, a boat's
 * floorboards. Extents are measured in the platform's own frame, so a boat that
 * turns carries its walkable area round with it.
 */
export type Platform = {
  x: number;
  z: number;
  /** Rotation about Y. The long axis runs along `(sin yaw, cos yaw)`. */
  yaw: number;
  /** Half the walkable width, inside any parapet or railing. */
  halfWidth: number;
  halfLength: number;
  /** The walking surface at the platform's own centre. */
  surfaceY: number;
  /**
   * Metres risen per metre travelled along +yaw, for a ramp or a bridge
   * approach. Omitted or 0 for a level deck. A span is only ever walkable where
   * its surface is above the terrain, so a ramp should run past the point where
   * it meets the ground at both ends: the crossing is then found rather than
   * stepped over, and the walk on and off is continuous.
   */
  grade?: number;
};

/** Somewhere a swimmer can get out of the water: a ladder, cut steps, a ramp. */
export type WaterExit = {
  x: number;
  z: number;
  /** How near the swimmer must be before the way out is offered. */
  radius: number;
  /** Where they end up once they have climbed out. */
  landing: { x: number; y: number; z: number };
};

/**
 * What the rider can see of the machine — the dash.
 *
 * Every field is already somewhere in this file: `drive.along`, the three pedals
 * off `driveInput`, the boost meter and the slip and the two axle-grip figures
 * off `drive`, the gradient the ride branch reads off the surface ahead, and the
 * full-scale figure off `machine.topSpeed`. None of it was reachable from
 * outside, which is why a rider could not be shown how fast they were going.
 *
 * Deliberately a flat copy rather than the `DriveState` itself. That object is
 * integrated in place — `stepDrive` mutates it, in substeps — so a caller
 * holding a reference to it would have the numbers change under them part-way
 * through a render.
 */
export type RideTelemetry = {
  /** m/s up its own nose. Negative is being walked backwards. */
  speed: number;
  /** m/s the throttle will hold on the flat: the dial's full scale. */
  topSpeed: number;
  /** 0..1 as applied this frame. */
  throttle: number;
  brake: number;
  handbrake: number;
  /** 0..1 in the meter, and 0..1 of it actually lit. */
  boost: number;
  boosting: number;
  /** Radians the velocity lies off the nose — the drift read-out. */
  slip: number;
  /** 0..1 of each axle's grip gone. */
  frontSlide: number;
  rearSlide: number;
  /** Which gear, counted from 1 the way a rider counts them. */
  gear: number;
  /** How many there are, so the dash knows how many slots to draw. */
  gears: number;
  /**
   * Engine speed, 0 to 1 of the rev range, where 1 is the limiter. Peak power
   * sits at 0.87 of it and peak torque at 0.65, which is where they sit on a
   * real tacho — just short of the red. Pre-normalised, so the dash needs no
   * `REDLINE` of its own.
   */
  engine: number;
  /** Clutch out mid-shift: no drive and no engine braking for `SHIFT_TIME`. */
  shifting: boolean;
  /** The gearbox is shifting itself, for the AUTO/TAY lamp. */
  auto: boolean;
  /** Metres risen per metre travelled, under the wheels. */
  grade: number;
  /** What it is, for the label: 'xe máy'. */
  noun: string;
};

export type WalkerOptions = {
  /** Enables wading and swimming. Null at a destination with no water. */
  water?: WaterParams | null;
  /** Decks that can be stood on — the jetty walkway. */
  platforms?: Platform[];
  /** Ladders and cut steps a swimmer can climb out at. */
  exits?: WaterExit[];
  /** Live boat transforms, straight from `life.rideables`. */
  rideables?: () => Rideable[];
  /**
   * Solid things at ground level whose `radius` is the real footprint — railway
   * embankments, bridge piers, platform edges, signal posts. Separate from the
   * canopy index because a crown radius is four times its trunk's and because
   * these have a `bottom` that means something: a viaduct soffit overhead is
   * walked under, not into.
   */
  obstacles?: ObstacleQuery;
  /**
   * The near-field trees standing around the viewer, for the camera sweep only.
   * A getter rather than the array because `tree-near` rewrites its crowns in
   * place every `update` — so this is read fresh each frame and never held.
   *
   * There is no index behind it and none is wanted: the set is already only the
   * trees within the near-field radius of the walker, which is what the index
   * would have been asked for.
   */
  nearCrowns?: () => Obstacle[];
  /**
   * The moving bodies a driven machine can hit — the NPC fleet, and whichever
   * companions in the room are riding.
   *
   * This is the other half of the user's report that there is no collision
   * between vehicles at all. The machine branch below resolved against *static*
   * circles only, so the fleet and the other players were not solid: you drove
   * through a coach. `driving-collision.ts` has had the whole answer for a while
   * and was unused, because what was missing was the list.
   *
   * Several getters rather than one array, for two reasons. Each source rewrites
   * its bodies in place every frame — `vehicles.traffic` at the end of its tick,
   * `avatar-ride.traffic` as each machine is placed — so they are read fresh and
   * never held, the way `nearCrowns` is. And taking several means nothing has to
   * concatenate them into a merged array sixty times a second just to hand them
   * over, which is the one thing a per-frame getter must not do.
   *
   * Nothing in the list is ever the machine the player is on: the fleet publishes
   * only its moving vehicles, never the parked bikes, and a companion is by
   * definition somebody else.
   */
  traffic?: (() => readonly Impactor[])[];
  /**
   * How wet the road is, 0 to 1, read fresh each frame because the weather moves.
   *
   * Only a driven machine asks: wet asphalt holds about 0.7 of its dry grip, and
   * a dirt lane in the rain is worse than that. Feet do not care — a body walks
   * the same in the rain — which is why this is a getter for the one branch that
   * needs it and not a parameter the whole file carries.
   */
  wetness?: () => number;
  /** Overrides the `prefers-reduced-motion` media query, for tests. */
  reducedMotion?: boolean;
  /**
   * Lets the cinematic extras reach the camera: the roll a stride and a bend
   * carry into the horizon, the lean of a boat under you, and the lens widening
   * with speed. Off by default, and independent of `reducedMotion` — those three
   * are the documented motion-sickness triggers in this file, and the view is
   * comfortable for everybody before it is cinematic for anybody. The body and
   * the hull still lean whatever this says; only the camera stops joining in.
   */
  cameraMotion?: boolean;
};

export type Walker = {
  group: Group;
  position: Vector3;
  yaw: number;
  /**
   * Where the *camera* is pointed, as against where the body faces.
   *
   * They are the same standing still and part company the moment somebody
   * walks: `yaw` is eased toward the direction of travel, while this is the
   * player's own hand on the mouse. Anything telling a player which way to turn
   * has to use this one — an arrow drawn off the body's yaw points relative to
   * where the legs are going, which on a strafe is ninety degrees out.
   */
  viewYaw: number;
  update: (delta: number, camera: PerspectiveCamera) => void;
  setJoystick: (input: Joystick | null) => void;
  setSensitivity: (value: number) => void;
  /** Flips `WalkerOptions.cameraMotion` while the scene is running. */
  setCameraMotion: (value: boolean) => void;
  /** 'first' puts the camera at the eyes; 'third' trails behind the shoulder. */
  setView: (view: 'first' | 'third') => void;
  toggleView: () => void;
  onViewChange: (handler: ((view: 'first' | 'third') => void) | null) => void;
  /** Called whenever the pointer is locked or released. */
  onLockChange: (handler: ((locked: boolean) => void) | null) => void;
  requestLock: () => void;
  teleport: (x: number, z: number) => void;
  /** The action available where the walker stands, in Vietnamese, without a key. */
  prompt: () => string | null;
  /** Takes that action. The same queue the E key feeds, so a tap and a keypress
   *  resolve against the same frame's idea of what is alongside. */
  interact: () => void;
  /**
   * The walker as something that can be driven into: the machine's own body
   * while riding, a person's shoulders on foot.
   *
   * Rewritten in place and handed out by reference, like everything else that
   * crosses this boundary. The fleet reads it to brake — and it is a body rather
   * than a ride on purpose: a coach driving through somebody standing in the
   * lane is the same bug as a coach driving through somebody on a bike, and
   * braking for one and not the other would have fixed the symptom the user
   * happened to name.
   */
  body: () => Impactor;
  /**
   * What the rider can see of the machine, or null on foot.
   *
   * Read fresh each frame by the HUD, and a copy rather than the live
   * `DriveState` for the reason recorded on `RideTelemetry`. Null aboard a boat
   * too: a hull has no throttle, no brake, no axles and no gradient, so eight of
   * the eleven numbers would be zeroes dressed as readings.
   */
  telemetry: () => RideTelemetry | null;
  /** True while slaved to a boat's deck or astride a machine. */
  riding: () => boolean;
  /** Which rideable, or null. The maps need it to stop offering you the bike you
   *  are sitting on as somewhere to walk to. */
  ridingId: () => string | null;
  /**
   * Replaces the walkable spans — bridge decks and approaches, jetty decks and
   * ramps. A setter as well as an option because the modules that build bridges
   * are created after the walker is.
   */
  setPlatforms: (spans: Platform[]) => void;
  /** Ripples, wake and waterline — world space, so the owner adds it to the scene. */
  waterEffects: Group | null;
  setNight: (amount: number) => void;
  dispose: () => void;
};

/** The gait ladder as one continuous curve, so analog input has somewhere to go. */
const speedForGait = (gait: number): number =>
  gait < 0.5
    ? STROLL_SPEED + (WALK_SPEED - STROLL_SPEED) * (gait / 0.5)
    : WALK_SPEED + (JOG_SPEED - WALK_SPEED) * ((gait - 0.5) / 0.5);

/**
 * Step length grows with pace — 0.8 m at a stroll, 1.1 m at a jog. It drives the
 * body's roll only. The clip rate used to come off it too, and being a curve
 * fitted by hand rather than read off the rig it called a 4.5 m/s running step
 * 1.09 m against the 1.31 m the run clip was drawn with; `HumanSource.strides`
 * is the measured answer and the clip rate uses that instead.
 */
const stepLength = (speed: number): number => 0.68 + speed * 0.09;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** A stable per-boat phase, so two hulls alongside do not rock in unison. */
const phaseOf = (id: string): number => {
  let value = 0;
  for (let index = 0; index < id.length; index += 1) value = (value * 31 + id.charCodeAt(index)) % 977;
  return (value / 977) * Math.PI * 2;
};

/**
 * Mouse-look on foot, the way a third-person game does it: click to capture the
 * pointer, then the mouse turns the camera and WASD moves relative to where you
 * are looking. Dragging to turn — the first version — meant you could not look
 * and walk at the same time, which is most of what moving through a place is.
 *
 * Water is a place too: walking into the river wades, then swims, then climbs
 * out at any bank gentle enough to haul up or at the jetty's ladder. E boards
 * whatever boat is alongside and hands the body over to its deck.
 */
export const createWalker = (
  terrain: Terrain,
  domElement: HTMLElement,
  startX: number,
  startZ: number,
  buildings: Building[] = [],
  /**
   * Tree crowns. Read twice over: at the published radius to keep the camera out
   * of the foliage, and at `TRUNK_SHARE` of it for the post underneath, which is
   * what a body walks into.
   */
  canopy?: ObstacleQuery,
  /** Which way to face on arrival — pointed at something worth looking at. */
  initialYaw = 0,
  humanSource?: HumanSource,
  options: WalkerOptions = {}
): Walker => {
  const water = options.water ?? null;
  const platforms = options.platforms ?? [];
  const exits = options.exits ?? [];
  const rideables = options.rideables ?? null;
  const solids = options.obstacles ?? null;
  const nearCrowns = options.nearCrowns ?? null;
  const traffic = options.traffic ?? null;
  const wetness = options.wetness ?? (() => 0);

  const motionQuery =
    options.reducedMotion === undefined && typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  let reducedMotion = options.reducedMotion ?? motionQuery?.matches ?? false;
  let cameraMotion = options.cameraMotion ?? false;
  const onMotionChange = (event: MediaQueryListEvent) => {
    reducedMotion = event.matches;
  };
  motionQuery?.addEventListener('change', onMotionChange);

  const parts = createPersonParts();
  const bodyMaterial = new MeshStandardMaterial({
    color: new Color('#b4552f'),
    flatShading: true,
    roughness: 0.92,
    metalness: 0,
  });
  const hatMaterial = new MeshStandardMaterial({
    color: new Color('#f0dba8'),
    flatShading: true,
    roughness: 0.92,
    metalness: 0,
  });

  const group = new Group();
  group.name = 'walker';

  // A rigged human when the model is available, the old primitive figure when it
  // is not — the scene must still work if the download fails.
  const human: Human | null = humanSource ? createHuman(humanSource, '#b4552f') : null;
  const bodyMesh = new Mesh(parts.body, bodyMaterial);
  const hatMesh = new Mesh(parts.hat, hatMaterial);

  // The floating body tips about its waist rather than its feet, so the pivot
  // has to sit where the waist is and the model hang back down from it.
  const floatPivot = new Group();
  floatPivot.position.y = FLOAT_PIVOT;

  if (human) {
    human.group.position.y = -FLOAT_PIVOT;
    floatPivot.add(human.group);
    group.add(floatPivot);
    human.play('idle');
  } else {
    bodyMesh.position.y = -FLOAT_PIVOT;
    hatMesh.position.y = -FLOAT_PIVOT;
    floatPivot.add(bodyMesh, hatMesh);
    group.add(floatPivot);
  }

  const swimClip = SWIM_CLIPS.find((name) =>
    (humanSource?.clips ?? []).some((clip) => clip.name.toLowerCase().includes(name))
  );

  /**
   * Seconds in one cycle of the clip `Human.play` would pick for this fragment,
   * matched the same way it matches, or 0 if the rig has no such clip. Read from
   * the model rather than written down: the stride is only matched to the ground
   * if the cycle length is the real one, and a rig swapped underneath this file
   * would otherwise go back to skating silently.
   */
  const clipFor = (fragment: string): AnimationClip | undefined =>
    (humanSource?.clips ?? []).find((clip) => clip.name.toLowerCase().includes(fragment));
  const clipCycle = (fragment: string): number => clipFor(fragment)?.duration ?? 0;
  /** Metres that cycle was drawn to cover, measured off the rig at load. */
  const clipStride = (fragment: string): number => {
    const clip = clipFor(fragment);
    return clip ? (humanSource?.strides.get(clip.name) ?? 0) : 0;
  };
  const walkCycle = clipCycle('walk');
  const runCycle = clipCycle('run');
  const walkStride = clipStride('walk');
  const runStride = clipStride('run');

  const effects: SwimEffects | null = water ? createSwimEffects(water) : null;
  const waterline: Waterline | null = water ? createWaterline() : null;

  if (waterline) {
    const soak = (object: Group) => {
      object.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        if (Array.isArray(node.material)) for (const entry of node.material) waterline.attach(entry);
        else waterline.attach(node.material);
      });
    };
    if (human) soak(human.group);
    else {
      waterline.attach(bodyMaterial);
      waterline.attach(hatMaterial);
    }
  }

  const eyeHeight = human ? EYE_HEIGHT : PERSON_HEIGHT * 0.9;

  // --- what the world is made of, as far as a body is concerned --------------
  // One query covering buildings, trunks and lineside structures, resolved as
  // circles the body cannot enter. Flat arrays rather than objects because this
  // is refilled every frame and a forest neighbourhood is dozens of entries.
  const contactX = new Float64Array(CONTACT_LIMIT);
  const contactZ = new Float64Array(CONTACT_LIMIT);
  const contactReach = new Float64Array(CONTACT_LIMIT);
  let contactCount = 0;
  /** Filled by whichever index was asked last, read before the next ask. */
  const nearby: Obstacle[] = [];

  /** The last place the body stood that nothing overlapped. */
  let safeX = startX;
  let safeZ = startZ;

  const addContact = (x: number, z: number, cx: number, cz: number, reach: number) => {
    if (contactCount >= CONTACT_LIMIT) return;
    const dx = x - cx;
    const dz = z - cz;
    const span = GATHER_REACH + reach;
    if (dx * dx + dz * dz > span * span) return;
    contactX[contactCount] = cx;
    contactZ[contactCount] = cz;
    contactReach[contactCount] = reach;
    contactCount += 1;
  };

  /**
   * Everything solid within a frame's reach of a point, at the height the body
   * is standing. Anything whose top is within a step is walked over — a kerb, a
   * rail, a low revetment — and anything whose bottom is over the head is walked
   * under, which is the difference between a viaduct and a wall.
   */
  const gatherContacts = (x: number, z: number, foot: number) => {
    contactCount = 0;
    const walkOver = foot + STEP_UP;
    const head = foot + eyeHeight;

    for (let index = 0; index < buildings.length; index += 1) {
      const building = buildings[index];
      if (building.top <= walkOver) continue;
      addContact(x, z, building.x, building.z, building.radius + BODY_RADIUS);
    }

    if (canopy) {
      const trees = canopy.near(x, z, nearby);
      for (let index = 0; index < trees.length; index += 1) {
        const tree = trees[index];
        // The index publishes the crown, but the trunk holding it up runs from
        // the ground, so only the top of the entry is a height test at all.
        if (tree.top <= walkOver) continue;
        addContact(x, z, tree.x, tree.z, tree.radius * TRUNK_SHARE + SHOULDER);
      }
    }

    if (solids) {
      const found = solids.near(x, z, nearby);
      for (let index = 0; index < found.length; index += 1) {
        const solid = found[index];
        if (solid.top <= walkOver || solid.bottom >= head) continue;
        addContact(x, z, solid.x, solid.z, solid.radius + SHOULDER);
      }
    }
  };

  /** Which contact a point is deepest inside, set by `deepestAt`. -1 if clear. */
  let worstContact = -1;

  /** How far inside the worst overlap a point is, in metres. 0 means clear. */
  const deepestAt = (x: number, z: number): number => {
    worstContact = -1;
    let worst = 0;

    for (let index = 0; index < contactCount; index += 1) {
      const dx = x - contactX[index];
      const dz = z - contactZ[index];
      const reach = contactReach[index];
      const squared = dx * dx + dz * dz;
      if (squared >= reach * reach) continue;
      const overlap = reach - Math.sqrt(squared);
      if (overlap <= worst) continue;
      worst = overlap;
      worstContact = index;
    }

    return worst;
  };

  /** Clear of everything solid, and a surface whatever is taking the step can use. */
  const stepTo = (x: number, z: number): boolean => deepestAt(x, z) === 0 && passable(x, z);

  /**
   * Takes the part of a blocked step that ran along the surface and throws away
   * the part that ran into it, then rides the result back out to the surface —
   * on a trunk the tangent leaves the circle immediately, so without that second
   * half the slide stalls after a few centimetres. Resolving radially instead,
   * the way the old building push did, cancels the whole step rather than the
   * blocked part of it, which is exactly what sticking to a wall feels like.
   */
  const slideAlong = (fromX: number, fromZ: number, wantX: number, wantZ: number): boolean => {
    const index = worstContact;
    if (index < 0) return false;

    const outX = wantX - contactX[index];
    const outZ = wantZ - contactZ[index];
    const span = Math.hypot(outX, outZ);
    if (span < 1e-4) return false;

    const normalX = outX / span;
    const normalZ = outZ / span;
    const moveX = wantX - fromX;
    const moveZ = wantZ - fromZ;
    const into = moveX * normalX + moveZ * normalZ;
    if (into >= 0) return false;

    let slideX = fromX + moveX - normalX * into;
    let slideZ = fromZ + moveZ - normalZ * into;
    const reach = contactReach[index];
    const awayX = slideX - contactX[index];
    const awayZ = slideZ - contactZ[index];
    const away = Math.hypot(awayX, awayZ);
    if (away > 1e-4 && away < reach) {
      slideX = contactX[index] + (awayX / away) * reach;
      slideZ = contactZ[index] + (awayZ / away) * reach;
    }

    if (!stepTo(slideX, slideZ)) return false;
    position.x = slideX;
    position.z = slideZ;
    return true;
  };

  /**
   * One substep of the walk. Nothing is ever committed without having been
   * tested against every contact, so resolving out of one obstacle can never
   * leave the body inside another and no gap narrower than the body can be
   * squeezed through.
   */
  const stepToward = (wantX: number, wantZ: number) => {
    const fromX = position.x;
    const fromZ = position.z;

    if (deepestAt(wantX, wantZ) === 0) {
      if (!passable(wantX, wantZ)) {
        // A bank too steep to climb is refused per axis, so a swimmer slides
        // along a cut bank instead of sticking to it.
        if (stepTo(wantX, fromZ)) position.x = wantX;
        else if (stepTo(fromX, wantZ)) position.z = wantZ;
        return;
      }
      position.x = wantX;
      position.z = wantZ;
      return;
    }

    if (slideAlong(fromX, fromZ, wantX, wantZ)) return;
    if (stepTo(wantX, fromZ)) position.x = wantX;
    else if (stepTo(fromX, wantZ)) position.z = wantZ;
  };

  /**
   * Shoves a body that is already inside something out of it — a spawn, a
   * teleport, a hull that drifted onto it — worst overlap first. The result is
   * only committed once it has been checked clear, because pushing radially out
   * of one trunk can put you straight inside the next and the honest answer in a
   * crevice too narrow to stand in is the last place that was not.
   */
  const depenetrate = () => {
    if (deepestAt(position.x, position.z) === 0) {
      safeX = position.x;
      safeZ = position.z;
      return;
    }

    let x = position.x;
    let z = position.z;
    for (let pass = 0; pass < PUSH_PASSES; pass += 1) {
      if (deepestAt(x, z) === 0) break;
      const index = worstContact;
      const dx = x - contactX[index];
      const dz = z - contactZ[index];
      const span = Math.hypot(dx, dz);
      // Dead centre has no direction to push along, so pick one.
      const angle = span < 1e-4 ? Math.random() * Math.PI * 2 : Math.atan2(dz, dx);
      x = contactX[index] + Math.cos(angle) * contactReach[index];
      z = contactZ[index] + Math.sin(angle) * contactReach[index];
    }

    if (deepestAt(x, z) === 0) {
      position.x = x;
      position.z = z;
      safeX = x;
      safeZ = z;
      return;
    }

    if (deepestAt(safeX, safeZ) === 0) {
      position.x = safeX;
      position.z = safeZ;
      return;
    }

    // Nowhere within reach is clear. Taking the best of a bad set beats locking
    // the body in place for ever.
    position.x = x;
    position.z = z;
  };

  type Deck = {
    platform: Platform;
    alongX: number;
    alongZ: number;
    grade: number;
    /** Squared radius of the circle around the footprint, for a cheap reject. */
    reachSquared: number;
  };

  // Each span's own axes, resolved once: `floorAt` runs a dozen times a frame —
  // the body, the ten occlusion samples, the ground behind the camera — and
  // trigonometry in there would be wasted work.
  let decks: Deck[] = [];
  const indexPlatforms = (list: Platform[]) => {
    decks = list.map((platform) => ({
      platform,
      alongX: Math.sin(platform.yaw),
      alongZ: Math.cos(platform.yaw),
      grade: platform.grade ?? 0,
      reachSquared: (platform.halfLength + platform.halfWidth) ** 2,
    }));
  };
  indexPlatforms(platforms);

  /**
   * The highest walkable surface under a point: the ground, or any span over it
   * whose surface is within one step of where the walker already is. The
   * reference is what keeps a bridge overhead overhead — without it, walking
   * under a jetty or a viaduct would teleport you onto the deck.
   */
  const floorAt = (x: number, z: number, reference: number): number => {
    let best = terrain.heightAt(x, z);

    for (let index = 0; index < decks.length; index += 1) {
      const deck = decks[index];
      const dx = x - deck.platform.x;
      const dz = z - deck.platform.z;
      if (dx * dx + dz * dz > deck.reachSquared) continue;

      const along = dx * deck.alongX + dz * deck.alongZ;
      if (Math.abs(along) > deck.platform.halfLength) continue;
      const across = dx * deck.alongZ - dz * deck.alongX;
      if (Math.abs(across) > deck.platform.halfWidth) continue;

      // The surface at this point, not at the span's centre: a graded approach
      // is only a step at its ends, and the whole point is that it is not one.
      const surface = deck.platform.surfaceY + deck.grade * along;
      if (surface <= best || surface > reference + STEP_UP) continue;
      best = surface;
    }

    return best;
  };

  /**
   * Water over the bed, with nothing built above it counted. Only the walk off
   * a boat wants this, because it lands on the terrain rather than on whatever
   * span happens to cross the spot.
   */
  const bedDepthAt = (x: number, z: number): number => (water ? Math.max(0, water.level - terrain.heightAt(x, z)) : 0);

  /**
   * Water a body standing here would be in: the surface it would stand on
   * against the waterline, not the bed against the waterline.
   *
   * It has to ask `floorAt` for the same reason `floorAt` exists — a road over
   * forty metres of river is still a road. Read straight off the terrain, the
   * Thu Bồn bridge made `afloat` 1 in the middle of its deck, and the gait
   * ladder then pulls the whole target towards `SWIM_SPEED`: measured 1.10 m/s
   * on a seven-metre carriageway two and a half metres above the water, which
   * is what the user hit as not being able to run across a bridge. `reference`
   * carries straight through, so a deck overhead is still overhead and the swim
   * under the arches is still a swim.
   */
  const depthAt = (x: number, z: number, reference: number): number =>
    water ? Math.max(0, water.level - floorAt(x, z, reference)) : 0;

  /**
   * Whether a body in the water can finish a step onto this point. Staying in
   * the water always can; leaving it only where the bank is shallow enough to
   * haul up, which is what makes a cut bank a wall and a shelving one a way out.
   *
   * Gated on the depth it is standing in rather than on how afloat it is: the
   * climb happens at thigh depth, by which point nothing is floating any more,
   * so an `afloat` gate let a swimmer walk straight up a cliff.
   *
   * The bed, not the floor, for the point being stepped to: this asks whether
   * there is still river there, and a span crossing overhead does not make the
   * river shallower. Anyone standing on that span has `depth` 0 and never
   * reaches the question.
   */
  const climbable = (x: number, z: number): boolean =>
    depth <= WADE_DEPTH || bedDepthAt(x, z) > WADE_DEPTH || terrain.slopeAt(x, z) <= CLIMB_SLOPE;

  /**
   * What the walker is riding, declared up here because every step test below has
   * to know whether it is a pair of feet or a machine taking the step.
   */
  let ride: Rideable | null = null;

  /**
   * Whether a machine may finish a step here, which is a stricter question than
   * whether a body may.
   *
   * A made surface is graded and is ridden as found; bare ground is only as
   * rideable as it is steep, and the limit is the machine's own. It has to be
   * stricter: `CLIMB_SLOPE` lets a body scramble up 49°, and a motorbike that
   * does the same is the bug. Water is read against the surface the wheels are on
   * for the same reason `depthAt` does — a road over a river is still a road.
   */
  const ridable = (machine: Machine, x: number, z: number): boolean => {
    const floor = floorAt(x, z, footY);
    if (floor <= terrain.heightAt(x, z) + MADE_SURFACE && terrain.slopeAt(x, z) > machine.climb) return false;
    return !water || water.level - floor <= machine.ford;
  };

  /** The step test for whatever is taking the step. */
  const passable = (x: number, z: number): boolean => (ride?.machine ? ridable(ride.machine, x, z) : climbable(x, z));

  // A couple of metres of scatter so two friends arriving together do not stand
  // inside each other — then shoved clear of whatever it landed in.
  const spawnX = startX + (Math.random() - 0.5) * 9;
  const spawnZ = startZ + (Math.random() - 0.5) * 9;
  const position = new Vector3(spawnX, terrain.heightAt(spawnX, spawnZ), spawnZ);
  gatherContacts(spawnX, spawnZ, position.y);
  depenetrate();
  position.y = terrain.heightAt(position.x, position.z);
  group.position.copy(position);

  const pressed = new Set<string>();
  let joystick: Joystick | null = null;
  let sensitivity = 1;
  let yaw = initialYaw;
  let cameraYaw = initialYaw;
  let cameraPitch = START_PITCH;
  let distance = START_DISTANCE;
  let locked = false;
  let dragging = false;
  const lastPointer = { x: 0, y: 0 };
  let lockHandler: ((value: boolean) => void) | null = null;
  let viewHandler: ((view: 'first' | 'third') => void) | null = null;

  let elapsed = 0;
  let gait = 0;
  let travel = 0;
  let groundSpeed = 0;
  let stridePhase = 0;
  let footY = position.y;
  /** The eased foot height. `footY` is the surface; this is where the body is. */
  let standY = position.y;
  let afloat = 0;
  let swimPhase = 0;
  let wet = 0;
  let depth = 0;
  let wasWading = false;
  let promptText: string | null = null;
  let interactQueued = false;

  let ridePhase = 0;
  let rideAcross = 0;
  let rideAlong = 0;
  let rideHeave = 0;
  let rideLastY = 0;
  /** m/s the machine is doing, and which way it points. Integrated, never set. */
  let rideSpeed = 0;
  let rideHeading = 0;
  /** Rad/s it is turning at, kept so the machine can be leant into the bend. */
  let rideTurn = 0;
  /**
   * The machine's own dynamics, live only while somebody is on one.
   *
   * Both are made at `board` and thrown away at `stepOff`: a `DriveState` is the
   * velocity, the yaw rate, the slip and the boost meter, and none of that
   * survives getting off. The tuning is derived once from the machine's spec
   * rather than per frame, because `tuneDrive` works out the yaw inertia and the
   * friction limits and those do not change while you ride.
   */
  let drive: DriveState | null = null;
  let tuning: DriveTuning | null = null;
  const driveInput: DriveInput = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: 0,
    boost: false,
    shift: 0,
    auto: true,
  };
  /**
   * One gear the rider has asked for, held until the next `stepDrive` takes it.
   *
   * An edge and not a held key: `stepDrive` consumes `shift` once before it
   * substeps, and a key still down on the next frame would shift again every
   * `SHIFT_TIME` and walk the box from first to top in under a second. The
   * `!event.repeat` below is what makes one press one gear.
   */
  let pendingShift: -1 | 0 | 1 = 0;
  /**
   * Whether the box is shifting itself.
   *
   * It matters more than a convenience: measured on a real road, the automatic
   * takes a gear tall enough to carry the machine off the carriageway at 80% of
   * every mountain run, while a rider holding one gear stays on it and covers
   * 1.5 to 1.9 times what a body does on foot. So the gear is not a tuning knob,
   * it is the governor a rider chooses — and a paddle press is itself the
   * request to take over, so nobody has to find the mode key first.
   */
  let autoBox = true;
  const driveSurface: DriveSurface = { grade: 0, grip: 1, made: false, draft: 0 };
  const impact = createImpact();
  /** This walker as something else can hit, rewritten in place by `body()`. */
  const self = createImpactor();
  /** m/s a body on foot is still being carried by having been hit. */
  let knockX = 0;
  let knockZ = 0;
  /** The dash, refilled by `telemetry()`. Allocated once: the HUD reads it every frame. */
  const dash: RideTelemetry = {
    speed: 0,
    topSpeed: 0,
    throttle: 0,
    brake: 0,
    handbrake: 0,
    boost: 0,
    boosting: 0,
    slip: 0,
    frontSlide: 0,
    rearSlide: 0,
    gear: 1,
    gears: 1,
    engine: 0,
    shifting: false,
    auto: true,
    grade: 0,
    noun: '',
  };
  /** 0 to 1, how far the camera has been let out behind a machine under way. */
  let rideBack = 0;
  /** Seconds until the live boat list is read again; not needed every frame. */
  let refreshIn = 0;
  let boardable: Rideable | null = null;
  let boardGap = Infinity;
  let exitNear: WaterExit | null = null;
  let exitGap = Infinity;

  /** Seconds the camera has been held inside the avatar's space. */
  let crowded = 0;

  /**
   * 1 the frame the player last moved the view, decaying to nothing afterwards.
   *
   * The machine's nose-follower is scaled by what is left of it, and that is the
   * difference between "the offset falls away after the player stops asking" and
   * "the offset is fought while they are still asking". Measured without it by
   * `probe/ride-heading.ts`: a mouse held at an unhurried 60°/s against the
   * follower settled 24.4° off the nose and went no further, because a
   * first-order follower at rate `k` cancels a drag of `w` at an offset of
   * exactly `w / k`. Four seconds of dragging bought a quarter of a turn. That
   * would have taken the lanterns and the lake off the list of things you can
   * look at from a moving machine, which is most of why there is a machine.
   *
   * A hand that is moving produces a `mousemove` every frame, so a drag pins
   * this at 1 and the follower is off for the whole of it. It fades back in as
   * this decays rather than switching on at a threshold, so there is no frame
   * where the recentring starts abruptly.
   */
  let lookHold = 0;

  /**
   * The point the camera orbits about, chasing the body rather than welded to
   * it. Started on the body so the first frame is the rig rather than a flight
   * in from wherever the pivot was initialised.
   */
  let pivotX = position.x;
  let pivotZ = position.z;
  let pivotY = position.y + eyeHeight * CHEST_SHARE;
  /** How far the camera is actually sitting out, after occlusion and easing. */
  let orbit = START_DISTANCE;

  /**
   * How far the ground is over the rig's line `reach` metres out from the pivot,
   * negative while the lens is clear of it. The whole of the ground occlusion
   * test, and the only thing the sweep below needs to find the crossing.
   *
   * Takes the line as arguments rather than closing over it: it is called a
   * dozen times a frame, and a closure rebuilt every frame for the sake of five
   * fewer characters at each call site is the same allocation the obstacle
   * queries were rewritten to avoid.
   */
  const lensDeficit = (reach: number, lineX: number, lineZ: number, lift: number, reference: number): number => {
    const x = pivotX - lineX * reach;
    const z = pivotZ - lineZ * reach;
    const floor = floorAt(x, z, reference) + CAMERA_CLEARANCE;
    return (water ? Math.max(floor, water.level + WATER_SKIM) : floor) - (pivotY - lift * reach);
  };

  let fovBase = 0;
  let fovApplied = Number.NaN;

  const applyView = (view: 'first' | 'third') => {
    distance = view === 'first' ? 0 : DEFAULT_DISTANCE;
    viewHandler?.(view);
  };

  const look = (deltaX: number, deltaY: number) => {
    cameraYaw -= deltaX * BASE_SENSITIVITY * sensitivity;
    cameraPitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, cameraPitch - deltaY * BASE_SENSITIVITY * sensitivity));
    // The hand is on the view, so the nose-follower below stands down. Set here
    // rather than in either handler because this is the one funnel both the
    // locked mouse and a thumb dragging the screen come through.
    lookHold = 1;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    pressed.add(event.code);
    // V is the usual key for this in third-person shooters, and having it on the
    // keyboard means the view can be changed without letting go of the mouse.
    if (event.code === 'KeyV') applyView(distance > 1 ? 'first' : 'third');
    // Queued rather than acted on here: boarding needs the frame's own idea of
    // what is alongside, and a held key must not board twice.
    if (event.code === 'KeyE' && !event.repeat) interactQueued = true;
    // The paddles sit under the right hand on a WASD layout and none of the
    // three was taken. G is a toggle rather than a hold, so it cannot fight
    // anything that is being held down.
    if (event.code === 'Period' && !event.repeat) pendingShift = 1;
    if (event.code === 'Comma' && !event.repeat) pendingShift = -1;
    if (event.code === 'KeyG' && !event.repeat) autoBox = !autoBox;
  };
  const onKeyUp = (event: KeyboardEvent) => pressed.delete(event.code);

  const onMouseMove = (event: MouseEvent) => {
    if (!locked) return;
    look(event.movementX, event.movementY);
  };

  const onLockChange = () => {
    locked = document.pointerLockElement === domElement;
    lockHandler?.(locked);
  };

  /**
   * Whether this browser has refused the pointer outright, as against refusing
   * one request.
   *
   * Chrome rejects any request made within about a second of the user's own exit
   * — that is the anti-pointer-trap rule — and pressing ESC and clicking straight
   * back into the scene is the commonest path through this file, because ESC is
   * also what opens the pause menu. That refusal clears by itself, so it stays
   * false for one and the next press asks again. A refusal for any other reason —
   * no API, a frame that is not allowed the pointer — never clears, and asking
   * once per press for the rest of the session is pure noise. Guessing wrong in
   * that direction is the cheap one: a redundant request costs a caught
   * rejection, while latching on a refusal that was only the cooldown would kill
   * pointer lock for the session over one press of ESC.
   */
  let lockDenied = false;

  const requestLock = (pointerType = 'mouse') => {
    // Only a mouse can be captured, so a finger asking for it earns a rejection
    // and nothing else.
    if (lockDenied || pointerType === 'touch') return;
    if (document.pointerLockElement === domElement) return;
    // The refusal arrives as a rejected promise, and leaving it unhandled was two
    // red lines in the console and a devtools issue badge every time somebody
    // left with ESC and clicked back in. There is nothing to recover here and
    // nothing is being swallowed: a refusal leaves `locked` false, which is the
    // state the HUD already reads to put the "kéo để nhìn quanh" hint back up,
    // and the press that asked has already armed the drag below. Older engines
    // return undefined instead of a promise, hence the resolve.
    void Promise.resolve(domElement.requestPointerLock?.()).catch((error: unknown) => {
      lockDenied = !(error instanceof DOMException) || error.name !== 'SecurityError';
    });
  };

  // Dragging looks around for every pointer type, not just touch. Excluding the
  // mouse meant that if pointer lock did not engage — a blocked request, a click
  // that landed on the HUD, a browser that refuses it — there was no way to tilt
  // the view at all, and the whole thing felt stuck flat.
  const onPointerDown = (event: PointerEvent) => {
    if (locked) return;
    dragging = true;
    lastPointer.x = event.clientX;
    lastPointer.y = event.clientY;
    // Capture only keeps the moves coming once the cursor leaves the canvas;
    // `onPointerMove` is on the window, so the drag reads them either way. It
    // throws `InvalidStateError` when the pointer id is already inactive by the
    // time this runs, which is not a reason to abandon a gesture that works.
    try {
      domElement.setPointerCapture?.(event.pointerId);
    } catch {
      // The drag stands; only the off-canvas part of it is lost.
    }
    // Asked for on the press, not on the click that follows it, so one gesture
    // covers both answers: granted, and `onPointerMove` stands aside for the
    // locked mouse; refused, and the drag this press just armed is already
    // carrying the view. Asked for on the click it was neither — the pointer was
    // back up by then, so a click the browser refused did nothing at all.
    if (event.isPrimary && event.button === 0) requestLock(event.pointerType);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging || locked) return;
    const gain = event.pointerType === 'touch' ? 1.8 : 1.1;
    look((event.clientX - lastPointer.x) * gain, (event.clientY - lastPointer.y) * gain);
    lastPointer.x = event.clientX;
    lastPointer.y = event.clientY;
  };
  const stopDragging = () => {
    dragging = false;
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const before = distance > 1;
    distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, distance + Math.sign(event.deltaY) * 1.6));
    if (before !== distance > 1) viewHandler?.(distance > 1 ? 'third' : 'first');
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', onLockChange);
  domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', stopDragging);
  window.addEventListener('pointercancel', stopDragging);
  domElement.addEventListener('wheel', onWheel, { passive: false });

  const forward = new Vector3();
  const right = new Vector3();
  const move = new Vector3();
  const step = new Vector3(Math.sin(initialYaw), 0, Math.cos(initialYaw));
  const frame: SwimFrame = { x: 0, z: 0, depth: 0, afloat: 0, speed: 0, heading: 0, stroke: 0, lens: 0, wet: 0 };
  /**
   * Whether the lens was at the rider's own eyes last frame.
   *
   * One frame behind, and it has to be: whether the rig is at the eyes is
   * decided in the camera block, which runs after `machine.place` has already
   * been handed this frame's `Ridden`. Hoisting the decision would mean working
   * the occlusion sweep out twice. A visibility toggle a sixtieth of a second
   * late is not something anybody can see; the figure appearing for one frame
   * when the view changes is the worst it can do, and the view does not change
   * often.
   */
  let atEyes = false;
  const ridden: Ridden = {
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    firstPerson: false,
    speed: 0,
    turn: 0,
    grade: 0,
    delta: 0,
    slip: 0,
    lateral: 0,
    steer: 0,
    brake: 0,
    boost: 0,
    boosting: 0,
    frontSlide: 0,
    rearSlide: 0,
  };

  /** How far outside a deck's walkable box a point is, in metres. */
  const gapToDeck = (rideable: Rideable, x: number, z: number): number => {
    const dx = x - rideable.position.x;
    const dz = z - rideable.position.z;
    const along = dx * rideable.forward.x + dz * rideable.forward.z;
    const across = dx * rideable.forward.z - dz * rideable.forward.x;
    return Math.hypot(
      Math.max(0, Math.abs(across) - rideable.bounds.across),
      Math.max(0, Math.abs(along) - rideable.bounds.along)
    );
  };

  const board = (rideable: Rideable) => {
    ride = rideable;
    refreshIn = 0;
    // Whatever was carrying the body does not carry the machine.
    knockX = 0;
    knockZ = 0;

    if (rideable.machine) {
      // Astride it, not aboard it: the rider is where the machine is from the
      // first frame, because there is no deck to walk and no oar to walk to. The
      // machine's own seated figure is what gets drawn from here on.
      rideHeading = Math.atan2(rideable.forward.x, rideable.forward.z);
      rideSpeed = 0;
      rideTurn = 0;
      // Stationary, pointed where it was parked. The tuning is the machine's own
      // description worked into the numbers the integrator wants.
      drive = createDriveState(rideHeading);
      tuning = tuneDrive(rideable.machine.drive);
      position.x = rideable.position.x;
      position.z = rideable.position.z;
      // The floor the machine itself is standing on, which is what its own
      // height already says — read with an open reference instead, a bike parked
      // under a bridge would put its rider up on the bridge.
      footY = floorAt(position.x, position.z, rideable.position.y);
      standY = footY;
      position.y = footY;
      depth = 0;
      afloat = 0;
      rideable.machine.mount();
      return;
    }

    const dx = position.x - rideable.position.x;
    const dz = position.z - rideable.position.z;

    // Where over the side they came, which is where they start walking aft from.
    rideAlong = clamp(dx * rideable.forward.x + dz * rideable.forward.z, -DECK_MARGIN, DECK_MARGIN);
    rideAcross = clamp(dx * rideable.forward.z - dz * rideable.forward.x, -DECK_MARGIN, DECK_MARGIN);
    ridePhase = phaseOf(rideable.id);
    rideLastY = rideable.position.y;
    rideHeave = 0;
    refreshIn = 0;
    // Hauling yourself over a gunwale throws water about whichever way you came.
    if (afloat > 0.1) effects?.splash(position.x, position.z, 0.9);
    afloat = 0;
  };

  /**
   * Somewhere to put a body that has just stepped off a deck: a jetty if one is
   * alongside, otherwise the nearest bank it could climb, otherwise the water —
   * which is a perfectly good answer, and the one the river usually gives.
   *
   * Off a machine it is simpler, because a machine stops: it goes on its stand
   * where it was left and the rider stands beside it, on its left, which is the
   * side the stand is on and the side you get off a bike. Anywhere will do — the
   * road, a lane, the middle of a field — and it can be got back on where it
   * stands, because nothing about it moved.
   */
  const stepOff = () => {
    const machine = ride?.machine;
    if (machine && ride) {
      const atX = ride.position.x;
      const atZ = ride.position.z;
      ride = null;
      rideSpeed = 0;
      rideTurn = 0;
      drive = null;
      tuning = null;
      machine.park();
      group.rotation.set(0, yaw, 0);
      // So the prompt to get back on is up on the next frame rather than up to
      // a fifth of a second later, which reads as the bike not offering itself.
      refreshIn = 0;

      // Local +X is the rider's left, the way `rotation.y` maps it.
      const offX = atX + Math.cos(rideHeading) * DISMOUNT_STEP;
      const offZ = atZ - Math.sin(rideHeading) * DISMOUNT_STEP;
      gatherContacts(offX, offZ, footY);
      const beside = deepestAt(offX, offZ) === 0;
      // Failing that, where the machine is: if the rider could ride to there,
      // they can stand there.
      position.x = beside ? offX : atX;
      position.z = beside ? offZ : atZ;
      position.y = floorAt(position.x, position.z, footY);
      footY = position.y;
      standY = position.y;
      return;
    }

    const fromX = position.x;
    const fromZ = position.z;
    // The way they were pushing when they went over the side, so leaving by the
    // shoreward gunwale does not land them on the far bank.
    const awayX = step.x;
    const awayZ = step.z;

    // Her own oar back. She keeps the way she had, so stepping off a moving boat
    // leaves her going and leaves you in the water behind her.
    ride?.steer?.(null);
    ride = null;
    rideHeave = 0;
    group.rotation.set(0, yaw, 0);

    for (let index = 0; index < decks.length; index += 1) {
      const deck = decks[index];
      const dx = fromX - deck.platform.x;
      const dz = fromZ - deck.platform.z;
      const along = clamp(dx * deck.alongX + dz * deck.alongZ, -deck.platform.halfLength, deck.platform.halfLength);
      const across = clamp(dx * deck.alongZ - dz * deck.alongX, -deck.platform.halfWidth, deck.platform.halfWidth);
      const landX = deck.platform.x + deck.alongX * along + deck.alongZ * across;
      const landZ = deck.platform.z + deck.alongZ * along - deck.alongX * across;
      if (Math.hypot(landX - fromX, landZ - fromZ) > 8) continue;

      const surface = deck.platform.surfaceY + deck.grade * along;
      position.set(landX, surface, landZ);
      footY = surface;
      standY = surface;
      return;
    }

    for (let reach = 2; reach <= LANDING_REACH; reach += 1) {
      const x = fromX + awayX * reach;
      const z = fromZ + awayZ * reach;
      if (bedDepthAt(x, z) > WADE_DEPTH) continue;
      if (terrain.slopeAt(x, z) > CLIMB_SLOPE) continue;

      position.set(x, terrain.heightAt(x, z), z);
      footY = position.y;
      standY = position.y;
      return;
    }

    // Over the side. The depth test next frame turns this into a swim.
    position.set(fromX + awayX * 1.6, terrain.heightAt(fromX + awayX * 1.6, fromZ + awayZ * 1.6), fromZ + awayZ * 1.6);
    footY = position.y;
    standY = position.y;
    effects?.splash(position.x, position.z, 1.2);
  };

  const climbOut = (exit: WaterExit) => {
    position.set(exit.landing.x, exit.landing.y, exit.landing.z);
    footY = exit.landing.y;
    standY = exit.landing.y;
    afloat = 0;
    effects?.splash(exit.x, exit.z, 0.7);
  };

  const update = (delta: number, camera: PerspectiveCamera) => {
    elapsed += delta;
    if (effects) effects.group.visible = group.visible;

    let inputX = 0;
    let inputZ = 0;
    let keyed = false;

    if (pressed.has('KeyW') || pressed.has('ArrowUp')) {
      inputZ += 1;
      keyed = true;
    }
    if (pressed.has('KeyS') || pressed.has('ArrowDown')) {
      inputZ -= 1;
      keyed = true;
    }
    if (pressed.has('KeyA') || pressed.has('ArrowLeft')) {
      inputX -= 1;
      keyed = true;
    }
    if (pressed.has('KeyD') || pressed.has('ArrowRight')) {
      inputX += 1;
      keyed = true;
    }

    if (joystick) {
      inputX += joystick.x;
      inputZ += joystick.y;
    }

    const sprinting = pressed.has('ShiftLeft') || pressed.has('ShiftRight');
    const magnitude = Math.hypot(inputX, inputZ);
    const moving = magnitude > 0.05;
    /** The heading the body is turning towards, which is not where it is yet. */
    let wantYaw = yaw;

    if (moving) {
      forward.set(Math.sin(cameraYaw), 0, Math.cos(cameraYaw));
      // Screen right, derived from the basis `camera.lookAt` actually builds
      // rather than assumed. `Matrix4.lookAt` takes its third column as
      // `normalize(eye - target)`, so with the camera aimed along `forward`
      // that column is `-forward`, and the first column — camera-local +X, which
      // is screen right — is `up x (-forward)`. With up = (0,1,0) that cross
      // product is `(-forward.z, 0, forward.x)`: forward turned a quarter turn
      // the other way from what this line used to say, which is why D strafed
      // left and A strafed right for everyone, joystick included.
      right.set(-forward.z, 0, forward.x);
      // A heading, nothing more. It used to be divided by `max(1, magnitude)`,
      // which left a half-pushed stick a half-length step — and since the step is
      // multiplied by `groundSpeed` further down, the body then covered half the
      // ground the gait ladder had already matched the clip to. Measured on a
      // stick at 50%: the body moved 1.20 m/s while the walk clip was driven for
      // 2.39, and the planted foot slid 0.64 m/s. Analog magnitude has one job
      // here and it is `gaitCeiling` below; taking it twice is the skate.
      move
        .set(0, 0, 0)
        .addScaledVector(forward, inputZ / magnitude)
        .addScaledVector(right, inputX / magnitude);
      step.copy(move);
      wantYaw = Math.atan2(move.x, move.z);
    } else {
      // Standing still, the avatar faces where the camera is looking.
      wantYaw = cameraYaw;
    }

    // Eased round the short way rather than set. Snapped, a flick of the stick
    // pivoted the body on the spot inside one frame — invisible in first person,
    // which is where this line was written, and the most obvious thing in the
    // picture once the camera is behind the shoulder. The ride branches below
    // overwrite it from the heading, where snapping is the right answer: a
    // machine or a hull is pointing where it is pointing.
    yaw += Math.atan2(Math.sin(wantYaw - yaw), Math.cos(wantYaw - yaw)) * (1 - Math.exp(-delta * BODY_TURN));

    // The gait climbs while the input is held, so a tap is a step and a long
    // hold is a jog; an analog stick overrides that with its own magnitude.
    const gaitCeiling = joystick && !keyed ? Math.min(1, magnitude) : 1;
    gait = moving ? Math.min(gaitCeiling, gait + delta / GAIT_RAMP) : Math.max(0, gait - delta / GAIT_RELEASE);

    // --- boarding and the ways out, refreshed a few times a second ----------
    refreshIn -= delta;
    if (refreshIn <= 0) {
      refreshIn = 0.2;
      if (ride) {
        const live = rideables?.().find((entry) => entry.id === ride?.id) ?? null;
        if (live) ride = live;
        else stepOff();
      }

      boardable = null;
      boardGap = Infinity;
      if (!ride && rideables) {
        for (const rideable of rideables()) {
          const gap = gapToDeck(rideable, position.x, position.z);
          if (gap > BOARD_REACH || gap >= boardGap) continue;
          if (Math.abs(position.y - (rideable.position.y + rideable.deckHeight)) > 3) continue;
          boardable = rideable;
          boardGap = gap;
        }
      }

      exitNear = null;
      exitGap = Infinity;
      // Offered to anyone actually in the water, not only to a floating body:
      // the dock's washing steps are reached at thigh depth, and the revetment
      // they climb is too steep to walk up without them.
      if (!ride && depth > WADE_DEPTH) {
        for (const exit of exits) {
          const gap = Math.hypot(position.x - exit.x, position.z - exit.z);
          if (gap > exit.radius || gap >= exitGap) continue;
          exitNear = exit;
          exitGap = gap;
        }
      }
    }

    if (interactQueued) {
      interactQueued = false;
      if (ride) stepOff();
      else if (boardable && boardGap <= exitGap) board(boardable);
      else if (exitNear) climbOut(exitNear);
    }

    // --- travel mode --------------------------------------------------------
    const wantTravel = sprinting && moving && !ride && depth < WADE_DEPTH;
    travel = clamp(travel + (wantTravel ? delta / TRAVEL_IN : -delta / TRAVEL_OUT), 0, 1);

    // --- where the body goes ------------------------------------------------
    let ridePitch = 0;
    let rideRoll = 0;
    const machine = ride?.machine ?? null;

    if (machine && ride && drive && tuning) {
      // Astride something with wheels. The division of labour is unchanged — this
      // file owns the world, because the published carriageway, the gradient, the
      // water and everything solid are known here and nowhere else — but the
      // *dynamics* are `driving.ts`'s now. What that bought is the thing the old
      // branch could not express: a top speed that is where the engine's force
      // meets the drag rather than a number somebody chose, and a back end that
      // can let go and be caught.
      depth = 0;
      afloat = 0;
      groundSpeed = 0;

      // Throttle, brake and bars, raw rather than camera-relative, the same way
      // the oar is: ahead is where the machine points wherever you are looking.
      //
      // S is a brake while it is rolling and a reverse once it has stopped,
      // which is the one key a rider uses for both. `driving.ts` draws that line
      // itself at 0.2 m/s; all this has to do is not hand it both at once.
      const rolling = drive.along > 0.2;
      driveInput.brake = inputZ < 0 && rolling ? Math.min(1, -inputZ) : 0;
      driveInput.throttle = driveInput.brake > 0 ? 0 : clamp(inputZ, -1, 1);
      // Negated once here rather than everywhere downstream: `DriveInput.steer`
      // is positive to the rider's left, which is the sign the yaw rate carries.
      driveInput.steer = -clamp(inputX, -1, 1);
      driveInput.handbrake = pressed.has('Space') ? 1 : 0;
      if (pendingShift) autoBox = false;
      driveInput.auto = autoBox;
      driveInput.shift = pendingShift;
      // Shift is "go faster" on foot and on a machine both, so there is one
      // thing to learn rather than two. Travel mode is gated on `!ride`, so the
      // two readings of the key can never both be live.
      driveInput.boost = sprinting;

      // What the hill in front is doing, read off the surface rather than the
      // terrain so a bridge is flat and an embankment is not. It is handed over
      // as a gradient and gravity does the rest — the old `HILL_COST`/`HILL_FLOOR`
      // pair was a fudge standing in for exactly that.
      const probe = floorAt(
        position.x + Math.sin(drive.heading) * GRADE_PROBE,
        position.z + Math.cos(drive.heading) * GRADE_PROBE,
        footY
      );
      const grade = (probe - footY) / GRADE_PROBE;

      // A made surface is graded and grips; bare ground does not. The same test
      // `ridable` uses, so what the tyres hold and where the machine is allowed
      // to go cannot disagree.
      const made = footY > terrain.heightAt(position.x, position.z) + MADE_SURFACE;
      driveSurface.grade = grade;
      driveSurface.made = made;
      driveSurface.grip = surfaceGrip(made, wetness());
      // Drafting needs somebody to draft, which means the traffic list. Zero
      // until that is wired, which costs only the boost charge it would have fed.
      driveSurface.draft = 0;

      stepDrive(drive, tuning, driveInput, driveSurface, delta);
      pendingShift = 0;

      rideHeading = drive.heading;
      rideSpeed = drive.along;
      rideTurn = drive.turn + drive.paddle;

      const edge = terrain.size / 2 - 4;
      // The velocity, not the nose direction. They are the same while it tracks
      // and they are the whole point when it does not: a machine sideways travels
      // where it was going, not where it is pointed.
      const wantX = clamp(position.x + driveVelocityX(drive) * delta, -edge, edge);
      const wantZ = clamp(position.z + driveVelocityZ(drive) * delta, -edge, edge);
      const fromX = position.x;
      const fromZ = position.z;

      // The body's own collision: houses, trunks and lineside structures, in
      // substeps, because 23.6 m/s is 2.36 m at the 0.1 s delta clamp and a
      // single test at the landing point would step clean over a signal post.
      gatherContacts(position.x, position.z, footY);
      const reach = Math.min(GATHER_REACH, Math.hypot(wantX - position.x, wantZ - position.z));
      if (reach > 1e-5) {
        const headingX = (wantX - position.x) / reach;
        const headingZ = (wantZ - position.z) / reach;
        let walked = 0;
        while (walked < reach) {
          const hop = Math.min(SUBSTEP, reach - walked);
          stepToward(position.x + headingX * hop, position.z + headingZ * hop);
          walked += hop;
        }
      }
      depenetrate();

      const got = Math.hypot(position.x - fromX, position.z - fromZ);
      if (reach > 1e-5 && got < reach - 1e-3) {
        /**
         * It hit something. What it hit decides what that costs.
         *
         * The old answer was `rideSpeed *= got / reach` — the share of the step
         * that survived, applied to the speed. That is wrong in both directions
         * at once: a glancing scrape along a wall travels most of its step and
         * so costs almost nothing, while a square hit at speed stops the step
         * dead and so zeroes the speed, when a real one would also throw the
         * nose round. `collideWorld` takes the geometry instead — the arm from
         * the centre of mass to the contact, and the closing speed along the
         * real normal — so a scrape is a scrape and a post taken half off centre
         * spins you.
         *
         * Which contact: the one the body is nearest after the slide, since
         * `stepToward` ends up alongside whatever refused the step. A blocked
         * step with nothing solid near it is the *surface* refusing — a bank too
         * steep, water too deep — and there is nothing to bang into, so that
         * keeps the old proportional answer.
         */
        let nearest = -1;
        let closest = Infinity;
        for (let index = 0; index < contactCount; index += 1) {
          const gap = Math.hypot(position.x - contactX[index], position.z - contactZ[index]) - contactReach[index];
          if (gap >= closest) continue;
          closest = gap;
          nearest = index;
        }

        if (nearest >= 0 && closest < 1) {
          collideWorld(drive, tuning, position.x, position.z, contactX[nearest], contactZ[nearest], impact);
        } else {
          const kept = clamp(got / reach, 0, 1);
          drive.along *= kept;
          drive.across *= kept;
        }
      }

      /**
       * And then everything that moves — the fleet, and the companions on bikes.
       *
       * After the static world rather than before it, because this ends in a
       * positional push and a push has to be resolved against the houses and the
       * trunks: shoved out of a coach into a wall, the wall wins. So the contacts
       * are re-gathered at where the machine has actually ended up — the set
       * above was collected at the start of the step, up to 8 m back — and the
       * push is walked out through the same `stepToward` the ride itself uses.
       *
       * `collideDrive` does the impulse: the closing speed along the real normal,
       * a tangential scrub, and a yaw kick off the arm from the centre of mass to
       * the contact on the bodywork. It is one-sided by construction, which is
       * what makes it work over a network — two clients each resolving their own
       * machine against the other's reported position apply impulses that are
       * exactly equal and opposite, so momentum comes out conserved with neither
       * owning the other.
       */
      if (traffic) {
        let pushX = 0;
        let pushZ = 0;
        for (let source = 0; source < traffic.length; source += 1) {
          const bodies = traffic[source]();
          for (let index = 0; index < bodies.length; index += 1) {
            if (!collideDrive(drive, tuning, position.x, position.z, bodies[index], impact)) continue;
            /**
             * The whole of the overlap, not this body's mass share of it.
             *
             * `collideDrive` splits the separation so the lighter party does the
             * moving, which is right between two free bodies and wrong against
             * most of this list: an NPC is a position on a queue along one
             * centreline and will not be moved by anything, so taking half the
             * overlap off a xe máy that hit another xe máy leaves the pair still
             * overlapping, gets another impulse next frame, and grinds the rider
             * along the side of it. Multiplying by `inverse/selfV` recovers the
             * undivided push — the caller owns position, and this is arithmetic
             * on the two numbers handed back rather than a change to the model.
             *
             * It overshoots between two players, where both clients separate
             * fully and the pair parts by twice the overlap. That is stable and
             * invisible: after one frame there is no contact left to resolve. The
             * *impulse* is untouched and still mass-split, so being shunted by a
             * coach is still four hundred times being shunted by a bicycle.
             */
            const share =
              Number.isFinite(bodies[index].mass) && bodies[index].mass > 0 ? 1 + tuning.mass / bodies[index].mass : 1;
            pushX += impact.pushX * share;
            pushZ += impact.pushZ * share;
          }
        }

        if (pushX !== 0 || pushZ !== 0) {
          gatherContacts(position.x, position.z, footY);
          const shove = Math.hypot(pushX, pushZ);
          // Substepped for the same reason the ride is: a deep overlap — a coach
          // arriving at a machine that was teleported into its lane — is metres,
          // and a single test at the landing point would step over a signal post.
          const outX = pushX / shove;
          const outZ = pushZ / shove;
          let walked = 0;
          while (walked < shove) {
            const hop = Math.min(SUBSTEP, shove - walked);
            stepToward(position.x + outX * hop, position.z + outZ * hop);
            walked += hop;
          }
          depenetrate();
        }
      }

      const floor = floorAt(position.x, position.z, footY);
      footY = floor;
      standY += (floor - standY) * (1 - Math.exp(-delta * STEP_EASE));
      position.y = standY;
      yaw = rideHeading;
      group.rotation.set(0, yaw, 0);
      step.set(Math.sin(rideHeading), 0, Math.cos(rideHeading));

      ridden.x = position.x;
      ridden.y = position.y;
      ridden.z = position.z;
      ridden.heading = drive.heading;
      ridden.speed = drive.along;
      ridden.turn = rideTurn;
      ridden.grade = grade;
      ridden.delta = delta;
      ridden.slip = drive.slip;
      ridden.lateral = drive.lateral;
      ridden.steer = drive.steer;
      ridden.brake = drive.brake;
      ridden.boost = drive.boost;
      ridden.boosting = drive.boosting;
      ridden.frontSlide = drive.frontSlide;
      ridden.rearSlide = drive.rearSlide;
      ridden.firstPerson = atEyes;
      machine.place(ridden);

      /**
       * And the lean, onto the horizon — the machine's, taken at the share the
       * rider's head takes of it.
       *
       * Written in the same form `machine.place` leans the rig by, off
       * `drive.lateral` rather than off `speed * turn`, so the two cannot part
       * company: in a slide the tyres have given up most of their grip while the
       * yaw rate is at its highest, and the camera would then roll hardest at
       * the moment the machine is leaning least.
       *
       * It goes through `rideRoll`, which is the boat's channel, and so is gated
       * behind `cameraMotion` with everything else that moves the horizon. That
       * gate is **off by default and stays off**, which is a decision and not an
       * oversight. Against it: a bike that corners with a level horizon reads as
       * a hovercraft, and in first person the camera is the only thing left that
       * can say the machine is leaning, because the machine itself is inside the
       * near plane and the avatar is hidden. For it: roll about the view axis is
       * the most reliably sickening motion a camera has, this file already
       * records a stride's fraction of a degree as "a documented way to make
       * somebody ill", and the person who set that default did so after being
       * made dizzy. A fidelity complaint nobody has made does not outrank a
       * comfort complaint somebody did make — and the rider who wants the bike
       * to feel like a bike has a switch, which is what the switch is for.
       */
      rideRoll = -Math.atan(drive.lateral / GRAVITY) * RIDER_HEAD_SHARE;
    }

    if (ride && !machine) {
      // Aboard is out of the water, whatever the bed under the hull is doing.
      depth = 0;
      afloat = 0;

      /**
       * Aboard is at the oar. The stick cannot both pace a nine-metre sole and
       * con the boat, and conning her is the whole of what being aboard is for —
       * standing on the floorboards while she drifted past on her own errand was
       * the complaint. So the input goes to the hull and not to the feet, raw
       * rather than camera-relative: ahead is her bow wherever you are looking,
       * which leaves the view free to be somewhere else. It also keeps the
       * joystick working, which a second key for the helm would not have.
       */
      ride.steer?.({ throttle: clamp(inputZ, -1, 1), rudder: clamp(inputX, -1, 1) });
      groundSpeed = 0;

      // Walked aft to the oar rather than put there: you come over the gunwale
      // wherever you could reach her, and arrive at the helm about a second later.
      const settle = 1 - Math.exp(-delta * 2.5);
      rideAlong += (ride.helmStation.along - rideAlong) * settle;
      rideAcross += (ride.helmStation.across - rideAcross) * settle;

      // Facing her bow, not the camera: a helmsman does not swivel to look at
      // the scenery, and the avatar turning under a still hull read as a glitch.
      yaw = Math.atan2(ride.forward.x, ride.forward.z);

      position.set(
        ride.position.x + ride.forward.x * rideAlong + ride.forward.z * rideAcross,
        ride.position.y + ride.deckHeight,
        ride.position.z + ride.forward.z * rideAlong - ride.forward.x * rideAcross
      );
      footY = position.y;
      standY = position.y;

      // The hull only heaves in `life`, so the roll is the walker's own slow
      // oscillator while the pitch is read off the lift it can actually see.
      const lift = delta > 0 ? (ride.position.y - rideLastY) / delta : 0;
      rideLastY = ride.position.y;
      rideHeave += (lift - rideHeave) * (1 - Math.exp(-delta * 6));
      const calm = reducedMotion ? 0.2 : 1;
      rideRoll =
        (Math.sin(elapsed * 0.9 + ridePhase) * 0.028 + Math.sin(elapsed * 1.7 + ridePhase * 2.3) * 0.015) * calm;
      ridePitch = clamp(rideHeave, -1, 1) * 0.055 * calm;
      group.rotation.set(ridePitch, yaw, rideRoll);
    }

    if (!ride) {
      // Against last frame's floor, which is where the feet are: a deck that
      // was under them a moment ago is the surface they are standing on now.
      depth = depthAt(position.x, position.z, footY);
      afloat = afloatAt(depth);

      let target = speedForGait(gait);
      if (travel > 0) target += (TRAVEL_SPEED - target) * travel;
      if (depth > WADE_DEPTH) target *= wadeDrag(depth);
      target += ((sprinting ? SWIM_FAST : SWIM_SPEED) - target) * afloat;
      if (!moving) target = 0;

      // Easing rather than snapping: a body does not reach 14 m/s in one frame,
      // and a short glide on release is what stops the walk looking like a slide.
      groundSpeed += (target - groundSpeed) * (1 - Math.exp(-delta * (target > groundSpeed ? 6 : 11)));

      const half = terrain.size / 2 - 4;
      const wantX = clamp(position.x + step.x * groundSpeed * delta, -half, half);
      const wantZ = clamp(position.z + step.z * groundSpeed * delta, -half, half);

      // Gathered once for the whole frame: `GATHER_REACH` is wider than any
      // step, so the same contact set answers every substep.
      gatherContacts(position.x, position.z, footY);

      // Walked in substeps. Testing only where the step lands would let a long
      // frame put the body on the far side of a trunk without ever having been
      // inside it — and a 14 m/s travel step is 3.5 m at 4 fps.
      const reach = Math.min(GATHER_REACH, Math.hypot(wantX - position.x, wantZ - position.z));
      if (reach > 1e-5) {
        const headingX = (wantX - position.x) / reach;
        const headingZ = (wantZ - position.z) / reach;
        let walked = 0;
        while (walked < reach) {
          const hop = Math.min(SUBSTEP, reach - walked);
          stepToward(position.x + headingX * hop, position.z + headingZ * hop);
          walked += hop;
        }
      }

      /**
       * And then being run over, which on foot is the other half of the user's
       * report: "va chạm ... giữa nhân vật với xe".
       *
       * Not `collideDrive`. That takes a `DriveState` and a `DriveTuning` — a
       * machine's velocity in its own frame, its yaw inertia, its wheelbase —
       * and a body on foot has none of those. Inventing them so the same
       * function could be called would be dressing a person up as a vehicle to
       * make the types line up, and the yaw kick that module exists for means
       * nothing on something with no nose.
       *
       * So the pedestrian case is its own three lines, and the proportion the
       * lead asked about falls out of the asymmetry rather than out of a mass
       * ratio: nothing in the traffic list will move for a person — an NPC is a
       * position on a queue and a companion is another client's — so the body
       * takes the whole of the separation and the whole of the knock. A 75 kg
       * body against a 12 t coach being entirely the body's problem is not a
       * calculation here, it is the only thing that can happen.
       */
      if (traffic) {
        let outX = 0;
        let outZ = 0;
        let worstClosing = 0;
        for (let source = 0; source < traffic.length; source += 1) {
          const bodies = traffic[source]();
          for (let index = 0; index < bodies.length; index += 1) {
            const other = bodies[index];
            const toX = position.x - other.x;
            const toZ = position.z - other.z;
            const span = Math.hypot(toX, toZ);
            const clear = SHOULDER + other.radius;
            if (span >= clear) continue;
            // Dead centre has no direction to separate along, so take the way
            // the body is facing — the same escape `collideDrive` uses.
            const awayX = span > 1e-4 ? toX / span : step.x;
            const awayZ = span > 1e-4 ? toZ / span : step.z;
            const overlap = clear - span;
            outX += awayX * overlap;
            outZ += awayZ * overlap;
            /**
             * Closing along that normal, which is what decides whether this is
             * being brushed by a parked bike or hit by a bus.
             *
             * `away` points from the other body toward this one, so the gap
             * shrinks at `(other.v − mine) · away`. Written with both signs
             * flipped at first, which made every approach read as opening: a
             * coach bulldozed a body 5.70 m down the road and never once knocked
             * it off its feet, because `worstClosing` was negative throughout.
             */
            const closing = (other.vx - step.x * groundSpeed) * awayX + (other.vz - step.z * groundSpeed) * awayZ;
            worstClosing = Math.max(worstClosing, closing);
          }
        }

        if (outX !== 0 || outZ !== 0) {
          const shove = Math.hypot(outX, outZ);
          // Out of the overlap first, through the same substepped walk, so being
          // hit can never put a body inside a wall.
          const stepX = outX / shove;
          const stepZ = outZ / shove;
          let walked = 0;
          while (walked < shove) {
            const hop = Math.min(SUBSTEP, shove - walked);
            stepToward(position.x + stepX * hop, position.z + stepZ * hop);
            walked += hop;
          }
          depenetrate();

          if (worstClosing > 0) {
            // Knocked, and knocked off the gait ladder: the legs stop and have to
            // climb back from a standstill, which is `GAIT_RAMP` seconds of
            // getting up. Taken as the larger of the two rather than added, so
            // being clipped repeatedly by the same vehicle does not accumulate.
            const kick = Math.min(KNOCK_MAX, worstClosing);
            if (kick > Math.hypot(knockX, knockZ)) {
              knockX = stepX * kick;
              knockZ = stepZ * kick;
            }
            gait = 0;
            groundSpeed = 0;
          }
        }
      }

      /**
       * Still being carried by it. Integrated through `stepToward` like
       * everything else, so a body knocked toward a wall stops at the wall, and
       * faded rather than cut so it reads as sliding to a stop on the tarmac.
       */
      const carried = Math.hypot(knockX, knockZ);
      if (carried > KNOCK_DONE) {
        const slide = carried * delta;
        if (slide > 1e-5) {
          const alongX = knockX / carried;
          const alongZ = knockZ / carried;
          let walked = 0;
          while (walked < slide) {
            const hop = Math.min(SUBSTEP, slide - walked);
            stepToward(position.x + alongX * hop, position.z + alongZ * hop);
            walked += hop;
          }
        }
        const fade = Math.exp(-delta * KNOCK_FADE);
        knockX *= fade;
        knockZ *= fade;
      } else {
        knockX = 0;
        knockZ = 0;
      }

      // Every frame, not only while moving: teleporting, spawning or a hull
      // drifting over you must never leave anyone standing inside a wall.
      depenetrate();

      // The floor first, then the water against it, so a deck over the river
      // keeps the body dry whatever the bed under it is doing.
      const floor = floorAt(position.x, position.z, footY);
      footY = floor;
      depth = water ? Math.max(0, water.level - floor) : 0;
      afloat = afloatAt(depth);

      // Eased, not snapped: a kerb or a deck lip resolves in about a tenth of a
      // second and a real drop reads as a fall, where snapping read as a jolt.
      standY += (floor - standY) * (1 - Math.exp(-delta * STEP_EASE));
      const floatY = water ? water.level - FLOAT_DRAFT : standY;
      position.y = standY + (floatY - standY) * afloat;
      group.rotation.set(0, yaw, 0);
    }

    // --- getting wet --------------------------------------------------------
    const wading = depth > WADE_DEPTH * 0.5;
    if (wading && !wasWading) effects?.splash(position.x, position.z, 0.4 + Math.min(1.1, groundSpeed * 0.12));
    wasWading = wading;
    wet = wading ? 1 : Math.max(0, wet - delta / DRY_TIME);
    if (water && waterline) waterline.set(water.level, wet);

    group.position.copy(position);

    // --- the stride, and what it does to the horizon ------------------------
    stridePhase += ((groundSpeed / stepLength(groundSpeed)) * Math.PI * delta) / 2;
    const paceOut = Math.min(1, groundSpeed / STROLL_SPEED) * (1 - afloat);
    // No camera bob, and no roll unless `cameraMotion` asks for it. Both were
    // added so the stride would not look like skating, but on screen a rising
    // and falling horizon reads as dropped frames rather than as footsteps — the
    // user called it lag — and a rolling one reads as nothing at all until it
    // reads as seasickness. The stride still drives the clip rate below, which
    // is what actually stops the feet sliding; the camera no longer joins in.
    const strideRoll = Math.sin(stridePhase) * (reducedMotion ? 0 : STRIDE_ROLL * 0.25 * paceOut);
    // Afloat, the surface itself does the moving, which is a real thing you are
    // standing on rather than an invented camera shake — so it is kept, halved,
    // and gated with the rest of the cinematic extras.
    const heave =
      reducedMotion || !cameraMotion
        ? 0
        : afloat * (Math.sin(elapsed * 1.3) * 0.025 + Math.sin(elapsed * 0.7 + 1.1) * 0.015);

    // --- the orbit rig ------------------------------------------------------
    /**
     * The whole arrangement, and the whole of the answer to "góc nhìn phải lấy
     * nhân vật làm trung tâm": a point on the body, the camera on a sphere about
     * it, and the aim along the line between them. Because the camera looks
     * *through* the pivot, the body holds one screen position at every pitch and
     * yaw and at every distance the rig is ever shortened to — measured as 0.011
     * of the frame across ±1.2 rad of pitch, against 2.645 for the look-direction
     * rig this replaced, which lost the body off the bottom edge above the
     * horizon and behind the lens at +1.2.
     *
     * What it costs: looking a long way up swings the camera down behind you into
     * the ground, so the sweep below shortens the rig and far enough up the view
     * ends at the eyes. That is geometry, not a choice — a camera that looks at
     * the body and up at the sky at the same time has to be below the body — and
     * it is the better half of the trade, because the state it arrives at is
     * first person rather than a body slid off the frame.
     */
    const headHeight = machine ? SADDLE_EYE : eyeHeight;
    const pivotHeight = headHeight * CHEST_SHARE;
    // Read off the body's own eased height rather than the floor under it, so the
    // frame and the feet never disagree about where the body is; `PIVOT_RISE`
    // then arrives a quarter of a second later than the feet do.
    const wantPivotY = position.y + pivotHeight + heave;
    pivotX += (position.x - pivotX) * (1 - Math.exp(-delta * PIVOT_CHASE));
    pivotZ += (position.z - pivotZ) * (1 - Math.exp(-delta * PIVOT_CHASE));
    pivotY += (wantPivotY - pivotY) * (1 - Math.exp(-delta * PIVOT_RISE));
    // Climbing faster than the ease can follow, the pivot is dragged up by the
    // body rather than left under it. Saturated, it then rises at exactly the
    // rate the body rises — a camera matching the thing it is following is the
    // definition of motion nobody asked for being absent, and it is the only
    // state in which the sweep below is asked a question about the real world.
    pivotY = Math.max(pivotY, wantPivotY - PIVOT_SINK);
    // A teleport, a boarding, a step off a hull: the body is simply somewhere
    // else, and easing across it is a flight through the scenery.
    if (Math.abs(wantPivotY - pivotY) > PIVOT_SNAP) pivotY = wantPivotY;
    if (Math.hypot(position.x - pivotX, position.z - pivotZ) > PIVOT_SNAP) {
      pivotX = position.x;
      pivotZ = position.z;
    }

    // How fast the machine is going, as a share of what its throttle holds on the
    // flat. Read before the view basis because the yaw now depends on it, and
    // integrated whatever `cameraMotion` says, so turning the setting on mid-ride
    // starts from where the machine actually is rather than from a standstill.
    const over = machine ? Math.min(1, Math.abs(rideSpeed) / machine.topSpeed) : 0;
    rideBack += (over - rideBack) * (1 - Math.exp(-delta * 0.7));

    /**
     * The view comes round to the machine's nose.
     *
     * The player's complaint, in full: "khi lái xe thì góc nhìn nên đổi theo cái
     * đầu xe chứ, chứ vừa lái mà vừa rê chuột để đổi góc nhìn quá là khó" — the
     * view should turn with the machine's nose; steering and dragging the mouse
     * at the same time is too hard. Measured by `probe/ride-heading.ts` before
     * this existed: holding a corner at 20.8 m/s turned the nose 1.254° a frame
     * and the lens 0.000°, and the two ended up 176.7° apart. A flick of the
     * mouse never came back at all.
     *
     * This is not an exception to the rule that the camera may not move unless
     * the player moved it. **Turning the bars is the command**, and it is one the
     * machine is steered by directly: `driveInput.steer` is `-inputX` raw, never
     * camera-relative, so the view cannot feed back into where the machine goes
     * and there is no loop here to close. The camera follows the player's hand
     * one step removed, exactly as far as that hand actually turned the nose.
     *
     * The mouse is not overridden, it is composed with: `look` writes its travel
     * straight into `cameraYaw` as it always has, and this bleeds the resulting
     * offset away afterwards. Held against it at an unhurried 60°/s the hand wins
     * outright, because a drag is an order of magnitude faster than the bleed —
     * which is the whole point, since riding through a place and looking at it is
     * most of why the machine is here.
     *
     * Weighted by `rideBack`, which is the camera's own eased idea of the speed
     * and is shared with `RIDE_PULLBACK` rather than duplicated. So at a kerb the
     * rate is nothing and the view stays where it is put — somebody paddling a
     * machine round in a lane is looking around, not cornering — and it comes up
     * with the speed. Measured: stopped with the bars hard over, the nose swings
     * 0.939° a frame and the lens turns 0.026°.
     *
     * A hull is deliberately not given this, and the speed weighting is most of
     * the argument: she does a few metres a second, so the rate would come out a
     * tenth of a machine's and the branch would do nothing visible. The rest of
     * it is already written in the boat branch above — her input is raw "which
     * leaves the view free to be somewhere else", and a rudder is slow enough to
     * follow by hand. The complaint was about steering at 55 m/s.
     */
    if (machine) {
      const toNose = Math.atan2(Math.sin(rideHeading - cameraYaw), Math.cos(rideHeading - cameraYaw));
      /**
       * From the saddle the coupling is tighter, and that is the physical answer
       * rather than a preference: in first person the lens *is* the rider's head,
       * and no rider's head lags their own machine through a corner. It is also
       * the gentler of the two for the stomach — what makes people ill is a view
       * that disagrees with the motion they can feel, and a view locked to the
       * vehicle is the configuration where the two agree.
       *
       * Gated on `distance` rather than on `firstPerson`, so it is the view the
       * player asked for and not the one a tree pulled them into for five frames:
       * the occlusion collapse is transient and must not change the control law
       * underneath them.
       */
      const rate = RIDE_FOLLOW * rideBack * (1 - lookHold) * (distance < FIRST_PERSON_UNDER ? RIDE_FOLLOW_EYES : 1);
      // Capped as a rate, not as an angle. An angle cap would stop the mouse
      // working past it; this only bounds how fast a large offset is taken back,
      // so looking over your shoulder at the field behind you returns as a pan
      // and not as a whip.
      const eased = toNose * (1 - Math.exp(-delta * rate));
      cameraYaw += clamp(eased, -RIDE_FOLLOW_SWEEP * delta, RIDE_FOLLOW_SWEEP * delta);
    }
    // Decayed after it is read, not before, so a frame the hand moved on is a
    // frame `lookHold` is exactly 1 and the rate above is exactly nothing. Decayed
    // first, every dragged frame was already a twentieth of the way back and the
    // hand only kept 65% of a 60°/s pan from the saddle.
    lookHold *= Math.exp(-delta * RIDE_FOLLOW_HAND);

    const horizontal = Math.cos(cameraPitch);
    const lift = Math.sin(cameraPitch);
    // The line from the pivot out to the camera, which is also the line the view
    // is aimed along. Rigid — there is no easing anywhere on the pitch, and none
    // on the yaw either beyond the machine's own nose above, because that is the
    // player's own hand and smoothing a hand is what makes a view feel like it is
    // sliding out from under the mouse.
    const awayX = Math.sin(cameraYaw) * horizontal;
    const awayZ = Math.cos(cameraYaw) * horizontal;
    /**
     * Camera-local +X in world space, which is where the shoulder offset goes.
     *
     * `Matrix4.lookAt` takes its third column as `normalize(eye - target)` and
     * its first as `up × that`; with up = (0,1,0) the cross product drops every
     * term the pitch is in, so screen right is `(-cos yaw, 0, sin yaw)` at any
     * pitch at all. Which is the reason the offset can be applied to the rig and
     * stay level: it never tilts.
     */
    const rightX = -Math.cos(cameraYaw);
    const rightZ = Math.sin(cameraYaw);
    /**
     * The rig's line, shoulder and all.
     *
     * Because the shoulder offset is carried as a share of the distance, the
     * camera at any distance sits on one straight line out of the pivot — leaned
     * `CAMERA_SHOULDER / DEFAULT_DISTANCE` off the view direction, 3.7°. So the
     * sweep below can follow it exactly rather than approximating it with the
     * un-leaned line: half a metre of lateral is nothing against a tree trunk,
     * but on a hillside running across the rig it was the lens ending up 0.35 m
     * under the terrain at Tà Xùa while the sweep reported it clear.
     */
    const lineX = awayX - (rightX * CAMERA_SHOULDER) / DEFAULT_DISTANCE;
    const lineZ = awayZ - (rightZ * CAMERA_SHOULDER) / DEFAULT_DISTANCE;

    // Under way on a machine the camera is let out, eased off the throttle
    // rather than off the frame, so it opens and closes over about a second and
    // a half instead of pumping with every touch of the brake.
    // It is the trailing distance only: `distance` stays the player's, so V and
    // the wheel still mean what they meant and a view pulled all the way in stays
    // first person.
    const out = distance * (1 + (cameraMotion ? RIDE_PULLBACK * rideBack : 0));

    /**
     * How much of the orbit line is clear, swept from the pivot outwards.
     *
     * The ground is now a genuine occluder rather than something the camera is
     * stood on top of. It has to be: the rig swings down behind the player as the
     * pitch goes up, and the old answer — lifting the camera to clear the hill —
     * is the one thing an orbit cannot do, because lifting it is what slides the
     * body off the frame. Shortening is free: pulling the camera in along this
     * line does not move the body in the picture by a pixel, it only makes it
     * bigger.
     *
     * Swept along the un-offset line. The shoulder is half a metre of lateral
     * and the sweep's own step is `out/OCCLUSION_SAMPLES`, 0.85 m at the default
     * distance, so carrying it through here would be false precision.
     */
    /**
     * How far out the ground lets the lens go: the hard cap, obeyed the frame it
     * is found, where everything else below is eased into.
     *
     * The two have to be told apart. A doorframe is worth waiting out because it
     * will have passed in five frames, and easing into it is what keeps a graze
     * from hiding the body; a hillside is not going anywhere, and easing into it
     * put the lens 1.59 m *under* the terrain at Tràng An for a tenth of a
     * second, which is a view of the inside of the world. The ground also moves
     * smoothly — it is a height field read at the camera, not an edge that snaps
     * past — so obeying it at once reads as the view drawing in, not as a jump.
     */
    let standoff = out;
    /**
     * The deficit at the last clear sample, kept so the crossing can be found
     * between samples rather than rounded down to one. Seeded at the pivot,
     * where on the flat the lens clears by `CHEST_HEIGHT - CAMERA_CLEARANCE`.
     */
    let wasDeficit = lensDeficit(0, lineX, lineZ, lift, footY);
    let wasReach = 0;

    for (let sample = 1; sample <= OCCLUSION_SAMPLES; sample += 1) {
      const reach = (out * sample) / OCCLUSION_SAMPLES;
      const deficit = lensDeficit(reach, lineX, lineZ, lift, footY);
      if (deficit > 0) {
        /**
         * Where the line actually crosses the ground, interpolated between the
         * last clear sample and this one rather than rounded down to it.
         *
         * Worth the divide because of where the threshold sits: the samples are
         * `out/OCCLUSION_SAMPLES` apart, 0.85 m at the default distance, and
         * `FIRST_PERSON_UNDER` falls between step 2 at 1.70 m and step 3 at 2.55
         * — so rounding a block down to the previous sample is the whole
         * difference between a camera drawn in and an avatar gone. Measured on
         * the Tà Xùa walk, it took the share of it the body is hidden for from
         * 5.8% to 0.6%.
         */
        const span = deficit - wasDeficit;
        standoff = clamp(span > 1e-6 ? wasReach + (reach - wasReach) * (-wasDeficit / span) : wasReach, 0, reach);
        // And two halvings, because that interpolation assumes the ground runs
        // straight between the samples and a karst tower between them is the
        // opposite of straight: at Tràng An the straight reading finished 0.13 m
        // under the surface on the worst frame of a 350 m walk.
        for (let pass = 0; pass < 2; pass += 1) {
          if (lensDeficit(standoff, lineX, lineZ, lift, footY) <= 0) break;
          standoff = wasReach + (standoff - wasReach) * 0.5;
        }
        break;
      }
      wasDeficit = deficit;
      wasReach = reach;
    }

    /**
     * And how much of what the ground left is clear of everything built.
     *
     * Swept only as far as `standoff`, because there is no sense asking whether a
     * wall is in the way at a distance the lens cannot reach.
     */
    let allowed = standoff;
    for (let sample = 1; sample <= OCCLUSION_SAMPLES; sample += 1) {
      const reach = (standoff * sample) / OCCLUSION_SAMPLES;
      const sampleX = pivotX - lineX * reach;
      const sampleZ = pivotZ - lineZ * reach;
      const sampleY = pivotY - lift * reach;

      // Loops rather than `some`, and the query filling a shared array rather
      // than returning a new one: this runs ten times a frame and the closures
      // and the concatenated result were ten allocations each.
      let blocked = false;

      if (!blocked && canopy) {
        const trees = canopy.near(sampleX, sampleZ, nearby);
        for (let index = 0; index < trees.length; index += 1) {
          const tree = trees[index];
          if (sampleY <= tree.bottom || sampleY >= tree.top) continue;
          const dx = sampleX - tree.x;
          const dz = sampleZ - tree.z;
          if (dx * dx + dz * dz >= tree.radius * tree.radius) continue;
          blocked = true;
          break;
        }
      }

      if (!blocked && solids) {
        const found = solids.near(sampleX, sampleZ, nearby);
        for (let index = 0; index < found.length; index += 1) {
          const solid = found[index];
          if (sampleY <= solid.bottom || sampleY >= solid.top) continue;
          const dx = sampleX - solid.x;
          const dz = sampleZ - solid.z;
          if (dx * dx + dz * dz >= solid.radius * solid.radius) continue;
          blocked = true;
          break;
        }
      }

      // The near-field trees. They are rewritten in place every frame by
      // `tree-near`, so the array is read here and never kept.
      if (!blocked && nearCrowns) {
        const crowns = nearCrowns();
        for (let index = 0; index < crowns.length; index += 1) {
          const crown = crowns[index];
          if (sampleY <= crown.bottom || sampleY >= crown.top) continue;
          const dx = sampleX - crown.x;
          const dz = sampleZ - crown.z;
          if (dx * dx + dz * dz >= crown.radius * crown.radius) continue;
          blocked = true;
          break;
        }
      }

      if (!blocked) {
        for (let index = 0; index < buildings.length; index += 1) {
          const building = buildings[index];
          if (building.top + 0.8 <= sampleY) continue;
          // The circumradius first, because it is one multiply and rejects
          // every building in the village but the two beside you; then the
          // walls, because the gap between the two is where the lane is.
          const dx = sampleX - building.x;
          const dz = sampleZ - building.z;
          if (dx * dx + dz * dz >= building.radius * building.radius) continue;
          if (!insideBuilding(building, sampleX, sampleZ)) continue;
          blocked = true;
          break;
        }
      }

      if (blocked) {
        allowed = (standoff * (sample - 1)) / OCCLUSION_SAMPLES;
        break;
      }
    }

    /**
     * A block the rig waits out rather than gives in to.
     *
     * A doorway, a lamp post or a tree you walk past is gone in a handful of
     * frames, and pulling the camera through the body for each one is what read
     * as "the character has disappeared" — so for `FIRST_PERSON_AFTER` the rig
     * holds at the two metres it can still draw a body at and accepts a clipped
     * shoulder instead, which is much the smaller problem.
     *
     * The ground is not that kind of block. A hillside behind you does not pass
     * by, and holding two metres out against it puts the lens *inside* the hill —
     * measured 3.64 m under the terrain at Tràng An, which is a view of the
     * inside of the world. So the ground is obeyed at once and the easing below
     * is what keeps it from reading as a snap.
     */
    crowded = allowed < FIRST_PERSON_UNDER && allowed < standoff ? crowded + delta : 0;
    const wantOut = crowded > 0 && crowded < FIRST_PERSON_AFTER ? Math.max(allowed, FIRST_PERSON_UNDER) : allowed;
    orbit += (wantOut - orbit) * (1 - Math.exp(-delta * (wantOut < orbit ? TUCK_IN : TUCK_OUT)));
    orbit = Math.min(orbit, standoff);

    /**
     * The body stands aside once the lens is inside the two metres it cannot be
     * drawn whole in — the scene's near plane is 2 m, so below that it is sliced
     * open around the camera rather than merely large.
     *
     * Read off where the camera actually is rather than off what the sweep
     * allows, which is what makes `TUCK_IN` the grace as well as the approach: a
     * five-frame graze only gets the rig a third of the way in before it clears,
     * so the body is never hidden for it, while a block that holds brings the rig
     * all the way and the body goes. The deeper the block, the sooner — which is
     * the behaviour `FIRST_PERSON_AFTER` was reaching for with a timer.
     */
    const firstPerson = distance < FIRST_PERSON_UNDER || orbit < FIRST_PERSON_UNDER;
    // Read by the ride branch on the next frame, which is what hands the machine
    // the one thing it needs to know about the view.
    atEyes = firstPerson && machine !== null;

    const swimming = afloat > SWIMMING;
    // The rig ships no swim clip, so the stroke is written out instead — and
    // tied to the ground the same way the walk is, or the arms turn over at one
    // speed while the body goes at another. Outside the `human` branch because
    // the ripples are cued off it too, and they are there with or without a rig.
    if (afloat > 0.002) swimPhase += delta * Math.max(TREAD_RATE, groundSpeed / STROKE_REACH);
    // Astride a machine the walking avatar stands down: the rider in the saddle
    // is the machine's own seated figure, built sitting, and two bodies in the
    // same place is one too many. There is nothing to swap in on foot, so this is
    // the one place the body is hidden for a reason other than the lens.
    const bodyHidden = firstPerson || machine !== null;
    if (human) {
      human.group.visible = !bodyHidden;
      // Picked by speed, not by a flag — and only ever a clip the rig has, or
      // the rate would be computed for a run while a walk carried on playing.
      const running = !swimming && runCycle > 0 && groundSpeed > RUN_CLIP_AT;
      const clip = swimming ? (swimClip ?? 'idle') : running ? 'run' : 'walk';
      const cycle = running ? runCycle : walkCycle;
      const stride = running ? runStride : walkStride;
      // One cycle of the clip has to cover the ground one cycle of strides
      // covers. That is the whole of the fix: played at a fixed rate, a clip
      // carries the feet at the speed it was authored for and the body at
      // another, and the difference is the skate. The stride is the clip's own,
      // measured off the rig — guessing it is the same skate with extra steps.
      const rate =
        swimming || groundSpeed < 0.15 || cycle <= 0 || stride <= 0
          ? 1
          : clamp((groundSpeed * cycle) / stride, MIN_CLIP_RATE, MAX_CLIP_RATE);
      human.update(delta * rate);
      human.play(swimming || groundSpeed > 0.15 ? clip : 'idle');
      human.swim(swimPhase, swimClip ? 0 : afloat);
    } else {
      bodyMesh.visible = !bodyHidden;
      hatMesh.visible = !bodyHidden;
    }
    // Prone once they are going somewhere, nearer upright when they are not:
    // a body treading water holds its chest up, and a body lying flat in the
    // river while standing still reads as a corpse.
    const lie = TREAD_PITCH + (1 - TREAD_PITCH) * Math.min(1, groundSpeed / SWIM_SPEED);
    floatPivot.rotation.x = swimClip ? 0 : afloat * FLOAT_PITCH * lie;

    /**
     * First person is at the eyes, not at the chest the rig orbits.
     *
     * Applied to the camera and carried into the aim with it, so it is a
     * translation of the whole rig: the view direction does not change, and the
     * body — which is hidden everywhere this is non-zero, `FIRST_PERSON_UNDER`
     * being the same two metres — cannot be moved up the frame by it.
     */
    const eyeLift = (headHeight - pivotHeight) * (1 - Math.min(1, orbit / FIRST_PERSON_UNDER));

    camera.position.set(pivotX - lineX * orbit, pivotY - lift * orbit + eyeLift, pivotZ - lineZ * orbit);

    // Along the rig's own line, from the camera rather than from the walker.
    // `lookAt` needs a point and this one is on the line through the pivot, so
    // the body lands where the arithmetic says it does; aimed from the walker it
    // would not, because the camera is metres further back along the same line
    // and sees a forty-metre point at a shallower angle than was asked for —
    // measured at +80° of pitch coming out as 67° at the lens.
    camera.lookAt(
      camera.position.x + awayX * AIM_REACH,
      camera.position.y + lift * AIM_REACH + (cameraMotion ? ridePitch * AIM_REACH : 0),
      camera.position.z + awayZ * AIM_REACH
    );

    // The horizon stays level unless the player has asked for the extras. A
    // stride and a bend used to roll it by a fraction of a degree, which is both
    // invisible and a documented way to make somebody ill.
    const lean = cameraMotion ? strideRoll + rideRoll : 0;
    if (lean !== 0) camera.rotateZ(lean);

    // Travel mode earns a wider lens, under the same gate: a field of view that
    // moves with speed is the third of the three triggers, and the one that is
    // hardest to point at afterwards. The base is re-read whenever something else
    // has written the field — a resize, a screenshot — so the offset never
    // compounds on top of itself, and the same re-read puts the lens back when
    // the setting goes off mid-stride.
    if (camera.fov !== fovApplied) fovBase = camera.fov;
    const wanted = fovBase + (cameraMotion ? travel * (reducedMotion ? 2 : 5) : 0);
    if (wanted !== camera.fov) {
      camera.fov = wanted;
      camera.updateProjectionMatrix();
    }
    fovApplied = wanted;

    // --- what the water does back -------------------------------------------
    if (effects) {
      frame.x = position.x;
      frame.z = position.z;
      frame.depth = depth;
      frame.afloat = afloat;
      frame.speed = groundSpeed;
      frame.heading = yaw;
      frame.stroke = swimPhase;
      frame.lens = camera.position.y - (water ? water.level : 0);
      frame.wet = wet;
      effects.update(delta, frame, camera);
    }

    promptText = !group.visible
      ? null
      : ride
        ? machine
          ? PROMPT_DISMOUNT
          : PROMPT_LEAVE
        : boardable && boardGap <= exitGap
          ? boardPrompt(boardable.noun)
          : exitNear
            ? PROMPT_ASHORE
            : null;
  };

  return {
    group,
    position,
    get yaw() {
      return yaw;
    },
    get viewYaw() {
      return cameraYaw;
    },
    update,
    setJoystick: (input) => {
      joystick = input;
    },
    setSensitivity: (value) => {
      sensitivity = Math.min(3, Math.max(0.2, value));
    },
    setCameraMotion: (value) => {
      cameraMotion = value;
    },
    setView: applyView,
    toggleView: () => applyView(distance > 1 ? 'first' : 'third'),
    onViewChange: (handler) => {
      viewHandler = handler;
      handler?.(distance > 1 ? 'third' : 'first');
    },
    onLockChange: (handler) => {
      lockHandler = handler;
      handler?.(locked);
    },
    requestLock,
    teleport: (x, z) => {
      knockX = 0;
      knockZ = 0;
      ride?.steer?.(null);
      // A machine does not come along: it stays where it was left, on its stand.
      ride?.machine?.park();
      ride = null;
      rideSpeed = 0;
      drive = null;
      tuning = null;
      group.rotation.set(0, yaw, 0);
      // Infinite reference, so arriving over a jetty puts you on it rather than
      // on the bed under it — a teleport has no previous height to be near.
      position.set(x, floorAt(x, z, Number.POSITIVE_INFINITY), z);
      // Arriving inside a trunk or a station platform has no previous position
      // to fall back on, so the landing point is the fallback.
      safeX = x;
      safeZ = z;
      gatherContacts(x, z, position.y);
      depenetrate();
      position.y = floorAt(position.x, position.z, Number.POSITIVE_INFINITY);
      footY = position.y;
      standY = position.y;
      groundSpeed = 0;
      gait = 0;
      group.position.copy(position);
    },
    prompt: () => promptText,
    interact: () => {
      interactQueued = true;
    },
    body: () => {
      if (drive && tuning) return readDriveBody(drive, tuning, position.x, position.z, self);
      // On foot, where there is no `DriveState` to read a velocity off: `step`
      // is the unit direction the body is going and `groundSpeed` is how fast,
      // which is the same pair the walk integrates with.
      self.x = position.x;
      self.z = position.z;
      self.vx = step.x * groundSpeed;
      self.vz = step.z * groundSpeed;
      self.mass = BODY_MASS;
      // The shoulders, which is the radius this file already uses against
      // anything whose own radius is the real thing.
      self.radius = SHOULDER;
      return self;
    },
    telemetry: () => {
      const machine = ride?.machine;
      // `tuning` is made and thrown away with `drive` at `board` and `stepOff`,
      // so it is never the odd one out — but it is tested rather than asserted,
      // because the next person to add a way off a machine should not have to
      // know that.
      if (!drive || !tuning || !ride || !machine) return null;
      dash.speed = drive.along;
      dash.topSpeed = machine.topSpeed;
      // The three pedals as they were applied this frame, off the same struct
      // `stepDrive` was handed — so the dial cannot disagree with the physics
      // about what the rider asked for.
      dash.throttle = driveInput.throttle;
      dash.brake = driveInput.brake;
      dash.handbrake = driveInput.handbrake;
      dash.boost = drive.boost;
      dash.boosting = drive.boosting;
      dash.slip = drive.slip;
      dash.frontSlide = drive.frontSlide;
      dash.rearSlide = drive.rearSlide;
      dash.gear = drive.gear;
      dash.gears = tuning.gears.length;
      dash.engine = drive.engine;
      dash.shifting = drive.shiftFor > 0;
      dash.auto = driveInput.auto ?? true;
      // Off `ridden`, which the ride branch fills from the surface ahead every
      // frame. The branch's own `grade` is a local and this is the same number:
      // hoisting a second copy of it would be two places to get it wrong.
      dash.grade = ridden.grade;
      dash.noun = ride.noun;
      return dash;
    },
    riding: () => ride !== null,
    ridingId: () => ride?.id ?? null,
    setPlatforms: (spans) => indexPlatforms(spans),
    waterEffects: effects?.group ?? null,
    setNight: (amount) => effects?.setNight(amount),
    dispose: () => {
      if (document.pointerLockElement === domElement) document.exitPointerLock();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onLockChange);
      domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
      domElement.removeEventListener('wheel', onWheel);
      motionQuery?.removeEventListener('change', onMotionChange);
      effects?.dispose();
      human?.dispose();
      parts.dispose();
      bodyMaterial.dispose();
      hatMaterial.dispose();
    },
  };
};
