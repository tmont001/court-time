"use client";

import { useState } from "react";
import {
  type DailySeriesPoint,
  dayDetailLines,
  getChartAxisLabels,
  defaultActiveDayIndex,
} from "./reservationsChart";

interface Props {
  series: DailySeriesPoint[];
}

/**
 * Runtime QA fix #1 (overflow/tooltip architecture): the prior single-
 * server-rendered-function chart put an absolutely-positioned per-bar
 * tooltip INSIDE the horizontally-scrolling track. An out-of-flow
 * descendant that overflows its container's own box still counts toward
 * that container's scrollable area, which produced a spurious horizontal
 * scrollbar even when the bars themselves fit, a spurious vertical
 * scrollbar (the tooltip rendered above the bars via bottom-full), and
 * visible clipping of the tooltip content by the scroll container's own
 * bounds.
 *
 * Fix: the active day's detail is not positioned relative to its bar at
 * all. It's ONE shared, non-absolutely-positioned block rendered in the
 * non-scrolling header region above the track, driven by a single piece of
 * state (which day is active) that hover/focus/tap on any bar updates.
 *
 * Runtime QA fix #2 (visual polish): the active day gets a restrained
 * neutral background wash on its own bar-pair column (using the SAME
 * activeIndex/isActive state hover/focus/click already share) so it's
 * immediately obvious which day the header detail refers to — the Total/
 * Cancelled bar colors themselves are never touched. Per-bar-column sparse
 * date labels (which wrapped into two stacked lines under narrow columns,
 * competing with the bars) are gone entirely, replaced by ONE independent
 * start/midpoint/end orientation axis below the track — not tied to
 * individual columns, so it never conflicts with the bars and needs no
 * placeholder labels for non-labeled days.
 *
 * Runtime QA fix #3 (focus/selection color): the active-day wash and the
 * keyboard focus ring both used to share `accent` — the SAME token the
 * Total bar itself is colored with (`bg-accent`), so a focused/active day
 * visually competed with the data series and read as a generic form-
 * control focus state rather than an analytics selection. The keyboard-
 * only focus-visible ring uses `brand` (Tailwind's `brand` color, `var(
 * --ct-brand)` — Court Time's own fixed brand green, architecturally
 * separate from the club's theme-able `accent` token, see globals.css's
 * own header comment on --ct-brand) instead of `accent`, so it's never the
 * same color as either data series (Total = accent, Cancelled = red)
 * regardless of which theme a club has selected; `dark:focus-visible:
 * ring-brand-tint` swaps in `--ct-brand-tint`, the existing lighter brand
 * derivative already defined specifically for dark surfaces (globals.css),
 * rather than the base brand green, which reads too dark against a dark
 * background. NO raw/invented color is used anywhere here.
 *
 * Runtime QA fix #4 (dark-mode contrast): the persistent active-day wash
 * was originally translucent (bg-gray-100/70 dark:bg-gray-800/70) and, in
 * dark mode, landed too close to the surrounding dark surface color to
 * read as a visible selection at all. Replaced with solid, stronger
 * neutral washes — bg-gray-200 (light) / dark:bg-gray-700 (dark) — chosen
 * for clearer contrast against both light and dark surfaces in both modes,
 * still no ring, still never touching the Total/Cancelled bar colors.
 *
 * This is the one component on /admin/reports that needs client state (for
 * exactly this reason) — the rest of the page stays a Server Component;
 * only this narrow piece is "use client".
 */
export default function ReservationsDailyChart({ series }: Props) {
  const [activeIndex, setActiveIndex] = useState<number | null>(() => defaultActiveDayIndex(series));

  const max = Math.max(1, ...series.map(p => p.total_count));
  const axisLabels = getChartAxisLabels(series);
  const active = activeIndex !== null ? series[activeIndex] : null;
  const activeDetail = active
    ? dayDetailLines(active.local_date, active.total_count, active.cancelled_count)
    : null;

  return (
    <div>
      {/* Non-scrolling header: title + the single active-day detail. A
          compact one-line treatment (date · Total N · Cancelled N · rate) —
          the full four-line block reads better as a per-bar hover/focus
          detail than stacked beside a section title, and one line is far
          more robust across desktop/mobile widths than a wrapping
          multi-line block in a title row. Plain visible text, no aria-live:
          each bar's own aria-label already announces the complete detail
          to assistive tech on focus, so this line exists for sighted users
          only and is never a duplicate announcement. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 mb-2">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-300">Reservations by day</p>
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          {activeDetail ? (
            <>
              <span className="font-semibold text-gray-700 dark:text-gray-200">{activeDetail[0]}</span>
              {" · "}
              {activeDetail[1]}
              {" · "}
              {activeDetail[2]}
              {" · "}
              {activeDetail[3]}
            </>
          ) : (
            "Hover or select a day"
          )}
        </p>
      </div>

      {/* Scrollable region contains ONLY the bar track — no absolutely-
          positioned or otherwise overflowing child, and (since the
          runtime-QA polish pass) no per-column labels either, so it can
          never inflate past its own content and never gets clipped.
          overflow-x only — this content's height is fixed (h-16 bars), so
          overflow-y is deliberately never enabled here. w-max (not a large
          fixed min-width) lets the track size to its actual content — a
          30-day range that fits the available desktop width renders with
          no scrollbar at all; only a genuinely wider range (366-day
          custom, or a narrow mobile viewport) scrolls. */}
      <div className="overflow-x-auto overflow-y-hidden">
        <div className="flex items-end gap-1 w-max px-1">
          {series.map((p, i) => {
            const totalPct = (p.total_count / max) * 100;
            const cancelledPct = (p.cancelled_count / max) * 100;
            const detail = dayDetailLines(p.local_date, p.total_count, p.cancelled_count);
            const isActive = activeIndex === i;
            return (
              <button
                key={p.local_date}
                type="button"
                aria-label={detail.join(", ")}
                aria-pressed={isActive}
                onMouseEnter={() => setActiveIndex(i)}
                onFocus={() => setActiveIndex(i)}
                onClick={() => setActiveIndex(i)}
                className={`h-16 w-4 shrink-0 flex items-end gap-[1px] rounded-md motion-safe:transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:focus-visible:ring-brand-tint focus-visible:ring-offset-1 ${
                  isActive ? "bg-gray-200 dark:bg-gray-700" : ""
                }`}
              >
                {/* Total/Cancelled bar colors are never touched by the
                    active-day treatment above — only the button's own
                    background/ring changes; accent stays accent, red stays
                    red. */}
                <span aria-hidden="true" className="flex-1 h-full flex flex-col justify-end">
                  <span className="w-full rounded-t-sm bg-accent" style={{ height: `${totalPct}%` }} />
                </span>
                <span aria-hidden="true" className="flex-1 h-full flex flex-col justify-end">
                  <span
                    className="w-full rounded-t-sm bg-red-400 dark:bg-red-500"
                    style={{ height: `${cancelledPct}%` }}
                  />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Orientation-only axis — start/midpoint/end, entirely independent
          of the scrolling bar track above (it never scrolls, and never
          claims to point at any specific column). The exact date for
          whichever day is active already appears in the header above, so
          this never needs more than three labels. The midpoint hides below
          the `sm` breakpoint (pure CSS, no viewport JS) so three labels
          never collide on a narrow phone — start and end alone remain
          legible there. */}
      {axisLabels.length > 0 && (
        <div
          className={`flex items-center text-[9px] text-gray-400 dark:text-gray-500 mt-1.5 px-1 ${
            axisLabels.length === 1 ? "justify-center" : "justify-between"
          }`}
        >
          {axisLabels.map((a, idx) => (
            <span key={a.index} className={axisLabels.length === 3 && idx === 1 ? "hidden sm:inline" : undefined}>
              {a.label}
            </span>
          ))}
        </div>
      )}

      <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1.5 flex items-center gap-3">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm bg-accent" /> Total reservations
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm bg-red-400 dark:bg-red-500" /> Cancelled
        </span>
      </p>
    </div>
  );
}
