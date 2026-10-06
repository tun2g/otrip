/**
 * Camera probe for `walker.ts`: where the body lands in the picture, and what
 * the view does that nobody asked it to.
 *
 * The rig is an orbit. It swings about a point on the chest and aims through it,
 * so the body holds one screen position at every pitch; the sweep from the pivot
 * out to the camera shortens it when the ground or anything built is on that
 * line, and inside the two metres a body cannot be drawn whole in the body
 * stands aside and the view is first person.
 *
 * Both halves of that are measured here, because both have been reported as
 * bugs by players: "the character has disappeared", which is the sweep firing
 * too readily, and "góc nhìn phải lấy nhân vật làm trung tâm" — the view must
 * take the character as its centre — which is the framing.
 *
 *   node --experimental-strip-types apps/web/scripts/walker-camera.ts
 *   node --experimental-strip-types apps/web/scripts/walker-camera.ts --only=ho-tay
 *
 * Per location it walks a few hundred metres and measures what share of the walk
 * the avatar is hidden for, how far the camera was allowed to trail, which
 * branch took it away, how far the lens cleared the ground, and the frame-to
 * frame swing of the view with no look input at all. Then it stands still and
 * sweeps the pitch through its whole range at three distances, projecting the
 * chest to see whether it moves.
 *
 * Every walk is also judged by the look-direction rig the orbit replaced — the
 * camera placed on a trailing line that held still above the horizon and was
 * stood on top of the ground rather than stopped by it — so the before and after
 * come off one instrument and one walk.
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

/**
 * The least `window`, `document` and the canvas can be and still carry an
 * event: a map of type to handlers, with `emit`.
 *
 * They were no-ops while the only thing being measured was a walk in a straight
 * line, where the camera never turns. The framing sweep has to turn it, and the
 * only way in is the one the player has — a mouse event, through the listeners
 * `walker.ts` binds for itself. Driving `cameraPitch` any other way would be
 * measuring a camera nobody can ask for.
 */
type Bus = {
  addEventListener: (type: string, handler: (event: never) => void) => void;
  removeEventListener: (type: string, handler: (event: never) => void) => void;
  emit: (type: string, event: unknown) => void;
};

const createBus = (extra: Record<string, unknown> = {}): Bus & Record<string, unknown> => {
  const handlers = new Map<string, Set<(event: never) => void>>();
  return {
    ...extra,
    addEventListener: (type, handler) => {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
    },
    removeEventListener: (type, handler) => handlers.get(type)?.delete(handler),
    emit: (type, event) => {
      for (const handler of [...(handlers.get(type) ?? [])]) handler(event as never);
    },
  };
};

// Several shader modules read `window.devicePixelRatio` behind a `typeof window`
// guard, so the ratio is declared rather than left undefined.
const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
const windowBus = createBus({ devicePixelRatio: 1 });
globals.window = windowBus;
const documentBus = createBus({
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
});
globals.document = documentBus;

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

/** What `createWalker` binds its listeners to: the canvas, as far as it knows. */
const canvasBus = createBus({ setPointerCapture: () => {}, requestPointerLock: () => {} });
const listener = canvasBus as unknown as HTMLElement;

/**
 * The pointer, captured. `walker.ts` only reads `movementX`/`movementY` once
 * `document.pointerLockElement` is the element it was built on and a
 * `pointerlockchange` has told it so, which is the one path that turns a mouse
 * delta into radians at the sensitivity the player actually gets.
 */
const grabPointer = () => {
  documentBus.pointerLockElement = listener;
  documentBus.emit('pointerlockchange', {});
};

/** Radians per pixel the walker turns at, copied from `walker.ts`. */
const BASE_SENSITIVITY = 0.0022;

/** Mouse travel in pixels, as a locked pointer reports it. */
const mouseBy = (deltaX: number, deltaY: number) =>
  windowBus.emit('mousemove', { movementX: deltaX, movementY: deltaY });

/** One notch of the wheel: `walker.ts` moves the distance 1.6 m per notch. */
const WHEEL_STEP = 1.6;
const wheelBy = (notches: number) => {
  for (let step = 0; step < Math.abs(notches); step += 1) {
    canvasBus.emit('wheel', { deltaY: Math.sign(notches), preventDefault: () => {} });
  }
};

// The sweep's own constants, copied from `walker.ts`. Any of these drifting is
// what the replica cross-check is for.
/** How far the look-direction rig this replaced stood the camera over the head. */
const CAMERA_HEIGHT = 2.5;
const CAMERA_CLEARANCE = 0.3;
const WATER_SKIM = 0.25;
const OCCLUSION_SAMPLES = 10;
const DEFAULT_DISTANCE = 8.5;
const FIRST_PERSON_UNDER = 2;
/** Seconds of held occlusion before the view gives up, matching `walker.ts`. */
const FIRST_PERSON_AFTER = 0.4;
const BUILDING_HEAD = 0.8;
/** How far right of the view the rig sits at `DEFAULT_DISTANCE`. */
const CAMERA_SHOULDER = 0.55;
/** How fast the rig shortens and lets back out, and how fast the pivot rises. */
const TUCK_IN = 20;
const TUCK_OUT = 5;
const PIVOT_RISE = 4;
const PIVOT_SNAP = 2.5;
const START_PITCH = -0.29;

/** Frames of walking per location, at 60 Hz, and the stick they are driven with. */
const FRAMES = 60 * 150;
const DELTA = 1 / 60;
/** Frames the camera is given to reach the walker before anything is believed. */
const ARRIVAL = 60;

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
 *
 * `legacy` is the rig the orbit replaced, so that one walk can be judged both
 * ways: the camera placed along `rigOut`/`rigLift` — a trailing line that held
 * still above the horizon and was stood on top of the ground rather than
 * stopped by it — against the orbit, which swings about the chest and treats
 * the ground as the occluder it is.
 */
const sweep = (
  terrain: ReturnType<typeof createTerrain>,
  buildings: Building[],
  canopy: { near: (x: number, z: number, into?: Obstacle[]) => Obstacle[] } | null,
  position: { x: number; y: number; z: number },
  headY: number,
  /** The eased orbit centre the walker is actually swinging about. */
  pivotY: number,
  cameraYaw: number,
  cameraPitch: number,
  footY: number,
  waterLevel: number,
  legacy: boolean
): Blame => {
  const horizontal = Math.cos(cameraPitch);
  const lift = Math.sin(cameraPitch);
  const distance = DEFAULT_DISTANCE;
  const rigLift = Math.min(0, lift);
  const rigOut = lift > 0 ? 1 : horizontal;
  const floorOf = (x: number, z: number) =>
    Math.max(terrain.heightAt(x, z) + CAMERA_CLEARANCE, waterLevel + WATER_SKIM);
  // The rig's line leans `CAMERA_SHOULDER / DEFAULT_DISTANCE` off the view
  // direction, because the shoulder offset is a share of the distance. On a
  // hillside running across the rig that lean is what decides whether the lens
  // is over the terrain or under it, so the replica carries it.
  const lean = legacy ? 0 : CAMERA_SHOULDER / DEFAULT_DISTANCE;
  const lineX = Math.sin(cameraYaw) + Math.cos(cameraYaw) * lean;
  const lineZ = Math.cos(cameraYaw) - Math.sin(cameraYaw) * lean;
  let wasDeficit = floorOf(position.x, position.z) - pivotY;
  let wasReach = 0;

  for (let sample = 1; sample <= OCCLUSION_SAMPLES; sample += 1) {
    const fraction = sample / OCCLUSION_SAMPLES;
    const along = legacy ? rigOut : horizontal;
    const reach = distance * fraction;
    const sampleX = position.x - lineX * along * reach;
    const sampleZ = position.z - lineZ * along * reach;
    const sampleY = legacy ? headY + (CAMERA_HEIGHT - rigLift * distance) * fraction : pivotY - lift * reach;
    const allowed = distance * ((sample - 1) / OCCLUSION_SAMPLES);

    // The ground stopped nothing under the old rule — it raised the camera
    // instead, which is the one move an orbit cannot make, because lifting the
    // camera is what slid the body off the frame. Where it stops the orbit, the
    // crossing is interpolated between samples the same way the walker does it.
    const deficit = floorOf(sampleX, sampleZ) - sampleY;
    if (!legacy && deficit > 0) {
      const span = deficit - wasDeficit;
      let crossing = Math.max(
        0,
        Math.min(span > 1e-6 ? wasReach + (reach - wasReach) * (-wasDeficit / span) : wasReach, reach)
      );
      // The walker's two halvings, for the ground between samples that does not
      // run straight.
      for (let pass = 0; pass < 2; pass += 1) {
        const at = floorOf(position.x - lineX * crossing, position.z - lineZ * crossing) - (pivotY - lift * crossing);
        if (at <= 0) break;
        crossing = wasReach + (crossing - wasReach) * 0.5;
      }
      return { allowed: crossing, branch: 'ground', at: null, depth: deficit };
    }
    wasDeficit = deficit;
    wasReach = reach;

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
      // The walls either way: both rigs read the rectangle, which is what lets a
      // camera see down a lane it is standing in the circumradius of.
      if (!insideBuilding(building, sampleX, sampleZ)) continue;
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
  /**
   * Degrees the camera's forward vector moved between consecutive frames, with
   * no look input at all. Every one of them is camera motion the player did not
   * ask for, which is the thing that makes people ill — so this is the number
   * the comfort work is judged on, not a share or a flag.
   */
  swing: number[];
  /** The least the camera ever cleared the ground by, in metres. */
  lowClear: number;
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
  nearTrees: NearTrees | null,
  waterLevel: number
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
    swing: [],
    lowClear: Infinity,
    worst: [],
    wasHidden: 0,
    wasAllowed: [],
    wasBlame: { clear: 0, ground: 0, canopy: 0, buildings: 0 },
  };
  let lastX = walker.position.x;
  let lastZ = walker.position.z;
  let crowded = 0;
  let orbit = DEFAULT_DISTANCE;
  let pivotY = walker.position.y + eyeHeight * CHEST_SHARE;
  const aim = new Vector3();
  const wasAim = new Vector3();

  for (let frame = 0; frame < FRAMES; frame += 1) {
    walker.update(DELTA, camera);
    out.travelled += Math.hypot(walker.position.x - lastX, walker.position.z - lastZ);
    lastX = walker.position.x;
    lastZ = walker.position.z;

    // The lens direction, read off the quaternion `lookAt` wrote rather than
    // recomputed from the yaw and pitch: anything the camera does after the aim
    // — a roll, a lean — is in here too, and is exactly what is being counted.
    aim.set(0, 0, -1).applyQuaternion(camera.quaternion);
    // Not the first second. A `PerspectiveCamera` is born at the origin and the
    // rig has to get it to the walker, which at Tà Xùa is a 350 m flight — it
    // measured as 81° of swing in a frame and as the lens being 294 m
    // underground, neither of which is anything a player ever sees.
    if (frame > ARRIVAL) {
      const dot = Math.min(1, Math.max(-1, aim.dot(wasAim)));
      out.swing.push((Math.acos(dot) * 180) / Math.PI);
      out.lowClear = Math.min(out.lowClear, camera.position.y - terrain.heightAt(camera.position.x, camera.position.z));
    }
    wasAim.copy(aim);

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
      pivotY,
      cameraYaw,
      START_PITCH,
      walker.position.y,
      waterLevel,
      false
    );

    // The same frame under the rig the orbit replaced. The walk is identical
    // either way — the sweep moves the camera, never the body — so this is a
    // like-for-like comparison rather than two different walks.
    const before = sweep(
      terrain,
      buildings,
      canopy,
      walker.position,
      headY,
      pivotY,
      cameraYaw,
      START_PITCH,
      walker.position.y,
      waterLevel,
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

    // The rest of the walker's rule, replicated: a block that is not the ground
    // is waited out for `FIRST_PERSON_AFTER` at two metres, the rig eases to
    // what is left, and the body stands aside once the lens is inside the two
    // metres it cannot be drawn whole in.
    crowded = verdict.allowed < FIRST_PERSON_UNDER && verdict.branch !== 'ground' ? crowded + DELTA : 0;
    const wantOut =
      crowded > 0 && crowded < FIRST_PERSON_AFTER ? Math.max(verdict.allowed, FIRST_PERSON_UNDER) : verdict.allowed;
    orbit += (wantOut - orbit) * (1 - Math.exp(-DELTA * (wantOut < orbit ? TUCK_IN : TUCK_OUT)));
    if (orbit < FIRST_PERSON_UNDER !== !shown) out.disagree += 1;

    // And the pivot, for the next frame's sweep.
    const wantPivot = walker.position.y + eyeHeight * CHEST_SHARE;
    pivotY += (wantPivot - pivotY) * (1 - Math.exp(-DELTA * PIVOT_RISE));
    if (Math.abs(wantPivot - pivotY) > PIVOT_SNAP) pivotY = wantPivot;

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
    `    look-direction rig: allowed p10 ${fixed(quantile(result.wasAllowed, 0.1))} median ${fixed(
      quantile(result.wasAllowed, 0.5)
    )} · blame ground ${((result.wasBlame.ground / frames) * 100).toFixed(1)}% canopy ${(
      (result.wasBlame.canopy / frames) *
      100
    ).toFixed(1)}% buildings ${((result.wasBlame.buildings / frames) * 100).toFixed(1)}%`
  );
  const tight = result.allowed.filter((value) => value < FIRST_PERSON_UNDER).length;
  console.log(
    `    the orbit's own sweep leaves the lens inside two metres for ${((tight / frames) * 100).toFixed(
      1
    )}% of frames, of which the rig's easing and the ${FIRST_PERSON_AFTER}s of patience save ${(
      ((tight - result.hidden) / frames) *
      100
    ).toFixed(1)} points`
  );
  console.log(
    `    framing over ${result.framed} trailing frames: body out of the picture ${(
      (result.offScreen / Math.max(1, result.framed)) *
      100
    ).toFixed(1)}% · lowest the head ever sat ${fixed(result.lowestHead)} in NDC, where -1 is the bottom edge`
  );
  console.log(
    `    uncommanded camera swing with no look input: median ${fixed(quantile(result.swing, 0.5), 3)}°/frame p99 ${fixed(
      quantile(result.swing, 0.99),
      3
    )}° max ${fixed(Math.max(...result.swing), 3)}° · camera cleared the ground by at least ${fixed(result.lowClear)} m`
  );
  console.log(
    `    orbit: allowed min ${fixed(quantile(result.allowed, 0))} p10 ${fixed(quantile(result.allowed, 0.1))} median ${fixed(
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

// --- where the character sits in the picture --------------------------------

/**
 * The pitches the framing is read at, in radians: nearly straight down, half
 * way, level, and the same either side of the horizon. `MIN_PITCH`/`MAX_PITCH`
 * are ±1.4, so ±1.2 is as far as anyone looks without being against the stop.
 */
const FRAMING_PITCHES = [-1.2, -0.6, 0, 0.6, 1.2];
/** Notches of the wheel either side of the default, at `WHEEL_STEP` apiece. */
const FRAMING_NOTCHES = [-3, 0, 3];
/**
 * Frames run at each stop before the picture is read. The rig's own followers
 * are the slowest thing in the loop and none of them has a time constant over
 * half a second, so a second and a half is settled rather than merely quiet.
 */
const SETTLE = 90;
/**
 * The orbit pivot, as a share of the eye height — `walker.ts` derives the chest
 * the same way so that the primitive rig the probe gets (no `humanSource`, so
 * `PERSON_HEIGHT * 0.9` eyes) and the 1.78 m human agree about where the middle
 * of a body is.
 *
 * Which is also the one thing to read with care here: the probe never downloads
 * the rigged human, so its chest sits at 1.95 m rather than 1.27, and the orbit
 * has 68 cm more headroom to swing down through before the ground stops it. The
 * screen positions below are the rig's own geometry and do not care, but the
 * pitch at which the body gives way to first person does — that number is
 * printed for both rigs.
 */
const CHEST_SHARE = 1.27 / 1.64;

/** On the flat, the upward pitch at which the ground shortens the rig past
 *  `FIRST_PERSON_UNDER` and the body stands aside, in degrees. */
const collapsePitch = (chest: number): number =>
  (Math.asin(Math.min(1, (chest - CAMERA_CLEARANCE) / FIRST_PERSON_UNDER)) * 180) / Math.PI;

type Shot = {
  distance: number;
  pitch: number;
  /** Where the chest landed, in NDC: ±1 is the edge of the frame. */
  x: number;
  y: number;
  ahead: boolean;
  shown: boolean;
  /** Metres from the lens to the chest. */
  trail: number;
};

/**
 * The complaint, measured. "góc nhìn phải lấy nhân vật làm trung tâm" — the
 * view must take the character as its centre — is a claim about one number:
 * where the body lands in the picture as the pitch moves. An orbit holds it
 * still; a camera that only turns its aim lets the body slide out of frame,
 * which is what was reported.
 *
 * Driven through the walker's own mouse listeners at the sensitivity the player
 * gets, and read by projecting the chest through the camera the walker wrote —
 * so nothing here knows how the rig is built and the number stands whatever
 * replaces it.
 */
const framing = (walker: ReturnType<typeof createWalker>, label: string) => {
  const camera = new Camera(52, 16 / 9, 2, 40_000) as PerspectiveCamera;
  const avatar: { visible: boolean }[] = [];
  walker.group.traverse((node) => {
    if (node instanceof Mesh) avatar.push(node as unknown as { visible: boolean });
  });
  const chest = PERSON_HEIGHT * 0.9 * CHEST_SHARE;
  const point = new Vector3();

  grabPointer();
  walker.setJoystick(null);
  let pitch = START_PITCH;
  const shots: Shot[] = [];

  for (const notches of FRAMING_NOTCHES) {
    wheelBy(notches);
    const distance = DEFAULT_DISTANCE + notches * WHEEL_STEP;

    for (const target of FRAMING_PITCHES) {
      // `look` subtracts the mouse travel, so the pixels are the other way about.
      mouseBy(0, (pitch - target) / BASE_SENSITIVITY);
      pitch = target;
      for (let frame = 0; frame < SETTLE; frame += 1) walker.update(DELTA, camera);

      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      point.set(walker.position.x, walker.position.y + chest, walker.position.z);
      const trail = point.distanceTo(camera.position);
      point.project(camera);
      shots.push({
        distance,
        pitch: target,
        x: point.x,
        y: point.y,
        ahead: point.z > -1 && point.z < 1,
        shown: avatar.some((mesh) => mesh.visible),
        trail,
      });
    }

    wheelBy(-notches);
  }

  console.log(
    `  ${label}: chest in the picture, by pitch (NDC, 0 is the centre and ±1 the edge) · on the flat the body gives way to first person above ${fixed(
      collapsePitch(chest),
      1
    )}° of upward pitch on this primitive rig, ${fixed(collapsePitch(1.27), 1)}° on the human one`
  );
  for (const notches of FRAMING_NOTCHES) {
    const row = shots.filter((shot) => shot.distance === DEFAULT_DISTANCE + notches * WHEEL_STEP);
    const framed = row.filter((shot) => shot.ahead);
    const spreadY = framed.length > 1 ? Math.max(...framed.map((s) => s.y)) - Math.min(...framed.map((s) => s.y)) : NaN;
    const spreadX = framed.length > 1 ? Math.max(...framed.map((s) => s.x)) - Math.min(...framed.map((s) => s.x)) : NaN;
    console.log(
      `    wheel ${fixed(DEFAULT_DISTANCE + notches * WHEEL_STEP, 1)} m: ${row
        .map(
          (shot) =>
            `${shot.pitch >= 0 ? '+' : ''}${shot.pitch.toFixed(1)} -> ${
              shot.ahead ? `${shot.y >= 0 ? '+' : ''}${shot.y.toFixed(2)}` : 'behind'
            }${shot.shown ? '' : ' (hidden)'}`
        )
        .join('  ')}`
    );
    const held = framed.length > 0 ? framed[0] : null;
    console.log(
      `      spread across the pitch range: y ${fixed(spreadY, 3)} x ${fixed(spreadX, 3)} of a 2.0 frame · held at x ${
        held ? fixed(held.x, 3) : '—'
      } y ${held ? fixed(held.y, 3) : '—'} · trail ${row.map((shot) => fixed(shot.trail, 1)).join('/')} m`
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
        const pivotY = ground + eyeHeight * CHEST_SHARE;
        const was = sweep(terrain, buildings, canopy, at, headY, pivotY, yaw, START_PITCH, ground, waterLevel, true);
        const now = sweep(terrain, buildings, canopy, at, headY, pivotY, yaw, START_PITCH, ground, waterLevel, false);
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
  report('from spawn', walk(fromSpawn, terrain, town.buildings, canopyIndex, facing, nearTrees, waterLevel));
  fromSpawn.dispose();

  // Standing still at the spawn and looking about, which is the gesture the
  // complaint is about — the walk above never turns the camera at all.
  const standing = seeded(() =>
    createWalker(terrain, listener, spawn.x, spawn.z, town.buildings, canopyIndex, facing, undefined, {
      water: recipe.water ?? null,
      reducedMotion: true,
    })
  );
  framing(standing, 'at the spawn');
  standing.dispose();

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

    const throughTown = seeded(() =>
      createWalker(terrain, listener, edgeX, edgeZ, town.buildings, canopyIndex, heading, undefined, {
        water: recipe.water ?? null,
        reducedMotion: true,
      })
    );
    report(
      'through the village',
      walk(throughTown, terrain, town.buildings, canopyIndex, heading, nearTrees, waterLevel)
    );
    throughTown.dispose();

    // In the lane, where something is on the camera line and the distance is
    // being shortened — the framing has to hold through that too, or clearing a
    // doorway moves the body up the frame.
    const inTown = seeded(() =>
      createWalker(terrain, listener, dense.x, dense.z, town.buildings, canopyIndex, heading, undefined, {
        water: recipe.water ?? null,
        reducedMotion: true,
      })
    );
    framing(inTown, 'in the village');
    inTown.dispose();

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
