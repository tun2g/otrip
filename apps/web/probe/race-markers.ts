/**
 * Does the race kit stand on the ground, clear the road, and cost a handful of
 * draw calls?
 *
 * Three bugs are measurable here and all three were expected. A road is
 * published draped within centimetres of the terrain along part of its length
 * and carried on metres of fill along the rest, so a post placed at the road's
 * own height floats at one end of the leg and sinks at the other — the
 * floating-furniture bug. `sampleAt` returns the centreline at kerb height while
 * the surface mesh crowns it at `y + camber`, so anything laid at the sample's
 * `y` is buried along the middle of the road — the buried-paint bug. And a cone
 * row at every station is up to forty cones, which is forty draw calls unless
 * they are merged into one.
 *
 * So this plans a route at all four destinations, builds the markers against the
 * real terrain, and measures every vertex of the kit against the surface it is
 * supposed to be resting on.
 *
 *   cd apps/web && node --import ./probe/hook.mjs --experimental-strip-types \
 *     probe/race-markers.ts [--only=ta-xua]
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { BufferGeometry, Material, Mesh as MeshType, Object3D, Texture } from 'three';

// The scene modules are written for a bundler, so their relative imports carry
// no extension and Node will not resolve them. Put it back on.
registerHooks({
  resolve: (specifier, context, nextResolve) => {
    if (specifier.startsWith('.') && !/\.[mc]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const extension of ['.ts', '.tsx', '/index.ts']) {
        if (existsSync(base + extension)) return nextResolve(pathToFileURL(base + extension).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const globals = globalThis as unknown as Record<string, unknown>;
globals.self = globalThis;
globals.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
globals.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  // `race-kit` paints a 64 px pennant onto a canvas. Node has no 2D context, so
  // the painter's own `if (!context) return` guard takes over and the sprite
  // carries a blank texture — all this probe needs from it.
  createElement: () => ({ width: 0, height: 0, getContext: () => null }),
};

const { createTerrain, LOCATIONS } = await import('@otrip/world');
const { Mesh, Sprite } = await import('three');
const { resolvePois } = await import('../src/scene/points-of-interest.ts');
const { createRoadNetwork } = await import('../src/scene/road-network.ts');
const { planTown } = await import('../src/scene/town-plan.ts');
const { planRoute } = await import('../src/scene/race-route.ts');
const { createRaceMarkers } = await import('../src/scene/race-markers.ts');
const { buildRaceKit } = await import('../src/scene/race-kit.ts');

const SEGMENTS = 416;
/** `road-network`'s `CAMBER`, which is not exported: the crown of a main road
 *  over its kerb. The surface interpolates linearly between the two. */
const CAMBER_OF: Record<string, number> = { main: 0.07, secondary: 0.056, lane: 0.035, trail: 0 };
/** `race-route`'s `CHECK_MARGIN`, also not exported. */
const CHECK_MARGIN = 2.5;

/** The spawn scatter is `Math.random`; held to one sequence so runs compare. */
const seeded = <T>(build: () => T): T => {
  const real = Math.random;
  let state = 0x2f6e2b1;
  Math.random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  try {
    return build();
  } finally {
    Math.random = real;
  }
};

const fixed = (value: number, places = 2) => value.toFixed(places).padStart(places + 4);

const footOf = (object: Object3D) => {
  object.updateWorldMatrix(true, false);
  const m = object.matrixWorld.elements;
  return { x: m[12], y: m[13], z: m[14] };
};

const only = process.argv.find((value) => value.startsWith('--only='))?.slice(7);
const slugs = ['ta-xua', 'hoi-an', 'trang-an', 'ho-tay'].filter((slug) => !only || slug === only);

for (const slug of slugs) {
  const recipe = LOCATIONS[slug];
  if (!recipe) continue;

  const terrain = createTerrain(recipe, SEGMENTS);
  const plan = seeded(() => planTown(terrain, recipe, 1));
  const pois = resolvePois(terrain, recipe, plan.lots);
  const network = seeded(() => createRoadNetwork(terrain, recipe, pois, plan.lots));
  const route = planRoute(network);

  console.log(`\n=== ${slug} ===`);
  if (!route) {
    console.log('  planRoute returned NULL — no road holds a grid, a leg and a turn.');
    continue;
  }

  const road = network.roads[route.roadIndex];
  const camber = CAMBER_OF[road.kind];
  const carriageHalf = route.stations[0].halfWidth - CHECK_MARGIN;
  console.log(
    `  road #${route.roadIndex} ${road.kind} width=${fixed(road.width)}m total=${fixed(road.totalLength, 1)}m` +
      `  leg=${fixed(route.legLength, 1)}m lap=${fixed(route.lapLength, 1)}m` +
      `  stations=${route.stations.length} checks=${route.checks.length} grid=${route.grid.length}`
  );

  // `nearestAlong` in race-route walks the centreline in XZ while the road's own
  // `cumulative` is 3D arc length, so on a graded road the line is laid short of
  // the parking spot it was aimed at. On a ridge that is worth knowing.
  const points = road.points;
  let flat = 0;
  let solid = 0;
  for (let i = 1; i < points.length / 3; i += 1) {
    flat += Math.hypot(points[i * 3] - points[(i - 1) * 3], points[i * 3 + 2] - points[(i - 1) * 3 + 2]);
    solid += Math.hypot(
      points[i * 3] - points[(i - 1) * 3],
      points[i * 3 + 1] - points[(i - 1) * 3 + 1],
      points[i * 3 + 2] - points[(i - 1) * 3 + 2]
    );
  }
  console.log(
    `  centreline XZ=${fixed(flat, 1)}m vs 3D=${fixed(solid, 1)}m (${fixed((1 - flat / solid) * 100)}% short)`
  );

  // Anything set back along the road from a station rests on that station's own
  // height, which is only right while the road is level. The marshal is the one
  // piece far enough back for the grade to matter.
  const here = { x: 0, y: 0, z: 0, tx: 0, tz: 1, curvature: 0 };
  network.sampleAt(route.roadIndex, route.startAt - 1.6, here);
  const fall = here.y - route.stations[0].y;
  let steepest = 0;
  for (let at = route.startAt; at < route.turnAt; at += 10) {
    const before = network.sampleAt(route.roadIndex, at, here).y;
    const after = network.sampleAt(route.roadIndex, at + 10, here).y;
    steepest = Math.max(steepest, Math.abs(after - before) / 10);
  }
  const first = route.stations[0];
  const terrainFall =
    terrain.heightAt(first.x - first.tx * 1.6, first.z - first.tz * 1.6) - terrain.heightAt(first.x, first.z);
  console.log(
    `  road fall over a setback=${fixed(fall, 3)}m  the terrain under it says=${fixed(terrainFall, 3)}m` +
      `  steepest grade on the leg=${fixed(steepest * 100, 1)}%`
  );

  const markers = createRaceMarkers(route, terrain);
  const group = markers.group;

  let meshes = 0;
  let triangles = 0;
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  group.traverse((object) => {
    if (!(object instanceof Mesh) && !(object instanceof Sprite)) return;
    meshes += 1;
    const material = object.material as Material & { map?: Texture | null };
    if (material) {
      materials.add(material);
      if (material.map) textures.add(material.map);
    }
    // A Sprite's geometry is three's own module-level singleton, shared by every
    // sprite in the process and not the module's to dispose, so it is left out of
    // both the triangle count and the disposal ledger.
    if (object instanceof Sprite) return;
    const geometry = (object as MeshType).geometry as BufferGeometry | undefined;
    if (!geometry) return;
    geometries.add(geometry);
    const index = geometry.getIndex();
    triangles += (index ? index.count : (geometry.getAttribute('position')?.count ?? 0)) / 3;
  });
  console.log(
    `  draw calls=${meshes} triangles=${Math.round(triangles)} geometries=${geometries.size}` +
      ` materials=${materials.size} textures=${textures.size}`
  );

  /** The published surface under a point: the carriageway's camber profile while
   *  the point is between the kerbs of a station, the raw terrain beyond them. */
  const restingAt = (x: number, z: number) => {
    let near = Infinity;
    let across = Infinity;
    let kerb = 0;
    for (const station of route.stations) {
      const dx = x - station.x;
      const dz = z - station.z;
      const along = Math.abs(dx * station.tx + dz * station.tz);
      if (along >= near) continue;
      near = along;
      across = Math.abs(-dx * station.tz + dz * station.tx);
      kerb = station.y;
    }
    // A station's height is the road's height only at that station's own
    // cross-section, so vertices further along than this are left to the
    // dedicated measurements below rather than judged against the wrong one.
    if (near > 1.2) return { y: NaN, road: false };
    if (across > carriageHalf) return { y: terrain.heightAt(x, z), road: false };
    return { y: kerb + camber * (1 - across / carriageHalf), road: true };
  };

  // Every vertex of the merged kit — the cones, the line posts, the turn mast and
  // the marshal — against whatever it is standing on. Only the vertices that are
  // meant to be touching it: a cone's reflective band is 0.3 m up and its tip
  // half a metre, both on purpose.
  const stand = group.getObjectByName('kit') as MeshType | undefined;
  const position = stand?.geometry.getAttribute('position');
  const FOOT = 0.08;
  const worst = { road: { below: 0, above: 0, count: 0 }, ground: { below: 0, above: 0, count: 0 } };
  let relief = 0;
  for (let i = 0; position && i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const resting = restingAt(x, z);
    if (!(Math.abs(y - resting.y) <= FOOT)) continue;
    const bucket = resting.road ? worst.road : worst.ground;
    bucket.count += 1;
    bucket.below = Math.max(bucket.below, resting.y - y);
    bucket.above = Math.max(bucket.above, y - resting.y);
    // A flat base on a slope necessarily cuts in uphill and lifts downhill, so
    // the relief across half a metre of ground is the floor on any such error.
    relief = Math.max(relief, Math.abs(terrain.heightAt(x + 0.5, z) - terrain.heightAt(x - 0.5, z)));
  }
  console.log(
    `  on the road   (${worst.road.count} vertices): worst below the crown=${fixed(worst.road.below, 3)}m` +
      ` above=${fixed(worst.road.above, 3)}m`
  );
  console.log(
    `  on the ground (${worst.ground.count} vertices): worst below=${fixed(worst.ground.below, 3)}m` +
      ` above=${fixed(worst.ground.above, 3)}m, terrain relief across a 1 m base=${fixed(relief, 3)}m`
  );

  // The one piece that moves between stations. Its foot has to be on the ground
  // at every one of them, and its tip has to clear the road from there however
  // much fill the road is carried on.
  const flag = group.getObjectByName('flag');
  const mast = flag?.children[0] as unknown as { scale: { y: number } } | undefined;
  let worstFoot = 0;
  let worstFootAt = -1;
  let lowestTip = Infinity;
  for (let station = 0; station < route.stations.length; station += 1) {
    const check = route.checks.findIndex((entry) => entry.station === station);
    markers.setTarget(check < 0 ? 0 : check);
    if (!flag || !mast) continue;
    const foot = footOf(flag);
    const error = Math.abs(foot.y - terrain.heightAt(foot.x, foot.z));
    if (error >= worstFoot) {
      worstFoot = error;
      worstFootAt = station;
    }
    lowestTip = Math.min(lowestTip, foot.y + mast.scale.y - route.stations[station].y);
  }
  console.log(
    `  flag: worst foot off the ground=${fixed(worstFoot, 4)}m (station ${worstFootAt})` +
      `  lowest tip over the carriageway=${fixed(lowestTip)}m`
  );

  // Each piece against the road it is standing beside. The two kerbside pieces
  // have to be level with it; the two poles on the verge are wherever the ground
  // put them, which is what their lengths are for.
  const kit = buildRaceKit(route, terrain);
  // The marshal is 3 m behind the line, so the road under their feet is the one
  // `sampleAt` reports there, not the line's own.
  network.sampleAt(route.roadIndex, route.startAt - 1.6, here);
  const marshalFoot = kit.marshalAt.y - 2.8 * 0.64 - here.y;
  console.log(
    `  against the road: marshal=${fixed(marshalFoot, 3)}m post=${fixed(kit.ribbonAt.y - 1.15 - first.y, 3)}m` +
      `  on the verge: turn mast=${fixed(kit.turnAt.y - route.stations[route.stations.length - 1].y, 2)}m` +
      ` flag=${fixed(kit.flagsAt[0].y - first.y, 2)}m`
  );

  markers.setPhase('idle');
  const hidden = group.visible === false;
  markers.setPhase('grid');
  const shown = group.visible === true;
  const viewer = { x: route.stations[0].x + 300, z: route.stations[0].z };

  /** The brightest the additive beam and the pennant ever get: over four seconds
   *  of their own pulse, at every range from standing on the line to a kilometre
   *  and a half away, which is where both windows have closed again. */
  const peaks = (night: number) => {
    markers.setNight(night);
    let beam = 0;
    let pennant = 0;
    for (let step = 0; step < 240; step += 1) {
      for (let range = 0; range <= 1500; range += 25) {
        markers.update(step / 30, { x: route.stations[0].x + range, z: route.stations[0].z });
        for (const name of ['flag-beam', 'turn-beam', 'pennant']) {
          const child = group.getObjectByName(name) as unknown as { material?: { opacity?: number } } | undefined;
          const opacity = child?.material?.opacity ?? 0;
          if (name === 'pennant') pennant = Math.max(pennant, opacity);
          else beam = Math.max(beam, opacity);
        }
      }
    }
    return { beam, pennant };
  };
  const day = peaks(0);
  const dark = peaks(1);
  console.log(
    `  visible: idle=${hidden ? 'hidden' : 'SHOWN'} grid=${shown ? 'shown' : 'HIDDEN'}` +
      `  beam day=${fixed(day.beam, 3)} night=${fixed(dark.beam, 3)}` +
      `  pennant day=${fixed(day.pennant, 3)} night=${fixed(dark.pennant, 3)}`
  );

  const rollOf = (name: string) => (group.getObjectByName(name) as unknown as { rotation: { z: number } }).rotation.z;
  markers.setPhase('countdown');
  markers.setCountdown(0);
  markers.update(20, viewer);
  const flagDown = rollOf('starter');
  for (let step = 1; step < 90; step += 1) {
    markers.setCountdown(step / 89);
    markers.update(20 + step / 30, viewer);
  }
  const flagUp = rollOf('starter');
  const ribbonTaut = rollOf('ribbon');
  markers.setPhase('running');
  for (let step = 0; step < 120; step += 1) markers.update(23 + step / 30, viewer);
  console.log(
    `  starter arm ${fixed(flagDown)} → ${fixed(flagUp)} rad, swept to ${fixed(rollOf('starter'))}` +
      `  ribbon taut=${fixed(ribbonTaut)} unhooked=${fixed(rollOf('ribbon'))} rad`
  );

  // Every geometry, material and texture the module made has to fire its own
  // dispose event. Three dispatches one, so the count is the module's answer and
  // not this probe's opinion of it.
  let released = 0;
  const made = geometries.size + materials.size + textures.size;
  for (const resource of [...geometries, ...materials, ...textures]) {
    const emitter = resource as unknown as { addEventListener: (type: string, fn: () => void) => void };
    emitter.addEventListener('dispose', () => {
      released += 1;
    });
  }
  markers.dispose();
  console.log(`  dispose: ${released}/${made} released, group now holds ${group.children.length} children`);

  network.dispose();
}

/**
 * All four destinations pick a 7 m main road, so the narrow branch above never
 * runs — the one that decides whether a cone row shuts the only road at a
 * destination whose longest road is a lane or a trail. It is the difference
 * between a race and a roadblock, so it is exercised here against a hand-made
 * 0.95 m trail on flat ground.
 */
const narrow = buildRaceKit(
  {
    stations: [
      { x: 0, y: 0.5, z: 0, tx: 0, tz: 1, halfWidth: 0.95 / 2 + CHECK_MARGIN },
      { x: 0, y: 0.5, z: 200, tx: 0, tz: 1, halfWidth: 0.95 / 2 + CHECK_MARGIN },
    ],
  } as unknown as Parameters<typeof buildRaceKit>[0],
  { heightAt: () => 0 } as unknown as Parameters<typeof buildRaceKit>[1]
);
const trailPosition = narrow.stand?.getAttribute('position');
let gate = Infinity;
for (let i = 0; trailPosition && i < trailPosition.count; i += 1) {
  if (trailPosition.getY(i) > 0.08) continue;
  gate = Math.min(gate, Math.abs(trailPosition.getX(i)));
}
console.log(`\n=== a 0.95 m trail ===\n  clear road left between the cone row: ${fixed(gate * 2)}m (a Wave is 0.72 m)`);
for (const geometry of [narrow.stand, narrow.ribbon, narrow.starter, narrow.mast, narrow.cloth]) geometry?.dispose();
