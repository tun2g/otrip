import {
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Keeps only what is brighter than the threshold, with a soft knee. */
const BRIGHT_SHADER = /* glsl */ `
  uniform sampler2D tSource;
  uniform float uThreshold;
  uniform float uKnee;

  varying vec2 vUv;

  void main() {
    vec3 colour = texture2D(tSource, vUv).rgb;
    float brightness = max(colour.r, max(colour.g, colour.b));

    float knee = max(uKnee, 1.0e-4);
    // Only the light *above* the threshold crosses into the blur. The previous
    // form passed the whole colour the moment it cleared the cut, so a lantern
    // at 1.8 handed over all 1.8 and bloom snapped on rather than growing — and
    // the knee it claimed to apply was algebraically dead: both sides of the
    // max() collapsed to the same step, making it a hard cut after all.
    float soft = clamp(brightness - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee);
    float weight = max(soft, brightness - uThreshold) / max(brightness, 1.0e-4);
    gl_FragColor = vec4(colour * weight, 1.0);
  }
`;

/** Nine-tap gaussian along one axis; run twice for a separable blur. */
const BLUR_SHADER = /* glsl */ `
  uniform sampler2D tSource;
  uniform vec2 uDirection;

  varying vec2 vUv;

  void main() {
    vec4 total = texture2D(tSource, vUv) * 0.227027;
    total += (texture2D(tSource, vUv + uDirection * 1.3846) + texture2D(tSource, vUv - uDirection * 1.3846)) * 0.3162162;
    total += (texture2D(tSource, vUv + uDirection * 3.2307) + texture2D(tSource, vUv - uDirection * 3.2307)) * 0.0702702;
    gl_FragColor = total;
  }
`;

export type Bloom = {
  setSize: (width: number, height: number) => void;
  /** Builds the bloom texture from an HDR source. */
  render: (renderer: WebGLRenderer, source: Texture) => Texture;
  setStrength: (value: number) => void;
  strength: () => number;
  dispose: () => void;
};

const LEVELS = 3;

/**
 * Bloom, hand-rolled rather than pulled from the post-processing stack, because
 * the scene is already presented through its own pass and this has to sit in
 * the middle of it. It is what gives the sun a halo, the water its sparkle and
 * the lanterns their glow — the difference between a lit scene and a photograph.
 */
/**
 * Threshold sits above a brightly lit surface on purpose. At 1.0 a sunlit
 * hillside crossed it and the whole mountain glowed white; only the sun disc,
 * specular highlights on water and the lanterns should ever bloom.
 */
export const createBloom = (initialStrength = 0.42): Bloom => {
  let strength = initialStrength;

  const makeTarget = () =>
    new WebGLRenderTarget(1, 1, { minFilter: LinearFilter, magFilter: LinearFilter, type: HalfFloatType });

  const bright = makeTarget();
  const chain = Array.from({ length: LEVELS }, () => ({ a: makeTarget(), b: makeTarget() }));

  const brightMaterial = new ShaderMaterial({
    uniforms: { tSource: { value: null }, uThreshold: { value: 1.75 }, uKnee: { value: 0.6 } },
    vertexShader: VERTEX_SHADER,
    fragmentShader: BRIGHT_SHADER,
    depthTest: false,
    depthWrite: false,
  });

  const blurMaterial = new ShaderMaterial({
    uniforms: { tSource: { value: null }, uDirection: { value: new Vector2() } },
    vertexShader: VERTEX_SHADER,
    fragmentShader: BLUR_SHADER,
    depthTest: false,
    depthWrite: false,
  });

  const geometry = new PlaneGeometry(2, 2);
  const quadScene = new Scene();
  const quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new Mesh(geometry, brightMaterial);
  quad.frustumCulled = false;
  quadScene.add(quad);

  const draw = (renderer: WebGLRenderer, material: ShaderMaterial, target: WebGLRenderTarget) => {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCamera);
  };

  return {
    setSize: (width, height) => {
      const w = Math.max(1, Math.round(width * 0.5));
      const h = Math.max(1, Math.round(height * 0.5));
      bright.setSize(w, h);
      chain.forEach((level, index) => {
        const scale = 2 ** (index + 1);
        level.a.setSize(Math.max(1, Math.round(w / scale)), Math.max(1, Math.round(h / scale)));
        level.b.setSize(Math.max(1, Math.round(w / scale)), Math.max(1, Math.round(h / scale)));
      });
    },
    render: (renderer, source) => {
      brightMaterial.uniforms.tSource.value = source;
      draw(renderer, brightMaterial, bright);

      let input: Texture = bright.texture;
      for (const level of chain) {
        blurMaterial.uniforms.tSource.value = input;
        blurMaterial.uniforms.uDirection.value.set(1 / level.a.width, 0);
        draw(renderer, blurMaterial, level.a);

        blurMaterial.uniforms.tSource.value = level.a.texture;
        blurMaterial.uniforms.uDirection.value.set(0, 1 / level.b.height);
        draw(renderer, blurMaterial, level.b);

        input = level.b.texture;
      }

      renderer.setRenderTarget(null);
      return input;
    },
    setStrength: (value) => {
      strength = Math.max(0, value);
    },
    strength: () => strength,
    dispose: () => {
      bright.dispose();
      for (const level of chain) {
        level.a.dispose();
        level.b.dispose();
      }
      geometry.dispose();
      brightMaterial.dispose();
      blurMaterial.dispose();
    },
  };
};
