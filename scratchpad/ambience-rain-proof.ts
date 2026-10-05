/**
 * Does the rain you ask for actually make something audible, at all four places?
 *
 * Reads the live forecast the app reads (`/api/weather/<slug>` off the running dev
 * server) so the "giờ thật" column is the real hour, then paints the two wet
 * presets through exactly the call `location-scene.tsx` makes. Prints every
 * declared bed and its gain, and checks the invariant that bites silently:
 * `ambienceMix` defaults `declared` to its own CATALOGUE, and `applyAmbience`
 * reads `wanted.get(name) ?? 0`, so a bed a recipe declares and the catalogue
 * omits loads, starts, and is held at zero for the life of the tab.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     ../../scratchpad/ambience-rain-proof.ts
 */
import { ambienceMix } from '../apps/web/src/lib/ambience.ts';
import { currentHourIndex, hourToDate } from '../apps/web/src/lib/forecast.ts';
import { effectivePreset, presetSkyConditions, type WeatherPresetId } from '../apps/web/src/lib/weather-presets.ts';
import { deriveSkyState, type Forecast } from '../packages/contracts/src/index.ts';
import { LOCATIONS } from '../packages/world/src/index.ts';

const SCENARIOS: WeatherPresetId[] = ['that', 'mua', 'bao'];
const ROLE_OF = (name: string) =>
  name.includes('rain')
    ? 'rain'
    : name.includes('wind')
      ? 'wind'
      : name.includes('bird')
        ? 'birds'
        : name.includes('night')
          ? 'night'
          : 'water';

let failures = 0;

for (const slug of ['ta-xua', 'hoi-an', 'trang-an', 'ho-tay']) {
  const recipe = LOCATIONS[slug];
  if (!recipe) throw new Error(`no recipe for ${slug}`);

  const response = await fetch(`http://localhost:3000/api/weather/${slug}`);
  if (!response.ok) throw new Error(`/api/weather/${slug} -> ${response.status}`);
  const forecast = (await response.json()) as Forecast;
  const index = currentHourIndex(forecast);
  const hour = forecast.hours[index];
  if (!hour) throw new Error(`no hour ${index} for ${slug}`);

  const declared = recipe.audio.ambience;
  console.log(
    `\n=== ${recipe.name} (${slug}) — ${hour.time}, ${hour.precipitation} mm, ${hour.windSpeed} km/h, code ${hour.weatherCode}`
  );
  console.log(`    beds: ${declared.join(', ')}`);

  const rows: Record<string, Record<string, number>> = {};
  for (const preset of SCENARIOS) {
    const sky = deriveSkyState(
      hourToDate(hour.time, forecast.utcOffsetSeconds),
      recipe.coords,
      presetSkyConditions(preset, recipe, {
        lowCloudCover: hour.lowCloudCover,
        humidity: hour.humidity,
        visibility: hour.visibility,
      })
    );
    const painted = effectivePreset(preset, recipe).override ?? hour;
    const layers = ambienceMix(sky, painted, declared);
    rows[preset] = Object.fromEntries(layers.map((l) => [l.name, l.gain]));

    // The real call site passes two arguments. Every declared bed has to come
    // back from that form too, at the same gain.
    const fromCatalogue = new Map(ambienceMix(sky, painted).map((l) => [l.name, l.gain]));
    for (const { name, gain } of layers) {
      const seen = fromCatalogue.get(name);
      if (seen === undefined) {
        console.log(`    !! ${name} missing from CATALOGUE — would load and stay at 0`);
        failures += 1;
      } else if (Math.abs(seen - gain) > 1e-9) {
        console.log(`    !! ${name} ${seen} via CATALOGUE vs ${gain} declared`);
        failures += 1;
      }
    }
  }

  const head = declared.map((n) => n.padStart(14)).join('');
  console.log(`    ${'scenario'.padEnd(10)}${head}`);
  for (const preset of SCENARIOS) {
    const cells = declared.map((n) => (rows[preset]?.[n] ?? NaN).toFixed(3).padStart(14)).join('');
    console.log(`    ${preset.padEnd(10)}${cells}`);
  }

  const rainBeds = declared.filter((n) => ROLE_OF(n) === 'rain');
  const windBeds = declared.filter((n) => ROLE_OF(n) === 'wind');
  if (rainBeds.length === 0) {
    console.log('    !! no rain bed declared');
    failures += 1;
  }
  for (const bed of rainBeds) {
    const dry = rows.that?.[bed] ?? 0;
    const wet = rows.mua?.[bed] ?? 0;
    const storm = rows.bao?.[bed] ?? 0;
    const ok = wet > dry && storm > wet && storm > 0.5;
    console.log(`    ${ok ? 'OK  ' : '!!  '}${bed}: ${dry.toFixed(3)} -> ${wet.toFixed(3)} -> ${storm.toFixed(3)}`);
    if (!ok) failures += 1;
  }
  if (windBeds.length === 0) {
    console.log('    !! no wind bed declared — windSpeed has nothing to act on');
    failures += 1;
  }
  for (const bed of windBeds) {
    const dry = rows.that?.[bed] ?? 0;
    const storm = rows.bao?.[bed] ?? 0;
    const ok = storm > dry;
    console.log(`    ${ok ? 'OK  ' : '!!  '}${bed}: ${dry.toFixed(3)} -> storm ${storm.toFixed(3)}`);
    if (!ok) failures += 1;
  }
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
