'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  connectToTrip,
  EMPTY_RACE,
  EMPTY_WORLD,
  realtimeIsLocal,
  showRoomId,
  type ChatLine,
  type MoveExtra,
  type TripConnection,
  type TripPlayer,
  type TripRace,
  type TripWorld,
} from '@/lib/trip-client';

export type TripStatus = 'idle' | 'connecting' | 'joined' | 'error';

export type Trip = {
  status: TripStatus;
  roomId: string | null;
  players: TripPlayer[];
  chat: ChatLine[];
  error: string | null;
  /** What the room agrees the place is: the hour, the weather and the clock. */
  world: TripWorld;
  race: TripRace;
  start: (name: string, roomId?: string, spawn?: { x: number; z: number }) => void;
  leave: () => void;
  move: (x: number, z: number, yaw: number, extra?: MoveExtra) => void;
  relocate: (x: number, z: number) => void;
  say: (text: string) => void;
  setHour: (stamp: string | null) => void;
  setPreset: (preset: string) => void;
  setClock: (playing: boolean, speedStep: number, stamp: string | null) => void;
  setupRace: (laps: number, route: { checksPerLap: number; lapLength: number }) => void;
  joinRace: () => void;
  reportCheck: (check: number, lap: number, atMs: number) => void;
  finishRace: (ms: number) => void;
  resetRace: () => void;
  /** The server's clock. `race.startAt` and `world.anchorAt` are instants on it,
   *  so anything measured against them is measured against this and not
   *  `Date.now()` — a phone two seconds out would otherwise draw the lights
   *  going out two seconds early. */
  serverNow: () => number;
};

const MAX_CHAT = 30;

/**
 * Whether the room actually answered, as against never having been reached.
 *
 * `MatchMakeError.code` is the HTTP status when the matchmaker replied, and the
 * replies worth repeating are already written for the person reading them —
 * `trip.room.ts` throws `ServerError(400, 'Link mời không đúng địa điểm của
 * phòng')` and `ServerError(400, 'Không có địa danh này')`. Those are shown as
 * they are.
 *
 * When the request never landed, the SDK's HTTP layer still builds a
 * `ServerError`, but out of the fetch failure's own cause —
 * `new ServerError(err.cause?.code || err.code, err.message)` — which is the
 * string `'ECONNREFUSED'` under Node and `undefined` in a browser, carrying the
 * message `fetch failed`. A numeric code is therefore exactly the question
 * "did the server say this", and nothing else in the SDK sets one.
 *
 * This guard is the bug. The test used to be `cause.message ? cause.message :
 * 'Không vào được chuyến đi. Máy chủ có thể chưa chạy.'`, and the SDK always
 * supplies a message, so the helpful branch was unreachable: someone running
 * `pnpm dev:web` with no room server was shown `fetch failed` and given nothing
 * to act on, which is how "đi cùng bạn" came to look broken when the room layer
 * was working perfectly.
 */
const serverAnswered = (cause: unknown): cause is Error & { code: number } =>
  cause instanceof Error && typeof (cause as { code?: unknown }).code === 'number';

/**
 * What to say when the room was never reached. The two cases need different
 * advice and only one of them is the visitor's problem: on a deployed site the
 * answer is the network or an outage, while on `localhost` it is always the same
 * thing — `pnpm dev:web` starts Next alone, and the rooms live in a second
 * process that `pnpm dev` starts alongside it.
 */
const unreachable = (): string =>
  realtimeIsLocal()
    ? 'Chưa kết nối được máy chủ phòng ở máy này. Chạy `pnpm dev` để bật cả web lẫn máy chủ — `pnpm dev:web` chỉ bật web.'
    : 'Chưa kết nối được máy chủ phòng. Kiểm tra mạng rồi vào lại chuyến đi.';

export const useTrip = (location: string): Trip => {
  const connectionRef = useRef<TripConnection | null>(null);
  // Guarding on state lets React's development double mount fire two joins in
  // the same tick, which put the same person in the room twice. A ref flips
  // synchronously, so the second call sees it.
  const joiningRef = useRef(false);
  const generation = useRef(0);
  const [status, setStatus] = useState<TripStatus>('idle');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [players, setPlayers] = useState<TripPlayer[]>([]);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [world, setWorld] = useState<TripWorld>(EMPTY_WORLD);
  const [race, setRace] = useState<TripRace>(EMPTY_RACE);

  useEffect(
    () => () => {
      generation.current += 1;
      joiningRef.current = false;
      connectionRef.current?.leave();
      connectionRef.current = null;
    },
    []
  );

  /** Everything a trip leaves behind, in one place, so leaving on purpose and
   *  being dropped cannot forget different halves of it. */
  const forget = useCallback(() => {
    setPlayers([]);
    setRoomId(null);
    setWorld(EMPTY_WORLD);
    setRace(EMPTY_RACE);
    // The room goes out of the address bar with the room: a reloaded page that
    // still carries `?r=` rejoins a room this person has left.
    showRoomId(null);
  }, []);

  const start = useCallback(
    (name: string, joinId?: string, spawn?: { x: number; z: number }) => {
      if (connectionRef.current || joiningRef.current) return;
      joiningRef.current = true;
      const attempt = ++generation.current;
      setStatus('connecting');
      setError(null);

      connectToTrip(location, name, joinId, spawn)
        .then((connection) => {
          if (attempt !== generation.current) {
            connection.leave();
            return;
          }
          connectionRef.current = connection;
          connection.onPlayers(setPlayers);
          connection.onChat((line) => setChat((lines) => [...lines, line].slice(-MAX_CHAT)));
          // Subscribed before the room id is published, so the first render that
          // knows it is in a room already knows which hour that room is in.
          connection.onWorld(setWorld);
          connection.onRace(setRace);
          connection.room.onLeave(() => {
            if (connectionRef.current !== connection) return;
            connectionRef.current = null;
            joiningRef.current = false;
            forget();
            setStatus('error');
            setError('Đã mất kết nối với phòng. Hãy vào lại chuyến đi.');
          });
          setRoomId(connection.room.roomId);
          // In the address bar as soon as there is a room, whether this person
          // created it or followed somebody's link. The host's own URL carried
          // nothing before, so a reload lost the room and the only way to share
          // it was a button.
          showRoomId(connection.room.roomId);
          setStatus('joined');
        })
        .catch((cause: unknown) => {
          if (attempt !== generation.current) return;
          joiningRef.current = false;
          setStatus('error');
          setError(serverAnswered(cause) && cause.message ? cause.message : unreachable());
        });
    },
    [location, forget]
  );

  const leave = useCallback(() => {
    generation.current += 1;
    connectionRef.current?.leave();
    connectionRef.current = null;
    joiningRef.current = false;
    setStatus('idle');
    setChat([]);
    forget();
  }, [forget]);

  const move = useCallback((x: number, z: number, yaw: number, extra?: MoveExtra) => {
    connectionRef.current?.move(x, z, yaw, extra);
  }, []);

  const relocate = useCallback((x: number, z: number) => {
    connectionRef.current?.relocate(x, z);
  }, []);

  const say = useCallback((text: string) => {
    connectionRef.current?.say(text);
  }, []);

  const setHour = useCallback((stamp: string | null) => {
    connectionRef.current?.setHour(stamp);
  }, []);

  const setPreset = useCallback((preset: string) => {
    connectionRef.current?.setPreset(preset);
  }, []);

  const setClock = useCallback((playing: boolean, speedStep: number, stamp: string | null) => {
    connectionRef.current?.setClock(playing, speedStep, stamp);
  }, []);

  const setupRace = useCallback((laps: number, route: { checksPerLap: number; lapLength: number }) => {
    connectionRef.current?.setupRace(laps, route);
  }, []);

  const joinRace = useCallback(() => {
    connectionRef.current?.joinRace();
  }, []);

  const reportCheck = useCallback((check: number, lap: number, atMs: number) => {
    connectionRef.current?.reportCheck(check, lap, atMs);
  }, []);

  const finishRace = useCallback((ms: number) => {
    connectionRef.current?.finishRace(ms);
  }, []);

  const resetRace = useCallback(() => {
    connectionRef.current?.resetRace();
  }, []);

  // Not a connection-less fallback of 0: callers subtract this from an instant
  // on the server's clock, and 0 would make every such difference an epoch.
  const serverNow = useCallback(() => connectionRef.current?.serverNow() ?? Date.now(), []);

  return {
    status,
    roomId,
    players,
    chat,
    error,
    world,
    race,
    start,
    leave,
    move,
    relocate,
    say,
    setHour,
    setPreset,
    setClock,
    setupRace,
    joinRace,
    reportCheck,
    finishRace,
    resetRace,
    serverNow,
  };
};
