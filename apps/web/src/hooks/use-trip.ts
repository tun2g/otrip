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
  start: (name: string, roomId?: string) => void;
  leave: () => void;
  move: (x: number, z: number, yaw: number) => void;
  say: (text: string) => void;
};

const MAX_CHAT = 30;

export const useTrip = (location: string): Trip => {
  const connectionRef = useRef<TripConnection | null>(null);
  // Guarding on state lets React's development double mount fire two joins in
  // the same tick, which put the same person in the room twice. A ref flips
  // synchronously, so the second call sees it.
  const joiningRef = useRef(false);
  const [status, setStatus] = useState<TripStatus>('idle');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [players, setPlayers] = useState<RemotePlayer[]>([]);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      connectionRef.current?.leave();
      connectionRef.current = null;
    },
    []
  );

  const start = useCallback(
    (name: string, joinId?: string) => {
      if (connectionRef.current || joiningRef.current) return;
      joiningRef.current = true;
      setStatus('connecting');
      setError(null);

      connectToTrip(location, name, joinId)
        .then((connection) => {
          connectionRef.current = connection;
          connection.onPlayers(setPlayers);
          connection.onChat((line) => setChat((lines) => [...lines, line].slice(-MAX_CHAT)));
          setRoomId(connection.room.roomId);
          setStatus('joined');
        })
        .catch((cause: unknown) => {
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

  const say = useCallback((text: string) => {
    connectionRef.current?.say(text);
  }, []);

  return { status, roomId, players, chat, error, start, leave, move, say };
};
