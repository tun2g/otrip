import { forecastResponseSchema, toForecast, type Forecast } from '@otrip/contracts';
import type { LocationRecipe } from '@otrip/world';

const HOURLY = [
  'temperature_2m',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'relative_humidity_2m',
  'visibility',
  'wind_speed_10m',
  'wind_direction_10m',
  'precipitation',
  'weather_code',
];

const CURRENT = [
  'temperature_2m',
  'relative_humidity_2m',
  'cloud_cover',
  'weather_code',
  'wind_speed_10m',
  'visibility',
];

export const REVALIDATE_SECONDS = 900;

/**
 * One upstream call per destination, cached on our side. Shared by the single
 * destination route and the hub summary so both read exactly the same numbers —
 * a lobby that disagrees with the page it links to is worse than no lobby.
 */
export const fetchForecast = async (recipe: LocationRecipe): Promise<Forecast> => {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(recipe.coords.lat));
  url.searchParams.set('longitude', String(recipe.coords.lon));
  url.searchParams.set('current', CURRENT.join(','));
  url.searchParams.set('hourly', HOURLY.join(','));
  url.searchParams.set('daily', 'sunrise,sunset');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '2');

  const response = await fetch(url, { next: { revalidate: REVALIDATE_SECONDS } });
  if (!response.ok) throw new Error('Nguồn thời tiết không phản hồi');

  const parsed = forecastResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Dữ liệu thời tiết sai định dạng');

  return toForecast(parsed.data, new Date().toISOString());
};
