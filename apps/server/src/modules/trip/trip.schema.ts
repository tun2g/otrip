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
    /**
     * Where the machine points, which is not where the rider looks. Once someone
     * is riding, `yaw` is the camera's own heading and the vehicle's is a
     * separate number — a bike on a left-hander is pointed into the bend while
     * the rider's head is already down the exit.
     */
    heading: t.number().default(0),
    /**
     * '' on foot, otherwise the vehicle kind. The roster lives in the renderer
     * (`vehicles.ts`) and never reaches the server, so this is bounded by shape
     * and length rather than checked against a list — see `cleanRiding`. It is
     * the field that lets a companion be drawn on a bike instead of as a jogger
     * covering 25 m/s, which is the giveaway that nothing is synchronised.
     */
    riding: t.string().default(''),
    /** m/s, so a companion's wheels and lean can be driven without having to
     *  differentiate positions that arrive at whatever rate the network manages. */
    speed: t.number().default(0),
    racing: t.boolean().default(false),
    /** Laps completed, and checkpoints passed in the current lap — the same two
     *  numbers `RacerProgress` holds in the browser, kept here by the server's own
     *  reckoning of the checks it accepted. */
    lap: t.number().default(0),
    check: t.number().default(0),
    /** Best lap and finishing time, in milliseconds. 0 is "no time", not zero. */
    bestMs: t.number().default(0),
    finishedMs: t.number().default(0),
  },
  'Player'
);

/**
 * What everyone standing in the same place has to agree about.
 *
 * The hour is carried as the forecast's own stamp rather than its index. The
 * 48-hour window is anchored at the destination's midnight, so a forecast
 * fetched after midnight holds the same hour at a lower index: an index pinned
 * one evening draws whatever hour has slid into the slot by morning, which is
 * the bug `location-scene.tsx` already records against its `?luc=` parameter.
 *
 * `anchorAt` is what makes a running clock agree rather than merely both run.
 * Each browser advances the hour on its own interval, so two clients that both
 * know `playing` and `speedStep` still sit up to one whole forecast hour apart
 * depending on when their interval happened to start — which is the complaint
 * this is for. With an anchor, the hour is derived, not stepped:
 *
 *     index(stamp) + floor((serverNow - anchorAt) / 1000 / secondsPerHour)
 *
 * so every client lands on the same hour from the same two numbers, and pressing
 * play costs exactly one message rather than one per hour.
 *
 * Deliberately NOT here: the NPC fleet, the boats, the villagers and the
 * wildlife. Every one of them is seeded from `recipe.seed` and then integrated
 * per frame from the local delta, so agreement would mean either replicating
 * hundreds of transforms at 10 Hz or making every one of those modules
 * frame-rate independent. They are scenery. The hour and the weather are the
 * place, and they are what two friends notice they do not share.
 */
export const WorldState = schema(
  {
    /** Forecast stamp, `YYYY-MM-DDThh:mm`. '' means nobody has pinned an hour and
     *  the room follows the destination's real one. */
    hourStamp: t.string().default(''),
    /** Server epoch ms the hour or the clock was last set. */
    anchorAt: t.number().default(0),
    playing: t.boolean().default(false),
    /** Index into the renderer's own speed ladder. The ladder is three entries in
     *  `location-scene.tsx` and the server has no business knowing that, so this
     *  is bounded as an index and the UI already falls back on one it cannot use. */
    speedStep: t.number().default(0),
    /** A `WeatherPresetId`, or '' for nobody's choice. Bounded by shape for the
     *  same reason as `riding`: the preset table is a browser file. */
    preset: t.string().default(''),
    /** Display name of whoever set it, read from room state the way chat is, so
     *  nobody can sign a change with a friend's name. */
    by: t.string().default(''),
  },
  'WorldState'
);

/**
 * The race, as the room sees it. Per-racer progress lives on `Player`; this is
 * the part that has to be one thing for everybody — above all `startAt`, which
 * is why a client is never asked when the lights go out.
 *
 * `checksPerLap` and `lapLength` are declared by whoever sets the race up: the
 * route is laid in the browser from the road network, and the server builds
 * terrain but no roads, so it cannot compute them. They are clamped to what
 * `race-route.ts` can actually produce and they are what the timing bounds are
 * derived from — see `trip.race.ts`.
 */
export const RaceState = schema(
  {
    /** `RacePhase` in `scene/race.ts`: idle | grid | countdown | running | ended. */
    phase: t.string().default('idle'),
    laps: t.number().default(0),
    checksPerLap: t.number().default(0),
    lapLength: t.number().default(0),
    /** Server epoch ms the lights go out. 0 outside a race. */
    startAt: t.number().default(0),
    endedAt: t.number().default(0),
    by: t.string().default(''),
  },
  'RaceState'
);

export const TripState = schema(
  {
    location: t.string(),
    players: t.map(Player),
    world: t.ref(WorldState),
    race: t.ref(RaceState),
  },
  'TripState'
);

export type PlayerInstance = InstanceType<typeof Player>;
export type WorldStateInstance = InstanceType<typeof WorldState>;
export type RaceStateInstance = InstanceType<typeof RaceState>;
export type TripStateInstance = InstanceType<typeof TripState>;
