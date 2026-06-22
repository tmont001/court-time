// Calendar-specific loading skeleton. Matches CalendarShell structure:
// date strip → court filter chips → time grid with gutter + columns.
// Renders inside layout's {children} — sidebar/bottom-nav already present.
export default function CalendarLoading() {
  return (
    <div className="animate-pulse">

      {/* Header skeleton — matches sticky h-14 Header */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-4 h-14 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <div className="w-8 h-8 rounded bg-gray-200 dark:bg-gray-700 flex-shrink-0" />
        <div className="h-3.5 w-20 rounded-full bg-gray-200 dark:bg-gray-700" />
        <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex-shrink-0" />
      </header>

      {/* Matches max-w-[1440px] wrapper in calendar/page.tsx */}
      <div className="max-w-[1440px] mx-auto w-full">
        <div
          className="flex flex-col overflow-hidden bg-white dark:bg-gray-900"
          style={{ height: "var(--page-fill-height)" }}
        >

          {/* Date strip — 8 circle pills matching w-10 h-10 rounded-full */}
          <div className="flex gap-1.5 px-3 py-2 border-b border-gray-100 dark:border-gray-800 shrink-0">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="w-10 h-10 rounded-full shrink-0 bg-gray-100 dark:bg-gray-800" />
            ))}
          </div>

          {/* Court filter chips — "All" + 5 court chips */}
          <div className="flex gap-2 px-3 py-2 border-b border-gray-100 dark:border-gray-800 shrink-0">
            <div className="h-6 w-8 rounded-full shrink-0 bg-gray-100 dark:bg-gray-800" />
            {[48, 52, 52, 56, 52].map((w, i) => (
              <div key={i} className="h-6 rounded-full shrink-0 bg-gray-100 dark:bg-gray-800" style={{ width: w }} />
            ))}
          </div>

          {/* Time grid */}
          <div className="flex-1 min-h-0 overflow-hidden">

            {/* Sticky court-name header row — 33px to match COURT_HEADER_H constant */}
            <div
              className="flex bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700"
              style={{ height: 33 }}
            >
              {/* Time gutter — 52px matching GUTTER_W */}
              <div className="shrink-0 border-r border-gray-200 dark:border-gray-700" style={{ width: 52 }} />
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="flex-1 flex items-center justify-center border-l border-gray-200 dark:border-gray-700"
                >
                  <div className="h-2.5 w-14 rounded bg-gray-100 dark:bg-gray-800" />
                </div>
              ))}
            </div>

            {/* Time slot rows — 40px each matching MIN_ROW_H */}
            {[...Array(10)].map((_, row) => (
              <div
                key={row}
                className={`flex border-b ${
                  row % 2 === 0
                    ? "border-gray-200 dark:border-gray-700/60"
                    : "border-gray-100 dark:border-gray-800"
                }`}
                style={{ height: 40 }}
              >
                {/* Time label gutter */}
                <div
                  className="shrink-0 flex justify-end items-start pr-1.5 pt-0.5 border-r border-gray-200 dark:border-gray-700"
                  style={{ width: 52 }}
                >
                  {row % 2 === 0 && (
                    <div className="h-2 w-7 rounded bg-gray-100 dark:bg-gray-800" />
                  )}
                </div>
                {/* Court columns */}
                {[...Array(5)].map((_, col) => (
                  <div
                    key={col}
                    className="flex-1 border-l border-gray-100 dark:border-gray-800"
                  />
                ))}
              </div>
            ))}

          </div>
        </div>
      </div>

    </div>
  );
}
