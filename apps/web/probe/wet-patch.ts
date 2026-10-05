import { writeFileSync } from 'node:fs';
import { MeshStandardMaterial, ShaderChunk, ShaderLib, UniformsUtils } from 'three';

import { applyWetLook } from '../src/scene/rain.ts';
import { createWind, applyWindSway } from '../src/scene/wind.ts';
import { LOCATIONS } from '@otrip/world';

const resolve = (source: string): string =>
  source.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name: string) => {
    const chunk = (ShaderChunk as Record<string, string>)[name];
    if (chunk === undefined) throw new Error(`unknown chunk ${name}`);
    return resolve(chunk);
  });

const wet = { value: 0.0 };
const material = new MeshStandardMaterial({ roughness: 0.9 });
applyWetLook(material, wet, { darken: 0.38, gloss: 0.72, pooling: 0.65 });

const shader = {
  uniforms: UniformsUtils.clone(ShaderLib.physical.uniforms) as Record<string, { value: unknown }>,
  vertexShader: ShaderLib.physical.vertexShader,
  fragmentShader: ShaderLib.physical.fragmentShader,
};
material.onBeforeCompile(shader as never, null as never);

const checks: [string, boolean][] = [
  ['vertex declares vWetUp', shader.vertexShader.includes('varying float vWetUp;')],
  ['vertex writes vWetUp', shader.vertexShader.includes('vWetUp = normalize(mat3(modelMatrix) * wetNormal).y;')],
  ['vertex kept beginnormal anchor', shader.vertexShader.includes('#include <beginnormal_vertex>')],
  ['fragment declares wetAmount', shader.fragmentShader.includes('float wetAmount()')],
  ['fragment darkens albedo', shader.fragmentShader.includes('diffuseColor.rgb *= 1.0 - 0.380 * wetAmount();')],
  ['fragment cuts roughness', shader.fragmentShader.includes('roughnessFactor = max(0.045,')],
  ['uniform is the shared object', shader.uniforms.uWetness === wet],
  ['pooling value interpolated', shader.fragmentShader.includes('0.650')],
];

// three hands onBeforeCompile a fresh shader object per compile, so the real
// hazard is applyWetLook chaining itself twice onto one material.
const hookBefore = material.onBeforeCompile;
applyWetLook(material, wet);
const fresh = () => ({
  uniforms: {} as Record<string, { value: unknown }>,
  vertexShader: ShaderLib.physical.vertexShader,
  fragmentShader: ShaderLib.physical.fragmentShader,
});
const once = fresh();
material.onBeforeCompile(once as never, null as never);
checks.push(['second apply does not re-chain', material.onBeforeCompile === hookBefore]);
checks.push(['one wetAmount per compile', once.fragmentShader.split('float wetAmount()').length === 2]);
checks.push(['one vWetUp declaration', once.vertexShader.split('varying float vWetUp;').length === 2]);
const twice = fresh();
material.onBeforeCompile(twice as never, null as never);
checks.push(['repeat compile is identical', twice.fragmentShader === once.fragmentShader]);

// A material can already be swayed; neither patch may drop the other.
const both = new MeshStandardMaterial();
applyWindSway(both, createWind(LOCATIONS['hoi-an']!), { amplitude: 0.1, height: 2, stiffness: 1 });
const windKey = both.customProgramCacheKey();
applyWetLook(both, wet, { darken: 0.2, gloss: 0.5, pooling: 0.3 });
const bothShader = {
  uniforms: {} as Record<string, { value: unknown }>,
  vertexShader: ShaderLib.physical.vertexShader,
  fragmentShader: ShaderLib.physical.fragmentShader,
};
both.onBeforeCompile(bothShader as never, null as never);
checks.push(['wind survives wet patch', bothShader.vertexShader.includes('windGustAt(windBase.xz, uWindTime)')]);
checks.push(['wet applied alongside wind', bothShader.vertexShader.includes('vWetUp =')]);
checks.push(['cache key keeps wind part', both.customProgramCacheKey().includes(windKey)]);
checks.push(['cache key adds wet part', both.customProgramCacheKey().includes('wet:0.2:0.5:0.3')]);
checks.push(['two configs key differently', both.customProgramCacheKey() !== material.customProgramCacheKey()]);

for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`${checks.filter(([, ok]) => ok).length}/${checks.length} passed`);

writeFileSync(
  '/private/tmp/claude-501/-Users-macbook-Documents-self-otrip/0f982f18-028d-462c-8653-c5fa04c062b7/scratchpad/wet-glsl.json',
  JSON.stringify({ vertex: resolve(shader.vertexShader), fragment: resolve(shader.fragmentShader) })
);
console.log('resolved GLSL written for the driver compile');
