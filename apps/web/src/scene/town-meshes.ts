import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import { Group } from 'three';

import { createBuildingKit } from './building-kit';
import { BUILDERS } from './building-types';
import { planTown, type TownPlan, type TownStyle } from './town-plan';

/** Where a building stands and how wide it is, for spawning and camera checks. */
export type Building = {
  x: number;
  z: number;
  /**
   * Half the footprint's diagonal — the circle that *circumscribes* the plan, so
   * its corners are empty air. Keep it for cheap broad-phase rejection, but
   * anything that cares where the wall actually is should use the rectangle
   * below: a camera grazing this circle by centimetres is grazing nothing.
   */
  radius: number;
  top: number;
  /** The real footprint. Local +z faces `yaw`, which is always toward the lane. */
  width: number;
  depth: number;
  yaw: number;
};

export type TownMeshes = {
  group: Group;
  buildings: Building[];
  /** Only the flickering materials move; the geometry is static. */
  update: (elapsed: number) => void;
  /** Windows, shopfronts, lanterns and signs light from inside after dusk. */
  setNight: (amount: number) => void;
  /** Hands the roofs, walls and paving the rain's wetness. Call once, with `rain.wetUniform`. */
  setWet: (wet: { value: number }) => void;
  dispose: () => void;
  /** Which kind of settlement the recipe asked for. Reported by the probe. */
  style: TownStyle;
  /** How many of each building type were actually built. */
  mix: Record<string, number>;
};

export type TownOptions = {
  /** Scales how many settlements are attempted. 1 is the authored density. */
  density?: number;
  /**
   * A plan made earlier, so the roads can be routed to the village and the
   * village can then be settled with the carriageway. Planning here instead
   * means the lots are fixed before any road exists, which is how houses came
   * to stand in the middle of one.
   */
  plan?: TownPlan;
};

/**
 * The town: real Vietnamese building types, each modelled once and chosen per
 * location, laid out along lanes by `planTown` and collapsed into one
 * InstancedMesh per geometry/material pair by the kit. Called at every
 * location — a highland ridge gets a nhà sàn hamlet, a karst delta gets a
 * village with an đình, so there is nothing to guard on.
 */
export const createTownMeshes = (terrain: Terrain, recipe: LocationRecipe, options?: TownOptions): TownMeshes => {
  const plan = options?.plan ?? planTown(terrain, recipe, options?.density ?? 1);
  const kit = createBuildingKit(recipe);
  const group = new Group();
  group.name = 'town';

  const buildings: Building[] = [];
  const mix: Record<string, number> = {};

  for (const lot of plan.lots) {
    const sink = kit.frame(lot.x, lot.pad, lot.z, lot.yaw);
    const top = BUILDERS[lot.type](sink, kit, {
      width: lot.width,
      depth: lot.depth,
      storeys: lot.storeys,
      drop: lot.drop,
      terrace: lot.terrace,
      variant: lot.variant,
      // Seeded per lot rather than per town, so adding a building upstream does
      // not reshuffle the details of every building after it.
      random: createPrng(`${recipe.seed}:building:${lot.variant}`),
    });

    buildings.push({
      x: lot.x,
      z: lot.z,
      radius: lot.radius,
      top: lot.pad + top,
      width: lot.width,
      depth: lot.depth,
      yaw: lot.yaw,
    });
    mix[lot.type] = (mix[lot.type] ?? 0) + 1;
  }

  for (const mesh of kit.assemble()) group.add(mesh);

  return {
    group,
    buildings,
    style: plan.style,
    mix,
    update: kit.update,
    setNight: kit.setNight,
    setWet: kit.setWet,
    dispose: () => {
      group.clear();
      kit.dispose();
    },
  };
};
