import { createTerrain, getLocation, type LocationRecipe, type Terrain } from '@otrip/world';

export type World = { recipe: LocationRecipe; terrain: Terrain };

/**
 * The server generates the same world the browser does, from the same seed and
 * at the same resolution. The resolution is not an optimisation to trade away:
 * the server overwrites every player's height from this heightfield, so any
 * disagreement with the client's is a friend's avatar buried in the hillside or
 * floating over the valley. A coarser 128-division grid was out by 19 m on
 * average and 142 m at worst against the client's 384 on the Tà Xùa ridge,
 * because smoothing a different grid spacing makes a different surface rather
 * than a cheaper sample of the same one. Matched, the error is exactly zero.
 *
 * Bounded by construction: only slugs `getLocation` recognises are ever cached,
 * so an unknown slug cannot grow the map. The four real locations cost about
 * 2 MB of heights in total and 40–140 ms each, paid once per process.
 */
const cache = new Map<string, World>();

export const worldFor = (slug: string): World | null => {
  const cached = cache.get(slug);
  if (cached) return cached;

  const recipe = getLocation(slug);
  if (!recipe) return null;

  const world: World = { recipe, terrain: createTerrain(recipe) };
  cache.set(slug, world);
  return world;
};
