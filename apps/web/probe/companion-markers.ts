/**
 * What does a companion's ring cost, and does it actually show up where the
 * avatar cannot?
 *
 * The case the marker exists for was measured on the deployed site: switching to
 * "Về ngắm cảnh từ trên cao" puts the camera 3,439 m out and leaves a companion
 * 0.43 px tall and still inside the frustum, while the trip panel reads "Bạn và
 * 1 người nữa". Being told you have company and shown nothing is one click from
 * the joined state, so the ring has to hold its size where the body does not.
 *
 * This boots the module in Node with a stubbed `window`/`document` — no terrain,
 * no model, no renderer — and measures the four things that can go wrong without
 * ever looking wrong in a screenshot: that an empty roster draws nothing, that
 * the ring is a usable number of pixels at every range, that night does not hand
 * the marker the frame's highlight budget, and that `dispose` releases every
 * object the module created.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/companion-markers.ts
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { RemotePlayer } from '../src/scene/avatars.ts';

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

/**
 * `paintRing` asks the canvas for a 2D context and returns when it does not get
 * one — the single branch in that file written for a machine with no canvas. So
 * the texture, the materials and every number this probe measures are real;
 * only the rasterised ring is absent, and nothing here depends on its pixels.
 */
const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
globals.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
globals.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({ width: 0, height: 0, getContext: () => null }),
};

const { Sprite } = await import('three');
const { createCompanionMarkers } = await import('../src/scene/companion-markers.ts');

const player = (fields: Partial<RemotePlayer>): RemotePlayer => ({
  id: 'friend',
  name: 'Bình',
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  // What the room carries once somebody is riding or racing. Spelt out rather
  // than left optional: `RemotePlayer` is the contract the renderer reads, and a
  // probe that is allowed to omit half of it stops being a test of that.
  heading: 0,
  riding: '',
  speed: 0,
  racing: false,
  lap: 0,
  check: 0,
  bestMs: 0,
  finishedMs: 0,
  ...fields,
});

/** The frame this repo sizes screen-constant sprites against: 1080 px at 52°. */
const FRAME = 1080;
const VERTICAL_FOV = (52 * Math.PI) / 180;
const pixels = (metres: number, range: number) => (metres / range / VERTICAL_FOV) * FRAME;

const markers = createCompanionMarkers();
const drawn = () => markers.group.children.filter((node) => node.visible);

let failures = 0;
const check = (label: string, pass: boolean, note: string) => {
  if (!pass) failures += 1;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${note}`);
};

console.log('\n--- nothing in the frame until somebody is in the room ---\n');

check('group hidden on a fresh instance', !markers.group.visible, `visible=${markers.group.visible}`);
check(
  'sprites built up front, not on join',
  markers.group.children.length === 7,
  `${markers.group.children.length} slots`
);

markers.sync([]);
markers.update(0, { x: 0, y: 1, z: 0 });
check('empty roster draws nothing', !markers.group.visible && drawn().length === 0, `${drawn().length} drawn`);

markers.sync([player({ x: 0, y: 0, z: 300 })]);
check('one companion wakes the group', markers.group.visible, `visible=${markers.group.visible}`);

console.log('\n--- what one ring costs the frame ---\n');

markers.update(0, { x: 0, y: 1.6, z: 0 });
const one = drawn().length;
console.log(`  one companion at 300 m      ${one} draw call${one === 1 ? '' : 's'}, ${one * 2} triangles`);

markers.sync(Array.from({ length: 7 }, (_, at) => player({ id: `friend-${at}`, x: at * 40, y: 0, z: 300 })));
markers.update(0, { x: 0, y: 1.6, z: 0 });
const full = drawn().length;
console.log(`  a full room of seven        ${full} draw calls, ${full * 2} triangles`);
console.log('  (one shared canvas texture, seven materials, three.js own sprite geometry)');

console.log('\n--- does it show up where the body does not? ---\n');
console.log(`  ${'range'.padEnd(12)}${'ring'.padEnd(12)}${'body'.padEnd(12)}opacity`);

markers.setNight(0);
const solo = createCompanionMarkers();
for (const range of [10, 17, 26, 48, 120, 600, 3439]) {
  solo.sync([player({ x: 0, y: 0, z: range })]);
  // Sampled at the crest of the breathing, which is what "peak opacity" means.
  let peak = 0;
  let span = 0;
  for (let step = 0; step < 240; step += 1) {
    solo.update(step / 24, { x: 0, y: 1.1, z: 0 });
    const sprite = solo.group.children.find((node) => node.visible);
    if (!(sprite instanceof Sprite)) continue;
    if (sprite.material.opacity > peak) peak = sprite.material.opacity;
    span = sprite.scale.x;
  }

  const ring = span > 0 ? `${pixels(span, range).toFixed(1)} px` : '—';
  console.log(
    `  ${`${range} m`.padEnd(12)}${ring.padEnd(12)}${`${pixels(1.78, range).toFixed(2)} px`.padEnd(12)}` +
      `${peak.toFixed(3)}`
  );
}

check(
  'faded out while you can see each other',
  (() => {
    solo.sync([player({ x: 0, y: 0, z: 12 })]);
    solo.update(0, { x: 0, y: 1.1, z: 0 });
    return solo.group.children.every((node) => !node.visible);
  })(),
  'nothing drawn at 12 m'
);
check(
  'still 24 px wide from the sightseeing camera',
  (() => {
    solo.sync([player({ x: 0, y: 0, z: 3439 })]);
    solo.update(0, { x: 0, y: 1.1, z: 0 });
    const sprite = solo.group.children.find((node) => node.visible);
    return sprite instanceof Sprite && Math.abs(pixels(sprite.scale.x, 3439) - 23.5) < 2;
  })(),
  'against a body at 0.43 px'
);

console.log('\n--- the night budget ---\n');

const lit = (night: number): { peak: number; luma: number } => {
  solo.setNight(night);
  solo.sync([player({ id: 'hue', x: 0, y: 0, z: 600 })]);
  let peak = 0;
  let luma = 0;
  for (let step = 0; step < 240; step += 1) {
    solo.update(step / 24, { x: 0, y: 1.1, z: 0 });
    const sprite = solo.group.children.find((node) => node.visible);
    if (!(sprite instanceof Sprite)) continue;
    if (sprite.material.opacity <= peak) continue;
    peak = sprite.material.opacity;
    const { r, g, b } = sprite.material.color;
    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return { peak, luma };
};

const day = lit(0);
const dark = lit(1);
console.log(`  by day     peak opacity ${day.peak.toFixed(3)}   tint luma ${day.luma.toFixed(3)} scene-linear`);
console.log(`  at midnight peak opacity ${dark.peak.toFixed(3)}  tint luma ${dark.luma.toFixed(3)} scene-linear`);
console.log('');
console.log('  present-pass.ts reads anything over 0.12 linear as a light rather than');
console.log('  a surface, and the avatar name label already sits at #f2ece2 ≈ 0.88 with');
console.log('  depthTest off. The ring has to stay under that label and over the ground.');

check('night takes brightness off the ring', dark.luma < day.luma, `${day.luma.toFixed(3)} -> ${dark.luma.toFixed(3)}`);
check('never brighter than the name label', dark.luma < 0.88 && day.luma < 0.88, 'label is 0.88 linear');
check(
  'no additive blending anywhere',
  !drawn().some((node) => node instanceof Sprite && node.material.blending !== 1),
  'NormalBlending only'
);

console.log('\n--- dispose ---\n');

// Collected by walking the group rather than from the module's own bookkeeping,
// so a sprite it forgot to track is still counted here. `Material.dispose` and
// `Texture.dispose` both dispatch a 'dispose' event, which is the only honest
// evidence available without a GL context.
const owned = new Set<{ addEventListener: (type: 'dispose', fn: () => void) => void }>();
for (const node of markers.group.children) {
  if (!(node instanceof Sprite)) continue;
  owned.add(node.material);
  if (node.material.map) owned.add(node.material.map);
}

let released = 0;
for (const object of owned) object.addEventListener('dispose', () => (released += 1));

const expected = owned.size;
markers.dispose();
check('every material and texture released', released === expected, `${released} of ${expected}`);
check('group emptied', markers.group.children.length === 0, `${markers.group.children.length} children left`);

solo.dispose();

console.log(
  failures
    ? `\nFAILED: ${failures} check${failures === 1 ? '' : 's'}\n`
    : '\nOK — the ring is cheap, visible at range, and quiet up close\n'
);
if (failures) process.exitCode = 1;
