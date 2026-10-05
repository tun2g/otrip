'use client';

import { LOCATIONS, type LocationRecipe, type TerrainProfile } from '@otrip/world';
import Link from 'next/link';
import { useState } from 'react';

import { cn } from '@/lib/utils';

const PROFILE_LABELS: Record<TerrainProfile, string> = {
  ridge: 'Sống núi',
  karst: 'Núi đá vôi',
  lowland: 'Đồng bằng',
};

/**
 * What a place is, read off the recipe rather than written twice. A fifth
 * destination therefore describes itself the moment its recipe exists.
 */
const traitsOf = (recipe: LocationRecipe): string =>
  [
    PROFILE_LABELS[recipe.terrain.profile],
    `${recipe.coords.elevation.toLocaleString('vi-VN')}m`,
    recipe.cloudSea ? 'biển mây' : null,
    recipe.water ? 'mặt nước' : null,
    recipe.town?.lanterns ? 'phố sáng đèn' : recipe.town ? 'phố' : null,
    `${recipe.pois.length} điểm ghé`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

/** 44px minimum on every row: this menu is reachable from a phone, by thumb. */
const ROW = 'flex min-h-11 w-full items-center gap-3 rounded-control px-4 py-2 text-sm transition-colors';

type PauseMenuProps = {
  recipe: LocationRecipe;
  onResume: () => void;
  /** Back to the orbiting view of this same place, still inside the app. */
  onSightsee: () => void;
  /** Named consequence of leaving this page while a trip is live, or null. */
  tripWarning: string | null;
};

export const PauseMenu = ({ recipe, onResume, onSightsee, tripWarning }: PauseMenuProps) => {
  const [switching, setSwitching] = useState(false);
  const destinations = Object.values(LOCATIONS);

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label="Tạm dừng"
      className="pointer-events-auto w-full rounded-panel bg-panel/90 p-4 shadow-panel backdrop-blur-md"
    >
      <header className="px-1">
        <p className="text-[0.65rem] tracking-wide text-accent uppercase">Tạm dừng</p>
        <p className="font-display text-xl leading-tight">{recipe.name}</p>
        <p className="text-xs text-muted-foreground">{recipe.region}</p>
      </header>

      <div className="mt-3 flex flex-col gap-1.5">
        <button
          type="button"
          autoFocus
          onClick={onResume}
          className={cn(ROW, 'border border-accent/60 text-accent hover:border-accent hover:bg-accent/10')}
        >
          <span aria-hidden="true">▸</span>
          <span className="flex-1 text-left">Tiếp tục đi bộ</span>
          <span className="text-xs text-subtle">ESC</span>
        </button>

        <button type="button" onClick={onSightsee} className={cn(ROW, 'border border-border hover:border-accent')}>
          <span className="flex-1 text-left">Về ngắm cảnh từ trên cao</span>
        </button>

        <button
          type="button"
          onClick={() => setSwitching((value) => !value)}
          aria-expanded={switching}
          className={cn(ROW, 'border border-border hover:border-accent', switching && 'border-accent/50')}
        >
          <span className="flex-1 text-left">Đổi điểm đến</span>
          <span aria-hidden="true" className="text-xs text-subtle">
            {switching ? '▴' : '▾'}
          </span>
        </button>

        {switching && (
          <div className="flex flex-col gap-1.5 rounded-control bg-panel-strong/50 p-1.5">
            {tripWarning && <p className="px-2.5 pt-1 text-[0.68rem] leading-relaxed text-subtle">{tripWarning}</p>}
            {destinations.map((destination) => {
              const here = destination.slug === recipe.slug;

              return here ? (
                <p
                  key={destination.slug}
                  className={cn(ROW, 'flex-col items-start justify-center gap-0 border border-accent/40 text-accent')}
                >
                  <span className="font-display text-sm">{destination.name}</span>
                  <span className="text-[0.68rem] text-subtle">Bạn đang ở đây</span>
                </p>
              ) : (
                <Link
                  key={destination.slug}
                  href={`/${destination.slug}`}
                  className={cn(
                    ROW,
                    'flex-col items-start justify-center gap-0 border border-border hover:border-accent'
                  )}
                >
                  <span className="font-display text-sm">
                    {destination.name}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">{destination.region}</span>
                  </span>
                  <span className="text-[0.68rem] text-subtle">{traitsOf(destination)}</span>
                </Link>
              );
            })}
          </div>
        )}

        <Link href="/" className={cn(ROW, 'border border-transparent text-subtle hover:border-border')}>
          <span className="flex-1 text-left">Về trang chủ otrip</span>
        </Link>
      </div>
    </section>
  );
};
