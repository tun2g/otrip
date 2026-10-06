import type { Checkpoint, RaceRoute } from './race-route';

/**
 * How far round the route everybody is, and who is winning.
 *
 * Separate from `race-route.ts` because the two answer different questions and
 * run at different rates: the route is laid once when the world is built, and
 * this runs every frame for every racer in the room. Keeping the per-frame law
 * in one small file is also what lets it be driven headlessly without a terrain.
 *
 * Nothing here holds state of its own — a `RacerProgress` is passed in and
 * mutated — so the local player and a companion whose position arrived over the
 * network are advanced by exactly the same code.
 */

/** Seconds of getting further from the next checkpoint before the HUD says so.
 *  A hairpin legitimately costs about a second and a half of that. */
const WRONG_WAY_AFTER = 2.5;
/** Below this, m/s, a racer is stopped rather than lost, and the timer is held. */
const WRONG_WAY_MOVING = 1.5;

/** Where a race is up to. Owned by the room, mirrored into the scene. */
export type RacePhase = 'idle' | 'grid' | 'countdown' | 'running' | 'ended';

/**
 * How far round the lap one racer is. Held per racer — the local player from
 * their own position, a companion from the position the room last sent — so the
 * standings are worked out for everybody by one law.
 */
export type RacerProgress = {
  /** Laps completed. */
  lap: number;
  /** Checkpoints passed in the current lap, 0 to `checks.length`. */
  check: number;
  /** Checkpoints passed since the race began, which is what the order reads. */
  passed: number;
  /** Checkpoints the racer got past without crossing inside. A lap with any is
   *  not a record, which is the only penalty — refusing it outright is worse. */
  missed: number;
  /** Metres to the next checkpoint, which orders two racers between the same pair. */
  toNext: number;
  /** Milliseconds, on whatever monotonic clock the caller passes in. */
  lapStart: number;
  lastLap: number;
  bestLap: number;
  finished: number;
  /** Seconds the gap to the next checkpoint has been opening while under way. */
  adrift: number;
  wrongWay: boolean;
  /** Where the racer was last seen, so a step can be tested for a crossing. */
  lastX: number;
  lastZ: number;
  seen: boolean;
};

export const createProgress = (): RacerProgress => ({
  lap: 0,
  check: 0,
  passed: 0,
  missed: 0,
  toNext: Infinity,
  lapStart: 0,
  lastLap: 0,
  bestLap: 0,
  finished: 0,
  adrift: 0,
  wrongWay: false,
  lastX: 0,
  lastZ: 0,
  seen: false,
});

export const resetProgress = (progress: RacerProgress, nowMs: number) => {
  progress.lap = 0;
  progress.check = 0;
  progress.passed = 0;
  progress.missed = 0;
  progress.toNext = Infinity;
  progress.lapStart = nowMs;
  progress.lastLap = 0;
  progress.bestLap = 0;
  progress.finished = 0;
  progress.adrift = 0;
  progress.wrongWay = false;
  progress.seen = false;
};

/** What one step through the route did. */
export type RaceEvent = 'none' | 'check' | 'lap';

/**
 * Whether the step from where the racer was to where they are now crosses the
 * checkpoint's plane, the right way, between the kerbs.
 *
 * A plane crossing rather than a radius. A radius is either too small to catch a
 * bike doing 25 m/s on a long frame — the walker clamps delta at 0.1 s, which is
 * 2.5 m of travel — or so large that it also catches a racer who drove past on
 * the verge. A sign change cannot be missed at any frame rate, and the `t` of it
 * is what says where the crossing happened.
 */
const crosses = (check: Checkpoint, fromX: number, fromZ: number, toX: number, toZ: number): boolean => {
  const before = (fromX - check.x) * check.nx + (fromZ - check.z) * check.nz;
  const after = (toX - check.x) * check.nx + (toZ - check.z) * check.nz;
  if (before > 0 || after <= 0) return false;

  const span = after - before;
  const t = span > 1e-9 ? -before / span : 0;
  const atX = fromX + (toX - fromX) * t;
  const atZ = fromZ + (toZ - fromZ) * t;
  const across = (atX - check.x) * check.ax + (atZ - check.z) * check.az;
  return Math.abs(across) <= check.halfWidth;
};

/**
 * Advances one racer, and says what happened.
 *
 * Two checkpoints are armed, not one. Strict ordering is what makes a lap mean
 * something, but a racer who put a wheel on the verge at checkpoint four and is
 * told at checkpoint nine that they are still on four has been handed an
 * unrecoverable state by a rule meant to stop cheating. So crossing the one
 * after the expected one claims both and counts a miss, which costs the lap
 * record and nothing else.
 *
 * @param nowMs any monotonic millisecond clock; lap times are differences on it.
 */
export const trackProgress = (
  route: RaceRoute,
  progress: RacerProgress,
  x: number,
  z: number,
  nowMs: number,
  delta: number
): RaceEvent => {
  const checks = route.checks;

  if (!progress.seen) {
    progress.seen = true;
    progress.lastX = x;
    progress.lastZ = z;
    return 'none';
  }

  const fromX = progress.lastX;
  const fromZ = progress.lastZ;
  progress.lastX = x;
  progress.lastZ = z;

  let event: RaceEvent = 'none';
  const expected = checks[progress.check];
  const following = checks[(progress.check + 1) % checks.length];

  const claim = (count: number) => {
    progress.check += count;
    progress.passed += count;
    if (progress.check < checks.length) {
      event = 'check';
      return;
    }
    // The lap line. `check` goes back round and the lap is banked.
    progress.check -= checks.length;
    progress.lap += 1;
    progress.lastLap = nowMs - progress.lapStart;
    // A lap with a missed checkpoint is driven and counted but is not a record:
    // the racer may have cut a corner and there is no way to know they did not.
    if (progress.missed === 0 && (progress.bestLap === 0 || progress.lastLap < progress.bestLap)) {
      progress.bestLap = progress.lastLap;
    }
    progress.lapStart = nowMs;
    progress.missed = 0;
    event = 'lap';
  };

  if (expected && crosses(expected, fromX, fromZ, x, z)) claim(1);
  else if (following && following !== expected && crosses(following, fromX, fromZ, x, z)) {
    progress.missed += 1;
    claim(2);
  }

  const armed = checks[progress.check];
  const was = progress.toNext;
  progress.toNext = armed ? Math.hypot(armed.x - x, armed.z - z) : Infinity;

  const travelled = Math.hypot(x - fromX, z - fromZ);
  const moving = delta > 0 && travelled / delta > WRONG_WAY_MOVING;
  // Held while stopped: a racer parked at the turn is not going the wrong way,
  // they are stopped, and saying otherwise is noise.
  if (!moving || event !== 'none') progress.adrift = 0;
  else if (Number.isFinite(was) && progress.toNext > was) progress.adrift += delta;
  else progress.adrift = 0;
  progress.wrongWay = progress.adrift > WRONG_WAY_AFTER;

  return event;
};

/**
 * The sort key for the standings: more checkpoints first, and between two racers
 * on the same stretch, the one nearer the next one.
 *
 * One number rather than a comparator, so the same ordering applies to the local
 * player and to a companion whose count arrived over the network. `toNext` is
 * folded in rather than compared because the checkpoints are 180 m apart and a
 * lap is at most 18 of them, so a metre of road can never outweigh one.
 */
export const standingKey = (progress: RacerProgress): number =>
  progress.passed * 10_000 - Math.min(9_999, progress.toNext);

/** mm:ss.mmm, the way a lap time is read. 0 is "no time yet", not "zero". */
export const formatLapTime = (ms: number): string => {
  if (!(ms > 0)) return '—';
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const thousandths = Math.floor(ms % 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(thousandths).padStart(3, '0')}`;
};

/** The gap to the leader, signed the way a timing screen signs it. */
export const formatGap = (ms: number): string => (ms > 0 ? `+${(ms / 1000).toFixed(1)}s` : '—');
