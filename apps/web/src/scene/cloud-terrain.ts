import type { Terrain } from '@otrip/world';
import { ClampToEdgeWrapping, DataTexture, LinearFilter, RGBAFormat } from 'three';

/**
 * What a cloud sea needs to know about the land under it. Three things, and all
 * three have to come out of the heightfield rather than out of a constant: how
 * high to float so the ridges come through as islands, where the ground is so
 * the cloud can pool and fade against it, and which passes on the ridge sit low
 * enough for the sea to pour over.
 */

const QUANTILE_STOPS = 129;
const HISTOGRAM_BINS = 2048;
/** Directions probed around a candidate when deciding whether it is a pass. */
const RING = 12;

export type CloudSaddle = {
  /** World metres. */
  x: number;
  z: number;
  /** Ground height at the lip of the pass. */
  height: number;
  /** Unit vector down the emptier side — the way the cloud falls. */
  spillX: number;
  spillZ: number;
  /** Metres the ground drops below the lip on that side. */
  drop: number;
  /** How far down the slope the fall carries before it has gone. */
  reach: number;
  /** Half-width of the gap in the ridge, metres. */
  width: number;
};

export type CloudTerrain = {
  /** The heightfield as a texture, for the shader to find its own shoreline. */
  texture: DataTexture;
  minHeight: number;
  heightRange: number;
  /** Altitude at which `fraction` of the land lies submerged. */
  levelForSubmerged: (fraction: number) => number;
  /** The inverse: how much of the land lies below an altitude. */
  submergedAt: (height: number) => number;
  /**
   * The share of the land the sea covers in average weather — the recipe's
   * wished-for altitude, read as a fraction of *this* heightfield and kept
   * inside a band that always leaves summits out and valleys in.
   */
  restingSubmerged: number;
  saddles: CloudSaddle[];
  dispose: () => void;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * The height distribution, as a table of quantiles. A histogram rather than a
 * sort because the heightfield runs to a third of a million samples and only
 * metre-scale precision is wanted back.
 */
const buildQuantiles = (heights: Float32Array): { quantiles: Float32Array; min: number; range: number } => {
  let min = Infinity;
  let max = -Infinity;
  for (const height of heights) {
    if (height < min) min = height;
    if (height > max) max = height;
  }
  const range = Math.max(1, max - min);

  const histogram = new Uint32Array(HISTOGRAM_BINS);
  for (const height of heights) {
    const bin = Math.min(HISTOGRAM_BINS - 1, Math.floor(((height - min) / range) * HISTOGRAM_BINS));
    histogram[bin] += 1;
  }

  const quantiles = new Float32Array(QUANTILE_STOPS);
  let cumulative = 0;
  let bin = 0;
  for (let stop = 0; stop < QUANTILE_STOPS; stop += 1) {
    const wanted = (stop / (QUANTILE_STOPS - 1)) * heights.length;
    while (bin < HISTOGRAM_BINS - 1 && cumulative + histogram[bin] < wanted) {
      cumulative += histogram[bin];
      bin += 1;
    }
    // Interpolating inside the bin matters: a wide flat valley floor puts tens
    // of thousands of samples in one bin, and without this every quantile
    // through it collapses onto the same altitude.
    const within = histogram[bin] > 0 ? clamp01((wanted - cumulative) / histogram[bin]) : 0;
    quantiles[stop] = min + ((bin + within) / HISTOGRAM_BINS) * range;
  }

  return { quantiles, min, range };
};

const readQuantile = (quantiles: Float32Array, fraction: number): number => {
  const at = clamp01(fraction) * (quantiles.length - 1);
  const stop = Math.min(quantiles.length - 2, Math.floor(at));
  return quantiles[stop] + (quantiles[stop + 1] - quantiles[stop]) * (at - stop);
};

const readFraction = (quantiles: Float32Array, height: number): number => {
  const last = quantiles.length - 1;
  if (height <= quantiles[0]) return 0;
  if (height >= quantiles[last]) return 1;

  let stop = 0;
  while (stop < last - 1 && quantiles[stop + 1] < height) stop += 1;
  const span = quantiles[stop + 1] - quantiles[stop];
  return (stop + (span > 0 ? (height - quantiles[stop]) / span : 0)) / last;
};

/**
 * Stored as 8-bit normalised rather than float, because linear filtering of
 * float textures is not universally available and a metre of precision is finer
 * than a cloud shoreline needs. `water.ts` builds the same thing for its own
 * shoreline; if a third module wants it, this is the copy to share.
 */
const createHeightTexture = (terrain: Terrain, min: number, range: number): DataTexture => {
  const side = terrain.segments + 1;
  const data = new Uint8Array(side * side * 4);

  for (let i = 0; i < terrain.heights.length; i += 1) {
    data[i * 4] = Math.round(clamp01((terrain.heights[i] - min) / range) * 255);
    data[i * 4 + 3] = 255;
  }

  const texture = new DataTexture(data, side, side, RGBAFormat);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return texture;
};

/**
 * Thác mây starts at a pass, so the passes have to be found. A pass is a point
 * that climbs on two opposite sides — the ridge carrying on through it — and
 * falls away on the other two. A summit climbs nowhere, a valley floor falls
 * nowhere, and an ordinary hillside only climbs on one side, so that one test
 * separates passes from everything else on the mountain.
 */
const findSaddles = (terrain: Terrain, quantiles: Float32Array, resting: number, limit: number): CloudSaddle[] => {
  if (limit <= 0) return [];

  const radius = Math.min(terrain.size * 0.075, 340);
  const riseMin = terrain.maxHeight * 0.045;
  const dropMin = terrain.maxHeight * 0.05;
  const reliefMin = terrain.maxHeight * 0.08;
  const lip = terrain.maxHeight * 0.035;
  // Passes above this are never under the sea and ones below it are never out
  // of it, so neither can ever be seen to overflow.
  const lowest = readQuantile(quantiles, 0.25);
  const highest = readQuantile(quantiles, 0.9);

  const dirX = new Float64Array(RING);
  const dirZ = new Float64Array(RING);
  for (let k = 0; k < RING; k += 1) {
    const angle = (k / RING) * Math.PI * 2;
    dirX[k] = Math.cos(angle);
    dirZ[k] = Math.sin(angle);
  }

  const delta = new Float64Array(RING);
  const found: (CloudSaddle & { score: number })[] = [];

  const step = Math.max(radius * 0.22, terrain.size / 240);
  // Keep clear of the patch border: the edge falloff that sinks the rim reads
  // as a ring of perfect passes, and every one of them is an artefact.
  const edge = terrain.size / 2 - radius * 2.6;

  for (let z = -edge; z <= edge; z += step) {
    for (let x = -edge; x <= edge; x += step) {
      const height = terrain.heightAt(x, z);
      if (height < lowest || height > highest) continue;

      let rise = -Infinity;
      let fall = Infinity;
      let riseK = 0;
      let fallK = 0;
      for (let k = 0; k < RING; k += 1) {
        const d = terrain.heightAt(x + dirX[k] * radius, z + dirZ[k] * radius) - height;
        delta[k] = d;
        if (d > rise) {
          rise = d;
          riseK = k;
        }
        if (d < fall) {
          fall = d;
          fallK = k;
        }
      }

      if (rise < riseMin || delta[(riseK + RING / 2) % RING] < riseMin * 0.45) continue;
      if (fall > -dropMin || delta[(fallK + RING / 2) % RING] > -dropMin * 0.45) continue;

      const spillX = dirX[fallK];
      const spillZ = dirZ[fallK];
      const drop =
        height -
        Math.min(
          terrain.heightAt(x + spillX * radius * 2.2, z + spillZ * radius * 2.2),
          terrain.heightAt(x + spillX * radius * 3.6, z + spillZ * radius * 3.6)
        );
      if (drop < reliefMin) continue;

      // The gap is only as wide as the ridge allows: walk the ridge axis both
      // ways until the ground climbs clear of the lip again.
      const ridgeX = -spillZ;
      const ridgeZ = spillX;
      let width = 650;
      for (const side of [1, -1]) {
        let reach = 60;
        while (reach < 650 && terrain.heightAt(x + ridgeX * side * reach, z + ridgeZ * side * reach) < height + lip) {
          reach += 45;
        }
        width = Math.min(width, reach);
      }

      found.push({
        x,
        z,
        height,
        spillX,
        spillZ,
        drop,
        reach: Math.min(900, Math.max(280, drop * 2.6)),
        // The fall concentrates on the low line of the gap rather than filling
        // it wall to wall, so the curtain is narrower than the saddle is.
        width: Math.min(260, width * 0.55),
        // A deep wide pass is worth more, but a pass the sea never reaches is
        // worth nothing at all, so closeness to where the deck rests counts
        // for as much as the drop does. Without this the search picks the
        // highest cols on the mountain and the falls only run in a downpour.
        score: (drop * Math.sqrt(width)) / (1 + Math.abs(height - resting) / 110),
      });
    }
  }

  found.sort((a, b) => b.score - a.score);

  const chosen: CloudSaddle[] = [];
  const separation = radius * 2.4;
  for (const candidate of found) {
    if (chosen.some((taken) => Math.hypot(taken.x - candidate.x, taken.z - candidate.z) < separation)) continue;
    chosen.push({
      x: candidate.x,
      z: candidate.z,
      height: candidate.height,
      spillX: candidate.spillX,
      spillZ: candidate.spillZ,
      drop: candidate.drop,
      reach: candidate.reach,
      width: candidate.width,
    });
    if (chosen.length >= limit) break;
  }

  return chosen;
};

/**
 * @param nominalAltitude the recipe's wished-for deck altitude, in the same
 * metres as the terrain. Only used to decide where the deck rests on this
 * heightfield; the metres themselves come back out of the distribution.
 */
export const analyseCloudTerrain = (terrain: Terrain, nominalAltitude: number, maxSaddles: number): CloudTerrain => {
  const { quantiles, min, range } = buildQuantiles(terrain.heights);
  const texture = createHeightTexture(terrain, min, range);

  const restingSubmerged = Math.min(0.72, Math.max(0.34, readFraction(quantiles, nominalAltitude)));

  return {
    texture,
    minHeight: min,
    heightRange: range,
    levelForSubmerged: (fraction) => readQuantile(quantiles, fraction),
    submergedAt: (height) => readFraction(quantiles, height),
    restingSubmerged,
    saddles: findSaddles(terrain, quantiles, readQuantile(quantiles, restingSubmerged), maxSaddles),
    dispose: () => texture.dispose(),
  };
};
