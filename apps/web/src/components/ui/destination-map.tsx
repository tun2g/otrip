'use client';

import type { LocationRecipe } from '@otrip/world';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { Conditions } from '@/app/api/conditions/route';
import { drawOf } from '@/lib/draw';
import { cloudHuntLabel, weatherLabel } from '@/lib/forecast';
import { cn } from '@/lib/utils';

/**
 * Pins sit at their real latitude and longitude. There is deliberately no
 * coastline drawn behind them: an invented outline of the country would be a
 * confident lie, while a correct projection with a graticule is simply true, and
 * still puts Tà Xùa in the north and Hội An in the middle where they belong.
 */
const PADDING = 0.55;

type Bounds = { minLat: number; maxLat: number; minLon: number; maxLon: number };

const boundsOf = (recipes: LocationRecipe[]): Bounds => {
  const lats = recipes.map((recipe) => recipe.coords.lat);
  const lons = recipes.map((recipe) => recipe.coords.lon);

  return {
    minLat: Math.min(...lats) - PADDING,
    maxLat: Math.max(...lats) + PADDING,
    minLon: Math.min(...lons) - PADDING,
    maxLon: Math.max(...lons) + PADDING,
  };
};

const project = (recipe: LocationRecipe, bounds: Bounds): { left: string; top: string } => ({
  left: `${((recipe.coords.lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * 100}%`,
  top: `${((bounds.maxLat - recipe.coords.lat) / (bounds.maxLat - bounds.minLat)) * 100}%`,
});

export const DestinationMap = ({ recipes }: { recipes: LocationRecipe[] }) => {
  const [conditions, setConditions] = useState<Record<string, Conditions>>({});
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    fetch('/api/conditions', { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('unavailable'))))
      .then((payload: { conditions: Conditions[] }) => {
        setConditions(Object.fromEntries(payload.conditions.map((item) => [item.slug, item])));
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });

    return () => controller.abort();
  }, []);

  const bounds = boundsOf(recipes);

  return (
    <div className="overflow-hidden rounded-panel border border-border bg-panel/50 shadow-panel">
      {/* Capped in height and centred, with the drawing area keeping the shape of
          the degrees it covers — the projection stays honest without the panel
          running off the bottom of the screen. */}
      <div className="grid max-h-[26rem] place-items-center py-4">
        <div
          className="relative h-[24rem]"
          style={{ aspectRatio: `${bounds.maxLon - bounds.minLon} / ${bounds.maxLat - bounds.minLat}` }}
        >
          {/* Graticule: real degree lines, so the spacing means something. */}
          <svg className="absolute inset-0 size-full" aria-hidden="true">
            <defs>
              <linearGradient id="otrip-map-sea" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#141c33" />
                <stop offset="100%" stopColor="#0b1020" />
              </linearGradient>
            </defs>
            <rect width="100%" height="100%" fill="url(#otrip-map-sea)" />
            {[0.2, 0.4, 0.6, 0.8].map((fraction) => (
              <line
                key={`h-${fraction}`}
                x1="0"
                x2="100%"
                y1={`${fraction * 100}%`}
                y2={`${fraction * 100}%`}
                stroke="#2a3450"
                strokeDasharray="3 7"
              />
            ))}
            {[0.25, 0.5, 0.75].map((fraction) => (
              <line
                key={`v-${fraction}`}
                y1="0"
                y2="100%"
                x1={`${fraction * 100}%`}
                x2={`${fraction * 100}%`}
                stroke="#2a3450"
                strokeDasharray="3 7"
              />
            ))}
          </svg>

          {recipes.map((recipe, index) => {
            const position = project(recipe, bounds);
            const live = conditions[recipe.slug];
            // Destinations a few degrees apart had their cards sitting on top of
            // each other, so labels alternate above and below their pin.
            const below = index % 2 === 0;

            return (
              <Link
                key={recipe.slug}
                href={`/${recipe.slug}`}
                style={position}
                className="group absolute -translate-x-1/2 -translate-y-1/2 focus-visible:z-20 hover:z-20"
              >
                <span className={cn('flex flex-col items-center gap-1', !below && 'flex-col-reverse')}>
                  <span
                    className={cn(
                      'size-3 rounded-full ring-4 transition-all group-hover:scale-125',
                      live && live.daylight > 0.4 ? 'bg-accent ring-accent/20' : 'bg-haze ring-haze/15'
                    )}
                  />
                  <span className="rounded-control bg-panel-strong/90 px-2 py-1 text-center whitespace-nowrap backdrop-blur-sm">
                    <span className="block font-display text-sm group-hover:text-accent">
                      {recipe.name}
                      {live && <span className="ml-1.5 text-xs text-muted-foreground">{live.temperature}°</span>}
                    </span>
                    {live && (
                      <span className="hidden text-[0.65rem] group-focus-visible:block group-hover:block">
                        <span className="block text-muted-foreground">
                          {live.localTime} · {weatherLabel(live.weatherCode)}
                        </span>
                        <span className="block text-accent">
                          {drawOf(recipe).chance} {live.cloudHunt}/100 · {cloudHuntLabel(live.cloudHunt)}
                        </span>
                      </span>
                    )}
                  </span>
                </span>
              </Link>
            );
          })}
        </div>
      </div>

      <p className="flex justify-between border-t border-border px-4 py-2 text-[0.65rem] text-subtle">
        <span>
          {bounds.maxLat.toFixed(0)}°B — {bounds.minLat.toFixed(0)}°B
        </span>
        <span>đông →</span>
      </p>

      {failed && (
        <p className="border-t border-border px-4 py-2 text-xs text-subtle">
          Chưa lấy được thời tiết các điểm — bản đồ vẫn vào được bình thường.
        </p>
      )}
    </div>
  );
};
