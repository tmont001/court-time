import { CORE_FEATURES, PLANS } from "./planData";

// Semantic, single-table comparison — every value below is read from the
// same PLANS/CORE_FEATURES data the cards use, so there is nothing here
// that can drift out of sync with the cards.

function IncludedCell() {
  return (
    <td className="text-center px-3 py-2.5">
      <span aria-hidden="true" className="text-green-600 dark:text-green-400 font-bold">✓</span>
      <span className="sr-only">Included</span>
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
        colSpan={4}
        className="sticky left-0 z-10 bg-gray-50 dark:bg-gray-800/60 text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
      >
        {label}
      </th>
    </tr>
  );
}

const [founding, starter, club] = PLANS;

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
            Feature comparison between the Founding Club, Starter, and Club plans
          </caption>
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700">
              <th
                scope="col"
                className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400"
              >
                Feature
              </th>
              <th
                scope="col"
                className="px-3 py-3 text-xs font-bold text-gray-900 dark:text-gray-100 bg-gray-50 dark:bg-gray-800/80 border-x-2 border-gray-900 dark:border-gray-100"
              >
                Founding Club
                <span className="block font-normal text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                  Current offer
                </span>
              </th>
              <th scope="col" className="px-3 py-3 text-xs font-semibold text-gray-700 dark:text-gray-300">
                Starter
                <span className="block font-normal text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
                  Planned
                </span>
              </th>
              <th scope="col" className="px-3 py-3 text-xs font-semibold text-gray-700 dark:text-gray-300">
                Club
                <span className="block font-normal text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
                  Planned
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">

            <SectionRow label="Pricing and availability" />
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">Monthly price</th>
              <TextCell strong>{founding.monthly}</TextCell>
              <TextCell>{starter.monthly}</TextCell>
              <TextCell>{club.monthly}</TextCell>
            </tr>
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">Annual price</th>
              <TextCell strong>{founding.annual}</TextCell>
              <TextCell>{starter.annual}</TextCell>
              <TextCell>{club.annual}</TextCell>
            </tr>
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">Availability</th>
              <TextCell strong>{founding.availabilityNote}</TextCell>
              <TextCell>{starter.availabilityNote}</TextCell>
              <TextCell>{club.availabilityNote}</TextCell>
            </tr>
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">Intended scale</th>
              <TextCell strong>{founding.intendedScale}</TextCell>
              <TextCell>{starter.intendedScale}</TextCell>
              <TextCell>{club.intendedScale}</TextCell>
            </tr>
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">Per-member fee</th>
              <TextCell strong>{founding.perMemberFee}</TextCell>
              <TextCell>{starter.perMemberFee}</TextCell>
              <TextCell>{club.perMemberFee}</TextCell>
            </tr>

            <SectionRow label="Product" />
            {CORE_FEATURES.map((f) => (
              <tr key={f.key}>
                <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">
                  {f.label}
                </th>
                <IncludedCell />
                <IncludedCell />
                <IncludedCell />
              </tr>
            ))}

            <SectionRow label="Service" />
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">Onboarding</th>
              <TextCell strong>{founding.onboarding}</TextCell>
              <TextCell>{starter.onboarding}</TextCell>
              <TextCell>{club.onboarding}</TextCell>
            </tr>
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">Support</th>
              <TextCell strong>{founding.support}</TextCell>
              <TextCell>{starter.support}</TextCell>
              <TextCell>{club.support}</TextCell>
            </tr>
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-white dark:bg-gray-800 text-left px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 font-normal">Founding price protection</th>
              <TextCell strong>{founding.priceProtection}</TextCell>
              <TextCell>{starter.priceProtection}</TextCell>
              <TextCell>{club.priceProtection}</TextCell>
            </tr>

          </tbody>
        </table>
      </div>
    </div>
  );
}
