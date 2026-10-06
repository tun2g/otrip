import type { Terrain } from '@otrip/world';

/**
 * Which pieces of dry ground are actually joined to which.
 *
 * Nothing in the generator used to ask this, and one destination was two
 * countries because of it. Hồ Tây's recipe drew the lake as a `river` of 990 m
 * half-width with `amplitude: 0`, and a channel has no ending, so the water ran
 * edge to edge of the 4200 m patch and the map was **two** landmasses: measured
 * on this grid, 5.54 km² on the west bank carrying 73 of the 105 houses and
 * 5.11 km² on the east carrying the other 32, with 1325 m of water between them
 * at the narrowest row against a `BRIDGE_LIMIT` of 440 m in `road-network`.
 * Every road, every landmark and every parking row was planned from one hub on
 * the west bank, so the east bank had thirty-two houses standing in a field with
 * no road, no name and no way to walk there — which is the half of the map a
 * player opened the world map and called chán.
 *
 * That recipe is now a `BasinParams` and Hồ Tây is one landmass of 12.29 km².
 * This module stays because it is what proved the diagnosis, because it is what
 * keeps a landmark off ground the people cannot reach (`points-of-interest`) and
 * a hamlet's road on the right side of the water (`road-network`), and because
 * the next recipe with an island in it will need the same answer.
 *
 * Water is the only separator here, deliberately. A cliff is not: `walker.ts`
 * climbs a gradient of 1.15 and a karst tower stands on the same floodplain its
 * village does, so splitting on slope would report Tràng An as two hundred
 * islands and answer a question nobody asked.
 */

export type Landmass = {
  /** Which piece of ground a point stands on, or -1 for open water. */
  at: (x: number, z: number) => number;
  /** Square metres of each piece, indexed by the id `at` returns. */
  area: Float64Array;
  /** Pieces found, largest first — `area[0]` is always the biggest. */
  count: number;
};

/**
 * Cells per side. Independent of `terrain.segments` on purpose: the answer is a
 * topological one and must not change when a weak device drops the mesh
 * resolution, because the server regenerates the same terrain at its own
 * segment count to validate where players say they are.
 */
const CELLS = 200;

export const findLandmasses = (terrain: Terrain, waterLevel: number): Landmass => {
  const step = terrain.size / CELLS;
  const half = terrain.size / 2;
  const dry = new Uint8Array(CELLS * CELLS);

  for (let row = 0; row < CELLS; row += 1) {
    for (let col = 0; col < CELLS; col += 1) {
      const x = -half + (col + 0.5) * step;
      const z = -half + (row + 0.5) * step;
      // Half a metre of margin, the same figure `buildGrid` calls wet, so a road
      // and a landmass never disagree about where the bank is.
      if (terrain.heightAt(x, z) > waterLevel + 0.5) dry[row * CELLS + col] = 1;
    }
  }

  const label = new Int32Array(CELLS * CELLS).fill(-1);
  const sizes: number[] = [];
  const queue: number[] = [];

  for (let seed = 0; seed < dry.length; seed += 1) {
    if (dry[seed] === 0 || label[seed] >= 0) continue;
    const id = sizes.length;
    sizes.push(0);
    label[seed] = id;
    queue.length = 0;
    queue.push(seed);

    while (queue.length > 0) {
      const at = queue.pop() as number;
      sizes[id] += 1;
      const col = at % CELLS;
      const row = (at - col) / CELLS;
      // Eight-connected: a bank that narrows to a diagonal thread of cells is
      // still a bank you can walk along, and four-connectivity cuts it.
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const nc = col + dc;
          const nr = row + dr;
          if (nc < 0 || nr < 0 || nc >= CELLS || nr >= CELLS) continue;
          const next = nr * CELLS + nc;
          if (dry[next] === 0 || label[next] >= 0) continue;
          label[next] = id;
          queue.push(next);
        }
      }
    }
  }

  // Relabelled largest first, so `0` means "the main landmass" without a caller
  // having to sort anything.
  const order = sizes.map((count, id) => ({ count, id })).sort((a, b) => b.count - a.count);
  const rank = new Int32Array(sizes.length);
  order.forEach((entry, position) => {
    rank[entry.id] = position;
  });
  const area = new Float64Array(order.length);
  order.forEach((entry, position) => {
    area[position] = entry.count * step * step;
  });
  for (let i = 0; i < label.length; i += 1) {
    if (label[i] >= 0) label[i] = rank[label[i]];
  }

  return {
    at: (x: number, z: number) => {
      const col = Math.min(CELLS - 1, Math.max(0, Math.floor((x + half) / step)));
      const row = Math.min(CELLS - 1, Math.max(0, Math.floor((z + half) / step)));
      return label[row * CELLS + col];
    },
    area,
    count: order.length,
  };
};
