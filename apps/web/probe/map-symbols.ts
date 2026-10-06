/**
 * Can you tell the marks on the corner map apart without seeing their colour?
 *
 * The reported complaint was that the minimap is hard to read and the symbols
 * should be easier to understand, and it arrived straight after a request for
 * more places to pick up a motorbike or a boat — so the thing being attempted on
 * that map is finding a ride. What was there to find it with: a 5.2 px pale blue
 * square for a parking slot, a 3.4 px orange disc for a visited place, a 2.6 px
 * grey ring for an unvisited one, a 3 px coloured disc for a companion. Four
 * marks, one silhouette, four hues — over a relief bitmap that is itself sand,
 * green and blue.
 *
 * There is no 2D canvas in bare Node, so this rasterises each symbol itself,
 * from the same geometry `map-symbols.ts` hands the browser, on the real pixel
 * grid at the only size the corner map is ever drawn at. Every number below is
 * measured off that raster; the words naming each difference are picked from
 * whichever measured property differs, never asserted.
 *
 * Three things it cannot prove, and does not claim: that the raster matches what
 * Chrome's own antialiasing produces (the coverage model here is 8×8 box
 * sampling, which is close but not identical); that a human reads these shapes
 * apart as fast as the geometry says they could; and anything at all about
 * colour, which is deliberately absent from every comparison.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/map-symbols.ts [--only=ta-xua]
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve: (specifier, context, nextResolve) => {
    if (specifier.startsWith('.') && !/\.[mc]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const extension of ['.ts', '.tsx', '/index.ts']) {
        if (existsSync(base + extension)) return nextResolve(pathToFileURL(base + extension).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
globals.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
globals.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({ width: 0, height: 0, getContext: () => null }),
};

const { createTerrain, LOCATIONS } = await import('@otrip/world');
const { COMPANION_HALF, PLACE_RADIUS, RIDE_RADIUS, outlineFor } = await import('@/components/ui/map-symbols');
const { planTown } = await import('@/scene/town-plan');
const { resolvePois } = await import('@/scene/points-of-interest');
const { createRoadNetwork } = await import('@/scene/road-network');
const { findDockSite, createDock } = await import('@/scene/dock');
const { createVehicles } = await import('@/scene/vehicles');
const { createLife } = await import('@/scene/life');
const { QUALITY_SETTINGS } = await import('@/scene/quality');

/** `SIZE` in `minimap.tsx`. The corner map has exactly one size. */
const MAP = 140;

/** `MERGE_PIXELS` in `map-symbols.ts`, which is not exported because only the plot needs it. */
const MERGE_PIXELS = 7;

/** The range a fresh multiplayer join puts two people at, per `companion-markers.ts`. */
const JOIN_RANGE = 9;

/** Subsamples per axis. 8 gives 64 coverage levels, finer than a canvas reports. */
const SUB = 8;
/** Half-width of the raster, in pixels. Twice the largest mark, so nothing clips. */
const PAD = 11;

type Inside = (x: number, y: number) => boolean;

/** Coverage per pixel in [0,1], the row-major square from −PAD to +PAD. */
type Raster = { cover: Float64Array; side: number };

const rasterise = (inside: Inside): Raster => {
  const side = PAD * 2;
  const cover = new Float64Array(side * side);
  const step = 1 / SUB;

  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      let hits = 0;
      for (let sy = 0; sy < SUB; sy += 1) {
        const y = -PAD + row + (sy + 0.5) * step;
        for (let sx = 0; sx < SUB; sx += 1) {
          if (inside(-PAD + col + (sx + 0.5) * step, y)) hits += 1;
        }
      }
      cover[row * side + col] = hits / (SUB * SUB);
    }
  }

  return { cover, side };
};

type Polygon = readonly (readonly [number, number])[];

const scaled = (outline: Polygon, radius: number): Polygon => outline.map(([x, y]) => [x * radius, y * radius]);

/** Even-odd ray cast. The outlines are convex, but even-odd costs nothing and never lies. */
const inPolygon = (poly: Polygon, x: number, y: number): boolean => {
  let on = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < xi + ((y - yi) / (yj - yi)) * (xj - xi)) on = !on;
  }
  return on;
};

const toSegment = (x: number, y: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax;
  const dy = by - ay;
  const span = dx * dx + dy * dy;
  const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / span));
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
};

const toEdges = (poly: Polygon, x: number, y: number): number => {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    best = Math.min(best, toSegment(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]));
  }
  return best;
};

/**
 * The coloured ink of one mark, which is the part that carries a shape.
 *
 * Every mark on both maps is cased in `rgba(11,16,32,0.85)` against the
 * hillshade, and a canvas stroke straddles its path — half the width inside, half
 * out. So a filled mark loses half the casing off its fill, and a hollow one is
 * only the ring of colour laid back over the casing. That is what the eye has to
 * segment, so that is what gets compared.
 */
const inkOf = (name: string): { raster: Raster; corners: number } => {
  switch (name) {
    case 'xe máy':
    case 'thuyền': {
      const poly = scaled(outlineFor(name), RIDE_RADIUS);
      // paintRide: 1.4 px casing straddling the outline, then fill.
      return { raster: rasterise((x, y) => inPolygon(poly, x, y) && toEdges(poly, x, y) > 0.7), corners: poly.length };
    }
    case 'xe máy (bạn đang lái)':
    case 'thuyền (bạn đang lái)': {
      const poly = scaled(outlineFor(name.split(' (')[0]), RIDE_RADIUS);
      // paintRide, taken: 2.6 px casing, then a 1.3 px line of colour on top of it.
      return { raster: rasterise((x, y) => toEdges(poly, x, y) <= 0.65), corners: poly.length };
    }
    case 'địa điểm': {
      // paintPlace: a filled disc with a 1.2 px casing.
      return { raster: rasterise((x, y) => Math.hypot(x, y) <= PLACE_RADIUS - 0.6), corners: 0 };
    }
    case 'người đi cùng': {
      const { across, along } = COMPANION_HALF;
      const reach = along - across;
      // paintCompanion: a capsule stroked 1.1 px, then filled.
      return { raster: rasterise((x, y) => toSegment(x, y, 0, -reach, 0, reach) <= across - 0.55), corners: 0 };
    }
    case 'bạn (hướng mặt)': {
      // drawHeadingMarker at radius 7, facing north, with its 0.91 px casing.
      const r = 7;
      const poly: Polygon = [
        [0, -r],
        [r * 0.64, r * 0.73],
        [0, r * 0.41],
        [-r * 0.64, r * 0.73],
      ];
      return { raster: rasterise((x, y) => inPolygon(poly, x, y) && toEdges(poly, x, y) > 0.455), corners: 4 };
    }
    // --- what was there before, measured the same way --------------------
    case 'cũ: ô đỗ xe': {
      // A 5.2 px square with a 1.2 px casing.
      return { raster: rasterise((x, y) => Math.max(Math.abs(x), Math.abs(y)) <= 2.6 - 0.6), corners: 4 };
    }
    case 'cũ: đã khám phá': {
      return { raster: rasterise((x, y) => Math.hypot(x, y) <= 3.4 - 0.6), corners: 0 };
    }
    case 'cũ: chưa khám phá': {
      // A hollow 2.6 px ring stroked 1.2 px, with no casing under it.
      return { raster: rasterise((x, y) => Math.abs(Math.hypot(x, y) - 2.6) <= 0.6), corners: 0 };
    }
    case 'cũ: người đi cùng': {
      return { raster: rasterise((x, y) => Math.hypot(x, y) <= 3 - 0.6), corners: 0 };
    }
    default:
      throw new Error(`no geometry for ${name}`);
  }
};

type Shape = {
  name: string;
  corners: number;
  /** Covered pixels, summed as coverage: the ink the hue is laid on. */
  area: number;
  width: number;
  height: number;
  /** Covered pixels in the topmost and bottommost occupied rows: a point, or an edge. */
  topRun: number;
  bottomRun: number;
  /** Ink over the area of the bounding box: how much of its own box a mark fills. */
  density: number;
  raster: Raster;
};

const measure = (name: string): Shape => {
  const { raster, corners } = inkOf(name);
  const { cover, side } = raster;

  let area = 0;
  let minRow = side;
  let maxRow = -1;
  let minCol = side;
  let maxCol = -1;
  const perRow = new Float64Array(side);

  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const value = cover[row * side + col];
      area += value;
      // Half coverage is where a canvas pixel stops reading as background.
      if (value < 0.5) continue;
      perRow[row] += 1;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
    }
  }

  const width = maxCol - minCol + 1;
  const height = maxRow - minRow + 1;

  return {
    name,
    corners,
    area,
    width,
    height,
    topRun: perRow[minRow] ?? 0,
    bottomRun: perRow[maxRow] ?? 0,
    density: area / (width * height),
    raster,
  };
};

/**
 * How much of two marks' combined ink belongs to only one of them, with both
 * centred on the same pixel — the strictest reading, because two symbols on a map
 * are never conveniently offset from each other.
 *
 * Soft rather than thresholded: `Σ|a−b| / Σ max(a,b)` over coverage, so a shape
 * that differs only in antialiased edge pixels scores near zero instead of
 * collecting a free difference from the rounding.
 */
const apart = (a: Raster, b: Raster): number => {
  let diff = 0;
  let union = 0;
  for (let i = 0; i < a.cover.length; i += 1) {
    diff += Math.abs(a.cover[i] - b.cover[i]);
    union += Math.max(a.cover[i], b.cover[i]);
  }
  return union === 0 ? 0 : diff / union;
};

/**
 * Below this, two marks are the same object in two colours.
 *
 * Calibrated on the pair this file exists because of: the old parking square and
 * the old visited-place disc, which is what the complaint was looking at. Its
 * score is printed in the "before" table, and the bar sits above it.
 */
const SAME_OBJECT = 0.3;

/** Which measured properties differ enough to name. Nothing here is asserted. */
const reasons = (a: Shape, b: Shape): string[] => {
  const notes: string[] = [];

  const aspectA = a.width / a.height;
  const aspectB = b.width / b.height;
  if ((aspectA > 1.15 && aspectB < 0.87) || (aspectB > 1.15 && aspectA < 0.87)) {
    const tall = aspectA < aspectB ? a : b;
    notes.push(`${tall.name} cao hơn rộng, cái kia thì không`);
  }

  if (Math.abs(a.height - b.height) >= 2) notes.push(`cao ${a.height} px so với ${b.height} px`);
  if (Math.abs(a.width - b.width) >= 2) notes.push(`rộng ${a.width} px so với ${b.width} px`);

  const thin = Math.min(a.density, b.density);
  const solid = Math.max(a.density, b.density);
  if (solid - thin >= 0.2) {
    const hollow = a.density < b.density ? a : b;
    notes.push(`${hollow.name} rỗng ở giữa (đặc ${thin.toFixed(2)} so với ${solid.toFixed(2)})`);
  }

  if (Math.abs(a.topRun - b.topRun) >= 2) notes.push(`đỉnh ${a.topRun} px so với ${b.topRun} px`);
  if (Math.abs(a.bottomRun - b.bottomRun) >= 2) notes.push(`đáy ${a.bottomRun} px so với ${b.bottomRun} px`);

  if (a.corners !== b.corners) notes.push(`${a.corners} góc so với ${b.corners}`);

  const ratio = Math.max(a.area, b.area) / Math.max(1e-6, Math.min(a.area, b.area));
  if (ratio >= 1.5) notes.push(`mực gấp ${ratio.toFixed(1)} lần`);

  return notes;
};

const table = (title: string, names: string[]): Shape[] => {
  console.log(`\n================ ${title} ================`);
  const shapes = names.map(measure);

  console.log('symbol                      box      ink   density  top  bottom  corners');
  for (const shape of shapes) {
    console.log(
      `${shape.name.padEnd(26)} ${`${shape.width}×${shape.height}`.padStart(6)} ` +
        `${shape.area.toFixed(1).padStart(7)}  ${shape.density.toFixed(2).padStart(7)} ` +
        `${String(shape.topRun).padStart(4)} ${String(shape.bottomRun).padStart(7)} ${String(shape.corners).padStart(8)}`
    );
  }

  console.log('\npairs, colour withheld:');
  let worst = { score: Infinity, pair: '' };
  for (let i = 0; i < shapes.length; i += 1) {
    for (let j = i + 1; j < shapes.length; j += 1) {
      const score = apart(shapes[i].raster, shapes[j].raster);
      const why = reasons(shapes[i], shapes[j]);
      const verdict = score >= SAME_OBJECT ? 'khác nhau' : 'TRÙNG   ';
      console.log(`  ${verdict} ${score.toFixed(2)}  ${shapes[i].name} / ${shapes[j].name}`);
      console.log(`             ${why.length > 0 ? why.join('; ') : 'KHÔNG CÓ GÌ KHÁC NGOÀI MÀU'}`);
      if (score < worst.score) worst = { score, pair: `${shapes[i].name} / ${shapes[j].name}` };
    }
  }
  console.log(`\n  worst pair: ${worst.pair} at ${worst.score.toFixed(2)}`);
  return shapes;
};

const before = table('before — four marks, one silhouette', [
  'cũ: ô đỗ xe',
  'cũ: đã khám phá',
  'cũ: chưa khám phá',
  'cũ: người đi cùng',
]);

const after = table('after — the vocabulary in map-symbols.ts', [
  'bạn (hướng mặt)',
  'xe máy',
  'thuyền',
  'xe máy (bạn đang lái)',
  'thuyền (bạn đang lái)',
  'địa điểm',
  'người đi cùng',
]);

const lowest = (shapes: Shape[]) => {
  let worst = Infinity;
  for (let i = 0; i < shapes.length; i += 1) {
    for (let j = i + 1; j < shapes.length; j += 1) worst = Math.min(worst, apart(shapes[i].raster, shapes[j].raster));
  }
  return worst;
};

console.log('\n================ the scale this all has to survive ================');
console.log('place      terrain   m/px   9 m    500 m   merge span   places');

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
const places = Object.values(LOCATIONS).filter((recipe) => !only || recipe.slug === only);

for (const recipe of places) {
  const perPixel = recipe.terrain.size / MAP;
  console.log(
    `${recipe.slug.padEnd(10)} ${`${recipe.terrain.size} m`.padStart(7)} ${perPixel.toFixed(2).padStart(6)} ` +
      `${`${(JOIN_RANGE / perPixel).toFixed(2)} px`.padStart(8)} ${`${(500 / perPixel).toFixed(1)} px`.padStart(8)} ` +
      `${`${(MERGE_PIXELS * perPixel).toFixed(0)} m`.padStart(11)} ${String(recipe.pois.length).padStart(8)}`
  );
}

console.log('\n================ the rides, plotted for real ================');
console.log('place      tier   rides  drawn  closest pair   verdict');

for (const recipe of places) {
  const terrain = createTerrain(recipe);
  const town = planTown(terrain, recipe, 1);
  const landing = findDockSite(terrain, recipe, town.lots);
  const pois = resolvePois(terrain, recipe, town.lots, landing);
  const net = createRoadNetwork(terrain, recipe, pois, town.lots);
  const dock = createDock(terrain, recipe, landing);
  const perPixel = recipe.terrain.size / MAP;

  for (const tier of ['low', 'ultra'] as const) {
    const settings = QUALITY_SETTINGS[tier];
    const vehicles = createVehicles(recipe, net, settings.vehicles, terrain);
    const life = createLife(
      terrain,
      recipe,
      { people: 0, boats: settings.boats, birds: 0 },
      undefined,
      town.lots,
      dock?.moorings ?? []
    );

    // The same composition `WorldRenderer.rides()` performs.
    const rides = [...life.rideables(), ...vehicles.rideables()].map((ride) => ({
      noun: ride.noun,
      x: ride.position.x / perPixel,
      y: ride.position.z / perPixel,
    }));

    let closest = Infinity;
    for (const a of rides) {
      for (const b of rides) {
        if (a === b || a.noun !== b.noun) continue;
        closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }

    // The merge in `plotRides`, run on the real positions.
    const drawn: typeof rides = [];
    for (const ride of rides) {
      if (drawn.some((o) => o.noun === ride.noun && Math.hypot(o.x - ride.x, o.y - ride.y) < MERGE_PIXELS)) continue;
      drawn.push(ride);
    }

    const stacked = rides.length - drawn.length;
    console.log(
      `${recipe.slug.padEnd(10)} ${tier.padEnd(6)} ${String(rides.length).padStart(5)} ` +
        `${String(drawn.length).padStart(6)} ${`${closest.toFixed(2)} px`.padStart(14)}   ` +
        `${stacked > 0 ? `${stacked} would have stacked` : 'none closer than the merge span'}`
    );

    if (drawn.length < 2) {
      console.log(`           FAILED: ${drawn.length} mark(s) — the merge span has eaten the spread`);
      process.exitCode = 1;
    }
  }
}

const worstAfter = lowest(after);
const worstBefore = lowest(before);
console.log(
  `\nworst pair: ${worstBefore.toFixed(2)} before, ${worstAfter.toFixed(2)} after, bar at ${SAME_OBJECT.toFixed(2)}`
);
if (worstAfter < SAME_OBJECT) {
  console.log('FAILED: two marks still differ by less than the bar — that is a colour cue, not a symbol');
  process.exitCode = 1;
} else {
  console.log('OK — every pair of marks differs by something other than its colour');
}
