import type { Prng } from '@otrip/world';
import type { MeshStandardMaterial } from 'three';

import type { BuildSink, BuildingKit } from './building-kit';

/**
 * Walls with holes in them. A window drawn as a dark rectangle on a flat wall
 * is the single thing that makes a procedural town look like a diagram, so a
 * wall here is built as the pieces around its openings — sill course, head
 * course and piers — and the sash is then set back inside a real reveal.
 */

export type OpeningRow = {
  /** Centres of the openings, in the wall's own x. */
  centres: number[];
  width: number;
  sillY: number;
  headY: number;
  /** Outer face of the wall, so a sash can be set back from it. */
  faceZ: number;
};

export type WallOptions = {
  material: MeshStandardMaterial;
  width: number;
  /** Bottom of this storey's wall. */
  baseY: number;
  height: number;
  /** Centre of the wall slab. */
  z: number;
  thickness: number;
  /** How many openings in the row. 0 leaves the wall solid. */
  openings: number;
  openWidth: number;
  /** Heights of the opening, measured from `baseY`. */
  sill: number;
  head: number;
  /** A deeper lintel band above the head, in a second material. */
  lintel?: MeshStandardMaterial;
};

const MIN_PIER = 0.22;

/**
 * Lays the solid parts of one storey's wall and reports where the holes are.
 * Openings shrink before piers do: a façade with no wall left between its
 * windows reads as a curtain wall, which no house in this town has.
 */
export const addPiercedWall = (sink: BuildSink, options: WallOptions): OpeningRow => {
  const { material, width, baseY, height, z, thickness } = options;
  const face = z + thickness / 2;

  if (options.openings < 1) {
    sink.box(material, 0, baseY + height / 2, z, width, height, thickness);
    return { centres: [], width: 0, sillY: baseY, headY: baseY, faceZ: face };
  }

  const count = options.openings;
  const available = width - MIN_PIER * (count + 1);
  const openWidth = Math.max(0.4, Math.min(options.openWidth, available / count));
  const pier = (width - openWidth * count) / (count + 1);

  const head = Math.min(options.head, height);
  const sill = Math.min(options.sill, head - 0.4);

  if (sill > 0.02) sink.box(material, 0, baseY + sill / 2, z, width, sill, thickness);
  if (height - head > 0.02) {
    sink.box(material, 0, baseY + (head + height) / 2, z, width, height - head, thickness);
  }
  if (options.lintel) {
    sink.box(options.lintel, 0, baseY + head + 0.09, z, width, 0.18, thickness + 0.07);
  }

  const centres: number[] = [];
  for (let i = 0; i <= count; i += 1) {
    const at = -width / 2 + pier * i + openWidth * i;
    sink.box(material, at + pier / 2, baseY + (sill + head) / 2, z, pier, head - sill, thickness);
    if (i < count) centres.push(at + pier + openWidth / 2);
  }

  return { centres, width: openWidth, sillY: baseY + sill, headY: baseY + head, faceZ: face };
};

/** Picks what is behind the glass. Not every window in a street is lit. */
export const paneMaterial = (kit: BuildingKit, random: Prng): MeshStandardMaterial => {
  const roll = random();
  if (roll < 0.34) return kit.mat.glass;
  if (roll < 0.76) return kit.mat.windowWarm;
  if (roll < 0.92) return kit.mat.windowCool;
  return kit.mat.windowTv;
};

export type SashOptions = {
  pane: MeshStandardMaterial;
  frame: MeshStandardMaterial;
  /** How far behind the wall face the glass sits. A deep reveal casts a shadow. */
  reveal?: number;
  /** A projecting sill nose below the opening. */
  sill?: MeshStandardMaterial;
  shutters?: MeshStandardMaterial;
  grille?: boolean;
};

/**
 * Fills one opening: glass set back in the reveal, the sash in front of it, an
 * optional sill nose, and shutters folded back against the jambs.
 */
export const addSash = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  facing: number,
  options: SashOptions
): void => {
  const reveal = options.reveal ?? 0.12;
  const bay = sink.frame(x, y, z, facing);

  bay.box(options.pane, 0, height / 2, -reveal, width - 0.04, height - 0.04, 0.05);
  bay.put(kit.panel.sash(width, height), options.frame, 0, 0, -reveal + 0.07, { sx: width, sy: height, sz: 1 });

  if (options.grille) {
    bay.put(kit.panel.grille(width), kit.mat.metal, 0, 0, -reveal + 0.14, { sx: width, sy: height, sz: 1 });
  }
  if (options.sill) {
    bay.box(options.sill, 0, -0.04, 0.03, width + 0.22, 0.08, 0.26);
  }
  if (options.shutters) {
    const leaf = width * 0.46;
    for (const side of [-1, 1]) {
      bay.put(kit.panel.louvre(height), options.shutters, (side * (width + leaf)) / 2, 0, 0.06, {
        sx: leaf,
        sy: height,
        sz: 1,
      });
    }
  }
};

/** A doorway: boarded leaves, a threshold step and a frame that stands proud. */
export const addDoorway = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  facing: number,
  leaf: MeshStandardMaterial,
  frame: MeshStandardMaterial
): void => {
  const bay = sink.frame(x, y, z, facing);
  bay.put(kit.panel.boarded(width), leaf, 0, 0, -0.1, { sx: width - 0.1, sy: height - 0.06, sz: 1 });
  bay.box(frame, 0, height - 0.06, -0.04, width + 0.18, 0.12, 0.14);
  for (const side of [-1, 1]) {
    bay.box(frame, (side * (width + 0.1)) / 2, height / 2, -0.04, 0.12, height, 0.14);
  }
  bay.box(kit.mat.stone, 0, -0.04, 0.09, width + 0.2, 0.09, 0.4);
  bay.put(kit.geo.sphere, kit.mat.metal, width * 0.32, height * 0.46, -0.04, { size: 0.08 });
};

/**
 * A plinth, and the skirt that takes it down into the slope. Without the skirt
 * a house on a hillside floats at its downhill corner, which is the first thing
 * the eye catches on terrain this uneven.
 */
export const addPlinth = (
  sink: BuildSink,
  kit: BuildingKit,
  width: number,
  depth: number,
  height: number,
  drop: number,
  material: MeshStandardMaterial
): void => {
  sink.box(material, 0, -height / 2, 0, width + 0.3, height, depth + 0.3);
  sink.box(kit.mat.concreteWorn, 0, -height - drop / 2, 0, width + 0.1, drop + 0.1, depth + 0.1);
  // A nosing proud of the plinth reads as a cast edge rather than a cut face.
  sink.box(kit.mat.stone, 0, -0.04, 0, width + 0.42, 0.08, depth + 0.42);
};

/** The damp line a wall picks up from the street. Mortar, mud, moss. */
export const addWeathering = (
  sink: BuildSink,
  kit: BuildingKit,
  width: number,
  depth: number,
  y: number,
  random: Prng
): void => {
  sink.box(kit.mat.grime, 0, y + 0.26, 0, width + 0.03, 0.52, depth + 0.03);
  const patches = 2 + Math.floor(random() * 3);
  for (let i = 0; i < patches; i += 1) {
    const front = random() > 0.5;
    const along = (random() - 0.5) * (front ? width : depth) * 0.85;
    sink.box(
      random() > 0.45 ? kit.mat.moss : kit.mat.concreteWorn,
      front ? along : ((random() > 0.5 ? 1 : -1) * width) / 2,
      y + 0.1 + random() * 0.8,
      front ? ((random() > 0.5 ? 1 : -1) * depth) / 2 : along,
      front ? 0.3 + random() * 0.5 : 0.05,
      0.2 + random() * 0.5,
      front ? 0.05 : 0.3 + random() * 0.5
    );
  }
};
