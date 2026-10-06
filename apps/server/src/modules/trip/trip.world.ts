import type { Client } from 'colyseus';

import type { TripStateInstance } from './trip.schema.ts';

/**
 * The part of the place that is not a person: which hour of the forecast the
 * room is standing in, which weather it asked for, and whether the hour is
 * running.
 *
 * Last writer wins, and that needs no reconciling. Colyseus hands every message
 * to one room on one thread, so arrival order *is* the order and there is no
 * concurrent write to merge. The timestamp is not a tie-break: it is the anchor
 * a running clock is derived from, and the thing a client that has only just
 * arrived reads so that it lands on the hour the room is already living in
 * rather than on its own default — see `trip.schema.ts`.
 *
 * Nobody here is a host. A few friends who already know each other is the social
 * unit this whole app is built for, which is also why there is no moderation
 * queue and no permission to grant.
 */

/** A forecast hour's own stamp, `YYYY-MM-DDThh:mm`, as the weather API returns
 *  it. The server holds no forecast, so this is the shape and nothing more. */
const HOUR_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** A `WeatherPresetId`. The preset table is a browser file (`weather-presets.ts`)
 *  and the server has no business holding a copy, so this bounds the shape of an
 *  id and not its membership — a ninth preset needs no server deploy, and a
 *  500-character string still cannot be replicated to everybody's screen. */
const PRESET = /^[a-z][a-z-]{0,23}$/;

/** Entries in the renderer's own speed ladder. Three today, in
 *  `location-scene.tsx`, which already falls back on its default for an index it
 *  cannot use. */
const MAX_SPEED_STEP = 15;

type HourMessage = { stamp?: unknown };
type PresetMessage = { preset?: unknown };
type ClockMessage = { playing?: unknown; speedStep?: unknown; stamp?: unknown };

const readStamp = (value: unknown): string | null => {
  if (typeof value !== 'string' || value === '') return '';
  return HOUR_STAMP.test(value) ? value : null;
};

export class World {
  /** Assigned in the body rather than declared as a parameter property: Node's
   *  type stripping erases types but cannot emit the assignment one implies. */
  private readonly state: TripStateInstance;

  constructor(state: TripStateInstance) {
    this.state = state;
  }

  /** Pinning an hour, or '' to hand the room back to the destination's real one. */
  hour(client: Client, message: HourMessage) {
    const player = this.state.players.get(client.sessionId);
    const stamp = readStamp(message?.stamp);
    if (!player || stamp === null) return;
    this.state.world.hourStamp = stamp;
    this.state.world.anchorAt = Date.now();
    this.state.world.by = player.name;
  }

  /** The picker is a lie by design, and two people standing in one place should
   *  at least be told the same lie. */
  preset(client: Client, message: PresetMessage) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    const preset = typeof message?.preset === 'string' ? message.preset : '';
    if (preset && !PRESET.test(preset)) return;
    this.state.world.preset = preset;
    this.state.world.by = player.name;
  }

  /**
   * Whether the hour is running, and how fast.
   *
   * The stamp travels with it, and has to. The hour a client shows while the
   * clock runs is derived from the anchor, so a pause that moves the anchor
   * without restating which hour is on screen snaps everybody back to the hour
   * play started from. One write sets both, which makes press-play, press-pause
   * and change-speed the same operation: re-anchor here, now, on this hour.
   */
  clock(client: Client, message: ClockMessage) {
    const player = this.state.players.get(client.sessionId);
    const step = Number(message?.speedStep);
    if (!player || !Number.isInteger(step) || step < 0 || step > MAX_SPEED_STEP) return;
    const stamp = readStamp(message?.stamp);
    if (stamp === null) return;

    this.state.world.playing = message?.playing === true;
    this.state.world.speedStep = step;
    if (stamp) this.state.world.hourStamp = stamp;
    this.state.world.anchorAt = Date.now();
    this.state.world.by = player.name;
  }
}
