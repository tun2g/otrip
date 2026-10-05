/**
 * Weather you can ask for, on top of the weather that is actually happening.
 *
 * The scene runs on a real 48-hour forecast, which means a week of clear nights
 * is a week in which the rain preset does not exist and an overcast one is a
 * week without a moon. These presets are the escape hatch, and every one of them
 * is a lie the UI has to admit to — see `weather-picker.tsx`.
 */
import type { SkyConditions } from '@otrip/contracts';
import type { LocationRecipe } from '@otrip/world';

import { deriveWorldWeather, type WeatherInput, type WorldWeather } from '@/scene/weather-state';

export type WeatherPresetId = 'that' | 'quang' | 'nhieu-may' | 'bien-may' | 'mua' | 'bao' | 'suong-mu' | 'dem-trang';

/**
 * Something the destination itself has to have. Read off the recipe rather than
 * keyed by slug, the same way `lib/draw.ts` does it, so a fifth destination
 * answers for itself the moment its recipe exists.
 */
export type PlaceRequirement = {
  /** Which recipe field decides it. For the test table, not for the screen. */
  reason: string;
  met: (recipe: LocationRecipe) => boolean;
};

/** Where the sun really is at the chosen hour. No preset is allowed to forge it. */
export type SunHour = {
  /** 0 by day .. 1 at full dark. */
  night: number;
  /** 0 .. 1, `clamp01((elevation + 6) / 14)` — so 0.4 is the sun on the horizon. */
  daylight: number;
};

/**
 * Something the chosen *hour* has to give, as opposed to something the place has
 * to have. An hour is one drag of the slider away, so this condition never
 * removes the chip: it labels it and says what to do.
 */
export type HourRequirement = {
  /** Two words beside the preset's name on the chip. */
  badge: string;
  met: (sun: SunHour) => boolean;
  /** What the scene cannot give and what to drag the slider to, in Vietnamese. */
  shortfall: string;
};

export type WeatherPreset = {
  id: WeatherPresetId;
  label: string;
  /** One line for the chip: what you will actually be looking at. */
  note: string;
  /**
   * A forecast hour that never happened, or `null` to leave the real one alone.
   *
   * Stated as a `WeatherInput` and never as a finished `WorldWeather`, because
   * every consistency rule the scene leans on lives inside `deriveWorldWeather`:
   * rain forcing the deck above it thick, a thunderstorm pinning the occlusion
   * past what the cloud fields claim, the decks stacking rather than adding.
   * Writing the fifteen output numbers by hand means maintaining those rules by
   * hand, and the first thing to break is rain falling out of a clear sky — the
   * exact bug `weather-state.ts` was written to make impossible.
   */
  override: WeatherInput | null;
  /**
   * What the chosen hour has to give, or `null` when any hour will do. Note that
   * no preset carries `night` or `daylight` of its own: those come from the sun's
   * real position at the chosen hour, and a preset allowed to forge them would
   * turn midday into midnight the moment someone picked "Quang".
   */
  needsHour: HourRequirement | null;
  /**
   * What the place must have, or `null` when the preset works anywhere.
   *
   * Not the same kind of condition as `needsHour`, and it cannot be presented
   * the same way. An hour the user has not reached is one drag of the slider
   * away, so saying "kéo thanh giờ tới sau khi mặt trời lặn" is advice they can
   * act on. Nothing in this app moves Hồ Tây to Tà Xùa, so the equivalent
   * sentence is not advice, it is an advertisement for somewhere else. A preset
   * whose requirement the place fails is therefore not offered at all —
   * `presetsFor` drops it — rather than offered greyed out: a chip that can
   * never work here is exactly the `lib/draw.ts` bug with a button on it.
   */
  needsPlace: PlaceRequirement | null;
};

/**
 * Below this `night` the moon is arithmetic rather than a sight. The disc is
 * `3.0 * uNight * clear` (`scene/sky-dome.ts:166`) and `night` is `-elevation/8`,
 * so the tempting `night > 0` test — sun a hair under the horizon, `night ≈ 0.01`
 * — leaves it at 3% against a sky that is still daylight blue. At 0.3 the sun is
 * 2.4° down and the disc reaches ~0.9, which reads.
 */
export const NIGHT_FOR_MOON = 0.3;

const NEEDS_NIGHT: HourRequirement = {
  badge: 'cần đêm',
  met: (sun) => sun.night >= NIGHT_FOR_MOON,
  shortfall: 'Giờ đang chọn trời còn sáng nên chưa có trăng. Kéo thanh giờ tới sau khi mặt trời lặn.',
};

/**
 * Above this the deck has sunk out of sight of anyone standing on the ridge.
 *
 * `cloud-sea.ts:656` burns the inversion off with `smoothstep(0.4, 0.95, daylight)`,
 * and `daylight` is `(elevation + 6) / 14`, so the burn starts the moment the sun
 * clears the horizon and is complete by +7°. Measured at Tà Xùa, walking, seed
 * `ta-xua-v1`: at 06:00 (elevation +1.3°, daylight 0.52) the deck rests at 323 m
 * against ground of 376 m at the spawn and the sea is right there at your feet;
 * at 13:00 (daylight 1) it has dropped to 257 m, which is 119 m below your feet
 * and behind the near slope — a raymarch of every sightline from the spawn found
 * cloud in a sliver at the horizon and nowhere else. The deck goes out of reach
 * when it falls more than one shoreline feather (72 m, `uShoreFeather`) below the
 * ground you stand on, which is 304 m here — daylight 0.63.
 *
 * The overview camera sits at ~1270 m and still sees the sea perfectly at midday,
 * which is why this labels the chip instead of removing it.
 */
export const DAYLIGHT_FOR_CLOUD_SEA = 0.65;

const NEEDS_DAWN: HourRequirement = {
  badge: 'cần rạng sáng',
  met: (sun) => sun.daylight < DAYLIGHT_FOR_CLOUD_SEA,
  // Names the chip in `sky-controls.tsx:218` rather than the slider: that one is
  // a single tap onto the right hour, and the slider moves in whole hours while
  // the window this preset needs is about one of them wide. The sentence still
  // reads on the rare hour that chip is absent — it says where to go, not only
  // what to press.
  shortfall:
    'Mặt trời lên là biển mây tan dần xuống đáy thung lũng — ngắm từ trên cao thì vẫn còn, nhưng đứng dưới đất sẽ không thấy gì. Bấm "Xem bình minh tới" để quay về giờ còn biển mây.',
};

/**
 * `world-renderer.ts:447` builds a cloud sea only where `recipe.cloudSea` is set,
 * and three of the four destinations have it `null`. Without this the preset was
 * a button at Hội An, Tràng An and Hồ Tây that invited you to watch the renderer
 * draw nothing — the same false promise `lib/draw.ts` exists to have killed, and
 * a worse form of it, because prose only describes while a chip asks to be
 * pressed.
 */
const HAS_CLOUD_SEA: PlaceRequirement = {
  reason: 'recipe.cloudSea == null — không có createCloudSea nào được dựng',
  met: (recipe) => recipe.cloudSea != null,
};

const REAL: WeatherPreset = {
  id: 'that',
  label: 'Thật',
  note: 'dự báo thật của giờ đã chọn',
  override: null,
  needsHour: null,
  needsPlace: null,
};

export const WEATHER_PRESETS: readonly WeatherPreset[] = [
  REAL,
  {
    id: 'quang',
    label: 'Quang',
    note: 'trời trong; đêm thì đầy sao',
    override: {
      cloudCover: 8,
      lowCloudCover: 2,
      midCloudCover: 3,
      highCloudCover: 8,
      precipitation: 0,
      windSpeed: 7,
      windDirection: 120,
      humidity: 60,
      visibility: 24_000,
      weatherCode: 0,
    },
    needsHour: null,
    needsPlace: null,
  },
  {
    id: 'nhieu-may',
    label: 'Nhiều mây',
    note: 'kín trời, chưa mưa',
    override: {
      cloudCover: 94,
      lowCloudCover: 82,
      midCloudCover: 72,
      highCloudCover: 45,
      precipitation: 0,
      windSpeed: 15,
      windDirection: 70,
      humidity: 86,
      visibility: 11_000,
      weatherCode: 3,
    },
    needsHour: null,
    needsPlace: null,
  },
  {
    id: 'bien-may',
    label: 'Biển mây',
    note: 'rạng sáng, mây lấp thung lũng dưới chân',
    // The one preset the single `skyOcclusion` number cannot say honestly: a
    // cloud sea is low cloud *below* the viewer, and `deriveWorldWeather` can
    // only read `lowCloudCover` as sky taken away. A first pass at 85% low cloud
    // got a thick sea under an occlusion of 0.90, which killed the sunrise glow
    // that is the entire reason anyone climbs up there. The sea in
    // `cloud-sea.ts:651` is `0.2 + cloudLow*0.5 + moisture*0.46 - gust*0.3`, so
    // saturated still air buys coverage at no cost in sky: humidity 96 and 2 km/h
    // reach ~0.84 coverage with the occlusion left near 0.45.
    override: {
      cloudCover: 55,
      lowCloudCover: 42,
      midCloudCover: 3,
      highCloudCover: 8,
      precipitation: 0,
      windSpeed: 2,
      windDirection: 150,
      humidity: 96,
      visibility: 16_000,
      weatherCode: 2,
    },
    needsHour: NEEDS_DAWN,
    needsPlace: HAS_CLOUD_SEA,
  },
  {
    id: 'mua',
    label: 'Mưa',
    note: 'mưa vừa, đường ướt',
    override: {
      cloudCover: 100,
      lowCloudCover: 86,
      midCloudCover: 80,
      highCloudCover: 40,
      precipitation: 4.5,
      windSpeed: 18,
      windDirection: 200,
      humidity: 94,
      visibility: 5_000,
      weatherCode: 63,
    },
    needsHour: null,
    needsPlace: null,
  },
  {
    id: 'bao',
    label: 'Bão',
    note: 'sấm, gió 62 km/h',
    // `storm` is scaled by `0.5 + clamp01(windSpeed/55) * 0.5`, so anything under
    // 55 km/h caps the lightning and the gusts short of full violence however
    // hard it is raining. 62 is a real tropical-storm figure at 10 m and lands
    // the multiplier exactly on 1.
    override: {
      cloudCover: 100,
      lowCloudCover: 92,
      midCloudCover: 95,
      highCloudCover: 60,
      precipitation: 14,
      windSpeed: 62,
      windDirection: 220,
      humidity: 97,
      visibility: 2_200,
      weatherCode: 95,
    },
    needsHour: null,
    needsPlace: null,
  },
  {
    id: 'suong-mu',
    label: 'Sương mù',
    note: 'đứng trong mây, nhìn 420 m',
    // 420 m is an extinction of 3.912/420 per metre in `present-pass.ts`, which
    // veils about 60% of a ridge 100 m away — thick enough to be fog and open
    // enough that there is still a landscape in there.
    override: {
      cloudCover: 75,
      lowCloudCover: 60,
      midCloudCover: 25,
      highCloudCover: 15,
      precipitation: 0,
      windSpeed: 2,
      windDirection: 90,
      humidity: 99,
      visibility: 420,
      weatherCode: 45,
    },
    needsHour: null,
    needsPlace: null,
  },
  {
    id: 'dem-trang',
    label: 'Đêm trăng',
    note: 'sạch mây để thấy trăng',
    override: {
      cloudCover: 4,
      lowCloudCover: 0,
      midCloudCover: 1,
      highCloudCover: 4,
      precipitation: 0,
      windSpeed: 5,
      windDirection: 110,
      humidity: 58,
      visibility: 28_000,
      weatherCode: 0,
    },
    needsHour: NEEDS_NIGHT,
    needsPlace: null,
  },
];

export const DEFAULT_WEATHER_PRESET = REAL.id;

export const weatherPreset = (id: WeatherPresetId): WeatherPreset =>
  WEATHER_PRESETS.find((preset) => preset.id === id) ?? REAL;

export const presetAvailableAt = (preset: WeatherPreset, recipe: LocationRecipe): boolean =>
  !preset.needsPlace || preset.needsPlace.met(recipe);

/** The presets this destination can actually deliver, in order. */
export const presetsFor = (recipe: LocationRecipe): readonly WeatherPreset[] =>
  WEATHER_PRESETS.filter((preset) => presetAvailableAt(preset, recipe));

/**
 * The preset that is really in force here. A preset the place cannot support
 * falls all the way back to the real forecast rather than to a near-miss, so an
 * id that arrives from somewhere other than the picker — remembered across a
 * navigation, pasted in a link — degrades to honesty instead of to a scene that
 * silently renders nothing.
 */
export const effectivePreset = (id: WeatherPresetId, recipe: LocationRecipe): WeatherPreset => {
  const preset = weatherPreset(id);
  return presetAvailableAt(preset, recipe) ? preset : REAL;
};

/**
 * `recipe`, `night` and `daylight` are all arguments rather than preset fields,
 * so there is no call shape in which a preset supplies its own time of day or
 * decides for itself that the destination can carry it.
 */
export const applyWeatherPreset = (
  id: WeatherPresetId,
  recipe: LocationRecipe,
  real: WeatherInput,
  night: number,
  daylight: number
): WorldWeather => deriveWorldWeather(effectivePreset(id, recipe).override ?? real, night, daylight);

/**
 * `deriveSkyState` reads three of the same numbers for the fog, the deck
 * altitude and the cloud opacity. Leaving it on the real hour is what makes
 * "Sương mù" a 420 m scene rendered through 20 km of clean air.
 */
export const presetSkyConditions = (
  id: WeatherPresetId,
  recipe: LocationRecipe,
  real: SkyConditions
): SkyConditions => {
  const override = effectivePreset(id, recipe).override;
  if (!override) return real;

  return {
    lowCloudCover: override.lowCloudCover,
    humidity: override.humidity,
    visibility: override.visibility,
  };
};

/**
 * The condition the chosen *hour* fails for this preset, or `null` when it is in
 * reach. A preset that quietly renders nothing is worse than one that says why.
 * Place conditions never reach here: `presetsFor` has already dropped those
 * presets, because there is no sentence that turns "nơi này không có" into
 * something to go and do.
 */
export const unmetHour = (id: WeatherPresetId, sun: SunHour): HourRequirement | null => {
  const needed = weatherPreset(id).needsHour;
  return needed && !needed.met(sun) ? needed : null;
};
