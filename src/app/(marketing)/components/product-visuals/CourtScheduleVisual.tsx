import ProductFrame from "./ProductFrame";

// Mirrors the real /calendar grid: fixed time gutter, court columns, an
// hourly line grid with lighter half-hour lines, and the same block
// treatments the app uses (blue "Your booking", colored event block via the
// club's actual event-type color, hatched maintenance block). Cropped to a
// short 8:00–Noon window across 3 courts rather than a full day.

const GUTTER_W = 34;
const COL_W = 76;
const ROW_H = 26;

const SLOTS = [
  { label: "8 AM", isHour: true },
  { label: "", isHour: false },
  { label: "9 AM", isHour: true },
  { label: "", isHour: false },
  { label: "10 AM", isHour: true },
  { label: "", isHour: false },
  { label: "11 AM", isHour: true },
  { label: "", isHour: false },
];

const COURTS = ["Court 1", "Court 2", "Court 3"];
const GRID_H = SLOTS.length * ROW_H;

export default function CourtScheduleVisual() {
  return (
    <div className="max-w-[280px] mx-auto">
      <ProductFrame label="Court Time" sublabel="Riverside Tennis Club" padded={false}>
        <div style={{ width: GUTTER_W + COL_W * COURTS.length }}>

          {/* Court header row */}
          <div className="flex border-b border-gray-200 dark:border-gray-700">
            <div className="shrink-0 border-r border-gray-200 dark:border-gray-700" style={{ width: GUTTER_W }} />
            {COURTS.map((name) => (
              <div
                key={name}
                className="shrink-0 text-center text-[10px] font-medium text-gray-700 dark:text-gray-300 py-1.5 border-l border-gray-200 dark:border-gray-700"
                style={{ width: COL_W }}
              >
                {name}
              </div>
            ))}
          </div>

          {/* Grid body */}
          <div className="flex" style={{ height: GRID_H }}>

            {/* Time gutter */}
            <div className="relative shrink-0 border-r border-gray-200 dark:border-gray-700" style={{ width: GUTTER_W, height: GRID_H }}>
              {SLOTS.map((slot, i) => (
                <div
                  key={i}
                  className="absolute flex justify-end pr-1"
                  style={{ top: i * ROW_H, width: GUTTER_W }}
                >
                  {slot.isHour && (
                    <span className="text-[8px] leading-none text-gray-400 dark:text-gray-600">{slot.label}</span>
                  )}
                </div>
              ))}
            </div>

            {/* Court 1 — the animated booking */}
            <div className="relative shrink-0 border-l border-gray-200 dark:border-gray-700" style={{ width: COL_W, height: GRID_H }}>
              {SLOTS.map((slot, i) => (
                <div
                  key={i}
                  className={`absolute border-t left-0 right-0 ${slot.isHour ? "border-gray-200 dark:border-gray-700/60" : "border-gray-100 dark:border-gray-800"}`}
                  style={{ top: i * ROW_H, height: ROW_H }}
                >
                  <div className="mx-0.5 my-0.5 h-[calc(100%-4px)] border border-dashed border-gray-200 dark:border-gray-700 rounded-sm" />
                </div>
              ))}
              {/* Highlight pulse, then the reservation block — same cell (slot 2 = 9:00–9:30) */}
              <div
                className="mkt-viz-cell-highlight absolute rounded-sm"
                style={{ top: 2 * ROW_H + 1, height: ROW_H - 2, left: 2, right: 2 }}
              />
              <div
                className="mkt-viz-reservation-block absolute rounded text-[9px] font-medium flex items-center justify-center border-2 border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                style={{ top: 2 * ROW_H + 1, height: ROW_H - 2, left: 2, right: 2 }}
              >
                You
              </div>
            </div>

            {/* Court 2 — a scheduled event, colored via the real event-type token */}
            <div className="relative shrink-0 border-l border-gray-200 dark:border-gray-700" style={{ width: COL_W, height: GRID_H }}>
              {SLOTS.map((slot, i) => (
                <div
                  key={i}
                  className={`absolute border-t left-0 right-0 ${slot.isHour ? "border-gray-200 dark:border-gray-700/60" : "border-gray-100 dark:border-gray-800"}`}
                  style={{ top: i * ROW_H, height: ROW_H }}
                >
                  <div className="mx-0.5 my-0.5 h-[calc(100%-4px)] border border-dashed border-gray-200 dark:border-gray-700 rounded-sm" />
                </div>
              ))}
              <div
                className="absolute rounded text-[9px] font-semibold px-1 pt-0.5 text-white overflow-hidden"
                style={{ top: 2 * ROW_H + 1, height: ROW_H * 2 - 2, left: 2, right: 2, background: "#2E9B5E" }}
              >
                Adult Clinic
              </div>
            </div>

            {/* Court 3 — maintenance block, using the real hatched pattern */}
            <div className="relative shrink-0 border-l border-gray-200 dark:border-gray-700" style={{ width: COL_W, height: GRID_H }}>
              {SLOTS.map((slot, i) => (
                <div
                  key={i}
                  className={`absolute border-t left-0 right-0 ${slot.isHour ? "border-gray-200 dark:border-gray-700/60" : "border-gray-100 dark:border-gray-800"}`}
                  style={{ top: i * ROW_H, height: ROW_H }}
                >
                  <div className="mx-0.5 my-0.5 h-[calc(100%-4px)] border border-dashed border-gray-200 dark:border-gray-700 rounded-sm" />
                </div>
              ))}
              <div
                className="absolute rounded text-[9px] text-gray-500 flex items-center justify-center"
                style={{
                  top: 1 * ROW_H + 1,
                  height: ROW_H * 2 - 2,
                  left: 2,
                  right: 2,
                  background: "repeating-linear-gradient(-45deg,#e5e7eb 0px,#e5e7eb 4px,#f9fafb 4px,#f9fafb 8px)",
                }}
              >
                Net repair
              </div>
            </div>

          </div>
        </div>

        {/* Legend — matches the real calendar legend row */}
        <div className="flex items-center gap-3 px-3 py-2 border-t border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm border-2 border-blue-500 bg-blue-50 dark:bg-blue-900/30" />
            <span className="text-[9px] text-gray-500 dark:text-gray-400">Your booking</span>
          </div>
        </div>
      </ProductFrame>
    </div>
  );
}
