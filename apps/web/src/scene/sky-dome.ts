import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';

import type { ResolvedSky } from './sky-palette';

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldDirection;

  void main() {
    vWorldDirection = normalize((modelMatrix * vec4(position, 1.0)).xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunCore;
  uniform vec3 uSunGlow;
  uniform vec3 uBelow;
  uniform vec3 uSunDirection;
  uniform float uSunVisibility;
  uniform float uNight;
  uniform float uOcclusion;
  uniform float uTime;

  varying vec3 vWorldDirection;

  /** Where the Milky Way crosses the sky. Tilted so it arcs overhead. */
  const vec3 GALACTIC_POLE = vec3(0.4472, 0.6261, -0.6396);

  // Cheap stable hash, so a star keeps its place instead of boiling.
  float hash(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  /** Smoothed value noise; two octaves are enough for cloudy starlight. */
  float valueNoise(vec3 p) {
    vec3 cell = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n00 = mix(hash(cell + vec3(0.0, 0.0, 0.0)), hash(cell + vec3(1.0, 0.0, 0.0)), f.x);
    float n10 = mix(hash(cell + vec3(0.0, 1.0, 0.0)), hash(cell + vec3(1.0, 1.0, 0.0)), f.x);
    float n01 = mix(hash(cell + vec3(0.0, 0.0, 1.0)), hash(cell + vec3(1.0, 0.0, 1.0)), f.x);
    float n11 = mix(hash(cell + vec3(0.0, 1.0, 1.0)), hash(cell + vec3(1.0, 1.0, 1.0)), f.x);

    return mix(mix(n00, n10, f.y), mix(n01, n11, f.y), f.z);
  }

  /**
   * The Milky Way: a band of unresolved starlight with dark dust lanes through
   * it. Without it the night sky is an even scatter of dots, which is the one
   * thing a real sky never looks like.
   */
  vec3 milkyWay(vec3 dir, float night) {
    float band = 1.0 - smoothstep(0.0, 0.30, abs(dot(dir, GALACTIC_POLE)));
    if (band <= 0.001) return vec3(0.0);

    float clouds = valueNoise(dir * 9.0) * 0.6 + valueNoise(dir * 23.0) * 0.4;
    // Dust lanes are what give the band its shape; squaring the gaps deepens them.
    float dust = smoothstep(0.30, 0.78, clouds);
    vec3 tint = mix(vec3(0.30, 0.36, 0.56), vec3(0.64, 0.60, 0.66), clouds);

    return tint * band * band * dust * night * 0.16 * smoothstep(-0.02, 0.22, dir.y);
  }

  /** A field of stars that fades in as the sun goes down. */
  vec3 starField(vec3 dir, float night, float time) {
    if (night <= 0.001 || dir.y < -0.05) return vec3(0.0);

    vec3 cell = floor(dir * 320.0);
    float pick = hash(cell);
    // Only a small fraction of cells carry a star, otherwise the sky is noise.
    // Stars crowd toward the galactic plane, as they do in a real sky.
    float crowding = 1.0 - smoothstep(0.0, 0.34, abs(dot(dir, GALACTIC_POLE)));
    if (pick < 0.9972 - crowding * 0.0016) return vec3(0.0);

    vec3 centre = (cell + 0.5) / 320.0;
    float closeness = 1.0 - smoothstep(0.0, 0.0021, length(normalize(centre) - dir));
    // A real sky is a handful of bright stars among very many faint ones. An
    // even field of equally bright dots reads as grain however sparse it is.
    float magnitude = 0.16 + 0.84 * pow(hash(cell + 3.3), 2.6);
    float twinkle = 0.65 + 0.35 * sin(time * 2.1 + pick * 90.0);
    // Warm and cool stars, and none right at the horizon where haze eats them.
    vec3 tint = mix(vec3(0.75, 0.84, 1.0), vec3(1.0, 0.92, 0.78), hash(cell + 7.0));
    return tint * closeness * magnitude * twinkle * night * smoothstep(-0.02, 0.25, dir.y);
  }

  /**
   * One meteor at a time, and most cycles pass without any. The point is that
   * someone sitting still long enough is rewarded, not that the sky is busy.
   */
  vec3 shootingStar(vec3 dir, float night, float time) {
    if (night <= 0.05) return vec3(0.0);

    float cycle = 11.0;
    float epoch = floor(time / cycle);
    float t = fract(time / cycle);
    if (t > 0.26) return vec3(0.0);
    if (hash(vec3(epoch, 11.0, 3.0)) < 0.5) return vec3(0.0);

    vec3 from = normalize(vec3(
      hash(vec3(epoch, 1.0, 2.0)) * 2.0 - 1.0,
      0.28 + hash(vec3(epoch, 5.0, 9.0)) * 0.66,
      hash(vec3(epoch, 8.0, 4.0)) * 2.0 - 1.0
    ));
    vec3 to = normalize(from + vec3(
      hash(vec3(epoch, 3.0, 7.0)) - 0.5,
      -0.42,
      hash(vec3(epoch, 6.0, 1.0)) - 0.5
    ) * 0.85);

    float progress = clamp(t / 0.22, 0.0, 1.0);
    vec3 head = normalize(mix(from, to, progress));
    vec3 tail = normalize(mix(from, to, max(0.0, progress - 0.13)));

    // Distance from the view direction to the tail→head chord.
    vec3 segment = head - tail;
    float along = clamp(dot(dir - tail, segment) / max(dot(segment, segment), 1e-5), 0.0, 1.0);
    float offset = length(dir - (tail + segment * along));

    float core = 1.0 - smoothstep(0.0, 0.0045, offset);
    // Brightest at the head, thinning down the tail, and gone by the end.
    float streak = along * along * (1.0 - smoothstep(0.18, 0.26, t));
    return vec3(1.0, 0.96, 0.86) * core * streak * night * 1.8;
  }

  void main() {
    vec3 dir = normalize(vWorldDirection);

    // Tight horizon band so a sunrise reads as a line rather than a wash.
    vec3 sky = mix(uHorizon, uZenith, pow(clamp(dir.y, 0.0, 1.0), 0.45));

    // Below the horizon the dome used to stay sunrise-orange, which read as a
    // lit plain behind the mountains. Fading it to the cloud colour instead
    // lets the modelled cloud sea continue into the distance unbroken.
    sky = mix(sky, uBelow, clamp(-dir.y * 7.0, 0.0, 1.0));

    // Cloud hides what is behind it. The disc goes first and hardest, the glow
    // survives as a diffuse brightening — which is exactly what an overcast sky
    // with the sun somewhere behind it looks like.
    float clear = 1.0 - uOcclusion;
    float sun = max(dot(dir, normalize(uSunDirection)), 0.0);
    sky += uSunGlow * pow(sun, 24.0) * 0.9 * uSunVisibility * (0.3 + 0.7 * clear);
    sky += uSunCore * pow(sun, 420.0) * uSunVisibility * clear * clear;

    // Stars are faint and go behind the thinnest veil; the moon burns through
    // longer; under a rain deck there is nothing up there at all.
    float starlight = uNight * pow(clear, 1.7);
    if (starlight > 0.001) {
      sky += milkyWay(dir, starlight);
      sky += starField(dir, starlight, uTime);
      sky += shootingStar(dir, starlight, uTime);
    }

    if (uNight > 0.001) {
      // The moon sits opposite the sun, so it is up exactly when the sun is not.
      vec3 moonDir = -normalize(uSunDirection);
      float moon = max(dot(dir, moonDir), 0.0);
      float moonlight = uNight * clear;
      sky += vec3(0.62, 0.70, 0.88) * pow(moon, 110.0) * 0.46 * uNight * (0.25 + 0.75 * clear);
      // Disc radius just under a degree. Wider than this and it stops reading
      // as the moon and starts reading as a lamp.
      sky += vec3(1.0, 0.98, 0.92) * smoothstep(0.99982, 0.99991, moon) * 3.0 * moonlight;
    }

    gl_FragColor = vec4(sky, 1.0);
  }
`;

export type SkyDome = {
  mesh: Mesh;
  /** A second dome on the same material, for generating the environment map. */
  environmentMesh: Mesh;
  update: (
    colors: ResolvedSky,
    sunDirection: Vector3,
    sunVisibility: number,
    night: number,
    /** 0 clear .. 1 total cloud. Hides the sun disc, the moon and the stars. */
    occlusion: number
  ) => void;
  tick: (elapsed: number) => void;
  dispose: () => void;
};

export const createSkyDome = (radius: number): SkyDome => {
  const material = new ShaderMaterial({
    uniforms: {
      uZenith: { value: new Color() },
      uHorizon: { value: new Color() },
      uSunCore: { value: new Color() },
      uSunGlow: { value: new Color() },
      uBelow: { value: new Color() },
      uSunDirection: { value: new Vector3(0, 1, 0) },
      uSunVisibility: { value: 1 },
      uNight: { value: 0 },
      uOcclusion: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });

  const geometry = new SphereGeometry(radius, 32, 16);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky-dome';
  mesh.frustumCulled = false;

  // Shares the material, so the environment map always matches the sky on screen.
  const environmentMesh = new Mesh(new SphereGeometry(10, 24, 12), material);
  environmentMesh.frustumCulled = false;

  return {
    mesh,
    environmentMesh,
    tick: (elapsed) => {
      material.uniforms.uTime.value = elapsed;
    },
    update: (colors, sunDirection, sunVisibility, night, occlusion) => {
      material.uniforms.uZenith.value.copy(colors.zenith);
      material.uniforms.uHorizon.value.copy(colors.horizon);
      material.uniforms.uSunCore.value.copy(colors.sunCore);
      material.uniforms.uSunGlow.value.copy(colors.sunGlow);
      material.uniforms.uBelow.value.copy(colors.cloudLit);
      material.uniforms.uSunDirection.value.copy(sunDirection);
      material.uniforms.uSunVisibility.value = sunVisibility;
      material.uniforms.uNight.value = night;
      material.uniforms.uOcclusion.value = occlusion;
    },
    dispose: () => {
      geometry.dispose();
      environmentMesh.geometry.dispose();
      material.dispose();
    },
  };
};
