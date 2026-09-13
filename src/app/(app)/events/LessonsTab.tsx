"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import LessonProSheet from "./LessonProSheet";
import type { ProLessonRequestRow, ClubPro } from "@/app/(app)/lessons/actions";
import { ACTION_BUTTON_PRIMARY, ACTION_BUTTON_SECONDARY, ACTION_BUTTON_DESTRUCTIVE } from "./actionButtonStyles";
import { canAccessOperationsWorkspace, isOperator } from "@/lib/auth/roles";
import { lessonDependsOnLiveReservation, isPastConfirmedLesson } from "@/lib/lessons/lessonAccess";

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

type StatusFilter = "active" | "past" | "all";

const ACTIVE_STATUSES = ["pending", "proposed", "confirmed"];

// Phase 38A: a request counts as "Active" for pending/proposed regardless of
// any date (those aren't tied to a definite scheduled event yet), and for
// confirmed only when its effective lesson start hasn't passed. "Past" is
// the complementary confirmed-and-elapsed case. Declined/cancelled/withdrawn
// requests are neither — they only ever appear under "All", unchanged from
// before this phase.
function isActiveRequest(r: Pick<ProLessonRequestRow, "status" | "proposed_starts_at">): boolean {
  if (!ACTIVE_STATUSES.includes(r.status)) return false;
  if (r.status !== "confirmed") return true;
  return !isPastConfirmedLesson(r.status, r.proposed_starts_at);
}

function isPastRequest(r: Pick<ProLessonRequestRow, "status" | "proposed_starts_at">): boolean {
  return r.status === "confirmed" && isPastConfirmedLesson(r.status, r.proposed_starts_at);
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
  // Phase 38A: generalized from the prior boolean proposeMode so a card
  // button can jump directly into any of the sheet's existing modes
  // (propose/reassign/cancel) — never a second implementation of any of
  // them, just which one LessonProSheet's own initialMode opens into.
  const [initialSheetMode, setInitialSheetMode] = useState<"propose" | "cancel" | "reassign" | undefined>(undefined);
  const [proFilter, setProFilter] = useState<string>("");

  // Use props directly — router.refresh() causes RSC to pass fresh props
  const requests    = initialRequests;
  const activeCount = requests.filter(isActiveRequest).length;
  const pastCount   = requests.filter(isPastRequest).length;

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

    // Authorization: `match` inside `requests` (the caller's own RPC-
    // scoped rows) is the ONLY boundary — no match (unauthorized,
    // nonexistent, reassigned away) means nothing opens, regardless of
    // what follows below.
    const match = requests.find(r => r.id === lessonIdParam);
    if (!match) { clearLessonIdParam(); return; }

    // Phase 36D correction: only a state whose CURRENT actionable
    // workflow actually depends on an active linked reservation —
    // confirmed, or a proposed RESCHEDULE of an already-confirmed lesson
    // (status='proposed' WITH linked_reservation_id already set) — needs
    // the live re-validation below. Phase 30G's own reasoning still
    // applies exactly to that pair: lesson_requests.proposed_starts_at is
    // not authoritative for a pending reschedule (it holds the new
    // candidate, not the original lesson's time), so the linked
    // reservation itself is the only reliable source of whether the
    // original lesson is still confirmed, same-club, and in the future.
    //
    // Every OTHER state — pending, a FRESH proposed (no
    // linked_reservation_id yet — the normal "Pro proposed a time,
    // member hasn't responded" case), declined, cancelled, withdrawn —
    // has no active reservation dependency at all: this is the exact
    // same condition canReschedule already uses elsewhere in this file
    // for "does this request's current state hinge on a live
    // reservation," reused here rather than inventing a second one. Those
    // states open directly from the already-authorized row — identically
    // to a manual click on that same card (the onClick above performs no
    // reservation check whatsoever), which is the behavior parity this
    // correction restores.
    if (!lessonDependsOnLiveReservation(match.status, match.linked_reservation_id)) {
      setSelected(match);
      setInitialSheetMode(undefined);
      return;
    }

    if (!match.linked_reservation_id) { clearLessonIdParam(); return; }

    let cancelled = false;

    (async () => {
      // Phase 30G correction: lesson_requests.proposed_starts_at is not
      // authoritative for a pending reschedule — it holds the new
      // candidate, not the original lesson's time. The linked reservation
      // itself is the only reliable source of "is the original lesson
      // still confirmed and same-club." Validated directly here — never
      // inferred from names, notes, owner_user_id, or a matching
      // court/time. Not time-restricted: a past confirmed lesson is a
      // valid, viewable lesson too — the mutation RPCs (propose_lesson_time,
      // cancel_lesson) remain the authoritative gate on which actions a
      // past lesson still permits, independent of this re-validation.
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
        reservation.status === "confirmed";

      if (!reservationEligible) {
        clearLessonIdParam();
        return;
      }

      setSelected(match);
      setInitialSheetMode(undefined);
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
    .filter(r => filter === "active" ? isActiveRequest(r) : filter === "past" ? isPastRequest(r) : true)
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
  // Phase 38A: additionally excludes a PAST confirmed lesson — the RPC
  // (propose_lesson_time) already rejected this server-side via
  // cannot_reschedule_started_lesson, but the card previously still showed
  // the button. Only applies to status === 'confirmed': a pending
  // reschedule (status === 'proposed' with linked_reservation_id set) is
  // always Active regardless of time (its proposed_starts_at holds the new
  // CANDIDATE time, not the original lesson's time — isPastConfirmedLesson
  // is never evaluated against that value here).
  const canReschedule = (r: ProLessonRequestRow) =>
    r.member_claimed &&
    lessonDependsOnLiveReservation(r.status, r.linked_reservation_id) &&
    (isOperator(userRole) || (userRole === "pro" && r.pro_id === userId)) &&
    !(r.status === "confirmed" && isPastConfirmedLesson(r.status, r.proposed_starts_at));

  // Phase 38A: card-level Reassign Pro / Cancel Lesson — Admin/Staff only,
  // a FUTURE confirmed lesson only (never Pro, including their own lesson —
  // "Pros may NOT reassign themselves or other Pros"; Pro's existing
  // ability to cancel their OWN lesson is untouched and still reachable via
  // the full card click into LessonProSheet's own default action list,
  // unaffected by these two card-level additions).
  const canReassignFromCard = (r: ProLessonRequestRow) =>
    isOperator(userRole) &&
    r.status === "confirmed" &&
    !isPastConfirmedLesson(r.status, r.proposed_starts_at);

  const canCancelFromCard = (r: ProLessonRequestRow) =>
    isOperator(userRole) &&
    r.status === "confirmed" &&
    !isPastConfirmedLesson(r.status, r.proposed_starts_at);

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
            onClick={() => setFilter("past")}
            className={`px-3 py-1 rounded-md text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
              filter === "past"
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700"
            }`}
          >
            Past {pastCount > 0 && `(${pastCount})`}
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
            {filter === "active"
              ? "No active lesson requests."
              : filter === "past"
              ? "No past lessons yet."
              : "No lesson requests yet."}
          </p>
        </div>
      )}

      {/* Request cards */}
      {visible.map(r => {
        const memberName = [r.member_first_name, r.member_last_name].filter(Boolean).join(" ") || "Member";
        const proName    = [r.pro_first_name, r.pro_last_name].filter(Boolean).join(" ") || "Pro";
        const isActive   = ACTIVE_STATUSES.includes(r.status);
        const isPastConfirmed = r.status === "confirmed" && isPastConfirmedLesson(r.status, r.proposed_starts_at);

        return (
          <div
            key={r.id}
            role="button"
            tabIndex={0}
            onClick={() => { setSelected(r); setInitialSheetMode(undefined); }}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { setSelected(r); setInitialSheetMode(undefined); } }}
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

            {/* Phase 38A: a past confirmed lesson never shows Propose New
                Time / Reassign Pro / a direct Cancel Lesson button — only a
                plain View Details affordance into the SAME LessonProSheet
                (the whole card is already clickable to the same effect;
                this button just makes that explicit for a card whose other
                actions have all been intentionally removed). Admin/Staff's
                historical-correction ability to still cancel a past lesson
                remains available inside that sheet's own default action
                list, untouched by this card-level restriction. */}
            {isPastConfirmed ? (
              <div
                className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700/50"
                onClick={e => e.stopPropagation()}
              >
                <button
                  onClick={() => { setSelected(r); setInitialSheetMode(undefined); }}
                  className={`w-full md:w-auto ${ACTION_BUTTON_SECONDARY}`}
                >
                  View Details
                </button>
              </div>
            ) : (canPropose(r) || canReschedule(r) || canReassignFromCard(r) || canCancelFromCard(r)) && (
              <div
                className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700/50 flex flex-wrap gap-2"
                onClick={e => e.stopPropagation()}
              >
                {(canPropose(r) || canReschedule(r)) && (
                  <button
                    onClick={() => { setSelected(r); setInitialSheetMode("propose"); }}
                    className={`w-full sm:w-auto ${ACTION_BUTTON_PRIMARY}`}
                  >
                    {canPropose(r)
                      ? "Propose a Time"
                      : r.status === "proposed"
                      ? "Revise Proposed Time"
                      : "Propose New Time"}
                  </button>
                )}
                {canReassignFromCard(r) && (
                  <button
                    onClick={() => { setSelected(r); setInitialSheetMode("reassign"); }}
                    className={`w-full sm:w-auto ${ACTION_BUTTON_SECONDARY}`}
                  >
                    Reassign Pro
                  </button>
                )}
                {canCancelFromCard(r) && (
                  <button
                    onClick={() => { setSelected(r); setInitialSheetMode("cancel"); }}
                    className={`w-full sm:w-auto ${ACTION_BUTTON_DESTRUCTIVE}`}
                  >
                    Cancel Lesson
                  </button>
                )}
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
          initialMode={initialSheetMode}
          onClose={() => { setSelected(null); setInitialSheetMode(undefined); clearLessonIdParam(); router.refresh(); }}
        />
      )}
    </div>
  );
}
