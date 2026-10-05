import type { MeshStandardMaterial } from 'three';

import type { BuildSink, BuildingKit } from './building-kit';
import {
  addAirConditioner,
  addAntenna,
  addPottedPlant,
  addRoofTank,
  addSatelliteDish,
  addScooter,
  addWashingLine,
} from './building-props';
import type { BuildSpec, Builder } from './building-spec';
import { addAwning, addBalcony, addParapet, addSignBoard } from './building-trim';
import { addDoorway, addPiercedWall, addPlinth, addSash, addWeathering, paneMaterial } from './building-walls';

/**
 * The two concrete types: nhà ống and the low-rise block. Both are a stack of
 * storeys behind a street façade with a flat roof on top, and on that roof is
 * where a Vietnamese town keeps its water, its aerials and its washing — which
 * is why the roof gets as much attention here as the front door.
 */

const WALL = 0.22;

/** Everything that happens on a flat roof once the parapet is up. */
const addRoofscape = (
  sink: BuildSink,
  kit: BuildingKit,
  spec: BuildSpec,
  width: number,
  depth: number,
  top: number
): number => {
  const { random } = spec;
  const parapet = 0.95;
  sink.box(kit.mat.screed, 0, top - 0.08, 0, width, 0.16, depth);
  addParapet(sink, kit, width, depth, top, parapet, kit.mat.concrete);

  // Lồng cầu thang: the stair comes up through the roof in its own hut.
  const hutWidth = Math.min(2.6, width * 0.5);
  const hutZ = -depth / 2 + 1.6;
  sink.box(kit.mat.concrete, width * 0.22, top + 1.25, hutZ, hutWidth, 2.5, 2.4);
  sink.box(kit.mat.tileDark, width * 0.22, top + 2.56, hutZ, hutWidth + 0.3, 0.12, 2.7);
  sink.box(kit.mat.glass, width * 0.22, top + 1.5, hutZ + 1.22, 0.9, 1.1, 0.06);

  let highest = top + 2.62;

  const tanks = 1 + (random() < 0.45 ? 1 : 0);
  for (let i = 0; i < tanks; i += 1) {
    addRoofTank(sink, kit, -width * 0.22 + i * 1.5, top, hutZ + 0.4, Math.PI / 2, i % 2 === 1);
    highest = Math.max(highest, top + 1.8);
  }

  if (random() < 0.62) {
    addSatelliteDish(sink, kit, width * 0.3, top + parapet, depth / 2 - 0.5, 0.6 + random());
    highest = Math.max(highest, top + parapet + 1.1);
  }
  if (random() < 0.5) {
    addAntenna(sink, kit, -width * 0.36, top, -depth / 2 + 0.6, random() * Math.PI);
    highest = Math.max(highest, top + 2.6);
  }

  addWashingLine(sink, kit, 0, top, depth * 0.18, Math.min(width - 1, 3.6), 0, random);
  const plants = 1 + Math.floor(random() * 3);
  for (let i = 0; i < plants; i += 1) {
    addPottedPlant(sink, kit, (random() - 0.5) * (width - 1.2), top, depth / 2 - 0.7, 0.5 + random() * 0.3, random);
  }

  return highest;
};

/** A shopfront: glazing or a shutter, a door beside it, an awning and a sign. */
const addShopfront = (
  sink: BuildSink,
  kit: BuildingKit,
  spec: BuildSpec,
  inner: number,
  faceZ: number,
  storeyTop: number,
  wall: MeshStandardMaterial
): void => {
  const { random } = spec;
  const head = Math.min(2.9, storeyTop - 0.7);
  const pier = 0.28;
  const open = inner - pier * 2;

  for (const side of [-1, 1]) {
    sink.box(wall, (side * (inner - pier)) / 2, head / 2, faceZ, pier, head, WALL);
  }
  sink.box(wall, 0, (head + storeyTop) / 2, faceZ, inner, storeyTop - head, WALL);
  sink.box(kit.mat.concreteWorn, 0, head + 0.11, faceZ, inner + 0.12, 0.22, WALL + 0.09);

  const doorWidth = Math.min(1.1, open * 0.34);
  const glazed = open - doorWidth - 0.14;
  const doorX = open / 2 - doorWidth / 2;
  const glazeX = -open / 2 + glazed / 2;

  sink.box(wall, doorX - doorWidth / 2 - 0.07, head / 2, faceZ, 0.14, head, WALL);

  if (random() < 0.3) {
    sink.put(kit.panel.roller(head), kit.mat.metalPale, glazeX, 0, faceZ + WALL / 2, {
      sx: glazed,
      sy: head,
      sz: 1,
    });
  } else {
    sink.box(kit.mat.shopGlow, glazeX, head / 2 - 0.1, faceZ - 0.1, glazed - 0.1, head - 0.5, 0.06);
    sink.put(kit.panel.sash(glazed, head - 0.4), kit.mat.metal, glazeX, 0.3, faceZ + 0.02, {
      sx: glazed,
      sy: head - 0.4,
      sz: 1,
    });
    sink.box(kit.mat.screed, glazeX, 0.15, faceZ + 0.04, glazed, 0.3, WALL + 0.1);
  }

  addDoorway(sink, kit, doorX, 0, faceZ + WALL / 2, doorWidth, 2.3, 0, kit.mat.timberMid, kit.mat.timberDark);

  const awningY = head + 0.34;
  addAwning(sink, kit, awningY, faceZ + WALL / 2, inner, 1.35, random() < 0.5 ? kit.mat.clothRed : kit.mat.clothTeal);
  addSignBoard(sink, kit, 0, awningY + 0.5, faceZ + WALL / 2, inner * 0.82, 0.78, random() < 0.7);
};

/**
 * Nhà ống. Narrow at the street and very deep, because it is taxed on its
 * frontage: four metres of façade carrying a shop, then three floors of
 * balconies above it and a water tank on the roof.
 */
export const buildTubeHouse: Builder = (sink, kit, spec) => {
  const { width, depth, storeys, random } = spec;
  const wall = kit.mat.plaster[spec.variant % kit.mat.plaster.length];
  const inner = width - WALL * 2;
  const front = depth / 2 - WALL / 2;
  const groundTop = 3.9;
  const storey = 3.25;
  const top = groundTop + (storeys - 1) * storey;

  addPlinth(sink, kit, width, depth, 0.32, spec.drop, kit.mat.stone);

  for (const side of [-1, 1]) {
    sink.box(wall, (side * (width - WALL)) / 2, top / 2, 0, WALL, top, depth);
    // A party wall standing proud of the façade is what separates one house in
    // a terrace from the next; without it a row reads as one long building.
    if (spec.terrace) {
      sink.box(kit.mat.concreteWorn, (side * width) / 2, top / 2, front + 0.1, 0.1, top + 0.25, 0.3);
    }
  }

  addShopfront(sink, kit, spec, inner, front, groundTop, wall);

  for (let level = 1; level < storeys; level += 1) {
    const base = groundTop + (level - 1) * storey;
    sink.box(kit.mat.concrete, 0, base + 0.09, 0, inner, 0.18, depth - WALL * 2);

    const row = addPiercedWall(sink, {
      material: wall,
      width: inner,
      baseY: base,
      height: storey,
      z: front,
      thickness: WALL,
      openings: inner > 4.4 ? 3 : 2,
      openWidth: 1.15,
      sill: 0.12,
      head: 2.42,
      lintel: kit.mat.concreteWorn,
    });

    addBalcony(sink, kit, base, front + WALL / 2, inner + 0.5, 1.15, kit.mat.concrete, kit.mat.metal);
    for (const centre of row.centres) {
      addSash(sink, kit, centre, row.sillY, row.faceZ, row.width, row.headY - row.sillY, 0, {
        pane: paneMaterial(kit, random),
        frame: kit.mat.metalPale,
        sill: kit.mat.concreteWorn,
        shutters: random() < 0.4 ? kit.mat.timberMid : undefined,
      });
    }

    // Back rooms are kitchens and bathrooms: one small barred window each.
    const rear = addPiercedWall(sink, {
      material: wall,
      width: inner,
      baseY: base,
      height: storey,
      z: -front,
      thickness: WALL,
      openings: 1,
      openWidth: 0.9,
      sill: 1.3,
      head: 2.5,
    });
    for (const centre of rear.centres) {
      addSash(sink, kit, centre, rear.sillY, -front - WALL / 2, rear.width, 1.2, Math.PI, {
        pane: paneMaterial(kit, random),
        frame: kit.mat.metalPale,
        grille: true,
      });
    }

    if (level < storeys - 1 && random() < 0.6) {
      const side = random() < 0.5 ? 1 : -1;
      addAirConditioner(sink, kit, (side * width) / 2, base + 2.1, depth * 0.1, (side * Math.PI) / 2);
    }
  }

  addWeathering(sink, kit, width, depth, 0, random);
  const highest = addRoofscape(sink, kit, spec, width, depth, top);

  if (random() < 0.7) addScooter(sink, kit, width * 0.15, 0, depth / 2 + 1.1, Math.PI / 2 + random() * 0.4);
  addPottedPlant(sink, kit, -width * 0.3, 0, depth / 2 + 0.7, 0.55, random);

  return highest;
};

/**
 * The low-rise concrete block of a Hanoi street: a wide frontage, shops on the
 * ground floor, and continuous balconies above that every flat has hung
 * something off. Taller than a nhà ống but built the same way.
 */
export const buildBlock: Builder = (sink, kit, spec) => {
  const { width, depth, storeys, random } = spec;
  const wall = kit.mat.plaster[spec.variant % kit.mat.plaster.length];
  const inner = width - WALL * 2;
  const front = depth / 2 - WALL / 2;
  const groundTop = 4.2;
  const storey = 3.2;
  const top = groundTop + (storeys - 1) * storey;
  const bays = Math.max(2, Math.round(inner / 4.2));

  addPlinth(sink, kit, width, depth, 0.36, spec.drop, kit.mat.concrete);

  for (const side of [-1, 1]) {
    sink.box(kit.mat.concrete, (side * (width - WALL)) / 2, top / 2, 0, WALL, top, depth);
  }
  sink.box(kit.mat.concrete, 0, top / 2, -front, inner, top, WALL);

  // The ground floor is a run of lock-up shops behind a continuous arcade beam.
  const shops = Math.max(1, Math.round(inner / 5));
  const shopWidth = inner / shops;
  for (let i = 0; i < shops; i += 1) {
    const unit = sink.frame(-inner / 2 + shopWidth * (i + 0.5), 0, 0);
    addShopfront(unit, kit, spec, shopWidth - 0.16, front, groundTop, wall);
  }
  for (const side of [-1, 1]) {
    sink.box(kit.mat.concreteWorn, (side * inner) / 2, groundTop / 2, front, 0.3, groundTop, WALL + 0.06);
  }

  for (let level = 1; level < storeys; level += 1) {
    const base = groundTop + (level - 1) * storey;
    sink.box(kit.mat.concrete, 0, base + 0.1, 0, inner, 0.2, depth - WALL * 2);

    const row = addPiercedWall(sink, {
      material: wall,
      width: inner,
      baseY: base,
      height: storey,
      z: front,
      thickness: WALL,
      openings: bays,
      openWidth: 1.9,
      sill: 0.9,
      head: 2.5,
      lintel: kit.mat.concreteWorn,
    });

    addBalcony(sink, kit, base, front + WALL / 2, inner + 0.4, 1.3, kit.mat.concrete, kit.mat.metal);
    for (const centre of row.centres) {
      addSash(sink, kit, centre, row.sillY, row.faceZ, row.width, row.headY - row.sillY, 0, {
        pane: paneMaterial(kit, random),
        frame: kit.mat.metalPale,
        sill: kit.mat.concreteWorn,
      });
      if (random() < 0.45) {
        addAirConditioner(sink, kit, centre + row.width * 0.6, base + 1.1, front + 0.5, 0);
      }
    }

    // Flank windows, which is where the stair and the light wells come out.
    for (const side of [-1, 1]) {
      if (random() > 0.62) continue;
      addSash(
        sink,
        kit,
        (side * width) / 2,
        base + 1.1,
        (random() - 0.5) * depth * 0.5,
        1.0,
        1.4,
        (side * Math.PI) / 2,
        {
          pane: paneMaterial(kit, random),
          frame: kit.mat.metalPale,
          grille: true,
          reveal: 0.1,
        }
      );
    }

    if (random() < 0.5) {
      addWashingLine(sink, kit, (random() - 0.5) * inner * 0.6, base + 0.2, front + 1.2, 1.9, 0, random);
    }
  }

  addWeathering(sink, kit, width, depth, 0, random);
  return addRoofscape(sink, kit, spec, width, depth, top);
};
