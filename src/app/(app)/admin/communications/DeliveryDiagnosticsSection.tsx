import TestSmsSection from "./TestSmsSection";

interface DeliveryFailure {
  channel:    string;
  created_at: string;
}

interface Props {
  emailConfigured: boolean;
  smsConfigured:   boolean;
  // Admin IA Checkpoint 4 (D1) — the detailed failure history previously
  // duplicated on /admin/overview now lives only here; Overview keeps a
  // lightweight count + a link to this tab. failuresUnavailable mirrors
  // Overview's own sectionFailed.deliveries flag (the notification_
  // deliveries query itself failed, as distinct from "zero failures").
  failureCount:        number;
  failureDetails:      DeliveryFailure[];
  failuresUnavailable: boolean;
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

function formatRelativeAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return "< 1 hour ago";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Admin IA Checkpoint 4 — Diagnostics is now its own dedicated
// /admin/communications?tab=diagnostics destination rather than one closed-
// by-default disclosure buried among several unrelated Settings sections
// (the Phase 31D <details> treatment this component used on Settings), so
// everything here renders open/always-visible instead.
export default function DeliveryDiagnosticsSection({
  emailConfigured,
  smsConfigured,
  failureCount,
  failureDetails,
  failuresUnavailable,
}: Props) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3.5 space-y-2">
        <StatusRow label="Email" configured={emailConfigured} />
        <StatusRow label="SMS" configured={smsConfigured} />
      </div>

      {smsConfigured && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3.5">
          <TestSmsSection />
        </div>
      )}

      <div className="space-y-2">
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3.5 flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Delivery failures (48 h)
          </span>
          {failuresUnavailable
            ? <span className="text-xs text-orange-500">Unavailable</span>
            : failureCount === 0
              ? <span className="text-xs font-medium text-green-600 dark:text-green-400">None</span>
              : <span className="text-xs font-semibold text-red-600 dark:text-red-400">{failureCount}</span>}
        </div>

        {!failuresUnavailable && failureDetails.length > 0 && (
          <div className="space-y-1">
            {failureDetails.map((f, i) => (
              <div
                key={i}
                className="ct-card px-3 py-2 flex items-center justify-between text-xs text-red-600 dark:text-red-400"
              >
                <span className="font-medium uppercase">{f.channel}</span>
                <span className="text-gray-400 dark:text-gray-500">{formatRelativeAge(f.created_at)}</span>
              </div>
            ))}
            {failureCount > failureDetails.length && (
              <p className="text-xs text-gray-400 dark:text-gray-500 px-1">
                … and {failureCount - failureDetails.length} more.
              </p>
            )}
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500">
        A provider accepting a message does not guarantee it reaches the
        recipient&apos;s inbox or phone carrier.
      </p>
    </div>
  );
}
