import type { WaterParams } from '@otrip/world';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Material,
  type PerspectiveCamera,
} from 'three';

/** Metres of water that only wets the feet. Below this the walk is unaffected. */
export const WADE_DEPTH = 0.4;
/** Chest depth on a 1.78 m body — where the feet stop reaching the bed. */
export const SWIM_DEPTH = 1.3;
/** Bank gradient a swimmer can still haul themselves up; steeper wants a ladder. */
export const CLIMB_SLOPE = 1.15;

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** 0 standing on the bed, 1 fully afloat. The blend is the wade-to-swim change. */
export const afloatAt = (depth: number): number => smoothstep(SWIM_DEPTH - 0.35, SWIM_DEPTH + 0.25, depth);

/** What the water takes out of a wading walk: 1 free, 0.38 at chest depth. */
export const wadeDrag = (depth: number): number => 1 - 0.62 * smoothstep(WADE_DEPTH, SWIM_DEPTH, depth);

export type Waterline = {
  /** Patches a material so whatever is under the surface darkens and goes slick. */
  attach: (material: Material) => void;
  set: (level: number, wet: number) => void;
};

/**
 * Wet legs. The avatar is one skinned mesh with one material, so the waterline
 * has to be found per fragment rather than by swapping anything: everything
 * below the surface loses albedo and gains gloss, which is what wading reads as.
 */
export const createWaterline = (): Waterline => {
  const uniforms = { uWaterY: { value: 0 }, uWet: { value: 0 } };
  /**
   * A function, not a `float soaked = ...` statement, because the waterline is
   * needed at two chunks inside the same `main()` and a second declaration is a
   * redefinition: the whole fragment shader failed to compile, and three.js then
   * skips the draw, so at every destination that has water the avatar was not
   * drawn at all while nothing in the scene graph looked wrong. It cost a
   * destination rather than an effect, which is why the soak is now computed
   * where it cannot be declared twice and does not care which chunk comes first.
   */
  const soakFn = 'float waterlineSoak() { return clamp((uWaterY - vWetY) / 0.5, 0.0, 1.0) * uWet; }';

  return {
    attach: (material) => {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uWaterY = uniforms.uWaterY;
        shader.uniforms.uWet = uniforms.uWet;

        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying float vWetY;')
          // After projection, so `transformed` already carries the skinning.
          .replace(
            '#include <project_vertex>',
            '#include <project_vertex>\nvWetY = (modelMatrix * vec4(transformed, 1.0)).y;'
          );

        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>\nvarying float vWetY;\nuniform float uWaterY;\nuniform float uWet;\n${soakFn}`
          )
          .replace(
            '#include <roughnessmap_fragment>',
            `#include <roughnessmap_fragment>
             roughnessFactor *= mix(1.0, 0.28, waterlineSoak());`
          )
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
             diffuseColor.rgb *= mix(vec3(1.0), vec3(0.46, 0.55, 0.58), waterlineSoak());`
          );
      };

      // Without its own key this material shares a compiled program with every
      // other standard material in the scene, so either the villagers get a
      // waterline or the swimmer does not.
      material.customProgramCacheKey = () => 'waterline';
    },
    set: (level, wet) => {
      uniforms.uWaterY.value = level;
      uniforms.uWet.value = wet;
    },
  };
};

export type SwimFrame = {
  x: number;
  z: number;
  /** Metres of water under them; 0 on dry land. */
  depth: number;
  /** 0 wading, 1 swimming. */
  afloat: number;
  /** Ground speed, m/s. */
  speed: number;
  /** Heading of travel, in the walker's convention: `atan2(dx, dz)`. */
  heading: number;
  /** Stroke cycles since they went in, so the water answers the arms. */
  stroke: number;
  /** Camera height relative to the surface. Negative means the lens is under. */
  lens: number;
  /** 1 while the body is wet, decaying once it is out of the water. */
  wet: number;
};

export type SwimEffects = {
  /** World space, so the owner adds it to the scene rather than to the walker. */
  group: Group;
  update: (delta: number, frame: SwimFrame, camera: PerspectiveCamera) => void;
  /** A burst at a point on the surface: going in, or stepping off a deck. */
  splash: (x: number, z: number, force: number) => void;
  setNight: (amount: number) => void;
  dispose: () => void;
};

const RIPPLES = 18;
const DROPLETS = 44;
const WAKE_SAMPLES = 26;
/** Metres the swimmer travels before the wake lays down another cross-section. */
const WAKE_STEP = 0.55;
/**
 * The speed the wake and the bow wave are drawn at full strength.
 *
 * Swimming hard, and nothing in the water goes faster: the walker's ladder tops
 * out at 1.6 m/s afloat. These were divided by 4.5 and 5 — running speeds — so a
 * swimmer crossing the Thu Bồn carried a wake at a quarter strength and a bow
 * wave at its smallest, which is why from the bank there was nothing to see.
 */
const STROKE_SPEED = 1.5;
/** Fractions of a stroke cycle the water is pushed at: the pull, then the kick. */
const PULL_AT = 0.3;
const KICK_AT = 0.72;

/**
 * A white per-vertex colour, which is the only thing that lets `instanceColor`
 * reach the fragment shader: three declares the colour varying from the
 * geometry's `color` attribute, so without this every per-ripple fade would be
 * computed in the vertex shader and then thrown away.
 */
const addWhite = (geometry: BufferGeometry): BufferGeometry => {
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(count * 3).fill(1), 3));
  return geometry;
};

/**
 * The V a swimmer pushes ahead of their shoulders. A quad strip per side with
 * the fade written into the vertex alpha, so the crest is solid at the shoulder
 * and gone by the tail without a texture to ship.
 */
const createBowWaveGeometry = (): BufferGeometry => {
  const steps = 7;
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];

  for (const side of [-1, 1]) {
    const base = positions.length / 3;

    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      // Roughly the 19° a slow swimmer's crest leaves the shoulder at, widening
      // as it runs back.
      const spread = 0.18 + t * 1.5;
      const back = -t * 3.2;
      const thickness = 0.1 + t * 0.42;
      const fade = (1 - t) ** 1.4;

      positions.push(side * spread, 0, back);
      colours.push(1, 1, 1, fade * 0.8);
      positions.push(side * (spread + thickness), 0, back - thickness * 0.5);
      colours.push(1, 1, 1, 0);
    }

    for (let i = 0; i < steps; i += 1) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colours), 4));
  geometry.setIndex(indices);
  return geometry;
};

const LENS_FRAGMENT = /* glsl */ `
  uniform float uWet;
  uniform float uTime;
  uniform vec3 uTint;

  varying vec2 vUv;

  float hash12(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }

  void main() {
    // A film of water at the edge of the frame, where it would run off last.
    float edge = smoothstep(0.3, 0.5, max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)));
    float alpha = edge * uWet * 0.3;
    vec3 colour = uTint;

    // One cell, at most one drop. Drifting the lookup downward is the whole
    // sheet of them running off the lens.
    vec2 cell = vUv * vec2(11.0, 7.0);
    cell.y += uTime * 0.05;
    vec2 id = floor(cell);
    vec2 offset = fract(cell) - 0.5 - (vec2(hash12(id + 11.0), hash12(id + 23.0)) - 0.5) * 0.62;

    float pick = hash12(id);
    float radius = (0.1 + pick * 0.19) * uWet;
    float distanceTo = length(offset * vec2(1.0, 1.45));

    if (pick > 0.52) {
      float body = smoothstep(radius, radius * 0.4, distanceTo);
      // A droplet is a lens, so its rim is the bright part of it.
      float rim = smoothstep(radius, radius * 0.82, distanceTo) - smoothstep(radius * 0.82, radius * 0.5, distanceTo);
      alpha += body * uWet * 0.42;
      colour += vec3(rim * 0.8);
    }

    if (alpha < 0.002) discard;
    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

const LENS_VERTEX = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Everything the water does back to you: the rings where you went in, the bow
 * wave and the wake you drag behind, the droplets you throw, and — once the lens
 * is down at the surface — the waterline cutting across the frame and the film
 * of water left on it.
 */
export const createSwimEffects = (water: WaterParams): SwimEffects => {
  const level = water.level;
  const group = new Group();
  group.name = 'swim-effects';

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const keep = <T extends BufferGeometry>(geometry: T): T => {
    geometries.push(geometry);
    return geometry;
  };
  const keepMaterial = <T extends Material>(material: T): T => {
    materials.push(material);
    return material;
  };

  // Two foams rather than one: the rings carry their fade in `instanceColor`
  // over a three-component attribute, the ribbons carry theirs in a
  // four-component vertex alpha, and one material cannot be both without three
  // swapping programs between the two every frame.
  const foamInstanced = keepMaterial(
    new MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      vertexColors: true,
      fog: false,
    })
  );
  const foamRibbon = keepMaterial(
    new MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      vertexColors: true,
      fog: false,
    })
  );

  // --- rings spreading from wherever the surface was broken -----------------
  const ringGeometry = keep(new RingGeometry(0.64, 1, 24, 1));
  ringGeometry.rotateX(-Math.PI / 2);
  addWhite(ringGeometry);

  const rings = new InstancedMesh(ringGeometry, foamInstanced, RIPPLES);
  rings.frustumCulled = false;
  group.add(rings);

  const ringX = new Float32Array(RIPPLES);
  const ringZ = new Float32Array(RIPPLES);
  const ringAge = new Float32Array(RIPPLES).fill(Infinity);
  const ringLife = new Float32Array(RIPPLES).fill(1);
  const ringSpread = new Float32Array(RIPPLES).fill(1);
  let ringCursor = 0;

  // --- water thrown into the air -------------------------------------------
  const dropGeometry = addWhite(keep(new SphereGeometry(0.075, 6, 4)));
  const drops = new InstancedMesh(dropGeometry, foamInstanced, DROPLETS);
  drops.frustumCulled = false;
  group.add(drops);

  const dropPosition = new Float32Array(DROPLETS * 3);
  const dropVelocity = new Float32Array(DROPLETS * 3);
  const dropAge = new Float32Array(DROPLETS).fill(Infinity);
  const dropLife = new Float32Array(DROPLETS).fill(1);
  let dropCursor = 0;

  // --- the bow wave, carried along in front of the shoulders ---------------
  const bowWave = new Object3D();
  group.add(bowWave);
  const bowMesh = new Mesh(keep(createBowWaveGeometry()), foamRibbon);
  bowMesh.frustumCulled = false;
  bowWave.add(bowMesh);

  // --- the wake, laid down in world space as they go -----------------------
  const wakeGeometry = keep(new BufferGeometry());
  const wakePositions = new Float32Array(WAKE_SAMPLES * 3 * 3);
  const wakeColours = new Float32Array(WAKE_SAMPLES * 3 * 4);
  const wakeIndices: number[] = [];
  for (let i = 0; i < WAKE_SAMPLES - 1; i += 1) {
    const a = i * 3;
    const b = (i + 1) * 3;
    wakeIndices.push(a, a + 1, b + 1, a, b + 1, b, a + 1, a + 2, b + 2, a + 1, b + 2, b + 1);
  }
  wakeGeometry.setAttribute('position', new BufferAttribute(wakePositions, 3));
  wakeGeometry.setAttribute('color', new BufferAttribute(wakeColours, 4));
  wakeGeometry.setIndex(wakeIndices);

  const wake = new Mesh(wakeGeometry, foamRibbon);
  wake.frustumCulled = false;
  group.add(wake);

  const trailX = new Float32Array(WAKE_SAMPLES);
  const trailZ = new Float32Array(WAKE_SAMPLES);
  const trailStrength = new Float32Array(WAKE_SAMPLES);
  let trailLastX = 0;
  let trailLastZ = 0;

  // --- the surface seen from the lens --------------------------------------
  // An annulus lying in the water plane around the camera. Edge-on it is the
  // waterline itself, so the band falls exactly where the surface crosses the
  // frame instead of being guessed in screen space. The inner radius clears the
  // 2 m near plane, or there would be nothing to see.
  const bandGeometry = keep(new RingGeometry(2.4, 9, 32, 1));
  bandGeometry.rotateX(-Math.PI / 2);
  const bandMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: '#dff3ff',
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: DoubleSide,
      fog: false,
    })
  );
  const band = new Mesh(bandGeometry, bandMaterial);
  band.frustumCulled = false;
  band.renderOrder = 12;
  group.add(band);

  const overlayGeometry = keep(new PlaneGeometry(1, 1));

  const tintMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: new Color(water.deep),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      side: DoubleSide,
      fog: false,
    })
  );
  const tint = new Mesh(overlayGeometry, tintMaterial);
  tint.frustumCulled = false;
  tint.renderOrder = 11;
  group.add(tint);

  const lensUniforms = {
    uWet: { value: 0 },
    uTime: { value: 0 },
    uTint: { value: new Color(water.shallow) },
  };
  const lensMaterial = keepMaterial(
    new ShaderMaterial({
      uniforms: lensUniforms,
      vertexShader: LENS_VERTEX,
      fragmentShader: LENS_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: DoubleSide,
    })
  );
  const lens = new Mesh(overlayGeometry, lensMaterial);
  lens.frustumCulled = false;
  lens.renderOrder = 13;
  group.add(lens);

  const matrix = new Matrix4();
  const scratch = new Vector3();
  const flat = new Quaternion();
  const scale = new Vector3(1, 1, 1);
  const fadeColour = new Color();
  const deepColour = new Color(water.deep);
  const forward = new Vector3();

  let night = 0;
  let elapsed = 0;
  let strokeTimer = 0;
  let lastBeat = Number.NaN;

  const ring = (x: number, z: number, spread: number, life: number) => {
    ringX[ringCursor] = x;
    ringZ[ringCursor] = z;
    ringAge[ringCursor] = 0;
    ringLife[ringCursor] = life;
    ringSpread[ringCursor] = spread;
    ringCursor = (ringCursor + 1) % RIPPLES;
  };

  const droplet = (x: number, z: number, force: number) => {
    const index = dropCursor * 3;
    const angle = Math.random() * Math.PI * 2;
    const out = Math.random() * 1.5 * force;

    dropPosition[index] = x;
    dropPosition[index + 1] = level + 0.1;
    dropPosition[index + 2] = z;
    dropVelocity[index] = Math.cos(angle) * out;
    dropVelocity[index + 1] = (1.6 + Math.random() * 2.6) * force;
    dropVelocity[index + 2] = Math.sin(angle) * out;
    dropAge[dropCursor] = 0;
    dropLife[dropCursor] = 0.5 + Math.random() * 0.7;
    dropCursor = (dropCursor + 1) % DROPLETS;
  };

  const splash = (x: number, z: number, force: number) => {
    const strength = Math.min(1.6, Math.max(0.2, force));
    ring(x, z, 2.4 * strength, 1.3);
    ring(x, z, 4.2 * strength, 2.1);
    ring(x, z, 6.4 * strength, 3);
    for (let i = 0; i < Math.round(10 + strength * 14); i += 1) droplet(x, z, strength);
  };

  /**
   * Keeps an overlay in front of the lens and filling it, whatever the fov is.
   * The heading comes off the quaternion, not `getWorldDirection`: the walker
   * has just aimed the camera and nothing has updated its world matrix yet.
   */
  const faceLens = (mesh: Mesh, camera: PerspectiveCamera, distance: number) => {
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    mesh.position.copy(camera.position).addScaledVector(forward, distance);
    mesh.quaternion.copy(camera.quaternion);
    const height = 2 * distance * Math.tan((camera.fov * Math.PI) / 360);
    mesh.scale.set(height * camera.aspect * 1.1, height * 1.1, 1);
  };

  const update = (delta: number, frame: SwimFrame, camera: PerspectiveCamera) => {
    elapsed += delta;
    const swimming = frame.afloat > 0.45;
    const wading = frame.depth > WADE_DEPTH * 0.6 && !swimming;

    // --- rings -------------------------------------------------------------
    // Twice a stroke, on the arm pull and on the kick, rather than on a timer of
    // its own: rings arriving on their own beat are what made a swimmer look
    // like a float bobbing on a pond instead of someone driving themselves.
    if (swimming) {
      const whole = Math.floor(frame.stroke);
      const cycle = frame.stroke - whole;
      const kicking = cycle >= KICK_AT;
      const beat = kicking ? whole * 2 + 1 : cycle >= PULL_AT ? whole * 2 : whole * 2 - 1;
      if (beat !== lastBeat) {
        lastBeat = beat;
        ring(frame.x, frame.z, kicking ? 3.1 : 2.2, kicking ? 2.1 : 1.6);
        droplet(frame.x, frame.z, kicking ? 0.6 : 0.35);
      }
    } else if (wading && frame.speed > 1.5) {
      strokeTimer -= delta;
      if (strokeTimer <= 0) {
        strokeTimer = 0.34;
        ring(frame.x, frame.z, 1.7, 1.2);
      }
    }

    for (let i = 0; i < RIPPLES; i += 1) {
      if (ringAge[i] === Infinity) {
        scratch.set(0, level, 0);
        matrix.compose(scratch, flat, scale.set(0, 0, 0));
        rings.setMatrixAt(i, matrix);
        continue;
      }

      ringAge[i] += delta;
      const life = Math.min(1, ringAge[i] / ringLife[i]);
      if (life >= 1) ringAge[i] = Infinity;

      const radius = 0.35 + ringSpread[i] * life;
      scratch.set(ringX[i], level + 0.035, ringZ[i]);
      matrix.compose(scratch, flat, scale.set(radius, 1, radius));
      rings.setMatrixAt(i, matrix);

      const fade = (1 - life) ** 1.7 * 0.75 * (1 - night * 0.45);
      rings.setColorAt(i, fadeColour.setRGB(fade, fade, fade));
    }
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
    scale.set(1, 1, 1);

    // --- droplets ----------------------------------------------------------
    for (let i = 0; i < DROPLETS; i += 1) {
      const index = i * 3;
      if (dropAge[i] === Infinity) {
        scratch.set(0, level, 0);
        matrix.compose(scratch, flat, scale.set(0, 0, 0));
        drops.setMatrixAt(i, matrix);
        continue;
      }

      dropAge[i] += delta;
      dropVelocity[index + 1] -= 11 * delta;
      dropPosition[index] += dropVelocity[index] * delta;
      dropPosition[index + 1] += dropVelocity[index + 1] * delta;
      dropPosition[index + 2] += dropVelocity[index + 2] * delta;

      if (dropAge[i] > dropLife[i] || dropPosition[index + 1] < level) {
        dropAge[i] = Infinity;
        // One last ring where it fell back in, which is what sells a splash.
        if (dropPosition[index + 1] < level) ring(dropPosition[index], dropPosition[index + 2], 0.7, 0.8);
        continue;
      }

      scratch.set(dropPosition[index], dropPosition[index + 1], dropPosition[index + 2]);
      matrix.compose(scratch, flat, scale.set(1, 1, 1));
      drops.setMatrixAt(i, matrix);

      const fade = (1 - dropAge[i] / dropLife[i]) * (1 - night * 0.4);
      drops.setColorAt(i, fadeColour.setRGB(fade, fade, fade));
    }
    drops.instanceMatrix.needsUpdate = true;
    if (drops.instanceColor) drops.instanceColor.needsUpdate = true;

    // --- bow wave ----------------------------------------------------------
    const push = swimming ? Math.min(1, frame.speed / STROKE_SPEED) : 0;
    bowWave.visible = push > 0.05;
    if (bowWave.visible) {
      // Ahead of the walker's own point, because the body lies forward of it.
      bowWave.position.set(
        frame.x + Math.sin(frame.heading) * 0.95,
        level + 0.03,
        frame.z + Math.cos(frame.heading) * 0.95
      );
      bowWave.rotation.y = frame.heading;
      bowWave.scale.set(0.7 + push * 0.5, 1, 0.6 + push * 0.8);
    }

    // --- wake --------------------------------------------------------------
    if (swimming && Math.hypot(frame.x - trailLastX, frame.z - trailLastZ) > WAKE_STEP) {
      // Index 0 is always the newest sample, so the ribbon is a forward walk.
      trailX.copyWithin(1, 0, WAKE_SAMPLES - 1);
      trailZ.copyWithin(1, 0, WAKE_SAMPLES - 1);
      trailStrength.copyWithin(1, 0, WAKE_SAMPLES - 1);
      trailX[0] = frame.x;
      trailZ[0] = frame.z;
      trailStrength[0] = Math.min(1, frame.speed / STROKE_SPEED);
      trailLastX = frame.x;
      trailLastZ = frame.z;
    }

    let wakeVisible = false;
    for (let i = 0; i < WAKE_SAMPLES; i += 1) {
      trailStrength[i] = Math.max(0, trailStrength[i] - delta * 0.34);
      if (trailStrength[i] > 0.01) wakeVisible = true;

      const ahead = Math.max(0, i - 1);
      const behind = Math.min(WAKE_SAMPLES - 1, i + 1);
      let tangentX = trailX[ahead] - trailX[behind];
      let tangentZ = trailZ[ahead] - trailZ[behind];
      const length = Math.hypot(tangentX, tangentZ);
      if (length < 1e-4) {
        tangentX = 0;
        tangentZ = 1;
      } else {
        tangentX /= length;
        tangentZ /= length;
      }

      const sideX = tangentZ;
      const sideZ = -tangentX;
      const spread = 0.3 + (i / WAKE_SAMPLES) * 1.8;
      const fade = trailStrength[i] * (1 - i / WAKE_SAMPLES) * 0.5 * (1 - night * 0.4);
      const vertex = i * 9;
      const colour = i * 12;

      for (let edge = 0; edge < 3; edge += 1) {
        const across = (edge - 1) * spread;
        wakePositions[vertex + edge * 3] = trailX[i] + sideX * across;
        wakePositions[vertex + edge * 3 + 1] = level + 0.02;
        wakePositions[vertex + edge * 3 + 2] = trailZ[i] + sideZ * across;
        wakeColours[colour + edge * 4] = 1;
        wakeColours[colour + edge * 4 + 1] = 1;
        wakeColours[colour + edge * 4 + 2] = 1;
        wakeColours[colour + edge * 4 + 3] = edge === 1 ? fade : 0;
      }
    }
    wake.visible = wakeVisible;
    if (wakeVisible) {
      wakeGeometry.getAttribute('position').needsUpdate = true;
      wakeGeometry.getAttribute('color').needsUpdate = true;
    }

    // --- the lens --------------------------------------------------------
    const near = Math.min(1, Math.abs(frame.lens));
    band.visible = near < 1;
    if (band.visible) {
      band.position.set(camera.position.x, level, camera.position.z);
      bandMaterial.opacity = (1 - near) * 0.5 * (1 - night * 0.5);
    }

    const under = smoothstep(0.05, -0.5, frame.lens);
    tint.visible = under > 0.01;
    if (tint.visible) {
      faceLens(tint, camera, 2.6);
      tintMaterial.opacity = under * 0.62;
      tintMaterial.color.copy(deepColour).multiplyScalar(1 - night * 0.55);
    }

    // Droplets belong to the lens, not the body: they show when the camera has
    // been in the water, which in first person is whenever you are swimming.
    const lensWet = frame.wet * (1 - smoothstep(0.4, 1.3, frame.lens));
    lens.visible = lensWet > 0.02;
    if (lens.visible) {
      faceLens(lens, camera, 2.5);
      lensUniforms.uWet.value = lensWet;
      lensUniforms.uTime.value = elapsed;
    }
  };

  return {
    group,
    update,
    splash,
    setNight: (amount) => {
      night = Math.min(1, Math.max(0, amount));
    },
    dispose: () => {
      rings.dispose();
      drops.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      group.clear();
    },
  };
};
