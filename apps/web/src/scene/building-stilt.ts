import { addDryingRack, addFirewood, addPottedPlant } from './building-props';
import { addGableRoof, addLeanRoof } from './building-roof';
import type { Builder } from './building-spec';
import { addChimney } from './building-trim';
import { addDoorway, addPiercedWall, addSash, paneMaterial } from './building-walls';

/**
 * A timber house is a frame first and a wall second, which is the opposite of
 * the concrete types: the posts carry the roof, and the walls are boards or
 * woven panels hung between them.
 */

/**
 * Nhà sàn. The floor stands clear of the ground on posts, which is what keeps
 * it dry and lets the livestock live underneath — so the space below the floor
 * is modelled too, and the stair is the front door.
 */
export const buildStiltHouse: Builder = (sink, kit, spec) => {
  const { width, depth, random } = spec;
  const floorY = 1.85 + random() * 0.35;
  const wallHeight = 2.4;
  const wallTop = floorY + wallHeight;
  const veranda = 1.5;
  const core = depth - veranda;
  const thatched = spec.variant % 3 !== 0;

  const postsX = Math.max(3, Math.round(width / 2.6));
  const postsZ = Math.max(2, Math.round(depth / 2.6));
  for (let i = 0; i < postsX; i += 1) {
    for (let j = 0; j < postsZ; j += 1) {
      const x = (-0.5 + i / (postsX - 1)) * (width - 0.5);
      const z = (-0.5 + j / (postsZ - 1)) * (depth - 0.5);
      sink.put(kit.geo.post, kit.mat.timberMid, x, floorY / 2, z, { sx: 0.22, sy: floorY, sz: 0.22 });
      // A flat stone under each post: a timber post set into the ground rots.
      sink.put(kit.geo.drum, kit.mat.stone, x, 0.07, z, { sx: 0.44, sy: 0.18, sz: 0.44 });
    }
  }
  sink.box(kit.mat.earth, 0, -spec.drop / 2, 0, width + 0.6, spec.drop + 0.12, depth + 0.6);

  for (const side of [-1, 1]) {
    sink.box(kit.mat.timberMid, 0, floorY - 0.14, (side * (depth - 0.4)) / 2, width, 0.18, 0.2);
  }
  sink.box(kit.mat.timberPale, 0, floorY - 0.04, 0, width, 0.1, depth);

  // Woven walls between the posts, with the veranda left open at the front.
  const coreZ = -depth / 2 + core / 2;
  const shell = sink.frame(0, 0, coreZ);
  const row = addPiercedWall(shell, {
    material: kit.mat.woven,
    width,
    baseY: floorY,
    height: wallHeight,
    z: core / 2 - 0.08,
    thickness: 0.14,
    openings: 2,
    openWidth: 0.85,
    sill: 0.95,
    head: 2.0,
  });
  shell.box(kit.mat.woven, 0, floorY + wallHeight / 2, -core / 2 + 0.08, width, wallHeight, 0.14);
  for (const side of [-1, 1]) {
    shell.box(kit.mat.woven, (side * (width - 0.14)) / 2, floorY + wallHeight / 2, 0, 0.14, wallHeight, core);
  }
  for (const centre of row.centres) {
    addSash(shell, kit, centre, floorY + 0.95, core / 2, row.width, 1.05, 0, {
      pane: paneMaterial(kit, random),
      frame: kit.mat.timberDark,
      shutters: kit.mat.timberMid,
      reveal: 0.1,
    });
  }

  const doorX = width * 0.18;
  addDoorway(shell, kit, doorX, floorY, core / 2, 1.0, 2.05, 0, kit.mat.timberMid, kit.mat.timberDark);

  // Veranda: posts carrying the eave, a plank deck and a rail to lean on.
  const verandaZ = depth / 2 - veranda / 2;
  for (const side of [-1, 1]) {
    sink.put(kit.geo.post, kit.mat.timberDark, (side * (width - 0.4)) / 2, floorY + wallHeight / 2, depth / 2 - 0.3, {
      sx: 0.18,
      sy: wallHeight,
      sz: 0.18,
    });
    sink.put(kit.panel.balustrade(veranda), kit.mat.bamboo, (side * (width - 0.3)) / 2, floorY, verandaZ, {
      sx: veranda,
      sy: 0.92,
      sz: 1,
      yaw: Math.PI / 2,
    });
  }
  sink.put(kit.panel.balustrade(width * 0.52), kit.mat.bamboo, -width * 0.24, floorY, depth / 2 - 0.12, {
    sx: width * 0.52,
    sy: 0.92,
    sz: 1,
  });

  // Cầu thang: the stair is the front door, so it faces the lane squarely.
  sink.put(kit.panel.steps(4), kit.mat.timberMid, doorX, 0, depth / 2 + 0.95, {
    sx: 1.15,
    sy: floorY,
    sz: 1.9,
    yaw: Math.PI,
  });
  for (const side of [-1, 1]) {
    sink.put(kit.geo.pipe, kit.mat.bamboo, doorX + side * 0.62, floorY * 0.75, depth / 2 + 0.95, {
      sx: 0.07,
      sy: 2.3,
      sz: 0.07,
      roll: Math.PI / 2,
      pitch: Math.atan2(1.9, floorY),
    });
  }

  // Under the floor: a lattice skirt, firewood and whatever lives down there.
  for (const side of [-1, 1]) {
    sink.put(kit.panel.lattice(core, floorY - 0.4), kit.mat.bamboo, (side * (width - 0.1)) / 2, 0.2, coreZ, {
      sx: core,
      sy: floorY - 0.4,
      sz: 1,
      yaw: Math.PI / 2,
    });
  }
  sink.put(kit.panel.lattice(width, floorY - 0.4), kit.mat.bamboo, 0, 0.2, -depth / 2 + 0.1, {
    sx: width,
    sy: floorY - 0.4,
    sz: 1,
  });
  addFirewood(sink, kit, -width * 0.26, 0, -depth * 0.12, 0);
  if (random() < 0.5) addDryingRack(sink, kit, 0, 0, depth / 2 + 2.6, Math.min(width, 3.2), 0);

  const roof = addGableRoof(sink, kit, {
    width,
    depth,
    wallTop,
    pitch: thatched ? 0.68 : 0.56,
    eave: 1.05,
    verge: 0.5,
    tile: thatched ? kit.mat.thatch : kit.mat.tileOld,
    timber: kit.mat.timberDark,
  });
  // The gable screens close the triangle the roof leaves at each end.
  const screen = roof.ridgeY - wallTop - 0.3;
  for (const side of [-1, 1]) {
    sink.put(kit.panel.lattice(depth * 0.6, screen), kit.mat.bamboo, (side * width) / 2, wallTop + 0.1, 0, {
      sx: depth * 0.6,
      sy: screen,
      sz: 1,
      yaw: Math.PI / 2,
    });
  }

  // Bếp: the kitchen is a lean-to off the back, and it is the only chimney.
  const kitchenWidth = Math.min(width * 0.55, 3.2);
  const kitchen = sink.frame(width * 0.2, 0, -depth / 2 - 1.1, Math.PI);
  kitchen.box(kit.mat.woven, 0, 1.15, -0.1, kitchenWidth, 2.3, 2.2);
  kitchen.box(kit.mat.earth, 0, 0.08, -0.1, kitchenWidth + 0.3, 0.16, 2.4);
  addLeanRoof(kitchen, kit, kitchenWidth + 0.5, 2.3, 2.55, 0.42, 0.45, kit.mat.tileOld, kit.mat.timberDark, false);
  addChimney(kitchen, kit, kitchenWidth * 0.3, -0.9, 1.4, 3.1, 0.42, kit.mat.brick);

  return roof.ridgeY;
};
