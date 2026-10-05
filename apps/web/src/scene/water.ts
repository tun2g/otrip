import type { Terrain, WaterParams } from '@otrip/world';
import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  RGBAFormat,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';

import type { ResolvedSky } from './sky-palette';

/**
 * The heightfield as a texture. The water shader reads it to find its own
 * shoreline, so a carved river channel becomes a river and a basin becomes a
 * lake without anyone drawing either. Stored as 8-bit normalised rather than
 * float because linear filtering of float textures is not universally available,
 * and a metre of precision is finer than the shore needs.
 */
const createHeightTexture = (terrain: Terrain): { texture: DataTexture; min: number; range: number } => {
  const side = terrain.segments + 1;
  let min = Infinity;
  let max = -Infinity;
  for (const height of terrain.heights) {
    if (height < min) min = height;
    if (height > max) max = height;
  }
  const range = Math.max(1, max - min);

  const data = new Uint8Array(side * side * 4);
  for (let i = 0; i < terrain.heights.length; i += 1) {
    const normalised = Math.round(((terrain.heights[i] - min) / range) * 255);
    data[i * 4] = normalised;
    data[i * 4 + 3] = 255;
  }

  const texture = new DataTexture(data, side, side, RGBAFormat);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return { texture, min, range };
};

const VERTEX_SHADER = /* glsl */ `
  #include <fog_pars_vertex>

  varying vec3 vWorld;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  #include <fog_pars_fragment>

  uniform sampler2D uHeight;
  uniform float uHalfSize;
  uniform float uMinHeight;
  uniform float uHeightRange;
  uniform float uLevel;
  uniform float uTime;
  uniform float uRipple;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uSky;
  uniform vec3 uSunColor;
  uniform vec3 uSunDirection;
  uniform float uNight;
  uniform float uLight;

  varying vec3 vWorld;

  float hash12(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }

  void main() {
    vec2 uv = (vWorld.xz + uHalfSize) / (2.0 * uHalfSize);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;

    float ground = uMinHeight + texture2D(uHeight, uv).r * uHeightRange;
    float depth = uLevel - ground;
    if (depth <= 0.0) discard;

    // Three crossing swells rather than a normal map: no texture to ship, and
    // the slope falls straight out of the derivative.
    float slopeX = cos(vWorld.x * 0.08 + uTime * 0.8) * 0.08 + cos((vWorld.x + vWorld.z) * 0.045 + uTime * 1.1) * 0.05;
    float slopeZ = cos(vWorld.z * 0.065 - uTime * 0.6) * 0.07 + cos((vWorld.x + vWorld.z) * 0.045 + uTime * 1.1) * 0.05;
    vec3 normal = normalize(vec3(-slopeX * uRipple, 1.0, -slopeZ * uRipple));

    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);

    vec3 base = mix(uShallow, uDeep, clamp(depth / 26.0, 0.0, 1.0));
    // A pale band where the water runs out, which is what makes a shoreline read.
    base = mix(base, vec3(1.0), (1.0 - smoothstep(0.0, 3.0, depth)) * 0.5);
    // Body colour is albedo, not emission. Without this the river kept its
    // midday turquoise after dark and glowed against an unlit landscape.
    base *= uLight;

    vec3 halfway = normalize(normalize(uSunDirection) + viewDir);
    float specular = pow(max(dot(normal, halfway), 0.0), 200.0);

    // The moon sits opposite the sun, so after dark it lays a path across the
    // water. A broader lobe than the sun's, because a rough surface scatters a
    // dim source over a wider angle — that spread is the path.
    vec3 moonDir = -normalize(uSunDirection);
    vec3 moonHalf = normalize(moonDir + viewDir);
    // A tight lobe. At 36 the path spread across the whole foreground and read
    // as fog on the water rather than as a reflection of one small bright disc.
    float moonSpec = pow(max(dot(normal, moonHalf), 0.0), 120.0);

    // Sparkle: individual wavelets catching the light. Quantised in space and
    // flickering in time, so it reads as glitter rather than a smooth sheen.
    vec2 glintCell = floor(vWorld.xz * 1.6 + vec2(uTime * 0.6, uTime * 0.35));
    float glint = step(0.93, hash12(glintCell)) * (0.5 + 0.5 * sin(uTime * 7.0 + hash12(glintCell) * 42.0));
    float glintMask = pow(max(dot(normal, moonHalf), 0.0), 26.0);

    vec3 moonlight = vec3(0.78, 0.86, 1.0) * (moonSpec * 1.6 + glint * glintMask * 0.9) * uNight;

    gl_FragColor = vec4(base + uSky * fresnel * 0.4 + uSunColor * specular * 1.8 + moonlight, 1.0);
    #include <fog_fragment>
  }
`;

export type Water = {
  mesh: Mesh;
  applySky: (
    colors: ResolvedSky,
    sunDirection: Vector3,
    /** How much moonlight actually lands: night, minus whatever cloud blocks. */
    night: number,
    /** 0..1 how much light is reaching the surface. Scales the body colour. */
    light: number
  ) => void;
  update: (elapsed: number) => void;
  dispose: () => void;
};

export const createWater = (terrain: Terrain, params: WaterParams): Water => {
  const { texture, min, range } = createHeightTexture(terrain);

  // A hand-written ShaderMaterial with `fog: true` still has to carry the fog
  // uniforms itself: the renderer writes straight into them and throws if they
  // are missing. Cloning keeps this material's fog independent of every other.
  const uniforms = Object.assign(UniformsUtils.clone(UniformsLib.fog), {
    uHeight: { value: texture },
    uHalfSize: { value: terrain.size / 2 },
    uMinHeight: { value: min },
    uHeightRange: { value: range },
    uLevel: { value: params.level },
    uTime: { value: 0 },
    uRipple: { value: params.ripple },
    uDeep: { value: new Color(params.deep) },
    uShallow: { value: new Color(params.shallow) },
    uSky: { value: new Color('#ffffff') },
    uSunColor: { value: new Color('#ffffff') },
    uSunDirection: { value: new Vector3(0, 1, 0) },
    uNight: { value: 0 },
    uLight: { value: 1 },
  });

  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    fog: true,
  });

  const geometry = new PlaneGeometry(terrain.size, terrain.size);
  geometry.rotateX(-Math.PI / 2);

  const mesh = new Mesh(geometry, material);
  mesh.name = 'water';
  mesh.position.y = params.level;

  return {
    mesh,
    applySky: (colors, sunDirection, night, light) => {
      material.uniforms.uSky.value.copy(colors.horizon);
      material.uniforms.uSunColor.value.copy(colors.sunCore);
      material.uniforms.uSunDirection.value.copy(sunDirection);
      material.uniforms.uNight.value = night;
      material.uniforms.uLight.value = light;
    },
    update: (elapsed) => {
      material.uniforms.uTime.value = elapsed;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
};
