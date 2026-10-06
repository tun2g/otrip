import type { Client } from 'colyseus';

import { loadConfig } from '../../config/configuration.ts';
import type { PlayerInstance, TripStateInstance } from './trip.schema.ts';

const config = loadConfig();

/**
 * The race, as a protocol.
 *
 * Split out of `trip.room.ts` along the obvious seam: the room is about being
 * somewhere together and this is about one game played there, it is the only
 * part with phases and timers, and the room was already 215 lines.
 *
 * ## What is checked and what is not
 *
 * Positions are reported by the client and always will be — the browser owns the
 * heightfield, the roads and the vehicle model, and the server has no view of
 * the carriageway at all. So there is no pretending here that a lap was watched.
 * What is checked is the part where cheating would actually change the result:
 *
 *  - the **order** of the checkpoints, by the same rule the browser uses, so a
 *    lap cannot be driven by crossing the line back and forth;
 *  - the **time** it took, against a bound derived from the route's own geometry
 *    and the server's speed limit, so a lap cannot be claimed faster than a
 *    vehicle can travel the distance;
 *  - **when the lights go out**, which is held here and never asked of a client.
 *
 * Everything else — where the bike is, which way it is pointing, how fast it
 * says it is going — is taken on trust, because the alternative is a second
 * physics model on a machine that cannot see the road.
 */

/** `RacePhase` in `scene/race.ts`, which draws it. Duplicated rather than
 *  imported because that file is a browser module built on the road network. */
export type RacePhase = 'idle' | 'grid' | 'countdown' | 'running' | 'ended';

/**
 * A grid phase exists because `race:join` has to be answerable: somebody sets a
 * race up and everyone else needs a moment to see the offer and accept it, and
 * the lights are then a separate window so that the thing a racer is staring at
 * counts down from a number and not from fifteen. Both are in
 * `configuration.ts`, which says why.
 */
const GRID_MS = config.raceGridMs;
const LIGHTS_MS = config.raceLightsMs;

/**
 * What a route can be, straight out of `race-route.ts`.
 *
 * `planRoute` builds `stationCount = clamp(round(legLength / 180) + 1, 4, 10)`
 * stations and a lap of `2 × stationCount − 2` crossings, over a leg of
 * `MIN_LEG = 200` to `LEG_TARGET = 800` metres. So a lap is 400 to 1600 m and 6
 * to 18 checks, and anything outside that was not produced by the planner.
 */
const MIN_LAP_LENGTH = 400;
const MAX_LAP_LENGTH = 1600;
const MIN_CHECKS_PER_LAP = 6;
const MAX_CHECKS_PER_LAP = 18;
const MAX_LAPS = 20;

/**
 * Milliseconds of slack on the server's own reckoning of how long a race has
 * been running.
 *
 * Two things spend it, and neither is cheating. A client whose clock is a second
 * ahead of the server's believes the lights went out a second early and starts
 * racing then; and the socket that carries a check claim is the same one that
 * delivers a backlog in a burst, which `move-budget.ts` banks 1.5 s of travel
 * against. Rounded up to two seconds, which is nothing against a lap but is the
 * difference between a legitimate first checkpoint being accepted and a racer
 * being told their lap did not happen.
 */
const JITTER_MS = 2000;

/**
 * What share of the derived split is actually required.
 *
 * The bound is the station spacing over the speed limit, and the spacing is
 * measured along the centreline while a racer drives the inside line: a bend
 * taken on the kerb across a 7 m carriageway is a few per cent shorter than the
 * road is. So the true minimum is a little under the derived one, and demanding
 * the whole of it refuses a crossing that really happened.
 *
 * It also takes the arithmetic off an exact boundary. A claim of precisely
 * `k × split` is the fastest legitimate lap there can be, and in floating point
 * `5 × split − 4 × split` lands a few ulps under `split`, so the exact bound
 * refused the fifth crossing of a flat-out lap — measured, not supposed.
 */
const SPLIT_SHARE = 0.9;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const whole = (value: unknown, min: number, max: number): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
};

/** How far one racer has got, by the server's own count of what it accepted. */
type Progress = {
  /** Checkpoints accepted since the lights went out, which is what the order reads. */
  passed: number;
  /** The racer's own clock at the last accepted crossing, and at the lap it is on. */
  lastAtMs: number;
  lapStartMs: number;
  /** Crossings claimed with the one before them unaccounted for. A lap with any
   *  is driven and counted but is not a record — the rule in `scene/race.ts`,
   *  for the same reason: the racer may have cut a corner and there is no way to
   *  know from here that they did not. */
  missed: number;
};

type SetupMessage = { laps?: unknown; checksPerLap?: unknown; lapLength?: unknown };
type CheckMessage = { check?: unknown; lap?: unknown; atMs?: unknown };
type FinishMessage = { ms?: unknown };

export type RaceTimer = { after: (ms: number, run: () => void) => { clear: () => void } };

export class Race {
  private progress = new Map<string, Progress>();
  private pending: { clear: () => void }[] = [];

  /**
   * Assigned in the body rather than declared as parameter properties: the
   * server runs from TypeScript source through Node's type stripping, which
   * erases types but cannot emit the assignments a parameter property implies —
   * the same reason `trip.schema.ts` cannot use decorators.
   */
  private readonly state: TripStateInstance;
  /** The room's own speed limit, in m/s. The timing bounds are derived from it
   *  rather than from a figure of their own, so there is exactly one number in
   *  the server that says how fast anything can move. */
  private readonly maxSpeed: number;
  private readonly timer: RaceTimer;

  constructor(state: TripStateInstance, maxSpeed: number, timer: RaceTimer) {
    this.state = state;
    this.maxSpeed = maxSpeed;
    this.timer = timer;
  }

  /**
   * The least time between two crossings that a vehicle could have taken.
   *
   * The stations are evenly spaced along the lap, so the spacing is
   * `lapLength / checksPerLap` and the bound is that over the speed limit, less
   * `SPLIT_SHARE`. On a real route — a 1.6 km lap with eight crossings — that is
   * 200 m at 34 m/s and so 5.3 s, while the fastest thing anyone can ride is
   * governed at 29 m/s (`ABSOLUTE_TOP` in `driving.ts`) and needs 6.9 s, which
   * leaves a quarter of the bound in hand.
   *
   * Worth being plain about its limit: the geometry is declared by whoever set
   * the race up, and the most permissive declaration the clamps allow — a 400 m
   * lap with eighteen crossings — brings this down to 0.59 s. That buys nothing,
   * because a finishing time is taken from the server's clock and not from the
   * claim, and because it loosens the race for everybody in it rather than for
   * one racer.
   */
  private get minSplitMs(): number {
    const spacing = this.state.race.lapLength / this.state.race.checksPerLap;
    return (spacing / this.maxSpeed) * 1000 * SPLIT_SHARE;
  }

  private phase(next: RacePhase) {
    this.state.race.phase = next;
  }

  private cancelPending() {
    for (const handle of this.pending) handle.clear();
    this.pending = [];
  }

  /**
   * Only from `idle`, so a race in progress cannot be re-laid under the field.
   *
   * The start time is set here, once, on the server's clock, and the phases then
   * arrive on the room's own timer. A client is told when the lights go out; it
   * never gets to say.
   */
  setup(client: Client, message: SetupMessage) {
    const race = this.state.race;
    if (race.phase !== 'idle') return;

    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const laps = whole(message?.laps, 1, MAX_LAPS);
    const checksPerLap = whole(message?.checksPerLap, MIN_CHECKS_PER_LAP, MAX_CHECKS_PER_LAP);
    const lapLength = Number(message?.lapLength);
    if (laps === null || checksPerLap === null || !Number.isFinite(lapLength)) return;

    this.cancelPending();
    this.progress.clear();
    for (const [, each] of this.state.players) clearRacer(each);

    race.laps = laps;
    race.checksPerLap = checksPerLap;
    race.lapLength = clamp(lapLength, MIN_LAP_LENGTH, MAX_LAP_LENGTH);
    race.startAt = Date.now() + GRID_MS + LIGHTS_MS;
    race.endedAt = 0;
    race.by = player.name;
    this.phase('grid');

    this.pending.push(this.timer.after(GRID_MS, () => this.phase('countdown')));
    this.pending.push(this.timer.after(GRID_MS + LIGHTS_MS, () => this.start()));
    this.join(client);
  }

  private start() {
    if (this.state.race.phase !== 'countdown') return;
    // Nobody accepted, so there is nothing to start. Back to idle rather than
    // leaving an empty race running for the next person who walks in.
    if (!this.racers().length) {
      this.reset();
      return;
    }
    this.phase('running');
  }

  /** Accepting the offer. Allowed while the field is forming and while the
   *  lights hold, which is the whole of the window the grid phase exists for. */
  join(client: Client) {
    const race = this.state.race;
    if (race.phase !== 'grid' && race.phase !== 'countdown') return;
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    clearRacer(player);
    player.racing = true;
    this.progress.set(client.sessionId, { passed: 0, lastAtMs: 0, lapStartMs: 0, missed: 0 });
  }

  /**
   * One crossing, claimed.
   *
   * The ordering rule is the browser's, mirrored rather than reinvented: the
   * crossing after the expected one claims both and counts a miss, because a
   * racer who put a wheel on the verge at checkpoint four and is told at
   * checkpoint nine that they are still on four has been handed an unrecoverable
   * state by a rule meant to stop cheating.
   */
  check(client: Client, message: CheckMessage) {
    const race = this.state.race;
    const player = this.state.players.get(client.sessionId);
    const progress = this.progress.get(client.sessionId);
    if (race.phase !== 'running' || !player?.racing || !progress) return;
    if (player.finishedMs > 0) return;

    const check = whole(message?.check, 0, race.checksPerLap - 1);
    const lap = whole(message?.lap, 0, race.laps);
    const atMs = Number(message?.atMs);
    if (check === null || lap === null || !Number.isFinite(atMs)) return;

    const expected = progress.passed % race.checksPerLap;
    const advance = check === expected ? 1 : check === (expected + 1) % race.checksPerLap ? 2 : 0;
    if (!advance) return;

    // `lap` is a redundancy check on the two sides agreeing, so either side of
    // the crossing counts. A claim reported after `trackProgress` has run already
    // carries the incremented lap, and refusing that would silently drop every
    // lap-line crossing while refusing nothing a cheat would send — a client two
    // laps out of step is still refused.
    const lapBefore = Math.floor(progress.passed / race.checksPerLap);
    const lapAfter = Math.floor((progress.passed + advance) / race.checksPerLap);
    if (lap !== lapBefore && lap !== lapAfter) return;

    const split = this.minSplitMs;
    const elapsed = Date.now() - race.startAt;
    // The racer's own clock has to be monotonic and has to have taken the time
    // the distance needs; the server's clock has to agree that the race has been
    // running long enough for every crossing claimed so far, which is the half
    // of it that cannot be forged.
    if (atMs <= progress.lastAtMs || atMs - progress.lastAtMs < split * advance) return;
    if (atMs > elapsed + JITTER_MS) return;
    if (elapsed < (progress.passed + advance) * split - JITTER_MS) return;

    if (advance === 2) progress.missed += 1;
    const wasOnLap = Math.floor(progress.passed / race.checksPerLap);
    progress.passed += advance;
    progress.lastAtMs = atMs;
    player.lap = Math.floor(progress.passed / race.checksPerLap);
    player.check = progress.passed % race.checksPerLap;

    // Compared rather than read off `check`: claiming two crossings at the lap
    // line lands on the first checkpoint of the next lap, not on zero, and
    // testing for zero there drops the lap the racer actually completed.
    if (player.lap > wasOnLap) {
      const lapMs = atMs - progress.lapStartMs;
      if (progress.missed === 0 && (player.bestMs === 0 || lapMs < player.bestMs)) player.bestMs = lapMs;
      progress.lapStartMs = atMs;
      progress.missed = 0;
      // The lap line on the last lap is the finish, and the time of it is the
      // server's, not the claim's. `race:finish` may refine it; it cannot set it.
      if (player.lap >= race.laps) this.land(player, elapsed);
    }
  }

  /**
   * The racer's own finishing time, accepted only where it agrees with the
   * server's.
   *
   * It is worth having: the server's figure is taken when the last crossing
   * arrived, which includes however long the packet spent in flight, while the
   * browser's was taken at the line. Outside the jitter allowance it is not a
   * better measurement of the same thing, so the server's stands.
   */
  finish(client: Client, message: FinishMessage) {
    const race = this.state.race;
    const player = this.state.players.get(client.sessionId);
    // 'ended' is allowed as well as 'running': the last racer's own finish
    // message arrives after the crossing that ended the race, and a solo racer's
    // always does.
    if ((race.phase !== 'running' && race.phase !== 'ended') || !player?.racing) return;
    if (player.lap < race.laps || player.finishedMs === 0) return;

    const ms = Number(message?.ms);
    if (!Number.isFinite(ms) || ms <= 0) return;
    if (Math.abs(ms - player.finishedMs) > JITTER_MS) return;
    player.finishedMs = ms;
  }

  /** Back to idle, from any phase and by anybody. There is no host here and
   *  there should not be one: a race nobody can abandon is worse than one a
   *  friend can end early. */
  reset() {
    this.cancelPending();
    this.progress.clear();
    const race = this.state.race;
    race.laps = 0;
    race.checksPerLap = 0;
    race.lapLength = 0;
    race.startAt = 0;
    race.endedAt = 0;
    race.by = '';
    this.phase('idle');
    for (const [, player] of this.state.players) clearRacer(player);
  }

  /**
   * A racer who left mid-race is not a racer the field is still waiting for.
   *
   * Called after the player is out of room state, so `racers()` has already
   * forgotten them. If they were the last one, the race goes back to idle rather
   * than leaving a phase running over an empty road for whoever walks in next.
   */
  forget(sessionId: string) {
    this.progress.delete(sessionId);
    if (this.state.race.phase === 'idle') return;
    if (!this.racers().length) this.reset();
    else this.settle();
  }

  private racers(): PlayerInstance[] {
    const racing: PlayerInstance[] = [];
    for (const [, player] of this.state.players) if (player.racing) racing.push(player);
    return racing;
  }

  private land(player: PlayerInstance, elapsed: number) {
    player.finishedMs = Math.max(1, Math.round(elapsed));
    this.settle();
  }

  /** The race is over when there is nobody still out on the circuit. */
  private settle() {
    const racers = this.racers();
    if (!racers.length || racers.some((player) => player.finishedMs === 0)) return;
    this.state.race.endedAt = Date.now();
    this.phase('ended');
  }
}

const clearRacer = (player: PlayerInstance) => {
  player.racing = false;
  player.lap = 0;
  player.check = 0;
  player.bestMs = 0;
  player.finishedMs = 0;
};
