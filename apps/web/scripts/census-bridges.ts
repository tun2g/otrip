/**
 * Walkable spans, audited. `road-network.ts` and `railway.ts` now hand out
 * `decks: Platform[]` and `world-renderer.ts` passes them to the walker, and the
 * user's report on that wiring was "chưa đi lên cầu được" — they could not get
 * onto a bridge. So this asks three questions of the real `walker.ts`, not of a
 * reimplementation of it:
 *
 *  1. Do the spans exist at all, and do they join up into chains?
 *  2. Can a body on the ground reach a chain's end — is the lip inside STEP_UP?
 *  3. Does the surface a walker stands on rise continuously along the chain,
 *     with no step bigger than one frame of walking could climb?
 *
 * The walker's own `floorAt` is not exported, so it is read where it is written
 * without easing: `teleport()` sets `position.y = floorAt(x, z, +∞)` and nothing
 * else touches it. The crossing test on top of that drives the actual update
 * loop with a joystick, because reaching a deck is gated on STEP_UP against the
 * previous foot height and a teleport deliberately has no previous height.
 */
import { PerspectiveCamera } from 'three';

import type { Terrain } from '@otrip/world';

import type { Platform } from '../src/scene/walker.ts';

/** `walker.ts`'s own figure. Kept here as the gate this audit tests against. */
export const STEP_UP = 0.4;

/** Metres between surface samples: one 60 Hz frame at walking pace. */
const SAMPLE_STEP = 1.4 / 60;
/**
 * How much of a step counts as a jump rather than a slope. Two centimetres on a
 * 2.3 cm sample is most of a sheer riser, and legitimate rise is allowed for
 * separately out of the span's own grade and the ground's measured slope.
 */
const JUMP_TOLERANCE = 0.02;
/** Two spans belong to one chain when one's far end is this near the next's near end. */
const JOIN_REACH = 2;
/** …and agrees with it about its height to this. */
const JOIN_RISE = 0.5;
/** …and does not turn more than this, in radians, to get there. */
const JOIN_TURN = Math.PI / 3;
/** How high above the ground a crossing has to get before it counts as being on the deck. */
const ON_DECK = 0.35;

const end = (span: Platform, sign: 1 | -1) => ({
  x: span.x + sign * Math.sin(span.yaw) * span.halfLength,
  z: span.z + sign * Math.cos(span.yaw) * span.halfLength,
  y: span.surfaceY + sign * (span.grade ?? 0) * span.halfLength,
});

/**
 * The flat `decks` array back into the chains `deckChain` laid down. Entries
 * arrive in polyline order per bridged run, so a chain breaks exactly where one
 * span's far end stops meeting the next one's near end.
 */
export const chainsOf = (spans: Platform[]): Platform[][] => {
  const chains: Platform[][] = [];
  let current: Platform[] = [];

  for (const span of spans) {
    if (current.length > 0) {
      const last = current[current.length - 1];
      const previous = end(last, 1);
      const next = end(span, -1);
      // Position alone is not enough. A railway that crosses the water twice can
      // put the end of one bridge within two metres of the start of another, and
      // joining those two gave a single "chain" whose centreline jumped the
      // ground between them — which then read as a walker 170 m off the line.
      const turn = Math.abs(Math.atan2(Math.sin(span.yaw - last.yaw), Math.cos(span.yaw - last.yaw)));
      if (
        Math.hypot(previous.x - next.x, previous.z - next.z) > JOIN_REACH ||
        Math.abs(previous.y - next.y) > JOIN_RISE ||
        turn > JOIN_TURN
      ) {
        chains.push(current);
        current = [];
      }
    }
    current.push(span);
  }
  if (current.length > 0) chains.push(current);
  return chains;
};

export type ChainAudit = {
  spans: number;
  /** Plan length of the chain, metres. */
  length: number;
  /** Highest the deck gets above the ground beneath it. */
  clearance: number;
  /** The gap a body on the ground has to climb at each end of the chain. */
  lip: number;
  lipStart: number;
  lipEnd: number;
  /**
   * Metres of the chain where the deck is within one step of the ground, i.e.
   * where a body walking the ground can actually get onto it. Zero means the deck
   * exists and cannot be reached from anywhere along its length.
   */
  mountable: number;
  /** How far along the chain the easiest way on is. */
  mountAt: number;
  /** Steps in the deck's own profile, between one sample and the next. */
  jumps: number;
  worstJump: number;
  worstJumpAt: number;
  /** True when a walker driven along the chain actually ended up on the deck. */
  crossed: boolean;
  /** Highest the crossing walker's feet got above the ground. */
  crossedClearance: number;
  /** How far along the centreline the walker got, as a fraction of the chain. */
  crossedFraction: number;
  /** Share of the crossing frames the walker spent standing clear of the ground. */
  onDeck: number;
  /** Furthest the walker was pushed off the centreline it was steered along. */
  drift: number;
};

/** Enough of `Walker` to probe a surface with, so the audit does not import the whole shape. */
type Probe = {
  position: { x: number; y: number; z: number };
  teleport: (x: number, z: number) => void;
  setJoystick: (input: { x: number; y: number } | null) => void;
  update: (delta: number, camera: PerspectiveCamera) => void;
  dispose: () => void;
};

/** Builds a walker standing at `(x, z)` facing `yaw`, with these spans under it. */
export type MakeProbe = (x: number, z: number, yaw: number, spans: Platform[]) => Probe;

const polylineOf = (chain: Platform[]) => {
  const points = [end(chain[0], -1)];
  for (const span of chain) points.push(end(span, 1));
  return points;
};

type Leg = { x: number; z: number; length: number; grade: number };

/**
 * A point against the centreline: how far along it the nearest point is, and how
 * far off to the side the walker is. Projected onto the segments rather than
 * measured to the vertices — the vertices are five to seven metres apart, so
 * nearest-vertex distance reported a body walking the middle of the deck as four
 * metres off it, and progress in seven-metre steps.
 */
const against = (legs: Leg[], points: { x: number; z: number }[], atX: number, atZ: number) => {
  let along = 0;
  let best = { along: 0, lateral: Number.POSITIVE_INFINITY };

  for (let i = 0; i < legs.length; i += 1) {
    const dx = atX - points[i].x;
    const dz = atZ - points[i].z;
    const forward = Math.min(legs[i].length, Math.max(0, dx * legs[i].x + dz * legs[i].z));
    const lateral = Math.abs(dx * legs[i].z - dz * legs[i].x);
    // Clamped to the segment, so the perpendicular distance only counts where the
    // foot of it actually lands on the segment; past the end it is the corner.
    const offX = atX - (points[i].x + legs[i].x * forward);
    const offZ = atZ - (points[i].z + legs[i].z * forward);
    const gap = forward > 0 && forward < legs[i].length ? lateral : Math.hypot(offX, offZ);
    if (gap < best.lateral) best = { along: along + forward, lateral: gap };
    along += legs[i].length;
  }

  return best;
};

/**
 * Walks the chain's centreline one frame-length at a time and reads the surface
 * the walker would stand on, then drives a real crossing from eight metres back
 * on the approach.
 */
export const auditChain = (terrain: Terrain, chain: Platform[], spans: Platform[], probe: MakeProbe): ChainAudit => {
  const vertices = polylineOf(chain);
  // Built in step with the legs, and the spans kept beside them: dropping a
  // degenerate leg out of one array and not the others left `legs[i]` describing
  // a different stretch of bridge than `points[i]` and `chain[i]` did.
  const points: { x: number; z: number }[] = [];
  const legs: Leg[] = [];
  const owners: Platform[] = [];
  let length = 0;
  for (let i = 0; i < vertices.length - 1; i += 1) {
    const dx = vertices[i + 1].x - vertices[i].x;
    const dz = vertices[i + 1].z - vertices[i].z;
    const run = Math.hypot(dx, dz);
    if (run < 1e-4) continue;
    points.push(vertices[i]);
    legs.push({ x: dx / run, z: dz / run, length: run, grade: chain[i].grade ?? 0 });
    owners.push(chain[i]);
    length += run;
  }
  points.push(vertices[vertices.length - 1]);

  const audit: ChainAudit = {
    spans: chain.length,
    length,
    clearance: 0,
    lip: Number.POSITIVE_INFINITY,
    lipStart: 0,
    lipEnd: 0,
    mountable: 0,
    mountAt: 0,
    jumps: 0,
    worstJump: 0,
    worstJumpAt: 0,
    crossed: false,
    crossedClearance: 0,
    crossedFraction: 0,
    onDeck: 0,
    drift: 0,
  };

  // --- the lip at either end -------------------------------------------------
  // Reported separately. A chain is meant to run past where its surface meets the
  // ground at both ends, and one end being flush while the other is three metres
  // up is the difference between a bridge you walk onto and one you cannot — the
  // minimum of the two hid exactly that.
  {
    const head = end(chain[0], -1);
    const tail = end(chain[chain.length - 1], 1);
    audit.lipStart = head.y - terrain.heightAt(head.x, head.z);
    audit.lipEnd = tail.y - terrain.heightAt(tail.x, tail.z);
    audit.lip = Math.min(audit.lipStart, audit.lipEnd);
  }

  // --- the deck's own profile ------------------------------------------------
  // Read off the span the sample belongs to, not out of `floorAt`. `floorAt`
  // returns the highest span over a point and a hairpin bridge passes over
  // itself, so sampling it reported a two-metre step where the walker will never
  // see one — the reference argument is what keeps the upper ramp overhead.
  //
  // What is left is the deck's real profile, and a step in that is a step the
  // walker does feel: it is what `surfaceY + grade * along` hands back.
  let travelled = 0;
  let previous = Number.NaN;
  let leg = 0;
  let along = 0;
  let lowestStep = Number.POSITIVE_INFINITY;

  while (leg < legs.length) {
    const point = {
      x: points[leg].x + legs[leg].x * along,
      z: points[leg].z + legs[leg].z * along,
    };
    // `halfLength` carries an overlap pad, so `along` is measured from the span's
    // centre rather than from the leg's start.
    const surface = owners[leg].surfaceY + (owners[leg].grade ?? 0) * (along - legs[leg].length / 2);
    const ground = terrain.heightAt(point.x, point.z);
    audit.clearance = Math.max(audit.clearance, surface - ground);

    // Where a body on the ground can step on. `floorAt` takes a span only while it
    // is within STEP_UP of the foot it already has, so this is the whole of the
    // answer to "can you get onto the bridge": if it is nowhere, you cannot.
    const step = surface - ground;
    if (step <= STEP_UP) {
      audit.mountable += SAMPLE_STEP;
      if (step < lowestStep) {
        lowestStep = step;
        audit.mountAt = travelled;
      }
    }

    if (Number.isFinite(previous)) {
      // Allowed rise is the span's own grade. The ground does not come into it:
      // this is the deck's profile, and the deck is not draped over anything.
      const allowed = Math.abs(legs[leg].grade) * SAMPLE_STEP;
      const jump = Math.abs(surface - previous) - allowed;
      if (jump > JUMP_TOLERANCE) {
        audit.jumps += 1;
        if (jump > audit.worstJump) {
          audit.worstJump = jump;
          audit.worstJumpAt = travelled;
        }
      }
    }
    previous = surface;

    along += SAMPLE_STEP;
    travelled += SAMPLE_STEP;
    while (leg < legs.length && along > legs[leg].length) {
      along -= legs[leg].length;
      leg += 1;
    }
  }

  // --- the crossing ----------------------------------------------------------
  // Started on the ground short of the deck and steered along it, because the
  // question is whether the body gets up onto the thing, and that is decided by
  // STEP_UP against the previous frame's foot height — which a teleport, having
  // no previous height, deliberately skips.
  //
  // Steered, not pointed: a bridge is a curve, and a walker held on one heading
  // leaves the deck within a span or two and then reports that it could not get
  // on. The whole span list goes under this one, as the app passes it.
  // Started at the easiest way on rather than always at the head of the chain:
  // where one end sits three metres up and the other is flush, starting at the
  // high end measures the walker failing to climb a wall, which is a fact about
  // the chain's ends and is already reported as the lip.
  const approach = 8;
  // Walked towards whichever end has more bridge in front of it. A chain whose
  // only way on is at its far end is crossed backwards, which is a real crossing;
  // walking forwards off the end of it measured nothing.
  const way = audit.mountAt > length / 2 ? -1 : 1;
  let mountLeg = 0;
  let mountAlong = audit.mountable > 0 ? audit.mountAt : 0;
  while (mountLeg < legs.length - 1 && mountAlong > legs[mountLeg].length) {
    mountAlong -= legs[mountLeg].length;
    mountLeg += 1;
  }
  const from = legs[mountLeg];
  const startX = points[mountLeg].x + from.x * (mountAlong - approach * way);
  const startZ = points[mountLeg].z + from.z * (mountAlong - approach * way);
  const heading = Math.atan2(from.x * way, from.z * way);
  const walker = probe(startX, startZ, heading, spans);
  // `createWalker` scatters the spawn by ±4.5 m with an unseeded `Math.random()`
  // (walker.ts:691), which on a three-metre deck is the difference between
  // standing on the approach and standing in the river beside it. Three identical
  // runs of this audit put the body 1.3 m apart in height and disagreed about
  // whether the bridge could be mounted at all, so the start is pinned.
  walker.teleport(startX, startZ);
  const camera = new PerspectiveCamera(60, 1, 2, 4000);

  // The walker's heading comes from the camera, which nothing here moves, so the
  // stick is resolved into the fixed camera frame instead. With `forward` on yaw0
  // and `right` a quarter turn from it, an input of (sin(yaw0 - h), cos(yaw0 - h))
  // walks along world heading `h`.
  const steer = (towards: number) =>
    walker.setJoystick({ x: Math.sin(heading - towards), y: Math.cos(heading - towards) });

  /**
   * Where to aim: the point on the centreline four metres further along than the
   * body's own projection onto it. Far enough not to chase the nearest point and
   * oscillate, near enough to follow a bend.
   */
  const LOOKAHEAD = 4;
  const atAlong = (distance: number) => {
    let wanted = Math.min(Math.max(distance, 0), length);
    for (let i = 0; i < legs.length; i += 1) {
      if (wanted <= legs[i].length) {
        return { x: points[i].x + legs[i].x * wanted, z: points[i].z + legs[i].z * wanted };
      }
      wanted -= legs[i].length;
    }
    return points[points.length - 1];
  };

  // Generous: the gait ramps from standing, and the body is slowed by water,
  // grade and anything it has to walk round on the way.
  const finish = way > 0 ? length : 0;
  const ahead = Math.max(1, Math.abs(finish - audit.mountAt));
  const frames = Math.ceil(((approach + ahead) / 0.7) * 60);
  let covered = 0;
  let onDeck = 0;
  let counted = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    // Nothing more to learn once the far abutment is under it.
    if (covered >= ahead - 2) break;
    const where = against(legs, points, walker.position.x, walker.position.z);
    const target = atAlong(where.along + LOOKAHEAD * way);
    steer(Math.atan2(target.x - walker.position.x, target.z - walker.position.z));
    walker.update(1 / 60, camera);

    const clearance = walker.position.y - terrain.heightAt(walker.position.x, walker.position.z);
    if (clearance > audit.crossedClearance) audit.crossedClearance = clearance;
    if (clearance > ON_DECK) audit.crossed = true;

    // Progress along the centreline, not displacement from the start: a chain
    // that doubles back would otherwise read as going nowhere. The lateral error
    // beside it is how far something pushed the body off the line it was steered
    // along — a trunk under the viaduct, a pier, a parapet.
    const now = against(legs, points, walker.position.x, walker.position.z);
    const gone = (now.along - audit.mountAt) * way;
    if (gone > covered) covered = gone;

    // Only counted once the body is over the chain proper, so the eight metres of
    // ground it starts on, and the approach that is meant to be on the ground,
    // are not charged against the deck.
    if (gone > 2 && gone < ahead - 2) {
      counted += 1;
      if (clearance > ON_DECK) onDeck += 1;
      if (now.lateral > audit.drift) audit.drift = now.lateral;
    }
  }
  // Of the chain still ahead of the mount point, not of the whole chain: a way on
  // halfway along is not a failure to walk the half behind it.
  audit.crossedFraction = Math.min(1, Math.max(0, covered) / ahead);
  audit.onDeck = counted > 0 ? onDeck / counted : 0;
  walker.dispose();

  return audit;
};
