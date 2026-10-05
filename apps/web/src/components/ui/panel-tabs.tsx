'use client';

import { cn } from '@/lib/utils';

export type PanelTab = 'sky' | 'explore' | 'trip';

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'sky', label: 'Trời & giờ' },
  { id: 'explore', label: 'Khám phá' },
  { id: 'trip', label: 'Đi cùng' },
];

/**
 * A phone cannot carry three stacked panels and still be a view of a landscape,
 * so at narrow widths only one is open at a time — and tapping the open one
 * closes it, leaving this row as the whole interface and the other 90% of a
 * 390px screen as the place you came to look at. Hidden from `sm` up, where all
 * three fit side by side; the choice stays in CSS so the server render is
 * already right and nothing flashes.
 */
export const PanelTabs = ({ tab, onChange }: { tab: PanelTab | null; onChange: (tab: PanelTab | null) => void }) => (
  <div
    role="tablist"
    aria-label="Bảng điều khiển"
    className="pointer-events-auto flex w-full gap-1.5 rounded-control bg-panel/70 p-1.5 backdrop-blur-md sm:hidden"
  >
    {TABS.map((item) => {
      const open = tab === item.id;

      return (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={open}
          aria-label={open ? `Thu gọn ${item.label}` : `Mở ${item.label}`}
          onClick={() => onChange(open ? null : item.id)}
          className={cn(
            'flex min-h-11 flex-1 items-center justify-center gap-1 rounded-control px-2 text-xs transition-colors',
            open ? 'bg-accent/15 text-accent' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {item.label}
          {open && (
            <span aria-hidden="true" className="text-[0.6rem]">
              ▾
            </span>
          )}
        </button>
      );
    })}
  </div>
);
