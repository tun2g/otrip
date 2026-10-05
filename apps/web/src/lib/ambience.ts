import type { SkyState } from '@otrip/contracts';

import type { AmbienceLayer } from '@/lib/audio-engine';

/**
 * What a bed is for, rather than which file it is. Keying the mix on file names
 * left three of the four destinations silent: the mix only ever emitted
 * `wind-ridge`, `birds-dawn` and `forest-night`, while Hội An declares
 * `wind-trees` and `birds-village` and Tràng An declares `stream`, so the engine
 * held buffers whose gain nothing ever ramped off zero.
 */
type Role = 'wind' | 'water' | 'rain' | 'birds' | 'night';

/**
 * Matched as substrings against the declared name, so a new `wind-sea.m4a` or
 * `birds-heron.m4a` falls into the right role with no change here. `forest-night`
 * is night rather than forest — the token is what the bed does, not where it was
 * recorded.
 *
 * `rain` is its own role and is matched before `water`, because folding the two
 * made one gain carry two opposite jobs. Standing water has to be audible on a
 * cloudless afternoon and rain must not be, so the shared gain sat at 0.32 dry —
 * a hiss over Hồ Tây under a clear sky — and had nowhere left to go when it
 * actually rained. It also left Tà Xùa with nothing at all to raise: the ridge
 * has `water: null`, so it declares no water bed, and rain there was inaudible.
 */
const ROLE_TOKENS: [Role, string[]][] = [
  ['rain', ['rain']],
  ['wind', ['wind']],
  ['water', ['stream', 'water', 'wave']],
  ['birds', ['bird']],
  ['night', ['night', 'cricket', 'insect']],
];

/**
 * Everything under public/audio/ambience, used when a caller cannot say what the
 * location declared — which is the normal path: `location-scene.tsx` calls with
 * two arguments. Emitting a gain for a name the engine never loaded is free, but
 * the reverse is not: `applyAmbience` reads `wanted.get(name) ?? 0`, so a bed a
 * recipe declares and this list omits is loaded, started, and then held at zero
 * for the life of the tab. Anything added to a recipe belongs here too.
 */
const CATALOGUE = [
  'wind-ridge',
  'wind-trees',
  'rain-ridge',
  'rain-roof',
  'rain-lake',
  'stream',
  'water-lap',
  'birds-dawn',
  'birds-village',
  'forest-night',
];

/**
 * A bed whose role cannot be read still has to be audible. Silence is the one
 * failure that nobody notices until they have listened for a minute, so an
 * unknown name gets a quiet constant presence instead of nothing.
 */
const UNKNOWN_GAIN = 0.22;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const roleOf = (name: string): Role | null => {
  const lower = name.toLowerCase();
  for (const [role, tokens] of ROLE_TOKENS) {
    if (tokens.some((token) => lower.includes(token))) return role;
  }
  return null;
};

/**
 * The soundscape follows the same live data the picture does: wind rises with
 * the real wind, birds only at daylight and only when it is not raining, the
 * night bed when the sun is down, and the rain bed from nothing to the loudest
 * thing in the mix as the rain arrives.
 * Hearing the weather is most of why the scene feels like a place rather than a
 * wallpaper.
 *
 * Takes the three fields it reads rather than a whole `HourPoint`, because the
 * sound has to follow the sky that was *rendered*, not the one the forecast
 * holds. A weather preset paints an hour that never happened, and asking for a
 * thunderstorm used to leave the birds singing: measured at Tà Xùa, the gain
 * ramps were identical with the storm preset on and off, because this read the
 * real hour while everything visible read the override.
 *
 * @param declared the location's own `recipe.audio.ambience`.
 */
export const ambienceMix = (
  sky: SkyState,
  hour: { precipitation: number; windSpeed: number; weatherCode?: number },
  declared: string[] = CATALOGUE
): AmbienceLayer[] => {
  const weatherCode = hour.weatherCode ?? 0;
  // `daylight` is 0 at six degrees below the horizon and 1 at eight above, so
  // 0.43 is the sun exactly on the horizon.
  const day = clamp01(sky.daylight);

  // The hourly millimetres are an average over the hour, so a squall can read
  // 0.3 mm; the WMO code is the honest signal that it is raining. 51-67 is
  // drizzle through freezing rain, 80-82 showers, 95+ thunder.
  const rain = Math.max(
    clamp01(Math.log1p(Math.max(0, hour.precipitation) * 2.2) / Math.log1p(22)),
    weatherCode >= 51 && weatherCode <= 67 ? 0.4 : 0,
    weatherCode >= 80 ? 0.75 : 0
  );

  const gains: Record<Role, number> = {
    wind: Math.min(0.8, 0.25 + hour.windSpeed / 45),
    // Water is the body of water the place stands on, so it is there in dry
    // weather and only swells a little when the rain feeds it. The rain itself
    // is the `rain` bed; this term used to be the whole of it.
    water: 0.3 + rain * 0.14,
    // Lands just under the wind at full storm (0.78 against 0.80), which is what
    // 62 km/h over heavy rain sounds like: neither one wins.
    rain: rain * 0.78,
    birds: clamp01(day * 1.5) * 0.5 * (1 - clamp01(rain * 2)),
    night: Math.max(0, 1 - day * 2.2) * 0.45,
  };

  return declared.map((name) => {
    const role = roleOf(name);
    return { name, gain: role ? gains[role] : UNKNOWN_GAIN };
  });
};
