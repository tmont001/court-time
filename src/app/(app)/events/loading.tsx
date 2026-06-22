// Events-specific loading skeleton. Matches events/page.tsx structure:
// page title block → date section header → event cards.
// Renders inside layout's {children} — sidebar/bottom-nav already present.
export default function EventsLoading() {
  return (
    <div className="animate-pulse">

      {/* Header skeleton — matches sticky h-14 Header */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-4 h-14 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <div className="w-8 h-8 rounded bg-gray-200 dark:bg-gray-700 flex-shrink-0" />
        <div className="h-3.5 w-16 rounded-full bg-gray-200 dark:bg-gray-700" />
        <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex-shrink-0" />
      </header>

      <div
        className="overflow-hidden bg-gray-50 dark:bg-gray-900"
        style={{ height: "var(--page-fill-height)" }}
      >
        <div className="md:max-w-2xl md:mx-auto">

          {/* Page title block — matches px-4 pt-5 pb-1 section */}
          <div className="px-4 pt-5 pb-1">
            <div className="h-5 w-40 rounded bg-gray-200 dark:bg-gray-700 mb-2" />
            <div className="h-3 w-64 rounded bg-gray-100 dark:bg-gray-800" />
          </div>

          {/* Date section header */}
          <div className="px-4 pt-5 pb-2">
            <div className="h-3 w-36 rounded bg-gray-100 dark:bg-gray-800" />
          </div>

          {/* Event card skeletons — matches bg-white rounded-xl border px-4 py-3 cards */}
          <div className="px-4 space-y-3">
            {[0, 1, 2].map(i => (
              <div
                key={i}
                className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3"
              >
                {/* Type pill badge */}
                <div className="h-4 w-14 rounded-full bg-gray-200 dark:bg-gray-700 mb-2" />
                {/* Event title */}
                <div className="h-4 w-48 rounded bg-gray-200 dark:bg-gray-700 mb-1.5" />
                {/* Time + courts */}
                <div className="h-3 w-36 rounded bg-gray-100 dark:bg-gray-800 mb-2" />
                {/* Capacity + action button row */}
                <div className="flex items-center justify-between">
                  <div className="h-3 w-24 rounded bg-gray-100 dark:bg-gray-800" />
                  <div className="h-3 w-16 rounded bg-gray-100 dark:bg-gray-800" />
                </div>
              </div>
            ))}
          </div>

        </div>
      </div>

    </div>
  );
}
