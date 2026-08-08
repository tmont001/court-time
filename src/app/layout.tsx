import type { Metadata, Viewport } from 'next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import SystemThemeSync from '@/components/SystemThemeSync';
import { SITE_URL } from '@/lib/siteUrl';
import './globals.css';

const SITE_DESCRIPTION =
  'Club operations software for tennis clubs — court scheduling, events and programs, lesson coordination, and club administration. Less chaos. More tennis.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Court Time',
  description: SITE_DESCRIPTION,
  // Default, page-agnostic social preview — most public pages override
  // title/description below, but every page inherits this shape so a share
  // is never blank. No og:image yet: no Court Time brand asset exists in
  // this repo, and generating one is a deliberate Phase 32D+ deferral
  // rather than a rushed placeholder (see the production checklist).
  openGraph: {
    type: 'website',
    siteName: 'Court Time',
    title: 'Court Time',
    description: SITE_DESCRIPTION,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary',
    title: 'Court Time',
    description: SITE_DESCRIPTION,
  },
  // Default: public pages are indexable. The authenticated (app) and
  // transactional (auth) route groups override this to noindex — see
  // their own layout.tsx files.
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#111827' },
  ],
};

// Runs synchronously before first paint so the dark class is applied before any
// CSS loads. Eliminates flash-of-wrong-theme on hard refresh.
// Reads localStorage first; falls back to system preference when no saved choice exists.
const themeScript = `(function(){var t=localStorage.getItem('court-time-theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(t===null&&d)){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* suppressHydrationWarning: React ignores class mismatches on <html>
          caused by the blocking theme script running before hydration. */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 antialiased motion-safe:transition-colors motion-safe:duration-150">
        <SystemThemeSync />
        <div className="w-full min-h-screen bg-white dark:bg-gray-900 motion-safe:transition-colors motion-safe:duration-150">
          {children}
        </div>
        <SpeedInsights />
      </body>
    </html>
  );
}
