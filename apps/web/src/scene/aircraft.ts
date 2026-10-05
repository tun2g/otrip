import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type BufferGeometry as Geometry,
  type Material,
} from 'three';

import type { WorldWeather } from './weather-state';

/** Meteorological degrees to radians. */
const DEG = Math.PI / 180;

/** Low sun on ice and aluminium. */
const DAWN_GOLD = new Color('#ffc48a');

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Heading is a bearing from +Z, matching every other module in the scene. */
const forwardX = (heading: number) => Math.sin(heading);
const forwardZ = (heading: number) => Math.cos(heading);
const rightX = (heading: number) => Math.cos(heading);
const rightZ = (heading: number) => -Math.sin(heading);

// --- the airliner, to 777 dimensions ---------------------------------------
const FUSELAGE_LENGTH = 63.7;
const FUSELAGE_RADIUS = 3.1;
const WINGSPAN = 60.9;
const WING_ROOT_CHORD = 14.2;
const WING_SWEEP = 31.6 * DEG;
const WING_DIHEDRAL = 6 * DEG;
/** Engine centreline out from the fuselage axis; the contrails start here. */
const ENGINE_OFFSET = 10.8;
const ENGINE_LENGTH = 7.4;
const ENGINE_RADIUS = 1.65;
const FIN_HEIGHT = 11.2;
const TAILPLANE_SPAN = 21.5;

/** True airspeed at cruise, m/s — 865 km/h. */
const CRUISE_SPEED = 240;
/** Cruise band in metres. Contrails do not form much below this. */
const CRUISE_LOW = 9600;
const CRUISE_HIGH = 11_300;
/** Half the straight track, so the aircraft enters and leaves well off the map. */
const TRACK_HALF = 15_500;

// --- contrail ---------------------------------------------------------------
/** Seconds a trail segment lives. Beyond two minutes it is a cirrus streak the
 * cloud decks already draw. */
const TRAIL_LIFE = 112;
const TRAIL_NODES = 200;
/**
 * Half-width of a fresh trail and of one about to die. The spread is raised to
 * a power so it is slow at first: that early slowness is the only reason the
 * pair reads as two trails at all, because two cores eleven metres apart at ten
 * kilometres is a tenth of a degree. They merge into one band a few kilometres
 * behind the aircraft, which is exactly what the real thing does.
 */
const TRAIL_START_HALF = 4.5;
const TRAIL_END_HALF = 330;
/** Contrails sink, and the shear between their ends is what kinks an old one. */
const TRAIL_SINK = 1.1;
/** Wind at the tropopause runs several times the surface value. */
const TRAIL_SHEAR = 3.2;

/**
 * Mean seconds between passes. These are deliberately long: a pass lasts a
 * little over two minutes and the contrail outlives it by another two, so a gap
 * of two minutes would put something in the sky more often than not, and a
 * thing that is always there is not a thing you look up at.
 */
const AIRLINER_GAP = 700;
const PARAGLIDER_GAP = 780;
const BALLOON_GAP = 560;

// --- paraglider, to a mid-B glider ------------------------------------------
const PARA_SPAN = 11.4;
const PARA_CHORD = 2.65;
/** Half-angle of the canopy arc, which is what gives a paraglider its shape. */
const PARA_ARC = 0.62;
/** Riser length from the canopy to the harness. */
const PARA_LINES = 7.2;
const PARA_SPEED = 10.2;

// --- hot-air balloon --------------------------------------------------------
const BALLOON_RADIUS = 9.2;
const BALLOON_HEIGHT = 20.5;
const BALLOON_GORES = 14;
const BASKET_WIDTH = 1.35;

type LoftPoint = (u: number, v: number, out: Vector3) => void;

const LOFT_SCRATCH = new Vector3();

const loftInto = (geometry: BufferGeometry, columns: number, rows: number, wrap: boolean, point: LoftPoint): void => {
  const attribute = geometry.getAttribute('position');
  const array = attribute.array as Float32Array;
  let i = 0;
  for (let r = 0; r < rows; r += 1) {
    const v = rows > 1 ? r / (rows - 1) : 0;
    for (let c = 0; c < columns; c += 1) {
      point(wrap ? c / columns : columns > 1 ? c / (columns - 1) : 0, v, LOFT_SCRATCH);
      array[i] = LOFT_SCRATCH.x;
      array[i + 1] = LOFT_SCRATCH.y;
      array[i + 2] = LOFT_SCRATCH.z;
      i += 3;
    }
  }
  attribute.needsUpdate = true;
  geometry.computeVertexNormals();
};

/**
 * An indexed grid surface. Every curved panel in this file — fuselage, wing,
 * fin, canopy — is one of these, which is also what lets the paraglider's
 * canopy be re-evaluated each frame instead of being swapped for another mesh.
 */
const loft = (columns: number, rows: number, point: LoftPoint, wrap = false): BufferGeometry => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(columns * rows * 3), 3));

  const indices: number[] = [];
  const span = wrap ? columns : columns - 1;
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < span; c += 1) {
      const next = (c + 1) % columns;
      const a = r * columns + c;
      const b = r * columns + next;
      const d = (r + 1) * columns + c;
      const e = (r + 1) * columns + next;
      indices.push(a, d, e, a, e, b);
    }
  }
  geometry.setIndex(indices);
  loftInto(geometry, columns, rows, wrap, point);
  return geometry;
};

/** Nose ogive, constant barrel, upswept tail cone. t = 0 at the nose. */
const fuselageRadiusAt = (t: number): number => {
  if (t < 0.15) return FUSELAGE_RADIUS * Math.sqrt(Math.max(0, 1 - ((0.15 - t) / 0.15) ** 2));
  if (t > 0.78) return FUSELAGE_RADIUS * (1 - ((t - 0.78) / 0.22) ** 2 * 0.88);
  return FUSELAGE_RADIUS;
};

const fuselageRiseAt = (t: number): number => (t > 0.7 ? ((t - 0.7) / 0.3) ** 2 * FUSELAGE_RADIUS * 1.2 : 0);

/** Thickness distribution of a transport aerofoil, as a fraction of chord. */
const aerofoilAt = (x: number): number => Math.sin(Math.PI * Math.min(1, x) ** 0.78) * 0.52;

const createWingGeometry = (tip: number, root: number, sweep: number, dihedral: number, rake: number) => {
  const half = tip;
  return loft(
    10,
    9,
    (u, v, out) => {
      // v runs out the span, u around the section: 0 and 1 are the trailing
      // edge, 0.5 the leading edge. Forward is +Z, so sweeping a wing back
      // moves its leading edge towards -Z as you go outboard.
      const chord = root * (1 - v * 0.8);
      const leading = -v * half * Math.tan(sweep);
      const rise = v * half * Math.tan(dihedral) + v ** 5 * rake;
      const along = u < 0.5 ? u * 2 : (1 - u) * 2;
      const thickness = aerofoilAt(along) * chord * 0.115 * (u < 0.5 ? 1 : -0.62);
      out.set(v * half, rise + thickness, leading + (1 - along) * chord * -1 + chord * 0.5);
    },
    true
  );
};

const createFinGeometry = () =>
  loft(
    8,
    7,
    (u, v, out) => {
      const chord = 9.6 * (1 - v * 0.62);
      const along = u < 0.5 ? u * 2 : (1 - u) * 2;
      const thickness = aerofoilAt(along) * chord * 0.1 * (u < 0.5 ? 1 : -1);
      out.set(thickness, v * FIN_HEIGHT, -v * FIN_HEIGHT * 0.72 + (1 - along) * -chord + chord * 0.5);
    },
    true
  );

/**
 * The envelope, as gores. Alternate gores get the second material through index
 * groups, which is what makes it a balloon rather than a coloured egg.
 */
const createEnvelopeGeometry = (): BufferGeometry => {
  const rows = 20;
  const columns = BALLOON_GORES * 3;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(columns * rows * 3), 3));

  const even: number[] = [];
  const odd: number[] = [];
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const next = (c + 1) % columns;
      const a = r * columns + c;
      const b = r * columns + next;
      const d = (r + 1) * columns + c;
      const e = (r + 1) * columns + next;
      const target = Math.floor(c / 3) % 2 === 0 ? even : odd;
      target.push(a, d, e, a, e, b);
    }
  }
  geometry.setIndex(even.concat(odd));
  geometry.addGroup(0, even.length, 0);
  geometry.addGroup(even.length, odd.length, 1);

  loftInto(geometry, columns, rows, true, (u, v, out) => {
    const angle = u * Math.PI * 2;
    // Teardrop: fat and round at the crown, drawn in to the mouth. The slight
    // scallop between gores is the panel seam pulling on the inflated fabric.
    const profile = Math.sin(Math.PI * (0.12 + v * 0.8)) ** 0.72;
    const mouth = v > 0.82 ? 1 - ((v - 0.82) / 0.18) ** 1.5 * 0.72 : 1;
    const scallop = 1 - 0.035 * Math.abs(Math.cos(u * Math.PI * BALLOON_GORES));
    const radius = BALLOON_RADIUS * profile * mouth * scallop;
    out.set(Math.cos(angle) * radius, BALLOON_HEIGHT * (1 - v), Math.sin(angle) * radius);
  });

  return geometry;
};

const TRAIL_VERTEX = /* glsl */ `
  attribute float aAge;
  attribute float aEdge;

  varying float vAge;
  varying float vEdge;

  void main() {
    vAge = aAge;
    vEdge = aEdge;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }
`;

const TRAIL_FRAGMENT = /* glsl */ `
  uniform vec3 uColour;
  uniform float uOpacity;

  varying float vAge;
  varying float vEdge;

  void main() {
    if (vAge > 1.0) discard;
    // Soft across the width and brightest down the middle: an ice cloud has no
    // edge, and a hard one is the thing that gives a ribbon away as a ribbon.
    float across = pow(max(0.0, 1.0 - abs(vEdge)), 0.85);
    // Dense and sharp where it leaves the engine, thin and diffuse as it ages.
    float density = mix(1.0, 0.22, vAge);
    float birth = smoothstep(0.0, 0.015, vAge);
    float death = 1.0 - smoothstep(0.72, 1.0, vAge);
    float alpha = across * density * birth * death * uOpacity;
    gl_FragColor = vec4(uColour, alpha);
  }
`;

type Trail = {
  mesh: Mesh;
  geometry: BufferGeometry;
  /** Ring buffer of emitted nodes: centre, right vector and birth time. */
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  rightX: Float64Array;
  rightZ: Float64Array;
  birth: Float64Array;
  head: number;
  live: number;
};

const createTrail = (material: Material, nodes: number): Trail => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(nodes * 2 * 3), 3));
  geometry.setAttribute('aAge', new BufferAttribute(new Float32Array(nodes * 2), 1));

  const edges = new Float32Array(nodes * 2);
  for (let i = 0; i < nodes; i += 1) {
    edges[i * 2] = -1;
    edges[i * 2 + 1] = 1;
  }
  geometry.setAttribute('aEdge', new BufferAttribute(edges, 1));

  const indices: number[] = [];
  for (let i = 0; i < nodes - 1; i += 1) {
    const a = i * 2;
    indices.push(a, a + 2, a + 3, a, a + 3, a + 1);
  }
  geometry.setIndex(indices);
  geometry.setDrawRange(0, 0);
  // The strip is rewritten every frame over tens of kilometres, so a bounding
  // sphere computed once is always wrong.
  geometry.boundingSphere = null;

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;

  return {
    mesh,
    geometry,
    x: new Float64Array(nodes),
    y: new Float64Array(nodes),
    z: new Float64Array(nodes),
    rightX: new Float64Array(nodes),
    rightZ: new Float64Array(nodes),
    birth: new Float64Array(nodes),
    head: 0,
    live: 0,
  };
};

const emitTrailNode = (
  trail: Trail,
  now: number,
  x: number,
  y: number,
  z: number,
  acrossX: number,
  acrossZ: number
): void => {
  const nodes = trail.birth.length;
  const slot = trail.head;
  trail.x[slot] = x;
  trail.y[slot] = y;
  trail.z[slot] = z;
  trail.rightX[slot] = acrossX;
  trail.rightZ[slot] = acrossZ;
  trail.birth[slot] = now;
  trail.head = (slot + 1) % nodes;
  if (trail.live < nodes) trail.live += 1;
};

/**
 * Rewrites the strip from the live nodes, oldest first, so the index buffer can
 * stay static and the draw range can simply cover the live span. Compacting
 * like this rather than drawing the ring in place is what avoids a quad thrown
 * across the whole sky at the seam between the newest node and the oldest.
 */
const rebuildTrail = (trail: Trail, now: number, windX: number, windZ: number): void => {
  const nodes = trail.birth.length;

  while (trail.live > 0) {
    const oldest = (trail.head - trail.live + nodes) % nodes;
    if (now - trail.birth[oldest] <= TRAIL_LIFE) break;
    trail.live -= 1;
  }

  const positions = trail.geometry.getAttribute('position');
  const ages = trail.geometry.getAttribute('aAge');
  const positionArray = positions.array as Float32Array;
  const ageArray = ages.array as Float32Array;

  for (let k = 0; k < trail.live; k += 1) {
    const slot = (trail.head - trail.live + k + nodes) % nodes;
    const seconds = now - trail.birth[slot];
    const age = clamp01(seconds / TRAIL_LIFE);
    const half = TRAIL_START_HALF + (TRAIL_END_HALF - TRAIL_START_HALF) * age ** 1.45;
    const x = trail.x[slot] + windX * seconds;
    const y = trail.y[slot] - TRAIL_SINK * seconds;
    const z = trail.z[slot] + windZ * seconds;

    const base = k * 6;
    positionArray[base] = x - trail.rightX[slot] * half;
    positionArray[base + 1] = y;
    positionArray[base + 2] = z - trail.rightZ[slot] * half;
    positionArray[base + 3] = x + trail.rightX[slot] * half;
    positionArray[base + 4] = y;
    positionArray[base + 5] = z + trail.rightZ[slot] * half;
    ageArray[k * 2] = age;
    ageArray[k * 2 + 1] = age;
  }

  positions.needsUpdate = true;
  ages.needsUpdate = true;
  trail.geometry.setDrawRange(0, Math.max(0, trail.live - 1) * 6);
};

/**
 * Whether the air at cruise would hold a contrail. Ground instruments are the
 * only thing this scene has, so the test is a proxy: persistent contrails need
 * ice-supersaturated air, which shows up from below as humid air under a cirrus
 * deck. Dry air leaves the engines with nothing to condense and the aircraft
 * crosses on its own.
 */
const contrailStrength = (weather: WorldWeather): number => {
  const moisture = clamp01((weather.humidity - 48) / 34);
  const cirrus = clamp01(weather.cloudHigh * 1.3);
  return clamp01(moisture * 0.65 + cirrus * 0.55 - 0.08);
};

/** How much of the sky is actually worth looking at. */
const skyClarity = (weather: WorldWeather): number =>
  clamp01(1 - weather.skyOcclusion * 1.15) * clamp01((weather.visibility - 2500) / 11_000);

/**
 * Twilight, from the one signal the scene publishes. Peaks when the sun is on
 * the horizon, which is the window where an aircraft at eleven kilometres is in
 * full sunlight and the ground under it is not.
 */
const twilightFrom = (night: number): number => clamp01(1 - Math.abs(night - 0.5) * 3.1);

type Schedule = { nextStart: number; active: boolean; startedAt: number; duration: number };

const createSchedule = (firstStart: number): Schedule => ({
  nextStart: firstStart,
  active: false,
  startedAt: 0,
  duration: 1,
});

type Highest = { x: number; z: number; height: number };

/** The top of the ridge, for anything that has to be flown over it. */
const findHighPoint = (terrain: Terrain): Highest => {
  const side = terrain.segments + 1;
  const half = terrain.size / 2;
  const step = terrain.size / terrain.segments;
  const margin = Math.floor(side * 0.2);
  let best: Highest = { x: 0, z: 0, height: terrain.heightAt(0, 0) };
  for (let row = margin; row < side - margin; row += 3) {
    for (let col = margin; col < side - margin; col += 3) {
      const height = terrain.heights[row * side + col];
      if (height <= best.height) continue;
      best = { x: -half + col * step, z: -half + row * step, height };
    }
  }
  return best;
};

export type Aircraft = {
  group: Group;
  update: (elapsed: number) => void;
  setNight: (amount: number) => void;
  setWeather: (weather: WorldWeather) => void;
  dispose: () => void;
};

export type AircraftOptions = {
  /** Contrail segments kept alive. 0 drops the contrail entirely. */
  trailNodes?: number;
  /** Multiplies the gap between passes. Above 1 the sky is quieter. */
  rarity?: number;
};

/**
 * What is in the sky above the valley, as opposed to in it. Three things, none
 * of them often: an airliner at cruise trailing a pair of contrails that spread
 * and sink behind it, and then whichever of a ridge paraglider or a sunrise
 * balloon `recipe.aloft` says belongs here. Only the airliner is everywhere,
 * because only the airliner really is.
 *
 * All three are scheduled minutes apart on purpose. The sky should reward
 * someone who looks up, not be busy — and an aircraft that is always there
 * stops being an aircraft and becomes scenery.
 */
export const createAircraft = (terrain: Terrain, recipe: LocationRecipe, options: AircraftOptions = {}): Aircraft => {
  const random = createPrng(`${recipe.seed}:aircraft`);
  const group = new Group();
  group.name = 'aircraft';

  const geometries: Geometry[] = [];
  const materials: Material[] = [];
  const keep = <T extends Geometry>(geometry: T): T => {
    geometries.push(geometry);
    return geometry;
  };
  const standard = (settings: Record<string, unknown>): MeshStandardMaterial => {
    const material = new MeshStandardMaterial({ flatShading: true, metalness: 0, fog: false, ...settings });
    materials.push(material);
    return material;
  };
  const basic = (settings: Record<string, unknown>): MeshBasicMaterial => {
    const material = new MeshBasicMaterial({ fog: false, ...settings });
    materials.push(material);
    return material;
  };

  // Nothing in this module is lit by the scene's sun the way the ground is: an
  // aircraft at eleven kilometres is in sunlight for half an hour after the
  // valley has gone dark. Emissive carries that, and `setNight` drives it, so
  // the brightness still follows the light rather than being a fixed albedo.
  const hull = standard({ color: '#e9edf1', roughness: 0.44, metalness: 0.2, emissive: '#ffffff' });
  const belly = standard({ color: '#aab4bd', roughness: 0.6, emissive: '#ffffff' });
  const livery = standard({ color: '#0b4ea2', roughness: 0.5, emissive: '#6f9ed8' });
  const liveryGold = standard({ color: '#d8b24a', roughness: 0.45, metalness: 0.3, emissive: '#d8b24a' });
  const cowl = standard({ color: '#d3d9df', roughness: 0.4, metalness: 0.25, emissive: '#ffffff' });
  const intake = standard({ color: '#23272b', roughness: 0.7, emissive: '#5c646c' });
  const cheatline = standard({ color: '#2b333c', roughness: 0.65, emissive: '#7b8691' });

  const litMaterials = [hull, belly, livery, liveryGold, cowl, intake, cheatline];

  // Every light on the aircraft is an additive glow rather than a lit bulb. A
  // 1 m bulb at eleven kilometres is a hundredth of a degree and renders as
  // nothing; what you actually see from the ground is the halo.
  const navRed = basic({
    color: '#ff2b1e',
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const navGreen = basic({
    color: '#2bff5a',
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const navWhite = basic({
    color: '#ffffff',
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const beaconRed = basic({
    color: '#ff2b1e',
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const strobeWhite = basic({
    color: '#ffffff',
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
  });

  const trailColour = new Color('#ffffff');
  const trailMaterial = new ShaderMaterial({
    uniforms: { uColour: { value: trailColour }, uOpacity: { value: 0 } },
    vertexShader: TRAIL_VERTEX,
    fragmentShader: TRAIL_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    fog: false,
  });
  materials.push(trailMaterial);

  // --- the airliner --------------------------------------------------------
  const airliner = new Group();
  airliner.name = 'airliner';
  airliner.visible = false;
  group.add(airliner);

  const addTo = (parent: Object3D, geometry: Geometry, material: Material, configure?: (mesh: Mesh) => void): Mesh => {
    const mesh = new Mesh(geometry, material);
    configure?.(mesh);
    parent.add(mesh);
    return mesh;
  };

  const fuselageGeometry = keep(
    loft(
      14,
      26,
      (u, v, out) => {
        const angle = u * Math.PI * 2;
        const radius = fuselageRadiusAt(v);
        out.set(Math.cos(angle) * radius, Math.sin(angle) * radius + fuselageRiseAt(v), (0.5 - v) * FUSELAGE_LENGTH);
      },
      true
    )
  );
  addTo(airliner, fuselageGeometry, hull);

  // The window band. Nothing else on a white fuselage tells you how big it is.
  const cheatlineGeometry = keep(
    loft(4, 24, (u, v, out) => {
      const angle = (0.1 + u * 0.1) * Math.PI;
      const radius = fuselageRadiusAt(0.07 + v * 0.78) * 1.01;
      out.set(
        Math.cos(angle) * radius,
        Math.sin(angle) * radius + fuselageRiseAt(0.07 + v * 0.78),
        (0.43 - v * 0.78) * FUSELAGE_LENGTH
      );
    })
  );
  addTo(airliner, cheatlineGeometry, cheatline);
  addTo(airliner, cheatlineGeometry, cheatline, (mesh) => (mesh.scale.x = -1));

  const wingGeometry = keep(
    createWingGeometry(WINGSPAN / 2, WING_ROOT_CHORD, WING_SWEEP, WING_DIHEDRAL, FUSELAGE_RADIUS * 1.5)
  );
  for (const side of [1, -1]) {
    addTo(airliner, wingGeometry, hull, (mesh) => {
      mesh.scale.x = side;
      mesh.position.set(0, -FUSELAGE_RADIUS * 0.35, -FUSELAGE_LENGTH * 0.04);
    });
  }

  const tailplaneGeometry = keep(createWingGeometry(TAILPLANE_SPAN / 2, 6.4, 34 * DEG, 5 * DEG, 0));
  for (const side of [1, -1]) {
    addTo(airliner, tailplaneGeometry, hull, (mesh) => {
      mesh.scale.x = side;
      mesh.position.set(0, FUSELAGE_RADIUS * 0.55, -FUSELAGE_LENGTH * 0.4);
    });
  }

  const finGeometry = keep(createFinGeometry());
  addTo(airliner, finGeometry, livery, (mesh) => mesh.position.set(0, FUSELAGE_RADIUS * 0.55, -FUSELAGE_LENGTH * 0.38));

  const finBandGeometry = keep(new CylinderGeometry(0.1, 0.1, 6.2, 4));
  finBandGeometry.rotateZ(Math.PI / 2);
  addTo(airliner, finBandGeometry, liveryGold, (mesh) =>
    mesh.position.set(0, FUSELAGE_RADIUS * 0.55 + FIN_HEIGHT * 0.62, -FUSELAGE_LENGTH * 0.46)
  );

  const nacelleGeometry = keep(
    loft(
      12,
      8,
      (u, v, out) => {
        const angle = u * Math.PI * 2;
        // Fat at the intake, drawn in to the exhaust: a plain tube reads as a
        // pencil taped under the wing.
        const radius = ENGINE_RADIUS * (1 - 0.3 * v ** 2) * (v < 0.1 ? 0.88 + v * 1.2 : 1);
        out.set(Math.cos(angle) * radius, Math.sin(angle) * radius, (0.5 - v) * ENGINE_LENGTH);
      },
      true
    )
  );
  const intakeGeometry = keep(new TorusGeometry(ENGINE_RADIUS * 0.94, 0.2, 5, 14));
  const fanGeometry = keep(new CylinderGeometry(ENGINE_RADIUS * 0.82, ENGINE_RADIUS * 0.82, 0.12, 14));
  fanGeometry.rotateX(Math.PI / 2);
  const pylonGeometry = keep(new CylinderGeometry(0.42, 0.55, 3.1, 5));

  const enginePositions: Vector3[] = [];
  for (const side of [1, -1]) {
    const x = side * ENGINE_OFFSET;
    const rise = ENGINE_OFFSET * Math.tan(WING_DIHEDRAL);
    const y = -FUSELAGE_RADIUS * 0.35 + rise - 2.6;
    // Nacelles hang forward of the leading edge, which at this station is at
    // -ENGINE_OFFSET * tan(sweep) plus half the local chord.
    const z = -ENGINE_OFFSET * Math.tan(WING_SWEEP) + 5.6;
    enginePositions.push(new Vector3(x, y, z));
    addTo(airliner, nacelleGeometry, cowl, (mesh) => mesh.position.set(x, y, z));
    addTo(airliner, intakeGeometry, intake, (mesh) => mesh.position.set(x, y, z + ENGINE_LENGTH * 0.49));
    addTo(airliner, fanGeometry, intake, (mesh) => mesh.position.set(x, y, z + ENGINE_LENGTH * 0.4));
    addTo(airliner, pylonGeometry, hull, (mesh) => {
      mesh.position.set(x, y + 1.9, z - 1.1);
      mesh.rotation.x = 0.2;
    });
  }

  const bellyGeometry = keep(
    loft(8, 16, (u, v, out) => {
      const angle = Math.PI * (1.12 + u * 0.76);
      const radius = fuselageRadiusAt(0.14 + v * 0.66) * 1.008;
      out.set(Math.cos(angle) * radius, Math.sin(angle) * radius, (0.36 - v * 0.66) * FUSELAGE_LENGTH);
    })
  );
  addTo(airliner, bellyGeometry, belly);

  // Navigation lights, beacons and strobes. A slow blink crossing the stars is
  // the whole reason to put an aircraft up there at night.
  const glowGeometry = keep(new SphereGeometry(16, 8, 6));
  const wingTipY = (WINGSPAN / 2) * Math.tan(WING_DIHEDRAL) + FUSELAGE_RADIUS * 1.5 - FUSELAGE_RADIUS * 0.35;
  const wingTipZ = (WINGSPAN / 2) * Math.tan(WING_SWEEP) * -1 - FUSELAGE_LENGTH * 0.04;
  const navPort = new Vector3(-WINGSPAN / 2, wingTipY, wingTipZ);
  const navStarboard = new Vector3(WINGSPAN / 2, wingTipY, wingTipZ);

  addTo(airliner, glowGeometry, navRed, (mesh) => {
    mesh.position.copy(navPort);
    mesh.scale.setScalar(0.42);
  });
  addTo(airliner, glowGeometry, navGreen, (mesh) => {
    mesh.position.copy(navStarboard);
    mesh.scale.setScalar(0.42);
  });
  addTo(airliner, glowGeometry, navWhite, (mesh) => {
    mesh.position.set(0, FUSELAGE_RADIUS * 0.55 + FIN_HEIGHT * 0.1, -FUSELAGE_LENGTH * 0.52);
    mesh.scale.setScalar(0.34);
  });

  const strobes: Mesh[] = [];
  for (const tip of [navPort, navStarboard]) {
    strobes.push(addTo(airliner, glowGeometry, strobeWhite, (mesh) => mesh.position.copy(tip)));
  }
  const beacons: Mesh[] = [];
  for (const side of [1, -1]) {
    beacons.push(
      addTo(airliner, glowGeometry, beaconRed, (mesh) => {
        mesh.position.set(0, side * FUSELAGE_RADIUS * 1.1, FUSELAGE_LENGTH * 0.06);
        mesh.scale.setScalar(0.62);
      })
    );
  }

  const trailNodes = Math.max(0, Math.round(options.trailNodes ?? TRAIL_NODES));
  const trails = trailNodes >= 8 ? enginePositions.map(() => createTrail(trailMaterial, trailNodes)) : [];
  for (const trail of trails) group.add(trail.mesh);
  const trailEmitInterval = trailNodes >= 8 ? TRAIL_LIFE / (trailNodes - 4) : Infinity;

  // --- the paraglider ------------------------------------------------------
  // `recipe.aloft`, not `recipe.slug`: a slug test is a fact about this codebase
  // and not about the place, and it cannot answer for a fifth location.
  const ridge = recipe.aloft === 'paraglider' ? findHighPoint(terrain) : null;

  const sail = standard({ color: '#e24a2f', roughness: 0.78, side: DoubleSide, emissive: '#ff8a5c' });
  const sailStripe = standard({ color: '#f4e7c9', roughness: 0.78, side: DoubleSide, emissive: '#fff3d8' });
  const lineMaterial = standard({ color: '#2f3238', roughness: 0.9, emissive: '#6a6f78' });
  const harness = standard({ color: '#2d3a4d', roughness: 0.85, emissive: '#6d7b90' });
  const suit = standard({ color: '#1f6f8c', roughness: 0.85, emissive: '#5fa3bb' });
  const skin = standard({ color: '#b08a66', roughness: 0.82, emissive: '#c9a988' });
  litMaterials.push(sail, sailStripe, lineMaterial, harness, suit, skin);

  const paraglider = new Group();
  paraglider.name = 'paraglider';
  paraglider.visible = false;
  // Yaw, then pitch, then roll — the default XYZ order banks about the world
  // axis and the wing ends up leaning sideways out of its own turn.
  paraglider.rotation.order = 'YXZ';
  if (ridge) group.add(paraglider);

  const CANOPY_COLUMNS = 15;
  const CANOPY_ROWS = 6;
  const canopyRadius = PARA_SPAN / 2 / Math.sin(PARA_ARC);

  /** Arc, taper and camber of the canopy, plus whatever the air is doing to it. */
  const canopyPoint = (u: number, v: number, out: Vector3, breathe: number, ripple: number): void => {
    const s = u * 2 - 1;
    const taper = Math.abs(s) ** 1.7;
    const chord = PARA_CHORD * (1 - taper * 0.44);
    const angle = s * PARA_ARC * (1 + breathe * 0.05);
    const flutter = Math.sin(s * 5.1 + ripple) * 0.055 * (0.2 + taper);
    const camber = Math.sin(v * Math.PI) * chord * 0.14 * (1 + breathe * 0.12);
    out.set(
      Math.sin(angle) * canopyRadius,
      -(canopyRadius - Math.cos(angle) * canopyRadius) + camber + flutter,
      (v - 0.36) * chord - taper * PARA_CHORD * 0.3
    );
  };

  const canopyGeometry = keep(loft(CANOPY_COLUMNS, CANOPY_ROWS, (u, v, out) => canopyPoint(u, v, out, 0, 0)));
  const canopy = addTo(paraglider, canopyGeometry, sail);

  // Two cells in the second colour, so the canopy has a pattern rather than
  // being a single red sheet. They sit on the same surface, so they have to be
  // re-evaluated with it or they tear through as it flexes.
  const CELL_COLUMNS = 3;
  const cellU = (u: number) => 0.5 + (u - 0.5) * (2 / (CANOPY_COLUMNS - 1));
  const cellGeometry = keep(loft(CELL_COLUMNS, CANOPY_ROWS, (u, v, out) => canopyPoint(cellU(u), v, out, 0, 0)));
  addTo(paraglider, cellGeometry, sailStripe, (mesh) => (mesh.position.y = 0.02));

  const riser = new Object3D();
  riser.position.y = -PARA_LINES;
  paraglider.add(riser);

  const lineGeometry = keep(new CylinderGeometry(0.012, 0.012, 1, 3));
  lineGeometry.translate(0, 0.5, 0);
  const anchor = new Vector3();
  for (let i = 0; i < 10; i += 1) {
    const u = 0.08 + (i / 9) * 0.84;
    canopyPoint(u, i % 2 === 0 ? 0.22 : 0.78, anchor, 0, 0);
    const length = Math.hypot(anchor.x, anchor.y + PARA_LINES, anchor.z);
    const line = addTo(paraglider, lineGeometry, lineMaterial, (mesh) => {
      mesh.position.set(0, -PARA_LINES, 0);
      mesh.scale.y = length;
    });
    line.lookAt(anchor);
    line.rotateX(Math.PI / 2);
  }

  const harnessGeometry = keep(new CylinderGeometry(0.34, 0.26, 0.7, 7));
  const torsoGeometry = keep(new CylinderGeometry(0.2, 0.3, 0.72, 7));
  const headGeometry = keep(new SphereGeometry(0.14, 8, 6));
  const helmetGeometry = keep(new SphereGeometry(0.17, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.62));
  const legGeometry = keep(new CylinderGeometry(0.09, 0.07, 0.86, 5));
  const armGeometry = keep(new CylinderGeometry(0.06, 0.055, 0.56, 5));

  addTo(riser, harnessGeometry, harness, (mesh) => mesh.position.set(0, -0.3, -0.1));
  // Reclined, the way a pilot actually sits in a pod harness: upright is the
  // single most obvious thing to get wrong about a paraglider.
  const pilot = new Object3D();
  pilot.rotation.x = -0.95;
  riser.add(pilot);
  addTo(pilot, torsoGeometry, suit, (mesh) => mesh.position.set(0, 0.1, 0));
  addTo(pilot, headGeometry, skin, (mesh) => mesh.position.set(0, 0.55, 0.04));
  addTo(pilot, helmetGeometry, harness, (mesh) => mesh.position.set(0, 0.58, 0.04));
  for (const side of [1, -1]) {
    addTo(pilot, legGeometry, harness, (mesh) => {
      mesh.position.set(side * 0.12, -0.1, 0.48);
      mesh.rotation.x = 1.35;
    });
  }
  const brakeArms: Mesh[] = [];
  for (const side of [1, -1]) {
    brakeArms.push(
      addTo(pilot, armGeometry, suit, (mesh) => {
        mesh.position.set(side * 0.3, 0.3, 0.06);
        mesh.rotation.z = side * -0.3;
      })
    );
  }

  // --- the balloon ---------------------------------------------------------
  const envelopeHot = standard({ color: '#c93b3b', roughness: 0.82, side: DoubleSide, emissive: '#ff8f6a' });
  const envelopeCool = standard({ color: '#f2e3c2', roughness: 0.82, side: DoubleSide, emissive: '#fff0d2' });
  const wicker = standard({ color: '#a8854f', roughness: 0.94, side: DoubleSide, emissive: '#cBa978' });
  const frame = standard({ color: '#3a3f45', roughness: 0.7, metalness: 0.3, emissive: '#7e868f' });
  litMaterials.push(envelopeHot, envelopeCool, wicker, frame);

  const burnerFlame = basic({
    color: '#ffb347',
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const envelopeGlow = basic({
    color: '#ff9a3c',
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });

  // Balloon tourism is a thing at named places, not a default: Tràng An flies its
  // own festival and Hội An's old town is on the list, while Hanoi's balloons go
  // up from Long Biên, across the city from Tây Hồ, and a 1602m ridge has nowhere
  // to put one down. Unflown, the group is still built and disposed so the burner
  // materials and the night pass have one shape to deal with either way.
  const flies = recipe.aloft === 'balloon';
  const balloon = new Group();
  balloon.name = 'balloon';
  balloon.visible = false;
  if (flies) group.add(balloon);

  const envelopeGeometry = keep(createEnvelopeGeometry());
  const envelope = new Mesh(envelopeGeometry, [envelopeHot, envelopeCool]);
  balloon.add(envelope);

  const glowShellGeometry = keep(new SphereGeometry(BALLOON_RADIUS * 0.82, 14, 10));
  addTo(balloon, glowShellGeometry, envelopeGlow, (mesh) => (mesh.position.y = BALLOON_HEIGHT * 0.62));

  const basketGeometry = keep(new CylinderGeometry(BASKET_WIDTH * 0.52, BASKET_WIDTH * 0.46, 1.15, 10, 1, true));
  const basketRimGeometry = keep(new TorusGeometry(BASKET_WIDTH * 0.52, 0.055, 4, 12));
  basketRimGeometry.rotateX(Math.PI / 2);
  const uprightGeometry = keep(new CylinderGeometry(0.05, 0.05, 1.5, 4));
  const burnerGeometry = keep(new TorusGeometry(0.4, 0.07, 4, 10));
  burnerGeometry.rotateX(Math.PI / 2);
  const cableGeometry = keep(new CylinderGeometry(0.02, 0.02, 1, 3));
  cableGeometry.translate(0, 0.5, 0);
  const flameGeometry = keep(new CylinderGeometry(0.06, 0.62, 2.6, 8, 1, true));

  const basketY = -2.9;
  addTo(balloon, basketGeometry, wicker, (mesh) => (mesh.position.y = basketY));
  for (const offset of [-0.56, 0.56]) {
    addTo(balloon, basketRimGeometry, wicker, (mesh) => (mesh.position.y = basketY + offset));
  }
  for (const [ux, uz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]) {
    addTo(balloon, uprightGeometry, frame, (mesh) =>
      mesh.position.set(ux * BASKET_WIDTH * 0.36, basketY + 1.3, uz * BASKET_WIDTH * 0.36)
    );
  }
  addTo(balloon, burnerGeometry, frame, (mesh) => (mesh.position.y = basketY + 2.0));
  const flame = addTo(balloon, flameGeometry, burnerFlame, (mesh) => (mesh.position.y = basketY + 3.3));

  // Eight cables from the envelope mouth to the basket corners. The mouth is at
  // v = 1 of the envelope loft, which is y = 0 and radius BALLOON_RADIUS * 0.28.
  const mouthRadius = BALLOON_RADIUS * 0.28;
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2;
    const top = new Vector3(Math.cos(angle) * mouthRadius, 0, Math.sin(angle) * mouthRadius);
    const bottomX = Math.cos(angle) * BASKET_WIDTH * 0.36;
    const bottomZ = Math.sin(angle) * BASKET_WIDTH * 0.36;
    const length = Math.hypot(top.x - bottomX, basketY + 0.6, top.z - bottomZ);
    const cable = addTo(balloon, cableGeometry, lineMaterial, (mesh) => {
      mesh.position.set(bottomX, basketY + 0.6, bottomZ);
      mesh.scale.y = length;
    });
    cable.lookAt(top);
    cable.rotateX(Math.PI / 2);
  }

  // --- flight state --------------------------------------------------------
  const rarity = Math.max(0.2, options.rarity ?? 1);
  const airlinerSchedule = createSchedule(25 + random() * 90 * rarity);
  const paraSchedule = createSchedule(60 + random() * 150 * rarity);
  const balloonSchedule = createSchedule(40 + random() * 120 * rarity);

  let weather: WorldWeather | null = null;
  let night = 0;
  let twilight = 0;
  /** Positive when the light is coming back, which is the balloon's hour. */
  let brightening = 0;
  let lastNight = -1;
  let lastElapsed = 0;

  let airlinerBearing = 0;
  let airlinerOffset = 0;
  let airlinerAltitude = CRUISE_LOW;
  let airlinerTrailing = false;
  let nextEmit = 0;

  let thermalX = 0;
  let thermalZ = 0;
  let thermalBase = 0;
  let paraPhase = 0;
  let paraTurn = 1;

  let balloonX = 0;
  let balloonZ = 0;
  let balloonBase = 0;
  let balloonHeading = 0;

  const half = terrain.size / 2;

  const beginAirliner = (now: number): void => {
    airlinerBearing = random() * Math.PI * 2;
    airlinerOffset = (random() * 2 - 1) * half * 0.8;
    airlinerAltitude = CRUISE_LOW + random() * (CRUISE_HIGH - CRUISE_LOW);
    airlinerSchedule.duration = (TRACK_HALF * 2) / CRUISE_SPEED;
    airlinerTrailing = weather !== null && contrailStrength(weather) > 0.12;
    nextEmit = now;
    for (const trail of trails) {
      trail.live = 0;
      trail.head = 0;
      trail.mesh.visible = airlinerTrailing;
    }
  };

  const beginParaglider = (_now: number): void => {
    if (!ridge) return;
    const angle = random() * Math.PI * 2;
    const radius = 90 + random() * 220;
    thermalX = ridge.x + Math.cos(angle) * radius;
    thermalZ = ridge.z + Math.sin(angle) * radius;
    thermalBase = Math.max(terrain.heightAt(thermalX, thermalZ), ridge.height - 60) + 55;
    paraPhase = random() * Math.PI * 2;
    paraTurn = random() < 0.5 ? -1 : 1;
    paraSchedule.duration = 125 + random() * 145;
  };

  const beginBalloon = (_now: number): void => {
    const angle = random() * Math.PI * 2;
    balloonX = Math.cos(angle) * half * 0.6;
    balloonZ = Math.sin(angle) * half * 0.6;
    balloonBase = terrain.heightAt(balloonX, balloonZ);
    balloonHeading = weather ? weather.windDirection * DEG : random() * Math.PI * 2;
    balloonSchedule.duration = 210 + random() * 180;
  };

  const run = (
    schedule: Schedule,
    now: number,
    suitable: boolean,
    gap: number,
    begin: (now: number) => void
  ): number => {
    if (schedule.active) {
      const t = (now - schedule.startedAt) / schedule.duration;
      if (t <= 1) return t;
      schedule.active = false;
      schedule.nextStart = now + gap * (0.6 + random() * 0.8) * rarity;
      return -1;
    }
    if (now < schedule.nextStart) return -1;
    if (!suitable) {
      // Not the weather for it. Try again shortly rather than queueing a pass
      // that would have been invisible anyway.
      schedule.nextStart = now + 25 + random() * 45;
      return -1;
    }
    schedule.active = true;
    schedule.startedAt = now;
    begin(now);
    return 0;
  };

  const update = (elapsed: number): void => {
    const step = Math.max(0, Math.min(0.5, elapsed - lastElapsed));
    lastElapsed = elapsed;

    const clarity = weather ? skyClarity(weather) : 1;
    const windAngle = weather ? weather.windDirection * DEG : 0;
    // A wind FROM `angle` blows towards (-sin, +cos), the same convention the
    // rest of the scene uses.
    const windToX = -Math.sin(windAngle);
    const windToZ = Math.cos(windAngle);
    const surfaceWind = weather ? weather.windSpeed / 3.6 : 2;

    // --- airliner ---
    const airlinerT = run(airlinerSchedule, elapsed, clarity > 0.25, AIRLINER_GAP, beginAirliner);
    if (airlinerT >= 0) {
      const along = (airlinerT - 0.5) * TRACK_HALF * 2;
      const x = forwardX(airlinerBearing) * along + rightX(airlinerBearing) * airlinerOffset;
      const z = forwardZ(airlinerBearing) * along + rightZ(airlinerBearing) * airlinerOffset;
      airliner.position.set(x, airlinerAltitude, z);
      airliner.rotation.y = airlinerBearing;
      airliner.visible = clarity > 0.1;

      if (airlinerTrailing && trails.length > 0) {
        // A backgrounded tab resumes with a large jump in `elapsed`. Catching up
        // one node at a time would spin for thousands of iterations to lay a
        // trail that has already expired.
        nextEmit = Math.max(nextEmit, elapsed - TRAIL_LIFE);
        while (elapsed >= nextEmit) {
          for (const [index, trail] of trails.entries()) {
            const engine = enginePositions[index];
            // A few metres behind the exhaust is where the trail actually
            // starts, and it is laid in the world, not in the aircraft's frame.
            const back = engine.z - 6;
            emitTrailNode(
              trail,
              nextEmit,
              x + rightX(airlinerBearing) * engine.x + forwardX(airlinerBearing) * back,
              airlinerAltitude + engine.y,
              z + rightZ(airlinerBearing) * engine.x + forwardZ(airlinerBearing) * back,
              rightX(airlinerBearing),
              rightZ(airlinerBearing)
            );
          }
          nextEmit += trailEmitInterval;
        }
      }

      // Strobes double-flash; the beacon is a slow single pulse. Both only read
      // once the sky is dark enough to have lost the airframe.
      const dark = clamp01((night - 0.25) / 0.5);
      const strobeCycle = (elapsed * 1.15) % 1;
      const strobe = (strobeCycle < 0.05 || (strobeCycle > 0.11 && strobeCycle < 0.16) ? 1 : 0) * dark;
      const beacon = Math.max(0, Math.sin(elapsed * 3.3)) ** 9 * dark;
      strobeWhite.opacity = strobe * 0.95 * clarity;
      beaconRed.opacity = beacon * 0.8 * clarity;
      for (const mesh of strobes) mesh.visible = strobe > 0.01;
      for (const mesh of beacons) mesh.visible = beacon > 0.01;

      const lit = dark * clarity;
      navRed.opacity = lit;
      navGreen.opacity = lit;
      navWhite.opacity = lit * 0.8;
    } else {
      airliner.visible = false;
      strobeWhite.opacity = 0;
      beaconRed.opacity = 0;
    }

    // The trail outlives the aircraft by its whole life, so it is rebuilt
    // whether or not the airliner is still on the map.
    if (trails.length > 0) {
      const shearX = windToX * surfaceWind * TRAIL_SHEAR;
      const shearZ = windToZ * surfaceWind * TRAIL_SHEAR;
      let anyLive = false;
      for (const trail of trails) {
        rebuildTrail(trail, elapsed, shearX, shearZ);
        if (trail.live > 1) anyLive = true;
        trail.mesh.visible = trail.live > 1;
      }
      if (anyLive && weather) {
        const strength = contrailStrength(weather);
        // Ice catches the light the ground has already lost, so the trail goes
        // warm at twilight and only fades out in real darkness. It is never raw
        // white: the sky it sits against decides how bright it can be.
        trailColour.setRGB(1, 1, 1).lerp(DAWN_GOLD, twilight * 0.85);
        trailMaterial.uniforms.uOpacity.value =
          strength * clarity * 0.5 * (0.35 + weather.daylight * 0.65) * clamp01(1 - (night - 0.6) / 0.35);
      } else {
        trailMaterial.uniforms.uOpacity.value = 0;
      }
    }

    // --- paraglider ---
    if (ridge) {
      const flyable = weather !== null && weather.rainIntensity < 0.3 && weather.windSpeed < 34 && night < 0.55;
      const paraT = run(paraSchedule, elapsed, flyable, PARAGLIDER_GAP, beginParaglider);
      paraglider.visible = paraT >= 0;
      if (paraT >= 0) {
        // Circling a thermal, climbing while the lift lasts, then leaving on a
        // glide. Bank follows the turn rate, because a paraglider that turns
        // flat is the other obvious thing to get wrong.
        const lift = Math.max(0, Math.sin(paraT * Math.PI)) ** 0.7;
        const radius = 48 + (1 - lift) * 70;
        const rate = (PARA_SPEED / radius) * paraTurn;
        paraPhase += rate * step;
        const drift = (paraT - 0.35) * 420;
        const x = thermalX + Math.cos(paraPhase) * radius + windToX * drift;
        const z = thermalZ + Math.sin(paraPhase) * radius + windToZ * drift;
        const gain = 150 * lift * Math.min(1, paraT * 3);
        paraglider.position.set(x, thermalBase + gain + Math.sin(elapsed * 0.7) * 1.6, z);
        // Heading is the tangent of the circle, and heading is a bearing from
        // +Z, so it is atan2 of the velocity's x over its z.
        paraglider.rotation.y = Math.atan2(-Math.sin(paraPhase) * paraTurn, Math.cos(paraPhase) * paraTurn);
        paraglider.rotation.z = -Math.atan((PARA_SPEED * PARA_SPEED) / (radius * 9.81)) * paraTurn;
        paraglider.rotation.x = -0.08 + (1 - lift) * 0.1;

        const breathe = Math.sin(elapsed * 1.35) * 0.6 + Math.sin(elapsed * 2.9 + 1.1) * 0.4;
        const ripple = elapsed * 2.4;
        loftInto(canopyGeometry, CANOPY_COLUMNS, CANOPY_ROWS, false, (u, v, out) =>
          canopyPoint(u, v, out, breathe, ripple)
        );
        loftInto(cellGeometry, CELL_COLUMNS, CANOPY_ROWS, false, (u, v, out) =>
          canopyPoint(cellU(u), v, out, breathe, ripple)
        );
        canopy.position.y = breathe * 0.04;
        // Inside brake, held on through the turn.
        brakeArms[0].rotation.x = -0.1 + Math.max(0, paraTurn) * 0.45;
        brakeArms[1].rotation.x = -0.1 + Math.max(0, -paraTurn) * 0.45;
        riser.rotation.z = -paraglider.rotation.z * 0.35;
      }
    }

    // --- balloon ---
    // Balloons go up in the still air just after sunrise and come down before
    // the thermals start, which is why this one waits for the light to return
    // rather than for a clock.
    // The sign is all that is wanted here, and its magnitude is one frame's
    // change in the light, so a scene parked on the hour slider reads as
    // neither rising nor falling — and is allowed, rather than never getting a
    // balloon at all.
    const dawn = brightening >= -1e-7 ? clamp01(twilight * 1.2) : 0;
    const balloonable =
      flies && weather !== null && dawn > 0.25 && weather.windSpeed < 20 && weather.rainIntensity < 0.15;
    const balloonT = run(balloonSchedule, elapsed, balloonable, BALLOON_GAP, beginBalloon);
    balloon.visible = balloonT >= 0;
    if (balloonT >= 0) {
      balloonX += windToX * surfaceWind * 0.55 * step;
      balloonZ += windToZ * surfaceWind * 0.55 * step;
      // A burn every half minute or so, climbing between them and settling in
      // between, which is what a balloon actually does.
      const burnCycle = (elapsed * 0.034 + 0.2) % 1;
      const burning = burnCycle < 0.16 ? Math.sin((burnCycle / 0.16) * Math.PI) : 0;
      const rise = 60 + Math.sin(balloonT * Math.PI) * 170;
      const ground = terrain.heightAt(balloonX, balloonZ);
      balloon.position.set(balloonX, Math.max(ground + 12, balloonBase + rise), balloonZ);
      balloon.rotation.y = balloonHeading + Math.sin(elapsed * 0.11) * 0.5;
      // Hanging load: the envelope leads, the basket trails, and the whole thing
      // rocks very slowly.
      balloon.rotation.z = Math.sin(elapsed * 0.23) * 0.022;
      balloon.rotation.x = Math.cos(elapsed * 0.19) * 0.018;

      burnerFlame.opacity = burning * 0.85;
      flame.visible = burning > 0.02;
      flame.scale.set(1, 0.6 + burning * 0.7, 1);
      envelopeGlow.opacity = burning * 0.3 + 0.04;
    } else {
      burnerFlame.opacity = 0;
      envelopeGlow.opacity = 0;
    }
  };

  const setNight = (amount: number): void => {
    const next = clamp01(amount);
    if (lastNight >= 0) {
      // Which way the light is going, smoothed: a single frame's difference is
      // noise, and the hour slider can jump.
      brightening = brightening * 0.9 + (lastNight - next) * 0.1;
    }
    lastNight = next;
    night = next;
    twilight = twilightFrom(night);

    // Everything in this file is above the terrain and keeps its light longer
    // than the terrain does. That is the point of the module — but it is still
    // light-driven, not a fixed colour: at full dark the emissive goes with it.
    const sunlit = clamp01(1 - Math.max(0, night - 0.58) / 0.34);
    for (const material of litMaterials) {
      material.emissiveIntensity = sunlit * (0.22 + twilight * 0.5);
    }
    for (const material of [hull, belly, cowl]) {
      material.emissive.setRGB(1, 1, 1).lerp(DAWN_GOLD, twilight * 0.8);
    }
  };

  const setWeather = (next: WorldWeather): void => {
    weather = next;
  };

  setNight(0);

  return {
    group,
    update,
    setNight,
    setWeather,
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const trail of trails) trail.geometry.dispose();
      for (const material of materials) material.dispose();
      group.clear();
      airliner.clear();
      paraglider.clear();
      balloon.clear();
    },
  };
};
