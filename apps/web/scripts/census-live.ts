/**
 * The live half of the census: is the scene actually drawing, and what does one
 * frame cost.
 *
 * Three things here were learned the hard way and are the whole reason this is a
 * committed script rather than a scratch file somebody rewrites next time.
 *
 * 1. **`canvas.width > 400` does not mean the scene is running.** `scene-canvas.tsx`
 *    renders the `<canvas>` unconditionally at `absolute inset-0 h-full w-full`
 *    and only swaps a status flag, so when the renderer's dynamic import throws
 *    the element is still there at full size with a grey card over it. The page
 *    returns HTTP 200, the HTML is normal, the canvas measures 1280 — every
 *    signal short of reading the DOM says the scene is fine. So the check here is
 *    positive: wrap the GL draw calls and require that the page actually issued
 *    some. A frame that drew nothing is the failure, however the page looks, and
 *    it keeps working when somebody rewords the Vietnamese on the card.
 *
 * 2. **`agent-browser eval` runs in an isolated world.** It shares the DOM but has
 *    its own copies of every built-in prototype, so patching
 *    `WebGL2RenderingContext.prototype.drawElements` there instruments nothing,
 *    and `requestAnimationFrame` registered there never fires. Both read as a flat
 *    zero. Everything below goes through CDP `Runtime.evaluate`, which lands in
 *    the page's own context.
 *
 * 3. **Compiling is not linking and linking is not drawing.** Programs are checked
 *    where they are bound for a draw, which is the only set that matters.
 *
 *   node --experimental-strip-types scripts/scene-census.ts --live=9222
 *
 * The port is the CDP endpoint of a browser already showing the app —
 * `agent-browser get cdp-url --session <name>` prints it, and the number in it is
 * what to pass. Nothing here starts or stops a browser.
 */

/**
 * Frames dropped before any of it counts. The scene is built in one synchronous
 * go — measured at 1.0 to 1.3 s on an M2 Pro — and charging that to the frame
 * budget reports a 60 fps scene as a 1 fps one.
 */
const WARMUP = 40;

/**
 * How much longer to wait for a first publishable sample before calling it dead.
 * The probe needs WARMUP + 10 frames, which is under a second at 60 Hz and never
 * arrives at all if the render loop is not running — so this separates a short
 * sample from a scene that never started.
 */
const WARMING_GRACE = 15_000;

/** Wrapped GL counters plus a rAF sampler, as the page's own script. */
const PROBE = `(() => {
  if (window.__glCensus) { window.__glCensus.reset(); return 'reset'; }

  const out = document.createElement('pre');
  out.id = '__glout';
  out.style.display = 'none';
  document.documentElement.appendChild(out);

  const proto = WebGL2RenderingContext.prototype;
  const state = { draws: 0, instances: 0, triangles: 0, first: 0, last: 0, frames: [], seen: new Set(), created: new Set(), failed: [] };

  const TRIANGLES = 4, STRIP = 5, FAN = 6;
  const tris = (mode, count) =>
    mode === TRIANGLES ? count / 3 : mode === STRIP || mode === FAN ? Math.max(0, count - 2) : 0;

  const wrap = (name, countAt, instanceAt) => {
    const original = proto[name];
    if (!original) return;
    proto[name] = function (...args) {
      // Wall clock at the first and last draw of the frame. Their difference is
      // the main thread's own cost of issuing the frame, which — unlike the rAF
      // interval — is not rounded to the compositor's cadence.
      const now = performance.now();
      if (state.draws === 0) state.first = now;
      state.last = now;
      state.draws += 1;
      const copies = instanceAt === undefined ? 1 : (args[instanceAt] ?? 1);
      if (instanceAt !== undefined) state.instances += copies;
      state.triangles += tris(args[0], args[countAt] ?? 0) * copies;
      return original.apply(this, args);
    };
  };
  wrap('drawArrays', 2);
  wrap('drawElements', 1);
  wrap('drawArraysInstanced', 2, 3);
  wrap('drawElementsInstanced', 1, 4);
  wrap('drawRangeElements', 3);

  const createProgram = proto.createProgram;
  proto.createProgram = function (...args) {
    const program = createProgram.apply(this, args);
    if (program) state.created.add(program);
    return program;
  };

  const useProgram = proto.useProgram;
  proto.useProgram = function (program) {
    if (program && !state.seen.has(program)) {
      state.seen.add(program);
      try {
        if (!this.getProgramParameter(program, this.LINK_STATUS)) {
          const shaders = this.getAttachedShaders(program) || [];
          state.failed.push({
            log: (this.getProgramInfoLog(program) || 'link failed, empty log').slice(0, 400),
            shaders: shaders.map((s) => (this.getShaderInfoLog(s) || '').slice(0, 200)).filter(Boolean),
          });
        }
      } catch (cause) {
        state.failed.push({ log: 'link check threw: ' + String(cause).slice(0, 200), shaders: [] });
      }
    }
    return useProgram.apply(this, arguments);
  };

  const spread = (frames, key) => {
    const values = frames.map((f) => f[key]).sort((a, b) => a - b);
    const at = (q) => values[Math.min(values.length - 1, Math.floor(values.length * q))];
    return { p50: at(0.5), p95: at(0.95), max: values[values.length - 1] };
  };

  const publish = () => {
    const frames = state.frames.slice(${WARMUP});
    if (frames.length < 10) {
      out.textContent = JSON.stringify({ frames: frames.length, warming: true });
      return;
    }
    const ms = spread(frames, 'ms');
    const canvas = document.querySelector('canvas');
    out.textContent = JSON.stringify({
      frames: frames.length,
      ms,
      fps: Math.round(1000 / ms.p50),
      submit: spread(frames, 'submit'),
      draws: spread(frames, 'draws'),
      instances: spread(frames, 'instances'),
      triangles: spread(frames, 'triangles'),
      canvas: canvas ? canvas.width + 'x' + canvas.height : 'none',
      dpr: window.devicePixelRatio,
      programsUsed: state.seen.size,
      programsCreated: state.created.size,
      failed: state.failed,
      // The DOM's own account, for diagnosing a zero rather than gating on it.
      fallback: /chưa xem được cảnh 3D/.test(document.body.innerText),
    });
  };

  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    state.frames.push({
      ms: now - last,
      submit: state.draws > 0 ? state.last - state.first : 0,
      draws: state.draws,
      instances: state.instances,
      triangles: Math.round(state.triangles),
    });
    if (state.frames.length > 1200) state.frames.shift();
    state.draws = 0;
    state.instances = 0;
    state.triangles = 0;
    last = now;
    if (state.frames.length % 20 === 0) publish();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.__glCensus = {
    reset: () => {
      state.frames.length = 0;
      state.failed.length = 0;
      state.seen.clear();
      out.textContent = JSON.stringify({ frames: 0, warming: true });
    },
  };
  out.textContent = JSON.stringify({ frames: 0, warming: true });
  return 'installed';
})()`;

type Spread = { p50: number; p95: number; max: number };

export type FrameReport = {
  frames: number;
  /** rAF interval. Quantised to the compositor's cadence, so read it as a cap. */
  ms?: Spread;
  /** Main-thread milliseconds spent issuing the frame's draw calls. Not quantised. */
  submit?: Spread;
  fps?: number;
  draws?: Spread;
  instances?: Spread;
  triangles?: Spread;
  canvas?: string;
  dpr?: number;
  programsUsed?: number;
  programsCreated?: number;
  failed?: { log: string; shaders: string[] }[];
  fallback?: boolean;
  warming?: boolean;
};

type Viewport = { name: string; width: number; height: number; dpr: number; mobile: boolean };

const VIEWPORTS: Viewport[] = [
  { name: 'desktop', width: 1440, height: 900, dpr: 2, mobile: false },
  { name: 'phone', width: 390, height: 844, dpr: 3, mobile: true },
];

/** A minimal CDP client. One socket, one page, request/response by id. */
const connect = async (port: number) => {
  const targets = (await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())) as {
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = targets.find((target) => target.type === 'page' && target.url.includes('localhost:3000'));
  if (!page) throw new Error(`cổng ${port} không có tab nào đang mở localhost:3000`);

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (cause: Error) => void }>();
  let onLoad = () => {};

  socket.addEventListener('message', (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      error?: { message: string };
      result?: unknown;
    };
    if (message.method === 'Page.loadEventFired') return onLoad();
    if (message.id === undefined) return;
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('không mở được websocket CDP')), { once: true });
  });

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression: string): Promise<unknown> => {
    const result = (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
      exceptionDetails?: unknown;
      result?: { value?: unknown };
    };
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400));
    return result.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  const navigate = async (url: string) => {
    const landed = new Promise<void>((resolve) => {
      onLoad = resolve;
    });
    await send('Page.navigate', { url });
    await landed;
  };

  return { send, evaluate, navigate, close: () => socket.close() };
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Live weather, from the HUD, so a run says what sky it was measured under. */
const HUD_WEATHER = `(() => { const m = document.body.innerText.match(/[^\\n]*°C[^\\n]*/); return m ? m[0].trim() : ''; })()`;

export type LiveOptions = {
  port: number;
  slugs: string[];
  /** Forecast hours to visit, as `?luc=` values. */
  hours: { label: string; value: string }[];
  /** Seconds of frames per run. */
  seconds: number;
};

/**
 * Visits every location at every viewport and hour, and returns the lines the
 * census should treat as failures. Prints as it goes, because a run is minutes
 * long and a table that only appears at the end is a table nobody watches.
 */
export const measureLive = async (options: LiveOptions): Promise<string[]> => {
  const failures: string[] = [];
  const session = await connect(options.port);
  console.log(`\n=== frames · cổng ${options.port} ===`);
  console.log(
    `${'viewport'.padEnd(8)} ${'khi'.padEnd(5)} ${'nơi'.padEnd(9)} ${'canvas'.padEnd(10)} ` +
      `${'Hz'.padStart(3)} ${'gửi50'.padStart(6)} ${'gửi95'.padStart(6)} ${'gửimax'.padStart(7)} ` +
      `${'draws'.padStart(5)} ${'instances'.padStart(9)} ${'triangles'.padStart(10)} ${'prog'.padStart(4)}  link`
  );

  for (const viewport of VIEWPORTS) {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.dpr,
      mobile: viewport.mobile,
    });
    await session.send('Emulation.setTouchEmulationEnabled', {
      enabled: viewport.mobile,
      maxTouchPoints: viewport.mobile ? 5 : 1,
    });
    // The renderer resizes its targets off the new metrics, so let that land before
    // the first navigation at this size: without it the first run of each viewport
    // read as a page with no frames.
    await wait(2000);

    for (const hour of options.hours) {
      for (const slug of options.slugs) {
        const where = `${viewport.name}/${hour.label}/${slug}`;
        await session.navigate(`http://localhost:3000/${slug}?luc=${encodeURIComponent(hour.value)}`);
        // The nature kit, the avatar FBX and the forecast all land before the scene
        // is built, and the build itself is one synchronous second.
        await wait(14_000);

        let report: FrameReport;
        let weather = '';
        try {
          await session.evaluate(PROBE);
          await wait(options.seconds * 1000);
          // Polled until there is something to judge. The probe publishes nothing
          // until it has `WARMUP` + 10 frames, so reading once and finding
          // `warming` means the sample was short — which is not the same claim as
          // "the scene drew nothing", and reporting it as such is the same false
          // confidence as the canvas-width check this replaces.
          const until = Date.now() + WARMING_GRACE;
          do {
            report = JSON.parse(String(await session.evaluate(`document.getElementById('__glout').textContent`)));
            if (!report.warming) break;
            await wait(1000);
          } while (Date.now() < until);

          // A page that was slow to build can still be warming here, and a probe
          // installed before the renderer existed never sees a frame. One reinstall
          // costs a second and turns most of those into a measurement.
          if (report.warming) {
            await session.evaluate(PROBE);
            const retry = Date.now() + WARMING_GRACE;
            do {
              report = JSON.parse(String(await session.evaluate(`document.getElementById('__glout').textContent`)));
              if (!report.warming) break;
              await wait(1000);
            } while (Date.now() < retry);
          }

          // The first sample often contains the scene build — one synchronous
          // second or more, with every shader compiled inside it — which is real
          // but is not a frame cost, and it drags the percentiles by two orders of
          // magnitude. So the window that gets measured is a second sample, taken
          // after a reset.
          if (!report.warming) {
            await session.evaluate(`(window.__glCensus.reset(), 'reset')`);
            await wait(options.seconds * 1000);
            const after = JSON.parse(
              String(await session.evaluate(`document.getElementById('__glout').textContent`))
            ) as FrameReport;
            if (!after.warming) report = after;
          }
          weather = String(await session.evaluate(HUD_WEATHER));
        } catch (cause) {
          failures.push(`${where}: không đo được — ${cause instanceof Error ? cause.message : String(cause)}`);
          console.log(`${viewport.name.padEnd(8)} ${hour.label.padEnd(5)} ${slug.padEnd(9)} — không đo được`);
          continue;
        }

        // The gate. Not the canvas size, not the absence of a Vietnamese sentence:
        // whether the page issued a draw call. Everything else is diagnosis.
        const drew = (report.draws?.p50 ?? 0) > 0;
        if (report.warming) {
          // No frames at all after the grace period. A page whose renderer threw
          // sits exactly here, because the rAF loop that publishes is the scene's.
          failures.push(
            `${where}: không có frame nào sau ${(WARMING_GRACE / 1000).toFixed(0)}s chờ thêm — ` +
              (report.fallback
                ? 'trang đang hiện thẻ fallback, scene không khởi động được'
                : 'trang không hiện fallback, nhưng vòng render không chạy')
          );
        } else if (!drew) {
          failures.push(
            `${where}: canvas ${report.canvas ?? '?'} có ${report.frames} frame nhưng không có lệnh vẽ nào` +
              `${report.fallback ? ' — trang đang hiện thẻ fallback, scene không khởi động được' : ''}`
          );
        }
        for (const failure of report.failed ?? []) {
          failures.push(`${where}: program không link được — ${failure.log}`);
        }

        console.log(
          `${viewport.name.padEnd(8)} ${hour.label.padEnd(5)} ${slug.padEnd(9)} ${(report.canvas ?? '?').padEnd(10)} ` +
            (drew && report.ms
              ? `${String(report.fps).padStart(3)} ${(report.submit?.p50 ?? 0).toFixed(2).padStart(6)} ` +
                `${(report.submit?.p95 ?? 0).toFixed(2).padStart(6)} ${(report.submit?.max ?? 0).toFixed(2).padStart(7)} ` +
                `${String(report.draws?.p50).padStart(5)} ${String(report.instances?.p50).padStart(9)} ` +
                `${(report.triangles?.p50 ?? 0).toLocaleString('en-US').padStart(10)} ` +
                `${String(report.programsUsed).padStart(4)}  ${report.failed?.length === 0 ? 'ok' : `${report.failed?.length} ✗`}`
              : `${report.warming ? 'KHÔNG CÓ FRAME' : 'KHÔNG VẼ GÌ'} ✗${report.fallback ? ' (thẻ fallback)' : ''}  ${weather}`)
        );
      }
    }
  }

  await session.send('Emulation.clearDeviceMetricsOverride');
  session.close();
  return failures;
};
