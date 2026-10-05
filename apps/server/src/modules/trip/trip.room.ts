import type { Terrain } from '@otrip/world';
import { Room, ServerError, type Client } from 'colyseus';

import { loadConfig } from '../../config/configuration.ts';
import { Player, TripState } from './trip.schema.ts';
import { findSpawn, isSpawnable } from '../../shared/spawn.ts';
import { worldFor } from '../../shared/terrain-cache.ts';

const config = loadConfig();

const MAX_NAME = 24;
const MAX_CHAT = 200;

/**
 * Chat lines one person may send back to back, and how long each one takes to
 * come back. A flat minimum interval swallows the second half of "ok" / "đi
 * thôi", which reads as the app losing messages; a small allowance that refills
 * lets a real double-send through and still settles at one line per 1.5s.
 */
const CHAT_BURST = 4;
const CHAT_REFILL = 1500;

/**
 * How long a dropped player's place is held, in seconds. A lost connection is a
 * tunnel or a phone locking far more often than somebody leaving, and the
 * browser SDK retries on its own, so the only thing missing was the server
 * agreeing to wait. Short enough that a friend who has really gone does not
 * stand there.
 */
const RECONNECT_SECONDS = 20;

/**
 * Messages one client may send per second before Colyseus closes it. The walker
 * sends ten position updates a second, so this is three times what the app
 * needs; it is set because the framework's own default is Infinity, and the
 * speed check below bounds how far a player can get, not how much of the
 * server's time they can spend trying.
 */
const MAX_MESSAGES_PER_SECOND = 30;

type MoveMessage = { x?: unknown; z?: unknown; yaw?: unknown };
type ChatMessage = { text?: unknown };
type JoinOptions = { name?: unknown; spawn?: unknown };

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * One line of plain text. Newlines and control characters go too: the chat panel
 * renders whatever it is given, so 200 newlines is 200 blank lines in everyone's
 * transcript.
 */
const cleanText = (value: unknown, limit: number): string =>
  typeof value === 'string'
    ? value
        .replace(/[\s\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, limit)
    : '';

const cleanName = (value: unknown): string => cleanText(value, MAX_NAME) || 'Khách';

/** Where the client says it put you, if that is somewhere a person could stand. */
const readSpawn = (value: unknown, terrain: Terrain, waterLevel: number): { x: number; z: number } | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { x, z } = value as { x?: unknown; z?: unknown };
  if (typeof x !== 'number' || typeof z !== 'number') return null;
  return isSpawnable(terrain, waterLevel, x, z) ? { x, z } : null;
};

export class TripRoom extends Room {
  state = new TripState();
  maxClients = config.maxClientsPerRoom;
  maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;

  private terrain: Terrain | null = null;
  private waterLevel = Number.NEGATIVE_INFINITY;
  private lastMove = new Map<string, { at: number; x: number; z: number }>();
  private chatAllowance = new Map<string, { lines: number; at: number }>();

  onCreate(options: { location?: unknown }) {
    const slug = typeof options?.location === 'string' ? options.location : '';
    const world = worldFor(slug);
    if (!world) throw new ServerError(400, 'Không có địa danh này');

    this.terrain = world.terrain;
    this.waterLevel = world.recipe.water?.level ?? Number.NEGATIVE_INFINITY;
    this.state.location = slug;

    // Private by design: a room is reached through its invite link, never by
    // matchmaking into whatever room happens to be open.
    this.setPrivate(true);

    this.onMessage('move', (client, message: MoveMessage) => this.handleMove(client, message));
    this.onMessage('chat', (client, message: ChatMessage) => this.handleChat(client, message));
  }

  onJoin(client: Client, options: JoinOptions) {
    const terrain = this.terrain;
    if (!terrain) throw new ServerError(500, 'Phòng chưa sẵn sàng');

    const spawn = readSpawn(options?.spawn, terrain, this.waterLevel) ?? findSpawn(terrain, this.waterLevel);

    const player = new Player();
    player.name = cleanName(options?.name);
    player.x = spawn.x;
    player.z = spawn.z;
    player.y = terrain.heightAt(spawn.x, spawn.z);
    player.yaw = 0;
    this.state.players.set(client.sessionId, player);

    // Seeded here rather than on the first packet: with nothing to measure
    // against, the first `move` of a session could put you anywhere on the map.
    this.lastMove.set(client.sessionId, { at: Date.now(), x: spawn.x, z: spawn.z });
  }

  /**
   * Only for a connection that dropped without saying goodbye. Holding the seat
   * keeps the player's own entry in the state, so a friend who comes back is
   * still where they were standing and still has their name. Colyseus calls
   * `onLeave` once the window closes, which is where the entry is removed.
   */
  onDrop(client: Client) {
    void this.allowReconnection(client, RECONNECT_SECONDS);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.lastMove.delete(client.sessionId);
    this.chatAllowance.delete(client.sessionId);
  }

  /**
   * The client sends where it thinks it is on the ground plane; the server reads
   * the height off the same heightfield the browser generated the world from, so
   * height cannot be forged and there is nothing about it left to check. What
   * remains is the ground plane: inside the map, and reached at a pace a person
   * could walk.
   */
  private handleMove(client: Client, message: MoveMessage) {
    const terrain = this.terrain;
    const player = this.state.players.get(client.sessionId);
    if (!terrain || !player) return;

    const x = Number(message?.x);
    const z = Number(message?.z);
    const yaw = Number(message?.yaw);
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return;

    const half = terrain.size / 2;
    const nextX = clamp(x, -half, half);
    const nextZ = clamp(z, -half, half);

    const now = Date.now();
    const previous = this.lastMove.get(client.sessionId);
    if (previous) {
      // Measured against the last position the server accepted, so a rejected
      // teleport never becomes the baseline for the next one — and with no floor
      // under the interval, which is what let a client beat the speed limit
      // outright by sending faster than once every 50 ms.
      const seconds = (now - previous.at) / 1000;
      if (Math.hypot(nextX - previous.x, nextZ - previous.z) / seconds > config.maxSpeed) return;
    }

    this.lastMove.set(client.sessionId, { at: now, x: nextX, z: nextZ });
    player.x = nextX;
    player.z = nextZ;
    player.y = terrain.heightAt(nextX, nextZ);
    // Wrapped into one turn rather than passed through: this rotates a remote
    // avatar, and a client is free to send 1e300.
    player.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  }

  private handleChat(client: Client, message: ChatMessage) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const now = Date.now();
    const allowance = this.chatAllowance.get(client.sessionId);
    const lines = allowance ? Math.min(CHAT_BURST, allowance.lines + (now - allowance.at) / CHAT_REFILL) : CHAT_BURST;
    if (lines < 1) return;

    const text = cleanText(message?.text, MAX_CHAT);
    if (!text) return;

    this.chatAllowance.set(client.sessionId, { lines: lines - 1, at: now });
    // The name is read from room state, never from the packet, so nobody can put
    // words in a friend's mouth.
    this.broadcast('chat', { from: player.name, text });
  }
}
