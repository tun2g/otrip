import type { LocationRecipe } from '@otrip/world';

import { drawOf } from '@/lib/draw';
import { weatherPreset, type WeatherPresetId } from '@/lib/weather-presets';
import type { Capture } from '@/scene/present-pass';

export type PostcardMeta = {
  /**
   * The whole recipe, not a name and a region: the card stamps the score, and
   * naming what the score is a score *of* needs the rest of the recipe. A PNG
   * someone keeps is the worst place to promise a cloud sea that this
   * destination never renders.
   */
  recipe: LocationRecipe;
  when: string;
  /** The real forecast's reading, which only describes the picture when the
   *  sky was not overridden. */
  weather: string;
  /**
   * Which sky was actually rendered. Every preset but `that` paints an hour that
   * never happened, and the caption was being written from the real forecast
   * either way — a storm preset came out of the renderer stamped "Trời quang ·
   * 26°C". The file leaves the app and gets shown to people who cannot ask, so
   * the card has to say which of the two it is.
   */
  preset: WeatherPresetId;
  /**
   * null when no forecast hour is loaded. It used to arrive as `0`, which prints
   * `0/100` — indistinguishable from a measured reading that the morning is
   * hopeless. The neighbouring fields already degrade honestly (`when` falls
   * back to "bây giờ", `weather` to empty), so this one drops out too.
   */
  cloudHunt: number | null;
};

const CAPTION_HEIGHT = 132;
const MARGIN = 48;

/** Trims to fit a width rather than letting the two caption lines overlap. */
const ellipsize = (context: CanvasRenderingContext2D, text: string, room: number): string => {
  if (context.measureText(text).width <= room) return text;
  let kept = text;
  while (kept.length > 1 && context.measureText(`${kept}…`).width > room) kept = kept.slice(0, -1);
  return `${kept.trimEnd()}…`;
};

/**
 * The stamp on the card: what it says it is a picture of, then the brand.
 *
 * The simulated sky is named here rather than beside the place, because the
 * place line is the one `ellipsize` trims — put the admission at the end of it
 * and the first narrow card drops the admission and keeps the storm.
 */
export const postcardMark = (meta: PostcardMeta): string => {
  const preset = weatherPreset(meta.preset);

  return [
    preset.override === null ? null : `trời mô phỏng: ${preset.label}`,
    meta.cloudHunt === null ? null : `${drawOf(meta.recipe).chance} ${meta.cloudHunt}/100`,
    'otrip',
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
};

/**
 * Where and when, and the real reading only while the real sky is the one in
 * the picture: the mark has already named the preset, and keeping "Trời quang ·
 * 26°C" beside it would put the forecast the picture contradicts back on the
 * card. Any part can be empty — there is no weather line before the forecast
 * lands — and an empty one used to leave a dangling separator.
 */
export const postcardPlace = (meta: PostcardMeta): string =>
  [meta.recipe.region, meta.when, weatherPreset(meta.preset).override === null ? meta.weather : '']
    .filter((part) => part.trim().length > 0)
    .join(' · ');

/**
 * Turns a rendered frame into something worth sending someone: the picture with
 * a band under it saying where and when it is. WebGL hands pixels back bottom
 * row first, so the copy walks the rows backwards.
 */
export const composePostcard = (capture: Capture, meta: PostcardMeta): Promise<Blob | null> => {
  const canvas = document.createElement('canvas');
  canvas.width = capture.width;
  canvas.height = capture.height + CAPTION_HEIGHT;

  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);

  const image = context.createImageData(capture.width, capture.height);
  const rowBytes = capture.width * 4;
  for (let row = 0; row < capture.height; row += 1) {
    const from = (capture.height - 1 - row) * rowBytes;
    image.data.set(capture.data.subarray(from, from + rowBytes), row * rowBytes);
  }
  context.putImageData(image, 0, 0);

  context.fillStyle = '#0b1020';
  context.fillRect(0, capture.height, canvas.width, CAPTION_HEIGHT);

  // A hairline under the photograph. Without it the picture bleeds into the band
  // and the whole thing reads as a screenshot with text on it rather than as a
  // card someone made.
  context.fillStyle = '#f2a679';
  context.fillRect(0, capture.height, canvas.width, 3);

  context.textBaseline = 'top';
  context.textAlign = 'left';

  context.fillStyle = '#f2ece2';
  context.font = '600 44px system-ui, sans-serif';
  context.fillText(meta.recipe.name, MARGIN, capture.height + 26);

  // Right first, so the left line knows how much room is left. The score is the
  // one thing on the card that is a claim about the moment rather than a label,
  // so it keeps its width and the place line gives way.
  context.fillStyle = '#f2a679';
  context.font = '600 26px system-ui, sans-serif';
  context.textAlign = 'right';
  const mark = postcardMark(meta);
  context.fillText(mark, canvas.width - MARGIN, capture.height + 80);

  const place = postcardPlace(meta);
  context.textAlign = 'left';
  context.fillStyle = '#b9b3ab';
  context.font = '26px system-ui, sans-serif';
  const room = canvas.width - MARGIN * 3 - context.measureText(mark).width;
  context.fillText(ellipsize(context, place, room), MARGIN, capture.height + 80);

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
};

export const downloadPostcard = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  // In the document and revoked on a later task: a link that was never attached
  // does not fire in Firefox, and revoking in the same task cancels the save
  // before the browser has read the blob.
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 2000);
};
