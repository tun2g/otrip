/**
 * The line as ground: what a body meets when it walks into the railway.
 *
 * Three questions, and they are the same question asked from three sides. Where
 * does the formation stand high enough to be walked *on* — the crest, the
 * bridge timbers — and how wide is that surface? Where does it stand high enough
 * to be walked *into* — the ballast shoulder and the batter below it? And where
 * does a carriageway cross it, which is the one place both answers have to be
 * suspended, because a road that stops at a railway is not a road.
 *
 * ## The bug this was split out for
 *
 * The player's report was "chưa đi lên được đường ray, chưa xử lí va chạm với xe
 * lửa" — cannot get up onto the track, nothing happens when the train comes —
 * with a screenshot of a carriageway running into the formation on a raised bank
 * and carrying on, untouched, on the far side.
 *
 * Measured at Hồ Tây, the only one of the four destinations whose recipe carries
 * a line, by `probe/railway-crossing.ts`: the 4.59 km alignment meets a
 * carriageway in **three** places, and not one of them had a crossing. The one
 * level crossing the module built was anchored on the town centroid — which at
 * Hồ Tây is the middle of the lake — and set at a random skew, so it was a road
 * deck, two sets of gates and a pair of flashing lamps laid across the formation
 * where no road has ever been.
 *
 * Worse than the missing crossing was what happened at the three real ones. The
 * embankment published no obstacle below 1.2 m of fill, and all three
 * intersections are on 0.35 m of fill or in cutting — so the body was not stopped
 * by the bank at all. It walked **through** the ballast, under the rails, with
 * the crest 0.62 m and 0.77 m over its head: the ledge in the screenshot was
 * solid to the eye and empty to the feet. "Cannot get up onto the track" was
 * exactly right, and so was its opposite.
 */
import type { Obstacle } from './obstacle-index';
import {
  BALLAST_CROWN_HALF,
  BALLAST_DEPTH,
  CESS,
  FILL_SLOPE,
  RAIL_ABOVE_FORMATION,
  RAIL_HEIGHT,
  SLEEPER_LENGTH,
  VIADUCT_FILL,
  type Alignment,
  type Structure,
} from './railway-alignment';
import { deckChain, type RoadKind } from './road-network';
import type { Platform } from './walker';

/**
 * `walker.ts`'s `STEP_UP`, which is not imported because importing it would make
 * this module depend on the walker's whole surface for one number, and because
 * what it means here is narrower than what it means there: it is the height at
 * which the formation stops being a kerb and becomes a bank. The walker's own
 * value is 0.4, and `probe/railway-crossing.ts` asserts the two still agree.
 */
export const FORMATION_STEP = 0.4;

/**
 * How far the sleeper tops have to stand over the ground before they are
 * published as a surface. A noise floor, not a lip: the ballast is a made surface
 * wherever there is any of it, and a threshold at the walker's step height left
 * 310 m of the Hồ Tây line unpublished where the formation is on shallow fill and
 * the crest clears the ground by less than 35 cm — measured down to 2 cm. Walking
 * those, the body stood on the original ground with the sleepers around its
 * shins.
 *
 * The 859 m still left out is every one of it in cutting, measured: the ground
 * sits at or above the crest there, and `floorAt` taking the higher of the two
 * makes the ground the floor whether a span is published or not.
 */
const SURFACE_GAP = 0.04;

/** Stations of line carried past each end of a raised run. Ten metres. */
const DECK_APPROACH = 2;

/**
 * The ballast toe: how far from the centreline the made surface reaches before
 * the batter starts. `buildTrackGeometries` draws the crown to
 * `BALLAST_CROWN_HALF` at shoulder level and slopes it out to this at formation
 * level, so it is the narrowest the earthwork ever is and therefore the floor
 * under every obstacle radius below.
 */
const BALLAST_TOE = BALLAST_CROWN_HALF + FILL_SLOPE * BALLAST_DEPTH;

/**
 * Stations between obstacle cylinders along the formation.
 *
 * One, meaning every 5 m, and that is the measurement that fixed the walk
 * through the bank. It used to be every 12 m of chainage against a radius of
 * `BALLAST_CROWN_HALF + FILL_SLOPE * fill * 0.5` — 2.40 m at the 1.2 m fill where
 * the chain started. Two circles 10 m apart with a 2.40 m radius and a 0.45 m
 * shoulder leave 4.3 m of clear ground between them, so the embankment was a
 * picket fence with a gap four times the width of a body in every panel of it.
 *
 * At 5 m the narrowest cylinder the chain can carry is `BALLAST_TOE`, 2.17 m, and
 * the body is tested at 2.62 m: two of those 5 m apart overlap by 0.25 m and
 * nothing fits through. That is the whole arithmetic, and it is why this is
 * stated in stations rather than in metres — it has to stay tied to the radius.
 */
const OBSTACLE_STRIDE = 1;

/**
 * Preferred grade of the road ramp at a level crossing. 8% is steep for a
 * carriageway and ordinary for the last ten metres of one going over a railway;
 * the hump is a thing you can see from down the road, which is the point.
 */
const CROSSING_GRADE = 0.08;

/**
 * The steepest a ramp may get before the crossing is refused, and the longest
 * one may run.
 *
 * 17% is one in six, which is a village lane humping over the rails and is the
 * steepest thing on this map that is still a road. 26 m is as far as the
 * approach may reach before it stops being an approach and becomes an earthwork
 * of its own. Together they cap the rise at 4.42 m: above that the line is on
 * real embankment, a real railway carries the road over or under it on a bridge,
 * and neither of those is modelled — so the crossing is refused and reported
 * rather than faked. Measured at Hồ Tây, the deepest of the three intersections
 * needs 0.77 m, so nothing on any shipped destination comes near the ceiling.
 */
const CROSSING_GRADE_MAX = 0.17;
const CROSSING_RUN_MAX = 26;

/**
 * Half the level part of the crossing deck, measured along the road, before the
 * obliquity of the crossing is taken into account: the ballast crown plus its
 * drainage cess, which is the width of made ground the road has to be carried
 * flat across.
 */
const CROSSING_DECK_HALF = BALLAST_CROWN_HALF + CESS;

/** Sampling along the road while the ramp profile is laid out. */
const RAMP_STEP = 2;

/**
 * The least of the crossing's obliquity that is ever divided by. A road meeting
 * the line at 5° crosses 25 m of formation, and `1 / sin 5°` would ask for a
 * 290 m deck; refusing the crossing outright is the honest answer, and that is
 * what a skew below this produces, because the run then exceeds
 * `CROSSING_RUN_MAX`. It also keeps the division finite for a road laid exactly
 * along the line, which is a tangency rather than a crossing.
 */
const MIN_SKEW_SIN = 0.15;

/** The slice of `Road` a crossing needs. Structural, so a probe can pass its own. */
export type RoadLine = {
  index: number;
  kind: RoadKind;
  width: number;
  totalLength: number;
  /** x, y, z triples along the centreline. `y` is the carriageway surface. */
  points: Float32Array | number[];
};

/**
 * Where the line and a carriageway cross, and what that place is.
 *
 * `kind` is the whole of the decision. `level` is a crossing: the road is carried
 * up over the formation and both of them are at the same height for a few metres.
 * `under` is the line on a truss and the road passing beneath it, which needs
 * nothing built — the piers are already obstacles and the soffit is already over
 * a walker's head. `over` is the line in cutting and the road passing above it on
 * the original ground, which also needs nothing: the crest is below the ground
 * there, so there is no bank to climb and no span to stand on. `blocked` is an
 * intersection a level crossing cannot be built at, and is a defect — it is
 * carried on the type rather than dropped so that a probe can count them.
 */
export type RailCrossing = {
  /** Chainage along the alignment, metres. */
  chainage: number;
  /** Distance along the road's centreline, metres. */
  roadDistance: number;
  x: number;
  z: number;
  /** Bearing from +Z of the line and of the road at the intersection. */
  railHeading: number;
  roadHeading: number;
  /** The acute angle between them. A square crossing is π/2. */
  skew: number;
  road: RoadLine;
  structure: Structure;
  /** Formation height over the original ground, metres. Negative in cutting. */
  fill: number;
  /** Top of the sleepers, which is what the road is brought up to. */
  crest: number;
  /** The carriageway's own surface at the intersection. */
  roadSurface: number;
  kind: 'level' | 'under' | 'over' | 'blocked';
  /** Metres of ramp each side of the deck. 0 for anything but a `level` crossing. */
  run: number;
  /** Half the deck along the road, the obliquity already divided in. */
  deckHalf: number;
};

const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

/**
 * How near two hits on the same road have to be before they are one place. A
 * road meeting the line at a shallow angle can cut it three times inside fifty
 * metres, and that is one crossing with three gates and three ramps otherwise.
 */
const MERGE_REACH = 40;

/**
 * Where the alignment and the road centrelines actually cross, segment against
 * segment, both polylines read exactly as they are drawn.
 *
 * Found geometrically and not by asking either module where it thinks it put a
 * crossing, because the thing being fixed is precisely that the one crossing in
 * the file was put where no road was.
 */
export const findRailCrossings = (alignment: Alignment, roads: readonly RoadLine[]): RailCrossing[] => {
  const found: RailCrossing[] = [];

  for (const road of roads) {
    const samples = Math.floor(road.points.length / 3);
    if (samples < 2) continue;
    const spacing = road.totalLength / Math.max(1, samples - 1);

    for (let r = 0; r + 1 < samples; r += 1) {
      const ax = road.points[r * 3];
      const az = road.points[r * 3 + 2];
      const rx = road.points[(r + 1) * 3] - ax;
      const rz = road.points[(r + 1) * 3 + 2] - az;

      for (let i = 0; i + 1 < alignment.count; i += 1) {
        const cx = alignment.x[i];
        const cz = alignment.z[i];
        const sx = alignment.x[i + 1] - cx;
        const sz = alignment.z[i + 1] - cz;
        const denominator = rx * sz - rz * sx;
        if (Math.abs(denominator) < 1e-9) continue;
        const t = ((cx - ax) * sz - (cz - az) * sx) / denominator;
        const u = ((cx - ax) * rz - (cz - az) * rx) / denominator;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;

        const chainage = (i + u) * alignment.step;
        const roadDistance = (r + t) * spacing;
        // Against every hit this road has already made, not only the last one.
        // The hits are found road segment by road segment, so their chainages do
        // not come out in order and a third crossing between two near ones would
        // have let the pair through.
        if (found.some((kept) => kept.road === road && Math.abs(chainage - kept.chainage) < MERGE_REACH)) continue;

        const station = Math.min(alignment.count - 1, Math.round(chainage / alignment.step));
        const railHeading = Math.atan2(sx, sz);
        const roadHeading = Math.atan2(rx, rz);
        const fill = alignment.y[station] - RAIL_ABOVE_FORMATION - alignment.ground[station];
        const crest = alignment.y[station] - RAIL_HEIGHT;
        const roadSurface = road.points[r * 3 + 1] + (road.points[(r + 1) * 3 + 1] - road.points[r * 3 + 1]) * t;

        const crossing: RailCrossing = {
          chainage,
          roadDistance,
          x: ax + rx * t,
          z: az + rz * t,
          railHeading,
          roadHeading,
          skew: Math.abs(wrapAngle(roadHeading - railHeading)),
          road,
          structure: alignment.structure[station],
          fill,
          crest,
          roadSurface,
          kind: 'level',
          run: 0,
          deckHalf: 0,
        };
        // The acute angle, so a road crossing from the other side is not reported
        // as 137° one way and 43° the other.
        if (crossing.skew > Math.PI / 2) crossing.skew = Math.PI - crossing.skew;

        decideCrossing(crossing);
        found.push(crossing);
      }
    }
  }

  found.sort((a, b) => a.chainage - b.chainage);
  return found;
};

/**
 * What the line does to the road here, and how long the ramp is if the answer is
 * a level crossing.
 *
 * The rise is taken to the *crest* and not to the rail head, because the crest is
 * the surface a wheel and a foot land on: the road deck at a crossing is carried
 * up between and outside the rails with the flangeways left open, which is what
 * `railway.ts` already draws.
 */
const decideCrossing = (crossing: RailCrossing): void => {
  if (crossing.structure === 'bridge') {
    crossing.kind = 'under';
    return;
  }
  const rise = crossing.crest - crossing.roadSurface;
  if (rise <= 0) {
    // The line is in cutting, or the road is itself carried over it on fill. Both
    // leave the carriageway above the crest with nothing to climb and no bank to
    // meet, and neither has an overbridge to draw, so nothing is built.
    crossing.kind = 'over';
    return;
  }
  crossing.deckHalf = Math.max(3, CROSSING_DECK_HALF / Math.max(MIN_SKEW_SIN, Math.sin(crossing.skew)));
  if (rise <= FORMATION_STEP) {
    // The formation stands less than a kerb over the carriageway and the step on
    // and off it is one a body and a machine both already take. The deck and the
    // gates are still built; no ramp is, because there is nothing to climb.
    crossing.kind = 'level';
    return;
  }

  const run = rise / CROSSING_GRADE;
  if (run > CROSSING_RUN_MAX && rise / CROSSING_RUN_MAX > CROSSING_GRADE_MAX) {
    crossing.kind = 'blocked';
    return;
  }
  crossing.kind = 'level';
  crossing.run = Math.min(run, CROSSING_RUN_MAX);
};

/**
 * How far each side of the intersection the crossing reaches: the level deck over
 * the formation plus the ramp off each end of it, held inside the road's own two
 * ends.
 *
 * Symmetric, and clamped to the shorter side rather than cut off on one. Without
 * the clamp, `crossingPointAt` saturates past the end of a road and both the span
 * chain and the asphalt ribbon are handed a run of coincident points, which
 * `deckChain` turns into a zero-length rectangle with an arbitrary axis — a
 * walkable span pointing nowhere. A crossing that close to the end of a road has
 * a short ramp, which is honest: there is no road left to lay one on.
 */
export const crossingReach = (crossing: RailCrossing): number =>
  Math.min(crossing.deckHalf + crossing.run, crossing.roadDistance, crossing.road.totalLength - crossing.roadDistance);

/**
 * A point on the crossing's road surface, `offset` metres along the road from the
 * intersection. Signed, so -reach to +reach walks the whole crossing.
 *
 * The one place the crossing's shape is decided. `crossingSpans` turns it into
 * walkable rectangles and `railway.ts` sweeps the asphalt ribbon along the same
 * samples, so the surface a foot lands on and the surface a player sees are the
 * same surface by construction rather than by two files agreeing.
 *
 * The height is the higher of the ramp profile and the carriageway's own. That is
 * what makes the approach continuous at both ends: past the point the ramp has
 * come back down to the road, the road is the answer and there is no step onto
 * anything — which is exactly what `Platform.grade`'s own note asks a ramp to do.
 */
export type CrossingPoint = { x: number; y: number; z: number };

export const crossingPointAt = (crossing: RailCrossing, offset: number, out: CrossingPoint): CrossingPoint => {
  const road = crossing.road;
  const samples = Math.floor(road.points.length / 3);
  const spacing = road.totalLength / Math.max(1, samples - 1);
  const grid = Math.max(0, Math.min(road.totalLength, crossing.roadDistance + offset)) / spacing;
  const i = Math.max(0, Math.min(samples - 2, Math.floor(grid)));
  const f = grid - i;
  const lerp = (component: number) =>
    road.points[i * 3 + component] + (road.points[(i + 1) * 3 + component] - road.points[i * 3 + component]) * f;

  const descent = Math.max(0, Math.abs(offset) - crossing.deckHalf);
  const fall = crossing.run > 0 ? (descent / crossing.run) * (crossing.crest - crossing.roadSurface) : 0;
  out.x = lerp(0);
  out.y = Math.max(lerp(1), crossing.crest - fall);
  out.z = lerp(2);
  return out;
};

/**
 * The road carried over the formation, as walkable spans along the road's own
 * axis.
 *
 * A polyline rather than one box for the reason `RoadNetwork.decks` gives: a
 * crossing on a bend described by a single rectangle hangs off the carriageway at
 * its ends and falls short of it in the middle.
 */
const crossingSpans = (crossing: RailCrossing, out: Platform[]): void => {
  if (crossing.kind !== 'level') return;
  const reach = crossingReach(crossing);
  const point: CrossingPoint = { x: 0, y: 0, z: 0 };
  const points: number[] = [];
  for (let offset = -reach; offset <= reach + 1e-6; offset += RAMP_STEP) {
    crossingPointAt(crossing, offset, point);
    points.push(point.x, point.y, point.z);
  }
  if (points.length < 6) return;
  deckChain(points, crossing.road.width / 2, out);
};

export type RailFormation = {
  /**
   * The formation where it stands clear of the ground, as walkable spans, plus
   * the road ramps at every level crossing.
   *
   * The crest is published at the width of the ballast crown and a bridge at the
   * width of its timbers, which used to be one number — `SLEEPER_LENGTH / 2`,
   * 0.9 m — for both. On a truss that is right and deliberate: stepping off the
   * timbers is stepping off the bridge. On an embankment it is not the same
   * situation at all, because stepping off the crest puts a body on the batter,
   * and a 1.8 m walkway along a 3 m bank is a knife edge the ground either side
   * of it does not justify.
   */
  decks: Platform[];
  /**
   * The ballast shoulder and the batter under it, as cylinders, wherever the
   * crest stands more than a step above the original ground — so the bank is a
   * wall from the side and a floor from on top, which is the whole trick
   * `gatherContacts` makes possible by ignoring a solid whose top is within a
   * step of the foot.
   *
   * Nothing is suppressed at a level crossing, and that is the measurement that
   * matters here rather than an omission.
   *
   * It was: a window of `width / 2 / sin(skew)` of chainage each side of the
   * intersection, with no cylinder inside it. That leaves a hole, and the hole is
   * wider than the road — the kept cylinders at the window's edge reach only
   * `radius + shoulder` back into it, so at the 43° crossing at Hồ Tây the open
   * corridor measured 9.2 m of line against an 8.1 m carriageway and a body 4.3 m
   * off the centreline walked straight through the bank beside the ramp.
   *
   * Nothing needs suppressing, because `gatherContacts` already does it, from the
   * one fact that makes this whole file work: a solid whose top is within
   * `STEP_UP` of the foot is ignored. A body coming up the ramp meets the first
   * cylinder that reaches the carriageway at `(radius + shoulder) / sin(skew)`
   * along the road, by which point the ramp has carried it to within
   * `(that - deckHalf) * CROSSING_GRADE` of the crest — 5 cm at the Hồ Tây
   * crossings — and the bank is no longer there as far as its feet are concerned.
   * A body at ground level a metre and a half outside the carriageway is still at
   * ground level and the same cylinder is still a wall.
   *
   * The arithmetic holds while `deckHalf + STEP_UP / CROSSING_GRADE` exceeds
   * `(radius + shoulder) / sin(skew)`, which it does for any crossing squarer
   * than about 20° at any fill `CROSSING_RUN_MAX` permits. Below that the ramp's
   * lower half would be walled and the crossing would stop short of the rails; no
   * alignment on any shipped destination comes near it, and the probe is where it
   * would show.
   */
  obstacles: Obstacle[];
};

/**
 * Turns a surveyed alignment into ground: what can be stood on, what cannot be
 * walked through, and the holes the crossings cut in the second of those.
 *
 * Deterministic and total — no prng, no frame, nothing but the alignment and the
 * crossings — which is what lets `probe/railway-crossing.ts` call it twice, once
 * with the crossings and once with none, and measure the difference.
 */
export const buildRailFormation = (alignment: Alignment, crossings: readonly RailCrossing[]): RailFormation => {
  const decks: Platform[] = [];
  const obstacles: Obstacle[] = [];

  /** Top of the sleepers, which is what a foot lands on — bridge timber or not. */
  const crestOf = (i: number) => alignment.y[i] - RAIL_HEIGHT;
  const standsOn = (i: number) => crestOf(i) - alignment.ground[i] > SURFACE_GAP;

  // --- somewhere to walk ---------------------------------------------------
  // Walking the line is how people here actually get along a valley, and from
  // the crest is the only way onto the bridges: the flanks of an embankment are
  // walls, so the way up is along the formation from where it meets the ground,
  // or over a level crossing.
  //
  // Runs are broken where the structure changes between bridge and earthwork as
  // well as where the formation meets the ground, because the two carry different
  // widths and one span cannot be both.
  const deckPoints: number[] = [];
  let runStart = -1;
  const closeRun = (end: number) => {
    if (runStart < 0) return;
    const bridged = alignment.structure[runStart] === 'bridge';
    // A run is already maximal in how far it stands clear, so carrying it two
    // stations further each way lands it under the ground rather than on it —
    // except across a structure change, where the next run picks it up.
    const head = Math.max(0, runStart - (bridged ? 0 : DECK_APPROACH));
    const tail = Math.min(alignment.count - 1, end + (bridged ? 0 : DECK_APPROACH));
    deckPoints.length = 0;
    for (let at = head; at <= tail; at += 1) deckPoints.push(alignment.x[at], crestOf(at), alignment.z[at]);
    // Sleeper width on a truss and the ballast crown on an earthwork. The 0.9 m
    // on a bridge is deliberately narrower than the 2.4 m timbers actually laid
    // there, and stays: stepping off the sleepers on a bridge is stepping off the
    // bridge, and a span as wide as the timbers would let a body stand in the air
    // outside the trusses.
    deckChain(deckPoints, bridged ? SLEEPER_LENGTH / 2 : BALLAST_CROWN_HALF, decks);
    runStart = -1;
  };
  for (let i = 0; i <= alignment.count; i += 1) {
    const raised = i < alignment.count && standsOn(i);
    const bridged = raised && alignment.structure[i] === 'bridge';
    if (raised && runStart >= 0 && bridged !== (alignment.structure[runStart] === 'bridge')) closeRun(i - 1);
    if (raised) {
      if (runStart < 0) runStart = i;
      continue;
    }
    closeRun(i - 1);
  }

  for (const crossing of crossings) crossingSpans(crossing, decks);

  // --- what cannot be walked through ---------------------------------------
  for (let i = 0; i < alignment.count; i += OBSTACLE_STRIDE) {
    const fill = alignment.y[i] - RAIL_ABOVE_FORMATION - alignment.ground[i];
    const crest = crestOf(i);
    // The step, not the fill. A formation on 0.35 m of fill still carries its
    // crest 0.96 m over the ground, because the ballast and the sleepers are
    // 0.61 m of made surface in their own right — and 0.96 m is the ledge the
    // player photographed and then walked straight through.
    if (crest - alignment.ground[i] <= FORMATION_STEP) continue;
    // A bridge is piers and a deck. The piers are obstacles of their own, and a
    // cylinder from the bed to the parapet on top of them would both shove
    // anyone off the deck they are standing on and wall a swimmer out of the
    // whole river underneath it.
    if (alignment.structure[i] === 'bridge') continue;

    obstacles.push({
      x: alignment.x[i],
      z: alignment.z[i],
      // The ballast toe at the least, widening with the batter. Taken at half the
      // fill because the cylinder has one radius for the whole height of the bank
      // and the batter is only that wide at its foot; the toe is the floor,
      // because the made surface is that wide whatever the fill is doing.
      radius: BALLAST_TOE + FILL_SLOPE * Math.min(Math.max(0, fill), VIADUCT_FILL) * 0.5,
      bottom: alignment.ground[i],
      // The crest, not the rails above it: `gatherContacts` ignores anything
      // whose top is within a step of the foot, so publishing the walking
      // surface makes an embankment a wall from the side and a floor from on
      // top. Carrying it 0.4 m higher made it a wall from both.
      top: crest,
    });
  }

  return { decks, obstacles };
};
