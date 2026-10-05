import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  LatheGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector2,
} from 'three';

/**
 * Every primitive a building is made of, as shared unit geometry: one metre
 * cube, one metre diameter, one square metre of roof. Nothing here knows what
 * it will become — the builders scale it.
 *
 * Primitives are centred on the origin. The extruded (`prism`, `wedge`,
 * `halfRound`), lathed and ribbed ones stand on y = 0 instead, because what you
 * position those by is the course they sit on.
 */

/**
 * A closed convex profile in the (z, y) plane, extruded along x from -0.5 to
 * 0.5. Gable fills, ridge caps, fascia mouldings, steps and awnings are all the
 * same operation, and one generator for all of them is what keeps the part
 * count low enough to instance.
 */
const createPrismX = (profile: number[][]): BufferGeometry => {
  let points = profile;
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [z0, y0] = points[i];
    const [z1, y1] = points[(i + 1) % points.length];
    area += z0 * y1 - z1 * y0;
  }
  // The windings below assume a counter-clockwise profile; a clockwise one
  // would turn the whole prism inside out.
  if (area < 0) points = [...points].reverse();

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const count = points.length;

  const push = (x: number, y: number, z: number) => {
    positions.push(x, y, z);
    uvs.push(z + 0.5, y);
    return positions.length / 3 - 1;
  };

  for (let i = 0; i < count; i += 1) {
    const [z0, y0] = points[i];
    const [z1, y1] = points[(i + 1) % count];
    const a = push(-0.5, y0, z0);
    const b = push(-0.5, y1, z1);
    const c = push(0.5, y1, z1);
    const d = push(0.5, y0, z0);
    indices.push(a, d, c, a, c, b);
  }

  const far: number[] = [];
  const near: number[] = [];
  for (const [z, y] of points) {
    far.push(push(0.5, y, z));
    near.push(push(-0.5, y, z));
  }
  for (let i = 1; i < count - 1; i += 1) {
    indices.push(far[0], far[i + 1], far[i]);
    indices.push(near[0], near[i], near[i + 1]);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

/**
 * One square metre of roof surface in unit space: `ribs` rolls across it and
 * `courses` laid up the slope, each course standing proud of the one below so
 * the eye gets the shadow line that says "tiles" rather than "painted plane".
 * +z is up-slope and y is relief, so a caller scales by (width, relief, slope).
 *
 * `taper` narrows the field towards the ridge: 0 is a rectangular slope, 1 a
 * triangle. A hipped roof needs both, because overlapping rectangles would
 * leave the wrong plane on top in each corner.
 */
const createRibbedField = (
  ribs: number,
  courses: number,
  valley: number,
  head: number,
  taper: number
): BufferGeometry => {
  const columns = ribs * 2 + 1;
  const rows = courses * 2;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let row = 0; row < rows; row += 1) {
    const course = Math.floor(row / 2);
    const atButt = row % 2 === 0;
    const z = -0.5 + (course + (atButt ? 0 : 1)) / courses;
    const rowHeight = atButt ? 1 : head;
    const narrow = 1 - taper * (z + 0.5);

    for (let column = 0; column < columns; column += 1) {
      const across = -0.5 + column / (columns - 1);
      positions.push(across * narrow, rowHeight * (column % 2 === 1 ? 1 : valley), z);
      uvs.push(across + 0.5, z + 0.5);
    }
  }

  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const a = row * columns + column;
      const b = a + 1;
      const c = (row + 1) * columns + column + 1;
      const d = (row + 1) * columns + column;
      indices.push(a, d, c, a, c, b);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

const createLathed = (profile: number[][], segments: number): BufferGeometry =>
  new LatheGeometry(
    profile.map(([radius, height]) => new Vector2(radius, height)),
    segments
  );

const createThatchCone = (): BufferGeometry => {
  const geometry = new ConeGeometry(0.5, 1, 14, 3);
  const position = geometry.getAttribute('position');
  // Thatch is bundled grass, never a smooth cone: the lower rings get pulled
  // out and down by a fixed wobble, so every roof shares the same ragged skirt.
  for (let i = 0; i < position.count; i += 1) {
    const y = position.getY(i);
    if (y > -0.2) continue;
    const x = position.getX(i);
    const z = position.getZ(i);
    const wobble = 1 + Math.sin(Math.atan2(z, x) * 7) * 0.07;
    position.setX(i, x * wobble);
    position.setZ(i, z * wobble);
    position.setY(i, y - 0.04);
  }
  geometry.computeVertexNormals();
  return geometry;
};

export type KitGeometry = {
  box: BufferGeometry;
  /** 8-sided cylinder: timber posts, pipes, poles. */
  post: BufferGeometry;
  /** 5-sided: balusters, wires, bamboo — anything thin and numerous. */
  pipe: BufferGeometry;
  drum: BufferGeometry;
  cone: BufferGeometry;
  sphere: BufferGeometry;
  ring: BufferGeometry;
  dish: BufferGeometry;
  /** Isosceles triangle along x: gable fills and ridge caps. */
  prism: BufferGeometry;
  /** Right triangle along x, high at +z: lean-tos, steps, awnings. */
  wedge: BufferGeometry;
  /** Semicircle along x: ridge tiles, bamboo gutters, rolled bedding. */
  halfRound: BufferGeometry;
  pot: BufferGeometry;
  jar: BufferGeometry;
  urn: BufferGeometry;
  bell: BufferGeometry;
  finial: BufferGeometry;
  thatch: BufferGeometry;
  /** Silk lantern body — the Hội An shape, waisted at both ends. */
  lantern: BufferGeometry;
  leaf: BufferGeometry;
};

export type GeometryKit = {
  geo: KitGeometry;
  /** A tiled roof surface for this slope, from a ladder of shared fields. */
  tileField: (width: number, slope: number, taper?: number) => BufferGeometry;
  corrugated: (width: number, taper?: number) => BufferGeometry;
  dispose: () => void;
};

const TILE_RIBS = [8, 14, 20, 28, 38];
const TILE_COURSES = [3, 5, 8, 12];
const SHEET_RIBS = [6, 12, 20, 30];

const nearest = (ladder: number[], target: number): number =>
  ladder.reduce((best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best), ladder[0]);

export const createGeometryKit = (): GeometryKit => {
  const geometries: BufferGeometry[] = [];
  const keep = <T extends BufferGeometry>(geometry: T): T => {
    geometries.push(geometry);
    return geometry;
  };

  const geo: KitGeometry = {
    box: keep(new BoxGeometry(1, 1, 1)),
    post: keep(new CylinderGeometry(0.5, 0.5, 1, 8)),
    pipe: keep(new CylinderGeometry(0.5, 0.5, 1, 5)),
    drum: keep(new CylinderGeometry(0.5, 0.5, 1, 12)),
    cone: keep(new ConeGeometry(0.5, 1, 10)),
    sphere: keep(new SphereGeometry(0.5, 10, 7)),
    ring: keep(new TorusGeometry(0.42, 0.08, 5, 12)),
    dish: keep(new SphereGeometry(0.5, 12, 5, 0, Math.PI * 2, 0, Math.PI * 0.42)),
    prism: keep(
      createPrismX([
        [-0.5, 0],
        [0.5, 0],
        [0, 1],
      ])
    ),
    wedge: keep(
      createPrismX([
        [-0.5, 0],
        [0.5, 0],
        [0.5, 1],
      ])
    ),
    halfRound: keep(
      createPrismX(
        Array.from({ length: 9 }, (_, index) => {
          const angle = (index / 8) * Math.PI;
          return [Math.cos(angle) * 0.5, Math.sin(angle) * 0.5];
        })
      )
    ),
    pot: keep(new CylinderGeometry(0.5, 0.34, 1, 10)),
    jar: keep(
      createLathed(
        [
          [0, 0],
          [0.2, 0],
          [0.34, 0.12],
          [0.5, 0.42],
          [0.4, 0.78],
          [0.24, 0.9],
          [0.28, 1],
          [0, 1],
        ],
        10
      )
    ),
    urn: keep(
      createLathed(
        [
          [0, 0],
          [0.3, 0],
          [0.26, 0.14],
          [0.44, 0.3],
          [0.5, 0.62],
          [0.46, 0.86],
          [0.5, 0.94],
          [0.44, 1],
          [0, 1],
        ],
        12
      )
    ),
    bell: keep(
      createLathed(
        [
          [0, 0],
          [0.5, 0.04],
          [0.44, 0.3],
          [0.3, 0.72],
          [0.3, 0.88],
          [0.12, 0.94],
          [0.1, 1],
          [0, 1],
        ],
        10
      )
    ),
    finial: keep(
      createLathed(
        [
          [0, 0],
          [0.3, 0.06],
          [0.18, 0.22],
          [0.32, 0.44],
          [0.14, 0.64],
          [0.2, 0.8],
          [0, 1],
        ],
        8
      )
    ),
    thatch: keep(createThatchCone()),
    lantern: keep(
      createLathed(
        [
          [0, 0],
          [0.16, 0.04],
          [0.4, 0.22],
          [0.5, 0.5],
          [0.4, 0.78],
          [0.16, 0.96],
          [0, 1],
        ],
        10
      )
    ),
    leaf: keep(new SphereGeometry(0.5, 6, 4)),
  };

  const fields = new Map<string, BufferGeometry>();
  const field = (ribs: number, courses: number, valley: number, head: number, taper: number): BufferGeometry => {
    const stepped = Math.round(Math.min(1, Math.max(0, taper)) * 4) / 4;
    const key = `${ribs}:${courses}:${stepped}`;
    const existing = fields.get(key);
    if (existing) return existing;
    const created = keep(createRibbedField(ribs, courses, valley, head, stepped));
    fields.set(key, created);
    return created;
  };

  return {
    geo,
    // A pan tile is about 0.22m across and a course covers about 0.95m of
    // slope; the ladder keeps every roof in the town on a handful of fields.
    tileField: (width, slope, taper = 0) =>
      field(nearest(TILE_RIBS, width / 0.22), nearest(TILE_COURSES, slope / 0.95), 0.4, 0.5, taper),
    corrugated: (width, taper = 0) => field(nearest(SHEET_RIBS, width / 0.18), 1, 0.25, 1, taper),
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      geometries.length = 0;
      fields.clear();
    },
  };
};
