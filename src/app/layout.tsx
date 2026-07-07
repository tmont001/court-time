import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Court Time",
  description:
    "Simple court booking and event roster software for tennis clubs. Less chaos. More tennis.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)",  color: "#111827" },
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
        <div className="w-full min-h-screen bg-white dark:bg-gray-900 motion-safe:transition-colors motion-safe:duration-150">
          {children}
        </div>
      </body>
    </html>
  );
}
