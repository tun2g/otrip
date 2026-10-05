/**
 * Scene census. Builds every location headlessly, calls every scene-generating
 * module, and prints what each one actually produced — draw calls, instances,
 * triangles, and the side channels the rest of the scene reads (buildings,
 * roads, parking, falls, sounds, moorings, exits, obstacles, rideables).
 *
 * It exists because the dominant failure here is a module that typechecks,
 * loads, runs without error and silently produces nothing: `createRoadNetwork`
 * returned zero roads at all four locations for hours without logging or
 * throwing. So this is a check, not a report — it exits non-zero when a module
 * returns nothing it was asked to produce.
 *
 * It also fails on a module nothing reaches, which is the same failure one step
 * earlier: `action-prompt.tsx` was complete and correct and missing only an
 * import line, so the boat mechanic rendered nothing at all. The census could
 * never have caught that by itself, because it only measures what it calls — so
 * `census-orphans.ts` walks the import graph instead, and both answers come out
 * of this one command.
 *
 * And on a module that takes the whole scene down with it, which is the third
 * shape and the only one that needs a browser: `--live=<cdp-port>` measures real
 * frames and gates on the page having issued a draw call, because a renderer that
 * failed to import leaves a full-size canvas, an HTTP 200 and a grey card, and
 * every cheaper signal says the scene is fine.
 *
 *   node --experimental-strip-types apps/web/scripts/scene-census.ts
 *   node --experimental-strip-types apps/web/scripts/scene-census.ts --tier=high --only=ta-xua
 *   node --experimental-strip-types apps/web/scripts/scene-census.ts --live=51766
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Object3D } from 'three';

import { auditChain, chainsOf, STEP_UP, type MakeProbe } from './census-bridges.ts';
import { measureLive } from './census-live.ts';
import { reportOrphans } from './census-orphans.ts';
import type { MeshSource, NatureSources } from '../src/scene/model-loader.ts';
import type { WildlifeCounts } from '../src/scene/wildlife.ts';
import type { WorldWeather } from '../src/scene/weather-state.ts';

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

// Three things here need a browser and none needs a real one. GLTFLoader reaches
// for `self.URL` and an <img> to decode the nature kit's texture atlas,
// `poi-markers` paints its plaque text onto a 2D canvas, and `walker.ts` binds
// keyboard, pointer and pointer-lock listeners the moment it is created. The
// census wants geometry, counts and surface heights, so all three are answered
// with the thinnest possible stub.
//
// `devicePixelRatio` is here rather than left undefined on purpose: three of the
// shader modules read `window.devicePixelRatio` behind a `typeof window` guard,
// so declaring `window` at all and leaving the ratio off would feed them NaN.
const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
globals.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  devicePixelRatio: 1,
};
globals.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  pointerLockElement: null,
  exitPointerLock: () => {},
  createElementNS: () => ({
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'load') queueMicrotask(listener);
    },
    removeEventListener: () => {},
    src: '',
  }),
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () =>
      new Proxy(
        { canvas: { width: 0, height: 0 } },
        {
          get: (target: Record<string, unknown>, key: string) =>
            key in target ? target[key] : () => ({ width: 0, actualBoundingBoxAscent: 0 }),
          set: () => true,
        }
      ),
  }),
};

const { createTerrain, LOCATIONS, LOCATION_SLUGS, scatterOnTerrain } = await import('@otrip/world');
const { InstancedMesh, Mesh, Points } = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

const { QUALITY_SETTINGS } = await import('../src/scene/quality.ts');
const { createWind } = await import('../src/scene/wind.ts');
const { createTerrainMesh } = await import('../src/scene/terrain-mesh.ts');
const { createNatureScatter } = await import('../src/scene/nature-scatter.ts');
const { createGroundCover } = await import('../src/scene/ground-cover.ts');
const { createWater } = await import('../src/scene/water.ts');
const { createStreams } = await import('../src/scene/stream.ts');
const { createWaterfalls } = await import('../src/scene/waterfall.ts');
const { createLakes } = await import('../src/scene/lake.ts');
const { createCanals, slopeCeiling } = await import('../src/scene/canal.ts');
const { createTerraces } = await import('../src/scene/terraces.ts');
const { createTownMeshes } = await import('../src/scene/town-meshes.ts');
const { resolvePois } = await import('../src/scene/points-of-interest.ts');
const { createPoiMarkers } = await import('../src/scene/poi-markers.ts');
const { createRoadNetwork } = await import('../src/scene/road-network.ts');
const { createRailway } = await import('../src/scene/railway.ts');
const { createVehicles } = await import('../src/scene/vehicles.ts');
const { createDock, findDockSite } = await import('../src/scene/dock.ts');
const { createLife } = await import('../src/scene/life.ts');
const { createWildlife } = await import('../src/scene/wildlife.ts');
const { createFish } = await import('../src/scene/fish.ts');
const { createFireflies } = await import('../src/scene/fireflies.ts');
const { createRain } = await import('../src/scene/rain.ts');
const { createDayClouds } = await import('../src/scene/day-clouds.ts');
const { createCloudSea } = await import('../src/scene/cloud-sea.ts');
const { createAircraft } = await import('../src/scene/aircraft.ts');
const { createBoatKit } = await import('../src/scene/boat.ts');
const { createNearTrees } = await import('../src/scene/tree-near.ts');
const { createObstacleIndex } = await import('../src/scene/obstacle-index.ts');
const { createWalker } = await import('../src/scene/walker.ts');
const { CLEAR_WEATHER } = await import('../src/scene/weather-state.ts');

type Tier = keyof typeof QUALITY_SETTINGS;

const MODELS = fileURLToPath(new URL('../public/models/nature/', import.meta.url));

/**
 * Median `follow()` cost the walk test tolerates, in ms, out of a 16.7 ms frame.
 * The median and not the worst: a stop-the-world GC from building the rest of
 * the scene lands inside the timing window and is not this module's cost, while
 * a regression to relaying the whole field would move every busy frame at once.
 */
const FOLLOW_BUDGET = 2;
/** Metres walked, and m/s walked at, by the stutter test. */
const WALK_DISTANCE = 140;
const WALK_SPEED = 1.4;
/** Frames the tick test drives every module through, i.e. one second at 60 Hz. */
const TICK_FRAMES = 60;
/**
 * Unmeasured frames first. A module that lazily grows an array or builds a
 * lookup on its first update pays for it once; charging that to every frame is
 * how `life` at Tràng An read as 17 ms/frame when its steady state is 0.02.
 */
const TICK_WARMUP = 8;

/**
 * 95th-percentile slope over the whole map — `canal.ts`'s own statistic for
 * telling a landscape with steep ground in it from one without. Measured there
 * across all three terrain resolutions: the two deltas 0.10 and 0.29, karst
 * 1.15–2.21, the ridge 2.15–3.08, so the gap at 1 is wide and not a tuning knob.
 *
 * It decides which of canals and terraces a location *owes* output. Without it
 * every zero looks alike: a lake shore with no canal is a bug and a 1,600 m
 * ridge with no canal is the right answer, and the whole point of this script is
 * to be able to tell those apart without a human reading the table.
 */
const DELTA_CEILING = 1;

/** `walker.ts`'s own reach for offering `lên thuyền`. */
const BOARD_REACH = 2.5;
/** Frames the boats are driven for while looking for a chance to board: four minutes. */
const BOARDING_FRAMES = 60 * 240;

/**
 * Clearance above the ground at which a deck chain stops being pavement and
 * starts being a bridge, and therefore owes a walker who can get onto it. Below
 * it the chain is lying on the embankment and is walked as ground.
 */
const ON_DECK_FLOOR = 0.6;

/**
 * Share of a crossing that has to be spent on the deck rather than beside it.
 * Not 1: the chain carries on into the embankment at both ends by design, so the
 * first and last few metres of any crossing are legitimately on the ground.
 */
const ON_DECK_SHARE = 0.75;

/**
 * How much of a chain's length the walker has to get along before being stuck
 * counts as being stuck. The frame budget is nearly twice what the distance needs
 * at walking pace, so anything short of this is a body wedged against something.
 */
const CROSS_SHARE = 0.9;

/**
 * What `createWalker` binds its keyboard and pointer listeners to. Nothing in
 * the census sends it an event; it exists so the constructor does not throw.
 */
const listener = {
  addEventListener: () => {},
  removeEventListener: () => {},
} as unknown as HTMLElement;

/** Heavy rain. Vehicles light up and slow down in it, and nothing headless has driven that path. */
const RAIN_WEATHER: WorldWeather = {
  ...CLEAR_WEATHER,
  cloudCover: 0.95,
  cloudLow: 0.9,
  cloudMid: 0.8,
  precipitation: 14,
  rainIntensity: 0.85,
  storm: 0.5,
  windSpeed: 34,
  humidity: 96,
  visibility: 2_600,
  skyOcclusion: 0.92,
  daylight: 0.35,
};

const argument = (name: string, fallback: string): string => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const tier = argument('tier', 'ultra') as Tier;
const settings = QUALITY_SETTINGS[tier];
if (!settings) {
  console.error(`Tier không hợp lệ: ${tier}`);
  process.exit(2);
}
const only = argument('only', '');
const slugs = only ? only.split(',') : [...LOCATION_SLUGS];

// --- the nature kit, off disk ------------------------------------------------

const loadSources = async (): Promise<NatureSources> => {
  const sources: NatureSources = new Map<string, MeshSource>();

  for (const file of readdirSync(MODELS).filter((name) => name.endsWith('.glb'))) {
    const bytes = readFileSync(MODELS + file);
    const gltf = await new Promise<Awaited<ReturnType<InstanceType<typeof GLTFLoader>['loadAsync']>>>(
      (resolve, reject) =>
        new GLTFLoader().parse(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          '',
          resolve,
          reject
        )
    );

    let found: InstanceType<typeof Mesh> | null = null;
    gltf.scene.updateWorldMatrix(true, true);
    gltf.scene.traverse((node) => {
      if (!found && node instanceof Mesh) found = node;
    });
    if (!found) continue;

    const mesh: InstanceType<typeof Mesh> = found;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    sources.set(file.replace('.glb', ''), {
      geometry,
      material: Array.isArray(mesh.material) ? mesh.material[0] : mesh.material,
      height: box ? Math.max(0.001, box.max.y - box.min.y) : 1,
    });
  }

  return sources;
};

// --- counting ---------------------------------------------------------------

type Count = { draws: number; instances: number; triangles: number };

const countOf = (root: Object3D | null): Count => {
  const count: Count = { draws: 0, instances: 0, triangles: 0 };
  if (!root) return count;

  root.traverse((node) => {
    const geometry = node instanceof Mesh || node instanceof Points ? node.geometry : null;
    if (!geometry) return;

    count.draws += 1;
    const copies = node instanceof InstancedMesh ? node.count : 1;
    if (node instanceof InstancedMesh) count.instances += copies;

    if (node instanceof Points) return;
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    const vertices = index ? index.count : (position?.count ?? 0);
    count.triangles += Math.floor(vertices / 3) * copies;
  });

  return count;
};

/**
 * Instances scaled to zero are the signature silent failure of every module
 * that hides what it cannot place rather than removing it, so they are counted
 * apart from the instances that exist.
 */
const visibleInstances = (root: Object3D): number => {
  let visible = 0;
  root.traverse((node) => {
    if (!(node instanceof InstancedMesh)) return;
    const array = node.instanceMatrix.array;
    for (let i = 0; i < node.count; i += 1) {
      const at = i * 16;
      if (array[at] !== 0 || array[at + 1] !== 0 || array[at + 2] !== 0) visible += 1;
    }
  });
  return visible;
};

// --- the report -------------------------------------------------------------

type Channel = { label: string; value: number; min: number };
type Row = { module: string; count: Count; channels: Channel[]; note?: string };

const failures: string[] = [];

const row = (module: string, root: Object3D | null, channels: Channel[] = [], note?: string): Row => ({
  module,
  count: countOf(root),
  channels,
  note,
});

const need = (label: string, value: number, min = 1): Channel => ({ label, value, min });
const show = (label: string, value: number): Channel => ({ label, value, min: 0 });
/** The module had to put geometry in the scene, whatever else it reports. */
const drawn = (root: Object3D | null, min = 1): Channel => need('drawn', countOf(root).draws, min);

const pad = (text: string, width: number) => text.padEnd(width);
const padNumber = (value: number, width: number) => value.toLocaleString('en-US').padStart(width);

const print = (slug: string, rows: Row[]) => {
  console.log(`\n=== ${slug} · ${tier} · segments ${settings.segments} ===`);
  console.log(
    `${pad('module', 16)}  ${'draws'.padStart(6)}  ${'instances'.padStart(9)}  ${'triangles'.padStart(10)}  channels`
  );

  for (const entry of rows) {
    const channels = entry.channels
      .map((channel) => {
        const failed = channel.value < channel.min;
        if (failed) failures.push(`${slug}/${entry.module}: ${channel.label} = ${channel.value}, cần ≥ ${channel.min}`);
        return `${channel.label}=${channel.value}${failed ? ' ✗' : ''}`;
      })
      .join('  ');

    const empty = entry.count.draws === 0 && entry.channels.every((channel) => channel.min === 0);
    console.log(
      `${pad(entry.module, 16)}  ${padNumber(entry.count.draws, 6)}  ${padNumber(entry.count.instances, 9)}  ` +
        `${padNumber(entry.count.triangles, 10)}  ${channels}${entry.note ? `  (${entry.note})` : ''}${empty ? '  —' : ''}`
    );
  }

  const total = rows.reduce(
    (sum, entry) => ({
      draws: sum.draws + entry.count.draws,
      instances: sum.instances + entry.count.instances,
      triangles: sum.triangles + entry.count.triangles,
    }),
    { draws: 0, instances: 0, triangles: 0 }
  );
  console.log(
    `${pad('TOTAL', 16)}  ${padNumber(total.draws, 6)}  ${padNumber(total.instances, 9)}  ${padNumber(total.triangles, 10)}`
  );
};

// --- one location -----------------------------------------------------------

const census = (slug: string, sources: NatureSources) => {
  const recipe = LOCATIONS[slug];
  if (!recipe) {
    failures.push(`Không có location ${slug}`);
    return;
  }

  const terrain = createTerrain(recipe, settings.segments);
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const wind = createWind(recipe);
  const rows: Row[] = [];

  const terrainMesh = createTerrainMesh(terrain, recipe.ground, recipe.seed);
  rows.push(row('terrain', terrainMesh.mesh));

  const treeBudget = Math.min(recipe.scatter.trees, settings.trees);
  const nature = createNatureScatter(
    terrain,
    recipe,
    sources,
    { trees: treeBudget, bushes: Math.round(treeBudget * 0.7), rocks: Math.round(treeBudget * 0.25) },
    waterLevel,
    wind,
    // Null for now, which is what every caller passes: `world-renderer.ts` does
    // not build a claim set yet. When it does, this has to be the same set, or
    // the census will count trees standing on a road the app keeps clear.
    null
  );
  rows.push(row('nature', nature.group, [need('canopy', nature.canopy.length)]));

  const nearTrees = createNearTrees(terrain, recipe, settings.nearTrees, wind);

  const town = createTownMeshes(terrain, recipe, { density: 1 });
  rows.push(row('town', town.group, [need('buildings', town.buildings.length)], town.style));

  const landing = findDockSite(terrain, recipe, town.buildings);
  const pois = resolvePois(terrain, recipe, town.buildings, landing);
  rows.push(
    row('pois', null, [need('resolved', pois.length, recipe.pois.length)], recipe.pois.map((poi) => poi.kind).join('/'))
  );
  // Again with no buildings at all. A location whose recipe has `town: null`
  // gets exactly this, and a `town` POI there used to vanish from the array
  // without a word — the panel then counted places nobody could ever reach.
  const townless = resolvePois(terrain, recipe, []);
  rows.push(
    row('pois (no town)', null, [
      need('resolved', townless.length, recipe.pois.length),
      need('not last-resort', townless.filter((poi) => poi.fallback !== 'standable').length, recipe.pois.length),
      show('from scatter', townless.filter((poi) => poi.fallback === 'scatter').length),
    ])
  );
  rows.push(row('poi-markers', createPoiMarkers(pois, terrain).group, [need('markers', pois.length)]));

  const groundCover = createGroundCover(terrain, recipe, sources, settings.grass, wind, null);
  const anchor = pois[0] ?? { x: 0, z: 0 };
  // `follow` amortises a pass over many frames, so the field is driven to rest
  // before it is counted: what matters is the grass a standing viewer sees.
  for (let frame = 0; frame < Math.ceil(settings.grass / 2000) + 4; frame += 1) {
    groundCover.follow(anchor.x, anchor.z);
  }
  rows.push(
    row('ground-cover', groundCover.group, [
      need('asked', settings.grass, settings.grass),
      need('visible', visibleInstances(groundCover.group)),
    ])
  );

  // The near half of the forest. Its draw calls are pool capacity — every slot's
  // meshes are built up front and hidden — so the only honest count is `crowns`,
  // which `update` refills from the slots actually standing. And it has to be
  // asked more than once: the field is a lattice round the viewer, so a single
  // station on a bare ridge top reads as a dead module when the ground fifty
  // metres away is full of bamboo.
  let bestCrowns = 0;
  let stationsWithTrees = 0;
  const stations = [...pois.map((poi) => ({ x: poi.x, z: poi.z }))];
  const reach = terrain.size / 2 - 40;
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 6; j += 1) {
      stations.push({ x: -reach + (i / 5) * reach * 2, z: -reach + (j / 5) * reach * 2 });
    }
  }
  for (const station of stations) {
    nearTrees.follow(station.x, station.z);
    nearTrees.update(0);
    if (nearTrees.crowns.length > 0) stationsWithTrees += 1;
    bestCrowns = Math.max(bestCrowns, nearTrees.crowns.length);
  }
  nearTrees.follow(anchor.x, anchor.z);
  nearTrees.update(0);
  rows.push(
    row(
      'tree-near',
      nearTrees.group,
      [
        need('best crowns', bestCrowns, settings.nearTrees > 0 ? 1 : 0),
        show('asked', settings.nearTrees),
        need('stations', stationsWithTrees, settings.nearTrees > 0 ? 1 : 0),
        show('of', stations.length),
        show('at poi[0]', nearTrees.crowns.length),
      ],
      'draws are pool capacity, not trees standing'
    )
  );

  const water = recipe.water ? createWater(terrain, recipe.water) : null;
  rows.push(row('water', water?.mesh ?? null, recipe.water ? [need('surface', water ? 1 : 0)] : []));

  const streams = createStreams(terrain, recipe, {
    streams: settings.streams,
    cascades: settings.streams,
    crossings: Math.max(2, Math.round(settings.streams / 2)),
  });
  // Falls are found, not asked for: a delta at 120 m of relief has streams and
  // no waterfall, and requiring one there would make this check cry wolf.
  rows.push(row('streams', streams.group, [drawn(streams.group), show('falls', streams.falls.length)]));

  const waterfalls = createWaterfalls(terrain, recipe, streams.falls, {
    falls: Math.max(1, Math.round(settings.streams / 2)),
    spray: settings.spray ? 1 : 0,
  });
  rows.push(
    row('waterfalls', waterfalls.group, [need('sounds', waterfalls.sounds.length, streams.falls.length > 0 ? 1 : 0)])
  );

  // Budgets below are the ones `world-renderer.ts` passes, verbatim. A census
  // that asks for a different number than the app does cannot tell a module's
  // zero apart from the caller's zero, which is the only question worth asking.
  const lakes = createLakes(terrain, recipe, { lakes: settings.streams }, sources, wind);
  rows.push(
    row(
      'lakes',
      lakes.group,
      [
        show('lakes', lakes.lakes.length),
        show(
          'reeds',
          lakes.lakes.reduce((sum, lake) => sum + lake.reeds, 0)
        ),
        show('biggest m²', Math.round(lakes.lakes[0]?.area ?? 0)),
      ],
      'basins only where the land has hollows'
    )
  );

  const ceiling = slopeCeiling(terrain);
  const delta = ceiling < DELTA_CEILING;
  // `createCanals` gates on nothing but the water it drains to — the slope test
  // lives in `createStreams`, which hands flat ground straight to this module.
  // So water is the whole requirement, and a canal network in karst is the
  // module working as written rather than a misplacement.
  const owesCanals = recipe.water !== null;

  const canals = createCanals(terrain, recipe, { channels: settings.streams });
  rows.push(
    row(
      'canals',
      canals.group,
      [
        drawn(canals.group, owesCanals ? 1 : 0),
        need('metres', Math.round(canals.length), owesCanals ? 1 : 0),
        show('crossings', canals.crossings.length),
      ],
      recipe.water === null
        ? 'no water to drain to — empty on purpose'
        : `slope95=${ceiling.toFixed(2)}${delta ? ' — also what createStreams returns here' : ''}`
    )
  );

  const terraces = createTerraces(
    terrain,
    recipe,
    { fields: Math.max(1, Math.round(settings.streams / 2)), crops: Math.round(settings.grass * 0.25) },
    wind
  );
  rows.push(
    row(
      'terraces',
      terraces.group,
      [
        need('fields', terraces.fields.length, delta ? 0 : 1),
        show(
          'beds',
          terraces.fields.reduce((sum, field) => sum + field.beds, 0)
        ),
        show(
          'flooded',
          terraces.fields.reduce((sum, field) => sum + field.flooded, 0)
        ),
        show('m²', Math.round(terraces.fields.reduce((sum, field) => sum + field.area, 0))),
      ],
      delta && terraces.fields.length === 0
        ? `slope95=${ceiling.toFixed(2)}, no hillside to step — empty on purpose`
        : `slope95=${ceiling.toFixed(2)}`
    )
  );

  const roads = createRoadNetwork(terrain, recipe, pois, town.buildings);
  rows.push(
    row('roads', roads.group, [
      need('roads', roads.roads.length),
      show('parking', roads.parking.length),
      show('decks', roads.decks.length),
    ])
  );

  // `createVehicles` substitutes rather than omits — a location with no sealed
  // road still gets its full count, all of it in xe máy — so anything short of
  // the budget is a placement failure and not a quiet downgrade.
  const vehicles = createVehicles(recipe, roads, settings.vehicles, terrain);
  rows.push(
    row(
      'vehicles',
      vehicles.group,
      [
        need(
          'driving',
          vehicles.group.children.filter((node) => node.name !== 'motorbike-parked').length,
          roads.roads.length > 0 ? settings.vehicles : 0
        ),
        show('parked', vehicles.group.children.filter((node) => node.name === 'motorbike-parked').length),
      ],
      `${roads.roads.length} road(s) · ${roads.roads.map((road) => road.kind).join('/')}`
    )
  );

  const railway = createRailway(terrain, recipe, { buildings: town.buildings });
  rows.push(
    row(
      'railway',
      railway.group,
      [need('obstacles', railway.obstacles.length, railway.built ? 1 : 0), show('decks', railway.decks.length)],
      railway.built ? 'built' : 'grade too steep — empty on purpose'
    )
  );

  const dock = createDock(terrain, recipe, findDockSite(terrain, recipe, town.buildings));
  rows.push(
    row(
      'dock',
      dock?.group ?? null,
      recipe.water
        ? [need('moorings', dock?.moorings.length ?? 0), need('exits', dock?.exits.length ?? 0)]
        : [show('moorings', 0)]
    )
  );

  const life = createLife(
    terrain,
    recipe,
    { people: settings.people, boats: recipe.water ? settings.boats : 0, birds: settings.birds },
    undefined,
    town.buildings
  );
  rows.push(
    row('life', life.group, [
      need('rideables', life.rideables().length, recipe.water ? 1 : 0),
      show('people asked', settings.people),
    ])
  );

  // --- can anyone actually board one of these boats? ------------------------
  // `walker.ts` offers `lên thuyền` within BOARD_REACH of a hull, so a boat has
  // to come that close to somewhere a body can be standing: the jetty deck, or
  // the shallow water at the bank it can wade into. `createLife` places hulls at
  // random points with three metres of water under them and steers them away
  // from the shore, and nothing passes it `dock.moorings`, so the one place a
  // player would try — alongside the jetty — may never have a boat at it.
  //
  // Driven for real minutes rather than reasoned about: the hulls wander, so the
  // question is whether any of them ever arrives, not where they start.
  if (recipe.water && dock) {
    const standable = [
      ...dock.moorings.map((mooring) => ({ what: 'mooring', x: mooring.x, z: mooring.z })),
      ...dock.platforms.map((deck) => ({ what: 'deck', x: deck.x, z: deck.z })),
      ...dock.exits.map((exit) => ({ what: 'exit', x: exit.x, z: exit.z })),
    ];
    const nearest = standable.map(() => Number.POSITIVE_INFINITY);
    let everBoardable = 0;
    for (let frame = 0; frame < BOARDING_FRAMES; frame += 1) {
      life.update(frame / 60);
      const boats = life.rideables();
      for (let at = 0; at < standable.length; at += 1) {
        for (const boat of boats) {
          const gap = Math.hypot(boat.position.x - standable[at].x, boat.position.z - standable[at].z);
          if (gap < nearest[at]) nearest[at] = gap;
          if (gap <= BOARD_REACH) everBoardable += 1;
        }
      }
    }
    const closest = Math.min(...nearest);
    const where = standable[nearest.indexOf(closest)];
    // And can a player find the jetty at all? Every route into the world starts
    // at a POI, so a jetty far from all of them is a mechanic with no signpost.
    const anchorPoi = pois
      .map((poi) => ({ name: poi.name, gap: Math.min(...standable.map((s) => Math.hypot(poi.x - s.x, poi.z - s.z))) }))
      .sort((a, b) => a.gap - b.gap)[0];
    console.log(
      `${pad('  jetty at', 16)}  ${standable
        .filter((spot) => spot.what !== 'deck')
        .map((spot) => `${spot.what} (${spot.x.toFixed(0)}, ${spot.z.toFixed(0)})`)
        .join('  ')}  · nearest poi ${anchorPoi ? `${anchorPoi.name} ${anchorPoi.gap.toFixed(0)}m` : '—'}`
    );
    console.log(
      `${pad('boarding', 16)}  ${life.rideables().length} hull(s) driven ${(BOARDING_FRAMES / 60).toFixed(0)}s  ` +
        `closest approach ${closest.toFixed(1)}m (${where?.what ?? '—'})  ` +
        `frames within ${BOARD_REACH}m of anywhere standable: ${everBoardable}  ` +
        standable.map((spot, at) => `${spot.what} ${nearest[at].toFixed(0)}m`).join('  ')
    );
    if (everBoardable === 0) {
      failures.push(
        `${slug}/boarding: trong ${(BOARDING_FRAMES / 60).toFixed(0)}s không có thuyền nào vào trong ${BOARD_REACH}m ` +
          `của bến hay bờ lên xuống (gần nhất ${closest.toFixed(1)}m tại ${where?.what ?? '—'}) — ` +
          `không thể lên thuyền bằng cách đi bộ`
      );
    }
  }

  const asked: WildlifeCounts = {
    buffalo: Math.max(1, Math.round(settings.people / 14)),
    dogs: Math.max(1, Math.round(settings.people / 12)),
    chickens: Math.round(settings.people / 3),
    butterflies: Math.round(settings.grass / 900),
    dragonflies: Math.round(settings.grass / 1400),
    goats: Math.round(settings.people / 16),
  };
  const wildlife = createWildlife(terrain, recipe, asked, town.buildings);
  const placed = wildlife.counts();
  // Two kinds are gated inside the module on the land itself, and a zero there
  // is the right answer rather than a silent drop: dragonflies hunt over water,
  // and goats need ground between 0.3 and 1.1 of slope, which a delta has none
  // of. Everything else owes the full count wherever it is asked for.
  const owed: Record<keyof WildlifeCounts, number> = {
    buffalo: asked.buffalo,
    dogs: asked.dogs,
    chickens: asked.chickens,
    butterflies: asked.butterflies,
    dragonflies: recipe.water === null ? 0 : asked.dragonflies,
    goats: delta ? 0 : asked.goats,
  };
  rows.push(
    row(
      'wildlife',
      wildlife.group,
      (Object.keys(asked) as (keyof WildlifeCounts)[]).map((kind) =>
        need(`${kind} ${placed[kind]}/${asked[kind]}`, placed[kind], Math.min(owed[kind], asked[kind]))
      ),
      recipe.water === null ? 'no water: dragonflies 0 on purpose' : delta ? 'delta: goats 0 on purpose' : undefined
    )
  );

  const fish = createFish(terrain, recipe, Math.round(settings.people * 1.5));
  const school = fish?.counts() ?? { fish: 0, schools: 0 };
  rows.push(
    row(
      'fish',
      fish?.group ?? null,
      recipe.water ? [need('fish', school.fish), need('schools', school.schools)] : [show('fish', 0)],
      recipe.water ? undefined : 'no water — null on purpose'
    )
  );

  const fireflies = createFireflies(terrain, recipe, Math.round(settings.grass * 0.012));
  rows.push(row('fireflies', fireflies.points));

  const rain = createRain(terrain, recipe, wind, settings.raindrops);
  rows.push(row('rain', rain.group));

  const dayClouds = createDayClouds(terrain, recipe, settings.cloudSteps);
  rows.push(row('day-clouds', dayClouds.mesh));

  const cloudSea = recipe.cloudSea
    ? createCloudSea(terrain, recipe, recipe.cloudSea, settings.cloudSteps, settings.cloudLayers)
    : null;
  rows.push(row('cloud-sea', cloudSea?.group ?? null, recipe.cloudSea ? [need('decks', cloudSea ? 1 : 0)] : []));

  const aircraft = createAircraft(terrain, recipe);
  rows.push(row('aircraft', aircraft.group));

  const obstacles = [...nature.canopy, ...railway.obstacles];
  const index = createObstacleIndex(obstacles);
  const probe = nature.canopy[0] ?? { x: 0, z: 0 };
  rows.push(
    row('obstacle-index', null, [
      show('obstacles', obstacles.length),
      need('near(canopy[0])', index.near(probe.x, probe.z).length, nature.canopy.length > 0 ? 1 : 0),
    ])
  );

  // Boats are the one thing in the scene that is modelled rather than
  // instanced, so its draw calls are counted per hull: five of them at ultra is
  // most of the whole frame's allowance.
  const kit = createBoatKit();
  const hull = kit.create(0);
  const perBoat = countOf(hull.group);
  rows.push(
    row('boat (1 hull)', hull.group, [
      show('draws × boats', perBoat.draws * settings.boats),
      show('tris', perBoat.triangles),
    ])
  );
  hull.dispose();
  kit.dispose();

  print(slug, rows);

  // --- walking ------------------------------------------------------------
  // `follow()` is what stutters: it is the only thing in the scene that does
  // tens of thousands of terrain samples in one call, and it fires every few
  // metres while you walk.
  // Walked at 1.4 m/s, sampled once per 60 Hz frame, which is how the renderer
  // calls it. The renderer also drains the attribute's update ranges once it has
  // uploaded them; nothing does headless, and the garbage left behind otherwise
  // shows up in the timings as pauses that have nothing to do with follow().
  const uploads: InstanceType<typeof InstancedMesh>[] = [];
  groundCover.group.traverse((node) => {
    if (node instanceof InstancedMesh) uploads.push(node);
  });

  const advance = WALK_SPEED / 60;
  const frames = Math.round(WALK_DISTANCE / advance);
  const spent = new Float64Array(frames);
  const heading = Math.PI / 5;
  let walked = 0;

  for (let frame = 0; frame < frames; frame += 1) {
    const x = anchor.x + Math.cos(heading) * frame * advance;
    const z = anchor.z + Math.sin(heading) * frame * advance;
    if (Math.abs(x) > terrain.size / 2 || Math.abs(z) > terrain.size / 2) break;
    const started = performance.now();
    groundCover.follow(x, z);
    spent[frame] = performance.now() - started;
    walked += 1;
    for (const mesh of uploads) mesh.instanceMatrix.clearUpdateRanges();
  }

  const busy = Array.from(spent.subarray(0, walked))
    .filter((ms) => ms > 0.05)
    .sort((a, b) => a - b);
  const median = busy.length > 0 ? busy[Math.floor(busy.length / 2)] : 0;
  const worst = busy.length > 0 ? busy[busy.length - 1] : 0;
  const total = busy.reduce((sum, ms) => sum + ms, 0);

  const verdict = median > FOLLOW_BUDGET ? ` ✗ (ngân sách ${FOLLOW_BUDGET}ms)` : '';
  if (verdict) failures.push(`${slug}/ground-cover: follow() median ${median.toFixed(2)}ms > ${FOLLOW_BUDGET}ms`);
  console.log(
    `${pad(`walk ${WALK_DISTANCE}m`, 16)}  follow ×${walked} frames, ${busy.length} busy  ` +
      `median ${median.toFixed(2)}ms  worst ${worst.toFixed(2)}ms (cả GC)  total ${total.toFixed(0)}ms${verdict}`
  );

  // --- the tick ------------------------------------------------------------
  // Building is half of it. A module that places everything and then throws on
  // its first update is exactly as invisible as one that places nothing, and
  // until now nothing headless had ever called update(), follow(), setNight()
  // or setWeather() even once. One second at 60 Hz, walking, with night coming
  // on and rain arriving halfway through.
  // The index signature is load-bearing: without it TypeScript applies its weak
  // type check and rejects `terrainMesh`, which has none of these four, even
  // though a module with nothing to tick is exactly what this list must tolerate.
  type Ticked = {
    update?: (elapsed: number, night: number) => void;
    follow?: (x: number, z: number) => void;
    setNight?: (amount: number) => void;
    setWeather?: (weather: WorldWeather) => void;
    [key: string]: unknown;
  };

  const ticked: [string, Ticked | null][] = [
    ['terrain', terrainMesh],
    ['nature', nature],
    ['tree-near', nearTrees],
    ['town', town],
    ['water', water],
    ['streams', streams],
    ['waterfalls', waterfalls],
    ['lakes', lakes],
    ['canals', canals],
    ['terraces', terraces],
    ['roads', roads],
    ['vehicles', vehicles],
    ['railway', railway],
    ['dock', dock],
    ['life', life],
    ['wildlife', wildlife],
    ['fish', fish],
    ['fireflies', fireflies],
    ['rain', rain],
    ['day-clouds', dayClouds],
    ['cloud-sea', cloudSea],
    ['aircraft', aircraft],
  ];

  const costs: [string, number][] = [];
  const samples = new Float64Array(TICK_FRAMES);
  let tickTotal = 0;
  let tickWorst = 0;
  let worstAt = '';

  for (const [label, thing] of ticked) {
    if (!thing) continue;
    const drive = (frame: number) => {
      thing.update?.(frame / 60, frame / TICK_FRAMES);
      // Walked, not stood: `follow` is cheap when nothing moved.
      thing.follow?.(anchor.x + frame * (WALK_SPEED / 60), anchor.z);
      thing.setNight?.(frame / TICK_FRAMES);
      thing.setWeather?.(frame > TICK_FRAMES / 2 ? RAIN_WEATHER : CLEAR_WEATHER);
    };

    try {
      for (let frame = 0; frame < TICK_WARMUP; frame += 1) drive(frame);
      for (let frame = 0; frame < TICK_FRAMES; frame += 1) {
        const started = performance.now();
        drive(TICK_WARMUP + frame);
        samples[frame] = performance.now() - started;
      }
    } catch (cause) {
      failures.push(`${slug}/${label}: tick ném lỗi — ${cause instanceof Error ? cause.stack : String(cause)}`);
      continue;
    }

    const sorted = Array.from(samples).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const worst = sorted[sorted.length - 1];
    tickTotal += median;
    if (worst > tickWorst) {
      tickWorst = worst;
      worstAt = label;
    }
    costs.push([label, median]);
  }

  costs.sort((a, b) => b[1] - a[1]);
  console.log(
    `${pad('tick/frame', 16)}  ${tickTotal.toFixed(2)}ms median CPU over ${costs.length} modules, ` +
      `worst single frame ${tickWorst.toFixed(2)}ms (${worstAt})  ` +
      costs
        .filter(([, ms]) => ms >= 0.02)
        .map(([label, ms]) => `${label} ${ms.toFixed(2)}`)
        .join('  ')
  );

  // --- bridges ------------------------------------------------------------
  // Exactly the list `world-renderer.ts` hands the walker. The user's report on
  // this wiring was that they could not get onto a bridge, so each chain is
  // measured for the lip a body has to climb, for steps in its surface, and then
  // crossed by a real walker driven from the approach.
  const spans = [...(dock?.platforms ?? []), ...roads.decks, ...railway.decks];
  const chains = chainsOf(spans);
  // The renderer passes its canopy index and nothing for `obstacles`, so the
  // probe does the same: a walker that collided with the railway's piers here
  // but not in the app would be measuring a different bridge.
  const canopyIndex = createObstacleIndex(nature.canopy);
  const makeProbe: MakeProbe = (x, z, yaw, list) =>
    createWalker(terrain, listener, x, z, town.buildings, canopyIndex, yaw, undefined, {
      water: recipe.water ?? null,
      platforms: list,
      exits: dock?.exits ?? [],
      rideables: () => life.rideables(),
      reducedMotion: true,
    });

  console.log(
    `${pad('bridges', 16)}  ${spans.length} span(s) in ${chains.length} chain(s)  ` +
      `(dock ${dock?.platforms.length ?? 0} · roads ${roads.decks.length} · railway ${railway.decks.length})`
  );
  // A road is bridged exactly where its ground is under the water line, so a
  // destination with no water owes no deck at all and Tà Xùa's zero is the right
  // answer. Where there is water, a walker with nowhere to walk is the bug the
  // user reported.
  if (spans.length === 0 && recipe.water !== null) {
    failures.push(`${slug}/bridges: có nước nhưng không có platform nào cho người đi bộ`);
  }

  // How high each source hangs its deck above the ground under it. The deck
  // profile is graded and then held at or above the ground, with the `fill > 4`
  // clamp skipped on bridged samples, so there is nothing stopping a span from
  // inheriting the height of a hill a hundred metres away — and this is where
  // that shows up.
  for (const [label, list] of [
    ['roads', roads.decks],
    ['railway', railway.decks],
  ] as const) {
    if (list.length === 0) continue;
    const above = list.map((span) => span.surfaceY - terrain.heightAt(span.x, span.z)).sort((a, b) => a - b);
    const grades = list.map((span) => Math.abs(span.grade ?? 0)).sort((a, b) => a - b);
    console.log(
      `${pad(`  ${label} decks`, 16)}  ${String(list.length).padStart(4)} spans  ` +
        `above ground min ${above[0].toFixed(2)}m p50 ${above[Math.floor(above.length / 2)].toFixed(2)}m ` +
        `max ${above[above.length - 1].toFixed(2)}m  ` +
        `|grade| p50 ${grades[Math.floor(grades.length / 2)].toFixed(3)} max ${grades[grades.length - 1].toFixed(3)}`
    );
  }

  chains.forEach((chain, at) => {
    const audit = auditChain(terrain, chain, spans, makeProbe);
    const verdicts: string[] = [];
    // The decisive one, and it needs no walker: `floorAt` only takes a deck that
    // is within STEP_UP of the foot the walker already has, so a chain with no
    // metre of itself within STEP_UP of the ground cannot be got onto anywhere
    // along its length, however well it is built.
    if (audit.mountable === 0) {
      verdicts.push('không có chỗ lên ✗');
      failures.push(
        `${slug}/bridges[${at}]: không có mét nào của cầu ${audit.length.toFixed(0)}m nằm trong ${STEP_UP}m của mặt đất ` +
          `(mép đầu ${audit.lipStart.toFixed(2)}m, mép cuối ${audit.lipEnd.toFixed(2)}m) — không thể bước lên từ đâu cả`
      );
    }
    if (audit.jumps > 0) {
      verdicts.push('bước giật ✗');
      failures.push(
        `${slug}/bridges[${at}]: ${audit.jumps} mẫu nhảy tới ${(audit.worstJump * 100).toFixed(1)}cm ` +
          `tại ${audit.worstJumpAt.toFixed(0)}m dọc cầu`
      );
    }
    // Only chains that actually stand clear of the ground owe a crossing: a deck
    // laid on the embankment is walked over as ground and proves nothing.
    if (audit.clearance > ON_DECK_FLOOR && !audit.crossed) {
      verdicts.push('không lên được ✗');
      failures.push(
        `${slug}/bridges[${at}]: cầu cao ${audit.clearance.toFixed(2)}m nhưng người đi bộ chỉ lên tới ` +
          `${audit.crossedClearance.toFixed(2)}m (đi được ${(audit.crossedFraction * 100).toFixed(0)}% chiều dài, ` +
          `lệch ${audit.drift.toFixed(1)}m khỏi tim cầu)`
      );
    } else if (audit.crossedFraction < CROSS_SHARE) {
      verdicts.push('tắc giữa cầu ✗');
      failures.push(
        `${slug}/bridges[${at}]: người đi bộ chỉ qua được ${(audit.crossedFraction * 100).toFixed(0)}% của ` +
          `${audit.length.toFixed(0)}m cầu rồi tắc (ở trên mặt cầu ${(audit.onDeck * 100).toFixed(0)}% thời gian)`
      );
    } else if (audit.clearance > ON_DECK_FLOOR && audit.onDeck < ON_DECK_SHARE) {
      verdicts.push('rơi khỏi cầu ✗');
      failures.push(
        `${slug}/bridges[${at}]: chỉ ${(audit.onDeck * 100).toFixed(0)}% thời gian băng cầu là ở trên mặt cầu, ` +
          `lệch tới ${audit.drift.toFixed(1)}m khỏi tim cầu`
      );
    }
    console.log(
      `${pad(`  chain ${at}`, 16)}  ${String(audit.spans).padStart(3)} spans  ${audit.length.toFixed(0).padStart(4)}m  ` +
        `clearance ${audit.clearance.toFixed(2).padStart(6)}m  ` +
        `lip ${audit.lipStart.toFixed(2).padStart(6)}/${audit.lipEnd.toFixed(2).padStart(6)}m  ` +
        `mount ${audit.mountable.toFixed(0).padStart(3)}m@${audit.mountAt.toFixed(0)}m  ` +
        `jumps ${audit.jumps} (worst ${(audit.worstJump * 100).toFixed(1)}cm)  ` +
        `walk ${(audit.crossedFraction * 100).toFixed(0).padStart(3)}% on-deck ${(audit.onDeck * 100).toFixed(0).padStart(3)}% ` +
        `up ${audit.crossedClearance.toFixed(2)}m drift ${audit.drift.toFixed(1)}m  ` +
        (verdicts.length > 0 ? verdicts.join(' ') : 'ok')
    );
  });

  // Scattered house placements, which `resolvePois` falls back on where the
  // recipe has no town. Reported so a `town` POI that cannot be placed is
  // visibly a missing fallback rather than a mystery.
  const houses = scatterOnTerrain(terrain, `${recipe.seed}:houses`, recipe.scatter.houses, {
    minHeight: Math.max(terrain.maxHeight * 0.06, waterLevel + 2.5),
    maxHeight: recipe.scatter.treeLine * 0.8,
    maxSlope: 0.32,
  });
  console.log(`${pad('scatter.houses', 16)}  ${houses.length}/${recipe.scatter.houses} placed`);

  for (const resolved of pois) {
    console.log(
      `${pad('  poi', 16)}  ${pad(resolved.kind, 8)} ${pad(resolved.name, 22)} ` +
        `(${resolved.x.toFixed(0)}, ${resolved.y.toFixed(0)}, ${resolved.z.toFixed(0)})`
    );
  }
  for (const poi of recipe.pois) {
    if (!pois.some((resolved) => resolved.id === poi.id)) {
      console.log(`${pad('  poi', 16)}  ${pad(poi.kind, 8)} ${pad(poi.name, 22)} KHÔNG ĐẶT ĐƯỢC ✗`);
    }
  }

  for (const thing of [
    terrainMesh,
    nature,
    nearTrees,
    town,
    groundCover,
    water,
    streams,
    waterfalls,
    lakes,
    canals,
    terraces,
    roads,
    vehicles,
    railway,
    dock,
    life,
    wildlife,
    fish,
    fireflies,
    rain,
    dayClouds,
    cloudSea,
    aircraft,
  ]) {
    thing?.dispose();
  }
};

const sources = await loadSources();
console.log(`nature kit: ${sources.size} models off disk (${[...sources.keys()].slice(0, 4).join(', ')}, …)`);

for (const slug of slugs) {
  try {
    census(slug, sources);
  } catch (cause) {
    failures.push(`${slug}: ${cause instanceof Error ? `${cause.message}\n${cause.stack}` : String(cause)}`);
  }
}

// Whole-tree, so it runs whatever `--only` narrowed the scene walk to.
failures.push(...reportOrphans());

// The browser half. Opt-in on a port rather than attempted and swallowed: a
// liveness check that quietly skips itself is the same false confidence as the
// canvas-width check it replaces, so the skip is printed either way.
const live = argument('live', '');
if (live) {
  try {
    failures.push(
      ...(await measureLive({
        port: Number(live),
        slugs,
        hours: [
          { label: 'ngày', value: '2026-10-04T09:00' },
          // 01:00 is night, and the wettest hour in the forecast at all four.
          { label: 'đêm', value: '2026-10-04T01:00' },
        ],
        seconds: 10,
      }))
    );
  } catch (cause) {
    failures.push(`--live=${live}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
} else {
  console.log(
    '\n=== frames ===\nbỏ qua: cần --live=<cổng CDP> của một trình duyệt đang mở app ' +
      '(agent-browser get cdp-url --session <tên>). Không có nó thì không ai biết scene có vẽ được hay không.'
  );
}

if (failures.length > 0) {
  console.log(`\n${failures.length} lỗi:`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\nTất cả module đều dựng được những gì được yêu cầu, và không có file nào bị bỏ rơi.');
