import { createPrng, type LocationRecipe, type Terrain } from '@otrip/world';
import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector2, Vector3 } from 'three';

import type { ResolvedSky } from './sky-palette';

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorld;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uSunDirection;
  uniform vec3 uSunLight;
  uniform vec3 uMoonLight;
  uniform vec3 uCloudLit;
  uniform vec3 uCloudShadow;
  uniform vec3 uHaze;
  uniform vec2 uDrift;
  uniform vec2 uWindAxis;
  uniform float uDaylight;
  uniform float uBaseY;
  uniform float uThickness;
  uniform float uCover;
  uniform float uStratus;
  uniform float uCirrus;
  uniform float uCirrusY;
  uniform float uRain;
  uniform float uTime;
  uniform float uMaxDistance;
  uniform float uHazeFalloff;

  varying vec3 vWorld;

  /** Extinction per metre of solid cloud. At this value 300 m is nearly opaque. */
  const float SIGMA = 0.0042;
  /** How far toward the sun the single shadow sample reaches, in metres. */
  const float SHADOW_REACH = 290.0;
  /** Feature scale: one unit of noise space is about 2.4 km of sky. */
  const float FIELD = 0.00042;

  float hash(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

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

  /** Henyey–Greenstein, normalised so isotropic scattering reads 1.0. */
  float henyey(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1.0e-4), 1.5);
  }

  /** World metres into the drifting noise frame the cloud field lives in. */
  vec3 field(vec3 p) {
    vec3 q = p * FIELD;
    // Sampling further upwind as time passes is what carries the deck downwind.
    q.xz -= uDrift * uTime * FIELD;
    // Clouds are far wider than they are deep, so the vertical axis is stretched.
    q.y *= 2.3;
    return q;
  }

  /**
   * The vertical envelope is what separates one cloud type from another: cumulus
   * keeps a flat base and builds upward, stratus is a thin sheet lying on it.
   */
  float envelopeAt(float height) {
    float cumulus = smoothstep(0.0, 0.09, height) * (1.0 - smoothstep(0.32, 1.0, height));
    float stratus = smoothstep(0.0, 0.08, height) * (1.0 - smoothstep(0.45, 0.95, height));
    return mix(cumulus, stratus, uStratus);
  }

  /**
   * The bar the noise has to clear. Raising it with height is what builds a
   * tower: only the densest cores get that high, so a wide flat base narrows
   * into cauliflower instead of extruding straight up.
   */
  float barAt(float height, float cover) {
    return mix(1.02, 0.30, cover) + height * 0.30 * (1.0 - uStratus);
  }

  float cloudDensity(vec3 p, float height, float cover) {
    vec3 q = field(p);
    float shape = valueNoise(q) * 0.5714 + valueNoise(q * 2.07) * 0.2857 + valueNoise(q * 4.21) * 0.1429;
    float bar = barAt(height, cover);
    float raw = shape * envelopeAt(height) - bar;
    if (raw <= 0.0) return 0.0;

    // The detail octaves run on their own clock so the edges churn while the
    // silhouette holds. A field that only scrolls reads as wallpaper.
    vec3 d = q * 9.4 + vec3(0.0, uTime * 0.013, uTime * 0.007);
    float detail = valueNoise(d) * 0.66 + valueNoise(d * 2.3) * 0.34;

    return clamp(
      raw / max(1.0 - bar, 0.10) - detail * 0.36 * (0.22 + 0.78 * height) * (1.0 - uStratus * 0.55),
      0.0,
      1.0
    );
  }

  /** Two octaves is enough to ask whether cloud stands between a point and the sun. */
  float shadowDensity(vec3 p, float height, float cover) {
    vec3 q = field(p);
    float shape = valueNoise(q) * 0.6667 + valueNoise(q * 2.07) * 0.3333;
    return max(shape * envelopeAt(height) - barAt(height, cover), 0.0);
  }

  /**
   * Cover is neither even across the sky nor steady. A very large, very slow
   * swell thickens one part of the deck while another thins out, which is what
   * makes a sky look like it is building rather than sliding past.
   */
  float coverAt(vec3 p) {
    vec2 q = (p.xz - uDrift * uTime) * 0.000052;
    return clamp(uCover + (valueNoise(vec3(q, uTime * 0.0032)) - 0.5) * 0.32, 0.0, 1.0);
  }

  /**
   * The 22° halo. Hexagonal ice bends light through a minimum of 21.8°, so a
   * ring that size stands around the sun whenever there is cirrus in the way —
   * red on the inside, because red bends least.
   */
  vec3 halo(float cosSun, float sunUp) {
    float offset = cosSun - 0.9283;
    float ring = smoothstep(0.0050, 0.0, abs(offset));
    if (ring <= 0.0) return vec3(0.0);

    vec3 tint = mix(vec3(0.70, 0.83, 1.0), vec3(1.0, 0.68, 0.42), smoothstep(-0.0028, 0.0028, offset));
    return tint * ring * ring * sunUp * 1.5;
  }

  /** Red at 0, violet at 1. Three lobes is plenty for an arc two degrees wide. */
  vec3 spectral(float x) {
    return vec3(
      exp(-x * x * 7.0) + exp(-(x - 1.0) * (x - 1.0) * 24.0) * 0.4,
      exp(-(x - 0.44) * (x - 0.44) * 13.0),
      exp(-(x - 0.86) * (x - 0.86) * 11.0)
    );
  }

  /**
   * A rainbow stands 42° from the point opposite the sun. No elevation test is
   * needed: once the sun climbs past 42° that whole arc has sunk below the
   * horizon on its own, which is why bows belong to morning and late afternoon.
   * Emissive — it is light in clear air, so it adds without adding opacity.
   */
  vec3 rainbow(vec3 dir, vec3 sunDir, float sunUp) {
    if (uRain <= 0.01 || dir.y < 0.0) return vec3(0.0);

    float cosAnti = dot(dir, -sunDir);
    // Primary bow: violet at 40.5°, red at 42.4°.
    float x = (cosAnti - 0.73846) / 0.02195;
    float primary = smoothstep(-0.10, 0.08, x) * (1.0 - smoothstep(0.92, 1.10, x));
    // Secondary at 50.4°–53.4°, much fainter and with the colours reversed.
    float y = (cosAnti - 0.59622) / 0.04121;
    float secondary = smoothstep(-0.10, 0.08, y) * (1.0 - smoothstep(0.92, 1.10, y));
    if (primary + secondary <= 0.0) return vec3(0.0);

    vec3 bow = spectral(clamp(x, 0.0, 1.0)) * primary + spectral(clamp(1.0 - y, 0.0, 1.0)) * secondary * 0.3;
    // It needs rain to refract in and sun to light it; an overcast sky has neither.
    float lit = uRain * sunUp * (1.0 - smoothstep(0.78, 0.98, uCover)) * smoothstep(0.0, 0.08, dir.y);
    return bow * lit * 0.34;
  }

  /**
   * Cirrus is ice at seven kilometres. One plane sample is not a shortcut here:
   * the real thing is a sheet with no depth worth marching through.
   * Returns premultiplied colour in rgb.
   */
  vec4 cirrusLayer(vec3 dir, float cosSun, float sunUp) {
    if (uCirrus <= 0.01 || dir.y < 0.015) return vec4(0.0);

    float distance = (uCirrusY - cameraPosition.y) / dir.y;
    if (distance <= 0.0) return vec4(0.0);

    vec2 at = (cameraPosition.xz + dir.xz * distance - uDrift * uTime * 1.9) * 0.00011;
    // Drawn out along the wind: a long wavelength downwind against a short one
    // across it is the whole look of a cirrus streak.
    vec2 across = vec2(-uWindAxis.y, uWindAxis.x);
    vec2 q = vec2(dot(at, uWindAxis) * 0.24, dot(at, across) * 2.5);

    float sheet =
      valueNoise(vec3(q, uTime * 0.004)) * 0.60 +
      valueNoise(vec3(q * 2.9, uTime * 0.0065)) * 0.27 +
      valueNoise(vec3(q * 6.7, 0.0)) * 0.13;

    float bar = mix(0.88, 0.34, uCirrus);
    float amount = clamp((sheet - bar) / max(1.0 - bar, 0.12), 0.0, 1.0);
    if (amount <= 0.0) return vec4(0.0);

    // Ice forward-scatters hard, so the sheet whitens toward the sun.
    float forward = pow(max(cosSun, 0.0), 7.0);
    vec3 colour = uCloudLit * (0.9 + 0.5 * uDaylight) + uSunLight * forward * 0.8 + halo(cosSun, sunUp);

    // A thin sheet seen edge-on is optically far thicker than one seen flat.
    float opacity = amount * 0.58 * mix(1.0, 2.3, 1.0 - smoothstep(0.015, 0.55, dir.y));
    opacity = clamp(opacity * (0.30 + 0.70 * uDaylight), 0.0, 0.92);

    float haze = 1.0 - exp(-min(distance, uMaxDistance) * uHazeFalloff);
    return vec4(mix(colour * opacity, uHaze * opacity, haze), opacity);
  }

#if DAY_CLOUD_STEPS == 0
  /**
   * The lowest tier gets one plane and two octaves instead of a march. Shading
   * comes from comparing the field here against a point toward the sun, which is
   * a cheap stand-in for a shadow ray and still gives lit flanks and dark bases.
   */
  vec4 deckLayer(vec3 dir, vec3 sunDir, float cosSun) {
    if (dir.y < 0.012) return vec4(0.0);

    float distance = (uBaseY + uThickness * 0.32 - cameraPosition.y) / dir.y;
    if (distance <= 0.0) return vec4(0.0);

    vec3 p = cameraPosition + dir * distance;
    float cover = coverAt(p);
    float bar = mix(1.0, 0.34, cover);

    vec3 q = field(p);
    float shape = valueNoise(q) * 0.65 + valueNoise(q * 2.4) * 0.35;
    float density = clamp((shape - bar) / max(1.0 - bar, 0.10), 0.0, 1.0);
    if (density <= 0.0) return vec4(0.0);

    vec3 toward = field(p + sunDir * 900.0);
    float ahead = valueNoise(toward) * 0.65 + valueNoise(toward * 2.4) * 0.35;
    float sunlight = clamp(1.0 - (ahead - bar) * 2.4, 0.0, 1.0);

    vec3 colour =
      mix(uCloudShadow, uCloudLit, 0.35 + 0.65 * sunlight) +
      uSunLight * sunlight * mix(henyey(cosSun, 0.16), henyey(cosSun, 0.74), 0.22) * 0.55 +
      uMoonLight * sunlight;

    float opacity = clamp(
      pow(density, 0.8) * 0.92 * mix(1.0, 1.6, 1.0 - smoothstep(0.012, 0.5, dir.y)),
      0.0,
      0.97
    );

    float haze = 1.0 - exp(-min(distance, uMaxDistance) * uHazeFalloff);
    return vec4(mix(colour * opacity, uHaze * opacity, haze), opacity);
  }
#else
  /** The low and mid deck, marched. Returns premultiplied colour in rgb. */
  vec4 deckLayer(vec3 dir, vec3 sunDir, float cosSun) {
    // Near the horizontal the slab is thousands of kilometres deep and the
    // quotients below overflow, so leave that sliver to the haze.
    if (abs(dir.y) < 0.004) return vec4(0.0);

    float toBase = (uBaseY - cameraPosition.y) / dir.y;
    float toTop = (uBaseY + uThickness - cameraPosition.y) / dir.y;
    // The near clamp keeps anything opaque off the lens: the camera can orbit up
    // into the deck, and a sample at zero distance fills the screen with grey.
    float enter = max(min(toBase, toTop), 240.0);
    float exit = min(max(toBase, toTop), uMaxDistance);
    if (exit <= enter) return vec4(0.0);

    float dt = (exit - enter) / float(DAY_CLOUD_STEPS);
    // A stable per-pixel offset. At this few steps the slab's edges would
    // otherwise show as concentric rings around the view direction.
    float t = enter + dt * hash(vec3(gl_FragCoord.xy, 7.0));

    // The cover swell is far coarser than the march, so two samples and a lerp
    // cover it instead of one per step.
    float coverNear = coverAt(cameraPosition + dir * enter);
    float coverFar = coverAt(cameraPosition + dir * exit);

    // The forward lobe is the silver lining: looking through a thin edge toward
    // the sun, almost everything scattered comes straight at you. Weighted so
    // only that rim crosses the bloom threshold.
    float phase = mix(henyey(cosSun, 0.16), henyey(cosSun, 0.74), 0.26);
    float moonForward = pow(max(-cosSun, 0.0), 6.0);

    vec3 scattered = vec3(0.0);
    float transmittance = 1.0;
    float depth = 0.0;
    float depthWeight = 0.0;

    for (int i = 0; i < DAY_CLOUD_STEPS; i += 1) {
      if (transmittance < 0.02) break;

      vec3 p = cameraPosition + dir * t;
      float height = clamp((p.y - uBaseY) / uThickness, 0.0, 1.0);
      float cover = mix(coverNear, coverFar, float(i) / float(DAY_CLOUD_STEPS));
      float density = cloudDensity(p, height, cover);

      if (density > 0.004) {
        vec3 toward = p + sunDir * SHADOW_REACH;
        float towardHeight = clamp((toward.y - uBaseY) / uThickness, 0.0, 1.0);
        float sunlight = exp(-shadowDensity(toward, towardHeight, cover) * SHADOW_REACH * SIGMA * 7.0);
        // Multiple scattering: deep inside a cloud the light has been turned
        // around many times before it reaches the eye. Without this a thick base
        // reads as flat grey paint rather than as something with a volume.
        float powder = 1.0 - exp(-density * 7.0);

        vec3 light =
          mix(uCloudShadow, uCloudLit, height) +
          uSunLight * sunlight * phase * mix(0.38, 1.0, powder) +
          uMoonLight * sunlight * (0.4 + 0.6 * height + moonForward * 0.8);

        float stepTransmittance = exp(-density * SIGMA * dt);
        float absorbed = transmittance * (1.0 - stepTransmittance);
        scattered += light * absorbed;
        depth += t * absorbed;
        depthWeight += absorbed;
        transmittance *= stepTransmittance;
      }

      t += dt;
    }

    float opacity = 1.0 - transmittance;
    if (opacity < 0.002) return vec4(0.0);

    // Aerial perspective. Cloud thirty kilometres out is seen through thirty
    // kilometres of air and has to settle into the horizon, or the deck ends in
    // a hard bright rim where it runs out.
    float haze = 1.0 - exp(-(depthWeight > 0.0 ? depth / depthWeight : exit) * uHazeFalloff);
    return vec4(mix(scattered, uHaze * opacity, haze), opacity);
  }
#endif

  void main() {
    vec3 dir = normalize(vWorld - cameraPosition);
    vec3 sunDir = normalize(uSunDirection);
    float cosSun = dot(dir, sunDir);
    float sunUp = smoothstep(-0.03, 0.10, sunDir.y);

    // Composited far to near: optics in clear air, then the cirrus sheet above,
    // then the deck below it. Premultiplied throughout, so the purely emissive
    // terms carry no opacity of their own.
    vec3 rgb = rainbow(dir, sunDir, sunUp);
    float alpha = 0.0;

    vec4 cirrus = cirrusLayer(dir, cosSun, sunUp);
    rgb = cirrus.rgb + rgb * (1.0 - cirrus.a);
    alpha = cirrus.a;

    vec4 deck = deckLayer(dir, sunDir, cosSun);
    rgb = deck.rgb + rgb * (1.0 - deck.a);
    alpha = deck.a + alpha * (1.0 - deck.a);

    gl_FragColor = vec4(rgb, alpha);
  }
`;

/**
 * Open-Meteo's cloud fields, as fractions of 100. Only `cloudCover` is required:
 * when the forecast carries no split, whatever cover the low deck cannot account
 * for has to be sitting above it, and that is what the layers are derived from.
 */
export type DayCloudConditions = {
  cloudCover: number;
  cloudCoverLow?: number;
  cloudCoverMid?: number;
  cloudCoverHigh?: number;
  /** km/h at 10 m. */
  windSpeed?: number;
  /** Degrees the wind blows *from*; a seeded bearing stands in when it is absent. */
  windBearing?: number;
  /** 0 dry .. 1 raining. Drives the rainbow and flattens the deck into nimbostratus. */
  rain?: number;
};

export type DayClouds = {
  mesh: Mesh;
  /** @param daylight 0 at night .. 1 in full daylight, as `SkyState` reports it. */
  applySky: (colors: ResolvedSky, sunDirection: Vector3, daylight: number) => void;
  setConditions: (conditions: DayCloudConditions) => void;
  update: (elapsed: number) => void;
  dispose: () => void;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** Metres of vertical development available to the deck, cumulus down to stratus. */
const CUMULUS_SLAB = 1500;
const STRATUS_SLAB = 520;

/** Moonlight on a night deck. Matches the tint the sky dome gives the moon. */
const MOON = new Color('#9fb0d4');

/**
 * The daytime sky above the ridges: a raymarched low and mid deck that changes
 * type with the cover, a cirrus sheet at seven kilometres, and the two pieces of
 * atmospheric optics that only ever show up in this weather — a 22° halo in the
 * ice, and a rainbow opposite the sun when it rains while the sun is out.
 *
 * Deliberately not the cloud sea: that one is a modelled surface you stand above
 * and hunt at dawn, this is the weather overhead. They share no geometry.
 *
 * @param quality raymarch steps. 0 falls back to a single-plane two-octave deck.
 */
export const createDayClouds = (terrain: Terrain, recipe: LocationRecipe, quality: number): DayClouds => {
  const steps = Math.max(0, Math.round(quality));
  const random = createPrng(`${recipe.seed}:day-clouds`);

  // Cumulus bases sit over a kilometre up, and here they also have to clear both
  // the ridges and however high the camera can be orbited.
  const baseAltitude = Math.max(1500, terrain.maxHeight * 2.6);

  const material = new ShaderMaterial({
    defines: { DAY_CLOUD_STEPS: String(steps) },
    uniforms: {
      uSunDirection: { value: new Vector3(0, 1, 0) },
      uSunLight: { value: new Color() },
      uMoonLight: { value: new Color() },
      uCloudLit: { value: new Color() },
      uCloudShadow: { value: new Color() },
      uHaze: { value: new Color() },
      uDrift: { value: new Vector2(6, 0) },
      uWindAxis: { value: new Vector2(1, 0) },
      uDaylight: { value: 1 },
      uBaseY: { value: baseAltitude },
      uThickness: { value: CUMULUS_SLAB },
      uCover: { value: 0.5 },
      uStratus: { value: 0 },
      uCirrus: { value: 0.2 },
      uCirrusY: { value: baseAltitude + 6000 },
      uRain: { value: 0 },
      uTime: { value: 0 },
      uMaxDistance: { value: terrain.size * 14 },
      uHazeFalloff: { value: 1 / (terrain.size * 6) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: BackSide,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    // The scene's own fog reaches 95% opacity long before this shell does, which
    // would erase the clouds outright. Distance is handled inside the shader
    // against the marched depth instead of against the dome's radius.
    fog: false,
  });

  // Finer than the sky dome on purpose: every effect here is a function of the
  // view direction, and on a coarse sphere the chord sag between vertices bends
  // that direction enough to turn the halo ring into a polygon.
  const geometry = new SphereGeometry(terrain.size * 6.3, 96, 48);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'day-clouds';
  mesh.frustumCulled = false;
  // Above the sky dome, below the cloud sea: the sea is kilometres away and this
  // shell is tens of kilometres away, so the sea has to paint over it.
  mesh.renderOrder = 4;

  const drift = new Vector2();
  const bearing = random() * 360;

  return {
    mesh,
    applySky: (colors, sunDirection, daylight) => {
      const night = 1 - daylight;
      material.uniforms.uSunDirection.value.copy(sunDirection);
      // Scaled so a sunlit top lands just under the bloom threshold and only the
      // forward-scattering rim crosses it.
      material.uniforms.uSunLight.value.copy(colors.sunCore).multiplyScalar(0.16 + daylight * 0.78);
      material.uniforms.uCloudLit.value.copy(colors.cloudLit).multiplyScalar(0.04 + daylight * 0.4);
      material.uniforms.uCloudShadow.value.copy(colors.cloudShadow).multiplyScalar(0.05 + daylight * 0.35);
      material.uniforms.uHaze.value.copy(colors.horizon);
      material.uniforms.uMoonLight.value.copy(MOON).multiplyScalar(night * night * 0.09);
      material.uniforms.uDaylight.value = daylight;
    },
    setConditions: (conditions) => {
      const total = clamp01(conditions.cloudCover / 100);
      const low = clamp01((conditions.cloudCoverLow ?? conditions.cloudCover) / 100);
      const rest = clamp01((total - low) / Math.max(1 - low, 0.05));
      const mid = clamp01((conditions.cloudCoverMid ?? rest * 65) / 100);
      const high = clamp01((conditions.cloudCoverHigh ?? rest * 70) / 100);
      const rain = clamp01(conditions.rain ?? 0);

      // One marched slab stands in for the low and mid layers at once: they are
      // the two with any depth to march through, and they overlap in the sky.
      const deck = 1 - (1 - low) * (1 - mid * 0.85);
      // A broken sky is cumulus; a covered one has turned into a sheet, and rain
      // falls out of a sheet rather than out of fair-weather puffs.
      const stratus = Math.max(smoothstep(0.52, 0.94, low), rain * 0.85);
      // Cover carried by the mid layer rather than the low one sits higher up.
      const lowShare = low / Math.max(low + mid, 0.05);

      material.uniforms.uCover.value = deck;
      material.uniforms.uStratus.value = stratus;
      material.uniforms.uCirrus.value = high;
      material.uniforms.uRain.value = rain;
      material.uniforms.uThickness.value = CUMULUS_SLAB - stratus * (CUMULUS_SLAB - STRATUS_SLAB);
      material.uniforms.uBaseY.value = baseAltitude - stratus * 380 + (1 - lowShare) * 700;

      // Wind at cloud base runs about twice the ten-metre reading, and a deck
      // that never moves reads as a painted backdrop, so a little more again.
      const speed = Math.max(conditions.windSpeed ?? 9, 4) * 0.2778 * 2.5;
      const toward = (((conditions.windBearing ?? bearing) + 180) * Math.PI) / 180;
      drift.set(Math.sin(toward), -Math.cos(toward));
      material.uniforms.uWindAxis.value.copy(drift);
      material.uniforms.uDrift.value.copy(drift).multiplyScalar(speed);

      // Nothing above and nothing to refract in means nothing to draw at all.
      mesh.visible = deck > 0.02 || high > 0.02 || rain > 0.02;
    },
    update: (elapsed) => {
      material.uniforms.uTime.value = elapsed;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
};
