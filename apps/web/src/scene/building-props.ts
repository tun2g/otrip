import type { Prng } from '@otrip/world';

import type { BuildSink, BuildingKit } from './building-kit';

/**
 * The things that make a building look lived in rather than modelled: lanterns,
 * laundry, a scooter at the door, pot plants, the water tank on the roof. They
 * are shared because every building type wants them — a street of houses with
 * nothing in front of it reads as an architectural model, not a street.
 */

/** Đèn lồng. Hung from a cord, lit from inside once the sun is down. */
export const addLantern = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  size: number,
  warm: boolean,
  cord = 0.3
): void => {
  const silk = warm ? kit.mat.lanternGold : kit.mat.lanternRed;
  if (cord > 0) sink.box(kit.mat.timberDark, x, y + size * 0.5 + cord / 2, z, 0.02, cord, 0.02);
  sink.put(kit.geo.lantern, silk, x, y - size * 0.5, z, { size });
  sink.put(kit.geo.drum, kit.mat.timberDark, x, y + size * 0.47, z, { sx: size * 0.3, sy: 0.04, sz: size * 0.3 });
  sink.put(kit.geo.drum, kit.mat.timberDark, x, y - size * 0.47, z, { sx: size * 0.3, sy: 0.04, sz: size * 0.3 });
  sink.box(kit.mat.clothRed, x, y - size * 0.68, z, 0.03, size * 0.4, 0.03);
};

/**
 * A run of lanterns strung across a lane. The wire sags, which is the only
 * reason it reads as a wire and not a pipe.
 */
export const addLanternString = (
  sink: BuildSink,
  kit: BuildingKit,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  count: number,
  sag: number
): void => {
  const sampleY = (t: number) => ay + (by - ay) * t - Math.sin(Math.PI * t) * sag;
  const segments = Math.max(count + 1, 4);

  for (let i = 0; i < segments; i += 1) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const x0 = ax + (bx - ax) * t0;
    const z0 = az + (bz - az) * t0;
    const x1 = ax + (bx - ax) * t1;
    const z1 = az + (bz - az) * t1;
    const y0 = sampleY(t0);
    const y1 = sampleY(t1);
    const run = Math.hypot(x1 - x0, z1 - z0);

    sink.put(kit.geo.pipe, kit.mat.timberDark, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, {
      sx: 0.035,
      sy: Math.hypot(run, y1 - y0),
      sz: 0.035,
      yaw: Math.atan2(x1 - x0, z1 - z0),
      // The wire is a cylinder standing on its end, so tipping it a quarter
      // turn plus this segment's own slope lays it along the run.
      pitch: Math.PI / 2 - Math.atan2(y1 - y0, run),
    });
  }

  for (let i = 0; i < count; i += 1) {
    const t = (i + 0.5) / count;
    const at = sampleY(t) - 0.18;
    addLantern(sink, kit, ax + (bx - ax) * t, at, az + (bz - az) * t, 0.3 + (i % 3) * 0.04, i % 2 === 0, 0.14);
  }
};

export const addPottedPlant = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  size: number,
  random: Prng
): void => {
  sink.put(kit.geo.pot, kit.mat.brick, x, y + size * 0.16, z, { sx: size * 0.42, sy: size * 0.32, sz: size * 0.42 });
  sink.put(kit.geo.drum, kit.mat.earth, x, y + size * 0.3, z, { sx: size * 0.34, sy: 0.04, sz: size * 0.34 });

  const leaves = 3 + Math.floor(random() * 3);
  for (let i = 0; i < leaves; i += 1) {
    const angle = (i / leaves) * Math.PI * 2 + random();
    const reach = size * (0.1 + random() * 0.18);
    sink.put(
      random() > 0.4 ? kit.geo.leaf : kit.geo.cone,
      i % 2 === 0 ? kit.mat.foliage : kit.mat.foliageDark,
      x + Math.cos(angle) * reach,
      y + size * (0.42 + random() * 0.3),
      z + Math.sin(angle) * reach,
      { sx: size * 0.42, sy: size * (0.4 + random() * 0.4), sz: size * 0.42, roll: Math.cos(angle) * 0.3 }
    );
  }
};

/** Bể nước: stainless on a steel cradle, or the black plastic kind. */
export const addRoofTank = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  yaw: number,
  plastic: boolean
): void => {
  const length = plastic ? 1.1 : 1.5;
  const diameter = plastic ? 0.95 : 0.8;
  const frame = sink.frame(x, y, z, yaw);
  const shell = plastic ? kit.mat.grime : kit.mat.metal;

  for (const side of [-1, 1]) {
    frame.box(kit.mat.metalRust, side * (length * 0.32), 0.22, 0, 0.06, 0.44, diameter * 0.9);
  }
  frame.box(kit.mat.metalRust, 0, 0.44, 0, length, 0.06, diameter * 0.9);

  if (plastic) {
    frame.put(kit.geo.drum, shell, 0, 0.47 + diameter / 2, 0, { size: diameter });
    frame.put(kit.geo.drum, kit.mat.metal, 0, 0.47 + diameter + 0.04, 0, { sx: 0.26, sy: 0.1, sz: 0.26 });
  } else {
    frame.put(kit.geo.drum, shell, 0, 0.47 + diameter / 2, 0, {
      sx: diameter,
      sy: length,
      sz: diameter,
      roll: Math.PI / 2,
    });
    frame.put(kit.geo.pipe, kit.mat.metal, length * 0.52, 0.47 + diameter * 0.2, 0, { sx: 0.06, sy: 0.5, sz: 0.06 });
  }
};

export const addSatelliteDish = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  yaw: number
): void => {
  sink.put(kit.geo.pipe, kit.mat.metal, x, y + 0.3, z, { sx: 0.07, sy: 0.6, sz: 0.07 });
  const head = sink.frame(x, y + 0.6, z, yaw);
  head.put(kit.geo.dish, kit.mat.metalPale, 0, 0.3, 0.1, { sx: 0.95, sy: 0.5, sz: 0.95, pitch: -1.15 });
  head.box(kit.mat.metal, 0, 0.26, 0.42, 0.05, 0.05, 0.4);
  head.put(kit.geo.sphere, kit.mat.grime, 0, 0.24, 0.6, { size: 0.12 });
};

export const addAntenna = (sink: BuildSink, kit: BuildingKit, x: number, y: number, z: number, yaw: number): void => {
  const mast = sink.frame(x, y, z, yaw);
  mast.put(kit.geo.pipe, kit.mat.metal, 0, 1.3, 0, { sx: 0.05, sy: 2.6, sz: 0.05 });
  for (let i = 0; i < 5; i += 1) {
    mast.box(kit.mat.metal, 0, 1.3 + i * 0.26, 0, 0.03, 0.03, 1.1 - i * 0.13);
  }
  mast.box(kit.mat.metal, 0, 2.6, 0, 0.03, 0.03, 0.5);
};

export const addAirConditioner = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  yaw: number
): void => {
  const unit = sink.frame(x, y, z, yaw);
  unit.box(kit.mat.metalPale, 0, 0, 0.19, 0.78, 0.54, 0.34);
  unit.put(kit.geo.ring, kit.mat.grime, 0, 0, 0.37, { sx: 0.42, sy: 0.42, sz: 0.06, pitch: Math.PI / 2 });
  for (const side of [-1, 1]) unit.box(kit.mat.metalRust, 0, side * 0.34, 0.12, 0.06, 0.16, 0.2);
};

/** Quần áo phơi: the line, and whatever is drying on it. */
export const addWashingLine = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  length: number,
  yaw: number,
  random: Prng
): void => {
  const line = sink.frame(x, y, z, yaw);
  const cloths = [kit.mat.clothRed, kit.mat.clothTeal, kit.mat.clothCream];

  for (const side of [-1, 1]) {
    line.put(kit.geo.pipe, kit.mat.metal, side * (length / 2), 0.6, 0, { sx: 0.05, sy: 1.2, sz: 0.05 });
    line.box(kit.mat.metal, side * (length / 2), 1.18, 0, 0.04, 0.04, 0.4);
  }
  for (const offset of [-0.14, 0.14]) {
    line.box(kit.mat.rope, 0, 1.13, offset, length, 0.02, 0.02);
  }

  const items = 2 + Math.floor(random() * 4);
  for (let i = 0; i < items; i += 1) {
    const drop = 0.45 + random() * 0.35;
    line.box(
      cloths[Math.floor(random() * cloths.length)],
      (-0.5 + (i + 0.5) / items) * length * 0.92,
      1.12 - drop / 2,
      (i % 2 === 0 ? -0.14 : 0.14) + (random() - 0.5) * 0.04,
      0.3 + random() * 0.22,
      drop,
      0.03,
      (random() - 0.5) * 0.2
    );
  }
};

/** A fence from a to b, split into panels so one geometry covers any length. */
export const addFenceRun = (
  sink: BuildSink,
  kit: BuildingKit,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  y: number,
  height: number,
  bamboo: boolean
): void => {
  const run = Math.hypot(bx - ax, bz - az);
  if (run < 0.5) return;
  const spans = Math.max(1, Math.round(run / 3.2));
  const span = run / spans;
  const yaw = Math.atan2(-(bz - az), bx - ax);
  const material = bamboo ? kit.mat.bamboo : kit.mat.timberMid;

  for (let i = 0; i < spans; i += 1) {
    const t = (i + 0.5) / spans;
    sink.put(kit.panel.fence(span), material, ax + (bx - ax) * t, y, az + (bz - az) * t, {
      sx: span,
      sy: height,
      sz: 1,
      yaw,
    });
  }
};

export const addHaystack = (sink: BuildSink, kit: BuildingKit, x: number, y: number, z: number, size: number): void => {
  sink.put(kit.geo.post, kit.mat.timberMid, x, y + size * 0.6, z, { sx: 0.12, sy: size * 1.2, sz: 0.12 });
  sink.put(kit.geo.drum, kit.mat.straw, x, y + size * 0.32, z, { sx: size, sy: size * 0.64, sz: size });
  sink.put(kit.geo.cone, kit.mat.straw, x, y + size * 0.85, z, { sx: size * 1.05, sy: size * 0.5, sz: size * 1.05 });
  sink.box(kit.mat.rope, x, y + size * 0.45, z, size * 1.02, 0.03, 0.03);
};

/** Giàn phơi: bamboo poles carrying rice mats and split fish to dry. */
export const addDryingRack = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  length: number,
  yaw: number
): void => {
  const rack = sink.frame(x, y, z, yaw);
  for (const side of [-1, 1]) {
    rack.put(kit.geo.pipe, kit.mat.bamboo, side * (length / 2 - 0.2), 0.45, 0, { sx: 0.08, sy: 0.9, sz: 0.08 });
  }
  rack.put(kit.geo.pipe, kit.mat.bamboo, 0, 0.88, 0, { sx: 0.07, sy: length, sz: 0.07, roll: Math.PI / 2 });
  rack.box(kit.mat.woven, 0, 0.92, 0, length * 0.86, 0.04, 0.9);
  rack.box(kit.mat.produce, 0, 0.95, 0.22, length * 0.5, 0.05, 0.3);
};

export const addFirewood = (sink: BuildSink, kit: BuildingKit, x: number, y: number, z: number, yaw: number): void => {
  const stack = sink.frame(x, y, z, yaw);
  for (let row = 0; row < 3; row += 1) {
    for (let i = 0; i < 4; i += 1) {
      stack.put(kit.geo.pipe, kit.mat.timberMid, -0.3 + i * 0.2, 0.12 + row * 0.19, row % 2 === 0 ? 0 : 0.06, {
        sx: 0.17,
        sy: 1.1,
        sz: 0.17,
        roll: Math.PI / 2,
        yaw: row % 2 === 0 ? 0 : 0.08,
      });
    }
  }
};

/** Xe máy. Parked at the door of every house in the country. */
export const addScooter = (sink: BuildSink, kit: BuildingKit, x: number, y: number, z: number, yaw: number): void => {
  const bike = sink.frame(x, y, z, yaw);
  const body = kit.mat.lacquer;

  for (const at of [-0.62, 0.62]) {
    bike.put(kit.geo.ring, kit.mat.grime, at, 0.21, 0, { sx: 0.42, sy: 0.42, sz: 0.1, yaw: Math.PI / 2 });
  }
  bike.box(body, 0, 0.42, 0, 0.9, 0.22, 0.26);
  bike.box(kit.mat.timberDark, -0.1, 0.57, 0, 0.5, 0.1, 0.3);
  bike.box(body, 0.5, 0.52, 0, 0.3, 0.3, 0.22);
  bike.put(kit.geo.pipe, kit.mat.metal, 0.6, 0.5, 0, { sx: 0.06, sy: 0.6, sz: 0.06, roll: 0.26 });
  bike.box(kit.mat.metal, 0.66, 0.84, 0, 0.05, 0.05, 0.62);
  bike.put(kit.geo.drum, kit.mat.metalPale, 0.74, 0.74, 0, { sx: 0.16, sy: 0.08, sz: 0.16, roll: Math.PI / 2 });
  bike.put(kit.geo.pipe, kit.mat.metal, -0.5, 0.3, 0, { sx: 0.05, sy: 0.4, sz: 0.05, roll: -0.3 });
};

/** Quán nước: a tin tray table and plastic stools on the pavement. */
export const addStreetStall = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  random: Prng
): void => {
  sink.put(kit.geo.drum, kit.mat.metalPale, x, y + 0.42, z, { sx: 0.62, sy: 0.05, sz: 0.62 });
  for (let i = 0; i < 3; i += 1) {
    const angle = (i / 3) * Math.PI * 2;
    sink.put(kit.geo.pipe, kit.mat.metal, x + Math.cos(angle) * 0.22, y + 0.21, z + Math.sin(angle) * 0.22, {
      sx: 0.04,
      sy: 0.42,
      sz: 0.04,
    });
  }

  const stools = 2 + Math.floor(random() * 3);
  for (let i = 0; i < stools; i += 1) {
    const angle = random() * Math.PI * 2;
    const reach = 0.7 + random() * 0.35;
    const seat = i % 2 === 0 ? kit.mat.clothTeal : kit.mat.clothRed;
    const stool = sink.frame(x + Math.cos(angle) * reach, y, z + Math.sin(angle) * reach, random() * Math.PI);
    stool.put(kit.geo.pot, seat, 0, 0.14, 0, { sx: 0.3, sy: 0.28, sz: 0.3 });
    stool.put(kit.geo.drum, seat, 0, 0.29, 0, { sx: 0.34, sy: 0.04, sz: 0.34 });
  }
};

/** Giếng: a brick well with a windlass and a bucket on the rope. */
export const addWell = (sink: BuildSink, kit: BuildingKit, x: number, y: number, z: number): void => {
  sink.put(kit.geo.drum, kit.mat.brick, x, y + 0.34, z, { sx: 1.5, sy: 0.68, sz: 1.5 });
  sink.put(kit.geo.drum, kit.mat.stone, x, y + 0.7, z, { sx: 1.62, sy: 0.1, sz: 1.62 });
  sink.put(kit.geo.drum, kit.mat.grime, x, y + 0.6, z, { sx: 1.2, sy: 0.08, sz: 1.2 });
  for (const side of [-1, 1]) {
    sink.put(kit.geo.post, kit.mat.timberMid, x + side * 0.72, y + 1.3, z, { sx: 0.12, sy: 1.3, sz: 0.12 });
  }
  sink.put(kit.geo.post, kit.mat.timberDark, x, y + 1.92, z, { sx: 0.12, sy: 1.7, sz: 0.12, roll: Math.PI / 2 });
  sink.box(kit.mat.rope, x + 0.2, y + 1.5, z, 0.03, 0.8, 0.03);
  sink.put(kit.geo.pot, kit.mat.metalRust, x + 0.2, y + 1.05, z, { sx: 0.3, sy: 0.3, sz: 0.3 });
};

/** Lư hương on a stone plinth, with three sticks still burning in it. */
export const addIncenseUrn = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  size: number
): void => {
  sink.box(kit.mat.stone, x, y + size * 0.14, z, size * 1.1, size * 0.28, size * 1.1);
  sink.put(kit.geo.urn, kit.mat.gold, x, y + size * 0.28, z, { sx: size, sy: size * 0.95, sz: size });
  for (let i = 0; i < 3; i += 1) {
    sink.box(kit.mat.timberDark, x - 0.06 + i * 0.06, y + size * 1.25, z, 0.015, size * 0.5, 0.015, i * 0.2);
  }
};

export const addCrates = (
  sink: BuildSink,
  kit: BuildingKit,
  x: number,
  y: number,
  z: number,
  yaw: number,
  random: Prng
): void => {
  const pile = sink.frame(x, y, z, yaw);
  const count = 2 + Math.floor(random() * 3);
  for (let i = 0; i < count; i += 1) {
    pile.box(
      i % 2 === 0 ? kit.mat.woven : kit.mat.timberPale,
      (i % 2) * 0.62 - 0.31,
      0.17 + Math.floor(i / 2) * 0.34,
      (random() - 0.5) * 0.1,
      0.58,
      0.34,
      0.42,
      (random() - 0.5) * 0.3
    );
  }
  pile.put(kit.geo.sphere, kit.mat.produce, -0.31, 0.38, 0, { sx: 0.5, sy: 0.22, sz: 0.36 });
};
