'use client';

import type { Forecast } from '@otrip/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { currentHourIndex } from '@/lib/forecast';

export type ForecastState = {
  forecast: Forecast | null;
  /** Null while loading, on success, and on a refetch that failed over data we
   *  still hold; a readable reason only when there is nothing to show. */
  error: string | null;
  /** The hour the destination is living in, re-read as its clock turns over. */
  nowIndex: number;
};

const FAILED = 'Không lấy được thời tiết';

const HOUR_MS = 3_600_000;

/**
 * A tab that comes back after being away wants the hour it returns to, not the
 * one it left — but `/api/weather` caches the upstream call for
 * `REVALIDATE_SECONDS` (900), so asking again sooner than that only re-reads the
 * same payload. Alt-tabbing is therefore free; an overnight tab is not ignored.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * The forecast, plus the hour it is currently on. One clock drives both: the
 * destination's own hour boundary is the only moment either answer changes, so
 * there is nothing to keep in step.
 *
 * Deliberately not wired through a query library: there is still nothing to
 * invalidate or mutate, and the scene must stay watchable whether or not any
 * single request resolves.
 */
export const useForecast = (slug: string): ForecastState => {
  const [state, setState] = useState<{ forecast: Forecast | null; error: string | null }>({
    forecast: null,
    error: null,
  });
  const [nowIndex, setNowIndex] = useState(0);
  const fetchedAt = useRef(0);

  const load = useCallback(
    async (signal: AbortSignal) => {
      fetchedAt.current = Date.now();

      // A refetch that fails keeps the forecast already on screen: numbers a few
      // hours old still make a sky worth sitting in front of, and the error line
      // this would otherwise raise says "đang hiện cảnh bình minh mặc định" —
      // which would be a lie told over the real scene it just threw away.
      const keepOrFail = () =>
        setState((previous) => (previous.forecast ? previous : { forecast: null, error: FAILED }));

      try {
        const response = await fetch(`/api/weather/${slug}`, { signal });
        if (!response.ok) {
          keepOrFail();
          return;
        }

        const forecast = (await response.json()) as Forecast;
        // Set together so the first render holding a forecast already holds the
        // right hour: leaving `nowIndex` to the effect below showed one frame of
        // index 0, which is midnight at the destination.
        setNowIndex(currentHourIndex(forecast));
        setState({ forecast, error: null });
      } catch {
        if (!signal.aborted) keepOrFail();
      }
    },
    [slug]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const { forecast } = state;

  useEffect(() => {
    if (!forecast) return;

    const controller = new AbortController();
    let timer = 0;

    const run = (refetch: boolean) => {
      setNowIndex(currentHourIndex(forecast));
      if (refetch) void load(controller.signal);

      // Aligned to the destination's own hour rather than set to a flat 60
      // minutes from mount, because the cell turning over is the only thing
      // either answer depends on. A second past the boundary: a timer that fires
      // a few milliseconds early reads the hour it has just left, and then waits
      // another full hour to notice.
      const localMs = Date.now() + forecast.utcOffsetSeconds * 1000;
      timer = window.setTimeout(() => run(true), HOUR_MS - (localMs % HOUR_MS) + 1000);
    };

    run(false);

    // A hidden tab has its timers throttled to roughly one a minute, so the hour
    // it wakes up in is read here rather than waited for.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setNowIndex(currentHourIndex(forecast));
      if (Date.now() - fetchedAt.current >= STALE_AFTER_MS) void load(controller.signal);
    };

    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      controller.abort();
    };
  }, [forecast, load]);

  return { forecast: state.forecast, error: state.error, nowIndex };
};
