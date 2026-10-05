import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
registerHooks({
  resolve: (specifier, context, nextResolve) => {
    if (specifier.startsWith('.') && !/\.[mc]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        if (existsSync(base + ext)) return nextResolve(pathToFileURL(base + ext).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
const { createTerrain, LOCATIONS } = await import('@otrip/world');
const { BoxGeometry, InstancedMesh, MeshStandardMaterial } = await import('three');
const { createWind } = await import('../src/scene/wind.ts');
const { createGroundCover } = await import('../src/scene/ground-cover.ts');

const recipe = LOCATIONS['ta-xua'];
const terrain = createTerrain(recipe, 560);
const geometry = new BoxGeometry(1, 100, 1);
const material = new MeshStandardMaterial();
const sources = new Map(['Grass001', 'Grass002', 'Grass003'].map((n) => [n, { geometry, material, height: 100 }]));
const cover = createGroundCover(terrain, recipe, sources, 52000, createWind(recipe), null);

const meshes: InstanceType<typeof InstancedMesh>[] = [];
cover.group.traverse((n) => {
  if (n instanceof InstancedMesh) meshes.push(n);
});
// The renderer clears these once it has uploaded; headless nothing does, and the
// garbage it leaves behind lands in the timings as pauses that are not follow().
const drain = () => {
  for (const m of meshes) m.instanceMatrix.clearUpdateRanges();
};
for (let i = 0; i < 60; i += 1) {
  cover.follow(0, 610);
  drain();
}

const FRAMES = 6000;
const times = new Float64Array(FRAMES);
const advance = 1.4 / 60;
for (let f = 0; f < FRAMES; f += 1) {
  const x = Math.cos(0.6) * f * advance;
  const z = 610 + Math.sin(0.6) * f * advance;
  const t = performance.now();
  cover.follow(x, z);
  times[f] = performance.now() - t;
  drain();
}
const sorted = Array.from(times).sort((a, b) => b - a);
const busy = sorted.filter((t) => t > 0.05);
console.log(
  'worst',
  sorted[0].toFixed(2),
  'p99',
  busy[Math.floor(busy.length * 0.01)].toFixed(2),
  'median',
  busy[Math.floor(busy.length / 2)].toFixed(2),
  '| busy',
  busy.length,
  'total',
  busy.reduce((a, b) => a + b, 0).toFixed(0) + 'ms'
);
