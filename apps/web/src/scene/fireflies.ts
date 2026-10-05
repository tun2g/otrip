import type { LocationRecipe, Terrain } from '@otrip/world';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, type Material } from 'three';

import { styleOf } from './town-styles';

/** How far from the viewer fireflies are kept. They only read up close. */
const RADIUS = 55;
/** Metres the viewer may move before the swarm is laid out again. */
const RESTEP = 12;

const VERTEX_SHADER = /* glsl */ `
  attribute float aSeed;

  uniform float uTime;
  uniform float uPixelRatio;

  varying float vSeed;
  varying float vFade;

  void main() {
    vSeed = aSeed;

    // Each insect wanders its own slow loop around where it was placed, which
    // is cheaper and steadier than re-uploading positions every frame.
    vec3 drift = vec3(
      sin(uTime * 0.37 + aSeed * 31.0) * 1.9,
      sin(uTime * 0.53 + aSeed * 17.0) * 0.8,
      cos(uTime * 0.31 + aSeed * 43.0) * 1.9
    );

    vec4 world = modelMatrix * vec4(position + drift, 1.0);
    vec4 view = viewMatrix * world;
    gl_Position = projectionMatrix * view;

    float distance = -view.z;
    // Fade out before the far edge so they appear and vanish while out of
    // focus rather than popping at the boundary.
    vFade = 1.0 - smoothstep(${(RADIUS * 0.6).toFixed(1)}, ${RADIUS.toFixed(1)}, distance);
    gl_PointSize = (140.0 * uPixelRatio) / max(distance, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uNight;

  varying float vSeed;
  varying float vFade;

  void main() {
    // A soft disc, brightest in the middle; a square point gives the whole
    // thing away.
    float radius = length(gl_PointCoord - 0.5) * 2.0;
    if (radius > 1.0) discard;
    float core = pow(1.0 - radius, 2.6);

    // Pulse, not blink: on for a moment, off for most of a second.
    float blink = pow(max(sin(uTime * 2.1 + vSeed * 47.0), 0.0), 7.0);
    float glow = core * (0.12 + blink * 0.88) * vFade * uNight;

    gl_FragColor = vec4(mix(vec3(0.72, 1.0, 0.42), vec3(1.0, 0.96, 0.62), blink) * glow, glow);
  }
`;

export type Fireflies = {
  points: Points;
  /** Re-seeds the swarm around a point. Cheap enough to call as you walk. */
  follow: (x: number, z: number) => void;
  update: (elapsed: number, night: number) => void;
  dispose: () => void;
};

/**
 * Đom đóm. Dusk in a Vietnamese valley has them, and they do something no
 * static light can: they tell you the air between you and the trees is a
 * volume, not a backdrop.
 */
export const createFireflies = (terrain: Terrain, recipe: LocationRecipe, count: number): Fireflies => {
  const waterLevel = recipe.water?.level ?? Number.NEGATIVE_INFINITY;
  const treeLine = recipe.scatter.treeLine;
  /**
   * Đom đóm are gone from inner-city Hanoi — light and drained ground took them
   * — and this module was lighting 384 of them over Tây Hồ because it only ever
   * asked about water and the tree line. It is a keep-out rather than a switch:
   * walk out past the last block and they come back, which is both true of the
   * city's edge and the only version of this that does not simply delete a thing
   * from one of the four nights.
   *
   * 0.75 of `spread` because `spread` is how far the planner is allowed to look,
   * not how far it built: measured at Hồ Tây the 105 houses reach 1469m against a
   * spread of 1995m, a ratio of 0.74. Taking the whole of `spread` would reach
   * 1995m of a 2100m half-extent and leave nowhere outside it, which is deletion
   * wearing a keep-out's clothes.
   */
  const builtUp = styleOf(recipe) === 'city' ? (recipe.town?.spread ?? 0) * (terrain.size / 2) * 0.75 : 0;

  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i += 1) seeds[i] = Math.random();

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  // The swarm moves with the viewer, so a bounding sphere computed once is
  // always wrong; skipping the frustum test is both cheaper and correct.
  geometry.boundingSphere = null;

  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uNight: { value: 0 },
      uPixelRatio: { value: typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });

  const points = new Points(geometry, material);
  points.name = 'fireflies';
  points.frustumCulled = false;
  points.visible = false;

  let lastX = Infinity;
  let lastZ = Infinity;

  const follow = (centreX: number, centreZ: number) => {
    if (Math.hypot(centreX - lastX, centreZ - lastZ) < RESTEP) return;
    lastX = centreX;
    lastZ = centreZ;

    const half = terrain.size / 2;

    for (let i = 0; i < count; i += 1) {
      // Polar placement, biased outward so the density is even across the disc
      // rather than piling up on top of the viewer.
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * RADIUS;
      const x = Math.min(half, Math.max(-half, centreX + Math.cos(angle) * distance));
      const z = Math.min(half, Math.max(-half, centreZ + Math.sin(angle) * distance));

      const ground = terrain.heightAt(x, z);
      // They live in the vegetation: over water or above the tree line there
      // are none, and a bare rock face has none either.
      const bare =
        ground <= waterLevel + 0.3 ||
        ground > treeLine * 1.25 ||
        terrain.slopeAt(x, z) > 1.3 ||
        (builtUp > 0 && Math.hypot(x, z) < builtUp);

      positions[i * 3] = x;
      positions[i * 3 + 1] = bare ? -10_000 : ground + 0.5 + Math.random() * 3.2;
      positions[i * 3 + 2] = z;
    }

    geometry.attributes.position.needsUpdate = true;
  };

  return {
    points,
    follow,
    update: (elapsed, night) => {
      material.uniforms.uTime.value = elapsed;
      // Dusk is their hour; they thin out in the dead of night and are gone by
      // day, so the swarm follows the light rather than a clock.
      const strength = Math.min(1, Math.max(0, night * 1.6)) * (1 - Math.max(0, night - 0.75) * 1.6);
      material.uniforms.uNight.value = Math.max(0, strength);
      points.visible = material.uniforms.uNight.value > 0.02;
    },
    dispose: () => {
      geometry.dispose();
      (material as Material).dispose();
    },
  };
};
