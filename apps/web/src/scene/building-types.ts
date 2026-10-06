import { buildVillageHall, buildCommunalHouse } from './building-civic';
import { buildBlock, buildTubeHouse } from './building-houses';
import { buildPagoda } from './building-pagoda';
import { buildAnimalPen, buildDryingYard, buildGranary, buildMarketShed } from './building-sheds';
import type { Builder, BuildingType } from './building-spec';
import { buildOldTownHouse } from './building-old-town';
import { buildShrine } from './building-shrine';
import { buildStiltHouse } from './building-stilt';

/**
 * Which builder makes which type, and how much ground each one needs. The
 * planner reads `PLOT` to lay out a village before any geometry exists, so the
 * two must agree: a chùa given a house's plot would build its courtyard
 * through its neighbours.
 */
export const BUILDERS: Record<BuildingType, Builder> = {
  'nha-ong': buildTubeHouse,
  'nha-co': buildOldTownHouse,
  'nha-san': buildStiltHouse,
  block: buildBlock,
  dinh: buildVillageHall,
  'nha-rong': buildCommunalHouse,
  chua: buildPagoda,
  mieu: buildShrine,
  market: buildMarketShed,
  granary: buildGranary,
  pen: buildAnimalPen,
  'drying-yard': buildDryingYard,
};

export type Plot = {
  /** Frontage, in metres. The planner jitters between the two. */
  minWidth: number;
  maxWidth: number;
  minDepth: number;
  maxDepth: number;
  minStoreys: number;
  maxStoreys: number;
  /** Clear ground to leave beyond the footprint, for eaves, stairs and yards. */
  margin: number;
  /** Steepest ground this type will stand on, as a terrain gradient. */
  maxSlope: number;
  /**
   * Biggest height difference across the footprint the plinth can swallow. A
   * nhà sàn stands on posts and barely cares; a market slab has to be level.
   */
  maxDrop: number;
};

export const PLOT: Record<BuildingType, Plot> = {
  'nha-ong': {
    minWidth: 4,
    maxWidth: 5.6,
    minDepth: 11,
    maxDepth: 17,
    minStoreys: 2,
    maxStoreys: 4,
    margin: 0.6,
    maxSlope: 0.3,
    maxDrop: 2.6,
  },
  'nha-co': {
    minWidth: 5.4,
    maxWidth: 7.6,
    minDepth: 12,
    maxDepth: 19,
    minStoreys: 2,
    maxStoreys: 2,
    margin: 1.4,
    maxSlope: 0.24,
    maxDrop: 2.4,
  },
  'nha-san': {
    minWidth: 7,
    maxWidth: 9.5,
    minDepth: 5.5,
    maxDepth: 7.2,
    minStoreys: 1,
    maxStoreys: 1,
    margin: 2.6,
    maxSlope: 0.56,
    maxDrop: 4.6,
  },
  block: {
    minWidth: 13,
    maxWidth: 22,
    minDepth: 10,
    maxDepth: 14,
    minStoreys: 4,
    maxStoreys: 7,
    margin: 1.2,
    maxSlope: 0.26,
    maxDrop: 2.4,
  },
  dinh: {
    minWidth: 14,
    maxWidth: 18,
    minDepth: 15,
    maxDepth: 20,
    minStoreys: 1,
    maxStoreys: 1,
    margin: 2,
    maxSlope: 0.28,
    maxDrop: 3.2,
  },
  'nha-rong': {
    minWidth: 13,
    maxWidth: 16,
    minDepth: 14,
    maxDepth: 18,
    minStoreys: 1,
    maxStoreys: 1,
    margin: 2,
    maxSlope: 0.44,
    maxDrop: 5,
  },
  chua: {
    minWidth: 22,
    maxWidth: 27,
    minDepth: 28,
    maxDepth: 34,
    minStoreys: 1,
    maxStoreys: 1,
    margin: 2.4,
    maxSlope: 0.18,
    maxDrop: 2.6,
  },
  /**
   * Mostly sân. The shrine itself is 2.4 m across inside this, and the rest is
   * the forecourt with its two pillars — which is why the plot is deeper than it
   * is wide. The slope and drop allowances are a nhà sàn's rather than an đình's
   * on purpose: a miếu is the one built thing that has to be placeable on the
   * Tà Xùa ridge, where `PLOT.dinh`'s 0.28 gradient rules out most of the
   * mountain and a hamlet with nothing at its centre was the thing to fix.
   */
  mieu: {
    minWidth: 3.6,
    maxWidth: 4.6,
    minDepth: 5,
    maxDepth: 6.4,
    minStoreys: 1,
    maxStoreys: 1,
    margin: 1.6,
    maxSlope: 0.5,
    maxDrop: 3.4,
  },
  market: {
    minWidth: 13,
    maxWidth: 19,
    minDepth: 8,
    maxDepth: 11,
    minStoreys: 1,
    maxStoreys: 1,
    margin: 2.2,
    maxSlope: 0.22,
    maxDrop: 1.8,
  },
  granary: {
    minWidth: 2.6,
    maxWidth: 3.4,
    minDepth: 2.2,
    maxDepth: 2.8,
    minStoreys: 1,
    maxStoreys: 1,
    margin: 1.2,
    maxSlope: 0.6,
    maxDrop: 2.6,
  },
  pen: {
    minWidth: 6,
    maxWidth: 8,
    minDepth: 4.5,
    maxDepth: 6,
    minStoreys: 1,
    maxStoreys: 1,
    margin: 1,
    maxSlope: 0.44,
    maxDrop: 2.2,
  },
  'drying-yard': {
    minWidth: 8,
    maxWidth: 12,
    minDepth: 6,
    maxDepth: 9,
    minStoreys: 1,
    maxStoreys: 1,
    margin: 1,
    maxSlope: 0.22,
    maxDrop: 2.4,
  },
};
