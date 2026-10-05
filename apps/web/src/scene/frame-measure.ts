/**
 * Turning "it looks washed out" into numbers.
 *
 * The complaint this exists to settle is about chroma, and chroma is the one
 * thing a screenshot argument cannot establish: a frame can be bright, have a
 * wide luminance range and still be nearly greyscale, which is exactly the
 * failure that went unnoticed for weeks. So the finish is measured the way the
 * reference it is judged against was measured — per band, in hue and saturation
 * as well as luminance — and the numbers are read off the presented frame, after
 * tone mapping and after the output transform, because that is the image a
 * person actually sees.
 */

/** Rec. 709 luma, 0..255. The same weighting the present pass uses. */
export const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export type BandStats = {
  name: string;
  hex: string;
  /** Rec. 709 luma, 0..255. */
  luma: number;
  /** HSL hue in degrees; meaningless once saturation is near zero. */
  hue: number;
  /** HSL saturation, percent. The number the washed-out complaint is about. */
  saturation: number;
  /** Mean distance to the surface in this band, in metres. Says what the band is. */
  metres: number;
  /** Linear-light channel ratio normalised to red, as the reference was read. */
  ratio: string;
};

export type FrameStats = {
  bands: BandStats[];
  /** Luma percentiles over the whole frame, 0..255. */
  percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number; max: number };
  /** Percent of pixels with every channel at zero. The night failure, measured. */
  pureBlack: number;
  /** Mean saturation over the whole frame, percent. */
  saturation: number;
};

/** Where to read, as a fraction of frame height from the bottom. */
const BANDS: { name: string; at: number }[] = [
  { name: 'sky top', at: 0.9 },
  { name: 'sky horizon', at: 0.62 },
  { name: 'far ridge', at: 0.46 },
  { name: 'mid ground', at: 0.26 },
  { name: 'near ground', at: 0.08 },
];

/** Half-height of a band, in rows. Averaging a strip beats trusting one pixel. */
const BAND_ROWS = 3;

const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;

/** Standard HSL, on 0..255 input. Hue in degrees, saturation in percent. */
const hsl = (r: number, g: number, b: number): { hue: number; saturation: number } => {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const span = max - min;
  const lightness = (max + min) / 2;

  if (span < 1e-6) return { hue: 0, saturation: 0 };

  const saturation = span / (1 - Math.abs(2 * lightness - 1));

  let hue: number;
  if (max === red) hue = ((green - blue) / span + (green < blue ? 6 : 0)) / 6;
  else if (max === green) hue = ((blue - red) / span + 2) / 6;
  else hue = ((red - green) / span + 4) / 6;

  return { hue: hue * 360, saturation: Math.min(1, saturation) * 100 };
};

/** sRGB transfer, inverted. The reference's 1 : 2.3 : 4.9 is a linear ratio. */
const toLinear = (value: number): number => {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const ratioOf = (r: number, g: number, b: number): string => {
  const base = Math.max(toLinear(r), 1e-5);
  return `1 : ${(toLinear(g) / base).toFixed(2)} : ${(toLinear(b) / base).toFixed(2)}`;
};

/**
 * @param pixels RGBA of the presented frame, rows bottom-up as WebGL reads them.
 * @param depth the same frame rendered as distance, red channel scaled to `range`.
 * @param range what a full red channel means in `depth`, in metres.
 */
export const measureFrame = (
  pixels: Uint8Array,
  depth: Uint8Array,
  width: number,
  height: number,
  range: number
): FrameStats => {
  const bands = BANDS.map(({ name, at }) => {
    const centre = Math.round(height * at);
    let r = 0;
    let g = 0;
    let b = 0;
    let metres = 0;
    let n = 0;

    for (let y = centre - BAND_ROWS; y <= centre + BAND_ROWS; y += 1) {
      if (y < 0 || y >= height) continue;
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        r += pixels[i];
        g += pixels[i + 1];
        b += pixels[i + 2];
        metres += (depth[i] / 255) * range;
        n += 1;
      }
    }

    const mean = [r / n, g / n, b / n] as const;
    const { hue, saturation } = hsl(mean[0], mean[1], mean[2]);
    return {
      name,
      hex: hex(mean[0], mean[1], mean[2]),
      luma: luma(mean[0], mean[1], mean[2]),
      hue,
      saturation,
      metres: metres / n,
      ratio: ratioOf(mean[0], mean[1], mean[2]),
    };
  });

  // A full-resolution canvas is millions of pixels and sorting all of them
  // stalls the tab long enough for the driving tool to give up. Every statistic
  // here is a distribution, so a regular sample of a few hundred thousand says
  // the same thing to a tenth of a percent.
  const count = width * height;
  const stride = Math.max(1, Math.floor(count / 400_000));
  const values: number[] = [];
  let pureBlack = 0;
  let saturationTotal = 0;

  for (let i = 0; i < count; i += stride) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    values.push(luma(r, g, b));
    if (r === 0 && g === 0 && b === 0) pureBlack += 1;
    saturationTotal += hsl(r, g, b).saturation;
  }

  const sorted = values.sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))];

  return {
    bands,
    percentiles: { p5: at(0.05), p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95), max: at(1) },
    pureBlack: (pureBlack / sorted.length) * 100,
    saturation: saturationTotal / sorted.length,
  };
};

/** A fixed-width table, because these numbers are read side by side or not at all. */
export const formatFrameStats = (stats: FrameStats, heading: string): string => {
  const lines = [heading];
  lines.push('band          hex      L      hue    sat     dist      linear r:g:b');
  for (const band of stats.bands) {
    lines.push(
      `${band.name.padEnd(13)} ${band.hex}  ${band.luma.toFixed(1).padStart(5)}  ` +
        `${band.hue.toFixed(1).padStart(5)}  ${band.saturation.toFixed(1).padStart(5)}%  ` +
        `${band.metres.toFixed(0).padStart(6)}m  ${band.ratio}`
    );
  }
  const p = stats.percentiles;
  lines.push(
    `luma p5=${p.p5.toFixed(1)} p25=${p.p25.toFixed(1)} p50=${p.p50.toFixed(1)} ` +
      `p75=${p.p75.toFixed(1)} p95=${p.p95.toFixed(1)} max=${p.max.toFixed(1)}`
  );
  lines.push(`pure black ${stats.pureBlack.toFixed(1)}%   frame saturation ${stats.saturation.toFixed(1)}%`);
  return lines.join('\n');
};
