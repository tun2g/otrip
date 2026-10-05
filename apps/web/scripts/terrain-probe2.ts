import { createTerrain, LOCATIONS } from '@otrip/world';

const recipe = LOCATIONS['trang-an'];
const terrain = createTerrain(recipe);
const { segments, heights, size } = terrain;
const side = segments + 1;
const step = size / segments;
const level = recipe.water!.level;

let maxDepth = 0;
const wet = new Uint8Array(side * side);
for (let i = 0; i < heights.length; i += 1) {
  if (heights[i] < level) {
    wet[i] = 1;
    maxDepth = Math.max(maxDepth, level - heights[i]);
  }
}

const flood = (mask: Uint8Array): number[] => {
  const seen = new Uint8Array(mask.length);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let count = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      count += 1;
      const r = Math.floor(i / side);
      const c = i % side;
      for (const [dr, dc] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= side || nc >= side) continue;
        const n = nr * side + nc;
        if (mask[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    sizes.push(count);
  }
  return sizes.sort((a, b) => b - a);
};

const cellArea = (step * step) / 1e6;
const wetParts = flood(wet);
console.log(`max depth ${maxDepth.toFixed(1)} m`);
console.log(
  `water bodies: ${wetParts.length}, largest ${(wetParts[0] * cellArea).toFixed(2)} km² (${((100 * wetParts[0]) / (side * side)).toFixed(1)}% of map), next ${wetParts
    .slice(1, 5)
    .map((n) => (n * cellArea).toFixed(2))
    .join(', ')}`
);

// Navigable = at least 0.6 m of water for a poled sampan.
const nav = new Uint8Array(side * side);
for (let i = 0; i < heights.length; i += 1) if (level - heights[i] > 0.6) nav[i] = 1;
const navParts = flood(nav);
console.log(
  `navigable (>0.6 m): ${((100 * navParts.reduce((a, b) => a + b, 0)) / (side * side)).toFixed(1)}% of map, largest run ${(navParts[0] * cellArea).toFixed(2)} km²`
);

// Flat dry ground, contiguous, for a village and a landing.
const flat = new Uint8Array(side * side);
for (let row = 0; row < side; row += 1) {
  for (let col = 0; col < side; col += 1) {
    const i = row * side + col;
    if (heights[i] < level) continue;
    if (terrain.slopeAt(-size / 2 + col * step, -size / 2 + row * step) < 0.3) flat[i] = 1;
  }
}
const flatParts = flood(flat);
console.log(
  `flat dry patches: largest ${(flatParts[0] * cellArea).toFixed(2)} km², next ${flatParts
    .slice(1, 5)
    .map((n) => (n * cellArea).toFixed(2))
    .join(', ')}`
);

// Shoreline: flat dry cells touching navigable water — where a jetty can go.
let shore = 0;
for (let row = 1; row < side - 1; row += 1) {
  for (let col = 1; col < side - 1; col += 1) {
    const i = row * side + col;
    if (!flat[i]) continue;
    if (nav[i - 1] || nav[i + 1] || nav[i - side] || nav[i + side]) shore += 1;
  }
}
console.log(`flat shore cells adjoining navigable water: ${shore} (${(shore * step).toFixed(0)} m of bank)`);

// Tower statistics: how much is rock, how tall.
let rock = 0;
for (let i = 0; i < heights.length; i += 1) if (heights[i] > level + 25) rock += 1;
console.log(`above waterline + 25 m (tower rock): ${((100 * rock) / (side * side)).toFixed(1)}% of map`);
