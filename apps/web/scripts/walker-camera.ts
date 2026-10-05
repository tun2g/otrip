/**
 * Camera-occlusion probe for `walker.ts`.
 *
 * The third-person camera sweeps the line from the head back to its trailing
 * position and pulls in to the first blocked sample; under about two metres the
 * avatar is hidden and the view becomes first person. That is deliberate — a
 * body at arm's length fills the lens — but it means any sweep that fires
 * constantly reads to a player as "the character has disappeared", which is
 * exactly what was reported.
 *
 * So this walks each location for a few hundred metres and measures the thing
 * the player sees: what share of the walk the avatar is hidden for, how far the
 * camera was allowed to trail, and which branch of the sweep took it away.
 *
 *   node --experimental-strip-types apps/web/scripts/walker-camera.ts
 *   node --experimental-strip-types apps/web/scripts/walker-camera.ts --only=ho-tay
 *
 * The sweep is re-implemented here rather than exported from `walker.ts`, so
 * every run cross-checks the replica against the walker's own answer — the
 * avatar's `visible` flag — and prints the disagreement rate. A replica that has
 * drifted from the file says so instead of quietly reporting fiction.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { PerspectiveCamera } from 'three';

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

// `walker.ts` binds keyboard, pointer and pointer-lock listeners the moment it
// is created, and several shader modules read `window.devicePixelRatio` behind a
// `typeof window` guard — so the ratio is declared rather than left undefined.
const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
globals.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
globals.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  pointerLockElement: null,
  exitPointerLock: () => {},
  // GLTFLoader decodes the nature kit's texture atlas through an <img>.
  createElementNS: () => ({
    addEventListener: (type: string, callback: () => void) => {
      if (type === 'load') queueMicrotask(callback);
    },
    removeEventListener: () => {},
    src: '',
  }),
};

const { createTerrain, LOCATIONS, LOCATION_SLUGS } = await import('@otrip/world');
const { PerspectiveCamera: Camera, Mesh, Vector3 } = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

const { QUALITY_SETTINGS } = await import('../src/scene/quality.ts');
const { createWind } = await import('../src/scene/wind.ts');
const { createNatureScatter } = await import('../src/scene/nature-scatter.ts');
const { createTownMeshes } = await import('../src/scene/town-meshes.ts');
const { resolvePois } = await import('../src/scene/points-of-interest.ts');
const { createObstacleIndex } = await import('../src/scene/obstacle-index.ts');
const { createNearTrees } = await import('../src/scene/tree-near.ts');
const { createWalker } = await import('../src/scene/walker.ts');
const { PERSON_HEIGHT } = await import('../src/scene/person.ts');

type Obstacle = { x: number; z: number; radius: number; bottom: number; top: number };
type Building = { x: number; z: number; radius: number; top: number; width: number; depth: number; yaw: number };

/** `insideBuilding` from `walker.ts`: the real rectangle, not the circle. */
const insideBuilding = (building: Building, x: number, z: number): boolean => {
  const dx = x - building.x;
  const dz = z - building.z;
  const sin = Math.sin(building.yaw);
  const cos = Math.cos(building.yaw);
  return Math.abs(dx * cos - dz * sin) < building.width / 2 && Math.abs(dx * sin + dz * cos) < building.depth / 2;
};

/**
 * `createWalker` scatters its spawn by a few metres through `Math.random`, so
 * two runs otherwise walk different ground and nothing can be compared. Held to
 * one sequence for the length of a construction, and handed back afterwards.
 */
const seeded = <T>(build: () => T): T => {
  const real = Math.random;
  let state = 0x2f6e2b1;
  Math.random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  try {
    return build();
  } finally {
    Math.random = real;
  }
};

/** What `createWalker` binds its listeners to. Nothing here sends it an event. */
const listener = { addEventListener: () => {}, removeEventListener: () => {} } as unknown as HTMLElement;

// The sweep's own constants, copied from `walker.ts`. Any of these drifting is
// what the replica cross-check is for.
const CAMERA_HEIGHT = 2.5;
const CAMERA_CLEARANCE = 1.4;
const OCCLUSION_SAMPLES = 10;
const DEFAULT_DISTANCE = 8.5;
const FIRST_PERSON_UNDER = 2;
/** Seconds of held occlusion before the view gives up, matching `walker.ts`. */
const FIRST_PERSON_AFTER = 0.4;
const BUILDING_HEAD = 0.8;
const START_PITCH = -0.07;

/** Frames of walking per location, at 60 Hz, and the stick they are driven with. */
const FRAMES = 60 * 150;
const DELTA = 1 / 60;

const argument = (name: string, fallback: string): string => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const only = argument('only', '');
const tier = argument('tier', 'high') as keyof typeof QUALITY_SETTINGS;
const settings = QUALITY_SETTINGS[tier];

/** `findSpawn`, copied from `world-renderer.ts`. */
const findSpawn = (
  terrain: ReturnType<typeof createTerrain>,
  waterLevel: number,
  buildings: Building[]
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

/** The crest-and-outlook refinement, copied from `world-renderer.ts`. */
const refineSpawn = (
  terrain: ReturnType<typeof createTerrain>,
  waterLevel: number,
  buildings: Building[],
  first: { x: number; z: number } | undefined
): { x: number; z: number; from: 'crest' | 'base' } => {
  const base = findSpawn(terrain, waterLevel, buildings);
  if (!first) return { ...base, from: 'base' };

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
      if (terrain.heightAt(x + Math.sin(toward) * step, z + Math.cos(toward) * step) > eye + 6) return false;
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
      if (terrain.heightAt(x, z) < ringAverage(x, z, terrain.size * 0.035) + terrain.maxHeight * 0.02) continue;
      if (!hasOutlook(x, z)) continue;
      return { x, z, from: 'crest' };
    }
  }

  return { ...base, from: 'base' };
};

/** Which way `world-renderer.ts` faces the walker: downhill. */
const facingOf = (terrain: ReturnType<typeof createTerrain>, x: number, z: number): number => {
  let facing = 0;
  let lowest = Infinity;
  for (let step = 0; step < 16; step += 1) {
    const angle = (step / 16) * Math.PI * 2;
    const height = terrain.heightAt(x + Math.sin(angle) * 110, z + Math.cos(angle) * 110);
    if (height < lowest) {
      lowest = height;
      facing = angle;
    }
  }
  return facing;
};

type Blame = {
  allowed: number;
  /** Which branch stopped the sweep, and what did it. */
  branch: 'clear' | 'ground' | 'canopy' | 'buildings';
  at: { x: number; z: number; radius: number; top: number } | null;
  /** How far inside the blocking circle the sample was, in metres. */
  depth: number;
};

/**
 * The sweep from `walker.ts`, re-run so the branch that fired can be named. The
 * walker passes no platforms in this probe, so its `floorAt` is the terrain and
 * the ground branch is exact.
 */
const sweep = (
  terrain: ReturnType<typeof createTerrain>,
  buildings: Building[],
  canopy: { near: (x: number, z: number, into?: Obstacle[]) => Obstacle[] } | null,
  position: { x: number; y: number; z: number },
  headY: number,
  cameraYaw: number,
  cameraPitch: number,
  footY: number,
  /**
   * False reproduces the rule this change replaced: the ground blocking like a
   * wall, and buildings as the circle around them rather than the walls.
   */
  legacy: boolean
): Blame => {
  const horizontal = Math.cos(cameraPitch);
  const lift = Math.sin(cameraPitch);
  const distance = DEFAULT_DISTANCE;

  for (let sample = 1; sample <= OCCLUSION_SAMPLES; sample += 1) {
    const fraction = sample / OCCLUSION_SAMPLES;
    const sampleX = position.x - Math.sin(cameraYaw) * horizontal * distance * fraction;
    const sampleZ = position.z - Math.cos(cameraYaw) * horizontal * distance * fraction;
    const sampleY = headY + (CAMERA_HEIGHT - lift * distance) * fraction;
    const allowed = distance * ((sample - 1) / OCCLUSION_SAMPLES);

    // The ground only ever blocked under the old rule. It now raises the camera
    // instead, which is handled in the walker and shows up in the framing
    // numbers rather than here.
    const floor = terrain.heightAt(sampleX, sampleZ);
    if (legacy && floor + CAMERA_CLEARANCE > sampleY) {
      return { allowed, branch: 'ground', at: null, depth: floor + CAMERA_CLEARANCE - sampleY };
    }

    if (canopy) {
      const trees = canopy.near(sampleX, sampleZ);
      for (const tree of trees) {
        if (sampleY <= tree.bottom || sampleY >= tree.top) continue;
        const span = Math.hypot(sampleX - tree.x, sampleZ - tree.z);
        if (span >= tree.radius) continue;
        return {
          allowed,
          branch: 'canopy',
          at: { x: tree.x, z: tree.z, radius: tree.radius, top: tree.top },
          depth: tree.radius - span,
        };
      }
    }

    for (const building of buildings) {
      if (building.top + BUILDING_HEAD <= sampleY) continue;
      const span = Math.hypot(sampleX - building.x, sampleZ - building.z);
      if (span >= building.radius) continue;
      if (!legacy && !insideBuilding(building, sampleX, sampleZ)) continue;
      return {
        allowed,
        branch: 'buildings',
        at: { x: building.x, z: building.z, radius: building.radius, top: building.top },
        depth: building.radius - span,
      };
    }
  }

  return { allowed: distance, branch: 'clear', at: null, depth: 0 };
};

const quantile = (values: number[], share: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
};

const fixed = (value: number, places = 2): string => (Number.isFinite(value) ? value.toFixed(places) : '—');

const MODELS = fileURLToPath(new URL('../public/models/nature/', import.meta.url));

/**
 * The nature kit off disk, the same way the census reads it. Without it
 * `createNatureScatter` places nothing and publishes an empty canopy, and the
 * forest branch of the sweep — the one with a five-metre radius — goes
 * unmeasured while appearing to pass.
 */
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

// --- one walk ---------------------------------------------------------------

type NearTrees = { crowns: Obstacle[]; follow: (x: number, z: number) => void; update: (elapsed: number) => void };

type Walk = {
  travelled: number;
  hidden: number;
  disagree: number;
  allowed: number[];
  blame: Record<Blame['branch'], number>;
  /** Frames where a near-tree crown sat on the camera line. Not in the sweep. */
  nearHits: number;
  /**
   * Frames where the avatar was flagged visible but was not actually on screen,
   * and where it was within a whisker of the bottom edge. `visible` is a
   * property of the object, not of the picture — nothing in the walker knows
   * whether the thing it is drawing is inside the frustum.
   */
  offScreen: number;
  /** Worst (most negative = furthest below the frame) head position, in NDC. */
  lowestHead: number;
  /** Frames the framing statistics were taken over. */
  framed: number;
  worst: Blame[];
  /** The same walk judged by the rule this change replaced. */
  wasHidden: number;
  wasAllowed: number[];
  wasBlame: Record<Blame['branch'], number>;
};

/**
 * Drives a walker straight ahead and records, per frame, whether the avatar was
 * on screen, how far the camera was allowed to trail, and what stopped it.
 *
 * `cameraYaw` is the walker's `initialYaw`: nothing here sends a mouse event, so
 * the camera never turns and the replica knows the yaw exactly.
 */
const walk = (
  walker: ReturnType<typeof createWalker>,
  terrain: ReturnType<typeof createTerrain>,
  buildings: Building[],
  canopy: { near: (x: number, z: number, into?: Obstacle[]) => Obstacle[] },
  cameraYaw: number,
  nearTrees: NearTrees | null
): Walk => {
  const camera = new Camera(52, 16 / 9, 2, 40_000) as PerspectiveCamera;
  const avatar: { visible: boolean }[] = [];
  walker.group.traverse((node) => {
    if (node instanceof Mesh) avatar.push(node as unknown as { visible: boolean });
  });
  const eyeHeight = PERSON_HEIGHT * 0.9;
  const head = new Vector3();
  const feet = new Vector3();

  walker.setJoystick({ x: 0, y: 1 });

  const out: Walk = {
    travelled: 0,
    hidden: 0,
    disagree: 0,
    allowed: [],
    blame: { clear: 0, ground: 0, canopy: 0, buildings: 0 },
    nearHits: 0,
    offScreen: 0,
    lowestHead: Infinity,
    framed: 0,
    worst: [],
    wasHidden: 0,
    wasAllowed: [],
    wasBlame: { clear: 0, ground: 0, canopy: 0, buildings: 0 },
  };
  let lastX = walker.position.x;
  let lastZ = walker.position.z;
  let crowded = 0;

  for (let frame = 0; frame < FRAMES; frame += 1) {
    walker.update(DELTA, camera);
    out.travelled += Math.hypot(walker.position.x - lastX, walker.position.z - lastZ);
    lastX = walker.position.x;
    lastZ = walker.position.z;

    const shown = avatar.some((mesh) => mesh.visible);
    if (!shown) out.hidden += 1;

    // Where the body actually lands in the picture. Projecting into normalised
    // device coordinates is the only honest answer to "is the character on
    // screen": anything inside -1..1 on both axes and in front of the camera is
    // in frame, and `visible` says nothing about it.
    // Only while the camera is genuinely trailing. Pulled in close the body
    // straddles the 2 m near plane, where projected coordinates run to tens of
    // units and mean nothing — and that case is already counted as `hidden`.
    const trailing = Math.hypot(
      camera.position.x - walker.position.x,
      camera.position.y - (walker.position.y + eyeHeight),
      camera.position.z - walker.position.z
    );
    if (shown && trailing > 4) {
      out.framed += 1;
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      head.set(walker.position.x, walker.position.y + eyeHeight, walker.position.z).project(camera);
      feet.set(walker.position.x, walker.position.y, walker.position.z).project(camera);
      // A point behind the lens projects with a negative w, which flips both
      // axes and makes its coordinates meaningless — so the near-plane test
      // comes first and nothing downstream reads a value it invalidated.
      const ahead = (point: InstanceType<typeof Vector3>) => point.z > -1 && point.z < 1;
      const inFrame = (point: InstanceType<typeof Vector3>) =>
        ahead(point) && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1;
      if (!inFrame(head) && !inFrame(feet)) out.offScreen += 1;
      if (ahead(head) && head.y < out.lowestHead) out.lowestHead = head.y;
    }

    const headY = walker.position.y + eyeHeight;
    const verdict = sweep(
      terrain,
      buildings,
      canopy,
      walker.position,
      headY,
      cameraYaw,
      START_PITCH,
      walker.position.y,
      false
    );

    // The same frame under the rule this change replaced: the circumscribing
    // circle, and first person the instant a sample came back blocked. The walk
    // is identical either way — the sweep moves the camera, never the body — so
    // this is a like-for-like comparison rather than two different walks.
    const before = sweep(
      terrain,
      buildings,
      canopy,
      walker.position,
      headY,
      cameraYaw,
      START_PITCH,
      walker.position.y,
      true
    );
    out.wasAllowed.push(before.allowed);
    out.wasBlame[before.branch] += 1;
    if (before.allowed < FIRST_PERSON_UNDER) out.wasHidden += 1;
    out.allowed.push(verdict.allowed);
    out.blame[verdict.branch] += 1;
    if (verdict.allowed < FIRST_PERSON_UNDER && verdict.branch !== 'clear' && out.worst.length < 4) {
      out.worst.push(verdict);
    }

    crowded = verdict.allowed < FIRST_PERSON_UNDER ? crowded + DELTA : 0;
    if (crowded >= FIRST_PERSON_AFTER !== !shown) out.disagree += 1;

    // The near-field trees are not in the sweep at all, so they never shorten
    // `allowed` — they just get drawn between the camera and the avatar. This
    // counts how often one was on that line, which is the size of the gap.
    if (nearTrees) {
      nearTrees.follow(walker.position.x, walker.position.z);
      nearTrees.update(frame * DELTA);
      const horizontal = Math.cos(START_PITCH);
      const lift = Math.sin(START_PITCH);
      let hit = false;
      for (let sample = 1; sample <= OCCLUSION_SAMPLES && !hit; sample += 1) {
        const fraction = sample / OCCLUSION_SAMPLES;
        const x = walker.position.x - Math.sin(cameraYaw) * horizontal * DEFAULT_DISTANCE * fraction;
        const z = walker.position.z - Math.cos(cameraYaw) * horizontal * DEFAULT_DISTANCE * fraction;
        const y = headY + (CAMERA_HEIGHT - lift * DEFAULT_DISTANCE) * fraction;
        for (const crown of nearTrees.crowns) {
          if (y <= crown.bottom || y >= crown.top) continue;
          if (Math.hypot(x - crown.x, z - crown.z) >= crown.radius) continue;
          hit = true;
          break;
        }
      }
      if (hit) out.nearHits += 1;
    }
  }

  return out;
};

const report = (label: string, result: Walk) => {
  const frames = FRAMES;
  console.log(
    `  ${label}: walked ${fixed(result.travelled, 1)} m · avatar hidden ${((result.wasHidden / frames) * 100).toFixed(
      1
    )}% before -> ${((result.hidden / frames) * 100).toFixed(1)}% now · replica disagrees ${(
      (result.disagree / frames) *
      100
    ).toFixed(1)}%`
  );
  console.log(
    `    before: allowed p10 ${fixed(quantile(result.wasAllowed, 0.1))} median ${fixed(
      quantile(result.wasAllowed, 0.5)
    )} · blame ground ${((result.wasBlame.ground / frames) * 100).toFixed(1)}% canopy ${(
      (result.wasBlame.canopy / frames) *
      100
    ).toFixed(1)}% buildings ${((result.wasBlame.buildings / frames) * 100).toFixed(1)}%`
  );
  const instant = result.allowed.filter((value) => value < FIRST_PERSON_UNDER).length;
  console.log(
    `    of which the sweep itself (ground raising rather than blocking, walls rather than circles) accounts for ${(
      ((result.wasHidden - instant) / frames) *
      100
    ).toFixed(
      1
    )} points and waiting ${FIRST_PERSON_AFTER}s for ${(((instant - result.hidden) / frames) * 100).toFixed(1)} points`
  );
  console.log(
    `    framing over ${result.framed} trailing frames: body out of the picture ${(
      (result.offScreen / Math.max(1, result.framed)) *
      100
    ).toFixed(1)}% · lowest the head ever sat ${fixed(result.lowestHead)} in NDC, where -1 is the bottom edge`
  );
  console.log('    now:');
  console.log(
    `    allowed min ${fixed(quantile(result.allowed, 0))} p10 ${fixed(quantile(result.allowed, 0.1))} median ${fixed(
      quantile(result.allowed, 0.5)
    )} of ${DEFAULT_DISTANCE} m · blame ground ${((result.blame.ground / frames) * 100).toFixed(1)}% canopy ${(
      (result.blame.canopy / frames) *
      100
    ).toFixed(1)}% buildings ${((result.blame.buildings / frames) * 100).toFixed(1)}% · near-tree on the camera line ${(
      (result.nearHits / frames) *
      100
    ).toFixed(1)}%`
  );
  for (const entry of result.worst) {
    console.log(
      `    stopped at ${fixed(entry.allowed)} m by ${entry.branch}${
        entry.at
          ? ` at ${fixed(entry.at.x, 1)},${fixed(entry.at.z, 1)} radius ${fixed(entry.at.radius)} top ${fixed(
              entry.at.top,
              1
            )} — ${fixed(entry.depth)} m inside`
          : ` — ${fixed(entry.depth)} m under the clearance`
      }`
    );
  }
};

/**
 * The sweep over a whole village rather than along one line through it.
 *
 * A single walk is a poor estimator: whether it finds the spot where the avatar
 * goes out is luck, and the walk that first showed Hồ Tây losing it 83% of the
 * time could not be reproduced from a different starting metre. So this stands
 * the walker on every standable square metre of the cluster, points the camera
 * sixteen ways from each, and counts how much of the village loses the avatar
 * from how many angles — deterministic, and it cannot miss the bad corner.
 */
const survey = (
  terrain: ReturnType<typeof createTerrain>,
  buildings: Building[],
  canopy: { near: (x: number, z: number, into?: Obstacle[]) => Obstacle[] },
  centre: { x: number; z: number },
  waterLevel: number
): { places: number; before: number; after: number; worstBefore: Blame | null } => {
  const SPAN = 70;
  const STEP = 4;
  const YAWS = 16;
  const eyeHeight = PERSON_HEIGHT * 0.9;

  let places = 0;
  let before = 0;
  let after = 0;
  let worstBefore: Blame | null = null;

  for (let dx = -SPAN; dx <= SPAN; dx += STEP) {
    for (let dz = -SPAN; dz <= SPAN; dz += STEP) {
      const x = centre.x + dx;
      const z = centre.z + dz;
      const ground = terrain.heightAt(x, z);
      if (ground <= waterLevel + 0.5) continue;
      if (terrain.slopeAt(x, z) > 1.2) continue;
      // Standing inside a house is not a place the player can be.
      if (buildings.some((building) => insideBuilding(building, x, z))) continue;

      const at = { x, y: ground, z };
      const headY = ground + eyeHeight;
      for (let step = 0; step < YAWS; step += 1) {
        const yaw = (step / YAWS) * Math.PI * 2;
        places += 1;
        const was = sweep(terrain, buildings, canopy, at, headY, yaw, START_PITCH, ground, true);
        const now = sweep(terrain, buildings, canopy, at, headY, yaw, START_PITCH, ground, false);
        if (was.allowed < FIRST_PERSON_UNDER) {
          before += 1;
          if (was.branch === 'buildings' && (!worstBefore || was.depth < worstBefore.depth)) worstBefore = was;
        }
        if (now.allowed < FIRST_PERSON_UNDER) after += 1;
      }
    }
  }

  return { places, before, after, worstBefore };
};

// --- one location -----------------------------------------------------------

const probe = (slug: string, sources: NatureSources) => {
  const recipe = LOCATIONS[slug];
  if (!recipe) {
    console.error(`Không có location ${slug}`);
    return;
  }

  const terrain = createTerrain(recipe, settings.segments);
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const wind = createWind(recipe);

  const treeBudget = Math.min(recipe.scatter.trees, settings.trees);
  const nature = createNatureScatter(
    terrain,
    recipe,
    sources,
    { trees: treeBudget, bushes: Math.round(treeBudget * 0.7), rocks: Math.round(treeBudget * 0.25) },
    waterLevel,
    wind,
    // No claims: this probe builds the town after the scatter and only measures
    // where the camera may stand, so what the trees avoid does not come into it.
    null
  );
  const town = createTownMeshes(terrain, recipe, { density: 1 });
  const pois = resolvePois(terrain, recipe, town.buildings);
  const canopyIndex = createObstacleIndex(nature.canopy);
  const nearTrees = createNearTrees(terrain, recipe, settings.nearTrees, wind) as unknown as NearTrees & {
    dispose: () => void;
  };

  console.log(`\n=== ${slug} · ${town.buildings.length} buildings · ${nature.canopy.length} crowns ===`);

  // --- the walk the player actually gets ------------------------------------
  const spawn = refineSpawn(terrain, waterLevel, town.buildings, pois[0]);
  const facing = facingOf(terrain, spawn.x, spawn.z);

  let nearest: Building | null = null;
  let nearestGap = Infinity;
  let inside = 0;
  for (const building of town.buildings) {
    const gap = Math.hypot(spawn.x - building.x, spawn.z - building.z) - building.radius;
    if (gap < 0) inside += 1;
    if (gap < nearestGap) {
      nearestGap = gap;
      nearest = building;
    }
  }
  console.log(
    `spawn ${fixed(spawn.x, 1)},${fixed(spawn.z, 1)} (${spawn.from}) · nearest building ${fixed(
      nearestGap,
      1
    )} m outside its circle (radius ${fixed(nearest?.radius ?? 0)}) · spawn inside ${inside} building circle(s)`
  );

  const fromSpawn = seeded(() =>
    createWalker(terrain, listener, spawn.x, spawn.z, town.buildings, canopyIndex, facing, undefined, {
      water: recipe.water ?? null,
      reducedMotion: true,
    })
  );
  report('from spawn', walk(fromSpawn, terrain, town.buildings, canopyIndex, facing, nearTrees));
  fromSpawn.dispose();

  // --- and the one the hypothesis is about ----------------------------------
  // Walking the village street. The spawn is hundreds of metres from any house
  // at every location, so a walk from it never tests the buildings branch at
  // all; this starts at the edge of the densest cluster and crosses it.
  if (town.buildings.length > 0) {
    let dense = town.buildings[0];
    let best = -1;
    for (const building of town.buildings) {
      let count = 0;
      for (const other of town.buildings) {
        if (Math.hypot(building.x - other.x, building.z - other.z) < 60) count += 1;
      }
      if (count > best) {
        best = count;
        dense = building;
      }
    }
    const heading = Math.atan2(-dense.x, -dense.z);
    const edgeX = dense.x - Math.sin(heading) * 70;
    const edgeZ = dense.z - Math.cos(heading) * 70;
    console.log(
      `village: densest cluster at ${fixed(dense.x, 1)},${fixed(dense.z, 1)} with ${best} buildings inside 60 m`
    );

    const throughTown = createWalker(terrain, listener, edgeX, edgeZ, town.buildings, canopyIndex, heading, undefined, {
      water: recipe.water ?? null,
      reducedMotion: true,
    });
    report('through the village', walk(throughTown, terrain, town.buildings, canopyIndex, heading, nearTrees));
    throughTown.dispose();

    const sampled = survey(terrain, town.buildings, canopyIndex, dense, waterLevel);
    console.log(
      `  village survey: ${sampled.places} stand-and-look pairs · camera forced inside 2 m ${(
        (sampled.before / sampled.places) *
        100
      ).toFixed(1)}% before -> ${((sampled.after / sampled.places) * 100).toFixed(1)}% now`
    );
    if (sampled.worstBefore?.at) {
      console.log(
        `    shallowest building block before: ${fixed(sampled.worstBefore.depth, 3)} m inside a circle of radius ${fixed(
          sampled.worstBefore.at.radius
        )}`
      );
    }
  }

  nature.dispose();
  town.dispose();
  nearTrees.dispose();
};

const sources = await loadSources();
console.log(`nature kit: ${sources.size} models off disk`);
const slugs = only ? only.split(',') : [...LOCATION_SLUGS];
for (const slug of slugs) probe(slug, sources);
