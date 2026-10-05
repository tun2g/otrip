import { getLocation, LOCATION_SLUGS } from '@otrip/world';
import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'otrip';

export const generateStaticParams = async () => LOCATION_SLUGS.map((location) => ({ location }));

/**
 * Sharing a link is the one growth loop this product has, and a link with no
 * preview is a dead link in a Zalo thread. The scene itself cannot be rendered
 * here — no WebGL on the server — so this is a drawn stand-in using the
 * destination's own dawn palette.
 */
export default async function OpengraphImage({ params }: { params: Promise<{ location: string }> }) {
  const recipe = getLocation((await params).location);
  const dawn = recipe?.skies.dawn;

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        position: 'relative',
        background: `linear-gradient(180deg, ${dawn?.zenith ?? '#2b3a66'} 0%, ${dawn?.horizon ?? '#f6b183'} 62%, ${dawn?.cloudLit ?? '#f0f4f9'} 100%)`,
        fontFamily: 'sans-serif',
      }}
    >
      {/* Satori has no clip-path and the CSS border triangle renders as a box,
            so the ridgeline is drawn as plain SVG polygons. */}
      <svg width={1200} height={630} viewBox="0 0 1200 630" style={{ position: 'absolute', top: 0, left: 0 }}>
        <polygon points="-40,480 180,300 330,350 520,480" fill={recipe?.ground.high ?? '#9d957c'} opacity="0.7" />
        <polygon
          points="250,480 470,232 610,300 760,210 980,480"
          fill={recipe?.ground.rock ?? '#8a8175'}
          opacity="0.9"
        />
        <polygon points="620,480 880,268 1010,330 1240,480" fill={recipe?.ground.mid ?? '#7d8757'} />
      </svg>

      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 230,
          background: `linear-gradient(180deg, rgba(255,255,255,0) 0%, ${dawn?.cloudLit ?? '#f0f4f9'} 55%)`,
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', padding: 56, position: 'relative' }}>
        <div style={{ display: 'flex', fontSize: 68, fontWeight: 700, color: '#2b2520' }}>
          {recipe?.name ?? 'otrip'}
        </div>
        <div style={{ display: 'flex', fontSize: 30, color: '#5b5249', marginTop: 8 }}>
          {recipe ? `${recipe.region} · ${recipe.coords.elevation}m` : 'Đi du lịch online cùng nhau'}
        </div>
        <div style={{ display: 'flex', fontSize: 24, color: '#7a6f64', marginTop: 20 }}>
          otrip · thế giới sống theo thời tiết thật của nơi đó
        </div>
      </div>
    </div>,
    size
  );
}
