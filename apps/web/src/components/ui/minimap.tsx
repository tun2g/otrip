'use client';

import { useEffect, useRef } from 'react';

import type { MapPerson, MapPlayer, Relief } from '@/components/ui/world-map';
import { drawHeadingMarker, worldToMapFraction } from '@/components/ui/world-map';
import { alwaysOnMap } from '@/scene/points-of-interest';
import type { ResolvedPoi } from '@/scene/points-of-interest';

const SIZE = 140;
const NO_PEOPLE: MapPerson[] = [];
const NO_PARKING: readonly { x: number; z: number }[] = [];

type MinimapProps = {
  relief: Relief | null;
  pois: ResolvedPoi[];
  /** Where motorbikes stand parked. Always drawn: a service, not a sight. */
  parking?: readonly { x: number; z: number }[];
  discovered: Set<string>;
  player: MapPlayer | null;
  others?: MapPerson[];
  /** Opens the full map. The corner map is the handle, not the whole thing. */
  onOpen?: () => void;
};

/**
 * The same drawing as the full map, shrunk into the corner: one relief bitmap,
 * the places, the people, and which way you are facing. No contours at this
 * size — at 140 px they would be a grey smear — so it stays a single blit plus
 * a dozen dots, cheap enough to redraw every time you move.
 */
export const Minimap = ({
  relief,
  pois,
  parking = NO_PARKING,
  discovered,
  player,
  others = NO_PEOPLE,
  onOpen,
}: MinimapProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

    // Drawn under the places, so a jetty and a parking bay in the same village
    // do not fight over the same few pixels: the sight wins the top layer.
    for (const spot of parking) {
      const point = toPixel(spot.x, spot.z);
      context.fillStyle = '#8fb8d8';
      context.strokeStyle = 'rgba(11,16,32,0.85)';
      context.lineWidth = 1.2;
      context.beginPath();
      context.rect(point.x - 2.6, point.y - 2.6, 5.2, 5.2);
      context.fill();
      context.stroke();
    }

    for (const poi of pois) {
      const point = toPixel(poi.x, poi.z);
      const found = discovered.has(poi.id) || alwaysOnMap(poi);
      context.beginPath();
      context.arc(point.x, point.y, found ? 3.4 : 2.6, 0, Math.PI * 2);
      if (found) {
        context.fillStyle = '#f2a679';
        context.fill();
        context.lineWidth = 1.2;
        context.strokeStyle = 'rgba(11,16,32,0.85)';
        context.stroke();
      } else {
        // Undiscovered places are a hollow ring: present on the map, not placed.
        context.lineWidth = 1.2;
        context.strokeStyle = 'rgba(205,217,230,0.75)';
        context.stroke();
      }
    }

    for (const person of others) {
      const point = toPixel(person.x, person.z);
      context.beginPath();
      context.arc(point.x, point.y, 2.4, 0, Math.PI * 2);
      context.fillStyle = '#cdd9e6';
      context.fill();
    }

    if (player) {
      const point = toPixel(player.x, player.z);
      drawHeadingMarker(context, point.x, point.y, player.yaw, { radius: 7, fill: '#f2ece2' });
    }

    context.restore();
  }, [relief, pois, parking, discovered, player, others]);

  const content = (
    <>
      <canvas ref={canvasRef} width={SIZE} height={SIZE} aria-hidden="true" className="size-[140px] rounded-full" />
      <span aria-hidden="true" className="absolute top-1 left-1/2 -translate-x-1/2 text-[0.55rem] text-haze/80">
        B
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

  if (!onOpen) {
    return (
      <div
        className="pointer-events-none relative rounded-full border border-border shadow-panel"
        role="img"
        aria-label="Bản đồ nhỏ"
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Mở bản đồ lớn (phím M)"
      title="Mở bản đồ lớn (M)"
      className="pointer-events-auto relative rounded-full border border-border shadow-panel transition-colors hover:border-accent/70 focus-visible:border-accent focus-visible:outline-none"
    >
      {content}
    </button>
  );
};
