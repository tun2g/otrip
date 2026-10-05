import { createPrng, type LocationRecipe, type Prng, type Terrain } from '@otrip/world';

import type { BuildingType } from './building-spec';
import { PLOT, type Plot } from './building-types';
import type { GroundClaims } from './ground-claims';
import { alongLane, makeLane, padUnder, seekSite, traceArm, type Lane, type Point } from './town-lanes';
import { SETTLEMENTS, styleOf, type Mix, type SettlementPlan, type TownStyle } from './town-styles';

/**
 * Where the buildings go. This is the half of a town that cannot be fixed by
 * modelling: houses front onto something, share their neighbour's orientation,
 * leave lanes between them, and sit on a pad cut level into the slope. Scatter
 * the same models at random angles and it reads as an asset dump.
 *
 * So nothing is placed directly. A settlement centre is found first, the
 * landmark goes on it, then lanes are traced along the local contour across its
 * front and every house is hung off a lane — which is also why neighbours end
 * up parallel without ever being told to be.
 *
 * The village's own lanes are not the road network, and the roads are not routed
 * until the village exists, so the lots have to be settled against them
 * afterwards: `yieldToClaims`.
 */

export type Lot = {
  type: BuildingType;
  x: number;
  z: number;
  /** Finished level of the pad. The builder's origin sits here. */
  pad: number;
  /** Local +z faces this way, which is always towards the lane. */
  yaw: number;
  width: number;
  depth: number;
  storeys: number;
  variant: number;
  /** How far the plinth must reach down to meet the lowest corner. */
  drop: number;
  terrace: boolean;
  /** Circumradius of the footprint. Collision, spawning and roads read this. */
  radius: number;
};

export type TownPlan = { style: TownStyle; lots: Lot[] };

export { styleOf, type TownStyle };

/**
 * The level pad a footprint would be cut to here, or null if the ground will not
 * take one. Cut rather than fill: the pad sits just under the uphill corner, so
 * the bank shows against the plinth instead of the house floating.
 */
const cutPad = (
  terrain: Terrain,
  plot: Plot,
  x: number,
  z: number,
  yaw: number,
  width: number,
  depth: number,
  dry: number
): { pad: number; drop: number } | null => {
  // Half the margin: eaves and stairs may overhang falling ground, so only the
  // part of the clearance that is actually walked on has to be level.
  const ground = padUnder(terrain, x, z, yaw, width + plot.margin * 0.5, depth + plot.margin * 0.5);
  if (ground.low <= dry) return null;
  const drop = ground.high - ground.low;
  if (drop > plot.maxDrop) return null;
  return { pad: ground.high - 0.1, drop: drop + 0.5 };
};

const pickWeighted = (mix: Mix, random: Prng): BuildingType => {
  const total = mix.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = random() * total;
  for (const entry of mix) {
    roll -= entry.weight;
    if (roll <= 0) return entry.type;
  }
  return mix[mix.length - 1].type;
};

export const planTown = (terrain: Terrain, recipe: LocationRecipe, density: number): TownPlan => {
  const style = styleOf(recipe);
  const random = createPrng(`${recipe.seed}:town-plan`);
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const wet = Number.isFinite(waterLevel);
  const dry = wet ? waterLevel + 1.6 : Number.NEGATIVE_INFINITY;
  const half = (terrain.size / 2) * (recipe.town?.spread ?? 0.7);
  const lots: Lot[] = [];
  let variant = 0;
  let probe = 0;

  /**
   * Successive candidate sites walk a golden-angle spiral out from the centre
   * of the map rather than coming straight off the stream. Pure rejection
   * sampling happily puts every settlement on one shore of a lake and leaves
   * the other empty, because nothing in it says "somewhere else this time".
   */
  const nextSeedPoint = (): Point => {
    probe += 1;
    const turn = probe * 2.399963;
    const reach = Math.sqrt(((probe % 29) + 1.5) / 30) * half;
    return {
      x: Math.cos(turn) * reach + (random() - 0.5) * half * 0.22,
      z: Math.sin(turn) * reach + (random() - 0.5) * half * 0.22,
    };
  };

  const clear = (x: number, z: number, radius: number): boolean =>
    lots.every((lot) => Math.hypot(x - lot.x, z - lot.z) > radius + lot.radius);

  const tryLot = (
    type: BuildingType,
    x: number,
    z: number,
    yaw: number,
    plan: SettlementPlan,
    terrace: boolean
  ): Lot | null => {
    const plot = PLOT[type];
    const width = plot.minWidth + random() * (plot.maxWidth - plot.minWidth);
    const depth = plot.minDepth + random() * (plot.maxDepth - plot.minDepth);
    const radius = Math.hypot(width, depth) / 2;

    if (Math.max(Math.abs(x), Math.abs(z)) > terrain.size / 2 - radius - 8) return null;
    if (terrain.slopeAt(x, z) > Math.min(plot.maxSlope, plan.maxSlope)) return null;

    const ground = cutPad(terrain, plot, x, z, yaw, width, depth, dry);
    if (!ground) return null;
    if (!clear(x, z, radius + plot.margin * 0.5)) return null;

    variant += 1;
    const lot: Lot = {
      type,
      x,
      z,
      pad: ground.pad,
      yaw,
      width,
      depth,
      storeys: plot.minStoreys + Math.floor(random() * (plot.maxStoreys - plot.minStoreys + 1)),
      variant,
      drop: ground.drop,
      terrace,
      radius,
    };
    lots.push(lot);
    return lot;
  };

  const settle = (plan: SettlementPlan): boolean => {
    const bandLow = wet ? waterLevel + 3 : Number.NEGATIVE_INFINITY;
    const bandHigh = wet ? waterLevel + plan.bank : Number.POSITIVE_INFINITY;

    let centre: Point | null = null;
    for (let attempt = 0; attempt < 70 && !centre; attempt += 1) {
      const site = seekSite(terrain, nextSeedPoint(), bandLow, bandHigh, random);
      const height = terrain.heightAt(site.x, site.z);
      if (height < bandLow || height > bandHigh) continue;
      if (site.slope > plan.maxSlope * 0.85) continue;
      // Settlements sit well apart, or every one of them lands on the same
      // shoulder and the rest of the map is empty.
      if (!clear(site.x, site.z, plan.lanes * plan.stride * 0.8 + 170)) continue;
      centre = site;
    }
    if (!centre) return false;

    const usable = (x: number, z: number) =>
      Math.max(Math.abs(x), Math.abs(z)) < terrain.size / 2 - 40 &&
      terrain.heightAt(x, z) > dry + 1 &&
      terrain.slopeAt(x, z) < plan.maxSlope * 1.4;

    const base = random() * Math.PI * 2;
    const alongX = Math.cos(base);
    const alongZ = Math.sin(base);
    // The lane normal: lanes run along `along` and are stacked along `out`.
    const outX = -alongZ;
    const outZ = alongX;
    const spacing = plan.setback * 2 + 10;

    const lanes: Lane[] = [];
    for (let i = 0; i < plan.lanes; i += 1) {
      const spread = (i - (plan.lanes - 1) / 2) * spacing;
      const origin = { x: centre.x + outX * spread, z: centre.z + outZ * spread };
      if (!usable(origin.x, origin.z)) continue;

      const forward = traceArm(terrain, origin, { x: alongX, z: alongZ }, plan.nodes, plan.stride, usable);
      const backward = traceArm(terrain, origin, { x: -alongX, z: -alongZ }, plan.nodes, plan.stride, usable);
      const points = [...backward.slice(1).reverse(), ...forward];
      if (points.length < 2) continue;
      lanes.push(makeLane(points));
    }
    if (lanes.length === 0) return false;

    /**
     * Hangs a lot off a lane at the given arclength. The setback is nudged in
     * and out before giving up: a fixed setback on broken ground rejects most
     * of a village, and a lane where every front wall is exactly level with
     * the next is a tell anyway.
     */
    const hangOffLane = (lane: Lane, at: number, side: number, type: BuildingType, terrace: boolean): Lot | null => {
      const here = alongLane(lane, at);
      const plot = PLOT[type];
      const nx = -here.tz * side;
      const nz = here.tx * side;
      // The front (+z) must look back at the lane, so the façade normal is the
      // inward lane normal rather than the outward one.
      const yaw = Math.atan2(-nx, -nz);
      const reach = plan.setback + (plot.minDepth + plot.maxDepth) / 4;

      for (const nudge of [0, 3, -2.5, 7, -4.5, 12]) {
        const lot = tryLot(type, here.x + nx * (reach + nudge), here.z + nz * (reach + nudge), yaw, plan, terrace);
        if (lot) return lot;
      }
      return null;
    };

    // The landmark fronts the outermost lane, where there is room for its
    // courtyard. It goes down before the houses do: placed afterwards it is
    // always rejected, because by then the rows already stand on its forecourt.
    if (plan.landmark) {
      const outer = lanes[lanes.length - 1];
      let placed = false;
      for (let attempt = 0; attempt < 14 && !placed; attempt += 1) {
        const at = (0.2 + random() * 0.6) * outer.length;
        placed = hangOffLane(outer, at, attempt % 2 === 0 ? 1 : -1, plan.landmark, false) !== null;
      }
      // Failing that, take the flattest ground anywhere nearby and face the
      // village. On a ridge there may be no level pad beside a lane at all.
      for (let attempt = 0; attempt < 14 && !placed; attempt += 1) {
        const angle = random() * Math.PI * 2;
        const reach = 50 + random() * 70;
        const site = seekSite(
          terrain,
          { x: centre.x + Math.cos(angle) * reach, z: centre.z + Math.sin(angle) * reach },
          bandLow,
          bandHigh,
          random
        );
        const facing = Math.atan2(centre.x - site.x, centre.z - site.z);
        placed = tryLot(plan.landmark, site.x, site.z, facing, plan, false) !== null;
      }
    }

    for (const extra of plan.extras) {
      for (let i = 0; i < extra.count; i += 1) {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const lane = lanes[Math.floor(random() * lanes.length)];
          const here = alongLane(lane, random() * lane.length);
          const side = random() < 0.5 ? -1 : 1;
          const reach = plan.setback + 19 + random() * 22;
          const nx = -here.tz * side;
          const nz = here.tx * side;
          const placed = tryLot(
            extra.type,
            here.x + nx * reach,
            here.z + nz * reach,
            Math.atan2(-nx, -nz) + (random() - 0.5) * 0.5,
            plan,
            false
          );
          if (placed) break;
        }
      }
    }

    for (const lane of lanes) {
      for (const side of [-1, 1]) {
        let at = 1 + random() * 4;
        let previous = Number.NEGATIVE_INFINITY;
        while (at < lane.length - 1) {
          const type = pickWeighted(plan.street, random);
          const lot = hangOffLane(lane, at, side, type, plan.terrace && at - previous < 9);
          if (lot) previous = at;
          at += (lot?.width ?? PLOT[type].minWidth) + plan.gap;
        }
      }
    }

    return true;
  };

  for (const plan of SETTLEMENTS[style]) {
    const wanted = Math.max(1, Math.round(plan.count * density));
    let built = 0;
    for (let attempt = 0; attempt < wanted * 3 && built < wanted; attempt += 1) {
      if (settle(plan)) built += 1;
    }
  }

  return { style, lots };
};

export type TownYield = { moved: number; dropped: number };

/**
 * Settles the village against ground that turned out to be spoken for. The
 * roads cannot be routed until the village they serve is on the map — the trunk
 * runs to the densest cluster of houses — and the village cannot avoid them
 * until they are routed, so one of the two has to give way afterwards, and it is
 * the houses: a road nudged between two walls has no setback left, and a village
 * with holes punched in it reads worse than one that stepped back.
 *
 * A lot moves off the carriageway keeping its yaw, so a row the road crosses
 * opens out around it instead of losing its members. Measured over the four
 * locations: 18 of 305 houses stood on a road surface, 11 with the centreline
 * through the footprint; afterwards none do, 19 having moved and 2 — both on the
 * Tà Xùa ridge, where there is nowhere to step back to — having gone.
 *
 * Rejecting claimed ground inside `planTown` instead was tried first and also
 * reaches zero, but the lots it refuses reshuffle the stream and every later
 * settlement lands somewhere else, which undoes the roads that were just routed
 * to them: at Tràng An a lane that ended 13 m from a house ended 114 m from one.
 */
export const yieldToClaims = (
  terrain: Terrain,
  recipe: LocationRecipe,
  plan: TownPlan,
  claims: GroundClaims
): TownYield => {
  if (claims.count === 0) return { moved: 0, dropped: 0 };

  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const dry = Number.isFinite(waterLevel) ? waterLevel + 1.6 : Number.NEGATIVE_INFINITY;
  const kept: Lot[] = [];
  let moved = 0;
  let dropped = 0;

  for (const lot of plan.lots) {
    const plot = PLOT[lot.type];
    const standable = (x: number, z: number): { pad: number; drop: number } | null => {
      if (Math.max(Math.abs(x), Math.abs(z)) > terrain.size / 2 - lot.radius - 8) return null;
      if (terrain.slopeAt(x, z) > plot.maxSlope) return null;
      if (claims.pressureAt(x, z, lot.radius, 0) >= 1) return null;
      const gap = lot.radius + plot.margin * 0.5;
      for (const other of plan.lots) {
        if (other === lot) continue;
        if (Math.hypot(x - other.x, z - other.z) <= gap + other.radius) return null;
      }
      return cutPad(terrain, plot, x, z, lot.yaw, lot.width, lot.depth, dry);
    };

    if (claims.pressureAt(lot.x, lot.z, lot.radius, 0) < 1) {
      kept.push(lot);
      continue;
    }

    // Local +z faces the lane, so straight back off the carriageway is local −z
    // and the frontage runs along local x. Nearest displacement first, and back
    // before along before across: across is somebody else's frontage, while
    // along is often the only move left on a ridge, where stepping back climbs
    // into ground too steep to cut a pad from.
    const backX = -Math.sin(lot.yaw);
    const backZ = -Math.cos(lot.yaw);
    const alongX = Math.cos(lot.yaw);
    const alongZ = -Math.sin(lot.yaw);
    let settled = false;
    for (const step of [7, 11, 15, 20, 26, 33]) {
      for (const turn of [0, 0.7, -0.7, 1.3, -1.3, 2, -2]) {
        const outX = backX * Math.cos(turn) + alongX * Math.sin(turn);
        const outZ = backZ * Math.cos(turn) + alongZ * Math.sin(turn);
        const x = lot.x + outX * step;
        const z = lot.z + outZ * step;
        const ground = standable(x, z);
        if (!ground) continue;
        lot.x = x;
        lot.z = z;
        lot.pad = ground.pad;
        lot.drop = ground.drop;
        kept.push(lot);
        moved += 1;
        settled = true;
        break;
      }
      if (settled) break;
    }
    if (!settled) dropped += 1;
  }

  plan.lots = kept;
  return { moved, dropped };
};
