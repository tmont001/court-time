"use client";

// ─── Constants ───────────────────────────────────────────────────────────────

const START_HOUR = 8;   // 8 AM
const END_HOUR   = 19;  // 7 PM

const GUTTER_W = 52;  // px — time-label column width
const COL_W    = 80;  // px — each court column width
const ROW_H    = 40;  // px — each 30-min slot height

// ─── Helpers ─────────────────────────────────────────────────────────────────

type TimeSlot = { label: string; isHour: boolean };

function buildTimeSlots(): TimeSlot[] {
  const slots: TimeSlot[] = [];
  for (let h = START_HOUR; h < END_HOUR; h++) {
    const ampm    = h < 12 ? "AM" : "PM";
    const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
    slots.push({ label: `${display}:00 ${ampm}`, isHour: true });
    slots.push({ label: "",                       isHour: false });
  }
  return slots;
}

type DatePill = { day: string; date: number; isToday: boolean };

function buildDateStrip(): DatePill[] {
  const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const today = new Date();
  const pills: DatePill[] = [];
  for (let offset = -2; offset <= 10; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    pills.push({ day: DAY_NAMES[d.getDay()], date: d.getDate(), isToday: offset === 0 });
  }
  return pills;
}

const TIME_SLOTS  = buildTimeSlots();
const DATE_STRIP  = buildDateStrip();

// ─── Types ───────────────────────────────────────────────────────────────────

interface Court {
  id:            string;
  name:          string;
  display_order: number;
}

interface Props {
  courts:    Court[];
  hasError?: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CalendarShell({ courts, hasError }: Props) {
  const gridContentWidth = courts.length * COL_W;
  // Total inner width: gutter + all court columns (at least gutter + 1 placeholder column so the grid is visible even when empty)
  const innerWidth = GUTTER_W + Math.max(gridContentWidth, COL_W);

  return (
    /*
     * Outer container: fills the space between the header (56 px = 3.5 rem)
     * and the fixed bottom nav (64 px = 4 rem). Uses dvh so mobile Chrome's
     * dynamic toolbar doesn't cause overflow.
     */
    <div
      className="flex flex-col overflow-hidden bg-white"
      style={{ height: "calc(100dvh - 56px - 64px)" }}
    >

      {/* ── Date strip ─────────────────────────────────────────────────── */}
      <div className="flex gap-1.5 overflow-x-auto px-3 py-2 border-b border-gray-100 shrink-0 hide-scrollbar">
        {DATE_STRIP.map((d, i) => (
          <div
            key={i}
            className={`flex flex-col items-center justify-center rounded-full shrink-0 w-10 h-10 text-xs leading-tight ${
              d.isToday
                ? "bg-gray-900 text-white font-semibold"
                : "text-gray-500"
            }`}
          >
            <span>{d.day}</span>
            <span>{d.date}</span>
          </div>
        ))}
      </div>

      {/* ── View toggle ────────────────────────────────────────────────── */}
      <div className="flex gap-1.5 px-3 py-2 border-b border-gray-100 shrink-0">
        {["Day", "Week", "My Schedule"].map((v) => (
          <button
            key={v}
            disabled
            className={`px-3 py-1 rounded-full text-xs font-medium ${
              v === "Day"
                ? "bg-gray-900 text-white"
                : "bg-gray-100 text-gray-500"
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      {/* ── Court chips ────────────────────────────────────────────────── */}
      <div className="flex gap-2 px-3 py-2 border-b border-gray-100 overflow-x-auto shrink-0 hide-scrollbar">
        <button
          disabled
          className="shrink-0 px-3 py-1 rounded-full text-xs font-medium bg-gray-900 text-white"
        >
          All
        </button>
        {courts.map((court) => (
          <button
            key={court.id}
            disabled
            className="shrink-0 px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600"
          >
            {court.name}
          </button>
        ))}
      </div>

      {/* ── Empty / error state ────────────────────────────────────────── */}
      {hasError && (
        <p className="mx-4 mt-3 text-xs text-gray-400 shrink-0">
          Unable to load courts. Please try refreshing.
        </p>
      )}

      {!hasError && courts.length === 0 && (
        <p className="mx-4 mt-3 text-xs text-gray-400 shrink-0">
          No courts found. Please check your club setup.
        </p>
      )}

      {/* ── Timeline grid ──────────────────────────────────────────────── */}
      {/*
       * Single scroll container: scrolls both axes.
       * - Court-name header row: sticky top-0 (sticks during vertical scroll)
       * - Time-label column:     sticky left-0 (sticks during horizontal scroll)
       * - Corner cell:           sticky top-0 left-0 z-30 (always fixed)
       */}
      <div className="flex-1 overflow-auto">
        <div style={{ width: innerWidth, minWidth: "100%" }}>

          {/* Court header row */}
          <div
            className="flex bg-white border-b border-gray-200 sticky top-0 z-20"
            style={{ width: innerWidth }}
          >
            {/* Corner: always visible, covers both axes */}
            <div
              className="shrink-0 sticky left-0 z-30 bg-white border-r border-gray-200"
              style={{ width: GUTTER_W }}
            />
            {courts.length > 0 ? (
              courts.map((court) => (
                <div
                  key={court.id}
                  className="shrink-0 text-center text-xs font-medium text-gray-700 py-2 border-l border-gray-200"
                  style={{ width: COL_W }}
                >
                  {court.name}
                </div>
              ))
            ) : (
              /* Placeholder column header so the grid isn't zero-width */
              <div
                className="shrink-0 border-l border-gray-200"
                style={{ width: COL_W }}
              />
            )}
          </div>

          {/* Time rows */}
          {TIME_SLOTS.map((slot, rowIdx) => (
            <div
              key={rowIdx}
              className="flex"
              style={{ height: ROW_H, width: innerWidth }}
            >
              {/* Time label — sticky on horizontal scroll */}
              <div
                className="shrink-0 sticky left-0 z-10 bg-white border-r border-gray-200 flex items-start justify-end pr-1.5"
                style={{ width: GUTTER_W, paddingTop: 3 }}
              >
                {slot.isHour && (
                  <span className="text-[10px] leading-none text-gray-400">
                    {slot.label}
                  </span>
                )}
              </div>

              {/* Court cells */}
              {courts.length > 0 ? (
                courts.map((court, colIdx) => (
                  <div
                    key={court.id}
                    className={`shrink-0 ${colIdx > 0 ? "border-l border-gray-100" : ""} ${
                      slot.isHour ? "border-t border-gray-200" : "border-t border-gray-100"
                    }`}
                    style={{ width: COL_W, height: ROW_H }}
                  />
                ))
              ) : (
                /* Placeholder cell so the grid still draws rows */
                <div
                  className={`flex-1 ${slot.isHour ? "border-t border-gray-200" : "border-t border-gray-100"}`}
                />
              )}
            </div>
          ))}

        </div>
      </div>
    </div>
  );
}
