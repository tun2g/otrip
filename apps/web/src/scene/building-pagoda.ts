import { addColonnade, addInfill } from './building-civic';
import { addCrates, addIncenseUrn, addLanternString } from './building-props';
import { addHipRoof } from './building-roof';
import type { Builder } from './building-spec';
import { addPlinth } from './building-walls';

/**
 * Chùa. Two tiers with the corners turned up, a wall round the compound, a gate
 * at the street and a bell tower in the courtyard. The tiers are not decoration
 * — the gap between them is the clerestory that lights the hall, so the drum
 * between the two roofs is built as a wall with a lattice in it.
 *
 * The spec's width and depth are the compound, not the hall: a chùa with no
 * courtyard in front of it is just an oddly shaped house.
 */
export const buildPagoda: Builder = (sink, kit, spec) => {
  const { width, depth, random } = spec;
  const hallWidth = Math.min(width * 0.62, 12);
  const hallDepth = Math.min(depth * 0.4, 9);
  const floorY = 0.8;
  const columnHeight = 4.0;
  const hallZ = -depth / 2 + hallDepth / 2 + 1.4;
  const hall = sink.frame(0, 0, hallZ);

  addPlinth(hall, kit, hallWidth + 1.4, hallDepth + 1.4, floorY, spec.drop, kit.mat.stone);
  hall.box(kit.mat.paving, 0, floorY - 0.06, 0, hallWidth + 1.4, 0.12, hallDepth + 1.4);
  hall.put(kit.panel.steps(3), kit.mat.stone, 0, 0, hallDepth / 2 + 1.35, {
    sx: hallWidth * 0.5,
    sy: floorY,
    sz: 1.6,
    yaw: Math.PI,
  });

  addColonnade(hall, kit, hallWidth, hallDepth, floorY, columnHeight, 4, 3, true);
  addInfill(hall, kit, hallWidth, hallDepth, floorY, columnHeight * 0.66);

  const lower = addHipRoof(hall, kit, {
    width: hallWidth + 0.8,
    depth: hallDepth + 0.8,
    wallTop: floorY + columnHeight * 0.74,
    pitch: 0.58,
    eave: 1.9,
    tile: kit.mat.tileGlazed,
    timber: kit.mat.lacquer,
    horns: true,
  });

  const drumY = lower.ridgeY - 0.35;
  const drumWidth = hallWidth * 0.66;
  const drumDepth = hallDepth * 0.6;
  hall.box(kit.mat.whitewash, 0, drumY + 0.9, 0, drumWidth, 1.8, drumDepth);
  for (const side of [-1, 1]) {
    hall.put(kit.panel.lattice(drumWidth * 0.8, 1.2), kit.mat.lacquer, 0, drumY + 0.4, (side * drumDepth) / 2, {
      sx: drumWidth * 0.8,
      sy: 1.2,
      sz: 1,
    });
  }
  const upper = addHipRoof(hall, kit, {
    width: drumWidth + 1.4,
    depth: drumDepth + 1.4,
    wallTop: drumY + 1.8,
    pitch: 0.62,
    eave: 1.15,
    tile: kit.mat.tileGlazed,
    timber: kit.mat.lacquer,
    horns: true,
  });
  hall.put(kit.geo.urn, kit.mat.gold, 0, upper.ridgeY, 0, { sx: 0.8, sy: 1.3, sz: 0.8 });

  const courtDepth = Math.max(4, depth - hallDepth - 2.8);
  const courtZ = hallZ + hallDepth / 2 + 0.7 + courtDepth / 2;
  sink.box(kit.mat.paving, 0, 0.04, courtZ, width, 0.1, courtDepth);
  addIncenseUrn(sink, kit, 0, 0.09, courtZ, 1.4);

  // Gác chuông: the bell tower, open on all four sides so the bell shows.
  const tower = sink.frame(width * 0.3, 0, courtZ - courtDepth * 0.18);
  addPlinth(tower, kit, 3.0, 3.0, 0.5, 0, kit.mat.stone);
  addColonnade(tower, kit, 2.4, 2.4, 0.5, 2.6, 2, 2, true);
  tower.box(kit.mat.timberPale, 0, 3.55, 0, 2.8, 0.14, 2.8);
  addColonnade(tower, kit, 1.9, 1.9, 3.6, 2.2, 2, 2, true);
  addHipRoof(tower, kit, {
    width: 2.9,
    depth: 2.9,
    wallTop: 6.1,
    pitch: 0.68,
    eave: 1.0,
    tile: kit.mat.tileGlazed,
    timber: kit.mat.lacquer,
    horns: true,
  });
  tower.box(kit.mat.timberDark, 0, 5.4, 0, 1.9, 0.16, 0.16);
  tower.put(kit.geo.bell, kit.mat.gold, 0, 4.1, 0, { sx: 1.0, sy: 1.25, sz: 1.0 });

  // Tam quan: the gate, which is the only way through the compound wall.
  const gateZ = depth / 2 - 0.6;
  const gate = sink.frame(0, 0, gateZ);
  for (const at of [-1.9, -0.7, 0.7, 1.9]) {
    gate.box(kit.mat.whitewash, at, 1.9, 0, 0.5, 3.8, 0.7);
  }
  gate.box(kit.mat.whitewash, 0, 4.0, 0, 4.9, 0.4, 0.8);
  gate.box(kit.mat.lacquer, 0, 4.0, 0.42, 2.4, 0.5, 0.1);
  addHipRoof(gate, kit, {
    width: 5.4,
    depth: 1.5,
    wallTop: 4.2,
    pitch: 0.6,
    eave: 0.8,
    tile: kit.mat.tileGlazed,
    timber: kit.mat.lacquer,
    horns: true,
  });
  addLanternString(sink, kit, -width / 2 + 0.6, 3.4, gateZ, width / 2 - 0.6, 3.4, gateZ, 5, 0.5);

  // The compound wall: down both flanks, and across the front past the gate.
  const flank = courtDepth + hallDepth + 2;
  for (const side of [-1, 1]) {
    sink.box(kit.mat.whitewash, (side * width) / 2, 0.95, depth / 2 - flank / 2, 0.3, 1.9, flank);
    sink.put(kit.geo.halfRound, kit.mat.tileDark, (side * width) / 2, 1.9, depth / 2 - flank / 2, {
      sx: flank,
      sy: 0.24,
      sz: 0.56,
      yaw: Math.PI / 2,
    });
    sink.box(kit.mat.whitewash, (side * (width / 2 + 2.6)) / 2, 0.95, gateZ, width / 2 - 2.6, 1.9, 0.3);
  }

  if (random() < 0.8) addCrates(sink, kit, -width * 0.3, 0.09, courtZ + courtDepth * 0.2, 0.4, random);
  // The gold urn is the highest thing on the compound, not the upper ridge.
  return upper.ridgeY + 1.35;
};
