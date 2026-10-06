/**
 * Does the dash's arithmetic hold at both ends, and past them?
 *
 * `ride-dash.tsx` turns eleven telemetry numbers into a needle angle, four bar
 * lengths, three colours and five words, and that arithmetic is where the bugs
 * will be rather than in the markup. The failure to look for is a dial that wraps:
 * the driving model legitimately reports more than `topSpeed` — `driving.ts` lifts
 * the governor by `BOOST_TOP` 3 m/s and power by 1.6, and `driving-state.ts` caps
 * total velocity at `ABSOLUTE_TOP` 29 m/s — so a sweep computed as `speed/topSpeed`
 * would pass 1 on any boost run and a dash arc drawn from it would run backwards.
 * Negative speed is equally real: reverse is a rider paddling the machine
 * backwards at up to `REVERSE_MAX` 4 m/s, and the nose speed of a machine fully
 * sideways can be large and negative while it slides.
 *
 * It also pins the three thresholds the dash shares with the model, because the
 * dash teaching the mechanic depends on them agreeing: the drift word must appear
 * on exactly the frames `driving.ts` starts charging the meter (`DRIFT_SLIP`), the
 * arming notch must sit where the button starts working (`BOOST_ARM`), and the
 * `topSpeed` mark must sit where the throttle's own top is.
 *
 * Node cannot import the component: it does not recognise `.tsx`, and
 * `--experimental-strip-types` cannot strip JSX. So the file is cut at the two
 * markers it carries for the purpose and the arithmetic half — which has no
 * imports by construction — is run on its own. That is the real shipped source,
 * character for character, not a copy.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/ride-dash-readout.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE = new URL('../src/components/ui/ride-dash.tsx', import.meta.url);
const START = 'export type RideTelemetry';
const END = '/* ——— end of the sliced arithmetic';

const whole = readFileSync(SOURCE, 'utf8');
const from = whole.indexOf(START);
const to = whole.indexOf(END);
if (from < 0 || to <= from) throw new Error('ride-dash.tsx no longer carries both slice markers');
const slice = whole.slice(from, to);
if (/import |<[a-zA-Z]/.test(slice)) throw new Error('the sliced region picked up an import or JSX');

const scratch = mkdtempSync(join(tmpdir(), 'otrip-dash-'));
const file = join(scratch, 'readout.ts');
writeFileSync(file, slice);

type Dash = {
  readSpeed: (speed: number) => number;
  sweep: (speed: number, topSpeed: number) => number;
  dashOffset: (lit: number) => number;
  meter: (value: number) => number;
  driftLevel: (slip: number) => number;
  readGrade: (grade: number) => string;
  readState: (
    slip: number,
    frontSlide: number,
    rearSlide: number,
    speed: number
  ) => { text: string; drift: boolean; level: number };
  readBoost: (boost: number, boosting: number) => string;
  spoken: (ride: Record<string, number | string>) => string;
};

let dash: Dash;
try {
  dash = (await import(pathToFileURL(file).href)) as unknown as Dash;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

let failures = 0;
const check = (claim: string, pass: boolean, shown: string) => {
  if (!pass) failures += 1;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${claim.padEnd(54)} ${shown}`);
};

const ARC = Math.PI * 46;
/** The two readings of `topSpeed` in play: the Wave's own top, and the governor. */
const WAVE = 23.6;
const GOVERNED = 25;
const CEILING = 29;
const deg = (radians: number) => (radians * 180) / Math.PI;

console.log('\n=== the dial =========================================================');
console.log('  Full scale is topSpeed × 1.25, so topSpeed itself sits at 0.800.\n');
console.log('   m/s     km/h   sweep@23.6  offset   sweep@25    note');

const ramp = [-CEILING, -8, -4, -0.3, 0, 1, 5, 10, 15, 20, WAVE, GOVERNED, 27.99, CEILING, 31.25, 1e9];
for (const speed of ramp) {
  const a = dash.sweep(speed, WAVE);
  const b = dash.sweep(speed, GOVERNED);
  const note =
    speed === WAVE
      ? '<- the Wave’s own top'
      : speed === GOVERNED
        ? '<- the governor'
        : speed === 27.99
          ? '<- measured, boosted'
          : speed === CEILING
            ? '<- ABSOLUTE_TOP, the hardest ceiling there is'
            : speed === 1e9
              ? '<- absurd, and still bounded'
              : speed < 0
                ? 'reverse: the needle parks'
                : '';
  console.log(
    `  ${speed.toFixed(2).padStart(9)} ${dash.readSpeed(speed).toString().padStart(5)} ` +
      `${a.toFixed(4).padStart(10)} ${dash.dashOffset(a).toFixed(2).padStart(8)} ` +
      `${b.toFixed(4).padStart(9)}    ${note}`
  );
}

const sweeps = ramp.map((speed) => dash.sweep(speed, WAVE));
check('0 m/s lights nothing', dash.sweep(0, WAVE) === 0, '0.0000');
check('topSpeed lands exactly on the mark', Math.abs(dash.sweep(WAVE, WAVE) - 0.8) < 1e-12, '0.8000');
check(
  'a boost run is past the mark but short of full',
  dash.sweep(27.99, WAVE) > 0.8 && dash.sweep(27.99, WAVE) < 1,
  dash.sweep(27.99, WAVE).toFixed(4)
);
check(
  'the hardest the model can go never saturates',
  dash.sweep(CEILING, WAVE) < 1 && dash.sweep(CEILING, GOVERNED) < 1,
  `${dash.sweep(CEILING, WAVE).toFixed(4)} and ${dash.sweep(CEILING, GOVERNED).toFixed(4)}`
);
check('full scale is full and goes no further', dash.sweep(1e9, WAVE) === 1, '1.0000');
check('reverse parks the needle', dash.sweep(-4, WAVE) === 0 && dash.sweep(-CEILING, WAVE) === 0, '0.0000');
check(
  'monotonic across the whole ramp',
  sweeps.every((value, at) => at === 0 || value >= sweeps[at - 1]!),
  'never decreases'
);
check(
  'bounded in [0, 1] throughout',
  sweeps.every((value) => value >= 0 && value <= 1),
  'yes'
);
check(
  'and so is the dash offset it becomes',
  sweeps.every((value) => dash.dashOffset(value) >= 0 && dash.dashOffset(value) <= ARC),
  `[0, ${ARC.toFixed(2)}]`
);
// Garbage in: a NaN reaching `strokeDashoffset` is an arc that silently vanishes,
// and a topSpeed of 0 is what a machine reports before its spec is resolved.
const junk: [string, number, number][] = [
  ['NaN speed', Number.NaN, WAVE],
  ['Infinite speed', Number.POSITIVE_INFINITY, WAVE],
  ['NaN topSpeed', 10, Number.NaN],
  ['zero topSpeed', 10, 0],
];
check(
  'junk reads as zero rather than as NaN',
  junk.every(([, speed, top]) => dash.sweep(speed, top) === 0),
  junk.map(([name]) => name).join(', ')
);

console.log('\n=== the pedals and the meter =========================================');
console.log('  One bar, throttle right of centre and brake left, both as scaleX.\n');
console.log('   value    bar');
for (const value of [-1, -0.001, 0, 0.25, 0.5, 0.73, 1, 1.0001, 7, Number.NaN, Number.POSITIVE_INFINITY]) {
  console.log(`  ${String(value).padStart(8)} ${dash.meter(value).toFixed(3).padStart(6)}`);
}
const bars = [-1, 0, 0.25, 0.5, 1, 7].map(dash.meter);
check('0 and 1 are exact', dash.meter(0) === 0 && dash.meter(1) === 1, '0.000 and 1.000');
check(
  'monotonic and bounded in [0, 1]',
  bars.every((v, at) => v >= 0 && v <= 1 && (at === 0 || v >= bars[at - 1]!)),
  'yes'
);
check('NaN is empty, not a NaN-wide bar', dash.meter(Number.NaN) === 0, '0.000');

console.log('\n=== the drift read-out ===============================================');
console.log('  The word must appear exactly where driving.ts starts charging the');
console.log('  meter: |slip| past DRIFT_SLIP 0.10 rad, which is 5.73°.\n');
console.log('   slip°    level   word                 front/rear');
// The slip ramp with one axle pair held, so the level is the only thing moving.
const levels: number[] = [];
for (const radians of [0, 0.05, 0.1, 0.1001, 0.15, 0.2, 0.3, 0.45, 0.8, 1.4]) {
  const read = dash.readState(radians, 0.2, 0.95, 12);
  levels.push(read.level);
  console.log(
    `  ${deg(radians).toFixed(2).padStart(7)} ${read.level.toFixed(3).padStart(7)}   ` +
      `${(read.text || '—').padEnd(20)} 0.20/0.95`
  );
}
console.log('\n  Which end, at a fixed 17° of slip:\n');
for (const [front, rear] of [
  [0.9, 0.2],
  [0.2, 0.95],
  [0.8, 0.85],
  [0.3, 0.8],
] as const) {
  const read = dash.readState(0.3, front, rear, 12);
  console.log(`  ${front.toFixed(2)}/${rear.toFixed(2)}  ${read.text}`);
}
check('silent at a dead-straight 0°', dash.readState(0, 0, 0, 12).text === '', 'no word');
check('still silent exactly at DRIFT_SLIP', dash.readState(0.1, 0.5, 0.9, 12).text === '', '5.73° is not yet a drift');
check('speaks the moment it is past it', dash.readState(0.1001, 0.2, 0.9, 12).drift, 'yes');
check(
  'the drift level is bounded and monotonic in slip',
  levels.every((v, i) => v >= 0 && v <= 1 && (i === 0 || v >= levels[i - 1]!)),
  `${levels[0]!.toFixed(3)} → ${levels.at(-1)!.toFixed(3)}`
);
check('and legible the instant it appears', dash.readState(0.1001, 0.2, 0.9, 12).level >= 0.4, '≥ 0.400');
check('a rear step-out names the rear', dash.readState(0.3, 0.1, 0.9, 12).text === 'Bánh sau trượt', 'Bánh sau trượt');
check(
  'a front wash names the front',
  dash.readState(0.3, 0.9, 0.1, 12).text === 'Bánh trước trượt',
  'Bánh trước trượt'
);
check(
  'both gone within AXLE_MARGIN names both',
  dash.readState(0.3, 0.8, 0.85, 12).text === 'Trượt cả hai bánh',
  'Trượt cả hai bánh'
);
// `driving.ts` pins rearSlide to HANDBRAKE_BITE 0.8 the instant the handbrake is
// touched, so a stab has to read as a rear step-out without any help.
check(
  'a handbrake stab reads as the rear, not as both',
  dash.readState(0.25, 0.3, 0.8, 12).text === 'Bánh sau trượt',
  'front 0.30 against the bite’s 0.80'
);
check('sideways is symmetric', dash.readState(-0.3, 0.1, 0.9, 12).text === 'Bánh sau trượt', 'left and right alike');
check('reverse gets the line when nothing is sliding', dash.readState(0, 0, 0, -1.2).text === 'Đang lùi', 'Đang lùi');
check('a stopped machine is not reversing', dash.readState(0, 0, 0, -0.2).text === '', 'inside REVERSE_FLOOR');
check('and a slide outranks it', dash.readState(0.4, 0.1, 0.9, -2).text === 'Bánh sau trượt', 'the slide is the news');

console.log('\n=== the boost meter ==================================================');
console.log('   meter  lit    word');
for (const [boost, lit] of [
  [0, 0],
  [0.24, 0],
  [0.25, 0],
  [0.6, 0],
  [1, 0],
  [0.6, 1],
  [1, 1],
  [0, 1],
  [Number.NaN, Number.NaN],
] as const) {
  console.log(`  ${String(boost).padStart(6)} ${String(lit).padStart(5)}  ${dash.readBoost(boost, lit) || '—'}`);
}
check('nothing to say below the arming notch', dash.readBoost(0.24, 0) === '', 'silent at 0.24');
check('armed at BOOST_ARM, where the notch is drawn', dash.readBoost(0.25, 0) === 'sẵn', 'sẵn at 0.25');
check('full says so', dash.readBoost(1, 0) === 'đầy', 'đầy');
check('and burning outranks full', dash.readBoost(1, 1) === 'đang vọt', 'đang vọt');

console.log('\n=== the gradient =====================================================');
console.log('   grade    read');
for (const grade of [-0.5, -0.25, -0.03, -0.029, 0, 0.029, 0.03, 0.12, 0.25, 1.4, Number.NaN]) {
  console.log(`  ${String(grade).padStart(7)}    ${dash.readGrade(grade) || '—'}`);
}
check('flat enough is not a hill', dash.readGrade(0.029) === '' && dash.readGrade(0) === '', 'silent under 3%');
check('a 1:4 climb reads 25%', dash.readGrade(0.25) === '↗ 25%', '↗ 25%');
check('and a 1:4 descent the other way', dash.readGrade(-0.25) === '↘ 25%', '↘ 25%');
check('a cliff cannot widen the panel', dash.readGrade(1.4) === '↗ 99%', 'capped at 99%');

console.log('\n=== what a screen reader hears =======================================');
const ride = (fields: Record<string, number | string>) => ({
  speed: 0,
  topSpeed: GOVERNED,
  throttle: 0,
  brake: 0,
  handbrake: 0,
  boost: 0,
  boosting: 0,
  slip: 0,
  frontSlide: 0,
  rearSlide: 0,
  grade: 0,
  noun: 'xe máy',
  ...fields,
});
const lines: [string, Record<string, number | string>][] = [
  ['stopped', {}],
  ['pulling away', { speed: 6.2 }],
  ['at the Wave’s top', { speed: WAVE }],
  ['one frame later', { speed: 23.74 }],
  ['on the brakes', { speed: 11.1, brake: 1 }],
  ['sliding the rear', { speed: 14, slip: 0.3, frontSlide: 0.2, rearSlide: 0.9 }],
  ['meter full', { speed: 18, boost: 1 }],
  ['burning it', { speed: 27.5, boost: 0.4, boosting: 1 }],
  ['paddling backwards', { speed: -1.1 }],
];
for (const [label, fields] of lines) console.log(`  ${label.padEnd(20)} "${dash.spoken(ride(fields))}"`);
check(
  'two frames 0.5 km/h apart read the same, so nothing is re-announced',
  dash.spoken(ride({ speed: WAVE })) === dash.spoken(ride({ speed: 23.74 })),
  `both "${dash.spoken(ride({ speed: WAVE }))}"`
);
check('reverse is named rather than signed', dash.spoken(ride({ speed: -1.1 })).startsWith('lùi'), 'lùi 5 km/h');
check('a full meter is worth interrupting for', dash.spoken(ride({ speed: 18, boost: 1 })).includes('đủ đà'), 'đủ đà');

console.log(failures ? `\nFAILED — ${failures} check${failures === 1 ? '' : 's'}\n` : '\nOK\n');
if (failures) process.exitCode = 1;
