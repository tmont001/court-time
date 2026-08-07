import ProductFrame from "./ProductFrame";

// Mirrors the real EventDetailSheet: a colored event-type pill (using the
// club's actual event-type color token), the exact "X of Y spots filled ·
// N on waitlist" capacity line, and the real waitlist → offered → confirmed
// participant lifecycle, including the amber "Spot offered / Accept by"
// treatment the app shows for an active offer.

const STATIC_PARTICIPANTS = ["S. Nguyen", "R. Alvarez"];

export default function EventRosterVisual() {
  return (
    <ProductFrame label="Adult Clinic" sublabel="Wed · 6:00–7:30 PM">
      <div className="flex items-center gap-1.5 mb-3">
        <span
          className="inline-block rounded-full px-2.5 py-1 text-[11px] font-semibold text-white"
          style={{ background: "#2E9B5E" }}
        >
          Clinic
        </span>
      </div>

      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Adult Clinic</p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Court 2</p>

      {/* Capacity line — updates only once the participant is Confirmed, matching the real event capacity logic */}
      <div className="relative mt-1 h-4">
        <p className="mkt-viz-stack-1 absolute inset-0 text-xs text-gray-500 dark:text-gray-400">
          9 of 12 spots filled · 1 on waitlist
        </p>
        <p className="mkt-viz-stack-2 absolute inset-0 text-xs text-gray-500 dark:text-gray-400">
          9 of 12 spots filled · 1 on waitlist
        </p>
        <p className="mkt-viz-stack-3 absolute inset-0 text-xs text-gray-500 dark:text-gray-400">
          10 of 12 spots filled.
        </p>
      </div>

      {/* Roster */}
      <div className="mt-3 space-y-1.5">
        {STATIC_PARTICIPANTS.map((name) => (
          <div key={name} className="flex items-center justify-between">
            <span className="text-xs text-gray-700 dark:text-gray-300">{name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
              Confirmed
            </span>
          </div>
        ))}

        {/* Animated participant row */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-700 dark:text-gray-300">T. Brooks</span>
          <span className="relative inline-block w-[70px] h-4">
            <span className="mkt-viz-stack-1 absolute right-0 top-0 text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 whitespace-nowrap">
              Waitlisted
            </span>
            <span className="mkt-viz-stack-2 absolute right-0 top-0 text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 whitespace-nowrap">
              Offered
            </span>
            <span className="mkt-viz-stack-3 absolute right-0 top-0 text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 whitespace-nowrap">
              Confirmed
            </span>
          </span>
        </div>
      </div>

      {/* Active-offer detail — matches the real "Spot offered" amber card, shown only during the Offered phase */}
      <div className="relative mt-3 h-[42px]">
        <div className="mkt-viz-stack-2 absolute inset-0 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-3 py-2">
          <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">Spot offered</p>
          <p className="text-[10px] text-amber-600 dark:text-amber-400">Accept by 6:45 PM</p>
        </div>
      </div>
    </ProductFrame>
  );
}
