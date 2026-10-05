'use client';

import type { Forecast } from '@otrip/contracts';
import type { LocationRecipe } from '@otrip/world';
import { useState } from 'react';

import { drawOf } from '@/lib/draw';
import { cloudHuntLabel, formatHour, goldenHourStandsOut, sunriseInHour, todayAt, weatherLabel } from '@/lib/forecast';
import { cn } from '@/lib/utils';

type SkyControlsProps = {
  /** Names what the score is a score *of*: not everywhere has a cloud sea. */
  recipe: LocationRecipe;
  forecast: Forecast;
  index: number;
  nowIndex: number;
  /**
   * Highest cloud-hunting score in the window that opens at a sunrise still
   * ahead — a good morning, not the moment the sun clears the ridge.
   */
  goldenIndex: number | null;
  /** The forecast hour closest to the next real sunrise. */
  sunriseIndex: number | null;
  onChange: (index: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  /** Wall-clock seconds spent on each forecast hour while the clock runs. */
  secondsPerHour: number;
  onCycleSpeed: () => void;
  onPlaySunrise: () => void;
  onShare: () => void;
  shareLabel: string;
  onPhoto: () => void;
  photoLabel: string;
  onRemind: () => void;
  remindLabel: string;
  /** Collapsing one card while the rest of the HUD stays is not what anyone
   *  means by "thu gọn", so the button hands the whole overlay off instead. */
  onCollapse: () => void;
};

/** Touch gets the 44px target; a mouse does not need the panel twice as tall. */
const CHIP =
  'rounded-control border border-border px-2.5 py-1 transition-colors hover:border-accent [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3';

const Stat = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div className="flex flex-col">
    <dt className="text-[0.65rem] tracking-wide text-subtle uppercase">{label}</dt>
    <dd className="text-sm">{value}</dd>
    {hint && <p className="text-[0.65rem] leading-tight text-subtle">{hint}</p>}
  </div>
);

/** Plain-language reading of each input, so the score is never a bare verdict. */
const humidityNote = (value: number): string => (value >= 90 ? 'gần bão hoà' : value >= 75 ? 'khá ẩm' : 'còn khô');

/* The bands are `cloudHuntScore`'s own gates, but only the middle one was ever
   written per place. "mây dưới thung lũng" is Tà Xùa talking: Hồ Tây sits inside
   Hà Nội and Hội An on the beach, with no valley under either to be clear of.
   "dễ là bạn đứng trong mây" was the same mistake at the other end — true on a
   1500m ridge, while at the lake a full low deck is a grey lid overhead. Both
   ends now say only what holds in all four places; the vivid per-place reading
   needs a field on `Draw` saying where the viewer stands relative to the cloud. */
const lowCloudNote = (value: number, promise: string): string => {
  if (value < 10) return 'gần như không có';
  if (value < 35) return 'mới lác đác';
  if (value <= 85) return promise;
  return 'kín trời — dày quá';
};

const windNote = (value: number): string => (value <= 6 ? 'lặng' : value <= 18 ? 'hơi có gió' : 'gió mạnh, dễ tan mây');

export const SkyControls = ({
  recipe,
  forecast,
  index,
  nowIndex,
  goldenIndex,
  sunriseIndex,
  onChange,
  playing,
  onTogglePlay,
  secondsPerHour,
  onCycleSpeed,
  onPlaySunrise,
  onShare,
  shareLabel,
  onPhoto,
  photoLabel,
  onRemind,
  remindLabel,
  onCollapse,
}: SkyControlsProps) => {
  const [explained, setExplained] = useState(false);

  const draw = drawOf(recipe);
  const hour = forecast.hours[index];
  if (!hour) return null;

  const today = todayAt(forecast.utcOffsetSeconds);
  const isNow = index === nowIndex;
  const last = forecast.hours.length - 1;
  // The cell is what gets jumped to, because the cell is where the weather is;
  // printing it is what told people 05:00 for a 05:48 sunrise.
  const sunriseAt = sunriseIndex === null ? null : sunriseInHour(forecast, sunriseIndex);

  const golden = goldenIndex === null ? null : forecast.hours[goldenIndex];
  const goldenStandsOut = goldenIndex !== null && goldenHourStandsOut(forecast, goldenIndex, nowIndex);
  const peakNote = `Giờ có điểm ${draw.chance} cao nhất trong khoảng ba tiếng sau bình minh`;

  return (
    <section className="pointer-events-auto w-full rounded-panel bg-panel/70 p-4 shadow-panel backdrop-blur-md sm:max-w-md">
      {/* Three things competing for one row turned into six wrapped lines on a
          phone; letting the weather and the collapse drop together keeps two. */}
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="font-display text-lg">
          {formatHour(hour.time, today)}
          {isNow && <span className="ml-2 text-xs text-subtle">đang diễn ra</span>}
          {playing && !isNow && <span className="ml-2 text-xs text-accent">giờ đang chạy</span>}
        </p>
        <div className="flex shrink-0 items-baseline gap-2">
          <p className="text-sm whitespace-nowrap text-muted-foreground">
            {weatherLabel(hour.weatherCode)} · {Math.round(hour.temperature)}°C
          </p>
          <button
            type="button"
            onClick={onCollapse}
            title="Ẩn toàn bộ bảng điều khiển (phím H)"
            className="text-xs whitespace-nowrap text-subtle underline-offset-2 hover:underline"
          >
            Thu gọn
          </button>
        </div>
      </header>

      <div className="mt-3 flex items-baseline justify-between gap-3">
        <p className="text-sm">
          <span className="text-subtle">Cơ hội {draw.chance} </span>
          <span className="font-display text-lg">{hour.cloudHunt}</span>
          <span className="text-subtle">/100 · {cloudHuntLabel(hour.cloudHunt)} · ước lượng</span>
        </p>
        <button
          type="button"
          onClick={() => setExplained((value) => !value)}
          aria-expanded={explained}
          className="text-xs text-accent underline-offset-2 hover:underline"
        >
          {explained ? 'Ẩn' : 'Vì sao?'}
        </button>
      </div>

      {explained && (
        <div className="mt-2 rounded-control bg-panel-strong/60 p-3">
          <dl className="grid grid-cols-3 gap-3">
            <Stat label="Độ ẩm" value={`${hour.humidity}%`} hint={humidityNote(hour.humidity)} />
            <Stat
              label="Mây thấp"
              value={`${hour.lowCloudCover}%`}
              hint={lowCloudNote(hour.lowCloudCover, draw.lowCloudPromise)}
            />
            <Stat label="Gió" value={`${Math.round(hour.windSpeed)} km/h`} hint={windNote(hour.windSpeed)} />
          </dl>
          {/* The caveat used to sit at the foot of the panel as permanent fine
              print, costing a phone 44px and getting read by nobody. It belongs
              beside the three numbers it is a caveat about. */}
          <p className="mt-3 text-[0.68rem] leading-relaxed text-subtle">
            Ba số này là tất cả những gì điểm trên dựa vào — một ước lượng, không phải dự báo {draw.noun}.
          </p>
        </div>
      )}

      <input
        type="range"
        min={0}
        max={last}
        value={index}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={`Chọn giờ trong dự báo ${forecast.hours.length} tiếng`}
        className="mt-4 w-full accent-accent"
      />

      {/* Waiting for the light is the whole point of this app, and a slider you
          have to drag is a sunrise you can only scrub past. */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          onClick={onTogglePlay}
          aria-pressed={playing}
          title={playing ? 'Dừng đồng hồ' : 'Cho giờ tự trôi để xem trời đổi'}
          className={cn(
            CHIP,
            'min-h-11 border-accent/60 px-3 text-accent hover:border-accent',
            playing && 'border-accent bg-accent/10'
          )}
        >
          <span aria-hidden="true" className="mr-1.5">
            {playing ? '❚❚' : '▶'}
          </span>
          {playing ? 'Dừng giờ' : 'Cho giờ trôi'}
        </button>

        <button
          type="button"
          onClick={onCycleSpeed}
          title={`Mỗi ${secondsPerHour} giây trôi qua một giờ dự báo. Bấm để đổi tốc độ.`}
          className={cn(CHIP, 'text-muted-foreground')}
        >
          {secondsPerHour}s / giờ
        </button>

        {sunriseAt && sunriseIndex !== null && (
          <button
            type="button"
            onClick={onPlaySunrise}
            title={`Nhảy về trước bình minh ${formatHour(sunriseAt, today)} rồi cho giờ tự trôi. Dự báo theo từng giờ nên thanh giờ nhảy tròn tiếng.`}
            className={cn(CHIP, index === sunriseIndex && 'border-accent text-accent')}
          >
            Xem bình minh tới · {formatHour(sunriseAt, today)}
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={() => onChange(nowIndex)}
          disabled={isNow}
          className={cn(CHIP, isNow && 'cursor-default border-accent/40 text-subtle hover:border-accent/40')}
        >
          Bây giờ
        </button>
        {/* This hour is the best-scoring one in the three hours after a sunrise,
            which is not the same thing as sunrise — the old label said "Bình minh
            tới" and then handed you 08:00.
            The superlative is conditional for the same reason: at Hồ Tây the
            button read "Sáng đẹp nhất · 06:00 sáng mai · 0/100" beside a current
            hour of 24/100. The hour stays reachable either way — a grey day is
            still a day you can scrub to the coming sunrise — so what gives way is
            the claim, not the button. */}
        {golden && goldenIndex !== null && (
          <button
            type="button"
            onClick={() => onChange(goldenIndex)}
            title={
              goldenStandsOut
                ? `${peakNote} — không phải giờ mặt trời mọc.`
                : `${peakNote} — nhưng cao nhất của khoảng đó không có nghĩa là cao hơn giờ bạn đang xem.`
            }
            className={cn(CHIP, index === goldenIndex && 'border-accent text-accent')}
          >
            {goldenStandsOut ? 'Sáng đẹp nhất' : 'Cao nhất quanh bình minh'} · {formatHour(golden.time, today)} ·{' '}
            {golden.cloudHunt}/100
          </button>
        )}
        <button type="button" onClick={onShare} className={CHIP}>
          {shareLabel}
        </button>
        {/* The only control on this panel that leaves the screen. It had no
            quality gate at all: at Hồ Tây it sat in full accent beside "Cao nhất
            quanh bình minh · 0/100", offering a 5am alarm for a morning the app
            itself scores zero — and an alarm fires when nobody is at the tab to
            read a correction. It stays reachable, because 0/100 is an estimate
            that will have been refetched by then and someone may be going
            anyway; what it stops doing is recommending itself, and the score now
            travels with the action instead of staying behind on the screen. */}
        {golden && goldenIndex !== null && index === goldenIndex && (
          <button
            type="button"
            onClick={onRemind}
            title={
              goldenStandsOut
                ? `Tải file .ics đặt chuông trước ${formatHour(golden.time, today)} 10 phút.`
                : `Tải file .ics đặt chuông trước ${formatHour(golden.time, today)} 10 phút. Giờ đó mới được ${golden.cloudHunt}/100, nên chuông sẽ kêu mà chưa có gì được hứa — ước lượng còn đổi trước lúc đó.`
            }
            className={cn(CHIP, goldenStandsOut && 'border-accent/60 text-accent')}
          >
            {remindLabel}
            {!goldenStandsOut && ` · ${golden.cloudHunt}/100`}
          </button>
        )}
        <button type="button" onClick={onPhoto} className={CHIP}>
          {photoLabel}
        </button>
      </div>
    </section>
  );
};
