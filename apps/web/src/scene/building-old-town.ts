import { addLantern, addPottedPlant, addScooter } from './building-props';
import { addGableRoof } from './building-roof';
import type { Builder } from './building-spec';
import { addChimney, addSignBoard } from './building-trim';
import { addDoorway, addPiercedWall, addPlinth, addSash, addWeathering, paneMaterial } from './building-walls';

/** Deepest a single tiled gable can span before its ridge gets absurd. */
const MAX_SPAN = 8.4;

/**
 * Nhà cổ Hội An. Ochre lime wash, a mezzanine behind the shutters, and a tiled
 * roof whose overhang is what keeps the wash off the wall — so the eave is
 * deep, the rafter tails show, and the lanterns hang from them.
 *
 * A deep plan is two blocks with a yard between them, as the real ones are: one
 * roof over eighteen metres of depth would put the ridge five metres too high.
 */
export const buildOldTownHouse: Builder = (sink, kit, spec) => {
  const { width, depth, random } = spec;
  const wall = spec.variant % 3 === 0 ? kit.mat.ochreDeep : kit.mat.ochre;
  const thickness = 0.28;
  const groundTop = 3.7;
  const wallTop = groundTop + 2.95;
  const tile = spec.variant % 2 === 0 ? kit.mat.tile : kit.mat.tileOld;

  const frontDepth = Math.min(depth, MAX_SPAN);
  // A light well wide enough to read as a gap between the two ridges.
  const rearDepth = depth - frontDepth - 3.2;
  const inner = width - thickness * 2;
  const front = frontDepth / 2 - thickness / 2;

  addPlinth(sink, kit, width, depth, 0.38, spec.drop, kit.mat.stone);

  const house = sink.frame(0, 0, depth / 2 - frontDepth / 2);
  for (const side of [-1, 1]) {
    house.box(wall, (side * (width - thickness)) / 2, wallTop / 2, 0, thickness, wallTop, frontDepth);
  }
  house.box(wall, 0, wallTop / 2, -front, inner, wallTop, thickness);

  // The shopfront is timber boards between two columns, not glass.
  const columns = 0.26;
  const open = inner - columns * 2;
  for (const side of [-1, 1]) {
    house.put(kit.geo.post, kit.mat.timberDark, (side * (inner - columns)) / 2, groundTop / 2, front + 0.05, {
      sx: columns,
      sy: groundTop,
      sz: columns,
    });
  }
  house.box(kit.mat.timberDark, 0, groundTop - 0.17, front + 0.04, inner, 0.34, thickness + 0.14);

  const doorWidth = 1.25;
  const boards = open - doorWidth - 0.2;
  house.put(kit.panel.boarded(boards), kit.mat.timberMid, -open / 2 + boards / 2, 0.02, front + 0.1, {
    sx: boards,
    sy: groundTop - 0.5,
    sz: 1,
  });
  house.box(kit.mat.shopGlow, -open / 2 + boards / 2, 1.4, front - 0.14, boards * 0.5, 1.5, 0.05);
  addDoorway(
    house,
    kit,
    open / 2 - doorWidth / 2,
    0,
    front + thickness / 2,
    doorWidth,
    2.5,
    0,
    kit.mat.timberDark,
    kit.mat.timberMid
  );
  house.put(kit.panel.lattice(doorWidth, 0.5), kit.mat.timberDark, open / 2 - doorWidth / 2, 2.55, front + 0.12, {
    sx: doorWidth,
    sy: 0.5,
    sz: 1,
  });

  // Mezzanine shutters above the shop: the floor the goods are hauled up to.
  const row = addPiercedWall(house, {
    material: wall,
    width: inner,
    baseY: groundTop + 0.34,
    height: wallTop - groundTop - 0.34,
    z: front,
    thickness,
    openings: inner > 6 ? 3 : 2,
    openWidth: 1.05,
    sill: 0.55,
    head: 2.35,
    lintel: kit.mat.timberDark,
  });
  for (const centre of row.centres) {
    addSash(house, kit, centre, row.sillY, row.faceZ, row.width, row.headY - row.sillY, 0, {
      pane: random() < 0.5 ? kit.mat.windowWarm : kit.mat.glass,
      frame: kit.mat.timberDark,
      shutters: kit.mat.timberDark,
      reveal: 0.16,
    });
  }

  // A shallow balcony on brackets, which is how it is done without a slab.
  const balconyZ = front + thickness / 2;
  house.box(kit.mat.timberMid, 0, row.sillY - 0.06, balconyZ + 0.3, inner, 0.11, 0.66);
  house.put(kit.panel.balustrade(inner), kit.mat.timberDark, 0, row.sillY, balconyZ + 0.58, {
    sx: inner,
    sy: 0.72,
    sz: 1,
  });
  for (const at of [-0.34, 0, 0.34]) {
    house.put(kit.geo.wedge, kit.mat.timberDark, at * inner, row.sillY - 0.5, balconyZ + 0.24, {
      sx: 0.1,
      sy: 0.44,
      sz: 0.46,
      yaw: Math.PI / 2,
    });
  }

  const roof = addGableRoof(house, kit, {
    width,
    depth: frontDepth,
    wallTop,
    pitch: 0.47,
    eave: 1.25,
    verge: 0.55,
    tile,
    timber: kit.mat.timberDark,
  });

  const lanterns = 2 + Math.floor(random() * 2);
  for (let i = 0; i < lanterns; i += 1) {
    const at = (-0.5 + (i + 0.5) / lanterns) * (width - 0.8);
    addLantern(house, kit, at, roof.eaveY - 0.75, frontDepth / 2 + 0.85, 0.42, i % 2 === 0, 0.32);
  }
  addSignBoard(house, kit, 0, groundTop + 0.05, front + thickness / 2 + 0.05, inner * 0.6, 0.62, true);

  // Nhà sau: the back block across a yard, lower and with the kitchen in it.
  if (rearDepth > 3) {
    const rear = sink.frame(0, 0, -depth / 2 + rearDepth / 2);
    const rearTop = 3.5;
    rear.box(wall, 0, rearTop / 2, -rearDepth / 2 + thickness / 2, inner, rearTop, thickness);
    for (const side of [-1, 1]) {
      rear.box(wall, (side * (width - thickness)) / 2, rearTop / 2, 0, thickness, rearTop, rearDepth);
    }
    const yard = addPiercedWall(rear, {
      material: wall,
      width: inner,
      baseY: 0,
      height: rearTop,
      z: rearDepth / 2 - thickness / 2,
      thickness,
      openings: 2,
      openWidth: 1.0,
      sill: 0.9,
      head: 2.3,
      lintel: kit.mat.timberDark,
    });
    for (const centre of yard.centres) {
      addSash(rear, kit, centre, yard.sillY, yard.faceZ, yard.width, yard.headY - yard.sillY, 0, {
        pane: paneMaterial(kit, random),
        frame: kit.mat.timberDark,
        shutters: kit.mat.timberDark,
      });
    }
    addGableRoof(rear, kit, {
      width,
      depth: rearDepth,
      wallTop: rearTop,
      pitch: 0.44,
      eave: 0.85,
      verge: 0.4,
      tile: kit.mat.tileOld,
      timber: kit.mat.timberDark,
    });
    addChimney(rear, kit, width * 0.3, -rearDepth * 0.2, rearTop, rearTop + 1.5, 0.4, kit.mat.brick);
    // The yard between the blocks is paved and holds the water jar.
    sink.box(kit.mat.paving, 0, 0.03, -depth / 2 + rearDepth + 1.1, width - 0.4, 0.08, 2.2);
    sink.put(kit.geo.jar, kit.mat.lacquer, width * 0.3, 0.06, -depth / 2 + rearDepth + 1.0, {
      sx: 0.8,
      sy: 0.95,
      sz: 0.8,
    });
    addPottedPlant(sink, kit, -width * 0.25, 0.08, -depth / 2 + rearDepth + 1.0, 0.8, random);
  }

  addWeathering(sink, kit, width, frontDepth, 0, random);
  addPottedPlant(sink, kit, -width * 0.36, 0, depth / 2 + 0.6, 0.6, random);
  if (random() < 0.45) addScooter(sink, kit, width * 0.22, 0, depth / 2 + 1.0, Math.PI / 2);

  return roof.ridgeY;
};
