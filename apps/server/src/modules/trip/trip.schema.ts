import { schema, t } from '@colyseus/schema';

/**
 * The functional schema builder rather than decorators: the server runs straight
 * from TypeScript source through Node's type stripping, which erases types but
 * cannot execute decorators.
 */
export const Player = schema(
  {
    name: t.string(),
    x: t.number(),
    y: t.number(),
    z: t.number(),
    yaw: t.number(),
  },
  'Player'
);

export const TripState = schema(
  {
    location: t.string(),
    players: t.map(Player),
  },
  'TripState'
);

export type PlayerInstance = InstanceType<typeof Player>;
export type TripStateInstance = InstanceType<typeof TripState>;
