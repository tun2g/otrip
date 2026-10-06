import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import { Group, Mesh, Vector3 } from 'three';

import { createImpactor, tuneDrive, type DriveSpec, type Impactor } from './driving';
import type { Machine, Rideable, Ridden } from './life';
import { styleOf, type TownStyle } from './town-styles';
import type { ParkingSpot, RoadKind, RoadNetwork, RoadSample } from './road-network';
import { buildFor, motorbikeBuild, PAINT } from './vehicle-builds';
import { COCKPIT_LAYER, createVehicleKit, type Rig, type VehicleKit } from './vehicle-kit';
import { GRAVITY, SPECS, type Spec, type VehicleKind } from './vehicle-specs';
import { pick } from './vehicle-parts';
import type { WorldWeather } from './weather-state';

/**
 * The fleet, in the order it is dealt out, cut to whatever count the caller
 * asks for. Xe máy first and xe máy most everywhere — that is the ratio on any
 * road in the country and the whole reason these are written lists rather than a
 * sampled distribution — but what the rest of the list is differs by the kind of
 * settlement, and that was the bug: one roster plus a `town.lanterns` test gave
 * all four places the same fleet, down to a xích lô pedalling round Tây Hồ.
 *
 * `lanterns` was the wrong variable to ask. At Hồ Tây it is true and means the
 * window lights of a tower block; the question a xích lô answers is whether this
 * is an old quarter, which `styleOf` already decides off the terrain profile and
 * the height the recipe lets the town build to.
 *
 * - `highland` — a Sơn La ridge: two wheels, a cargo bike and a bicycle, and the
 *   cart that does the work a truck would do if a truck could get up here.
 * - `oldTown` — Hội An: the xích lô belongs here and nowhere else of the four,
 *   and the place is full of rented bicycles. One coach brings the day trippers.
 * - `delta` — Tràng An: coaches, because that is how everybody arrives, plus the
 *   two wheels and carts of the villages between the towers.
 * - `city` — Tây Hồ: cars and a bus in traffic, no cart, no xích lô. The old
 *   quarter's cyclos are five kilometres away in Hoàn Kiếm.
 */
const ROSTERS: Record<TownStyle, VehicleKind[]> = {
  highland: [
    'motorbike',
    'motorbike',
    'motorbike-cargo',
    'motorbike',
    'bicycle',
    'motorbike',
    'buffalo-cart',
    'motorbike',
    'motorbike-cargo',
    'motorbike',
    'buffalo-cart',
    'motorbike',
    'bicycle',
    'motorbike',
    'motorbike',
    'motorbike',
  ],
  oldTown: [
    'motorbike',
    'bicycle',
    'cyclo',
    'motorbike',
    'motorbike-cargo',
    'bicycle',
    'cyclo',
    'motorbike',
    'car',
    'bicycle',
    'motorbike',
    'coach',
    'motorbike-cargo',
    'motorbike',
    'truck',
    'motorbike',
  ],
  delta: [
    'motorbike',
    'motorbike',
    'coach',
    'motorbike-cargo',
    'bicycle',
    'motorbike',
    'buffalo-cart',
    'motorbike',
    'car',
    'motorbike',
    'coach',
    'motorbike-cargo',
    'bicycle',
    'motorbike',
    'truck',
    'motorbike',
  ],
  city: [
    'motorbike',
    'car',
    'motorbike',
    'car',
    'motorbike',
    'coach',
    'motorbike',
    'truck',
    'motorbike',
    'car',
    'motorbike-cargo',
    'motorbike',
    'bicycle',
    'motorbike',
    'car',
    'motorbike',
  ],
};

type Agent = Rig & {
  spec: Spec;
  road: number;
  /** +1 with the centreline, −1 against it. Vietnam drives on the right either way. */
  dir: number;
  distance: number;
  /** Metres right of the centreline, in the direction of travel. */
  lane: number;
  speed: number;
  cruise: number;
  spin: number;
  crank: number;
  braking: number;
  bob: number;
};

export type Vehicles = {
  group: Group;
  /** Seconds since scene start. Deltas come out of it, so it must be monotonic. */
  update: (elapsed: number) => void;
  setNight: (amount: number) => void;
  /** Lights come on in heavy rain too, and everything slows down in it. */
  setWeather: (weather: WorldWeather) => void;
  /**
   * The parked xe máy, which are the ones that can be taken. The moving fleet is
   * not offered: every agent is a position on a queue along one centreline, and a
   * rider who took one out of it would be fighting the car behind for the lane.
   */
  rideables: () => Rideable[];
  /**
   * The shared materials and the assembler, so a companion's machine comes out
   * of the same pair of shaders as the bus in front of it. Owned here: it is
   * disposed with the fleet, and a rig borrowed from it dies at the same moment.
   */
  kit: VehicleKit;
  /**
   * The moving fleet as bodies a driven machine can hit, rewritten in place
   * every tick. Read fresh each frame and never held — and empty until the
   * first tick, because before that nothing has been put in a lane.
   */
  traffic: () => readonly Impactor[];
  /**
   * Hands the fleet a getter for where the player is, so it can brake for them.
   * Null unhooks it. A setter because the walker is made long after the fleet
   * and only once somebody goes down to walk the place.
   */
  watch: (body: (() => Impactor | null) | null) => void;
  dispose: () => void;
};

/** Handed out instead of the pool before the first tick has placed anything. */
const NONE: readonly Impactor[] = [];

/**
 * What the machine the *player* rides is, where it stops being a Honda Wave.
 *
 * Three numbers, and they are not a faster Wave — they are not a machine that
 * exists. The player has asked three times for the bike to be faster than
 * running and twice been answered with a top speed, which is the wrong
 * measurement: a body on foot crosses country in a straight line at a flat
 * 14 m/s, while a machine follows a carriageway 13% longer, brakes for every
 * bend, and takes seconds to spool up. Measured off this probe's own sustained
 * figures and divided by that 1.13, the stock Wave came to 0.98× running at
 * Tràng An and 1.01× at Tà Xùa. The player was right every time. Asked what they
 * wanted instead they said "phải nhanh hơn 3x 4x", so this is three to four
 * times a running body and is written down as a fiction rather than dressed up
 * as a 150 cc.
 *
 * `grip` is the one that matters and the one that is easy to get wrong. A
 * corner bounds the average; the top speed does not. At the stock 5.2 m/s² a
 * 125 m bend holds 25.5 m/s and a 58 m bend 17.4, so raising the power alone
 * gives a machine that reaches 198 km/h on a straight, leaves the road at every
 * bend, and has exactly the same point-to-point average it always had. At
 * 30 m/s² — `tuneDrive` reads it as `grip / (G · CRUISE_SHARE)`, so 16.5 is
 * 3.06 g at the tyre — the same two bends hold 61.2 and 41.7.
 *
 * It is applied **here**, where the ridden `DriveSpec` is assembled, and not in
 * `SPECS`. `Spec.grip` is also what the fleet's own bend law reads as
 * `sqrt(spec.grip / bend)`, and that law had never once fired at three of the
 * four destinations until the roads were made sinuous — hand the traffic 3 g and
 * it stops braking for corners again and that work is undone.
 *
 * The governor, the boost ceiling, the hard cap and the room's own rejection
 * limit are all raised to match, in `driving-tuning.ts`, `driving.ts`,
 * `driving-state.ts` and the server's `configuration.ts`. The reasoning for the
 * figures those four carry lives with them.
 *
 * The bodywork is untouched. It is still the step-through `motorbikeBuild`
 * draws, and it still reads as one.
 */
/**
 * What the one you ride is, as against what the fleet around it is.
 *
 * The player asked to be three to four times quicker than running, which on
 * these roads is 198 km/h, and that is no longer a 110 cc step-through whatever
 * the bodywork still draws. These are the four numbers that follow from saying
 * so, and they are overridden here rather than in `SPECS` because the NPC fleet
 * reads that table — its bend law takes `grip`, and a traffic jam with a 3 g
 * tyre limit stops braking for corners at all.
 *
 * `dragArea` is the one that was wrong for a long time without showing. It
 * stayed at the naked Wave's 0.59 m² while the power went up **twelvefold**, and
 * drag is what decides how much load the front axle keeps: holding 49.6 m/s
 * means pushing 880 N of air, which levers 391 N off an 858 N front and takes
 * the cornering grip down to 46% of the tyre. A faired machine at this speed is
 * 0.30–0.35 m² in reality, and 0.32 takes the full-lock radius at 49.6 m/s from
 * 168.5 m to 126.4 m without the top speed moving — measured 55.01 against the
 * 55 governor, because the power was never the binding constraint up there.
 *
 * The extra mass is the fairing, the frame and the bigger engine that go with
 * it: 230 kg with a rider against a Wave's 165. It helps the same problem from
 * the other side — more static load on the front for the same lever to shift —
 * and takes the radius to 111.7 m on its own.
 */
const RIDDEN = { mass: 230, power: 62000, grip: 16.5, dragArea: 0.32 };

/** A motorbike will take a trail, but at a crawl, and only one of them will. */
const TRAIL_CRUISE = 4.2;

/**
 * What the one you ride yourself will do — and no longer a table of answers.
 *
 * There used to be three numbers here: `RIDER_TOP = 9`, `RIDER_REVERSE = 1.2`
 * and `RIDER_PIVOT = 1.1`, with a long argument for the first. The argument was
 * that a player is reading an unfamiliar lane off a camera, so 9 m/s — 32 km/h —
 * was enough. It was overruled by the person it was written for: the bike was
 * slower than the 14 m/s a body covers ground at on foot, so riding one was
 * strictly worse than walking, and the whole feature read as scenery.
 *
 * All three are gone, because they were outcomes rather than properties. The
 * machine is now described — mass, power, drag area, rolling resistance, where
 * the weight sits — and `driving.ts` works the outcomes out: 23.60 m/s flat out
 * on the Wave, which is the real machine's 85 km/h, reached by the force falling
 * off against the drag rather than by meeting a clamp. Reverse is the rider's
 * own feet and the crawl-speed pivot is their legs, both of which that module
 * derives from the wheelbase and the mass.
 *
 * What stays here is what the *world* decides rather than the machine: how steep
 * a hillside it will attempt, and how deep a flood it will ride through.
 */
/**
 * The steepest bare ground it will take: 0.45 is 24°, which is a dirt ramp off a
 * kerb and not a hillside. Measured against the four road networks, no
 * centreline sample is both off a published surface and steeper than this, so
 * the limit never stands between a rider and a road — including Tà Xùa's, whose
 * terrain under the carriageway averages a gradient of 0.60 and reaches 2.64.
 * A walker is allowed 1.15 (49°) because a body can scramble; a motorbike on a
 * 49° slope is a bug.
 */
const RIDER_CLIMB = 0.45;
/** Metres of water it will ride through. A flooded lane, not a river. */
const RIDER_FORD = 0.25;
/** Metres the wheels sit clear of the surface, as the parked bikes always did. */
const TYRE_LIFT = 0.01;
/** Where the saddle is on the Wave build: `seatedRider`'s hip. */
const SADDLE_HEIGHT = 0.86;
/** Over on its side stand, the only way one of these ever stands still. */
const PARK_LEAN = 0.12;

/**
 * Xe máy, xe con, xe tải, xe khách, xe đạp, xích lô, xe trâu — a handful of them,
 * each built properly, driving the centrelines the road network hands over.
 *
 * Nothing here is instanced. At sixteen vehicles the win would be a few draw
 * calls and the cost would be every detail that makes a motorbike read as a
 * motorbike. What is shared is the materials; each vehicle's static bodywork is
 * merged into one vertex-coloured geometry, so a bike with ninety parts still
 * costs one draw call for its body.
 */
/**
 * Xe máy, xe con, xe tải, xe khách, xe đạp, xích lô, xe trâu — a handful of them,
 * each built properly, driving the centrelines the road network hands over.
 *
 * The materials and the assembler are `vehicle-kit.ts`'s now, because a
 * companion's bike has to come out of the same pair of shaders as the bus in
 * front of it. The kit is made here and disposed here, so a rig handed to
 * another module lives exactly as long as the fleet does — `avatar-ride.ts`
 * borrows it and `world-renderer.ts` disposes both at the same teardown.
 */
export const createVehicles = (
  recipe: LocationRecipe,
  network: RoadNetwork,
  count: number,
  /** Only the parked bikes need it: a kerb-side spot has to stand on something. */
  terrain: Terrain
): Vehicles => {
  const random = createPrng(`${recipe.seed}:vehicles`);
  const group = new Group();
  group.name = 'vehicles';

  const kit = createVehicleKit();
  const assemble = (kind: VehicleKind, build: Parameters<VehicleKit['assemble']>[1]): Rig => {
    const rig = kit.assemble(kind, build);
    group.add(rig.group);
    return rig;
  };

  // --- deal the fleet out ---------------------------------------------------
  const agents: Agent[] = [];
  const hasLane = network.roads.some((road) => road.kind === 'lane');
  const hasSealed = network.roads.some((road) => road.kind === 'main' || road.kind === 'secondary');
  const roster = ROSTERS[styleOf(recipe)];
  let trailRiders = 0;

  const wanted = Math.max(0, Math.min(roster.length, Math.floor(count)));
  for (let i = 0; i < wanted && network.roads.length > 0; i += 1) {
    let kind = roster[i];
    // Substitutions, not omissions: a location with no sealed road still gets
    // its full count, it just gets all of it in xe máy. A cart needs a lane for
    // the same reason — there is nothing for it to be on a bare trail.
    if ((kind === 'coach' || kind === 'truck') && !hasSealed) kind = 'motorbike';
    if (kind === 'buffalo-cart' && !hasLane) kind = 'motorbike-cargo';

    const allowed = (spec: Spec) =>
      network.roads.filter(
        // A đường mòn is walked, not driven — except that a Wave will go up one,
        // which is very much a Vietnamese thing and worth exactly one of them.
        (road) => spec.roads.includes(road.kind) && (road.kind !== 'trail' || (kind === 'motorbike' && trailRiders < 1))
      );

    let candidates = allowed(SPECS[kind]);
    if (candidates.length === 0) {
      kind = 'motorbike';
      candidates = allowed(SPECS.motorbike);
    }
    if (candidates.length === 0) break;

    // Weighted by length, so a four-kilometre trunk carries the traffic and a
    // two-hundred-metre lane carries one bike. A trail is quartered: it is a
    // path that happens to admit a motorbike, not a road that wants one.
    const weigh = (kind2: RoadKind, length: number) => (kind2 === 'trail' ? length * 0.25 : length);
    let total = 0;
    for (const road of candidates) total += weigh(road.kind, road.totalLength);
    let roll = random() * total;
    let chosen = candidates[0];
    for (const road of candidates) {
      roll -= weigh(road.kind, road.totalLength);
      if (roll <= 0) {
        chosen = road;
        break;
      }
    }

    const spec = SPECS[kind];
    const rig = assemble(kind, buildFor(kind, random));
    // Nothing passes on a trail and nothing comes the other way down one.
    const single = chosen.kind === 'trail';
    if (single) trailRiders += 1;
    const dir = single ? 1 : i % 2 === 0 ? 1 : -1;
    const cruise = spec.cruise * (0.86 + random() * 0.24);

    agents.push({
      ...rig,
      spec,
      road: chosen.index,
      dir,
      distance: random() * chosen.totalLength,
      lane: dir * Math.min(chosen.laneOffset, chosen.width * 0.26),
      speed: cruise * 0.6,
      cruise: single ? Math.min(cruise, TRAIL_CRUISE) : cruise,
      spin: random() * Math.PI * 2,
      crank: random() * Math.PI * 2,
      braking: 0,
      bob: random() * Math.PI * 2,
    });
  }
  // --- parked xe máy, which are the ones you can take ------------------------
  const parked: Rideable[] = [];
  /** True while the player has it: its lamp is lit and its rider is drawn. */
  const taken = new Set<string>();
  /** Each parked bike's headlight cone, so `applyLights` can find it by id. */
  const glows = new Map<string, Mesh>();

  /**
   * The highest published surface over a point, or null where none covers it.
   * The same rectangles `walker.floorAt` reads, asked here because a parked bike
   * has to stand on the floor the rider will be standing on.
   */
  const deckUnder = (x: number, z: number, reference: number): number | null => {
    let best: number | null = null;
    for (const deck of network.decks) {
      const dx = x - deck.x;
      const dz = z - deck.z;
      const alongX = Math.sin(deck.yaw);
      const alongZ = Math.cos(deck.yaw);
      const along = dx * alongX + dz * alongZ;
      if (Math.abs(along) > deck.halfLength) continue;
      if (Math.abs(dx * alongZ - dz * alongX) > deck.halfWidth) continue;
      const surface = deck.surfaceY + (deck.grade ?? 0) * along;
      // A span crossing overhead is not this spot's floor.
      if (surface > reference + 0.4) continue;
      if (best === null || surface > best) best = surface;
    }
    return best;
  };

  /**
   * Where a kerb-side spot actually stands.
   *
   * `road-network` puts a spot 1.9 m beyond the kerb and gives it the
   * centreline's height — which on a road cut as a shelf is the height of the
   * carriageway and not of the verge, and on a draped one is a few centimetres
   * off the dirt. Measured: at Tà Xùa the six spots hang 6.00 to 8.31 m over the
   * hillside, at Hội An three of them sit 0.08 to 0.38 m into it. A bike you walk
   * up to and get on cannot be in the air, so the spot is carried in across the
   * kerb until the carriageway's own deck is under it, and failing that dropped
   * onto the ground where it stands.
   */
  const stand = (spot: ParkingSpot): { x: number; y: number; z: number } => {
    for (let step = 0; step <= 6.001; step += 0.25) {
      for (const side of step === 0 ? [1] : [-1, 1]) {
        const x = spot.x + Math.sin(spot.heading) * side * step;
        const z = spot.z + Math.cos(spot.heading) * side * step;
        const deck = deckUnder(x, z, spot.y);
        if (deck !== null) return { x, y: deck, z };
      }
    }
    return { x: spot.x, y: terrain.heightAt(spot.x, spot.z), z: spot.z };
  };

  /**
   * One bike at the head of every row, and a second in the first row.
   *
   * Not scaled with the detail tier, and deliberately: these are how the player
   * gets about, not scenery, and they cost nothing to leave standing — each is
   * one merged geometry and one draw call with no per-frame update until somebody
   * takes it. What was scaled was the *count*, which on the lowest tier came to a
   * single bike; and because every slot `road-network` published sat in one row
   * 0.9 m apart, spreading three bikes over that array put all three within four
   * metres of each other. A five-kilometre map therefore had one place to get a
   * motorbike however high you turned the quality up.
   *
   * `area` is what fixes it: one bike per row means a bike wherever a row is. The
   * second in row zero is there so the first place anybody finds has a spare —
   * two friends arriving together should not be one bike short.
   */
  /**
   * Three machines in every row.
   *
   * It was one per row plus a spare in the first, and a row with one bike in it
   * is a row that is empty the moment anybody takes it — the same defect the
   * jetty had with a single moored boat. It is also not what a kerb in Vietnam
   * looks like: bikes are left in a line, and a line of one is a lost bike.
   *
   * Three of the four slots `road-network` publishes, not four, so the row still
   * reads as a place people leave machines rather than a dealership with its
   * stock out. They cost almost nothing to leave standing: each is one merged
   * vertex-coloured geometry and one draw call, with no per-frame work at all
   * until somebody rides it.
   */
  const PER_ROW = 3;
  const filled = new Map<number, number>();
  const stands: ParkingSpot[] = [];
  for (const spot of network.parking) {
    const already = filled.get(spot.area) ?? 0;
    if (already >= PER_ROW) continue;
    filled.set(spot.area, already + 1);
    stands.push(spot);
  }

  for (let i = 0; i < stands.length; i += 1) {
    const spot = stands[i];
    const spec = SPECS.motorbike;
    const rig = assemble('motorbike', motorbikeBuild(pick(PAINT, random), false, random, true));
    const where = stand(spot);
    rig.group.name = 'motorbike-parked';
    rig.group.position.set(where.x, where.y + TYRE_LIFT, where.z);
    rig.group.rotation.y = spot.heading;
    rig.group.rotation.z = PARK_LEAN;
    // Nobody sits on a bike on its stand. The figure is the rider you become.
    if (rig.rider) rig.rider.visible = false;

    const id = `motorbike-${i}`;
    if (rig.glow) {
      rig.glow.visible = false;
      glows.set(id, rig.glow);
    }
    const forward = new Vector3(Math.sin(spot.heading), 0, Math.cos(spot.heading));
    let spin = 0;

    // The machine's own description, off its spec except where `RIDDEN` is
    // louder. `tuneDrive` is asked for the top speed rather than told one, so
    // the figure the HUD shows and the figure the physics produces cannot drift
    // apart.
    const drive: DriveSpec = {
      length: spec.length,
      width: spec.width,
      frontAxle: spec.frontAxle,
      rearAxle: spec.rearAxle,
      grip: RIDDEN.grip,
      brake: spec.brake,
      mass: RIDDEN.mass,
      power: RIDDEN.power,
      dragArea: RIDDEN.dragArea,
      rollCrr: spec.rollCrr,
      massBias: spec.massBias,
      cgHeight: spec.cgHeight,
      driveFront: spec.driveFront,
    };

    const machine: Machine = {
      drive,
      topSpeed: tuneDrive(drive).limit,
      climb: RIDER_CLIMB,
      ford: RIDER_FORD,
      mount: () => {
        taken.add(id);
        if (rig.rider) rig.rider.visible = true;
        rig.group.rotation.z = 0;
        // On the cockpit layer as well as the world's, so the second pass can
        // draw this one machine with a near plane that can see the bars. Only
        // while it is being ridden: the other five parked bikes must not appear
        // in front of the rider's face.
        rig.group.traverse((node) => node.layers.enable(COCKPIT_LAYER));
        applyLights();
      },
      place: (at: Ridden) => {
        rig.group.position.set(at.x, at.y + TYRE_LIFT, at.z);
        rig.group.rotation.y = at.heading;
        // Nose up the hill, and down on the brakes the way the fleet does it.
        rig.group.rotation.x = -Math.atan(at.grade) - at.brake * 0.03;
        /**
         * The angle a free body takes against the cornering force, which on two
         * wheels is the whole of it.
         *
         * Against `lateral` — the force the tyres are actually making — and no
         * longer against `speed * turn`. The two agree while the machine tracks
         * and part company exactly where it matters: in a slide the tyres have
         * given up most of their grip while the yaw rate is at its highest, so
         * the old form leant a drifting bike hardest at the moment it has least
         * to lean against, and a handbrake turn looked like a railway curve.
         *
         * +Z rolls toward −X, so the sign puts it into the corner.
         */
        rig.group.rotation.z = -Math.atan(at.lateral / GRAVITY) * spec.leanGain;
        if (rig.steer) {
          // The lock the model actually has at the wheel, which in a slide is
          // turned *into* it — a rider catching the back end is the most
          // recognisable thing a drift does, and Ackermann off the yaw rate
          // cannot express it because it assumes the machine is tracking.
          rig.steer.rotation.y = Math.max(-0.52, Math.min(0.52, at.steer));
        }
        // The brake light, off the real brake rather than off a speed drop.
        if (rig.tail) rig.tail.material = at.brake > 0.15 ? kit.brakeMaterial : kit.tailMaterial;
        /**
         * The figure in the saddle is who the first-person camera is, so from
         * its own eyes it has to go — otherwise the view is the inside of a
         * skull with a helmet on it.
         *
         * All of it, not just the head. `addMesh` merges every part `seatedRider`
         * produced into one vertex-coloured geometry, which is the whole reason a
         * bike with ninety parts costs one draw call; keeping the hands on the
         * bars would mean splitting that build in two and paying a second draw
         * call on every vehicle in the fleet to buy a detail in one view of one
         * of them.
         */
        if (rig.rider) rig.rider.visible = !at.firstPerson;
        // The wheels turn with the ground they are on, not with the nose: a
        // machine sideways still covers ground, and spinning the tyres to the
        // nose speed stops them dead halfway through a slide.
        spin +=
          (Math.hypot(at.speed, at.speed * Math.tan(at.slip)) * Math.sign(at.speed) * at.delta) / spec.wheelRadius;
        rig.rearAxle.rotation.x = spin;
        rig.frontAxle.rotation.x = spin;
        forward.set(Math.sin(at.heading), 0, Math.cos(at.heading));
      },
      park: () => {
        taken.delete(id);
        rig.group.traverse((node) => node.layers.disable(COCKPIT_LAYER));
        if (rig.rider) rig.rider.visible = false;
        rig.group.rotation.x = 0;
        rig.group.rotation.z = PARK_LEAN;
        if (rig.steer) rig.steer.rotation.y = 0;
        if (rig.tail) rig.tail.material = kit.tailMaterial;
        applyLights();
      },
    };

    parked.push({
      id,
      noun: 'xe máy',
      // The rig's own vector, so it is never copied and never stale.
      position: rig.group.position,
      forward,
      deckHeight: SADDLE_HEIGHT,
      bounds: { across: spec.width / 2, along: spec.length / 2 },
      // The saddle, which on a machine is where the rider is the moment they are
      // on it — there is no walking aft to the oar.
      helmStation: { along: -0.18, across: 0 },
      machine,
    });
  }

  // --- queues, so each vehicle knows what is in front of it -----------------
  const queues: number[][] = [];
  const queueOf = new Map<string, number[]>();
  agents.forEach((agent, index) => {
    const key = `${agent.road}:${agent.dir}`;
    let queue = queueOf.get(key);
    if (!queue) {
      queue = [];
      queueOf.set(key, queue);
      queues.push(queue);
    }
    queue.push(index);
  });

  // --- the fleet as bodies something else can hit --------------------------
  /**
   * One `Impactor` per moving vehicle, rewritten in place at the end of every
   * tick and handed out by reference.
   *
   * Only the *moving* fleet is in it. A parked bike is not, and that is not an
   * oversight: the one the player is sitting on is a parked bike, there is
   * nothing on an `Impactor` to tell it apart from the other five, and a rider
   * resolved against the machine under them is pinned to the kerb for ever.
   */
  const bodies: Impactor[] = agents.map(() => createImpactor());
  /**
   * Whether the first tick has run. Before it has, every vehicle is still at the
   * origin with the default radius `createImpactor` gives it, and handing that
   * list out puts a phantom coach at the middle of the map.
   */
  let placed = false;

  /**
   * The player, as a body the fleet can see. Null until somebody goes for a
   * walk — `world-renderer.ts` makes the walker long after the fleet, and only
   * once the view goes down to the ground.
   *
   * Set rather than passed for that reason, and read through a getter for the
   * usual one: the walker rewrites its own body in place every frame.
   */
  let rider: (() => Impactor | null) | null = null;

  // --- per-frame scratch, hoisted: the tick allocates nothing ---------------
  const here: RoadSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, curvature: 0 };
  const ahead: RoadSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, curvature: 0 };

  let last = -1;
  let lit = 0;
  let wet = 0;
  let slow = 1;
  const update = (elapsed: number) => {
    if (agents.length === 0) return;
    const delta = last < 0 ? 0.016 : Math.min(0.1, Math.max(0, elapsed - last));
    last = elapsed;

    for (const queue of queues) {
      // Insertion sort on progress. The order barely changes between frames, so
      // this is linear in practice, and it never allocates.
      for (let i = 1; i < queue.length; i += 1) {
        const index = queue[i];
        const key = agents[index].distance * agents[index].dir;
        let j = i - 1;
        while (j >= 0 && agents[queue[j]].distance * agents[queue[j]].dir > key) {
          queue[j + 1] = queue[j];
          j -= 1;
        }
        queue[j + 1] = index;
      }

      for (let i = 0; i < queue.length; i += 1) {
        const agent = agents[queue[i]];
        const road = network.roads[agent.road];
        const spec = agent.spec;
        const look = Math.max(6, agent.speed * 1.6);

        network.sampleAt(agent.road, agent.distance, here);
        network.sampleAt(agent.road, agent.distance + agent.dir * look, ahead);

        // Slow for the bend. A corner is taken at the speed the grip allows, and
        // the whole character of a mountain road comes out of this one line.
        const bend = Math.abs(ahead.curvature) * 0.65 + Math.abs(here.curvature) * 0.35;
        let target = agent.cruise * slow;
        if (bend > 1e-4) target = Math.min(target, Math.sqrt(spec.grip / bend));

        // Right of travel is (−fz, fx), the same convention the road network uses
        // for its own lane offsets and kerbside furniture. Needed up here as well
        // as below now, because the gap to the player is measured in this frame.
        const fx = here.tx * agent.dir;
        const fz = here.tz * agent.dir;
        const atX = here.x - fz * agent.lane;
        const atZ = here.z + fx * agent.lane;

        if (queue.length > 1) {
          const leader = agents[queue[(i + 1) % queue.length]];
          let gap = (leader.distance - agent.distance) * agent.dir;
          if (gap < 0) gap += road.totalLength;
          gap -= (spec.length + leader.spec.length) / 2;
          const want = spec.gap + agent.speed * 0.9;
          if (gap < want) target = Math.min(target, Math.max(0, (gap / want) * target));
        }

        /**
         * And the player, who until now was not in this calculation at all.
         *
         * That is the other half of the user's report. `driving-collision.ts`
         * decides what a hit costs, but a coach that drives into somebody at
         * cruise was never going to brake, because an agent's target speed came
         * only off the bend and off the agent in front of it — and a bike stopped
         * in the lane is neither. So the same gap law the queue uses is applied
         * to the player: nose to tail, closing on the thing ahead, at the brake
         * the vehicle has.
         *
         * Measured in the agent's own frame rather than as a distance along the
         * centreline, which is the only form that answers the question. A player
         * is not on the queue: they can be stopped across the lane, cutting the
         * corner, or on the verge, and `distance` has nothing to say about any of
         * those. Six multiplies gives the metres in front and the metres to the
         * side, and the side is what decides whether it is in the way.
         *
         * It brakes and does not swerve, which is a decision and not a shortcut.
         * `agent.lane` is the lane this vehicle lives in, chosen once off
         * `road.laneOffset` with the sign of `dir`; moving it would put a 10.5 m
         * coach across a 5.5 m secondary road's centreline into oncoming traffic,
         * and the queue sorts purely on `distance`, so two agents at one distance
         * in two lanes would read as a vehicle to brake for rather than one being
         * passed. That is a traffic model. Braking is the reaction, and being
         * shoved aside by whatever does touch you is `collideDrive`'s half.
         */
        const body = rider?.();
        if (body) {
          const toX = body.x - atX;
          const toZ = body.z - atZ;
          const front = toX * fx + toZ * fz;
          const side = toX * -fz + toZ * fx;
          // Half the lane plus a body: inside this it is in the way, outside it
          // the vehicle goes past. `Impactor.radius` is the mean half-extent its
          // owner published, so a coach gives way to a coach's width of room.
          const across = spec.width / 2 + body.radius;
          if (front > 0 && Math.abs(side) < across) {
            const gap = front - (spec.length / 2 + body.radius);
            const want = spec.gap + agent.speed * 0.9;
            if (gap < want) target = Math.min(target, Math.max(0, (gap / want) * target));
          }
        }

        const was = agent.speed;
        if (target > agent.speed) agent.speed = Math.min(target, agent.speed + spec.accel * delta);
        else agent.speed = Math.max(0, Math.max(target, agent.speed - spec.brake * delta));

        const shedding = delta > 0 ? (was - agent.speed) / delta : 0;
        agent.braking += ((shedding > spec.brake * 0.18 ? 1 : 0) - agent.braking) * Math.min(1, delta * 9);

        agent.distance += agent.dir * agent.speed * delta;
        if (agent.distance > road.totalLength) agent.distance -= road.totalLength;
        if (agent.distance < 0) agent.distance += road.totalLength;

        // Against the sample this frame's decisions were made from, which is one
        // step behind where the integration has just put it: re-sampling here
        // would cost a second `sampleAt` per vehicle to move a 10 cm position.
        agent.group.position.set(atX, here.y + 0.012, atZ);
        agent.group.rotation.y = Math.atan2(fx, fz);
        agent.group.rotation.x = -Math.atan2((ahead.y - here.y) * agent.dir, look) + agent.braking * 0.022;

        const turn = here.curvature * agent.dir;
        const lean = Math.atan((agent.speed * agent.speed * turn) / GRAVITY) * spec.leanGain;
        agent.group.rotation.z = -Math.max(-0.55, Math.min(0.55, lean));

        if (agent.steer) {
          const wheelbase = spec.frontAxle - spec.rearAxle;
          agent.steer.rotation.y = Math.max(-0.52, Math.min(0.52, Math.atan(wheelbase * turn)));
        }

        agent.spin += (agent.speed * delta) / spec.wheelRadius;
        agent.rearAxle.rotation.x = agent.spin;
        agent.frontAxle.rotation.x = agent.spin;

        if (agent.swings.length > 0) {
          agent.crank += agent.speed * delta * 1.9;
          for (const swing of agent.swings) {
            swing.node.rotation.x = Math.sin(agent.crank + swing.phase) * 0.42 * swing.gain;
          }
        }

        if (agent.rider) {
          // The rider stays a little more upright than the machine, and the road
          // surface comes up through the seat.
          agent.rider.rotation.z = -agent.group.rotation.z * 0.22;
          agent.rider.position.y = Math.sin(elapsed * 7.3 + agent.bob) * 0.006 * Math.min(1, agent.speed / 6);
        }

        if (agent.tail) agent.tail.material = agent.braking > 0.4 ? kit.brakeMaterial : kit.tailMaterial;

        // And this vehicle as something that can be driven into. The velocity is
        // the lane's own direction, which is the honest one: an agent has no
        // slide, it is a position on a queue, so its nose and its travel are the
        // same vector by construction.
        const seen = bodies[queue[i]];
        seen.x = atX;
        seen.z = atZ;
        seen.vx = fx * agent.speed;
        seen.vz = fz * agent.speed;
        seen.mass = spec.mass;
        // The mean half-extent, which is `DriveTuning.radius`'s own definition —
        // a circle is wrong for a 10.5 m coach and right for everything else, and
        // `driving-collision.ts` takes the contact on the box regardless.
        seen.radius = (spec.length + spec.width) / 4;
      }
    }

    placed = true;
  };

  const applyLights = () => {
    // Daylight in heavy rain is dark enough that everyone has their lights on.
    const on = Math.max(lit, wet > 0.32 ? 0.65 : 0);
    kit.setLit(on);
    for (const agent of agents) {
      if (agent.glow) agent.glow.visible = on > 0.08;
    }
    // A bike on its stand has its ignition off; the one being ridden does not.
    for (const bike of parked) {
      const glow = glows.get(bike.id);
      if (glow) glow.visible = on > 0.08 && taken.has(bike.id);
    }
  };

  return {
    group,
    update,
    setNight: (amount) => {
      lit = Math.min(1, Math.max(0, amount));
      applyLights();
    },
    rideables: () => parked,
    setWeather: (weather) => {
      wet = weather.rainIntensity;
      // Nobody drives a wet mountain road at the speed they drive a dry one.
      slow = 1 - wet * 0.26;
      applyLights();
    },
    kit,
    traffic: () => (placed ? bodies : NONE),
    watch: (body) => {
      rider = body;
    },
    dispose: () => {
      kit.dispose();
      group.clear();
      bodies.length = 0;
      placed = false;
      rider = null;
      agents.length = 0;
      parked.length = 0;
      glows.clear();
      taken.clear();
      queues.length = 0;
      queueOf.clear();
    },
  };
};
