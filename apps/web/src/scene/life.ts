import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import { Group, Matrix4, Quaternion, Vector3 } from 'three';

import { createBirds, type Birds } from './birds';
import { BOAT_BEAM, BOAT_DRAUGHT, BOAT_LENGTH, BOAT_SOLE, BOAT_WATERLINE, createBoatKit, type Boat } from './boat';
import type { Mooring } from './dock';
import { createHuman, type Human, type HumanSource } from './human';
import { createPersonMeshes, createPersonParts, PERSON_HEIGHT } from './person';

const UP = new Vector3(0, 1, 0);

type Walker = { x: number; z: number; radius: number; speed: number; phase: number };

/** What the helm is asking for: both -1 to 1, ahead and to starboard positive. */
type Orders = { throttle: number; rudder: number };

type BoatState = {
  boat: Boat;
  x: number;
  z: number;
  heading: number;
  /** The cruise she picks for herself when nobody has the oar. */
  cruise: number;
  /** Live speed through the water, m/s. Integrated, never assigned from a clock. */
  way: number;
  bob: number;
  /** Made fast to the jetty: it rides the swell but never gets under way. */
  moored: boolean;
  /** Set while someone is aboard conning her; null means she steers herself. */
  orders: Orders | null;
  ride: Rideable;
};

export type LifeCounts = {
  people: number;
  boats: number;
  birds: number;
};

/** One frame of riding a machine, in world space. Reused, so nothing allocates. */
export type Ridden = {
  x: number;
  y: number;
  z: number;
  /** Radians about Y, the way `Object3D.rotation.y` reads it. */
  heading: number;
  speed: number;
  /** Rad/s the heading is turning, positive to the rider's left. */
  turn: number;
  /** Metres risen per metre travelled, under the wheels. */
  grade: number;
  delta: number;
};

/**
 * Something the rider drives themselves, as against a hull that carries them.
 *
 * The walker integrates the motion rather than the machine doing it, because the
 * walker is the only thing that knows what is under the wheels — the published
 * carriageway, a bridge deck, how steep the hillside has stood up, what is
 * solid — and that is one law already written. The machine states what it will
 * do and is told where it ended up.
 */
export type Machine = {
  /** m/s with the throttle open on the flat. */
  topSpeed: number;
  /** m/s backwards: a rider walking it off the kerb, not a reverse gear. */
  reverse: number;
  accel: number;
  brake: number;
  /** Lateral acceleration the tyres hold, m/s². With `topSpeed`, the circle. */
  grip: number;
  /** Rad/s cap at a crawl, where the rider's feet and not the tyres decide. */
  pivot: number;
  /** The steepest bare ground it will take, as `terrain.slopeAt` reads it. */
  climb: number;
  /** Metres of water it will ride through. */
  ford: number;
  /** Rider on, off its stand. */
  mount: () => void;
  /** Where it is, every frame somebody has it. */
  place: (at: Ridden) => void;
  /** Back on its stand, where it was left, with nobody on it. */
  park: () => void;
};

/**
 * What the walker needs in order to board something and then con it. Exactly one
 * of `steer` and `machine` is set: a hull is given orders and carries the rider,
 * a machine is driven by the rider and told where it went.
 */
export type Rideable = {
  id: string;
  /** What the prompt calls it: "thuyền", "xe máy". */
  noun: string;
  position: Vector3;
  /** Unit vector the hull points along, level — the bow, with no pitch in it. */
  forward: Vector3;
  /** Metres above the hull's origin that a standing passenger's feet sit. */
  deckHeight: number;
  /**
   * Half-extents of the hull, across and along, for reaching her from a jetty or
   * from the water. Not the walkable floor: you board over the gunwale, which is
   * the widest part of her and the part your hands actually land on.
   */
  bounds: { across: number; along: number };
  /** Where the helmsman stands, in the hull's frame: along the hull, across it. */
  helmStation: { along: number; across: number };
  /**
   * Hands her her orders, every frame somebody has the oar. `null` gives her
   * back, and she carries whatever way she had at the moment you let go — which
   * is what happens when you stop rowing.
   */
  steer?: (orders: Orders | null) => void;
  /** Set on something the rider drives; absent on a hull that carries them. */
  machine?: Machine;
};

export type Life = {
  group: Group;
  update: (elapsed: number) => void;
  setNight: (amount: number) => void;
  /** Live boat transforms, for boarding and for riding along. */
  rideables: () => Rideable[];
  dispose: () => void;
};

/**
 * Everything that moves. The scene was correct without it and still read as a
 * diorama nobody lived in.
 */
/** How many villagers get the rigged model. Each carries its own animation
 * mixer, so this is a budget rather than a count — the rest stay as the cheap
 * figures, which at a distance is all anyone can tell apart anyway. */
const RIGGED_VILLAGERS = 64;

/**
 * Boats are now built rather than instanced, so there are deliberately few of
 * them. A river with four working boats on it looks like a river; the same
 * river with twenty identical hulls looks like a car park.
 */
const MAX_BOATS = 5;

/**
 * Metres the hull heaves. The water is a geometrically flat plane — every wave on
 * it is shading — so this is not a boat riding a swell, it is the hull pumping up
 * and down out of nothing. At 0.22 m it pushed the floorboards back under the
 * surface that `BOAT_WATERLINE` had just lifted them out of; 0.05 m is a river
 * breathing.
 */
const HEAVE = 0.05;

/**
 * Metres of water a hull wants under her keel. One law, derived from the draught
 * she actually floats at rather than picked: it decides where a boat may be put,
 * where she may go, and where the helm is allowed to take her.
 *
 * It was two separate numbers — 0.6 m to spawn in and 2 m to move through — so a
 * boat could be placed somewhere she was forbidden to leave. 2 m was also a
 * stranger to the hull: at Tràng An, whose deepest water is 5.3 m, it left only
 * 23.8% of the wet area navigable; 0.85 m leaves 55.7% of it, and still half a
 * metre under a keel that draws 0.35.
 */
const UNDER_KEEL = BOAT_DRAUGHT + 0.5;
/** Metres of bed the helmsman reads ahead before putting the helm over. */
const BOAT_PROBE = 24;
/** Rad/s. About 23°/s, which at 3 m/s is an eight-metre turning circle. */
const BOAT_TURN_RATE = 0.4;
/** Fraction of way kept on while coming about — a sampan nearly stops to turn. */
const BOAT_CRAWL = 0.18;

/**
 * The oar, for whoever is holding it. A thuyền is not a launch: she is pulled by
 * one man against quadratic hull drag, which is why there is no top-speed clamp
 * anywhere below — `HELM_PULL / HELM_DRAG` is the top speed, by construction.
 *
 * Measured on this model: 0 to 2.47 m/s (95% of top) in 5.0 s over 8.9 m, and
 * with the oar out of the water she is still doing 1.3 m/s 2.7 s later.
 */
const HELM_TOP = 2.6;
const HELM_PULL = 0.95;
const HELM_DRAG = HELM_PULL / (HELM_TOP * HELM_TOP);
/** Backing water is a quarter of the work and gets 0.53 m/s out of her. */
const HELM_BACK = 0.04;
/**
 * Rad/s the stern oar sweeps her round when she is lying still — sculling her
 * head about, which is the one thing a rowed boat does that a car cannot. It
 * fades out as she gathers way and the hull's own lateral grip takes over.
 */
const HELM_PIVOT = 0.16;
/** Metres. Her steady turning circle with way on: 22 m, a length and a half. */
const HELM_RADIUS = 22;
/**
 * Where the helmsman stands: aft on the floorboards, to port of the boatman and
 * his oar, which is the only place on a sampan from which you would be conning
 * anything. The sole is 0.92 m to each side there, so 0.5 m off the centreline is
 * on the boards and not on the planking.
 */
const HELM_ALONG = -BOAT_LENGTH * 0.3;
const HELM_ACROSS = -0.5;

export const createLife = (
  terrain: Terrain,
  recipe: LocationRecipe,
  counts: LifeCounts,
  humanSource?: HumanSource,
  /** Where the houses are, so people stand where people would stand. */
  buildings: { x: number; z: number }[] = [],
  /** The jetty's berths, from `dock.moorings`. One boat lies in the best of them. */
  moorings: readonly Mooring[] = []
): Life => {
  const random = createPrng(`${recipe.seed}:life`);
  const group = new Group();
  group.name = 'life';

  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const half = terrain.size / 2;
  const townSpread = (recipe.town?.spread ?? 0.6) * half;

  // --- people -------------------------------------------------------------
  // Scattered uniformly over nine hundred metres, the villagers were technically
  // present and never once met. They now stand near the houses, which is both
  // where people are and where anyone walking the map will actually be.
  const walkers: Walker[] = [];
  for (let attempt = 0; attempt < counts.people * 40 && walkers.length < counts.people; attempt += 1) {
    const anchor = buildings.length > 0 ? buildings[Math.floor(random() * buildings.length)] : null;
    const x = anchor ? anchor.x + (random() * 2 - 1) * 55 : (random() * 2 - 1) * townSpread;
    const z = anchor ? anchor.z + (random() * 2 - 1) * 55 : (random() * 2 - 1) * townSpread;

    if (Math.abs(x) > half || Math.abs(z) > half) continue;
    if (terrain.heightAt(x, z) <= waterLevel + 1.5) continue;
    if (terrain.slopeAt(x, z) > 0.42) continue;

    walkers.push({ x, z, radius: 4 + random() * 14, speed: 0.12 + random() * 0.2, phase: random() * Math.PI * 2 });
  }

  // The nearest few dozen villagers are the rigged model; the rest keep the
  // stylised figure, because a hundred skinned meshes is a hundred mixers.
  const riggedCount = humanSource ? Math.min(RIGGED_VILLAGERS, walkers.length) : 0;
  const humans: Human[] = [];
  for (let i = 0; i < riggedCount; i += 1) {
    const human = createHuman(humanSource!, i % 2 === 0 ? '#5b6b7e' : '#7a6a58');
    human.play('walk');
    group.add(human.group);
    humans.push(human);
  }

  const parts = createPersonParts();
  const simpleCount = Math.max(0, walkers.length - riggedCount);
  const people = createPersonMeshes(parts, simpleCount, '#4a5a6e', '#d8c38a');
  if (simpleCount > 0) group.add(people.body, people.hat);

  // --- boats --------------------------------------------------------------
  const boatKit = recipe.water ? createBoatKit() : null;
  const boats: BoatState[] = [];

  /**
   * One `Rideable` per hull, built once and kept. It used to be rebuilt on every
   * call — a fresh object and a fresh Vector3 five times over, several times a
   * second, for a list of at most five boats that never changes — and nothing
   * could hold a handle on a boat across frames, which is exactly what taking the
   * helm needs.
   */
  const launch = (
    boat: Boat,
    x: number,
    z: number,
    heading: number,
    cruise: number,
    bob: number,
    moored: boolean
  ): BoatState => {
    const ride: Rideable = {
      id: `boat-${boats.length}`,
      noun: 'thuyền',
      // The group's own vector, so it is never copied and never stale.
      position: boat.group.position,
      forward: new Vector3(Math.cos(heading), 0, Math.sin(heading)),
      deckHeight: BOAT_SOLE,
      bounds: { across: BOAT_BEAM / 2, along: BOAT_LENGTH / 2 },
      helmStation: { along: HELM_ALONG, across: HELM_ACROSS },
      steer: () => {},
    };
    const state: BoatState = {
      boat,
      x,
      z,
      heading,
      cruise,
      way: moored ? 0 : cruise,
      bob,
      moored,
      orders: null,
      ride,
    };
    ride.steer = (orders) => {
      state.orders = orders;
      // Casting off takes a pull on the oar, not merely standing aboard: someone
      // who climbs into the boat at the jetty and does nothing is sitting in a
      // moored boat, which is a thing you would do. The first order she is given
      // takes her off the bollard, and she does not go back on it.
      if (orders && (orders.throttle !== 0 || orders.rudder !== 0)) state.moored = false;
    };
    return state;
  };
  if (recipe.water && boatKit) {
    const wanted = Math.min(MAX_BOATS, counts.boats);

    // One of them lies at the jetty and stays there. "Bến thuyền" is a place the
    // panel sends people to walk to, and the boats below knew only that they
    // were on water: measured from the berth, the nearest was 382 m away at
    // Tràng An, 628 m at Hồ Tây, 941 m at Hội An, and all of them under way.
    // So the landing was a name you could reach with nothing to board. This is
    // one of the four and not a fifth — more boats would only have raised the
    // odds, which is not the same as putting one where it belongs. The deepest
    // berth, because a hull wants the water the dock's own search found most of.
    const berth = moorings.reduce<Mooring | null>(
      (best, m) => (!best || terrain.heightAt(m.x, m.z) < terrain.heightAt(best.x, best.z) ? m : best),
      null
    );
    if (berth && wanted > 0) {
      const boat = boatKit.create(0);
      boat.setUnderway(false);
      group.add(boat.group);
      // `yaw` is ready for `rotation.y`; the render below works back from
      // `heading`, so this is the same angle expressed the way it is stored.
      boats.push(launch(boat, berth.x, berth.z, Math.PI / 2 - berth.yaw, 0, 0, true));
    }

    for (let attempt = 0; attempt < wanted * 120 && boats.length < wanted; attempt += 1) {
      const x = (random() * 2 - 1) * half * 0.8;
      const z = (random() * 2 - 1) * half * 0.8;
      // The same clearance she will be held to once she is moving, so a boat is
      // never put somewhere she is forbidden to leave. Three metres was a barge's
      // requirement and it left Tràng An — a karst waterway whose whole subject
      // is a rowing boat — with no boats at all: its deepest water is 5.30 m, and
      // only 23.8% of its wet area is more than two metres deep.
      if (terrain.heightAt(x, z) > waterLevel - UNDER_KEEL) continue;
      // Keep them apart: two boats in the same reach of river look like one
      // boat that failed to move.
      const spacing = Math.min(90, terrain.size * 0.025);
      if (boats.some((other) => Math.hypot(other.x - x, other.z - z) < spacing)) continue;

      const boat = boatKit.create(boats.length);
      group.add(boat.group);
      boats.push(launch(boat, x, z, random() * Math.PI * 2, 1.4 + random() * 1.8, random() * Math.PI * 2, false));
    }
  }

  const edge = half * 0.97;

  /**
   * Three probes along the heading, so a boat sees the bend before it is in it.
   * Steering on the water under the hull instead only turned the boat once it
   * was already aground.
   */
  const clearAhead = (x: number, z: number, heading: number) => {
    const forward = Math.cos(heading);
    const side = Math.sin(heading);
    for (let step = BOAT_PROBE * 0.35; step <= BOAT_PROBE + 0.001; step += BOAT_PROBE * 0.325) {
      const px = x + forward * step;
      const pz = z + side * step;
      if (Math.abs(px) > edge || Math.abs(pz) > edge) return false;
      if (terrain.heightAt(px, pz) > waterLevel - UNDER_KEEL) return false;
    }
    return true;
  };

  const birds: Birds | null = counts.birds > 0 ? createBirds(terrain, counts.birds, random) : null;
  if (birds) group.add(birds.group);

  const matrix = new Matrix4();
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3(1, 1, 1);

  let lastElapsed = 0;

  /**
   * Where a floating hull's origin goes. `BOAT_WATERLINE` is where the still
   * water falls inside the boat's own frame, so subtracting it is what puts her
   * on her marks — the origin used to be dropped straight on `waterLevel`, which
   * floated her on 1.25 m of draught and drew the river across her floorboards.
   */
  const floatY = (elapsed: number, phase: number) =>
    waterLevel - BOAT_WATERLINE + Math.sin(elapsed * 1.6 + phase) * HEAVE;

  const rides = boats.map((state) => state.ride);

  const update = (elapsed: number) => {
    const delta = Math.min(0.1, Math.max(0, elapsed - lastElapsed));
    lastElapsed = elapsed;
    for (const human of humans) human.update(delta);

    walkers.forEach((walker, index) => {
      const angle = walker.phase + elapsed * walker.speed;
      const x = walker.x + Math.cos(angle) * walker.radius;
      const z = walker.z + Math.sin(angle) * walker.radius;
      const y = terrain.heightAt(x, z);
      // Face along the loop, so the figures read as walking rather than sliding.
      const facing = -angle + Math.PI / 2;

      const human = humans[index];
      if (human) {
        human.group.position.set(x, y, z);
        human.group.rotation.y = facing;
        return;
      }

      position.set(x, y, z);
      quaternion.setFromAxisAngle(UP, facing);
      matrix.compose(position, quaternion, scale);
      people.body.setMatrixAt(index - riggedCount, matrix);
      people.hat.setMatrixAt(index - riggedCount, matrix);
    });
    if (simpleCount > 0) {
      people.body.instanceMatrix.needsUpdate = true;
      people.hat.instanceMatrix.needsUpdate = true;
    }

    // Position is integrated, not derived from `elapsed`. Offsetting the spawn
    // point by elapsed * speed grew without bound: every boat was outside a
    // 3600m map inside ten minutes, and the turn-back branch scaled the same
    // unbounded distance, so a boat that met a bank jumped kilometres in a frame.
    for (const state of boats) {
      const orders = state.orders;

      if (state.moored) {
        // Everything below is getting under way, which is the one thing a boat
        // made fast to a bollard does not do. It still heaves on the swell and
        // its boatman still works his oar against the jetty, so it reads as a
        // boat waiting rather than a prop — and the berth has a boat in it, which
        // is the whole point of putting it here. Until someone takes her out:
        // after that the berth stays empty, because a boat you rowed away is gone.
        state.boat.update(elapsed, 0);
        state.boat.group.position.set(state.x, floatY(elapsed, 0), state.z);
        state.boat.group.rotation.y = -state.heading + Math.PI / 2;
        continue;
      }

      const clear = clearAhead(state.x, state.z, state.heading);

      if (orders) {
        // Quadratic drag, because that is the drag a hull has and because it is
        // what sets the top speed without a clamp. She answers slowly in both
        // directions, which is the whole character of a rowed boat: there is no
        // throttle to let go of, only an oar to stop pulling on.
        const thrust = orders.throttle * (orders.throttle > 0 ? HELM_PULL : HELM_BACK);
        state.way += (thrust - HELM_DRAG * state.way * Math.abs(state.way)) * delta;
        // The bank is the hull's law and the helm gets no vote on it: the same
        // probe the boats that steer themselves use, and the same clearance. Put
        // her bow at the mud and she comes down to a crawl short of it instead of
        // climbing it. Only her way ahead is capped — the probe only looks ahead,
        // and backing out of a dead end has to stay possible.
        if (!clear) state.way = Math.min(state.way, HELM_TOP * BOAT_CRAWL);
        // Sculling her round where she lies, fading into a wide sweep as the
        // water starts to hold her. Signed by the way she has on, because a boat
        // going astern answers her helm the other way.
        const held = Math.min(1, Math.abs(state.way) / HELM_TOP);
        state.heading += orders.rudder * (HELM_PIVOT * (1 - held) + state.way / HELM_RADIUS) * delta;
      } else {
        // A slow weave rather than a straight line.
        let turn = Math.sin(elapsed * 0.07 + state.bob) * 0.35;

        if (!clear) {
          // Feel for open water either side and put the helm over that way. With
          // both banks close the boat comes about, which is what a sampan does at
          // the head of a reach; `bob` picks the side so it always picks the same one.
          const left = clearAhead(state.x, state.z, state.heading - 0.7);
          const right = clearAhead(state.x, state.z, state.heading + 0.7);
          turn = left === right ? (state.bob > Math.PI ? -1 : 1) : left ? -1 : 1;
        }

        state.heading += Math.max(-1, Math.min(1, turn)) * BOAT_TURN_RATE * delta;
        // Eased back to her own cruise rather than snapped to it, so a boat the
        // player has just let go of carries her way instead of jumping to it.
        const wanted = state.cruise * (clear ? 1 : BOAT_CRAWL);
        state.way += (wanted - state.way) * (1 - Math.exp(-delta * 0.6));
      }

      const advance = state.way * delta;
      const x = state.x + Math.cos(state.heading) * advance;
      const z = state.z + Math.sin(state.heading) * advance;
      if (Math.abs(x) < edge && Math.abs(z) < edge && terrain.heightAt(x, z) < waterLevel - UNDER_KEEL) {
        state.x = x;
        state.z = z;
      } else if (orders) {
        // She has touched. Way off rather than a bounce, and the helm still
        // answers, so backing water gets her off again.
        state.way = 0;
      }

      const way = Math.min(1, Math.abs(state.way) / HELM_TOP);
      state.boat.setUnderway(state.way > 0.4);
      state.boat.update(elapsed, way);
      state.boat.group.position.set(state.x, floatY(elapsed, state.bob), state.z);
      state.boat.group.rotation.y = -state.heading + Math.PI / 2;
      state.ride.forward.set(Math.cos(state.heading), 0, Math.sin(state.heading));
    }

    birds?.update(elapsed);
  };

  update(0);

  return {
    group,
    update,
    setNight: (amount) => {
      for (const state of boats) state.boat.setNight(amount);
    },
    rideables: () => rides,
    dispose: () => {
      for (const human of humans) human.dispose();
      for (const state of boats) state.boat.dispose();
      boatKit?.dispose();
      birds?.dispose();
      parts.dispose();
      people.dispose();
    },
  };
};

export { PERSON_HEIGHT };
