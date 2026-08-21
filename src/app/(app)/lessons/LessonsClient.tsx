"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import RequestLessonSheet from "./RequestLessonSheet";
import LessonRequestDetail from "./LessonRequestDetail";
import type { LessonRequestRow } from "./actions";

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
      </button>
    );
  }

  const canRequest = !prosError && pros.length > 0 && canRequestNew;

  return (
    <div className="px-4 pb-8">
      {/* Header row */}
      <div className="flex items-center justify-between pt-4 pb-3">
        <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          My Requests
        </p>
        {canRequest && (
          <button
            onClick={() => setShowRequest(true)}
            className="bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs font-semibold px-3 py-1.5 rounded-lg"
          >
            + Request Lesson
          </button>
        )}
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
