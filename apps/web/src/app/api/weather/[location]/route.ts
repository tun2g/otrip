import { getLocation } from '@otrip/world';
import { NextResponse } from 'next/server';

import { fetchForecast, REVALIDATE_SECONDS } from '@/services/weather';

/**
 * Proxied rather than called from the browser: one cached upstream request
 * serves every visitor of a destination, the quota stays off individual users,
 * and the realtime server can later read the same endpoint so a room shares one
 * sky.
 */
export const GET = async (_request: Request, { params }: { params: Promise<{ location: string }> }) => {
  const recipe = getLocation((await params).location);
  if (!recipe) {
    return NextResponse.json({ error: 'Không có địa danh này' }, { status: 404 });
  }

  try {
    return NextResponse.json(await fetchForecast(recipe), {
      headers: { 'Cache-Control': `public, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=3600` },
    });
  } catch {
    return NextResponse.json({ error: 'Không gọi được nguồn thời tiết' }, { status: 502 });
  }
};
