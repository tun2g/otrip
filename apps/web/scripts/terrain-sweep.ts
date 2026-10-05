import { createTerrain, TRANG_AN } from '@otrip/world';
import type { LocationRecipe } from '@otrip/world';

const BANDS = [0, 1, 2, 3, 5, 8, Infinity];

const run = (baseHeight: number, level: number, edgeFalloff: number) => {
  const recipe: LocationRecipe = {
    ...TRANG_AN,
    terrain: { ...TRANG_AN.terrain, baseHeight, edgeFalloff, river: null },
    water: { ...TRANG_AN.water!, level },
  };
  const terrain = createTerrain(recipe);
  const { heights, size, segments } = terrain;
  const side = segments + 1;
  const step = size / segments;
  const total = side * side;
  const cellArea = (step * step) / 1e6;

  let wet = 0;
  const bands = new Array(BANDS.length - 1).fill(0);
  let maxDepth = 0;
  const nav = new Uint8Array(total);
  const flat = new Uint8Array(total);
  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const i = row * side + col;
      const d = level - heights[i];
      if (d > 0) {
        wet += 1;
        maxDepth = Math.max(maxDepth, d);
        for (let b = 0; b < bands.length; b += 1)
          if (d >= BANDS[b] && d < BANDS[b + 1]) {
            bands[b] += 1;
            break;
          }
      }
      if (d > 0.5) nav[i] = 1;
      if (d <= 0 && terrain.slopeAt(-size / 2 + col * step, -size / 2 + row * step) < 0.3) flat[i] = 1;
    }
  }

  const biggest = (mask: Uint8Array) => {
    const seen = new Uint8Array(total);
    const stack: number[] = [];
    let best = 0;
    let parts = 0;
    for (let start = 0; start < total; start += 1) {
      if (!mask[start] || seen[start]) continue;
      parts += 1;
      let count = 0;
      stack.push(start);
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        count += 1;
        const c = i % side;
        if (i >= side && mask[i - side] && !seen[i - side]) ((seen[i - side] = 1), stack.push(i - side));
        if (i < total - side && mask[i + side] && !seen[i + side]) ((seen[i + side] = 1), stack.push(i + side));
        if (c > 0 && mask[i - 1] && !seen[i - 1]) ((seen[i - 1] = 1), stack.push(i - 1));
        if (c < side - 1 && mask[i + 1] && !seen[i + 1]) ((seen[i + 1] = 1), stack.push(i + 1));
      }
      best = Math.max(best, count);
    }
    return { km2: best * cellArea, parts };
  };

  let longest = 0;
  for (let row = 0; row < side; row += 1) {
    let run = 0;
    for (let col = 0; col < side; col += 1) {
      run = flat[row * side + col] ? run + 1 : 0;
      if (run > longest) longest = run;
    }
  }
  const nb = biggest(nav);
  const fb = biggest(flat);
  let shore = 0;
  for (let i = side; i < total - side; i += 1)
    if (flat[i] && (nav[i - 1] || nav[i + 1] || nav[i - side] || nav[i + side])) shore += 1;
  let steep = 0;
  for (let row = 0; row < side; row += 1)
    for (let col = 0; col < side; col += 1)
      if (terrain.slopeAt(-size / 2 + col * step, -size / 2 + row * step) > 1) steep += 1;

  console.log(
    `b${baseHeight} L${level} ef${edgeFalloff} | wet ${((100 * wet) / total).toFixed(0)}% max ${maxDepth.toFixed(1)}m [${bands.map((n, b) => `${BANDS[b]}-${BANDS[b + 1] === Infinity ? '∞' : BANDS[b + 1]}:${((100 * n) / wet).toFixed(0)}%`).join(' ')}] | nav ${nb.km2.toFixed(2)}km²/${nb.parts} | flat ${fb.km2.toFixed(2)}km² run ${(longest * step).toFixed(0)}m | bank ${(shore * step).toFixed(0)}m | slope>1 ${((100 * steep) / total).toFixed(0)}%`
  );
};

for (const [b, l, ef] of [
  [22, 16.5, 0.9],
  [20, 15, 0.9],
  [18, 13.5, 0.9],
  [16, 12, 0.9],
  [14, 10.5, 0.9],
  [18, 13.5, 0.88],
  [18, 14, 0.9],
] as const)
  run(b, l, ef);
