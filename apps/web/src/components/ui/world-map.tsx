'use client';

import { createPrng, createTerrain, type LocationRecipe, type Terrain } from '@otrip/world';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { paintCompanion, wordsForRide, type MapRide } from '@/components/ui/map-symbols';
import { RideGlyph } from '@/components/ui/ride-glyph';
import { cn } from '@/lib/utils';
import { alwaysOnMap } from '@/scene/points-of-interest';
import type { ResolvedPoi } from '@/scene/points-of-interest';

export type MapRouteKind = 'main' | 'secondary' | 'lane' | 'trail' | 'rail';
export type MapRoute = { points: { x: number; z: number }[]; kind: MapRouteKind };
export type MapPlayer = { x: number; z: number; yaw: number };
export type MapPerson = { id: string; name: string; x: number; z: number };

/**
 * Line work in world metres, bucketed into a coarse grid. A ridge map holds
 * ~30 000 contour segments and stroking all of them while a finger is dragging
 * is what makes a map feel broken, so only the buckets on screen are drawn.
 */
export type TiledPath = { tiles: Path2D[]; margin: number };

/**
 * Everything the two maps draw, derived once from the recipe. The relief is a
 * raster because a hillshade is continuous tone; the contours and the shoreline
 * are paths in world metres because a hairline has to stay a hairline at every
 * zoom, which an upscaled bitmap cannot do.
 */
export type Relief = {
  terrainSize: number;
  resolution: number;
  bitmap: HTMLCanvasElement;
  /** Lowest and highest dry ground, for the altitude ramp. */
  landMin: number;
  landMax: number;
  waterLevel: number | null;
  contourInterval: number;
  minorContours: TiledPath;
  indexContours: TiledPath;
  shoreline: TiledPath | null;
  /** CSS colours of the altitude ramp, low to high, for the legend. */
  rampStops: string[];
  heightAt: (x: number, z: number) => number;
};

/**
 * The north-west light at 45° every shaded-relief map on earth uses. Any other
 * direction reads as valleys where there are ridges — the brain insists the
 * light comes from above-left.
 */
const LIGHT = { x: -0.5, y: 0.7071, z: -0.5 };

/** Grid samples between contour vertices. 4 keeps the lines near the real resolution of the heightfield. */
const CONTOUR_SAMPLE_STEP = 4;
const SHORE_SAMPLE_STEP = 2;
const CONTOUR_TARGET_LINES = 22;
const CONTOUR_INTERVALS = [2, 5, 10, 20, 25, 50, 100, 200, 500];
const INDEX_EVERY = 5;
const TILE_GRID = 4;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

type WorldRect = { minX: number; maxX: number; minZ: number; maxZ: number };

const strokeTiled = (
  context: CanvasRenderingContext2D,
  line: TiledPath,
  rect: WorldRect,
  terrainSize: number
): void => {
  const span = terrainSize / TILE_GRID;
  const half = terrainSize / 2;

  for (let row = 0; row < TILE_GRID; row += 1) {
    const minZ = -half + row * span - line.margin;
    if (minZ > rect.maxZ || minZ + span + line.margin * 2 < rect.minZ) continue;
    for (let column = 0; column < TILE_GRID; column += 1) {
      const minX = -half + column * span - line.margin;
      if (minX > rect.maxX || minX + span + line.margin * 2 < rect.minX) continue;
      context.stroke(line.tiles[row * TILE_GRID + column]);
    }
  }
};

const parseHex = (hex: string): [number, number, number] => {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

const mixRgb = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * Marching squares, one entry per corner-above-level mask. Edges are numbered
 * 0 top, 1 right, 2 bottom, 3 left; the two saddle cases emit both segments.
 */
const CONTOUR_CASES: readonly number[][] = [
  [],
  [3, 0],
  [0, 1],
  [3, 1],
  [1, 2],
  [3, 0, 1, 2],
  [0, 2],
  [3, 2],
  [2, 3],
  [0, 2],
  [0, 1, 2, 3],
  [1, 2],
  [3, 1],
  [0, 1],
  [3, 0],
  [],
];

const contourPath = (
  grid: Float32Array,
  side: number,
  step: number,
  terrainSize: number,
  levels: number[],
  waterLevel: number | null
): TiledPath => {
  const tiles = Array.from({ length: TILE_GRID * TILE_GRID }, () => new Path2D());
  const cells = Math.floor((side - 1) / step);
  const half = terrainSize / 2;
  const metres = terrainSize / cells;
  const at = (col: number, row: number) => grid[row * step * side + col * step];
  const tileOf = (x: number, z: number) => {
    const column = clamp(Math.floor(((x + half) / terrainSize) * TILE_GRID), 0, TILE_GRID - 1);
    const row = clamp(Math.floor(((z + half) / terrainSize) * TILE_GRID), 0, TILE_GRID - 1);
    return tiles[row * TILE_GRID + column];
  };

  // Interpolated position on one edge of a cell, in cell units.
  const cut = (a: number, b: number, level: number) => {
    const span = b - a;
    return Math.abs(span) < 1e-6 ? 0.5 : clamp((level - a) / span, 0, 1);
  };

  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const a = at(col, row);
      const b = at(col + 1, row);
      const c = at(col + 1, row + 1);
      const d = at(col, row + 1);

      const low = Math.min(a, b, c, d);
      const high = Math.max(a, b, c, d);
      // Contours under the waterline would be bathymetry nobody asked for.
      if (waterLevel !== null && high <= waterLevel) continue;

      for (const level of levels) {
        if (level <= low || level > high) continue;
        const mask = (a > level ? 1 : 0) | (b > level ? 2 : 0) | (c > level ? 4 : 0) | (d > level ? 8 : 0);
        const edges = CONTOUR_CASES[mask];

        for (let pair = 0; pair < edges.length; pair += 2) {
          let path = tiles[0];
          for (let end = 0; end < 2; end += 1) {
            const edge = edges[pair + end];
            let u = col;
            let v = row;
            if (edge === 0) u = col + cut(a, b, level);
            else if (edge === 1) {
              u = col + 1;
              v = row + cut(b, c, level);
            } else if (edge === 2) {
              u = col + cut(d, c, level);
              v = row + 1;
            } else v = row + cut(a, d, level);

            const x = -half + u * metres;
            const z = -half + v * metres;
            if (end === 0) {
              path = tileOf(x, z);
              path.moveTo(x, z);
            } else path.lineTo(x, z);
          }
        }
      }
    }
  }

  // A segment sits in the tile of its first end, so culling has to keep a cell
  // of slack or lines would stop short of the edge of the screen.
  return { tiles, margin: metres };
};

type ReliefBuilder = { advance: () => Relief | null };

/**
 * Built in stages so the browser can breathe between them: the whole thing is
 * about a third of a second of arithmetic, which as one task would show up as a
 * dropped half-second in a scene that is already drawing.
 */
export const createReliefBuilder = (recipe: LocationRecipe, resolution: number): ReliefBuilder => {
  const terrainSize = recipe.terrain.size;
  const half = terrainSize / 2;
  const side = resolution + 1;
  const waterLevel = recipe.water?.level ?? null;
  const metresPerPixel = terrainSize / resolution;

  let terrain: Terrain | null = null;
  let grid = new Float32Array(0);
  let scratch = new Float32Array(0);
  let landMin = Infinity;
  let landMax = -Infinity;
  let interval = 50;
  let ramp = new Uint8Array(0);
  let rampStops: string[] = [];
  let bitmap: HTMLCanvasElement | null = null;
  let minorContours: TiledPath = { tiles: [], margin: 0 };
  let indexContours: TiledPath = { tiles: [], margin: 0 };
  let shoreline: TiledPath | null = null;

  const sample = () => {
    const field = terrain;
    if (!field) return;
    grid = new Float32Array(side * side);
    for (let row = 0; row < side; row += 1) {
      const z = -half + (row / resolution) * terrainSize;
      for (let col = 0; col < side; col += 1) {
        const height = field.heightAt(-half + (col / resolution) * terrainSize, z);
        grid[row * side + col] = height;
        if (waterLevel === null || height >= waterLevel) {
          if (height < landMin) landMin = height;
          if (height > landMax) landMax = height;
        }
      }
    }
    if (landMin > landMax) {
      landMin = waterLevel ?? 0;
      landMax = landMin + recipe.terrain.maxHeight;
    }
    scratch = new Float32Array(side * side);
  };

  // Bilinear upsampling leaves the gradient discontinuous across the cells of
  // the source heightfield, which a hillshade turns into a grid of facets. Two
  // box passes at pixel scale are enough to put them back under the ink.
  const blur = () => {
    for (let row = 0; row < side; row += 1) {
      const up = Math.max(row - 1, 0) * side;
      const here = row * side;
      const down = Math.min(row + 1, side - 1) * side;
      for (let col = 0; col < side; col += 1) {
        const left = Math.max(col - 1, 0);
        const right = Math.min(col + 1, side - 1);
        scratch[here + col] =
          (grid[up + left] +
            grid[up + col] +
            grid[up + right] +
            grid[here + left] +
            grid[here + col] +
            grid[here + right] +
            grid[down + left] +
            grid[down + col] +
            grid[down + right]) /
          9;
      }
    }
    const swap = grid;
    grid = scratch;
    scratch = swap;
  };

  const buildRamp = () => {
    const low = parseHex(recipe.ground.low);
    const mid = parseHex(recipe.ground.mid);
    const high = parseHex(recipe.ground.high);
    const peak = parseHex(recipe.ground.rock);

    // The location's own low → mid → high → rock, but walked across the relief
    // that actually exists rather than the recipe's nominal maxHeight: a delta
    // only uses the bottom fifth of that scale, and tinting it by absolute
    // height produced a map that was one flat olive everywhere. The extra
    // darkening of the low end is what separates two bands of a palette whose
    // colours were chosen to sit next to each other in a landscape.
    const colourAt = (t: number): [number, number, number] => {
      let colour = t < 0.4 ? mixRgb(low, mid, t / 0.4) : mixRgb(mid, high, Math.min(1, (t - 0.4) / 0.35));
      if (t > 0.75) colour = mixRgb(colour, peak, (t - 0.75) / 0.25);
      const lift = 0.84 + t * 0.32;
      return [colour[0] * lift, colour[1] * lift, colour[2] * lift];
    };

    ramp = new Uint8Array(256 * 3);
    for (let step = 0; step < 256; step += 1) {
      const colour = colourAt(step / 255);
      ramp[step * 3] = colour[0];
      ramp[step * 3 + 1] = colour[1];
      ramp[step * 3 + 2] = colour[2];
    }

    rampStops = [];
    for (let stop = 0; stop < 7; stop += 1) {
      const index = Math.round((stop / 6) * 255) * 3;
      rampStops.push(`rgb(${ramp[index]} ${ramp[index + 1]} ${ramp[index + 2]})`);
    }

    const relief = landMax - landMin;
    interval =
      CONTOUR_INTERVALS.find((candidate) => relief / candidate <= CONTOUR_TARGET_LINES) ??
      CONTOUR_INTERVALS[CONTOUR_INTERVALS.length - 1];
  };

  const raster = () => {
    const image = new ImageData(resolution, resolution);
    const pixels = image.data;
    const deep = waterLevel === null ? [20, 30, 45] : parseHex(recipe.water?.deep ?? '#1a2433');
    const shallow = waterLevel === null ? deep : parseHex(recipe.water?.shallow ?? '#1a2433');
    const span = Math.max(1, landMax - landMin);

    for (let row = 0; row < resolution; row += 1) {
      const up = Math.max(row - 2, 0) * side;
      const down = Math.min(row + 2, side - 1) * side;
      const here = row * side;

      for (let col = 0; col < resolution; col += 1) {
        const height = grid[here + col];
        const offset = (row * resolution + col) * 4;
        let r: number;
        let g: number;
        let b: number;

        if (waterLevel !== null && height < waterLevel) {
          const depth = Math.min(1, (waterLevel - height) / 30);
          r = shallow[0] + (deep[0] - shallow[0]) * depth;
          g = shallow[1] + (deep[1] - shallow[1]) * depth;
          b = shallow[2] + (deep[2] - shallow[2]) * depth;
        } else {
          const index = Math.round(clamp((height - landMin) / span, 0, 1) * 255) * 3;
          const left = Math.max(col - 2, 0);
          const right = Math.min(col + 2, side - 1);
          const dx = (grid[here + right] - grid[here + left]) / (4 * metresPerPixel);
          const dz = (grid[down + col] - grid[up + col]) / (4 * metresPerPixel);
          const length = Math.hypot(dx, 1, dz);
          const lit = (-dx * LIGHT.x + LIGHT.y - dz * LIGHT.z) / length;
          // A ridge map is nearly all 40° slopes, so a full-range lambert puts
          // half of it in black. The shadows are compressed until the form is
          // still obvious and the ground under them is still a colour.
          const shade = clamp(0.62 + lit * 0.56, 0.44, 1.26);
          r = ramp[index] * shade;
          g = ramp[index + 1] * shade;
          b = ramp[index + 2] * shade;
        }

        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
        pixels[offset + 3] = 255;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = resolution;
    canvas.height = resolution;
    canvas.getContext('2d')?.putImageData(image, 0, 0);
    bitmap = canvas;
  };

  const contours = () => {
    const levels: number[] = [];
    const indexLevels: number[] = [];
    const first = Math.ceil(landMin / interval) * interval;
    for (let level = first; level <= landMax; level += interval) {
      if (Math.round(level / interval) % INDEX_EVERY === 0) indexLevels.push(level);
      else levels.push(level);
    }

    minorContours = contourPath(grid, side, CONTOUR_SAMPLE_STEP, terrainSize, levels, waterLevel);
    indexContours = contourPath(grid, side, CONTOUR_SAMPLE_STEP, terrainSize, indexLevels, waterLevel);
  };

  const shore = () => {
    if (waterLevel !== null) {
      shoreline = contourPath(grid, side, SHORE_SAMPLE_STEP, terrainSize, [waterLevel], null);
    }
    scratch = new Float32Array(0);
  };

  const stages: (() => void)[] = [
    () => {
      terrain = createTerrain(recipe);
    },
    sample,
    blur,
    blur,
    buildRamp,
    raster,
    contours,
    shore,
  ];

  let done = 0;

  return {
    advance: () => {
      if (done < stages.length) {
        stages[done]();
        done += 1;
      }
      if (done < stages.length || !bitmap || !terrain) return null;

      const heightAt = terrain.heightAt;
      return {
        terrainSize,
        resolution,
        bitmap,
        landMin,
        landMax,
        waterLevel,
        contourInterval: interval,
        minorContours,
        indexContours,
        shoreline,
        rampStops,
        heightAt,
      };
    },
  };
};

const cache = new Map<string, Relief>();

/**
 * One relief per location, built in the gaps between frames and kept, so the
 * corner map and the full map are literally the same drawing and opening the
 * map costs nothing.
 */
export const useRelief = (recipe: LocationRecipe, resolution = 1024): Relief | null => {
  const [relief, setRelief] = useState<Relief | null>(() => cache.get(recipe.slug) ?? null);

  useEffect(() => {
    const ready = cache.get(recipe.slug);
    if (ready) {
      setRelief(ready);
      return;
    }

    setRelief(null);
    const builder = createReliefBuilder(recipe, resolution);
    let handle = 0;
    let cancelled = false;

    const defer = (run: () => void) => {
      handle =
        typeof window.requestIdleCallback === 'function'
          ? window.requestIdleCallback(run, { timeout: 400 })
          : window.setTimeout(run, 24);
    };

    const pump = () => {
      if (cancelled) return;
      const built = builder.advance();
      if (!built) {
        defer(pump);
        return;
      }
      cache.set(recipe.slug, built);
      setRelief(built);
    };

    defer(pump);

    return () => {
      cancelled = true;
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(handle);
      window.clearTimeout(handle);
    };
  }, [recipe, resolution]);

  return relief;
};

/**
 * The scene's compass, written down once because every map marker depends on
 * it and guessing a sign gets you an arrow pointing where you came from.
 *
 * World: the walker sets `yaw = atan2(move.x, move.z)` and feeds it straight to
 * `rotation.y`, so forward is `(sin yaw, 0, cos yaw)`. North is −Z and east is
 * +X — the basis `deriveSkyState` builds the sun direction in, where azimuth 0
 * gives `(0, −1)`. The terrain is a square `terrainSize` metres on a side with
 * the origin at its centre.
 *
 * Map: north up. So world +X is screen right, world +Z is screen down, and both
 * axes map with the same `worldToMapFraction`, with no flip anywhere.
 */
export const worldToMapFraction = (value: number, terrainSize: number) => (value + terrainSize / 2) / terrainSize;

/**
 * Canvas `rotate(θ)` sends a nose drawn at `(0, −r)` to `(r sin θ, −r cos θ)`.
 * Screen down is +Z, so pointing it along `(sin yaw, cos yaw)` needs
 * `sin θ = sin yaw` and `−cos θ = cos yaw`: θ is π − yaw, not −yaw.
 */
export const mapRotationForYaw = (yaw: number) => Math.PI - yaw;

/** Where someone is and which way they face. Shared, so the two maps cannot disagree. */
export const drawHeadingMarker = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  yaw: number,
  { radius, fill, halo }: { radius: number; fill: string; halo?: string }
): void => {
  context.save();
  context.translate(x, y);

  if (halo) {
    context.beginPath();
    context.arc(0, 0, radius * 1.1, 0, Math.PI * 2);
    context.fillStyle = halo;
    context.fill();
  }

  context.rotate(mapRotationForYaw(yaw));
  context.beginPath();
  context.moveTo(0, -radius);
  context.lineTo(radius * 0.64, radius * 0.73);
  context.lineTo(0, radius * 0.41);
  context.lineTo(-radius * 0.64, radius * 0.73);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  context.lineWidth = Math.max(1, radius * 0.13);
  context.strokeStyle = 'rgba(11,16,32,0.9)';
  context.stroke();
  context.restore();
};

const KIND_LABEL: Record<ResolvedPoi['kind'], string> = {
  summit: 'Đỉnh núi',
  valley: 'Sống núi',
  shore: 'Bến thuyền',
  island: 'Đảo',
  town: 'Phố',
  grove: 'Rừng cây',
};

/**
 * These stay letter-free pictures beside a printed name, which is what makes
 * them work at 20 px. There was a seventh, `parking: 'P'`, for a synthetic point
 * per kerb slot; the rides it stood in for now have their own symbols in
 * `map-symbols.ts`, drawn to survive the corner map's 9 px.
 */
const KIND_GLYPH: Record<ResolvedPoi['kind'], string> = {
  summit: '▲',
  valley: '⌃',
  shore: '⚓',
  island: '◍',
  town: '▣',
  grove: '♣',
};

const ROUTE_LABEL: Record<MapRouteKind, string> = {
  main: 'Đường chính',
  secondary: 'Đường nhánh',
  lane: 'Đường làng',
  trail: 'Đường mòn',
  rail: 'Đường sắt',
};

/** Line weights in screen pixels — a road on a map is a symbol, not a measurement. */
const ROUTE_STYLE: Record<
  MapRouteKind,
  { casing?: number; casingColour?: string; width: number; colour: string; dash?: number[] }
> = {
  main: { casing: 6.4, casingColour: 'rgba(16,21,34,0.85)', width: 3.4, colour: '#f0c58a' },
  secondary: { casing: 4.8, casingColour: 'rgba(16,21,34,0.8)', width: 2.4, colour: '#e6d6ba' },
  lane: { width: 1.7, colour: 'rgba(236,222,196,0.9)' },
  trail: { width: 1.4, colour: 'rgba(242,230,208,0.85)', dash: [1.4, 3.2] },
  rail: { casing: 3.2, casingColour: 'rgba(14,18,30,0.9)', width: 2.6, colour: '#cdd9e6', dash: [4.5, 4.5] },
};

const SCALE_CHOICES = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const MAX_ZOOM = 16;
const NO_RIDES: readonly MapRide[] = [];
const NO_PEOPLE: MapPerson[] = [];

/** Exported so the corner map's legend says a distance the same way this one does. */
export const formatDistance = (metres: number) =>
  metres >= 1000 ? `${(metres / 1000).toFixed(metres % 1000 === 0 ? 0 : 1)} km` : `${Math.round(metres)} m`;

/** Undiscovered places are a question mark, not a pin, so the offset has to be stable between opens. */
const approximate = (poi: ResolvedPoi, seed: string, terrainSize: number) => {
  const random = createPrng(`${seed}:map:${poi.id}`);
  const angle = random() * Math.PI * 2;
  const radius = terrainSize * (0.025 + random() * 0.035);
  return { x: poi.x + Math.cos(angle) * radius, z: poi.z + Math.sin(angle) * radius, radius };
};

type WorldMapProps = {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  recipe: LocationRecipe;
  relief: Relief | null;
  pois: ResolvedPoi[];
  /** Live motorbikes and boats, not the kerb they stand on — see `MapRide`. */
  rides?: readonly MapRide[];
  /** Walks to a position rather than to a named place, which is what a ride is. */
  onTravelTo?: (x: number, z: number) => void;
  discovered: Set<string>;
  player: MapPlayer | null;
  others?: MapPerson[];
  routes?: MapRoute[];
  onTravel: (poiId: string) => void;
  /** Fast travel only means anything on foot; off it, the button says so instead of lying. */
  canTravel?: boolean;
};

/**
 * The whole place at once: shaded relief, contours, the water, every road the
 * scene knows about, the people in the room, and the question marks where
 * something is still waiting to be found.
 */
export const WorldMap = ({
  open,
  onOpen,
  onClose,
  recipe,
  relief,
  pois,
  rides = NO_RIDES,
  onTravelTo,
  discovered,
  player,
  others = NO_PEOPLE,
  routes,
  onTravel,
  canTravel = true,
}: WorldMapProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);

  const terrainSize = recipe.terrain.size;
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [view, setView] = useState({ x: 0, z: 0, scale: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);

  const fitScale = frame.width > 0 ? Math.min(frame.width, frame.height) / terrainSize : 0;
  const scale = view.scale > 0 ? view.scale : fitScale;

  // The edge of the patch is the edge of the world: panning stops where the
  // screen would start showing nothing, and at full extent it does not pan at
  // all, so the map can never be dragged away and lost.
  const clampView = useCallback(
    (next: { x: number; z: number; scale: number }) => {
      const half = terrainSize / 2;
      const zoom = clamp(next.scale, fitScale, fitScale * MAX_ZOOM || next.scale);
      const limitX = Math.max(0, half - frame.width / 2 / zoom);
      const limitZ = Math.max(0, half - frame.height / 2 / zoom);
      return { scale: zoom, x: clamp(next.x, -limitX, limitX), z: clamp(next.z, -limitZ, limitZ) };
    },
    [fitScale, frame.height, frame.width, terrainSize]
  );

  useEffect(() => {
    const element = frameRef.current;
    if (!element || !open) return;

    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setFrame({ width: box.width, height: box.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  // Opening shows the whole patch: the first question a map answers is "where is
  // all of this", and panning in from there is a decision, not a chore.
  useEffect(() => {
    if (!open) return;
    setView({ x: 0, z: 0, scale: 0 });
    setSelected(null);
    setLegendOpen(window.matchMedia('(min-width: 768px)').matches);
    // A captured pointer belongs to the walker; the map needs the mouse back.
    if (document.pointerLockElement) document.exitPointerLock();
  }, [open]);

  const zoomBy = useCallback(
    (factor: number, anchor?: { x: number; y: number }) => {
      setView((current) => {
        const from = current.scale > 0 ? current.scale : fitScale;
        const to = clamp(from * factor, fitScale, fitScale * MAX_ZOOM);
        if (!anchor || to === from) return clampView({ ...current, scale: to });
        // Keep the world point under the cursor under the cursor.
        const worldX = current.x + (anchor.x - frame.width / 2) / from;
        const worldZ = current.z + (anchor.y - frame.height / 2) / from;
        return clampView({
          scale: to,
          x: worldX - (anchor.x - frame.width / 2) / to,
          z: worldZ - (anchor.y - frame.height / 2) / to,
        });
      });
    },
    [clampView, fitScale, frame.height, frame.width]
  );

  const routePaths = useMemo(() => {
    if (!routes || routes.length === 0) return [];
    return routes
      .filter((route) => route.points.length > 1)
      .map((route) => {
        const path = new Path2D();
        route.points.forEach((point, index) => {
          if (index === 0) path.moveTo(point.x, point.z);
          else path.lineTo(point.x, point.z);
        });
        return { kind: route.kind, path };
      });
  }, [routes]);

  const project = useCallback(
    (x: number, z: number) => ({
      x: (x - view.x) * scale + frame.width / 2,
      y: (z - view.z) * scale + frame.height / 2,
    }),
    [frame.height, frame.width, scale, view.x, view.z]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!open || !canvas || frame.width === 0) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(frame.width * ratio);
    canvas.height = Math.round(frame.height * ratio);

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, frame.width, frame.height);
    context.fillStyle = '#0b1020';
    context.fillRect(0, 0, frame.width, frame.height);
    if (!relief) return;

    const origin = project(-terrainSize / 2, -terrainSize / 2);
    const extent = terrainSize * scale;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(relief.bitmap, origin.x, origin.y, extent, extent);

    // World metres become the user space, so every hairline below is specified
    // in screen pixels and stays that width at any zoom.
    context.setTransform(
      ratio * scale,
      0,
      0,
      ratio * scale,
      ratio * (frame.width / 2 - view.x * scale),
      ratio * (frame.height / 2 - view.z * scale)
    );
    context.lineJoin = 'round';
    context.lineCap = 'round';

    const visible: WorldRect = {
      minX: view.x - frame.width / 2 / scale,
      maxX: view.x + frame.width / 2 / scale,
      minZ: view.z - frame.height / 2 / scale,
      maxZ: view.z + frame.height / 2 / scale,
    };

    // Zoomed out, contours every 2 m would be closer together than the pixels
    // that have to carry them, so only the index lines are drawn.
    if (scale > fitScale * 1.5) {
      context.strokeStyle = 'rgba(22,28,44,0.42)';
      context.lineWidth = 0.7 / scale;
      strokeTiled(context, relief.minorContours, visible, terrainSize);
    }
    context.strokeStyle = 'rgba(18,24,38,0.62)';
    context.lineWidth = 1.2 / scale;
    strokeTiled(context, relief.indexContours, visible, terrainSize);

    if (relief.shoreline) {
      context.strokeStyle = 'rgba(226,238,245,0.5)';
      context.lineWidth = 1.1 / scale;
      strokeTiled(context, relief.shoreline, visible, terrainSize);
    }

    for (const { kind, path } of routePaths) {
      const style = ROUTE_STYLE[kind];
      context.setLineDash([]);
      if (style.casing) {
        context.strokeStyle = style.casingColour ?? 'rgba(16,21,34,0.85)';
        context.lineWidth = style.casing / scale;
        context.stroke(path);
      }
      if (style.dash) context.setLineDash(style.dash.map((part) => part / scale));
      context.strokeStyle = style.colour;
      context.lineWidth = style.width / scale;
      context.stroke(path);
    }
    context.setLineDash([]);

    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    // The same upright capsule the corner map draws, in the same per-person
    // colour their body, their ring and their compass arrow carry. This was one
    // pale `#cdd9e6` disc for everybody, which is the full map disagreeing with
    // every other drawing of the same person in the app — and a disc is what a
    // place is, which is the collision the corner map had no room to survive.
    for (const person of others) {
      const point = project(person.x, person.z);
      paintCompanion(context, point.x, point.y, person.id, 1.6);

      context.font = '600 11px system-ui, sans-serif';
      context.textAlign = 'center';
      context.lineWidth = 3;
      context.strokeStyle = 'rgba(11,16,32,0.8)';
      context.strokeText(person.name, point.x, point.y - 11);
      context.fillStyle = '#e8eef5';
      context.fillText(person.name, point.x, point.y - 11);
    }

    if (player) {
      const point = project(player.x, player.z);
      drawHeadingMarker(context, point.x, point.y, player.yaw, {
        radius: 11,
        fill: '#f2a679',
        halo: 'rgba(242,166,121,0.18)',
      });
    }
  }, [
    fitScale,
    frame.height,
    frame.width,
    open,
    others,
    player,
    project,
    relief,
    routePaths,
    scale,
    terrainSize,
    view.x,
    view.z,
  ]);

  // M opens and closes, Escape closes. Taken in the capture phase and stopped
  // there, because the scene listens for the same keys on window and a map in
  // front of you must not also be driving the walker behind it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;

      if (event.code === 'KeyM') {
        event.preventDefault();
        event.stopPropagation();
        if (open) onClose();
        else onOpen();
        return;
      }
      if (!open) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      const panStep = 90;
      const pan: Record<string, { x: number; z: number }> = {
        ArrowLeft: { x: -panStep, z: 0 },
        ArrowRight: { x: panStep, z: 0 },
        ArrowUp: { x: 0, z: -panStep },
        ArrowDown: { x: 0, z: panStep },
        KeyA: { x: -panStep, z: 0 },
        KeyD: { x: panStep, z: 0 },
        KeyW: { x: 0, z: -panStep },
        KeyS: { x: 0, z: panStep },
      };
      const step = pan[event.code];
      if (step) {
        event.preventDefault();
        event.stopPropagation();
        const current = scale > 0 ? scale : 1;
        setView((value) =>
          clampView({ ...value, scale: current, x: value.x + step.x / current, z: value.z + step.z / current })
        );
        return;
      }

      if (event.key === '+' || event.key === '=' || event.code === 'Equal') {
        event.preventDefault();
        event.stopPropagation();
        zoomBy(1.4);
      } else if (event.key === '-' || event.code === 'Minus') {
        event.preventDefault();
        event.stopPropagation();
        zoomBy(1 / 1.4);
      }
    };

    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [clampView, onClose, onOpen, open, scale, zoomBy]);

  // A modal that leaks focus to the scene behind it is a trap of its own.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onTab);
    return () => {
      window.removeEventListener('keydown', onTab);
      previous?.focus();
    };
  }, [open]);

  // Wheel has to be a non-passive listener of its own: React's onWheel cannot
  // preventDefault, and without that the page zooms instead of the map.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!open || !canvas) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = canvas.getBoundingClientRect();
      zoomBy(Math.exp(-event.deltaY * 0.0022), { x: event.clientX - box.left, y: event.clientY - box.top });
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [open, zoomBy]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (relief && readoutRef.current && pointers.current.size === 0) {
      const worldX = view.x + (event.clientX - box.left - frame.width / 2) / scale;
      const worldZ = view.z + (event.clientY - box.top - frame.height / 2) / scale;
      const inside = Math.abs(worldX) <= terrainSize / 2 && Math.abs(worldZ) <= terrainSize / 2;
      const height = inside ? relief.heightAt(worldX, worldZ) : 0;
      readoutRef.current.textContent = !inside
        ? ''
        : relief.waterLevel !== null && height < relief.waterLevel
          ? 'mặt nước'
          : `cao ${Math.round(height)} m`;
    }

    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = Array.from(pointers.current.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const start = pinch.current;
      const target = clamp((start.scale * distance) / Math.max(1, start.distance), fitScale, fitScale * MAX_ZOOM);
      const midX = (a.x + b.x) / 2 - box.left;
      const midY = (a.y + b.y) / 2 - box.top;
      setView((current) => {
        const from = current.scale > 0 ? current.scale : fitScale;
        const worldX = current.x + (midX - frame.width / 2) / from;
        const worldZ = current.z + (midY - frame.height / 2) / from;
        return clampView({
          scale: target,
          x: worldX - (midX - frame.width / 2) / target,
          z: worldZ - (midY - frame.height / 2) / target,
        });
      });
      return;
    }

    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    setView((current) =>
      clampView({
        scale: current.scale > 0 ? current.scale : fitScale,
        x: current.x - dx / scale,
        z: current.z - dy / scale,
      })
    );
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  /**
   * Every ride anybody can get to, nearest first.
   *
   * No merging here, unlike the corner map: this one zooms to sixteen times the
   * fit, so two bikes four metres apart are one mark at full extent and two the
   * moment you lean in, and collapsing them would throw away the second machine
   * that the spare in area 0 exists to provide.
   */
  const reachable = useMemo(() => {
    const here = rides.filter((ride) => ride.atRest || ride.taken);
    if (!player) return here;
    const away = (ride: MapRide) => Math.hypot(ride.x - player.x, ride.z - player.z);
    return here.sort((a, b) => away(a) - away(b));
  }, [rides, player]);

  /**
   * What the card is about, from whichever list the selection came from. A place
   * has a name of its own and a ride has a state instead, which is the thing
   * worth reading: a machine you can take, or the one under you.
   */
  const chosen = useMemo(() => {
    const poi = pois.find((entry) => entry.id === selected);
    if (poi)
      return {
        label: KIND_LABEL[poi.kind],
        name: poi.name,
        note: poi.note,
        x: poi.x,
        z: poi.z,
        travel: () => onTravel(poi.id),
      };

    const ride = reachable.find((entry) => entry.id === selected);
    if (!ride) return null;

    const words = wordsForRide(ride.noun);
    return {
      label: words.title,
      name: ride.taken ? 'Bạn đang lái' : 'Còn trống',
      note: words.note,
      x: ride.x,
      z: ride.z,
      // Nothing to walk to when you are already sitting on it.
      travel: ride.taken || !onTravelTo ? null : () => onTravelTo(ride.x, ride.z),
    };
  }, [onTravel, onTravelTo, pois, reachable, selected]);

  const scaleMetres =
    SCALE_CHOICES.find((candidate) => candidate * scale > 72) ?? SCALE_CHOICES[SCALE_CHOICES.length - 1];
  const kinds = useMemo(() => Array.from(new Set((routes ?? []).map((route) => route.kind))), [routes]);

  if (!open) return null;

  const latitude = `${Math.abs(recipe.coords.lat).toFixed(3)}°${recipe.coords.lat >= 0 ? 'B' : 'N'}`;
  const longitude = `${Math.abs(recipe.coords.lon).toFixed(3)}°${recipe.coords.lon >= 0 ? 'Đ' : 'T'}`;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Bản đồ ${recipe.name}`}
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-md"
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="font-display text-base leading-tight sm:text-lg">Bản đồ · {recipe.name}</p>
          <p className="truncate text-[0.7rem] text-subtle">
            {latitude} · {longitude} · cao {recipe.coords.elevation} m · vùng {formatDistance(terrainSize)} mỗi chiều
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label="Thu nhỏ"
            title="Thu nhỏ"
            onClick={() => zoomBy(1 / 1.5)}
            className="size-11 rounded-control border border-border bg-panel/70 text-lg leading-none transition-colors hover:border-border-strong"
          >
            −
          </button>
          <button
            type="button"
            aria-label="Phóng to"
            title="Phóng to"
            onClick={() => zoomBy(1.5)}
            className="size-11 rounded-control border border-border bg-panel/70 text-lg leading-none transition-colors hover:border-border-strong"
          >
            +
          </button>
          <button
            type="button"
            aria-label="Về vị trí của bạn"
            title="Về vị trí của bạn"
            disabled={!player}
            onClick={() => player && setView(clampView({ x: player.x, z: player.z, scale: fitScale * 2.2 }))}
            className="size-11 rounded-control border border-border bg-panel/70 text-base leading-none transition-colors hover:border-border-strong disabled:opacity-40"
          >
            ◎
          </button>
          <button
            ref={closeRef}
            type="button"
            aria-label="Đóng bản đồ"
            onClick={onClose}
            className="h-11 rounded-control border border-accent/60 px-4 text-sm text-accent transition-colors hover:border-accent"
          >
            Đóng
          </button>
        </div>
      </header>

      <div ref={frameRef} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={`Địa hình ${recipe.name}, bắc ở phía trên. Dùng các phím mũi tên để di chuyển, + và − để phóng.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            if (readoutRef.current) readoutRef.current.textContent = '';
          }}
          className="absolute inset-0 size-full cursor-grab touch-none outline-none focus-visible:ring-2 focus-visible:ring-accent/70 active:cursor-grabbing"
        />

        {!relief && (
          <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">Đang dựng bản đồ…</p>
        )}

        <details
          open
          className="absolute top-3 left-3 z-10 max-w-[min(20rem,calc(100%-5rem))] rounded-panel border border-border bg-panel/95 p-3 shadow-panel"
        >
          {/* The heading always said "Xe máy & thuyền" and the list under it held
              neither: it was the kerb slots, twenty of them for six bikes, plus
              the jetty, which is a place and not a boat. */}
          <summary className="cursor-pointer text-sm font-medium text-accent">
            Xe máy &amp; thuyền · {reachable.filter((ride) => !ride.taken).length} chiếc
          </summary>
          <div className="mt-2 flex max-h-32 flex-col gap-1 overflow-y-auto">
            {reachable.length === 0 && <p className="text-xs text-subtle">Chưa có xe hay thuyền nào đang đỗ ở đây.</p>}
            {reachable.map((ride) => (
              <button
                key={ride.id}
                type="button"
                onClick={() => {
                  setSelected(ride.id);
                  setView(clampView({ x: ride.x, z: ride.z, scale: fitScale * 8 }));
                }}
                className="flex min-h-11 items-center gap-2 rounded-control border border-border px-3 py-2 text-left text-xs hover:border-accent"
              >
                <RideGlyph noun={ride.noun} taken={ride.taken} className="size-3 shrink-0" />
                {wordsForRide(ride.noun).title}
                {ride.taken && <span className="text-subtle">bạn đang lái</span>}
                {player && !ride.taken && (
                  <span className="ml-auto text-subtle">
                    {formatDistance(Math.hypot(ride.x - player.x, ride.z - player.z))}
                  </span>
                )}
              </button>
            ))}
          </div>
        </details>

        {relief &&
          pois.map((poi) => {
            const found = discovered.has(poi.id) || alwaysOnMap(poi);
            const spot = found ? { x: poi.x, z: poi.z, radius: 0 } : approximate(poi, recipe.seed, terrainSize);
            const point = project(spot.x, spot.z);
            if (point.x < -60 || point.y < -60 || point.x > frame.width + 60 || point.y > frame.height + 60)
              return null;

            if (!found) {
              return (
                <div
                  key={poi.id}
                  style={{ left: point.x, top: point.y }}
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
                >
                  <span
                    style={{
                      width: Math.max(26, spot.radius * scale * 2),
                      height: Math.max(26, spot.radius * scale * 2),
                    }}
                    className="grid place-items-center rounded-full border border-dashed border-haze/50 bg-background/30 text-xs text-haze/80"
                  >
                    ?
                  </span>
                  <span className="sr-only">Chưa khám phá</span>
                </div>
              );
            }

            return (
              <button
                key={poi.id}
                type="button"
                style={{ left: point.x, top: point.y }}
                onClick={() => setSelected(poi.id)}
                aria-label={`${poi.name} — ${KIND_LABEL[poi.kind]}`}
                className={cn(
                  'absolute grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full outline-none',
                  'focus-visible:ring-2 focus-visible:ring-accent'
                )}
              >
                <span
                  className={cn(
                    'grid size-5 place-items-center rounded-full border text-[0.6rem] shadow-panel transition-transform',
                    selected === poi.id
                      ? 'scale-125 border-accent bg-accent text-background'
                      : 'border-background/70 bg-accent/90 text-background hover:scale-110'
                  )}
                  aria-hidden="true"
                >
                  {KIND_GLYPH[poi.kind]}
                </span>
                <span className="pointer-events-none absolute top-[1.9rem] left-1/2 -translate-x-1/2 rounded-control bg-background/75 px-1.5 py-0.5 text-[0.65rem] whitespace-nowrap text-foreground">
                  {poi.name}
                </span>
              </button>
            );
          })}

        {/* No printed name on a ride, where every place has one. Six markers each
            captioned "Xe máy" is six captions saying what the shape already says,
            and the shape is the thing that has to be learned, because it is all
            the corner map has room for. The legend names it; so does the list and
            so does `aria-label`. */}
        {relief &&
          reachable.map((ride) => {
            const point = project(ride.x, ride.z);
            if (point.x < -60 || point.y < -60 || point.x > frame.width + 60 || point.y > frame.height + 60)
              return null;

            const words = wordsForRide(ride.noun);
            return (
              <button
                key={ride.id}
                type="button"
                style={{ left: point.x, top: point.y }}
                onClick={() => setSelected(ride.id)}
                aria-label={ride.taken ? `${words.title} — bạn đang lái` : `${words.title} — còn trống`}
                className={cn(
                  'absolute grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full outline-none',
                  'focus-visible:ring-2 focus-visible:ring-accent'
                )}
              >
                <RideGlyph
                  noun={ride.noun}
                  taken={ride.taken}
                  className={cn(
                    'size-4 drop-shadow-[0_1px_2px_rgba(11,16,32,0.9)] transition-transform',
                    selected === ride.id ? 'scale-150' : 'hover:scale-125'
                  )}
                />
              </button>
            );
          })}

        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-3 right-3 grid size-11 place-items-center rounded-full border border-border bg-background/70"
        >
          <span className="text-center text-[0.6rem] leading-none text-muted-foreground">
            <span className="block text-accent">▲</span>B
          </span>
        </div>

        <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1">
          <div className="flex items-end gap-2">
            <div
              style={{ width: Math.round(scaleMetres * scale) }}
              className="h-2 border-x-2 border-b-2 border-foreground/70"
              aria-hidden="true"
            />
            <span className="text-[0.7rem] text-foreground/80">{formatDistance(scaleMetres)}</span>
          </div>
          <span ref={readoutRef} className="h-4 text-[0.7rem] text-muted-foreground" />
        </div>

        {relief && (
          <details
            open={legendOpen}
            onToggle={(event) => setLegendOpen(event.currentTarget.open)}
            className="pointer-events-auto absolute right-3 bottom-3 max-w-[13rem] rounded-panel border border-border bg-panel/85 text-[0.7rem] backdrop-blur-md"
          >
            <summary className="cursor-pointer list-none px-3 py-2 font-display text-xs">Chú giải</summary>
            <div className="flex flex-col gap-1.5 px-3 pb-3">
              <div
                aria-hidden="true"
                className="h-2 rounded-full"
                style={{ backgroundImage: `linear-gradient(to right, ${relief.rampStops.join(', ')})` }}
              />
              <p className="flex justify-between text-subtle">
                <span>{Math.round(relief.landMin)} m</span>
                <span>{Math.round(relief.landMax)} m</span>
              </p>
              <p className="text-muted-foreground">Đường bình độ mỗi {relief.contourInterval} m</p>
              {relief.waterLevel !== null && (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-5 rounded-sm"
                    style={{ background: recipe.water?.shallow ?? '#2f4d55' }}
                  />
                  Mặt nước
                </p>
              )}
              {/* The two rides first: they are what somebody opens this panel
                  for, and they are the symbols the corner map has to teach. */}
              {Array.from(new Set(rides.map((ride) => ride.noun))).map((noun) => (
                <p key={noun} className="flex items-center gap-2 text-muted-foreground">
                  <RideGlyph noun={noun} className="size-2.5 shrink-0" />
                  {wordsForRide(noun).title}
                </p>
              ))}
              {rides.some((ride) => ride.taken) && (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <RideGlyph noun={rides.find((ride) => ride.taken)?.noun ?? ''} taken className="size-2.5 shrink-0" />
                  Chiếc bạn đang lái
                </p>
              )}
              {others.length > 0 && (
                <p className="flex items-center gap-2 text-muted-foreground">
                  {/* A rounded pill is the capsule both maps paint, so the row
                      names the shape rather than approximating it. */}
                  <span aria-hidden="true" className="inline-block h-3 w-1.5 shrink-0 rounded-full bg-haze" />
                  Người đi cùng
                </p>
              )}
              <p className="flex items-center gap-2 text-muted-foreground">
                <span aria-hidden="true" className="inline-block size-2 rounded-full bg-accent" />
                Đã khám phá
              </p>
              <p className="flex items-center gap-2 text-muted-foreground">
                <span
                  aria-hidden="true"
                  className="inline-grid size-3.5 place-items-center rounded-full border border-dashed border-haze/60 text-[0.5rem]"
                >
                  ?
                </span>
                Chưa khám phá
              </p>
              {kinds.map((kind) => (
                <p key={kind} className="flex items-center gap-2 text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className="inline-block w-5"
                    style={{
                      borderTop: `${kind === 'main' ? 3 : 2}px ${ROUTE_STYLE[kind].dash ? 'dashed' : 'solid'} ${ROUTE_STYLE[kind].colour}`,
                    }}
                  />
                  {ROUTE_LABEL[kind]}
                </p>
              ))}
            </div>
          </details>
        )}

        {chosen && (
          <section className="pointer-events-auto absolute bottom-3 left-1/2 w-[min(22rem,calc(100%-1.5rem))] -translate-x-1/2 rounded-panel border border-border bg-panel/90 p-3 shadow-panel backdrop-blur-md">
            <p className="text-[0.65rem] tracking-wide text-accent uppercase">{chosen.label}</p>
            <p className="font-display text-base">{chosen.name}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{chosen.note}</p>
            {player && (
              <p className="mt-1 text-[0.7rem] text-subtle">
                cách bạn {formatDistance(Math.hypot(chosen.x - player.x, chosen.z - player.z))}
              </p>
            )}
            <div className="mt-2 flex gap-2">
              {/* Absent rather than disabled for the ride under you: a dead
                  button invites the press that the title has to then explain. */}
              {chosen.travel && (
                <button
                  type="button"
                  disabled={!canTravel}
                  title={canTravel ? undefined : 'Bật “Đi bộ” để tới đây'}
                  onClick={() => {
                    chosen.travel?.();
                    onClose();
                  }}
                  className="h-11 rounded-control border border-accent/60 px-3 text-xs text-accent transition-colors hover:border-accent disabled:opacity-50"
                >
                  Đi tới đây
                </button>
              )}
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="h-11 rounded-control border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-border-strong"
              >
                Đóng
              </button>
            </div>
          </section>
        )}
      </div>

      <p className="shrink-0 border-t border-border px-4 py-2 text-[0.7rem] text-subtle sm:px-6">
        Kéo để di chuyển · lăn chuột hoặc chụm hai ngón để phóng · phím mũi tên và +/− cũng được · M hoặc Esc để đóng
      </p>
    </div>
  );
};
