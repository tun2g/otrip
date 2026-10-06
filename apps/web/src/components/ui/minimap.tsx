'use client';

import { useEffect, useMemo, useRef } from 'react';

import { paintCompanion, paintPlace, paintRide, plotRides, type MapRide } from '@/components/ui/map-symbols';
import { RideGlyph } from '@/components/ui/ride-glyph';
import type { MapPerson, MapPlayer, Relief } from '@/components/ui/world-map';
import { drawHeadingMarker, formatDistance, worldToMapFraction } from '@/components/ui/world-map';
import { alwaysOnMap } from '@/scene/points-of-interest';
import type { ResolvedPoi } from '@/scene/points-of-interest';

const SIZE = 140;
const NO_PEOPLE: MapPerson[] = [];
const NO_RIDES: readonly MapRide[] = [];

type MinimapProps = {
  relief: Relief | null;
  pois: ResolvedPoi[];
  /** Live motorbikes and boats. The reason anybody looks at this map twice. */
  rides?: readonly MapRide[];
  discovered: Set<string>;
  player: MapPlayer | null;
  others?: MapPerson[];
  /** Opens the full map. The corner map is the handle, not the whole thing. */
  onOpen?: () => void;
};

/** One legend row: a symbol, its Vietnamese name, and where the nearest one is. */
type Row = { noun: string; taken: boolean; status: string };

/**
 * What the legend says about one kind of ride.
 *
 * Three states, because there are three answers a player can get and the wrong
 * thing to do with the last two is print a distance anyway. A free machine at
 * rest gives a distance. The machine under the player gives "bạn đang lái", so
 * the hollow symbol under their own arrow has a name. And boats are the one kind
 * that can all be out on the water at once — three of the five per lake are
 * under way at the ultra tier — in which case there is nothing to walk to and
 * saying so beats sending somebody to an empty landing.
 */
const rowFor = (noun: string, rides: readonly MapRide[], player: MapPlayer | null): Row => {
  const mine = rides.find((ride) => ride.noun === noun && ride.taken);
  if (mine) return { noun, taken: true, status: 'bạn đang lái' };

  const free = rides.filter((ride) => ride.noun === noun && ride.atRest);
  if (free.length === 0) return { noun, taken: false, status: 'đều đang chạy' };
  if (!player) return { noun, taken: false, status: `${free.length} chiếc` };

  const nearest = free.reduce(
    (best, ride) => Math.min(best, Math.hypot(ride.x - player.x, ride.z - player.z)),
    Number.POSITIVE_INFINITY
  );
  return { noun, taken: false, status: formatDistance(nearest) };
};

/**
 * The same drawing as the full map, shrunk into the corner: one relief bitmap,
 * the places, the rides, the people, and which way you are facing. No contours at
 * this size — at 140 px they would be a grey smear — so it stays a single blit
 * plus a dozen shapes, cheap enough to redraw every time you move.
 *
 * Two things are deliberately not on it. Undiscovered places were a 2.6 px
 * hollow grey ring, which over a hillshade is both invisible and unnameable: a
 * mark you cannot identify is noise, and "there is something out there" is a
 * question the full map has room to answer properly, with its dashed circle and
 * its question mark. And the kerb-side parking slots are gone in favour of the
 * machines themselves — see `MapRide`.
 */
export const Minimap = ({
  relief,
  pois,
  rides = NO_RIDES,
  discovered,
  player,
  others = NO_PEOPLE,
  onOpen,
}: MinimapProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Keyed on the noun rather than on a fixed list, so a third kind of ride
  // appears in the legend the day the renderer starts returning one.
  const legend = useMemo(() => {
    const nouns = Array.from(new Set(rides.map((ride) => ride.noun)));
    return nouns.map((noun) => rowFor(noun, rides, player));
  }, [rides, player]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = SIZE * ratio;
    canvas.height = SIZE * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, SIZE, SIZE);

    context.save();
    context.beginPath();
    context.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
    context.clip();

    context.fillStyle = '#0b1020';
    context.fillRect(0, 0, SIZE, SIZE);
    if (relief) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(relief.bitmap, 0, 0, SIZE, SIZE);
    }

    const terrainSize = relief?.terrainSize ?? 1;
    const toPixel = (worldX: number, worldZ: number) => ({
      x: worldToMapFraction(worldX, terrainSize) * SIZE,
      y: worldToMapFraction(worldZ, terrainSize) * SIZE,
    });

    // Bottom to top in the order the player needs them: the places they have
    // already been, then the ride they are looking for, then the people, then
    // themselves. Nothing may cover the heading marker, and a bike may not cover
    // a person.
    for (const poi of pois) {
      if (!discovered.has(poi.id) && !alwaysOnMap(poi)) continue;
      const point = toPixel(poi.x, poi.z);
      paintPlace(context, point.x, point.y);
    }

    for (const ride of plotRides(rides, toPixel)) {
      paintRide(context, ride.x, ride.y, ride.noun, ride.taken);
    }

    // At the only range this map works at — a whole 3.6–5.2 km terrain in 140 px,
    // so 26 to 37 metres to the pixel — a companion at the 9–17 m a fresh join
    // puts them at lands a third of a pixel from you and underneath your own
    // marker. Close range is the compass's question, not this one;
    // `probe/companion-bearing.ts` prints the arithmetic per destination. What
    // this answers is the other half: where somebody went half a kilometre ago,
    // which is thirteen to nineteen pixels away and worth a mark.
    for (const person of others) {
      const point = toPixel(person.x, person.z);
      paintCompanion(context, point.x, point.y, person.id);
    }

    if (player) {
      const point = toPixel(player.x, player.z);
      drawHeadingMarker(context, point.x, point.y, player.yaw, { radius: 7, fill: '#f2ece2' });
    }

    context.restore();
  }, [relief, pois, rides, discovered, player, others]);

  const dial = (
    <>
      <canvas ref={canvasRef} width={SIZE} height={SIZE} aria-hidden="true" className="size-[140px] rounded-full" />
      {/* An arrow over the letter, the same rose the full map puts in its corner:
          a bare "B" on a circle is a letter floating on a picture, and north is a
          direction before it is an initial. */}
      <span
        aria-hidden="true"
        className="absolute top-0.5 left-1/2 -translate-x-1/2 text-center text-[0.5rem] leading-none text-haze/80"
      >
        <span className="block text-accent">▲</span>B
      </span>
      {onOpen && (
        <span
          aria-hidden="true"
          className="absolute -right-1 -bottom-1 rounded-control border border-border bg-panel/90 px-1.5 py-0.5 text-[0.6rem] text-muted-foreground"
        >
          M
        </span>
      )}
    </>
  );

  return (
    <div className="pointer-events-none flex flex-col items-end gap-1.5">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label="Mở bản đồ lớn (phím M)"
          title="Mở bản đồ lớn (M)"
          className="pointer-events-auto relative rounded-full border border-border shadow-panel transition-colors hover:border-accent/70 focus-visible:border-accent focus-visible:outline-none"
        >
          {dial}
        </button>
      ) : (
        <div className="relative rounded-full border border-border shadow-panel" role="img" aria-label="Bản đồ nhỏ">
          {dial}
        </div>
      )}

      {/* The symbols named, in the place where the question gets asked. A shape
          cannot be understood the first time it is seen, and 140 px has no room
          for a legend inside it — while a legend on the other screen teaches the
          corner map nothing. So the naming sits under the dial and earns its two
          lines by also carrying the answer: how far to the nearest one. */}
      {legend.length > 0 && (
        <ul className="w-[140px] rounded-control bg-panel/70 px-2 py-1 text-[0.6rem] backdrop-blur-md">
          {legend.map((row) => (
            <li key={row.noun} className="flex items-center gap-1.5 leading-5">
              <RideGlyph noun={row.noun} taken={row.taken} className="size-2.5 shrink-0" />
              <span className="text-muted-foreground">{row.noun}</span>
              <span className="ml-auto text-subtle">{row.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
