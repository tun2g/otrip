import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  RepeatWrapping,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  type Material,
} from 'three';

import { BOAT_LENGTH } from './boat';
import type { Platform, WaterExit } from './walker';

/** Metres. A village jetty is one cart wide and no more. */
const DECK_WIDTH = 3;
const DECK_MIN = 13;
const DECK_MAX = 27;
/** Freeboard: high enough that a loaded boat's gunwale comes up under it. */
const DECK_RISE = 1.35;
/** Bays between bents. Any wider and the stringers would visibly sag. */
const BENT_SPACING = 2.6;
const PLANK_WIDTH = 0.22;
const PLANK_GAP = 0.012;
const PLANK_THICK = 0.045;
/** How far a pile is driven past the bed before it holds. */
const PILE_EMBED = 1.2;
const RAIL_HEIGHT = 0.95;
/** Draught of a laden thuyền, so the deck end needs at least this much water. */
const BOAT_DRAUGHT = 2.2;
/** Metres outboard of the deck edge a berth lies: far enough that a 3.8 m beam
 * clears the fenders, close enough to step across. */
const BERTH_OFFSET = 2.6;
/** Water a moored hull needs amidships. Its lofted ends draw far less, so they
 * are only required to be wet. */
const BERTH_DRAUGHT = 0.6;

const WOOD = ['#7a5f45', '#6b5239', '#866a4c', '#5f4a36', '#8e7355'];

export type Mooring = {
  x: number;
  y: number;
  z: number;
  /** Radians, ready to drop straight into the boat group's `rotation.y`. */
  yaw: number;
};

export type Dock = {
  group: Group;
  /** Where a boat lies alongside, bow pointing along `yaw`. */
  moorings: Mooring[];
  /** The plank deck, for anything that walks on it. */
  walkway: Platform;
  /** The deck and the landward ramp up to it, for the walker to stand on. */
  platforms: Platform[];
  /** The ladder and the washing steps — how a swimmer gets out. */
  exits: WaterExit[];
  update: (elapsed: number) => void;
  /**
   * Where the boats are, in world space. A line is only drawn to a berth that
   * has one lying in it: two berths are built and only the deeper one is ever
   * occupied, so one rope always hung out over open water — and steering the
   * moored boat away left the other one doing the same. A rope made fast to
   * nothing is the sort of detail that makes the rest of the jetty look painted
   * on. Separate from `update` so the jetty stays a plain ticked thing.
   */
  setHulls: (hulls: readonly { x: number; z: number }[]) => void;
  setNight: (amount: number) => void;
  dispose: () => void;
};

type Spin = { rx: number; ry: number; rz: number };

type Piece = Spin & {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  shade: number;
};

const STRAIGHT: Spin = { rx: 0, ry: 0, rz: 0 };

type Offshore = { heading: number; depth: number };

/**
 * Which way the water deepens. A jetty runs out along the bed's fall line, so
 * this is both where it should point and whether the spot is worth using.
 */
const deepestDirection = (terrain: Terrain, x: number, z: number, level: number): Offshore | null => {
  let heading = 0;
  let depth = -Infinity;

  for (let step = 0; step < 16; step += 1) {
    const angle = (step / 16) * Math.PI * 2;
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);

    let total = 0;
    for (const reach of [9, 17, 25]) total += level - terrain.heightAt(x + dirX * reach, z + dirZ * reach);
    const mean = total / 3;

    if (mean > depth) {
      depth = mean;
      heading = angle;
    }
  }

  return depth > 0.9 ? { heading, depth } : null;
};

export type DockSite = { x: number; z: number; heading: number; ground: number };

/**
 * The bank a village would have built on: shallow enough to stand on, gentle
 * enough to carry a load up, with real water within a jetty's length. Searched
 * on a fixed grid rather than sampled, so every reload picks the same spot.
 */
const findSite = (terrain: Terrain, level: number, buildings: { x: number; z: number }[]): DockSite | null => {
  const half = terrain.size / 2;
  // Measured: at 52 divisions the step is 70-80 m while a terrain cell is about
  // 20 m, so the search sampled one point in every fourteen cells and walked
  // straight over every landing. Tràng An — a flooded karst basin, 88% of it
  // under water, with only eleven candidates in the whole shoreline band at
  // that spacing — came out with no jetty at all, which for the destination
  // whose identity is the sampan tour is the worst possible place to lose one.
  // At this spacing it has seventeen, the gentlest on a 0.057 slope, so nothing
  // here needed loosening; the search just had to be as fine as the ground it
  // was searching. Fixed rather than tied to `terrain.segments` so the quality
  // tier does not move the jetty. Costs about 5 ms, once, at scene build.
  const divisions = 256;
  const step = terrain.size / divisions;

  let best: DockSite | null = null;
  let bestScore = -Infinity;

  for (let row = 1; row < divisions; row += 1) {
    for (let column = 1; column < divisions; column += 1) {
      const x = -half + column * step;
      const z = -half + row * step;

      const ground = terrain.heightAt(x, z);
      if (ground < level + 0.2 || ground > level + 2.6) continue;
      if (terrain.slopeAt(x, z) > 0.26) continue;

      const offshore = deepestDirection(terrain, x, z, level);
      if (!offshore) continue;

      // Near the houses if there are any; otherwise away from the map edge,
      // where a jetty stands in the falloff with nothing behind it.
      const pull =
        buildings.length > 0
          ? -Math.min(...buildings.map((building) => Math.hypot(x - building.x, z - building.z))) * 0.02
          : (-Math.hypot(x, z) / half) * 3;

      const score = Math.min(offshore.depth, 4.5) * 4 + pull;
      if (score <= bestScore) continue;

      bestScore = score;
      best = { x, z, heading: offshore.heading, ground };
    }
  }

  return best;
};

/**
 * Where the jetty goes, resolved before anything is built, because two things
 * need the answer: the jetty itself and the "Bến thuyền" marker that sends
 * people to it. Each working it out from its own rule is exactly how those two
 * ended up kilometres apart.
 */
export const findDockSite = (
  terrain: Terrain,
  recipe: LocationRecipe,
  /** Where the houses are, so the jetty lands at the village and not behind it. */
  buildings: { x: number; z: number }[] = []
): DockSite | null => (recipe.water ? findSite(terrain, recipe.water.level, buildings) : null);

/** A woven net as a repeating alpha pattern — two families of diagonal cords. */
const createNetTexture = (): DataTexture => {
  const size = 64;
  const pitch = 8;
  const cord = 2;
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const woven = (x + y) % pitch < cord || (x - y + size) % pitch < cord;
      data[index] = 226;
      data[index + 1] = 218;
      data[index + 2] = 186;
      data[index + 3] = woven ? 255 : 0;
    }
  }

  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(4, 3);
  texture.needsUpdate = true;
  return texture;
};

/** A net hung from its top edge: it bellies out and draws in at the bottom. */
const createNetGeometry = (width: number, height: number): BufferGeometry => {
  const geometry = new PlaneGeometry(width, height, 8, 6);
  const position = geometry.getAttribute('position');

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const drop = (height / 2 - y) / height;
    const belly = Math.sin((x / width + 0.5) * Math.PI);

    position.setZ(i, belly * drop * 0.3);
    position.setY(i, y + drop * drop * height * 0.12);
  }

  geometry.computeVertexNormals();
  return geometry;
};

/** A mooring line from the bollard head, sagging under its own weight. */
const createRopeGeometry = (to: Vector3, sag: number): BufferGeometry => {
  const points: Vector3[] = [];
  for (let i = 0; i <= 7; i += 1) {
    const t = i / 7;
    points.push(new Vector3(to.x * t, to.y * t - Math.sin(Math.PI * t) ** 0.85 * sag, to.z * t));
  }
  return new TubeGeometry(new CatmullRomCurve3(points), 20, 0.026, 5, false);
};

/**
 * Bến thuyền. Built the way one is built: piles driven until they hold, caps and
 * stringers across them, planks laid one at a time with a gap to let the river
 * through, then everything a working jetty accumulates — bollards with lines out
 * to the boats, tyres for fenders, a ladder, washing steps, drying nets, crates,
 * a lamp, and somewhere for the boatman to sit out of the sun.
 *
 * The carpentry is three instanced batches — boxes, round timber and roof tiles —
 * because two hundred individually placed boards should still be three draws.
 */
export const createDock = (
  terrain: Terrain,
  recipe: LocationRecipe,
  /** From `findDockSite`, shared with the POI that names this jetty. */
  site: DockSite | null
): Dock | null => {
  if (!recipe.water || !site) return null;

  const level = recipe.water.level;

  const random = createPrng(`${recipe.seed}:dock`);
  const forwardX = Math.sin(site.heading);
  const forwardZ = Math.cos(site.heading);
  const acrossX = forwardZ;
  const acrossZ = -forwardX;

  const toWorldX = (lx: number, lz: number) => site.x + acrossX * lx + forwardX * lz;
  const toWorldZ = (lx: number, lz: number) => site.z + acrossZ * lx + forwardZ * lz;
  const bedAt = (lx: number, lz: number) => terrain.heightAt(toWorldX(lx, lz), toWorldZ(lx, lz));

  // Out until the water is deep enough to lie a loaded boat against the end.
  let deckLength = DECK_MIN;
  for (let reach = DECK_MIN; reach <= DECK_MAX; reach += 1) {
    deckLength = reach;
    if (level - bedAt(0, reach) >= BOAT_DRAUGHT) break;
  }

  const deckY = Math.max(level + DECK_RISE, site.ground + 0.5);
  const halfWidth = DECK_WIDTH / 2;
  const capTop = deckY - PLANK_THICK - 0.2;
  const pileTop = capTop - 0.18;

  const timber: Piece[] = [];
  const round: Piece[] = [];
  const tiles: Piece[] = [];

  const shade = () => Math.floor(random() * WOOD.length);

  const beam = (x: number, y: number, z: number, sx: number, sy: number, sz: number, spin: Spin = STRAIGHT) =>
    timber.push({ x, y, z, ...spin, sx, sy, sz, shade: shade() });

  /** A round timber hanging from its head, which is where a drawing measures. */
  const pole = (x: number, y: number, z: number, radius: number, length: number, spin: Spin = STRAIGHT) =>
    round.push({ x, y, z, ...spin, sx: radius * 2, sy: length, sz: radius * 2, shade: shade() });

  // --- bents: a pair of piles, a cap, and the bracing that stops it racking --
  const bents = Math.max(5, Math.round((deckLength - 1.2) / BENT_SPACING) + 1);
  for (let i = 0; i < bents; i += 1) {
    const lz = 0.6 + (i / (bents - 1)) * (deckLength - 1.2);
    const bed = bedAt(0, lz);

    for (const side of [-1, 1]) {
      pole(side * (halfWidth - 0.15), pileTop, lz, 0.125, pileTop - (bed - PILE_EMBED));
    }

    beam(0, capTop - 0.09, lz, DECK_WIDTH + 0.14, 0.18, 0.18);

    // Cross-bracing, but only where there is air to put it in.
    const low = Math.max(bed, level) + 0.3;
    const high = pileTop - 0.35;
    if (high - low > 1) {
      const span = (halfWidth - 0.15) * 2;
      const rise = high - low;
      const diagonal = Math.hypot(span, rise);
      const angle = Math.atan2(rise, span);
      for (const direction of [1, -1]) {
        beam(0, (low + high) / 2, lz, diagonal, 0.09, 0.07, { rx: 0, ry: 0, rz: angle * direction });
      }
    }

    // The handrail stands on the bents, where there is something to bolt to.
    if (i > 0 && i < bents - 1) pole(-(halfWidth - 0.1), deckY + RAIL_HEIGHT, lz, 0.045, RAIL_HEIGHT);
  }

  // --- stringers, in scarfed lengths rather than one impossible timber ------
  for (const lx of [-1.25, 0, 1.25]) {
    for (let i = 0; i < 2; i += 1) {
      const length = (deckLength - 0.1) / 2;
      beam(lx, capTop + 0.1, 0.05 + length * (i + 0.5), 0.12, 0.2, length - 0.04);
    }
  }

  // --- the deck, board by board --------------------------------------------
  const planks = Math.floor(deckLength / (PLANK_WIDTH + PLANK_GAP));
  for (let i = 0; i < planks; i += 1) {
    // Worn boards: a short one here and there, none of them quite square, and a
    // millimetre of cup so the deck catches the light unevenly.
    const short = random() < 0.12;
    beam(
      short ? (random() - 0.5) * 0.1 : 0,
      deckY - PLANK_THICK / 2 + (random() - 0.5) * 0.008,
      (i + 0.5) * (PLANK_WIDTH + PLANK_GAP),
      short ? DECK_WIDTH - 0.07 : DECK_WIDTH,
      PLANK_THICK,
      PLANK_WIDTH,
      { rx: 0, ry: (random() - 0.5) * 0.009, rz: 0 }
    );
  }

  // --- the rails those posts carry -----------------------------------------
  for (const height of [RAIL_HEIGHT, RAIL_HEIGHT * 0.52]) {
    for (let i = 0; i < 2; i += 1) {
      const length = (deckLength - 2) / 2;
      pole(-(halfWidth - 0.1), deckY + height, 1 + length * (i + 0.5), height > 0.8 ? 0.042 : 0.032, length - 0.06, {
        rx: Math.PI / 2,
        ry: 0,
        rz: 0,
      });
    }
  }

  // --- steps up from the bank ----------------------------------------------
  for (let i = 0; i < 3; i += 1) {
    const t = (i + 1) / 3;
    const lz = -1.7 + t * 1.7;
    const y = site.ground + (deckY - site.ground) * t;
    beam(0, y - 0.06, lz, 2.4, 0.12, 0.56);
    for (const side of [-1, 1]) pole(side, y - 0.12, lz, 0.05, 0.7);
  }

  // --- the washing steps, going the other way: down into the water ---------
  const stepsX = halfWidth + 1.05;
  const stepTop = Math.max(site.ground, level + 0.3);
  const stepFoot = level - 0.55;
  const waterSteps = 4;
  for (let i = 0; i < waterSteps; i += 1) {
    const t = i / (waterSteps - 1);
    const lz = 1.5 + t * 1.9;
    const y = stepTop + (stepFoot - stepTop) * t;
    beam(stepsX, y - 0.07, lz, 1.7, 0.14, 0.52);
    for (const side of [-1, 1]) {
      const legX = stepsX + side * 0.6;
      pole(legX, y - 0.14, lz, 0.055, y - 0.14 - (bedAt(legX, lz) - 0.4));
    }
  }

  // --- the ladder off the end ----------------------------------------------
  const ladderZ = deckLength + 0.14;
  const ladderFoot = level - 0.75;
  for (const side of [-1, 1]) pole(side * 0.34, deckY + 0.14, ladderZ, 0.035, deckY + 0.14 - ladderFoot);
  const rungs = 5;
  for (let i = 0; i < rungs; i += 1) {
    const drop = (deckY - 0.12 - ladderFoot) / (rungs - 1);
    pole(0, deckY - 0.12 - i * drop, ladderZ, 0.028, 0.74, { rx: 0, ry: 0, rz: Math.PI / 2 });
  }

  // --- bollards, and the lines out to the boats ----------------------------
  const moorings: Mooring[] = [];
  const ropes: { pivot: Object3D; geometry: BufferGeometry; phase: number; berth: { x: number; z: number } }[] = [];

  /**
   * A berth has to float the whole hull, not just the point the line is made
   * fast to. Measured at all four quality tiers, the bollard's own station left
   * a 14.5 m hull's stern 0.1-1.0 m *above* the waterline at ten of the twelve
   * jetties — a boat planted in the bank — because the station was a fraction
   * of the deck and knew nothing of how long a boat is. So the berth walks
   * seaward from the bollard until the hull is afloat along its length, and
   * reports nothing if it never is.
   */
  const berthAlongside = (lx: number, from: number): number | null => {
    for (let lz = from; lz <= deckLength; lz += 0.6) {
      let afloat = true;
      for (let t = -0.5; t <= 0.5001 && afloat; t += 0.05) {
        const clearance = level - bedAt(lx, lz + t * BOAT_LENGTH);
        afloat = clearance > (Math.abs(t) < 0.3 ? BERTH_DRAUGHT : 0);
      }
      if (afloat) return lz;
    }
    return null;
  };

  [deckLength * 0.36, deckLength * 0.74].forEach((lz, index) => {
    const side = index === 0 ? 1 : -1;
    const lx = side * (halfWidth - 0.08);
    const headY = deckY + 1.05;

    pole(lx, headY, lz, 0.135, 1.35);
    // The head, which is the only reason a rope stays on a bollard.
    pole(lx, headY + 0.09, lz, 0.17, 0.09);

    const berthX = side * (halfWidth + BERTH_OFFSET);
    const berthZ = berthAlongside(berthX, lz + 1.4);
    // No rope either: a line running taut into empty water is worse than a bare
    // bollard, and this is the one berth on the jetty nothing can lie in.
    if (berthZ === null) return;

    moorings.push({
      x: toWorldX(berthX, berthZ),
      y: level,
      z: toWorldZ(berthX, berthZ),
      yaw: site.heading,
    });

    const pivot = new Object3D();
    pivot.position.set(lx, headY, lz);
    ropes.push({
      pivot,
      // Aimed at the boat's gunwale rather than its origin, so the line lands on
      // the hull instead of disappearing into the water beside it.
      geometry: createRopeGeometry(new Vector3(berthX - lx, level + 0.75 - headY, berthZ - 0.9 - lz), 0.55),
      phase: index * 2.1,
      berth: { x: toWorldX(berthX, berthZ), z: toWorldZ(berthX, berthZ) },
    });
  });

  // --- fenders: old tyres, hung over the side ------------------------------
  const tyres: Vector3[] = [];
  for (let i = 0; i < 3; i += 1) {
    const lz = deckLength * (0.28 + i * 0.22);
    const tyreY = level + 0.18;
    tyres.push(new Vector3(halfWidth + 0.08, tyreY, lz));
    pole(halfWidth + 0.02, deckY - 0.1, lz, 0.022, deckY - 0.1 - tyreY - 0.2);
  }

  // --- the boatman's shelter, on the bank behind the jetty head ------------
  const hutZ = -3.1;
  const floor = site.ground;
  for (const sideX of [-1, 1]) {
    for (const sideZ of [-1, 1]) pole(sideX * 1.15, floor + 2.15, hutZ + sideZ * 1.05, 0.075, 2.15);
  }
  for (const sideZ of [-1, 1]) beam(0, floor + 2.1, hutZ + sideZ * 1.05, 2.5, 0.12, 0.12);
  // Two walls only: the sun comes from one side and the river from the other.
  beam(-1.15, floor + 1.05, hutZ, 0.06, 1.5, 2.1);
  beam(0, floor + 1.05, hutZ - 1.05, 2.3, 1.5, 0.06);
  beam(0.35, floor + 0.44, hutZ, 0.42, 0.08, 1.5);
  for (const sideZ of [-1, 1]) pole(0.35, floor + 0.4, hutZ + sideZ * 0.6, 0.05, 0.4);

  const ridgeY = floor + 2.72;
  const eaveY = floor + 2.16;
  const roofRun = 1.42;
  const pitch = Math.atan2(ridgeY - eaveY, roofRun);
  const courses = 3;
  const along = 9;
  const tilePitch = 2.2 / along;

  beam(0, ridgeY, hutZ, 0.1, 0.1, 2.5);
  for (const side of [-1, 1]) {
    beam(side * roofRun * 0.5, (ridgeY + eaveY) / 2, hutZ, Math.hypot(roofRun, ridgeY - eaveY), 0.06, 2.4, {
      rx: 0,
      ry: 0,
      rz: -side * pitch,
    });

    for (let course = 0; course < courses; course += 1) {
      const run = (course + 0.5) / courses;
      for (let i = 0; i < along; i += 1) {
        tiles.push({
          x: side * roofRun * run,
          y: ridgeY - (ridgeY - eaveY) * run + 0.05,
          z: hutZ - 1.1 + (i + 0.5) * tilePitch,
          rx: 0,
          ry: 0,
          rz: -side * pitch,
          sx: 1,
          sy: tilePitch * 1.08,
          sz: 1,
          shade: 0,
        });
      }
    }
  }
  for (let i = 0; i < along; i += 1) {
    tiles.push({
      x: 0,
      y: ridgeY + 0.08,
      z: hutZ - 1.1 + (i + 0.5) * tilePitch,
      rx: 0,
      ry: Math.PI / 2,
      rz: 0,
      sx: 1.15,
      sy: tilePitch * 1.1,
      sz: 1.15,
      shade: 0,
    });
  }

  // --- crates, stacked where they were unloaded ----------------------------
  const crate = (lx: number, ly: number, lz: number, turn: number) => {
    const width = 0.62;
    const depth = 0.48;
    const height = 0.44;
    const spin = { rx: 0, ry: turn, rz: 0 };

    beam(lx, ly + height / 2, lz, width, height, depth, spin);
    for (const sideX of [-1, 1]) {
      for (const sideZ of [-1, 1]) {
        beam(
          lx + (Math.cos(turn) * sideX * width - Math.sin(turn) * sideZ * depth) * 0.5,
          ly + height / 2,
          lz + (Math.sin(turn) * sideX * width + Math.cos(turn) * sideZ * depth) * 0.5,
          0.06,
          height + 0.03,
          0.06,
          spin
        );
      }
    }
    beam(lx, ly + height * 0.78, lz, width + 0.04, 0.05, depth + 0.04, spin);
  };

  crate(-0.75, deckY, 4.4, 0.18);
  crate(-0.72, deckY + 0.44, 4.35, -0.1);
  crate(-0.8, deckY, 5.2, -0.42);

  // --- the drying frame and the lamp post ----------------------------------
  const frameZ = deckLength * 0.56;
  for (const sideZ of [-1, 1]) pole(-(halfWidth - 0.2), deckY + 2.05, frameZ + sideZ * 1.3, 0.055, 2.05);
  pole(-(halfWidth - 0.2), deckY + 2, frameZ, 0.045, 2.6, { rx: Math.PI / 2, ry: 0, rz: 0 });

  const lampZ = deckLength - 1.1;
  const lampX = -(halfWidth - 0.25);
  pole(lampX, deckY + 3.1, lampZ, 0.055, 3.1);

  // -------------------------------------------------------------------------
  // Everything above is measurements. Now it becomes meshes.
  // -------------------------------------------------------------------------

  const group = new Group();
  group.name = 'dock';
  group.position.set(site.x, 0, site.z);
  group.rotation.y = site.heading;

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const keep = <T extends BufferGeometry>(geometry: T): T => {
    geometries.push(geometry);
    return geometry;
  };
  const keepMaterial = <T extends Material>(material: T): T => {
    materials.push(material);
    return material;
  };

  /**
   * A white vertex colour so `instanceColor` survives to the fragment shader:
   * three only declares the colour varying when the geometry carries a `color`
   * attribute, and without it every board would come out the same shade.
   */
  const addWhite = <T extends BufferGeometry>(geometry: T): T => {
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(count * 3).fill(1), 3));
    return geometry;
  };

  const woodColours = WOOD.map((hex) => new Color(hex));
  const matrix = new Matrix4();
  const translation = new Vector3();
  const rotation = new Quaternion();
  const euler = new Euler();
  const scale = new Vector3();

  const batch = (geometry: BufferGeometry, pieces: Piece[], material: Material): InstancedMesh | null => {
    if (pieces.length === 0) return null;

    const mesh = new InstancedMesh(geometry, material, pieces.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    pieces.forEach((piece, index) => {
      translation.set(piece.x, piece.y, piece.z);
      euler.set(piece.rx, piece.ry, piece.rz);
      rotation.setFromEuler(euler);
      scale.set(piece.sx, piece.sy, piece.sz);
      matrix.compose(translation, rotation, scale);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, woodColours[piece.shade]);
    });

    group.add(mesh);
    return mesh;
  };

  const timberMaterial = keepMaterial(
    new MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 0.9, metalness: 0, vertexColors: true })
  );
  const tileMaterial = keepMaterial(
    new MeshStandardMaterial({
      color: recipe.ground.roof,
      flatShading: true,
      roughness: 0.84,
      metalness: 0,
      side: DoubleSide,
    })
  );

  const boxGeometry = addWhite(keep(new BoxGeometry(1, 1, 1)));
  const poleGeometry = addWhite(keep(new CylinderGeometry(0.5, 0.42, 1, 8)));
  poleGeometry.translate(0, -0.5, 0);
  // Half a pipe lying along x and covering the top: a cap tile.
  const tileGeometry = addWhite(keep(new CylinderGeometry(0.085, 0.085, 1, 7, 1, true, 0, Math.PI)));
  tileGeometry.rotateZ(Math.PI / 2);

  const timberMesh = batch(boxGeometry, timber, timberMaterial);
  const poleMesh = batch(poleGeometry, round, timberMaterial);
  const tileMesh = batch(tileGeometry, tiles, tileMaterial);

  // --- the pieces that are each their own shape ----------------------------
  const ropeMaterial = keepMaterial(
    new MeshStandardMaterial({ color: '#9b9075', flatShading: true, roughness: 0.96, metalness: 0 })
  );
  for (const rope of ropes) {
    const mesh = new Mesh(keep(rope.geometry), ropeMaterial);
    mesh.castShadow = true;
    rope.pivot.add(mesh);
    group.add(rope.pivot);
  }

  const rubber = keepMaterial(
    new MeshStandardMaterial({ color: '#2b2b2e', flatShading: true, roughness: 0.95, metalness: 0 })
  );
  const tyreGeometry = keep(new TorusGeometry(0.33, 0.1, 7, 14));
  for (const at of tyres) {
    const tyre = new Mesh(tyreGeometry, rubber);
    tyre.position.copy(at);
    tyre.rotation.y = Math.PI / 2;
    // Old tyres have been squashed against the piles for years.
    tyre.scale.set(1, 0.93, 1);
    tyre.castShadow = true;
    group.add(tyre);
  }

  const netTexture = createNetTexture();
  const netMaterial = keepMaterial(
    new MeshStandardMaterial({
      map: netTexture,
      alphaTest: 0.5,
      side: DoubleSide,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
    })
  );

  const dryingNet = new Mesh(keep(createNetGeometry(2.4, 1.55)), netMaterial);
  dryingNet.position.set(-(halfWidth - 0.24), deckY + 1.22, frameZ);
  dryingNet.rotation.y = Math.PI / 2;
  group.add(dryingNet);

  const railNet = new Mesh(keep(createNetGeometry(1.5, 0.9)), netMaterial);
  railNet.position.set(-(halfWidth - 0.08), deckY + RAIL_HEIGHT - 0.42, deckLength * 0.28);
  railNet.rotation.y = Math.PI / 2;
  group.add(railNet);

  const basketStraw = keepMaterial(
    new MeshStandardMaterial({ color: '#b39a6e', flatShading: true, roughness: 0.95, metalness: 0, side: DoubleSide })
  );
  const basketGeometry = keep(new CylinderGeometry(0.44, 0.32, 0.4, 12, 1, true));
  const basketRimGeometry = keep(new TorusGeometry(0.44, 0.04, 4, 12));
  basketRimGeometry.rotateX(Math.PI / 2);
  for (let i = 0; i < 2; i += 1) {
    const lx = 0.85 - i * 0.1;
    const lz = 6.6 + i * 0.95;
    const basket = new Mesh(basketGeometry, basketStraw);
    basket.position.set(lx, deckY + 0.2, lz);
    basket.castShadow = true;
    group.add(basket);
    const rim = new Mesh(basketRimGeometry, basketStraw);
    rim.position.set(lx, deckY + 0.4, lz);
    group.add(rim);
  }

  // --- the lamp ------------------------------------------------------------
  const metal = keepMaterial(
    new MeshStandardMaterial({ color: '#39342c', flatShading: true, roughness: 0.6, metalness: 0.3 })
  );
  const lampShade = new Mesh(keep(new ConeGeometry(0.3, 0.24, 10, 1, true)), metal);
  lampShade.position.set(lampX, deckY + 3.12, lampZ);
  group.add(lampShade);

  const bulbMaterial = keepMaterial(new MeshBasicMaterial({ color: '#8a6a3a' }));
  const bulb = new Mesh(keep(new CylinderGeometry(0.075, 0.075, 0.14, 8)), bulbMaterial);
  bulb.position.set(lampX, deckY + 2.95, lampZ);
  group.add(bulb);

  const glowMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: '#ffc271',
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
    })
  );
  const glow = new Mesh(keep(new CylinderGeometry(0.42, 0.42, 0.5, 10)), glowMaterial);
  glow.position.copy(bulb.position);
  glow.visible = false;
  group.add(glow);

  const poolMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: '#ffb86a',
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
    })
  );
  const poolGeometry = keep(new CircleGeometry(2.7, 20));
  poolGeometry.rotateX(-Math.PI / 2);
  const pool = new Mesh(poolGeometry, poolMaterial);
  pool.position.set(lampX, deckY + 0.012, lampZ);
  pool.visible = false;
  group.add(pool);

  const walkway: Platform = {
    x: toWorldX(0, deckLength / 2),
    z: toWorldZ(0, deckLength / 2),
    yaw: site.heading,
    halfWidth: halfWidth - 0.25,
    halfLength: deckLength / 2 - 0.15,
    surfaceY: deckY,
  };

  // The landward steps as a span the walker can climb, and the deck at its full
  // extent to meet it. The ramp runs a metre further inland than the carpentry
  // does, so its surface starts below the bank and emerges from it — `floorAt`
  // takes the higher of ground and span, so the crossing is found rather than
  // stepped over and the walk up is continuous. The two spans meet exactly at
  // lz = 0, both at deck height: `walkway` is inset by 15 cm to keep anything
  // standing on it off the very edge of the planks, and that inset as a
  // walkable extent would have left a seam to fall through.
  const approachRun = 1.7;
  const approachGrade = (deckY - site.ground) / approachRun;
  const approachHalf = (approachRun + 1) / 2;
  const approach: Platform = {
    x: toWorldX(0, -approachHalf),
    z: toWorldZ(0, -approachHalf),
    yaw: site.heading,
    halfWidth: 1.2,
    halfLength: approachHalf,
    surfaceY: deckY - approachGrade * approachHalf,
    grade: approachGrade,
  };
  const deckSpan: Platform = {
    x: toWorldX(0, deckLength / 2),
    z: toWorldZ(0, deckLength / 2),
    yaw: site.heading,
    halfWidth: halfWidth - 0.25,
    halfLength: deckLength / 2,
    surfaceY: deckY,
  };

  const exits: WaterExit[] = [
    {
      x: toWorldX(0, ladderZ + 0.5),
      z: toWorldZ(0, ladderZ + 0.5),
      radius: 3.2,
      landing: { x: toWorldX(0, deckLength - 1), y: deckY, z: toWorldZ(0, deckLength - 1) },
    },
    {
      x: toWorldX(stepsX, 3.9),
      z: toWorldZ(stepsX, 3.9),
      radius: 3,
      // The top step reaches the bank, so the landing is the bank — and it has
      // to be the bank's own height, because anything standing there is going
      // to be held at ground level and would otherwise drop on arrival. The
      // ladder's landing is the deck, which is a surface in its own right.
      landing: {
        x: toWorldX(stepsX, 1.5),
        y: Math.max(bedAt(stepsX, 1.5), level + 0.15),
        z: toWorldZ(stepsX, 1.5),
      },
    },
  ];

  return {
    group,
    moorings,
    walkway,
    platforms: [approach, deckSpan],
    exits,
    update: (elapsed) => {
      // The lines breathe with the boats they are tied to. A few centimetres at
      // the far end is all it takes to stop a rope looking like a rod.
      for (const { pivot, phase } of ropes) {
        if (!pivot.visible) continue;
        pivot.rotation.x = Math.sin(elapsed * 0.78 + phase) * 0.022;
        pivot.rotation.y = Math.sin(elapsed * 0.51 + phase) * 0.014;
      }
    },
    setHulls: (hulls) => {
      for (const { pivot, berth } of ropes) {
        pivot.visible = hulls.some((hull) => Math.hypot(hull.x - berth.x, hull.z - berth.z) <= BOAT_LENGTH * 0.5 + 2);
      }
    },
    setNight: (amount) => {
      const lit = Math.min(1, Math.max(0, amount));
      bulbMaterial.color.setHex(lit > 0.3 ? 0xffd79a : 0x8a6a3a);
      glowMaterial.opacity = lit * 0.45;
      glow.visible = lit > 0.03;
      poolMaterial.opacity = lit * 0.3;
      pool.visible = lit > 0.03;
    },
    dispose: () => {
      timberMesh?.dispose();
      poleMesh?.dispose();
      tileMesh?.dispose();
      netTexture.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      group.clear();
    },
  };
};
