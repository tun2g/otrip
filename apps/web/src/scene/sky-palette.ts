import type { SkyPalettes } from '@otrip/world';
import { Color } from 'three';

export type ResolvedSky = {
  zenith: Color;
  horizon: Color;
  sunCore: Color;
  sunGlow: Color;
  cloudLit: Color;
  cloudShadow: Color;
  fog: Color;
};

const KEYS = ['zenith', 'horizon', 'sunCore', 'sunGlow', 'cloudLit', 'cloudShadow', 'fog'] as const;

const createResolved = (): ResolvedSky =>
  Object.fromEntries(KEYS.map((key) => [key, new Color()])) as unknown as ResolvedSky;

/** Hoisted: `resolveSky` runs every frame and must not allocate. */
const scratch = new Color();

/**
 * Three keyframes rather than a continuous model: night, dawn and day, blended
 * by where the sun actually is. Below the horizon the sky slides from night into
 * the sunrise set; above it, from sunrise into full daylight.
 */
export const resolveSky = (palettes: SkyPalettes, sunElevation: number, into = createResolved()): ResolvedSky => {
  const belowHorizon = sunElevation < 0;
  const from = belowHorizon ? palettes.night : palettes.dawn;
  const to = belowHorizon ? palettes.dawn : palettes.day;
  const t = belowHorizon
    ? Math.min(1, Math.max(0, (sunElevation + 7) / 7))
    : Math.min(1, Math.max(0, sunElevation / 16));

  for (const key of KEYS) {
    into[key].set(from[key]).lerp(scratch.set(to[key]), t);
  }

  return into;
};

export const createSkyColors = createResolved;
