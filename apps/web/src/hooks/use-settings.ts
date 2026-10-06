'use client';

import { useCallback, useEffect, useState } from 'react';

import { detectQuality, type QualityTier, type RenderStyle } from '@/scene/quality';

export type Settings = {
  style: RenderStyle;
  tier: QualityTier;
  /** Mouse-look sensitivity multiplier, 0.2–3. */
  sensitivity: number;
  /**
   * How strong the peripheral mask gets at full speed, 0–1, where 0 is off.
   * `present-pass` wants this multiplied by how fast the viewer is actually
   * moving, so this is the ceiling rather than the value handed to the shader.
   */
  vignette: number;
  /**
   * Whether the camera is allowed its cinematic extras — the horizon roll, the
   * lean a boat carries into the view, the pullback at speed.
   *
   * Off by default, which is the opposite of what a demo would want, because the
   * complaint that produced this setting is that people were being made ill. All
   * three move the horizon without the player asking, and an unasked-for horizon
   * movement is the one thing the vestibular system has no matching signal for.
   */
  cameraMotion: boolean;
  /** Vertical field of view in degrees, 44–75. */
  fov: number;
};

/**
 * The field-of-view range and its default, which is also `BASE_FOV` in
 * `world-renderer`.
 *
 * It is the *reference* FOV and not the one the camera ends up with:
 * `world-renderer.resize()` widens it below a 16:9 aspect so that a portrait
 * phone keeps the same amount of the world across the frame instead of cropping
 * it, which on a tall phone can take the actual vertical FOV up to its 88° cap.
 * So this number is what the aspect correction is applied to.
 *
 * The range is bounded on both sides for comfort reasons that point opposite
 * ways. Narrow reduces the optic flow across the periphery, which is the whole
 * reason someone reaching for this control is reaching for it, but under about
 * 44° the view reads as a telescope and small turns feel violent. Above about
 * 75° the edge distortion of a rectilinear projection becomes the motion cue
 * itself, which is the problem rather than a cure for it.
 */
export const FOV_MIN = 44;
export const FOV_MAX = 75;
export const FOV_DEFAULT = 52;

export type SettingsState = Settings & {
  ready: boolean;
  update: (patch: Partial<Settings>) => void;
};

const KEY = 'otrip:settings';

const isTier = (value: unknown): value is QualityTier =>
  value === 'low' || value === 'medium' || value === 'high' || value === 'ultra';

/**
 * A stored number counts only if it is a finite number inside the range its own
 * control offers; anything else is the default.
 *
 * Clamping instead was the other option and is worse: the values that arrive out
 * of range are hand-edited keys and keys left behind by an older build, and
 * silently pinning those to a bound hands someone a setting they never chose and
 * cannot see is wrong. The `typeof` test alone — which is what `sensitivity`
 * used to get — passes NaN, and a NaN here reaches `camera.fov` and the
 * projection matrix, where it blanks the canvas with no error anywhere.
 */
const inRange = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;

/**
 * What a first-time visitor gets, and the fallback every stored key is measured
 * against. One table rather than a literal in `useState` and a second set of
 * fallbacks in the read, which is how the two drift apart.
 *
 * The mask is on out of the box, at 0.6 of its range. Someone who is about to
 * feel ill does not yet know the setting exists, so the default has to be the
 * comfortable one; and 0.6 at a walking pace is mild enough that nobody who
 * never goes looking for it will notice the frame has corners.
 */
const DEFAULTS: Settings = {
  style: 'sharp',
  tier: 'medium',
  sensitivity: 1,
  vignette: 0.6,
  cameraMotion: false,
  fov: FOV_DEFAULT,
};

/**
 * Per-viewer preferences, kept in local storage. Read after mount so the server
 * render and the first client render agree; until then the detected tier stands
 * in, which is also what a first-time visitor gets.
 */
export const useSettings = (): SettingsState => {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stored: Partial<Settings> = {};
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
      // A valid JSON document is not necessarily an object: a stored `null`, or
      // the bare `5` an unrelated script could leave under this key, parses
      // without throwing and then takes the property read down with it — outside
      // the try, in an effect, which is a blank page rather than a bad setting.
      if (parsed !== null && typeof parsed === 'object') stored = parsed as Partial<Settings>;
    } catch {
      // Blocked or corrupt storage: fall through to the detected defaults.
    }

    setSettings({
      style: stored.style === 'pixel' ? 'pixel' : 'sharp',
      tier: isTier(stored.tier) ? stored.tier : detectQuality(),
      sensitivity: inRange(stored.sensitivity, 0.2, 3, DEFAULTS.sensitivity),
      vignette: inRange(stored.vignette, 0, 1, DEFAULTS.vignette),
      // Anything that is not the boolean `true` is the comfortable answer, so a
      // truthy 7 left in storage cannot switch the cinematic camera back on.
      cameraMotion: stored.cameraMotion === true,
      fov: inRange(stored.fov, FOV_MIN, FOV_MAX, DEFAULTS.fov),
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
