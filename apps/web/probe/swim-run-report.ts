import { readFileSync } from 'node:fs';
import { createTerrain, LOCATIONS } from '@otrip/world';
import { AnimationMixer, Box3, Vector3, type Object3D } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

import { afloatAt, SWIM_DEPTH, WADE_DEPTH } from '@/scene/swimming';

const SEGMENTS = 288;

console.log('=== 1. WATER: how deep each destination actually is ===');
console.log('place      level  deepest   water%   >wade%   >swim%   (% of map / % of the water)');
for (const slug of ['hoi-an', 'trang-an', 'ho-tay', 'ta-xua']) {
  const recipe = LOCATIONS[slug];
  if (!recipe?.water) {
    console.log(`${slug.padEnd(10)} no water`);
    continue;
  }
  const terrain = createTerrain(recipe, SEGMENTS);
  const level = recipe.water.level;
  const half = terrain.size / 2 - 4;
  const grid = 400;
  let wet = 0;
  let wade = 0;
  let swim = 0;
  let deepest = 0;
  for (let i = 0; i < grid; i += 1) {
    for (let j = 0; j < grid; j += 1) {
      const depth = Math.max(
        0,
        level - terrain.heightAt(-half + (2 * half * i) / (grid - 1), -half + (2 * half * j) / (grid - 1))
      );
      if (depth <= 0) continue;
      wet += 1;
      if (depth > WADE_DEPTH) wade += 1;
      if (depth > SWIM_DEPTH) swim += 1;
      deepest = Math.max(deepest, depth);
    }
  }
  const total = grid * grid;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  const share = (n: number) => `${((n / wet) * 100).toFixed(1)}%`;
  console.log(
    `${slug.padEnd(10)} ${String(level).padStart(5)}  ${deepest.toFixed(1).padStart(6)}m  ` +
      `${pct(wet).padStart(6)}  ${pct(wade).padStart(6)}/${share(wade).padStart(6)}  ${pct(swim).padStart(6)}/${share(swim).padStart(6)}`
  );
}
console.log(
  `\nafloat(depth): ${[0.4, 0.8, 1.0, 1.3, 1.45, 1.55, 2, 6.8, 20].map((d) => `${d}m=${afloatAt(d).toFixed(2)}`).join('  ')}`
);
console.log(`WADE_DEPTH=${WADE_DEPTH}  SWIM_DEPTH=${SWIM_DEPTH}  (swimming starts at afloat>0.45, i.e. ${'1.28'}m)`);

console.log('\n=== 2. RUN: clip rate against the ground ===');
const buffer = readFileSync('/Users/macbook/Documents/self/otrip/apps/web/public/models/people/human.fbx');
const model = new FBXLoader().parse(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  '/models/people/'
);
const box = new Box3().setFromObject(model);
const scale = 1.78 / (box.max.y - box.min.y);
const left = model.getObjectByName('LeftToeBase') as Object3D;
const right = model.getObjectByName('RightToeBase') as Object3D;
const mixer = new AnimationMixer(model);
const a = new Vector3();
const b = new Vector3();
const strideOf = (fragment: string) => {
  const clip = model.animations.find((entry) => entry.name.toLowerCase().includes(fragment))!;
  mixer.stopAllAction();
  mixer.clipAction(clip).reset().play();
  let widest = 0;
  for (let step = 0; step < 48; step += 1) {
    mixer.setTime((step / 48) * clip.duration);
    model.updateMatrixWorld(true);
    a.setFromMatrixPosition(left.matrixWorld);
    b.setFromMatrixPosition(right.matrixWorld);
    widest = Math.max(widest, Math.hypot(a.x - b.x, a.z - b.z));
  }
  return { cycle: clip.duration, stride: widest * scale * 2 };
};
const walk = strideOf('walk');
const run = strideOf('run');
console.log(
  `measured: walk cycle ${walk.cycle.toFixed(3)}s stride ${walk.stride.toFixed(3)}m | run cycle ${run.cycle.toFixed(3)}s stride ${run.stride.toFixed(3)}m`
);

const RUN_CLIP_AT = 2.8;
const MIN = 0.35;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** The curve the clip rate used to be fitted with, kept only for the comparison. */
const guessedStride = (speed: number) => (0.68 + speed * 0.09) * 2;

type Column = { name: string; jog: number; max: number; stride: (clip: { stride: number }, speed: number) => number };
const COLUMNS: Column[] = [
  { name: 'A reported', jog: 4.5, max: 2.4, stride: (_clip, speed) => guessedStride(speed) },
  { name: 'B stride fix', jog: 4.5, max: 2.25, stride: (clip) => clip.stride },
  { name: 'C + slower jog', jog: 3.9, max: 2.25, stride: (clip) => clip.stride },
];

const ladder = (jog: number) =>
  [
    ['stroll', 1.4],
    ['walk', 2.4],
    ['brisk (mid ladder)', (2.4 + jog) / 2],
    ['jog, W held', jog],
    ['travel, Shift', 14],
  ] as const;

for (const column of COLUMNS) {
  console.log(`\n--- ${column.name}: JOG_SPEED ${column.jog}, MAX_CLIP_RATE ${column.max} ---`);
  console.log('gait                 speed   km/h  clip  rate    feet m/s   spm  skate');
  for (const [name, speed] of ladder(column.jog)) {
    const running = speed > RUN_CLIP_AT;
    const clip = running ? run : walk;
    const stride = column.stride(clip, speed);
    const rate = clamp((speed * clip.cycle) / stride, MIN, column.max);
    // What the clip actually carries the feet at is always its own stride.
    const feet = (clip.stride / clip.cycle) * rate;
    const spm = (120 * rate) / clip.cycle;
    console.log(
      `${name.padEnd(19)} ${speed.toFixed(2).padStart(5)}  ${(speed * 3.6).toFixed(1).padStart(5)}  ` +
        `${(running ? 'run' : 'walk').padEnd(4)}  ${rate.toFixed(3).padStart(5)}  ${feet.toFixed(2).padStart(8)}  ` +
        `${spm.toFixed(0).padStart(4)}  ${((feet / speed - 1) * 100).toFixed(0).padStart(4)}%`
    );
  }
}
console.log('\nskate = how far the feet travel against how far the body does. 0% is no sliding.');
console.log('spm = steps a minute. Recreational runners hold 160-180; walking is 100-130.');
