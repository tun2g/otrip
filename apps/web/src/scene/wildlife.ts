import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { styleOf } from './town-styles';

/** Metres of viewer movement before the insect swarms are laid out again. */
const INSECT_RESTEP = 9;
/** How far from the viewer insects live. Nothing this small reads beyond it. */
const BUTTERFLY_RADIUS = 34;
const DRAGONFLY_RADIUS = 26;
/** Metres at which a chicken breaks and runs, and a dog looks up. */
const FLUSH_RADIUS = 7;
const DOG_NOTICE_RADIUS = 14;

const UP = new Vector3(0, 1, 0);
const AXIS = new Vector3();

// --- geometry helpers --------------------------------------------------------

/** One cross section of a lofted body: a ring at `z`, spanning `bottom`..`top`. */
type Section = { z: number; top: number; bottom: number; half: number };

/**
 * A closed body lofted from cross sections, capped at both ends. The ring is
 * raised to a power rather than left circular, which is the difference between
 * a barrel and a sausage — an animal's flank is flat and its belly is round, and
 * the flank is what the silhouette shows.
 */
const loft = (sections: Section[], ring = 10): BufferGeometry => {
  const positions: number[] = [];
  const indices: number[] = [];

  for (const section of sections) {
    const centre = (section.top + section.bottom) / 2;
    const height = (section.top - section.bottom) / 2;
    for (let j = 0; j < ring; j += 1) {
      const angle = (j / ring) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      positions.push(
        section.half * Math.sign(cos) * Math.abs(cos) ** 0.8,
        centre + height * Math.sign(sin) * Math.abs(sin) ** (sin > 0 ? 0.78 : 1),
        section.z
      );
    }
  }

  for (let i = 0; i < sections.length - 1; i += 1) {
    for (let j = 0; j < ring; j += 1) {
      const next = (j + 1) % ring;
      const a = i * ring + j;
      const b = i * ring + next;
      const c = (i + 1) * ring + j;
      const d = (i + 1) * ring + next;
      indices.push(a, d, c, a, b, d);
    }
  }

  const first = sections[0];
  const last = sections[sections.length - 1];
  const backCap = positions.length / 3;
  positions.push(0, (first.top + first.bottom) / 2, first.z);
  const frontCap = positions.length / 3;
  positions.push(0, (last.top + last.bottom) / 2, last.z);
  const lastRing = (sections.length - 1) * ring;
  for (let j = 0; j < ring; j += 1) {
    const next = (j + 1) % ring;
    indices.push(backCap, j, next);
    indices.push(frontCap, lastRing + next, lastRing + j);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

/**
 * A tube of varying radius along a smoothed curve — horns, legs, tails, necks.
 * `TubeGeometry` carries one radius for the whole length, and a buffalo horn
 * that does not taper to a point is the one thing that would give the animal
 * away, so the rings are built here instead.
 */
const taperedTube = (points: Vector3[], radii: number[], segments = 14, ring = 6): BufferGeometry => {
  const curve = new CatmullRomCurve3(points);
  const frames = curve.computeFrenetFrames(segments, false);
  const positions: number[] = [];
  const indices: number[] = [];
  const point = new Vector3();

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    curve.getPoint(t, point);
    const span = (radii.length - 1) * t;
    const low = Math.min(Math.floor(span), radii.length - 2);
    const radius = radii[low] + (radii[low + 1] - radii[low]) * (span - low);
    const normal = frames.normals[i];
    const binormal = frames.binormals[i];

    for (let j = 0; j < ring; j += 1) {
      const angle = (j / ring) * Math.PI * 2;
      const cos = Math.cos(angle) * radius;
      const sin = Math.sin(angle) * radius;
      positions.push(
        point.x + normal.x * cos + binormal.x * sin,
        point.y + normal.y * cos + binormal.y * sin,
        point.z + normal.z * cos + binormal.z * sin
      );
    }
  }

  for (let i = 0; i < segments; i += 1) {
    for (let j = 0; j < ring; j += 1) {
      const next = (j + 1) % ring;
      const a = i * ring + j;
      const b = i * ring + next;
      const c = (i + 1) * ring + j;
      const d = (i + 1) * ring + next;
      indices.push(a, d, c, a, b, d);
    }
  }

  const tipIndex = positions.length / 3;
  curve.getPoint(1, point);
  positions.push(point.x, point.y, point.z);
  const lastRing = segments * ring;
  for (let j = 0; j < ring; j += 1) {
    indices.push(tipIndex, lastRing + ((j + 1) % ring), lastRing + j);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

/** A flat membrane in the XZ plane, fanned from the root — a wing or a fin. */
const membrane = (outline: [number, number][]): BufferGeometry => {
  const positions: number[] = [0, 0, 0];
  for (const [x, z] of outline) positions.push(x, 0, z);
  const indices: number[] = [];
  for (let i = 1; i < outline.length; i += 1) indices.push(0, i, i + 1);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

type Part = { geometry: BufferGeometry; material: Material; matrix?: Matrix4 };

const at = (x: number, y: number, z: number): Matrix4 => new Matrix4().setPosition(x, y, z);

const mirrored = (part: Part): Part => {
  const matrix = new Matrix4().makeScale(-1, 1, 1);
  if (part.matrix) matrix.multiply(part.matrix);
  return { geometry: part.geometry, material: part.material, matrix };
};

/**
 * Collapses a bag of parts into one buffer per material. Every animal here is a
 * dozen pieces, and a dozen meshes each would be more draw calls than the whole
 * module is allowed.
 */
const mergeByMaterial = (parts: Part[]): { geometry: BufferGeometry; material: Material }[] => {
  const buckets = new Map<Material, BufferGeometry[]>();

  for (const part of parts) {
    const geometry = part.geometry.clone();
    if (part.matrix) geometry.applyMatrix4(part.matrix);
    // The lofts carry no uvs and the primitives all do; mergeGeometries refuses
    // the mismatch, and nothing here samples a texture.
    geometry.deleteAttribute('uv');
    // A mirrored part has a negative determinant, which flips its winding.
    if (part.matrix && part.matrix.determinant() < 0) {
      const index = geometry.getIndex();
      if (index) {
        const array = index.array;
        for (let i = 0; i < array.length; i += 3) {
          const swap = array[i + 1];
          array[i + 1] = array[i + 2];
          array[i + 2] = swap;
        }
        index.needsUpdate = true;
      }
      geometry.computeVertexNormals();
    }

    const bucket = buckets.get(part.material);
    if (bucket) bucket.push(geometry);
    else buckets.set(part.material, [geometry]);
  }

  const out: { geometry: BufferGeometry; material: Material }[] = [];
  for (const [material, bucket] of buckets) {
    if (bucket.length === 1) {
      out.push({ geometry: bucket[0], material });
      continue;
    }
    const merged = mergeGeometries(bucket);
    for (const piece of bucket) piece.dispose();
    if (merged) out.push({ geometry: merged, material });
  }
  return out;
};

// --- the instanced rig -------------------------------------------------------

/**
 * One `InstancedMesh` per (pivot, material) pair, all driven by a single scratch
 * hierarchy that is posed once per animal and read off as world matrices. This
 * is what lets twenty chickens with a neck, a comb, a fanned tail and two legs
 * cost nine draw calls in total rather than nine each.
 */
type Rig = {
  meshes: InstancedMesh[];
  /** Pose these, then `commit`. The root carries position, heading and scale. */
  root: Object3D;
  head: Object3D;
  tail: Object3D;
  legs: Object3D[];
  commit: (index: number) => void;
  setTint: (index: number, color: Color) => void;
  flush: () => void;
  dispose: () => void;
};

type RigSpec = {
  name: string;
  body: Part[];
  head: Part[];
  tail: Part[];
  /** Hip positions in the root's frame. Each leg shares one geometry. */
  hips: Vector3[];
  leg: Part[];
  /** Materials that `setTint` is allowed to colour per animal. */
  tintable: Set<Material>;
};

const createRig = (spec: RigSpec, count: number): Rig => {
  const root = new Object3D();
  const head = new Object3D();
  const tail = new Object3D();
  const legs = spec.hips.map((hip) => {
    const leg = new Object3D();
    leg.position.copy(hip);
    return leg;
  });
  root.add(head, tail, ...legs);

  const owned: BufferGeometry[] = [];
  const meshes: InstancedMesh[] = [];
  const tinted: InstancedMesh[] = [];
  /** Which scratch node each mesh reads, and how many instances it takes per animal. */
  const sources: { mesh: InstancedMesh; nodes: Object3D[] }[] = [];

  const add = (parts: Part[], nodes: Object3D[]) => {
    if (parts.length === 0) return;
    for (const piece of mergeByMaterial(parts)) {
      owned.push(piece.geometry);
      const mesh = new InstancedMesh(piece.geometry, piece.material, count * nodes.length);
      mesh.name = spec.name;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      meshes.push(mesh);
      if (spec.tintable.has(piece.material)) tinted.push(mesh);
      sources.push({ mesh, nodes });
    }
  };

  add(spec.body, [root]);
  add(spec.head, [head]);
  add(spec.tail, [tail]);
  add(spec.leg, legs);

  return {
    meshes,
    root,
    head,
    tail,
    legs,
    commit: (index) => {
      root.updateMatrixWorld(true);
      for (const source of sources) {
        for (let n = 0; n < source.nodes.length; n += 1) {
          source.mesh.setMatrixAt(index * source.nodes.length + n, source.nodes[n].matrixWorld);
        }
      }
    },
    setTint: (index, color) => {
      for (const mesh of tinted) {
        const stride = mesh.count / count;
        for (let n = 0; n < stride; n += 1) mesh.setColorAt(index * stride + n, color);
      }
    },
    flush: () => {
      for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
      for (const mesh of tinted) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    dispose: () => {
      for (const geometry of owned) geometry.dispose();
      for (const mesh of meshes) mesh.dispose();
    },
  };
};

/** A flyer: one body and a set of wings, each wing on its own pivot. */
type FlyerRig = {
  meshes: InstancedMesh[];
  root: Object3D;
  wings: Object3D[];
  commit: (index: number) => void;
  setTint: (index: number, color: Color) => void;
  flush: () => void;
  dispose: () => void;
};

const createFlyerRig = (
  name: string,
  body: Part[],
  wing: { geometry: BufferGeometry; material: Material },
  roots: { x: number; y: number; z: number; mirror: boolean }[],
  count: number,
  tintable: Set<Material>
): FlyerRig => {
  const root = new Object3D();
  const wings = roots.map((spot) => {
    const node = new Object3D();
    node.position.set(spot.x, spot.y, spot.z);
    if (spot.mirror) node.scale.x = -1;
    root.add(node);
    return node;
  });

  const owned: BufferGeometry[] = [];
  const meshes: InstancedMesh[] = [];
  const tinted: InstancedMesh[] = [];
  const sources: { mesh: InstancedMesh; nodes: Object3D[] }[] = [];

  for (const piece of mergeByMaterial(body)) {
    owned.push(piece.geometry);
    const mesh = new InstancedMesh(piece.geometry, piece.material, count);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    meshes.push(mesh);
    if (tintable.has(piece.material)) tinted.push(mesh);
    sources.push({ mesh, nodes: [root] });
  }

  const wingMesh = new InstancedMesh(wing.geometry, wing.material, count * wings.length);
  wingMesh.name = `${name}-wings`;
  wingMesh.frustumCulled = false;
  wingMesh.castShadow = false;
  meshes.push(wingMesh);
  if (tintable.has(wing.material)) tinted.push(wingMesh);
  sources.push({ mesh: wingMesh, nodes: wings });

  return {
    meshes,
    root,
    wings,
    commit: (index) => {
      root.updateMatrixWorld(true);
      for (const source of sources) {
        for (let n = 0; n < source.nodes.length; n += 1) {
          source.mesh.setMatrixAt(index * source.nodes.length + n, source.nodes[n].matrixWorld);
        }
      }
    },
    setTint: (index, color) => {
      for (const mesh of tinted) {
        const stride = mesh.count / count;
        for (let n = 0; n < stride; n += 1) mesh.setColorAt(index * stride + n, color);
      }
    },
    flush: () => {
      for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
      for (const mesh of tinted) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    dispose: () => {
      for (const geometry of owned) geometry.dispose();
      for (const mesh of meshes) mesh.dispose();
    },
  };
};

// --- con trâu ---------------------------------------------------------------

/**
 * A water buffalo, to scale: 1.36 m at the withers, 2.7 m nose to tail, horns
 * 1.2 m tip to tip. It is the largest animal in the scene and the one a
 * Vietnamese visitor will look for, so unlike the dogs and the chickens it is
 * built as a group per animal rather than instanced — the dipped back, the
 * withers hump, the head carried below the shoulder and the swept-back crescent
 * horns are the whole silhouette, and there is no way to fake any of them.
 */
const BUFFALO_TRUNK: Section[] = [
  { z: -0.92, top: 1.08, bottom: 0.86, half: 0.06 },
  { z: -0.8, top: 1.22, bottom: 0.72, half: 0.22 },
  { z: -0.58, top: 1.26, bottom: 0.62, half: 0.3 },
  { z: -0.31, top: 1.24, bottom: 0.58, half: 0.32 },
  { z: -0.02, top: 1.23, bottom: 0.57, half: 0.325 },
  { z: 0.23, top: 1.28, bottom: 0.59, half: 0.33 },
  { z: 0.48, top: 1.36, bottom: 0.62, half: 0.32 },
  { z: 0.66, top: 1.34, bottom: 0.66, half: 0.28 },
  { z: 0.8, top: 1.26, bottom: 0.72, half: 0.2 },
  { z: 0.9, top: 1.14, bottom: 0.84, half: 0.06 },
];

/** Where the neck meets the body. The head group hangs off this. */
const BUFFALO_NECK = new Vector3(0, 1.16, 0.8);
const BUFFALO_HIP_Y = 0.8;
/** Metres the hoof drops below the hip pivot. */
const BUFFALO_LEG_DROP = 0.795;

type BuffaloPose = {
  /** 0 head carried low, 1 muzzle in the grass. */
  graze: number;
  /** 0 relaxed, 1 head up and ears forward. */
  alert: number;
  /** 0 standing, 1 full stride. */
  walk: number;
  /** Accumulated walk cycle in radians. */
  stride: number;
  /** Metres the body is sunk into a wallow. */
  sink: number;
  elapsed: number;
};

type BuffaloModel = {
  group: Group;
  pose: (pose: BuffaloPose) => void;
  setLed: (led: boolean) => void;
  dispose: () => void;
};

type BuffaloKit = {
  create: (variant: number) => BuffaloModel;
  dispose: () => void;
};

type Palette = {
  hides: MeshStandardMaterial[];
  horn: MeshStandardMaterial;
  dark: MeshStandardMaterial;
  skin: MeshStandardMaterial;
  shirt: MeshStandardMaterial;
  straw: MeshStandardMaterial;
  rope: MeshStandardMaterial;
};

const createBuffaloKit = (palette: Palette): BuffaloKit => {
  const kept: BufferGeometry[] = [];
  const keep = <T extends BufferGeometry>(geometry: T): T => {
    kept.push(geometry);
    return geometry;
  };

  const trunk = keep(loft(BUFFALO_TRUNK, 12));

  // Head and neck in the neck pivot's own frame, so lowering the head to graze
  // is one rotation rather than a hand-animated chain.
  const neckTube = keep(
    taperedTube(
      [new Vector3(0, -0.02, -0.06), new Vector3(0, -0.06, 0.18), new Vector3(0, -0.12, 0.42)],
      [0.27, 0.24, 0.2],
      8,
      8
    )
  );
  const skull = keep(
    loft(
      [
        { z: 0.4, top: 0.06, bottom: -0.3, half: 0.05 },
        { z: 0.46, top: 0.06, bottom: -0.32, half: 0.17 },
        { z: 0.66, top: -0.02, bottom: -0.36, half: 0.165 },
        { z: 0.82, top: -0.14, bottom: -0.4, half: 0.12 },
        { z: 0.95, top: -0.2, bottom: -0.42, half: 0.125 },
        { z: 0.99, top: -0.22, bottom: -0.41, half: 0.06 },
      ],
      10
    )
  );
  const muzzle = keep(new SphereGeometry(0.115, 10, 7));
  const horn = keep(
    taperedTube(
      [
        new Vector3(0.14, 0.02, 0.5),
        new Vector3(0.32, 0.08, 0.42),
        new Vector3(0.48, 0.1, 0.26),
        new Vector3(0.58, 0.16, 0.06),
        new Vector3(0.6, 0.3, -0.06),
      ],
      [0.055, 0.047, 0.038, 0.027, 0.011],
      16,
      7
    )
  );
  const ear = keep(new ConeGeometry(0.055, 0.17, 5));
  ear.rotateX(Math.PI * 0.62);
  const eye = keep(new SphereGeometry(0.038, 7, 5));
  const noseRing = keep(new TorusGeometry(0.048, 0.011, 4, 10));

  const legUpper = keep(
    taperedTube(
      [new Vector3(0, 0.03, 0), new Vector3(0, -0.14, 0.01), new Vector3(0, -0.36, 0)],
      [0.105, 0.095, 0.075],
      6,
      7
    )
  );
  const legLower = keep(
    taperedTube(
      [new Vector3(0, -0.36, 0), new Vector3(0, -0.55, -0.015), new Vector3(0, -0.68, 0.005)],
      [0.072, 0.057, 0.05],
      6,
      7
    )
  );
  const hoof = keep(new CylinderGeometry(0.078, 0.07, 0.115, 8));

  const tail = keep(
    taperedTube(
      [new Vector3(0, 0, 0), new Vector3(0, -0.26, -0.06), new Vector3(0, -0.52, -0.04)],
      [0.045, 0.03, 0.02],
      7,
      6
    )
  );
  const tuft = keep(new SphereGeometry(0.058, 7, 6));

  // The herder: the same construction as the boatman, plus legs, because unlike
  // him he walks. Only one buffalo in a herd gets one, and only at dusk.
  const torso = keep(new CylinderGeometry(0.17, 0.26, 0.62, 7));
  const herderHead = keep(new SphereGeometry(0.115, 8, 6));
  const hat = keep(new CylinderGeometry(0.01, 0.29, 0.15, 10));
  const arm = keep(new CylinderGeometry(0.048, 0.042, 0.56, 5));
  arm.translate(0, -0.28, 0);
  const shin = keep(new CylinderGeometry(0.062, 0.05, 0.78, 5));
  shin.translate(0, -0.39, 0);
  const halter = keep(new CylinderGeometry(0.01, 0.01, 1, 4));

  const create = (variant: number): BuffaloModel => {
    const group = new Group();
    group.name = 'buffalo';
    const hide = palette.hides[variant % palette.hides.length];
    const owned: BufferGeometry[] = [];

    const build = (parent: Object3D, parts: Part[], shadows = true) => {
      for (const piece of mergeByMaterial(parts)) {
        owned.push(piece.geometry);
        const mesh = new Mesh(piece.geometry, piece.material);
        mesh.castShadow = shadows;
        parent.add(mesh);
      }
    };

    build(group, [{ geometry: trunk, material: hide }]);

    const headPivot = new Object3D();
    headPivot.position.copy(BUFFALO_NECK);
    group.add(headPivot);

    const headParts: Part[] = [
      { geometry: neckTube, material: hide },
      { geometry: skull, material: hide },
      { geometry: muzzle, material: palette.dark, matrix: at(0, -0.3, 0.98) },
      { geometry: horn, material: palette.horn },
      mirrored({ geometry: horn, material: palette.horn }),
      { geometry: eye, material: palette.dark, matrix: at(0.152, -0.06, 0.6) },
      { geometry: eye, material: palette.dark, matrix: at(-0.152, -0.06, 0.6) },
    ];
    build(headPivot, headParts);

    const ears = new Object3D();
    headPivot.add(ears);
    build(ears, [
      { geometry: ear, material: hide, matrix: at(0.175, 0.0, 0.42) },
      { geometry: ear, material: hide, matrix: at(-0.175, 0.0, 0.42) },
    ]);

    const ring = new Mesh(noseRing, palette.horn);
    ring.position.set(0, -0.38, 0.99);
    ring.rotation.x = Math.PI / 2;
    headPivot.add(ring);

    const legParts: Part[] = [
      { geometry: legUpper, material: hide },
      { geometry: legLower, material: hide },
      { geometry: hoof, material: palette.dark, matrix: at(0, -0.735, 0.005) },
    ];
    const hips: Vector3[] = [
      new Vector3(-0.23, BUFFALO_HIP_Y, -0.56),
      new Vector3(-0.21, BUFFALO_HIP_Y, 0.55),
      new Vector3(0.23, BUFFALO_HIP_Y, -0.56),
      new Vector3(0.21, BUFFALO_HIP_Y, 0.55),
    ];
    const legPivots = hips.map((hip) => {
      const pivot = new Object3D();
      pivot.position.copy(hip);
      group.add(pivot);
      build(pivot, legParts);
      return pivot;
    });

    const tailPivot = new Object3D();
    tailPivot.position.set(0, 1.1, -0.9);
    group.add(tailPivot);
    build(tailPivot, [
      { geometry: tail, material: hide },
      { geometry: tuft, material: palette.dark, matrix: at(0, -0.56, -0.04) },
    ]);

    // The herder rides in the buffalo's own frame, a stride ahead and to one
    // side, so the rope between his hand and the nose ring never has to be
    // rebuilt — he is being pulled along by the animal, which is the truth of it.
    const herder = new Group();
    herder.position.set(0.55, 0, 2.55);
    herder.visible = false;
    group.add(herder);
    build(herder, [
      { geometry: torso, material: palette.shirt, matrix: at(0, 1.1, 0) },
      { geometry: herderHead, material: palette.skin, matrix: at(0, 1.5, 0) },
      { geometry: hat, material: palette.straw, matrix: at(0, 1.58, 0) },
    ]);

    const herderArms = new Object3D();
    herderArms.position.y = 1.32;
    herder.add(herderArms);
    build(herderArms, [
      { geometry: arm, material: palette.skin, matrix: at(0.2, 0, 0) },
      { geometry: arm, material: palette.skin, matrix: at(-0.2, 0, 0) },
    ]);

    const herderLegs = [-0.09, 0.09].map((offset) => {
      const pivot = new Object3D();
      pivot.position.set(offset, 0.8, 0);
      herder.add(pivot);
      build(pivot, [{ geometry: shin, material: palette.shirt }]);
      return pivot;
    });

    // Hand to nose ring, measured once in the buffalo's frame. The cylinder is a
    // unit metre long, so the scale is the distance.
    const hand = new Vector3(0.55 - 0.2, 1.08, 2.55 + 0.1);
    const nose = new Vector3(0, BUFFALO_NECK.y - 0.38, BUFFALO_NECK.z + 0.99);
    const span = new Vector3().subVectors(nose, hand);
    const rope = new Mesh(halter, palette.rope);
    rope.position.copy(hand).addScaledVector(span, 0.5);
    rope.scale.y = span.length();
    AXIS.copy(span).normalize();
    rope.quaternion.setFromUnitVectors(UP, AXIS);
    rope.visible = false;
    group.add(rope);

    return {
      group,
      pose: ({ graze, alert, walk, stride, sink, elapsed }) => {
        // Reach forward as the head goes down: rotating about the neck alone
        // tucks the muzzle under the chest, which is not what grazing looks like.
        headPivot.rotation.x = 0.18 + graze * 0.74 - alert * 0.34;
        headPivot.position.z = BUFFALO_NECK.z + graze * 0.26;
        headPivot.position.y = BUFFALO_NECK.y - graze * 0.1;
        // Chewing while the head is down, and a slower sway while it is up.
        headPivot.rotation.y = Math.sin(elapsed * (0.5 + graze * 1.4)) * (0.1 + graze * 0.12);
        ears.rotation.x = -alert * 0.5 + Math.sin(elapsed * 3.1) * 0.12 * (1 - alert);
        ears.rotation.z = Math.sin(elapsed * 2.3 + 1.1) * 0.1;

        // A real four-beat walk: near hind, near fore, off hind, off fore. A
        // diagonal pair moving together is a trot, and a buffalo does not trot.
        const order = [0, 0.25, 0.5, 0.75];
        for (let i = 0; i < legPivots.length; i += 1) {
          const phase = stride + order[i] * Math.PI * 2;
          legPivots[i].rotation.x = Math.sin(phase) * 0.3 * walk;
          legPivots[i].visible = sink < 0.45;
        }

        tailPivot.rotation.z = Math.sin(elapsed * 1.7) * 0.3 + Math.sin(elapsed * 0.41) * 0.18;
        tailPivot.rotation.x = Math.sin(elapsed * 1.3) * 0.12;

        for (let i = 0; i < herderLegs.length; i += 1) {
          herderLegs[i].rotation.x = Math.sin(stride + i * Math.PI) * 0.38 * walk;
        }
        herderArms.rotation.x = -0.9 - walk * 0.12;

        group.position.y -= sink;
        // The body rolls as it settles into the mud, and rocks with the stride.
        group.rotation.z = sink * 0.07 + Math.sin(stride * 0.5) * 0.02 * walk;
      },
      setLed: (led) => {
        herder.visible = led;
        rope.visible = led;
        ring.visible = led;
      },
      dispose: () => {
        for (const geometry of owned) geometry.dispose();
        owned.length = 0;
        group.clear();
      },
    };
  };

  return {
    create,
    dispose: () => {
      for (const geometry of kept) geometry.dispose();
    },
  };
};

// --- chó: the village dog ---------------------------------------------------

const createDogRig = (palette: Palette, fur: MeshStandardMaterial, count: number): Rig => {
  const body = loft(
    [
      { z: -0.3, top: 0.42, bottom: 0.34, half: 0.035 },
      { z: -0.24, top: 0.47, bottom: 0.3, half: 0.085 },
      { z: -0.1, top: 0.46, bottom: 0.3, half: 0.095 },
      { z: 0.04, top: 0.46, bottom: 0.27, half: 0.098 },
      { z: 0.16, top: 0.48, bottom: 0.24, half: 0.102 },
      { z: 0.26, top: 0.47, bottom: 0.27, half: 0.092 },
      { z: 0.33, top: 0.42, bottom: 0.33, half: 0.035 },
    ],
    9
  );

  const neck = taperedTube(
    [new Vector3(0, -0.02, -0.02), new Vector3(0, 0.05, 0.08), new Vector3(0, 0.1, 0.17)],
    [0.072, 0.064, 0.055],
    5,
    6
  );
  const skull = taperedTube(
    [new Vector3(0, 0.1, 0.16), new Vector3(0, 0.11, 0.24), new Vector3(0, 0.09, 0.31)],
    [0.052, 0.058, 0.05],
    5,
    7
  );
  const snout = taperedTube(
    [new Vector3(0, 0.09, 0.29), new Vector3(0, 0.07, 0.38), new Vector3(0, 0.058, 0.44)],
    [0.042, 0.033, 0.026],
    5,
    6
  );
  const earCone = new ConeGeometry(0.036, 0.095, 4);
  earCone.rotateX(-0.25);
  const nose = new SphereGeometry(0.021, 6, 5);
  const eyeBall = new SphereGeometry(0.012, 5, 4);

  const legTube = taperedTube(
    [new Vector3(0, 0, 0), new Vector3(0, -0.18, 0.015), new Vector3(0, -0.33, -0.01), new Vector3(0, -0.42, 0.02)],
    [0.036, 0.028, 0.021, 0.023],
    7,
    6
  );
  const paw = new SphereGeometry(0.03, 6, 5);
  paw.scale(1, 0.6, 1.3);

  const tailTube = taperedTube(
    [new Vector3(0, 0, 0), new Vector3(0, 0.1, -0.08), new Vector3(0, 0.19, -0.03), new Vector3(0, 0.21, 0.07)],
    [0.022, 0.018, 0.014, 0.009],
    8,
    5
  );

  const rig = createRig(
    {
      name: 'dog',
      body: [{ geometry: body, material: fur }],
      head: [
        { geometry: neck, material: fur },
        { geometry: skull, material: fur },
        { geometry: snout, material: fur },
        { geometry: earCone, material: fur, matrix: at(0.045, 0.165, 0.19) },
        { geometry: earCone, material: fur, matrix: at(-0.045, 0.165, 0.19) },
        { geometry: nose, material: palette.dark, matrix: at(0, 0.058, 0.455) },
        { geometry: eyeBall, material: palette.dark, matrix: at(0.042, 0.105, 0.265) },
        { geometry: eyeBall, material: palette.dark, matrix: at(-0.042, 0.105, 0.265) },
      ],
      tail: [{ geometry: tailTube, material: fur }],
      hips: [
        new Vector3(-0.085, 0.43, -0.17),
        new Vector3(-0.075, 0.44, 0.17),
        new Vector3(0.085, 0.43, -0.17),
        new Vector3(0.075, 0.44, 0.17),
      ],
      leg: [
        { geometry: legTube, material: fur },
        { geometry: paw, material: fur, matrix: at(0, -0.435, 0.03) },
      ],
      tintable: new Set<Material>([fur]),
    },
    count
  );

  rig.head.position.set(0, 0.455, 0.28);
  rig.tail.position.set(0, 0.44, -0.3);

  for (const geometry of [body, neck, skull, snout, earCone, nose, eyeBall, legTube, paw, tailTube]) {
    geometry.dispose();
  }
  return rig;
};

// --- gà: the village chicken ------------------------------------------------

const createChickenRig = (
  palette: Palette,
  feather: MeshStandardMaterial,
  trim: MeshStandardMaterial,
  comb: MeshStandardMaterial,
  count: number
): Rig => {
  const body = loft(
    [
      { z: -0.145, top: 0.225, bottom: 0.155, half: 0.02 },
      { z: -0.11, top: 0.26, bottom: 0.13, half: 0.055 },
      { z: -0.03, top: 0.28, bottom: 0.115, half: 0.072 },
      { z: 0.05, top: 0.275, bottom: 0.12, half: 0.07 },
      { z: 0.115, top: 0.25, bottom: 0.145, half: 0.045 },
      { z: 0.15, top: 0.22, bottom: 0.175, half: 0.015 },
    ],
    9
  );

  const neck = taperedTube(
    [new Vector3(0, -0.01, -0.01), new Vector3(0, 0.035, 0.025), new Vector3(0, 0.062, 0.038)],
    [0.04, 0.031, 0.026],
    4,
    6
  );
  const skull = new SphereGeometry(0.032, 7, 6);
  const beak = new ConeGeometry(0.014, 0.042, 4);
  beak.rotateX(Math.PI / 2);
  const crest = new SphereGeometry(0.013, 5, 4);
  const wattle = new SphereGeometry(0.011, 5, 4);
  const eyeBall = new SphereGeometry(0.0075, 4, 4);

  // The tail is a fan of stiff feathers, which is most of a chicken's outline.
  const feathers: Part[] = [];
  const quill = new ConeGeometry(0.038, 0.15, 3);
  quill.scale(0.35, 1, 1);
  quill.translate(0, 0.075, 0);
  for (let i = 0; i < 3; i += 1) {
    const matrix = new Matrix4().makeRotationX(-0.9 + (i - 1) * 0.12);
    matrix.premultiply(new Matrix4().makeRotationZ((i - 1) * 0.3));
    feathers.push({ geometry: quill, material: feather, matrix });
  }

  const legTube = taperedTube(
    [new Vector3(0, 0, 0), new Vector3(0, -0.07, 0.005), new Vector3(0, -0.135, 0.015)],
    [0.012, 0.009, 0.0085],
    4,
    5
  );
  const foot = new SphereGeometry(0.018, 5, 4);
  foot.scale(1, 0.35, 1.7);

  const rig = createRig(
    {
      name: 'chicken',
      body: [{ geometry: body, material: feather }],
      head: [
        { geometry: neck, material: feather },
        { geometry: skull, material: feather, matrix: at(0, 0.075, 0.046) },
        { geometry: beak, material: trim, matrix: at(0, 0.07, 0.084) },
        { geometry: crest, material: comb, matrix: at(0, 0.104, 0.028) },
        { geometry: crest, material: comb, matrix: at(0, 0.108, 0.046) },
        { geometry: crest, material: comb, matrix: at(0, 0.102, 0.062) },
        { geometry: wattle, material: comb, matrix: at(0.013, 0.048, 0.066) },
        { geometry: wattle, material: comb, matrix: at(-0.013, 0.048, 0.066) },
        { geometry: eyeBall, material: palette.dark, matrix: at(0.027, 0.083, 0.058) },
        { geometry: eyeBall, material: palette.dark, matrix: at(-0.027, 0.083, 0.058) },
      ],
      tail: feathers,
      hips: [new Vector3(-0.035, 0.135, 0.005), new Vector3(0.035, 0.135, 0.005)],
      leg: [
        { geometry: legTube, material: trim },
        { geometry: foot, material: trim, matrix: at(0, -0.138, 0.026) },
      ],
      tintable: new Set<Material>([feather]),
    },
    count
  );

  rig.head.position.set(0, 0.262, 0.1);
  rig.tail.position.set(0, 0.245, -0.13);

  for (const geometry of [body, neck, skull, beak, crest, wattle, eyeBall, quill, legTube, foot]) geometry.dispose();
  return rig;
};

// --- dê: the highland goat --------------------------------------------------

const createGoatRig = (palette: Palette, fleece: MeshStandardMaterial, count: number): Rig => {
  const body = loft(
    [
      { z: -0.36, top: 0.56, bottom: 0.44, half: 0.04 },
      { z: -0.29, top: 0.6, bottom: 0.4, half: 0.11 },
      { z: -0.12, top: 0.6, bottom: 0.38, half: 0.125 },
      { z: 0.04, top: 0.6, bottom: 0.35, half: 0.13 },
      { z: 0.2, top: 0.61, bottom: 0.33, half: 0.125 },
      { z: 0.31, top: 0.58, bottom: 0.36, half: 0.105 },
      { z: 0.38, top: 0.52, bottom: 0.44, half: 0.04 },
    ],
    9
  );

  const neck = taperedTube(
    [new Vector3(0, -0.02, -0.02), new Vector3(0, 0.1, 0.07), new Vector3(0, 0.185, 0.13)],
    [0.085, 0.072, 0.058],
    5,
    7
  );
  const skull = taperedTube(
    [new Vector3(0, 0.19, 0.12), new Vector3(0, 0.185, 0.22), new Vector3(0, 0.15, 0.31)],
    [0.058, 0.052, 0.038],
    5,
    7
  );
  const snout = new SphereGeometry(0.03, 6, 5);
  const hornTube = taperedTube(
    [
      new Vector3(0.035, 0.25, 0.12),
      new Vector3(0.055, 0.33, 0.04),
      new Vector3(0.078, 0.36, -0.08),
      new Vector3(0.1, 0.29, -0.16),
    ],
    [0.022, 0.018, 0.013, 0.007],
    12,
    6
  );
  const earCone = new ConeGeometry(0.03, 0.1, 4);
  earCone.rotateX(Math.PI * 0.62);
  const beard = new ConeGeometry(0.028, 0.1, 4);
  beard.rotateX(Math.PI);
  const eyeBall = new SphereGeometry(0.013, 5, 4);

  const legTube = taperedTube(
    [new Vector3(0, 0, 0), new Vector3(0, -0.24, 0.015), new Vector3(0, -0.44, -0.015), new Vector3(0, -0.545, 0.015)],
    [0.034, 0.026, 0.019, 0.021],
    7,
    6
  );
  const hoof = new CylinderGeometry(0.026, 0.022, 0.04, 6);

  const tailTube = taperedTube(
    [new Vector3(0, 0, 0), new Vector3(0, 0.08, -0.03), new Vector3(0, 0.12, -0.08)],
    [0.022, 0.016, 0.009],
    5,
    5
  );

  const rig = createRig(
    {
      name: 'goat',
      body: [{ geometry: body, material: fleece }],
      head: [
        { geometry: neck, material: fleece },
        { geometry: skull, material: fleece },
        { geometry: snout, material: palette.dark, matrix: at(0, 0.148, 0.325) },
        { geometry: hornTube, material: palette.horn },
        mirrored({ geometry: hornTube, material: palette.horn }),
        { geometry: earCone, material: fleece, matrix: at(0.07, 0.225, 0.155) },
        { geometry: earCone, material: fleece, matrix: at(-0.07, 0.225, 0.155) },
        { geometry: beard, material: fleece, matrix: at(0, 0.1, 0.25) },
        { geometry: eyeBall, material: palette.dark, matrix: at(0.05, 0.2, 0.235) },
        { geometry: eyeBall, material: palette.dark, matrix: at(-0.05, 0.2, 0.235) },
      ],
      tail: [{ geometry: tailTube, material: fleece }],
      hips: [
        new Vector3(-0.095, 0.56, -0.22),
        new Vector3(-0.085, 0.57, 0.2),
        new Vector3(0.095, 0.56, -0.22),
        new Vector3(0.085, 0.57, 0.2),
      ],
      leg: [
        { geometry: legTube, material: fleece },
        { geometry: hoof, material: palette.dark, matrix: at(0, -0.565, 0.015) },
      ],
      tintable: new Set<Material>([fleece]),
    },
    count
  );

  rig.head.position.set(0, 0.6, 0.34);
  rig.tail.position.set(0, 0.58, -0.37);

  for (const geometry of [body, neck, skull, snout, hornTube, earCone, beard, eyeBall, legTube, hoof, tailTube]) {
    geometry.dispose();
  }
  return rig;
};

// --- bướm and chuồn chuồn ---------------------------------------------------

const createButterflyRig = (
  dark: MeshStandardMaterial,
  wingMaterial: MeshStandardMaterial,
  count: number
): FlyerRig => {
  const body = taperedTube(
    [new Vector3(0, 0, -0.016), new Vector3(0, 0.002, 0), new Vector3(0, 0, 0.014)],
    [0.0032, 0.005, 0.0028],
    4,
    5
  );
  // Fore and hind wing as one outline — at 7 cm across, the notch between them
  // is the only part of a butterfly anyone can actually resolve in flight.
  const wing = membrane([
    [0.0, 0.012],
    [0.014, 0.023],
    [0.03, 0.017],
    [0.037, -0.003],
    [0.027, -0.02],
    [0.011, -0.023],
    [0.0, -0.013],
  ]);

  const rig = createFlyerRig(
    'butterfly',
    [{ geometry: body, material: dark }],
    { geometry: wing, material: wingMaterial },
    [
      { x: 0, y: 0.004, z: 0, mirror: false },
      { x: 0, y: 0.004, z: 0, mirror: true },
    ],
    count,
    new Set<Material>([wingMaterial])
  );
  body.dispose();
  return rig;
};

const createDragonflyRig = (
  bodyMaterial: MeshStandardMaterial,
  wingMaterial: MeshStandardMaterial,
  count: number
): FlyerRig => {
  const thorax = taperedTube(
    [new Vector3(0, 0, 0.014), new Vector3(0, 0.001, 0), new Vector3(0, 0, -0.009)],
    [0.0042, 0.0062, 0.005],
    4,
    6
  );
  const abdomen = taperedTube(
    [new Vector3(0, 0, -0.009), new Vector3(0, 0.0008, -0.026), new Vector3(0, -0.001, -0.042)],
    [0.005, 0.0034, 0.0018],
    5,
    5
  );
  const head = new SphereGeometry(0.0075, 6, 5);
  head.scale(1.5, 0.9, 1);

  const wing = membrane([
    [0.0, 0.006],
    [0.016, 0.0055],
    [0.03, 0.004],
    [0.038, 0.0],
    [0.028, -0.004],
    [0.012, -0.005],
    [0.0, -0.005],
  ]);

  const rig = createFlyerRig(
    'dragonfly',
    [
      { geometry: thorax, material: bodyMaterial },
      { geometry: abdomen, material: bodyMaterial },
      { geometry: head, material: bodyMaterial, matrix: at(0, 0.001, 0.019) },
    ],
    { geometry: wing, material: wingMaterial },
    [
      { x: 0.004, y: 0.008, z: 0.006, mirror: false },
      { x: 0.004, y: 0.008, z: 0.006, mirror: true },
      { x: 0.004, y: 0.005, z: -0.005, mirror: false },
      { x: 0.004, y: 0.005, z: -0.005, mirror: true },
    ],
    count,
    new Set<Material>([bodyMaterial])
  );

  for (const geometry of [thorax, abdomen, head]) geometry.dispose();
  return rig;
};

// --- placement --------------------------------------------------------------

type Spot = { x: number; z: number; y: number };

/**
 * Rejection sampling with a test, biased toward an anchor when there is one.
 * Everything here is placed by what the ground is doing, not by a scatter over
 * the whole map: a chicken belongs within shouting distance of a house and a
 * buffalo belongs where the ground is wet.
 */
const findSpots = (
  terrain: Terrain,
  random: () => number,
  wanted: number,
  accept: (x: number, z: number, y: number) => boolean,
  anchor?: { x: number; z: number; radius: number }
): Spot[] => {
  const spots: Spot[] = [];
  if (wanted <= 0) return spots;
  const half = terrain.size / 2;
  const attempts = wanted * 120;

  for (let attempt = 0; attempt < attempts && spots.length < wanted; attempt += 1) {
    let x: number;
    let z: number;
    if (anchor) {
      const angle = random() * Math.PI * 2;
      const distance = Math.sqrt(random()) * anchor.radius;
      x = anchor.x + Math.cos(angle) * distance;
      z = anchor.z + Math.sin(angle) * distance;
    } else {
      x = (random() * 2 - 1) * half * 0.94;
      z = (random() * 2 - 1) * half * 0.94;
    }
    if (Math.abs(x) > half || Math.abs(z) > half) continue;
    const y = terrain.heightAt(x, z);
    if (!accept(x, z, y)) continue;
    spots.push({ x, z, y });
  }
  return spots;
};

// --- state ------------------------------------------------------------------

const BUFFALO_STATES = ['graze', 'walk', 'wallow', 'rest', 'alert'] as const;
type BuffaloState = (typeof BUFFALO_STATES)[number];

type BuffaloActor = {
  model: BuffaloModel;
  x: number;
  z: number;
  heading: number;
  /** Where it grazes, and where it is taken at dusk. */
  anchor: Spot;
  home: { x: number; z: number };
  wallow: Spot | null;
  state: BuffaloState;
  until: number;
  stride: number;
  /** Eased pose weights, so the animal never snaps between states. */
  graze: number;
  alert: number;
  walk: number;
  sink: number;
  led: boolean;
  phase: number;
};

type Quadruped = {
  x: number;
  z: number;
  heading: number;
  anchor: Spot;
  state: number;
  until: number;
  stride: number;
  speed: number;
  phase: number;
  /** Eased weights: how upright the head is, and how much of the gait is running. */
  headDown: number;
  down: number;
  tint: Color;
};

type Flyer = {
  homeX: number;
  homeZ: number;
  homeY: number;
  phase: number;
  /** Dragonflies hold a station and jump to the next; butterflies never stop. */
  stationX: number;
  stationZ: number;
  stationY: number;
  until: number;
  dartFrom: Vector3;
  size: number;
};

export type WildlifeCounts = {
  buffalo: number;
  dogs: number;
  chickens: number;
  butterflies: number;
  dragonflies: number;
  goats: number;
};

/**
 * One knob for the caller. Detail is fixed — every animal is the full model at
 * every tier — and only how many of them there are moves, which is the whole
 * point of `chi tiết hơn số lượng`.
 */
export const wildlifeCountsFor = (scale: number): WildlifeCounts => {
  const clamped = Math.min(1, Math.max(0.2, scale));
  return {
    buffalo: Math.max(1, Math.round(5 * clamped)),
    dogs: Math.max(1, Math.round(8 * clamped)),
    chickens: Math.round(26 * clamped),
    butterflies: Math.round(44 * clamped),
    dragonflies: Math.round(24 * clamped),
    goats: Math.round(12 * clamped),
  };
};

export type Wildlife = {
  group: Group;
  update: (elapsed: number) => void;
  /** The viewer's position: insects follow it, and chickens flush from it. */
  follow: (x: number, z: number) => void;
  setNight: (amount: number) => void;
  /** What was actually placed, per kind. The census reads this. */
  counts: () => WildlifeCounts;
  dispose: () => void;
};

/**
 * Animals. The world had people, boats, birds and fireflies and not one living
 * thing on the ground, which is a specific kind of emptiness: a Vietnamese
 * landscape without a buffalo in the shallows reads as a model of a place
 * rather than the place.
 */
export const createWildlife = (
  terrain: Terrain,
  recipe: LocationRecipe,
  counts: WildlifeCounts,
  buildings: { x: number; z: number }[] = []
): Wildlife => {
  const random = createPrng(`${recipe.seed}:wildlife`);
  const group = new Group();
  group.name = 'wildlife';

  /**
   * The caller's budget is how much livestock the frame can afford, not what the
   * place keeps. Asked only `water` and `treeLine`, this module put four water
   * buffalo and nineteen chickens inside Tây Hồ, which is an inner district of
   * Hanoi — the buffalo stood in the lake because the lake is the only shallow
   * water on the map. What decides it is the kind of settlement, which
   * `styleOf` already reads off the recipe.
   *
   * Nothing is only removed. A city shore keeps the insects over the water and
   * takes the whole livestock budget in dogs, because what you actually meet
   * walking round Hồ Tây at six in the evening is other people's dogs. Goats are
   * highland and karst — dê núi Ninh Bình is the dish the place is known for —
   * and not a thing on the coastal delta at Hội An.
   */
  const style = styleOf(recipe);
  const city = style === 'city';
  const want: WildlifeCounts = {
    buffalo: city ? 0 : counts.buffalo,
    chickens: city ? 0 : counts.chickens,
    goats: style === 'highland' || style === 'delta' ? counts.goats : 0,
    dogs: city ? counts.dogs + counts.buffalo + Math.round(counts.chickens / 2) : counts.dogs,
    butterflies: counts.butterflies,
    dragonflies: counts.dragonflies,
  };

  const hasWater = recipe.water !== null;
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const treeLine = recipe.scatter.treeLine;
  const half = terrain.size / 2;

  const materials: Material[] = [];
  const makeMaterial = (options: Record<string, unknown>): MeshStandardMaterial => {
    const material = new MeshStandardMaterial({ flatShading: true, metalness: 0, ...options });
    materials.push(material);
    return material;
  };

  const palette: Palette = {
    // Three shades rather than one: a herd of identically coloured animals is
    // the thing that reads as instancing even when nothing is instanced.
    hides: ['#4b4a50', '#3f4046', '#55525a'].map((color) => makeMaterial({ color, roughness: 0.93 })),
    horn: makeMaterial({ color: '#8b8578', roughness: 0.68 }),
    dark: makeMaterial({ color: '#23222a', roughness: 0.85 }),
    skin: makeMaterial({ color: '#b08a66', roughness: 0.82 }),
    shirt: makeMaterial({ color: '#52605c', roughness: 0.9 }),
    straw: makeMaterial({ color: '#d9c48c', roughness: 0.95, side: DoubleSide }),
    rope: makeMaterial({ color: '#8d8268', roughness: 0.96 }),
  };

  // White bases, because the per-animal colour arrives as `instanceColor` and
  // multiplies: a tinted base would wash every variant toward the same hue.
  const dogFur = makeMaterial({ color: '#ffffff', roughness: 0.9 });
  const feather = makeMaterial({ color: '#ffffff', roughness: 0.88 });
  const chickenTrim = makeMaterial({ color: '#d9a23c', roughness: 0.7 });
  const chickenComb = makeMaterial({ color: '#c1372c', roughness: 0.7 });
  const fleece = makeMaterial({ color: '#ffffff', roughness: 0.95 });
  const butterflyWing = makeMaterial({ color: '#ffffff', roughness: 0.6, side: DoubleSide });
  const dragonflyBody = makeMaterial({ color: '#ffffff', roughness: 0.45 });
  const dragonflyWing = makeMaterial({
    color: '#e7f1f4',
    roughness: 0.3,
    side: DoubleSide,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });

  // --- con trâu -----------------------------------------------------------
  // Shallow water and the wet edge of a paddy, which is where a buffalo spends
  // its day. Where there is no water at all — a ridge at 1600 m — it is the
  // flattest pasture below the tree line instead, which is where the highland
  // herds actually are.
  const grazeOk = hasWater
    ? (x: number, z: number, y: number) => y > waterLevel - 0.9 && y < waterLevel + 2.6 && terrain.slopeAt(x, z) < 0.3
    : (x: number, z: number, y: number) => y < treeLine * 0.95 && terrain.slopeAt(x, z) < 0.24;

  const herdCentre = findSpots(terrain, random, 1, grazeOk)[0] ?? null;
  const buffaloSpots = herdCentre
    ? findSpots(terrain, random, want.buffalo, grazeOk, { x: herdCentre.x, z: herdCentre.z, radius: 26 })
    : [];

  const buffaloKit = buffaloSpots.length > 0 ? createBuffaloKit(palette) : null;
  const buffaloes: BuffaloActor[] = [];

  if (buffaloKit && herdCentre) {
    // A herd faces roughly the same way, which is most of what makes it read as
    // a herd rather than as several animals that happen to be nearby.
    const herdHeading = random() * Math.PI * 2;
    const wallows = hasWater
      ? findSpots(
          terrain,
          random,
          buffaloSpots.length,
          (x, z, y) => y < waterLevel - 0.45 && y > waterLevel - 1.7 && terrain.slopeAt(x, z) < 0.25,
          { x: herdCentre.x, z: herdCentre.z, radius: 70 }
        )
      : [];

    let home = { x: herdCentre.x, z: herdCentre.z };
    let nearest = Infinity;
    for (const building of buildings) {
      const distance = Math.hypot(building.x - herdCentre.x, building.z - herdCentre.z);
      if (distance < nearest) {
        nearest = distance;
        home = { x: building.x, z: building.z };
      }
    }

    buffaloSpots.forEach((spot, index) => {
      const model = buffaloKit.create(index);
      group.add(model.group);
      buffaloes.push({
        model,
        x: spot.x,
        z: spot.z,
        heading: herdHeading + (random() * 2 - 1) * 0.55,
        anchor: spot,
        home,
        wallow: wallows[index] ?? null,
        state: 'graze',
        until: 4 + random() * 12,
        stride: random() * Math.PI * 2,
        graze: 1,
        alert: 0,
        walk: 0,
        sink: 0,
        led: false,
        phase: random() * Math.PI * 2,
      });
    });
  }

  // --- chó và gà ----------------------------------------------------------
  // Both belong to the houses. Without a building to hang off there is nothing
  // for a village dog to be near, so with no town they do not appear.
  const yards = buildings.length > 0 ? buildings : [];
  const nearHouse = (wanted: number, radius: number): Spot[] => {
    const spots: Spot[] = [];
    if (yards.length === 0 || wanted <= 0) return spots;
    for (let i = 0; i < wanted; i += 1) {
      const yard = yards[Math.floor(random() * yards.length)];
      const found = findSpots(terrain, random, 1, (x, z, y) => y > waterLevel + 0.6 && terrain.slopeAt(x, z) < 0.5, {
        x: yard.x,
        z: yard.z,
        radius,
      });
      if (found[0]) spots.push(found[0]);
    }
    return spots;
  };

  const dogSpots = nearHouse(want.dogs, 24);
  const chickenSpots = nearHouse(want.chickens, 13);

  const DOG_COATS = ['#a8794a', '#6d5a46', '#2c2a28', '#c6b193', '#8a6b4f'];
  const dogRig = dogSpots.length > 0 ? createDogRig(palette, dogFur, dogSpots.length) : null;
  const dogs: Quadruped[] = dogSpots.map((spot, index) => ({
    x: spot.x,
    z: spot.z,
    heading: random() * Math.PI * 2,
    anchor: spot,
    state: 0,
    until: 1 + random() * 4,
    stride: random() * Math.PI * 2,
    speed: 1.5 + random() * 0.8,
    phase: random() * Math.PI * 2,
    headDown: 0,
    down: 0,
    tint: new Color(DOG_COATS[index % DOG_COATS.length]),
  }));

  const HEN_COATS = ['#9a6b3e', '#d8cfbe', '#3a3632', '#b58c54', '#7e5c3c'];
  const chickenRig =
    chickenSpots.length > 0 ? createChickenRig(palette, feather, chickenTrim, chickenComb, chickenSpots.length) : null;
  const chickens: Quadruped[] = chickenSpots.map((spot, index) => ({
    x: spot.x,
    z: spot.z,
    heading: random() * Math.PI * 2,
    anchor: spot,
    state: 0,
    until: 0.5 + random() * 2,
    stride: random() * Math.PI * 2,
    speed: 0.7 + random() * 0.4,
    phase: random() * Math.PI * 2,
    headDown: 1,
    down: 0,
    tint: new Color(HEN_COATS[index % HEN_COATS.length]),
  }));

  // --- dê: slopes only, so in practice the highland ridge -----------------
  const goatSpots = findSpots(terrain, random, want.goats, (x, z, y) => {
    const slope = terrain.slopeAt(x, z);
    return y > waterLevel + 2 && y < treeLine * 1.05 && slope > 0.3 && slope < 1.1;
  });
  const GOAT_COATS = ['#d6cdbd', '#8f7f6a', '#4a443c', '#b3a289'];
  const goatRig = goatSpots.length > 0 ? createGoatRig(palette, fleece, goatSpots.length) : null;
  const goats: Quadruped[] = goatSpots.map((spot, index) => ({
    x: spot.x,
    z: spot.z,
    heading: random() * Math.PI * 2,
    anchor: spot,
    state: 0,
    until: 3 + random() * 8,
    stride: random() * Math.PI * 2,
    speed: 0.6 + random() * 0.5,
    phase: random() * Math.PI * 2,
    headDown: 1,
    down: 0,
    tint: new Color(GOAT_COATS[index % GOAT_COATS.length]),
  }));

  // --- bướm và chuồn chuồn ------------------------------------------------
  const butterflyRig = want.butterflies > 0 ? createButterflyRig(palette.dark, butterflyWing, want.butterflies) : null;
  const WING_COLOURS = ['#f3d24e', '#f6f2e4', '#5d81c6', '#d4772e', '#e8e0f0'];
  const butterflies: Flyer[] = Array.from({ length: butterflyRig ? want.butterflies : 0 }, () => ({
    homeX: 0,
    homeZ: 0,
    homeY: -10_000,
    phase: random() * Math.PI * 2,
    stationX: 0,
    stationZ: 0,
    stationY: 0,
    until: 0,
    dartFrom: new Vector3(),
    size: 0.85 + random() * 0.45,
  }));

  const dragonflyRig =
    hasWater && want.dragonflies > 0 ? createDragonflyRig(dragonflyBody, dragonflyWing, want.dragonflies) : null;
  const DRAGON_COLOURS = ['#c2402f', '#3f7fb5', '#5d8f52', '#c8a63a'];
  const dragonflies: Flyer[] = Array.from({ length: dragonflyRig ? want.dragonflies : 0 }, () => ({
    homeX: 0,
    homeZ: 0,
    homeY: -10_000,
    phase: random() * Math.PI * 2,
    stationX: 0,
    stationZ: 0,
    stationY: 0,
    until: 0,
    dartFrom: new Vector3(),
    size: 0.9 + random() * 0.35,
  }));

  for (const rig of [dogRig, chickenRig, goatRig]) {
    if (!rig) continue;
    for (const mesh of rig.meshes) group.add(mesh);
  }
  for (const rig of [butterflyRig, dragonflyRig]) {
    if (!rig) continue;
    for (const mesh of rig.meshes) group.add(mesh);
  }

  dogs.forEach((dog, index) => dogRig?.setTint(index, dog.tint));
  chickens.forEach((hen, index) => chickenRig?.setTint(index, hen.tint));
  goats.forEach((goat, index) => goatRig?.setTint(index, goat.tint));
  butterflies.forEach((_, index) => butterflyRig?.setTint(index, new Color(WING_COLOURS[index % WING_COLOURS.length])));
  dragonflies.forEach((_, index) =>
    dragonflyRig?.setTint(index, new Color(DRAGON_COLOURS[index % DRAGON_COLOURS.length]))
  );

  // --- per-frame scratch, hoisted ----------------------------------------
  const scratch = new Vector3();
  let night = 0;
  let viewerX = 0;
  let viewerZ = 0;
  let laidX = Infinity;
  let laidZ = Infinity;
  let lastElapsed = 0;

  /** Eases a weight toward a target with a time constant, framerate-independent. */
  const ease = (current: number, target: number, rate: number, delta: number) =>
    current + (target - current) * Math.min(1, rate * delta);

  const inBounds = (x: number, z: number) => Math.abs(x) < half * 0.98 && Math.abs(z) < half * 0.98;

  /**
   * Walks an animal toward a point, turning rather than sliding, and refusing
   * ground it has no business on. Returns true when it has arrived.
   */
  const walkToward = (
    actor: { x: number; z: number; heading: number },
    targetX: number,
    targetZ: number,
    speed: number,
    delta: number,
    passable: (x: number, z: number, y: number) => boolean
  ): boolean => {
    const dx = targetX - actor.x;
    const dz = targetZ - actor.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.8) return true;

    const wanted = Math.atan2(dz, dx);
    let turn = wanted - actor.heading;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    actor.heading += Math.max(-1, Math.min(1, turn * 2.5)) * 1.4 * delta;

    const advance = speed * delta;
    const x = actor.x + Math.cos(actor.heading) * advance;
    const z = actor.z + Math.sin(actor.heading) * advance;
    if (inBounds(x, z) && passable(x, z, terrain.heightAt(x, z))) {
      actor.x = x;
      actor.z = z;
    } else {
      // Nowhere to go this way, so turn out of it rather than grinding.
      actor.heading += 1.8 * delta;
    }
    return false;
  };

  const updateBuffaloes = (elapsed: number, delta: number) => {
    // Dusk takes them home, and deep night they are lying down there. This is
    // the behaviour `setNight` is for — brightness is the lighting's job.
    const homing = night > 0.3 && night < 0.9;
    const bedded = night >= 0.9;

    buffaloes.forEach((actor, index) => {
      if (elapsed >= actor.until) {
        const roll = random();
        if (bedded) {
          actor.state = 'rest';
          actor.until = elapsed + 20 + random() * 30;
        } else if (homing) {
          actor.state = Math.hypot(actor.x - actor.home.x, actor.z - actor.home.z) > 14 ? 'walk' : 'graze';
          actor.until = elapsed + 5 + random() * 8;
        } else if (actor.state === 'wallow') {
          actor.state = 'graze';
          actor.until = elapsed + 8 + random() * 14;
        } else if (actor.wallow && roll < 0.14) {
          actor.state = 'walk';
          actor.until = elapsed + 24;
        } else if (roll < 0.34) {
          actor.state = 'walk';
          actor.until = elapsed + 4 + random() * 7;
        } else if (roll < 0.42) {
          actor.state = 'alert';
          actor.until = elapsed + 1.5 + random() * 3;
        } else if (roll < 0.5) {
          actor.state = 'rest';
          actor.until = elapsed + 6 + random() * 12;
        } else {
          actor.state = 'graze';
          actor.until = elapsed + 10 + random() * 18;
        }
      }

      const wallowing = actor.state === 'wallow';
      const walking = actor.state === 'walk';
      let targetGraze = 0;
      let targetAlert = 0;
      let targetWalk = 0;
      let targetSink = 0;

      if (actor.state === 'graze') targetGraze = 1;
      if (actor.state === 'alert') targetAlert = 1;
      if (wallowing) targetSink = 0.72;
      if (actor.state === 'rest') targetGraze = 0.12;

      if (walking) {
        targetWalk = 1;
        const goal = bedded || homing ? actor.home : (actor.wallow ?? actor.anchor);
        const arrived = walkToward(actor, goal.x, goal.z, 0.95, delta, grazeOk);
        if (arrived) {
          // Reaching the wallow is what starts the wallow; reaching home at dusk
          // just means standing there.
          actor.state = actor.wallow && goal === actor.wallow ? 'wallow' : 'graze';
          actor.until = elapsed + (actor.state === 'wallow' ? 25 + random() * 40 : 8 + random() * 12);
        }
      } else if (actor.state === 'graze') {
        // Grazing drifts: a few steps, a mouthful, a few more.
        const creep = (Math.sin(elapsed * 0.21 + actor.phase) + 1) * 0.5;
        if (creep > 0.82) {
          targetWalk = 0.35;
          walkToward(actor, actor.anchor.x, actor.anchor.z, 0.22, delta, grazeOk);
        }
      }

      actor.graze = ease(actor.graze, targetGraze, 2.2, delta);
      actor.alert = ease(actor.alert, targetAlert, 5, delta);
      actor.walk = ease(actor.walk, targetWalk, 3, delta);
      actor.sink = ease(actor.sink, targetSink, 1.1, delta);
      actor.stride += actor.walk * 2.1 * delta;

      // One animal in the herd is the one being led, and only at dusk.
      const led = homing && index === 0;
      if (led !== actor.led) {
        actor.led = led;
        actor.model.setLed(led);
      }

      const ground = terrain.heightAt(actor.x, actor.z);
      actor.model.group.position.set(actor.x, ground, actor.z);
      actor.model.group.rotation.set(0, -actor.heading + Math.PI / 2, 0);
      actor.model.pose({
        graze: actor.graze,
        alert: actor.alert,
        walk: actor.walk,
        stride: actor.stride,
        sink: actor.sink,
        elapsed,
      });
    });
  };

  const DOG_TROT = 0;
  const DOG_SNIFF = 1;
  const DOG_LIE = 2;
  const DOG_ALERT = 3;

  const updateDogs = (elapsed: number, delta: number) => {
    if (!dogRig) return;
    const rig = dogRig;

    dogs.forEach((dog, index) => {
      const noticed = Math.hypot(dog.x - viewerX, dog.z - viewerZ) < DOG_NOTICE_RADIUS;
      if (noticed && dog.state !== DOG_ALERT && random() < 0.05) {
        dog.state = DOG_ALERT;
        dog.until = elapsed + 1.2 + random() * 2;
      }

      if (elapsed >= dog.until) {
        const roll = random();
        // Dogs are out at all hours; what changes is how much of it is spent
        // lying down. Noon sun and the small hours both favour lying.
        const lazy = 0.3 + night * 0.4;
        if (roll < lazy) {
          dog.state = DOG_LIE;
          dog.until = elapsed + 6 + random() * 22;
        } else if (roll < lazy + 0.3) {
          dog.state = DOG_SNIFF;
          dog.until = elapsed + 1.5 + random() * 4;
        } else {
          dog.state = DOG_TROT;
          dog.until = elapsed + 2 + random() * 6;
          dog.heading = random() * Math.PI * 2;
        }
      }

      let gait = 0;
      let targetHead = 0;
      let targetDown = 0;

      if (dog.state === DOG_TROT) {
        gait = 1;
        // A radius, not a wander: a village dog has a yard.
        const away = Math.hypot(dog.x - dog.anchor.x, dog.z - dog.anchor.z);
        if (away > 22) {
          walkToward(dog, dog.anchor.x, dog.anchor.z, dog.speed, delta, (x, z, y) => y > waterLevel + 0.3);
        } else {
          dog.heading += Math.sin(elapsed * 0.6 + dog.phase) * 0.9 * delta;
          const advance = dog.speed * delta;
          const x = dog.x + Math.cos(dog.heading) * advance;
          const z = dog.z + Math.sin(dog.heading) * advance;
          if (inBounds(x, z) && terrain.heightAt(x, z) > waterLevel + 0.3) {
            dog.x = x;
            dog.z = z;
          } else dog.heading += 2.4 * delta;
        }
      } else if (dog.state === DOG_SNIFF) {
        targetHead = 1;
      } else if (dog.state === DOG_LIE) {
        targetDown = 1;
      }

      dog.headDown = ease(dog.headDown, targetHead, 4, delta);
      dog.down = ease(dog.down, targetDown, 3, delta);
      dog.stride += gait * 9 * delta;

      const alerted = dog.state === DOG_ALERT;
      const ground = terrain.heightAt(dog.x, dog.z);
      rig.root.position.set(dog.x, ground - dog.down * 0.2, dog.z);
      rig.root.rotation.set(0, -dog.heading + Math.PI / 2, 0);

      // Sniffing puts the nose on the ground; alert snaps it up and the tail
      // goes stiff. Lying folds the legs under, which is the lowered root plus
      // legs swung forward.
      rig.head.rotation.x = dog.headDown * 0.95 - (alerted ? 0.3 : 0) + dog.down * 0.1;
      rig.head.rotation.y = Math.sin(elapsed * (1.4 + dog.headDown * 3)) * 0.22;
      // Wagging: fast and wide when trotting or greeting, a slow sweep at rest.
      const wag = gait > 0.5 || alerted ? 7.5 : 1.6;
      rig.tail.rotation.z = Math.sin(elapsed * wag + dog.phase) * (gait > 0.5 || alerted ? 0.55 : 0.22);
      rig.tail.rotation.x = -0.2 - (alerted ? 0.35 : 0) + dog.down * 0.3;

      for (let leg = 0; leg < rig.legs.length; leg += 1) {
        // Diagonal pairs: a dog trots, unlike the buffalo.
        const diagonal = leg === 0 || leg === 3 ? 0 : Math.PI;
        rig.legs[leg].rotation.x = Math.sin(dog.stride + diagonal) * 0.5 * gait + dog.down * 1.25;
        rig.legs[leg].scale.setScalar(1 - dog.down * 0.35);
      }

      rig.commit(index);
    });

    rig.flush();
  };

  const HEN_PECK = 0;
  const HEN_SCUTTLE = 1;
  const HEN_PREEN = 2;
  const HEN_FLEE = 3;

  const updateChickens = (elapsed: number, delta: number) => {
    if (!chickenRig) return;
    const rig = chickenRig;
    // They roost at dusk and are not out at night. Hiding them is honest: a
    // chicken standing in a yard at 2am is worse than no chicken.
    const roosting = night > 0.42;

    chickens.forEach((hen, index) => {
      if (roosting) {
        rig.root.scale.setScalar(0);
        rig.commit(index);
        return;
      }
      rig.root.scale.setScalar(1);

      if (hen.state !== HEN_FLEE && Math.hypot(hen.x - viewerX, hen.z - viewerZ) < FLUSH_RADIUS) {
        hen.state = HEN_FLEE;
        hen.until = elapsed + 1.1 + random() * 1.2;
        hen.heading = Math.atan2(hen.z - viewerZ, hen.x - viewerX) + (random() * 2 - 1) * 0.7;
      }

      if (elapsed >= hen.until) {
        const roll = random();
        if (roll < 0.5) {
          hen.state = HEN_PECK;
          hen.until = elapsed + 1.2 + random() * 2.6;
        } else if (roll < 0.85) {
          hen.state = HEN_SCUTTLE;
          hen.until = elapsed + 0.5 + random() * 1.1;
          hen.heading = random() * Math.PI * 2;
        } else {
          hen.state = HEN_PREEN;
          hen.until = elapsed + 1.5 + random() * 3;
        }
      }

      const fleeing = hen.state === HEN_FLEE;
      let gait = 0;
      let targetHead = 0;

      if (fleeing || hen.state === HEN_SCUTTLE) {
        gait = fleeing ? 1 : 0.7;
        const speed = fleeing ? 3.4 : hen.speed;
        const away = Math.hypot(hen.x - hen.anchor.x, hen.z - hen.anchor.z);
        if (!fleeing && away > 11) hen.heading = Math.atan2(hen.anchor.z - hen.z, hen.anchor.x - hen.x);
        const advance = speed * delta;
        const x = hen.x + Math.cos(hen.heading) * advance;
        const z = hen.z + Math.sin(hen.heading) * advance;
        if (inBounds(x, z) && terrain.heightAt(x, z) > waterLevel + 0.4) {
          hen.x = x;
          hen.z = z;
        } else hen.heading += 3 * delta;
      } else if (hen.state === HEN_PECK) {
        // Pecking is bursts, not a metronome: three or four quick stabs, then
        // the head comes up and stays up for a moment.
        const cycle = (elapsed * 0.55 + hen.phase) % 1;
        targetHead = cycle < 0.55 ? Math.max(0, Math.sin((elapsed * 7 + hen.phase) * Math.PI)) : 0;
      }

      hen.headDown = ease(hen.headDown, targetHead, 16, delta);
      hen.stride += gait * 13 * delta;

      const ground = terrain.heightAt(hen.x, hen.z);
      // Running hens bob; a pecking one is still.
      rig.root.position.set(hen.x, ground + Math.abs(Math.sin(hen.stride)) * 0.018 * gait, hen.z);
      rig.root.rotation.set(0, -hen.heading + Math.PI / 2, 0);
      rig.root.rotation.z = Math.sin(hen.stride) * 0.1 * gait;

      rig.head.rotation.x = hen.headDown * 1.45 + (fleeing ? -0.35 : 0);
      rig.head.rotation.y = hen.state === HEN_PREEN ? Math.sin(elapsed * 4 + hen.phase) * 0.9 : 0;
      rig.tail.rotation.x = -0.1 + (fleeing ? -0.5 : 0) + hen.headDown * 0.35;

      for (let leg = 0; leg < rig.legs.length; leg += 1) {
        rig.legs[leg].rotation.x = Math.sin(hen.stride + leg * Math.PI) * 0.75 * gait;
      }

      rig.commit(index);
    });

    rig.flush();
  };

  const updateGoats = (elapsed: number, delta: number) => {
    if (!goatRig) return;
    const rig = goatRig;
    const bedded = night > 0.55;

    goats.forEach((goat, index) => {
      if (elapsed >= goat.until) {
        const roll = random();
        if (bedded || roll < 0.25) {
          goat.state = 2;
          goat.until = elapsed + 10 + random() * 24;
        } else if (roll < 0.55) {
          goat.state = 1;
          goat.until = elapsed + 3 + random() * 6;
          goat.heading = random() * Math.PI * 2;
        } else {
          goat.state = 0;
          goat.until = elapsed + 6 + random() * 14;
        }
      }

      let gait = 0;
      let targetHead = 0;
      if (goat.state === 0) targetHead = 1;
      if (goat.state === 1) {
        gait = 1;
        const away = Math.hypot(goat.x - goat.anchor.x, goat.z - goat.anchor.z);
        if (away > 18) goat.heading = Math.atan2(goat.anchor.z - goat.z, goat.anchor.x - goat.x);
        const advance = goat.speed * delta;
        const x = goat.x + Math.cos(goat.heading) * advance;
        const z = goat.z + Math.sin(goat.heading) * advance;
        if (inBounds(x, z) && terrain.heightAt(x, z) > waterLevel + 1 && terrain.slopeAt(x, z) < 1.2) {
          goat.x = x;
          goat.z = z;
        } else goat.heading += 2.2 * delta;
      }
      if (goat.state === 2) targetHead = 0.15;

      goat.headDown = ease(goat.headDown, targetHead, 3, delta);
      goat.stride += gait * 5.5 * delta;

      const ground = terrain.heightAt(goat.x, goat.z);
      rig.root.position.set(goat.x, ground, goat.z);
      rig.root.rotation.set(0, -goat.heading + Math.PI / 2, 0);
      rig.head.rotation.x = goat.headDown * 1.05;
      rig.head.rotation.y = Math.sin(elapsed * 1.9 + goat.phase) * 0.18;
      rig.tail.rotation.z = Math.sin(elapsed * 5 + goat.phase) * 0.4;

      for (let leg = 0; leg < rig.legs.length; leg += 1) {
        const order = [0, 0.25, 0.5, 0.75][leg];
        rig.legs[leg].rotation.x = Math.sin(goat.stride + order * Math.PI * 2) * 0.42 * gait;
      }

      rig.commit(index);
    });

    rig.flush();
  };

  /** Lays the insects out around the viewer. Both kinds need their own ground. */
  const layInsects = (centreX: number, centreZ: number) => {
    for (const flyer of butterflies) {
      const angle = random() * Math.PI * 2;
      const distance = Math.sqrt(random()) * BUTTERFLY_RADIUS;
      const x = centreX + Math.cos(angle) * distance;
      const z = centreZ + Math.sin(angle) * distance;
      const ground = terrain.heightAt(x, z);
      // Over vegetation, which is dry ground below the tree line and not a cliff.
      const bare =
        Math.abs(x) > half ||
        Math.abs(z) > half ||
        ground <= waterLevel + 0.3 ||
        ground > treeLine * 1.2 ||
        terrain.slopeAt(x, z) > 1.1;
      flyer.homeX = x;
      flyer.homeZ = z;
      flyer.homeY = bare ? -10_000 : ground + 0.4 + random() * 1.8;
    }

    for (const flyer of dragonflies) {
      let placed = false;
      for (let attempt = 0; attempt < 12 && !placed; attempt += 1) {
        const angle = random() * Math.PI * 2;
        const distance = Math.sqrt(random()) * DRAGONFLY_RADIUS;
        const x = centreX + Math.cos(angle) * distance;
        const z = centreZ + Math.sin(angle) * distance;
        if (Math.abs(x) > half || Math.abs(z) > half) continue;
        // Dragonflies are over water, full stop. Inland there are none, which is
        // why they vanish as you walk away from the river.
        if (terrain.heightAt(x, z) > waterLevel - 0.05) continue;
        flyer.homeX = x;
        flyer.homeZ = z;
        flyer.homeY = waterLevel + 0.25 + random() * 0.9;
        flyer.stationX = x;
        flyer.stationZ = z;
        flyer.stationY = flyer.homeY;
        flyer.until = 0;
        placed = true;
      }
      if (!placed) flyer.homeY = -10_000;
    }
  };

  const updateButterflies = (elapsed: number) => {
    if (!butterflyRig) return;
    const rig = butterflyRig;
    // Daytime insects. They are gone before the fireflies arrive.
    const awake = Math.max(0, 1 - night * 2.6);

    butterflies.forEach((flyer, index) => {
      if (flyer.homeY < -1000 || awake <= 0.01) {
        rig.root.scale.setScalar(0);
        rig.commit(index);
        return;
      }

      // Three incommensurate loops, which is what makes the path read as erratic
      // rather than as a circle: a butterfly never repeats a turn.
      const t = elapsed * 0.9 + flyer.phase;
      const x = flyer.homeX + Math.sin(t * 0.73) * 2.4 + Math.sin(t * 1.61 + 1.3) * 0.9;
      const z = flyer.homeZ + Math.cos(t * 0.59) * 2.4 + Math.cos(t * 1.37 + 0.4) * 0.9;
      const y = flyer.homeY + Math.sin(t * 1.9) * 0.45 + Math.sin(t * 4.3) * 0.12;

      // Heading from the actual velocity, differenced analytically so there is
      // no stored previous position to go stale when the swarm is relaid.
      const dx = Math.cos(t * 0.73) * 0.73 * 2.4 + Math.cos(t * 1.61 + 1.3) * 1.61 * 0.9;
      const dz = -Math.sin(t * 0.59) * 0.59 * 2.4 - Math.sin(t * 1.37 + 0.4) * 1.37 * 0.9;

      rig.root.position.set(x, y, z);
      rig.root.rotation.set(0, Math.atan2(dx, dz), 0);
      rig.root.scale.setScalar(flyer.size * awake);
      // The beat is huge and slow, and the wings nearly clap over the back —
      // small symmetric flapping reads as a moth, or as a bird too far away.
      const flap = Math.sin(elapsed * 11 + flyer.phase * 3) * 1.15 + 0.25;
      rig.wings[0].rotation.z = flap;
      rig.wings[1].rotation.z = -flap;
      rig.root.rotation.z = Math.sin(elapsed * 11 + flyer.phase * 3) * 0.1;
      rig.commit(index);
    });

    rig.flush();
  };

  const updateDragonflies = (elapsed: number) => {
    if (!dragonflyRig) return;
    const rig = dragonflyRig;
    // Out by day and strongest at dusk over the water, gone once it is dark.
    const awake = Math.max(0, Math.min(1, (0.72 - night) * 3));

    dragonflies.forEach((flyer, index) => {
      if (flyer.homeY < -1000 || awake <= 0.01) {
        rig.root.scale.setScalar(0);
        rig.commit(index);
        return;
      }

      if (elapsed >= flyer.until) {
        // The dart: pick a new station and get there in a fraction of a second.
        // Nothing else in the scene moves like this, and it is the whole reason
        // a dragonfly is worth having.
        flyer.dartFrom.set(flyer.stationX, flyer.stationY, flyer.stationZ);
        const angle = random() * Math.PI * 2;
        const reach = 0.6 + random() * 3.2;
        const x = flyer.homeX + Math.cos(angle) * reach;
        const z = flyer.homeZ + Math.sin(angle) * reach;
        if (terrain.heightAt(x, z) < waterLevel - 0.05) {
          flyer.stationX = x;
          flyer.stationZ = z;
        }
        flyer.stationY = waterLevel + 0.2 + random() * 1.1;
        flyer.until = elapsed + 0.55 + random() * 2.4;
      }

      // 0.14 s of travel, then it holds station. The ease is cubic out, so it
      // arrives and stops dead rather than drifting in.
      const since = Math.max(0, flyer.until - elapsed);
      const dart = Math.min(1, Math.max(0, 1 - (since - 0.41) / 0.14));
      const eased = 1 - (1 - dart) ** 3;
      const x = flyer.dartFrom.x + (flyer.stationX - flyer.dartFrom.x) * eased;
      const y = flyer.dartFrom.y + (flyer.stationY - flyer.dartFrom.y) * eased;
      const z = flyer.dartFrom.z + (flyer.stationZ - flyer.dartFrom.z) * eased;

      scratch.set(flyer.stationX - flyer.dartFrom.x, 0, flyer.stationZ - flyer.dartFrom.z);
      const heading = scratch.lengthSq() > 1e-6 ? Math.atan2(scratch.x, scratch.z) : flyer.phase;

      // Holding station is not holding still: it hangs, trembling.
      const hover = 1 - eased;
      rig.root.position.set(
        x + Math.sin(elapsed * 6.1 + flyer.phase) * 0.03 * hover,
        y + Math.sin(elapsed * 7.7 + flyer.phase) * 0.022,
        z + Math.cos(elapsed * 5.3 + flyer.phase) * 0.03 * hover
      );
      rig.root.rotation.set(0, heading, 0);
      rig.root.rotation.x = -eased * 0.3;
      rig.root.scale.setScalar(flyer.size * awake);

      // Fore and hind wings beat out of phase, which is what a dragonfly does
      // and why its wings never look like one pair.
      const beat = Math.sin(elapsed * 34 + flyer.phase * 5) * 0.4;
      rig.wings[0].rotation.z = beat;
      rig.wings[1].rotation.z = -beat;
      rig.wings[2].rotation.z = -beat;
      rig.wings[3].rotation.z = beat;
      rig.commit(index);
    });

    rig.flush();
  };

  const update = (elapsed: number) => {
    const delta = Math.min(0.1, Math.max(0, elapsed - lastElapsed));
    lastElapsed = elapsed;

    updateBuffaloes(elapsed, delta);
    updateDogs(elapsed, delta);
    updateChickens(elapsed, delta);
    updateGoats(elapsed, delta);
    updateButterflies(elapsed);
    updateDragonflies(elapsed);
  };

  const follow = (x: number, z: number) => {
    viewerX = x;
    viewerZ = z;
    if (Math.hypot(x - laidX, z - laidZ) < INSECT_RESTEP) return;
    laidX = x;
    laidZ = z;
    layInsects(x, z);
  };

  follow(0, 0);
  update(0);

  return {
    group,
    update,
    follow,
    setNight: (amount) => {
      night = Math.min(1, Math.max(0, amount));
    },
    counts: () => ({
      buffalo: buffaloes.length,
      dogs: dogs.length,
      chickens: chickens.length,
      butterflies: butterflies.length,
      dragonflies: dragonflies.length,
      goats: goats.length,
    }),
    dispose: () => {
      for (const actor of buffaloes) actor.model.dispose();
      buffaloKit?.dispose();
      dogRig?.dispose();
      chickenRig?.dispose();
      goatRig?.dispose();
      butterflyRig?.dispose();
      dragonflyRig?.dispose();
      for (const material of materials) material.dispose();
    },
  };
};
