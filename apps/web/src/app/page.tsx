import { LOCATIONS } from '@otrip/world';
import Link from 'next/link';

import { DestinationMap } from '@/components/ui/destination-map';

export default function HomePage() {
  const locations = Object.values(LOCATIONS);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-3">
        <h1 className="font-display text-4xl leading-tight sm:text-5xl">otrip</h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Đi du lịch online cùng nhau. Mỗi địa danh là một thế giới 3D sinh ra bằng code, sống theo thời tiết và giờ
          thật của chính nơi đó.
        </p>
      </header>

      <section className="grid items-start gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide text-subtle uppercase">Điểm đến</h2>
          <DestinationMap recipes={locations} />
        </div>

        <ul className="grid gap-2">
          {locations.map((location) => (
            <li key={location.slug}>
              <Link
                href={`/${location.slug}`}
                className="flex items-baseline justify-between gap-3 rounded-control border border-border bg-panel/60 px-4 py-3 transition-colors hover:border-accent"
              >
                <span className="font-display text-lg">{location.name}</span>
                <span className="text-sm text-muted-foreground">{location.region}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
