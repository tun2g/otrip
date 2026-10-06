/**
 * What the room's state means, as plain values.
 *
 * Split from `trip-client.ts` so that reading the room is separate from being
 * connected to it: these are pure functions of a decoded state object, which is
 * also what lets them be read in a test without a renderer. `trip-client`
 * re-exports the types, so there is one place to import from.
 */
import type { RemotePlayer } from '@/scene/avatars';
import type { RacePhase } from '@/scene/race';

/**
 * A companion, with everything the renderer needs to draw them doing what they
 * are actually doing.
 *
 * Stated as an intersection because `RemotePlayer` is declared in
 * `scene/avatars.ts`, which draws them. The extra fields belong there in the
 * end; until they are added this says the same thing without reaching into that
 * file, and it keeps saying it afterwards.
 */
export type TripPlayer = RemotePlayer & {
  /** Where the machine points, which is not where the rider looks. */
  heading: number;
  /** '' on foot, otherwise the vehicle kind. */
  riding: string;
  /** m/s, so wheels and lean can be driven without differentiating positions
   *  that arrive at whatever rate the network manages. */
  speed: number;
  racing: boolean;
  lap: number;
  check: number;
  bestMs: number;
  finishedMs: number;
};

/**
 * What the room agrees about the place itself.
 *
 * `hourStamp` is the forecast's own stamp and not an index into it: the 48-hour
 * window is anchored at the destination's midnight, so an index pinned one
 * evening points at a different hour by morning. '' means nobody has pinned one
 * and the room is following the destination's real hour.
 *
 * While `playing`, the hour on screen is derived from the anchor rather than
 * stepped on a local interval:
 *
 *     index(hourStamp) + floor((serverNow() - anchorAt) / 1000 / secondsPerHour)
 *
 * which is what makes two clients agree instead of merely both run — a local
 * interval leaves them up to one whole forecast hour apart depending on when it
 * happened to start.
 */
export type TripWorld = {
  hourStamp: string;
  anchorAt: number;
  playing: boolean;
  speedStep: number;
  preset: string;
  /** Display name of whoever set it last, for a line saying so. */
  by: string;
};

/** The race, as the room holds it. `startAt` is an instant on the server's
 *  clock, which is what `serverNow()` is for. */
export type TripRace = {
  phase: RacePhase;
  laps: number;
  checksPerLap: number;
  lapLength: number;
  startAt: number;
  endedAt: number;
  by: string;
};

export const EMPTY_WORLD: TripWorld = {
  hourStamp: '',
  anchorAt: 0,
  playing: false,
  speedStep: 0,
  preset: '',
  by: '',
};

export const EMPTY_RACE: TripRace = {
  phase: 'idle',
  laps: 0,
  checksPerLap: 0,
  lapLength: 0,
  startAt: 0,
  endedAt: 0,
  by: '',
};

/**
 * The shape the decoder hands back. Every field past the original five is
 * optional here on purpose: a schema field carries a default, but reading one
 * the server has never written is a real possibility and `?? ` is cheaper than
 * finding out which.
 */
type PlayerFields = {
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  heading?: number;
  riding?: string;
  speed?: number;
  racing?: boolean;
  lap?: number;
  check?: number;
  bestMs?: number;
  finishedMs?: number;
};

export type TripStateShape = {
  players?: Map<string, PlayerFields>;
  world?: Partial<TripWorld>;
  /** `phase` is widened back to a string here: the wire carries whatever the
   *  server wrote, and claiming `RacePhase` of it would be a cast dressed as a
   *  type. `readRace` narrows it. */
  race?: Partial<Omit<TripRace, 'phase'>> & { phase?: string };
};

/** Everyone except you — your own avatar is the walker you control. */
export const readPlayers = (state: TripStateShape, selfId: string): TripPlayer[] => {
  const players: TripPlayer[] = [];

  state.players?.forEach((player, id) => {
    if (id === selfId) return;
    players.push({
      id,
      name: player.name,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      // A walker's body faces where it looks, so yaw is the honest fallback for
      // a packet that carried no heading of its own.
      heading: player.heading ?? player.yaw,
      riding: player.riding ?? '',
      speed: player.speed ?? 0,
      racing: player.racing ?? false,
      lap: player.lap ?? 0,
      check: player.check ?? 0,
      bestMs: player.bestMs ?? 0,
      finishedMs: player.finishedMs ?? 0,
    });
  });

  return players;
};

export const readWorld = (state: TripStateShape): TripWorld => {
  const fields = state.world;
  if (!fields) return EMPTY_WORLD;
  return {
    hourStamp: fields.hourStamp ?? '',
    anchorAt: fields.anchorAt ?? 0,
    playing: fields.playing ?? false,
    speedStep: fields.speedStep ?? 0,
    preset: fields.preset ?? '',
    by: fields.by ?? '',
  };
};

const PHASES: readonly RacePhase[] = ['idle', 'grid', 'countdown', 'running', 'ended'];

/** The phase arrives as a string, because that is what a schema field is. An
 *  unrecognised one means idle rather than a phase the renderer cannot draw. */
const readPhase = (value: string | undefined): RacePhase => PHASES.find((phase) => phase === value) ?? 'idle';

export const readRace = (state: TripStateShape): TripRace => {
  const fields = state.race;
  if (!fields) return EMPTY_RACE;
  return {
    phase: readPhase(fields.phase),
    laps: fields.laps ?? 0,
    checksPerLap: fields.checksPerLap ?? 0,
    lapLength: fields.lapLength ?? 0,
    startAt: fields.startAt ?? 0,
    endedAt: fields.endedAt ?? 0,
    by: fields.by ?? '',
  };
};

export const sameWorld = (a: TripWorld, b: TripWorld): boolean =>
  a.hourStamp === b.hourStamp &&
  a.anchorAt === b.anchorAt &&
  a.playing === b.playing &&
  a.speedStep === b.speedStep &&
  a.preset === b.preset &&
  a.by === b.by;

export const sameRace = (a: TripRace, b: TripRace): boolean =>
  a.phase === b.phase &&
  a.laps === b.laps &&
  a.checksPerLap === b.checksPerLap &&
  a.lapLength === b.lapLength &&
  a.startAt === b.startAt &&
  a.endedAt === b.endedAt &&
  a.by === b.by;
