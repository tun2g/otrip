'use client';

import { useCallback, useEffect, useState } from 'react';

import { detectQuality, type QualityTier, type RenderStyle } from '@/scene/quality';

export type Settings = {
  style: RenderStyle;
  tier: QualityTier;
  /** Mouse-look sensitivity multiplier, 0.2–3. */
  sensitivity: number;
};

export type SettingsState = Settings & {
  ready: boolean;
  update: (patch: Partial<Settings>) => void;
};

const KEY = 'otrip:settings';

const isTier = (value: unknown): value is QualityTier =>
  value === 'low' || value === 'medium' || value === 'high' || value === 'ultra';

/**
 * Per-viewer preferences, kept in local storage. Read after mount so the server
 * render and the first client render agree; until then the detected tier stands
 * in, which is also what a first-time visitor gets.
 */
export const useSettings = (): SettingsState => {
  const [settings, setSettings] = useState<Settings>({ style: 'sharp', tier: 'medium', sensitivity: 1 });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stored: Partial<Settings> = {};
    try {
      stored = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    } catch {
      // Blocked or corrupt storage: fall through to the detected defaults.
    }

    setSettings({
      style: stored.style === 'pixel' ? 'pixel' : 'sharp',
      tier: isTier(stored.tier) ? stored.tier : detectQuality(),
      sensitivity: typeof stored.sensitivity === 'number' ? stored.sensitivity : 1,
    });
    setReady(true);
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Preferences simply will not persist; the session still works.
      }
      return next;
    });
  }, []);

  return { ...settings, ready, update };
};
