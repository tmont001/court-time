import { STANDARD_TIERS, STAFF_MANAGED_FEATURES, CONNECTED_FEATURES } from "./planData";

// Phase 34G-A2 — rewritten around the two STANDARD tiers (Staff-Managed,
// Connected), not the prior Founding Club/Starter/Club 3-column layout.
// The Product section is now split into two sub-groups so the table
// itself explains WHY Connected costs more: every Staff-Managed feature is
// included on both columns, but the Member self-service group is checked
// ONLY under Connected — a real, executable difference (member_self_
// service, 0123), never a cosmetic one. Court Time Payments gets its own
// dedicated row below Product, marked as an optional add-on available
// only with Connected — never a plain "included" checkmark on either
// column, since it is not bundled by default on Connected either.

function IncludedCell() {
  return (
    <td className="text-center px-3 py-2.5">
      <span aria-hidden="true" className="text-green-600 dark:text-green-400 font-bold">✓</span>
      <span className="sr-only">Included</span>
    </td>
  );
}

function NotIncludedCell() {
  return (
    <td className="text-center px-3 py-2.5">
      <span aria-hidden="true" className="text-gray-300 dark:text-gray-600">—</span>
      <span className="sr-only">Not included</span>
    </td>
  );
}

function TextCell({ children, strong = false }: { children: React.ReactNode; strong?: boolean }) {
  return (
    <td
      className={`text-center px-3 py-2.5 text-xs ${
        strong ? "font-medium text-gray-900 dark:text-gray-100" : "text-gray-600 dark:text-gray-300"
      }`}
    >
      {children}
    </td>
  );
}

function SectionRow({ label }: { label: string }) {
  return (
    <tr className="bg-gray-50 dark:bg-gray-800/60">
      <th
        scope="colgroup"
        colSpan={3}
        className="sticky left-0 z-10 bg-gray-50 dark:bg-gray-800/60 text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
      >
        {label}
      </th>
    </tr>
  );
}

const [staffManaged, connected] = STANDARD_TIERS;

export default function ComparisonTable() {
  return (
    <div>
      <p className="lg:hidden text-xs text-gray-400 dark:text-gray-500 mb-2 text-center">
        Swipe to compare plans →
      </p>
      <div
        role="region"
        aria-label="Plan comparison table"
        tabIndex={0}
        className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700"
      >
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Feature comparison between the Staff-Managed and Connected plans
          </caption>
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700">
              <th
                scope="col"
                className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400"
              >
                Feature
              </th>
              <th scope="col" className="px-3 py-3 text-xs font-semibold text-gray-700 dark:text-gray-300">
                Staff-Managed
              </th>
              <th
                scope="col"
                className="px-3 py-3 text-xs font-bold text-gray-900 dark:text-gray-100 bg-gray-50 dark:bg-gray-800/80 border-x-2 border-brand"
              >
                Connected
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">

            <SectionRow label="Pricing" />
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">Monthly price</th>
              <TextCell>{staffManaged.monthly}</TextCell>
              <TextCell strong>{connected.monthly}</TextCell>
            </tr>
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">Annual price</th>
              <TextCell>{staffManaged.annual}</TextCell>
              <TextCell strong>{connected.annual}</TextCell>
            </tr>
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">Per-member fee</th>
              <TextCell>{staffManaged.perMemberFee}</TextCell>
              <TextCell strong>{connected.perMemberFee}</TextCell>
            </tr>

            <SectionRow label="Staff-Managed — included on both plans" />
            {STAFF_MANAGED_FEATURES.map((f) => (
              <tr key={f.key}>
                <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">
                  {f.label}
                </th>
                <IncludedCell />
                <IncludedCell />
              </tr>
            ))}

            <SectionRow label="Connected adds — Member self-service" />
            {CONNECTED_FEATURES.map((f) => (
              <tr key={f.key}>
                <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">
                  {f.label}
                </th>
                <NotIncludedCell />
                <IncludedCell />
              </tr>
            ))}

            <SectionRow label="Court Time Payments" />
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">
                Member online Pay Now (optional add-on)
              </th>
              <TextCell>Not available</TextCell>
              <TextCell strong>Optional add-on</TextCell>
            </tr>

          </tbody>
        </table>
      </div>
    </div>
  );
}
