import { scatterOnTerrain, type LocationRecipe, type PoiKind, type PoiRecipe, type Terrain } from '@otrip/world';

/**
 * Why a place is not where its own rule would have put it. `scatter` means the
 * recipe has no town and the scattered houses stood in for it; `standable` means
 * no rule could place it at all and it sits on the best ground available, which
 * is a bug in the rule or the recipe and is logged as one.
 */
export type PoiFallback = 'scatter' | 'standable';

export type ResolvedPoi = PoiRecipe & { x: number; y: number; z: number; fallback?: PoiFallback };

/** Anything that counts as a built thing for the purpose of finding a settlement. */
type Place = { x: number; z: number };

/** How close you have to get for a place to count as visited. */
export const DISCOVERY_RADIUS = 70;

/**
 * Places the maps show from the first frame, rather than as a hollow ring until
 * you have stood on them.
 *
 * A viewpoint is worth discovering: finding it is the thing. A jetty is not —
 * it is somewhere you go when you have decided to be on the water, and hiding
 * it until you have already walked there is the one case where the discovery
 * rule costs more than it gives. Keyed on the kind so a fifth destination
 * answers for itself.
 */
export const alwaysOnMap = (poi: { kind: string }): boolean => poi.kind === 'shore';

/** Candidates are taken from a fixed grid, so the result is the same for everyone. */
const GRID = 56;
const MIN_SEPARATION = 260;

type Candidate = { x: number; z: number; height: number; slope: number };

const sampleGrid = (terrain: Terrain): Candidate[] => {
  const candidates: Candidate[] = [];
  const half = terrain.size / 2;
  const step = terrain.size / GRID;

  for (let row = 1; row < GRID; row += 1) {
    for (let col = 1; col < GRID; col += 1) {
      const x = -half + col * step;
      const z = -half + row * step;
      candidates.push({ x, z, height: terrain.heightAt(x, z), slope: terrain.slopeAt(x, z) });
    }
  }

  return candidates;
};

/** Mean height of a ring around a point — the basis for prominence and islands. */
const ringHeight = (terrain: Terrain, x: number, z: number, radius: number): number => {
  let total = 0;
  for (let step = 0; step < 8; step += 1) {
    const angle = (step / 8) * Math.PI * 2;
    total += terrain.heightAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
  }
  return total / 8;
};

const ringUnderwater = (terrain: Terrain, x: number, z: number, radius: number, waterLevel: number): number => {
  let under = 0;
  for (let step = 0; step < 12; step += 1) {
    const angle = (step / 12) * Math.PI * 2;
    if (terrain.heightAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius) < waterLevel) under += 1;
  }
  return under / 12;
};

/**
 * How far apart the built things are, so a settlement can be found among ninety
 * houses scattered over three kilometres as well as among seventy packed into
 * one street. Floored at the width of a village centre.
 */
const clusterRadius = (places: readonly Place[], size: number): number =>
  Math.max(140, Math.sqrt((size * size) / Math.max(1, places.length)) * 0.8);

const scorer = (
  kind: PoiKind,
  terrain: Terrain,
  waterLevel: number,
  places: readonly Place[]
): ((candidate: Candidate) => number) => {
  const half = terrain.size / 2;
  const nearestPlace = (x: number, z: number) =>
    places.length === 0 ? Infinity : Math.min(...places.map((place) => Math.hypot(x - place.x, z - place.z)));

  switch (kind) {
    case 'summit':
      return (c) => (c.height < waterLevel ? -Infinity : c.height);

    case 'valley':
      // A narrow spine: high, with the ground falling away on both sides.
      return (c) =>
        c.height < waterLevel ? -Infinity : c.height - ringHeight(terrain, c.x, c.z, terrain.size * 0.05) * 1.1;

    case 'shore':
      // Right at the waterline, and as far from the middle as the map allows.
      return (c) => {
        if (!Number.isFinite(waterLevel)) return -Infinity;
        const depth = Math.abs(c.height - waterLevel);
        if (depth > 3 || c.height < waterLevel) return -Infinity;
        return Math.hypot(c.x, c.z) / half - depth;
      };

    case 'island':
      return (c) => {
        if (!Number.isFinite(waterLevel) || c.height <= waterLevel + 1) return -Infinity;
        const surrounded = ringUnderwater(terrain, c.x, c.z, terrain.size * 0.06, waterLevel);
        return surrounded < 0.6 ? -Infinity : surrounded * 100 + c.height * 0.05;
      };

    case 'town': {
      // Density, not proximity. Scoring by the nearest single building put the
      // marker next to one outlying house in a field, with the actual town a
      // kilometre away. A falling kernel rather than a count inside a fixed ring,
      // because the ring returned zero everywhere for a hamlet whose houses are
      // three hundred metres apart — and a score of zero everywhere is how
      // "Bản trên núi" silently stopped existing at Tà Xùa.
      const spread = clusterRadius(places, terrain.size);
      return (c) => {
        if (places.length === 0) return -Infinity;
        let weight = 0;
        for (const place of places) {
          const dx = c.x - place.x;
          const dz = c.z - place.z;
          weight += Math.exp(-(dx * dx + dz * dz) / (spread * spread));
        }
        return weight;
      };
    }

    case 'grove':
    default:
      // Away from the houses, out of the water, on ground you can stand on.
      return (c) => {
        if (c.height <= waterLevel + 2 || c.slope > 0.4) return -Infinity;
        return Math.min(nearestPlace(c.x, c.z), 600) - Math.hypot(c.x, c.z) * 0.15;
      };
  }
};

/**
 * Ground you can stand on, and nothing more. The last resort for a place whose
 * own rule found nowhere: better a reachable spot than a name in the panel that
 * counts towards a total nobody can complete.
 */
const standable =
  (waterLevel: number): ((candidate: Candidate) => number) =>
  (c) =>
    c.height <= waterLevel + 1 || c.slope > 0.5 ? -Infinity : 1 - c.slope;

/**
 * Beside the jetty rather than on it. A marker is a 24 m mast with an 11 m
 * banner, and the jetty's own origin is the landward end of the planking with
 * the ramp head under it, so marking the landing there drives the mast straight
 * down through the deck. Six metres clears the deck, the washing steps and the
 * fenders; a metre back from the planking keeps it on the bank. The side is
 * whichever of the two is dry — the shelter sits on neither.
 */
const besideLanding = (terrain: Terrain, landing: { x: number; z: number; heading: number }): Place => {
  const forwardX = Math.sin(landing.heading);
  const forwardZ = Math.cos(landing.heading);
  const at = (side: number) => ({
    x: landing.x + forwardZ * side * 6 - forwardX * 1,
    z: landing.z - forwardX * side * 6 - forwardZ * 1,
  });

  const left = at(-1);
  const right = at(1);
  return terrain.heightAt(left.x, left.z) > terrain.heightAt(right.x, right.z) ? left : right;
};

/**
 * Turns the recipe's named rules into real coordinates on this seed's terrain.
 * Each place claims the best spot its rule can find that is not already taken by
 * an earlier one, so two of them never land on the same hilltop.
 */
export const resolvePois = (
  terrain: Terrain,
  recipe: LocationRecipe,
  buildings: readonly Place[],
  /** The jetty's site, from `findDockSite`. Null where there is no jetty. */
  landing?: { x: number; z: number; heading: number } | null
): ResolvedPoi[] => {
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const candidates = sampleGrid(terrain);
  const resolved: ResolvedPoi[] = [];

  // Two locations have `town: null`, so a recipe there can still name a
  // settlement — Tà Xùa's "Bản trên núi" is one — and the only built things on
  // the map are the scattered houses. Mirrors the filter in `scatter-meshes.ts`:
  // the two have to agree or the marker lands where no house stands.
  const scattered: Place[] =
    buildings.length > 0
      ? []
      : scatterOnTerrain(terrain, `${recipe.seed}:houses`, recipe.scatter.houses, {
          minHeight: Math.max(terrain.maxHeight * 0.06, waterLevel + 2.5),
          maxHeight: recipe.scatter.treeLine * 0.8,
          maxSlope: 0.32,
        });
  const places: readonly Place[] = buildings.length > 0 ? buildings : scattered;
  const fromScatter = buildings.length === 0 && scattered.length > 0;

  const pick = (score: (candidate: Candidate) => number): Candidate | null => {
    let best: Candidate | null = null;
    let bestScore = -Infinity;

    for (const candidate of candidates) {
      const tooClose = resolved.some(
        (placed) => Math.hypot(candidate.x - placed.x, candidate.z - placed.z) < MIN_SEPARATION
      );
      if (tooClose) continue;

      const value = score(candidate);
      if (value > bestScore) {
        bestScore = value;
        best = candidate;
      }
    }

    return bestScore === -Infinity ? null : best;
  };

  for (const poi of recipe.pois) {
    // A shore is a landing, and on each of these maps exactly one landing is
    // built: the jetty. Scored on its own rule — waterline, furthest from the
    // middle of the map — it went somewhere else entirely: measured 2247 m from
    // the jetty at Hội An, 3105 m at Tràng An, 2388 m at Hồ Tây. That gap is why
    // walking to "Bến thuyền nan" arrived at bare water with no boat and no
    // jetty in sight; the name and the thing it names were never the same place.
    // Placed directly rather than through `pick`, because the jetty is a built
    // fact and not a candidate to be scored against the grid.
    if (poi.kind === 'shore' && landing) {
      const spot = besideLanding(terrain, landing);
      resolved.push({ ...poi, x: spot.x, y: terrain.heightAt(spot.x, spot.z), z: spot.z });
      continue;
    }

    const found = pick(scorer(poi.kind, terrain, waterLevel, places));
    let fallback: PoiFallback | undefined = found && fromScatter && poi.kind === 'town' ? 'scatter' : undefined;
    let best = found;

    if (!best) {
      // Loud, because the alternative is what this used to do: drop the place
      // from the array, leave the panel counting a total nobody can complete,
      // and leave the recipe's own note describing somewhere you cannot go.
      best = pick(standable(waterLevel));
      fallback = 'standable';
      console.error(
        `POI "${poi.name}" (${poi.id}, ${poi.kind}) không có chỗ nào thoả luật của nó ở ${recipe.slug}` +
          (best ? ' — tạm đặt ở chỗ đứng được tốt nhất.' : ' — và cũng không có chỗ nào đứng được.')
      );
    }

    if (!best) continue;
    resolved.push({ ...poi, x: best.x, y: terrain.heightAt(best.x, best.z), z: best.z, fallback });
  }

  return resolved;
};
