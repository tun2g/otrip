import { createTerrain, LOCATIONS } from '@otrip/world';

import { createRoadNetwork, type RoadKind } from '@/scene/road-network';
import { resolvePois } from '@/scene/points-of-interest';
import { planTown } from '@/scene/town-plan';

import { createCanvas, dot, line, ring, writePng } from './plan-png';

const SEGMENTS = Number(process.env.SEG ?? 416);
const PIXELS = 900;
const OUT =
  process.env.OUT ??
  '/private/tmp/claude-501/-Users-macbook-Documents-self-otrip/adad3663-35ff-413c-af8a-9af878a3ac4b/scratchpad/roads';
const TAG = process.env.TAG ?? 'before';

const KIND_COLOR: Record<RoadKind, [number, number, number]> = {
  main: [255, 236, 150],
  secondary: [240, 180, 90],
  lane: [190, 150, 110],
  trail: [150, 200, 140],
};

for (const slug of ['hoi-an', 'trang-an', 'ho-tay']) {
  const recipe = LOCATIONS[slug];
  if (!recipe?.water) continue;
  const waterLevel = recipe.water.level;
  const terrain = createTerrain(recipe, SEGMENTS);
  const plan = planTown(terrain, recipe, 1);
  const pois = resolvePois(terrain, recipe, plan.lots);
  const net = createRoadNetwork(terrain, recipe, pois, plan.lots);

  const canvas = createCanvas(PIXELS, PIXELS);
  const extent = Number(process.env.EXTENT ?? terrain.size);
  const centreX = Number(process.env.CX ?? 0);
  const centreZ = Number(process.env.CZ ?? 0);
  const half = extent / 2;
  const toPx = (x: number) => ((x - centreX + half) / extent) * PIXELS;
  const toPy = (z: number) => ((z - centreZ + half) / extent) * PIXELS;

  let lowest = Infinity;
  let highest = -Infinity;
  const heights = new Float32Array(PIXELS * PIXELS);
  for (let py = 0; py < PIXELS; py += 1) {
    for (let px = 0; px < PIXELS; px += 1) {
      const x = (px / PIXELS) * extent - half + centreX;
      const z = (py / PIXELS) * extent - half + centreZ;
      const y = terrain.heightAt(x, z);
      heights[py * PIXELS + px] = y;
      if (y > waterLevel) {
        if (y < lowest) lowest = y;
        if (y > highest) highest = y;
      }
    }
  }
  for (let i = 0; i < PIXELS * PIXELS; i += 1) {
    const y = heights[i];
    if (y < waterLevel + 0.5) {
      const deep = Math.min(1, (waterLevel - y) / 12);
      canvas.rgb[i * 3] = 20 + (1 - deep) * 30;
      canvas.rgb[i * 3 + 1] = 50 + (1 - deep) * 60;
      canvas.rgb[i * 3 + 2] = 90 + (1 - deep) * 50;
    } else {
      const t = Math.min(1, Math.max(0, (y - lowest) / Math.max(1, highest - lowest)));
      canvas.rgb[i * 3] = 40 + t * 120;
      canvas.rgb[i * 3 + 1] = 48 + t * 110;
      canvas.rgb[i * 3 + 2] = 38 + t * 90;
    }
  }

  for (const road of net.roads) {
    const count = road.points.length / 3;
    const color = KIND_COLOR[road.kind];
    for (let i = 1; i < count; i += 1) {
      const ax = road.points[(i - 1) * 3];
      const az = road.points[(i - 1) * 3 + 2];
      const bx = road.points[i * 3];
      const bz = road.points[i * 3 + 2];
      const wet = terrain.heightAt(bx, bz) < waterLevel + 0.4;
      line(
        canvas,
        toPx(ax),
        toPy(az),
        toPx(bx),
        toPy(bz),
        wet ? 3 : road.kind === 'trail' ? 1 : 2,
        wet ? [255, 70, 70] : color
      );
    }
  }

  for (const poi of pois) {
    dot(canvas, toPx(poi.x), toPy(poi.z), 6, [255, 255, 255]);
    dot(canvas, toPx(poi.x), toPy(poi.z), 4, [30, 30, 30]);
    const marked = poi.id === 'con-giua' || poi.kind === 'island';
    if (marked) ring(canvas, toPx(poi.x), toPy(poi.z), (650 / extent) * PIXELS, [255, 255, 255]);
    console.log(`${slug} ${TAG}: poi ${poi.id} ${poi.kind} (${poi.x.toFixed(0)}, ${poi.z.toFixed(0)})`);
  }

  writePng(`${OUT}/${slug}-${TAG}.png`, PIXELS, PIXELS, canvas.rgb);
  console.log(`${slug} ${TAG}: ${net.roads.length} roads, ${net.decks.length} deck spans -> ${OUT}/${slug}-${TAG}.png`);
  net.dispose();
}
