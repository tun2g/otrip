import {
  addCrates,
  addDryingRack,
  addFenceRun,
  addFirewood,
  addHaystack,
  addLanternString,
  addWell,
} from './building-props';
import { addGableRoof, addLeanRoof } from './building-roof';
import type { Builder } from './building-spec';

/**
 * The structures that are not houses: the market, the granary, the pen and the
 * drying yard. All four are a roof or a kerb with the work of the village piled
 * under it, so almost all of the parts here are the contents rather than the
 * building — which is the point, because that is what makes a village look used.
 */

/**
 * Chợ. A roof on posts, which is the whole building; everything that makes it a
 * market is the stalls under it, so that is where the parts go.
 */
export const buildMarketShed: Builder = (sink, kit, spec) => {
  const { width, depth, random } = spec;
  const height = 3.4;
  const bays = Math.max(3, Math.round(width / 3.6));
  const rows = Math.max(2, Math.round(depth / 3.6));

  sink.box(kit.mat.screed, 0, 0.05, 0, width + 1.2, 0.14, depth + 1.2);
  sink.box(kit.mat.concreteWorn, 0, -spec.drop / 2, 0, width + 1.4, spec.drop + 0.1, depth + 1.4);

  for (let i = 0; i < bays; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      if (i > 0 && i < bays - 1 && j > 0 && j < rows - 1) continue;
      const x = (-0.5 + i / (bays - 1)) * width;
      const z = (-0.5 + j / (rows - 1)) * depth;
      sink.box(kit.mat.concrete, x, 0.2, z, 0.44, 0.4, 0.44);
      sink.put(kit.geo.post, kit.mat.metalRust, x, 0.4 + height / 2, z, { sx: 0.17, sy: height, sz: 0.17 });
      for (const brace of [-1, 1]) {
        sink.put(kit.geo.pipe, kit.mat.metalRust, x + brace * 0.3, 0.4 + height - 0.3, z, {
          sx: 0.07,
          sy: 0.85,
          sz: 0.07,
          roll: Math.PI / 4,
        });
      }
    }
  }
  for (const side of [-1, 1]) {
    sink.box(kit.mat.metalRust, 0, 0.4 + height, (side * depth) / 2, width + 0.4, 0.2, 0.16);
  }

  const roof = addGableRoof(sink, kit, {
    width,
    depth,
    wallTop: 0.4 + height + 0.1,
    pitch: 0.26,
    eave: 1.25,
    verge: 0.6,
    tile: kit.mat.metal,
    timber: kit.mat.metalRust,
    sheet: true,
  });

  // The stalls: a trestle, produce on it, a cloth over it, crates underneath.
  const stalls = Math.max(3, Math.round((width * depth) / 22));
  for (let i = 0; i < stalls; i += 1) {
    const stall = sink.frame(
      (random() - 0.5) * (width - 2.4),
      0.12,
      (random() - 0.5) * (depth - 2.4),
      random() * Math.PI
    );
    const bench = 1.6 + random() * 0.8;

    stall.box(kit.mat.timberPale, 0, 0.78, 0, bench, 0.08, 0.86);
    for (const side of [-1, 1]) {
      stall.box(kit.mat.timberMid, (side * (bench - 0.2)) / 2, 0.39, 0, 0.1, 0.78, 0.74);
    }

    const heaps = 2 + Math.floor(random() * 3);
    for (let h = 0; h < heaps; h += 1) {
      stall.put(
        kit.geo.sphere,
        h % 2 === 0 ? kit.mat.produce : kit.mat.foliage,
        (-0.5 + (h + 0.5) / heaps) * bench,
        0.92,
        0,
        {
          sx: bench / heaps - 0.08,
          sy: 0.22,
          sz: 0.6,
        }
      );
    }

    stall.box(random() < 0.5 ? kit.mat.clothTeal : kit.mat.clothCream, 0, 1.95, 0, bench + 0.4, 0.03, 1.2);
    for (const side of [-1, 1]) {
      stall.put(kit.geo.pipe, kit.mat.bamboo, (side * (bench + 0.2)) / 2, 1.0, 0, { sx: 0.05, sy: 2.0, sz: 0.05 });
    }
    if (random() < 0.5) addCrates(stall, kit, 0, 0, -0.7, 0, random);
  }

  addLanternString(sink, kit, -width / 2, roof.eaveY - 0.3, 0, width / 2, roof.eaveY - 0.3, 0, 5, 0.6);
  return roof.ridgeY;
};

/**
 * Bồ lúa. The rice store, which is why it stands on four posts with a disc
 * under the floor on each of them: that is the rat guard, and without it the
 * building makes no sense.
 */
export const buildGranary: Builder = (sink, kit, spec) => {
  const { width, depth, random } = spec;
  const floorY = 1.35;
  const wallHeight = 2.1;
  const wallTop = floorY + wallHeight;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = (sx * (width - 0.7)) / 2;
      const z = (sz * (depth - 0.7)) / 2;
      sink.put(kit.geo.drum, kit.mat.stone, x, 0.1, z, { sx: 0.5, sy: 0.2, sz: 0.5 });
      sink.put(kit.geo.post, kit.mat.timberMid, x, floorY / 2 + 0.1, z, { sx: 0.2, sy: floorY, sz: 0.2 });
      sink.put(kit.geo.dish, kit.mat.metalPale, x, floorY - 0.14, z, { sx: 0.76, sy: 0.3, sz: 0.76, pitch: Math.PI });
    }
  }
  sink.box(kit.mat.earth, 0, -spec.drop / 2, 0, width + 0.4, spec.drop + 0.1, depth + 0.4);

  sink.box(kit.mat.timberPale, 0, floorY, 0, width, 0.14, depth);
  for (const side of [-1, 1]) {
    sink.put(kit.panel.boarded(depth), kit.mat.timberMid, (side * width) / 2, floorY, 0, {
      sx: depth,
      sy: wallHeight,
      sz: 1,
      yaw: Math.PI / 2,
    });
    sink.put(kit.panel.boarded(width), kit.mat.timberMid, 0, floorY, (side * depth) / 2, {
      sx: width,
      sy: wallHeight,
      sz: 1,
    });
  }
  sink.put(kit.panel.boarded(0.9), kit.mat.timberDark, 0, floorY + 0.1, depth / 2 + 0.06, {
    sx: 0.9,
    sy: 1.5,
    sz: 1,
  });
  sink.put(kit.panel.ladder(floorY + 0.5), kit.mat.bamboo, -width * 0.25, 0, depth / 2 + 0.45, {
    sx: 0.75,
    sy: floorY + 0.5,
    sz: 1,
  });

  const roof = addGableRoof(sink, kit, {
    width,
    depth,
    wallTop,
    pitch: 0.62,
    eave: 0.7,
    verge: 0.4,
    tile: spec.variant % 2 === 0 ? kit.mat.thatch : kit.mat.tileOld,
    timber: kit.mat.timberDark,
  });

  if (random() < 0.6) addCrates(sink, kit, width * 0.6, 0, -depth * 0.2, 0.4, random);
  return roof.ridgeY;
};

/**
 * Chuồng. A fenced yard with a lean-to along one side, a trough and straw on
 * the ground. The shelter is corrugated because every one of them is.
 */
export const buildAnimalPen: Builder = (sink, kit, spec) => {
  const { width, depth, random } = spec;
  const shelterWidth = Math.min(width * 0.6, 4.2);
  const shelterDepth = 2.4;

  sink.box(kit.mat.earth, 0, 0.02, 0, width, 0.1, depth);
  addFenceRun(sink, kit, -width / 2, depth / 2, width / 2, depth / 2, 0, 1.15, true);
  for (const side of [-1, 1]) {
    addFenceRun(sink, kit, (side * width) / 2, -depth / 2, (side * width) / 2, depth / 2, 0, 1.15, true);
  }
  addFenceRun(sink, kit, -width / 2, -depth / 2, -width * 0.05, -depth / 2, 0, 1.15, true);

  const shelter = sink.frame(width * 0.15, 0, -depth / 2 + shelterDepth / 2);
  shelter.box(kit.mat.concreteWorn, 0, 0.09, 0, shelterWidth + 0.4, 0.18, shelterDepth + 0.4);
  for (const side of [-1, 1]) {
    shelter.put(kit.geo.post, kit.mat.timberMid, (side * shelterWidth) / 2, 1.15, shelterDepth / 2, {
      sx: 0.16,
      sy: 2.3,
      sz: 0.16,
    });
    shelter.put(kit.geo.post, kit.mat.timberMid, (side * shelterWidth) / 2, 1.4, -shelterDepth / 2, {
      sx: 0.16,
      sy: 2.8,
      sz: 0.16,
    });
    shelter.put(kit.panel.boarded(shelterDepth), kit.mat.timberMid, (side * shelterWidth) / 2, 0.18, 0, {
      sx: shelterDepth,
      sy: 1.9,
      sz: 1,
      yaw: Math.PI / 2,
    });
  }
  shelter.put(kit.panel.boarded(shelterWidth), kit.mat.timberMid, 0, 0.18, -shelterDepth / 2, {
    sx: shelterWidth,
    sy: 2.4,
    sz: 1,
  });
  addLeanRoof(shelter, kit, shelterWidth + 0.7, shelterDepth, 2.9, 0.3, 0.45, kit.mat.metal, kit.mat.metalRust, true);

  shelter.box(kit.mat.straw, 0, 0.22, shelterDepth * 0.2, shelterWidth * 0.8, 0.1, shelterDepth * 0.5);
  shelter.put(kit.geo.pot, kit.mat.concreteWorn, -shelterWidth * 0.3, 0.3, shelterDepth / 2 + 0.6, {
    sx: 1.2,
    sy: 0.42,
    sz: 0.6,
  });

  if (random() < 0.7) addHaystack(sink, kit, -width * 0.3, 0, depth * 0.2, 1.3 + random() * 0.5);
  if (random() < 0.5) addFirewood(sink, kit, width * 0.35, 0, depth * 0.25, random() * Math.PI);
  return 3.1;
};

/**
 * Sân phơi. A concrete pad with the rice spread on it in rows, which is the
 * single most common man-made surface in rural Vietnam and reads instantly.
 */
export const buildDryingYard: Builder = (sink, kit, spec) => {
  const { width, depth, random } = spec;

  sink.box(kit.mat.screed, 0, 0.05, 0, width, 0.14, depth);
  sink.box(kit.mat.concreteWorn, 0, -spec.drop / 2, 0, width + 0.2, spec.drop + 0.12, depth + 0.2);
  for (const side of [-1, 1]) {
    sink.box(kit.mat.concrete, 0, 0.14, (side * depth) / 2, width, 0.14, 0.24);
    sink.box(kit.mat.concrete, (side * width) / 2, 0.14, 0, 0.24, 0.14, depth);
  }

  const rows = Math.max(2, Math.floor(depth / 1.6));
  for (let i = 0; i < rows; i += 1) {
    if (random() < 0.25) continue;
    const z = (-0.5 + (i + 0.5) / rows) * (depth - 0.8);
    sink.box(kit.mat.straw, (random() - 0.5) * 0.6, 0.15, z, (width - 1) * (0.6 + random() * 0.4), 0.07, 1.1);
  }

  // Cái cào: the rake left standing in the heap, and the baskets beside it.
  const rakeX = (random() - 0.5) * width * 0.5;
  sink.put(kit.geo.pipe, kit.mat.bamboo, rakeX, 1.0, depth * 0.1, { sx: 0.05, sy: 2.0, sz: 0.05, roll: 0.22 });
  sink.box(kit.mat.timberMid, rakeX + 0.22, 0.18, depth * 0.1, 0.9, 0.06, 0.08);
  addCrates(sink, kit, width * 0.3, 0.12, -depth * 0.3, random() * Math.PI, random);
  addDryingRack(sink, kit, -width * 0.2, 0.12, -depth * 0.32, Math.min(width * 0.5, 3), 0);
  if (random() < 0.6) addHaystack(sink, kit, width * 0.38, 0, depth * 0.34, 1.4);
  if (random() < 0.4) addWell(sink, kit, -width * 0.36, 0.1, depth * 0.3);

  return 2.2;
};
