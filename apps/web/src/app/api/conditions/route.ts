import { deriveSkyState } from '@otrip/contracts';
import { LOCATIONS } from '@otrip/world';
import { NextResponse } from 'next/server';

import { currentHourIndex, hourToDate } from '@/lib/forecast';
import { fetchForecast, REVALIDATE_SECONDS } from '@/services/weather';

export type Conditions = {
  slug: string;
  temperature: number;
  weatherCode: number;
  cloudHunt: number;
  /** Local wall-clock time at the destination, HH:mm. */
  localTime: string;
  /** 0 at night, 1 in full daylight — the lobby dot is lit by this. */
  daylight: number;
};

/**
 * What every destination looks like right now, for the map on the landing page.
 * Returns whatever it can: one unreachable destination should not blank the map.
 */
export const GET = async () => {
  const results = await Promise.all(
    Object.values(LOCATIONS).map(async (recipe): Promise<Conditions | null> => {
      try {
        const forecast = await fetchForecast(recipe);
        const index = currentHourIndex(forecast);
        const hour = forecast.hours[index];
        if (!hour) return null;

        const sky = deriveSkyState(hourToDate(hour.time, forecast.utcOffsetSeconds), recipe.coords, {
          lowCloudCover: hour.lowCloudCover,
          humidity: hour.humidity,
          visibility: hour.visibility,
        });

        return {
          slug: recipe.slug,
          temperature: Math.round(hour.temperature),
          weatherCode: hour.weatherCode,
          cloudHunt: hour.cloudHunt,
          localTime: hour.time.slice(11, 16),
          daylight: Number(sky.daylight.toFixed(2)),
        };
      } catch {
        return null;
      }
    })
  );

  return NextResponse.json(
    { conditions: results.filter((item): item is Conditions => item !== null) },
    { headers: { 'Cache-Control': `public, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=3600` } }
  );
};
