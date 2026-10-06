import type { LocationRecipe, Terrain } from '@otrip/world';

import type { ParkingSpot } from './road-network';
import type { ResolvedPoi } from './points-of-interest';

/**
 * Somewhere to stand on arrival.
 *
 * Its own module, and exported, for one reason: it used to be a closure inside
 * `createWorldRenderer`, so nothing could measure it. The probe that reports
 * "how far is the nearest motorbike from where you arrive" was answering with a
 * *different*, simpler spawn — `findSpawn` — and so could not see a change to
 * this one at all. A replica that drifts from the thing it measures is worse
 * than no measurement, and this file is how both run the same code.
 */
export const chooseSpawn = (
  terrain: Terrain,
  recipe: LocationRecipe,
  /** Where the houses are, so nobody arrives inside somebody's wall. */
  buildings: readonly { x: number; z: number }[],
  pois: readonly ResolvedPoi[],
  /** Rows of parked machines. A tiebreak only — see below. */
  parking: readonly ParkingSpot[],
  /** The weaker centre-outward search, for when nothing better is found. */
  fallback: { x: number; z: number }
): { x: number; z: number } => {
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const base = fallback;
  const first = pois[0];
  if (!first) return base;

  /** Average ground on a ring, to tell a crest from a hollow. */
  const ringAverage = (x: number, z: number, radius: number) => {
    let total = 0;
    for (let step = 0; step < 8; step += 1) {
      const angle = (step / 8) * Math.PI * 2;
      total += terrain.heightAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
    }
    return total / 8;
  };

  const hasOutlook = (x: number, z: number) => {
    const eye = terrain.heightAt(x, z) + 2.5;
    const toward = Math.atan2(first.x - x, first.z - z);

    for (let step = 15; step <= 80; step += 15) {
      const ahead = terrain.heightAt(x + Math.sin(toward) * step, z + Math.cos(toward) * step);
      if (ahead > eye + 6) return false;
    }
    return true;
  };

  /**
   * The nearest row of parked machines, as a tiebreak only.
   *
   * The player's complaint was that they arrive and the nearest bike is 243 to
   * 653 m away, which is a walk before the ride. But every test above is about
   * whether the place is worth standing in — dry, not a cliff, on a crest
   * rather than in a hollow, with something to look at — and none of those may
   * be traded for a shorter walk. So this does not filter anything: the scan
   * still takes the **first ring** that yields any acceptable spot at all, so
   * the spawn is exactly as close to the first landmark as it ever was. All
   * that changes is which of the equally good points on that ring is chosen.
   *
   * One point per row rather than per slot, so a four-slot row does not outvote
   * a distant one by having four entries near each other.
   */
  const rows = new Map<number, { x: number; z: number }>();
  for (const spot of parking) if (!rows.has(spot.area)) rows.set(spot.area, spot);
  const toParking = (x: number, z: number) => {
    let best = Infinity;
    for (const row of rows.values()) best = Math.min(best, Math.hypot(row.x - x, row.z - z));
    return best;
  };

  for (let radius = 260; radius < 900; radius += 45) {
    let pick: { x: number; z: number } | null = null;
    let walk = Infinity;

    for (let step = 0; step < 24; step += 1) {
      const angle = (step / 24) * Math.PI * 2;
      const x = first.x + Math.cos(angle) * radius;
      const z = first.z + Math.sin(angle) * radius;
      if (Math.abs(x) > terrain.size / 2 - 40 || Math.abs(z) > terrain.size / 2 - 40) continue;
      if (terrain.heightAt(x, z) <= waterLevel + 2) continue;
      if (terrain.slopeAt(x, z) > 0.3) continue;
      // On a crest rather than in a hollow. Standing in a dip on a mountain
      // means the only thing in frame is the next slope up.
      if (terrain.heightAt(x, z) < ringAverage(x, z, terrain.size * 0.035) + terrain.maxHeight * 0.02) continue;
      if (!hasOutlook(x, z)) continue;

      const reach = toParking(x, z);
      if (pick && reach >= walk) continue;
      pick = { x, z };
      walk = reach;
    }

    if (pick) return pick;
  }

  return base;
};
