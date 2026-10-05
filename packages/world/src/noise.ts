import { createNoise2D, createNoise4D, type NoiseFunction2D, type NoiseFunction4D } from 'simplex-noise';

import { createPrng } from './prng.ts';

export type FbmOptions = {
  octaves: number;
  frequency: number;
  lacunarity: number;
  gain: number;
};

export const createNoise = (seed: string): NoiseFunction2D => createNoise2D(createPrng(seed));

export const createNoise4 = (seed: string): NoiseFunction4D => createNoise4D(createPrng(seed));

export const fbm2d = (noise: NoiseFunction2D, x: number, y: number, options: FbmOptions): number => {
  const { octaves, frequency, lacunarity, gain } = options;
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let f = frequency;

  for (let i = 0; i < octaves; i += 1) {
    sum += noise(x * f, y * f) * amplitude;
    total += amplitude;
    amplitude *= gain;
    f *= lacunarity;
  }

  return total === 0 ? 0 : sum / total;
};

/**
 * Ridged multifractal: folding the noise around zero turns smooth hills into
 * the sharp crests a mountain range needs. Returns 0..1, where 1 is a ridge.
 */
export const ridged2d = (noise: NoiseFunction2D, x: number, y: number, options: FbmOptions): number => {
  const { octaves, frequency, lacunarity, gain } = options;
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let f = frequency;

  for (let i = 0; i < octaves; i += 1) {
    const ridge = 1 - Math.abs(noise(x * f, y * f));
    sum += ridge * ridge * amplitude;
    total += amplitude;
    amplitude *= gain;
    f *= lacunarity;
  }

  return total === 0 ? 0 : sum / total;
};

const TAU = Math.PI * 2;

/**
 * Seamlessly tileable fBm: walking a 2-torus through 4D noise means the pattern
 * wraps exactly, so a drifting cloud texture never shows a seam. Here
 * `frequency` reads as "features across one tile".
 */
export const tileableFbm = (noise: NoiseFunction4D, u: number, v: number, options: FbmOptions): number => {
  const { octaves, frequency, lacunarity, gain } = options;
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let radius = frequency;

  for (let i = 0; i < octaves; i += 1) {
    sum +=
      noise(
        Math.cos(u * TAU) * radius,
        Math.sin(u * TAU) * radius,
        Math.cos(v * TAU) * radius,
        Math.sin(v * TAU) * radius
      ) * amplitude;
    total += amplitude;
    amplitude *= gain;
    radius *= lacunarity;
  }

  return total === 0 ? 0 : sum / total;
};
