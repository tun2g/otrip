import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  RingGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Base body length of the model, in metres. Per-fish scale works off this. */
const BODY_LENGTH = 0.24;
/** Metres of water a school needs under it. Relaxed if the location has none. */
const SCHOOL_DEPTH = [1.6, 0.9, 0.45];
/** Rings alive at once. A rise lasts about two seconds, so this is generous. */
const RING_SLOTS = 20;
/** Fish that can be out of the water at the same moment. */
const JUMP_SLOTS = 6;
/** Seconds a ring takes to spread and fade. */
const RING_LIFE = 2.3;
/** Metres a ring has spread to by the end of its life. */
const RING_REACH = 1.9;
/** Metres above the waterline the flat shapes and rings are drawn. */
const SURFACE_LIFT = 0.045;
const RING_LIFT = 0.055;

const STATE_CRUISE = 0;
const STATE_RISE = 1;
const STATE_JUMP = 2;

const GRAVITY = 9.81;

/** A membrane fanned from its first point — every fin on the fish is one of these. */
const fan = (points: [number, number, number][]): BufferGeometry => {
  const positions: number[] = [];
  for (const point of points) positions.push(point[0], point[1], point[2]);
  const indices: number[] = [];
  for (let i = 1; i < points.length - 1; i += 1) indices.push(0, i, i + 1);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

type Section = { z: number; top: number; bottom: number; half: number };

/**
 * A fusiform body lofted from sections. A fish seen through the surface is a
 * silhouette and nothing else, so the taper from the shoulder to the caudal
 * peduncle is the only thing on it that has to be right.
 */
const loft = (sections: Section[], ring = 8): BufferGeometry => {
  const positions: number[] = [];
  const indices: number[] = [];

  for (const section of sections) {
    const centre = (section.top + section.bottom) / 2;
    const height = (section.top - section.bottom) / 2;
    for (let j = 0; j < ring; j += 1) {
      const angle = (j / ring) * Math.PI * 2;
      positions.push(section.half * Math.cos(angle), centre + height * Math.sin(angle), section.z);
    }
  }

  for (let i = 0; i < sections.length - 1; i += 1) {
    for (let j = 0; j < ring; j += 1) {
      const next = (j + 1) % ring;
      const a = i * ring + j;
      const b = i * ring + next;
      const c = (i + 1) * ring + j;
      const d = (i + 1) * ring + next;
      indices.push(a, d, c, a, b, d);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

const BODY: Section[] = [
  { z: -0.105, top: 0.012, bottom: -0.012, half: 0.004 },
  { z: -0.075, top: 0.02, bottom: -0.018, half: 0.009 },
  { z: -0.035, top: 0.03, bottom: -0.028, half: 0.016 },
  { z: 0.0, top: 0.034, bottom: -0.032, half: 0.018 },
  { z: 0.04, top: 0.03, bottom: -0.028, half: 0.016 },
  { z: 0.08, top: 0.018, bottom: -0.018, half: 0.01 },
  { z: 0.11, top: 0.005, bottom: -0.005, half: 0.004 },
];

const createBodyGeometry = (): BufferGeometry => {
  const hull = loft(BODY);
  const dorsal = fan([
    [0, 0.028, -0.005],
    [0, 0.05, 0.005],
    [0, 0.052, 0.022],
    [0, 0.03, 0.042],
  ]);
  const anal = fan([
    [0, -0.028, -0.022],
    [0, -0.046, -0.014],
    [0, -0.028, 0.004],
  ]);
  const pectoral = fan([
    [0.016, -0.012, 0.045],
    [0.046, -0.026, 0.026],
    [0.038, -0.016, 0.056],
  ]);
  const pectoralLeft = pectoral.clone();
  pectoralLeft.applyMatrix4(new Matrix4().makeScale(-1, 1, 1));

  const merged = mergeGeometries([hull, dorsal, anal, pectoral, pectoralLeft]);
  for (const piece of [hull, dorsal, anal, pectoral, pectoralLeft]) piece.dispose();
  return merged ?? loft(BODY);
};

/** The forked caudal fin, in its own pivot's frame so it can beat. */
const createTailGeometry = (): BufferGeometry =>
  fan([
    [0, 0, 0],
    [0, 0.046, -0.062],
    [0, 0.014, -0.034],
    [0, -0.046, -0.062],
  ]);

const RING_VERTEX = /* glsl */ `
  #include <fog_pars_vertex>

  attribute float aLife;
  varying float vLife;
  varying float vRadial;

  void main() {
    vLife = aLife;
    // The ring geometry spans 0.55..1.0 in its own units; this is the position
    // across the band, which is what the band's profile is drawn from.
    vRadial = (length(position.xz) - 0.55) / 0.45;
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const RING_FRAGMENT = /* glsl */ `
  #include <fog_pars_fragment>

  uniform vec3 uFoam;
  uniform float uLight;

  varying float vLife;
  varying float vRadial;

  void main() {
    if (vLife >= 1.0) discard;

    // Soft across the band, with the outer edge the sharp one — a ring on water
    // has a crest travelling out and a smooth trough behind it.
    float band = pow(sin(clamp(vRadial, 0.0, 1.0) * 3.14159265), 1.4);
    float crest = smoothstep(0.45, 1.0, vRadial);

    // The boil comes first and bright, the ring spreads and goes. Fading as the
    // square keeps the last half-second from lingering as a grey hoop.
    float swirl = 1.0 - smoothstep(0.0, 0.18, vLife);
    float fade = pow(1.0 - vLife, 1.7);

    float alpha = (band * 0.45 + crest * 0.35 + swirl * 0.55) * fade * uLight;
    if (alpha <= 0.002) discard;

    // Albedo, not emission. The one bug that has cost this project most was the
    // river keeping its midday colour after dark, so this is scaled by the light
    // reaching the surface and a ring at midnight is a faint grey disturbance.
    gl_FragColor = vec4(uFoam * uLight, alpha);
    #include <fog_fragment>
    #ifdef USE_FOG
      gl_FragColor.a *= 1.0 - fogFactor;
    #endif
  }
`;

type School = {
  x: number;
  z: number;
  /** Validated against the bed: every point on this orbit has water under it. */
  radius: number;
  depth: number;
  phase: number;
  drift: number;
};

type Swimmer = {
  school: number;
  angle: number;
  orbit: number;
  /** Metres below the surface while cruising. */
  depth: number;
  speed: number;
  size: number;
  beat: number;
  phase: number;
  state: number;
  until: number;
  /** Eased 0..1: how far up toward the surface the fish has come. */
  lift: number;
  /** Eased 0..1: burst speed and a widening orbit after being disturbed. */
  flight: number;
  /** Which jump slot this fish holds, or -1. */
  slot: number;
  jumpX: number;
  jumpZ: number;
  jumpY: number;
  jumpVy: number;
  jumpHeading: number;
  jumpSpeed: number;
  spin: number;
};

export type Fish = {
  group: Group;
  update: (elapsed: number) => void;
  setNight: (amount: number) => void;
  /** A swimmer, or a boat's forefoot. Everything nearby scatters and goes deep. */
  startle: (x: number, z: number, radius?: number) => void;
  /** Fish actually placed, and how many schools they were placed in. */
  counts: () => { fish: number; schools: number };
  dispose: () => void;
};

/**
 * Cá. Shapes under the surface, and rises that break it. The rise is the part
 * anyone actually notices — a swirl, a ring spreading, gone — and the jumps come
 * at dawn and dusk because that is when fish feed at the top.
 *
 * Returns null where there is no water, which is Tà Xùa.
 */
export const createFish = (terrain: Terrain, recipe: LocationRecipe, count: number): Fish | null => {
  const water = recipe.water;
  if (!water || count <= 0) return null;

  const random = createPrng(`${recipe.seed}:fish`);
  const level = water.level;
  const half = terrain.size / 2;
  const depthAt = (x: number, z: number) => level - terrain.heightAt(x, z);

  // --- schools ------------------------------------------------------------
  // The whole orbit has to be in water, not just its centre: a school placed on
  // the mean depth of a channel had half its fish swimming through the bank.
  const schools: School[] = [];
  const wantedSchools = Math.max(1, Math.round(count / 7));

  for (const minimum of SCHOOL_DEPTH) {
    for (let attempt = 0; attempt < wantedSchools * 160 && schools.length < wantedSchools; attempt += 1) {
      const x = (random() * 2 - 1) * half * 0.9;
      const z = (random() * 2 - 1) * half * 0.9;
      if (depthAt(x, z) < minimum) continue;

      let radius = 7 + random() * 16;
      let fits = false;
      while (radius > 2.5 && !fits) {
        fits = true;
        for (let probe = 0; probe < 10; probe += 1) {
          const angle = (probe / 10) * Math.PI * 2;
          const px = x + Math.cos(angle) * radius;
          const pz = z + Math.sin(angle) * radius;
          if (Math.abs(px) > half || Math.abs(pz) > half || depthAt(px, pz) < minimum * 0.6) {
            fits = false;
            break;
          }
        }
        if (!fits) radius *= 0.72;
      }
      if (!fits) continue;

      schools.push({
        x,
        z,
        radius,
        depth: Math.min(minimum * 1.4, depthAt(x, z) * 0.6),
        phase: random() * Math.PI * 2,
        drift: (random() * 2 - 1) * 0.05,
      });
    }
    if (schools.length >= wantedSchools) break;
  }

  if (schools.length === 0) return null;

  const group = new Group();
  group.name = 'fish';

  const swimmers: Swimmer[] = Array.from({ length: count }, (_, index) => {
    const school = schools[index % schools.length];
    return {
      school: index % schools.length,
      angle: random() * Math.PI * 2,
      orbit: school.radius * (0.25 + random() * 0.7),
      depth: 0.3 + random() * Math.max(0.2, school.depth - 0.3),
      speed: 0.55 + random() * 0.65,
      // Most of a river's fish are small; a few are worth seeing.
      size: random() < 0.14 ? 1.3 + random() * 0.8 : 0.65 + random() * 0.5,
      beat: 5.5 + random() * 3,
      phase: random() * Math.PI * 2,
      state: STATE_CRUISE,
      until: 4 + random() * 30,
      lift: 0,
      flight: 0,
      slot: -1,
      jumpX: 0,
      jumpZ: 0,
      jumpY: level,
      jumpVy: 0,
      jumpHeading: 0,
      jumpSpeed: 0,
      spin: 0,
    };
  });

  // --- meshes -------------------------------------------------------------
  const bodyGeometry = createBodyGeometry();
  const tailGeometry = createTailGeometry();

  const materials: Material[] = [];

  /**
   * The main water surface is opaque, so a fish genuinely below it draws
   * nothing. These are the shapes seen *through* the surface: the body flattened
   * onto the waterline, dark and translucent, which is what a fish a foot down
   * actually looks like from the bank — and it correctly disappears at a grazing
   * angle, where the surface reflects instead of showing what is under it.
   */
  const shadeMaterial = new MeshStandardMaterial({
    color: new Color(water.deep).multiplyScalar(0.55),
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
    side: DoubleSide,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  });
  const airMaterial = new MeshStandardMaterial({
    color: '#9aa391',
    roughness: 0.3,
    metalness: 0.18,
    flatShading: true,
    side: DoubleSide,
  });
  materials.push(shadeMaterial, airMaterial);

  const shadeBody = new InstancedMesh(bodyGeometry, shadeMaterial, count);
  const shadeTail = new InstancedMesh(tailGeometry, shadeMaterial, count);
  const airBody = new InstancedMesh(bodyGeometry, airMaterial, JUMP_SLOTS);
  const airTail = new InstancedMesh(tailGeometry, airMaterial, JUMP_SLOTS);

  for (const mesh of [shadeBody, shadeTail, airBody, airTail]) {
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }

  const ringGeometry = new RingGeometry(0.55, 1, 28, 1);
  ringGeometry.rotateX(-Math.PI / 2);
  const ringLives = new Float32Array(RING_SLOTS).fill(2);
  const ringAttribute = new InstancedBufferAttribute(ringLives, 1);
  ringGeometry.setAttribute('aLife', ringAttribute);

  const ringUniforms = Object.assign(UniformsUtils.clone(UniformsLib.fog), {
    uFoam: { value: new Color('#e8f2ef') },
    uLight: { value: 1 },
  });
  const ringMaterial = new ShaderMaterial({
    name: 'fish-rings',
    uniforms: ringUniforms,
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    fog: true,
  });
  materials.push(ringMaterial);

  const rings = new InstancedMesh(ringGeometry, ringMaterial, RING_SLOTS);
  rings.name = 'fish-rings';
  rings.frustumCulled = false;
  rings.castShadow = false;
  // After the lake surface, which sets 1, so a ring sits on the water rather
  // than being blended under it.
  rings.renderOrder = 2;
  group.add(rings);

  type Ring = { x: number; z: number; born: number; scale: number };
  const ringPool: Ring[] = Array.from({ length: RING_SLOTS }, () => ({ x: 0, z: 0, born: -1000, scale: 1 }));
  let ringCursor = 0;
  const jumpSlots: number[] = Array.from({ length: JUMP_SLOTS }, () => -1);

  // --- scratch, hoisted ---------------------------------------------------
  const root = new Object3D();
  const tailPivot = new Object3D();
  tailPivot.position.z = -0.105;
  root.add(tailPivot);
  const hidden = new Matrix4().makeScale(0, 0, 0);
  const ringMatrix = new Matrix4();
  const ringScale = new Vector3();
  const ringPosition = new Vector3();

  let night = 0;
  let lastElapsed = 0;
  let startleX = 0;
  let startleZ = 0;
  let startleRadius = 0;
  let startleUntil = -1000;

  const spawnRing = (x: number, z: number, elapsed: number, scale: number) => {
    const ring = ringPool[ringCursor];
    ringCursor = (ringCursor + 1) % RING_SLOTS;
    ring.x = x;
    ring.z = z;
    ring.born = elapsed;
    ring.scale = scale;
  };

  const ease = (current: number, target: number, rate: number, delta: number) =>
    current + (target - current) * Math.min(1, rate * delta);

  const update = (elapsed: number) => {
    const delta = Math.min(0.1, Math.max(0, elapsed - lastElapsed));
    lastElapsed = elapsed;

    // Dawn and dusk, from the one number the renderer has: night runs 0..1, so
    // twilight is wherever it is halfway, which is both ends of the day.
    const twilight = 1 - Math.abs(night * 2 - 1);
    const feeding = 0.25 + twilight * 1.25;
    const startled = elapsed < startleUntil;

    for (let index = 0; index < swimmers.length; index += 1) {
      const fish = swimmers[index];
      const school = schools[fish.school];

      if (startled) {
        const reach = Math.hypot(
          school.x + Math.cos(fish.angle) * fish.orbit - startleX,
          school.z + Math.sin(fish.angle) * fish.orbit - startleZ
        );
        if (reach < startleRadius) fish.flight = 1;
      }
      fish.flight = ease(fish.flight, 0, 0.55, delta);

      if (fish.state === STATE_CRUISE && elapsed >= fish.until) {
        // A rise most of the time, a jump occasionally and only when the light
        // is going — a fish clearing the water at noon is a thing people notice
        // as wrong without being able to say why.
        const jumping = random() < 0.12 + twilight * 0.3;
        const slot = jumping ? jumpSlots.indexOf(-1) : -1;
        if (jumping && slot >= 0) {
          fish.state = STATE_JUMP;
          fish.slot = slot;
          jumpSlots[slot] = index;
          fish.jumpX = school.x + Math.cos(fish.angle) * fish.orbit;
          fish.jumpZ = school.z + Math.sin(fish.angle) * fish.orbit;
          fish.jumpY = level;
          fish.jumpVy = 2.4 + random() * 1.9 + fish.size * 0.7;
          fish.jumpHeading = fish.angle + Math.PI / 2 + (random() * 2 - 1) * 0.5;
          fish.jumpSpeed = 1.5 + random() * 1.6;
          fish.spin = (random() * 2 - 1) * 1.6;
          spawnRing(fish.jumpX, fish.jumpZ, elapsed, 0.5 + fish.size * 0.5);
          fish.until = elapsed + 6;
        } else {
          fish.state = STATE_RISE;
          fish.until = elapsed + 1.1 + random() * 0.8;
        }
      }

      if (fish.state === STATE_RISE) {
        fish.lift = ease(fish.lift, 1, 2.4, delta);
        if (elapsed >= fish.until) {
          // The break: one ring, and the fish is gone back down.
          spawnRing(
            school.x + Math.cos(fish.angle) * fish.orbit,
            school.z + Math.sin(fish.angle) * fish.orbit,
            elapsed,
            0.35 + fish.size * 0.35
          );
          fish.state = STATE_CRUISE;
          fish.until = elapsed + (8 + random() * 34) / feeding;
        }
      } else if (fish.state !== STATE_JUMP) {
        fish.lift = ease(fish.lift, 0, 1.6, delta);
      }

      if (fish.state === STATE_JUMP) {
        fish.jumpVy -= GRAVITY * delta;
        fish.jumpY += fish.jumpVy * delta;
        fish.jumpX += Math.cos(fish.jumpHeading) * fish.jumpSpeed * delta;
        fish.jumpZ += Math.sin(fish.jumpHeading) * fish.jumpSpeed * delta;

        if (fish.jumpY <= level && fish.jumpVy < 0) {
          spawnRing(fish.jumpX, fish.jumpZ, elapsed, 0.7 + fish.size * 0.7);
          if (fish.slot >= 0) {
            airBody.setMatrixAt(fish.slot, hidden);
            airTail.setMatrixAt(fish.slot, hidden);
            jumpSlots[fish.slot] = -1;
            fish.slot = -1;
          }
          fish.state = STATE_CRUISE;
          fish.lift = 0.5;
          fish.until = elapsed + (10 + random() * 40) / feeding;
        } else {
          // Pitched along the arc, and rolling: a fish out of the water is
          // flailing, and the flat flank catching the light is the whole picture.
          root.position.set(fish.jumpX, fish.jumpY, fish.jumpZ);
          root.rotation.set(Math.atan2(fish.jumpVy, fish.jumpSpeed), fish.jumpHeading + Math.PI / 2, 0);
          root.rotation.z = fish.spin * (fish.jumpY - level) * 0.6;
          root.scale.setScalar(fish.size);
          tailPivot.rotation.y = Math.sin(elapsed * 26 + fish.phase) * 0.8;
          root.updateMatrixWorld(true);
          if (fish.slot >= 0) {
            airBody.setMatrixAt(fish.slot, root.matrixWorld);
            airTail.setMatrixAt(fish.slot, tailPivot.matrixWorld);
          }
          // Out of the water there is no shape under it.
          shadeBody.setMatrixAt(index, hidden);
          shadeTail.setMatrixAt(index, hidden);
          continue;
        }
      }

      // Cruising. Position comes from the orbit rather than being integrated, so
      // a fish can never wander out of the water its school was validated on.
      const burst = 1 + fish.flight * 3.4;
      fish.angle += ((fish.speed * burst) / Math.max(1, fish.orbit)) * delta;
      const orbit = fish.orbit * (1 + fish.flight * 0.5) + Math.sin(elapsed * 0.4 + fish.phase) * 0.6;
      const x = school.x + Math.cos(fish.angle + school.phase + elapsed * school.drift) * orbit;
      const z = school.z + Math.sin(fish.angle + school.phase + elapsed * school.drift) * orbit;

      // A startled fish goes deep; a rising one comes to the surface film.
      const depth = fish.depth * (1 + fish.flight * 1.2);
      const y = level - depth + (depth - SURFACE_LIFT) * fish.lift;
      const heading = fish.angle + school.phase + elapsed * school.drift + Math.PI / 2;

      root.position.set(x, Math.min(level + SURFACE_LIFT, y + SURFACE_LIFT), z);
      root.rotation.set(0, -heading + Math.PI / 2, 0);
      // Flattened onto the waterline: this is a shape seen through the surface,
      // not a body in the air, and a full-depth fish floating above the water is
      // the thing that would give it away.
      root.scale.set(fish.size, fish.size * 0.4, fish.size);
      root.rotation.z = Math.sin(elapsed * fish.beat * 0.4 + fish.phase) * 0.08;
      tailPivot.rotation.y = Math.sin(elapsed * fish.beat * burst + fish.phase) * (0.45 + fish.flight * 0.5);
      root.updateMatrixWorld(true);

      shadeBody.setMatrixAt(index, root.matrixWorld);
      shadeTail.setMatrixAt(index, tailPivot.matrixWorld);
    }

    shadeBody.instanceMatrix.needsUpdate = true;
    shadeTail.instanceMatrix.needsUpdate = true;
    airBody.instanceMatrix.needsUpdate = true;
    airTail.instanceMatrix.needsUpdate = true;

    for (let slot = 0; slot < RING_SLOTS; slot += 1) {
      const ring = ringPool[slot];
      const life = (elapsed - ring.born) / RING_LIFE;
      ringLives[slot] = life;
      if (life < 0 || life >= 1) {
        rings.setMatrixAt(slot, hidden);
        continue;
      }
      // Spreading as the square root: a ring on water travels fast at first and
      // slows, and a linear one reads as an expanding decal.
      const radius = ring.scale * (0.12 + Math.sqrt(life) * RING_REACH);
      ringScale.set(radius, 1, radius);
      ringPosition.set(ring.x, level + RING_LIFT, ring.z);
      rings.setMatrixAt(slot, ringMatrix.identity().scale(ringScale).setPosition(ringPosition));
    }
    rings.instanceMatrix.needsUpdate = true;
    ringAttribute.needsUpdate = true;
  };

  update(0);
  for (let slot = 0; slot < JUMP_SLOTS; slot += 1) {
    airBody.setMatrixAt(slot, hidden);
    airTail.setMatrixAt(slot, hidden);
  }
  airBody.instanceMatrix.needsUpdate = true;
  airTail.instanceMatrix.needsUpdate = true;

  return {
    group,
    update,
    setNight: (amount) => {
      night = Math.min(1, Math.max(0, amount));
      // Moonlight is enough to see a ring by and nothing like enough to see a
      // fish by, which is why the shapes go before the rings do.
      const light = 1 - night * 0.86;
      ringUniforms.uLight.value = light;
      shadeMaterial.opacity = 0.62 * (1 - night * 0.75);
      shadeBody.visible = shadeMaterial.opacity > 0.03;
      shadeTail.visible = shadeBody.visible;
    },
    startle: (x, z, radius = 9) => {
      startleX = x;
      startleZ = z;
      startleRadius = radius;
      startleUntil = lastElapsed + 0.3;
    },
    counts: () => ({ fish: swimmers.length, schools: schools.length }),
    dispose: () => {
      bodyGeometry.dispose();
      tailGeometry.dispose();
      ringGeometry.dispose();
      for (const mesh of [shadeBody, shadeTail, airBody, airTail, rings]) mesh.dispose();
      for (const material of materials) material.dispose();
    },
  };
};
