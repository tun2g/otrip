import { LOCATIONS } from '../packages/world/src/index.ts';
import { drawOf } from '../apps/web/src/lib/draw.ts';

const SLUGS = ['ta-xua', 'hoi-an', 'trang-an', 'ho-tay'];

const forecast = { utcOffsetSeconds: 7 * 3600 } as never;
const hour = {
  time: '2026-10-05T05:00',
  cloudHunt: 24,
  humidity: 93,
  lowCloudCover: 62,
  weatherCode: 45,
  temperature: 19,
  windSpeed: 4,
} as never;

const { buildReminder } = await import('../apps/web/src/lib/reminder.ts');
const { postcardMark, postcardPlace } = await import('../apps/web/src/lib/postcard.ts');

const field = (ics: string, key: string): string[] =>
  ics
    .split('\r\n')
    .filter((line) => line.startsWith(`${key}:`))
    .map((line) => line.slice(key.length + 1));

const BANNED = ['săn mây', 'Săn mây', 'biển mây', 'Biển mây'];

console.log('═══ 1. drawOf() across all four destinations ═══');
for (const slug of SLUGS) {
  const recipe = LOCATIONS[slug]!;
  const ics = buildReminder(forecast, hour, recipe, `https://otrip.vn/${slug}`);
  const descriptions = field(ics, 'DESCRIPTION');
  const card = { recipe, when: '05:00 sáng mai', weather: 'Sương mù · 19°C', preset: 'that' as const, cloudHunt: 24 };

  console.log(`\n### ${slug}  (draw.chance = "${drawOf(recipe).chance}")`);
  console.log(`  .ics SUMMARY      : ${field(ics, 'SUMMARY')[0]}`);
  console.log(`  .ics DESCRIPTION  : ${descriptions[0]}`);
  console.log(`  .ics VALARM (5am) : ${descriptions[1]}`);
  console.log(`  postcard mark     : ${postcardMark(card)}`);

  const subject = `${ics}\n${postcardMark(card)}\n${postcardPlace(card)}`;
  const hits = BANNED.filter((word) => subject.includes(word));
  const ok = slug === 'ta-xua' ? hits.length > 0 : hits.length === 0;
  console.log(`  cloud-sea wording : ${hits.length ? hits.join(', ') : 'none'} — ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
}

console.log('\n\n═══ 2. postcard caption: preset × missing score ═══');
const recipe = LOCATIONS['ho-tay']!;
const CASES: [string, 'that' | 'bao' | 'dem-trang', number | null][] = [
  ['real sky, score known (unchanged)', 'that', 24],
  ['real sky, no forecast hour', 'that', null],
  ['Bão preset, score known', 'bao', 24],
  ['Đêm trăng preset, no forecast hour', 'dem-trang', null],
];

for (const [name, preset, cloudHunt] of CASES) {
  const card = { recipe, when: '05:00 sáng mai', weather: 'Trời quang · 26°C', preset, cloudHunt };
  console.log(`\n### ${name}`);
  console.log(`  left  : ${postcardPlace(card)}`);
  console.log(`  right : ${postcardMark(card)}`);

  const caption = `${postcardPlace(card)} ${postcardMark(card)}`;
  const problems: string[] = [];
  if (cloudHunt === null && caption.includes('/100')) problems.push('invented a score');
  if (preset !== 'that' && !caption.includes('mô phỏng')) problems.push('simulated sky not admitted');
  if (preset !== 'that' && caption.includes('Trời quang')) problems.push('real forecast captions a fake sky');
  if (preset === 'that' && caption.includes('mô phỏng')) problems.push('real sky marked simulated');
  console.log(`  check : ${problems.length ? `FAIL — ${problems.join('; ')}` : 'OK'}`);
  if (problems.length) process.exitCode = 1;
}

console.log('\n\n═══ 3. VALARM — the only line that actually goes off ═══');
const SCORES: [string, number][] = [
  ['low morning (the app itself says Khó)', 0],
  ['just under the bar', 34],
  ['at the bar', 35],
  ['good morning', 78],
];

for (const [name, cloudHunt] of SCORES) {
  console.log(`\n### ${name} — cloudHunt ${cloudHunt}`);
  for (const slug of SLUGS) {
    const r = LOCATIONS[slug]!;
    const ics = buildReminder(forecast, { ...(hour as object), cloudHunt } as never, r, `https://otrip.vn/${slug}`);
    const valarm = field(ics, 'DESCRIPTION')[1]!;
    const promises = valarm.includes(drawOf(r).rising);
    const ok = cloudHunt >= 35 ? promises : !promises && valarm.includes(`${cloudHunt}/100`);
    console.log(`  ${slug.padEnd(9)} ${valarm.padEnd(52)} ${ok ? 'OK' : 'FAIL'}`);
    if (!ok) process.exitCode = 1;
    if (!valarm.includes(r.name)) {
      console.log(`  ${' '.repeat(9)} FAIL — alarm does not say where`);
      process.exitCode = 1;
    }
  }
}
