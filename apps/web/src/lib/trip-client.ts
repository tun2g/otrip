import { Client, type Room } from '@colyseus/sdk';

// Spelt with the extension, and not as `@/lib/...`, because
// `pnpm test:multiplayer` loads this module in Node through
// `--experimental-strip-types`, which resolves neither a bare `./trip-state` nor
// the `@/` alias — the alias survives elsewhere in this file's neighbours only
// because every other one of their imports is `import type` and is erased. The
// `.ts` specifier is what `@otrip/world` and `@otrip/contracts` already use, and
// Next transpiles both from source, so it holds in the browser too.
import {
  EMPTY_RACE,
  EMPTY_WORLD,
  readPlayers,
  readRace,
  readWorld,
  sameRace,
  sameWorld,
  type TripPlayer,
  type TripRace,
  type TripStateShape,
  type TripWorld,
} from './trip-state.ts';

export { ROOM_PARAM, inviteUrl, isRoomId, readRoomId, showRoomId } from './trip-url.ts';
export { EMPTY_RACE, EMPTY_WORLD, type TripPlayer, type TripRace, type TripWorld } from './trip-state.ts';

export type ChatLine = { from: string; text: string; at: number };

/**
 * What rides along with a position. An absent field means on foot and standing
 * still rather than "unchanged" — the server reads it the same way, so a rider
 * who dismounts cannot leave a bike bolted to a companion's screen by simply
 * stopping sending.
 */
export type MoveExtra = { heading?: number; speed?: number; riding?: string };

export type TripConnection = {
  room: Room;
  /** Everyone except you — your own avatar is the walker you control. */
  onPlayers: (handler: (players: TripPlayer[]) => void) => void;
  onChat: (handler: (line: ChatLine) => void) => void;
  onWorld: (handler: (world: TripWorld) => void) => void;
  onRace: (handler: (race: TripRace) => void) => void;
  move: (x: number, z: number, yaw: number, extra?: MoveExtra) => void;
  relocate: (x: number, z: number) => void;
  say: (text: string) => void;
  /** A forecast stamp, or null to hand the room back to its real hour. */
  setHour: (stamp: string | null) => void;
  setPreset: (preset: string) => void;
  /** The hour on screen travels with the clock, and has to: pausing without
   *  restating it snaps everybody back to the hour play started from. */
  setClock: (playing: boolean, speedStep: number, stamp: string | null) => void;
  setupRace: (laps: number, route: { checksPerLap: number; lapLength: number }) => void;
  joinRace: () => void;
  reportCheck: (check: number, lap: number, atMs: number) => void;
  finishRace: (ms: number) => void;
  resetRace: () => void;
  /** The server's clock, as well as this machine can measure it. */
  serverNow: () => number;
  leave: () => void;
};

/**
 * Where the rooms live. Baked in at build time, so changing it means rebuilding
 * the image — which is what the deploy notes say.
 *
 * Exported because the fallback is the whole of a failure mode: with no
 * `NEXT_PUBLIC_REALTIME_URL` set this is `localhost`, and `pnpm dev:web` starts
 * only Next, so a join fails against nothing at all. `useTrip` reads this to
 * tell the two cases apart when it has to explain itself.
 */
export const realtimeEndpoint = (): string => process.env.NEXT_PUBLIC_REALTIME_URL ?? 'ws://localhost:2567';

/** Whether the rooms are expected on this machine rather than on a server. */
export const realtimeIsLocal = (): boolean => /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$|\/)/.test(realtimeEndpoint());

/**
 * How many times the server's clock is sampled at join, and how far apart.
 *
 * The countdown is drawn from `race.startAt`, which is an instant on the
 * server's clock, so a phone two seconds out would show the lights going out two
 * seconds early. Three samples spread over a second, keeping the one with the
 * shortest round trip, because a sample that spent 400 ms queued carries 200 ms
 * of error. Nothing is sampled after that: the error that matters is the offset
 * between two clocks, and quartz does not drift seconds over an afternoon.
 */
const CLOCK_SAMPLES = [0, 300, 900];

/**
 * Rooms are reached by their id, which is what the invite link carries. There is
 * deliberately no "find me any room": the social unit here is a few friends who
 * already know each other, which is also why there is no moderation queue.
 */
export const connectToTrip = async (
  location: string,
  name: string,
  roomId?: string,
  spawn?: { x: number; z: number }
): Promise<TripConnection> => {
  const client = new Client(realtimeEndpoint());

  const room = roomId
    ? await client.joinById(roomId, { name, location, spawn })
    : await client.create('trip', { location, name, spawn });

  const state = () => room.state as TripStateShape;

  let playersHandler: ((players: TripPlayer[]) => void) | null = null;
  let worldHandler: ((world: TripWorld) => void) | null = null;
  let raceHandler: ((race: TripRace) => void) | null = null;
  let world = EMPTY_WORLD;
  let race = EMPTY_RACE;

  let offset = 0;
  let bestTrip = Infinity;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const serverNow = () => Date.now() + offset;

  room.onMessage('time', (payload: { sent?: number; now?: number }) => {
    const sent = Number(payload?.sent);
    const there = Number(payload?.now);
    if (!Number.isFinite(sent) || !Number.isFinite(there) || sent <= 0) return;
    const trip = Date.now() - sent;
    if (trip < 0 || trip >= bestTrip) return;
    bestTrip = trip;
    // Half the round trip is the one assumption here, and it is the standard
    // one: nothing in a single exchange tells a slow request from a slow reply.
    offset = there - (sent + trip / 2);
  });
  for (const at of CLOCK_SAMPLES) {
    timers.push(setTimeout(() => room.send('time', { sent: Date.now() }), at));
  }

  const snapshot = () => {
    playersHandler?.(readPlayers(state(), room.sessionId));

    // Diffed rather than published every time, because this runs on every change
    // and the positions alone are ten a second per person. The hour and the race
    // change when somebody touches them, and a React setter called at 80 Hz with
    // an identical value is 80 renders nobody asked for.
    const nextWorld = readWorld(state());
    if (!sameWorld(world, nextWorld)) {
      world = nextWorld;
      worldHandler?.(world);
    }
    const nextRace = readRace(state());
    if (!sameRace(race, nextRace)) {
      race = nextRace;
      raceHandler?.(race);
    }
  };

  // One snapshot per change rather than per field: the roster is at most eight
  // people, so rebuilding it is cheaper than tracking individual bindings.
  room.onStateChange(() => snapshot());

  return {
    room,
    onPlayers: (handler) => {
      playersHandler = handler;
      handler(readPlayers(state(), room.sessionId));
    },
    onChat: (handler) => {
      room.onMessage('chat', (payload: { from?: string; text?: string }) => {
        if (!payload?.text) return;
        handler({ from: payload.from ?? 'Khách', text: payload.text, at: Date.now() });
      });
    },
    // Published once on subscribe as well as on change: a client that joined an
    // hour after the room did has to be told the hour it is standing in, and
    // nothing is going to change it just because somebody new arrived.
    onWorld: (handler) => {
      worldHandler = handler;
      world = readWorld(state());
      handler(world);
    },
    onRace: (handler) => {
      raceHandler = handler;
      race = readRace(state());
      handler(race);
    },
    move: (x, z, yaw, extra) =>
      room.send('move', { x, z, yaw, heading: extra?.heading, speed: extra?.speed, riding: extra?.riding }),
    relocate: (x, z) => room.send('relocate', { x, z }),
    say: (text) => room.send('chat', { text }),
    setHour: (stamp) => room.send('world:hour', { stamp: stamp ?? '' }),
    setPreset: (preset) => room.send('world:preset', { preset }),
    setClock: (playing, speedStep, stamp) => room.send('world:clock', { playing, speedStep, stamp: stamp ?? '' }),
    setupRace: (laps, route) =>
      room.send('race:setup', { laps, checksPerLap: route.checksPerLap, lapLength: route.lapLength }),
    joinRace: () => room.send('race:join', {}),
    reportCheck: (check, lap, atMs) => room.send('race:check', { check, lap, atMs }),
    finishRace: (ms) => room.send('race:finish', { ms }),
    resetRace: () => room.send('race:reset', {}),
    serverNow,
    leave: () => {
      for (const timer of timers) clearTimeout(timer);
      void room.leave();
    },
  };
};
