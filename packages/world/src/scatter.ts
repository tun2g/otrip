import { createPrng } from './prng.ts';
import type { Terrain } from './terrain.ts';

export type ScatterPoint = {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotation: number;
};

export type ScatterFilter = {
  minHeight: number;
  maxHeight: number;
  maxSlope: number;
  /**
   * Metres below `maxHeight` over which density thins to nothing. A hard cut
   * shaves a horizontal line across a hillside that nothing in nature makes,
   * and it is what left the upper half of a mountain bare.
   */
  fade?: number;
};

/**
 * Rejection sampling against the terrain, so trees stay below the tree line and
 * houses stay off cliffs. Seeded, so the placement is identical for everyone.
 */
export const scatterOnTerrain = (
  terrain: Terrain,
  seed: string,
  count: number,
  filter: ScatterFilter
): ScatterPoint[] => {
  const random = createPrng(seed);
  const half = terrain.size / 2;
  const points: ScatterPoint[] = [];
  const maxAttempts = count * 40;

  for (let attempt = 0; attempt < maxAttempts && points.length < count; attempt += 1) {
    const x = (random() * 2 - 1) * half;
    const z = (random() * 2 - 1) * half;
    const y = terrain.heightAt(x, z);

    if (y < filter.minHeight || y > filter.maxHeight) continue;
    if (terrain.slopeAt(x, z) > filter.maxSlope) continue;

    const fade = filter.fade ?? 0;
    const intoFade = fade > 0 ? Math.min(1, Math.max(0, (y - (filter.maxHeight - fade)) / fade)) : 0;
    if (intoFade > 0 && random() < intoFade) continue;

    // Growth near the limit is stunted, which is the other half of why a tree
    // line reads as a gradient rather than an edge.
    const scale = (0.75 + random() * 0.55) * (1 - intoFade * 0.38);
    points.push({ x, y, z, scale, rotation: random() * Math.PI * 2 });
  }

  return points;
};
