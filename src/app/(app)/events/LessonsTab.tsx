"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import LessonProSheet from "./LessonProSheet";
import type { ProLessonRequestRow, ClubPro } from "@/app/(app)/lessons/actions";
import { ACTION_BUTTON_PRIMARY } from "./actionButtonStyles";
import { canAccessOperationsWorkspace, isOperator } from "@/lib/auth/roles";

interface Court {
  id:   string;
  name: string;
}

interface Props {
  initialRequests: ProLessonRequestRow[];
  courts:          Court[];
  userId:          string;
  userRole:        string;
  clubId:          string;
  clubTimezone:    string;
  currency:        string;
  pros?:           ClubPro[];
  onCreateRequest?: () => void;
}

type StatusFilter = "active" | "all";

const ACTIVE_STATUSES = ["pending", "proposed", "confirmed"];

function statusBadge(status: string) {
  const map: Record<string, string> = {
    pending:   "bg-amber-100 text-amber-700",
    proposed:  "bg-blue-100 text-blue-700",
    confirmed: "bg-green-100 text-green-700",
    declined:  "bg-red-100 text-red-700",
    withdrawn: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
    cancelled: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
  };
  const cls   = map[status] ?? "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400";
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

export default function LessonsTab({ initialRequests, courts, userId, userRole, clubId, clubTimezone, currency, pros, onCreateRequest }: Props) {
  const router                    = useRouter();
  const pathname                  = usePathname();
  const searchParams              = useSearchParams();
  const [filter, setFilter]       = useState<StatusFilter>("active");
  const [selected, setSelected]   = useState<ProLessonRequestRow | null>(null);
  const [proposeMode, setProposeMode] = useState(false);
  const [proFilter, setProFilter] = useState<string>("");

  // Use props directly — router.refresh() causes RSC to pass fresh props
  const requests    = initialRequests;
  const activeCount = requests.filter(r => ACTIVE_STATUSES.includes(r.status)).length;

  // Phase 30G: Calendar's pro_lesson block click navigates here with
  // ?lessonId=<request id>, auto-opening that exact request's existing
  // LessonProSheet. `requests` is already the caller's own RPC-scoped list
  // (get_pro_lesson_requests — pro sees only pro_id=auth.uid() rows, admin
  // sees the whole club) — matching against it, rather than an independent
  // lookup, is what makes this authorization-safe: an unrelated pro's
  // requests array never contains another pro's row, so a manually typed
  // lessonId for someone else's lesson simply finds no match. Fires once
  // per lessonId value (via the ref) so it never fights a user's own click
  // on a different card.
  const lessonIdParam = searchParams.get("lessonId");
  const autoOpenAttemptRef = useRef<string | null>(null);
  const supabase = useMemo(() => createClient(), []);

  // Strips lessonId from the URL (preserving tab=lessons and every other
  // param) without adding a new history entry, and re-arms the attempt ref
  // so clicking the same lesson block again from Calendar (or retrying the
  // same manually-typed URL after the underlying lesson becomes eligible)
  // can re-open it.
  function clearLessonIdParam() {
    autoOpenAttemptRef.current = null;
    const params = new URLSearchParams(searchParams.toString());
    if (!params.has("lessonId")) return;
    params.delete("lessonId");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  useEffect(() => {
    if (!lessonIdParam) return;
    if (autoOpenAttemptRef.current === lessonIdParam) return;
    autoOpenAttemptRef.current = lessonIdParam;

    const match = requests.find(r => r.id === lessonIdParam);
    if (!match || !match.linked_reservation_id) { clearLessonIdParam(); return; }

    const statusEligible =
      match.status === "confirmed" ||
      (match.status === "proposed" && match.linked_reservation_id !== null);
    if (!statusEligible) { clearLessonIdParam(); return; }

    let cancelled = false;

    (async () => {
      // Phase 30G correction: lesson_requests.proposed_starts_at is not
      // authoritative for a pending reschedule — it holds the new
      // candidate, not the original lesson's time. The linked reservation
      // itself is the only reliable source of "is the original lesson
      // still confirmed, same-club, and in the future." Validated
      // directly here — never inferred from names, notes, owner_user_id,
      // or a matching court/time.
      const { data: reservation } = await supabase
        .from("reservations")
        .select("id, club_id, reason, status, starts_at")
        .eq("id", match.linked_reservation_id as string)
        .maybeSingle();

      if (cancelled) return;

      const reservationEligible =
        !!reservation &&
        reservation.club_id === clubId &&
        reservation.reason === "pro_lesson" &&
        reservation.status === "confirmed" &&
        new Date(reservation.starts_at) > new Date();

      if (!reservationEligible) {
        clearLessonIdParam();
        return;
      }

      setSelected(match);
      setProposeMode(false);
    })();

    return () => { cancelled = true; };
  }, [lessonIdParam, requests]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive unique pro options from request data (operator filter — admin/staff)
  const proOptions = isOperator(userRole)
    ? Array.from(
        new Map(requests.map(r => [r.pro_id, r])).values()
      ).map(r => ({ id: r.pro_id, name: [r.pro_first_name, r.pro_last_name].filter(Boolean).join(" ") || "Pro" }))
    : [];

  const filtered = requests
    .filter(r => filter === "active" ? ACTIVE_STATUSES.includes(r.status) : true)
    .filter(r => proFilter ? r.pro_id === proFilter : true);

  const visible = filtered;

  const canPropose = (r: ProLessonRequestRow) =>
    r.status === "pending" &&
    (isOperator(userRole) || (userRole === "pro" && r.pro_id === userId));

  // Phase 30E: a confirmed lesson (start a reschedule), or an already-
  // pending reschedule proposal (status='proposed' with linked_reservation_id
  // set — revise it again before the member responds). Same authorization
  // as canPropose — Admin/Staff (isOperator) or the assigned Pro only.
  // Phase 33D1: also requires member_claimed — propose_lesson_time's
  // negotiation cycle requires an authenticated Member to respond, and is
  // now server-guarded (member_has_no_account) against a no-account
  // Member's lesson. Admin uses "Edit Lesson" (LessonProSheet) for those
  // instead — a direct edit, not a negotiation.
  // Phase 34A: widened to isOperator — 0135 lifted propose_lesson_time's
  // Staff reschedule block, matching this. admin_update_member_lesson
  // (the no-account-Member direct-edit path, unrelated to this button)
  // remains admin-only and deferred.
  const canReschedule = (r: ProLessonRequestRow) =>
    r.member_claimed &&
    (r.status === "confirmed" || (r.status === "proposed" && r.linked_reservation_id !== null)) &&
    (isOperator(userRole) || (userRole === "pro" && r.pro_id === userId));

  return (
    <div className="px-4 pb-8 pt-2">
      {/* Operator (Admin/Staff) or Pro: book a lesson directly */}
      {(canAccessOperationsWorkspace(userRole)) && onCreateRequest && (
        <div className="mb-3">
          <button
            onClick={onCreateRequest}
            className="w-full py-2.5 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold hover:brightness-110 hover:shadow-sm motion-safe:hover:-translate-y-0.5 active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
          >
            + Book Lesson
          </button>
        </div>
      )}

      {/* Filter row */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex p-1 gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg">
          <button
            onClick={() => setFilter("active")}
            className={`px-3 py-1 rounded-md text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
              filter === "active"
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700"
            }`}
          >
            Active {activeCount > 0 && `(${activeCount})`}
          </button>
          <button
            onClick={() => setFilter("all")}
            className={`px-3 py-1 rounded-md text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
              filter === "all"
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700"
            }`}
          >
            All
          </button>
        </div>
        {isOperator(userRole) && proOptions.length > 1 && (
          <select
            value={proFilter}
            onChange={e => setProFilter(e.target.value)}
            className="ct-input text-base md:text-xs py-1 h-8 flex-1 min-w-0"
          >
            <option value="">All pros</option>
            {proOptions.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Empty state */}
      {visible.length === 0 && (
        <div className="flex flex-col items-center justify-center h-40">
          <p className="text-sm text-gray-400 dark:text-gray-500">
            {filter === "active" ? "No active lesson requests." : "No lesson requests yet."}
          </p>
        </div>
      )}

      {/* Request cards */}
      {visible.map(r => {
        const memberName = [r.member_first_name, r.member_last_name].filter(Boolean).join(" ") || "Member";
        const proName    = [r.pro_first_name, r.pro_last_name].filter(Boolean).join(" ") || "Pro";
        const isActive   = ACTIVE_STATUSES.includes(r.status);

        return (
          <div
            key={r.id}
            role="button"
            tabIndex={0}
            onClick={() => { setSelected(r); setProposeMode(false); }}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { setSelected(r); setProposeMode(false); } }}
            className="ct-card mx-0 mb-3 px-4 py-3 w-full text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 active:bg-gray-100 motion-safe:transition-colors motion-safe:duration-100 cursor-pointer"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                {memberName}
                {!r.member_claimed && (
                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                    No account yet
                  </span>
                )}
              </span>
              {statusBadge(r.status)}
            </div>
            {isOperator(userRole) && (
              <p className="text-xs text-gray-400 dark:text-gray-500 mb-0.5">with {proName}</p>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {r.duration_minutes} min
              {r.preferred_court_name ? ` · ${r.preferred_court_name}` : ""}
              {" · "}Submitted {fmt(r.created_at, clubTimezone)}
            </p>

            {r.status === "pending" && isActive && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5 font-medium">
                Awaiting your response
              </p>
            )}
            {r.status === "proposed" && r.proposed_starts_at && (
              <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5 font-medium">
                {r.linked_reservation_id ? "Reschedule proposed" : "Proposed"} for {new Date(r.proposed_starts_at).toLocaleString("en-US", {
                  timeZone: clubTimezone, month: "short", day: "numeric",
                  hour: "numeric", minute: "2-digit", hour12: true,
                })} — awaiting member
              </p>
            )}
            {r.status === "confirmed" && r.proposed_starts_at && (
              <p className="text-xs text-green-600 dark:text-green-400 mt-0.5 font-medium">
                {new Date(r.proposed_starts_at).toLocaleString("en-US", {
                  timeZone: clubTimezone, month: "short", day: "numeric",
                  hour: "numeric", minute: "2-digit", hour12: true,
                })}
              </p>
            )}

            {(canPropose(r) || canReschedule(r)) && (
              <div
                className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700/50"
                onClick={e => e.stopPropagation()}
              >
                <button
                  onClick={() => { setSelected(r); setProposeMode(true); }}
                  className={`w-full md:w-auto ${ACTION_BUTTON_PRIMARY}`}
                >
                  {canPropose(r)
                    ? "Propose a Time"
                    : r.status === "proposed"
                    ? "Revise Proposed Time"
                    : "Propose New Time"}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Detail sheet */}
      {selected && (
        <LessonProSheet
          request={selected}
          courts={courts}
          userId={userId}
          clubId={clubId}
          clubTimezone={clubTimezone}
          currency={currency}
          userRole={userRole}
          pros={pros}
          initialMode={proposeMode ? "propose" : undefined}
          onClose={() => { setSelected(null); setProposeMode(false); clearLessonIdParam(); router.refresh(); }}
        />
      )}
    </div>
  );
}
