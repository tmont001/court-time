// actionButtonStyles.ts
// Phase 27C.3: shared, page-scoped action-button classes for /events (all
// four tabs — Upcoming, Manage → Events, Manage → Programs, Lessons).
// Consolidates what was previously duplicated/ad hoc styling (bare text
// links, a locally-defined pair of classes in ProgramsManageClient, small
// bordered chips in AdminEventsClient) into one small set of variants.
//
// Deliberately NOT a global design-system component — scoped to this one
// directory, plain exported class strings (matching this codebase's
// existing convention, e.g. AdminEventsClient's own `selectClass`), used
// only by /events' own components. Broader application-wide button
// consistency is out of scope here and left as deferred visual-design
// polish (see the Phase 27C.2 note this supersedes).
//
// Three variants, one consistent size (px-3 py-2, text-xs font-semibold,
// rounded-lg) so hierarchy is communicated by color/fill/border alone —
// never by size:
//   PRIMARY     — the principal positive action on a card or toolbar
//                 (Join, Accept, Rejoin, Preview & Generate, Manage
//                 Sessions, Unarchive, Create Event/Program, Propose a
//                 Time, Create Lesson Request). Accent-filled.
//   SECONDARY   — supporting/navigational actions with no positive-or-
//                 negative charge (View Sessions, View Roster, the
//                 dismiss side of any confirmation, the admin-managed
//                 toggle initiator). Neutral bordered.
//   DESTRUCTIVE — actions that remove, cancel, restrict, or decline
//                 something (Leave, Cancel Event, Archive, Decline/Pass,
//                 Make admin-managed). Red-tinted bordered — a deliberate
//                 tinted-not-solid fill so it reads as clearly red/
//                 destructive without visually overpowering lower-stakes
//                 instances of it (e.g. Pass, repeated down a long list)
//                 the way a solid red fill would.

const BASE =
  "px-3 py-2 rounded-lg text-xs font-semibold " +
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
  "px-2 py-1 rounded-md text-[11px] font-semibold " +
  "text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 " +
  "border border-red-300 dark:border-red-800/60 " +
  "hover:bg-red-100 dark:hover:bg-red-900/40 hover:border-red-400 dark:hover:border-red-700 " +
  "active:scale-95 motion-safe:transition-all motion-safe:duration-150 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 " +
  "disabled:opacity-40 disabled:pointer-events-none";
