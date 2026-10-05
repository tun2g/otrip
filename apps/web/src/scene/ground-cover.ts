import type { LocationRecipe, Terrain } from '@otrip/world';
import { Color, Group, InstancedMesh, Matrix4, Quaternion, Vector3, type Material } from 'three';

import type { GroundClaims } from './ground-claims';
import type { NatureSources } from './model-loader';
import { applyWindSway, type Wind } from './wind';

const UP = new Vector3(0, 1, 0);
/** Zero scale: a blade the work queue has not laid out yet draws nothing. */
const HIDDEN = new Matrix4().scale(new Vector3(0, 0, 0));

/** How far from the viewer grass is drawn. Beyond this the terrain colour carries it. */
// Tighter radius, far more blades: density is what reads as grass, and a
// smaller disc spends the same budget on the ground you can actually see.
const RADIUS = 70;
const TILE = RADIUS * 2;
/** Metres the viewer may move before the field is laid out again. */
const RESTEP = 7;
/**
 * Frames a full relayout is spread over. Laying all fifty-two thousand blades in
 * one call cost 93 ms — a stutter every seven metres of walking. Spreading the
 * pass rather than fixing a slice count keeps the settle time the same at every
 * quality tier, and twenty-four frames is fewer than the thirty it takes to
 * cover RESTEP at the walker's top speed of 14 m/s, so the field never falls
 * behind however fast you move.
 */
const PASS_FRAMES = 24;

/**
 * Grass is allowed right up to the kerb — that is where it belongs, and a bare
 * apron round every road reads worse than grass on the asphalt did. So the
 * clearance is barely more than a blade's own width, and the thinning band is
 * short: one and a half metres of verge getting sparser, then nothing.
 */
const GRASS_CLEARANCE = 0.12;
const GRASS_FADE = 1.5;

/**
 * A stable value in [0, 1) per blade. The verge thinning has to be a property of
 * the blade, not of the moment: deciding it afresh each relayout would make the
 * verge crawl and shimmer every seven metres the viewer walks. An integer mix
 * rather than a stored field, because `homes` is three floats per blade and
 * widening it would cost 200 KB of nothing.
 */
const dither = (index: number): number => {
  const mixed = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b);
  return ((mixed ^ (mixed >>> 15)) >>> 8) / 0x1000000;
};

export type GroundCover = {
  group: Group;
  /** Re-lays the field around a point. Cheap enough to call as you walk. */
  follow: (x: number, z: number) => void;
  update: (elapsed: number) => void;
  dispose: () => void;
};

type Patch = {
  mesh: InstancedMesh;
  /** Fixed home offsets inside one tile; wrapping these is what makes the field endless. */
  homes: Float32Array;
  scale: number;
};

/**
 * `claims` is the ground already taken by roads, rail, buildings and terraces.
 * Declared rather than optional, so a caller with claims to give has to make a
 * decision about them instead of silently sowing grass down the carriageway —
 * but absent at runtime means "nothing is claimed", never an error.
 */
export const createGroundCover = (
  terrain: Terrain,
  recipe: LocationRecipe,
  sources: NatureSources,
  density: number,
  wind: Wind,
  claims: GroundClaims | null | undefined
): GroundCover => {
  const group = new Group();
  group.name = 'ground-cover';

  /**
   * Both shapes of absence collapsed to one, once, here at the boundary. The
   * first version of this tested `claims !== null` in the hot path, which is
   * true of `undefined`, so a caller that had not been given the new argument
   * yet did not sow as it always had — it threw on the first blade and took the
   * whole scene down with it. A keep-out system whose absence is fatal is worse
   * than no keep-out system.
   */
  const ground: GroundClaims | null = claims ?? null;

  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const treeLine = recipe.scatter.treeLine;
  // Grass reads lighter than the shadowed foliage of a tree canopy; tinting it
  // with the forest colours made a field of dark spikes.
  const foliage = new Color(recipe.ground.mid);
  const low = new Color(recipe.ground.low).lerp(new Color('#ffffff'), 0.18);

  const patches: Patch[] = [];

  // Heights in metres. The models arrive in their own units, so each is divided
  // by its own bounding height — the first version skipped that and produced
  // blades of grass the size of palm trees.
  const variants: { name: string; share: number; metres: number; sway: number }[] = [
    { name: 'Grass001', share: 0.5, metres: 0.55, sway: 0.09 },
    { name: 'Grass002', share: 0.3, metres: 0.42, sway: 0.08 },
    { name: 'Grass003', share: 0.2, metres: 0.75, sway: 0.07 },
  ];

  for (const variant of variants) {
    const source = sources.get(variant.name);
    if (!source) continue;

    const count = Math.max(1, Math.round(density * variant.share));
    const material = source.material.clone();
    // Amplitude and height are both in the model's own units, so the per-instance
    // scale carries through and a tall tuft bends further than a short one.
    applyWindSway(material, wind, { amplitude: variant.sway * source.height, height: source.height });

    const mesh = new InstancedMesh(source.geometry, material, count);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;

    // Home offsets inside the tile, plus a rotation, fixed for the life of the
    // scene so a blade keeps its identity as the field scrolls.
    const homes = new Float32Array(count * 3);
    const tint = new Color();
    for (let i = 0; i < count; i += 1) {
      homes[i * 3] = Math.random() * TILE;
      homes[i * 3 + 1] = Math.random() * Math.PI * 2;
      homes[i * 3 + 2] = Math.random() * TILE;
      tint.copy(low).lerp(foliage, 0.25 + Math.random() * 0.75);
      mesh.setColorAt(i, tint);
      // three fills the instance matrix with identities, so a blade that the
      // first pass has not reached yet would stand full size at the origin.
      mesh.setMatrixAt(i, HIDDEN);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    group.add(mesh);
    patches.push({ mesh, homes, scale: variant.metres / source.height });
  }

  const slice = Math.max(1, Math.ceil(patches.reduce((total, patch) => total + patch.mesh.count, 0) / PASS_FRAMES));

  const matrix = new Matrix4();
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();

  const half = terrain.size / 2;
  const step = terrain.size / terrain.segments;
  const side = terrain.segments + 1;
  const heights = terrain.heights;

  let sampledHeight = 0;
  let sampledSlope = 0;

  /**
   * Height and gradient straight off the height grid. `heightAt` plus `slopeAt`
   * is five bilinear samples — twenty array reads and a dozen lerps — for the
   * same two numbers, and fifty thousand blades of that is where the stutter
   * was. The gradient is the same central difference `slopeAt` takes, read at
   * the nearest node instead of interpolated: taking the cell's own corner
   * gradient was cheaper still and culled a third of the grass off every slope.
   */
  const probe = (x: number, z: number) => {
    const gx = Math.min(Math.max((x + half) / step, 0), terrain.segments);
    const gz = Math.min(Math.max((z + half) / step, 0), terrain.segments);
    const col = Math.floor(gx);
    const row = Math.floor(gz);
    const colNext = Math.min(col + 1, terrain.segments);
    const rowNext = Math.min(row + 1, terrain.segments);
    const fx = gx - col;
    const fz = gz - row;

    const h00 = heights[row * side + col];
    const h10 = heights[row * side + colNext];
    const h01 = heights[rowNext * side + col];
    const h11 = heights[rowNext * side + colNext];

    sampledHeight = (h00 + (h10 - h00) * fx) * (1 - fz) + (h01 + (h11 - h01) * fx) * fz;

    const nearCol = Math.round(gx);
    const nearRow = Math.round(gz);
    const colLow = Math.max(nearCol - 1, 0);
    const colHigh = Math.min(nearCol + 1, terrain.segments);
    const rowLow = Math.max(nearRow - 1, 0);
    const rowHigh = Math.min(nearRow + 1, terrain.segments);
    const dx = (heights[nearRow * side + colHigh] - heights[nearRow * side + colLow]) / ((colHigh - colLow) * step);
    const dz = (heights[rowHigh * side + nearCol] - heights[rowLow * side + nearCol]) / ((rowHigh - rowLow) * step);
    sampledSlope = Math.sqrt(dx * dx + dz * dz);
  };

  let lastX = Infinity;
  let lastZ = Infinity;
  let centreX = 0;
  let centreZ = 0;
  let patchCursor = 0;
  let instanceCursor = 0;
  let relaying = false;

  const lay = (patch: Patch, from: number, to: number) => {
    for (let i = from; i < to; i += 1) {
      const homeX = patch.homes[i * 3];
      const rotation = patch.homes[i * 3 + 1];
      const homeZ = patch.homes[i * 3 + 2];

      // Wrap the blade into the tile centred on the viewer.
      const x = homeX + Math.round((centreX - homeX) / TILE) * TILE;
      const z = homeZ + Math.round((centreZ - homeZ) / TILE) * TILE;

      probe(x, z);
      // The claim query is last in the chain on purpose: `||` short-circuits, so
      // it is only asked about blades that would otherwise be drawn — a fifth or
      // so of the field, rather than all fifty thousand.
      const outside =
        Math.abs(x) > half ||
        Math.abs(z) > half ||
        sampledHeight <= waterLevel + 0.4 ||
        sampledHeight > treeLine * 1.35 ||
        sampledSlope > 1.1 ||
        Math.hypot(x - centreX, z - centreZ) > RADIUS ||
        (ground !== null && dither(i) < ground.pressureAt(x, z, GRASS_CLEARANCE, GRASS_FADE));

      position.set(x, sampledHeight, z);
      quaternion.setFromAxisAngle(UP, rotation);
      // Hidden blades are scaled to nothing rather than removed, which keeps
      // the instance buffer a fixed size and the update allocation-free.
      scale.setScalar(outside ? 0 : patch.scale * (0.7 + ((i * 37) % 11) / 18));
      patch.mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    }

    // Only the slice just written goes up the bus. A full re-upload of three
    // patches is 3.3 MB, and it was landing in the same frame as the relayout.
    patch.mesh.instanceMatrix.addUpdateRange(from * 16, (to - from) * 16);
    patch.mesh.instanceMatrix.needsUpdate = true;
  };

  const follow = (x: number, z: number) => {
    if (relaying) {
      // Adopt the newer centre mid-pass. The viewer cannot have moved more than
      // a few metres since the pass began, which is nothing against a 70 m disc,
      // and restarting instead would mean a walking viewer never finishes one.
      centreX = x;
      centreZ = z;
      lastX = x;
      lastZ = z;
    } else {
      if (Math.hypot(x - lastX, z - lastZ) < RESTEP) return;
      centreX = x;
      centreZ = z;
      lastX = x;
      lastZ = z;
      patchCursor = 0;
      instanceCursor = 0;
      relaying = true;
    }

    let budget = slice;
    while (budget > 0 && patchCursor < patches.length) {
      const patch = patches[patchCursor];
      const to = Math.min(patch.mesh.count, instanceCursor + budget);
      if (to > instanceCursor) {
        lay(patch, instanceCursor, to);
        budget -= to - instanceCursor;
        instanceCursor = to;
      }
      if (instanceCursor >= patch.mesh.count) {
        patchCursor += 1;
        instanceCursor = 0;
      }
    }

    if (patchCursor >= patches.length) relaying = false;
  };

  return {
    group,
    follow,
    // Nothing to advance: the wind field owns the clock now.
    update: () => {},
    dispose: () => {
      for (const patch of patches) {
        (patch.mesh.material as Material).dispose();
        patch.mesh.dispose();
      }
    },
  };
};
