import { createTerrain, LOCATIONS } from '@otrip/world';

import { createRoadNetwork } from '@/scene/road-network';
import { resolvePois } from '@/scene/points-of-interest';
import { planTown } from '@/scene/town-plan';

/** Two samples of different roads this close are the same junction. */
const JUNCTION = 14;

for (const slug of ['ta-xua', 'hoi-an', 'trang-an', 'ho-tay']) {
  const recipe = LOCATIONS[slug];
  if (!recipe) continue;
  const row: string[] = [];
  for (const segments of [192, 288, 416, 560]) {
    const terrain = createTerrain(recipe, segments);
    const plan = planTown(terrain, recipe, 1);
    const pois = resolvePois(terrain, recipe, plan.lots);
    const net = createRoadNetwork(terrain, recipe, pois, plan.lots);

    const parent = net.roads.map((road) => road.index);
    const find = (a: number): number => {
      while (parent[a] !== a) a = parent[a];
      return a;
    };
    for (let a = 0; a < net.roads.length; a += 1) {
      for (let b = a + 1; b < net.roads.length; b += 1) {
        if (find(a) === find(b)) continue;
        const left = net.roads[a].points;
        const right = net.roads[b].points;
        let touching = false;
        for (let i = 0; i < left.length / 3 && !touching; i += 1) {
          for (let j = 0; j < right.length / 3; j += 1) {
            if (Math.hypot(left[i * 3] - right[j * 3], left[i * 3 + 2] - right[j * 3 + 2]) <= JUNCTION) {
              touching = true;
              break;
            }
          }
        }
        if (touching) parent[find(a)] = find(b);
      }
    }

    const groups = new Map<number, number[]>();
    for (const road of net.roads) {
      const root = find(road.index);
      const list = groups.get(root);
      if (list) list.push(road.index);
      else groups.set(root, [road.index]);
    }
    const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
    const orphans = sorted.slice(1);
    const detail = orphans
      .map((group) =>
        group.map((index) => `${net.roads[index].kind}#${index}/${net.roads[index].totalLength.toFixed(0)}m`).join('+')
      )
      .join(', ');
    row.push(
      `seg ${segments}: ${net.roads.length} roads, ${sorted.length} piece(s)${detail ? ` — adrift: ${detail}` : ''}`
    );
    net.dispose();
  }
  console.log(`${slug}\n  ${row.join('\n  ')}`);
}
