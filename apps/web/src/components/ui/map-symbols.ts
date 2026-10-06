/**
 * The one symbol vocabulary both maps read.
 *
 * The corner map used to let colour carry the meaning: a pale blue square for a
 * parking slot, an orange disc for a place, a hollow ring for a place not yet
 * found, a coloured disc for a companion. Four marks, one object, four hues —
 * which fails for anyone colour-blind and fails anyway over a relief bitmap that
 * is itself sand, green and blue. The full map meanwhile had its own vocabulary
 * of pictorial glyphs in 20 px chips.
 *
 * The constraint that settles every decision here is the corner map's scale.
 * `Minimap` is 140 px across and the terrains are 3,600–5,200 m square, so a
 * pixel is 26–37 metres and a symbol has nine of them. At that size the features
 * that survive rasterisation are corners on different axes, fill versus no fill,
 * and aspect ratio — `probe/map-symbols.ts` rasterises each of these on the real
 * pixel grid and prints the footprints and the pairwise differences.
 *
 * So the geometry lives here once, as polygons on the unit circle, painted two
 * ways from the same numbers: onto the corner map's canvas, and as SVG for the
 * full map's markers and for both legends.
 */
import { colourFor } from '@/scene/companion-markers';

/**
 * A ride as the maps need it: a live motorbike or boat, not the kerb it stands
 * on. `WorldRenderer.rides()` is the source.
 *
 * The maps used to plot `road-network`'s parking slots instead: 20 of them in
 * rows 0.9 m apart at hoi-an, trang-an and ho-tay, 8 at ta-xua, on which
 * `vehicles.ts` stands **6** bikes (3 at ta-xua) — one per `area`, plus a spare
 * in area 0. So the corner map drew twenty squares for six bikes, four of them
 * inside a tenth of a pixel of each other, and the full map's transport list ran
 * to "Điểm lấy xe máy 20". `probe/transport-points.ts` prints both counts.
 */
export type MapRide = {
  id: string;
  /** The Vietnamese word the board prompt uses: "xe máy", "thuyền". */
  noun: string;
  x: number;
  z: number;
  /** The one the player is on. Not something to go and find. */
  taken: boolean;
  /**
   * True when a walker could reach it on foot: a bike at its stand, a boat made
   * fast to the jetty. False for a boat under way — three of the five boats per
   * lake at the ultra tier, which the maps have no business promising.
   */
  atRest: boolean;
};

/**
 * A closed outline on the unit circle, so one set of numbers serves a canvas
 * path, an SVG polygon and the probe's rasteriser.
 */
export type Outline = readonly (readonly [number, number])[];

/**
 * Corners straight up, down, left and right: nothing else on either map has a
 * point on the vertical axis, and against the triangle it is the only mark whose
 * bottommost row is a point rather than an edge — 2 px against 8.
 */
const DIAMOND: Outline = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * One apex over a flat base, which rasterises to an 8 px bottom row against the
 * diamond's 2 and the disc's 2 — the only horizontal straight edge on the map.
 * Inscribed in the unit circle and then widened to the diamond's full span, so
 * the two rides read as one rank: `cos 30° = 0.866`, so every coordinate is
 * scaled by `1 / 0.866` to open the base to ±1.
 */
const TRIANGLE: Outline = [
  [0, -1.1547],
  [1, 0.5774],
  [-1, 0.5774],
];

/** A ride whose noun this map has no sign for. Square, so it is plainly neither of the two. */
const SQUARE: Outline = [
  [-0.8, -0.8],
  [0.8, -0.8],
  [0.8, 0.8],
  [-0.8, 0.8],
];

const RIDE_OUTLINE: Record<string, Outline> = {
  'xe máy': DIAMOND,
  thuyền: TRIANGLE,
};

export const outlineFor = (noun: string): Outline => RIDE_OUTLINE[noun] ?? SQUARE;

/**
 * Coloured against the ground each ride stands on rather than against the other
 * ride. A motorbike is always on a road, so it keeps the pale blue the old
 * parking square used — the one cool mark in a palette of sand and green. A boat
 * is always on water, which the relief renders down to `#1a2433`, so it takes a
 * warm straw. A second cue, never the first: the shapes carry the meaning.
 */
const RIDE_COLOUR: Record<string, string> = {
  'xe máy': '#8fb8d8',
  thuyền: '#f2d9a0',
};

export const colourForRide = (noun: string): string => RIDE_COLOUR[noun] ?? '#cdd9e6';

/**
 * What the full map's card calls a ride and how it says to board one. Both notes
 * were already on screen — one was the synthetic parking point's `note`, the
 * other the paragraph the card printed for a `shore` — and they move here
 * because they describe the machine, not the kerb or the jetty.
 */
const RIDE_WORDS: Record<string, { title: string; note: string }> = {
  'xe máy': {
    title: 'Xe máy',
    note: 'Xe đỗ bên đường trong thế giới 3D. Đi sát xe rồi nhấn E, hoặc chạm nút tương tác, để lên xe. Không có bước thanh toán.',
  },
  thuyền: {
    title: 'Thuyền',
    note: 'Thuyền buộc ở bến. Đi xuống cầu bến, tới sát thuyền rồi nhấn E hoặc chạm nút tương tác để lên thuyền.',
  },
};

export const wordsForRide = (noun: string): { title: string; note: string } =>
  RIDE_WORDS[noun] ?? { title: noun, note: 'Tới sát rồi nhấn E, hoặc chạm nút tương tác, để lên.' };

/** The dark casing every mark on both maps already wears, so none of them dissolve into the hillside. */
const CASING = 'rgba(11,16,32,0.85)';

/**
 * Half-widths in screen pixels at 140 px, which is the only size the corner map
 * is ever drawn at.
 *
 * Ranked by what the player is trying to do: a ride is the answer to the question
 * that produced this file, so it is the largest mark on the map.
 *
 * 6 and not 4.5, which is where this started, because the probe refused it. At
 * 4.5 the diamond rasterises to a 6×6 block of ink and the place disc to another
 * 6×6, and their silhouettes differ by 0.17 of their combined area — the two are
 * the same object in two colours, which is the complaint this file answers. The
 * corners are 1 px each at that size and carry nothing. At 6 the diamond is 10×10
 * and the pair reaches 0.52. Every remaining pair clears 0.35, the weakest being
 * the two rides against each other, which the flat base of the triangle settles.
 */
export const RIDE_RADIUS = 6;
export const PLACE_RADIUS = 3.4;
export const COMPANION_HALF = { across: 1.8, along: 4 };

/**
 * Nothing closer together than this can be two marks; it is one mark drawn twice.
 * Two bikes share area 0 at every destination and stand about four metres apart,
 * a seventh of a pixel, so without a merge the corner map stacks them and the
 * ink goes dark where the casings pile up.
 *
 * Deliberately smaller than the symbol's own 12 px span. The span is 446 m at
 * ta-xua, which is more than half the 705 m between that destination's only two
 * parking areas, and swallowing one of two places to get a bike is a worse
 * failure than two symbols touching. 7 px is 260 m there and 180 m at hoi-an —
 * under every real gap, over every real stack. `probe/map-symbols.ts` prints the
 * closest pair per destination against this number and fails if either
 * destination ends up with fewer than two marks.
 */
const MERGE_PIXELS = 7;

/**
 * One symbol per place a ride can be found, nearest first, with the ones nobody
 * can walk to dropped.
 *
 * @param toPixel world metres to map pixels, so the merge is judged in the units
 *   the eye is working in rather than in metres, which differ per destination.
 */
export const plotRides = (
  rides: readonly MapRide[],
  toPixel: (x: number, z: number) => { x: number; y: number }
): { noun: string; taken: boolean; x: number; y: number }[] => {
  const plotted: { noun: string; taken: boolean; x: number; y: number }[] = [];

  for (const ride of rides) {
    if (!ride.atRest && !ride.taken) continue;
    const point = toPixel(ride.x, ride.z);
    // The one you are on wins its pixel: it is drawn hollow, and a solid mark
    // merged into it would say there is a spare machine there when there is not.
    const near = plotted.find(
      (other) => other.noun === ride.noun && Math.hypot(other.x - point.x, other.y - point.y) < MERGE_PIXELS
    );
    if (near) {
      if (ride.taken) near.taken = true;
      continue;
    }
    plotted.push({ noun: ride.noun, taken: ride.taken, x: point.x, y: point.y });
  }

  return plotted;
};

const traceOutline = (
  context: CanvasRenderingContext2D,
  outline: Outline,
  x: number,
  y: number,
  radius: number
): void => {
  context.beginPath();
  outline.forEach(([ox, oy], index) => {
    const px = x + ox * radius;
    const py = y + oy * radius;
    if (index === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  });
  context.closePath();
};

/**
 * A ride on the corner map. Filled when it is free, outline only when it is the
 * one the player is on: hollow against solid is the strongest difference two
 * marks of one shape can have at nine pixels, and it is the difference that
 * matters, because a map offering you the bike you are sitting on is worse than
 * one offering nothing.
 */
export const paintRide = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  noun: string,
  taken: boolean,
  radius = RIDE_RADIUS
): void => {
  const colour = colourForRide(noun);
  traceOutline(context, outlineFor(noun), x, y, radius);

  // Cased first and wider than the mark, so the dark reads as an edge on both
  // the solid and the hollow form rather than as a second, thinner symbol.
  context.lineJoin = 'round';
  context.lineWidth = taken ? 2.6 : 1.4;
  context.strokeStyle = CASING;
  context.stroke();

  if (taken) {
    context.lineWidth = 1.3;
    context.strokeStyle = colour;
    context.stroke();
    return;
  }

  context.fillStyle = colour;
  context.fill();
};

/** A place worth walking to: round, solid, no corners anywhere. */
export const paintPlace = (context: CanvasRenderingContext2D, x: number, y: number): void => {
  context.beginPath();
  context.arc(x, y, PLACE_RADIUS, 0, Math.PI * 2);
  context.fillStyle = '#f2a679';
  context.fill();
  context.lineWidth = 1.2;
  context.strokeStyle = CASING;
  context.stroke();
};

/**
 * Somebody you came with: an upright capsule in their own colour, the colour
 * their body, their ring and their compass arrow already carry.
 *
 * Standing up is the whole idea. A disc is what a place is, so the mark that
 * tells a person from a place cannot be another round one. Taller than it is
 * wide is an axis nothing else here uses, and it is the shape of a person
 * besides — the difference between a symbol that is merely distinguishable and
 * one that can be understood the first time it is seen.
 */
export const paintCompanion = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  id: string,
  /** The full map has room for a bigger one, and prints the name over it as well. */
  scale = 1
): void => {
  const across = COMPANION_HALF.across * scale;
  const along = COMPANION_HALF.along * scale;
  context.beginPath();
  context.roundRect(x - across, y - along, across * 2, along * 2, across);
  context.lineWidth = 1.1 * scale;
  context.strokeStyle = CASING;
  context.stroke();
  context.fillStyle = colourFor(id);
  context.fill();
};
