import type { Terrain } from '@otrip/world';
import { Room, ServerError, type Client } from 'colyseus';

import { loadConfig } from '../../config/configuration.ts';
import { Player, TripState } from './trip.schema.ts';
import { Race } from './trip.race.ts';
import { World } from './trip.world.ts';
import { findSpawn } from '../../shared/spawn.ts';
import { allowStep, createBudget, type MoveBudget } from '../../shared/move-budget.ts';
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
 *
 * A race does not change the arithmetic. It adds fields to the `move` packet
 * rather than packets of its own, and a checkpoint claim arrives once every
 * 5.3 s at the very fastest on a real route — see `trip.race.ts`. The clock samples are three at
 * join and none after. Ten a second against thirty stands.
 */
const MAX_MESSAGES_PER_SECOND = 30;

/** The vehicle kinds are a renderer file (`vehicles.ts`); this bounds the shape
 *  of one, not its membership, so a new machine needs no server deploy and a
 *  500-character string still cannot be replicated to everybody's screen. */
const RIDING = /^[a-z][a-z-]{0,23}$/;

type MoveMessage = { x?: unknown; z?: unknown; yaw?: unknown; heading?: unknown; speed?: unknown; riding?: unknown };
type ChatMessage = { text?: unknown };
type TimeMessage = { sent?: unknown };
type JoinOptions = { name?: unknown; location?: unknown; spawn?: unknown };

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Wrapped into one turn rather than passed through: these rotate a remote
 *  avatar and its machine, and a client is free to send 1e300. */
const wrapAngle = (value: number): number => Math.atan2(Math.sin(value), Math.cos(value));

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

/** A visitor can join after exploring, including on a bridge or in the water. */
const readSpawn = (value: unknown, terrain: Terrain): { x: number; z: number } | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { x, z } = value as { x?: unknown; z?: unknown };
  if (typeof x !== 'number' || typeof z !== 'number') return null;
  const half = terrain.size / 2;
  return Number.isFinite(x) && Number.isFinite(z) && Math.abs(x) <= half && Math.abs(z) <= half ? { x, z } : null;
};

export class TripRoom extends Room {
  state = new TripState();
  maxClients = config.maxClientsPerRoom;
  maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;

  private terrain: Terrain | null = null;
  private waterLevel = Number.NEGATIVE_INFINITY;
  private budgets = new Map<string, MoveBudget>();
  private lastRelocate = new Map<string, number>();
  private chatAllowance = new Map<string, { lines: number; at: number }>();
  private world = new World(this.state);
  private race = new Race(this.state, config.maxSpeed, {
    // The room's own clock, so a phase change is paced by the same tick that
    // encodes the state rather than by a timer the framework knows nothing about.
    after: (ms, run) => this.clock.setTimeout(run, ms),
  });

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
    this.onMessage('relocate', (client, message: MoveMessage) => this.handleRelocate(client, message));
    this.onMessage('chat', (client, message: ChatMessage) => this.handleChat(client, message));
    // What the clock sample is for: `race.startAt` is an instant on this
    // machine's clock, and a phone two seconds out would draw the lights going
    // out two seconds early. The reply carries the client's own send time back
    // so it can halve the round trip without the server keeping anything.
    this.onMessage('time', (client, message: TimeMessage) => {
      client.send('time', { sent: Number(message?.sent) || 0, now: Date.now() });
    });

    this.onMessage('world:hour', (client, message) => this.world.hour(client, message ?? {}));
    this.onMessage('world:preset', (client, message) => this.world.preset(client, message ?? {}));
    this.onMessage('world:clock', (client, message) => this.world.clock(client, message ?? {}));

    this.onMessage('race:setup', (client, message) => this.race.setup(client, message ?? {}));
    this.onMessage('race:join', (client) => this.race.join(client));
    this.onMessage('race:check', (client, message) => this.race.check(client, message ?? {}));
    this.onMessage('race:finish', (client, message) => this.race.finish(client, message ?? {}));
    this.onMessage('race:reset', () => this.race.reset());
  }

  onJoin(client: Client, options: JoinOptions) {
    const terrain = this.terrain;
    if (!terrain) throw new ServerError(500, 'Phòng chưa sẵn sàng');
    if (options?.location && options.location !== this.state.location) {
      throw new ServerError(400, 'Link mời không đúng địa điểm của phòng');
    }

    const spawn = readSpawn(options?.spawn, terrain) ?? findSpawn(terrain, this.waterLevel);

    const player = new Player();
    player.name = cleanName(options?.name);
    player.x = spawn.x;
    player.z = spawn.z;
    player.y = terrain.heightAt(spawn.x, spawn.z);
    player.yaw = 0;
    player.heading = 0;
    this.state.players.set(client.sessionId, player);

    this.budgets.set(client.sessionId, createBudget(Date.now(), spawn.x, spawn.z));
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
    this.budgets.delete(client.sessionId);
    this.chatAllowance.delete(client.sessionId);
    this.lastRelocate.delete(client.sessionId);
    this.race.forget(client.sessionId);
  }

  /**
   * The client sends where it thinks it is on the ground plane; the server reads
   * the height off the same heightfield the browser generated the world from, so
   * height cannot be forged and there is nothing about it left to check. What
   * remains is the ground plane: inside the map, and reached at a pace a vehicle
   * could really have carried somebody — `move-budget.ts` holds that arithmetic
   * and why it is an allowance rather than a division.
   *
   * `heading`, `speed` and `riding` ride along in the same packet. An absent one
   * means on foot and standing still rather than "unchanged", so a rider who
   * dismounts cannot leave a bike bolted to their companion's screen by simply
   * stopping sending.
   */
  private handleMove(client: Client, message: MoveMessage) {
    const terrain = this.terrain;
    const player = this.state.players.get(client.sessionId);
    const budget = this.budgets.get(client.sessionId);
    if (!terrain || !player || !budget) return;

    const x = Number(message?.x);
    const z = Number(message?.z);
    const yaw = Number(message?.yaw);
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return;

    const half = terrain.size / 2;
    const nextX = clamp(x, -half, half);
    const nextZ = clamp(z, -half, half);
    if (!allowStep(budget, Date.now(), nextX, nextZ, config.maxSpeed)) return;

    player.x = nextX;
    player.z = nextZ;
    player.y = terrain.heightAt(nextX, nextZ);
    player.yaw = wrapAngle(yaw);

    const heading = Number(message?.heading);
    player.heading = Number.isFinite(heading) ? wrapAngle(heading) : player.yaw;
    const speed = Number(message?.speed);
    player.speed = Number.isFinite(speed) ? clamp(speed, 0, config.maxSpeed) : 0;
    const riding = typeof message?.riding === 'string' ? message.riding : '';
    player.riding = RIDING.test(riding) ? riding : '';
  }

  /** Fast travel is an explicit action, not a stream of impossible walk packets. */
  private handleRelocate(client: Client, message: MoveMessage) {
    const player = this.state.players.get(client.sessionId);
    const terrain = this.terrain;
    if (!player || !terrain) return;
    const now = Date.now();
    if (now - (this.lastRelocate.get(client.sessionId) ?? 0) < 500) return;
    const x = message?.x;
    const z = message?.z;
    if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return;
    if (Math.abs(x) > terrain.size / 2 || Math.abs(z) > terrain.size / 2) return;
    this.lastRelocate.set(client.sessionId, now);
    player.x = x;
    player.z = z;
    player.y = terrain.heightAt(x, z);
    this.budgets.set(client.sessionId, createBudget(now, x, z));
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
