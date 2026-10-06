/**
 * Every destination is the same engine driven by a different recipe. Adding a
 * location means adding a recipe, not adding rendering code.
 *
 * Heights are in metres above the valley floor, not above sea level: the scene
 * only ever needs relief, and a relative space keeps `cloudSea.altitude`
 * readable (180 means "clouds fill the valleys 180m deep").
 */

/**
 * Surface albedo. Constant: the time of day belongs to the lighting, not the paint.
 *
 * These are authored with real chroma on purpose. The first set was far too
 * grey to survive being rendered — Hội An's valley colour was `#8a8a5c` and Hồ
 * Tây's ridge `#9a9a86`, both with red exactly equal to green, which is khaki
 * rather than anything that grows. Measured end to end, a sunlit hillside came
 * back at 5-9% saturation against a target of 25-35%, and disabling aerial
 * perspective entirely only lifted it to 17.8%, because 17.8% was all the
 * albedo ever had. Light cannot add chroma a surface does not have, so no
 * amount of tuning downstream could reach the target while these stayed grey.
 *
 * Rock is the deliberate exception and stays near neutral: weathered limestone
 * and granite really are grey, and saturating them makes a mountain look like a
 * painted set.
 */
export type GroundPalette = {
  low: string;
  mid: string;
  high: string;
  rock: string;
  foliage: string;
  roof: string;
};

/** Everything that changes as the sun moves. One set per keyframe of the day. */
export type SkyPalette = {
  zenith: string;
  horizon: string;
  sunCore: string;
  sunGlow: string;
  cloudLit: string;
  cloudShadow: string;
  fog: string;
};

export type SkyPalettes = {
  night: SkyPalette;
  dawn: SkyPalette;
  day: SkyPalette;
};

/**
 * How the raw noise becomes land. Each profile is a different place on earth,
 * not a different generator: ridges for a mountain range, isolated towers for
 * karst, a near-flat plain for a delta town.
 */
export type TerrainProfile = 'ridge' | 'karst' | 'lowland';

/** A sinuous channel cut through the heightfield, which water then fills. */
export type RiverParams = {
  /** How far the channel swings away from the centre line, in metres. */
  amplitude: number;
  /** Swings per map width. */
  waves: number;
  /** Half-width of the channel bed, in metres. */
  width: number;
  /** How deep the bed is cut, in metres. */
  depth: number;
  /** true runs the channel along X instead of Z. */
  alongX: boolean;
};

/**
 * A closed body of water: a hollow pressed into the heightfield that stops short
 * of the patch border, so the land goes round it.
 *
 * `river` cannot be one. Its channel is `|across - centre| < width` with the
 * centre a sine of the along-axis, which has no ending — it crosses the patch
 * whatever the amplitude, and Hồ Tây was built with one. Measured on the shipped
 * recipe (`amplitude: 0, width: 990` over a 4200 m patch): the water ran edge to
 * edge and the map was two landmasses, 5.54 km² of west bank carrying 73 of 105
 * houses against 5.11 km² of east carrying the other 32, with 1325 m of water
 * between them at the narrowest row — against a `BRIDGE_LIMIT` of 440 m in
 * `road-network`. A third of the town was on an island nobody could reach, which
 * is what a player saw when they opened the world map and asked why the other
 * half was chán. The real Hồ Tây is a lake in the middle of Hanoi with city on
 * every side of it, so a basin is not a liberty taken with the place; a channel
 * was.
 *
 * Nothing says "lake" in the type on purpose — it is a hollow, and whether water
 * stands in it is decided by `WaterParams.level` the same way a carved channel
 * becomes a river for free.
 */
export type BasinParams = {
  /** Centre of the hollow, in metres from the middle of the patch. */
  x: number;
  z: number;
  /** Mean radius of the rim — where the hollow stops, not the waterline. */
  radius: number;
  /** Metres the floor is cut below the ground that would otherwise be there. */
  depth: number;
  /**
   * Metres of shelving between the rim and the full cut. The waterline lands
   * somewhere inside this band rather than on the rim, and because the ground it
   * is cut from already varies with the massif, that is what makes the shore
   * wander instead of being a drawn circle.
   */
  shore: number;
  /** How far the rim wanders, as a fraction of `radius`. 0 is a dinner plate. */
  wobble: number;
  /** Ellipse: above 1 stretches the hollow along X. Hồ Tây is wider than it is tall. */
  stretch: number;
};

export type TerrainParams = {
  profile: TerrainProfile;
  /** Width and depth of the generated patch, in metres. */
  size: number;
  /** Grid divisions per side. Renderers may sample fewer on weak devices. */
  segments: number;
  /** Relief from valley floor to the highest ridge, in metres. */
  maxHeight: number;
  /** Noise frequency driving the main ridge lines. Smaller = broader ridges. */
  ridgeFrequency: number;
  /** Noise frequency for surface roughness. */
  detailFrequency: number;
  /** 0 = rolling hills, 1 = pure knife-edge ridges. */
  ridgeWeight: number;
  /** <1 stretches ridgelines along X, so the range flows instead of pimpling. */
  ridgeStretch: number;
  /** Box-blur passes over the heightfield, to kill needles at grid scale. */
  smoothing: number;
  /**
   * Fraction of the half-extent at which the land starts sinking, so the patch
   * ends below the cloud line instead of showing a square cliff at the border.
   * 1 disables it.
   */
  edgeFalloff: number;
  /** Floor added before shaping, so a delta is not a valley with no ground. */
  baseHeight: number;
  river: RiverParams | null;
  basin: BasinParams | null;
};

/**
 * A still surface that hides whatever the terrain does below it. The renderer
 * samples the heightfield, so the shoreline follows the land rather than being
 * drawn by hand — a carved channel becomes a river for free.
 */
export type WaterParams = {
  /** Surface height in the same metres as the terrain. */
  level: number;
  deep: string;
  shallow: string;
  /** 0 glassy, 1 choppy. */
  ripple: number;
};

/**
 * Buildings laid out in blocks rather than scattered, for places where people
 * built along streets. Lanterns light up once the sun is down.
 */
export type TownParams = {
  blocks: number;
  perBlock: number;
  /** Metres. Old towns are low, a city edge is not. */
  minHeight: number;
  maxHeight: number;
  /** Extent of the built-up area as a fraction of the map half-width. */
  spread: number;
  wall: string;
  roof: string;
  lanterns: boolean;
};

/**
 * Đường sắt Việt Nam, where there is any. Most of the country has none: the
 * network is one main line down the coast plus a handful of lines out of Hanoi,
 * and whole provinces are nowhere near it. A location carries this only when a
 * line plausibly runs across the patch, which is why it is nullable and why two
 * of the four are null — see `locations.ts` for the reason in each case.
 *
 * Gauge is not a parameter: every line in the country the scene could be
 * depicting is metre gauge.
 */
export type RailwayParams = {
  /** Carriages behind the locomotive. */
  carriages: number;
  /**
   * Mean seconds between trains. Compressed from the real timetable — the main
   * line runs a train each way every hour or so and nobody is going to wait
   * that long — but the ordering is real: Hanoi sees more than a provincial
   * halt does.
   */
  headway: number;
  /** Whether there is a halt here, with a platform and a station stop. */
  station: boolean;
};

/**
 * Somewhere worth walking to. The coordinates are not written down — a
 * procedural map would make them wrong the moment a parameter changed — so each
 * one names a rule the terrain is searched for, and carries the words a visitor
 * reads when they arrive.
 */
export type PoiKind = 'summit' | 'shore' | 'island' | 'town' | 'grove' | 'valley';

export type PoiRecipe = {
  id: string;
  name: string;
  kind: PoiKind;
  note: string;
};

export type CloudSeaParams = {
  /** Height of the top of the cloud layer, in metres above the valley floor. */
  altitude: number;
  /** Vertical extent of the layer. */
  thickness: number;
  /** Stacked planes used to fake volume. */
  layers: number;
};

export type ScatterParams = {
  trees: number;
  houses: number;
  /** Trees stop growing above this height, in metres. */
  treeLine: number;
};

/**
 * What is grown on the open ground, which is a fact about the place and not
 * about its heightfield. Ruộng bậc thang is highland cultivation: you cut steps
 * because the hill is too steep to farm otherwise, and you only do that work
 * where there is nothing flatter within walking distance. A delta has flat
 * ground, so it grows flat paddy; a city lakeshore grows neither.
 *
 * This is a recipe field rather than something derived from the terrain because
 * every derivation tried was wrong. Gating on slope alone put 25 steps of
 * ruộng bậc thang on a 24% knoll three kilometres from Hội An's beach and 28
 * steps up the flank of a limestone tower at Tràng An, both measured; gating on
 * `water` keeps the one at Hồ Tây, which has the most water of the four. The
 * question is not how steep the ground is, it is whether anyone here farms that
 * way, and only the location knows that.
 *
 * - `terrace` — stepped beds cut into a hillside. Northern highlands.
 * - `paddy` — level bunded plots on near-flat ground, with the bund only as
 *   high as the ground's own fall across one plot.
 * - `none` — no field crops on the open ground at all.
 */
export type FarmingKind = 'terrace' | 'paddy' | 'none';

/**
 * What flies here besides the airliners, which cross everywhere and belong to
 * nobody. Balloon tourism in Vietnam happens at a handful of named places and
 * nowhere else: Tràng An runs the Tràng An–Cúc Phương festival out of its own
 * culture park, Hội An's old town is on the short list of festival sites, and
 * Hanoi's balloons fly from vườn nhãn Long Biên by cầu Vĩnh Tuy — the far side
 * of the city from Tây Hồ. A knife-edge ridge has no balloon and never will:
 * there is nowhere to land one. It has the paraglider instead, which is the
 * thing people actually do off a ridge in cloud.
 *
 * Gated here rather than in the renderer because the old test was
 * `recipe.slug === 'ta-xua'`, and a slug test is the thing this file exists to
 * replace — it cannot be answered by a fifth location without editing code.
 */
export type AloftKind = 'paraglider' | 'balloon' | 'none';

export type LocationRecipe = {
  slug: string;
  name: string;
  region: string;
  /** One paragraph of real text per location — the only thing a crawler can read. */
  description: string;
  /** Fixed seed. Changing it regenerates the world, so it is part of the data. */
  seed: string;
  /** Real coordinates — the live weather layer reads them. */
  coords: { lat: number; lon: number; elevation: number };
  terrain: TerrainParams;
  cloudSea: CloudSeaParams | null;
  water: WaterParams | null;
  /** Places to find on foot. The scene resolves each to real coordinates. */
  pois: PoiRecipe[];
  town: TownParams | null;
  railway: RailwayParams | null;
  scatter: ScatterParams;
  farming: FarmingKind;
  aloft: AloftKind;
  ground: GroundPalette;
  skies: SkyPalettes;
  audio: {
    ambience: string[];
    music: string[];
  };
};
