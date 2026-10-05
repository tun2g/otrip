/**
 * One weather state, derived once, consumed by everything.
 *
 * The scene used to let each module reach into the forecast for the fields it
 * cared about, which is how you end up with rain falling out of a clear sky and
 * a full moon shining through a storm. Every module now reads this instead, so
 * the world can only ever be in one weather at a time.
 */
export type WorldWeather = {
  /** 0..1 total sky covered. */
  cloudCover: number;
  /** 0..1 per deck. Low cloud blocks the sky; high cirrus barely does. */
  cloudLow: number;
  cloudMid: number;
  cloudHigh: number;
  /** mm/h. */
  precipitation: number;
  /** 0..1, derived from precipitation on a curve that saturates at heavy rain. */
  rainIntensity: number;
  /** 0..1 chance-weighted storminess; drives lightning and gust violence. */
  storm: number;
  /** km/h at 10 m. */
  windSpeed: number;
  /** Degrees meteorological — the direction the wind blows FROM. */
  windDirection: number;
  /** Percent. */
  humidity: number;
  /** Metres. */
  visibility: number;
  /**
   * 0 clear .. 1 total. How much of the sky is blocked by cloud, weighted by
   * deck: low cloud hides the moon, high cirrus only veils it. Sun disc, moon
   * disc, stars and the Milky Way are all multiplied by (1 - this).
   */
  skyOcclusion: number;
  /** 0 by day .. 1 at full dark, from the sun's elevation. */
  night: number;
  /** 0..1 how much direct daylight reaches the ground. */
  daylight: number;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export const CLEAR_WEATHER: WorldWeather = {
  cloudCover: 0.15,
  cloudLow: 0.05,
  cloudMid: 0.1,
  cloudHigh: 0.2,
  precipitation: 0,
  rainIntensity: 0,
  storm: 0,
  windSpeed: 8,
  windDirection: 120,
  humidity: 70,
  visibility: 20_000,
  skyOcclusion: 0.08,
  night: 0,
  daylight: 1,
};

export type WeatherInput = {
  cloudCover: number;
  lowCloudCover: number;
  midCloudCover: number;
  highCloudCover: number;
  precipitation: number;
  windSpeed: number;
  windDirection: number;
  humidity: number;
  visibility: number;
  /** WMO code from the forecast; 95+ is thunderstorm. */
  weatherCode?: number;
};

export const deriveWorldWeather = (input: WeatherInput, night: number, daylight: number): WorldWeather => {
  const cloudLow = clamp01(input.lowCloudCover / 100);
  const cloudMid = clamp01(input.midCloudCover / 100);
  const cloudHigh = clamp01(input.highCloudCover / 100);

  // Rain is logarithmic in feel: 1 mm/h is already clearly rain, 10 mm/h is
  // heavy, and past 20 there is nothing left to add visually.
  const rainIntensity = clamp01(Math.log1p(Math.max(0, input.precipitation) * 2.2) / Math.log1p(22));
  const code = input.weatherCode ?? 0;
  const thunder = code >= 95 ? 1 : 0;
  // The hourly precipitation figure is an average over the hour, so a
  // thunderstorm can arrive reading 0.3 mm. The code is the honest signal that
  // there is a cumulonimbus overhead; trust it over the millimetres.
  const showers = code >= 80 && code <= 82 ? 0.8 : 0;
  const storm = clamp01(
    Math.max(thunder, showers * 0.6, rainIntensity * 0.7) * (0.5 + clamp01(input.windSpeed / 55) * 0.5)
  );

  // Decks stack rather than add: two half-covered layers leave a quarter of the
  // sky open, not none of it. Low cloud is opaque, cirrus is a veil.
  const openSky = (1 - cloudLow) * (1 - cloudMid * 0.85) * (1 - cloudHigh * 0.35);
  // Rain cannot fall from a clear sky, and a thunderstorm cannot happen under a
  // thin one. If the forecast says either, the deck above is thick whatever the
  // cloud cover fields claim.
  const skyOcclusion = clamp01(Math.max(1 - openSky, rainIntensity * 0.97, thunder * 0.94, showers * 0.85));

  return {
    cloudCover: clamp01(input.cloudCover / 100),
    cloudLow: Math.max(cloudLow, rainIntensity * 0.95, thunder * 0.9, showers * 0.8),
    cloudMid: Math.max(cloudMid, rainIntensity * 0.8, thunder * 0.95, showers * 0.75),
    cloudHigh,
    precipitation: Math.max(0, input.precipitation),
    rainIntensity,
    storm,
    windSpeed: Math.max(0, input.windSpeed),
    windDirection: input.windDirection,
    humidity: input.humidity,
    visibility: Math.max(200, input.visibility),
    skyOcclusion,
    night: clamp01(night),
    daylight: clamp01(daylight),
  };
};

/** Eases between two states, so scrubbing the hour slider never snaps. */
export const blendWeather = (from: WorldWeather, to: WorldWeather, amount: number): WorldWeather => {
  const t = clamp01(amount);
  const mix = (a: number, b: number) => a + (b - a) * t;

  // Direction is an angle: interpolating 350° to 10° the long way round spins
  // every tree in the scene.
  const delta = ((((to.windDirection - from.windDirection) % 360) + 540) % 360) - 180;

  return {
    cloudCover: mix(from.cloudCover, to.cloudCover),
    cloudLow: mix(from.cloudLow, to.cloudLow),
    cloudMid: mix(from.cloudMid, to.cloudMid),
    cloudHigh: mix(from.cloudHigh, to.cloudHigh),
    precipitation: mix(from.precipitation, to.precipitation),
    rainIntensity: mix(from.rainIntensity, to.rainIntensity),
    storm: mix(from.storm, to.storm),
    windSpeed: mix(from.windSpeed, to.windSpeed),
    windDirection: (from.windDirection + delta * t + 360) % 360,
    humidity: mix(from.humidity, to.humidity),
    visibility: mix(from.visibility, to.visibility),
    skyOcclusion: mix(from.skyOcclusion, to.skyOcclusion),
    night: mix(from.night, to.night),
    daylight: mix(from.daylight, to.daylight),
  };
};
