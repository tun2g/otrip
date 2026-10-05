'use client';

import type { LocationRecipe } from '@otrip/world';

import {
  DEFAULT_WEATHER_PRESET,
  effectivePreset,
  presetsFor,
  unmetHour,
  type SunHour,
  type WeatherPresetId,
} from '@/lib/weather-presets';
import { cn } from '@/lib/utils';

type WeatherPickerProps = {
  value: WeatherPresetId;
  onChange: (id: WeatherPresetId) => void;
  /**
   * The destination decides which presets exist at all: three of the four have no
   * cloud sea, so offering one there is a button that renders nothing.
   */
  recipe: LocationRecipe;
  /**
   * Vị trí mặt trời thật của giờ đang chọn. Cái picker không tự tính được: nó
   * phụ thuộc toạ độ và giờ, cả hai ở ngoài component. "Đêm trăng" cần `night`,
   * "Biển mây" cần `daylight` — một con số không nói được cả hai, vì sau khi mặt
   * trời mọc `night` đã về 0 và đứng yên suốt cả ngày.
   */
  sun: SunHour;
  /** Thời tiết thật của giờ đang chọn, ví dụ "Trời quang · 24°C". */
  realLabel?: string;
};

/** Touch gets the 44px target; a mouse does not need the panel twice as tall. */
const CHIP =
  'rounded-control border border-border px-2.5 py-1 transition-colors hover:border-accent [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3';

export const WeatherPicker = ({ value, onChange, recipe, sun, realLabel }: WeatherPickerProps) => {
  // Not `weatherPreset(value)`: an id this destination cannot carry is really the
  // real forecast, and the chip row has to agree with the scene about that rather
  // than highlight nothing while the header claims a simulation.
  const active = effectivePreset(value, recipe);
  const simulated = active.override !== null;
  const needed = unmetHour(active.id, sun);

  return (
    <section className="pointer-events-auto w-full rounded-panel bg-panel/70 p-4 shadow-panel backdrop-blur-md sm:max-w-xs">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-display text-lg">Thời tiết</h2>
        {/* The state of the scene belongs in the header, not in fine print at the
            bottom that nobody scrolls to: this line is the whole honesty claim. */}
        <p className={cn('text-xs whitespace-nowrap', simulated ? 'text-accent' : 'text-subtle')}>
          {simulated ? 'đang giả lập' : 'dữ liệu thật'}
        </p>
      </header>

      {realLabel && (
        <p className="mt-1 text-xs text-muted-foreground">
          Thật ở {recipe.name}: {realLabel}
        </p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-1.5 text-xs">
        {presetsFor(recipe).map((preset) => {
          const chosen = preset.id === active.id;
          // An hour condition leaves the chip pressable on purpose: greying out
          // "Đêm trăng" at noon leaves someone tapping a dead chip with no idea
          // what it wants, and the slider is right there. A place condition gets
          // the opposite treatment and never reaches this row at all.
          const unmet = unmetHour(preset.id, sun);

          return (
            <button
              key={preset.id}
              type="button"
              aria-pressed={chosen}
              onClick={() => onChange(preset.id)}
              className={cn(CHIP, 'flex flex-col items-start gap-0.5 py-1.5 text-left', chosen && 'border-accent')}
            >
              <span className="flex items-baseline gap-1.5">
                <span className={chosen ? 'text-accent' : undefined}>{preset.label}</span>
                {unmet && <span className="text-[0.6rem] text-subtle">{unmet.badge}</span>}
              </span>
              <span className="text-[0.62rem] leading-tight text-subtle">{preset.note}</span>
            </button>
          );
        })}
      </div>

      {needed && (
        <p className="mt-2 rounded-control border border-accent/40 px-2.5 py-1.5 text-[0.68rem] leading-relaxed text-accent">
          {needed.shortfall}
        </p>
      )}

      {simulated && (
        <div className="mt-3 rounded-control bg-panel-strong/60 p-2.5">
          <p className="text-[0.68rem] leading-relaxed text-muted-foreground">
            Cảnh đang chạy bằng thời tiết bạn đặt, không phải trời thật ở {recipe.name} lúc này.
          </p>
          <button
            type="button"
            onClick={() => onChange(DEFAULT_WEATHER_PRESET)}
            className={cn(CHIP, 'mt-2 w-full border-accent/60 text-accent hover:border-accent')}
          >
            Về thời tiết thật
          </button>
        </div>
      )}
    </section>
  );
};
