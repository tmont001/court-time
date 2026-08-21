// actionButtonStyles.ts
// Phase 34B: promoted from the /events-scoped module (which now re-exports
// from here) so the same compact action-button vocabulary can be reused
// across the Admin pricing surfaces this phase touches (/admin/courts,
// /admin/settings — Event Types, Lesson Types, Pricing) without inventing
// a second visual language. Still deliberately small and hand-picked, not
// a full design system — one consistent size per variant so hierarchy is
// communicated by color/fill/border alone, never by size:
//   PRIMARY              — the principal positive action (Create, Add, Save).
//                           Accent-filled.
//   SECONDARY             — supporting actions with no positive-or-negative
//                           charge (Edit, view/navigate). Neutral bordered.
//   DESTRUCTIVE           — actions that remove, cancel, restrict, decline,
//                           or archive something. Red-tinted bordered — a
//                           deliberate tinted-not-solid fill so it reads as
//                           clearly red/destructive without visually
//                           overpowering lower-stakes repeated instances of
//                           it down a long list the way a solid fill would.
// Each has a COMPACT variant, sized down for a single repeated action
// inline inside a dense list row (a name/price next to a row of small
// status pills), where the full px-3 py-2 size would be disproportionate.
// Still a real bordered/tinted button, never a bare text link.

const BASE =
  "px-3 py-2 rounded-lg text-xs font-semibold " +
  "active:scale-95 motion-safe:transition-all motion-safe:duration-150 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 " +
  "disabled:opacity-40 disabled:pointer-events-none";

const COMPACT_BASE =
  "px-2 py-1 rounded-md text-[11px] font-semibold " +
  "active:scale-95 motion-safe:transition-all motion-safe:duration-150 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 " +
  "disabled:opacity-40 disabled:pointer-events-none";

export const ACTION_BUTTON_PRIMARY =
  BASE +
  " text-white dark:text-gray-900 bg-accent " +
  "hover:brightness-110 hover:shadow-sm motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0 " +
  "focus-visible:ring-accent";

export const ACTION_BUTTON_SECONDARY =
  BASE +
  " text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 " +
  "border border-gray-300 dark:border-gray-600 " +
  "hover:bg-gray-50 dark:hover:bg-gray-700 hover:border-gray-400 dark:hover:border-gray-500 " +
  "focus-visible:ring-gray-400";

export const ACTION_BUTTON_SECONDARY_COMPACT =
  COMPACT_BASE +
  " text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 " +
  "border border-gray-300 dark:border-gray-600 " +
  "hover:bg-gray-50 dark:hover:bg-gray-700 hover:border-gray-400 dark:hover:border-gray-500 " +
  "focus-visible:ring-gray-400";

export const ACTION_BUTTON_DESTRUCTIVE =
  BASE +
  " text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 " +
  "border border-red-300 dark:border-red-800/60 " +
  "hover:bg-red-100 dark:hover:bg-red-900/40 hover:border-red-400 dark:hover:border-red-700 " +
  "focus-visible:ring-red-500";

// Compact destructive variant — same red-tinted border/fill/hover/focus
// treatment as ACTION_BUTTON_DESTRUCTIVE, sized down for a single
// repeated inline action inside dense list rows (e.g. the roster sheet's
// per-participant/per-guest "Remove") where the full px-3 py-2 size would
// be disproportionate next to a name and a row of small status pills.
// Still a real bordered/tinted button, never a bare text link.
export const ACTION_BUTTON_DESTRUCTIVE_COMPACT =
  COMPACT_BASE +
  " text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 " +
  "border border-red-300 dark:border-red-800/60 " +
  "hover:bg-red-100 dark:hover:bg-red-900/40 hover:border-red-400 dark:hover:border-red-700 " +
  "focus-visible:ring-red-500";

// Compact positive variant — same treatment as ACTION_BUTTON_DESTRUCTIVE_COMPACT
// but green, for a compact affirmative admin roster action (e.g. "Force
// Confirm" on an offered/waitlisted participant) that needs to keep its own
// distinct semantic color rather than the shared accent.
export const ACTION_BUTTON_POSITIVE_COMPACT =
  COMPACT_BASE +
  " text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 " +
  "border border-green-300 dark:border-green-800/60 " +
  "hover:bg-green-100 dark:hover:bg-green-900/40 hover:border-green-400 dark:hover:border-green-700 " +
  "focus-visible:ring-green-500";

// Compact informational variant — same treatment, blue, for a compact
// neutral-but-notable admin roster action (e.g. "Offer Spot" on a
// waitlisted participant).
export const ACTION_BUTTON_INFO_COMPACT =
  COMPACT_BASE +
  " text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 " +
  "border border-blue-300 dark:border-blue-800/60 " +
  "hover:bg-blue-100 dark:hover:bg-blue-900/40 hover:border-blue-400 dark:hover:border-blue-700 " +
  "focus-visible:ring-blue-500";

// Compact warning variant — amber, distinct from ACTION_BUTTON_DESTRUCTIVE_
// COMPACT's red. For an action that reduces/restricts something without
// permanently removing it (e.g. Deactivate, as opposed to Delete/Archive).
export const ACTION_BUTTON_WARNING_COMPACT =
  COMPACT_BASE +
  " text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 " +
  "border border-amber-300 dark:border-amber-800/60 " +
  "hover:bg-amber-100 dark:hover:bg-amber-900/40 hover:border-amber-400 dark:hover:border-amber-700 " +
  "focus-visible:ring-amber-500";
