import type { PoiKind, Terrain } from '@otrip/world';

/**
 * The rule each kind of landmark is found by.
 *
 * Split out of `points-of-interest` because the two answer different questions:
 * that file resolves a recipe against a seed, and this one holds the judgement
 * about what a summit, a spine, a shore, a cồn and a vườn actually are on a
 * heightfield. Every rule here is a statement about the real landform, and two
 * of them used to be statements about the generator instead — see `island` and
 * `valley`.
 */

export type Candidate = { x: number; z: number; height: number; slope: number };

/** Anything that counts as a built thing for the purpose of finding a settlement. */
export type Place = { x: number; z: number };

/** What a rule may ask about the world besides the candidate in front of it. */
export type Ground = {
  terrain: Terrain;
  waterLevel: number;
  /** The built things, for the rules that are about people rather than about land. */
  places: readonly Place[];
  /**
   * Highest dry candidate on the grid. The massif the `valley` rule measures
   * its spine against, taken from the same candidate set so the two rules
   * cannot disagree about which mountain this is.
   */
  roof: Candidate | null;
  /**
   * Metres from the centre beyond which `edgeFalloff` is already sinking the
   * patch. Past it the ground is the drawn horizon rather than a place.
   */
  inland: number;
};

/** Mean height of a ring around a point — the basis for prominence. */
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

export const scorer = (kind: PoiKind, ground: Ground): ((candidate: Candidate) => number) => {
  const { terrain, waterLevel, places } = ground;
  const half = terrain.size / 2;
  const nearestPlace = (x: number, z: number) =>
    places.length === 0 ? Infinity : Math.min(...places.map((place) => Math.hypot(x - place.x, z - place.z)));

  switch (kind) {
    case 'summit':
      return (c) => (c.height < waterLevel ? -Infinity : c.height);

    case 'valley':
      /**
       * The sống lưng: a narrow spine, high, with the ground falling away on
       * both sides — **of this mountain**, which is the part the rule used to
       * leave out. Scored on prominence alone it took the best spine anywhere on
       * the patch, and at Tà Xùa that is 1793 m from the summit across the
       * range: measured, "Sống lưng khủng long" stood at (-1671, -743) while
       * every road and every trail on the mountain was between x 536 and 1056,
       * and the đường mòn out to it was refused by `MAX_TRAIL_LENGTH` because
       * the walk was 2.2 km. A named place with no way to reach it.
       *
       * Windowed on the roof at a fifth of the patch, the same spine the ridge
       * trail already walks out along (`crestTarget` aims 6–13% of the map out),
       * it lands at (-279, -464) — 464 m from the summit, prominence 242 m
       * against the old 313 m, and on the ridge the player is already standing
       * on. `MIN_SEPARATION` is what keeps it off the summit itself.
       */
      return (c) => {
        if (c.height < waterLevel) return -Infinity;
        const spine = c.height - ringHeight(terrain, c.x, c.z, terrain.size * 0.05) * 1.1;
        if (spine <= 0) return -Infinity;
        if (!ground.roof) return spine;
        const away = Math.hypot(c.x - ground.roof.x, c.z - ground.roof.z);
        return spine * Math.exp(-((away / (terrain.size * 0.2)) ** 2));
      };

    case 'shore':
      // Right at the waterline, and as far from the middle as the map allows.
      return (c) => {
        if (!Number.isFinite(waterLevel)) return -Infinity;
        const depth = Math.abs(c.height - waterLevel);
        if (depth > 3 || c.height < waterLevel) return -Infinity;
        return Math.hypot(c.x, c.z) / half - depth;
      };

    case 'island':
      /**
       * A cồn or a bán đảo: dry ground with water most of the way round it.
       *
       * This rule only ever found the drowned border. The ring was 6% of the
       * map — 216 to 312 m — sampled wherever it fell, and `edgeFalloff` sinks
       * the rim below every waterline on purpose so the clouds can finish the
       * horizon, so a cell near the edge has water on two sides before any real
       * water is involved. Measured across the three watered destinations,
       * **every** candidate it admitted lay within 321 m of the border: all 22
       * at Hồ Tây in the four corners, all 18 at Hội An on the east and west
       * edges, all 132 at Tràng An on the west rim. So "Cồn giữa sông" stood
       * 1543 m out on the map edge instead of in the Thu Bồn, "Đảo nhỏ giữa hồ"
       * on the drowning rim and "Bán đảo" 225 m from a corner — on three of the
       * four destinations the note described somewhere the marker was not.
       *
       * So the ring has to stay inside the land the recipe means to keep, the
       * near radius is a spit's width rather than a sixth of the map, and the
       * wider ring breaks ties toward whatever reaches furthest into the water.
       * That puts Hội An's cồn at (-1029, -64), 2.6 m above the river in the
       * middle of the channel, which is what a cồn is.
       *
       * The slope gate is between the grove's 0.4 and the `standable` fallback's
       * 0.5, and it is what keeps this off a limestone flank: at Tràng An every
       * one of the six best-scoring candidates was tower face at a gradient of
       * 0.89 to 2.23, and the marker is a 24 m mast with a ring band painted on
       * the ground and a 70 m discovery radius round it. An island is somewhere
       * you set foot, so 0.45 takes it to (339, 407) — rock, standable, in the
       * water, which is "mỏm đất lọt thỏm giữa mặt nước, bốn bề là đá".
       */
      return (c) => {
        if (!Number.isFinite(waterLevel) || c.height <= waterLevel + 1.5) return -Infinity;
        if (c.slope > 0.45) return -Infinity;
        const spit = terrain.size * 0.035;
        if (Math.max(Math.abs(c.x), Math.abs(c.z)) + spit * 2 > ground.inland) return -Infinity;
        const around = ringUnderwater(terrain, c.x, c.z, spit, waterLevel);
        if (around < 0.5) return -Infinity;
        return around * 100 + ringUnderwater(terrain, c.x, c.z, spit * 2, waterLevel) * 60;
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
export const standable =
  (waterLevel: number): ((candidate: Candidate) => number) =>
  (c) =>
    c.height <= waterLevel + 1 || c.slope > 0.5 ? -Infinity : 1 - c.slope;
