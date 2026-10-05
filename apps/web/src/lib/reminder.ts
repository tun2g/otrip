import type { Forecast, HourPoint } from '@otrip/contracts';
import type { LocationRecipe } from '@otrip/world';

import { drawOf } from '@/lib/draw';
import { cloudHuntLabel, WORTH_PROMISING } from '@/lib/forecast';

const pad = (value: number): string => String(value).padStart(2, '0');

/** iCalendar wants UTC stamps as YYYYMMDDTHHMMSSZ. */
const stamp = (date: Date): string =>
  `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(
    date.getUTCMinutes()
  )}00Z`;

const escape = (text: string): string => text.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');

/**
 * A calendar invite instead of a push notification: the hour worth waking for
 * falls before sunrise, which is exactly when nobody is looking at a browser
 * tab. It needs no account, no permission prompt and no server — the file goes
 * straight into whatever calendar the person already wakes up to.
 *
 * Which is why the alarm names this place's own prize: three of the four
 * destinations never render a cloud sea, and an alarm is the one string nobody
 * reads twice. It goes off at five in the morning, having already got someone
 * out of bed.
 */
export const buildReminder = (forecast: Forecast, hour: HourPoint, recipe: LocationRecipe, url: string): string => {
  const draw = drawOf(recipe);

  // The event body carries the score and all three inputs, but nobody opens the
  // event: the alarm is the only line that actually goes off, and it fires ten
  // minutes before the hour to someone already out of bed with nothing left to
  // read. Promising `rising` on a morning the app scores 0/100 is the one lie in
  // this flow that cannot be taken back, so below the bar it reports the number
  // instead. `chance` rather than `noun` for that case: "bình minh trên sông khó
  // lên" says a sunrise might not happen, which is not what a low score means.
  const alarm =
    hour.cloudHunt >= WORTH_PROMISING
      ? `${recipe.name}: ${draw.rising} — ${hour.cloudHunt}/100`
      : `${recipe.name}: cơ hội ${draw.chance} chỉ ${hour.cloudHunt}/100`;

  const start = new Date(Date.parse(`${hour.time}:00Z`) - forecast.utcOffsetSeconds * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//otrip//VN',
    'BEGIN:VEVENT',
    `UID:${recipe.slug}-${hour.time}@otrip`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escape(`${recipe.name} · ${draw.chance} · otrip`)}`,
    `DESCRIPTION:${escape(
      `Dự báo lúc đó: ${draw.chance} ${hour.cloudHunt}/100 (${cloudHuntLabel(hour.cloudHunt)}), độ ẩm ${hour.humidity}%, mây thấp ${hour.lowCloudCover}%.\nMở: ${url}`
    )}`,
    `LOCATION:${escape(`${recipe.name}, ${recipe.region}`)}`,
    `URL:${escape(url)}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT10M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escape(alarm)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return lines.join('\r\n');
};

export const downloadReminder = (calendar: string, filename: string): void => {
  const blob = new Blob([calendar], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};
