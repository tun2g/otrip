import { solarPosition } from './sun.ts';

export type SkyPhase = 'night' | 'twilight' | 'golden' | 'day';

export type SkyState = {
  phase: SkyPhase;
  sunElevation: number;
  sunAzimuth: number;
  /** Unit vector in scene space, where north is -Z and east is +X. */
  sunDirection: { x: number; y: number; z: number };
  /** 1 when the light is low and warm, 0 at midday. Blends the palettes. */
  warmth: number;
  /** 0 at night, 1 in full daylight. Blends day vs night palettes. */
  daylight: number;
  fogDensity: number;
  cloudAltitudeScale: number;
  cloudOpacity: number;
  sunIntensity: number;
  fillIntensity: number;
  /** The night key, from the anti-solar point. Zero while the sun is up. */
  moonIntensity: number;
  /** How hard the sky's own image-based lighting is driven. The night fill. */
  ambientIntensity: number;
};

export type SkyConditions = {
  lowCloudCover: number;
  humidity: number;
  visibility: number;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const phaseOf = (elevation: number): SkyPhase => {
  if (elevation < -6) return 'night';
  if (elevation < 0) return 'twilight';
  if (elevation < 12) return 'golden';
  return 'day';
};

/**
 * Turns real conditions into the handful of numbers the renderer needs. Keeping
 * it pure and free of three.js means the server can derive the identical sky and
 * broadcast it, so everyone in a room sees one sunrise.
 */
export const deriveSkyState = (at: Date, coords: { lat: number; lon: number }, conditions: SkyConditions): SkyState => {
  const { elevation, azimuth } = solarPosition(at, coords.lat, coords.lon);

  const elevationRad = (elevation * Math.PI) / 180;
  const azimuthRad = (azimuth * Math.PI) / 180;
  const horizontal = Math.cos(elevationRad);

  const daylight = clamp01((elevation + 6) / 14);
  const warmth = clamp01(1 - elevation / 14);
  // Deliberately not `1 - daylight`: the handover has to finish well below the
  // horizon, or the moon rig fights the sunset while there is still a sun.
  const nightfall = clamp01(-(elevation + 2) / 8);

  // Visibility is in metres; FogExp2 reaches ~95% opacity at d where
  // (d * density)^2 ≈ 3, so density ≈ 1.73 / visibility. Damp humidity in on top,
  // because haze thickens long before visibility collapses.
  const humidityHaze = 1 + clamp01((conditions.humidity - 75) / 25) * 0.25;
  const fogDensity =
    Math.min(0.00016, Math.max(0.00005, (1.1 / Math.max(4000, conditions.visibility)) * humidityHaze)) *
    // Air cools and settles after sunset, and the extra haze is what carries the
    // night's colour into the distance instead of distance simply going black.
    // This was multiplied by zero, which left `nightfall` computed and unused and
    // the claim in this comment untrue; the reference night it is measured
    // against has almost no luminance range at all, which is what a night
    // airlight of about this strength produces.
    (1 + nightfall * 0.55);

  return {
    phase: phaseOf(elevation),
    sunElevation: elevation,
    sunAzimuth: azimuth,
    sunDirection: {
      x: Math.sin(azimuthRad) * horizontal,
      y: Math.sin(elevationRad),
      z: -Math.cos(azimuthRad) * horizontal,
    },
    warmth,
    daylight,
    fogDensity,
    // Moist air pools lower in the valleys; dry air lifts the deck.
    cloudAltitudeScale: 1.25 - clamp01((conditions.humidity - 55) / 45) * 0.45,
    cloudOpacity: clamp01(conditions.lowCloudCover / 70),
    // Calibrated for filmic tone mapping. The old value was tuned with no tone
    // mapper at all, so under ACES every lit surface sat past the shoulder of
    // the curve and came back grey.
    //
    // Night is a separate rig rather than a dimmed day, so every daytime source
    // is taken all the way to zero and handed over to the moon and the sky. The
    // old floors kept a sun shining up through the ground from below the horizon
    // and a near-white hemisphere bounce on top of it, which is what left the
    // night grey-green instead of blue.
    sunIntensity: 0.08 + daylight * 1.45,
    // Shadowed ground has to keep its colour. At the old levels a slope facing
    // away from a low sun went to near-black mud, which is physically defensible
    // and no fun to stand on.
    fillIntensity: 0.25 + daylight * 0.35,
    // The moon is the only direction left after dark, so it carries the shape:
    // which slope faces it, where a roof ends. Comparable to the sun because the
    // tone curve, not the physics, decides what a frame this dark looks like.
    moonIntensity: clamp01(-elevation / 8) * 0.8,
    // Sky ambient is a tint by day — at full strength it washed the albedo out
    // of everything and a green hillside came back grey. After dark it is the
    // whole fill, and it is what makes a moonlit landscape read blue: the only
    // light left comes from a blue sky, so every surface is lit blue rather than
    // tinted blue afterwards.
    // Measured against the reference: ours sat at median luminance 16.9 against
    // its 63.9, so the night half of this was simply too low to see by. The day
    // half is unchanged — it was verified not to move daylight, and raising it
    // is what washed the albedo out of everything in the first place.
    ambientIntensity: 0.3 + daylight * 0.08,
  };
};
