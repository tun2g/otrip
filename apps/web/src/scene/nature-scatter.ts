import { createPrng, scatterOnTerrain, type LocationRecipe, type Terrain } from '@otrip/world';
import { Color, Group, InstancedMesh, Matrix4, Quaternion, Vector3, type Material } from 'three';

import type { GroundClaims } from './ground-claims';
import type { NatureSources } from './model-loader';
import { applyWetLook } from './rain';
import { applyWindSway, type Wind } from './wind';

const UP = new Vector3(0, 1, 0);

type Placement = { x: number; y: number; z: number; scale: number; rotation: number };

type Kind = {
  /** Model names to pick between, round-robin. */
  models: string[];
  seed: string;
  count: number;
  /** Target height in metres, before per-instance variation. */
  metres: number;
  minHeight: number;
  maxHeight: number;
  /** Metres below maxHeight over which the band thins out. */
  fade?: number;
  /** Nothing is placed below this gradient. Only the steep-ground kinds set it. */
  minSlope?: number;
  maxSlope: number;
  /** Gradient below maxSlope over which density thins to nothing. */
  slopeFade?: number;
  /** Extra points to ask for, to pay for what the slope filter then rejects. */
  oversample?: number;
  /**
   * Grows in beds along a narrow height band rather than scattered over an area.
   * `clump` plants per bed, jittered up to `radius` metres from its centre.
   */
  band?: { clump: number; radius: number };
  /** Omitted for anything that should not move, such as rock. */
  sway?: { amplitude: number; stiffness: number };
  /**
   * Metres of claimed ground this plant needs clear of its own centre. A trunk
   * is thin and a canopy is not: what reads as a tree standing in the road is
   * the crown over the asphalt, so this is the crown's radius, not the stem's.
   */
  clearance: number;
  /**
   * Metres beyond the clearance over which density climbs back to full. A hard
   * circle at the clearance makes a crop circle round every kerb; a verge should
   * thin toward the edge the way the tree line thins toward its own limit.
   */
  claimFade: number;
  tint: string;
  variation: number;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Cells per side the band scan samples at, whatever the terrain's own resolution. */
const BAND_SCAN = 220;

/**
 * A shoreline is a contour, not an area. Rejection sampling the whole map for it
 * throws away ninety-nine samples in a hundred — the waterline band is 0.3% of
 * Tràng An and 1.4% of Hồ Tây, and asking `scatterOnTerrain` for 6300 reeds cost
 * half a second and still returned a third of them. One pass over the heightfield
 * finds every cell on the band instead, and the plants then grow in beds around
 * those cells, which is also how reeds actually grow.
 */
const scatterAlongBand = (terrain: Terrain, seed: string, kind: Kind, claims: GroundClaims | null): Placement[] => {
  const band = kind.band;
  if (!band) return [];

  const random = createPrng(seed);
  const half = terrain.size / 2;
  const step = terrain.size / BAND_SCAN;

  const shore: { x: number; z: number }[] = [];
  for (let x = -half; x <= half; x += step) {
    for (let z = -half; z <= half; z += step) {
      const y = terrain.heightAt(x, z);
      if (y < kind.minHeight || y > kind.maxHeight) continue;
      if (terrain.slopeAt(x, z) > kind.maxSlope) continue;
      shore.push({ x, z });
    }
  }
  if (shore.length === 0) return [];

  // Fisher-Yates, so which stretches of shore get a bed is seeded rather than
  // following the scan order, which would plant along rows.
  for (let i = shore.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = shore[i];
    const other = shore[j];
    if (swap && other) {
      shore[i] = other;
      shore[j] = swap;
    }
  }

  const fade = kind.fade ?? 0;
  const points: Placement[] = [];
  // Jitter rejects whatever stepped out of the band, so one bed per cell falls
  // short of the budget on a short shoreline. Going round again thickens the
  // existing beds rather than inventing shore that is not there.
  const rounds = shore.length * 3;
  for (let bed = 0; bed < rounds && points.length < kind.count; bed += 1) {
    const centre = shore[bed % shore.length];
    if (!centre) continue;

    for (let plant = 0; plant < band.clump && points.length < kind.count; plant += 1) {
      const angle = random() * Math.PI * 2;
      const reach = Math.sqrt(random()) * band.radius;
      const x = centre.x + Math.cos(angle) * reach;
      const z = centre.z + Math.sin(angle) * reach;
      const y = terrain.heightAt(x, z);
      // A plant that jittered up the bank is out of the water it needs.
      if (y < kind.minHeight || y > kind.maxHeight) continue;

      const intoFade = fade > 0 ? clamp01((y - (kind.maxHeight - fade)) / fade) : 0;
      if (intoFade > 0 && random() < intoFade) continue;

      // A shoreline is also where the dock, the bridge abutments and the lake
      // revetment are, so the band needs the same test as open ground.
      if (claims && random() < claims.pressureAt(x, z, kind.clearance, kind.claimFade)) continue;

      // The fade thins how many stand near the dry edge, which is enough of a
      // gradient on a band this narrow; shrinking them as well took the shortest
      // reeds under a metre.
      points.push({ x, y, z, scale: 0.78 + random() * 0.5, rotation: random() * Math.PI * 2 });
    }
  }

  return points;
};

/**
 * The slope half of the tree line. `scatterOnTerrain` fades density toward a
 * height limit but cuts dead at `maxSlope`, and on a ridge that is the limit
 * that actually bites: at Tà Xùa a third of the land is steeper than the old
 * 1.15, so the valleys were forest and every flank above them was bare rock.
 * Thinning toward the limit — and stunting what grows near it — turns the edge
 * into a gradient, and a kind with `minSlope` picks up the band beyond it.
 */
const filterPlacements = (
  terrain: Terrain,
  points: Placement[],
  kind: Kind,
  seed: string,
  claims: GroundClaims | null
): Placement[] => {
  const random = createPrng(`${seed}:slope`);
  const fade = kind.slopeFade ?? 0;
  const kept: Placement[] = [];

  for (const point of points) {
    if (kept.length >= kind.count) break;

    // Claimed ground is tested before the slope is even read: it is the cheaper
    // of the two — one grid cell against five bilinear samples — and it is the
    // test that rejects the most, because made ground is flat and flat ground is
    // exactly what the sampler was hunting for.
    if (claims && random() < claims.pressureAt(point.x, point.z, kind.clearance, kind.claimFade)) continue;

    const slope = terrain.slopeAt(point.x, point.z);
    if (kind.minSlope !== undefined && slope < kind.minSlope) continue;

    const into = fade > 0 ? clamp01((slope - (kind.maxSlope - fade)) / fade) : 0;
    if (into > 0 && random() < into) continue;

    kept.push({ ...point, scale: point.scale * (1 - into * 0.35) });
  }

  return kept;
};

export type NatureScatter = {
  group: Group;
  /** Tree crowns, so the camera can be kept out of them. */
  canopy: { x: number; z: number; radius: number; bottom: number; top: number }[];
  /**
   * Hands the boulders the rain's wetness. Only the boulders: foliage reads as
   * hanging and moving rather than as surface, and a leaf sheds what lands on it.
   */
  setWet: (wet: { value: number }) => void;
  dispose: () => void;
};

/**
 * Trees, bushes and rocks placed from the CC0 kit rather than from cones. The
 * placement rules are still the generator's — only the silhouette changed.
 *
 * `claims` is the ground the rest of the world has already taken: roads, the
 * railway, buildings, terraces, water. Declared rather than optional on purpose:
 * nothing here can tell on its own that it has grown a forest down the middle of
 * a carriageway, so a caller that has claims to give has to make a decision
 * about them. Absent at runtime means "nothing is claimed", never an error.
 */
export const createNatureScatter = (
  terrain: Terrain,
  recipe: LocationRecipe,
  sources: NatureSources,
  budget: { trees: number; bushes: number; rocks: number; scrub?: number; reeds?: number },
  waterLevel: number,
  wind: Wind,
  claims: GroundClaims | null | undefined
): NatureScatter => {
  const group = new Group();
  group.name = 'nature';

  /** The rock models' own materials, kept apart from the foliage so rain can find them. */
  const stone: Material[] = [];

  // Both shapes of absence collapsed to one, once, at the boundary — see the
  // same line in `ground-cover.ts` for what testing `!== null` in the hot path
  // cost when a caller had not been given this argument yet.
  const ground: GroundClaims | null = claims ?? null;

  const kinds: Kind[] = [
    {
      sway: { amplitude: 0.05, stiffness: 2.5 },
      models: ['TreeHigh001', 'TreeHigh002', 'TreeHigh003', 'TreeMed001', 'TreeMed002', 'TreeMed003'],
      seed: 'trees',
      count: budget.trees,
      metres: 17,
      minHeight: Math.max(terrain.maxHeight * 0.03, waterLevel + 2),
      maxHeight: recipe.scatter.treeLine,
      fade: recipe.scatter.treeLine * 0.3,
      // Vietnam has no alpine tree line at these reliefs — Tà Xùa is forest and
      // old tea to the ridge — so the limit is what a root can hold, not height.
      maxSlope: 1.8,
      slopeFade: 0.6,
      // Raised to pay for the claim rejections as well as the slope ones: made
      // ground is the flattest on the map and so the most likely to be sampled.
      oversample: 1.6,
      // A crown is `metres * 0.3 * scale`, so a mean tree spreads 5.1 m. Set to
      // the mean rather than to the largest: the biggest trees may still lean
      // their outer branches over a carriageway, which is what a tree-lined road
      // looks like, and the fault reported was a trunk in the asphalt.
      clearance: 5.2,
      claimFade: 7,
      tint: recipe.ground.foliage,
      variation: 0.2,
    },
    {
      sway: { amplitude: 0.09, stiffness: 1.6 },
      models: ['TreeLow001', 'TreeLow002', 'TreeLow003', 'TreeLow004', 'Bush001', 'Bush002'],
      seed: 'bushes',
      count: budget.bushes,
      metres: 2.6,
      minHeight: Math.max(terrain.maxHeight * 0.02, waterLevel + 1),
      maxHeight: recipe.scatter.treeLine * 1.2,
      fade: recipe.scatter.treeLine * 0.35,
      maxSlope: 1.9,
      slopeFade: 0.5,
      oversample: 1.5,
      clearance: 1.1,
      claimFade: 3.5,
      tint: recipe.ground.foliage,
      variation: 0.26,
    },
    {
      // Stunted scrub and tea on ground too steep to hold a tree, so the flanks
      // carry something green instead of being rejected into bare rock.
      sway: { amplitude: 0.06, stiffness: 2.2 },
      models: ['Bush001', 'Bush002', 'TreeLow001', 'TreeLow002', 'TreeLow003', 'TreeLow004'],
      seed: 'scrub',
      count: budget.scrub ?? Math.round(budget.bushes * 0.45),
      metres: 1.4,
      minHeight: Math.max(terrain.maxHeight * 0.02, waterLevel + 1),
      maxHeight: terrain.maxHeight,
      minSlope: 1.7,
      maxSlope: 2.6,
      slopeFade: 0.5,
      // Steep ground is a small fraction of any map, so most candidates are
      // thrown away before one lands on it.
      oversample: 7.5,
      clearance: 0.7,
      claimFade: 2.5,
      tint: recipe.ground.foliage,
      variation: 0.3,
    },
    {
      // Every shoreline in the app was a hard geometric line where water met
      // dirt. Reeds are the only thing that reads as a shore rather than an edge,
      // and they move far more than a tree does, which is half of why they read.
      sway: { amplitude: 0.14, stiffness: 1 },
      models: ['Reed001', 'Reed002'],
      seed: 'reeds',
      count: recipe.water ? (budget.reeds ?? Math.round(budget.bushes * 0.3)) : 0,
      metres: 1.55,
      minHeight: waterLevel - 0.6,
      maxHeight: waterLevel + 0.9,
      fade: 0.5,
      // Reeds stand in the water, so how tilted the bed under them is barely
      // matters. At Tràng An the shore is the foot of a limestone tower and a
      // gentle-ground limit left fifty reeds on the whole map.
      maxSlope: 1.9,
      band: { clump: 5, radius: 1.7 },
      clearance: 0.4,
      claimFade: 1.2,
      tint: recipe.ground.foliage,
      variation: 0.3,
    },
    {
      models: ['Rock001', 'Rock002', 'Rock003'],
      seed: 'rocks',
      count: budget.rocks,
      metres: 1.9,
      minHeight: Math.max(terrain.maxHeight * 0.02, waterLevel - 1),
      maxHeight: terrain.maxHeight,
      maxSlope: 2.5,
      oversample: 1.3,
      // A boulder sitting in a carriageway is the most jarring of the lot, and
      // unlike a tree it has no canopy to blame, so it gets its own girth plus a
      // little: nothing rolled to the kerb and stopped there.
      clearance: 1,
      claimFade: 2.5,
      tint: recipe.ground.rock,
      variation: 0.16,
    },
  ];

  const meshes: InstancedMesh[] = [];
  const canopy: NatureScatter['canopy'] = [];

  const matrix = new Matrix4();
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  const tint = new Color();

  for (const kind of kinds) {
    if (kind.count <= 0) continue;

    const seed = `${recipe.seed}:${kind.seed}`;
    const points = kind.band
      ? scatterAlongBand(terrain, seed, kind, ground)
      : filterPlacements(
          terrain,
          scatterOnTerrain(terrain, seed, Math.ceil(kind.count * (kind.oversample ?? 1)), {
            minHeight: kind.minHeight,
            maxHeight: kind.maxHeight,
            fade: kind.fade,
            maxSlope: kind.maxSlope,
          }),
          kind,
          seed,
          ground
        );
    if (points.length === 0) continue;

    // Split the placements between the available models so a hillside is not
    // one silhouette repeated a thousand times.
    const available = kind.models.filter((name) => sources.has(name));
    if (available.length === 0) continue;

    available.forEach((name, modelIndex) => {
      const source = sources.get(name);
      if (!source) return;

      const mine: Placement[] = points.filter((_, index) => index % available.length === modelIndex);
      if (mine.length === 0) return;

      const material = source.material.clone();
      (material as Material & { vertexColors?: boolean }).vertexColors = false;
      if (kind.seed === 'rocks') stone.push(material);
      if (kind.sway) {
        applyWindSway(material, wind, {
          amplitude: kind.sway.amplitude * source.height,
          height: source.height,
          stiffness: kind.sway.stiffness,
        });
      }
      const mesh = new InstancedMesh(source.geometry, material, mine.length);
      mesh.name = `nature-${kind.seed}-${name}`;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const unit = kind.metres / source.height;

      mine.forEach((point, index) => {
        const size = unit * point.scale;
        position.set(point.x, point.y, point.z);
        quaternion.setFromAxisAngle(UP, point.rotation);
        scale.setScalar(size);
        mesh.setMatrixAt(index, matrix.compose(position, quaternion, scale));

        // The kit ships its own baked palette. Tinting it the way the old cone
        // trees were tinted fought that texture and turned rocks black, so the
        // only variation left is a gentle lightness wobble.
        const wobble = Math.sin(point.x * 0.31 + point.z * 0.17);
        tint.setScalar(1 + wobble * kind.variation * 0.35);
        mesh.setColorAt(index, tint);

        if (kind.seed === 'trees') {
          canopy.push({
            x: point.x,
            z: point.z,
            radius: kind.metres * 0.3 * point.scale,
            bottom: point.y + kind.metres * 0.25 * point.scale,
            top: point.y + kind.metres * 1.1 * point.scale,
          });
        }
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      group.add(mesh);
      meshes.push(mesh);
    });
  }

  return {
    group,
    canopy,
    // Wet stone is the one surface in a forest that goes genuinely glossy, and a
    // boulder is as close to sky-facing as scatter gets.
    setWet: (wet) => {
      for (const material of stone) applyWetLook(material, wet, { darken: 0.3, gloss: 0.78, pooling: 0.6 });
    },
    dispose: () => {
      for (const mesh of meshes) {
        (mesh.material as Material).dispose();
        mesh.dispose();
      }
    },
  };
};
