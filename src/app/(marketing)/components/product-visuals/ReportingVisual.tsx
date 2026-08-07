import ProductFrame from "./ProductFrame";

// Mirrors the real Admin → Reports "Key metrics" tiles (ct-card, text-lg
// bold value + tiny label) and the "Court utilization" row group, using the
// app's actual metric names — no invented revenue, savings, or predictive
// figures. Values are illustrative and never change; only their reveal is
// animated (a staggered appearance, not a change in the numbers).

const KPI_TILES = [
  { label: "Court Utilization", value: "68%" },
  { label: "Session Fill Rate", value: "91%" },
  { label: "Cancellation Rate", value: "4%" },
  { label: "Active Members", value: "24" },
];

export default function ReportingVisual() {
  return (
    <ProductFrame label="Club Overview" sublabel="Last 30 days">

      <p className="mkt-viz-reveal-a text-[9px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
        Key metrics
      </p>
      <div className="mkt-viz-reveal-a grid grid-cols-2 gap-2 mb-4">
        {KPI_TILES.map((t) => (
          <div key={t.label} className="ct-card px-2.5 py-2.5 text-center">
            <p className="text-base font-bold text-gray-900 dark:text-gray-100">{t.value}</p>
            <p className="text-[9px] text-gray-400 dark:text-gray-500 mt-0.5 leading-tight">{t.label}</p>
          </div>
        ))}
      </div>

      <p className="mkt-viz-reveal-b text-[9px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
        Court utilization
      </p>
      <div className="mkt-viz-reveal-b ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden mb-4">
        <div className="px-3 py-2 flex items-center justify-between text-xs">
          <span className="text-gray-700 dark:text-gray-300">Gross utilization</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">68%</span>
        </div>
        <div className="px-3 py-2 flex items-center justify-between text-xs">
          <span className="text-gray-700 dark:text-gray-300">Cancelled reservations</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">6 / 142</span>
        </div>
      </div>

      <div className="mkt-viz-reveal-c rounded-lg border border-gray-100 dark:border-gray-700 px-3 py-2.5 flex items-start gap-2">
        <div className="shrink-0 w-5 h-5 mt-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 flex items-center justify-center text-[10px] font-bold">
          ✓
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-gray-800 dark:text-gray-200">Announcement sent</p>
          <p className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
            "Courts closed Saturday" · Email + in-app
          </p>
        </div>
      </div>
    </ProductFrame>
  );
}
