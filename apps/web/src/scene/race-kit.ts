import type { Terrain } from '@otrip/world';
import type { BufferGeometry } from 'three';

import { createPersonParts, PERSON_HEIGHT } from './person';
import type { RaceRoute, Station } from './race-route';
import { box, mergeParts, tube, type Part } from './road-network';

/**
 * The kit itself: what is carried out of the van, and where it stands.
 * `race-markers.ts` owns what it then does during a race — split because this
 * half runs once and is all measurement (kerbs, cambers, fill, the width of a
 * Honda Wave) while that half runs every frame and is all state.
 *
 * `sampleAt` returns the centreline at **kerb** height and `road-network`'s
 * surface mesh crowns it at `y + camber`, so anything laid at the sample's own
 * `y` is buried along the middle of the road; what rests on the carriageway is
 * lifted by the camber profile instead — see `CAMBER_MAX`. The two poles on the
 * verge are planted on `terrain.heightAt` and lengthened to reach over the road,
 * because one road is draped within centimetres of the ground along part of its
 * length and carried on metres of fill along the rest.
 */

/** Crown of the camber on a main road, from `road-network`'s own `CAMBER`. The
 *  markers are handed a route, not a network, so they cannot know the road's kind
 *  and so cannot know its camber — a secondary carries 0.8 of this, a lane 0.5, a
 *  trail none. Clearing the worst case can only float a cone, never bury one, and
 *  the float is nil at the kerb, which is where the cones stand. */
const CAMBER_MAX = 0.07;

/** Mirrors `CHECK_MARGIN` in `race-route.ts`, which is not exported.
 *  `Station.halfWidth` is the checkpoint gate — the carriageway's half-width plus
 *  that margin, generous so a racer on the verge is not told their lap did not
 *  happen — and the cones stand at the kerb rather than 2.5 m out in the grass,
 *  so the margin has to come back off. Delete this the moment a station carries
 *  the carriageway's own half-width. */
const GATE_MARGIN = 2.5;

/** A 500 mm road cone, the kind stacked in the back of every van. */
const CONE_HEIGHT = 0.52;
const CONE_RADIUS = 0.17;
/** Metres of clear road the cone row must leave between its inner pair. A Honda
 *  Wave is 0.72 m over the bars (`vehicles.ts`), so this is two of them: the row
 *  marks where the road is checked, it does not close it, and the NPC fleet still
 *  drives this carriageway while a race is on. */
const MIN_GATE = 1.6;
const CONE_INSET = 0.28;
/** Spacing of the second cone on each side, where the road is wide enough. */
const CONE_PAIR = 0.85;

/**
 * How far inside the kerb the posts and the marshal stand.
 *
 * Measured at all four destinations the ground beside the chosen road is not at
 * the road's level, and at Tà Xùa it cannot be: the carriageway is cut into the
 * ridge, so 0.7 m out the ground stands 1.3 m above it on the uphill side and
 * 3.3 m below on the downhill side, and no offset walks out of that. A post up a
 * bank carries its tape 2.2 m over the road while its opposite number carries it
 * at 1.15 — a tape hanging in mid-air beside a post. So these three stand on the
 * carriageway edge, where the height is known exactly from the camber and is the
 * same on both sides, which is where a person puts them anyway: beside the cones,
 * which are already on the road.
 */
const KERB_INSET = 0.12;

/** Offsets past the kerb the two length-compensated poles will consider, and what
 *  walking a metre out is worth against a metre of height error. These two can
 *  stand anywhere, because `plant` lengthens them to put their tips at a fixed
 *  height over the carriageway wherever the foot ended up. The ladder starts past
 *  `road-network`'s 0.6 m shoulder: the shoulder mesh is above the raw terrain it
 *  spreads over, so a pole planted on that terrain would stand in it. */
const VERGE_LADDER = [0.7, 1.1, 1.6, 2.2, 3];
const VERGE_REACH = 0.15;
/** Metres the marshal stands behind the line: the shortest setback that clears
 *  the post beside them (body 0.52 m, post 0.065 m). */
const MARSHAL_BACK = 1.6;

const POST_TOP = 1.45;
/** Ribbon height under the post top, so it crosses at chest height. */
const RIBBON_DROP = 0.3;

/** Tip heights over the carriageway. The turn is driven at down the whole leg, so
 *  it stands highest of anything here. */
const TURN_TIP = 4.2;
const FLAG_TIP = 3.2;

const CONE_BODY = '#e2561f';
const CONE_BAND = '#f4efe4';
const CONE_BASE = '#2a2724';
const POST = '#d8d2c6';
const RIBBON = '#c0342a';
const RIBBON_HEM = '#f0d98a';
const SHIRT = '#b8503c';
const HAT = '#d9c899';
const POLE = '#6b5a44';
const MAST = '#cdc6b7';
const FLAG = '#ffd23f';
const FLAG_HEM = '#241f1a';
const TURN_CLOTH = '#ff9f1c';
/** Side of the pennant glyph `race-markers.ts` grows with range. */
export const GLYPH = 64;
/** A pennant on a stick, dark-edged so it holds against a bright sky and a dark
 *  hillside alike without being bright itself. */
export const paintPennant = (canvas: HTMLCanvasElement) => {
  const context = canvas.getContext('2d');
  if (!context) return;

  const ink = 'rgba(11, 16, 32, 0.8)';
  context.clearRect(0, 0, GLYPH, GLYPH);
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(18, 8);
  context.lineTo(54, 20);
  context.lineTo(18, 32);
  context.closePath();
  context.lineWidth = 7;
  context.strokeStyle = ink;
  context.stroke();
  context.fillStyle = FLAG;
  context.fill();
  // The staff, drawn twice: a wide dark stroke, then a narrow pale one over it,
  // which is an outline for the price of one more stroke.
  context.beginPath();
  context.moveTo(16, 6);
  context.lineTo(16, 58);
  context.lineWidth = 8;
  context.strokeStyle = ink;
  context.stroke();
  context.lineWidth = 3;
  context.strokeStyle = MAST;
  context.stroke();
};

type Vec = [number, number, number];
/** Where something stands: its foot, and its length from there. */
export type Plant = { x: number; y: number; z: number; length: number };

export type RaceKit = {
  /** Cones, both line posts, the turn mast and the marshal as one vertex-coloured
   *  geometry: one draw call for the whole course, whatever the station count. */
  stand: BufferGeometry | null;
  /** The tape, origin at the post it is tied to, running along +X. */
  ribbon: BufferGeometry | null;
  /** The marshal's flag, origin at the shoulder, staff along +X. */
  starter: BufferGeometry | null;
  /** A unit-height flag mast, origin at its foot, so one mesh scaled in Y stands
   *  at any station without rebuilding geometry. */
  mast: BufferGeometry | null;
  /** The flag, origin at the mast tip, cloth hanging along +X. */
  cloth: BufferGeometry | null;
  ribbonAt: { x: number; y: number; z: number; yaw: number };
  /** The marshal's shoulder, and the way they face. */
  marshalAt: { x: number; y: number; z: number; yaw: number };
  /** The turn mast's foot, for its beam. */
  turnAt: { x: number; y: number; z: number };
  /** The flag's plant at each station, in station order, and each station's yaw. */
  flagsAt: Plant[];
  yaws: number[];
};

const yawOf = (station: Station) => Math.atan2(station.tx, station.tz);
// Right of travel is (−tz, tx), the convention `road-network` uses for its own
// lane offsets and kerbside furniture.
const acrossX = (station: Station, across: number) => station.x - station.tz * across;
const acrossZ = (station: Station, across: number) => station.z + station.tx * across;

export const buildRaceKit = (route: RaceRoute, terrain: Terrain): RaceKit => {
  const stations = route.stations;
  const line = stations[0];
  const turn = stations[stations.length - 1];
  const carriageHalf = Math.max(0.45, line.halfWidth - GATE_MARGIN);
  // Measured, all four destinations pick a 7 m main road, so the row sits inside
  // the kerb at 3.22 m. The gate wins where it cannot: on a 0.95 m trail the kerb
  // is 0.48 m out, and cones inset from that would shut the only road on a ridge,
  // so there the row steps onto the verge instead.
  const coneOut = Math.max(carriageHalf - CONE_INSET, MIN_GATE / 2 + CONE_RADIUS);
  const vergeFrom = Math.max(coneOut + 0.5 - carriageHalf, 0);

  /** What a thing `across` metres right of the centreline rests on: the camber
   *  profile while it is over the carriageway, the hillside once past the kerb. */
  const restY = (station: Station, across: number) => {
    const out = Math.abs(across);
    if (out > carriageHalf) return terrain.heightAt(acrossX(station, across), acrossZ(station, across));
    return station.y + CAMBER_MAX * (1 - out / carriageHalf);
  };

  /** Where to plant something `extra` metres out from the kerb, and how long it
   *  has to be: the offset whose ground comes nearest the road's own level, with
   *  nearer the road winning ties, and a length that closes whatever gap is left
   *  so the tip is at `tip` over the carriageway either way. */
  const plant = (station: Station, side: number, extra: number, tip: number): Plant => {
    let best: Plant = { x: station.x, y: station.y, z: station.z, length: tip };
    let bestCost = Infinity;
    for (const out of VERGE_LADDER) {
      const across = (carriageHalf + vergeFrom + extra + out) * side;
      const x = acrossX(station, across);
      const z = acrossZ(station, across);
      const y = terrain.heightAt(x, z);
      const cost = Math.abs(y - station.y) + out * VERGE_REACH;
      if (cost >= bestCost) continue;
      bestCost = cost;
      best = { x, z, y, length: Math.max(1.2, station.y + tip - y) };
    }
    return best;
  };

  const parts: Part[] = [];
  const rows = coneOut - CONE_PAIR >= MIN_GATE / 2 + CONE_RADIUS ? [coneOut, coneOut - CONE_PAIR] : [coneOut];
  const row = rows.flatMap((out) => [out, -out]);

  for (const station of stations) {
    for (const across of row) {
      const x = acrossX(station, across);
      const z = acrossZ(station, across);
      const y = restY(station, across);
      parts.push(
        box([0.34, 0.035, 0.34], [x, y + 0.018, z], CONE_BASE),
        tube([0.03, CONE_RADIUS], CONE_HEIGHT, [x, y + CONE_HEIGHT / 2, z], CONE_BODY, undefined, 6),
        // A band of reflective tape, a shade proud of the cone under it.
        tube([0.088, 0.1], 0.1, [x, y + 0.3, z], CONE_BAND, undefined, 6)
      );
    }
  }

  /** A post set on the carriageway edge: a known surface height, and the same one
   *  on both sides, so the tape crosses square and level. */
  const atKerb = (station: Station, side: number, back: number) => {
    const across = (carriageHalf - KERB_INSET) * side;
    const atX = acrossX(station, across);
    const atZ = acrossZ(station, across);
    const x = atX - station.tx * back;
    const z = atZ - station.tz * back;
    // A station's height is the road's height only *at* that station. The deck is
    // a graded hillside, so over a few metres the hillside's own rise carries it:
    // at Tà Xùa the road climbs 0.31 m over the marshal's setback on a 56% grade,
    // the terrain says most of it, and what is left over is the grading. Flat, the
    // marshal stood that whole distance inside the tarmac.
    const carry = back === 0 ? 0 : terrain.heightAt(x, z) - terrain.heightAt(atX, atZ);
    return { x, z, y: restY(station, across) + carry };
  };

  const nearPost = atKerb(line, 1, 0);
  const farPost = atKerb(line, -1, 0);
  for (const post of [nearPost, farPost]) {
    const length = line.y + POST_TOP - post.y;
    parts.push(tube([0.05, 0.065], length, [post.x, post.y + length / 2, post.z], POST, undefined, 6));
  }

  // The turn's cloth is static: a flutter here would read as a second instruction
  // competing with the one flag that is actually saying where to go.
  const turnMast = plant(turn, 1, 0, TURN_TIP);
  const mastAt: Vec = [turnMast.x, turnMast.y + turnMast.length / 2, turnMast.z];
  const clothAt: Vec = [turnMast.x + turn.tx * 0.78, turnMast.y + turnMast.length - 0.34, turnMast.z + turn.tz * 0.78];
  parts.push(
    tube([0.05, 0.075], turnMast.length, mastAt, POST, undefined, 6),
    box([0.03, 0.44, 1.5], clothAt, TURN_CLOTH, [0, yawOf(turn), 0])
  );

  // Behind the line at the kerb, where a starter stands: the flag reaches out over
  // the road rather than away from it, and the grid launches past them rather than
  // at them. A setback runs straight along the station's tangent, so on a bend it
  // leaves the carriageway at about `back² / 2R` — 0.13 m even on a 10 m radius,
  // tighter than any carriageway bend, which keeps the feet inside the kerb whose
  // height they are taking.
  const stand = atKerb(line, 1, MARSHAL_BACK);
  // The villagers' own shape — a cylinder under a nón lá, over scale at 2.8 m for
  // the same reason they are. `mergeParts` consumes both geometries, which is the
  // whole of what `person.dispose` would have done.
  const person = createPersonParts();
  person.body.translate(stand.x, stand.y, stand.z);
  person.hat.translate(stand.x, stand.y, stand.z);
  parts.push({ geometry: person.body, color: SHIRT }, { geometry: person.hat, color: HAT });

  const span = (carriageHalf - KERB_INSET) * 2;
  return {
    stand: mergeParts(parts),
    ribbon: mergeParts([
      box([span, 0.15, 0.02], [span / 2, 0, 0], RIBBON),
      box([span, 0.04, 0.022], [span / 2, -0.095, 0], RIBBON_HEM),
    ]),
    starter: mergeParts([
      tube([0.022, 0.022], 1.45, [0.72, 0, 0], POLE, [0, 0, Math.PI / 2], 5),
      box([0.86, 0.6, 0.02], [0.78, -0.34, 0], RIBBON),
      box([0.86, 0.08, 0.022], [0.78, -0.68, 0], RIBBON_HEM),
    ]),
    mast: mergeParts([tube([0.04, 0.055], 1, [0, 0.5, 0], MAST, undefined, 6)]),
    cloth: mergeParts([
      box([1.2, 0.74, 0.022], [0.62, -0.4, 0], FLAG),
      box([1.2, 0.1, 0.024], [0.62, -0.82, 0], FLAG_HEM),
    ]),
    // Local +X at the line's yaw is the far post, which the tape runs to.
    ribbonAt: { x: nearPost.x, y: line.y + POST_TOP - RIBBON_DROP, z: nearPost.z, yaw: yawOf(line) },
    marshalAt: { x: stand.x, y: stand.y + PERSON_HEIGHT * 0.64, z: stand.z, yaw: yawOf(line) },
    turnAt: { x: turnMast.x, y: turnMast.y, z: turnMast.z },
    // Pushed well past the far kerb, so it never shares a patch of grass with the
    // turn mast.
    flagsAt: stations.map((station) => plant(station, -1, 2.4, FLAG_TIP)),
    yaws: stations.map(yawOf),
  };
};
