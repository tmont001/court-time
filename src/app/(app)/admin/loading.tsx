// Generic loading skeleton for admin pages (overview, members, courts, settings, audit-log).
// Matches the shared admin page structure: sticky header + back link + card rows.
// Renders inside layout's {children} — sidebar and bottom nav are already present.
export default function AdminLoading() {
  return (
    <div className="animate-pulse">

      {/* Header skeleton */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-4 h-14 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <div className="w-8 h-8 rounded bg-gray-200 dark:bg-gray-700 flex-shrink-0" />
        <div className="h-3.5 w-20 rounded-full bg-gray-200 dark:bg-gray-700" />
        <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex-shrink-0" />
      </header>

      <div
        className="overflow-hidden"
        style={{ height: "var(--page-fill-height)" }}
      >
        <div className="px-4 pt-3 pb-0 md:max-w-2xl md:mx-auto">
          {/* Back link skeleton */}
          <div className="h-3 w-24 rounded bg-gray-100 dark:bg-gray-800 mb-5" />
        </div>

        <div className="px-4 pt-2 md:max-w-2xl md:mx-auto space-y-4">
          {/* Section label */}
          <div className="h-2.5 w-28 rounded bg-gray-100 dark:bg-gray-800" />

          {/* Card with divider rows */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800">
            {[80, 60, 70, 60, 80].map((w, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3">
                <div className="h-3.5 rounded bg-gray-200 dark:bg-gray-700" style={{ width: w }} />
                <div className="h-3 w-10 rounded bg-gray-100 dark:bg-gray-800" />
              </div>
            ))}
          </div>

          {/* Section label */}
          <div className="h-2.5 w-20 rounded bg-gray-100 dark:bg-gray-800 pt-2" />

          {/* Second card */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800">
            {[60, 72, 56].map((w, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3">
                <div className="h-3.5 rounded bg-gray-200 dark:bg-gray-700" style={{ width: w }} />
                <div className="h-3 w-8 rounded bg-gray-100 dark:bg-gray-800" />
              </div>
            ))}
          </div>
        </div>
      </div>

    </div>
  );
}
