'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { connectToTrip, type ChatLine, type TripConnection } from '@/lib/trip-client';
import type { RemotePlayer } from '@/scene/avatars';

export type TripStatus = 'idle' | 'connecting' | 'joined' | 'error';

export type Trip = {
  status: TripStatus;
  roomId: string | null;
  players: RemotePlayer[];
  chat: ChatLine[];
  error: string | null;
  start: (name: string, roomId?: string, spawn?: { x: number; z: number }) => void;
  leave: () => void;
  move: (x: number, z: number, yaw: number) => void;
  relocate: (x: number, z: number) => void;
  say: (text: string) => void;
};

const MAX_CHAT = 30;

export const useTrip = (location: string): Trip => {
  const connectionRef = useRef<TripConnection | null>(null);
  // Guarding on state lets React's development double mount fire two joins in
  // the same tick, which put the same person in the room twice. A ref flips
  // synchronously, so the second call sees it.
  const joiningRef = useRef(false);
  const generation = useRef(0);
  const [status, setStatus] = useState<TripStatus>('idle');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [players, setPlayers] = useState<RemotePlayer[]>([]);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      generation.current += 1;
      joiningRef.current = false;
      connectionRef.current?.leave();
      connectionRef.current = null;
    },
    []
  );

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
          connection.room.onLeave(() => {
            if (connectionRef.current !== connection) return;
            connectionRef.current = null;
            joiningRef.current = false;
            setPlayers([]);
            setRoomId(null);
            setStatus('error');
            setError('Đã mất kết nối với phòng. Hãy vào lại chuyến đi.');
          });
          setRoomId(connection.room.roomId);
          setStatus('joined');
        })
        .catch((cause: unknown) => {
          if (attempt !== generation.current) return;
          joiningRef.current = false;
          setStatus('error');
          setError(
            cause instanceof Error && cause.message
              ? cause.message
              : 'Không vào được chuyến đi. Máy chủ có thể chưa chạy.'
          );
        });
    },
    [location]
  );

  const leave = useCallback(() => {
    generation.current += 1;
    connectionRef.current?.leave();
    connectionRef.current = null;
    joiningRef.current = false;
    setStatus('idle');
    setRoomId(null);
    setPlayers([]);
    setChat([]);
  }, []);

  const move = useCallback((x: number, z: number, yaw: number) => {
    connectionRef.current?.move(x, z, yaw);
  }, []);

  const relocate = useCallback((x: number, z: number) => {
    connectionRef.current?.relocate(x, z);
  }, []);

  const say = useCallback((text: string) => {
    connectionRef.current?.say(text);
  }, []);

  return { status, roomId, players, chat, error, start, leave, move, relocate, say };
};
