import type { Forecast, HourPoint } from '@otrip/contracts';

/**
 * Open-Meteo returns local wall-clock stamps with no offset. Reading one back as
 * a real instant means treating it as UTC and removing the location's offset —
 * getting this backwards puts the sun on the wrong side of the sky.
 */
export const hourToDate = (time: string, utcOffsetSeconds: number): Date =>
  new Date(Date.parse(`${time}:00Z`) - utcOffsetSeconds * 1000);

const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/**
 * "06:00 · 4/10" sat next to a score reads as "4 out of 10". Naming the day
 * instead removes the collision, and "sáng mai" is what someone planning to go
 * actually wants to know.
 */
export const formatHour = (time: string, todayAtLocation?: string): string => {
  const [date, clock] = time.split('T');
  if (!date || !clock) return time;

  const [year, month, day] = date.split('-').map(Number);
  if (todayAtLocation === date) return `${clock} hôm nay`;

  const asDate = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  const tomorrow = todayAtLocation ? Date.parse(`${todayAtLocation}T00:00:00Z`) + 86400000 : NaN;
  if (asDate.getTime() === tomorrow) return `${clock} sáng mai`;

  return `${clock} ${WEEKDAYS[asDate.getUTCDay()]} ${day}/${month}`;
};

/** The calendar date the destination is currently on, as YYYY-MM-DD. */
export const todayAt = (utcOffsetSeconds: number): string =>
  new Date(Date.now() + utcOffsetSeconds * 1000).toISOString().slice(0, 10);

/** Index of the forecast hour the destination is living in right now. */
export const currentHourIndex = (forecast: Forecast): number => {
  const nowAtLocation = new Date(Date.now() + forecast.utcOffsetSeconds * 1000);
  const stamp = nowAtLocation.toISOString().slice(0, 13);
  const index = forecast.hours.findIndex((hour) => hour.time.slice(0, 13) === stamp);
  return index === -1 ? 0 : index;
};

/**
 * The hour worth setting an alarm for: the best cloud-hunting score in the
 * window that opens at a sunrise still ahead of us. Looking backwards would
 * point people at a sunrise they already missed.
 */
export const goldenHourIndex = (forecast: Forecast, fromIndex = 0): number | null => {
  let best: { index: number; score: number } | null = null;

  for (const sunrise of forecast.sunrises) {
    const sunriseAt = Date.parse(`${sunrise}:00Z`);

    forecast.hours.forEach((hour, index) => {
      if (index < fromIndex) return;
      // The window opens at sunrise, not around it: an hour scoring well at 4am
      // is an hour spent in the dark, which is not what the button promises.
      const offset = Date.parse(`${hour.time}:00Z`) - sunriseAt;
      if (offset < -30 * 60 * 1000 || offset > 3 * 3600 * 1000) return;
      if (!best || hour.cloudHunt > best.score) best = { index, score: hour.cloudHunt };
    });
  }

  return best === null ? null : (best as { index: number; score: number }).index;
};

/**
 * The score below which nothing may be advertised. It is `cloudHuntLabel`'s own
 * boundary for "Khó" rather than a number of its own: an hour the app rates as
 * unlikely cannot be the thing a button, a label or a 5am alarm points at. It is
 * exported because three callers had copied the 35 — a later edit to the label
 * bands would have moved the wording while leaving the alarm still promising.
 */
export const WORTH_PROMISING = 35;

/**
 * Whether that hour has earned the word "nhất".
 *
 * `goldenHourIndex` has no floor: any sunrise inside the 48 hours yields a
 * "best" hour, however bad. At Hồ Tây on 2026-10-04 the button read "Sáng đẹp
 * nhất · 06:00 sáng mai · 0/100" while the hour the visitor was standing in
 * scored 24 — an invitation to a morning emptier than the one they already had.
 * The hour is still the right place to send someone waiting for light; it is the
 * superlative the data does not pay for. 35 is the boundary `cloudHuntLabel`
 * already calls "Khó": an hour the app itself rates as unlikely cannot be the
 * prize. And pointing somewhere else at a score no higher than here is the same
 * claim in a quieter voice — standing in the golden hour already is not.
 */
export const goldenHourStandsOut = (forecast: Forecast, goldenIndex: number, nowIndex: number): boolean => {
  const golden = forecast.hours[goldenIndex];
  if (!golden || golden.cloudHunt < WORTH_PROMISING) return false;

  const now = forecast.hours[nowIndex];
  return goldenIndex === nowIndex || !now || golden.cloudHunt > now.cloudHunt;
};

/**
 * The real sunrise stamp behind an hour cell.
 *
 * The button read "Xem bình minh tới · 05:00 sáng mai" at Hồ Tây on 2026-10-04
 * while `forecast.sunrises` held 05:48 for that morning: it was printing the
 * cell that *contains* sunrise, and an hourly forecast makes every cell a round
 * number. 48 minutes is the difference between arriving in time and arriving to
 * find the light already up, and people set alarms by this number. The cell
 * stays the jump target — it is the only thing carrying weather — so only the
 * clock being read out moves to the sun's own stamp.
 */
export const sunriseInHour = (forecast: Forecast, hourIndex: number): string | null => {
  const hour = forecast.hours[hourIndex];
  if (!hour) return null;

  const stamp = hour.time.slice(0, 13);
  return forecast.sunrises.find((sunrise) => sunrise.slice(0, 13) === stamp) ?? hour.time;
};

const WEATHER_LABELS: [max: number, label: string][] = [
  [0, 'Trời quang'],
  [3, 'Có mây'],
  [48, 'Sương mù'],
  [57, 'Mưa phùn'],
  [67, 'Mưa'],
  [77, 'Tuyết'],
  [82, 'Mưa rào'],
  [99, 'Dông'],
];

export const weatherLabel = (code: number): string => WEATHER_LABELS.find(([max]) => code <= max)?.[1] ?? 'Không rõ';

export const cloudHuntLabel = (score: number): string => {
  if (score >= 75) return 'Rất có cửa';
  if (score >= 55) return 'Có cửa';
  if (score >= WORTH_PROMISING) return 'Hơi khó';
  return 'Khó';
};

export type SelectedHour = { hour: HourPoint; at: Date; isNow: boolean };
