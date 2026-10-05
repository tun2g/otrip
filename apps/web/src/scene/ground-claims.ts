import type { LakeInfo } from './lake';
import type { Obstacle } from './obstacle-index';
import type { Road } from './road-network';
import type { TerraceField } from './terraces';

/**
 * Who already owns a piece of ground. The kind is not decoration: it sets the
 * apron the claim demands, and the probe reports by it.
 */
export type ClaimKind = 'road' | 'trail' | 'railway' | 'building' | 'terrace' | 'water' | 'structure';

/**
 * Metres of clear ground each kind demands beyond its own made surface, before
 * the planter's own girth is added on top. These are aprons, not safety margins:
 * grass is supposed to reach the kerb, so a carriageway asks for little more
 * than its shoulder, while a track asks for the ballast shoulder and the four
 * foot because nothing grows between running rails.
 */
const APRON: Record<ClaimKind, number> = {
  road: 0.5,
  trail: 0.15,
  railway: 2.4,
  building: 1.2,
  terrace: 1,
  water: 0.4,
  structure: 0.8,
};

/** A made surface that runs: a carriageway, a footpath, a railway formation. */
export type Corridor = {
  kind: ClaimKind;
  /** The centreline. `road.points` is exactly this — x, y, z triples. */
  points: ArrayLike<number>;
  /** Floats per vertex: 3 for x, y, z triples, 2 for bare x, z pairs. */
  stride?: number;
  /** Half the made surface, in metres. */
  halfWidth: number;
  /** Overrides the kind's apron. */
  margin?: number;
};

/** A made surface that sits: a building, a terraced hillside, a lake, a pier. */
export type Disc = {
  kind: ClaimKind;
  x: number;
  z: number;
  radius: number;
  /** Overrides the kind's apron. */
  margin?: number;
};

export type GroundClaims = {
  /**
   * How strongly this ground is already spoken for, judged for something whose
   * own footprint has radius `clearance` and whose density thins over `fade`
   * metres beyond that. 1 means the ground is taken — reject outright. Between 0
   * and 1 is the verge, where the caller should thin rather than cut: a hard
   * circle around every claim reads as a crop circle, which is the mistake this
   * whole module exists to avoid making twice.
   */
  pressureAt: (x: number, z: number, clearance: number, fade: number) => number;
  /**
   * Which claim's body this point stands on, or null. For probes and reports —
   * the scene itself only ever wants `pressureAt`.
   */
  kindAt: (x: number, z: number, clearance?: number) => ClaimKind | null;
  /** Claim bodies indexed. Zero means nothing at all claims ground here. */
  count: number;
};

/**
 * Cell side in metres. Road and railway centrelines arrive sampled every seven
 * metres or so, so a segment is always far smaller than a cell; the big discs —
 * a terraced hillside runs to sixty metres — are written into every cell they
 * cover instead of relying on a neighbour sweep, which is what lets the query
 * read one cell per axis step and no more.
 */
const CELL = 32;

/** Keeps the key a small integer with no hashing and no collisions on any map this size. */
const keyOf = (cellX: number, cellZ: number) => (cellZ + 0x8000) * 0x10000 + (cellX + 0x8000);

const KINDS: ClaimKind[] = ['road', 'trail', 'railway', 'building', 'terrace', 'water', 'structure'];

/** Floats per entry in the flattened stores. */
const SEGMENT_STRIDE = 6;
const DISC_STRIDE = 4;

const distanceToSegment = (x: number, z: number, ax: number, az: number, bx: number, bz: number): number => {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  let t = lengthSq > 0 ? ((x - ax) * dx + (z - az) * dz) / lengthSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = x - (ax + dx * t);
  const pz = z - (az + dz * t);
  return Math.sqrt(px * px + pz * pz);
};

/**
 * A shared record of ground that is already spoken for, so the scatterers can
 * ask before they sow. Without it they cannot: they run off nothing but terrain
 * height and gradient, and asphalt is flat, so a road is the most attractive
 * ground on the map to a rejection sampler looking for somewhere gentle.
 *
 * Corridors and discs are the only two primitives, because they are the only two
 * shapes the world actually makes.
 */
export const createGroundClaims = (corridors: Corridor[], discs: Disc[]): GroundClaims => {
  // Flattened rather than held as objects: `pressureAt` runs once per blade of
  // grass per relayout — fifty thousand of them — and per rejection-sampling
  // attempt, of which there are up to forty per tree.
  const segmentStore: number[] = [];
  const segmentKind: number[] = [];
  const discStore: number[] = [];
  const discKind: number[] = [];
  const buckets = new Map<number, number[]>();

  /** Ids are signed so one bucket can hold both stores: >= 0 is a segment, < 0 is ~disc. */
  const insert = (id: number, minX: number, minZ: number, maxX: number, maxZ: number) => {
    const fromX = Math.floor(minX / CELL);
    const toX = Math.floor(maxX / CELL);
    const fromZ = Math.floor(minZ / CELL);
    const toZ = Math.floor(maxZ / CELL);
    for (let cellZ = fromZ; cellZ <= toZ; cellZ += 1) {
      for (let cellX = fromX; cellX <= toX; cellX += 1) {
        const key = keyOf(cellX, cellZ);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(id);
        else buckets.set(key, [id]);
      }
    }
  };

  for (const corridor of corridors) {
    const stride = corridor.stride ?? 3;
    const zOffset = stride === 2 ? 1 : 2;
    const vertices = Math.floor(corridor.points.length / stride);
    if (vertices < 2) continue;

    const kind = KINDS.indexOf(corridor.kind);
    const margin = corridor.margin ?? APRON[corridor.kind];
    const halfWidth = corridor.halfWidth;
    // The body is padded by its own apron at insertion time; the query pads by
    // the planter's reach. Between them every claim that can possibly bear on a
    // point is in a cell the query visits.
    const pad = halfWidth + margin;

    for (let i = 1; i < vertices; i += 1) {
      const ax = corridor.points[(i - 1) * stride];
      const az = corridor.points[(i - 1) * stride + zOffset];
      const bx = corridor.points[i * stride];
      const bz = corridor.points[i * stride + zOffset];
      if (!Number.isFinite(ax) || !Number.isFinite(az) || !Number.isFinite(bx) || !Number.isFinite(bz)) continue;

      const id = segmentStore.length / SEGMENT_STRIDE;
      segmentStore.push(ax, az, bx, bz, halfWidth, margin);
      segmentKind.push(kind);
      insert(id, Math.min(ax, bx) - pad, Math.min(az, bz) - pad, Math.max(ax, bx) + pad, Math.max(az, bz) + pad);
    }
  }

  for (const disc of discs) {
    if (!Number.isFinite(disc.x) || !Number.isFinite(disc.z) || !(disc.radius > 0)) continue;
    const margin = disc.margin ?? APRON[disc.kind];
    const id = ~(discStore.length / DISC_STRIDE);
    discStore.push(disc.x, disc.z, disc.radius, margin);
    discKind.push(KINDS.indexOf(disc.kind));
    const pad = disc.radius + margin;
    insert(id, disc.x - pad, disc.z - pad, disc.x + pad, disc.z + pad);
  }

  const segments = Float64Array.from(segmentStore);
  const segmentKinds = Uint8Array.from(segmentKind);
  const discData = Float64Array.from(discStore);
  const discKinds = Uint8Array.from(discKind);
  // Frozen into typed arrays once building is done: the query walks these on
  // every candidate, and a growable array of boxed numbers is not the shape to
  // walk fifty thousand times a relayout.
  const cells = new Map<number, Int32Array>();
  for (const [key, bucket] of buckets) cells.set(key, Int32Array.from(bucket));
  buckets.clear();

  const count = segmentKinds.length + discKinds.length;

  /**
   * Walks every claim that can bear on this point, newest answer winning only
   * when it is stronger. Returns through the two module-level slots rather than
   * an object so the hot path allocates nothing at all.
   */
  let foundPressure = 0;
  let foundKind = -1;

  const gather = (x: number, z: number, clearance: number, fade: number) => {
    foundPressure = 0;
    foundKind = -1;
    if (count === 0) return;

    const reach = clearance + fade;
    const fromX = Math.floor((x - reach) / CELL);
    const toX = Math.floor((x + reach) / CELL);
    const fromZ = Math.floor((z - reach) / CELL);
    const toZ = Math.floor((z + reach) / CELL);

    for (let cellZ = fromZ; cellZ <= toZ; cellZ += 1) {
      for (let cellX = fromX; cellX <= toX; cellX += 1) {
        const bucket = cells.get(keyOf(cellX, cellZ));
        if (!bucket) continue;

        for (let b = 0; b < bucket.length; b += 1) {
          const id = bucket[b];
          let distance: number;
          let need: number;
          let kind: number;

          if (id >= 0) {
            const at = id * SEGMENT_STRIDE;
            need = segments[at + 4] + segments[at + 5] + clearance;
            // The cheap rejections first: a bucket holds every claim whose
            // padded box touches the cell, and most of them are nowhere near.
            distance = distanceToSegment(x, z, segments[at], segments[at + 1], segments[at + 2], segments[at + 3]);
            kind = segmentKinds[id];
          } else {
            const at = ~id * DISC_STRIDE;
            const dx = x - discData[at];
            const dz = z - discData[at + 1];
            need = discData[at + 2] + discData[at + 3] + clearance;
            distance = Math.sqrt(dx * dx + dz * dz);
            kind = discKinds[~id];
          }

          if (distance <= need) {
            foundPressure = 1;
            foundKind = kind;
            return;
          }
          if (fade <= 0 || distance >= need + fade) continue;

          const pressure = (need + fade - distance) / fade;
          if (pressure > foundPressure) {
            foundPressure = pressure;
            foundKind = kind;
          }
        }
      }
    }
  };

  return {
    count,
    pressureAt: (x, z, clearance, fade) => {
      gather(x, z, clearance, fade);
      return foundPressure;
    },
    kindAt: (x, z, clearance = 0) => {
      gather(x, z, clearance, 0);
      return foundKind < 0 ? null : KINDS[foundKind];
    },
  };
};

/** Nothing claims any ground. For a caller that genuinely has nothing to avoid. */
export const NO_GROUND_CLAIMS: GroundClaims = createGroundClaims([], []);

/**
 * Everything in the world that owns ground, in the shapes the generators already
 * publish. Each field is optional so the renderer can hand over whatever it has
 * built by the time it reaches the vegetation — but handing over nothing means
 * handing over nothing, and the trees go back on the road.
 */
export type WorldGround = {
  roads?: readonly Road[];
  /**
   * The railway formation as a centreline. The embankment discs below only exist
   * where there is fill to publish, so track at grade or in cutting is invisible
   * without this.
   */
  railway?: { points: ArrayLike<number>; stride?: number; halfWidth: number } | null;
  /** Embankments, bridge piers and the platform, as `Railway.obstacles` publishes them. */
  railwayObstacles?: readonly Obstacle[];
  buildings?: readonly { x: number; z: number; radius: number }[];
  terraces?: readonly TerraceField[];
  lakes?: readonly LakeInfo[];
  /** Anything else standing on the ground — the dock's piles, a pier head. */
  structures?: readonly { x: number; z: number; radius: number }[];
};

/**
 * Turns what the generators returned into claims. The margins live here rather
 * than at each call site so there is one place to answer "how close may a tree
 * grow to a lane", and one place to be wrong.
 */
export const collectGroundClaims = (world: WorldGround): GroundClaims => {
  const corridors: Corridor[] = [];
  const discs: Disc[] = [];

  for (const road of world.roads ?? []) {
    if (road.points.length < 6) continue;
    corridors.push({
      // A trail is a worn footpath, not a made surface: grass closes over its
      // edges and should be allowed to, so it claims far less than a lane.
      kind: road.kind === 'trail' ? 'trail' : 'road',
      points: road.points,
      halfWidth: road.width / 2,
    });
  }

  if (world.railway) {
    corridors.push({
      kind: 'railway',
      points: world.railway.points,
      stride: world.railway.stride,
      halfWidth: world.railway.halfWidth,
    });
  }

  for (const obstacle of world.railwayObstacles ?? []) {
    discs.push({ kind: 'railway', x: obstacle.x, z: obstacle.z, radius: obstacle.radius });
  }

  for (const building of world.buildings ?? []) {
    discs.push({ kind: 'building', x: building.x, z: building.z, radius: building.radius });
  }

  for (const field of world.terraces ?? []) {
    discs.push({ kind: 'terrace', x: field.x, z: field.z, radius: field.radius });
  }

  for (const lake of world.lakes ?? []) {
    // The scatterers already keep off open water by height. This is for the
    // shoreline strip a basin carved below the recipe's own water level.
    discs.push({ kind: 'water', x: lake.x, z: lake.z, radius: lake.radius });
  }

  for (const structure of world.structures ?? []) {
    discs.push({ kind: 'structure', x: structure.x, z: structure.z, radius: structure.radius });
  }

  return createGroundClaims(corridors, discs);
};
