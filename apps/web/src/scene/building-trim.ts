import type { MeshStandardMaterial } from 'three';

import type { BuildSink, BuildingKit } from './building-kit';

/**
 * The things bolted onto a finished wall: a balcony, an awning, a sign board, a
 * kitchen vent, the parapet round a flat roof. Separate from the wall itself
 * because every building type wants them and none of them care what they hang
 * off — the same awning works over a shopfront and over a market stall.
 */

/** A cantilevered slab with a railing on it. Every upper floor has one. */
export const addBalcony = (
  sink: BuildSink,
  kit: BuildingKit,
  y: number,
  z: number,
  width: number,
  depth: number,
  slab: MeshStandardMaterial,
  rail: MeshStandardMaterial
): void => {
  sink.box(slab, 0, y + 0.06, z + depth / 2, width, 0.12, depth);
  sink.box(kit.mat.concreteWorn, 0, y + 0.18, z + depth, width, 0.14, 0.08);
  sink.put(kit.panel.balustrade(width), rail, 0, y + 0.12, z + depth - 0.05, { sx: width, sy: 0.96, sz: 1 });
  for (const side of [-1, 1]) {
    sink.put(kit.panel.balustrade(depth), rail, (side * width) / 2, y + 0.12, z + depth / 2, {
      sx: depth,
      sy: 0.96,
      sz: 1,
      yaw: Math.PI / 2,
    });
  }
};

/** Mái hiên: the cloth or sheet awning over a shopfront, on diagonal stays. */
export const addAwning = (
  sink: BuildSink,
  kit: BuildingKit,
  y: number,
  z: number,
  width: number,
  depth: number,
  cloth: MeshStandardMaterial
): void => {
  const fall = 0.4;
  const length = Math.hypot(depth, fall);
  sink.put(kit.geo.box, cloth, 0, y - fall / 2, z + depth / 2, {
    sx: width,
    sy: 0.035,
    sz: length,
    pitch: Math.atan2(fall, depth),
  });
  sink.box(kit.mat.metal, 0, y + 0.03, z + 0.04, width, 0.07, 0.07);
  // A scalloped valance along the front edge, which is what you actually see.
  sink.box(cloth, 0, y - fall - 0.11, z + depth, width, 0.22, 0.03);
  for (const side of [-1, 1]) {
    sink.put(kit.geo.pipe, kit.mat.metal, (side * width) / 2, y - fall / 2, z + depth / 2, {
      sx: 0.05,
      sy: length,
      sz: 0.05,
      roll: Math.PI / 2,
      pitch: Math.atan2(depth, fall),
    });
  }
};

/** Biển hiệu. A painted board by day, a lit box after dark. */
export const addSignBoard = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  lit: boolean
): void => {
  sink.box(lit ? kit.mat.signLit : kit.mat.signRed, x, y + height / 2, z + 0.06, width, height, 0.11);
  sink.box(kit.mat.metalPale, x, y + height / 2, z, width + 0.1, height + 0.08, 0.06);
  sink.box(kit.mat.gold, x, y + height - 0.05, z + 0.12, width * 0.9, 0.05, 0.02);
  sink.box(kit.mat.gold, x, y + 0.05, z + 0.12, width * 0.9, 0.05, 0.02);
};

/** Ống khói: the kitchen vent, which is where the smoke of dinner comes from. */
export const addChimney = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  z: number,
  baseY: number,
  topY: number,
  size: number,
  material: MeshStandardMaterial
): void => {
  sink.box(material, x, (baseY + topY) / 2, z, size, topY - baseY, size);
  sink.box(kit.mat.stone, x, topY + 0.05, z, size + 0.14, 0.1, size + 0.14);
  sink.put(kit.geo.drum, kit.mat.metalRust, x, topY + 0.22, z, { sx: size * 0.5, sy: 0.3, sz: size * 0.5 });
  sink.put(kit.geo.dish, kit.mat.metalRust, x, topY + 0.42, z, { sx: size * 0.8, sy: 0.2, sz: size * 0.8 });
};

/** The parapet round a flat roof, with its drip course and a weep spout. */
export const addParapet = (
  sink: BuildSink,
  kit: BuildingKit,
  width: number,
  depth: number,
  y: number,
  height: number,
  material: MeshStandardMaterial
): void => {
  const sides: [number, number, number, number][] = [
    [0, depth / 2, width, 0.14],
    [0, -depth / 2, width, 0.14],
  ];
  for (const [x, z, run, thickness] of sides) {
    sink.box(material, x, y + height / 2, z, run, height, thickness);
    sink.box(kit.mat.concreteWorn, x, y + height + 0.04, z, run + 0.16, 0.08, thickness + 0.14);
  }
  for (const side of [-1, 1]) {
    sink.box(material, (side * width) / 2, y + height / 2, 0, 0.14, height, depth);
    sink.box(kit.mat.concreteWorn, (side * width) / 2, y + height + 0.04, 0, 0.3, 0.08, depth + 0.16);
  }
  sink.put(kit.geo.pipe, kit.mat.metalRust, width * 0.36, y + 0.12, depth / 2 + 0.16, {
    sx: 0.09,
    sy: 0.3,
    sz: 0.09,
    roll: Math.PI / 2,
  });
};
