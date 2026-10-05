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
// 1.9 is roughly what the Kenney reed model measures; only the ratio matters here.
const sources: NatureSources = new Map(
  NAMES.map((n) => [n, { geometry: new BoxGeometry(1, 1, 1), material: new MeshStandardMaterial(), height: 1.9 }])
);

const matrix = new Matrix4();
const at = new Vector3();

for (const slug of ['hoi-an', 'trang-an', 'ho-tay', 'ta-xua']) {
  const recipe = LOCATIONS[slug];
  if (!recipe) continue;
  const terrain = createTerrain(recipe, 288);
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;

  const started = performance.now();
  const nature = createNatureScatter(
    terrain,
    recipe,
    sources,
    { trees: 12000, bushes: 8400, rocks: 3000 },
    waterLevel,
    createWind(recipe),
    null
  );
  const built = performance.now() - started;

  let reeds = 0;
  let meshes = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  let minS = Infinity;
  let maxS = -Infinity;
  const nearest: number[] = [];
  for (const child of nature.group.children) {
    if (!(child instanceof InstancedMesh) || !child.name.startsWith('nature-reeds')) continue;
    meshes += 1;
    reeds += child.count;
    for (let i = 0; i < child.count; i += 1) {
      child.getMatrixAt(i, matrix);
      at.setFromMatrixPosition(matrix);
      minY = Math.min(minY, at.y);
      maxY = Math.max(maxY, at.y);
      const h = matrix.elements[5] ?? 0;
      minS = Math.min(minS, h);
      maxS = Math.max(maxS, h);
      if (i % 97 === 0) nearest.push(at.y - waterLevel);
    }
  }

  console.log(
    `${slug}: reeds ${reeds} over ${meshes} meshes | build ${built.toFixed(0)}ms | ` +
      (reeds > 0
        ? `height ${minY.toFixed(2)}..${maxY.toFixed(2)}m (water ${waterLevel}m, offset ${(minY - waterLevel).toFixed(2)}..${(maxY - waterLevel).toFixed(2)}m) | plant height ${minS.toFixed(2)}..${maxS.toFixed(2)}m`
        : 'none (expected where there is no water)')
  );
  nature.dispose();
}
