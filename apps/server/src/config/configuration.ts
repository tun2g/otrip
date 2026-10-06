export interface AppConfig {
  nodeEnv: string;
  port: number;
  /** Upper bound on people in one room — a trip is a few friends, not a crowd. */
  maxClientsPerRoom: number;
  /**
   * Metres per second a player may cover before the server stops believing it.
   *
   * 90 rather than the old 34, because the ridden machine now tops out at 63 m/s
   * on the boost and a legitimate racer must never trip this. It is an
   * anti-nonsense bound and not an anti-cheat one — `handleRelocate` already
   * grants any client an unvalidated jump anywhere on the map twice a second,
   * because fast travel is a feature — so the width given away here is width
   * that was already on offer through a different door.
   */
  maxSpeed: number;
  /**
   * How long a race field has to form up, and how long the lights hold, in
   * milliseconds.
   *
   * The defaults are the product: 15 s is a notification, read and a tap, and
   * the lights are separate so a racer counts down from a number rather than
   * from fifteen. They are in the environment because the race protocol is
   * otherwise untestable in less than twenty seconds a case —
   * `pnpm test:multiplayer` runs its server with both set to a second.
   */
  raceGridMs: number;
  raceLightsMs: number;
}

/**
 * A misspelt number in the environment is worse than a missing one. `Number('')`
 * is 0 and `Number('fast')` is NaN, and both reach the room unnoticed: a NaN
 * `maxSpeed` makes every comparison against it false, which turns the movement
 * check off without a word, and a NaN port makes the server listen on a random
 * one. Anything that is not a positive finite number falls back to the default.
 */
const positiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const loadConfig = (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: positiveNumber(process.env.PORT, 2567),
  maxClientsPerRoom: positiveNumber(process.env.MAX_CLIENTS_PER_ROOM, 8),
  maxSpeed: positiveNumber(process.env.MAX_SPEED, 90),
  raceGridMs: positiveNumber(process.env.RACE_GRID_MS, 15_000),
  raceLightsMs: positiveNumber(process.env.RACE_LIGHTS_MS, 5_000),
});
