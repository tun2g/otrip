import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import type { RemotePlayer } from '../apps/web/src/scene/avatars.ts';
import { connectToTrip } from '../apps/web/src/lib/trip-client.ts';
import { worldFor } from '../apps/server/src/shared/terrain-cache.ts';
import { isSpawnable } from '../apps/server/src/shared/spawn.ts';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for multiplayer state');
    await delay(25);
  }
}

test('two real clients receive spawn, movement, chat, late join and leave in every destination', async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = spawn(process.execPath, ['--experimental-strip-types', 'apps/server/src/main.ts'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', (data) => {
    logs += data;
  });
  server.stderr.on('data', (data) => {
    logs += data;
  });
  process.env.NEXT_PUBLIC_REALTIME_URL = `ws://127.0.0.1:${port}`;
  try {
    await until(() => logs.includes('phòng du lịch đang nghe'));
    for (const location of ['ta-xua', 'hoi-an', 'trang-an', 'ho-tay']) {
      const world = worldFor(location)!;
      // Far from the fallback spawn, reproducing the original rejected movement.
      let start: { x: number; z: number } | undefined;
      const water = world.recipe.water?.level ?? -Infinity;
      for (let x = world.terrain.size * 0.3; x > 100 && !start; x -= 30) {
        for (let z = 100; z < world.terrain.size * 0.4; z += 30) {
          if (isSpawnable(world.terrain, water, x, z) && isSpawnable(world.terrain, water, x + 4, z)) {
            start = { x, z };
            break;
          }
        }
      }
      assert.ok(start, `test spawn for ${location}`);
      const a = await connectToTrip(location, 'Alice', undefined, start);
      const b = await connectToTrip(location, 'Bob', a.room.roomId, { x: start.x + 4, z: start.z });
      try {
        let seenA: RemotePlayer[] = [],
          seenB: RemotePlayer[] = [];
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
        let roster: RemotePlayer[] = [];
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
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
});
