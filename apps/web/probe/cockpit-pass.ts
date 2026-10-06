/**
 * Does the cockpit get drawn in the right place, with the right state put back?
 *
 * The ordering is the whole of this feature and it is the kind of thing that
 * fails silently: a cockpit drawn after the finish is a sticker on a photograph
 * rather than something standing in the same light; a depth buffer not cleared
 * leaves the bars behind the road they are over; and an `autoClear` left false
 * breaks every pass that runs afterwards, including the shadows, with no error
 * anywhere.
 *
 * None of that needs a GL context to check. `present-pass.ts` only ever talks to
 * the renderer through a handful of methods, so this hands it one that writes
 * down what it was asked to do, in order, and reads the transcript.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/cockpit-pass.ts
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve: (specifier, context, nextResolve) => {
    if (specifier.startsWith('.') && !/\.[mc]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const extension of ['.ts', '.tsx', '/index.ts']) {
        if (existsSync(base + extension)) return nextResolve(pathToFileURL(base + extension).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
globals.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
globals.document = { addEventListener: () => {}, removeEventListener: () => {} };

const { Scene, PerspectiveCamera } = await import('three');
const { createPresentPass } = await import('../src/scene/present-pass.ts');

let failures = 0;
const check = (claim: string, pass: boolean, shown: string) => {
  if (!pass) failures += 1;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${claim.padEnd(54)} ${shown}`);
};

/**
 * A renderer that draws nothing and remembers everything.
 *
 * `autoClear` is a real field rather than a recorded call, because that is how
 * three exposes it and the point of the test is that it is found as it was left.
 */
const transcript: string[] = [];
const fake = {
  autoClear: true,
  toneMappingExposure: 1,
  setRenderTarget: (target: unknown) => transcript.push(target ? 'bind:target' : 'bind:screen'),
  render: (scene: { name?: string }) => transcript.push(`render:${scene.name || 'quad'}`),
  clearDepth: () => transcript.push('clearDepth'),
  getPixelRatio: () => 1,
  readRenderTargetPixels: () => {},
  getContext: () => null,
  getSize: (into: { x: number; y: number }) => into,
};
const renderer = fake as unknown as Parameters<ReturnType<typeof createPresentPass>['render']>[0];

const world = new Scene();
world.name = 'world';
const cockpit = new Scene();
cockpit.name = 'cockpit';
const camera = new PerspectiveCamera(60, 16 / 9, 2, 4000);

const pass = createPresentPass(1, 'sharp', 0);
pass.setSize(640, 360);

console.log('\n--- with no cockpit, nothing changes ----------------------------------');
{
  transcript.length = 0;
  fake.autoClear = true;
  pass.setOverlay(null);
  pass.render(renderer, world, camera);
  const drew = transcript.filter((line) => line.startsWith('render:'));
  console.log(`  ${transcript.join(' → ')}`);
  check('the world is drawn once', drew.filter((line) => line === 'render:world').length === 1, drew.join(', '));
  check('the depth is never cleared', !transcript.includes('clearDepth'), 'no clearDepth');
  check('and autoClear is untouched', fake.autoClear === true, String(fake.autoClear));
}

console.log('\n--- with one, it goes between the world and the finish ----------------');
{
  transcript.length = 0;
  fake.autoClear = true;
  pass.setOverlay((target) => target.render(cockpit, camera));
  pass.render(renderer, world, camera);
  console.log(`  ${transcript.join(' → ')}`);

  const worldAt = transcript.indexOf('render:world');
  const clearAt = transcript.indexOf('clearDepth');
  const cockpitAt = transcript.indexOf('render:cockpit');
  // The finish is the first quad drawn after the cockpit: `composite` runs the
  // bloom and the shafts over the buffer and then the output quad is presented.
  const finishAt = transcript.findIndex((line, index) => index > cockpitAt && line === 'render:quad');

  check('the world first', worldAt >= 0, `at ${worldAt}`);
  check('then the depth cleared', clearAt > worldAt, `at ${clearAt}`);
  check('then the cockpit', cockpitAt > clearAt, `at ${cockpitAt}`);
  check('and the finish after all of it', finishAt > cockpitAt, `at ${finishAt}`);
  check('autoClear put back', fake.autoClear === true, String(fake.autoClear));
  // Which is what makes it stand in the same light as the road: the bloom, the
  // shafts and the night transform all read the buffer it was drawn into. The
  // test is that the last thing bound before the cockpit was the target, and
  // that the screen is not bound until after it.
  const boundBefore = transcript
    .slice(0, cockpitAt)
    .filter((line) => line.startsWith('bind:'))
    .pop();
  check(
    'drawn into the off-screen buffer, not onto the screen',
    boundBefore === 'bind:target' && transcript.indexOf('bind:screen') > cockpitAt,
    `${boundBefore} was bound, screen at ${transcript.indexOf('bind:screen')}`
  );
}

console.log('\n--- autoClear is restored to false if that is how it was found --------');
{
  // Not hypothetical: the shadow passes and the composite quads share this
  // renderer, and a pass that forces `autoClear` back to `true` breaks whichever
  // of them was relying on it being off.
  transcript.length = 0;
  fake.autoClear = false;
  pass.setOverlay((target) => target.render(cockpit, camera));
  pass.render(renderer, world, camera);
  check('found false, left false', fake.autoClear === false, String(fake.autoClear));
}

console.log('\n--- and the postcard gets the bars too --------------------------------');
{
  transcript.length = 0;
  fake.autoClear = true;
  pass.setOverlay((target) => target.render(cockpit, camera));
  pass.capture(renderer, world, camera, 64, 36);
  const worldAt = transcript.indexOf('render:world');
  const clearAt = transcript.indexOf('clearDepth');
  const cockpitAt = transcript.indexOf('render:cockpit');
  console.log(`  ${transcript.slice(0, 6).join(' → ')} …`);
  check('the capture draws the cockpit as well', cockpitAt > worldAt, `at ${cockpitAt}`);
  check('after clearing the depth', clearAt > worldAt && clearAt < cockpitAt, `at ${clearAt}`);
  check('and leaves autoClear alone', fake.autoClear === true, String(fake.autoClear));
}

pass.dispose();
console.log(failures ? `\nFAILED — ${failures} check${failures === 1 ? '' : 's'}\n` : '\nOK\n');
if (failures) process.exitCode = 1;
