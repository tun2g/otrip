/**
 * Does a companion's avatar survive one bad frame from the room?
 *
 * The reported bug: two people in one room, both panels correctly reading "Bạn
 * và 1 người nữa", and neither able to see the other — not the body, not even
 * the name label, which is a `Sprite` with `depthTest: false` and so is drawn
 * through walls. State arriving while nothing is drawn points at the position,
 * and `avatars.ts` had a latch there.
 *
 * `trip-client.ts` rebuilds the whole roster on every `onStateChange`, and a
 * change fires when a player is *added* as well as when their fields are
 * decoded, so one snapshot can carry an entry whose `x` is not yet a number.
 * `create()` wrote it straight into `avatar.position`, and from there nothing
 * recovered: `position.lerp(target)` leaves NaN as NaN, and the teleport escape
 * was written `distanceToSquared(target) > SNAP * SNAP`, which is **false** for
 * NaN — so the easing branch was chosen for ever.
 *
 * This drives `createAvatars` directly, with no terrain and no model, and
 * measures the thing the player sees: whether the avatar ends up somewhere the
 * renderer can draw. It also evaluates the old comparison alongside the new one
 * on the same numbers, so the fix is shown to be a fix rather than asserted.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/avatar-sync.ts
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
 * `createLabel` asks for a canvas and `paintLabel` asks it for a 2D context.
 * The context comes back null, which `paintLabel` already handles by returning —
 * it is the one branch in that file written for a machine without a canvas, and
 * it means the label's geometry and placement are still exercised here while
 * nothing tries to rasterise text.
 */
const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
globals.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
globals.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({ width: 0, height: 0, getContext: () => null }),
};

const { createAvatars } = await import('../src/scene/avatars.ts');

/** A roster entry exactly as `trip-client.ts` builds one, fields and all. */
const player = (fields: Partial<RemotePlayer>): RemotePlayer =>
  ({
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
  }) as RemotePlayer;

const avatars = createAvatars();
const group = avatars.group;

/** Where the one avatar actually is, or null when there is no avatar at all. */
const at = (): { x: number; y: number; z: number } | null => {
  const entry = group.children[0];
  if (!entry) return null;
  return { x: entry.position.x, y: entry.position.y, z: entry.position.z };
};

const drawable = (): boolean => {
  const where = at();
  return where !== null && Number.isFinite(where.x) && Number.isFinite(where.y) && Number.isFinite(where.z);
};

const show = (label: string, note = '') => {
  const where = at();
  const text = where ? `(${where.x.toFixed(2)}, ${where.y.toFixed(2)}, ${where.z.toFixed(2)})` : 'no avatar';
  console.log(`  ${label.padEnd(34)} ${text.padEnd(30)} drawable=${drawable() ? 'yes' : 'NO'} ${note}`);
};

// The spawn the room would really report at Tà Xùa: off-centre, high up.
const REAL = { x: 240.2, y: 327.07, z: 99.5 };

console.log('\n--- the reported sequence: one undecoded snapshot, then real ones ---');

// Frame 1: the player exists in the map, the numbers have not landed. This is
// the frame the whole bug turns on, and `undefined` is what it carries.
avatars.sync([player({ x: undefined as unknown as number, y: undefined as unknown as number })]);
show('after undecoded snapshot', '<- must not create a broken avatar');

// Frames 2 onward: the real position, arriving ten times a second.
for (let frame = 0; frame < 6; frame += 1) {
  avatars.sync([player(REAL)]);
  avatars.update(1 / 10, { x: REAL.x, z: REAL.z });
}
show('after 6 real snapshots', '<- the companion must be here');

if (!drawable()) {
  console.error('\nFAILED: the avatar is still unrenderable after good data arrived.');
  process.exitCode = 1;
}

console.log('\n--- the latch itself, old test against new, on the same numbers ---');
console.log('  A position already NaN, a target 0.5 m away — a normal walking step.\n');

const SNAP = 25;
for (const [label, distanceSquared] of [
  ['a 0.5 m walking step', 0.25],
  ['a 40 m travel jump', 1600],
  ['a NaN position', Number.NaN],
] as const) {
  const old = distanceSquared > SNAP * SNAP;
  const now = !(distanceSquared <= SNAP * SNAP);
  console.log(
    `  ${label.padEnd(24)} old snaps=${String(old).padEnd(5)} new snaps=${String(now).padEnd(5)} ` +
      `${old === now ? 'same' : '<- DIFFERS: NaN now recovers instead of latching'}`
  );
}

console.log('\n--- a player who never gets a position is simply not in the room ---');

const fresh = createAvatars();
fresh.sync([player({ id: 'ghost', x: Number.NaN, y: Number.NaN, z: Number.NaN })]);
fresh.update(1 / 10, { x: 0, z: 0 });
console.log(`  avatars in the scene: ${fresh.group.children.length} (expected 0)`);
if (fresh.group.children.length !== 0) {
  console.error('FAILED: an unplaced player was given an avatar.');
  process.exitCode = 1;
}

// And once their position does arrive, they appear — the hold is not a ban.
fresh.sync([player({ id: 'ghost', ...REAL })]);
fresh.update(1 / 10, { x: REAL.x, z: REAL.z });
console.log(`  after a good snapshot:  ${fresh.group.children.length} (expected 1)`);
if (fresh.group.children.length !== 1) {
  console.error('FAILED: a player held out never got in.');
  process.exitCode = 1;
}

fresh.dispose();
avatars.dispose();

console.log(process.exitCode ? '\nFAILED\n' : '\nOK — one bad frame no longer costs the session\n');
