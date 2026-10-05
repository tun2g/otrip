import type { Terrain, WaterParams } from '@otrip/world';
import { Color, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Vector3, type AnimationClip } from 'three';

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
/** How far the eyes sit above the surface when swimming. */
const SWIM_EYE = 0.22;
/** How far the body's origin sits below the surface once it is floating. */
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
 * Eye height astride a xe máy: the saddle at 0.86 m plus a sitting body, against
 * 1.64 m standing. It moves the camera and nothing else — the rider you see is
 * the machine's own seated figure, not the walking avatar.
 */
const SADDLE_EYE = 1.35;
/**
 * How much further the camera trails at a machine's top speed. 8.5 m frames a
 * body at walking pace; at 9 m/s the same 8.5 m is a metre of road ahead of the
 * front wheel, so it opens to 12.75 m, which puts the next bend in the picture.
 */
const RIDE_PULLBACK = 0.5;
/** Metres ahead a rider reads the gradient to know what the engine will hold. */
const GRADE_PROBE = 4;
/**
 * Rad/s a stopped machine is walked round by the rider's own feet, faded out by
 * the time it is rolling at 1 m/s. 0.6 is 34°/s — a half turn in five seconds,
 * which is about how long it takes to shuffle a Wave round in a lane.
 */
const PADDLE_RATE = 0.6;
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
 * What a gradient costs the engine, and the least it leaves. A 1:5 climb takes a
 * loaded Wave down to about two thirds; `HILL_FLOOR` is the pull it keeps on
 * anything it is still allowed to attempt, which is why the two numbers are not
 * independent of `Machine.climb`.
 */
const HILL_COST = 1.4;
const HILL_FLOOR = 0.35;
/** How far off the helm a body lands when it comes over the gunwale. */
const DECK_MARGIN = 2;
/** How far a disembarking walker will be carried to find a deck or a bank. */
const LANDING_REACH = 14;

const CAMERA_HEIGHT = 2.5;
const CAMERA_CLEARANCE = 1.4;
const OCCLUSION_SAMPLES = 10;
/**
 * Seconds the camera has to stay inside the avatar's own space before the view
 * gives up and moves to the eyes.
 *
 * Collapsing on the first blocked frame is what made a doorway, a lamp post or a
 * tree you walk past read as "the character has disappeared" — and `allowed` is
 * quantised to `distance/OCCLUSION_SAMPLES`, 0.85 m steps, with the threshold
 * sitting between step 2 at 1.70 and step 3 at 2.55, so a block that moves by
 * one sample is the whole difference between a camera drawn in and an avatar
 * gone. Waiting instead means a graze costs a few frames of clipped shoulder,
 * which is much the smaller problem, while a camera genuinely pinned against a
 * wall still ends up at the eyes. Recovery is immediate: one clear frame and the
 * body is back.
 */
const FIRST_PERSON_AFTER = 0.4;
/**
 * Under this the avatar fills the lens — and the scene's near plane is 2 m, so
 * below it the body is sliced open around the camera rather than merely large.
 * Which is why this is not the knob to turn when the avatar goes missing.
 */
const FIRST_PERSON_UNDER = 2;
/**
 * How far down the half-frame the feet are allowed to sit. A trailing camera
 * puts them at about 0.86 of it naturally — the body belongs low in the picture,
 * with the place you are walking into above it — so this leaves the framing
 * alone and only bites when something else is pushing the body towards the edge.
 */
const KEEP_IN_FRAME = 0.92;
/**
 * Radians of upward pitch over which `KEEP_IN_FRAME` is let go of.
 *
 * Measured on the Hồ Tây flat, the cap starts biting about one degree above the
 * horizon, so it has to be released almost at once or looking up is still a
 * fight; but releasing it on a hard `if` jumps the aim of a forty-metre lever,
 * and the mouse crosses the horizon constantly. Seven degrees fits the whole
 * fade inside one flick and keeps the view angle moving roughly one-for-one with
 * the pitch through it.
 */
const FREE_LOOK_ABOVE = 0.12;
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
  /** Overrides the `prefers-reduced-motion` media query, for tests. */
  reducedMotion?: boolean;
};

export type Walker = {
  group: Group;
  position: Vector3;
  yaw: number;
  update: (delta: number, camera: PerspectiveCamera) => void;
  setJoystick: (input: Joystick | null) => void;
  setSensitivity: (value: number) => void;
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
  /** True while slaved to a boat's deck. */
  riding: () => boolean;
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

  const motionQuery =
    options.reducedMotion === undefined && typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  let reducedMotion = options.reducedMotion ?? motionQuery?.matches ?? false;
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
  let cameraPitch = -0.07;
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

  let fovBase = 0;
  let fovApplied = Number.NaN;

  const applyView = (view: 'first' | 'third') => {
    distance = view === 'first' ? 0 : DEFAULT_DISTANCE;
    viewHandler?.(view);
  };

  const look = (deltaX: number, deltaY: number) => {
    cameraYaw -= deltaX * BASE_SENSITIVITY * sensitivity;
    cameraPitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, cameraPitch - deltaY * BASE_SENSITIVITY * sensitivity));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    pressed.add(event.code);
    // V is the usual key for this in third-person shooters, and having it on the
    // keyboard means the view can be changed without letting go of the mouse.
    if (event.code === 'KeyV') applyView(distance > 1 ? 'first' : 'third');
    // Queued rather than acted on here: boarding needs the frame's own idea of
    // what is alongside, and a held key must not board twice.
    if (event.code === 'KeyE' && !event.repeat) interactQueued = true;
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
  const cameraTarget = new Vector3();
  const frame: SwimFrame = { x: 0, z: 0, depth: 0, afloat: 0, speed: 0, heading: 0, stroke: 0, lens: 0, wet: 0 };
  const ridden: Ridden = { x: 0, y: 0, z: 0, heading: 0, speed: 0, turn: 0, grade: 0, delta: 0 };

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

    if (rideable.machine) {
      // Astride it, not aboard it: the rider is where the machine is from the
      // first frame, because there is no deck to walk and no oar to walk to. The
      // machine's own seated figure is what gets drawn from here on.
      rideHeading = Math.atan2(rideable.forward.x, rideable.forward.z);
      rideSpeed = 0;
      rideTurn = 0;
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
      yaw = Math.atan2(move.x, move.z);
    } else {
      // Standing still, the avatar faces where the camera is looking.
      yaw = cameraYaw;
    }

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

    if (machine && ride) {
      // Astride something with wheels. The whole of the difference from a hull is
      // who integrates the motion: a boat is given orders and works out where she
      // goes, while this is worked out here, because the road under the wheels,
      // the gradient and everything solid are already known in this file and
      // nowhere else.
      depth = 0;
      afloat = 0;
      groundSpeed = 0;

      // Throttle and bars, raw rather than camera-relative, the same way the oar
      // is: ahead is where the machine points wherever you are looking.
      const throttle = clamp(inputZ, -1, 1);
      const bars = clamp(inputX, -1, 1);

      // What the engine will hold on the hill in front, read off the surface
      // rather than the terrain so a bridge is flat and an embankment is not.
      const probe = floorAt(
        position.x + Math.sin(rideHeading) * GRADE_PROBE,
        position.z + Math.cos(rideHeading) * GRADE_PROBE,
        footY
      );
      const grade = (probe - footY) / GRADE_PROBE;
      const hill = clamp(1 - Math.max(0, grade) * HILL_COST, HILL_FLOOR, 1);

      const want = throttle >= 0 ? throttle * machine.topSpeed * hill : throttle * machine.reverse;
      rideSpeed +=
        want > rideSpeed
          ? Math.min(want - rideSpeed, machine.accel * delta)
          : -Math.min(rideSpeed - want, machine.brake * delta);

      // The turn is the tyres' and opens out with speed: `grip / v` is 0.58 rad/s
      // at 9 m/s, a 15.6 m circle. Below about 4.7 m/s that law runs away, and
      // `pivot` is where the rider's own feet take over from the tyres. Signed by
      // the way it is rolling, because a machine going backwards answers its bars
      // the other way about.
      const rate = Math.min(machine.pivot, machine.grip / Math.max(0.5, Math.abs(rideSpeed)));
      // Stopped, the bars do nothing — but a rider does: feet down and walk it
      // round, which is the one thing two wheels can do that four cannot. Without
      // it anything that takes the speed off pins the machine facing it for ever:
      // measured at Hội An, riding north off the spawn put the front wheel at the
      // Thu Bồn, the step into the water was refused, the speed went to nothing
      // and with it the turn, and the only way out left was reverse.
      const paddle = PADDLE_RATE * (1 - Math.min(1, Math.abs(rideSpeed)));
      rideTurn = -bars * (rate * clamp(rideSpeed, -1, 1) + paddle);
      rideHeading += rideTurn * delta;

      const edge = terrain.size / 2 - 4;
      const advance = rideSpeed * delta;
      const wantX = clamp(position.x + Math.sin(rideHeading) * advance, -edge, edge);
      const wantZ = clamp(position.z + Math.cos(rideHeading) * advance, -edge, edge);
      const fromX = position.x;
      const fromZ = position.z;

      // The body's own collision, unchanged: houses, trunks and lineside
      // structures, in substeps, because 9 m/s is 2.25 m at 4 fps.
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

      // What it got through. Straight into a wall takes the speed off it; a
      // glancing blow costs what the contact took out of the step. The same
      // answer a hull gets when she touches, and it is what stops the machine
      // grinding along a house at full throttle.
      const got = Math.hypot(position.x - fromX, position.z - fromZ);
      if (reach > 1e-5 && got < reach - 1e-3) rideSpeed *= clamp(got / reach, 0, 1);

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
      ridden.heading = rideHeading;
      ridden.speed = rideSpeed;
      ridden.turn = rideTurn;
      ridden.grade = grade;
      ridden.delta = delta;
      machine.place(ridden);
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
    // No camera bob. It was added so the stride would not look like skating, but
    // on screen a rising and falling horizon reads as dropped frames rather than
    // as footsteps — the user called it lag. The stride still drives the clip
    // rate below, which is what actually stops the feet sliding; the camera just
    // no longer joins in. Roll is kept at a trace so a turn still has weight.
    const bobAmount = 0;
    const rollAmount = reducedMotion ? 0 : STRIDE_ROLL * 0.25 * paceOut;
    const bob = Math.sin(stridePhase * 2) * bobAmount;
    const strideRoll = Math.sin(stridePhase) * rollAmount;
    // Afloat, the stride is gone and the surface itself does the moving.
    // Afloat, the surface itself does the moving, which is a real thing you are
    // standing on rather than an invented camera shake — kept, but halved.
    const heave = reducedMotion
      ? 0
      : afloat * (Math.sin(elapsed * 1.3) * 0.025 + Math.sin(elapsed * 0.7 + 1.1) * 0.015);

    const standingEye = position.y + (machine ? SADDLE_EYE : eyeHeight);
    const swimEye = water ? water.level + SWIM_EYE : standingEye;
    const headY = (ride ? standingEye : standingEye + (swimEye - standingEye) * afloat) + bob + heave;

    const horizontal = Math.cos(cameraPitch);
    const lift = Math.sin(cameraPitch);
    /**
     * The pitch the camera rig itself swings through, as against the pitch the
     * view is aimed at. Downward it is the player's: pitching down raises the
     * camera and foreshortens its trailing offset, which is the over-the-shoulder
     * view a slope needs. Upward it is nothing at all — the rig stays where it
     * was and only the view turns.
     *
     * Carried upward it drove the rig under your own feet. At +80° `lift` asked
     * for 4.2 m below the head, where `floorBehind` pinned it on the ground,
     * while `horizontal` pulled the trailing offset in from 8.5 m to 1.45 m:
     * measured on the Hồ Tây flat the camera ended up 1.98 m from the head
     * against a 2 m near plane, so the body was sliced open rather than drawn,
     * which is what the user saw as the character being gone — with
     * `human.group.visible` true the whole time. Holding the rig still keeps the
     * head 8.86 m off at every pitch, and keeps the occlusion sweep below on the
     * line the camera actually occupies instead of one that dives underground
     * through the footprints of buildings you are standing next to.
     *
     * Both match `horizontal`/`lift` at the horizon and both have zero slope
     * there, so nothing steps as the pitch crosses it.
     */
    const rigLift = Math.min(0, lift);
    const rigOut = lift > 0 ? 1 : horizontal;

    // Under way on a machine the camera is let out, eased off the throttle
    // rather than off the frame, so it opens and closes over about a second and
    // a half instead of pumping with every touch of the brake. It is the trailing
    // distance only: `distance` stays the player's, so V and the wheel still mean
    // what they meant and a view pulled all the way in stays first person.
    const over = machine ? Math.min(1, Math.abs(rideSpeed) / machine.topSpeed) : 0;
    rideBack += (over - rideBack) * (1 - Math.exp(-delta * 0.7));
    const out = distance * (1 + RIDE_PULLBACK * rideBack);

    // Pull the camera in until the line back to it clears the ground and any
    // buildings, otherwise looking at your own avatar means looking through a
    // hill or a wall.
    let allowed = out;
    /**
     * The highest ground the trailing line passes over, out as far as the
     * camera is actually allowed to go.
     *
     * The ground is not an occluder and must not be treated as one. A wall is
     * opaque and the only answer to it is to come closer; a hillside can be
     * stood on top of, which is the difference between following someone down a
     * slope and staring into it — and standing on it is what the camera already
     * meant to do. But the old sweep blocked on the ground like anything else,
     * and the trailing line only climbs `CAMERA_HEIGHT` over `distance`, so
     * anything steeper than about twenty degrees pulled the camera all the way
     * in. That set `trailing` to zero, which switched off the very lift that
     * handles slopes, and the two cancelled out: measured walking downhill from
     * the Tà Xùa spawn, `allowed` sat at 0 and the avatar was gone for fourteen
     * seconds straight. So the ground raises the camera and only solid things
     * shorten it.
     */
    let groundNeed = Number.NEGATIVE_INFINITY;
    for (let sample = 1; sample <= OCCLUSION_SAMPLES; sample += 1) {
      const fraction = sample / OCCLUSION_SAMPLES;
      const sampleX = position.x - Math.sin(cameraYaw) * rigOut * out * fraction;
      const sampleZ = position.z - Math.cos(cameraYaw) * rigOut * out * fraction;
      const sampleY = headY + (CAMERA_HEIGHT - rigLift * out) * fraction;

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
        allowed = out * ((sample - 1) / OCCLUSION_SAMPLES);
        break;
      }

      // Only for the stretch the camera is allowed to occupy — the loop breaks
      // before this on a solid, so ground beyond a wall never lifts anything.
      groundNeed = Math.max(groundNeed, floorAt(sampleX, sampleZ, footY) + CAMERA_CLEARANCE);
    }

    // Under about two metres the avatar fills the lens, so it steps aside and
    // the view becomes first person — but only once the camera has been held
    // there, because a doorway or a passing trunk takes a handful of frames and
    // snapping to the eyes for each one is what read as the character
    // disappearing. Deliberate first person, where the view was pulled all the
    // way in, is not a graze and does not wait.
    crowded = allowed < FIRST_PERSON_UNDER ? crowded + delta : 0;
    const firstPerson = distance < FIRST_PERSON_UNDER || crowded >= FIRST_PERSON_AFTER;
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

    // The shoulder offset has to fade out with the distance, otherwise pulling
    // all the way in leaves the camera hanging three metres above your own head.
    const shoulder = CAMERA_HEIGHT * (out === 0 ? 0 : allowed / out);
    const behindX = position.x - Math.sin(cameraYaw) * rigOut * allowed;
    const behindZ = position.z - Math.cos(cameraYaw) * rigOut * allowed;

    // On a steep slope the camera used to be squeezed to a few metres and ended
    // up staring into the hillside. Standing it on top of whatever ground is
    // behind you turns that into an over-the-shoulder view down the slope. Over
    // water that ground is the bed, so the surface is a floor of its own —
    // otherwise following a swimmer means following them from underneath.
    const eyeY = headY + shoulder - rigLift * allowed;
    // Standing on the highest ground along the whole trailing line, not just on
    // what happens to be under the far end: a hummock halfway back put the
    // camera inside itself every time the far end sat in a dip.
    const standOn = groundNeed > Number.NEGATIVE_INFINITY ? groundNeed + 1.6 : eyeY;
    const floorBehind = water ? Math.max(standOn, water.level + 0.45) : standOn;

    // The floor only applies to a camera that is actually trailing. Applied at
    // zero distance it lifted the first-person eye three metres above the head,
    // which swallowed the stride bob and put the waterline out of frame.
    const trailing = Math.min(1, allowed / 3);
    cameraTarget.set(behindX, eyeY + (Math.max(eyeY, floorBehind) - eyeY) * trailing, behindZ);

    camera.position.lerp(cameraTarget, firstPerson ? 1 : Math.min(1, delta * 12));

    /**
     * Where the camera looks. The pitch is the player's, until holding it would
     * leave the body behind.
     *
     * Aimed from the camera, not from the walker. A point forty metres ahead of
     * the walker is one the camera sees at a shallower angle than was asked
     * for, because the camera is another eight metres back along the same line:
     * +80° of pitch measured 67° at the lens. From the camera the two are the
     * same number by construction.
     *
     * Pitched down, the aim is pitched down further by however much it takes to
     * hold the feet inside the frame, and by nothing at all when they already
     * are, which on level ground is every frame. The lever is why that is
     * needed: the aim point is forty metres off and the body is eight, so a
     * metre of lift moves the body down the frame about five times as far as it
     * moves the aim — standing the camera up to clear a hillside drops the
     * avatar off the bottom edge long before the view has pitched down to follow
     * it. And the body stays `visible` through all of it, so nothing in the code
     * is any the wiser; the first measurement of that walk reported the avatar
     * perfectly healthy while it was below the picture.
     *
     * Pitched up, it is let go of. Holding the feet in frame above the horizon
     * means holding the camera pointed at the ground: measured on the Hồ Tây
     * flat, +80° of pitch came out as 40° *below* the horizon and +29° came out
     * as +2°, which is the whole of "it is very hard to look up at the sky".
     * Someone looking up is looking at the moon, not at the avatar, so the
     * avatar is allowed to slide off the bottom edge.
     */
    let aimY = camera.position.y + lift * 40;
    const reach = Math.hypot(camera.position.x - position.x, camera.position.z - position.z);
    if (reach > 0.01) {
      const toFeet = Math.atan2(position.y - camera.position.y, reach);
      const lowest = toFeet + ((camera.fov * Math.PI) / 180 / 2) * KEEP_IN_FRAME;
      const capped = camera.position.y + Math.tan(lowest) * horizontal * 40;
      // Faded over `FREE_LOOK_ABOVE` rather than switched off at the horizon,
      // which the mouse crosses constantly and where a hard cut would jump the
      // aim by metres at the far end of the lever.
      const hold = 1 - Math.min(1, Math.max(0, lift) / FREE_LOOK_ABOVE);
      if (aimY > capped) aimY += (capped - aimY) * hold;
    }

    camera.lookAt(
      camera.position.x + Math.sin(cameraYaw) * horizontal * 40,
      aimY + ridePitch * 40,
      camera.position.z + Math.cos(cameraYaw) * horizontal * 40
    );

    const lean = strideRoll + rideRoll;
    if (lean !== 0) camera.rotateZ(lean);

    // Travel mode earns a wider lens. The base is re-read whenever something
    // else has written the field — a resize, a screenshot — so the offset never
    // compounds on top of itself.
    if (camera.fov !== fovApplied) fovBase = camera.fov;
    const wanted = fovBase + travel * (reducedMotion ? 2 : 5);
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
    update,
    setJoystick: (input) => {
      joystick = input;
    },
    setSensitivity: (value) => {
      sensitivity = Math.min(3, Math.max(0.2, value));
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
      ride?.steer?.(null);
      // A machine does not come along: it stays where it was left, on its stand.
      ride?.machine?.park();
      ride = null;
      rideSpeed = 0;
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
    riding: () => ride !== null,
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
