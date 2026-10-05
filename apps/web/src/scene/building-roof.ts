import type { BufferGeometry, MeshStandardMaterial } from 'three';

import type { BuildSink, BuildingKit } from './building-kit';

/**
 * Roofs, for every building type in the town. A Vietnamese roof is most of what
 * you see of a house, so this is the one assembly worth getting exactly right:
 * a tiled field with real relief, a deck under it so the soffit is solid, a
 * fascia at the eave, rafter tails showing below it, and a rolled ridge.
 *
 * Everything is built in the sink's local frame with the ridge running along x,
 * so a caller only ever passes the span it has to cover.
 */

/** Relief of one tile course, in metres — the shadow line that says "tiles". */
const TILE_RELIEF = 0.085;
const SHEET_RELIEF = 0.055;
const DECK = 0.06;

export type RoofOptions = {
  /** Along the ridge. */
  width: number;
  /** Across the slopes. */
  depth: number;
  /** Where the wall stops. The eave hangs below this, as a real one does. */
  wallTop: number;
  /** Slope angle in radians. 0.5 is a house, 0.95 is a nhà rông. */
  pitch: number;
  /** Projection beyond the wall at the eave. */
  eave: number;
  /** Projection past the gable wall. Ignored by the hipped roof. */
  verge?: number;
  tile: MeshStandardMaterial;
  timber: MeshStandardMaterial;
  /** Corrugated sheet instead of pan tiles: market sheds, lean-tos, pens. */
  sheet?: boolean;
  rafters?: boolean;
  /** Upturned corner horns. A pagoda has them; a house does not. */
  horns?: boolean;
};

export type Roof = {
  /** Height of the ridge, so the caller knows what it just covered. */
  ridgeY: number;
  /** Height of the eave edge, for hanging lanterns and sign boards off. */
  eaveY: number;
};

/**
 * Lays an extruded part along an arbitrary segment. The extruded primitives run
 * along their own x and `compose` applies roll innermost, so roll tilts that
 * axis inside the vertical plane the yaw already turned it into.
 */
export const addStrut = (
  sink: BuildSink,
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  thickness: number
): void => {
  const run = Math.hypot(bx - ax, bz - az);
  sink.put(geometry, material, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, {
    sx: Math.hypot(run, by - ay),
    sy: thickness,
    sz: thickness,
    yaw: Math.atan2(-(bz - az), bx - ax),
    roll: Math.atan2(by - ay, run),
  });
};

type Slope = {
  /** Centre of the slope's footprint in the building frame. */
  cx: number;
  cz: number;
  yaw: number;
  pitch: number;
  /** Width at the eave. */
  span: number;
  /** Horizontal distance from eave edge to ridge. */
  run: number;
  eaveY: number;
  ridgeY: number;
  /** 0 is a rectangle, 1 a triangle; what turns a gable slope into a hip. */
  taper: number;
  verges: boolean;
};

/** One slope: deck, tile field, verge boards, fascia and rafter tails. */
const addSlope = (sink: BuildSink, kit: BuildingKit, options: RoofOptions, slope: Slope): void => {
  const relief = options.sheet ? SHEET_RELIEF : TILE_RELIEF;
  const length = Math.hypot(slope.run, slope.ridgeY - slope.eaveY);
  const field = options.sheet
    ? kit.corrugated(slope.span, slope.taper)
    : kit.tileField(slope.span, length, slope.taper);

  // +z of this frame runs up the slope, +y is the roof's own outward normal.
  const plane = sink.frame(slope.cx, (slope.eaveY + slope.ridgeY) / 2, slope.cz, slope.yaw, -slope.pitch);

  plane.box(options.timber, 0, 0.2 * relief - DECK / 2, 0, slope.span, DECK, length);
  plane.put(field, options.tile, 0, 0, 0, { sx: slope.span, sy: relief, sz: length });

  if (slope.verges) {
    for (const side of [-1, 1]) {
      plane.box(options.timber, (side * slope.span) / 2, 0.02, 0, 0.07, 0.18, length);
    }
  }

  plane.box(options.timber, 0, -0.07, -length / 2 + 0.03, slope.span, 0.2, 0.07);

  if (options.rafters !== false && options.eave > 0.25) {
    const tails = options.eave / Math.cos(slope.pitch);
    plane.put(kit.panel.rafters(slope.span), options.timber, 0, -0.11, -length / 2 + tails / 2, {
      sx: slope.span,
      sy: 0.15,
      sz: tails,
    });
  }
};

/** A horn: the eave corner curling up, in three shortening steps and a finial. */
const addHorn = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  yaw: number,
  size: number,
  tile: MeshStandardMaterial
): void => {
  const horn = sink.frame(x, y, z, yaw);
  let at = 0;
  let lift = 0;

  for (let i = 0; i < 3; i += 1) {
    const step = size * (0.46 - i * 0.1);
    const rise = 0.3 + i * 0.42;
    horn.put(kit.geo.halfRound, tile, at + (step * Math.cos(rise)) / 2, lift + (step * Math.sin(rise)) / 2, 0, {
      sx: step,
      sy: size * 0.3,
      sz: size * (0.42 - i * 0.07),
      roll: rise,
    });
    at += step * Math.cos(rise);
    lift += step * Math.sin(rise);
  }

  horn.put(kit.geo.finial, tile, at, lift, 0, { sx: size * 0.34, sy: size * 0.55, sz: size * 0.34 });
};

const addHorns = (
  sink: BuildSink,
  kit: BuildingKit,
  crossRun: number,
  run: number,
  eaveY: number,
  size: number,
  tile: MeshStandardMaterial,
  diagonal: boolean
): void => {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      addHorn(sink, kit, sx * crossRun, eaveY, sz * run, Math.atan2(diagonal ? -sz : 0, sx), size, tile);
    }
  }
};

/** Mái hai mái: the ordinary two-slope roof of a house, with gable ends. */
export const addGableRoof = (sink: BuildSink, kit: BuildingKit, options: RoofOptions): Roof => {
  const tangent = Math.tan(options.pitch);
  const run = options.depth / 2 + options.eave;
  const verge = options.verge ?? options.eave * 0.7;
  const span = options.width + 2 * verge;
  const eaveY = options.wallTop - options.eave * tangent;
  const ridgeY = eaveY + run * tangent;
  const shared = { span, run, eaveY, ridgeY, taper: 0, verges: true, pitch: options.pitch, cx: 0 };

  addSlope(sink, kit, options, { ...shared, yaw: 0, cz: -run / 2 });
  addSlope(sink, kit, options, { ...shared, yaw: Math.PI, cz: run / 2 });

  // The gable fill sits inside the verge, so the barge boards above overhang it.
  for (const side of [-1, 1]) {
    sink.put(kit.geo.prism, options.timber, (side * options.width) / 2, options.wallTop, 0, {
      sx: 0.14,
      sy: ridgeY - options.wallTop,
      sz: options.depth,
    });
  }

  sink.put(kit.geo.halfRound, options.sheet ? options.timber : options.tile, 0, ridgeY, 0, {
    sx: span + 0.14,
    sy: 0.26,
    sz: 0.46,
  });

  if (options.horns) {
    addHorns(sink, kit, span / 2, run, eaveY, options.eave * 1.5, options.tile, false);
  }

  return { ridgeY, eaveY };
};

/**
 * Mái bốn mái: hipped, for an đình, a chùa tier or anything with a courtyard on
 * every side of it. Square plans collapse to a pyramid, which is correct.
 *
 * The tile fields come off a shared ladder of taper values, so the ridge length
 * is derived from the taper the ladder actually gave rather than the other way
 * round — otherwise the hips and the slopes would not meet along one line.
 */
export const addHipRoof = (sink: BuildSink, kit: BuildingKit, options: RoofOptions): Roof => {
  const tangent = Math.tan(options.pitch);
  const run = options.depth / 2 + options.eave;
  const crossRun = options.width / 2 + options.eave;
  const eaveY = options.wallTop - options.eave * tangent;
  const ridgeY = eaveY + run * tangent;
  const longSpan = crossRun * 2;
  const shortSpan = run * 2;

  const wanted = 1 - Math.max(0, options.width - options.depth) / longSpan;
  const taper = Math.min(1, Math.max(0.25, Math.round(wanted * 4) / 4));
  const ridgeLength = longSpan * (1 - taper);

  const hipRun = crossRun - ridgeLength / 2;
  const hipPitch = Math.atan2(ridgeY - eaveY, hipRun);

  const long = { span: longSpan, run, eaveY, ridgeY, taper, verges: false, pitch: options.pitch, cx: 0 };
  addSlope(sink, kit, options, { ...long, yaw: 0, cz: -run / 2 });
  addSlope(sink, kit, options, { ...long, yaw: Math.PI, cz: run / 2 });

  const hip = { span: shortSpan, run: hipRun, eaveY, ridgeY, taper: 1, verges: false, pitch: hipPitch, cz: 0 };
  for (const side of [-1, 1]) {
    addSlope(sink, kit, options, {
      ...hip,
      yaw: (-side * Math.PI) / 2,
      cx: side * (ridgeLength / 2 + hipRun / 2),
    });
  }

  const cap = options.sheet ? options.timber : options.tile;
  if (ridgeLength > 0.4) {
    sink.put(kit.geo.halfRound, cap, 0, ridgeY, 0, { sx: ridgeLength, sy: 0.3, sz: 0.5 });
  } else {
    sink.put(kit.geo.finial, cap, 0, ridgeY - 0.1, 0, { sx: 0.7, sy: 1.05, sz: 0.7 });
  }

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      addStrut(sink, kit.geo.halfRound, cap, sx * crossRun, eaveY, sz * run, (sx * ridgeLength) / 2, ridgeY, 0, 0.34);
    }
  }

  if (options.horns) {
    addHorns(sink, kit, crossRun, run, eaveY, options.eave * 1.7, options.tile, true);
  }

  return { ridgeY, eaveY };
};

/** A single-pitch lean-to, falling towards +z. Kitchens, awnings, pens. */
export const addLeanRoof = (
  sink: BuildSink,
  kit: BuildingKit,
  width: number,
  depth: number,
  highY: number,
  pitch: number,
  eave: number,
  tile: MeshStandardMaterial,
  timber: MeshStandardMaterial,
  sheet: boolean
): number => {
  const run = depth + eave;
  const lowY = highY - run * Math.tan(pitch);
  const relief = sheet ? SHEET_RELIEF : TILE_RELIEF;
  const length = Math.hypot(run, highY - lowY);
  const field = sheet ? kit.corrugated(width) : kit.tileField(width, length);

  const plane = sink.frame(0, (highY + lowY) / 2, run / 2, Math.PI, -pitch);
  plane.box(timber, 0, 0.2 * relief - DECK / 2, 0, width, DECK, length);
  plane.put(field, tile, 0, 0, 0, { sx: width, sy: relief, sz: length });
  plane.box(timber, 0, -0.07, -length / 2 + 0.03, width, 0.18, 0.07);

  return lowY;
};
