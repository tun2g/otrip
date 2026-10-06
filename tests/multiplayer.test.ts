import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import type { TripPlayer, TripRace, TripWorld } from '../apps/web/src/lib/trip-client.ts';
import { connectToTrip, inviteUrl, isRoomId, readRoomId, ROOM_PARAM } from '../apps/web/src/lib/trip-client.ts';
import { allowStep, createBudget } from '../apps/server/src/shared/move-budget.ts';
import { worldFor } from '../apps/server/src/shared/terrain-cache.ts';
import { isSpawnable } from '../apps/server/src/shared/spawn.ts';

/** The limit the room is started with, so the bounds derived from it can be
 *  stated here as numbers rather than guessed at. */
const MAX_SPEED = 34;

/**
 * The grid and the lights, cut to a second each for the tests.
 *
 * The product defaults are 15 s and 5 s, which would make every race case a
 * twenty-second wait before the first assertion. The timing *bounds* are not
 * relaxed — those come from `MAX_SPEED` and the route's geometry, and they are
 * what the race cases are about.
 */
const GRID_MS = 1000;
const LIGHTS_MS = 1000;

let server: ChildProcess;
let logs = '';

async function until(predicate: () => boolean, label = 'multiplayer state', ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await delay(25);
  }
}

/** Somewhere far from the fallback spawn with room to drive, which is what
 *  reproduced the original rejected movement. */
function findStart(location: string): { x: number; z: number } {
  const world = worldFor(location)!;
  const water = world.recipe.water?.level ?? -Infinity;
  for (let x = world.terrain.size * 0.3; x > 100; x -= 30) {
    for (let z = 100; z < world.terrain.size * 0.4; z += 30) {
      if (isSpawnable(world.terrain, water, x, z) && isSpawnable(world.terrain, water, x + 4, z)) return { x, z };
    }
  }
  throw new Error(`no test spawn for ${location}`);
}

before(async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  server = spawn(process.execPath, ['--experimental-strip-types', 'apps/server/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      MAX_SPEED: String(MAX_SPEED),
      RACE_GRID_MS: String(GRID_MS),
      RACE_LIGHTS_MS: String(LIGHTS_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (data) => {
    logs += data;
  });
  server.stderr!.on('data', (data) => {
    logs += data;
  });
  process.env.NEXT_PUBLIC_REALTIME_URL = `ws://127.0.0.1:${port}`;
  await until(() => logs.includes('phòng du lịch đang nghe'), 'the room server to listen');
});

after(async () => {
  server.kill('SIGTERM');
  await once(server, 'exit');
});

test('two real clients receive spawn, movement, chat, late join and leave in every destination', async () => {
  for (const location of ['ta-xua', 'hoi-an', 'trang-an', 'ho-tay']) {
    const world = worldFor(location)!;
    const start = findStart(location);
    const a = await connectToTrip(location, 'Alice', undefined, start);
    const b = await connectToTrip(location, 'Bob', a.room.roomId, { x: start.x + 4, z: start.z });
    try {
      let seenA: TripPlayer[] = [],
        seenB: TripPlayer[] = [];
      a.onPlayers((players) => {
        seenA = players;
      });
      b.onPlayers((players) => {
        seenB = players;
      });
      await until(() => seenA.length === 1 && seenB.length === 1);
      assert.ok(Math.abs(seenB[0].x - start.x) < 0.01, `${location}: initial spawn`);
      assert.equal(seenA[0].id, b.room.sessionId);
      assert.equal(seenB[0].id, a.room.sessionId);
      for (let step = 1; step <= 4; step++) {
        await delay(110);
        a.move(start.x + step, start.z, 0.5);
        b.move(start.x + 4, start.z + step, -0.5);
        await until(
          () => Math.abs(seenB[0].x - (start!.x + step)) < 0.01 && Math.abs(seenA[0].z - (start!.z + step)) < 0.01
        );
      }
      assert.ok(Math.abs(seenB[0].yaw - 0.5) < 0.001);
      let message = '';
      b.onChat((line) => {
        message = `${line.from}: ${line.text}`;
      });
      a.onChat(() => {});
      a.say('hello');
      await until(() => message === 'Alice: hello');
      // An impossible move must still be rejected; the fix cannot disable validation.
      a.move(-world.terrain.size / 2, -world.terrain.size / 2, 0);
      await delay(150);
      assert.ok(Math.abs(seenB[0].x - (start.x + 4)) < 0.01);
      a.relocate(start.x - 400, start.z);
      await until(() => Math.abs(seenB[0].x - (start!.x - 400)) < 0.01);
      await delay(110);
      a.move(start.x - 399, start.z, 1);
      await until(() => Math.abs(seenB[0].x - (start!.x - 399)) < 0.01);
      await assert.rejects(connectToTrip('wrong-place', 'Wrong', a.room.roomId, start));
      const late = await connectToTrip(location, 'Late', a.room.roomId, start);
      let roster: TripPlayer[] = [];
      late.onPlayers((players) => {
        roster = players;
      });
      await until(() => roster.length === 2);
      late.leave();
      b.leave();
      await until(() => seenA.length === 0);
      console.log(`${location}: two-way movement and lifecycle OK`);
    } finally {
      a.leave();
      b.leave();
    }
  }
});

test('the hour, the weather and the clock are the room’s, including for someone who arrives late', async () => {
  const start = findStart('hoi-an');
  const a = await connectToTrip('hoi-an', 'Alice', undefined, start);
  const b = await connectToTrip('hoi-an', 'Bob', a.room.roomId, start);
  let late: Awaited<ReturnType<typeof connectToTrip>> | null = null;
  try {
    let worldB: TripWorld | null = null;
    b.onWorld((world) => {
      worldB = world;
    });

    const stamp = '2026-10-06T06:00';
    a.setHour(stamp);
    a.setPreset('mua');
    await until(() => worldB?.hourStamp === stamp && worldB?.preset === 'mua', 'the hour and the preset to arrive');
    assert.equal(worldB!.by, 'Alice', 'the writer is named from room state, not from the packet');
    assert.ok(worldB!.anchorAt > 0, 'the hour carries when it was set');

    // Nonsense is refused without disturbing what the room already agreed.
    a.setHour('tomorrow morning');
    a.setPreset('<script>alert(1)</script>');
    a.setClock(true, 99, stamp);
    await delay(200);
    assert.equal(worldB!.hourStamp, stamp);
    assert.equal(worldB!.preset, 'mua');
    assert.equal(worldB!.playing, false, 'an out-of-range speed step is not a clock change');

    b.setClock(true, 2, stamp);
    await until(() => worldB?.playing === true && worldB?.speedStep === 2, 'the clock to start for everybody');
    assert.equal(worldB!.by, 'Bob');

    // The case a design without a timestamp fails silently: somebody who was not
    // there when the hour was chosen has to arrive at it, not at their own default.
    late = await connectToTrip('hoi-an', 'Late', a.room.roomId, start);
    let worldLate: TripWorld | null = null;
    late.onWorld((world) => {
      worldLate = world;
    });
    await until(
      () => worldLate?.hourStamp === stamp,
      'a late arrival to land on the hour the room is living in rather than its own default'
    );
    assert.equal(worldLate!.preset, 'mua');
    assert.equal(worldLate!.playing, true);
    assert.equal(worldLate!.speedStep, 2);
    assert.ok(
      Math.abs(worldLate!.anchorAt - late.serverNow()) < 60_000,
      'the anchor is an instant on the clock the client measures against'
    );

    a.setHour(null);
    await until(() => worldB?.hourStamp === '', 'the room to follow its real hour again');
    console.log('world sync: hour, preset and clock shared, and read by a late arrival');
  } finally {
    late?.leave();
    a.leave();
    b.leave();
  }
});

test('the room id goes in the URL under ?r= and survives the round trip', async () => {
  const start = findStart('trang-an');
  const a = await connectToTrip('trang-an', 'Alice', undefined, start);
  try {
    const roomId = a.room.roomId;
    assert.ok(isRoomId(roomId), `a real room id passes the guard: ${roomId}`);

    const url = inviteUrl(roomId, 'https://otrip.app/trang-an?luc=2026-10-06T06%3A00');
    assert.match(url, new RegExp(`[?&]${ROOM_PARAM}=${roomId}(&|$)`));
    assert.match(url, /luc=2026-10-06T06%3A00/, 'the invitation keeps the hour that is pinned');
    assert.equal(readRoomId(url), roomId);
    assert.equal(readRoomId(`?${ROOM_PARAM}=${roomId}`), roomId, 'a bare search is read too');

    // Everything here arrives from an address bar, so none of it may throw.
    for (const hostile of [
      '',
      `?${ROOM_PARAM}=`,
      `?${ROOM_PARAM}=${'x'.repeat(500)}`,
      `?${ROOM_PARAM}=../../etc/passwd`,
      `?${ROOM_PARAM}=${encodeURIComponent('https://evil.example/room')}`,
      `?${ROOM_PARAM}=ab`,
      `?${ROOM_PARAM}=has%20space`,
      'https://otrip.app/trang-an',
      `https://otrip.app/trang-an#?${ROOM_PARAM}=${roomId}`,
      'not a url at all',
    ]) {
      assert.equal(readRoomId(hostile), null, `refused: ${hostile.slice(0, 40)}`);
    }

    // The point of the parameter: the id parsed back out of the link joins the room.
    const parsed = readRoomId(url)!;
    const b = await connectToTrip('trang-an', 'Bob', parsed, start);
    try {
      assert.equal(b.room.roomId, roomId);
      let roster: TripPlayer[] = [];
      b.onPlayers((players) => {
        roster = players;
      });
      await until(() => roster.length === 1, 'the invited client to see the host');
      assert.equal(roster[0].name, 'Alice');
    } finally {
      b.leave();
    }
    console.log(`?${ROOM_PARAM}= round trip OK, and ten hostile ids refused without throwing`);
  } finally {
    a.leave();
  }
});

test('a race is held by the server: countdown, ordering, timing, finish and reset', async () => {
  const start = findStart('ho-tay');
  const a = await connectToTrip('ho-tay', 'Alice', undefined, start);
  const b = await connectToTrip('ho-tay', 'Bob', a.room.roomId, { x: start.x + 4, z: start.z });
  try {
    let raceA: TripRace | null = null;
    let seenByB: TripPlayer[] = [];
    let seenByA: TripPlayer[] = [];
    a.onRace((race) => {
      raceA = race;
    });
    a.onPlayers((players) => {
      seenByA = players;
    });
    b.onPlayers((players) => {
      seenByB = players;
    });
    await until(() => seenByA.length === 1 && seenByB.length === 1);

    // The smallest route `planRoute` can produce, because a lap cannot be driven
    // faster than `lapLength / maxSpeed` and this is a test, not an afternoon.
    const laps = 1;
    const checksPerLap = 6;
    const lapLength = 400;
    const split = (lapLength / checksPerLap / MAX_SPEED) * 1000;

    const before = Date.now();
    a.setupRace(laps, { checksPerLap, lapLength });
    await until(() => raceA?.phase === 'grid', 'the field to form up');
    assert.equal(raceA!.by, 'Alice');
    assert.equal(raceA!.laps, laps);
    const startAt = raceA!.startAt;
    assert.ok(
      startAt >= before + GRID_MS + LIGHTS_MS && startAt <= Date.now() + GRID_MS + LIGHTS_MS,
      'the start is an instant on the server’s clock, not on a client’s'
    );

    b.joinRace();
    await until(() => seenByA.some((player) => player.racing), 'Bob to take the offer');

    await until(() => raceA?.phase === 'countdown', 'the lights', GRID_MS + 2000);
    await until(() => raceA?.phase === 'running', 'the lights to go out', LIGHTS_MS + 2000);
    // The server moved the phase on its own clock; nobody sent anything to do it.
    assert.ok(Date.now() >= startAt - 100, 'running no earlier than the start it published');

    const elapsed = () => Date.now() - startAt;
    const self = () => seenByB.find((player) => player.id === a.room.sessionId)!;

    // Out of order: the third crossing when the first is expected.
    a.reportCheck(3, 0, split * 4);
    await delay(200);
    assert.equal(self().check, 0, 'a checkpoint out of order is refused');

    for (let crossing = 1; crossing <= checksPerLap; crossing += 1) {
      const atMs = crossing * split + 10;
      await until(() => elapsed() >= atMs - 1980, `the clock to reach crossing ${crossing}`, 15_000);
      a.reportCheck(crossing - 1, 0, atMs);
      b.reportCheck(crossing - 1, 0, atMs);
      await until(
        () => self().check === crossing % checksPerLap && self().lap === Math.floor(crossing / checksPerLap),
        `crossing ${crossing} to be accepted`
      );
      if (crossing === 2) {
        // Replayed one second later: 1 s is less than the 1.96 s this route's
        // 66.7 m spacing needs at 34 m/s, so it is not a crossing that happened.
        a.reportCheck(crossing, 0, atMs + 1000);
        await delay(200);
        assert.equal(self().check, crossing, 'a split shorter than the distance allows is refused');
      }
    }

    await until(() => self().finishedMs > 0, 'Alice to be given a finishing time');
    const serverFinish = self().finishedMs;
    a.finishRace(serverFinish - 50);
    await until(() => self().finishedMs === serverFinish - 50, 'a finishing time close to the server’s to be taken');
    a.finishRace(10);
    await delay(200);
    assert.equal(self().finishedMs, serverFinish - 50, 'a finishing time the server’s clock contradicts is refused');

    await until(() => raceA?.phase === 'ended', 'the race to end once nobody is still out');
    assert.ok(raceA!.endedAt > 0);
    const bob = seenByA.find((player) => player.id === b.room.sessionId)!;
    assert.ok(bob.finishedMs > 0, 'both clients finished');
    assert.ok(bob.bestMs > 0, 'and have a lap record');

    b.resetRace();
    await until(() => raceA?.phase === 'idle', 'reset to return the room to idle');
    assert.equal(raceA!.laps, 0);
    await until(() => seenByA.every((player) => !player.racing && player.lap === 0), 'racers to be cleared');
    console.log(`race: ${checksPerLap} crossings validated at a ${Math.round(split)} ms floor, finish and reset OK`);
  } finally {
    a.leave();
    b.leave();
  }
});

test('a racer at 28 m/s is never dropped, and nonsense still is', async () => {
  const start = findStart('ho-tay');
  const a = await connectToTrip('ho-tay', 'Alice', undefined, start);
  const b = await connectToTrip('ho-tay', 'Bob', a.room.roomId, { x: start.x + 4, z: start.z });
  try {
    let seen: TripPlayer[] = [];
    b.onPlayers((players) => {
      seen = players;
    });
    await until(() => seen.length === 1);

    // 2.8 m every 100 ms is 28 m/s, which is what the ridden bike does flat out.
    // Every single packet has to land: the old per-interval check passed this
    // only while consecutive packets stayed more than 85 ms apart.
    const step = 2.8;
    let travelled = 0;
    for (let packet = 1; packet <= 30; packet += 1) {
      await delay(100);
      travelled += step;
      a.move(start.x - travelled, start.z, 0, { heading: Math.PI, speed: 28, riding: 'motorbike' });
      await until(
        () => Math.abs(seen[0].x - (start.x - travelled)) < 0.01,
        `packet ${packet} of a 28 m/s run to be accepted`,
        2000
      );
    }

    // A delivered backlog: three positions arriving in the same millisecond,
    // which is the shape of a stalled socket catching up. All three are real.
    await delay(600);
    for (let bunched = 0; bunched < 3; bunched += 1) {
      travelled += step;
      a.move(start.x - travelled, start.z, 0, { heading: Math.PI, speed: 28, riding: 'motorbike' });
    }
    await until(() => Math.abs(seen[0].x - (start.x - travelled)) < 0.01, 'a bunched burst to be accepted', 2000);

    const riding = seen[0];
    assert.equal(riding.riding, 'motorbike', 'a companion on a bike is drawn on one');
    assert.ok(Math.abs(riding.heading - Math.PI) < 0.001, 'with the machine’s own heading');
    assert.ok(Math.abs(riding.speed - 28) < 0.001, 'and its speed');

    // Dismounting by sending nothing: an absent field is on foot, not unchanged.
    await delay(110);
    travelled += 0.2;
    a.move(start.x - travelled, start.z, 0.25);
    await until(() => seen[0].riding === '', 'a rider who stops sending a vehicle to be back on foot');
    assert.equal(seen[0].speed, 0);

    const held = seen[0].x;
    a.move(start.x - travelled - 400, start.z, 0);
    await delay(250);
    assert.ok(Math.abs(seen[0].x - held) < 0.01, 'a 400 m jump in one packet is still refused');
    console.log('speed window: 33 packets at 28 m/s accepted including a bunched burst, 400 m jump refused');
  } finally {
    a.leave();
    b.leave();
  }
});

test('the movement allowance refuses a sustained overspeed and never deadlocks', () => {
  const run = (speed: number, intervalMs: number, packets: number, idleMs = 0) => {
    let now = 1_000_000;
    const budget = createBudget(now, 0, 0);
    // Standing still banks the allowance, which is the difference between
    // "refused at once" and "refused once the bank is empty".
    now += idleMs;
    let x = 0;
    let refused = 0;
    let firstRefusalMs: number | null = null;
    for (let packet = 0; packet < packets; packet += 1) {
      now += intervalMs;
      x += (speed * intervalMs) / 1000;
      if (!allowStep(budget, now, x, 0, MAX_SPEED)) {
        refused += 1;
        if (firstRefusalMs === null) firstRefusalMs = packet * intervalMs;
      }
    }
    return { refused, firstRefusalMs };
  };

  assert.equal(run(28, 100, 100).refused, 0, '28 m/s for ten seconds is never refused');
  assert.equal(run(33.9, 100, 100).refused, 0, 'nor is a hair under the limit');
  // Sending ten times as often buys nothing, because spending is by distance.
  assert.equal(run(28, 10, 1000).refused, 0, '28 m/s reported at 100 Hz is the same journey');

  // Bunching is the case the per-interval check failed, and it cannot be modelled
  // with a constant interval: the positions keep advancing on their own 100 ms
  // schedule while the delivery of fifteen of them is compressed into 15 ms,
  // which is the shape of a stalled socket handing over its backlog. Measured
  // against the old rule, every one of these was 2.8 m in 1 ms — 2800 m/s.
  let clock = 1_000_000;
  const stalled = createBudget(clock, 0, 0);
  let where = 0;
  let dropped = 0;
  clock += 1500;
  for (let packet = 0; packet < 15; packet += 1) {
    where += 2.8;
    clock += 1;
    if (!allowStep(stalled, clock, where, 0, MAX_SPEED)) dropped += 1;
  }
  assert.equal(dropped, 0, 'a 1.5 s backlog of 28 m/s positions is one journey, not fifteen teleports');

  // The allowance starts empty, so a player who was not already standing still
  // has nothing banked and 40 m/s is refused from the very first packet.
  const over = run(40, 100, 200);
  assert.equal(over.firstRefusalMs, 0, '40 m/s is refused immediately from a fresh baseline');
  assert.ok(over.refused > 150, `and goes on being refused, ${over.refused} of 200 packets`);

  // Standing still first banks 1.5 s of travel — 51 m at the default limit —
  // which 40 m/s then overspends by 0.6 m per 100 ms packet, so the bank empties
  // after about eight seconds of trying. Measured at 7.9 s. That is the burst
  // doing its job rather than a hole: the average over any window longer than
  // the burst is still bounded by the limit, and 7.9 s of 40 m/s is 316 m where
  // `relocate` already grants any client the whole map twice a second.
  const banked = run(40, 100, 200, 2000);
  assert.ok(
    banked.firstRefusalMs! >= 7500 && banked.firstRefusalMs! <= 8500,
    `a banked 40 m/s runs out at about 8 s, measured ${banked.firstRefusalMs} ms`
  );
  assert.ok(run(100, 100, 100, 2000).firstRefusalMs! <= 900, 'and 100 m/s inside a second even when banked');

  // The deadlock this replaced an interval check to avoid: a ten-second gap puts
  // a legitimate racer 280 m from the baseline, far past any allowance. It has
  // to be believed, or that player is frozen for the rest of the session.
  let now = 1_000_000;
  const budget = createBudget(now, 0, 0);
  assert.equal(allowStep(budget, (now += 10_000), 280, 0, MAX_SPEED), true, 'a long gap re-baselines');
  assert.equal(allowStep(budget, (now += 100), 282.8, 0, MAX_SPEED), true, 'and carries on from there');

  // And the same escape when packets keep arriving and are all disbelieved: a
  // backlog delivered while the client keeps moving leaves the accepted baseline
  // hundreds of metres behind, and no amount of refusing closes that gap.
  const stuck = createBudget(now, 0, 0);
  let refusals = 0;
  let firstAcceptMs: number | null = null;
  let acceptedAfter = 0;
  for (let packet = 1; packet <= 60; packet += 1) {
    now += 100;
    const allowed = allowStep(stuck, now, 500 + packet, 0, MAX_SPEED);
    if (!allowed) refusals += 1;
    else if (firstAcceptMs === null) firstAcceptMs = packet * 100;
    else acceptedAfter += 1;
  }
  assert.equal(refusals, 29, 'a 500 m gap is disbelieved for three seconds');
  assert.equal(firstAcceptMs, 3000, 'and then conceded, because the baseline is the stale thing');
  assert.equal(acceptedAfter, 30, 'after which the player tracks normally rather than staying frozen');
  console.log(
    `allowance: 28 m/s and a 1.5 s backlog accepted, 40 m/s refused at once (${banked.firstRefusalMs} ms when banked), no deadlock`
  );
});
