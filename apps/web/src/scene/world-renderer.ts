import type { SkyState } from '@otrip/contracts';
import { createTerrain, type LocationRecipe, type Terrain } from '@otrip/world';
import {
  Color,
  DirectionalLight,
  FogExp2,
  ACESFilmicToneMapping,
  HemisphereLight,
  PCFShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { createAircraft } from './aircraft';
import { createFish } from './fish';
import { collectGroundClaims } from './ground-claims';
import { createLakes } from './lake';
import { createNearTrees } from './tree-near';
import { createTerraces } from './terraces';
import { planTown, yieldToClaims } from './town-plan';
import { createVehicles } from './vehicles';
import { createWildlife } from './wildlife';
import { createAvatars, type RemotePlayer } from './avatars';
import { createCloudSea } from './cloud-sea';
import { createDayClouds } from './day-clouds';
import { createDock, findDockSite } from './dock';
import { createRailway } from './railway';
import { createRain } from './rain';
import { createRoadNetwork, type ParkingSpot } from './road-network';
import { createStreams } from './stream';
import { createWaterfalls } from './waterfall';
import { createWind } from './wind';
import { createPoiMarkers } from './poi-markers';
import { DISCOVERY_RADIUS, resolvePois, type ResolvedPoi } from './points-of-interest';
import { createPresentPass, type Capture } from './present-pass';
import { detectQuality, QUALITY_SETTINGS, type QualityTier, type RenderStyle } from './quality';
import { createSkyColors, resolveSky } from './sky-palette';
import { createSkyDome } from './sky-dome';
import { createTerrainMesh } from './terrain-mesh';
import { createGroundCover } from './ground-cover';
import { createFireflies } from './fireflies';
import { createLife } from './life';
import type { HumanSource } from './human';
import type { NatureSources } from './model-loader';
import { createNatureScatter } from './nature-scatter';
import { createObstacleIndex } from './obstacle-index';
import { createTownMeshes } from './town-meshes';
import { CLEAR_WEATHER, blendWeather, type WorldWeather } from './weather-state';
import { createWalker, type Joystick, type Walker } from './walker';
import { createWater } from './water';

/** The five idioms the map draws: four road classes plus the line. */
export type RouteKind = 'main' | 'secondary' | 'lane' | 'trail' | 'rail';

const BASE_FOV = 52;
const BASE_FOV_RADIANS = (BASE_FOV * Math.PI) / 180;
const REFERENCE_ASPECT = 16 / 9;

/**
 * What the scene shows before the live forecast lands: the sun just up, a full
 * deck of cloud. The page must never open on a grey nothing while waiting on a
 * network call it may not win.
 */
const OPENING_SKY: SkyState = {
  phase: 'golden',
  sunElevation: 4,
  sunAzimuth: 96,
  sunDirection: { x: 0.78, y: 0.22, z: 0.26 },
  warmth: 0.71,
  daylight: 0.71,
  fogDensity: 0.0001,
  cloudAltitudeScale: 1,
  cloudOpacity: 0.9,
  // In line with `deriveSkyState`, whose daylight maxima are 1.53 and 0.60, so
  // the opening frame matches the first real one instead of blowing past it.
  sunIntensity: 1.5,
  fillIntensity: 0.58,
  moonIntensity: 0,
  ambientIntensity: 0.38,
};

/**
 * Highest point in the middle of the map, used only to pick an opening height
 * for the camera so the framing adapts to whatever the seed produced.
 */
const findRidgeViewpoint = (
  heights: Float32Array,
  segments: number,
  size: number
): { x: number; y: number; z: number } => {
  const side = segments + 1;
  const margin = Math.floor(segments * 0.25);
  const step = size / segments;
  const half = size / 2;

  let best = { x: 0, y: -Infinity, z: 0 };

  for (let row = margin; row < side - margin; row += 1) {
    for (let col = margin; col < side - margin; col += 1) {
      const y = heights[row * side + col];
      if (y > best.y) {
        best = { x: -half + col * step, y, z: -half + row * step };
      }
    }
  }

  return best;
};

export type LocalMove = { x: number; z: number; yaw: number };

export type WorldRenderer = {
  applySky: (state: SkyState, weather: WorldWeather) => void;
  /** The action available where the walker stands, in Vietnamese, without a key. */
  prompt: () => string | null;
  /** Takes it. A tap on the on-screen prompt and the E key share one path. */
  interact: () => void;
  /** True while the walker is aboard a boat — the HUD reads differently afloat. */
  riding: () => boolean;
  /**
   * Road centrelines in world metres, for the map. Resolved once at build, the
   * way `pois` is, so the HUD's existing poll picks both up in the same tick.
   */
  routes: { points: { x: number; z: number }[]; kind: RouteKind }[];
  /** Switch between orbiting the diorama and walking it on foot. */
  setWalking: (enabled: boolean) => void;
  setRemotePlayers: (players: RemotePlayer[]) => void;
  setJoystick: (input: Joystick | null) => void;
  setStyle: (style: RenderStyle) => void;
  setSensitivity: (value: number) => void;
  /** Pointer lock state, so the UI can tell people how to get it back. */
  onLockChange: (handler: ((locked: boolean) => void) | null) => void;
  requestLock: () => void;
  toggleView: () => void;
  onViewChange: (handler: ((view: 'first' | 'third') => void) | null) => void;
  onLocalMove: (handler: ((move: LocalMove) => void) | null) => void;
  /** One frame at an exact size, for the shareable postcard. */
  capture: (width: number, height: number) => Capture;
  /** Places to find, already resolved against this seed's terrain. */
  pois: ResolvedPoi[];
  /**
   * Where motorbikes stand parked. Already real: `vehicles.ts` leaves three of
   * them here. Surfaced so the maps can mark it, because a parked bike you
   * cannot find is the same as no bike at all.
   */
  parking: ParkingSpot[];
  setDiscovered: (ids: Set<string>) => void;
  /** Jump to a place already visited. Walking is only required the first time. */
  travelTo: (poiId: string) => void;
  onDiscover: (handler: ((poi: ResolvedPoi) => void) | null) => void;
  /** Where the walker is, for the compass and the minimap. */
  localPosition: () => { x: number; z: number; yaw: number };
  /** A top-down picture of the terrain, drawn once for the minimap. */
  minimap: (size: number) => ImageData;
  terrainSize: number;
  dispose: () => void;
};

/**
 * Somewhere to stand: on land, off the cliffs, and not inside somebody's house —
 * spawning in a wall put the camera inside the building and filled the screen
 * with roof.
 */
const findSpawn = (
  terrain: Terrain,
  waterLevel: number,
  buildings: { x: number; z: number; radius: number }[]
): { x: number; z: number } => {
  const half = terrain.size / 2;
  const clear = (x: number, z: number) =>
    buildings.every((building) => Math.hypot(x - building.x, z - building.z) > building.radius + 14);

  for (let radius = 0; radius < half; radius += terrain.size / 80) {
    for (let step = 0; step < 16; step += 1) {
      const angle = (step / 16) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (terrain.heightAt(x, z) > waterLevel + 2 && terrain.slopeAt(x, z) < 0.35 && clear(x, z)) return { x, z };
    }
  }
  return { x: 0, z: 0 };
};

export const createWorldRenderer = (
  canvas: HTMLCanvasElement,
  recipe: LocationRecipe,
  tier: QualityTier = detectQuality(),
  style: RenderStyle = 'sharp',
  sources: NatureSources = new Map(),
  humanSource?: HumanSource
): WorldRenderer => {
  const settings = QUALITY_SETTINGS[tier];
  const terrain = createTerrain(recipe, settings.segments);

  const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  // Filmic tone mapping instead of none: it is what turns a linear render into
  // an image, holding highlights together instead of clipping the sky to paper.
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  // Shadows are the single biggest thing separating "lit geometry" from a place
  // that looks like it is standing in sunlight.
  if (settings.shadowMap > 0) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.maxPixelRatio));

  const scene = new Scene();
  scene.background = new Color();
  scene.fog = new FogExp2(0x000000, OPENING_SKY.fogDensity);

  const skyDome = createSkyDome(terrain.size * 7);
  scene.add(skyDome.mesh);

  // Image-based lighting from the scene's own sky. Everything then picks up the
  // colour of the air it is standing in — the single biggest difference between
  // "lit geometry" and a photograph of a place.
  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const skyOnly = new Scene();
  skyOnly.add(skyDome.environmentMesh);
  let environment: ReturnType<PMREMGenerator['fromScene']> | null = null;
  let environmentAt = -Infinity;

  const refreshEnvironment = (now: number) => {
    // Regenerating costs a few milliseconds, so it runs on a timer rather than
    // on every frame of a sky transition.
    if (now - environmentAt < 400) return;
    environmentAt = now;
    environment?.texture.dispose();
    environment = pmrem.fromScene(skyOnly);
    scene.environment = environment.texture;
  };

  // Warm key, cool fill. A single warm light from both directions flattened the
  // whole range into one orange mass; the cool sky bounce is what reads as dawn.
  const sun = new DirectionalLight(0xffffff, OPENING_SKY.sunIntensity);
  scene.add(sun);
  scene.add(sun.target);

  if (settings.shadowMap > 0) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(settings.shadowMap, settings.shadowMap);
    // One directional light over a five-kilometre map would waste the whole map
    // on texels nobody sees, so the shadow frustum is a box that follows
    // whatever the camera is actually looking at.
    // `bias` is a fraction of the shadow camera's depth range, so with a far
    // plane kilometres away a value that looks tiny becomes a shove of tens of
    // metres and every shadow disappears. Keep the range tight and lean on
    // normalBias, which is in world units.
    sun.shadow.camera.near = terrain.size * 0.15;
    sun.shadow.camera.far = terrain.size * 1.6;
    sun.shadow.bias = 0;
    sun.shadow.normalBias = 2.5;
    // PCF with a radius softens the staircase on shadow edges; soft shadow maps
    // were removed from three, so this is the remaining knob.
    sun.shadow.radius = 2.5;
  }
  // With image-based lighting doing the ambient work, the old stack of a
  // hemisphere light plus an ambient light on top of the sun blew the whole
  // scene to white. The hemisphere stays only as a faint ground bounce.
  const fill = new HemisphereLight(0xffffff, new Color(recipe.ground.mid), 0.18);
  scene.add(fill);

  const moon = new DirectionalLight(new Color('#aec3e8'), 0);
  scene.add(moon);

  const terrainMesh = createTerrainMesh(terrain, recipe.ground, recipe.seed);
  terrainMesh.mesh.receiveShadow = settings.shadowMap > 0;
  terrainMesh.mesh.castShadow = settings.shadowMap > 0;
  scene.add(terrainMesh.mesh);

  const castsShadow = settings.shadowMap > 0;
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;

  // One wind field for the whole world. Every swaying thing reads it, so the
  // grass, the forest and the rain cannot disagree about which way it blows.
  const wind = createWind(recipe);

  const water = recipe.water ? createWater(terrain, recipe.water) : null;
  if (water) scene.add(water.mesh);

  // `createStreams` is the dispatcher: on karst and on flat ground it returns a
  // canal network instead of a stream tracer, because limestone drains through
  // itself and a delta has nothing to fall down. A second `createCanals` call
  // used to stand here as well, on the same `${seed}:canal` seed, so Hội An,
  // Tràng An and Hồ Tây each carried two identical channel networks laid exactly
  // on top of each other — same six meshes, twice the draw calls, and every
  // bank z-fighting with its own copy.
  const streams = createStreams(terrain, recipe, {
    streams: settings.streams,
    cascades: settings.streams,
    crossings: Math.max(2, Math.round(settings.streams / 2)),
  });
  scene.add(streams.group);

  const lakes = createLakes(terrain, recipe, { lakes: settings.streams }, sources, wind);
  scene.add(lakes.group);

  const terraces = createTerraces(
    terrain,
    recipe,
    { fields: Math.max(1, Math.round(settings.streams / 2)), crops: Math.round(settings.grass * 0.25) },
    wind
  );
  scene.add(terraces.group);

  const waterfalls = createWaterfalls(terrain, recipe, streams.falls, {
    falls: Math.max(1, Math.round(settings.streams / 2)),
    spray: settings.spray ? 1 : 0,
  });
  scene.add(waterfalls.group);

  // Every location gets a settlement now — a nhà sàn hamlet on the ridge, a
  // delta village in the karst — so this is no longer gated on `recipe.town`.
  //
  // Planned before the roads and built after them, because the two need each
  // other in opposite directions and only one can go first. The trunk is routed
  // to the densest cluster of houses, so the lots have to exist before it is
  // drawn; but `buildGrid` and `stepCost` carry no building term at all, so the
  // route is then drawn straight through them. Measured across the four
  // destinations that was 18 houses standing on a carriageway and 11 with a
  // centreline through the footprint. Letting `planTown` refuse claimed ground
  // instead also reaches zero, and is worse: a refused lot reshuffles the prng,
  // every later settlement lands elsewhere, and the roads just routed to them
  // are left pointing at nothing — at Tràng An a lane that ended 13 m from a
  // house ended 114 m from one.
  const townPlan = planTown(terrain, recipe, 1);

  const avatars = createAvatars();
  scene.add(avatars.group);

  // One site, used both for the jetty and for the name that points at it.
  // Letting each side find its own by its own rule is how the "Bến thuyền" POI
  // ended up 2.2–3.1 km from the bến thuyền: `findSite` wants sheltered bank
  // near the houses with water deep enough to moor in, while the `shore` scorer
  // wants the waterline furthest from the middle of the map. Walking to the
  // marker arrived at open water with no jetty and no boat.
  const landing = findDockSite(terrain, recipe, townPlan.lots);
  const pois = resolvePois(terrain, recipe, townPlan.lots, landing);

  const roads = createRoadNetwork(terrain, recipe, pois, townPlan.lots);
  scene.add(roads.group);

  // Now the carriageway exists, the lots that turned out to be standing on it
  // step back off it — keeping their yaw, or sliding along the frontage where
  // the ridge leaves nowhere to step back to.
  yieldToClaims(terrain, recipe, townPlan, collectGroundClaims({ roads: roads.roads }));

  const town = createTownMeshes(terrain, recipe, { plan: townPlan });
  {
    town.group.traverse((node) => {
      node.castShadow = castsShadow;
      node.receiveShadow = castsShadow;
    });
    scene.add(town.group);
  }

  const railway = createRailway(terrain, recipe, { buildings: town.buildings });
  scene.add(railway.group);

  // Flattened from the same buffers the ribbons were built from, so the map and
  // the world cannot disagree about where a road goes.
  const routes: { points: { x: number; z: number }[]; kind: RouteKind }[] = roads.roads.map((road) => {
    const points: { x: number; z: number }[] = [];
    for (let i = 0; i < road.points.length; i += 3) points.push({ x: road.points[i], z: road.points[i + 2] });
    return { points, kind: road.kind as RouteKind };
  });

  const vehicles = createVehicles(recipe, roads, settings.vehicles, terrain);
  scene.add(vehicles.group);

  const dock = createDock(terrain, recipe, landing);
  if (dock) scene.add(dock.group);

  // Vegetation is sown last, because everything above has a claim on the ground
  // it would otherwise grow through. Sown first — which is how it was — trees
  // and grass came up through the asphalt, the houses and the terraces, since
  // the scatterer hunts for flat gentle ground and asphalt is the flattest
  // ground on the map.
  const claims = collectGroundClaims({
    roads: roads.roads,
    railwayObstacles: railway.built ? railway.obstacles : [],
    buildings: town.buildings,
    terraces: terraces.fields,
    lakes: lakes.lakes,
    // A circle over the jetty's rectangle rounds outward, which errs safely in
    // both directions it can: out over water, where nothing grows anyway, and
    // in across the landing, where a tree would be in the way regardless.
    structures: dock
      ? [
          {
            x: dock.walkway.x,
            z: dock.walkway.z,
            radius: Math.hypot(dock.walkway.halfWidth, dock.walkway.halfLength),
          },
        ]
      : [],
  });

  const treeBudget = Math.min(recipe.scatter.trees, settings.trees);
  const nature = createNatureScatter(
    terrain,
    recipe,
    sources,
    { trees: treeBudget, bushes: Math.round(treeBudget * 0.7), rocks: Math.round(treeBudget * 0.25) },
    waterLevel,
    wind,
    claims
  );
  nature.group.traverse((node) => {
    node.castShadow = castsShadow;
    node.receiveShadow = castsShadow;
  });
  scene.add(nature.group);

  // A handful of properly built trees in front of the viewer; the instanced cone
  // field keeps the horizon behind them.
  const nearTrees = createNearTrees(terrain, recipe, settings.nearTrees, wind, { claims });
  scene.add(nearTrees.group);

  const groundCover = createGroundCover(terrain, recipe, sources, settings.grass, wind, claims);
  scene.add(groundCover.group);
  const canopyIndex = createObstacleIndex(nature.canopy);
  const markers = createPoiMarkers(pois, terrain);
  scene.add(markers.group);

  const life = createLife(
    terrain,
    recipe,
    { people: settings.people, boats: recipe.water ? settings.boats : 0, birds: settings.birds },
    humanSource,
    town.buildings,
    dock?.moorings ?? []
  );
  scene.add(life.group);

  const fireflies = createFireflies(terrain, recipe, Math.round(settings.grass * 0.012));
  scene.add(fireflies.points);

  const aircraft = createAircraft(terrain, recipe);
  scene.add(aircraft.group);

  const wildlife = createWildlife(
    terrain,
    recipe,
    {
      buffalo: Math.max(1, Math.round(settings.people / 14)),
      dogs: Math.max(1, Math.round(settings.people / 12)),
      chickens: Math.round(settings.people / 3),
      butterflies: Math.round(settings.grass / 900),
      dragonflies: Math.round(settings.grass / 1400),
      goats: Math.round(settings.people / 16),
    },
    town.buildings
  );
  scene.add(wildlife.group);

  const fish = createFish(terrain, recipe, Math.round(settings.people * 1.5));
  if (fish) scene.add(fish.group);

  const rain = createRain(terrain, recipe, wind, settings.raindrops);
  scene.add(rain.group);

  // The other half of rain: ground that darkens and holds water. One shared
  // uniform, so every surface dries on the same curve — `rain.update` keeps
  // writing it after the last drop, because tarmac stays wet for minutes once
  // the shower has passed. Each module keeps its own numbers; asphalt does not
  // gloss like mud or roof tile.
  terrainMesh.setWet(rain.wetUniform);
  roads.setWet(rain.wetUniform);
  terraces.setWet(rain.wetUniform);
  town.setWet(rain.wetUniform);
  nature.setWet(rain.wetUniform);

  const dayClouds = createDayClouds(terrain, recipe, settings.cloudSteps);
  scene.add(dayClouds.mesh);

  const cloudSea = recipe.cloudSea
    ? createCloudSea(terrain, recipe, recipe.cloudSea, settings.cloudSteps, settings.cloudLayers)
    : null;
  if (cloudSea) scene.add(cloudSea.group);

  const viewpoint = findRidgeViewpoint(terrain.heights, terrain.segments, terrain.size);

  // What the eye should settle on differs by destination: the cloud deck in a
  // range, the water surface where there is water, otherwise mid-slope.
  const focus = cloudSea?.altitude ?? recipe.water?.level ?? viewpoint.y * 0.4;

  const camera = new PerspectiveCamera(BASE_FOV, 1, 2, terrain.size * 10);
  camera.position.set(terrain.size * 0.2, Math.max(viewpoint.y, focus) + terrain.size * 0.12, terrain.size * 0.62);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, focus + 30, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 160;
  controls.maxDistance = terrain.size * 0.75;
  // Stop short of the horizon so the camera never slips under the terrain.
  controls.maxPolarAngle = 1.52;
  controls.update();

  // Start within sight of the first place rather than wherever the middle of the
  // map happens to be: the loop has to teach itself in seconds, not after a
  // kilometre of holding W.
  /**
   * Where you arrive decides whether the place reads as a landscape or as a wall
   * of dirt two metres from your face. A spot only counts if you can actually
   * see out of it: the ground toward the first landmark must not rear up in the
   * first eighty metres.
   */
  const spawn = (() => {
    const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
    const base = findSpawn(terrain, waterLevel, town.buildings);
    const first = pois[0];
    if (!first) return base;

    /** Average ground on a ring, to tell a crest from a hollow. */
    const ringAverage = (x: number, z: number, radius: number) => {
      let total = 0;
      for (let step = 0; step < 8; step += 1) {
        const angle = (step / 8) * Math.PI * 2;
        total += terrain.heightAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
      }
      return total / 8;
    };

    const hasOutlook = (x: number, z: number) => {
      const eye = terrain.heightAt(x, z) + 2.5;
      const toward = Math.atan2(first.x - x, first.z - z);

      for (let step = 15; step <= 80; step += 15) {
        const ahead = terrain.heightAt(x + Math.sin(toward) * step, z + Math.cos(toward) * step);
        if (ahead > eye + 6) return false;
      }
      return true;
    };

    for (let radius = 260; radius < 900; radius += 45) {
      for (let step = 0; step < 24; step += 1) {
        const angle = (step / 24) * Math.PI * 2;
        const x = first.x + Math.cos(angle) * radius;
        const z = first.z + Math.sin(angle) * radius;
        if (Math.abs(x) > terrain.size / 2 - 40 || Math.abs(z) > terrain.size / 2 - 40) continue;
        if (terrain.heightAt(x, z) <= waterLevel + 2) continue;
        if (terrain.slopeAt(x, z) > 0.3) continue;
        // On a crest rather than in a hollow. Standing in a dip on a mountain
        // means the only thing in frame is the next slope up.
        if (terrain.heightAt(x, z) < ringAverage(x, z, terrain.size * 0.035) + terrain.maxHeight * 0.02) continue;
        if (!hasOutlook(x, z)) continue;
        return { x, z };
      }
    }

    return base;
  })();

  let walker: Walker | null = null;
  let walking = false;
  let joystick: Joystick | null = null;
  let sensitivity = 1;
  let lockHandler: ((locked: boolean) => void) | null = null;
  let discovered = new Set<string>();
  let discoverHandler: ((poi: ResolvedPoi) => void) | null = null;
  let viewHandler: ((view: 'first' | 'third') => void) | null = null;
  let onMove: ((move: LocalMove) => void) | null = null;
  let lastSent = 0;

  const presentPass = createPresentPass(settings.renderScale, style, settings.sunShafts);

  const skyColors = createSkyColors();
  const sunDirection = new Vector3();

  let weather: WorldWeather = CLEAR_WEATHER;
  /** Lightning is added on top of this every frame, so keep the base to return to. */
  let fillBase = 0;

  const pushSky = (state: SkyState) => {
    resolveSky(recipe.skies, state.sunElevation, skyColors);
    sunDirection.set(state.sunDirection.x, state.sunDirection.y, state.sunDirection.z).normalize();

    // Fade the disc out as it crosses the horizon instead of snapping it off.
    const sunVisibility = Math.min(1, Math.max(0, (state.sunElevation + 1.5) / 3));

    const night = Math.min(1, Math.max(0, -state.sunElevation / 8));
    skyDome.update(skyColors, sunDirection, sunVisibility, night, weather.skyOcclusion);

    // Moonlight. Opposite the sun, cool and soft — enough to keep a person and
    // a hillside legible after dark instead of swallowing them.
    moon.position.copy(sunDirection).multiplyScalar(-terrain.size);
    // Cloud takes the moon out of the sky, so it must take the moonlight with
    // it — a lit hillside under a storm is the giveaway that nothing is linked.
    // The colour comes from the night palette's `sunCore`, which is authored as
    // moonlight: it is the one thing that re-hues the ground after dark, and a
    // neutral grey here leaves an olive hillside olive.
    moon.color.copy(skyColors.sunCore);
    moon.intensity = state.moonIntensity * (1 - weather.skyOcclusion * 0.85);
    moon.visible = moon.intensity > 0.01;
    sun.position.copy(sunDirection).multiplyScalar(terrain.size);
    // Overcast does not just dim the sun, it removes the direction from the
    // light: no disc, no shadows, everything lit by the sky instead.
    const direct = 1 - weather.skyOcclusion * 0.82;
    sun.castShadow = settings.shadowMap > 0 && state.sunElevation > 2 && weather.skyOcclusion < 0.6;
    sun.color.copy(skyColors.sunCore);
    sun.intensity = state.sunIntensity * direct;
    fill.color.copy(skyColors.zenith).lerp(new Color('#ffffff'), 0.58);
    fillBase = state.fillIntensity;
    fill.intensity = fillBase;
    // The sky itself is the ambient source now, so its strength tracks daylight.
    // Sky ambient is a tint, not a second sun. At full strength it washed the
    // albedo out of everything — a green hillside came back grey.
    // A floor under the night so the world stays readable: the sky itself is the
    // ambient source, and after dark it still has to carry a little light.
    scene.environmentIntensity = state.ambientIntensity;

    (scene.fog as FogExp2).color.copy(skyColors.fog);
    (scene.fog as FogExp2).density = state.fogDensity;
    (scene.background as Color).copy(skyColors.horizon);

    refreshEnvironment(performance.now());
    cloudSea?.applySky(skyColors, sunDirection, state.daylight);
    cloudSea?.setWeather(weather);
    // A floor rather than zero: starlight and the town's own lanterns mean the
    // river is never pitch black, just very dark.
    water?.applySky(skyColors, sunDirection, night * (1 - weather.skyOcclusion), 0.055 + state.daylight * 0.945);
    const night01 = 1 - state.daylight;
    town.setNight(night01);
    life.setNight(night01);
    walker?.setNight(night01);
    roads.setNight(night01);
    railway.setNight(night01);
    aircraft.setNight(night01);
    aircraft.setWeather(weather);
    markers.setNight(night01);
    markers.setWeather(weather);
    vehicles.setNight(night01);
    vehicles.setWeather(weather);
    wildlife.setNight(night01);
    fish?.setNight(night01);
    dock?.setNight(night01);

    const light = 0.055 + state.daylight * 0.945;
    streams.applySky(skyColors, sunDirection, night, light);
    lakes.applySky(skyColors, sunDirection, night, light);
    waterfalls.applySky(skyColors, sunDirection, night, light);

    wind.setConditions({ windSpeed: weather.windSpeed, windDirection: weather.windDirection });
    waterfalls.setWind(wind.direction.x, wind.direction.y);

    rain.setIntensity(weather.rainIntensity);
    rain.applySky(skyColors, night);

    presentPass.applySky(skyColors, sunDirection, state.sunElevation, weather);
    dayClouds.applySky(skyColors, sunDirection, state.daylight);
    dayClouds.setConditions({
      cloudCover: weather.cloudCover,
      cloudCoverLow: weather.cloudLow,
      cloudCoverMid: weather.cloudMid,
      cloudCoverHigh: weather.cloudHigh,
      windSpeed: weather.windSpeed,
      windBearing: weather.windDirection,
      rain: weather.rainIntensity,
    });
  };

  // Scrubbing through the forecast, and the first real reading replacing the
  // opening sunrise, both look like a glitch if the sky snaps. Ease between
  // states instead, driven by the render loop.
  const TRANSITION_SECONDS = 1.1;
  let fromSky = OPENING_SKY;
  let toSky = OPENING_SKY;
  let blend = 1;

  const mix = (a: number, b: number, t: number) => a + (b - a) * t;

  const blendSky = (a: SkyState, b: SkyState, t: number): SkyState => ({
    phase: t < 0.5 ? a.phase : b.phase,
    sunElevation: mix(a.sunElevation, b.sunElevation, t),
    sunAzimuth: mix(a.sunAzimuth, b.sunAzimuth, t),
    sunDirection: {
      x: mix(a.sunDirection.x, b.sunDirection.x, t),
      y: mix(a.sunDirection.y, b.sunDirection.y, t),
      z: mix(a.sunDirection.z, b.sunDirection.z, t),
    },
    warmth: mix(a.warmth, b.warmth, t),
    daylight: mix(a.daylight, b.daylight, t),
    fogDensity: mix(a.fogDensity, b.fogDensity, t),
    cloudAltitudeScale: mix(a.cloudAltitudeScale, b.cloudAltitudeScale, t),
    cloudOpacity: mix(a.cloudOpacity, b.cloudOpacity, t),
    sunIntensity: mix(a.sunIntensity, b.sunIntensity, t),
    fillIntensity: mix(a.fillIntensity, b.fillIntensity, t),
    moonIntensity: mix(a.moonIntensity, b.moonIntensity, t),
    ambientIntensity: mix(a.ambientIntensity, b.ambientIntensity, t),
  });

  let fromWeather: WorldWeather = CLEAR_WEATHER;
  let toWeather: WorldWeather = CLEAR_WEATHER;
  /** Whether a real sky has arrived yet. The first one is not a transition. */
  let settled = false;

  const applySky = (state: SkyState, next: WorldWeather) => {
    fromSky = blend >= 1 ? toSky : blendSky(fromSky, toSky, blend);
    fromWeather = blend >= 1 ? toWeather : blendWeather(fromWeather, toWeather, blend);
    toSky = state;
    toWeather = next;

    // The opening sky is a placeholder to look at while the forecast loads, not
    // a frame worth easing away from: a link to a particular hour has to open on
    // that hour rather than slide into it from a hardcoded sunrise. Later
    // changes — scrubbing the slider, the hour advancing — do ease.
    if (settled) {
      blend = 0;
      return;
    }
    settled = true;
    blend = 1;
    weather = next;
    pushSky(state);
  };

  pushSky(OPENING_SKY);

  const resize = () => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    const aspect = width / height;
    camera.aspect = aspect;
    // On a portrait phone a fixed vertical FOV crops the range off both sides.
    // Widening it below the reference aspect keeps the same width in frame.
    camera.fov =
      aspect < REFERENCE_ASPECT
        ? Math.min(88, (2 * Math.atan(Math.tan(BASE_FOV_RADIANS / 2) * (REFERENCE_ASPECT / aspect)) * 180) / Math.PI)
        : BASE_FOV;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    presentPass.setSize(width * renderer.getPixelRatio(), height * renderer.getPixelRatio());
  };
  resize();

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  const startedAt = performance.now();
  let lastFrameAt = startedAt;
  let frame = 0;

  const tick = () => {
    frame = requestAnimationFrame(tick);
    const now = performance.now();
    const delta = Math.min(0.1, (now - lastFrameAt) / 1000);
    lastFrameAt = now;

    if (walking && walker) {
      walker.update(delta, camera);
      // Ten updates a second is plenty for people strolling, and keeps well
      // clear of the server's rate expectations.
      if (now - lastSent > 100) {
        lastSent = now;
        onMove?.({ x: walker.position.x, z: walker.position.z, yaw: walker.yaw });

        for (const poi of pois) {
          if (discovered.has(poi.id)) continue;
          if (Math.hypot(walker.position.x - poi.x, walker.position.z - poi.z) > DISCOVERY_RADIUS) continue;
          discovered.add(poi.id);
          markers.setDiscovered(discovered);
          discoverHandler?.(poi);
        }
      }
    } else {
      controls.update();
    }
    avatars.update(delta);

    if (blend < 1) {
      blend = Math.min(1, blend + delta / TRANSITION_SECONDS);
      const eased = blend * blend * (3 - 2 * blend);
      weather = blendWeather(fromWeather, toWeather, eased);
      pushSky(blendSky(fromSky, toSky, eased));
    }

    const focusX = walking && walker ? walker.position.x : controls.target.x;
    const focusZ = walking && walker ? walker.position.z : controls.target.z;
    groundCover.follow(focusX, focusZ);
    nearTrees.follow(focusX, focusZ);
    fireflies.follow(focusX, focusZ);

    if (settings.shadowMap > 0) {
      // The default shadow camera is a ten-metre box, which casts precisely
      // nothing across five kilometres of mountain. Keep it around whatever is
      // being looked at: tight on foot, wide when the range is in frame.
      const focus = walking && walker ? walker.position : controls.target;
      const span = walking ? 260 : terrain.size * 0.5;
      const shadowCamera = sun.shadow.camera;

      shadowCamera.left = -span;
      shadowCamera.right = span;
      shadowCamera.top = span;
      shadowCamera.bottom = -span;
      shadowCamera.near = terrain.size * 0.1;
      shadowCamera.far = terrain.size * 1.8;
      shadowCamera.updateProjectionMatrix();

      sun.target.position.copy(focus);
      sun.target.updateMatrixWorld();
      sun.position
        .copy(sunDirection)
        .multiplyScalar(terrain.size * 0.7)
        .add(focus);
    }

    const elapsed = (now - startedAt) / 1000;
    // Wind first: everything that sways reads the field this sets.
    wind.update(elapsed);
    rain.follow(focusX, focusZ);
    rain.update(elapsed);
    // A strike lights the whole scene for a few frames, which is the only way a
    // storm at night is anything other than dark.
    const strike = rain.flash();
    fill.intensity = fillBase + strike * 2.6;

    dayClouds.update(elapsed);
    streams.update(elapsed);
    waterfalls.update(elapsed);
    roads.update(elapsed);
    railway.update(elapsed);
    aircraft.update(elapsed);
    town.update(elapsed);
    vehicles.update(elapsed);
    lakes.update(elapsed);
    terraces.update(elapsed);
    nearTrees.update(elapsed);
    wildlife.update(elapsed);
    wildlife.follow(focusX, focusZ);
    fish?.update(elapsed);
    dock?.setHulls(life.rideables().map((boat) => boat.position));
    dock?.update(elapsed);
    cloudSea?.update(elapsed);
    water?.update(elapsed);
    life.update(elapsed);
    groundCover.update(elapsed);
    // Dusk, not darkness: they come out as the light goes and thin out later.
    fireflies.update(elapsed, Math.min(1, Math.max(0, (1 - toSky.daylight) * (1 - weather.skyOcclusion * 0.6))));
    markers.update(elapsed, walker ? { x: walker.position.x, z: walker.position.z } : undefined);
    skyDome.tick(elapsed);
    presentPass.render(renderer, scene, camera);
  };
  tick();

  return {
    applySky,
    prompt: () => walker?.prompt() ?? null,
    interact: () => walker?.interact(),
    riding: () => walker?.riding() ?? false,
    routes,
    setWalking: (enabled) => {
      walking = enabled;
      controls.enabled = !enabled;

      if (enabled && !walker) {
        // Face downhill, where the view is. Facing the first landmark sounded
        // helpful and in a mountain range it means staring at the slope you are
        // standing on; the compass still points the way, so nothing is lost.
        let facing = 0;
        let lowest = Infinity;
        for (let step = 0; step < 16; step += 1) {
          const angle = (step / 16) * Math.PI * 2;
          const height = terrain.heightAt(spawn.x + Math.sin(angle) * 110, spawn.z + Math.cos(angle) * 110);
          if (height < lowest) {
            lowest = height;
            facing = angle;
          }
        }
        walker = createWalker(
          terrain,
          renderer.domElement,
          spawn.x,
          spawn.z,
          town.buildings,
          canopyIndex,
          facing,
          humanSource,
          {
            water: recipe.water,
            platforms: [...(dock?.platforms ?? []), ...roads.decks, ...railway.decks],
            exits: dock?.exits ?? [],
            // Boats and parked motorbikes answer the same prompt, so the
            // walker sees one list. `dock.setHulls` above deliberately does
            // not: a motorbike is not something a mooring line is tied to.
            rideables: () => [...life.rideables(), ...vehicles.rideables()],
            // A getter, not the array: `update` refills it in place every frame.
            nearCrowns: () => nearTrees.crowns,
          }
        );
        walker.setJoystick(joystick);
        walker.setSensitivity(sensitivity);
        walker.onLockChange(lockHandler);
        walker.onViewChange(viewHandler);
        scene.add(walker.group);
        // World space, not a child of the walker, so it is added separately.
        if (walker.waterEffects) scene.add(walker.waterEffects);
      }
      if (walker) {
        walker.group.visible = enabled;
        // Without this the lens overlays freeze on screen after you stop
        // walking, because the walker's own update no longer runs.
        if (walker.waterEffects) walker.waterEffects.visible = enabled;
      }

      if (!enabled) {
        // Hand the camera back where the orbit controls expect to find it.
        controls.target.set(0, focus + 30, 0);
        camera.position.set(
          terrain.size * 0.2,
          Math.max(viewpoint.y, focus) + terrain.size * 0.12,
          terrain.size * 0.62
        );
        controls.update();
      }
    },
    setRemotePlayers: (players) => avatars.sync(players),
    setJoystick: (input) => {
      joystick = input;
      walker?.setJoystick(input);
    },
    setStyle: (next) => presentPass.setStyle(next),
    setSensitivity: (value) => {
      sensitivity = value;
      walker?.setSensitivity(value);
    },
    onLockChange: (handler) => {
      lockHandler = handler;
      walker?.onLockChange(handler);
    },
    requestLock: () => walker?.requestLock(),
    toggleView: () => walker?.toggleView(),
    onViewChange: (handler) => {
      viewHandler = handler;
      walker?.onViewChange(handler);
    },
    onLocalMove: (handler) => {
      onMove = handler;
    },
    pois,
    parking: roads.parking,
    travelTo: (poiId) => {
      const poi = pois.find((entry) => entry.id === poiId);
      if (poi && walker) walker.teleport(poi.x, poi.z + 30);
    },
    setDiscovered: (ids) => {
      discovered = new Set(ids);
      markers.setDiscovered(discovered);
    },
    onDiscover: (handler) => {
      discoverHandler = handler;
    },
    terrainSize: terrain.size,
    minimap: (size) => {
      // Sampled straight from the heightfield rather than rendered: a second
      // camera would cost a frame, and the map never changes once generated.
      const image = new ImageData(size, size);
      const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
      const half = terrain.size / 2;

      const land = [new Color(recipe.ground.low), new Color(recipe.ground.mid), new Color(recipe.ground.high)];
      const deep = recipe.water ? new Color(recipe.water.deep) : new Color('#1a2433');
      const shallow = recipe.water ? new Color(recipe.water.shallow) : deep;
      const shade = new Color();

      for (let row = 0; row < size; row += 1) {
        for (let col = 0; col < size; col += 1) {
          const x = -half + (col / (size - 1)) * terrain.size;
          const z = -half + (row / (size - 1)) * terrain.size;
          const height = terrain.heightAt(x, z);

          if (height < waterLevel) {
            shade.copy(shallow).lerp(deep, Math.min(1, (waterLevel - height) / 30));
          } else {
            const t = Math.min(1, Math.max(0, height / Math.max(1, terrain.maxHeight)));
            shade.copy(land[0]).lerp(land[1], Math.min(1, t * 2.2));
            if (t > 0.45) shade.lerp(land[2], Math.min(1, (t - 0.45) / 0.5));
          }

          const offset = (row * size + col) * 4;
          image.data[offset] = Math.round(shade.r * 255);
          image.data[offset + 1] = Math.round(shade.g * 255);
          image.data[offset + 2] = Math.round(shade.b * 255);
          image.data[offset + 3] = 255;
        }
      }

      return image;
    },
    localPosition: () => ({
      x: walker?.position.x ?? 0,
      z: walker?.position.z ?? 0,
      yaw: walker?.yaw ?? 0,
    }),
    capture: (width, height) => {
      // The postcard has its own shape, so the camera is briefly reframed to it
      // and put back — otherwise the photo is the window's aspect, stretched.
      const previousAspect = camera.aspect;
      const previousFov = camera.fov;

      camera.aspect = width / height;
      camera.fov = BASE_FOV;
      camera.updateProjectionMatrix();

      const capture = presentPass.capture(renderer, scene, camera, width, height);

      camera.aspect = previousAspect;
      camera.fov = previousFov;
      camera.updateProjectionMatrix();

      return capture;
    },
    dispose: () => {
      walker?.dispose();
      avatars.dispose();
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      cloudSea?.dispose();
      water?.dispose();
      town.dispose();
      life.dispose();
      markers.dispose();
      nature.dispose();
      groundCover.dispose();
      fireflies.dispose();
      rain.dispose();
      dayClouds.dispose();
      streams.dispose();
      waterfalls.dispose();
      roads.dispose();
      railway.dispose();
      aircraft.dispose();
      vehicles.dispose();
      lakes.dispose();
      terraces.dispose();
      nearTrees.dispose();
      wildlife.dispose();
      fish?.dispose();
      dock?.dispose();
      terrainMesh.dispose();
      skyDome.dispose();
      environment?.texture.dispose();
      pmrem.dispose();
      presentPass.dispose();
      renderer.dispose();
    },
  };
};
