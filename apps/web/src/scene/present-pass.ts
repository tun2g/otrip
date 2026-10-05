import {
  Color,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedIntType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type WebGLRenderer,
} from 'three';

import { createBloom } from './bloom';
import { formatFrameStats, measureFrame } from './frame-measure';
import { PIXEL_RENDER_SCALE, type RenderStyle } from './quality';
import type { ResolvedSky } from './sky-palette';
import { createSunShafts } from './sun-shafts';
import type { WorldWeather } from './weather-state';

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * The least of its own colour a surface keeps, however thick the air. At 300 m
 * visibility the physical answer is a white wall, and a white wall is not a
 * scene — a silhouette always survives.
 */
const MIN_TRANSMIT = 0.1;

/** Beyond this, in metres, is the sky dome and the far lip of the cloud deck. */
const SKY_DISTANCE = 12_000;

/** -ln(0.02): the contrast a meteorological visibility figure is defined at. */
const KOSCHMIEDER = 3.912;

/**
 * Extinction per channel, λ^-1.3 normalised to green. Pure Rayleigh (λ^-4) is
 * five times stronger in blue than red and turns a hillside into a cartoon;
 * real haze is mostly aerosol, which scatters almost greyly. This sits between
 * the two, which is where a photograph of a ridge at dawn sits.
 */
const AIR_TINT = new Vector3(0.76, 1, 1.33);

/**
 * How bright the airlight is against the sky it is borrowed from. Well under it
 * on purpose: at 1.0 a far ridge dissolves into the sky and the frame loses the
 * one thing the depth cue is for, which is the stack of ridges. 0.86 was still
 * too high — measured, the veil was brighter than every surface it was mixed
 * into, which is why a lowland plain at two kilometres came back near white.
 */
const AIR_LEVEL = 0.74;

/**
 * Where aerial perspective starts to bite and where it is fully in, in metres.
 *
 * Beer-Lambert on its own is uniform in distance, and that uniformity is what
 * flattened the frame rather than giving it depth. Measured at Hội An on a clear
 * 29 km day, the veil was still supplying a third of the signal at 1.1 km and
 * two thirds of the blue, which took a hillside from 17.8% saturation down to
 * 5.3% and lifted the frame's black point 33 levels. The cause is a brightness
 * mismatch, not a bad coefficient: the airlight sits at 0.41 scene-linear
 * against a lit hillside at 0.12, so it is three times brighter than everything
 * it is mixed into and even a 15% mix dominates.
 *
 * Holding it off the near field is what lets the foreground keep its own colour
 * while the ridge stack still dissolves into the sky — which is the only thing
 * the effect is for. It matches a photograph at this visibility better than the
 * uniform form did: nothing at a kilometre, everything at three. Lowering
 * AIR_LEVEL instead was tried and measured, and it buys chroma by throwing away
 * the ridge separation, which is the wrong trade.
 */
const AERIAL_NEAR = 700;
const AERIAL_FULL = 3000;

/**
 * How far a surface's chroma collapses onto the sky's after dark, and the
 * luminance floor it is held above.
 *
 * Both model the same thing from two directions. A night landscape is lit by a
 * single source — a blue sky — and is read by an eye that has lost most of its
 * colour discrimination, so every surface ends up on one chromaticity with only
 * its brightness still saying what it is. Measured off the reference, that is
 * its defining property: its sky, far ridge and near ground sit at luminance
 * 63.4, 61.0 and 61.2, within three levels of each other, and carry depth by
 * saturation instead. Light alone cannot produce it — an olive hillside stays
 * olive however blue the lamp — so it is done here, where the whole frame is
 * reachable at once.
 *
 * The floor is in luma, against a night sky normalised to unit luma, so it is
 * the luminance a shadowed surface lands at rather than a multiplier on
 * whatever it happened to be. Tuned against the reference by measurement rather
 * than by eye: 0.065 overshot it to a median of 83 against its 64, and this
 * lands at 60 with the frame's own lamps still carrying the top end.
 */
const NIGHT_CHROMA = 0.82;
const NIGHT_FLOOR = 0.042;
const NIGHT_FLOOR_TOP = 0.075;

/**
 * Where a pixel stops being a surface and starts being a light.
 *
 * The collapse above models scotopic vision — at these levels the cones have
 * nothing to work with and the rods cannot tell colours apart at all, which is
 * why a moonlit field reads blue-grey whatever is growing in it. A lantern is
 * not in that regime: it is bright enough to be seen photopically, in colour,
 * and it is the source rather than something the sky is lighting. That is
 * precisely why a lantern looks warm against a blue world, and collapsing it
 * too turned every lamp and lit window in Hội An blue — the opposite of what
 * the night is for. The reference keeps its highlights entirely in the lamps,
 * which is how it reaches 240 at the top while sitting at 64 in the middle.
 */
const NIGHT_LAMP_LOW = 0.12;
const NIGHT_LAMP_HIGH = 0.5;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloom;
  uniform sampler2D tShafts;
  uniform sampler2D tDepth;
  uniform vec2 uResolution;
  uniform float uLevels;
  uniform float uBloom;
  uniform float uShafts;
  uniform float uAerial;
  uniform vec3 uBeta;
  uniform vec3 uAir;
  uniform vec3 uAirSun;
  uniform float uNight;
  uniform vec3 uNightAir;
  uniform vec3 uSunDirection;
  uniform vec3 uEye;
  uniform mat4 uClipToWorld;

  uniform float uDebug;
  uniform float uEncode;
  uniform float uExposure;

  varying vec2 vUv;

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  // ACES and the sRGB transfer, by hand, for the capture path only.
  //
  // Three compiles the output transform into a shader only when the destination
  // is the canvas: WebGLPrograms forces tone mapping off and the output space
  // back to the working space whenever currentRenderTarget is not null. So the
  // two includes at the end of main are dead code in an off-screen pass, and
  // every saved postcard came back raw linear in an 8-bit buffer — far darker
  // and flatter than the frame the button was pressed on. These are the same two
  // transforms three would have applied, transcribed from its
  // tonemapping_pars_fragment and colorspace_pars_fragment chunks; uEncode picks
  // which copy runs so they can never both apply to one pixel.
  const mat3 ACES_IN = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 ACES_OUT = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602)
  );

  vec3 acesFilmic(vec3 value) {
    // The 1/0.6 is three's own: its ACES is scaled for a brighter viewing
    // environment, and dropping it would make the postcard a stop darker.
    vec3 fit = ACES_IN * (value * (uExposure / 0.6));
    vec3 numerator = fit * (fit + 0.0245786) - 0.000090537;
    vec3 denominator = fit * (0.983729 * fit + 0.4329510) + 0.238081;
    return clamp(ACES_OUT * (numerator / denominator), 0.0, 1.0);
  }

  vec3 encodeSrgb(vec3 value) {
    return mix(
      pow(value, vec3(0.41666)) * 1.055 - vec3(0.055),
      value * 12.92,
      vec3(lessThanEqual(value, vec3(0.0031308)))
    );
  }

  // Analytic 4x4 ordered Bayer, 0..15. Evaluated in source-resolution pixels so
  // the dither grid matches the chunky pixels rather than the upscaled ones.
  float bayer4(vec2 p) {
    vec2 unit = mod(p, 2.0);
    vec2 quad = floor(0.5 * mod(p, 4.0));
    return 4.0 * mod(unit.x + 2.0 * unit.y, 4.0) + mod(quad.x + 2.0 * quad.y, 4.0);
  }

  void main() {
    vec4 texel = texture2D(tDiffuse, vUv);
    vec3 colour = texel.rgb;

    // Where the surface in this pixel actually is. One matrix multiply against
    // the depth buffer is the whole cost of knowing that, and it is also the
    // only honest way to do aerial perspective: distance has to come out of the
    // geometry, not out of a guess at how far the horizon is.
    vec4 clip = vec4(vUv * 2.0 - 1.0, texture2D(tDepth, vUv).x * 2.0 - 1.0, 1.0);
    vec4 world = uClipToWorld * clip;
    vec3 position = world.xyz / world.w;
    vec3 ray = position - uEye;
    float span = length(ray);
    float sky = step(${SKY_DISTANCE}.0, span);

    // Beer-Lambert, straight, with no height profile on top. A profile was tried
    // and taken out: these worlds put y = 0 at the valley floor rather than at
    // sea level, and the camera starts ~1400 units above a 900-unit ridge, so
    // every pixel pinned the same end of the curve — a blanket haze multiplier
    // wearing the costume of a depth cue. Distance alone is the depth cue.
    vec3 transmit = max(exp(-uBeta * span), vec3(${MIN_TRANSMIT}));

    if (sky < 0.5) {
      // Airlight is the sky along this ray: warm toward a low sun, blue away
      // from it. That split is the reason a ridge stack reads as distance
      // rather than as one grey wash, and the reason this adds depth instead of
      // adding haze. The sky itself is left alone — it already is the
      // atmosphere, and running it through a second time only flattens the one
      // real gradient in the frame.
      float toward = max(0.0, dot(ray / max(span, 1.0e-4), uSunDirection));
      vec3 air = mix(uAir, uAirSun, toward * toward);
      // Distance decides how much of the veil applies, not just how thick it is.
      float reach = smoothstep(${AERIAL_NEAR}.0, ${AERIAL_FULL}.0, span);
      colour = mix(colour, colour * transmit + air * (1.0 - transmit), uAerial * reach);
    }

    // Bloom is added in linear HDR, before the tone mapper — adding it after
    // would be painting light onto an already-finished image. It is sampled
    // from the frame as rendered rather than as hazed, which costs nothing
    // real: the sun disc and the lanterns are the only things over the bright
    // threshold, and they are either at infinity or close enough to touch.
    colour += texture2D(tBloom, vUv).rgb * uBloom;

    // A shaft is light scattered by the air in front of what you are looking
    // at, so there has to be air in front of it: full strength against the sky,
    // next to none across a rock two metres away. Without this the rays paint
    // over the foreground and read as a dirty lens.
    float airAhead = sky > 0.5 ? 1.0 : 1.0 - dot(transmit, LUMA);
    colour += texture2D(tShafts, vUv).rgb * (uShafts * (0.3 + 0.7 * airAhead));

    if (uNight > 0.0) {
      float level = dot(colour, LUMA);
      // Luminance is preserved; only the chromaticity moves, onto the sky's.
      // Deliberately not named "shared": that is a reserved word in GLSL ES
      // 3.00, and it only compiles here because a raw ShaderMaterial still
      // targets ES 1.00. The same trap took the road shader out of the build.
      vec3 skyLit = uNightAir * (level / max(dot(uNightAir, LUMA), 1.0e-4));
      // Anything bright enough to be its own source keeps its colour.
      float lamp = 1.0 - smoothstep(${NIGHT_LAMP_LOW}, ${NIGHT_LAMP_HIGH}, level);
      colour = mix(colour, skyLit, uNight * ${NIGHT_CHROMA} * lamp);
      // A moonlit valley is dim, not black. ACES crushes anything under about
      // 0.02 linear, which is what put nearly half the frame at pure black.
      colour += uNightAir * (uNight * ${NIGHT_FLOOR} * (1.0 - smoothstep(0.0, ${NIGHT_FLOOR_TOP}, level)));
    }

    if (uDebug > 1.5) {
      gl_FragColor = vec4(texture2D(tShafts, vUv).rgb * uShafts, 1.0);
      return;
    }
    if (uDebug > 0.5) {
      gl_FragColor = vec4(vec3(span / 5000.0), 1.0);
      return;
    }

    if (uLevels > 0.0) {
      // Quantising to a fixed number of levels is what sells the pixel look, but
      // a smooth sky bands badly under it — the dither trades those rings for
      // noise the eye reads as texture.
      float threshold = (bayer4(vUv * uResolution) / 16.0) - 0.5;
      vec3 dithered = colour + threshold / uLevels;
      gl_FragColor = vec4(floor(dithered * uLevels + 0.5) / uLevels, texel.a);
    } else {
      gl_FragColor = vec4(colour, texel.a);
    }

    if (uEncode > 0.5) {
      // Alpha is forced rather than carried: the renderer clears to alpha 0, and
      // a postcard with transparent pixels in it is not a picture someone can
      // show a friend.
      gl_FragColor = vec4(encodeSrgb(acesFilmic(gl_FragColor.rgb)), 1.0);
      return;
    }

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export type Capture = { data: Uint8Array; width: number; height: number };

export type PresentPass = {
  setSize: (width: number, height: number) => void;
  setStyle: (style: RenderStyle) => void;
  setBloom: (strength: number) => void;
  /**
   * Everything the finish needs from the world's one weather: how far you can
   * see, where the sun is and what the air is coloured. Call it wherever the
   * sky is pushed to the rest of the scene, before `render`.
   */
  applySky: (colors: ResolvedSky, sunDirection: Vector3, sunElevation: number, weather: WorldWeather) => void;
  render: (renderer: WebGLRenderer, scene: Scene, camera: Camera) => void;
  /** Renders one frame off-screen at an exact size, for the postcard. */
  capture: (renderer: WebGLRenderer, scene: Scene, camera: Camera, width: number, height: number) => Capture;
  dispose: () => void;
};

const PIXEL_LEVELS = 24;

/** Samples per radial pass of the shafts. 0 turns them off. */
const DEFAULT_SHAFT_TAPS = 6;

/**
 * Draws the world into an off-screen buffer and presents it. Sharp keeps full
 * resolution with multisampling; pixel deliberately draws small and blits up
 * with nearest-neighbour, which is both the art direction and the budget that
 * makes a weak device playable.
 *
 * @param shaftTaps samples per radial pass of the crepuscular rays; 0 disables.
 */
export const createPresentPass = (
  baseScale: number,
  initialStyle: RenderStyle = 'sharp',
  shaftTaps = DEFAULT_SHAFT_TAPS
): PresentPass => {
  let style = initialStyle;
  let width = 1;
  let height = 1;

  const makeTarget = (targetWidth: number, targetHeight: number) => {
    const made = new WebGLRenderTarget(targetWidth, targetHeight, {
      minFilter: style === 'pixel' ? NearestFilter : LinearFilter,
      magFilter: style === 'pixel' ? NearestFilter : LinearFilter,
      depthBuffer: true,
      samples: style === 'pixel' ? 0 : 4,
      // Half float keeps the scene in HDR all the way to the tone mapper. On an
      // 8-bit target a bright sky clips to white before tone mapping ever sees
      // it, which is most of why the old image looked washed and flat.
      type: HalfFloatType,
    });
    // Aerial perspective needs to know how far away each pixel is, so the depth
    // the scene was already paying for is kept as a texture. Multisampling
    // resolves it alongside the colour; three sizes it with the target.
    made.depthTexture = new DepthTexture(targetWidth, targetHeight, UnsignedIntType);
    return made;
  };

  let target = makeTarget(1, 1);

  const material = new ShaderMaterial({
    uniforms: {
      tDiffuse: { value: target.texture },
      tBloom: { value: null },
      tShafts: { value: null },
      tDepth: { value: target.depthTexture },
      uResolution: { value: new Vector2(1, 1) },
      uLevels: { value: initialStyle === 'pixel' ? PIXEL_LEVELS : 0 },
      uBloom: { value: 0 },
      uShafts: { value: 0 },
      uAerial: { value: 1 },
      uBeta: { value: new Vector3() },
      uAir: { value: new Color('#000000') },
      uAirSun: { value: new Color('#000000') },
      uNight: { value: 0 },
      uNightAir: { value: new Vector3(0.2, 0.45, 1) },
      uSunDirection: { value: new Vector3(0, 1, 0) },
      uEye: { value: new Vector3() },
      uClipToWorld: { value: new Matrix4() },
      uDebug: { value: 0 },
      uEncode: { value: 0 },
      uExposure: { value: 1 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    depthTest: false,
    depthWrite: false,
  });

  const quadGeometry = new PlaneGeometry(2, 2);
  const quadScene = new Scene();
  const quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new Mesh(quadGeometry, material);
  quad.frustumCulled = false;
  quadScene.add(quad);

  const bloom = createBloom();
  const shafts = createSunShafts(shaftTaps);

  /** Hoisted: `applySky` runs every frame and must not allocate. */
  const nightAir = new Color();

  const scaleFor = () => (style === 'pixel' ? PIXEL_RENDER_SCALE : baseScale);

  const resize = () => {
    const scale = scaleFor();
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    target.setSize(w, h);
    material.uniforms.uResolution.value.set(w, h);
    bloom.setSize(w, h);
    shafts.setSize(w, h);
  };

  /**
   * The quad is drawn through an orthographic camera at the origin, so three's
   * own `cameraPosition` and `viewMatrix` describe that quad and not the view.
   * Both have to be handed over explicitly, and only after the scene has been
   * rendered, which is what brings the camera's world matrix up to date.
   */
  const syncCamera = (camera: Camera) => {
    camera.getWorldPosition(material.uniforms.uEye.value);
    material.uniforms.uClipToWorld.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
  };

  const composite = (renderer: WebGLRenderer, source: WebGLRenderTarget, camera: Camera) => {
    syncCamera(camera);
    material.uniforms.tBloom.value = bloom.render(renderer, source.texture);
    material.uniforms.uBloom.value = bloom.strength();
    material.uniforms.tShafts.value = shafts.render(renderer, source.texture, camera);
    material.uniforms.uShafts.value = shafts.strength();
  };

  /**
   * What the finish actually looks like, in numbers, on demand.
   *
   * The readback is from the canvas rather than from a render target, and that
   * is the whole point of it: three only compiles the tone mapping and the sRGB
   * encode into a shader when the destination is the canvas (see the
   * `currentRenderTarget === null` test in `WebGLPrograms`), so anything read
   * out of an off-screen target comes back raw linear and reads far darker and
   * more saturated than the frame on screen. Measuring that by mistake is how a
   * scene gets called washed out and then tuned against the wrong numbers.
   *
   * Arm it with `__otripMeasure()`; the next frame leaves the report in
   * `__otripReport`. It stalls the pipeline on a readback, so nothing runs until
   * it is asked for.
   */
  const MEASURE_RANGE = 5000;
  /** Frames presented. Separates "the measurement is broken" from "nothing is
   * being drawn", which has already been mistaken for each other once. */
  let frames = 0;
  let measureWanted = false;
  /** The last frame's inputs, so a measurement can draw its own frame. */
  let lastRenderer: WebGLRenderer | null = null;
  let lastScene: Scene | null = null;
  let lastCamera: Camera | null = null;
  let skyReport = 'applySky never called';
  const measureSize = new Vector2();

  const present = (renderer: WebGLRenderer, scene: Scene, camera: Camera) => {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);

    composite(renderer, target, camera);

    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCamera);

    frames += 1;
    lastRenderer = renderer;
    lastScene = scene;
    lastCamera = camera;
  };

  const readCanvas = (renderer: WebGLRenderer, w: number, h: number): Uint8Array => {
    const pixels = new Uint8Array(w * h * 4);
    const gl = renderer.getContext();
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  };

  const runMeasure = (renderer: WebGLRenderer) => {
    measureWanted = false;
    renderer.getDrawingBufferSize(measureSize);
    const w = Math.max(1, Math.floor(measureSize.x));
    const h = Math.max(1, Math.floor(measureSize.y));

    // The presented frame is already on the canvas; take it before anything
    // else touches the default framebuffer.
    const presented = readCanvas(renderer, w, h);

    // Distance, off the same quad. Its branch returns before the output
    // transform, so this pass is linear on purpose and stays comparable.
    material.uniforms.uDebug.value = 1;
    renderer.render(quadScene, quadCamera);
    const distance = readCanvas(renderer, w, h);
    material.uniforms.uDebug.value = 0;

    // The same frame with the air taken out. Haze and albedo both end in a pale
    // hillside and the two need completely different fixes, so the one number
    // worth having is the difference between them rather than either alone.
    material.uniforms.uAerial.value = 0;
    renderer.render(quadScene, quadCamera);
    const airless = readCanvas(renderer, w, h);

    // Leave the canvas holding the real frame, not a diagnostic one.
    material.uniforms.uAerial.value = 1;
    renderer.render(quadScene, quadCamera);

    const shaft = shafts.diagnose();
    (window as unknown as Record<string, unknown>).__otripReport = [
      formatFrameStats(measureFrame(presented, distance, w, h, MEASURE_RANGE), `canvas ${w}x${h}`),
      formatFrameStats(measureFrame(airless, distance, w, h, MEASURE_RANGE), 'same frame, aerial perspective off'),
      skyReport,
      `bloom=${bloom.strength().toFixed(3)} shafts=${shafts.strength().toFixed(4)} ` +
        `(taps=${shaft.taps} base=${shaft.strength.toFixed(2)} conditions=${shaft.conditions.toFixed(3)} ` +
        `framing=${shaft.framing.toFixed(3)} cut=${shaft.threshold.toFixed(2)})`,
    ].join('\n');
  };

  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__otripMeasure = () => {
      if (!lastRenderer || !lastScene || !lastCamera) return 'nothing presented yet — no frame to measure';

      // Draw the frame here rather than waiting for the next one. An occluded or
      // sleeping display stops requestAnimationFrame outright, and an instrument
      // that waits for a frame then reports nothing, which reads as a dead
      // renderer and sends the next hour chasing the wrong bug.
      present(lastRenderer, lastScene, lastCamera);
      runMeasure(lastRenderer);

      // The frame itself, grabbed inside the same task as the draw that made it.
      // A WebGL canvas without `preserveDrawingBuffer` is empty by the time a
      // later call could ask for it, so this is the only moment it can be had —
      // and a band table without the picture it came from is how a measurement
      // gets read as the wrong part of the scene.
      try {
        const canvas = lastRenderer.domElement;
        (window as unknown as Record<string, unknown>).__otripShot = canvas.toDataURL('image/png');
      } catch {
        (window as unknown as Record<string, unknown>).__otripShot = null;
      }

      return (window as unknown as Record<string, string>).__otripReport;
    };
  }

  return {
    setSize: (nextWidth, nextHeight) => {
      width = nextWidth;
      height = nextHeight;
      resize();
    },
    setStyle: (nextStyle) => {
      if (nextStyle === style) return;
      style = nextStyle;

      // Filtering and multisampling are fixed at construction, so switching the
      // look means a fresh target rather than a flag.
      target.dispose();
      target = makeTarget(1, 1);
      material.uniforms.tDiffuse.value = target.texture;
      material.uniforms.tDepth.value = target.depthTexture;
      material.uniforms.uLevels.value = style === 'pixel' ? PIXEL_LEVELS : 0;
      resize();
    },
    applySky: (colors, sunDirection, sunElevation, weather) => {
      skyReport =
        `visibility=${weather.visibility.toFixed(0)}m ` +
        `elev=${sunElevation.toFixed(2)} cover=${weather.cloudCover.toFixed(2)} ` +
        `occlusion=${weather.skyOcclusion.toFixed(2)} rain=${weather.rainIntensity.toFixed(2)} ` +
        `night=${weather.night.toFixed(2)} daylight=${weather.daylight.toFixed(2)} ` +
        `low=${weather.cloudLow.toFixed(2)} mid=${weather.cloudMid.toFixed(2)} high=${weather.cloudHigh.toFixed(2)}`;
      material.uniforms.uSunDirection.value.copy(sunDirection).normalize();

      // The real visibility figure, not a constant: 3.912 / V is the extinction
      // a reported visibility means by definition, so a 20 km morning and a
      // 2 km one differ by the amount they actually differ by.
      const extinction = KOSCHMIEDER / Math.max(200, weather.visibility);
      material.uniforms.uBeta.value.copy(AIR_TINT).multiplyScalar(extinction);

      material.uniforms.uAir.value.copy(colors.fog).lerp(colors.zenith, 0.45).multiplyScalar(AIR_LEVEL);
      material.uniforms.uAirSun.value.copy(colors.fog).lerp(colors.sunGlow, 0.6).multiplyScalar(AIR_LEVEL);

      // The night illuminant, normalised to unit luma so NIGHT_FLOOR is the
      // luminance a shadowed surface lands at rather than a multiplier on
      // whatever it happened to be. The horizon rather than the zenith: it is
      // the part of the sky a valley floor can actually see.
      material.uniforms.uNight.value = weather.night;
      nightAir.copy(colors.horizon).lerp(colors.zenith, 0.35);
      const nightLuma = Math.max(1e-4, 0.2126 * nightAir.r + 0.7152 * nightAir.g + 0.0722 * nightAir.b);
      material.uniforms.uNightAir.value.set(nightAir.r / nightLuma, nightAir.g / nightLuma, nightAir.b / nightLuma);

      shafts.applySky(colors, sunDirection, sunElevation, weather);
    },
    render: (renderer, scene, camera) => {
      present(renderer, scene, camera);
      if (measureWanted) runMeasure(renderer);
    },
    capture: (renderer, scene, camera, captureWidth, captureHeight) => {
      const scale = scaleFor();
      const sourceWidth = Math.round(captureWidth * scale);
      const sourceHeight = Math.round(captureHeight * scale);
      const sourceTarget = new WebGLRenderTarget(sourceWidth, sourceHeight, {
        minFilter: style === 'pixel' ? NearestFilter : LinearFilter,
        magFilter: style === 'pixel' ? NearestFilter : LinearFilter,
        depthBuffer: true,
        samples: style === 'pixel' ? 0 : 4,
        type: HalfFloatType,
      });
      sourceTarget.depthTexture = new DepthTexture(sourceWidth, sourceHeight, UnsignedIntType);
      const flatTarget = new WebGLRenderTarget(captureWidth, captureHeight, {
        minFilter: LinearFilter,
        magFilter: LinearFilter,
      });

      const previousMap = material.uniforms.tDiffuse.value;
      const previousDepth = material.uniforms.tDepth.value;
      const previousResolution = material.uniforms.uResolution.value.clone();

      renderer.setRenderTarget(sourceTarget);
      renderer.render(scene, camera);

      material.uniforms.tDiffuse.value = sourceTarget.texture;
      material.uniforms.tDepth.value = sourceTarget.depthTexture;
      material.uniforms.uResolution.value.set(sourceWidth, sourceHeight);

      // The postcard is the thing people keep, so it gets the same finish as the
      // screen. Both helpers size their buffers from the viewport, so they are
      // re-sized here and put back afterwards rather than being skipped.
      bloom.setSize(sourceWidth, sourceHeight);
      shafts.setSize(sourceWidth, sourceHeight);
      composite(renderer, sourceTarget, camera);

      // The output transform, which three will not supply here. Its exposure is
      // read off the renderer rather than repeated as a constant, so the postcard
      // cannot drift from the screen when the exposure is retuned.
      material.uniforms.uEncode.value = 1;
      material.uniforms.uExposure.value = renderer.toneMappingExposure;

      renderer.setRenderTarget(flatTarget);
      renderer.render(quadScene, quadCamera);

      const data = new Uint8Array(captureWidth * captureHeight * 4);
      renderer.readRenderTargetPixels(flatTarget, 0, 0, captureWidth, captureHeight, data);
      renderer.setRenderTarget(null);

      material.uniforms.uEncode.value = 0;
      material.uniforms.tDiffuse.value = previousMap;
      material.uniforms.tDepth.value = previousDepth;
      material.uniforms.uResolution.value.copy(previousResolution);
      sourceTarget.dispose();
      flatTarget.dispose();
      resize();

      return { data, width: captureWidth, height: captureHeight };
    },
    setBloom: (value: number) => bloom.setStrength(value),
    dispose: () => {
      bloom.dispose();
      shafts.dispose();
      target.dispose();
      quadGeometry.dispose();
      material.dispose();
    },
  };
};
