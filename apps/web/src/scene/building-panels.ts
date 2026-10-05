import { BufferAttribute, BufferGeometry } from 'three';

/**
 * Assemblies of small boxes baked into one geometry. A balcony railing is
 * twenty balusters, a shutter is nine louvres, a flight is six steps — stamping
 * those one box at a time is what turns a detailed town into a slideshow, so
 * each of them becomes a single shared part instead.
 *
 * Every panel lives in unit space: x ∈ [-0.5, 0.5] across, y ∈ [0, 1] up from
 * its base, z centred. Callers scale x and y to metres and leave z at 1, so
 * rails and slats keep their real thickness however long the run is.
 */

type BoxSpec = {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  /** Rotation about x, applied before the box is placed. Louvre slats need it. */
  pitch?: number;
};

const FACES: { normal: number[]; corners: number[][] }[] = [
  {
    normal: [1, 0, 0],
    corners: [
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [1, -1, 1],
    ],
  },
  {
    normal: [-1, 0, 0],
    corners: [
      [-1, -1, 1],
      [-1, 1, 1],
      [-1, 1, -1],
      [-1, -1, -1],
    ],
  },
  {
    normal: [0, 1, 0],
    corners: [
      [-1, 1, 1],
      [1, 1, 1],
      [1, 1, -1],
      [-1, 1, -1],
    ],
  },
  {
    normal: [0, -1, 0],
    corners: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
    ],
  },
  {
    normal: [0, 0, 1],
    corners: [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
  },
  {
    normal: [0, 0, -1],
    corners: [
      [1, -1, -1],
      [-1, -1, -1],
      [-1, 1, -1],
      [1, 1, -1],
    ],
  },
];

const UV = [0, 0, 1, 0, 1, 1, 0, 1];

const createBoxPanel = (boxes: BoxSpec[]): BufferGeometry => {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const box of boxes) {
    const pitch = box.pitch ?? 0;
    const cos = Math.cos(pitch);
    const sin = Math.sin(pitch);

    for (const face of FACES) {
      const base = positions.length / 3;

      face.corners.forEach((corner, index) => {
        const lx = (corner[0] * box.sx) / 2;
        const ly = (corner[1] * box.sy) / 2;
        const lz = (corner[2] * box.sz) / 2;
        positions.push(box.x + lx, box.y + ly * cos - lz * sin, box.z + ly * sin + lz * cos);
        normals.push(
          face.normal[0],
          face.normal[1] * cos - face.normal[2] * sin,
          face.normal[1] * sin + face.normal[2] * cos
        );
        uvs.push(UV[index * 2], UV[index * 2 + 1]);
      });

      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  return geometry;
};

const balustrade = (bars: number): BoxSpec[] => {
  const boxes: BoxSpec[] = [
    { x: 0, y: 0.955, z: 0, sx: 1, sy: 0.09, sz: 0.1 },
    { x: 0, y: 0.52, z: 0, sx: 1, sy: 0.045, sz: 0.07 },
    { x: 0, y: 0.04, z: 0, sx: 1, sy: 0.08, sz: 0.09 },
  ];
  for (let i = 0; i < bars; i += 1) {
    boxes.push({ x: -0.5 + (i + 0.5) / bars, y: 0.5, z: 0, sx: 0.45 / bars, sy: 0.9, sz: 0.05 });
  }
  return boxes;
};

const louvre = (slats: number): BoxSpec[] => {
  const boxes: BoxSpec[] = [
    { x: -0.455, y: 0.5, z: 0, sx: 0.09, sy: 1, sz: 0.05 },
    { x: 0.455, y: 0.5, z: 0, sx: 0.09, sy: 1, sz: 0.05 },
    { x: 0, y: 0.03, z: 0, sx: 1, sy: 0.06, sz: 0.05 },
    { x: 0, y: 0.97, z: 0, sx: 1, sy: 0.06, sz: 0.05 },
  ];
  for (let i = 0; i < slats; i += 1) {
    boxes.push({
      x: 0,
      y: 0.1 + ((i + 0.5) / slats) * 0.8,
      z: 0,
      sx: 0.82,
      sy: 0.6 / slats,
      sz: 0.055,
      pitch: 0.45,
    });
  }
  return boxes;
};

const boarded = (boards: number): BoxSpec[] => {
  const boxes: BoxSpec[] = [
    { x: 0, y: 0.08, z: 0, sx: 1, sy: 0.1, sz: 0.045 },
    { x: 0, y: 0.92, z: 0, sx: 1, sy: 0.1, sz: 0.045 },
  ];
  for (let i = 0; i < boards; i += 1) {
    boxes.push({ x: -0.5 + (i + 0.5) / boards, y: 0.5, z: 0, sx: 0.94 / boards, sy: 1, sz: 0.035 });
  }
  return boxes;
};

const grille = (bars: number): BoxSpec[] => {
  const boxes: BoxSpec[] = [
    { x: 0, y: 0.12, z: 0, sx: 1, sy: 0.035, sz: 0.035 },
    { x: 0, y: 0.88, z: 0, sx: 1, sy: 0.035, sz: 0.035 },
  ];
  for (let i = 0; i < bars; i += 1) {
    boxes.push({ x: -0.5 + (i + 0.5) / bars, y: 0.5, z: 0, sx: 0.22 / bars, sy: 1, sz: 0.03 });
  }
  return boxes;
};

/** The frame and glazing bars of a window, so one part carries the whole sash. */
const sash = (columns: number, rows: number): BoxSpec[] => {
  const boxes: BoxSpec[] = [
    { x: -0.47, y: 0.5, z: 0, sx: 0.07, sy: 1, sz: 0.09 },
    { x: 0.47, y: 0.5, z: 0, sx: 0.07, sy: 1, sz: 0.09 },
    { x: 0, y: 0.035, z: 0, sx: 1, sy: 0.07, sz: 0.09 },
    { x: 0, y: 0.965, z: 0, sx: 1, sy: 0.07, sz: 0.09 },
  ];
  for (let i = 1; i < columns; i += 1) {
    boxes.push({ x: -0.5 + i / columns, y: 0.5, z: 0, sx: 0.04, sy: 1, sz: 0.06 });
  }
  for (let i = 1; i < rows; i += 1) {
    boxes.push({ x: 0, y: i / rows, z: 0, sx: 1, sy: 0.04, sz: 0.06 });
  }
  return boxes;
};

const lattice = (columns: number, rows: number): BoxSpec[] => {
  const boxes: BoxSpec[] = [];
  for (let i = 0; i < columns; i += 1) {
    boxes.push({ x: -0.5 + (i + 0.5) / columns, y: 0.5, z: 0, sx: 0.3 / columns, sy: 1, sz: 0.04 });
  }
  for (let i = 0; i < rows; i += 1) {
    boxes.push({ x: 0, y: (i + 0.5) / rows, z: 0, sx: 1, sy: 0.3 / rows, sz: 0.045 });
  }
  return boxes;
};

const ladder = (rungs: number): BoxSpec[] => {
  const boxes: BoxSpec[] = [
    { x: -0.42, y: 0.5, z: 0, sx: 0.16, sy: 1.04, sz: 0.07 },
    { x: 0.42, y: 0.5, z: 0, sx: 0.16, sy: 1.04, sz: 0.07 },
  ];
  for (let i = 0; i < rungs; i += 1) {
    boxes.push({ x: 0, y: ((i + 0.5) / rungs) * 0.98, z: 0, sx: 0.84, sy: 0.5 / rungs, sz: 0.12 });
  }
  return boxes;
};

/** A flight climbing from -z to +z, scaled to (width, total rise, total run). */
const steps = (count: number): BoxSpec[] =>
  Array.from({ length: count }, (_, index) => ({
    x: 0,
    y: (index + 1) / (2 * count),
    z: -0.5 + (index + 0.5) / count,
    sx: 1,
    sy: (index + 1) / count,
    sz: 1 / count,
  }));

const fence = (posts: number): BoxSpec[] => {
  const boxes: BoxSpec[] = [
    { x: 0, y: 0.78, z: 0, sx: 1, sy: 0.07, sz: 0.06 },
    { x: 0, y: 0.38, z: 0, sx: 1, sy: 0.06, sz: 0.055 },
  ];
  for (let i = 0; i < posts; i += 1) {
    boxes.push({ x: -0.5 + (i + 0.5) / posts, y: 0.5, z: 0, sx: 0.3 / posts, sy: 1, sz: 0.08 });
  }
  return boxes;
};

/** Cửa cuốn: the horizontal ribs of a roller shutter, pulled down over a shopfront. */
const roller = (ribs: number): BoxSpec[] => {
  const boxes: BoxSpec[] = [{ x: 0, y: 0.5, z: -0.02, sx: 1, sy: 1, sz: 0.04 }];
  for (let i = 0; i < ribs; i += 1) {
    boxes.push({ x: 0, y: ((i + 0.5) / ribs) * 0.97, z: 0.01, sx: 0.98, sy: 0.62 / ribs, sz: 0.045 });
  }
  return boxes;
};

/** Rafter tails under an eave, scaled to (width, depth of the tail, projection). */
const rafters = (count: number): BoxSpec[] =>
  Array.from({ length: count }, (_, index) => ({
    x: -0.5 + (index + 0.5) / count,
    y: 0,
    z: 0,
    sx: 0.145 / count,
    sy: 1,
    sz: 1,
  }));

export type PanelKit = {
  balustrade: (length: number) => BufferGeometry;
  louvre: (height: number) => BufferGeometry;
  boarded: (width: number) => BufferGeometry;
  grille: (width: number) => BufferGeometry;
  sash: (width: number, height: number) => BufferGeometry;
  lattice: (width: number, height: number) => BufferGeometry;
  ladder: (height: number) => BufferGeometry;
  roller: (height: number) => BufferGeometry;
  steps: (count: number) => BufferGeometry;
  fence: (length: number) => BufferGeometry;
  rafters: (width: number) => BufferGeometry;
  dispose: () => void;
};

const nearest = (ladderSteps: number[], target: number): number =>
  ladderSteps.reduce(
    (best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best),
    ladderSteps[0]
  );

export const createPanelKit = (): PanelKit => {
  const cache = new Map<string, BufferGeometry>();

  const cached = (key: string, build: () => BoxSpec[]): BufferGeometry => {
    const existing = cache.get(key);
    if (existing) return existing;
    const created = createBoxPanel(build());
    cache.set(key, created);
    return created;
  };

  const pick = (key: string, ladderSteps: number[], target: number, build: (count: number) => BoxSpec[]) => {
    const count = nearest(ladderSteps, target);
    return cached(`${key}:${count}`, () => build(count));
  };

  return {
    balustrade: (length) => pick('balustrade', [4, 7, 11, 16, 24], length / 0.26, balustrade),
    louvre: (height) => pick('louvre', [4, 6, 9, 13], height / 0.15, louvre),
    boarded: (width) => pick('boarded', [2, 3, 4, 6], width / 0.22, boarded),
    grille: (width) => pick('grille', [3, 5, 8, 12], width / 0.18, grille),
    sash: (width, height) => {
      const columns = nearest([1, 2, 3, 4], width / 0.6);
      const rows = nearest([1, 2, 3], height / 0.75);
      return cached(`sash:${columns}:${rows}`, () => sash(columns, rows));
    },
    lattice: (width, height) => {
      const columns = nearest([2, 3, 5, 8], width / 0.3);
      const rows = nearest([2, 3, 5, 8], height / 0.3);
      return cached(`lattice:${columns}:${rows}`, () => lattice(columns, rows));
    },
    ladder: (height) => pick('ladder', [3, 5, 7, 10], height / 0.3, ladder),
    roller: (height) => pick('roller', [6, 10, 16], height / 0.2, roller),
    steps: (count) => pick('steps', [2, 3, 4, 6, 9], count, steps),
    fence: (length) => pick('fence', [4, 7, 11, 16], length / 0.9, fence),
    rafters: (width) => pick('rafters', [6, 10, 16, 24, 34], width / 0.55, rafters),
    dispose: () => {
      for (const geometry of cache.values()) geometry.dispose();
      cache.clear();
    },
  };
};
