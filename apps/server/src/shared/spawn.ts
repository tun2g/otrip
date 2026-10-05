import type { Terrain } from '@otrip/world';

/** Steepest ground a visitor may arrive on. The browser's own search uses 0.35. */
const MAX_SLOPE = 0.35;

/** Freeboard above the waterline, in metres, so nobody arrives wading. */
const DRY_MARGIN = 2;

export const isSpawnable = (terrain: Terrain, waterLevel: number, x: number, z: number): boolean => {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  const half = terrain.size / 2;
  if (Math.abs(x) > half || Math.abs(z) > half) return false;
  return terrain.heightAt(x, z) > waterLevel + DRY_MARGIN && terrain.slopeAt(x, z) < MAX_SLOPE;
};

/**
 * Somewhere to stand, searched in rings out from the centre of the map, which is
 * where the browser starts too. It is deliberately the weaker of the two: the
 * browser also keeps clear of buildings and checks that you can see out of the
 * spot, and it can, because the town plan and the landmarks live in the renderer
 * and never reach the server. So this is the answer for a client that sends no
 * spawn of its own, not a second opinion on one that does.
 *
 * It matters most where the centre is the worst place in the map: at Tà Xùa
 * (0, 0) is the ridge summit, which is how a joining friend ended up standing on
 * a mountain top until their first move packet arrived.
 */
export const findSpawn = (terrain: Terrain, waterLevel: number): { x: number; z: number } => {
  const half = terrain.size / 2;
  const stride = terrain.size / 80;

  for (let radius = 0; radius < half; radius += stride) {
    for (let step = 0; step < 16; step += 1) {
      const angle = (step / 16) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (isSpawnable(terrain, waterLevel, x, z)) return { x, z };
    }
  }

  return { x: 0, z: 0 };
};
