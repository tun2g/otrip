import { scatterOnTerrain, type LocationRecipe, type PoiRecipe, type Terrain } from '@otrip/world';

import { findLandmasses } from './landmass';
import { scorer, standable, type Candidate, type Place } from './poi-rules';

/**
 * Why a place is not where its own rule would have put it. `scatter` means the
 * recipe has no town and the scattered houses stood in for it; `standable` means
 * no rule could place it at all and it sits on the best ground available, which
 * is a bug in the rule or the recipe and is logged as one.
 */
export type PoiFallback = 'scatter' | 'standable';

export type ResolvedPoi = PoiRecipe & { x: number; y: number; z: number; fallback?: PoiFallback };

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
  const resolved: ResolvedPoi[] = [];

  // Two locations have `town: null`, so a recipe there can still name a
  // settlement — Tà Xùa's "Bản trên núi" is one — and the only built things on
  // the map are the scattered houses.
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

  /**
   * Ground joined to the ground the people live on, and no other.
   *
   * A landmark on a landmass no road and no walker can reach is a name in the
   * panel counting towards a total nobody can complete, which is the exact
   * failure the `standable` fallback below exists to make loud — and Hồ Tây was
   * two landmasses until its recipe moved onto a `basin`, 5.54 km² of west bank
   * against 5.11 km² of east with 1325 m of water between them. Applied to every
   * kind rather than to `island` alone, because the rules that climb and the
   * rules that go looking for open ground can all walk off the edge of the world
   * the player is standing in. Hồ Tây no longer has an edge to walk off; Tràng
   * An has seven landmasses and Hội An two, and a recipe is one parameter away
   * from having an island again.
   *
   * The home side is the one most of the houses are on, not the largest piece:
   * the landmass that matters is where the village is.
   */
  const land = Number.isFinite(waterLevel) ? findLandmasses(terrain, waterLevel) : null;
  let home = 0;
  if (land && places.length > 0) {
    const votes = new Map<number, number>();
    for (const place of places) {
      const id = land.at(place.x, place.z);
      if (id >= 0) votes.set(id, (votes.get(id) ?? 0) + 1);
    }
    for (const [id, count] of votes) if (count > (votes.get(home) ?? -1)) home = id;
  }
  // A ring as well as the point, because the landmass grid is ~20 m and a POI
  // grid cell is 65 to 93 m: a candidate that genuinely stands on the bank can
  // fall in a cell the flood called wet, and refusing it would cost exactly the
  // shoreline candidates the `island` and `shore` rules are looking for.
  const onHomeGround = (x: number, z: number): boolean => {
    if (!land) return true;
    if (land.at(x, z) === home) return true;
    const reach = terrain.size / 90;
    for (let step = 0; step < 8; step += 1) {
      const angle = (step / 8) * Math.PI * 2;
      if (land.at(x + Math.cos(angle) * reach, z + Math.sin(angle) * reach) === home) return true;
    }
    return false;
  };

  const candidates = sampleGrid(terrain).filter((candidate) => onHomeGround(candidate.x, candidate.z));
  let roof: Candidate | null = null;
  for (const candidate of candidates) {
    if (candidate.height <= waterLevel) continue;
    if (!roof || candidate.height > roof.height) roof = candidate;
  }
  const ground = { terrain, waterLevel, places, roof, inland: (terrain.size / 2) * recipe.terrain.edgeFalloff };

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
    // middle of the map — it goes somewhere else entirely: re-measured on the
    // shipped recipes at 1833 m from the jetty at Hội An, 2466 m at Tràng An and
    // 1730 m at Hồ Tây, where the first reading of this was 2247 / 3105 / 2388
    // before the lake became a basin and the hamlets moved the hub. That gap is why
    // walking to "Bến thuyền nan" arrived at bare water with no boat and no
    // jetty in sight; the name and the thing it names were never the same place.
    // Placed directly rather than through `pick`, because the jetty is a built
    // fact and not a candidate to be scored against the grid.
    if (poi.kind === 'shore' && landing) {
      const spot = besideLanding(terrain, landing);
      resolved.push({ ...poi, x: spot.x, y: terrain.heightAt(spot.x, spot.z), z: spot.z });
      continue;
    }

    const found = pick(scorer(poi.kind, ground));
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
