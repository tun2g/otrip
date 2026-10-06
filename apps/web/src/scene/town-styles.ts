import type { LocationRecipe } from '@otrip/world';

import type { BuildingType } from './building-spec';

/**
 * What kind of settlement each location gets, and what is in it. Read off the
 * recipe rather than the slug: a ridge is a highland hamlet, karst is a shore
 * village wedged between the towers, and a lowland town is either an old
 * quarter or a city edge depending on how tall the recipe lets it build.
 */
export type TownStyle = 'highland' | 'oldTown' | 'delta' | 'city';

export const styleOf = (recipe: LocationRecipe): TownStyle => {
  if (recipe.terrain.profile === 'ridge') return 'highland';
  if (recipe.terrain.profile === 'karst') return 'delta';
  return (recipe.town?.maxHeight ?? 0) >= 16 ? 'city' : 'oldTown';
};

export type Mix = { type: BuildingType; weight: number }[];

export type SettlementPlan = {
  /** How many of this kind of settlement to try for. */
  count: number;
  lanes: number;
  /** Nodes per lane arm; a lane is traced both ways from its origin. */
  nodes: number;
  /** Metres between lane nodes. */
  stride: number;
  /** Gap left between neighbours along the lane. */
  gap: number;
  /** From the lane centre line to the front wall. */
  setback: number;
  street: Mix;
  /** The one building the settlement is arranged around, at its centre. */
  landmark: BuildingType | null;
  extras: { type: BuildingType; count: number }[];
  /** Houses share party walls, so a row reads as one terrace. */
  terrace: boolean;
  /** Keep within this many metres above the water line. Infinity ignores it. */
  bank: number;
  maxSlope: number;
};

const OLD_TOWN_ROW: Mix = [
  { type: 'nha-ong', weight: 5 },
  { type: 'nha-co', weight: 5 },
];

/**
 * The outlying hamlets get a miếu.
 *
 * Every style's first plan is the one settlement with something at its centre —
 * an đình, a chùa, a nhà rông — and every later plan carried `landmark: null`,
 * so the four to eleven other hamlets each map builds were houses, a granary and
 * a pen. Walking out to one arrived at buildings rather than at a place. A miếu
 * is the right size and the right register for a hamlet (see
 * `building-shrine.ts`), and `PLOT.mieu` is slack enough on slope to stand on a
 * ridge, which `PLOT.dinh` is not.
 */
export const SETTLEMENTS: Record<TownStyle, SettlementPlan[]> = {
  highland: [
    {
      count: 1,
      lanes: 2,
      nodes: 4,
      stride: 13,
      gap: 5,
      setback: 7,
      street: [{ type: 'nha-san', weight: 1 }],
      landmark: 'nha-rong',
      extras: [
        { type: 'granary', count: 3 },
        { type: 'pen', count: 2 },
        { type: 'drying-yard', count: 1 },
      ],
      terrace: false,
      bank: Number.POSITIVE_INFINITY,
      maxSlope: 0.46,
    },
    {
      count: 6,
      lanes: 1,
      nodes: 3,
      stride: 12,
      gap: 5.5,
      setback: 6.5,
      street: [{ type: 'nha-san', weight: 1 }],
      landmark: 'mieu',
      extras: [
        { type: 'granary', count: 2 },
        { type: 'pen', count: 1 },
      ],
      terrace: false,
      bank: Number.POSITIVE_INFINITY,
      maxSlope: 0.5,
    },
  ],
  oldTown: [
    {
      count: 1,
      lanes: 4,
      nodes: 5,
      stride: 11,
      gap: 0.5,
      setback: 5.5,
      street: OLD_TOWN_ROW,
      landmark: 'chua',
      extras: [
        { type: 'market', count: 1 },
        { type: 'dinh', count: 1 },
      ],
      terrace: true,
      bank: 13,
      maxSlope: 0.2,
    },
    {
      count: 4,
      lanes: 1,
      nodes: 3,
      stride: 12,
      gap: 3.5,
      setback: 6,
      street: [
        { type: 'nha-ong', weight: 3 },
        { type: 'nha-co', weight: 2 },
      ],
      landmark: 'mieu',
      extras: [
        { type: 'drying-yard', count: 1 },
        { type: 'pen', count: 1 },
        { type: 'granary', count: 1 },
      ],
      terrace: false,
      bank: 30,
      maxSlope: 0.26,
    },
  ],
  // Tràng An is 88% water and what is left is tower flank: nothing bigger than
  // a one-lane hamlet fits, so the delta village is a shore village instead.
  delta: [
    {
      count: 1,
      lanes: 2,
      nodes: 3,
      stride: 11,
      gap: 2.5,
      setback: 6,
      street: [
        { type: 'nha-san', weight: 3 },
        { type: 'nha-ong', weight: 4 },
        { type: 'nha-co', weight: 3 },
      ],
      landmark: 'dinh',
      extras: [{ type: 'market', count: 1 }],
      terrace: true,
      bank: 24,
      maxSlope: 0.46,
    },
    {
      count: 16,
      lanes: 1,
      nodes: 4,
      stride: 11,
      gap: 3.5,
      setback: 6,
      // Weighted hard towards nhà sàn because the ground decides: a tower
      // flank will take a house on posts and nothing else.
      street: [
        { type: 'nha-san', weight: 7 },
        { type: 'nha-ong', weight: 2 },
        { type: 'nha-co', weight: 1 },
      ],
      landmark: 'mieu',
      extras: [
        { type: 'drying-yard', count: 1 },
        { type: 'granary', count: 1 },
        { type: 'pen', count: 1 },
      ],
      terrace: false,
      bank: 46,
      maxSlope: 0.52,
    },
  ],
  city: [
    {
      count: 2,
      lanes: 3,
      nodes: 4,
      stride: 22,
      gap: 1.2,
      setback: 10,
      street: [
        { type: 'block', weight: 5 },
        { type: 'nha-ong', weight: 4 },
      ],
      landmark: 'chua',
      extras: [{ type: 'market', count: 1 }],
      terrace: true,
      bank: 34,
      maxSlope: 0.24,
    },
    {
      count: 3,
      lanes: 2,
      nodes: 3,
      stride: 16,
      gap: 0.8,
      setback: 7,
      street: [
        { type: 'nha-ong', weight: 7 },
        { type: 'block', weight: 2 },
      ],
      landmark: 'mieu',
      extras: [],
      terrace: true,
      bank: 50,
      maxSlope: 0.28,
    },
  ],
};
