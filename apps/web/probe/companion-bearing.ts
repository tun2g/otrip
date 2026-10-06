/**
 * Does the compass arrow point at the friend, or at where you came from?
 *
 * `relativeTo` in `companion-markers.ts` is the only piece of this work whose
 * failure is a sign — an arrow that points behind you when your friend is ahead
 * is wrong for every user, in every session, and looks exactly as deliberate as
 * the correct version in a screenshot. Two conventions in this repo are already
 * documented as having been got wrong once: `walker.ts` carries a paragraph
 * about D having strafed left for everyone, and `world-map.ts` says the map
 * rotation is `π − yaw` "because guessing a sign gets you an arrow pointing
 * where you came from". So this derives nothing by eye.
 *
 * Also prints what 9 m comes to on the 140 px minimap, which is the measurement
 * that decided the minimap is not the close-range answer and was left alone.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/companion-bearing.ts
 */
import { relativeTo } from '../src/scene/companion-markers.ts';

/**
 * The scene's compass, from `world-map.ts`: the walker sets
 * `yaw = atan2(move.x, move.z)`, so forward is `(sin yaw, 0, cos yaw)`, north is
 * −Z and east is +X. These are therefore the yaws of a player facing each way.
 */
const FACING = [
  { name: 'bắc (north)', yaw: Math.atan2(0, -1) },
  { name: 'đông (east)', yaw: Math.atan2(1, 0) },
  { name: 'nam  (south)', yaw: Math.atan2(0, 1) },
  { name: 'tây  (west)', yaw: Math.atan2(-1, 0) },
] as const;

/** Where the companion stands, 20 m off, in the same basis. */
const PLACED = [
  { name: 'bắc', x: 0, z: -20 },
  { name: 'đông', x: 20, z: 0 },
  { name: 'nam', x: 0, z: 20 },
  { name: 'tây', x: -20, z: 0 },
] as const;

/**
 * What a person would say, given the turn. `bearing` is clockwise from straight
 * ahead, so this is the same ladder the compass chips read off it.
 */
const spoken = (bearing: number): string => {
  const away = Math.abs(bearing);
  const side = bearing > 0 ? 'phải' : 'trái';
  if (away <= 0.39) return 'ngay phía trước';
  if (away >= 2.75) return 'ngay phía sau';
  if (away <= 1.18) return `phía trước bên ${side}`;
  if (away <= 1.96) return `bên ${side}`;
  return `phía sau bên ${side}`;
};

/**
 * The expectation, derived from the compass and not from the formula under test.
 * `FACING` and `PLACED` are both in clockwise order — north, east, south, west —
 * so a friend `q` quarter-turns clockwise of where you face is `q · 90°` to your
 * right, and three quarters clockwise is one quarter left. A table that agreed
 * with the code because it was computed the same way would prove nothing.
 */
const expected = (facing: number, placed: number): number => {
  const quarters = (placed - facing + 4) % 4;
  return quarters === 3 ? -90 : quarters * 90;
};

console.log('\n--- which way does a person turn? ---\n');
console.log(`  ${'facing'.padEnd(14)}${'friend'.padEnd(8)}${'bearing'.padEnd(10)}${'want'.padEnd(8)}reads as`);

let wrong = 0;
for (const [facingAt, facing] of FACING.entries()) {
  for (const [placedAt, placed] of PLACED.entries()) {
    const { bearing, range } = relativeTo({ x: 0, z: 0, yaw: facing.yaw }, placed);
    const degrees = (bearing * 180) / Math.PI;
    const want = expected(facingAt, placedAt);
    // Compared as an angle, not as a number. Exactly behind is one direction
    // with two spellings — `atan2` hands back −180° or +180° depending on which
    // side the floating-point sine of π lands on — and an arrow drawn at either
    // points the same way.
    const slip = ((degrees - want) * Math.PI) / 180;
    const ok = Math.abs(Math.atan2(Math.sin(slip), Math.cos(slip))) < 1e-6 && Math.abs(range - 20) < 0.001;
    if (!ok) wrong += 1;

    console.log(
      `  ${facing.name.padEnd(14)}${placed.name.padEnd(8)}` +
        `${`${degrees.toFixed(0)}°`.padEnd(10)}${`${want}°`.padEnd(8)}${spoken(bearing)}${ok ? '' : '   <- WRONG'}`
    );
  }
  console.log('');
}

console.log('  Positive is clockwise, which is what CSS `rotate()` on an ↑ does,');
console.log('  so +90° points the glyph at screen right. Facing north, east is');
console.log('  on your right: the first block above must read +90° for đông.\n');

/**
 * The case the whole fix is for: a companion 16.75 m away, measured on the live
 * site, with the player facing the arrival direction the walker picked.
 */
console.log('--- the measured case: a companion 16.75 m off, in each direction ---\n');
// The player faces north, so forward is −Z and screen right is +X: the offsets
// below are written in world metres and the words have to come out matching.
const NORTH = Math.atan2(0, -1);
for (const offset of [
  { name: 'in front', x: 0, z: -16.75 },
  { name: 'behind', x: 0, z: 16.75 },
  { name: 'hard right', x: 16.75, z: 0 },
  { name: 'over the shoulder', x: 11.84, z: 11.84 },
] as const) {
  const { bearing, range } = relativeTo({ x: 0, z: 0, yaw: NORTH }, offset);
  console.log(
    `  ${offset.name.padEnd(20)}${`${range.toFixed(2)} m`.padEnd(10)}` +
      `${`${((bearing * 180) / Math.PI).toFixed(0)}°`.padEnd(8)}${spoken(bearing)}`
  );
}

/**
 * Why `minimap.tsx` was left as a legibility fix rather than made the answer.
 * `worldToMapFraction` maps the whole terrain across the canvas, and the canvas
 * is `SIZE = 140`, so the scale is fixed by the place rather than by the zoom.
 */
console.log('\n--- can you see a companion on the minimap? ---\n');
const SIZE = 140;
/** `drawHeadingMarker(..., { radius: 7 })` for the player, in `minimap.tsx`. */
const PLAYER_RADIUS = 7;

for (const [place, terrain] of [
  ['Tà Xùa', 5200],
  ['Hạ Long', 4200],
  ['Hội An', 3800],
  ['Tam Cốc', 3600],
] as const) {
  const perPixel = terrain / SIZE;
  console.log(
    `  ${place.padEnd(10)}${`${terrain} m across`.padEnd(16)}${`${perPixel.toFixed(1)} m/px`.padEnd(12)}` +
      `9 m = ${(9 / perPixel).toFixed(2)} px · 17 m = ${(17 / perPixel).toFixed(2)} px · ` +
      `the player's own arrow covers ${Math.round(PLAYER_RADIUS * perPixel)} m`
  );
}

console.log('');
console.log('  A companion at 9–17 m is a quarter of a pixel from the player dot,');
console.log('  underneath an arrow that is 180–260 m wide in world terms. No change');
console.log('  to the minimap can answer close range; the compass has to.\n');

if (wrong) {
  console.error(`FAILED: ${wrong} of 16 bearings point the wrong way.\n`);
  process.exitCode = 1;
} else {
  console.log('OK — all 16 bearings point where a person would point\n');
}
