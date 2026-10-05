'use client';

import type { ResolvedPoi } from '@/scene/points-of-interest';
import { cn } from '@/lib/utils';

export type Heading = { poi: ResolvedPoi; distance: number; bearing: number } | null;

type ExplorePanelProps = {
  pois: ResolvedPoi[];
  discovered: Set<string>;
  heading: Heading;
  walking: boolean;
  onWalk: () => void;
  onTravel: (poiId: string) => void;
  /** Opens the full map. Browsing has no minimap, so this is its only handle. */
  onOpenMap: () => void;
};

/**
 * The map was lovely and gave nobody a reason to take a step. This is the
 * smallest honest answer: a handful of real places, how many you have reached,
 * and which way the next one is.
 */
export const ExplorePanel = ({
  pois,
  discovered,
  heading,
  walking,
  onWalk,
  onTravel,
  onOpenMap,
}: ExplorePanelProps) => {
  if (pois.length === 0) return null;

  const found = pois.filter((poi) => discovered.has(poi.id)).length;
  const done = found === pois.length;

  return (
    <section className="pointer-events-auto w-full rounded-panel bg-panel/70 p-3 text-xs shadow-panel backdrop-blur-md sm:max-w-xs">
      <header className="flex items-baseline justify-between gap-2">
        <p className="font-display text-sm">
          Đã ghé {found}/{pois.length}
        </p>
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={onOpenMap}
            title="Mở bản đồ cả vùng (phím M)"
            className="rounded-control border border-border px-2 py-0.5 text-muted-foreground transition-colors hover:border-accent hover:text-accent [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3"
          >
            Bản đồ
          </button>
          {!walking && (
            <button
              type="button"
              onClick={onWalk}
              className="rounded-control border border-accent/60 px-2 py-0.5 text-accent transition-colors hover:border-accent [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3"
            >
              Đi bộ tới
            </button>
          )}
        </div>
      </header>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {pois.map((poi) =>
          discovered.has(poi.id) ? (
            // Walking there is the first visit only; after that it is a place you
            // know and going back should not cost another kilometre.
            <button
              key={poi.id}
              type="button"
              onClick={() => onTravel(poi.id)}
              disabled={!walking}
              title={walking ? `Tới ${poi.name}` : 'Bật “Đi bộ” để quay lại'}
              className="rounded-control border border-accent/50 px-2 py-0.5 text-accent transition-colors hover:border-accent disabled:opacity-60"
            >
              {poi.name}
            </button>
          ) : (
            <span key={poi.id} className="rounded-control border border-border px-2 py-0.5 text-subtle">
              ???
            </span>
          )
        )}
      </div>

      {done ? (
        <p className="mt-2 leading-relaxed text-muted-foreground">
          Bạn đã đi hết các điểm ở đây. Thử kéo thanh giờ sang bình minh hoặc ban đêm — cảnh đổi hẳn.
        </p>
      ) : heading ? (
        <p className="mt-2 flex items-center gap-2 text-muted-foreground">
          <span
            aria-hidden="true"
            className="inline-block text-base text-accent"
            style={{ transform: `rotate(${heading.bearing}rad)` }}
          >
            ↑
          </span>
          <span>
            Gần nhất: cách {Math.round(heading.distance)}m{heading.distance < 120 && ' — gần tới rồi'}
          </span>
        </p>
      ) : (
        <p className="mt-2 text-muted-foreground">Bật “Đi bộ” để bắt đầu tìm.</p>
      )}
    </section>
  );
};
