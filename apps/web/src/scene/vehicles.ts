import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Material,
} from 'three';

import type { Machine, Rideable, Ridden } from './life';
import { styleOf, type TownStyle } from './town-styles';
import {
  box,
  mergeParts,
  strut,
  tube,
  type ParkingSpot,
  type Part,
  type RoadKind,
  type RoadNetwork,
  type RoadSample,
} from './road-network';
import type { WorldWeather } from './weather-state';

/**
 * Local +Z is the way a vehicle faces and local +Y is up, which in a
 * right-handed frame puts the driver's right hand on local **−X**. Vietnam
 * drives on the right, so the kerb, the exhaust, the coach door and the lane
 * offset all live on that side; getting the sign wrong puts the whole fleet in
 * the oncoming lane.
 */
const RIGHT = -1;

const GRAVITY = 9.81;

const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export type VehicleKind =
  | 'motorbike'
  | 'motorbike-cargo'
  | 'car'
  | 'truck'
  | 'coach'
  | 'bicycle'
  | 'cyclo'
  | 'buffalo-cart';

type Spec = {
  length: number;
  width: number;
  wheelRadius: number;
  /** Axle positions along Z, from the vehicle's own origin. */
  frontAxle: number;
  rearAxle: number;
  /**
   * Roll into a bend, as a multiple of the angle a free body would take. A
   * motorbike leans the whole of it; a car's suspension lets the body roll a
   * little the *other* way, which is why this is negative on four wheels.
   */
  leanGain: number;
  /** m/s on an open straight. */
  cruise: number;
  /** Lateral acceleration it will take through a bend, m/s². */
  grip: number;
  accel: number;
  brake: number;
  steersFront: boolean;
  /** Whether the headlight turns with the bars. True only on two wheels. */
  lampOnSteer: boolean;
  /** Metres it wants between its nose and the tail in front. */
  gap: number;
  roads: RoadKind[];
};

const SPECS: Record<VehicleKind, Spec> = {
  // Honda Wave: 1.95 m over the mudguards, 1.24 m wheelbase, 17-inch wheels. The
  // whole fleet is scaled against this one because it is what there are most of.
  motorbike: {
    length: 1.95,
    width: 0.72,
    wheelRadius: 0.215,
    frontAxle: 0.62,
    rearAxle: -0.62,
    leanGain: 1,
    cruise: 11.5,
    grip: 5.2,
    accel: 3.4,
    brake: 5.4,
    steersFront: true,
    lampOnSteer: true,
    gap: 6,
    roads: ['main', 'secondary', 'lane', 'trail'],
  },
  'motorbike-cargo': {
    length: 1.95,
    width: 0.98,
    wheelRadius: 0.215,
    frontAxle: 0.62,
    rearAxle: -0.62,
    leanGain: 0.82,
    cruise: 8.4,
    grip: 3.9,
    accel: 2.1,
    brake: 4.2,
    steersFront: true,
    lampOnSteer: true,
    gap: 7,
    roads: ['main', 'secondary', 'lane'],
  },
  car: {
    length: 4.3,
    width: 1.8,
    wheelRadius: 0.31,
    frontAxle: 1.3,
    rearAxle: -1.3,
    leanGain: -0.2,
    cruise: 13.5,
    grip: 4.6,
    accel: 2.6,
    brake: 5.8,
    steersFront: true,
    lampOnSteer: false,
    gap: 11,
    roads: ['main', 'secondary'],
  },
  truck: {
    length: 5.4,
    width: 1.95,
    wheelRadius: 0.33,
    frontAxle: 1.52,
    rearAxle: -1.28,
    leanGain: -0.3,
    cruise: 10.4,
    grip: 3.3,
    accel: 1.4,
    brake: 4.2,
    steersFront: true,
    lampOnSteer: false,
    gap: 15,
    roads: ['main', 'secondary', 'lane'],
  },
  coach: {
    length: 10.5,
    width: 2.5,
    wheelRadius: 0.52,
    frontAxle: 3.1,
    rearAxle: -2.1,
    leanGain: -0.34,
    cruise: 12,
    grip: 2.9,
    accel: 1,
    brake: 3.6,
    steersFront: true,
    lampOnSteer: false,
    gap: 24,
    roads: ['main', 'secondary'],
  },
  bicycle: {
    length: 1.75,
    width: 0.56,
    wheelRadius: 0.34,
    frontAxle: 0.53,
    rearAxle: -0.52,
    leanGain: 0.85,
    cruise: 4.6,
    grip: 2.9,
    accel: 1.3,
    brake: 2.8,
    steersFront: true,
    lampOnSteer: true,
    gap: 4,
    roads: ['main', 'secondary', 'lane'],
  },
  cyclo: {
    length: 2.9,
    width: 1.22,
    wheelRadius: 0.33,
    frontAxle: 0.95,
    rearAxle: -1.05,
    leanGain: 0.12,
    cruise: 3.3,
    grip: 2.3,
    accel: 0.9,
    brake: 2.4,
    steersFront: false,
    lampOnSteer: false,
    gap: 6,
    roads: ['secondary', 'lane'],
  },
  'buffalo-cart': {
    length: 4.2,
    width: 1.62,
    wheelRadius: 0.6,
    frontAxle: 1.9,
    rearAxle: -0.3,
    leanGain: 0,
    cruise: 1.1,
    grip: 1.5,
    accel: 0.5,
    brake: 1.4,
    steersFront: false,
    lampOnSteer: false,
    gap: 9,
    roads: ['lane'],
  },
};

/**
 * The fleet, in the order it is dealt out, cut to whatever count the caller
 * asks for. Xe máy first and xe máy most everywhere — that is the ratio on any
 * road in the country and the whole reason these are written lists rather than a
 * sampled distribution — but what the rest of the list is differs by the kind of
 * settlement, and that was the bug: one roster plus a `town.lanterns` test gave
 * all four places the same fleet, down to a xích lô pedalling round Tây Hồ.
 *
 * `lanterns` was the wrong variable to ask. At Hồ Tây it is true and means the
 * window lights of a tower block; the question a xích lô answers is whether this
 * is an old quarter, which `styleOf` already decides off the terrain profile and
 * the height the recipe lets the town build to.
 *
 * - `highland` — a Sơn La ridge: two wheels, a cargo bike and a bicycle, and the
 *   cart that does the work a truck would do if a truck could get up here.
 * - `oldTown` — Hội An: the xích lô belongs here and nowhere else of the four,
 *   and the place is full of rented bicycles. One coach brings the day trippers.
 * - `delta` — Tràng An: coaches, because that is how everybody arrives, plus the
 *   two wheels and carts of the villages between the towers.
 * - `city` — Tây Hồ: cars and a bus in traffic, no cart, no xích lô. The old
 *   quarter's cyclos are five kilometres away in Hoàn Kiếm.
 */
const ROSTERS: Record<TownStyle, VehicleKind[]> = {
  highland: [
    'motorbike',
    'motorbike',
    'motorbike-cargo',
    'motorbike',
    'bicycle',
    'motorbike',
    'buffalo-cart',
    'motorbike',
    'motorbike-cargo',
    'motorbike',
    'buffalo-cart',
    'motorbike',
    'bicycle',
    'motorbike',
    'motorbike',
    'motorbike',
  ],
  oldTown: [
    'motorbike',
    'bicycle',
    'cyclo',
    'motorbike',
    'motorbike-cargo',
    'bicycle',
    'cyclo',
    'motorbike',
    'car',
    'bicycle',
    'motorbike',
    'coach',
    'motorbike-cargo',
    'motorbike',
    'truck',
    'motorbike',
  ],
  delta: [
    'motorbike',
    'motorbike',
    'coach',
    'motorbike-cargo',
    'bicycle',
    'motorbike',
    'buffalo-cart',
    'motorbike',
    'car',
    'motorbike',
    'coach',
    'motorbike-cargo',
    'bicycle',
    'motorbike',
    'truck',
    'motorbike',
  ],
  city: [
    'motorbike',
    'car',
    'motorbike',
    'car',
    'motorbike',
    'coach',
    'motorbike',
    'truck',
    'motorbike',
    'car',
    'motorbike-cargo',
    'motorbike',
    'bicycle',
    'motorbike',
    'car',
    'motorbike',
  ],
};

/**
 * Everything one vehicle is made of, grouped by what moves it. Every list is in
 * the vehicle's own coordinates with y = 0 at the tyre contact patch; the
 * assembler is what shifts a list into the frame of the node that carries it.
 */
type Build = {
  /** Static bodywork. Merged into one vertex-coloured geometry, so one draw call. */
  body: Part[];
  glass: Part[];
  /** Fork, bars, front mudguard — whatever turns with the steering. */
  steer: Part[];
  frontWheel: Part[];
  rearWheel: Part[];
  /** Leans and bobs with the machine. */
  rider: Part[];
  /** Pivots about X, for cranks that are pedalled and legs that walk. */
  swing: { parts: Part[]; at: [number, number, number]; phase: number; gain: number }[];
  head: Part[];
  tail: Part[];
  /** Where the headlight glow cone starts. Null means it carries no lights. */
  lamp: [number, number, number] | null;
};

const emptyBuild = (): Build => ({
  body: [],
  glass: [],
  steer: [],
  frontWheel: [],
  rearWheel: [],
  rider: [],
  swing: [],
  head: [],
  tail: [],
  lamp: null,
});

// --- shared primitives --------------------------------------------------------

/**
 * Sweeps a closed cross-section along Z and caps both ends. One call is a whole
 * shell: the silhouette comes out of the station functions rather than out of a
 * stack of boxes, which is the difference between a car and a crate.
 */
const loft = (stations: number[], ring: (z: number, index: number) => [number, number][], color: string): Part => {
  const positions: number[] = [];
  const indices: number[] = [];
  const rings = stations.map((z, index) => ring(z, index));
  const points = rings[0].length;

  rings.forEach((entries, index) => {
    for (const point of entries) positions.push(point[0], point[1], stations[index]);
  });

  for (let i = 0; i + 1 < rings.length; i += 1) {
    const a = i * points;
    const b = a + points;
    for (let p = 0; p < points; p += 1) {
      const next = (p + 1) % points;
      indices.push(a + p, a + next, b + next, a + p, b + next, b + p);
    }
  }

  for (let p = 1; p + 1 < points; p += 1) indices.push(0, p + 1, p);
  const tail = (rings.length - 1) * points;
  for (let p = 1; p + 1 < points; p += 1) indices.push(tail, tail + p, tail + p + 1);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry, color };
};

/** A rounded-rectangle section, bottom-left round to top-left. `taper` narrows the roof. */
const slab = (half: number, floor: number, roof: number, taper: number): [number, number][] => {
  const lift = Math.min(0.2, (roof - floor) * 0.24);
  const top = half * taper;
  return [
    [-half, floor + lift],
    [-half * 0.74, floor],
    [half * 0.74, floor],
    [half, floor + lift],
    [half, roof - lift],
    [top * 0.88, roof],
    [-top * 0.88, roof],
    [-half, roof - lift],
  ];
};

/**
 * How much the body's underside has to rise at this station to clear a wheel.
 * A low-poly body cannot have a hole cut in it, so the arch is built into the
 * sweep instead — and that bulge over each axle is most of what makes a body
 * shell read as a car rather than a shoebox.
 */
const archLift = (z: number, axles: number[], reach: number) => {
  let most = 0;
  for (const axle of axles) most = Math.max(most, 1 - smoothstep(reach * 0.55, reach, Math.abs(z - axle)));
  return most;
};

/**
 * One wheel at an offset along the axle. The tyre is a torus rather than a disc
 * because the profile is the first thing the eye checks on a wheel, and the
 * spokes are what make it obviously turning rather than sliding.
 */
const wheel = (radius: number, width: number, offset: number, spokes: number, rim = '#9a9ea1'): Part[] => {
  const parts: Part[] = [];
  const section = width * 0.36;

  const tyre = new TorusGeometry(radius - section, section, 6, 16);
  tyre.rotateY(Math.PI / 2);
  tyre.translate(offset, 0, 0);
  parts.push({ geometry: tyre, color: '#1b1b1d' });

  parts.push(
    tube([radius - section * 1.7, radius - section * 1.7], width * 0.42, [offset, 0, 0], rim, [0, 0, Math.PI / 2], 14)
  );
  parts.push(tube([width * 0.34, width * 0.34], width * 1.16, [offset, 0, 0], '#6e7275', [0, 0, Math.PI / 2], 8));

  for (let s = 0; s < spokes; s += 1) {
    const spoke = box([width * 0.16, (radius - section * 1.8) * 2, width * 0.1], [offset, 0, 0], rim);
    spoke.geometry.rotateX((s / spokes) * Math.PI);
    parts.push(spoke);
  }
  return parts;
};

/** A wooden cart wheel: a broad felloe, a thick hub and six real spokes. */
const cartWheel = (radius: number, offset: number): Part[] => {
  const parts: Part[] = [];
  const felloe = new TorusGeometry(radius - 0.05, 0.05, 5, 18);
  felloe.rotateY(Math.PI / 2);
  felloe.translate(offset, 0, 0);
  parts.push({ geometry: felloe, color: '#6b5339' });
  parts.push(tube([0.1, 0.1], 0.2, [offset, 0, 0], '#4e3d2b', [0, 0, Math.PI / 2], 10));
  for (let s = 0; s < 6; s += 1) {
    const spoke = box([0.055, (radius - 0.06) * 2, 0.055], [offset, 0, 0], '#755c40');
    spoke.geometry.rotateX((s / 6) * Math.PI);
    parts.push(spoke);
  }
  return parts;
};

type Outfit = {
  shirt: string;
  trousers: string;
  skin: string;
  /** Mũ bảo hiểm, nón lá, a cloth cap, or bare-headed. */
  hat: 'helmet' | 'non-la' | 'cap' | 'none';
  helmet: string;
};

const SKIN = ['#b88f68', '#c49a72', '#a87f5c'];
const SHIRTS = ['#4c5f72', '#8a4238', '#d8d3c4', '#3f6049', '#6f5a7d', '#2f4858'];
const TROUSERS = ['#2f3440', '#4a4237', '#36414a', '#5c5247'];
const HELMETS = ['#d9d4c6', '#2d3136', '#b03a2e', '#2f6b82'];

const pick = <T>(list: T[], random: () => number): T => list[Math.floor(random() * list.length)];

const dress = (random: () => number, hat: Outfit['hat']): Outfit => ({
  shirt: pick(SHIRTS, random),
  trousers: pick(TROUSERS, random),
  skin: pick(SKIN, random),
  hat,
  helmet: pick(HELMETS, random),
});

/**
 * A seated figure, built as one merged mesh. Nobody gets close enough to a
 * passing bike for an articulated spine to matter, and the lean that actually
 * sells it belongs to the machine the figure is sitting on. Arms reach `hands`
 * and legs reach `feet`, so the same function rigs a rider to handlebars, a
 * cyclo driver to his pedals and a carter to his reins.
 */
const seatedRider = (
  hip: [number, number, number],
  hands: [number, number, number],
  feet: [number, number, number],
  outfit: Outfit,
  lean: number,
  spread: { grip: number; foot: number }
): Part[] => {
  const parts: Part[] = [];
  const shoulderY = hip[1] + 0.5;
  const shoulderZ = hip[2] + Math.sin(lean) * 0.46;

  parts.push(box([0.34, 0.2, 0.3], hip, outfit.trousers));
  parts.push(
    box([0.36, 0.56, 0.24], [hip[0], (hip[1] + shoulderY) / 2 + 0.05, (hip[2] + shoulderZ) / 2], outfit.shirt, [
      -lean,
      0,
      0,
    ])
  );
  parts.push(box([0.42, 0.15, 0.23], [hip[0], shoulderY, shoulderZ], outfit.shirt, [-lean, 0, 0]));
  parts.push(tube([0.055, 0.062], 0.09, [hip[0], shoulderY + 0.1, shoulderZ + 0.02], outfit.skin, undefined, 6));

  const headY = shoulderY + 0.24;
  const headZ = shoulderZ + 0.04;
  const head = new SphereGeometry(0.1, 9, 7);
  head.scale(1, 1.14, 1.04);
  head.translate(hip[0], headY, headZ);
  parts.push({ geometry: head, color: outfit.skin });

  if (outfit.hat === 'helmet') {
    const shell = new SphereGeometry(0.135, 11, 8, 0, Math.PI * 2, 0, Math.PI * 0.62);
    shell.translate(hip[0], headY + 0.015, headZ);
    parts.push({ geometry: shell, color: outfit.helmet });
    // The peak and the dark visor band are what make a helmet read as a helmet
    // from behind, which is the angle anyone following a bike actually has.
    parts.push(box([0.2, 0.03, 0.1], [hip[0], headY + 0.04, headZ + 0.13], outfit.helmet, [0.2, 0, 0]));
    parts.push(box([0.21, 0.07, 0.03], [hip[0], headY - 0.01, headZ + 0.11], '#2a3036'));
  } else if (outfit.hat === 'non-la') {
    const cone = new ConeGeometry(0.29, 0.16, 14);
    cone.translate(hip[0], headY + 0.12, headZ);
    parts.push({ geometry: cone, color: '#d9c48c' });
  } else if (outfit.hat === 'cap') {
    parts.push(box([0.21, 0.07, 0.21], [hip[0], headY + 0.1, headZ], outfit.helmet));
    parts.push(box([0.19, 0.02, 0.1], [hip[0], headY + 0.08, headZ + 0.14], outfit.helmet));
  }

  for (const side of [-1, 1]) {
    const shoulder: [number, number, number] = [hip[0] + side * 0.2, shoulderY - 0.02, shoulderZ];
    const grip: [number, number, number] = [hands[0] + side * spread.grip, hands[1], hands[2]];
    const elbow: [number, number, number] = [
      (shoulder[0] + grip[0]) / 2 + side * 0.07,
      (shoulder[1] + grip[1]) / 2 - 0.08,
      (shoulder[2] + grip[2]) / 2 - 0.02,
    ];
    parts.push(strut(shoulder, elbow, 0.048, outfit.shirt, 5), strut(elbow, grip, 0.042, outfit.skin, 5));

    const hipAt: [number, number, number] = [hip[0] + side * 0.12, hip[1] - 0.04, hip[2]];
    const foot: [number, number, number] = [feet[0] + side * spread.foot, feet[1], feet[2]];
    const knee: [number, number, number] = [
      (hipAt[0] + foot[0]) / 2 + side * 0.04,
      (hipAt[1] + foot[1]) / 2 + 0.07,
      (hipAt[2] + foot[2]) / 2 + 0.16,
    ];
    parts.push(strut(hipAt, knee, 0.064, outfit.trousers, 5), strut(knee, foot, 0.053, outfit.trousers, 5));
    parts.push(box([0.09, 0.05, 0.22], [foot[0], foot[1] - 0.01, foot[2] + 0.04], '#2b2b2e'));
  }

  return parts;
};

// --- xe máy -------------------------------------------------------------------

const motorbikeBuild = (paint: string, cargo: boolean, random: () => number, solo = false): Build => {
  const build = emptyBuild();
  const spec = SPECS.motorbike;
  const dark = '#2a2d31';
  const chrome = '#b9bdc0';

  build.body.push(
    box([0.3, 0.26, 0.42], [0, 0.34, -0.04], dark),
    tube([0.07, 0.075], 0.22, [0, 0.47, 0.11], '#8d9296', [1.15, 0, 0], 8),
    box([0.12, 0.09, 0.66], [0, 0.68, -0.32], dark),
    box([0.24, 0.17, 0.34], [0, 0.63, -0.2], paint),
    box([0.3, 0.22, 0.46], [0, 0.46, -0.16], paint),
    box([0.34, 0.4, 0.1], [0, 0.6, 0.4], paint),
    box([0.26, 0.04, 0.38], [0, 0.24, 0.13], dark),
    box([0.27, 0.1, 0.62], [0, 0.76, -0.22], '#23242a'),
    box([0.2, 0.08, 0.17], [0, 0.755, 0.11], '#23242a'),
    box([0.26, 0.03, 0.27], [0, 0.805, -0.56], chrome),
    box([0.16, 0.11, 0.015], [0, 0.44, -0.79], '#e6e3d8'),
    box([0.17, 0.04, 0.3], [0, 0.49, -0.64], dark)
  );

  // A step-through has no top tube, so the line from the steering head down to
  // the engine is most of what there is to recognise it by.
  build.body.push(
    strut([0, 0.86, 0.5], [0, 0.44, 0.1], 0.032, dark, 6),
    strut([0, 0.86, 0.5], [0, 0.69, -0.02], 0.028, dark, 6),
    strut([RIGHT * 0.09, 0.33, -0.1], [RIGHT * 0.15, 0.25, -0.46], 0.028, chrome, 6),
    tube([0.05, 0.045], 0.34, [RIGHT * 0.16, 0.26, -0.66], chrome, [Math.PI / 2, 0, 0], 8)
  );
  for (const side of [-1, 1]) {
    build.body.push(
      strut([side * 0.095, 0.34, -0.1], [side * 0.08, 0.215, -0.6], 0.022, dark, 5),
      strut([side * 0.09, 0.64, -0.28], [side * 0.085, 0.3, -0.58], 0.026, '#6f757a', 6),
      box([0.11, 0.035, 0.09], [side * 0.17, 0.26, -0.02], dark)
    );
  }

  build.rearWheel.push(...wheel(spec.wheelRadius, 0.1, 0, 7));
  build.frontWheel.push(...wheel(spec.wheelRadius, 0.09, 0, 7));

  // Steering assembly, in vehicle coordinates — the assembler rebases it.
  const axle = spec.frontAxle;
  const bars = axle - 0.14;
  build.steer.push(
    box([0.17, 0.07, 0.11], [0, 0.75, axle + 0.02], dark),
    box([0.14, 0.06, 0.4], [0, 0.4, axle + 0.02], paint),
    box([0.2, 0.18, 0.13], [0, 0.86, axle + 0.01], dark),
    tube([0.017, 0.017], 0.62, [0, 0.9, bars], '#6f757a', [0, 0, Math.PI / 2], 6),
    box([0.14, 0.07, 0.1], [0, 0.99, bars - 0.05], dark)
  );
  for (const side of [-1, 1]) {
    build.steer.push(
      strut([side * 0.075, 0.72, axle + 0.04], [side * 0.075, 0.215, axle], 0.024, chrome, 6),
      tube([0.023, 0.023], 0.11, [side * 0.26, 0.9, bars], '#1f2024', [0, 0, Math.PI / 2], 6),
      strut([side * 0.21, 0.92, bars], [side * 0.27, 1.1, bars - 0.01], 0.012, '#6f757a', 4),
      box([0.12, 0.07, 0.02], [side * 0.27, 1.13, bars - 0.01], '#cfd4d6', [0, 0, side * 0.2]),
      box([0.11, 0.05, 0.03], [side * 0.14, 0.75, axle + 0.09], '#e2a43c')
    );
  }
  build.head.push(box([0.16, 0.12, 0.03], [0, 0.86, axle + 0.09], '#ffffff'));
  build.tail.push(box([0.11, 0.06, 0.025], [0, 0.56, -0.79], '#ffffff'));
  build.lamp = [0, 0.86, axle + 0.12];

  build.rider.push(
    ...seatedRider(
      [0, 0.86, -0.18],
      [0, 0.9, 0.48],
      [0, 0.29, -0.02],
      dress(random, random() < 0.78 ? 'helmet' : 'non-la'),
      0.26,
      {
        grip: 0.26,
        foot: 0.17,
      }
    )
  );

  if (!cargo && !solo && random() < 0.55) {
    // Two up is the normal way to carry a second person here, and the pillion
    // sits square where the rider is folded forward over the bars. Never on one
    // the player can take: a passenger who appears the moment you sit down is a
    // ghost, and the figure on a parked bike is the one you become.
    build.rider.push(
      ...seatedRider(
        [0, 0.88, -0.56],
        [0, 0.78, -0.3],
        [0, 0.3, -0.42],
        dress(random, random() < 0.6 ? 'helmet' : 'none'),
        0.08,
        { grip: 0.16, foot: 0.19 }
      )
    );
  }

  if (cargo) {
    // Loaded past any sensible limit, which is the point of the variant: crates
    // up the back, panniers either side, cord criss-crossed over the lot.
    const crates = 2 + Math.floor(random() * 2);
    let stack = 0.82;
    for (let c = 0; c < crates; c += 1) {
      const tall = 0.2 + random() * 0.08;
      build.body.push(
        box(
          [0.52 - c * 0.06, tall, 0.42 - c * 0.04],
          [0, stack + tall / 2, -0.56],
          c % 2 === 0 ? '#9a7b4f' : '#7c6a52',
          [0, (random() - 0.5) * 0.14, 0]
        )
      );
      stack += tall;
    }
    for (const side of [-1, 1]) {
      build.body.push(
        tube([0.2, 0.15], 0.34, [side * 0.34, 0.56, -0.5], '#b39a6e', undefined, 12),
        tube([0.21, 0.21], 0.03, [side * 0.34, 0.73, -0.5], '#8d7a55', undefined, 12)
      );
    }
    build.body.push(
      strut([-0.3, 0.76, -0.56], [0.3, stack - 0.04, -0.56], 0.012, '#4a4335', 4),
      strut([0.3, 0.76, -0.56], [-0.3, stack - 0.04, -0.56], 0.012, '#4a4335', 4)
    );
  }

  return build;
};

// --- xe con -------------------------------------------------------------------

const carBuild = (paint: string, random: () => number): Build => {
  const build = emptyBuild();
  const spec = SPECS.car;
  const dark = '#23262a';
  const chrome = '#b4b9bc';
  const half = spec.width / 2;
  const axles = [spec.frontAxle, spec.rearAxle];

  const stations: number[] = [];
  for (let i = 0; i <= 26; i += 1) stations.push(-2.15 + (i / 26) * 4.3);

  build.body.push(
    loft(
      stations,
      (z) => {
        const t = (z + 2.15) / 4.3;
        const beam = half * (0.82 + 0.18 * Math.sin(Math.PI * t) ** 0.45);
        const end = Math.max(0, Math.abs(2 * t - 1) - 0.84) / 0.16;
        // Clears a 0.31 m wheel over each axle and drops to a sill between them.
        const floor = 0.26 + 0.42 * archLift(z, axles, 0.56) + end * 0.1;
        return slab(beam, floor, 1.0 - end * 0.11, 0.94);
      },
      paint
    ),
    loft([-1.86, 1.86], () => slab(0.6, 0.17, 0.42, 1), '#2b2f33')
  );

  // The greenhouse: glass all round, raked at both ends so the screens come out
  // of the sweep rather than being pasted on as flat plates.
  const cabin = [-0.82, -0.56, -0.1, 0.44, 0.78, 1.0];
  const cabinRoof = [1.12, 1.33, 1.44, 1.44, 1.26, 1.06];
  const cabinHalf = [0.68, 0.74, 0.77, 0.75, 0.69, 0.58];
  build.glass.push(loft(cabin, (_z, index) => slab(cabinHalf[index], 1.0, cabinRoof[index], 0.9), '#10181d'));
  build.body.push(loft([-0.52, 0.46], () => slab(0.78, 1.41, 1.48, 0.95), paint));

  for (const side of [-1, 1]) {
    build.body.push(
      strut([side * 0.66, 1.0, 0.88], [side * 0.72, 1.44, 0.44], 0.045, paint, 5),
      strut([side * 0.76, 1.0, 0.06], [side * 0.78, 1.44, 0.06], 0.038, dark, 5),
      strut([side * 0.68, 1.0, -0.78], [side * 0.74, 1.44, -0.36], 0.05, paint, 5),
      strut([side * 0.74, 1.44, -0.4], [side * 0.74, 1.44, 0.46], 0.035, paint, 5),
      box([0.07, 0.09, 2.5], [side * (half - 0.04), 0.3, 0], '#2f3338'),
      box([0.13, 0.04, 0.035], [side * (half - 0.02), 0.92, 0.42], chrome),
      box([0.13, 0.04, 0.035], [side * (half - 0.02), 0.92, -0.36], chrome),
      strut([side * 0.8, 1.06, 0.74], [side * 0.97, 1.09, 0.7], 0.022, paint, 5),
      box([0.08, 0.12, 0.2], [side * 1.0, 1.1, 0.68], dark),
      box([0.02, 0.1, 0.17], [side * 1.03, 1.1, 0.68], '#9fb0b8')
    );

    for (const axle of axles) {
      const arch = new TorusGeometry(0.42, 0.05, 4, 10, Math.PI);
      arch.rotateY(Math.PI / 2);
      arch.translate(side * (half - 0.03), spec.wheelRadius, axle);
      build.body.push({ geometry: arch, color: paint });
    }
  }

  build.body.push(
    box([1.74, 0.24, 0.16], [0, 0.5, 2.11], '#44484c'),
    box([1.74, 0.24, 0.16], [0, 0.5, -2.11], '#44484c'),
    box([1.12, 0.22, 0.07], [0, 0.8, 2.13], dark),
    box([1.0, 0.035, 0.04], [0, 0.86, 2.16], chrome),
    box([1.0, 0.035, 0.04], [0, 0.79, 2.16], chrome),
    box([0.44, 0.13, 0.02], [0, 0.6, 2.17], '#e8e5da'),
    box([0.44, 0.13, 0.02], [0, 0.66, -2.17], '#e8e5da'),
    tube([0.035, 0.038], 0.12, [RIGHT * 0.52, 0.32, -2.12], '#7c8184', [Math.PI / 2, 0, 0], 8)
  );
  if (random() < 0.35) {
    // Half the cars on a Vietnamese road are carrying something on the roof.
    for (const side of [-1, 1]) build.body.push(box([0.05, 0.05, 1.0], [side * 0.6, 1.53, 0], '#55595d'));
    build.body.push(
      box([1.3, 0.05, 0.06], [0, 1.53, 0.44], '#55595d'),
      box([1.3, 0.05, 0.06], [0, 1.53, -0.44], '#55595d')
    );
  }

  for (const side of [-1, 1]) {
    build.head.push(box([0.36, 0.15, 0.06], [side * 0.58, 0.88, 2.12], '#ffffff'));
    build.body.push(box([0.14, 0.09, 0.05], [side * 0.8, 0.84, 2.12], '#e2a43c'));
    build.tail.push(box([0.28, 0.17, 0.05], [side * 0.62, 0.94, -2.12], '#ffffff'));
  }
  build.lamp = [0, 0.88, 2.2];

  build.frontWheel.push(...wheel(spec.wheelRadius, 0.21, -0.78, 6), ...wheel(spec.wheelRadius, 0.21, 0.78, 6));
  build.rearWheel.push(...wheel(spec.wheelRadius, 0.21, -0.78, 6), ...wheel(spec.wheelRadius, 0.21, 0.78, 6));
  return build;
};

// --- xe tải -------------------------------------------------------------------

const truckBuild = (paint: string, random: () => number): Build => {
  const build = emptyBuild();
  const spec = SPECS.truck;
  const dark = '#262a2e';
  const half = spec.width / 2;

  build.body.push(
    box([1.36, 0.18, 4.9], [0, 0.56, 0.1], '#3b3f43'),
    loft([1.02, 1.3, 2.3, 2.62], (z) => slab(half * (z > 2.4 ? 0.93 : 1), 0.7, z > 2.4 ? 1.86 : 2.2, 0.96), paint),
    box([half * 2, 0.5, 3.5], [0, 1.0, -0.78], paint),
    box([half * 1.96, 0.1, 3.5], [0, 1.26, -0.78], '#7b6246')
  );

  build.glass.push(
    box([half * 1.84, 0.78, 0.07], [0, 1.78, 2.56], '#10181d', [-0.13, 0, 0]),
    box([0.06, 0.6, 0.9], [-(half - 0.03), 1.66, 1.78], '#10181d'),
    box([0.06, 0.6, 0.9], [half - 0.03, 1.66, 1.78], '#10181d')
  );

  // Dropside boards with real corner stakes, which is what every small truck
  // here has and what a plain box body never looks like.
  for (const side of [-1, 1]) {
    build.body.push(
      box([0.08, 0.5, 3.5], [side * (half - 0.05), 1.56, -0.78], '#8a6f4e'),
      box([0.09, 0.56, 0.09], [side * (half - 0.05), 1.59, 0.9], '#5d4a35'),
      box([0.09, 0.56, 0.09], [side * (half - 0.05), 1.59, -2.46], '#5d4a35'),
      strut([side * (half + 0.02), 1.72, 2.44], [side * (half + 0.3), 1.72, 2.4], 0.025, dark, 5),
      box([0.08, 0.26, 0.17], [side * (half + 0.36), 1.68, 2.38], dark),
      box([0.02, 0.22, 0.14], [side * (half + 0.4), 1.68, 2.38], '#9fb0b8'),
      box([0.05, 0.42, 0.2], [side * (half - 0.04), 0.3, -1.68], '#1f2124')
    );
  }
  build.body.push(
    box([half * 1.9, 0.5, 0.08], [0, 1.56, -2.5], '#8a6f4e'),
    box([half * 2.02, 0.26, 0.18], [0, 0.48, 2.64], '#4a4e52'),
    box([1.2, 0.3, 0.08], [0, 0.95, 2.66], dark),
    box([0.46, 0.14, 0.02], [0, 0.62, 2.7], '#e8e5da')
  );

  // Sacks of rice, roped down. Stacked in two courses so the load has a shape.
  const sacks = 4 + Math.floor(random() * 4);
  for (let s = 0; s < sacks; s += 1) {
    const sack = new SphereGeometry(0.3, 8, 6);
    sack.scale(1.1, 0.74, 1.3);
    sack.rotateY(random() * Math.PI);
    sack.translate((random() - 0.5) * 1.1, 1.52 + Math.floor(s / 4) * 0.4, -0.3 - (s % 4) * 0.62);
    build.body.push({ geometry: sack, color: s % 3 === 0 ? '#cdc3a4' : '#b8ad8c' });
  }
  for (const side of [-1, 1]) {
    build.body.push(
      strut([side * (half - 0.06), 1.58, 0.7], [side * (half - 0.06) * 0.2, 2.0, -0.8], 0.014, '#4a4335', 4)
    );
  }

  for (const side of [-1, 1]) {
    build.head.push(box([0.3, 0.16, 0.06], [side * 0.62, 0.92, 2.68], '#ffffff'));
    build.tail.push(box([0.22, 0.2, 0.05], [side * 0.68, 0.78, -2.58], '#ffffff'));
  }
  build.lamp = [0, 0.92, 2.74];

  build.frontWheel.push(...wheel(spec.wheelRadius, 0.22, -0.8, 6), ...wheel(spec.wheelRadius, 0.22, 0.8, 6));
  // Twin rears, the giveaway that it is a load-carrier and not just a big car.
  for (const side of [-1, 1]) {
    build.rearWheel.push(
      ...wheel(spec.wheelRadius, 0.2, side * 0.66, 6),
      ...wheel(spec.wheelRadius, 0.2, side * 0.88, 6)
    );
  }
  return build;
};

// --- xe khách -----------------------------------------------------------------

const coachBuild = (paint: string, trim: string): Build => {
  const build = emptyBuild();
  const spec = SPECS.coach;
  const half = spec.width / 2;
  const dark = '#23262a';
  const axles = [spec.frontAxle, spec.rearAxle];

  const stations: number[] = [];
  for (let i = 0; i <= 28; i += 1) stations.push(-5.25 + (i / 28) * 10.5);

  build.body.push(
    loft(
      stations,
      (z) => {
        const t = (z + 5.25) / 10.5;
        const end = Math.max(0, Math.abs(2 * t - 1) - 0.9) / 0.1;
        const floor = 0.5 + 0.66 * archLift(z, axles, 0.9) + end * 0.14;
        return slab(half * (1 - end * 0.09), floor, 3.34 - end * 0.22, 0.93);
      },
      paint
    ),
    box([half * 2.02, 0.42, 9.6], [0, 1.6, -0.3], trim),
    box([half * 2.04, 0.14, 10.2], [0, 1.1, -0.2], trim)
  );

  build.glass.push(
    loft([-4.6, 4.3], () => slab(half - 0.04, 1.9, 2.82, 0.96), '#121b20'),
    box([half * 1.82, 1.12, 0.1], [0, 2.3, 5.14], '#121b20', [-0.1, 0, 0]),
    box([half * 1.8, 0.95, 0.09], [0, 2.26, -5.14], '#121b20', [0.08, 0, 0])
  );
  for (let p = -4; p <= 4; p += 1) {
    build.body.push(box([half * 2.06, 0.95, 0.09], [0, 2.36, p * 1.06], paint));
  }

  build.body.push(
    box([1.7, 0.3, 0.06], [0, 3.02, 5.1], dark),
    box([1.5, 0.19, 0.03], [0, 3.02, 5.14], '#d9cf9a'),
    box([half * 1.9, 0.1, 9.0], [0, 3.4, -0.3], trim),
    box([0.9, 0.72, 0.07], [RIGHT * (half - 0.01), 1.3, 2.0], dark),
    box([0.9, 0.72, 0.07], [RIGHT * (half - 0.01), 1.3, -1.6], dark),
    box([half * 2.02, 0.3, 0.2], [0, 0.72, 5.2], '#4a4e52'),
    box([half * 2.02, 0.3, 0.2], [0, 0.72, -5.2], '#4a4e52'),
    box([0.48, 0.14, 0.02], [0, 0.84, 5.28], '#e8e5da'),
    box([0.1, 1.8, 0.95], [RIGHT * (half - 0.02), 1.6, 3.6], dark)
  );
  build.glass.push(box([0.06, 1.1, 0.8], [RIGHT * (half - 0.06), 2.0, 3.6], '#121b20'));

  for (const side of [-1, 1]) {
    build.head.push(
      box([0.3, 0.17, 0.06], [side * 0.86, 1.08, 5.24], '#ffffff'),
      box([0.2, 0.13, 0.05], [side * 1.06, 0.86, 5.24], '#ffffff')
    );
    build.tail.push(
      box([0.24, 0.2, 0.05], [side * 0.88, 1.1, -5.24], '#ffffff'),
      box([0.18, 0.14, 0.05], [side * 1.04, 0.86, -5.24], '#ffffff')
    );
    // Roof marker lamps: how you see one of these coming round a bend at night.
    for (let m = -1; m <= 1; m += 1) build.tail.push(box([0.1, 0.06, 0.1], [side * 1.0, 3.3, m * 2.4], '#ffffff'));
    build.body.push(
      strut([side * (half + 0.02), 2.6, 4.95], [side * (half + 0.34), 2.6, 4.88], 0.028, dark, 5),
      box([0.09, 0.32, 0.2], [side * (half + 0.42), 2.54, 4.86], dark)
    );
  }
  build.lamp = [0, 1.08, 5.32];

  build.frontWheel.push(...wheel(spec.wheelRadius, 0.26, -1.06, 8), ...wheel(spec.wheelRadius, 0.26, 1.06, 8));
  for (const side of [-1, 1]) {
    build.rearWheel.push(
      ...wheel(spec.wheelRadius, 0.24, side * 0.9, 8),
      ...wheel(spec.wheelRadius, 0.24, side * 1.16, 8)
    );
  }

  // Left-hand drive, because the traffic keeps right.
  build.rider.push(
    ...seatedRider(
      [-RIGHT * 0.72, 1.72, 4.1],
      [-RIGHT * 0.72, 1.84, 4.52],
      [-RIGHT * 0.72, 1.24, 4.6],
      { shirt: '#d8d3c4', trousers: '#2f3440', skin: SKIN[0], hat: 'cap', helmet: '#2d3136' },
      0.1,
      { grip: 0.2, foot: 0.14 }
    )
  );
  return build;
};

// --- xe đạp -------------------------------------------------------------------

const bicycleBuild = (paint: string, random: () => number): Build => {
  const build = emptyBuild();
  const spec = SPECS.bicycle;
  const r = spec.wheelRadius;
  const axle = spec.frontAxle;
  const bb: [number, number, number] = [0, 0.29, -0.06];
  const seatTop: [number, number, number] = [0, 0.96, -0.28];
  const headTop: [number, number, number] = [0, 0.96, axle - 0.08];

  build.body.push(
    strut(bb, seatTop, 0.019, paint, 5),
    strut(bb, headTop, 0.021, paint, 5),
    strut(seatTop, headTop, 0.018, paint, 5),
    strut(bb, [0, r, spec.rearAxle], 0.015, paint, 5),
    strut(seatTop, [0, r, spec.rearAxle], 0.013, paint, 5),
    box([0.17, 0.05, 0.26], [0, 0.99, -0.3], '#2a2b2e'),
    tube([0.095, 0.095], 0.012, [0, 0.29, -0.02], '#9fa4a7', [0, 0, Math.PI / 2], 16),
    box([0.1, 0.04, 0.06], [0, 0.76, -0.42], '#9fa4a7'),
    tube([0.16, 0.13], 0.22, [0, 0.76, axle + 0.08], '#b39a6e', undefined, 12),
    tube([0.165, 0.165], 0.022, [0, 0.87, axle + 0.08], '#8d7a55', undefined, 12)
  );
  if (random() < 0.6) {
    const bundle = new SphereGeometry(0.15, 8, 6);
    bundle.scale(1.1, 0.8, 1);
    bundle.translate(0, 0.91, axle + 0.08);
    build.body.push({ geometry: bundle, color: '#5f7a44' });
  }

  build.steer.push(
    strut([0, 0.98, axle - 0.08], [0, r, axle], 0.018, paint, 5),
    tube([0.013, 0.013], 0.5, [0, 1.02, axle - 0.1], '#9fa4a7', [0, 0, Math.PI / 2], 6)
  );
  for (const side of [-1, 1]) {
    build.steer.push(tube([0.019, 0.019], 0.11, [side * 0.2, 1.02, axle - 0.1], '#2a2b2e', [0, 0, Math.PI / 2], 6));
  }

  build.frontWheel.push(...wheel(r, 0.05, 0, 9, '#c6cbce'));
  build.rearWheel.push(...wheel(r, 0.05, 0, 9, '#c6cbce'));
  // No headlight. Half of them have none, and the rear reflector is the only
  // thing that lights up — which is itself the honest night-time silhouette.
  build.tail.push(box([0.07, 0.05, 0.02], [0, 0.72, -0.44], '#ffffff'));

  build.rider.push(
    ...seatedRider(
      [0, 1.03, -0.3],
      [0, 1.04, axle - 0.08],
      [0, 0.34, 0.0],
      dress(random, random() < 0.5 ? 'non-la' : 'cap'),
      0.18,
      {
        grip: 0.2,
        foot: 0.15,
      }
    )
  );
  for (const side of [-1, 1]) {
    build.swing.push({
      parts: [
        box([0.03, 0.17, 0.03], [0, -0.085, 0], '#8e9397'),
        box([0.075, 0.03, 0.12], [side * 0.05, -0.17, 0], '#2a2b2e'),
      ],
      at: [side * 0.08, bb[1], bb[2]],
      phase: side > 0 ? 0 : Math.PI,
      gain: 1,
    });
  }
  return build;
};

// --- xích lô ------------------------------------------------------------------

const cycloBuild = (paint: string, random: () => number): Build => {
  const build = emptyBuild();
  const spec = SPECS.cyclo;
  const r = spec.wheelRadius;
  const frame = '#4d5a63';

  build.body.push(
    box([1.1, 0.07, 0.9], [0, 0.42, 0.82], '#6b5842'),
    box([1.0, 0.5, 0.08], [0, 0.72, 0.42], paint),
    box([1.02, 0.12, 0.08], [0, 1.0, 0.44], '#3a3024'),
    box([0.07, 0.4, 0.84], [-0.52, 0.66, 0.82], paint),
    box([0.07, 0.4, 0.84], [0.52, 0.66, 0.82], paint),
    box([0.96, 0.05, 0.3], [0, 0.3, 1.28], '#6b5842'),
    strut([-0.5, 0.38, 0.4], [0, 0.46, -0.5], 0.028, frame, 5),
    strut([0.5, 0.38, 0.4], [0, 0.46, -0.5], 0.028, frame, 5),
    strut([-0.52, r, 0.95], [0.52, r, 0.95], 0.022, frame, 5),
    strut([0, 0.46, -0.5], [0, 0.3, -1.02], 0.024, frame, 5),
    strut([0, 1.04, -0.56], [0, 0.34, -0.3], 0.02, frame, 5),
    box([0.16, 0.05, 0.24], [0, 1.08, -0.58], '#2a2b2e'),
    tube([0.014, 0.014], 0.44, [0, 1.12, -0.18], '#9fa4a7', [0, 0, Math.PI / 2], 6),
    tube([0.09, 0.09], 0.01, [0, 0.34, -0.3], '#9fa4a7', [0, 0, Math.PI / 2], 14)
  );

  // The folding hood over the passenger, which is what a xích lô is known by.
  for (let rib = 0; rib < 3; rib += 1) {
    const hood = new TorusGeometry(0.56, 0.028, 4, 10, Math.PI);
    hood.rotateY(Math.PI / 2);
    hood.translate(0, 0.98, 1.0 + rib * 0.24);
    build.body.push({ geometry: hood, color: frame });
  }
  build.body.push(
    loft(
      [0.98, 1.22, 1.5],
      () => [
        [-0.58, 0.98],
        [-0.42, 1.44],
        [0.42, 1.44],
        [0.58, 0.98],
      ],
      '#2f4858'
    )
  );

  build.frontWheel.push(...wheel(r, 0.05, -0.52, 9, '#c6cbce'), ...wheel(r, 0.05, 0.52, 9, '#c6cbce'));
  build.rearWheel.push(...wheel(r + 0.01, 0.05, 0, 9, '#c6cbce'));
  build.tail.push(box([0.07, 0.05, 0.02], [0, 0.4, -1.16], '#ffffff'));

  build.rider.push(
    ...seatedRider([0, 1.12, -0.54], [0, 1.12, -0.2], [0, 0.46, -0.3], dress(random, 'non-la'), 0.2, {
      grip: 0.18,
      foot: 0.14,
    })
  );
  if (random() < 0.7) {
    build.rider.push(
      ...seatedRider([0, 0.62, 0.74], [0, 0.66, 1.0], [0, 0.34, 1.24], dress(random, 'none'), -0.05, {
        grip: 0.22,
        foot: 0.17,
      })
    );
  }
  for (const side of [-1, 1]) {
    build.swing.push({
      parts: [
        box([0.03, 0.16, 0.03], [0, -0.08, 0], '#8e9397'),
        box([0.07, 0.03, 0.11], [side * 0.05, -0.16, 0], '#2a2b2e'),
      ],
      at: [side * 0.08, 0.34, -0.3],
      phase: side > 0 ? 0 : Math.PI,
      gain: 1,
    });
  }
  return build;
};

// --- xe trâu ------------------------------------------------------------------

const buffaloCartBuild = (random: () => number): Build => {
  const build = emptyBuild();
  const spec = SPECS['buffalo-cart'];
  const wood = '#7b6246';
  const hide = '#4a4540';

  build.body.push(
    box([1.34, 0.1, 2.1], [0, 0.78, -0.3], wood),
    box([1.4, 0.12, 0.14], [0, 0.72, -1.28], '#5d4a35'),
    box([1.4, 0.12, 0.14], [0, 0.72, 0.66], '#5d4a35'),
    box([0.12, 0.44, 2.1], [-0.65, 1.04, -0.3], '#8a6f4e'),
    box([0.12, 0.44, 2.1], [0.65, 1.04, -0.3], '#8a6f4e'),
    box([1.34, 0.44, 0.1], [0, 1.04, -1.33], '#8a6f4e'),
    box([0.16, 0.16, 0.5], [0, 0.72, -0.3], '#5d4a35'),
    strut([-0.5, 0.74, 0.6], [-0.42, 0.92, 2.42], 0.045, wood, 6),
    strut([0.5, 0.74, 0.6], [0.42, 0.92, 2.42], 0.045, wood, 6),
    box([1.16, 0.1, 0.12], [0, 0.95, 2.44], '#5d4a35')
  );

  for (const side of [-1, 1]) build.rearWheel.push(...cartWheel(spec.wheelRadius, side * 0.78));

  const bales = 3 + Math.floor(random() * 3);
  for (let b = 0; b < bales; b += 1) {
    build.body.push(
      tube(
        [0.26, 0.26],
        1.1,
        [(random() - 0.5) * 0.5, 1.12 + Math.floor(b / 2) * 0.46, -0.3 - (b % 2) * 0.6],
        '#c9b574',
        [0, (random() - 0.5) * 0.2, Math.PI / 2],
        9
      )
    );
  }

  // --- con trâu -------------------------------------------------------------
  const barrel = new SphereGeometry(0.52, 12, 9);
  barrel.scale(0.92, 0.9, 1.5);
  barrel.translate(0, 1.0, 3.5);
  build.body.push({ geometry: barrel, color: hide });
  build.body.push(
    box([0.78, 0.5, 0.5], [0, 1.26, 3.0], hide),
    strut([0, 1.1, 4.3], [0, 0.92, 4.86], 0.2, hide, 7),
    box([0.3, 0.24, 0.26], [0, 0.86, 5.0], '#3a3631'),
    box([0.2, 0.08, 0.1], [0, 0.78, 5.12], '#262320'),
    strut([0, 1.18, 2.98], [0, 1.02, 2.3], 0.035, hide, 5),
    box([1.1, 0.1, 0.14], [0, 1.44, 3.3], '#6b5339')
  );
  for (const side of [-1, 1]) {
    const horn = new TorusGeometry(0.26, 0.035, 4, 9, Math.PI * 0.8);
    horn.rotateX(Math.PI / 2);
    horn.rotateZ(side * 0.5);
    horn.translate(side * 0.16, 1.1, 4.82);
    build.body.push(
      { geometry: horn, color: '#b8ae96' },
      box([0.1, 0.18, 0.06], [side * 0.26, 1.0, 4.76], hide),
      strut([side * 0.44, 1.44, 3.3], [side * 0.42, 0.98, 2.5], 0.022, '#4a4335', 4)
    );
  }

  for (const side of [-1, 1]) {
    for (const along of [3.02, 4.0]) {
      build.swing.push({
        parts: [strut([0, 0, 0], [0, -0.78, 0.04], 0.07, hide, 6), box([0.14, 0.09, 0.2], [0, -0.82, 0.08], '#2b2823')],
        at: [side * 0.3, 0.98, along],
        phase: (side > 0 ? 0 : Math.PI) + (along > 3.5 ? Math.PI : 0),
        gain: 0.26,
      });
    }
  }

  build.rider.push(
    ...seatedRider(
      [-RIGHT * 0.3, 0.98, 0.4],
      [-RIGHT * 0.3, 1.04, 0.86],
      [-RIGHT * 0.3, 0.5, 0.78],
      { shirt: '#8a7f66', trousers: '#4a4237', skin: SKIN[2], hat: 'non-la', helmet: '#3b4149' },
      0.12,
      { grip: 0.18, foot: 0.15 }
    )
  );
  return build;
};

// --- the module ---------------------------------------------------------------

type Swing = { node: Object3D; phase: number; gain: number };

type Rig = {
  group: Group;
  rearAxle: Object3D;
  frontAxle: Object3D;
  steer: Object3D | null;
  rider: Object3D | null;
  swings: Swing[];
  tail: Mesh | null;
  glow: Mesh | null;
};

type Agent = Rig & {
  spec: Spec;
  road: number;
  /** +1 with the centreline, −1 against it. Vietnam drives on the right either way. */
  dir: number;
  distance: number;
  /** Metres right of the centreline, in the direction of travel. */
  lane: number;
  speed: number;
  cruise: number;
  spin: number;
  crank: number;
  braking: number;
  bob: number;
};

export type Vehicles = {
  group: Group;
  /** Seconds since scene start. Deltas come out of it, so it must be monotonic. */
  update: (elapsed: number) => void;
  setNight: (amount: number) => void;
  /** Lights come on in heavy rain too, and everything slows down in it. */
  setWeather: (weather: WorldWeather) => void;
  /**
   * The parked xe máy, which are the ones that can be taken. The moving fleet is
   * not offered: every agent is a position on a queue along one centreline, and a
   * rider who took one out of it would be fighting the car behind for the lane.
   */
  rideables: () => Rideable[];
  dispose: () => void;
};

const PAINT = ['#b23a2e', '#2f4858', '#c9c3b4', '#3f6049', '#d9b24c', '#6f5a7d', '#1f2a33', '#a8562e'];

const LAMP_DAY = new Color('#43443e');
const LAMP_NIGHT = new Color('#fff0c8');
const TAIL_DAY = new Color('#4a2420');
const TAIL_NIGHT = new Color('#c4291e');

/** A motorbike will take a trail, but at a crawl, and only one of them will. */
const TRAIL_CRUISE = 4.2;

/**
 * What the one you ride yourself will do.
 *
 * `SPECS.motorbike.cruise` is 11.5 m/s, which is what a Wave does on an open
 * straight with a rider who knows the road. The player does not: they are
 * reading a lane they have never seen off a camera, between houses, trees and
 * traffic that does not see them. 9 m/s is 32 km/h — a village lane speed, twice
 * `JOG_SPEED`'s 4.5, and 0.64 of the 14 m/s travel stride, so covering ground on
 * foot stays the fastest way to cross a map and the bike stays the way you look
 * at one on the way past.
 *
 * Everything else is the machine's own: the acceleration, the brakes and the
 * grip that sets the turning circle are `SPECS.motorbike`, because it is the
 * same motorbike.
 */
const RIDER_TOP = 9;
/** m/s backwards — a rider paddling it off the kerb with their feet. */
const RIDER_REVERSE = 1.2;
/**
 * Rad/s at a crawl. The grip law gives `grip / v`, which runs away as the bike
 * slows, and this is where the rider's own feet take over: 1.1 rad/s is 63°/s, a
 * U-turn in a lane's width, and it is reached at 4.7 m/s.
 */
const RIDER_PIVOT = 1.1;
/**
 * The steepest bare ground it will take: 0.45 is 24°, which is a dirt ramp off a
 * kerb and not a hillside. Measured against the four road networks, no
 * centreline sample is both off a published surface and steeper than this, so
 * the limit never stands between a rider and a road — including Tà Xùa's, whose
 * terrain under the carriageway averages a gradient of 0.60 and reaches 2.64.
 * A walker is allowed 1.15 (49°) because a body can scramble; a motorbike on a
 * 49° slope is a bug.
 */
const RIDER_CLIMB = 0.45;
/** Metres of water it will ride through. A flooded lane, not a river. */
const RIDER_FORD = 0.25;
/** Metres the wheels sit clear of the surface, as the parked bikes always did. */
const TYRE_LIFT = 0.01;
/** Where the saddle is on the Wave build: `seatedRider`'s hip. */
const SADDLE_HEIGHT = 0.86;
/** Over on its side stand, the only way one of these ever stands still. */
const PARK_LEAN = 0.12;

/**
 * Xe máy, xe con, xe tải, xe khách, xe đạp, xích lô, xe trâu — a handful of them,
 * each built properly, driving the centrelines the road network hands over.
 *
 * Nothing here is instanced. At sixteen vehicles the win would be a few draw
 * calls and the cost would be every detail that makes a motorbike read as a
 * motorbike. What is shared is the materials; each vehicle's static bodywork is
 * merged into one vertex-coloured geometry, so a bike with ninety parts still
 * costs one draw call for its body.
 */
export const createVehicles = (
  recipe: LocationRecipe,
  network: RoadNetwork,
  count: number,
  /** Only the parked bikes need it: a kerb-side spot has to stand on something. */
  terrain: Terrain
): Vehicles => {
  const random = createPrng(`${recipe.seed}:vehicles`);
  const group = new Group();
  group.name = 'vehicles';

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const keep = <T extends Material>(material: T): T => {
    materials.push(material);
    return material;
  };

  const bodyMaterial = keep(
    new MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.55,
      metalness: 0.08,
      side: DoubleSide,
    })
  );
  const glassMaterial = keep(
    new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.12,
      metalness: 0.1,
      transparent: true,
      opacity: 0.86,
      side: DoubleSide,
    })
  );
  // Unlit materials, so their colour is the whole of their brightness: by day
  // the lenses have to be dark glass or they glow at noon, which is the mistake
  // that made the river turquoise at midnight.
  const lampMaterial = keep(new MeshBasicMaterial({ color: LAMP_DAY.clone() }));
  const tailMaterial = keep(new MeshBasicMaterial({ color: TAIL_DAY.clone() }));
  const brakeMaterial = keep(new MeshBasicMaterial({ color: new Color('#ff3a24') }));
  const glowMaterial = keep(
    new MeshBasicMaterial({
      color: new Color('#ffe7b8'),
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    })
  );

  // One cone, shared by everything with a headlight: apex at the lamp, mouth
  // seven metres down the road.
  const glowGeometry = new ConeGeometry(1.25, 7, 10, 1, true);
  glowGeometry.rotateX(-Math.PI / 2);
  glowGeometry.translate(0, 0, 3.5);
  geometries.push(glowGeometry);

  const buildFor = (kind: VehicleKind): Build => {
    const paint = pick(PAINT, random);
    switch (kind) {
      case 'motorbike':
        return motorbikeBuild(paint, false, random);
      case 'motorbike-cargo':
        return motorbikeBuild(paint, true, random);
      case 'car':
        return carBuild(paint, random);
      case 'truck':
        return truckBuild(paint, random);
      case 'coach':
        return coachBuild(paint, pick(PAINT, random));
      case 'bicycle':
        return bicycleBuild(paint, random);
      case 'cyclo':
        return cycloBuild(paint, random);
      default:
        return buffaloCartBuild(random);
    }
  };

  const addMesh = (parent: Object3D, parts: Part[], material: Material, shift: number): Mesh | null => {
    if (parts.length === 0) return null;
    // mergeParts consumes its inputs, so a Build is good for exactly one rig.
    if (shift !== 0) for (const part of parts) part.geometry.translate(0, 0, shift);
    const geometry = mergeParts(parts);
    if (!geometry) return null;
    const mesh = new Mesh(geometry, material);
    mesh.castShadow = true;
    geometries.push(geometry);
    parent.add(mesh);
    return mesh;
  };

  /**
   * Hangs one Build on its pivots. Every part list arrives in vehicle
   * coordinates and is rebased here, which is the only place that has to know
   * where a node sits — do it in the builders and a lamp ends up half a metre
   * behind the wheel it is bolted to.
   */
  const assemble = (kind: VehicleKind, build: Build): Rig => {
    const spec = SPECS[kind];
    const vehicle = new Group();
    vehicle.name = kind;
    // Yaw, then pitch, then roll in the body's own frame. The default XYZ order
    // applies pitch in world space, which tips a cornering vehicle sideways.
    vehicle.rotation.order = 'YXZ';

    addMesh(vehicle, build.body, bodyMaterial, 0);
    addMesh(vehicle, build.glass, glassMaterial, 0);

    const rearAxle = new Object3D();
    rearAxle.position.set(0, spec.wheelRadius, spec.rearAxle);
    vehicle.add(rearAxle);
    addMesh(rearAxle, build.rearWheel, bodyMaterial, 0);

    const steer = spec.steersFront ? new Object3D() : null;
    if (steer) {
      steer.position.set(0, 0, spec.frontAxle);
      vehicle.add(steer);
      addMesh(steer, build.steer, bodyMaterial, -spec.frontAxle);
    } else {
      addMesh(vehicle, build.steer, bodyMaterial, 0);
    }

    const frontAxle = new Object3D();
    if (steer) {
      frontAxle.position.set(0, spec.wheelRadius, 0);
      steer.add(frontAxle);
    } else {
      frontAxle.position.set(0, spec.wheelRadius, spec.frontAxle);
      vehicle.add(frontAxle);
    }
    addMesh(frontAxle, build.frontWheel, bodyMaterial, 0);

    // On two wheels the headlight swings with the bars, which is most of why a
    // motorbike at night reads as a motorbike and not a lamp on a rail.
    const onSteer = spec.lampOnSteer && steer !== null;
    const lampParent = onSteer && steer ? steer : vehicle;
    const lampShift = onSteer ? -spec.frontAxle : 0;
    addMesh(lampParent, build.head, lampMaterial, lampShift);
    const tail = addMesh(vehicle, build.tail, tailMaterial, 0);

    let glow: Mesh | null = null;
    if (build.lamp) {
      glow = new Mesh(glowGeometry, glowMaterial);
      glow.position.set(build.lamp[0], build.lamp[1], build.lamp[2] + lampShift);
      glow.visible = false;
      lampParent.add(glow);
    }

    const rider = build.rider.length > 0 ? new Object3D() : null;
    if (rider) {
      vehicle.add(rider);
      addMesh(rider, build.rider, bodyMaterial, 0);
    }

    const swings: Swing[] = [];
    for (const entry of build.swing) {
      const node = new Object3D();
      node.position.set(entry.at[0], entry.at[1], entry.at[2]);
      vehicle.add(node);
      // Swing parts are given relative to their own pivot already.
      addMesh(node, entry.parts, bodyMaterial, 0);
      swings.push({ node, phase: entry.phase, gain: entry.gain });
    }

    group.add(vehicle);
    return { group: vehicle, rearAxle, frontAxle, steer, rider, swings, tail, glow };
  };

  // --- deal the fleet out ---------------------------------------------------
  const agents: Agent[] = [];
  const hasLane = network.roads.some((road) => road.kind === 'lane');
  const hasSealed = network.roads.some((road) => road.kind === 'main' || road.kind === 'secondary');
  const roster = ROSTERS[styleOf(recipe)];
  let trailRiders = 0;

  const wanted = Math.max(0, Math.min(roster.length, Math.floor(count)));
  for (let i = 0; i < wanted && network.roads.length > 0; i += 1) {
    let kind = roster[i];
    // Substitutions, not omissions: a location with no sealed road still gets
    // its full count, it just gets all of it in xe máy. A cart needs a lane for
    // the same reason — there is nothing for it to be on a bare trail.
    if ((kind === 'coach' || kind === 'truck') && !hasSealed) kind = 'motorbike';
    if (kind === 'buffalo-cart' && !hasLane) kind = 'motorbike-cargo';

    const allowed = (spec: Spec) =>
      network.roads.filter(
        // A đường mòn is walked, not driven — except that a Wave will go up one,
        // which is very much a Vietnamese thing and worth exactly one of them.
        (road) => spec.roads.includes(road.kind) && (road.kind !== 'trail' || (kind === 'motorbike' && trailRiders < 1))
      );

    let candidates = allowed(SPECS[kind]);
    if (candidates.length === 0) {
      kind = 'motorbike';
      candidates = allowed(SPECS.motorbike);
    }
    if (candidates.length === 0) break;

    // Weighted by length, so a four-kilometre trunk carries the traffic and a
    // two-hundred-metre lane carries one bike. A trail is quartered: it is a
    // path that happens to admit a motorbike, not a road that wants one.
    const weigh = (kind2: RoadKind, length: number) => (kind2 === 'trail' ? length * 0.25 : length);
    let total = 0;
    for (const road of candidates) total += weigh(road.kind, road.totalLength);
    let roll = random() * total;
    let chosen = candidates[0];
    for (const road of candidates) {
      roll -= weigh(road.kind, road.totalLength);
      if (roll <= 0) {
        chosen = road;
        break;
      }
    }

    const spec = SPECS[kind];
    const rig = assemble(kind, buildFor(kind));
    // Nothing passes on a trail and nothing comes the other way down one.
    const single = chosen.kind === 'trail';
    if (single) trailRiders += 1;
    const dir = single ? 1 : i % 2 === 0 ? 1 : -1;
    const cruise = spec.cruise * (0.86 + random() * 0.24);

    agents.push({
      ...rig,
      spec,
      road: chosen.index,
      dir,
      distance: random() * chosen.totalLength,
      lane: dir * Math.min(chosen.laneOffset, chosen.width * 0.26),
      speed: cruise * 0.6,
      cruise: single ? Math.min(cruise, TRAIL_CRUISE) : cruise,
      spin: random() * Math.PI * 2,
      crank: random() * Math.PI * 2,
      braking: 0,
      bob: random() * Math.PI * 2,
    });
  }

  // --- parked xe máy, which are the ones you can take ------------------------
  const parked: Rideable[] = [];
  /** True while the player has it: its lamp is lit and its rider is drawn. */
  const taken = new Set<string>();
  /** Each parked bike's headlight cone, so `applyLights` can find it by id. */
  const glows = new Map<string, Mesh>();

  /**
   * The highest published surface over a point, or null where none covers it.
   * The same rectangles `walker.floorAt` reads, asked here because a parked bike
   * has to stand on the floor the rider will be standing on.
   */
  const deckUnder = (x: number, z: number, reference: number): number | null => {
    let best: number | null = null;
    for (const deck of network.decks) {
      const dx = x - deck.x;
      const dz = z - deck.z;
      const alongX = Math.sin(deck.yaw);
      const alongZ = Math.cos(deck.yaw);
      const along = dx * alongX + dz * alongZ;
      if (Math.abs(along) > deck.halfLength) continue;
      if (Math.abs(dx * alongZ - dz * alongX) > deck.halfWidth) continue;
      const surface = deck.surfaceY + (deck.grade ?? 0) * along;
      // A span crossing overhead is not this spot's floor.
      if (surface > reference + 0.4) continue;
      if (best === null || surface > best) best = surface;
    }
    return best;
  };

  /**
   * Where a kerb-side spot actually stands.
   *
   * `road-network` puts a spot 1.9 m beyond the kerb and gives it the
   * centreline's height — which on a road cut as a shelf is the height of the
   * carriageway and not of the verge, and on a draped one is a few centimetres
   * off the dirt. Measured: at Tà Xùa the six spots hang 6.00 to 8.31 m over the
   * hillside, at Hội An three of them sit 0.08 to 0.38 m into it. A bike you walk
   * up to and get on cannot be in the air, so the spot is carried in across the
   * kerb until the carriageway's own deck is under it, and failing that dropped
   * onto the ground where it stands.
   */
  const stand = (spot: ParkingSpot): { x: number; y: number; z: number } => {
    for (let step = 0; step <= 6.001; step += 0.25) {
      for (const side of step === 0 ? [1] : [-1, 1]) {
        const x = spot.x + Math.sin(spot.heading) * side * step;
        const z = spot.z + Math.cos(spot.heading) * side * step;
        const deck = deckUnder(x, z, spot.y);
        if (deck !== null) return { x, y: deck, z };
      }
    }
    return { x: spot.x, y: terrain.heightAt(spot.x, spot.z), z: spot.z };
  };

  // Scaled with the tier the way the fleet is, but never to none: these are not
  // scenery any more, they are how the player gets about, so the lowest tier
  // still gets one. Static until somebody takes one, so the rest cost nothing.
  const slots = Math.min(3, network.parking.length, Math.max(1, Math.floor(count / 4)));
  for (let i = 0; i < slots && network.parking.length > 0; i += 1) {
    const spot = network.parking[Math.floor((i / slots) * network.parking.length)];
    const spec = SPECS.motorbike;
    const rig = assemble('motorbike', motorbikeBuild(pick(PAINT, random), false, random, true));
    const where = stand(spot);
    rig.group.name = 'motorbike-parked';
    rig.group.position.set(where.x, where.y + TYRE_LIFT, where.z);
    rig.group.rotation.y = spot.heading;
    rig.group.rotation.z = PARK_LEAN;
    // Nobody sits on a bike on its stand. The figure is the rider you become.
    if (rig.rider) rig.rider.visible = false;

    const id = `motorbike-${i}`;
    if (rig.glow) {
      rig.glow.visible = false;
      glows.set(id, rig.glow);
    }
    const forward = new Vector3(Math.sin(spot.heading), 0, Math.cos(spot.heading));
    const wheelbase = spec.frontAxle - spec.rearAxle;
    let spin = 0;

    const machine: Machine = {
      topSpeed: RIDER_TOP,
      reverse: RIDER_REVERSE,
      accel: spec.accel,
      brake: spec.brake,
      grip: spec.grip,
      pivot: RIDER_PIVOT,
      climb: RIDER_CLIMB,
      ford: RIDER_FORD,
      mount: () => {
        taken.add(id);
        if (rig.rider) rig.rider.visible = true;
        rig.group.rotation.z = 0;
        applyLights();
      },
      place: (at: Ridden) => {
        rig.group.position.set(at.x, at.y + TYRE_LIFT, at.z);
        rig.group.rotation.y = at.heading;
        // Nose up the hill, and down on the brakes the way the fleet does it.
        rig.group.rotation.x = -Math.atan(at.grade);
        // The angle a free body takes through the bend, which on two wheels is
        // the whole of it. `turn` is positive to the left and +Z rolls toward −X,
        // so the sign puts it into the corner rather than out of it.
        rig.group.rotation.z = -Math.atan((at.speed * at.turn) / GRAVITY) * spec.leanGain;
        if (rig.steer) {
          // Ackermann off the same yaw rate. Below a walking pace the bars would
          // ask for full lock, which is right but reads as a twitch, so the
          // divisor floors at 1.5 m/s.
          const lock = Math.atan((wheelbase * at.turn) / Math.max(1.5, Math.abs(at.speed)));
          rig.steer.rotation.y = Math.max(-0.52, Math.min(0.52, lock));
        }
        spin += (at.speed * at.delta) / spec.wheelRadius;
        rig.rearAxle.rotation.x = spin;
        rig.frontAxle.rotation.x = spin;
        forward.set(Math.sin(at.heading), 0, Math.cos(at.heading));
      },
      park: () => {
        taken.delete(id);
        if (rig.rider) rig.rider.visible = false;
        rig.group.rotation.x = 0;
        rig.group.rotation.z = PARK_LEAN;
        applyLights();
      },
    };

    parked.push({
      id,
      noun: 'xe máy',
      // The rig's own vector, so it is never copied and never stale.
      position: rig.group.position,
      forward,
      deckHeight: SADDLE_HEIGHT,
      bounds: { across: spec.width / 2, along: spec.length / 2 },
      // The saddle, which on a machine is where the rider is the moment they are
      // on it — there is no walking aft to the oar.
      helmStation: { along: -0.18, across: 0 },
      machine,
    });
  }

  // --- queues, so each vehicle knows what is in front of it -----------------
  const queues: number[][] = [];
  const queueOf = new Map<string, number[]>();
  agents.forEach((agent, index) => {
    const key = `${agent.road}:${agent.dir}`;
    let queue = queueOf.get(key);
    if (!queue) {
      queue = [];
      queueOf.set(key, queue);
      queues.push(queue);
    }
    queue.push(index);
  });

  // --- per-frame scratch, hoisted: the tick allocates nothing ---------------
  const here: RoadSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, curvature: 0 };
  const ahead: RoadSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, curvature: 0 };

  let last = -1;
  let lit = 0;
  let wet = 0;
  let slow = 1;

  const update = (elapsed: number) => {
    if (agents.length === 0) return;
    const delta = last < 0 ? 0.016 : Math.min(0.1, Math.max(0, elapsed - last));
    last = elapsed;

    for (const queue of queues) {
      // Insertion sort on progress. The order barely changes between frames, so
      // this is linear in practice, and it never allocates.
      for (let i = 1; i < queue.length; i += 1) {
        const index = queue[i];
        const key = agents[index].distance * agents[index].dir;
        let j = i - 1;
        while (j >= 0 && agents[queue[j]].distance * agents[queue[j]].dir > key) {
          queue[j + 1] = queue[j];
          j -= 1;
        }
        queue[j + 1] = index;
      }

      for (let i = 0; i < queue.length; i += 1) {
        const agent = agents[queue[i]];
        const road = network.roads[agent.road];
        const spec = agent.spec;
        const look = Math.max(6, agent.speed * 1.6);

        network.sampleAt(agent.road, agent.distance, here);
        network.sampleAt(agent.road, agent.distance + agent.dir * look, ahead);

        // Slow for the bend. A corner is taken at the speed the grip allows, and
        // the whole character of a mountain road comes out of this one line.
        const bend = Math.abs(ahead.curvature) * 0.65 + Math.abs(here.curvature) * 0.35;
        let target = agent.cruise * slow;
        if (bend > 1e-4) target = Math.min(target, Math.sqrt(spec.grip / bend));

        if (queue.length > 1) {
          const leader = agents[queue[(i + 1) % queue.length]];
          let gap = (leader.distance - agent.distance) * agent.dir;
          if (gap < 0) gap += road.totalLength;
          gap -= (spec.length + leader.spec.length) / 2;
          const want = spec.gap + agent.speed * 0.9;
          if (gap < want) target = Math.min(target, Math.max(0, (gap / want) * target));
        }

        const was = agent.speed;
        if (target > agent.speed) agent.speed = Math.min(target, agent.speed + spec.accel * delta);
        else agent.speed = Math.max(0, Math.max(target, agent.speed - spec.brake * delta));

        const shedding = delta > 0 ? (was - agent.speed) / delta : 0;
        agent.braking += ((shedding > spec.brake * 0.18 ? 1 : 0) - agent.braking) * Math.min(1, delta * 9);

        agent.distance += agent.dir * agent.speed * delta;
        if (agent.distance > road.totalLength) agent.distance -= road.totalLength;
        if (agent.distance < 0) agent.distance += road.totalLength;

        const fx = here.tx * agent.dir;
        const fz = here.tz * agent.dir;
        // Right of travel is (−fz, fx), the same convention the road network uses
        // for its own lane offsets and kerbside furniture.
        agent.group.position.set(here.x - fz * agent.lane, here.y + 0.012, here.z + fx * agent.lane);
        agent.group.rotation.y = Math.atan2(fx, fz);
        agent.group.rotation.x = -Math.atan2((ahead.y - here.y) * agent.dir, look) + agent.braking * 0.022;

        const turn = here.curvature * agent.dir;
        const lean = Math.atan((agent.speed * agent.speed * turn) / GRAVITY) * spec.leanGain;
        agent.group.rotation.z = -Math.max(-0.55, Math.min(0.55, lean));

        if (agent.steer) {
          const wheelbase = spec.frontAxle - spec.rearAxle;
          agent.steer.rotation.y = Math.max(-0.52, Math.min(0.52, Math.atan(wheelbase * turn)));
        }

        agent.spin += (agent.speed * delta) / spec.wheelRadius;
        agent.rearAxle.rotation.x = agent.spin;
        agent.frontAxle.rotation.x = agent.spin;

        if (agent.swings.length > 0) {
          agent.crank += agent.speed * delta * 1.9;
          for (const swing of agent.swings) {
            swing.node.rotation.x = Math.sin(agent.crank + swing.phase) * 0.42 * swing.gain;
          }
        }

        if (agent.rider) {
          // The rider stays a little more upright than the machine, and the road
          // surface comes up through the seat.
          agent.rider.rotation.z = -agent.group.rotation.z * 0.22;
          agent.rider.position.y = Math.sin(elapsed * 7.3 + agent.bob) * 0.006 * Math.min(1, agent.speed / 6);
        }

        if (agent.tail) agent.tail.material = agent.braking > 0.4 ? brakeMaterial : tailMaterial;
      }
    }
  };

  const applyLights = () => {
    // Daylight in heavy rain is dark enough that everyone has their lights on.
    const on = Math.max(lit, wet > 0.32 ? 0.65 : 0);
    lampMaterial.color.copy(LAMP_DAY).lerp(LAMP_NIGHT, on);
    tailMaterial.color.copy(TAIL_DAY).lerp(TAIL_NIGHT, on);
    glowMaterial.opacity = on * 0.085;
    for (const agent of agents) {
      if (agent.glow) agent.glow.visible = on > 0.08;
    }
    // A bike on its stand has its ignition off; the one being ridden does not.
    for (const bike of parked) {
      const glow = glows.get(bike.id);
      if (glow) glow.visible = on > 0.08 && taken.has(bike.id);
    }
  };

  return {
    group,
    update,
    setNight: (amount) => {
      lit = Math.min(1, Math.max(0, amount));
      applyLights();
    },
    rideables: () => parked,
    setWeather: (weather) => {
      wet = weather.rainIntensity;
      // Nobody drives a wet mountain road at the speed they drive a dry one.
      slow = 1 - wet * 0.26;
      applyLights();
    },
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      group.clear();
      agents.length = 0;
      parked.length = 0;
      glows.clear();
      taken.clear();
      queues.length = 0;
      queueOf.clear();
    },
  };
};
