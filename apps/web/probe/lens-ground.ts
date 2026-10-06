/**
 * What the player photographed: a hillside drawn over the avatar.
 *
 * `scripts/walker-camera.ts` measures the sweep and the framing, and reports the
 * least the lens ever cleared the ground by along one straight walk at one fixed
 * pitch. `probe/camera-jump.ts` measures how far the lens moves in a frame while
 * riding. Neither answers the two questions a screenshot of the inside of a hill
 * asks, which is why this exists:
 *
 *   1. is anything drawn between the lens and the body, and how deep
 *   2. for how long in a row is the body not actually in the picture
 *
 * The second number is the one the player feels. 1.8% of frames spread evenly is
 * a flicker; 1.8% in one block is "mất cả người chơi" — the player is gone.
 *
 * Both are measured off the camera `walker.update` actually wrote and the
 * avatar's own `visible` flag, never off a replica of the sweep: a replica that
 * agrees with the code it copies still cannot see an occluder neither of them
 * tests for, and that is exactly the failure here.
 *
 * Two things are counted, because they are different failures:
 *
 *   - **the lens inside the terrain**, which is a view of the inside of the
 *     world. `heightAt` is bilinear over the same grid the mesh is built from,
 *     so this is the drawn surface to within the saddle error of one cell.
 *   - **terrain across the sight line**, beyond the near plane and short of the
 *     body: the lens behind a crest, with the figure's feet, or the whole
 *     figure, drawn behind the hill while nothing in the sweep is aware of it.
 *
 * Carriageways are deliberately *not* counted. The hypothesis was good — the
 * sweep reads `floorAt`, which raises the floor to a deck only where the sample
 * stands over that deck's footprint, so one step off a Tà Xùa embankment the
 * floor is the hillside up to 8.6 m down — but `Platform` carries a surface and
 * no underside, and a test that asks only whether the slab is *above* the sight
 * line fires on every frame a rider is seen from under a bridge. It measured
 * 3.07% of a Tràng An ride as occluded on that basis and all of it was the
 * probe. Answering it properly needs a thickness the road network does not
 * publish, and inventing one is not measuring.
 *
 * The pitch is swept rather than held, because the orbit's own documentation
 * says looking up is what swings the lens down behind the body — a camera held
 * at the default -0.29 rad sits 2.4 m *above* the chest and can hardly find the
 * ground at all.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/lens-ground.ts
 *   … probe/lens-ground.ts --only=ta-xua
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { PerspectiveCamera as Lens } from 'three';

import type { MeshSource, NatureSources } from '../src/scene/model-loader.ts';

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

/** The least `window`/`document` can be and still carry a mouse event. */
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

const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
const windowBus = createBus({ devicePixelRatio: 1 });
globals.window = windowBus;
const documentBus = createBus({
  pointerLockElement: null,
  exitPointerLock: () => {},
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
const { Group, Mesh, PerspectiveCamera, Vector3 } = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

const { QUALITY_SETTINGS } = await import('../src/scene/quality.ts');
const { createWind } = await import('../src/scene/wind.ts');
const { createNatureScatter } = await import('../src/scene/nature-scatter.ts');
const { createObstacleIndex } = await import('../src/scene/obstacle-index.ts');
const { createNearTrees } = await import('../src/scene/tree-near.ts');
const { createRoadNetwork } = await import('../src/scene/road-network.ts');
const { createTownMeshes } = await import('../src/scene/town-meshes.ts');
const { createVehicles } = await import('../src/scene/vehicles.ts');
const { planTown } = await import('../src/scene/town-plan.ts');
const { resolvePois } = await import('../src/scene/points-of-interest.ts');
const { createWalker } = await import('../src/scene/walker.ts');

type Terrain = ReturnType<typeof createTerrain>;
type Network = ReturnType<typeof createRoadNetwork>;
type Platform = Network['decks'][number];
type Road = Network['roads'][number];
type Walker = ReturnType<typeof createWalker>;

const argument = (name: string, fallback: string): string => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const only = argument('only', '');
const settings = QUALITY_SETTINGS[argument('tier', 'high') as keyof typeof QUALITY_SETTINGS];

const DELTA = 1 / 60;
/** Frames the rig is given to fly in from the origin before anything counts. */
const ARRIVAL = 60;
/** Seconds of walking, and of riding, per destination. */
const WALK_FOR = 90;
const RIDE_FOR = 45;
/** Legs of steep ground, and seconds each, with a fresh pitch phase per leg. */
const STEEP_LEGS = 20;
const LEG_FOR = 12;
/** Candidate points the spiral tries before it gives up on finding those legs. */
const STEEP_SEARCH = 4000;
/** Points sampled along a sight line when looking for an occluder. */
const SIGHT_SAMPLES = 48;
/**
 * Metres of clearance under which the lens is called grazing.
 *
 * `CAMERA_CLEARANCE` is 0.3, so the sweep is entitled to put the lens here and
 * the number is not a failure on its own. It is the context for the two that
 * are: a lens half a metre over a hillside made of 12.5 m triangles sees that
 * hillside at a grazing angle, which is one hard-edged flat-shaded face filling
 * the bottom of the frame — and it is one upward degree of pitch away from
 * being under it.
 */
const GRAZING = 0.5;
/**
 * How far short of the body a sight line stops, metres. `BODY_RADIUS` in
 * `walker.ts` is 1.2 against a wall, so half of it is the shoulder it is tuned
 * for and is the least distance at which ground in front of the figure is
 * ground and not the floor the figure is standing on.
 */
const SILHOUETTE_MARGIN = 0.6;

// `walker.ts`'s own, for the chest the rig orbits and the two metres a body
// cannot be drawn whole in. Read, never re-derived: a drift here is a lie.
const EYE_HEIGHT = 1.64;
const CHEST_HEIGHT = 1.27;
const SADDLE_EYE = 1.65;
const CHEST_SHARE = CHEST_HEIGHT / EYE_HEIGHT;
const FIRST_PERSON_UNDER = 2;
const CAMERA_CLEARANCE = 0.3;
const OCCLUSION_SAMPLES = 10;
const STEP_UP = 0.4;
const BASE_SENSITIVITY = 0.0022;

/**
 * How the pitch is swept while the body walks or rides: a slow nod through most
 * of the range the stops allow, because what puts the lens in the ground is
 * looking *up*, and a probe that holds the default pitch never looks up at all.
 *
 * 11 s a cycle — slower than any of the rig's own followers, so every frame of
 * it is a settled reading rather than a chase.
 */
const PITCH_PERIOD = 11;
const PITCH_LOW = -0.5;
const PITCH_HIGH = 1.15;
/**
 * The pitch as last driven, and the clock the nod is read off, both held across
 * the passes of one destination and reset between destinations — so a
 * `--only=` run samples the same phases of the nod as the same destination does
 * inside a full one, and the two reports can be compared.
 *
 * `walker.ts` exposes no `cameraPitch`, so the only way to a known pitch is to
 * emit the mouse travel from the last one — which means the tracker has to
 * outlive the pass, or the first frame of every leg emits a delta from a pitch
 * the walker is no longer at. The clock is shared for the same reason in
 * reverse: restarted per leg, every leg would sample the same half of the nod.
 */
let heldPitch = -0.29;
let clock = 0;

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

const canvasBus = createBus({ setPointerCapture: () => {}, requestPointerLock: () => {} });
const listener = canvasBus as unknown as HTMLElement;
/**
 * The pointer, captured — once per walker, not once per run.
 *
 * `walker.ts` ignores every `mousemove` until its own `pointerlockchange`
 * handler has set `locked`, and that handler is bound when the walker is built.
 * Grabbing once at the top of a run therefore leaves every walker constructed
 * afterwards deaf to the mouse: the first version of this probe nodded the pitch
 * for its first pass and measured the other three at the default -0.29 rad while
 * printing the pitch it thought it had asked for.
 */
const grabPointer = () => {
  documentBus.pointerLockElement = listener;
  documentBus.emit('pointerlockchange', {});
};

const MODELS = fileURLToPath(new URL('../public/models/nature/', import.meta.url));

/** The nature kit off disk, so the forest branch of the sweep is real. */
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

/**
 * A `HumanSource` with no human in it.
 *
 * `walker.ts` reads `eyeHeight = human ? EYE_HEIGHT : PERSON_HEIGHT * 0.9`, so a
 * probe that skips the FBX orbits a chest at 1.95 m instead of 1.27 and hands
 * the rig 68 cm of headroom to swing down through that no player has. The rig
 * never looks at the figure, only at the height, so an empty group bought at the
 * price of two allocations buys the right geometry — and `createHuman` is happy
 * with it: no clips means `play` finds nothing, and no bones means every `aim`
 * returns at its first line.
 */
const stubHuman = () => {
  const prototype = new Group();
  prototype.add(new Mesh());
  return { prototype, clips: [], scale: 1, feetOffset: 0, strides: new Map<string, number>() };
};

/** `floorAt` from `walker.ts`: the ground, or a deck within one step of here. */
const makeFloorAt = (terrain: Terrain, platforms: Platform[]) => {
  const decks = platforms.map((platform) => ({
    platform,
    alongX: Math.sin(platform.yaw),
    alongZ: Math.cos(platform.yaw),
    grade: platform.grade ?? 0,
    reachSquared: (platform.halfLength + platform.halfWidth) ** 2,
  }));
  return {
    floorAt: (x: number, z: number, reference: number): number => {
      let best = terrain.heightAt(x, z);
      for (const deck of decks) {
        const dx = x - deck.platform.x;
        const dz = z - deck.platform.z;
        if (dx * dx + dz * dz > deck.reachSquared) continue;
        const along = dx * deck.alongX + dz * deck.alongZ;
        if (Math.abs(along) > deck.platform.halfLength) continue;
        if (Math.abs(dx * deck.alongZ - dz * deck.alongX) > deck.platform.halfWidth) continue;
        const surface = deck.platform.surfaceY + deck.grade * along;
        if (surface <= best || surface > reference + STEP_UP) continue;
        best = surface;
      }
      return best;
    },
  };
};

const findSpawn = (terrain: Terrain, waterLevel: number, lots: { x: number; z: number }[]) => {
  const half = terrain.size / 2;
  const clear = (x: number, z: number) => lots.every((lot) => Math.hypot(x - lot.x, z - lot.z) > 22);
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

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const fixed = (value: number, places = 2): string => (Number.isFinite(value) ? value.toFixed(places) : '—');
const share = (count: number, total: number) => `${((count / Math.max(1, total)) * 100).toFixed(2)}%`;

type Tally = {
  frames: number;
  /** Frames the lens sat below the terrain surface, and the worst depth. */
  inside: number;
  worstInside: number;
  /** Frames the ground stood in front of the feet, and of the head, and how far. */
  byTerrain: number;
  worstTerrain: number;
  byDeck: number;
  worstDeck: number;
  /** Frames the lens sat inside `GRAZING` of the floor, and the least it ever had. */
  grazing: number;
  lowest: number;
  /** Frames the avatar's own meshes were switched off, by the rig's own rule. */
  unflagged: number;
  /** Frames the body was not in the picture, however it got that way. */
  lost: number;
  /** The longest unbroken run of those, in frames, and where it started. */
  longest: number;
  longestAt: { x: number; z: number; pitch: number; speed: number } | null;
  /** The single worst frame, whatever hid the body, for naming the mechanism. */
  worst: {
    depth: number;
    cause: string;
    x: number;
    z: number;
    lens: number;
    chest: number;
    pitch: number;
    speed: number;
    rig: number;
    /**
     * What the sweep's own test would have found on that frame at its own
     * resolution, and what it would have found at twenty times that.
     *
     * `walker.ts` tests `OCCLUSION_SAMPLES` points along the rig line and asks
     * for `CAMERA_CLEARANCE` at each. Replicated along the lens→chest segment,
     * which is that line to within the shoulder lean and whatever the pivot is
     * lagging by. Coarse clear and fine blocked is a crest standing between two
     * samples and seen by neither — the one hypothesis a count of ten invites.
     */
    coarse: number;
    fine: number;
  } | null;
};

const emptyTally = (): Tally => ({
  frames: 0,
  inside: 0,
  worstInside: 0,
  byTerrain: 0,
  worstTerrain: 0,
  byDeck: 0,
  worstDeck: 0,
  grazing: 0,
  lowest: Number.POSITIVE_INFINITY,
  unflagged: 0,
  lost: 0,
  longest: 0,
  longestAt: null,
  worst: null,
});

/**
 * One pass: drive the walker, nod the pitch, and tally what came between the
 * lens and the body.
 *
 * `steer` is handed the frame number and returns the stick; riding follows the
 * trunk road with it, walking holds it forward.
 */
const measure = (
  walker: Walker,
  terrain: Terrain,
  floors: ReturnType<typeof makeFloorAt>,
  seconds: number,
  riding: boolean,
  steer: (frame: number) => { x: number; y: number } | null
): Tally => {
  const camera = new PerspectiveCamera(52, 16 / 9, riding ? 0.25 : 2, 40_000) as Lens;
  /**
   * Whether the figure is drawn, asked of the whole chain rather than of the
   * mesh.
   *
   * `walker.ts` switches `human.group.visible` when there is a rigged figure
   * and the primitive `bodyMesh`/`hatMesh` when there is not, so a probe that
   * reads the leaf's own flag reports a body on screen through every frame the
   * rig had already stood it down — which is a 0.0% that means nothing.
   */
  const avatar: { visible: boolean; parent: unknown }[] = [];
  walker.group.traverse((node) => {
    if (node instanceof Mesh) avatar.push(node as unknown as { visible: boolean; parent: unknown });
  });
  const drawn = (node: { visible: boolean; parent: unknown } | null): boolean => {
    for (let at = node; at; at = at.parent as typeof node) if (!at.visible) return false;
    return true;
  };

  grabPointer();
  const out = emptyTally();
  const point = new Vector3();
  let run = 0;
  let lastX = walker.position.x;
  let lastZ = walker.position.z;

  const total = Math.round(seconds * 60);
  for (let frame = 0; frame < total; frame += 1) {
    const stick = steer(frame);
    walker.setJoystick(stick);

    // Through the walker's own mouse listener at the sensitivity the player
    // gets, so the pitch is one a hand could have asked for.
    clock += DELTA;
    const wanted = PITCH_LOW + (PITCH_HIGH - PITCH_LOW) * (0.5 - Math.cos((clock * Math.PI * 2) / PITCH_PERIOD) / 2);
    windowBus.emit('mousemove', { movementX: 0, movementY: (heldPitch - wanted) / BASE_SENSITIVITY });
    heldPitch = wanted;
    const pitch = wanted;

    walker.update(DELTA, camera);

    const speed = Math.hypot(walker.position.x - lastX, walker.position.z - lastZ) / DELTA;
    lastX = walker.position.x;
    lastZ = walker.position.z;
    if (frame < ARRIVAL) continue;

    out.frames += 1;

    const chestY = walker.position.y + (riding ? SADDLE_EYE : EYE_HEIGHT) * CHEST_SHARE;
    const lensX = camera.position.x;
    const lensY = camera.position.y;
    const lensZ = camera.position.z;

    const underLens = terrain.heightAt(lensX, lensZ) - lensY;
    if (underLens > 0) {
      out.inside += 1;
      out.worstInside = Math.max(out.worstInside, underLens);
    }

    /**
     * How much of the body the ground is in front of, from the near plane out.
     *
     * The picture rather than the rig, and only the part of it the renderer
     * draws: nothing inside the world camera's 2 m near plane exists on screen,
     * so a hillside the lens is buried in is not an occluder — it is a hole you
     * see through, the terrain material being single-sided. What hides a body is
     * ground that crosses the sight line *beyond* the plane, and that is what
     * this samples.
     *
     * One ray per part, because they are three different complaints: the feet
     * behind a crest is the lower frame filling with hillside, the chest gone is
     * the body mostly swallowed, and the head gone is "mất cả người chơi" with
     * the avatar still flagged visible and nothing in the sweep aware of it.
     */
    const blockedTo = (targetY: number): number => {
      const span = Math.hypot(walker.position.x - lensX, targetY - lensY, walker.position.z - lensZ);
      const from = camera.near / span;
      // Stopped short of the body by its own half-width, and this is the whole
      // honesty of the measurement: the feet are standing *on* the terrain, so a
      // ray run the last few centimetres into them finds the ground at the
      // target every time and reports the hillside somebody is walking on as an
      // occluder. Only ground that crosses the line while there is still a body
      // ahead of it is drawn in front of anything.
      const until = 1 - SILHOUETTE_MARGIN / span;
      if (until <= from) return 0;
      let deepest = 0;
      for (let step = 0; step <= SIGHT_SAMPLES; step += 1) {
        const t = from + (until - from) * (step / SIGHT_SAMPLES);
        const x = lensX + (walker.position.x - lensX) * t;
        const z = lensZ + (walker.position.z - lensZ) * t;
        const y = lensY + (targetY - lensY) * t;
        deepest = Math.max(deepest, terrain.heightAt(x, z) - y);
      }
      return deepest;
    };

    const feetBlocked = blockedTo(walker.position.y + 0.1);
    const headBlocked = blockedTo(walker.position.y + (riding ? SADDLE_EYE : EYE_HEIGHT));
    const chestBlocked = blockedTo(chestY);
    if (feetBlocked > 0) {
      out.byTerrain += 1;
      out.worstTerrain = Math.max(out.worstTerrain, feetBlocked);
    }
    if (headBlocked > 0) {
      out.byDeck += 1;
      out.worstDeck = Math.max(out.worstDeck, headBlocked);
    }
    // How near the lens is sitting to whatever is under it, which is the knob
    // `CAMERA_CLEARANCE` sets and the thing a grazing view of the grass is.
    const clearance = lensY - floors.floorAt(lensX, lensZ, walker.position.y);
    out.lowest = Math.min(out.lowest, clearance);
    if (clearance < GRAZING) out.grazing += 1;

    const shown = avatar.some(drawn);
    if (!shown) out.unflagged += 1;
    // Riding hides the walking avatar on purpose — the figure in the saddle is
    // the machine's own — so there the lost frame is the rig collapsing to the
    // eyes, which is the view the player is thrown into without asking.
    const rig = Math.hypot(lensX - walker.position.x, lensY - chestY, lensZ - walker.position.z);
    /**
     * The body is not in the picture.
     *
     * Three ways, and all three are the same complaint to whoever is holding the
     * mouse: the rig stood the figure down, or the ground is in front of its
     * head, or — riding, where the walking avatar is hidden on purpose and the
     * figure you see is the machine's own — the rig collapsed to the saddle.
     */
    const gone = riding ? rig < FIRST_PERSON_UNDER || headBlocked > 0 : !shown || headBlocked > 0;

    if (gone) {
      run += 1;
      if (run > out.longest) {
        out.longest = run;
        out.longestAt = { x: walker.position.x, z: walker.position.z, pitch, speed };
      }
      out.lost += 1;
    } else {
      run = 0;
    }

    /**
     * The sweep's test, re-run along the same line at a chosen resolution.
     *
     * Swept from the chest outwards, as the walker sweeps from the pivot
     * outwards, so sample k lands where the walker's sample k lands.
     */
    const sweptDeficit = (samples: number): number => {
      let worst = Number.NEGATIVE_INFINITY;
      for (let step = 1; step <= samples; step += 1) {
        const t = step / samples;
        const x = walker.position.x + (lensX - walker.position.x) * t;
        const z = walker.position.z + (lensZ - walker.position.z) * t;
        const y = chestY + (lensY - chestY) * t;
        worst = Math.max(worst, floors.floorAt(x, z, walker.position.y) + CAMERA_CLEARANCE - y);
      }
      return worst;
    };

    const depth = Math.max(chestBlocked, underLens);
    if (depth > 0 && (!out.worst || depth > out.worst.depth)) {
      point.set(walker.position.x, chestY, walker.position.z);
      out.worst = {
        depth,
        cause:
          headBlocked > 0
            ? 'the ground in front of the whole figure'
            : chestBlocked > 0
              ? 'the ground in front of the chest'
              : 'the lens inside the hill, with nothing drawn over the body',
        x: walker.position.x,
        z: walker.position.z,
        lens: lensY,
        chest: chestY,
        pitch,
        speed,
        rig: point.distanceTo(camera.position),
        coarse: sweptDeficit(OCCLUSION_SAMPLES),
        fine: sweptDeficit(OCCLUSION_SAMPLES * 20),
      };
    }
  }

  return out;
};

/**
 * Several short legs as one reading. The longest-run figure is the longest of
 * the legs, not the sum: a leg ends because the probe teleported the body, which
 * is not something the player did, so a run cannot be carried across one.
 */
const merge = (into: Tally, leg: Tally): Tally => {
  into.frames += leg.frames;
  into.inside += leg.inside;
  into.worstInside = Math.max(into.worstInside, leg.worstInside);
  into.byTerrain += leg.byTerrain;
  into.worstTerrain = Math.max(into.worstTerrain, leg.worstTerrain);
  into.byDeck += leg.byDeck;
  into.worstDeck = Math.max(into.worstDeck, leg.worstDeck);
  into.grazing += leg.grazing;
  into.lowest = Math.min(into.lowest, leg.lowest);
  into.unflagged += leg.unflagged;
  into.lost += leg.lost;
  if (leg.longest > into.longest) {
    into.longest = leg.longest;
    into.longestAt = leg.longestAt;
  }
  if (leg.worst && (!into.worst || leg.worst.depth > into.worst.depth)) into.worst = leg.worst;
  return into;
};

const report = (label: string, out: Tally) => {
  console.log(`  ${label}: ${out.frames} frames`);
  console.log(
    `    lens inside the terrain ${share(out.inside, out.frames)} of frames, worst ${fixed(out.worstInside)} m under`
  );
  console.log(
    `    ground in front of the body, past the near plane — the feet ${share(out.byTerrain, out.frames)} (worst ${fixed(
      out.worstTerrain
    )} m over that line) · the head ${share(out.byDeck, out.frames)} (worst ${fixed(out.worstDeck)} m)`
  );
  console.log(
    `    lens within ${GRAZING} m of the floor ${share(out.grazing, out.frames)} of frames, least clearance ${fixed(
      out.lowest
    )} m`
  );
  console.log(
    `    body gone ${share(out.lost, out.frames)} of frames, longest unbroken ${fixed(
      out.longest / 60
    )} s · the rig's own rule switched it off for ${share(out.unflagged, out.frames)}`
  );
  if (out.longestAt) {
    console.log(
      `      that run began at ${fixed(out.longestAt.x, 1)},${fixed(out.longestAt.z, 1)} · pitch ${fixed(
        out.longestAt.pitch,
        2
      )} rad · ${fixed(out.longestAt.speed, 1)} m/s`
    );
  }
  if (out.worst) {
    const w = out.worst;
    console.log(
      `    worst frame: ${w.cause}, ${fixed(w.depth)} m · body at ${fixed(w.x, 1)},${fixed(w.z, 1)} · lens y ${fixed(
        w.lens
      )} against a chest at ${fixed(w.chest)} · pitch ${fixed(w.pitch, 2)} rad · ${fixed(w.speed, 1)} m/s · rig ${fixed(
        w.rig
      )} m`
    );
    console.log(
      `      the sweep's own test on that frame: ${OCCLUSION_SAMPLES} samples found ${fixed(
        w.coarse
      )} m of deficit, ${OCCLUSION_SAMPLES * 20} found ${fixed(w.fine)} m — ${
        w.coarse <= 0 && w.fine > 0 ? 'a crest standing between two samples' : 'the same crest either way'
      }`
    );
  }
};

const probe = (slug: string, sources: NatureSources) => {
  const recipe = LOCATIONS[slug];
  if (!recipe) {
    console.error(`Không có location ${slug}`);
    return;
  }

  heldPitch = -0.29;
  clock = 0;

  const terrain = createTerrain(recipe, settings.segments);
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const wind = createWind(recipe);
  const plan = planTown(terrain, recipe, 1);
  const town = createTownMeshes(terrain, recipe, { plan });
  const pois = resolvePois(terrain, recipe, town.buildings);
  const net = createRoadNetwork(terrain, recipe, pois, plan.lots);
  const vehicles = createVehicles(recipe, net, 16, terrain);
  const floors = makeFloorAt(terrain, net.decks);

  const treeBudget = Math.min(recipe.scatter.trees, settings.trees);
  const nature = createNatureScatter(
    terrain,
    recipe,
    sources,
    { trees: treeBudget, bushes: Math.round(treeBudget * 0.7), rocks: Math.round(treeBudget * 0.25) },
    waterLevel,
    wind,
    null
  );
  const canopy = createObstacleIndex(nature.canopy);
  const nearTrees = createNearTrees(terrain, recipe, settings.nearTrees, wind);

  /** How much of the road stands clear of the hill it crosses, as context. */
  let clearSum = 0;
  let clearMax = 0;
  for (const deck of net.decks) {
    const gap = deck.surfaceY - terrain.heightAt(deck.x, deck.z);
    clearSum += gap;
    clearMax = Math.max(clearMax, gap);
  }
  console.log(
    `\n=== ${slug} · ${town.buildings.length} buildings · ${nature.canopy.length} crowns · ${net.decks.length} carriageway spans standing a mean ${fixed(
      clearSum / Math.max(1, net.decks.length)
    )} m and up to ${fixed(clearMax)} m clear of the ground ===`
  );

  const options = {
    water: recipe.water ?? null,
    platforms: net.decks,
    rideables: () => vehicles.rideables(),
    nearCrowns: () => nearTrees.crowns,
    reducedMotion: true,
  };

  // --- on foot, off the road -------------------------------------------------
  const spawn = findSpawn(terrain, waterLevel, plan.lots);
  const onFoot = seeded(() =>
    createWalker(terrain, listener, spawn.x, spawn.z, town.buildings, canopy, 0, stubHuman(), options)
  );
  report(
    'walking',
    measure(onFoot, terrain, floors, WALK_FOR, false, (frame) => {
      nearTrees.follow(onFoot.position.x, onFoot.position.z);
      nearTrees.update(frame * DELTA);
      return { x: 0, y: 1 };
    })
  );
  onFoot.dispose();

  /**
   * And on foot on the steep ground, which is the half of the destination the
   * spawn rule is written to avoid.
   *
   * `findSpawn` wants `slopeAt < 0.35` and the crest refinement wants 0.3, so a
   * walk from the spawn never touches the hillside the complaint came off —
   * `CLIMB_SLOPE` lets a body scramble up 1.15, three times that. Legs rather
   * than one walk, because what matters is how many different pieces of
   * hillside do it, not how far one of them goes: a single walk that found a
   * clean line would say the ground is fine, which is how this was missed.
   */
  const steepStarts: { x: number; z: number }[] = [];
  const reach = terrain.size / 2 - 60;
  // A golden-angle spiral over the whole map rather than a ring of twenty. The
  // first version of this took `STEEP_LEGS * 4` candidates and found seventeen
  // legs at Tà Xùa and *none* at the other three, which reads as "only Tà Xùa
  // has a hillside" and is not true — Tràng An's karst reaches a gradient of
  // 2.64. It was sampling eighty points of a 3,600 m map.
  for (let ring = 1; ring <= STEEP_SEARCH && steepStarts.length < STEEP_LEGS; ring += 1) {
    const angle = ring * 2.39996;
    const radius = reach * Math.sqrt(ring / STEEP_SEARCH);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    if (terrain.heightAt(x, z) <= waterLevel + 3) continue;
    // Standable and steep: under `CLIMB_SLOPE`, which is what a body may
    // scramble up, and well over the 0.35 the spawn rule holds itself to.
    const slope = terrain.slopeAt(x, z);
    if (slope < 0.7 || slope > 1.1) continue;
    // Spread out, so twenty legs are twenty hillsides and not one of them
    // walked twenty times.
    if (steepStarts.some((start) => Math.hypot(start.x - x, start.z - z) < 200)) continue;
    steepStarts.push({ x, z });
  }

  const scrambler = seeded(() =>
    createWalker(terrain, listener, spawn.x, spawn.z, town.buildings, canopy, 0, stubHuman(), options)
  );
  const rough = emptyTally();
  for (let leg = 0; leg < steepStarts.length; leg += 1) {
    const start = steepStarts[leg];
    scrambler.teleport(start.x, start.z);
    // The stick is camera-relative, so each leg sets its direction by turning
    // the view a fifth of a turn — down the fall line on some legs and across
    // it on others, which is the case the shoulder lean was found to matter for.
    windowBus.emit('mousemove', { movementX: -1.2 / BASE_SENSITIVITY, movementY: 0 });
    merge(
      rough,
      measure(scrambler, terrain, floors, LEG_FOR, false, (frame) => {
        nearTrees.follow(scrambler.position.x, scrambler.position.z);
        nearTrees.update(frame * DELTA);
        return { x: 0, y: 1 };
      })
    );
  }
  if (steepStarts.length > 0) report(`walking ${steepStarts.length} legs of steep ground`, rough);
  else console.log('  no standable ground over a 0.7 gradient here, so no legs to walk');
  scrambler.dispose();

  // --- on foot, along the carriageway ---------------------------------------
  // The road is where the embankment is, and the embankment is the hypothesis.
  // A walk from the spawn is hundreds of metres from any made surface.
  const trunk = net.roads
    .filter((entry) => entry.kind !== 'trail')
    .reduce((best, entry) => (best && best.totalLength >= entry.totalLength ? best : entry), null as Road | null);

  if (!trunk) {
    console.log('  no made road here, so nothing to ride');
    nature.dispose();
    town.dispose();
    nearTrees.dispose();
    vehicles.dispose();
    return;
  }

  const count = Math.floor(trunk.points.length / 3);
  const px = (i: number) => trunk.points[i * 3];
  const pz = (i: number) => trunk.points[i * 3 + 2];
  const spacing = Math.max(0.5, Math.hypot(px(1) - px(0), pz(1) - pz(0)));

  /**
   * The stick that follows the trunk road, lifted from `probe/camera-jump.ts`:
   * walk the nearest sample forward, aim fifteen metres ahead of it, and turn
   * towards that. Shared by the walk and the ride so both cross the same ground.
   */
  const follower = (walker: Walker) => {
    let sample = 1;
    let done = false;
    return (): { x: number; y: number } => {
      if (done) return { x: 0, y: 0 };
      let gap = Infinity;
      for (let i = Math.max(0, sample - 4); i < Math.min(count, sample + 40); i += 1) {
        const reach = Math.hypot(walker.position.x - px(i), walker.position.z - pz(i));
        if (reach < gap) {
          gap = reach;
          sample = i;
        }
      }
      if (sample >= count - 2) {
        done = true;
        return { x: 0, y: 0 };
      }
      const aim = Math.min(count - 1, sample + Math.ceil(15 / spacing));
      const wanted = Math.atan2(px(aim) - walker.position.x, pz(aim) - walker.position.z);
      return { x: -Math.max(-1, Math.min(1, wrap(wanted - walker.viewYaw) * 1.1)), y: 1 };
    };
  };

  const at = Math.min(count - 2, Math.round(count * 0.15));
  const roadX = px(at);
  const roadZ = pz(at);

  const onRoad = seeded(() =>
    createWalker(terrain, listener, roadX, roadZ, town.buildings, canopy, 0, stubHuman(), options)
  );
  onRoad.teleport(roadX, roadZ);
  const roadStick = follower(onRoad);
  report(
    'walking the carriageway',
    measure(onRoad, terrain, floors, WALK_FOR, false, (frame) => {
      nearTrees.follow(onRoad.position.x, onRoad.position.z);
      nearTrees.update(frame * DELTA);
      return roadStick();
    })
  );
  onRoad.dispose();

  // --- and riding it --------------------------------------------------------
  const rider = seeded(() =>
    createWalker(terrain, listener, roadX, roadZ, town.buildings, canopy, 0, stubHuman(), options)
  );
  const bike = vehicles.rideables()[0];
  if (!bike) {
    console.log('  no machine parked here, so nothing to ride');
  } else {
    const heading = Math.atan2(px(at + 1) - roadX, pz(at + 1) - roadZ);
    bike.position.set(roadX, floors.floorAt(roadX, roadZ, Number.POSITIVE_INFINITY), roadZ);
    bike.forward.set(Math.sin(heading), 0, Math.cos(heading));
    rider.teleport(roadX + bike.forward.x * 1.6, roadZ + bike.forward.z * 1.6);
    const lens = new PerspectiveCamera(52, 16 / 9, 2, 40_000) as Lens;
    rider.setJoystick({ x: 0, y: 0 });
    for (let frame = 0; frame < 24; frame += 1) rider.update(DELTA, lens);
    rider.interact();
    for (let frame = 0; frame < 6; frame += 1) rider.update(DELTA, lens);

    if (!rider.riding()) {
      console.log('  could not board the machine parked on this road');
    } else {
      const rideStick = follower(rider);
      report(
        'riding',
        measure(rider, terrain, floors, RIDE_FOR, true, (frame) => {
          nearTrees.follow(rider.position.x, rider.position.z);
          nearTrees.update(frame * DELTA);
          return rideStick();
        })
      );
    }
  }
  rider.dispose();

  nature.dispose();
  town.dispose();
  nearTrees.dispose();
  vehicles.dispose();
};

const sources = await loadSources();
console.log(`nature kit: ${sources.size} models off disk`);
for (const slug of only ? only.split(',') : [...LOCATION_SLUGS]) probe(slug, sources);
