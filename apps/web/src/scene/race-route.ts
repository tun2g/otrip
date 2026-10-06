import type { RoadNetwork, RoadSample } from './road-network';

/**
 * A route round the ordinary roads: where it goes, where it is checked, and
 * where the field lines up.
 *
 * There is no circuit built anywhere in this app and there must not be one. The
 * roads are a function of the seed, the destinations are places people open to
 * breathe in, and a grandstand on the Tà Xùa ridge would be a worse thing than
 * no race at all. So this lays a route on the carriageway the destination
 * already has, and the only thing it puts on the ground is the handful of cones
 * somebody would carry out for an afternoon — see `race-markers.ts`.
 *
 * ## Why a lap is out and back
 *
 * `road-network` publishes each road as an **open** polyline. `sampleAt` wraps
 * its distance modulo the length, which is what lets the NPC fleet drive for
 * ever, but the two ends of a road are kilometres apart — at the seam a vehicle
 * is silently teleported across the map. Nobody has noticed because nobody
 * watches one agent for four kilometres; a field crossing a start line would
 * notice at once.
 *
 * So a lap runs out to a far point and back. That is what a race on a village
 * road is anyway, and it puts the one place positions really change — the
 * turn — in the middle of the lap rather than nowhere.
 */

/** Metres between checkpoints. Close enough on a 7 m carriageway that the
 *  course cannot be cut, far enough that a lap is not a slalom. */
const CHECK_SPACING = 180;
const MIN_CHECKS = 4;
const MAX_CHECKS = 10;

/**
 * The leg the planner aims for, and the least it will accept.
 *
 * 800 m out and back is a 1.6 km lap, about ninety seconds at the ridden bike's
 * pace — long enough to have corners that matter, short enough that three laps
 * is a race and not an afternoon. The floor exists because a destination may
 * have no road that long: Hội An's old quarter is laid out in lanes, and a 200 m
 * leg there is still a race while a refusal is not.
 */
const LEG_TARGET = 800;
const MIN_LEG = 200;

/** Metres of road kept behind the line for the grid, and clear beyond the turn
 *  so the hairpin is driven rather than run out of road. */
const GRID_RUN = 34;
const TURN_RUN = 25;

/** Starting slots. The room holds eight, so the grid does. */
const GRID_SLOTS = 8;
/** Metres between rows and either side of the centreline. A Wave is 1.95 m long
 *  and 0.72 m wide, so this is a real two-abreast grid and not a traffic jam. */
const GRID_ROW = 3.4;
const GRID_COLUMN = 0.95;

/**
 * How far either side of the centreline a checkpoint counts as passed, over the
 * carriageway's own half-width.
 *
 * Generous on purpose. The alternative to a wide gate is a racer who put two
 * wheels on the verge being told their lap did not happen, which is the least
 * forgivable thing this could do.
 */
const CHECK_MARGIN = 2.5;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Which way round the lap a checkpoint is passed. */
export type RaceLeg = 'out' | 'back';

/**
 * One crossing a lap requires, in the order it is required.
 *
 * `nx, nz` is the direction a racer must be travelling through it — a checkpoint
 * is a one-way plane, which is the whole of what stops a lap being driven by
 * reversing over the line. Two of these share each station: one outbound, one
 * inbound.
 */
export type Checkpoint = {
  index: number;
  /** Which station this is, so the markers and the list can be matched up. */
  station: number;
  leg: RaceLeg;
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
  /** The line itself, perpendicular to `n`. */
  ax: number;
  az: number;
  halfWidth: number;
};

/** A point on the route, shared by the outbound and inbound checkpoint there. */
export type Station = {
  x: number;
  y: number;
  z: number;
  /** Unit tangent of the carriageway, pointing outbound. */
  tx: number;
  tz: number;
  halfWidth: number;
};

/** Where one racer starts. Two abreast, staggered back from the line. */
export type GridSlot = { x: number; y: number; z: number; heading: number };

export type RaceRoute = {
  roadIndex: number;
  /** Distance along the road of the line and of the turn. */
  startAt: number;
  turnAt: number;
  legLength: number;
  lapLength: number;
  /** The stations, centreline order from the line out to the turn. */
  stations: Station[];
  /** Every crossing one lap requires, in order. `checks.length` is a lap. */
  checks: Checkpoint[];
  grid: GridSlot[];
  /** Facing on the line, radians about Y the way `rotation.y` reads it. */
  heading: number;
};

/**
 * The longest road worth driving fast on, preferring a made surface.
 *
 * Sealed first because `walker.ridable` reads the published deck rather than the
 * hillside under it, so a carriageway is drivable wherever it goes while bare
 * ground is only as drivable as it is steep. Width is in the score because a
 * 0.95 m trail is a race between one person and themselves, and overtaking needs
 * somewhere to go. A trail still wins where it is all there is — Tà Xùa is a
 * ridge, and refusing there would mean the feature does not exist at one of the
 * four destinations.
 */
const pickRoad = (network: RoadNetwork): number => {
  let best = -1;
  let bestScore = -Infinity;

  for (const road of network.roads) {
    const surface = road.kind === 'main' ? 3 : road.kind === 'secondary' ? 2.4 : road.kind === 'lane' ? 1.4 : 0.5;
    const score = road.totalLength * surface;
    if (score <= bestScore) continue;
    bestScore = score;
    best = road.index;
  }

  return best;
};

/**
 * Distance along a road of the point nearest a world position.
 *
 * A scan over the published centreline rather than a search: it is x, y, z
 * triples at 7 m spacing, so a four-kilometre road is 570 of them and this runs
 * once per destination.
 */
const nearestAlong = (points: Float32Array, x: number, z: number): { at: number; gap: number } => {
  const count = Math.floor(points.length / 3);
  let at = 0;
  let gap = Infinity;
  let walked = 0;

  for (let index = 0; index < count; index += 1) {
    const px = points[index * 3];
    const pz = points[index * 3 + 2];
    if (index > 0) walked += Math.hypot(px - points[(index - 1) * 3], pz - points[(index - 1) * 3 + 2]);
    const distance = Math.hypot(px - x, pz - z);
    if (distance >= gap) continue;
    gap = distance;
    at = walked;
  }

  return { at, gap };
};

/**
 * Lays a route on the network, or returns null where no road is long enough to
 * hold a grid, a leg and a turn.
 *
 * The line is pulled onto the stretch of road nearest a parking spot when there
 * is one within reach, because that is where the bikes are and walking to the
 * grid should not be a hike. Failing that the span is centred on the road, which
 * is the part of it furthest from both ends.
 */
export const planRoute = (network: RoadNetwork): RaceRoute | null => {
  const roadIndex = pickRoad(network);
  if (roadIndex < 0) return null;

  const road = network.roads[roadIndex];
  const usable = road.totalLength - GRID_RUN - TURN_RUN;
  if (usable < MIN_LEG) return null;

  const legLength = Math.min(LEG_TARGET, usable);
  const here: RoadSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, curvature: 0 };

  let startAt = (road.totalLength - legLength) / 2;
  let nearestSpot: { at: number; gap: number } | null = null;
  for (const spot of network.parking) {
    const found = nearestAlong(road.points, spot.x, spot.z);
    // Further than this and the spot belongs to a different road.
    if (found.gap > 90) continue;
    if (nearestSpot && found.gap >= nearestSpot.gap) continue;
    nearestSpot = found;
  }
  if (nearestSpot) startAt = nearestSpot.at;

  // Both ends have to fit, and the grid has to fit behind the line.
  startAt = clamp(startAt, GRID_RUN, road.totalLength - legLength - TURN_RUN);
  const turnAt = startAt + legLength;

  const stationCount = clamp(Math.round(legLength / CHECK_SPACING) + 1, MIN_CHECKS, MAX_CHECKS);
  const halfWidth = road.width / 2 + CHECK_MARGIN;

  const stations: Station[] = [];
  for (let index = 0; index < stationCount; index += 1) {
    network.sampleAt(roadIndex, startAt + (legLength * index) / (stationCount - 1), here);
    stations.push({ x: here.x, y: here.y, z: here.z, tx: here.tx, tz: here.tz, halfWidth });
  }

  /**
   * A lap, as crossings.
   *
   * Outbound from station 1 — nobody crosses the line going out, they are
   * sitting behind it — to the turn, then back down the same stations to station
   * 0, which is the lap line. The ordering is what makes the turn compulsory: a
   * racer who stops short of it has no inbound checkpoint armed and cannot
   * complete the lap however far they drive.
   */
  const checks: Checkpoint[] = [];
  const addCheck = (station: number, leg: RaceLeg) => {
    const at = stations[station];
    const sign = leg === 'out' ? 1 : -1;
    checks.push({
      index: checks.length,
      station,
      leg,
      x: at.x,
      y: at.y,
      z: at.z,
      nx: at.tx * sign,
      nz: at.tz * sign,
      ax: -at.tz * sign,
      az: at.tx * sign,
      halfWidth: at.halfWidth,
    });
  };
  for (let station = 1; station < stationCount; station += 1) addCheck(station, 'out');
  for (let station = stationCount - 2; station >= 0; station -= 1) addCheck(station, 'back');

  const grid: GridSlot[] = [];
  for (let slot = 0; slot < GRID_SLOTS; slot += 1) {
    const row = Math.floor(slot / 2);
    const side = slot % 2 === 0 ? -1 : 1;
    // Back from the line, so pole is nearest it, and the right-hand column is
    // staggered by part of a row so the two do not share a bumper.
    const at = Math.max(0, startAt - 4 - row * GRID_ROW - (side > 0 ? GRID_ROW * 0.4 : 0));
    network.sampleAt(roadIndex, at, here);
    // Right of travel is (−tz, tx), the convention `road-network` uses for its
    // own lane offsets and kerbside furniture.
    grid.push({
      x: here.x - here.tz * GRID_COLUMN * side,
      y: here.y,
      z: here.z + here.tx * GRID_COLUMN * side,
      heading: Math.atan2(here.tx, here.tz),
    });
  }

  network.sampleAt(roadIndex, startAt, here);

  return {
    roadIndex,
    startAt,
    turnAt,
    legLength,
    lapLength: legLength * 2,
    stations,
    checks,
    grid,
    heading: Math.atan2(here.tx, here.tz),
  };
};
