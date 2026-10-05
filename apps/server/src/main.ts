import { defineRoom, defineServer } from 'colyseus';

import { loadConfig } from './config/configuration.ts';
import { TripRoom } from './modules/trip/trip.room.ts';

const config = loadConfig();

/**
 * A room server, not a REST API. There used to be a CORS middleware here with an
 * ALLOWED_ORIGIN knob, and it did nothing: Colyseus installs its own permissive
 * CORS after anything the `express` hook adds and reflects whatever Origin asks,
 * so `curl -H 'Origin: http://evil.example'` came back with that origin allowed.
 * It is gone rather than rewritten, because an origin check cannot be made to
 * hold here anyway — the WebSocket upgrade never passes through express, and a
 * client that is not a browser ignores CORS entirely. Abuse of the matchmaking
 * endpoint is a rate limit at the edge, not a header.
 */
const server = defineServer({
  rooms: {
    trip: defineRoom(TripRoom),
  },
  express: (app) => {
    app.get('/health', (_request: unknown, response: { json: (body: unknown) => void }) => {
      response.json({ ok: true, nodeEnv: config.nodeEnv });
    });
  },
});

server.listen(config.port);
console.log(`[otrip] phòng du lịch đang nghe ở cổng ${config.port}`);
