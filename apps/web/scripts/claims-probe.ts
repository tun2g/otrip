/**
 * Does vegetation grow out of the asphalt?
 *
 * Builds every location headlessly, assembles the ground claims from what the
 * town, roads, railway, terraces and lakes actually produced, then sows the
 * nature scatter and the grass field twice — once with the claims and once with
 * `null`, which is the behaviour before `ground-claims.ts` existed — and counts
 * how many trees, bushes, rocks, reeds and blades of grass land on each kind of
 * made ground.
 *
 * The counts are read back out of the InstancedMesh matrices, not out of the
 * placement arrays, because what matters is what was handed to the GPU. It exits
 * non-zero if anything still stands on a carriageway, a roof or a railway after
 * the claims are applied.
 *
 *   node --experimental-strip-types apps/web/scripts/claims-probe.ts
 *   node --experimental-strip-types apps/web/scripts/claims-probe.ts --only=ta-xua
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BoxGeometry, Matrix4, MeshStandardMaterial, type InstancedMesh, type Object3D } from 'three';

import type { ClaimKind } from '../src/scene/ground-claims.ts';
import type { MeshSource, NatureSources } from '../src/scene/model-loader.ts';

// The scene modules are written for a bundler, so their relative imports carry
// no extension and Node will not resolve them. Put it back on.
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

// Several of the shader modules read `window.devicePixelRatio` behind a
// `typeof window` guard, so declaring `window` and leaving the ratio off would
// feed them NaN rather than nothing.
const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
globals.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };

const { createTerrain, LOCATION_SLUGS, LOCATIONS } = await import('@otrip/world');
const { collectGroundClaims } = await import('../src/scene/ground-claims.ts');
const { createNatureScatter } = await import('../src/scene/nature-scatter.ts');
const { createGroundCover } = await import('../src/scene/ground-cover.ts');
const { createTownMeshes } = await import('../src/scene/town-meshes.ts');
const { createRoadNetwork } = await import('../src/scene/road-network.ts');
const { createRailway } = await import('../src/scene/railway.ts');
const { createTerraces } = await import('../src/scene/terraces.ts');
const { resolvePois } = await import('../src/scene/points-of-interest.ts');
const { createWind } = await import('../src/scene/wind.ts');
const { createNearTrees } = await import('../src/scene/tree-near.ts');

/**
 * The nature kit off disk is a GLB behind GLTFLoader, an <img> and a texture
 * decode. None of that changes where a tree is put, so every model is answered
 * with the same unit box: the probe measures placement, not silhouette.
 */
const stubSources = (): NatureSources => {
  const geometry = new BoxGeometry(1, 1, 1);
  const source: MeshSource = { geometry, material: new MeshStandardMaterial(), height: 1 };
  const sources = new Map<string, MeshSource>();
  const get = sources.get.bind(sources);
  // Anything asked for exists, so the probe never has to track the kit's
  // filenames and silently measure a kind that was skipped for want of a model.
  sources.has = () => true;
  sources.get = (name: string) => get(name) ?? source;
  return sources;
};

const KINDS: ClaimKind[] = ['road', 'trail', 'railway', 'building', 'terrace', 'water', 'structure'];

type Tally = Record<ClaimKind, number> & { total: number };

const emptyTally = (): Tally => {
  const tally = { total: 0 } as Tally;
  for (const kind of KINDS) tally[kind] = 0;
  return tally;
};

const matrix = new Matrix4();

/**
 * Every drawn instance under this node as x, z, size triples. Read straight out
 * of the matrix — the translation is elements 12 and 14, the x scale is the
 * length of the first column — rather than through `decompose`, which wants a
 * real Quaternion and gives back a rotation nothing here asks about.
 *
 * `size` is the instance's world height, because the stub source is one unit
 * tall, which is what gives the crown radius below without this probe having to
 * keep its own copy of the scatter's numbers.
 *
 * Zero-scale instances are skipped: that is how `ground-cover` hides a blade it
 * has culled, and counting them would report grass that is not on the screen.
 */
const instancesOf = (root: Object3D, into: number[]): number[] => {
  root.traverse((node) => {
    const mesh = node as InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    for (let i = 0; i < mesh.count; i += 1) {
      mesh.getMatrixAt(i, matrix);
      const e = matrix.elements;
      const size = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
      if (size <= 1e-6) continue;
      into.push(e[12], e[14], size);
    }
  });
  return into;
};

/**
 * The same ratio `nature-scatter` uses to publish a tree's canopy, so "the crown
 * hangs over the asphalt" is measured against the crown the scene actually draws
 * rather than against whatever clearance we happened to choose — which would
 * make the after-count zero by construction and prove nothing.
 */
const CROWN = 0.3;

const tallyOf = (
  points: number[],
  kindAt: (x: number, z: number, clearance?: number) => ClaimKind | null,
  /** True to ask about the whole crown, false to ask only about the stem. */
  spread: boolean
): Tally => {
  const tally = emptyTally();
  for (let i = 0; i < points.length; i += 3) {
    tally.total += 1;
    const kind = kindAt(points[i], points[i + 1], spread ? points[i + 2] * CROWN : 0);
    if (kind) tally[kind] += 1;
  }
  return tally;
};

const onClaims = (tally: Tally): number => KINDS.reduce((sum, kind) => sum + tally[kind], 0);

/** Distance bands from the edge of the nearest carriageway, in metres. */
const VERGE_BANDS = [0, 0.5, 1, 1.5, 2, 3, 4, 6, 9];

/**
 * Metres from this point to the nearest road's made edge — negative on the road
 * itself. Computed here rather than asked of `GroundClaims`, which deliberately
 * publishes a pressure and not a distance: a scatterer has no business knowing
 * how far away a road is, only whether it may plant.
 */
const toNearestRoadEdge = (x: number, z: number, roads: readonly { points: Float32Array; width: number }[]): number => {
  let best = Infinity;
  for (const road of roads) {
    const half = road.width / 2;
    for (let i = 3; i < road.points.length; i += 3) {
      const ax = road.points[i - 3];
      const az = road.points[i - 1];
      const bx = road.points[i];
      const bz = road.points[i + 2];
      const dx = bx - ax;
      const dz = bz - az;
      const lengthSq = dx * dx + dz * dz;
      let t = lengthSq > 0 ? ((x - ax) * dx + (z - az) * dz) / lengthSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = x - (ax + dx * t);
      const pz = z - (az + dz * t);
      const distance = Math.sqrt(px * px + pz * pz) - half;
      if (distance < best) best = distance;
    }
  }
  return best;
};

/**
 * Grass per band of distance from the kerb, before and after. This is the
 * measurement that distinguishes a verge from a crop circle: the after/before
 * ratio has to climb across the bands, not jump from nothing to everything.
 */
const vergeProfile = (
  before: number[],
  after: number[],
  roads: readonly { points: Float32Array; width: number }[]
): string[] => {
  // Row 0 is the carriageway itself; rows 1 upward are the bands outward from
  // the kerb, and the last row is everything beyond the widest band.
  const rows = VERGE_BANDS.length + 1;
  const was = new Array<number>(rows).fill(0);
  const now = new Array<number>(rows).fill(0);

  const bin = (points: number[], into: number[]) => {
    for (let i = 0; i < points.length; i += 3) {
      const distance = toNearestRoadEdge(points[i], points[i + 1], roads);
      if (distance < 0) {
        into[0] += 1;
        continue;
      }
      let band = 0;
      while (band + 1 < VERGE_BANDS.length && distance >= VERGE_BANDS[band + 1]) band += 1;
      into[band + 1] += 1;
    }
  };
  bin(before, was);
  bin(after, now);

  const label = (index: number): string => {
    if (index === 0) return 'on road';
    const low = VERGE_BANDS[index - 1];
    const high = VERGE_BANDS[index];
    return high === undefined ? `${low}m+` : `${low}-${high}m`;
  };

  return was.map((count, index) => {
    const ratio = count > 0 ? `${((now[index] / count) * 100).toFixed(0)}%` : '—';
    return `      ${label(index).padEnd(9)} ${String(count).padStart(5)} → ${String(now[index]).padStart(5)}  ${ratio.padStart(4)}`;
  });
};

const row = (label: string, before: Tally, after: Tally): string => {
  const cells = KINDS.filter((kind) => before[kind] > 0 || after[kind] > 0).map(
    (kind) => `${kind} ${String(before[kind]).padStart(5)} → ${String(after[kind]).padStart(4)}`
  );
  return `    ${label.padEnd(16)} ${(cells.join('   ') || '—').padEnd(30)}`;
};

const argument = (name: string, fallback: string): string => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const only = argument('only', '');
const slugs = only ? only.split(',') : LOCATION_SLUGS;

/** Tree, bush, scrub, reed and rock groups keyed by the kind seed in the mesh name. */
const NATURE_KINDS = ['trees', 'bushes', 'scrub', 'reeds', 'rocks'];

let failures = 0;

/**
 * Before measuring anything: both scatterers must survive being handed no claims
 * at all. They were not always able to, and the way they failed took the whole
 * scene down at every location rather than just sowing as they always had — so
 * this runs first, and it runs for its exceptions, not its numbers.
 */
{
  const recipe = LOCATIONS[LOCATION_SLUGS[0] as keyof typeof LOCATIONS];
  const terrain = createTerrain(recipe);
  const wind = createWind(recipe);
  const sources = stubSources();
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  // Called with the argument missing entirely, which is what an un-updated
  // caller does and what no amount of typechecking will catch in a stale bundle.
  const absent = (fn: unknown) => fn as (...args: unknown[]) => unknown;

  try {
    absent(createNatureScatter)(terrain, recipe, sources, { trees: 400, bushes: 200, rocks: 100 }, waterLevel, wind);
    const cover = absent(createGroundCover)(terrain, recipe, sources, 3000, wind) as {
      follow: (x: number, z: number) => void;
    };
    for (let frame = 0; frame < 30; frame += 1) cover.follow(0, 0);
    console.log('no claims argument: both scatterers sow as before, nothing excluded, nothing thrown');
  } catch (error) {
    console.error(`no claims argument threw, which must never happen: ${String(error)}`);
    failures += 1;
  }

  // `nearTrees` is 0 at the low quality tier, so an empty field is a setting
  // rather than an edge case — and it used to take the whole scene down, because
  // the species pick resolved to index -1. Swept rather than spot-checked: the
  // counts where a species wins no slot at all are the ones that broke it.
  for (const slug of LOCATION_SLUGS) {
    const emptyRecipe = LOCATIONS[slug as keyof typeof LOCATIONS];
    const emptyTerrain = createTerrain(emptyRecipe);
    const emptyWind = createWind(emptyRecipe);
    for (let count = 0; count <= 20; count += 1) {
      try {
        const near = createNearTrees(emptyTerrain, emptyRecipe, count, emptyWind, { claims: null, shadows: false });
        near.follow(0, 0);
        near.update(0);
        near.follow(140, 140);
        near.update(0);
        near.dispose();
      } catch (error) {
        console.error(`createNearTrees(${slug}, count ${count}) threw: ${String(error)}`);
        failures += 1;
      }
    }
  }
  console.log('near trees: counts 0..20 at every location lay out without throwing');
}

for (const slug of slugs) {
  const recipe = LOCATIONS[slug as keyof typeof LOCATIONS];
  if (!recipe) {
    console.error(`không có location: ${slug}`);
    process.exitCode = 1;
    continue;
  }

  const terrain = createTerrain(recipe);
  const wind = createWind(recipe);
  const sources = stubSources();
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;

  // The order the renderer is being changed to: everything that claims ground
  // first, vegetation last.
  const town = createTownMeshes(terrain, recipe);
  const pois = resolvePois(terrain, recipe, town.buildings);
  const roads = createRoadNetwork(terrain, recipe, pois, town.buildings);
  const railway = createRailway(terrain, recipe, { buildings: town.buildings });
  const terraces = createTerraces(terrain, recipe, { fields: 3, crops: 2000 }, wind);

  const claims = collectGroundClaims({
    roads: roads.roads,
    railwayObstacles: railway.built ? railway.obstacles : [],
    buildings: town.buildings,
    terraces: terraces.fields,
  });

  console.log(`\n=== ${slug} ===`);
  console.log(
    `  claims ${claims.count} bodies · roads ${roads.roads.length} · buildings ${town.buildings.length} ` +
      `· railway ${railway.built ? railway.obstacles.length : 'none'} · terraces ${terraces.fields.length}`
  );

  // The renderer's own budget, so the numbers are the ones the app draws.
  const trees = recipe.scatter.trees;
  const budget = { trees, bushes: Math.round(trees * 0.7), rocks: Math.round(trees * 0.25) };
  const build = (against: typeof claims | null) =>
    createNatureScatter(terrain, recipe, sources, budget, waterLevel, wind, against);

  const before = build(null);
  const after = build(claims);

  const kindAt = (x: number, z: number, clearance?: number) => claims.kindAt(x, z, clearance);

  for (const seed of NATURE_KINDS) {
    const pick = (scatter: typeof before) => {
      const points: number[] = [];
      for (const child of scatter.group.children) {
        if (child.name.startsWith(`nature-${seed}-`)) instancesOf(child, points);
      }
      // Two questions, because they are two different complaints. The stem count
      // is a plant literally rooted in the asphalt. The crown count is what the
      // user actually sees — foliage hanging over the carriageway — and it is the
      // larger number by far, because a trunk is thin and a canopy is five metres
      // across.
      return { stem: tallyOf(points, kindAt, false), crown: tallyOf(points, kindAt, true) };
    };
    const was = pick(before);
    const now = pick(after);
    if (was.stem.total === 0 && now.stem.total === 0) continue;
    console.log(`  ${seed} · drawn ${was.stem.total} → ${now.stem.total}`);
    console.log(row('stem on it', was.stem, now.stem));
    console.log(row('crown over it', was.crown, now.crown));
    if (onClaims(now.stem) > 0) failures += 1;
  }

  // The hero trees only exist within a hundred metres of the viewer and re-pick
  // as it moves, so they are walked along a road rather than sampled once: this
  // is the kind the user stands next to, and a static sample would miss the
  // sites that only appear once you have walked on.
  const mainRoad = roads.roads[0];
  if (mainRoad && mainRoad.points.length >= 60) {
    const walk = (against: typeof claims | null) => {
      const near = createNearTrees(terrain, recipe, 10, wind, { claims: against, shadows: false });
      const stem = emptyTally();
      const crown = emptyTally();
      let standing = 0;
      // Every tenth centreline vertex, which at SPACING = 7 m is a 70 m stride —
      // further than RESTEP, so every step genuinely re-lays the field.
      for (let at = 0; at + 2 < mainRoad.points.length; at += 30) {
        near.follow(mainRoad.points[at], mainRoad.points[at + 2]);
        near.update(0);
        for (const tree of near.crowns) {
          standing += 1;
          const under = claims.kindAt(tree.x, tree.z);
          if (under) stem[under] += 1;
          const over = claims.kindAt(tree.x, tree.z, tree.radius);
          if (over) crown[over] += 1;
        }
      }
      stem.total = standing;
      crown.total = standing;
      near.dispose();
      return { stem, crown };
    };
    const was = walk(null);
    const now = walk(claims);
    console.log(`  near trees · trees standing along the main road ${was.stem.total} → ${now.stem.total}`);
    console.log(row('stem on it', was.stem, now.stem));
    console.log(row('crown over it', was.crown, now.crown));
    // Judged on the stem, like every other kind: a crown reaching over a
    // carriageway is a tree-lined road, a trunk in the asphalt is the bug.
    if (onClaims(now.stem) > 0) failures += 1;
  }

  // The grass field only covers seventy metres around the viewer, so it is asked
  // about the one place the bug is visible: standing in the middle of a road.
  const main = roads.roads[0];
  if (main && main.points.length >= 3) {
    const at = Math.floor(main.points.length / 6) * 3;
    const viewerX = main.points[at];
    const viewerZ = main.points[at + 2];

    const grass = (against: typeof claims | null) => {
      const cover = createGroundCover(terrain, recipe, sources, 24000, wind, against);
      // A relayout is spread over PASS_FRAMES calls and adopts the same centre
      // while it runs, so this is one settled field, not thirty.
      for (let frame = 0; frame < 40; frame += 1) cover.follow(viewerX, viewerZ);
      const laid = instancesOf(cover.group, []);
      return { tally: tallyOf(laid, kindAt, false), drawn: laid.length / 3, laid };
    };

    const was = grass(null);
    const now = grass(claims);
    console.log(
      `  grass · viewer on a ${main.kind} at ${viewerX.toFixed(0)}, ${viewerZ.toFixed(0)} ` +
        `· drawn ${was.drawn} → ${now.drawn}`
    );
    console.log(row('blade on it', was.tally, now.tally));
    console.log('    verge profile, distance from the kerb:');
    for (const line of vergeProfile(was.laid, now.laid, roads.roads)) console.log(line);
    if (now.tally.road > 0 || now.tally.railway > 0 || now.tally.building > 0) failures += 1;
  } else {
    console.log('  grass skipped: no road to stand on');
  }

  before.dispose();
  after.dispose();
}

if (failures > 0) {
  console.error(`\n${failures} nhóm vẫn còn mọc trên nền đã có chủ.`);
  process.exitCode = 1;
} else {
  console.log('\nKhông còn cây, đá hay cỏ nào mọc trên đường, nhà, đường sắt hay ruộng bậc thang.');
}
