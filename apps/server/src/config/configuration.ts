export interface AppConfig {
  nodeEnv: string;
  port: number;
  /** Upper bound on people in one room — a trip is a few friends, not a crowd. */
  maxClientsPerRoom: number;
  /** Metres per second a player may cover before the server stops believing it. */
  maxSpeed: number;
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
  maxSpeed: positiveNumber(process.env.MAX_SPEED, 34),
});
