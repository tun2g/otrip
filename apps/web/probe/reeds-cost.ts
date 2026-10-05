import { createTerrain, LOCATIONS } from '@otrip/world';
import { BoxGeometry, InstancedMesh, Matrix4, MeshStandardMaterial, Vector3 } from 'three';

import type { NatureSources } from '../src/scene/model-loader.ts';
import { createNatureScatter } from '../src/scene/nature-scatter.ts';
import { createWind } from '../src/scene/wind.ts';

const NAMES = [
  'TreeHigh001',
  'TreeHigh002',
  'TreeHigh003',
  'TreeMed001',
  'TreeMed002',
  'TreeMed003',
  'TreeLow001',
  'TreeLow002',
  'TreeLow003',
  'TreeLow004',
  'Bush001',
  'Bush002',
  'Reed001',
  'Reed002',
  'Rock001',
  'Rock002',
  'Rock003',
];
const sources: NatureSources = new Map(
  NAMES.map((n) => [n, { geometry: new BoxGeometry(1, 1, 1), material: new MeshStandardMaterial(), height: 1.9 }])
);
const matrix = new Matrix4();
const at = new Vector3();
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

type Run = { ms: number; reeds: number; total: number; draws: number; minH: number; maxH: number };

const build = (slug: string, reeds: number | undefined): Run => {
  const recipe = LOCATIONS[slug]!;
  const terrain = createTerrain(recipe, 288);
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const started = performance.now();
  const nature = createNatureScatter(
    terrain,
    recipe,
    sources,
    { trees: 12000, bushes: 8400, rocks: 3000, ...(reeds === undefined ? {} : { reeds }) },
    waterLevel,
    createWind(recipe),
    null
  );
  const ms = performance.now() - started;

  let r = 0;
  let total = 0;
  let draws = 0;
  let minH = Infinity;
  let maxH = -Infinity;
  for (const child of nature.group.children) {
    if (!(child instanceof InstancedMesh)) continue;
    draws += 1;
    total += child.count;
    if (!child.name.startsWith('nature-reeds')) continue;
    r += child.count;
    for (let i = 0; i < child.count; i += 1) {
      child.getMatrixAt(i, matrix);
      at.setFromMatrixPosition(matrix);
      // World height of the plant: the instance scale times the model's own height.
      const h = (matrix.elements[5] ?? 0) * 1.9;
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
    }
  }
  nature.dispose();
  return { ms, reeds: r, total, draws, minH, maxH };
};

// Warm the JIT so the first location is not charged for everyone else.
build('hoi-an', 0);

for (const slug of ['hoi-an', 'trang-an', 'ho-tay', 'ta-xua']) {
  const off = [0, 0, 0].map(() => build(slug, 0));
  const on = [0, 0, 0].map(() => build(slug, undefined));
  const a = on[0]!;
  console.log(
    `${slug.padEnd(9)} reeds off ${median(off.map((r) => r.ms))
      .toFixed(0)
      .padStart(3)}ms ${off[0]!.total} instances / ${off[0]!.draws} draws` +
      `  ->  reeds on ${median(on.map((r) => r.ms))
        .toFixed(0)
        .padStart(3)}ms ${a.total} instances / ${a.draws} draws` +
      `  |  ${a.reeds} reeds` +
      (a.reeds > 0 ? `, ${a.minH.toFixed(2)}-${a.maxH.toFixed(2)}m tall` : '')
  );
}
