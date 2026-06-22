// My Schedule-specific loading skeleton. Matches my-schedule/page.tsx structure:
// date section header → schedule item cards (no page-title block on this page).
// Renders inside layout's {children} — sidebar/bottom-nav already present.
export default function MyScheduleLoading() {
  return (
    <div className="animate-pulse">

      {/* Header skeleton — matches sticky h-14 Header */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-4 h-14 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <div className="w-8 h-8 rounded bg-gray-200 dark:bg-gray-700 flex-shrink-0" />
        <div className="h-3.5 w-28 rounded-full bg-gray-200 dark:bg-gray-700" />
        <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex-shrink-0" />
      </header>

      <div
        className="overflow-hidden bg-gray-50 dark:bg-gray-900"
        style={{ height: "var(--page-fill-height)" }}
      >
        <div className="md:max-w-2xl md:mx-auto">

          {/* Date section header — no page-title block on My Schedule */}
          <div className="px-4 pt-5 pb-2">
            <div className="h-3 w-36 rounded bg-gray-100 dark:bg-gray-800" />
          </div>

          {/* Schedule item skeletons — matches mx-4 mb-3 px-4 py-3 rounded-xl cards */}
          {[0, 1, 2].map(i => (
            <div
              key={i}
              className="mx-4 mb-3 px-4 py-3 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 flex items-center justify-between"
            >
              <div className="flex-1 min-w-0">
                {/* Court/event name */}
                <div className="h-4 w-32 rounded bg-gray-200 dark:bg-gray-700 mb-1.5" />
                {/* Time range + duration */}
                <div className="h-3 w-44 rounded bg-gray-100 dark:bg-gray-800" />
              </div>
              {/* Cancel / action label */}
              <div className="h-3 w-12 rounded bg-gray-100 dark:bg-gray-800 ml-4 shrink-0" />
            </div>
          ))}

          {/* Second date group */}
          <div className="px-4 pt-3 pb-2">
            <div className="h-3 w-28 rounded bg-gray-100 dark:bg-gray-800" />
          </div>

          {[0, 1].map(i => (
            <div
              key={i}
              className="mx-4 mb-3 px-4 py-3 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 flex items-start justify-between"
            >
              <div className="flex-1 min-w-0">
                {/* Event type pill */}
                <div className="h-4 w-12 rounded-full bg-gray-200 dark:bg-gray-700 mb-1.5" />
                {/* Event name */}
                <div className="h-4 w-36 rounded bg-gray-200 dark:bg-gray-700 mb-1.5" />
                {/* Time + courts */}
                <div className="h-3 w-40 rounded bg-gray-100 dark:bg-gray-800" />
              </div>
              <div className="h-3 w-10 rounded bg-gray-100 dark:bg-gray-800 ml-4 shrink-0" />
            </div>
          ))}

        </div>
      </div>

    </div>
  );
}
