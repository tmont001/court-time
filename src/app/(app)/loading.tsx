// Instant loading skeleton for all (app) routes.
// Renders inside layout's {children} slot — sidebar and bottom nav are
// already present from the layout. Shown during client-side navigation
// until the target page's Server Component finishes rendering.
export default function AppLoading() {
  return (
    <div className="animate-pulse">

      {/* Header skeleton — mirrors the sticky h-14 Header component */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-4 h-14 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <div className="w-8 h-8 rounded bg-gray-200 dark:bg-gray-700 flex-shrink-0" />
        <div className="h-3.5 w-24 rounded-full bg-gray-200 dark:bg-gray-700" />
        <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex-shrink-0" />
      </header>

      {/* Content area — same height as real pages so no layout shift */}
      <div
        className="overflow-hidden"
        style={{ height: "var(--page-fill-height)" }}
      >
        <div className="px-4 pt-5 md:max-w-2xl md:mx-auto">
          {/* Page title block */}
          <div className="h-5 w-40 rounded bg-gray-200 dark:bg-gray-700 mb-2" />
          <div className="h-3 w-56 rounded bg-gray-100 dark:bg-gray-800" />

          {/* Content card placeholders */}
          <div className="mt-6 space-y-3">
            <div className="h-20 rounded-xl bg-gray-100 dark:bg-gray-800" />
            <div className="h-16 rounded-xl bg-gray-100 dark:bg-gray-800" />
            <div className="h-20 rounded-xl bg-gray-100 dark:bg-gray-800" />
          </div>
        </div>
      </div>

    </div>
  );
}
