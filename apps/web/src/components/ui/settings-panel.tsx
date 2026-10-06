'use client';

import { useState } from 'react';

import { FOV_MAX, FOV_MIN, type SettingsState } from '@/hooks/use-settings';
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

          <div className="space-y-1.5">
            <p className="text-[0.65rem] tracking-wide text-subtle uppercase">Thoải mái</p>

            <button
              type="button"
              onClick={() => settings.update({ cameraMotion: !settings.cameraMotion })}
              aria-pressed={settings.cameraMotion}
              className={cn(
                'flex w-full items-center gap-2 rounded-control border border-border px-2 py-1 transition-colors hover:border-accent',
                settings.cameraMotion && 'border-accent text-accent'
              )}
            >
              <span className="flex-1 text-left">Máy quay tự nghiêng, lắc</span>
              <span className="text-subtle">{settings.cameraMotion ? 'Bật' : 'Tắt'}</span>
            </button>
            <p className="text-[0.65rem] leading-relaxed text-subtle">
              Tắt thì chân trời luôn nằm ngang: máy quay không nghiêng khi rẽ, không ngả theo thuyền, không lùi ra khi
              chạy nhanh.
            </p>

            {/* Two sliders on one line: the panel is 16rem inside a w-64 and this
                is its fourth section, so a phone in portrait runs out of screen
                before it runs out of settings. */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label htmlFor="otrip-vignette" className="block text-[0.65rem] text-subtle">
                  Tối viền · {Math.round(settings.vignette * 100)}%
                </label>
                <input
                  id="otrip-vignette"
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(settings.vignette * 100)}
                  onChange={(event) => settings.update({ vignette: Number(event.target.value) / 100 })}
                  className="w-full accent-accent"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="otrip-fov" className="block text-[0.65rem] text-subtle">
                  Góc nhìn · {settings.fov}°
                </label>
                <input
                  id="otrip-fov"
                  type="range"
                  min={FOV_MIN}
                  max={FOV_MAX}
                  value={settings.fov}
                  onChange={(event) => settings.update({ fov: Number(event.target.value) })}
                  className="w-full accent-accent"
                />
              </div>
            </div>
            <p className="text-[0.65rem] leading-relaxed text-subtle">
              Tối viền làm rìa hình mất màu và tối đi lúc bạn đang chạy — rìa mắt là chỗ cảm giác chuyển động dồn vào.
              Góc nhìn hẹp lại cũng đỡ say, bù lại thấy ít cảnh hai bên hơn.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
