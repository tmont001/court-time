import TestSmsSection from "./TestSmsSection";

interface Props {
  emailConfigured: boolean;
  smsConfigured:   boolean;
}

// "Configured" (not "Available") — this row only reflects whether the
// required environment variables are present, not whether the provider
// account is otherwise ready (e.g. toll-free/carrier registration) or
// whether any given message will actually be delivered.
function StatusRow({ label, configured }: { label: string; configured: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
      <span className="inline-flex items-center gap-1.5 text-xs font-medium">
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${configured ? "bg-green-500" : "bg-gray-400 dark:bg-gray-500"}`}
        />
        <span className={configured ? "text-green-700 dark:text-green-400" : "text-gray-500 dark:text-gray-400"}>
          {configured ? "Configured" : "Not configured"}
        </span>
      </span>
    </div>
  );
}

// Phase 31D: consolidates what was previously a "Notifications" section
// containing only Test SMS (no email status, no email test control existed
// before this checkpoint) into one compact, closed-by-default disclosure.
// Uses the native <details>/<summary> element — no client-side state, fully
// keyboard-operable (Enter/Space toggles it) without any JavaScript.
// Server component: emailConfigured/smsConfigured are plain booleans
// computed by the parent page from server-only env-var checks; no
// credential or environment-variable name is ever passed as a prop or
// rendered here.
export default function DeliveryDiagnosticsSection({ emailConfigured, smsConfigured }: Props) {
  return (
    <details className="group rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <summary className="cursor-pointer select-none list-none px-4 py-3 flex items-center justify-between gap-3 text-sm font-medium text-gray-600 dark:text-gray-400">
        <span>Delivery diagnostics</span>
        <span aria-hidden="true" className="text-gray-400 dark:text-gray-500 transition-transform group-open:rotate-180">
          ⌄
        </span>
      </summary>

      <div className="px-4 pb-4 pt-3 space-y-4 border-t border-gray-100 dark:border-gray-800">
        <div className="space-y-2">
          <StatusRow label="Email" configured={emailConfigured} />
          <StatusRow label="SMS" configured={smsConfigured} />
        </div>

        {smsConfigured && (
          <div className="pt-1 border-t border-gray-100 dark:border-gray-800">
            <TestSmsSection />
          </div>
        )}

        <p className="text-xs text-gray-400 dark:text-gray-500">
          A provider accepting a message does not guarantee it reaches the
          recipient&apos;s inbox or phone carrier.
        </p>
      </div>
    </details>
  );
}
