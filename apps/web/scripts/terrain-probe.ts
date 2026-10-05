import { createTerrain, LOCATION_SLUGS, LOCATIONS } from '@otrip/world';

const BANDS = [0, 1, 3, 5, 10, 20, 40, Infinity];

const percentile = (sorted: Float32Array, p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

for (const slug of LOCATION_SLUGS) {
  const recipe = LOCATIONS[slug];
  const terrain = createTerrain(recipe);
  const { segments, heights, size } = terrain;
  const side = segments + 1;
  const step = size / segments;
  const level = recipe.water ? recipe.water.level : -Infinity;

  let wet = 0;
  const bandCounts = new Array(BANDS.length - 1).fill(0);
  const buildable = new Uint8Array(side * side);
  let buildableCount = 0;

  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const h = heights[row * side + col];
      if (h < level) {
        wet += 1;
        const depth = level - h;
        for (let b = 0; b < BANDS.length - 1; b += 1) {
          if (depth >= BANDS[b] && depth < BANDS[b + 1]) {
            bandCounts[b] += 1;
            break;
          }
        }
        continue;
      }
      const x = -size / 2 + col * step;
      const z = -size / 2 + row * step;
      if (terrain.slopeAt(x, z) < 0.3) {
        buildable[row * side + col] = 1;
        buildableCount += 1;
      }
    }
  }

  let longest = 0;
  for (let row = 0; row < side; row += 1) {
    let run = 0;
    for (let col = 0; col < side; col += 1) {
      run = buildable[row * side + col] ? run + 1 : 0;
      if (run > longest) longest = run;
    }
  }
  for (let col = 0; col < side; col += 1) {
    let run = 0;
    for (let row = 0; row < side; row += 1) {
      run = buildable[row * side + col] ? run + 1 : 0;
      if (run > longest) longest = run;
    }
  }

  const sorted = heights.slice().sort();
  const total = side * side;
  const pct = (n: number) => `${((100 * n) / total).toFixed(1)}%`;

  console.log(
    `\n=== ${slug} (size ${size} m, maxHeight ${recipe.terrain.maxHeight} m, water ${recipe.water ? level : 'none'}) ===`
  );
  console.log(`  below water      ${pct(wet)}`);
  if (wet > 0) {
    const histogram = bandCounts
      .map(
        (count, b) =>
          `${BANDS[b]}-${BANDS[b + 1] === Infinity ? '∞' : BANDS[b + 1]}m ${((100 * count) / wet).toFixed(1)}%`
      )
      .join('  ');
    console.log(`  water depth      ${histogram}`);
  }
  console.log(`  dry & slope<0.3  ${pct(buildableCount)}   longest straight run ${(longest * step).toFixed(0)} m`);
  console.log(
    `  heights          p1 ${percentile(sorted, 0.01).toFixed(1)}  p10 ${percentile(sorted, 0.1).toFixed(1)}  p25 ${percentile(sorted, 0.25).toFixed(1)}  p50 ${percentile(sorted, 0.5).toFixed(1)}  p75 ${percentile(sorted, 0.75).toFixed(1)}  p90 ${percentile(sorted, 0.9).toFixed(1)}  p99 ${percentile(sorted, 0.99).toFixed(1)}  max ${percentile(sorted, 1).toFixed(1)}`
  );
}
