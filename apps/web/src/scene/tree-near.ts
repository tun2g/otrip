import { createPrng, type LocationRecipe, type Prng, type Terrain } from '@otrip/world';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  RGBADepthPacking,
  Vector3,
  type Material,
} from 'three';

import type { GroundClaims } from './ground-claims';
import type { Obstacle } from './obstacle-index';
import { applyWindSway, type Wind } from './wind';

const TAU = Math.PI * 2;
const UP = new Vector3(0, 1, 0);

/**
 * How far from the viewer a built tree is kept. The cone field carries the
 * forest past this, which is the whole point of the split: a 34-triangle cone is
 * a perfectly good tree at 300 m and an embarrassment at 20.
 */
const RADIUS = 100;
/**
 * Metres over which a tree entering the disc grows to full size. Fog is the
 * usual way to hide the seam, and at this scene's densities (5e-5 to 1.6e-4)
 * FogExp2 is still under one part in a thousand at 100 m, so it hides nothing.
 * Growing in over the outer band does: at walking pace a tree takes twenty
 * seconds over its last three metres, ninety metres away, inside a forest.
 */
const FADE_BAND = 30;
/** Metres the viewer may move before the sites are picked again. */
const RESTEP = 9;
/** Side of the site lattice. One candidate per cell, jittered inside it. */
const CELL = 46;
/** Fraction of a cell a site may wander from its centre, so the lattice never shows. */
const JITTER = 0.76;
/** Cells each way the scan covers, from RADIUS plus the worst jitter. */
const CELL_REACH = Math.ceil((RADIUS + CELL * JITTER * 0.5) / CELL);
const CELL_SPAN = CELL_REACH * 2 + 1;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smoothstep = (value: number) => value * value * (3 - 2 * value);

// --- the mould -------------------------------------------------------------

/**
 * Positions, vertex colours and indices, accumulated and then frozen. Every
 * plant here is built this way rather than out of three's primitives because the
 * two things that make the difference — a radius that varies with angle, and a
 * tint that varies per vertex — are exactly what a `CylinderGeometry` cannot do.
 */
type Mould = { position: number[]; color: number[]; index: number[] };

const mould = (): Mould => ({ position: [], color: [], index: [] });

const vertex = (m: Mould, x: number, y: number, z: number, tint: Color): number => {
  const index = m.position.length / 3;
  m.position.push(x, y, z);
  m.color.push(tint.r, tint.g, tint.b);
  return index;
};

const finish = (m: Mould, slack: number): BufferGeometry => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(m.position), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(m.color), 3));
  geometry.setIndex(m.index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  // The wind shader pushes vertices outside the sphere three culls against, so
  // without the slack a tree at the edge of the frame pops out while a gust
  // still has part of it on screen.
  if (geometry.boundingSphere) geometry.boundingSphere.radius += slack;
  return geometry;
};

type Carve = { bark: Mould; leaf: Mould };

// --- primitives ------------------------------------------------------------

type Node = { at: Vector3; radius: number; tint: Color };

type TubeOptions = {
  sides: number;
  /** Radius multiplier by ring and angle: buttress roots, a palm's swollen bole. */
  swell?: (ring: number, angle: number) => number;
  /** Lightness multiplier by ring and angle: the vertical furrows that read as bark. */
  streak?: (ring: number, angle: number) => number;
};

const perpendicular = (direction: Vector3, into: Vector3): Vector3 => {
  if (Math.abs(direction.y) < 0.92) into.set(-direction.z, 0, direction.x);
  else into.set(1, 0, 0);
  return into.sub(direction.clone().multiplyScalar(into.dot(direction))).normalize();
};

/**
 * A tapered tube through a polyline. The frame is parallel-transported from one
 * ring to the next rather than rebuilt from world up, which is what stops a
 * branch that curves over the horizontal from pinching shut as it passes it.
 */
const tube = (m: Mould, path: Node[], options: TubeOptions): void => {
  if (path.length < 2) return;

  const { sides } = options;
  const direction = new Vector3();
  const normal = new Vector3();
  const binormal = new Vector3();
  const projected = new Vector3();
  const tint = new Color();
  let previous = -1;

  for (let i = 0; i < path.length; i += 1) {
    const node = path[i];
    const ahead = path[Math.min(i + 1, path.length - 1)].at;
    const behind = path[Math.max(i - 1, 0)].at;
    direction.copy(ahead).sub(behind);
    if (direction.lengthSq() < 1e-9) direction.copy(UP);
    direction.normalize();

    if (i === 0) {
      perpendicular(direction, normal);
    } else {
      projected.copy(direction).multiplyScalar(normal.dot(direction));
      normal.sub(projected);
      if (normal.lengthSq() < 1e-6) perpendicular(direction, normal);
      else normal.normalize();
    }
    binormal.crossVectors(direction, normal);

    const first = m.position.length / 3;
    for (let s = 0; s < sides; s += 1) {
      const angle = (s / sides) * TAU;
      const radius = node.radius * (options.swell ? options.swell(i, angle) : 1);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      tint.copy(node.tint);
      if (options.streak) tint.multiplyScalar(options.streak(i, angle));
      vertex(
        m,
        node.at.x + (cos * normal.x + sin * binormal.x) * radius,
        node.at.y + (cos * normal.y + sin * binormal.y) * radius,
        node.at.z + (cos * normal.z + sin * binormal.z) * radius,
        tint
      );
    }

    if (previous >= 0) {
      for (let s = 0; s < sides; s += 1) {
        const next = (s + 1) % sides;
        const a = previous + s;
        const b = previous + next;
        const c = first + s;
        const d = first + next;
        m.index.push(a, d, c, a, b, d);
      }
    }
    previous = first;
  }
};

/** Columns of a whole blade: one edge, the midrib, the other edge. */
const WHOLE_BLADE = [-1, 0, 1];
/** A banana leaf the wind has already torn into ribbons, and the spans it lost. */
const TORN_BLADE = [-1, -0.56, -0.44, 0, 0.44, 0.56, 1];
const TORN_GAPS = [1, 4];

type BladeSpec = {
  from: Vector3;
  /** Unit, the direction the midrib leaves `from` in. */
  along: Vector3;
  /** Unit, perpendicular to `along`; the blade's width runs this way. */
  across: Vector3;
  /** Unit, the way the leaf falls. Explicit because handedness is the caller's. */
  down: Vector3;
  length: number;
  segments: number;
  /** Half-width in metres at t along the midrib. */
  half: (t: number) => number;
  /** Metres the midrib has fallen below the straight line at t. */
  drop: (t: number) => number;
  /** Edge fall as a fraction of the half-width: the crease down the middle. */
  fold: number;
  columns: number[];
  /** Spans between adjacent columns that carry no blade. */
  gaps?: number[];
  /** The midrib's colour; the edges lerp from it toward `rim`. */
  tint: Color;
  rim: Color;
};

/**
 * A leaf, as a midrib with the blade folded down on either side. The fold is the
 * whole trick: a flat quad reads as paper from any angle off its normal, and a
 * leaf with a crease catches the light on one half and not the other.
 */
const blade = (m: Mould, spec: BladeSpec): void => {
  const { from, along, across, down, length, segments, columns } = spec;
  const tint = new Color();
  const rows: number[] = [];

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const half = spec.half(t);
    const drop = spec.drop(t);
    const first = m.position.length / 3;
    for (const column of columns) {
      const offset = Math.abs(column);
      const fall = drop + spec.fold * half * offset * offset;
      tint.copy(spec.tint).lerp(spec.rim, offset * 0.85);
      vertex(
        m,
        from.x + along.x * length * t + across.x * half * column + down.x * fall,
        from.y + along.y * length * t + across.y * half * column + down.y * fall,
        from.z + along.z * length * t + across.z * half * column + down.z * fall,
        tint
      );
    }
    rows.push(first);
  }

  for (let i = 0; i < segments; i += 1) {
    for (let c = 0; c < columns.length - 1; c += 1) {
      if (spec.gaps?.includes(c)) continue;
      const a = rows[i] + c;
      const b = rows[i] + c + 1;
      const under = rows[i + 1] + c;
      const beside = rows[i + 1] + c + 1;
      m.index.push(a, under, beside, a, beside, b);
    }
  }
};

type BlobSpec = {
  centre: Vector3;
  radius: number;
  /** Vertical squash. Under 1 flattens the lump, which is what a leaf clump does. */
  flatten: number;
  meridians: number;
  bands: number;
  /** Seeds the lumpiness, so neighbouring clumps are not the same lump. */
  seed: number;
  shade: Color;
  lit: Color;
  /** 0 a clump buried inside the crown, 1 one on the sunlit outside. */
  exposure: number;
};

/**
 * A leaf clump. The light that gets through a canopy is most of what a tree
 * looks like close up, and this is the cheap way to say it: the lump's own
 * underside is dark, its top is lit, and a clump tucked inside the crown is
 * darker than one on the outside. Baked into the vertex colour, so it costs
 * nothing per frame and survives any lighting the sky hands the scene.
 */
const blob = (m: Mould, spec: BlobSpec): void => {
  const { centre, radius, meridians, bands, seed } = spec;
  const tint = new Color();

  const put = (polar: number, azimuth: number): number => {
    const lump = 1 + 0.22 * Math.sin(azimuth * 2.3 + seed) + 0.16 * Math.sin(polar * 3.1 + azimuth * 1.7 + seed * 1.7);
    const reach = radius * lump;
    const ringY = Math.cos(polar);
    const ringR = Math.sin(polar);
    tint.copy(spec.shade).lerp(spec.lit, clamp01(spec.exposure * (0.28 + 0.72 * (ringY * 0.5 + 0.5))));
    return vertex(
      m,
      centre.x + Math.cos(azimuth) * ringR * reach,
      centre.y + ringY * reach * spec.flatten,
      centre.z + Math.sin(azimuth) * ringR * reach,
      tint
    );
  };

  const top = put(0, 0);
  const rings: number[] = [];
  for (let b = 1; b <= bands; b += 1) {
    const polar = (b / (bands + 1)) * Math.PI;
    const first = m.position.length / 3;
    for (let s = 0; s < meridians; s += 1) put(polar, (s / meridians) * TAU);
    rings.push(first);
  }
  const bottom = put(Math.PI, 0);

  for (let s = 0; s < meridians; s += 1) {
    const next = (s + 1) % meridians;
    m.index.push(top, rings[0] + next, rings[0] + s);
    for (let b = 0; b < bands - 1; b += 1) {
      const a = rings[b] + s;
      const beside = rings[b] + next;
      const under = rings[b + 1] + s;
      const diagonal = rings[b + 1] + next;
      m.index.push(a, diagonal, under, a, beside, diagonal);
    }
    m.index.push(bottom, rings[bands - 1] + s, rings[bands - 1] + next);
  }
};

const quadratic = (from: Vector3, control: Vector3, to: Vector3, t: number, into: Vector3): Vector3 => {
  const inverse = 1 - t;
  return into
    .copy(from)
    .multiplyScalar(inverse * inverse)
    .addScaledVector(control, 2 * t * inverse)
    .addScaledVector(to, t * t);
};

// --- palette ---------------------------------------------------------------

type Palette = {
  trunk: Color;
  trunkPale: Color;
  culm: Color;
  culmPale: Color;
  sheath: Color;
  canopy: Color;
  canopyLit: Color;
  canopyShade: Color;
  bambooLeaf: Color;
  bambooLeafRim: Color;
  bananaRib: Color;
  bananaLeaf: Color;
  frondStem: Color;
  frond: Color;
  frondRim: Color;
  bloom: Color;
  coconut: Color;
};

/**
 * The far forest wears the CC0 kit's own baked palette, which is darker and
 * greyer than any real leaf — distance desaturates, and the cone field is all
 * distance. A near tree has to be the brighter end of the same hue family or it
 * reads as a different species of green entirely, so every colour here is pulled
 * part of the way toward the location's own foliage tone and no further.
 */
const paletteFor = (recipe: LocationRecipe): Palette => {
  const ground = new Color(recipe.ground.foliage);
  const green = (hex: string) => new Color(hex).lerp(ground, 0.34);
  const wood = (hex: string) => new Color(hex).lerp(ground, 0.12);

  return {
    trunk: wood('#564737'),
    trunkPale: wood('#7f7260'),
    culm: green('#95a055'),
    culmPale: green('#bcc07c'),
    sheath: green('#6f7f49'),
    canopy: green('#3f6b33'),
    canopyLit: green('#78a648'),
    canopyShade: green('#1e3a21'),
    bambooLeaf: green('#5f8d3b'),
    bambooLeafRim: green('#8aae54'),
    bananaRib: green('#a5b663'),
    bananaLeaf: green('#487c32'),
    frondStem: wood('#7a7159'),
    frond: green('#4f7b3f'),
    frondRim: green('#82a04c'),
    bloom: new Color('#6d2435'),
    coconut: wood('#6f5a3a'),
  };
};

// --- species ---------------------------------------------------------------

/** What a built plant tells the module about itself, in metres. */
type Shape = { bark: BufferGeometry; leaf: BufferGeometry; height: number; crown: number };

type Built = { height: number; crown: number };

/**
 * Tre. The one plant the existing kit has nothing like, and the one that says
 * Vietnam fastest. A clump, never a single stem: culms share a rhizome, lean out
 * of it, and arch over under the weight of their own leaves.
 */
const buildBamboo = (random: Prng, palette: Palette, carve: Carve): Built => {
  const culms = 7 + Math.floor(random() * 3);
  const clumpRadius = 0.5 + random() * 0.55;
  let tallest = 0;

  for (let c = 0; c < culms; c += 1) {
    const azimuth = (c / culms) * TAU + random() * 0.7;
    const foot = clumpRadius * Math.sqrt(random());
    const height = 9 + random() * 7;
    const baseRadius = 0.034 + random() * 0.018;
    const bow = height * (0.1 + random() * 0.14);
    const internode = 0.3 + random() * 0.14;
    tallest = Math.max(tallest, height);

    const reachAt = (y: number) => foot + bow * Math.min(1, y / height) ** 2.3;
    const path: Node[] = [];
    const pushRing = (y: number, collar: boolean) => {
      const t = Math.min(1, y / height);
      const reach = reachAt(y);
      path.push({
        at: new Vector3(Math.cos(azimuth) * reach, y, Math.sin(azimuth) * reach),
        radius: baseRadius * (1 - t * 0.5) * (collar ? 1.17 : 1),
        tint: palette.culm.clone().lerp(palette.culmPale, 0.15 + t * 0.55),
      });
    };

    // Nodes are modelled only where someone standing under the clump can
    // resolve them. Above three metres an internode is 40 cm of a line against
    // the sky and the collar costs a ring each, which is 30 rings a culm.
    const detailed = Math.min(height, 3.2);
    for (let y = 0; y < detailed; y += internode) {
      pushRing(y, true);
      pushRing(y + internode * 0.45, false);
    }
    const smooth = 9;
    for (let i = 1; i <= smooth; i += 1) pushRing(detailed + ((height - detailed) * i) / smooth, false);
    tube(carve.bark, path, { sides: 5 });

    // Leaves only on the upper half, which is where a culm has shed its sheaths.
    const nodes = 6;
    for (let n = 0; n < nodes; n += 1) {
      const y = height * (0.5 + (n / nodes) * 0.48);
      const at = new Vector3(Math.cos(azimuth) * reachAt(y), y, Math.sin(azimuth) * reachAt(y));
      const leaves = 5 + Math.floor(random() * 2);
      for (let l = 0; l < leaves; l += 1) {
        const spray = random() * TAU;
        const pitch = -0.2 - random() * 0.85;
        const out = new Vector3(Math.cos(spray), 0, Math.sin(spray));
        const along = new Vector3(out.x * Math.cos(pitch), Math.sin(pitch), out.z * Math.cos(pitch)).normalize();
        const across = new Vector3(-out.z, 0, out.x);
        const down = new Vector3().crossVectors(along, across).normalize();
        // One blade stands for a leafy branchlet rather than a single leaf: a
        // real 16 cm bamboo leaf is under a pixel at twenty metres, and the
        // feathery mass is what has to read, not the individual leaf.
        const length = 0.38 + random() * 0.2;
        blade(carve.leaf, {
          from: at,
          along,
          across,
          down,
          length,
          segments: 2,
          half: (t) => length * 0.1 * Math.sin(Math.PI * t ** 0.65),
          drop: (t) => length * 0.3 * t ** 1.8,
          fold: 0.3,
          columns: WHOLE_BLADE,
          tint: palette.bambooLeaf,
          rim: palette.bambooLeafRim,
        });
      }
    }
  }

  return { height: tallest, crown: clumpRadius + tallest * 0.1 };
};

/**
 * Chuối. A banana has no trunk — it has the rolled-up bases of its own old
 * leaves — and it is never on its own, so this is a stool with its suckers.
 */
const buildBanana = (random: Prng, palette: Palette, carve: Carve): Built => {
  const stools: { offset: Vector3; size: number }[] = [{ offset: new Vector3(), size: 1 }];
  const suckers = random() < 0.6 ? 2 : 1;
  for (let s = 0; s < suckers; s += 1) {
    const azimuth = random() * TAU;
    const reach = 0.55 + random() * 0.5;
    stools.push({
      offset: new Vector3(Math.cos(azimuth) * reach, 0, Math.sin(azimuth) * reach),
      size: 0.3 + random() * 0.3,
    });
  }

  let tallest = 0;
  let widest = 0;

  for (const stool of stools) {
    const stem = (2.4 + random() * 1) * stool.size;
    const radius = (0.16 + random() * 0.04) * stool.size;
    tallest = Math.max(tallest, stem * 1.5);

    // Three nested sheaths rather than one cylinder. The step where one ends is
    // the only thing that distinguishes a pseudostem from a length of pipe.
    for (let layer = 0; layer < 3; layer += 1) {
      const top = stem * (0.62 + layer * 0.19);
      const rings = 4;
      const path: Node[] = [];
      for (let i = 0; i < rings; i += 1) {
        const t = i / (rings - 1);
        path.push({
          at: new Vector3(stool.offset.x, top * t, stool.offset.z),
          radius: radius * (1 - layer * 0.1) * (1 - t * 0.24),
          tint: palette.sheath.clone().lerp(palette.bananaRib, 0.1 + t * 0.35),
        });
      }
      tube(carve.bark, path, {
        sides: 9,
        streak: (_, angle) => 1 + Math.sin(angle * 4 + layer * 2.1) * 0.08,
      });
    }

    const leaves = 6 + Math.floor(random() * 4);
    for (let l = 0; l < leaves; l += 1) {
      const azimuth = (l / leaves) * TAU + random() * 0.5;
      const age = l / leaves;
      const pitch = 1 - age * 1.3;
      const out = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
      const along = new Vector3(out.x * Math.cos(pitch), Math.sin(pitch), out.z * Math.cos(pitch)).normalize();
      const across = new Vector3(-out.z, 0, out.x);
      const down = new Vector3().crossVectors(along, across).normalize();
      const from = new Vector3(stool.offset.x, stem * (0.84 + (1 - age) * 0.14), stool.offset.z);

      const length = (1.8 + random() * 0.9) * stool.size;
      const petiole: Node[] = [];
      for (let i = 0; i < 4; i += 1) {
        const t = i / 3;
        petiole.push({
          at: from.clone().addScaledVector(along, length * 0.24 * t),
          radius: (0.04 - t * 0.014) * stool.size,
          tint: palette.bananaRib,
        });
      }
      tube(carve.leaf, petiole, { sides: 4 });

      // Wind shreds a banana leaf into ribbons within weeks of it opening, and
      // an unbroken one reads as plastic. Every third leaf is already torn.
      const torn = l % 3 === 1;
      blade(carve.leaf, {
        from: petiole[3].at,
        along,
        across,
        down,
        length: length * 0.8,
        segments: 7,
        half: (t) => length * 0.15 * Math.min(1, t * 3.2) * (1 - t ** 6),
        drop: (t) => length * 0.36 * t * t,
        fold: 0.34,
        columns: torn ? TORN_BLADE : WHOLE_BLADE,
        gaps: torn ? TORN_GAPS : undefined,
        tint: palette.bananaRib,
        rim: palette.bananaLeaf,
      });
      widest = Math.max(widest, stool.offset.length() + length * 0.9);
    }

    if (stool.size === 1 && random() < 0.45) {
      const azimuth = random() * TAU;
      const out = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
      const crown = new Vector3(stool.offset.x, stem * 0.95, stool.offset.z);
      const tip = crown
        .clone()
        .addScaledVector(out, 0.5)
        .setY(stem * 0.42);
      const control = crown.clone().addScaledVector(out, 0.2).addScaledVector(UP, 0.42);
      const stalk: Node[] = [];
      const scratch = new Vector3();
      for (let i = 0; i < 6; i += 1) {
        const t = i / 5;
        stalk.push({
          at: quadratic(crown, control, tip, t, scratch).clone(),
          radius: 0.05 - t * 0.012,
          tint: palette.sheath,
        });
      }
      tube(carve.bark, stalk, { sides: 5 });

      // Hands of fruit down the stalk, then the bract still hanging off the end.
      for (let hand = 0; hand < 4; hand += 1) {
        const t = 0.42 + hand * 0.14;
        blob(carve.leaf, {
          centre: quadratic(crown, control, tip, t, scratch).clone(),
          radius: 0.2 - hand * 0.016,
          flatten: 0.6,
          meridians: 6,
          bands: 3,
          seed: hand * 2.3,
          shade: palette.sheath,
          lit: palette.bananaRib,
          exposure: 0.8,
        });
      }
      const bractAcross = new Vector3(-out.z, 0, out.x);
      blade(carve.leaf, {
        from: tip,
        along: new Vector3(out.x * 0.3, -1, out.z * 0.3).normalize(),
        across: bractAcross,
        down: out.clone(),
        length: 0.42,
        segments: 2,
        half: (t) => 0.1 * Math.sin(Math.PI * (0.25 + t * 0.6)),
        drop: () => 0,
        fold: 0.5,
        columns: WHOLE_BLADE,
        tint: palette.bloom,
        rim: palette.bloom,
      });
    }
  }

  return { height: tallest, crown: Math.max(1, widest) };
};

/**
 * Dừa. A coconut leans, its base is swollen into a bole, its trunk is ringed
 * with the scars of every frond it has dropped, and the crown is pinnate — a
 * ring of feathers, not a ball of leaves.
 */
const buildPalm = (random: Prng, palette: Palette, carve: Carve): Built => {
  const height = 11 + random() * 6.5;
  const leanAzimuth = random() * TAU;
  const lean = height * (0.05 + random() * 0.08);
  const radius = 0.15 + random() * 0.05;

  const scarSpacing = 0.3;
  const scarred = Math.min(height * 0.3, 3.6);
  const path: Node[] = [];
  const pushRing = (y: number, scar: boolean) => {
    const t = Math.min(1, y / height);
    const reach = lean * t ** 1.5;
    path.push({
      at: new Vector3(Math.cos(leanAzimuth) * reach, y, Math.sin(leanAzimuth) * reach),
      radius: radius * (1 - t * 0.2) * (scar ? 1.07 : 1),
      tint: palette.trunk.clone().lerp(palette.trunkPale, 0.2 + t * 0.4),
    });
  };
  for (let y = 0; y < scarred; y += scarSpacing) {
    pushRing(y, true);
    pushRing(y + scarSpacing * 0.5, false);
  }
  const smooth = 12;
  for (let i = 1; i <= smooth; i += 1) pushRing(scarred + ((height - scarred) * i) / smooth, false);

  tube(carve.bark, path, {
    sides: 7,
    // The bole: a coconut's lowest metre is swollen into a drum sitting on its
    // own root mat, and a trunk that just stops at the ground looks planted.
    swell: (ring) => {
      const y = path[ring].at.y;
      return y > 1.1 ? 1 : 1 + (1 - y / 1.1) ** 1.6 * 1.5;
    },
    streak: (_, angle) => 1 + Math.sin(angle * 5 + 0.7) * 0.07,
  });

  const crownAt = path[path.length - 1].at;
  const fronds = 13 + Math.floor(random() * 4);
  let widest = 0;

  for (let f = 0; f < fronds; f += 1) {
    const azimuth = (f / fronds) * TAU + random() * 0.3;
    const age = f / fronds;
    const pitch = 0.95 - age * 1.9;
    const length = 4 + random() * 1.4;
    const out = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
    const along = new Vector3(out.x * Math.cos(pitch), Math.sin(pitch), out.z * Math.cos(pitch)).normalize();
    const across = new Vector3(-out.z, 0, out.x);
    const down = new Vector3().crossVectors(along, across).normalize();
    widest = Math.max(widest, length * 0.85);

    const rings = 8;
    const rachis: Node[] = [];
    for (let i = 0; i < rings; i += 1) {
      const t = i / (rings - 1);
      rachis.push({
        at: crownAt
          .clone()
          .addScaledVector(along, length * t)
          .addScaledVector(down, length * 0.42 * t * t),
        radius: 0.05 * (1 - t * 0.82),
        tint: palette.frondStem,
      });
    }
    // The rachis belongs to the crown, not the trunk, so it goes in the leaf
    // mould and bends with the fronds instead of standing still inside them.
    tube(carve.leaf, rachis, { sides: 3 });

    const leaflets = 11;
    for (let i = 0; i < leaflets; i += 1) {
      const t = 0.14 + (i / leaflets) * 0.82;
      const seat = quadraticFrond(crownAt, along, down, length, t);
      const taper = Math.sin(Math.PI * t ** 0.7);
      for (const side of [-1, 1]) {
        const fan = new Vector3()
          .copy(across)
          .multiplyScalar(side * 0.72)
          .addScaledVector(along, 0.5)
          .addScaledVector(down, 0.48)
          .normalize();
        const leafAcross = new Vector3().crossVectors(fan, down).normalize();
        const leafDown = new Vector3().crossVectors(fan, leafAcross).normalize();
        const span = (0.55 + taper * 0.55) * (1 - age * 0.12);
        blade(carve.leaf, {
          from: seat,
          along: fan,
          across: leafAcross,
          down: leafDown,
          length: span,
          segments: 1,
          half: (u) => span * 0.075 * (1 - u * 0.85),
          drop: (u) => span * 0.3 * u * u,
          fold: 0.3,
          columns: WHOLE_BLADE,
          tint: palette.frond,
          rim: palette.frondRim,
        });
      }
    }
  }

  const nuts = 4 + Math.floor(random() * 4);
  for (let n = 0; n < nuts; n += 1) {
    const azimuth = random() * TAU;
    const reach = 0.3 + random() * 0.28;
    blob(carve.bark, {
      centre: crownAt
        .clone()
        .add(new Vector3(Math.cos(azimuth) * reach, -0.2 - random() * 0.3, Math.sin(azimuth) * reach)),
      radius: 0.15,
      flatten: 1.2,
      meridians: 6,
      bands: 3,
      seed: n * 1.7,
      shade: palette.coconut,
      lit: palette.culmPale,
      exposure: 0.7,
    });
  }

  return { height: height + 1.5, crown: widest };
};

/** A point on a frond's arching rachis, so leaflets sit on the curve the tube drew. */
const quadraticFrond = (from: Vector3, along: Vector3, down: Vector3, length: number, t: number): Vector3 =>
  from
    .clone()
    .addScaledVector(along, length * t)
    .addScaledVector(down, length * 0.42 * t * t);

/**
 * Cây đa, or whatever the big tree at the edge of a village happens to be. The
 * silhouette is the whole thing at twenty metres, so the branching is built
 * first — tips are placed on a parasol envelope and the limbs are then grown out
 * to reach them, which guarantees the crown shape instead of hoping for it.
 */
const buildShade = (random: Prng, palette: Palette, carve: Carve): Built => {
  const height = 15 + random() * 6;
  const spread = height * (0.78 + random() * 0.26);
  const forkAt = height * (0.26 + random() * 0.1);
  const trunkRadius = 0.36 + random() * 0.16;
  const roots = 4 + Math.floor(random() * 3);
  // Three vertices a lobe, with the lobes phased onto vertices, or a buttress
  // gets sampled on its flank and comes out as a bulge instead of a spur.
  const trunkSides = roots * 3;
  const rootPhase = (Math.floor(random() * trunkSides) / trunkSides) * TAU;
  const tips = 18;
  const limbs = 4;

  const leanAzimuth = random() * TAU;
  const lean = height * (0.03 + random() * 0.05);
  const bendPhase = 0.45 + random() * 0.35;

  const trunkRings = 11;
  const trunkPath: Node[] = [];
  for (let i = 0; i < trunkRings; i += 1) {
    const t = i / (trunkRings - 1);
    // It leans one way low down and straightens as it rises, which is what a
    // trunk that grew toward a gap in the canopy actually did.
    const bend = Math.sin(t * Math.PI * bendPhase) * lean;
    trunkPath.push({
      at: new Vector3(Math.cos(leanAzimuth) * bend, forkAt * t, Math.sin(leanAzimuth) * bend),
      radius: trunkRadius * (1 - t * 0.28),
      tint: palette.trunk.clone().lerp(palette.trunkPale, 0.1 + t * 0.3),
    });
  }

  const barkStreak = (ring: number, angle: number) =>
    1 + (Math.sin(angle * 7 + ring * 0.7) * 0.5 + Math.sin(angle * 13 + 1.3) * 0.5) * 0.11;

  tube(carve.bark, trunkPath, {
    sides: trunkSides,
    // Buttresses, not a cone: the trunk only widens where a root leaves it, so
    // the radius has to be modulated by angle as well as by height.
    swell: (ring, angle) => {
      const y = trunkPath[ring].at.y;
      if (y > 1.8) return 1;
      return 1 + (1 - y / 1.8) ** 1.7 * 0.95 * Math.max(0, Math.cos(roots * (angle - rootPhase))) ** 1.4;
    },
    streak: barkStreak,
  });

  const crownBottom = forkAt + height * 0.1;
  const crownTop = height;
  const crownReach = spread * 0.5;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const tipAt: Vector3[] = [];
  for (let k = 0; k < tips; k += 1) {
    const reach = Math.sqrt((k + 0.5) / tips) * crownReach;
    const azimuth = k * golden + random() * 0.4;
    // A parasol: widest low, doming to a point, so how high a tip sits falls off
    // with how far out it reaches.
    const fall = (reach / crownReach) ** 1.5 * (0.85 + random() * 0.3);
    tipAt.push(
      new Vector3(
        Math.cos(azimuth) * reach,
        Math.max(crownBottom * 0.92, crownTop - (crownTop - crownBottom) * fall),
        Math.sin(azimuth) * reach
      )
    );
  }

  // Da Vinci's rule, run forwards from the trunk: a parent's cross-section is
  // the sum of its children's, which is what makes the limbs thin plausibly
  // instead of by a factor someone picked.
  const taperExponent = 2.3;
  const trunkTop = trunkRadius * 0.72;
  const tipRadius = trunkTop / tips ** (1 / taperExponent);
  const radiusFor = (count: number) => tipRadius * count ** (1 / taperExponent);

  const scratch = new Vector3();
  const limb = (from: Vector3, fromRadius: number, to: Vector3, toRadius: number, depth: number) => {
    const rings = 7 - depth;
    const sides = Math.max(4, 6 - depth);
    const span = from.distanceTo(to);
    // A limb leaves the trunk steeply and flattens as it reaches out. That arch
    // is what makes a crown look carried rather than glued on top.
    const control = from
      .clone()
      .lerp(to, 0.45)
      .addScaledVector(UP, span * (0.26 - depth * 0.07));
    const path: Node[] = [];
    for (let i = 0; i < rings; i += 1) {
      const t = i / (rings - 1);
      path.push({
        at: quadratic(from, control, to, t, scratch).clone(),
        radius: fromRadius + (toRadius - fromRadius) * t,
        tint: palette.trunk.clone().lerp(palette.trunkPale, 0.22 + depth * 0.1),
      });
    }
    tube(carve.bark, path, { sides, streak: barkStreak });
  };

  // Tips sorted by bearing, then split into contiguous arcs: an arc of sky is
  // what one limb of a real tree owns, and clustering by it is why the limbs do
  // not cross each other.
  const ordered = tipAt.slice().sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x));

  const grow = (from: Vector3, fromRadius: number, members: Vector3[], depth: number) => {
    const forks = depth === 0 ? Math.min(limbs, members.length) : Math.min(members.length, random() < 0.35 ? 3 : 2);
    if (members.length <= 1 || depth >= 3 || forks <= 1) {
      for (const target of members) limb(from, fromRadius, target, tipRadius, depth);
      return;
    }

    let cursor = 0;
    for (let f = 0; f < forks; f += 1) {
      const take = Math.round(((f + 1) * members.length) / forks) - cursor;
      if (take <= 0) continue;
      const run = members.slice(cursor, cursor + take);
      cursor += take;
      const radius = radiusFor(run.length);
      if (run.length === 1) {
        limb(from, fromRadius, run[0], tipRadius, depth);
        continue;
      }
      const centre = new Vector3();
      for (const at of run) centre.add(at);
      centre.multiplyScalar(1 / run.length);
      const node = from.clone().lerp(centre, depth === 0 ? 0.6 : 0.62);
      limb(from, fromRadius, node, radius, depth);
      grow(node, radius, run, depth + 1);
    }
  };
  grow(trunkPath[trunkRings - 1].at, trunkTop, ordered, 0);

  const crownCentre = new Vector3(0, (crownBottom + crownTop) / 2, 0);
  for (const at of tipAt) {
    const clump = spread * (0.085 + random() * 0.045);
    const exposure = clamp01(0.42 + (at.distanceTo(crownCentre) / crownReach) * 0.58);
    blob(carve.leaf, {
      centre: at,
      radius: clump,
      flatten: 0.74,
      meridians: 8,
      bands: 4,
      seed: at.x * 0.7 + at.z * 1.3,
      shade: palette.canopyShade,
      lit: palette.canopyLit,
      exposure,
    });

    // Cards poking out of the lump. A clump with a smooth outline is a bush
    // whatever colour it is; the ragged edge is what reads as leaves.
    const across = new Vector3();
    const down = new Vector3();
    for (let e = 0; e < 8; e += 1) {
      const polar = 0.3 + random() * 2.2;
      const azimuth = random() * TAU;
      const outward = new Vector3(
        Math.cos(azimuth) * Math.sin(polar),
        Math.cos(polar) * 0.74,
        Math.sin(azimuth) * Math.sin(polar)
      ).normalize();
      perpendicular(outward, across);
      down.crossVectors(outward, across).normalize();
      const span = clump * 0.62;
      blade(carve.leaf, {
        from: at.clone().addScaledVector(outward, clump * 0.74),
        along: outward,
        across,
        down,
        length: span,
        segments: 1,
        half: (t) => span * 0.26 * (1 - t),
        drop: (t) => span * 0.2 * t * t,
        fold: 0.2,
        columns: WHOLE_BLADE,
        tint: palette.canopy,
        rim: palette.canopyLit,
      });
    }
  }

  return { height, crown: crownReach };
};

type SpeciesName = 'bamboo' | 'banana' | 'palm' | 'shade';

type SwayConfig = { amplitude: number; height: number; stiffness: number };

type SpeciesSpec = {
  build: (random: Prng, palette: Palette, carve: Carve) => Built;
  /**
   * Amplitude and ramp height in metres, which is also the geometry's own unit,
   * so a slot scaled down sways proportionally. The bark and leaf ramps have to
   * agree where the canopy meets the wood or the foliage slides off its
   * branches; only the shade tree's crown spans enough height to need its own.
   */
  bark: SwayConfig;
  leaf: SwayConfig;
  /** Metres of ground the plant needs to itself, far trees included. */
  clearance: number;
  maxSlope: number;
  /** Metres above the water line it has to stand. */
  minAboveWater: number;
  /** Fraction of the location's tree line above which it does not grow. */
  ceiling: number;
};

const SPECIES: Record<SpeciesName, SpeciesSpec> = {
  bamboo: {
    build: buildBamboo,
    bark: { amplitude: 1.5, height: 13, stiffness: 1.5 },
    leaf: { amplitude: 1.5, height: 13, stiffness: 1.5 },
    clearance: 7,
    maxSlope: 1,
    minAboveWater: 0.8,
    ceiling: 1,
  },
  banana: {
    build: buildBanana,
    bark: { amplitude: 0.35, height: 2.8, stiffness: 1.4 },
    leaf: { amplitude: 0.35, height: 2.8, stiffness: 1.4 },
    clearance: 5,
    maxSlope: 0.55,
    minAboveWater: 1.2,
    ceiling: 0.5,
  },
  palm: {
    build: buildPalm,
    bark: { amplitude: 0.6, height: 15, stiffness: 2.6 },
    leaf: { amplitude: 0.6, height: 15, stiffness: 2.6 },
    clearance: 7,
    maxSlope: 0.5,
    minAboveWater: 1.5,
    ceiling: 0.35,
  },
  shade: {
    build: buildShade,
    bark: { amplitude: 0.45, height: 18, stiffness: 3.4 },
    leaf: { amplitude: 0.6, height: 13, stiffness: 1.6 },
    clearance: 10,
    maxSlope: 0.8,
    minAboveWater: 2,
    ceiling: 0.9,
  },
};

/**
 * What a place actually grows. The cone field is one silhouette everywhere; what
 * tells you you are standing in Hội An rather than on a ridge in Sơn La is a
 * coconut crown against the sky instead of a bamboo thicket. The coconut gate is
 * latitude rather than terrain profile because that is what decides it on the
 * ground: groves stop around the Hải Vân pass, and Hanoi has none.
 */
const speciesFor = (recipe: LocationRecipe): { name: SpeciesName; weight: number }[] => {
  if (recipe.coords.elevation > 900) {
    return [
      { name: 'bamboo', weight: 0.46 },
      { name: 'shade', weight: 0.39 },
      { name: 'banana', weight: 0.15 },
    ];
  }
  if (recipe.coords.lat < 17 && recipe.water !== null) {
    return [
      { name: 'palm', weight: 0.31 },
      { name: 'bamboo', weight: 0.25 },
      { name: 'banana', weight: 0.25 },
      { name: 'shade', weight: 0.19 },
    ];
  }
  if (recipe.terrain.profile === 'karst') {
    return [
      { name: 'bamboo', weight: 0.42 },
      { name: 'shade', weight: 0.3 },
      { name: 'banana', weight: 0.28 },
    ];
  }
  return [
    { name: 'shade', weight: 0.38 },
    { name: 'banana', weight: 0.32 },
    { name: 'bamboo', weight: 0.3 },
  ];
};

/** Largest remainder, so the weights are honoured exactly at any total. */
const allocate = (total: number, weights: number[]): number[] => {
  const sum = weights.reduce((carry, weight) => carry + weight, 0);
  if (sum <= 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (total * weight) / sum);
  const given = exact.map((value) => Math.floor(value));
  let left = total - given.reduce((carry, value) => carry + value, 0);

  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; left > 0; i += 1, left -= 1) given[order[i % order.length].index] += 1;

  return given;
};

// --- lattice ---------------------------------------------------------------

/**
 * Integer hash of a lattice cell. `hashSeed` takes a string and building one per
 * cell per relayout is exactly the allocation this has to avoid.
 */
const hashCell = (x: number, z: number, salt: number): number => {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(z, 0x85ebca6b) ^ salt;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return (h ^ (h >>> 16)) >>> 0;
};

/** One of several independent draws in [0,1) out of a single cell hash. */
const draw = (hash: number, index: number): number => {
  const mixed = Math.imul(hash ^ Math.imul(index + 1, 0x9e3779b9), 0x85ebca6b);
  return ((mixed ^ (mixed >>> 15)) >>> 0) / 4294967296;
};

type Site = {
  x: number;
  y: number;
  z: number;
  distance: number;
  rotation: number;
  scale: number;
  squash: number;
};

type Slot = {
  group: Group;
  standing: boolean;
  scale: number;
  squash: number;
  crown: Obstacle;
};

type Pool = {
  shape: Shape;
  slots: Slot[];
  /** Site indices chosen this pass, nearest first. */
  picked: Int32Array;
  found: number;
};

export type NearTrees = {
  group: Group;
  /**
   * Crowns of the trees currently standing, for keeping the camera and the
   * walker out of them. Rewritten in place every `update`, so read it, do not
   * hold on to the entries.
   */
  crowns: Obstacle[];
  follow: (x: number, z: number) => void;
  update: (elapsed: number) => void;
  dispose: () => void;
};

export type NearTreeOptions = {
  /**
   * True when something already stands on this ground — the far cone field's own
   * crowns, a building, a road. Without it a built tree and a cone end up in the
   * same spot, which is worse than either alone.
   */
  occupied?: (x: number, z: number, radius: number) => boolean;
  /**
   * Ground the rest of the world has already taken: roads, the railway, the
   * town, terraces. `occupied` above answers for things the scene puts down
   * itself; this answers for ground that was never free to begin with.
   *
   * It matters more here than anywhere else in the scene. These are the trees
   * you stand next to — a hand-built banana growing out of a carriageway three
   * metres from the camera is the photograph the user takes, where a cone a
   * kilometre away in the same place is a blemish.
   */
  claims?: GroundClaims | null;
  /**
   * Whether the trees cast. The module sets `castShadow` per mesh rather than
   * leaving it to a `traverse`, because the trunk and the canopy want different
   * answers for receiving.
   */
  shadows?: boolean;
};

/**
 * The near half of the forest. The far field is twelve thousand cones, which is
 * right for a horizon and wrong for the twenty metres in front of you, so a
 * small number of properly built plants stand where the player can actually see
 * them: a trunk that tapers and flares into roots, branches that fork and thin,
 * canopies with their own shading baked in, and wind through the shared field.
 *
 * Sites come off a deterministic jittered lattice rather than a list, so a tree
 * is a property of the ground it stands on: walk away and come back and it is
 * the same tree, the same size, facing the same way.
 */
export const createNearTrees = (
  terrain: Terrain,
  recipe: LocationRecipe,
  count: number,
  wind: Wind,
  options: NearTreeOptions = {}
): NearTrees => {
  const group = new Group();
  group.name = 'tree-near';
  const crowns: Obstacle[] = [];
  // Both shapes of absence collapsed once, here, rather than tested per site:
  // no claims means nothing is claimed, never an error.
  const ground: GroundClaims | null = options.claims ?? null;

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const pools: Pool[] = [];
  /**
   * One entry per species that actually won slots, holding its spec, its pools
   * and its share of the cumulative weight together.
   *
   * These were three arrays indexed by the same integer, with the specs rebuilt
   * afterwards as `speciesFor(recipe).filter((_, i) => i < poolsBySpecies.length)`
   * — taking a prefix of the list to stand for the species that won slots. That
   * is correct only while the ones that lose are a suffix, which holds today for
   * a reason written down nowhere: `speciesFor` happens to list weights in
   * descending order at all four locations, and `allocate` is largest-remainder,
   * so the species that floor to zero are exactly the smallest and therefore the
   * last. Reorder one of those lists, or add a species out of order, and the
   * prefix stops meaning what it meant: every site then reads another species'
   * clearance, slope limit and tree line, and puts a plausible tree in the wrong
   * place rather than throwing. Pairing them at the point they are built owes
   * nothing to the order.
   */
  const chosen: { spec: SpeciesSpec; pools: Pool[]; upto: number }[] = [];

  if (count > 0) {
    const palette = paletteFor(recipe);
    const random = createPrng(`${recipe.seed}:tree-near`);
    const wanted = speciesFor(recipe);
    const given = allocate(
      count,
      wanted.map((entry) => entry.weight)
    );
    const shadows = options.shadows ?? true;

    let running = 0;
    wanted.forEach((entry, index) => {
      const slots = given[index];
      if (slots <= 0) return;

      const spec = SPECIES[entry.name];
      const bark = new MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        roughness: 0.92,
        metalness: 0,
      });
      const leaf = new MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        roughness: 0.74,
        metalness: 0,
        side: DoubleSide,
      });
      // Three's own depth material knows nothing about the wind, so without a
      // custom one a tree sways and its shadow stands still — which at twenty
      // metres, with the shadow on open ground, is the first thing you notice.
      const barkDepth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
      const leafDepth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, side: DoubleSide });
      materials.push(bark, leaf, barkDepth, leafDepth);

      for (const material of [bark, barkDepth]) applyWindSway(material, wind, spec.bark);
      for (const material of [leaf, leafDepth]) applyWindSway(material, wind, spec.leaf);

      // Two shapes per species where the budget allows it. Which one a site gets
      // is the site's own business, so a tree never changes shape under you.
      const variants = Math.min(2, slots);
      const perVariant = allocate(slots, new Array(variants).fill(1));
      const mine: Pool[] = [];

      for (let variant = 0; variant < variants; variant += 1) {
        const carve: Carve = { bark: mould(), leaf: mould() };
        const built = spec.build(random, palette, carve);
        const shape: Shape = {
          bark: finish(carve.bark, spec.bark.amplitude * 2),
          leaf: finish(carve.leaf, spec.leaf.amplitude * 2),
          height: built.height,
          crown: built.crown,
        };
        geometries.push(shape.bark, shape.leaf);

        const slotList: Slot[] = [];
        for (let i = 0; i < perVariant[variant]; i += 1) {
          const tree = new Group();
          tree.visible = false;

          const woody = new Mesh(shape.bark, bark);
          woody.castShadow = shadows;
          woody.receiveShadow = shadows;
          woody.customDepthMaterial = barkDepth;

          const canopy = new Mesh(shape.leaf, leaf);
          canopy.castShadow = shadows;
          // Flat-shaded foliage receiving its own shadow is all acne, and the
          // vertex-colour gradient already says where the light does not reach.
          canopy.receiveShadow = false;
          canopy.customDepthMaterial = leafDepth;

          tree.add(woody, canopy);
          group.add(tree);
          slotList.push({
            group: tree,
            standing: false,
            scale: 1,
            squash: 1,
            crown: { x: 0, z: 0, radius: 0, bottom: 0, top: 0 },
          });
        }

        const pool: Pool = { shape, slots: slotList, picked: new Int32Array(Math.max(1, slotList.length)), found: 0 };
        pools.push(pool);
        mine.push(pool);
      }

      running += entry.weight;
      chosen.push({ spec, pools: mine, upto: running });
    });
    // Normalised over the species that got slots, so a tight budget thins the
    // field evenly instead of leaving the ground bare where a dropped species
    // would have stood.
    for (const entry of chosen) entry.upto /= running;
  }

  const salt = hashCell(recipe.seed.length, count, 0x5bf03635);
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const treeLine = recipe.scatter.treeLine;
  const edge = terrain.size / 2 - 12;

  const sites: Site[] = [];
  for (let i = 0; i < CELL_SPAN * CELL_SPAN; i += 1) {
    sites.push({ x: 0, y: 0, z: 0, distance: 0, rotation: 0, scale: 1, squash: 1 });
  }

  let viewerX = 0;
  let viewerZ = 0;
  let laidX = Infinity;
  let laidZ = Infinity;

  /** Insertion into a pool's nearest-first pick list. Allocation-free. */
  const consider = (pool: Pool, index: number, distance: number) => {
    const limit = pool.slots.length;
    let at = pool.found;
    if (at >= limit) {
      if (distance >= sites[pool.picked[limit - 1]].distance) return;
      at = limit - 1;
    } else {
      pool.found += 1;
    }
    while (at > 0 && sites[pool.picked[at - 1]].distance > distance) {
      pool.picked[at] = pool.picked[at - 1];
      at -= 1;
    }
    pool.picked[at] = index;
  };

  const relay = () => {
    // No species won a slot — `nearTrees: 0` on a weak machine, or a location
    // where nothing clears its height and slope test. An empty field is a
    // legitimate state, but the species pick below resolves to index -1 and
    // throws, so a tier that asked for no trees took the whole scene down.
    if (pools.length === 0 || chosen.length === 0) return;

    for (const pool of pools) pool.found = 0;
    let found = 0;

    const originX = Math.floor(viewerX / CELL);
    const originZ = Math.floor(viewerZ / CELL);

    for (let dx = -CELL_REACH; dx <= CELL_REACH; dx += 1) {
      for (let dz = -CELL_REACH; dz <= CELL_REACH; dz += 1) {
        const cellX = originX + dx;
        const cellZ = originZ + dz;
        const hash = hashCell(cellX, cellZ, salt);

        const x = (cellX + 0.5 + (draw(hash, 0) - 0.5) * JITTER) * CELL;
        const z = (cellZ + 0.5 + (draw(hash, 1) - 0.5) * JITTER) * CELL;
        const distance = Math.hypot(x - viewerX, z - viewerZ);
        if (distance > RADIUS) continue;
        if (Math.abs(x) > edge || Math.abs(z) > edge) continue;

        const pick = draw(hash, 2);
        let species = chosen.length - 1;
        for (let i = 0; i < chosen.length; i += 1) {
          if (pick < chosen[i].upto) {
            species = i;
            break;
          }
        }
        const choices = chosen[species].pools;
        const spec = chosen[species].spec;
        const pool = choices[Math.floor(draw(hash, 3) * choices.length) % choices.length];

        const y = terrain.heightAt(x, z);
        if (y < waterLevel + spec.minAboveWater || y > treeLine * spec.ceiling) continue;
        if (terrain.slopeAt(x, z) > spec.maxSlope) continue;
        // Thinned off the kerb rather than cut at it, and thinned by the cell's
        // own hash rather than a `random()`: `relay` runs again every nine metres
        // walked, so a draw off a shared stream would re-roll every tree on the
        // map each time the viewer moved. Off the hash, a site that is too close
        // to a road is the same site, absent, every time you come back to it.
        if (ground !== null && draw(hash, 7) < ground.pressureAt(x, z, spec.clearance, spec.clearance * 0.5)) continue;
        if (options.occupied?.(x, z, spec.clearance)) continue;

        const site = sites[found];
        site.x = x;
        site.y = y;
        site.z = z;
        site.distance = distance;
        site.rotation = draw(hash, 4) * TAU;
        site.scale = 0.84 + draw(hash, 5) * 0.34;
        site.squash = 0.93 + draw(hash, 6) * 0.15;
        consider(pool, found, distance);
        found += 1;
      }
    }

    for (const pool of pools) {
      for (let k = 0; k < pool.slots.length; k += 1) {
        const slot = pool.slots[k];
        if (k >= pool.found) {
          slot.standing = false;
          slot.group.visible = false;
          continue;
        }
        const site = sites[pool.picked[k]];
        slot.group.position.set(site.x, site.y, site.z);
        slot.group.rotation.y = site.rotation;
        slot.scale = site.scale;
        slot.squash = site.squash;
        slot.standing = true;
      }
    }
  };

  return {
    group,
    crowns,
    follow: (x, z) => {
      viewerX = x;
      viewerZ = z;
      if (Math.hypot(x - laidX, z - laidZ) < RESTEP) return;
      laidX = x;
      laidZ = z;
      relay();
    },
    update: () => {
      crowns.length = 0;
      for (const pool of pools) {
        for (const slot of pool.slots) {
          if (!slot.standing) continue;

          const at = slot.group.position;
          const distance = Math.hypot(at.x - viewerX, at.z - viewerZ);
          const fade = smoothstep(clamp01((RADIUS - distance) / FADE_BAND));
          if (fade <= 0.002) {
            slot.group.visible = false;
            continue;
          }

          slot.group.visible = true;
          const size = slot.scale * fade;
          slot.group.scale.set(size, size * slot.squash, size);

          const crown = slot.crown;
          crown.x = at.x;
          crown.z = at.z;
          crown.radius = pool.shape.crown * size;
          crown.bottom = at.y + pool.shape.height * 0.3 * size * slot.squash;
          crown.top = at.y + pool.shape.height * size * slot.squash;
          crowns.push(crown);
        }
      }
    },
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      group.clear();
    },
  };
};
