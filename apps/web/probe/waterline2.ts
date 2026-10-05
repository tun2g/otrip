import { createPrng, createTerrain, LOCATIONS, scatterOnTerrain } from '@otrip/world';

for (const slug of ['hoi-an', 'trang-an', 'ho-tay']) {
  const recipe = LOCATIONS[slug];
  if (!recipe?.water) continue;
  const terrain = createTerrain(recipe, 288);
  const w = recipe.water.level;
  const lo = w - 0.6;
  const hi = w + 0.9;
  const half = terrain.size / 2;

  const random = createPrng(`${recipe.seed}:reeds:measure`);
  const tries = 200_000;
  const limits = [0.7, 1.0, 1.4, 1.8, 99];
  const hits = new Array(limits.length).fill(0);
  for (let i = 0; i < tries; i += 1) {
    const x = (random() * 2 - 1) * half;
    const z = (random() * 2 - 1) * half;
    const y = terrain.heightAt(x, z);
    if (y < lo || y > hi) continue;
    const s = terrain.slopeAt(x, z);
    limits.forEach((limit, j) => {
      if (s <= limit) hits[j] += 1;
    });
  }
  console.log(
    `${slug}: acceptance in band by slope limit  ` +
      limits.map((l, j) => `${l}: ${((hits[j] / tries) * 100).toFixed(2)}%`).join('  ')
  );

  for (const [count, maxSlope] of [
    [2520, 1.4],
    [6300, 1.4],
  ] as const) {
    const started = performance.now();
    const points = scatterOnTerrain(terrain, `${recipe.seed}:reeds`, count, {
      minHeight: lo,
      maxHeight: hi,
      fade: 0.5,
      maxSlope,
    });
    console.log(
      `    asked ${count} at maxSlope ${maxSlope} -> got ${points.length} in ${(performance.now() - started).toFixed(0)}ms`
    );
  }
}
