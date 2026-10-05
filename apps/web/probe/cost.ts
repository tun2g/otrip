import { createTerrain, LOCATIONS, scatterOnTerrain } from '@otrip/world';

const recipe = LOCATIONS['hoi-an'];
if (!recipe?.water) throw new Error('no');
const terrain = createTerrain(recipe, 288);
const w = recipe.water.level;

let t = performance.now();
let n = 0;
const half = terrain.size / 2;
const step = terrain.size / 220;
for (let x = -half; x <= half; x += step)
  for (let z = -half; z <= half; z += step) {
    terrain.heightAt(x, z);
    n += 1;
  }
console.log(`heightAt x${n}: ${(performance.now() - t).toFixed(0)}ms`);

t = performance.now();
n = 0;
for (let x = -half; x <= half; x += step)
  for (let z = -half; z <= half; z += step) {
    terrain.slopeAt(x, z);
    n += 1;
  }
console.log(`slopeAt  x${n}: ${(performance.now() - t).toFixed(0)}ms`);

t = performance.now();
let shore = 0;
for (let x = -half; x <= half; x += step) {
  for (let z = -half; z <= half; z += step) {
    const y = terrain.heightAt(x, z);
    if (y < w - 0.6 || y > w + 0.9) continue;
    if (terrain.slopeAt(x, z) > 1.9) continue;
    shore += 1;
  }
}
console.log(
  `band scan (heightAt then slopeAt only in band): ${(performance.now() - t).toFixed(0)}ms, ${shore} shore cells`
);

for (const [seed, count, maxSlope, over] of [
  ['trees', 12000, 1.8, 1.3],
  ['scrub', 3780, 2.6, 7],
  ['bushes', 8400, 1.9, 1.25],
  ['rocks', 3000, 2.5, 1],
] as const) {
  t = performance.now();
  const p = scatterOnTerrain(terrain, `${recipe.seed}:${seed}`, Math.ceil(count * over), {
    minHeight: 1,
    maxHeight: recipe.scatter.treeLine,
    maxSlope,
  });
  console.log(
    `scatterOnTerrain ${seed} asked ${Math.ceil(count * over)} -> ${p.length} in ${(performance.now() - t).toFixed(0)}ms`
  );
}
