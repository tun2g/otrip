import { z } from 'zod';

/**
 * The slice of the Open-Meteo forecast the scene actually uses. Validated at the
 * edge of the system so a shape change upstream fails loudly in one place
 * instead of quietly producing a wrong sky.
 */
export const forecastResponseSchema = z.object({
  utc_offset_seconds: z.number(),
  timezone: z.string(),
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    relative_humidity_2m: z.number(),
    cloud_cover: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
    visibility: z.number(),
  }),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(z.number()),
    cloud_cover: z.array(z.number()),
    cloud_cover_low: z.array(z.number()),
    cloud_cover_mid: z.array(z.number()),
    cloud_cover_high: z.array(z.number()),
    relative_humidity_2m: z.array(z.number()),
    visibility: z.array(z.number()),
    wind_speed_10m: z.array(z.number()),
    wind_direction_10m: z.array(z.number()),
    precipitation: z.array(z.number()),
    weather_code: z.array(z.number()),
  }),
  daily: z.object({
    time: z.array(z.string()),
    sunrise: z.array(z.string()),
    sunset: z.array(z.string()),
  }),
});

export type ForecastResponse = z.infer<typeof forecastResponseSchema>;

/** One hour of the forecast, flattened into what the scene needs. */
export type HourPoint = {
  /** Local wall-clock ISO string, as returned by the API. */
  time: string;
  temperature: number;
  cloudCover: number;
  lowCloudCover: number;
  midCloudCover: number;
  highCloudCover: number;
  humidity: number;
  visibility: number;
  windSpeed: number;
  /** Degrees meteorological — the direction the wind blows FROM. */
  windDirection: number;
  /** mm in the hour. */
  precipitation: number;
  weatherCode: number;
  /** 0-100 heuristic, see `cloudHuntScore`. */
  cloudHunt: number;
};

export type Forecast = {
  timezone: string;
  utcOffsetSeconds: number;
  fetchedAt: string;
  current: {
    time: string;
    temperature: number;
    humidity: number;
    cloudCover: number;
    windSpeed: number;
    visibility: number;
    weatherCode: number;
  };
  hours: HourPoint[];
  /** Local ISO strings, one per forecast day. */
  sunrises: string[];
  sunsets: string[];
};

/**
 * How promising an hour looks for a sea of clouds. This is a readable heuristic,
 * not meteorology: a cloud sea wants moist air pooled in the valleys (low cloud),
 * air that is close to saturation, and little wind to tear it apart. The UI must
 * present it as an estimate, never as a forecast of the phenomenon itself.
 */
export const cloudHuntScore = (point: { lowCloudCover: number; humidity: number; windSpeed: number }): number => {
  // Low cloud gates the whole score instead of averaging into it: saturated,
  // windless air with a clear valley is a nice morning, not a sea of clouds,
  // and an earlier version happily called 1% low cloud "promising".
  const lowCloud =
    point.lowCloudCover < 10
      ? 0
      : point.lowCloudCover < 35
        ? (point.lowCloudCover - 10) / 25
        : point.lowCloudCover <= 85
          ? 1
          : Math.max(0.3, 1 - (point.lowCloudCover - 85) / 21);

  const humidity = Math.min(1, Math.max(0, (point.humidity - 60) / 35));
  const wind = Math.min(1, Math.max(0, (18 - point.windSpeed) / 14));

  return Math.round((0.62 * humidity + 0.38 * wind) * lowCloud * 100);
};

export const toForecast = (response: ForecastResponse, fetchedAt: string): Forecast => {
  const { hourly } = response;

  const hours: HourPoint[] = hourly.time.map((time, index) => {
    const point = {
      time,
      temperature: hourly.temperature_2m[index] ?? 0,
      cloudCover: hourly.cloud_cover[index] ?? 0,
      lowCloudCover: hourly.cloud_cover_low[index] ?? 0,
      midCloudCover: hourly.cloud_cover_mid[index] ?? 0,
      highCloudCover: hourly.cloud_cover_high[index] ?? 0,
      humidity: hourly.relative_humidity_2m[index] ?? 0,
      visibility: hourly.visibility[index] ?? 20000,
      windSpeed: hourly.wind_speed_10m[index] ?? 0,
      windDirection: hourly.wind_direction_10m[index] ?? 0,
      precipitation: hourly.precipitation[index] ?? 0,
      weatherCode: hourly.weather_code[index] ?? 0,
    };

    return { ...point, cloudHunt: cloudHuntScore(point) };
  });

  return {
    timezone: response.timezone,
    utcOffsetSeconds: response.utc_offset_seconds,
    fetchedAt,
    current: {
      time: response.current.time,
      temperature: response.current.temperature_2m,
      humidity: response.current.relative_humidity_2m,
      cloudCover: response.current.cloud_cover,
      windSpeed: response.current.wind_speed_10m,
      visibility: response.current.visibility,
      weatherCode: response.current.weather_code,
    },
    hours,
    sunrises: response.daily.sunrise,
    sunsets: response.daily.sunset,
  };
};
