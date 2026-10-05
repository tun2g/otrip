'use client';

import { useState } from 'react';

import type { SettingsState } from '@/hooks/use-settings';
import { QUALITY_LABELS, type QualityTier } from '@/scene/quality';
import { cn } from '@/lib/utils';

const TIERS: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

export const SettingsPanel = ({ settings }: { settings: SettingsState }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="pointer-events-auto relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="rounded-control bg-panel/70 px-3 py-2 text-xs shadow-panel backdrop-blur-md transition-colors hover:text-accent"
      >
        Cài đặt
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-2 w-64 space-y-3 rounded-panel bg-panel/90 p-3 text-xs shadow-panel backdrop-blur-md">
          <div className="space-y-1.5">
            <p className="text-[0.65rem] tracking-wide text-subtle uppercase">Hình ảnh</p>
            <div className="flex gap-2">
              {(['sharp', 'pixel'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => settings.update({ style: value })}
                  className={cn(
                    'flex-1 rounded-control border border-border px-2 py-1 transition-colors hover:border-accent',
                    settings.style === value && 'border-accent text-accent'
                  )}
                >
                  {value === 'sharp' ? 'Sắc nét' : 'Pixel'}
                </button>
              ))}
            </div>
            <p className="text-[0.65rem] leading-relaxed text-subtle">
              Sắc nét vẽ ở full độ phân giải. Pixel vẽ nhỏ rồi phóng to — nhẹ máy hơn hẳn.
            </p>
          </div>

          <div className="space-y-1.5">
            <p className="text-[0.65rem] tracking-wide text-subtle uppercase">Mức chi tiết</p>
            <div className="grid grid-cols-4 gap-1.5">
              {TIERS.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => settings.update({ tier })}
                  className={cn(
                    'rounded-control border border-border px-1 py-1 transition-colors hover:border-accent',
                    settings.tier === tier && 'border-accent text-accent'
                  )}
                >
                  {QUALITY_LABELS[tier]}
                </button>
              ))}
            </div>
            <p className="text-[0.65rem] text-subtle">Đổi mức sẽ dựng lại địa hình, mất một hai giây.</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="otrip-sensitivity" className="block text-[0.65rem] tracking-wide text-subtle uppercase">
              Độ nhạy chuột · {settings.sensitivity.toFixed(1)}×
            </label>
            <input
              id="otrip-sensitivity"
              type="range"
              min={20}
              max={300}
              value={Math.round(settings.sensitivity * 100)}
              onChange={(event) => settings.update({ sensitivity: Number(event.target.value) / 100 })}
              className="w-full accent-accent"
            />
          </div>
        </div>
      )}
    </div>
  );
};
