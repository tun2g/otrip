import { Client, getStateCallbacks, type Room } from '@colyseus/sdk';

import type { RemotePlayer } from '@/scene/avatars';

export type ChatLine = { from: string; text: string; at: number };

export type TripConnection = {
  room: Room;
  /** Everyone except you — your own avatar is the walker you control. */
  onPlayers: (handler: (players: RemotePlayer[]) => void) => void;
  onChat: (handler: (line: ChatLine) => void) => void;
  move: (x: number, z: number, yaw: number) => void;
  say: (text: string) => void;
  leave: () => void;
};

const endpoint = (): string => process.env.NEXT_PUBLIC_REALTIME_URL ?? 'ws://localhost:2567';

type PlayerFields = { name: string; x: number; y: number; z: number; yaw: number };

/**
 * Rooms are reached by their id, which is what the invite link carries. There is
 * deliberately no "find me any room": the social unit here is a few friends who
 * already know each other, which is also why there is no moderation queue.
 */
export const connectToTrip = async (location: string, name: string, roomId?: string): Promise<TripConnection> => {
  const client = new Client(endpoint());

  const room = roomId ? await client.joinById(roomId, { name }) : await client.create('trip', { location, name });

  const callbacks = getStateCallbacks(room);
  let playersHandler: ((players: RemotePlayer[]) => void) | null = null;

  const snapshot = () => {
    const players: RemotePlayer[] = [];
    const map = (room.state as { players?: Map<string, PlayerFields> }).players;

    map?.forEach((player, id) => {
      if (id === room.sessionId) return;
      players.push({ id, name: player.name, x: player.x, y: player.y, z: player.z, yaw: player.yaw });
    });

    playersHandler?.(players);
  };

  // One snapshot per change rather than per field: the roster is at most eight
  // people, so rebuilding it is cheaper than tracking individual bindings.
  room.onStateChange(() => snapshot());
  void callbacks;

  return {
    room,
    onPlayers: (handler) => {
      playersHandler = handler;
      snapshot();
    },
    onChat: (handler) => {
      room.onMessage('chat', (payload: { from?: string; text?: string }) => {
        if (!payload?.text) return;
        handler({ from: payload.from ?? 'Khách', text: payload.text, at: Date.now() });
      });
    },
    move: (x, z, yaw) => room.send('move', { x, z, yaw }),
    say: (text) => room.send('chat', { text }),
    leave: () => void room.leave(),
  };
};
