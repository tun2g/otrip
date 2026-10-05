import type { Metadata, Viewport } from 'next';
import { Be_Vietnam_Pro, Nunito } from 'next/font/google';

import './globals.css';

const nunito = Nunito({
  subsets: ['latin', 'vietnamese'],
  variable: '--font-nunito',
  display: 'swap',
});

const beVietnam = Be_Vietnam_Pro({
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '600'],
  variable: '--font-be-vietnam',
  display: 'swap',
});

export const viewport: Viewport = {
  themeColor: '#0b1020',
  colorScheme: 'dark',
};

export const metadata: Metadata = {
  // Without this the share-card URL resolves against localhost, so every link
  // posted from production would point at a machine nobody else can reach.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: {
    default: 'otrip — đi du lịch online cùng nhau',
    template: '%s · otrip',
  },
  description:
    'Bản đồ Việt Nam dựng bằng code. Mỗi địa danh là một thế giới 3D sống theo thời tiết và giờ thật của chính nơi đó.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={`${nunito.variable} ${beVietnam.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
