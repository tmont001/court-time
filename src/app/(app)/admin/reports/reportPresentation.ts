/**
 * Admin UX Checkpoint 1 — Reports UX cleanup. Pure presentation-only
 * helpers with no Supabase/Next import (same "extracted, real-imported,
 * unit-testable" shape as dateRange.ts and reportingDiagnostics.ts in this
 * directory) — this is presentation semantics only, never a change to the
 * underlying reporting RPCs or the numbers they return.
 */

/**
 * A rate computed from a zero-sized sample (e.g. no attendance ever marked,
 * no session capacity in range) renders as "0.0%" from raw math — visually
 * indistinguishable from a genuinely measured zero. `hasSample` must be the
 * exact condition the rate's own denominator was computed from server-side
 * (never a proxy — attendance_marked_count > 0 for attendance/no-show rate,
 * total_capacity > 0 for fill rate) so "—" only ever means "nothing to
 * measure," not "we measured and got zero." One shared helper so every rate
 * on the Reports page applies the same rule instead of a scattered
 * per-section check.
 */
export function formatRateOrUnavailable(pct: number, hasSample: boolean): string {
  return hasSample ? `${pct.toFixed(1)}%` : "—";
}
