import type { Prng } from '@otrip/world';

import type { BuildSink, BuildingKit } from './building-kit';
import { addIncenseUrn, addLantern, addStreetStall } from './building-props';
import { addGableRoof, addHipRoof } from './building-roof';
import type { Builder } from './building-spec';
import { addPlinth } from './building-walls';

/**
 * The buildings a village has one of. Neither is a house: an đình is a roof on
 * columns with a courtyard in front of it, and a nhà rông is the same idea with
 * the roof taken to its highland conclusion. They are also the only buildings
 * anyone walks towards, so they are built at the top of the detail budget.
 */

/** A row of columns on stone bases, carrying a beam. The whole timber order. */
export const addColonnade = (
  sink: BuildSink,
  kit: BuildingKit,
  width: number,
  depth: number,
  baseY: number,
  height: number,
  across: number,
  along: number,
  lacquered: boolean
): void => {
  const post = lacquered ? kit.mat.lacquer : kit.mat.timberDark;
  for (let i = 0; i < across; i += 1) {
    for (let j = 0; j < along; j += 1) {
      const edge = i === 0 || i === across - 1 || j === 0 || j === along - 1;
      if (!edge) continue;
      const x = (-0.5 + i / (across - 1)) * width;
      const z = (-0.5 + j / (along - 1)) * depth;
      sink.put(kit.geo.drum, kit.mat.stone, x, baseY + 0.12, z, { sx: 0.56, sy: 0.24, sz: 0.56 });
      sink.put(kit.geo.post, post, x, baseY + 0.24 + height / 2, z, { sx: 0.34, sy: height, sz: 0.34 });
      sink.put(kit.geo.ring, kit.mat.gold, x, baseY + 0.24 + height - 0.3, z, {
        sx: 0.46,
        sy: 0.46,
        sz: 0.1,
        pitch: Math.PI / 2,
      });
    }
  }
  // Beams both ways at the head of the columns, which is what the roof sits on.
  for (const side of [-1, 1]) {
    sink.box(post, 0, baseY + height + 0.3, (side * depth) / 2, width + 0.5, 0.3, 0.26);
    sink.box(post, (side * width) / 2, baseY + height + 0.3, 0, 0.26, 0.3, depth + 0.5);
  }
};

/** Low walls between the columns, open at the front. The đình is not a shed. */
export const addInfill = (
  sink: BuildSink,
  kit: BuildingKit,
  width: number,
  depth: number,
  baseY: number,
  height: number
): void => {
  sink.box(kit.mat.whitewash, 0, baseY + height / 2, -depth / 2, width, height, 0.22);
  for (const side of [-1, 1]) {
    sink.box(kit.mat.whitewash, (side * width) / 2, baseY + height / 2, 0, 0.22, height, depth);
    sink.put(kit.panel.lattice(depth * 0.6, 1.4), kit.mat.timberDark, (side * width) / 2, baseY + height, 0, {
      sx: depth * 0.6,
      sy: 1.4,
      sz: 1,
      yaw: Math.PI / 2,
    });
  }
  sink.box(kit.mat.lacquer, 0, baseY + height + 0.7, -depth / 2 + 0.1, width * 0.5, 1.4, 0.12);
  sink.box(kit.mat.gold, 0, baseY + height + 0.7, -depth / 2 + 0.18, width * 0.42, 0.9, 0.04);
};

/** Sân: a paved forecourt with a low wall, which is half of what a landmark is. */
export const addCourtyard = (
  sink: BuildSink,
  kit: BuildingKit,
  width: number,
  frontZ: number,
  depth: number,
  random: Prng
): void => {
  if (depth < 2) return;
  const centre = frontZ + depth / 2;
  sink.box(kit.mat.paving, 0, 0.04, centre, width, 0.1, depth);
  sink.box(kit.mat.stone, 0, 0.09, centre, width - 1.4, 0.1, depth - 1.4);

  for (const side of [-1, 1]) {
    sink.box(kit.mat.whitewash, (side * width) / 2, 0.5, centre, 0.26, 1.0, depth);
    sink.put(kit.geo.halfRound, kit.mat.tileDark, (side * width) / 2, 1.0, centre, {
      sx: depth,
      sy: 0.2,
      sz: 0.44,
      yaw: Math.PI / 2,
    });
  }

  if (random() < 0.7) addStreetStall(sink, kit, -width * 0.26, 0.09, centre + depth * 0.2, random);
};

/**
 * Đình. The village's own hall: a raised floor on stone bases, columns rather
 * than walls at the front, and a hipped roof heavy enough that the building
 * reads as the roof with a house under it.
 */
export const buildVillageHall: Builder = (sink, kit, spec) => {
  const { width, depth, random } = spec;
  const hallWidth = Math.min(width * 0.72, 14);
  const hallDepth = Math.min(depth * 0.46, 9);
  const floorY = 1.1;
  const columnHeight = 3.3;
  const wallTop = floorY + columnHeight + 0.45;
  const hallZ = -depth / 2 + hallDepth / 2 + 0.8;
  const hall = sink.frame(0, 0, hallZ);

  addPlinth(hall, kit, hallWidth + 1.2, hallDepth + 1.2, floorY, spec.drop, kit.mat.stone);
  hall.box(kit.mat.paving, 0, floorY - 0.06, 0, hallWidth + 1.2, 0.12, hallDepth + 1.2);

  // Bậc thềm: the steps up to the floor, the full width of the central bay.
  hall.put(kit.panel.steps(3), kit.mat.stone, 0, 0, hallDepth / 2 + 1.25, {
    sx: hallWidth * 0.45,
    sy: floorY,
    sz: 1.5,
    yaw: Math.PI,
  });

  addColonnade(hall, kit, hallWidth, hallDepth, floorY, columnHeight, 4, 3, true);
  addInfill(hall, kit, hallWidth, hallDepth, floorY, columnHeight * 0.62);

  const roof = addHipRoof(hall, kit, {
    width: hallWidth + 0.6,
    depth: hallDepth + 0.6,
    wallTop,
    pitch: 0.72,
    eave: 1.85,
    tile: kit.mat.tileDark,
    timber: kit.mat.timberDark,
    horns: true,
  });

  for (const side of [-1, 1]) {
    addLantern(hall, kit, (side * hallWidth) / 2, roof.eaveY - 0.8, hallDepth / 2 + 1.5, 0.5, side > 0, 0.4);
  }
  addIncenseUrn(sink, kit, 0, 0.09, hallZ + hallDepth / 2 + 3.2, 1.1);
  addCourtyard(sink, kit, width, hallZ + hallDepth / 2 + 0.6, depth - hallDepth - 1.4, random);

  return roof.ridgeY;
};

/**
 * Nhà rông. The same idea as an đình taken to its conclusion in the highlands:
 * the roof is twice the height of the house and its gable is the façade, so the
 * carved screen at each end is the part that matters.
 */
export const buildCommunalHouse: Builder = (sink, kit, spec) => {
  const { width, depth, random } = spec;
  const hallWidth = Math.min(width * 0.58, 11);
  const hallDepth = Math.min(depth * 0.42, 6.4);
  const floorY = 1.9;
  const columnHeight = 2.8;
  const wallTop = floorY + columnHeight;
  const hallZ = -depth / 2 + hallDepth / 2 + 1.2;
  const hall = sink.frame(0, 0, hallZ);

  for (let i = 0; i < 4; i += 1) {
    for (const side of [-1, 1]) {
      const x = (-0.5 + i / 3) * hallWidth;
      const z = (side * hallDepth) / 2;
      hall.put(kit.geo.drum, kit.mat.stone, x, 0.1, z, { sx: 0.6, sy: 0.2, sz: 0.6 });
      hall.put(kit.geo.post, kit.mat.timberDark, x, floorY / 2 + 0.1, z, { sx: 0.3, sy: floorY, sz: 0.3 });
    }
  }
  hall.box(kit.mat.earth, 0, -spec.drop / 2, 0, hallWidth + 1, spec.drop + 0.14, hallDepth + 1);

  hall.box(kit.mat.timberPale, 0, floorY, 0, hallWidth + 0.6, 0.14, hallDepth + 0.6);
  hall.box(kit.mat.timberMid, 0, floorY - 0.14, 0, hallWidth + 0.7, 0.2, hallDepth + 0.7);
  for (const side of [-1, 1]) {
    hall.box(kit.mat.woven, 0, floorY + columnHeight / 2, (side * hallDepth) / 2, hallWidth, columnHeight, 0.16);
    hall.box(kit.mat.woven, (side * hallWidth) / 2, floorY + columnHeight / 2, 0, 0.16, columnHeight, hallDepth);
    hall.put(kit.panel.balustrade(hallDepth), kit.mat.bamboo, (side * (hallWidth + 0.5)) / 2, floorY, 0, {
      sx: hallDepth,
      sy: 0.9,
      sz: 1,
      yaw: Math.PI / 2,
    });
  }
  hall.put(kit.panel.ladder(floorY + 0.4), kit.mat.timberMid, 0, 0, hallDepth / 2 + 0.7, {
    sx: 1.2,
    sy: floorY + 0.4,
    sz: 1,
  });

  const roof = addGableRoof(hall, kit, {
    width: hallWidth + 0.8,
    depth: hallDepth + 0.8,
    wallTop,
    // A nhà rông roof is nearly an axe blade; anything shallower is a house.
    pitch: 1.19,
    eave: 1.0,
    verge: 0.7,
    tile: kit.mat.thatch,
    timber: kit.mat.timberDark,
  });

  const screen = roof.ridgeY - wallTop - 0.4;
  for (const side of [-1, 1]) {
    hall.put(kit.panel.lattice(hallDepth * 0.8, screen), kit.mat.timberMid, (side * hallWidth) / 2, wallTop + 0.2, 0, {
      sx: hallDepth * 0.8,
      sy: screen,
      sz: 1,
      yaw: Math.PI / 2,
    });
    hall.put(kit.geo.finial, kit.mat.timberDark, (side * (hallWidth + 0.9)) / 2, roof.ridgeY - 0.2, 0, {
      sx: 0.6,
      sy: 1.5,
      sz: 0.6,
    });
  }

  addCourtyard(sink, kit, width, hallZ + hallDepth / 2 + 1.2, depth - hallDepth - 2.4, random);
  // The gable finials stand above the ridge, and `top` is what collision reads.
  return roof.ridgeY + 1.3;
};
