"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import RequestLessonSheet from "./RequestLessonSheet";
import LessonRequestDetail from "./LessonRequestDetail";
import PaymentStateBadge from "@/components/PaymentStateBadge";
import type { LessonRequestRow } from "./actions";
import { fetchPaymentStates } from "@/app/(app)/admin/payments/actions";
import type { PaymentStateRow } from "@/lib/payments";
import { formatMoney } from "@/lib/money";

interface Pro {
  id: string;
  first_name: string | null;
  last_name:  string | null;
  role:       string;
}

interface Court {
  id:   string;
  name: string;
}

interface LessonType {
  id:                       string;
  name:                     string;
  allowed_durations:        number[] | null;
  pricing_basis:            "flat" | "hourly";
  unit_price_amount_cents:  number | null;
  max_participants:         number;
}

// Phase 34C — Lesson prices are for the ENTIRE lesson, never per player.
// Distinct phrasing from money.ts's formatLessonUnitPrice (used for compact
// dropdown/summary contexts elsewhere) so this overview can say "total"
// explicitly. NULL price is hidden entirely for Members — never "No price
// set" (that's operator-only language).
function formatMemberLessonRate(basis: "flat" | "hourly", unitCents: number | null, currency: string): string | null {
  if (unitCents === null) return null;
  if (unitCents === 0) return "Free";
  const amount = formatMoney(unitCents, currency);
  return basis === "hourly" ? `${amount} total / hour` : `${amount} total / lesson`;
}

interface Props {
  initialRequests: LessonRequestRow[];
  pros:            Pro[];
  courts:          Court[];
  lessonTypes:     LessonType[];
  currency:        string;
  userId:          string;
  clubId:          string;
  clubTimezone:    string;
  /** True when get_club_pros returned an RPC error (not merely an empty list). */
  prosError:       boolean;
  /** True when ?request=1 was present and providers are available — opens sheet on mount. */
  autoOpen:        boolean;
  /** Phase 33F3B: false at a Staff-Managed club — hides the ability to
   * start a NEW lesson request. Resolving an existing request/proposal
   * (RequestCard -> LessonRequestDetail) is unaffected. */
  canRequestNew:   boolean;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    pending:   "bg-amber-100 text-amber-700",
    proposed:  "bg-blue-100 text-blue-700",
    confirmed: "bg-green-100 text-green-700",
    declined:  "bg-red-100 text-red-700",
    withdrawn: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
    cancelled: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
  };
  const cls = map[status] ?? "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400";
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>
      {label}
    </span>
  );
}

function fmt(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: tz, month: "short", day: "numeric", year: "numeric",
  });
}

export default function LessonsClient({
  initialRequests,
  pros,
  courts,
  lessonTypes,
  currency,
  userId,
  clubId,
  clubTimezone,
  prosError,
  autoOpen,
  canRequestNew,
}: Props) {
  const router = useRouter();
  const [showRequest, setShowRequest] = useState(autoOpen);
  const [selected, setSelected]       = useState<LessonRequestRow | null>(null);

  // Phase 34C — the Member's own read-only payment state per confirmed
  // request, via the sanitized batched read boundary. Batched once for
  // every confirmed request on the page, avoiding N+1.
  const [paymentStates, setPaymentStates] = useState<Map<string, PaymentStateRow>>(new Map());
  useEffect(() => {
    const confirmedIds = initialRequests.filter(r => r.status === "confirmed").map(r => r.id);
    if (confirmedIds.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await fetchPaymentStates("lesson_request", confirmedIds);
      if (!cancelled && data) setPaymentStates(new Map(data.map(p => [p.domain_id, p])));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRequests]);

  // Strip ?request=1 from the URL after auto-opening so a browser refresh does
  // not reopen the sheet after the user has submitted or dismissed it.
  useEffect(() => {
    if (autoOpen) {
      router.replace("/my-schedule?tab=lessons", { scroll: false });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active     = initialRequests.filter(r => ["pending", "proposed", "confirmed"].includes(r.status));
  const historical = initialRequests.filter(r => ["declined", "withdrawn", "cancelled"].includes(r.status));

  function handleDone() {
    setShowRequest(false);
    router.refresh();
  }

  function RequestCard({ r }: { r: LessonRequestRow }) {
    const proName    = [r.pro_first_name, r.pro_last_name].filter(Boolean).join(" ") || "Pro";
    const hasProposal = r.status === "proposed" && r.proposed_starts_at;
    return (
      <button
        onClick={() => setSelected(r)}
        className="ct-card mx-0 mb-3 px-4 py-3 w-full text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 active:bg-gray-100 motion-safe:transition-colors motion-safe:duration-100"
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{proName}</span>
          {statusBadge(r.status)}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {r.duration_minutes} min
          {r.proposed_court_name ? ` · ${r.proposed_court_name}` : ""}
          {" · "}Submitted {fmt(r.created_at, clubTimezone)}
        </p>
        {r.status === "pending" && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5 font-medium">
            Awaiting {proName}&rsquo;s response
          </p>
        )}
        {hasProposal && r.proposed_starts_at && (
          <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5 font-medium">
            {r.linked_reservation_id ? "Reschedule proposed" : "Time proposed"} — tap to review
          </p>
        )}
        {r.status === "confirmed" && r.proposed_starts_at && (
          <p className="text-xs text-green-600 dark:text-green-400 mt-0.5 font-medium">
            {new Date(r.proposed_starts_at).toLocaleString("en-US", {
              timeZone: clubTimezone,
              month: "short", day: "numeric",
              hour: "numeric", minute: "2-digit", hour12: true,
            })}
          </p>
        )}
        {r.status === "confirmed" && (
          <PaymentStateBadge state={paymentStates.get(r.id) ?? null} className="mt-1.5" />
        )}
      </button>
    );
  }

  const canRequest = !prosError && pros.length > 0 && canRequestNew;

  return (
    <div className="px-4 pb-8">
      {/* Prominent primary CTA — Phase 34C concrete QA finding: the prior
          header-row button was too hidden. Matches admin/lessons's "+ Book
          Lesson" bar in visual prominence, with Member-appropriate wording
          ("Request a Lesson" — a Member submission is still a request/
          proposal workflow, never a direct booking). */}
      {canRequest && (
        <div className="pt-4">
          <button
            onClick={() => setShowRequest(true)}
            className="w-full py-2.5 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold hover:brightness-110 hover:shadow-sm motion-safe:hover:-translate-y-0.5 active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
          >
            + Request a Lesson
          </button>
        </div>
      )}

      {/* Lesson Rates overview — Phase 34C. Helps a Member understand
          offerings/pricing BEFORE starting a request. Prices are for the
          entire lesson, never per player — see formatMemberLessonRate. */}
      {lessonTypes.length > 0 && (
        <div className="mt-4 rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
          <p className="px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide bg-gray-50 dark:bg-gray-800/60">
            Lesson Rates
          </p>
          {lessonTypes.map(lt => {
            const rate = formatMemberLessonRate(lt.pricing_basis, lt.unit_price_amount_cents, currency);
            return (
              <div key={lt.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{lt.name}</p>
                  {lt.max_participants > 1 && (
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                      Up to {lt.max_participants} players
                    </p>
                  )}
                </div>
                {rate && (
                  <span className="shrink-0 text-sm font-semibold text-gray-900 dark:text-gray-100">{rate}</span>
                )}
              </div>
            );
          })}
          <p className="px-4 py-2 text-[11px] text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-800/60">
            Lesson prices are for the entire lesson, not per player.
          </p>
        </div>
      )}

      {/* Header row */}
      <div className="flex items-center justify-between pt-4 pb-3">
        <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          My Requests
        </p>
      </div>

      {/* Provider lookup error — shown regardless of whether requests exist */}
      {prosError && (
        <div className="ct-card mx-0 mb-3 px-4 py-3 border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            Unable to load Pros
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
            Please refresh the page to try again.
          </p>
          <button
            onClick={() => router.refresh()}
            className="text-xs font-semibold text-amber-700 dark:text-amber-300 mt-2 underline"
          >
            Refresh
          </button>
        </div>
      )}

      {/* Empty state — shown only when there are no requests at all */}
      {initialRequests.length === 0 && !prosError && (
        <div className="flex flex-col items-center justify-center h-48 gap-3 text-center">
          <p className="text-sm text-gray-400 dark:text-gray-500">No lesson requests yet.</p>
          {canRequest ? (
            <button
              onClick={() => setShowRequest(true)}
              className="bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold px-4 py-2 rounded-xl"
            >
              Request a Lesson
            </button>
          ) : (
            <p className="text-xs text-gray-400 dark:text-gray-500 max-w-xs">
              Lesson requests are not available yet because your club has no active Pro available.
            </p>
          )}
        </div>
      )}

      {/* Active requests */}
      {active.length > 0 && (
        <div className="mb-2">
          {active.map((r: LessonRequestRow) => <RequestCard key={r.id} r={r} />)}
        </div>
      )}

      {/* Historical */}
      {historical.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-2 mt-4">
            Past requests
          </p>
          {historical.map((r: LessonRequestRow) => <RequestCard key={r.id} r={r} />)}
        </div>
      )}

      {/* Sheets */}
      {showRequest && (
        <RequestLessonSheet
          pros={pros}
          courts={courts}
          lessonTypes={lessonTypes}
          currency={currency}
          clubId={clubId}
          onClose={() => setShowRequest(false)}
          onDone={handleDone}
        />
      )}

      {selected && (
        <LessonRequestDetail
          request={selected}
          userId={userId}
          clubId={clubId}
          clubTimezone={clubTimezone}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
