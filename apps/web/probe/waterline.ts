import { createPrng, createTerrain, LOCATIONS, scatterOnTerrain } from '@otrip/world';

for (const slug of ['hoi-an', 'trang-an', 'ho-tay', 'ta-xua']) {
  const recipe = LOCATIONS[slug];
  if (!recipe) continue;
  const terrain = createTerrain(recipe, 288);
  if (!recipe.water) {
    console.log(`${slug}: no water, reeds must be skipped entirely`);
    continue;
  }
  const w = recipe.water.level;
  const lo = w - 0.6;
  const hi = w + 0.9;

  // Acceptance rate of the band, the way scatterOnTerrain samples it.
  const random = createPrng(`${recipe.seed}:reeds:measure`);
  const half = terrain.size / 2;
  let inBand = 0;
  let inBandGentle = 0;
  const tries = 200_000;
  for (let i = 0; i < tries; i += 1) {
    const x = (random() * 2 - 1) * half;
    const z = (random() * 2 - 1) * half;
    const y = terrain.heightAt(x, z);
    if (y < lo || y > hi) continue;
    inBand += 1;
    if (terrain.slopeAt(x, z) <= 0.7) inBandGentle += 1;
  }
  const rate = inBandGentle / tries;
  console.log(
    `${slug}: water ${w}m band ${lo.toFixed(1)}..${hi.toFixed(1)}m  in band ${((inBand / tries) * 100).toFixed(2)}%  ` +
      `and gentle ${(rate * 100).toFixed(2)}%  -> max reeds reachable in count*40 attempts: ${Math.round(rate * 40 * 1000)} per 1000 asked`
  );

  for (const count of [1500, 3000, 4500]) {
    const started = performance.now();
    const points = scatterOnTerrain(terrain, `${recipe.seed}:reeds`, count, {
      minHeight: lo,
      maxHeight: hi,
      fade: 0.5,
      maxSlope: 0.7,
    });
    const took = performance.now() - started;
    console.log(`    asked ${count} -> got ${points.length} in ${took.toFixed(0)}ms`);
  }
}
