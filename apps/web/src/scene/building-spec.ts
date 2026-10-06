import type { Prng } from '@otrip/world';

import type { BuildSink, BuildingKit } from './building-kit';

/**
 * What a planner hands a builder. The builder never learns where in the world
 * it is: the sink it is given already stands on the pad and faces the lane, so
 * everything inside a builder is local metres with the front at +z.
 */

export type BuildingType =
  | 'nha-ong'
  | 'nha-co'
  | 'nha-san'
  | 'block'
  | 'dinh'
  | 'nha-rong'
  | 'chua'
  | 'mieu'
  | 'market'
  | 'granary'
  | 'pen'
  | 'drying-yard';

export type BuildSpec = {
  /** Frontage, along local x. */
  width: number;
  /** Depth of the plan, along local z, front face at +depth/2. */
  depth: number;
  storeys: number;
  /** How far the plinth has to reach down to meet the lowest corner of the pad. */
  drop: number;
  /** Houses either side, so the flank walls are party walls and stay blank. */
  terrace: boolean;
  variant: number;
  random: Prng;
};

/** Returns the height of the highest part, which is what collision needs. */
export type Builder = (sink: BuildSink, kit: BuildingKit, spec: BuildSpec) => number;
