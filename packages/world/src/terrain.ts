import { createNoise, fbm2d, ridged2d } from './noise.ts';
import type { LocationRecipe } from './recipe.ts';

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export type Terrain = {
  size: number;
  segments: number;
  maxHeight: number;
  /** Row-major grid of (segments + 1)^2 heights. */
  heights: Float32Array;
  /** Bilinear height lookup in world coordinates, origin at the centre. */
  heightAt: (x: number, z: number) => number;
  /** Gradient magnitude, 0 = flat. Used to keep houses off cliffs. */
  slopeAt: (x: number, z: number) => number;
};

export const createTerrain = (recipe: LocationRecipe, segmentsOverride?: number): Terrain => {
  const {
    size,
    maxHeight,
    ridgeFrequency,
    detailFrequency,
    ridgeWeight,
    ridgeStretch,
    smoothing,
    edgeFalloff,
    profile,
    baseHeight,
    river,
    basin,
  } = recipe.terrain;
  const segments = segmentsOverride ?? recipe.terrain.segments;

  const ridgeNoise = createNoise(`${recipe.seed}:ridge`);
  const detailNoise = createNoise(`${recipe.seed}:detail`);
  const massifNoise = createNoise(`${recipe.seed}:massif`);
  const basinNoise = createNoise(`${recipe.seed}:basin`);

  const side = segments + 1;
  const heights = new Float32Array(side * side);
  const step = size / segments;
  const half = size / 2;

  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const x = -half + col * step;
      const z = -half + row * step;

      // Sampling X compressed stretches the ridges into lines that run across
      // the map, which is what a range looks like from a distance.
      const ridge = ridged2d(ridgeNoise, x * ridgeStretch, z, {
        octaves: 4,
        frequency: ridgeFrequency,
        lacunarity: 1.95,
        gain: 0.42,
      });
      const detail =
        (fbm2d(detailNoise, x, z, {
          octaves: 3,
          frequency: detailFrequency,
          lacunarity: 2,
          gain: 0.4,
        }) +
          1) /
        2;

      // A very low frequency pass so ridges differ in height across the map
      // instead of all topping out at maxHeight.
      const massif =
        0.55 +
        0.45 *
          ((fbm2d(massifNoise, x, z, {
            octaves: 2,
            frequency: ridgeFrequency * 0.35,
            lacunarity: 2,
            gain: 0.5,
          }) +
            1) /
            2);

      // Square patches betray themselves at the border. Sinking the rim below
      // the cloud line lets the clouds finish the horizon for us.
      const distance = Math.max(Math.abs(x), Math.abs(z)) / half;
      const rim = 1 - smoothstep(edgeFalloff, 1, distance);

      const mixed = ridgeWeight * ridge + (1 - ridgeWeight) * detail;

      // One generator, three places. Ridges stay sharp; karst stands isolated
      // towers on a floodplain; lowland keeps only a hint of relief so a delta
      // reads as a delta.
      let height: number;
      if (profile === 'karst') {
        // Karst is two landforms, not one, and scaling a single field by
        // `baseHeight / maxHeight` cannot be both: a plain flat enough to walk
        // and to pole a boat across is a thirtieth of the tower height, which
        // puts the whole floodplain thirty-odd metres under any waterline the
        // towers are measured against. So the plain is built in metres from the
        // massif swell alone — a few metres of relief, which is what decides
        // where water pools between the towers — and the towers are added on
        // top of it out of the high tail of the ridge noise.
        const tower = Math.pow(smoothstep(0.63, 0.96, ridge), 0.75);
        // The patch must still end in water rather than a square cliff, but
        // sinking the plain to zero the way a ridge does is what drowned it:
        // the rim only needs to dip a couple of metres under the waterline, so
        // it keeps most of its height while the towers fall away completely.
        height = baseHeight * massif * (0.75 + 0.25 * rim) + tower * maxHeight * massif * rim;
      } else {
        const shaped = profile === 'lowland' ? 0.08 + 0.3 * Math.pow(mixed, 1.8) : Math.pow(mixed, 1.15);
        const floor = Math.min(0.95, baseHeight / maxHeight);
        height = (floor + shaped * (1 - floor)) * massif * rim * maxHeight;
      }

      if (river) {
        const along = river.alongX ? x : z;
        const across = river.alongX ? z : x;
        const centre = river.amplitude * Math.sin((along / size) * Math.PI * 2 * river.waves);
        const fromCentre = Math.abs(across - centre);
        if (fromCentre < river.width) {
          height -= river.depth * smoothstep(0, 1, 1 - fromCentre / river.width);
        }
      }

      if (basin) {
        // Elliptical distance, so the hollow can be wider than it is tall the
        // way Hồ Tây is — 3.2 km east to west against 2.4 north to south.
        const fromX = (x - basin.x) / basin.stretch;
        const fromZ = z - basin.z;
        const reach = Math.hypot(fromX, fromZ);
        // The rim's wander is sampled on a circle rather than on the plane, so
        // it is a function of bearing alone and meets itself at the seam. A
        // plane sample would leave a step where the angle wraps.
        const bearing = Math.atan2(fromZ, fromX);
        const wander = fbm2d(basinNoise, Math.cos(bearing) * 3, Math.sin(bearing) * 3, {
          octaves: 3,
          frequency: 1,
          lacunarity: 2,
          gain: 0.5,
        });
        const rimReach = basin.radius * (1 + basin.wobble * wander);
        if (reach < rimReach) {
          // Nothing at the rim, the full cut `shore` metres inside it. The
          // waterline is wherever that shelf crosses `water.level`, which moves
          // with the massif underneath — that is the shoreline's irregularity,
          // and it is why this is a shelf rather than a step.
          height -= basin.depth * smoothstep(rimReach, Math.max(0, rimReach - basin.shore), reach);
        }
      }

      heights[row * side + col] = height;
    }
  }

  // Noise has energy right down to the grid spacing, which reads as a bed of
  // needles rather than mountains. One box blur per pass removes it without
  // touching the large forms, and stays deterministic.
  for (let pass = 0; pass < smoothing; pass += 1) {
    const source = heights.slice();
    for (let row = 0; row < side; row += 1) {
      for (let col = 0; col < side; col += 1) {
        let sum = 0;
        let count = 0;
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            const r = row + dr;
            const c = col + dc;
            if (r < 0 || c < 0 || r >= side || c >= side) continue;
            sum += source[r * side + c];
            count += 1;
          }
        }
        heights[row * side + col] = sum / count;
      }
    }
  }

  const heightAt = (x: number, z: number): number => {
    const gx = Math.min(Math.max((x + half) / step, 0), segments);
    const gz = Math.min(Math.max((z + half) / step, 0), segments);
    const col = Math.floor(gx);
    const row = Math.floor(gz);
    const colNext = Math.min(col + 1, segments);
    const rowNext = Math.min(row + 1, segments);
    const fx = gx - col;
    const fz = gz - row;

    const h00 = heights[row * side + col];
    const h10 = heights[row * side + colNext];
    const h01 = heights[rowNext * side + col];
    const h11 = heights[rowNext * side + colNext];

    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  };

  const slopeAt = (x: number, z: number): number => {
    const dx = (heightAt(x + step, z) - heightAt(x - step, z)) / (2 * step);
    const dz = (heightAt(x, z + step) - heightAt(x, z - step)) / (2 * step);
    return Math.hypot(dx, dz);
  };

  return { size, segments, maxHeight, heights, heightAt, slopeAt };
};
