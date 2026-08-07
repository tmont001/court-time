import ProductFrame from "./ProductFrame";

// Mirrors the real lesson-request detail sheet: the same status badge
// (pending/proposed/confirmed, identical colors) and the same detail-row
// layout (ct-card, divide-y, label/value pairs) used across the app's
// sheets. Cycles through the app's actual three lesson-request states.

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  proposed: "bg-blue-100 text-blue-700",
  confirmed: "bg-green-100 text-green-700",
};

function StatusPill({ phase, label }: { phase: "1" | "2" | "3"; label: string }) {
  return (
    <span
      className={`mkt-viz-stack-${phase} absolute inset-0 inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_STYLE[label.toLowerCase()]}`}
    >
      {label}
    </span>
  );
}

export default function LessonWorkflowVisual() {
  return (
    <ProductFrame label="Lesson Request" sublabel="K. Patel · Coach D. Reyes">
      <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
        <div className="px-3 py-2 flex items-center justify-between text-xs">
          <span className="text-gray-500 dark:text-gray-400">Status</span>
          <span className="relative inline-block w-[64px] h-[18px]">
            <StatusPill phase="1" label="Pending" />
            <StatusPill phase="2" label="Proposed" />
            <StatusPill phase="3" label="Confirmed" />
          </span>
        </div>
        <div className="px-3 py-2 flex justify-between text-xs">
          <span className="text-gray-500 dark:text-gray-400">Pro</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">D. Reyes</span>
        </div>
        <div className="px-3 py-2 flex justify-between text-xs">
          <span className="text-gray-500 dark:text-gray-400">Duration</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">60 min</span>
        </div>
      </div>

      {/* Time detail — cross-fades between "awaiting", "proposed", and "confirmed" */}
      <div className="relative mt-3 h-[46px]">
        <div className="mkt-viz-stack-1 absolute inset-0 flex items-center">
          <p className="text-xs text-gray-400 dark:text-gray-500">Awaiting a proposed time from your Pro.</p>
        </div>
        <div className="mkt-viz-stack-2 absolute inset-0 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 px-3 py-2">
          <p className="text-[11px] font-semibold text-blue-700 dark:text-blue-400">Time proposed</p>
          <p className="text-[10px] text-blue-600 dark:text-blue-400">Tue, Aug 12 · 4:00–5:00 PM</p>
        </div>
        <div className="mkt-viz-stack-3 absolute inset-0 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 px-3 py-2">
          <p className="text-[11px] font-semibold text-green-700 dark:text-green-400">Lesson confirmed</p>
          <p className="text-[10px] text-green-600 dark:text-green-400">Tue, Aug 12 · 4:00–5:00 PM · Court 2</p>
        </div>
      </div>
    </ProductFrame>
  );
}
