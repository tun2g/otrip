/**
 * Whether a player could really have got from where the server last saw them to
 * where they say they are now.
 *
 * It is an allowance of metres that refills at the speed limit, which is the
 * same shape as the chat allowance in `trip.room.ts` and for the same reason: a
 * limit measured over one packet interval is a limit on the network rather than
 * on the player.
 *
 * ## What the per-packet check got wrong
 *
 * The check this replaces divided the step by the time since the previous
 * accepted packet. The renderer sends a `move` every 100 ms, so at a racing
 * 29 m/s — `ABSOLUTE_TOP` in `driving.ts` — each step is 2.9 m and the measured
 * speed is `2.9 / Δt`. Against a 34 m/s limit that passes only while
 * `Δt ≥ 100 × 29/34 = 85 ms`. Two packets sent 100 ms apart and delivered 80 ms
 * apart — an ordinary thing on a phone, since a stalled socket delivers its
 * backlog in a burst — therefore measured 36 m/s and the position was silently
 * dropped. A friend's bike froze and then jumped, and nothing anywhere said why.
 *
 * Note that the stale baseline is NOT the failure: a rejected packet leaves the
 * baseline where it was, and because the interval is measured from the same
 * baseline the interval grows too, which makes the next check more permissive
 * rather than less. The fragility was always on the short side of the interval.
 *
 * ## Why an allowance fixes it without reopening the hole
 *
 * Spending is by distance covered and refilling is by time elapsed, so sending
 * faster buys nothing — the exploit that made the previous floor under the
 * interval untenable, where 1.7 m every 10 ms measured 34 m/s and travelled 170.
 * Over any window longer than the burst, the average speed cannot exceed the
 * limit; inside it, a backlog is paid for out of the time it took to accumulate.
 */

/**
 * Seconds of travel the allowance may bank. A 1.5 s stall at 29 m/s is 44 m of
 * real travel arriving at once, against a 51 m ceiling at the default limit.
 *
 * Note that a burst of queued packets is a sequence of successive positions, so
 * the backlog is spent 2.9 m at a time rather than in one 44 m jump — the
 * ceiling has to cover the whole burst, not one packet of it, which is why this
 * is stated in seconds of the limit and not in metres.
 */
const BURST_SECONDS = 1.5;

/**
 * Seconds of being disbelieved before the server concedes that its own baseline
 * is the stale thing.
 *
 * Without this the allowance deadlocks, and permanently. If the network holds a
 * client's packets for ten seconds and then delivers them, the backlog is 290 m
 * of successive positions against a 51 m allowance: the first seventeen are
 * accepted, the rest are rejected, and by the time the stream catches up the
 * accepted baseline is 290 m behind a player who is still moving. The gap never
 * closes, the allowance is capped, and that player is frozen for the rest of the
 * session. Three seconds of continuous disagreement — or three seconds with no
 * packet at all, which is the same question — means believe them and re-measure
 * from there.
 *
 * It costs nothing that was being defended. `handleRelocate` already grants any
 * client an unvalidated jump to anywhere on the map twice a second, because fast
 * travel is a feature; one concession per three seconds is strictly less than
 * that. This check is here to keep nonsense out of other people's screens, and
 * it is not and cannot be an anti-cheat while positions are reported by the
 * client — which they are, by design.
 */
const CONCEDE_SECONDS = 3;

export type MoveBudget = {
  /** When the allowance was last refilled, accepted or not. */
  at: number;
  /** When a step was last believed. */
  accepted: number;
  x: number;
  z: number;
  metres: number;
};

/**
 * Seeded on join rather than on the first packet: with nothing to measure
 * against, the first `move` of a session could put you anywhere on the map.
 */
export const createBudget = (now: number, x: number, z: number): MoveBudget => ({
  at: now,
  accepted: now,
  x,
  z,
  metres: 0,
});

/**
 * Whether the step is believable, refilling and spending the allowance either
 * way. The baseline moves only on a step that was believed.
 */
export const allowStep = (budget: MoveBudget, now: number, x: number, z: number, maxSpeed: number): boolean => {
  const elapsed = Math.max(0, now - budget.at) / 1000;
  budget.at = now;
  budget.metres = Math.min(maxSpeed * BURST_SECONDS, budget.metres + elapsed * maxSpeed);

  const step = Math.hypot(x - budget.x, z - budget.z);
  if (step > budget.metres && now - budget.accepted < CONCEDE_SECONDS * 1000) return false;

  budget.metres = Math.max(0, budget.metres - step);
  budget.accepted = now;
  budget.x = x;
  budget.z = z;
  return true;
};
