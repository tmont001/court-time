"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import PaymentStateBadge from "@/components/PaymentStateBadge";
import { createClient } from "@/lib/supabase/client";
import {
  withdrawLessonRequest,
  acceptLessonProposal,
  declineLessonProposal,
  cancelLesson,
  previewMemberLessonCancellationPolicy,
  cancelMemberLessonConfirmed,
  type LessonRequestRow,
} from "./actions";
import { fetchPaymentStates } from "@/app/(app)/admin/payments/actions";
import { isPaymentOpenForRecording, type PaymentStateRow } from "@/lib/payments";
import { formatMemberPrice } from "@/lib/money";
import { ACTION_BUTTON_PRIMARY_COMPACT_TOUCH, ACTION_BUTTON_SECONDARY } from "@/components/styles/actionButtonStyles";
import { getLessonCheckoutEligibilityAction, createLessonCheckoutAction } from "./lessonCheckoutActions";

interface Props {
  request:    LessonRequestRow;
  userId:     string;
  clubId:     string;
  clubTimezone: string;
  currency:   string;
  onClose:    () => void;
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
  return new Date(iso).toLocaleString("en-US", {
    timeZone: tz,
    month:    "short",
    day:      "numeric",
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true,
  });
}

// Phase 41B completion — authoritative Member cancellation copy, keyed off
// the server-verified policy state from previewMemberLessonCancellationPolicy.
// Never computes in_policy/late itself — policy is a parameter, not a
// derivation. Lessons never have grace (cancel_lesson's Member branch
// always passes 0 grace minutes), so there is no grace case here. Payment
// collected/outstanding phrasing uses the ALREADY-FETCHED paymentState —
// never re-derives policy classification from payment data.
function memberLessonCancelCopy(
  policy: { state: "in_policy" | "late" } | null,
  payment: PaymentStateRow | null,
): string {
  if (!policy) return "Checking this lesson's cancellation policy…";

  if (policy.state === "in_policy") {
    return "This will release the lesson and court slot. If you paid online, a refund request is automatically created for the club to review — actual refund processing still requires Admin approval.";
  }

  // late
  if (payment && isPaymentOpenForRecording(payment)) {
    return "This cancellation is outside the club's cancellation window. The lesson will be released, but your outstanding balance remains due — cancelling does not erase it.";
  }
  if (payment && payment.current_amount_paid_cents > 0) {
    return "This cancellation is outside the club's cancellation window. The lesson will be released, but no refund request will be created — your payment will not be automatically refunded. You can still contact the club to ask about a manual refund.";
  }
  return "This cancellation is outside the club's cancellation window. The lesson will be released.";
}

export default function LessonRequestDetail({ request, userId: _userId, clubId, clubTimezone, currency, onClose }: Props) {
  const router = useRouter();
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [confirmCancel,   setConfirmCancel]   = useState(false);
  const [cancelReason,    setCancelReason]    = useState("");
  // Phase 41B completion — this component is only ever rendered for a
  // viewer managing THEIR OWN lesson (Member or the assigned Pro; Admin/
  // Staff lesson management is a separate surface, LessonProSheet.tsx).
  // request.pro_id === userId is the same distinguishing signal cancel_
  // lesson's own v_actor_role computation uses for the 'pro' case — a Pro
  // gets simple operational confirmation; anyone else viewing their own
  // lesson here is the Member and gets the authoritative policy preview.
  const isViewerPro = request.pro_id === _userId;
  const [policyPreview, setPolicyPreview] = useState<{ state: "in_policy" | "late" } | null>(null);
  const [policyPreviewLoading, setPolicyPreviewLoading] = useState(false);
  const [policyChangedNotice, setPolicyChangedNotice]   = useState(false);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  // Phase 34C — own read-only payment state via the sanitized batched read
  // boundary. No Record Payment here — Member never mutates payments.
  const [paymentState, setPaymentState] = useState<PaymentStateRow | null>(null);
  useEffect(() => {
    if (request.status !== "confirmed") return;
    let cancelled = false;
    (async () => {
      const { data } = await fetchPaymentStates("lesson_request", [request.id]);
      if (!cancelled) setPaymentState(data?.[0] ?? null);
    })();
    return () => { cancelled = true; };
  }, [request.id, request.status]);

  // Phase 34F-A — whether THIS lesson's obligation was created under
  // court_time_payments (never re-derived from the club's CURRENT payment
  // mode, which may have changed since). Purely a UI-gating signal for
  // whether Pay Now renders at all — createLessonCheckoutAction always
  // re-derives eligibility fresh itself and never trusts this flag.
  // Mirrors ReservationDetailSheet's own identical checkoutEligible
  // pattern.
  const [checkoutEligible, setCheckoutEligible] = useState(false);
  const [checkoutLoading, setCheckoutLoading]   = useState(false);
  const [checkoutError, setCheckoutError]       = useState<string | null>(null);

  useEffect(() => {
    if (request.status !== "confirmed") {
      setCheckoutEligible(false);
      return;
    }
    getLessonCheckoutEligibilityAction(request.id, clubId).then(({ eligible }) => {
      setCheckoutEligible(eligible);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id, request.status]);

  async function handlePayNow() {
    setCheckoutLoading(true);
    setCheckoutError(null);
    const result = await createLessonCheckoutAction(request.id, clubId);
    if (result.error) {
      setCheckoutError(result.error);
      setCheckoutLoading(false);
      return;
    }
    if (result.url) {
      // External Stripe-hosted destination — a plain browser navigation.
      window.location.href = result.url;
    }
  }

  // Phase 34C — the already-snapshotted total price for this Lesson, at
  // the commitment point (proposed = deciding whether to accept; confirmed
  // = already committed). lesson_requests_select_member RLS (member_id =
  // auth.uid()) permits this direct read of the Member's own row — never
  // recalculated from current Lesson Type settings, always the stored
  // snapshot, exactly like the equivalent read on the Pro/operator side
  // (LessonProSheet's own priceSnapshot fetch).
  const [priceAmountCents, setPriceAmountCents] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (request.status !== "proposed" && request.status !== "confirmed") return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase.from as any)("lesson_requests")
        .select("price_amount_cents")
        .eq("id", request.id)
        .single() as { data: { price_amount_cents: number | null } | null };
      if (!cancelled) setPriceAmountCents(data?.price_amount_cents ?? null);
    })();
    return () => { cancelled = true; };
  }, [request.id, request.status]);

  const proName = [request.pro_first_name, request.pro_last_name].filter(Boolean).join(" ") || "Pro";

  // Phase 34C — already the pre-calculated TOTAL for this Lesson's actual
  // duration (round(unit_price_amount_cents * duration_minutes / 60) for
  // an hourly Lesson Type, computed server-side at snapshot time) — never
  // recomputed here, and never merely the hourly rate. NULL stays hidden
  // (never invented for a Member); undefined means "not yet fetched".
  const priceLabel =
    priceAmountCents === undefined || priceAmountCents === null
      ? null
      : priceAmountCents === 0
      ? "Free"
      : `Total lesson price: ${formatMemberPrice(priceAmountCents, currency)}`;

  function action(fn: () => Promise<{ error?: string }>) {
    setError("");
    startTransition(async () => {
      const res = await fn();
      if (res.error) { setError(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  // Phase 41B completion — fetches the authoritative in_policy/late preview
  // fresh; never computed client-side. Returns whether it succeeded so the
  // caller can decide whether to open the confirm panel.
  async function loadPolicyPreview(): Promise<boolean> {
    setPolicyPreviewLoading(true);
    setError("");
    const result = await previewMemberLessonCancellationPolicy(request.id, clubId);
    setPolicyPreviewLoading(false);
    if (result.error || !result.data) {
      setError(result.error ?? "Something went wrong. Please try again.");
      return false;
    }
    setPolicyPreview({ state: result.data.state });
    return true;
  }

  // Cancel trigger click — the assigned Pro opens the confirm panel
  // immediately (simple operational confirmation, no policy data needed);
  // the Member fetches the authoritative preview FIRST.
  async function handleCancelTriggerClick() {
    if (!isViewerPro) {
      const ok = await loadPolicyPreview();
      if (!ok) return;
    }
    setConfirmCancel(true);
  }

  function handleMemberCancelConfirmed() {
    if (!policyPreview) return;
    setError("");
    setPolicyChangedNotice(false);
    startTransition(async () => {
      const res = await cancelMemberLessonConfirmed({
        requestId:           request.id,
        memberId:            _userId,
        proId:               request.pro_id,
        actorId:             _userId,
        reason:              cancelReason.trim() || null,
        expectedClubId:      clubId,
        expectedPolicyState: policyPreview.state,
      });
      if (res.policyChanged) {
        // Phase 41B completion — no silent retry across a changed
        // financial outcome. Re-fetch the preview so the confirm panel's
        // copy/CTA reflect the NEW authoritative state, and require the
        // Member to confirm again explicitly.
        setPolicyChangedNotice(true);
        await loadPolicyPreview();
        return;
      }
      if (res.error) { setError(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  return (
    <ResponsiveSheet
      onClose={onClose}
      variant="modal"
      mobileInteraction="draggable"
      label="Lesson Request"
      header={
        <div className="relative flex items-center justify-center">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Lesson Request</h2>
          <button onClick={onClose} className="absolute right-0 text-sm text-gray-400 md:hidden" aria-label="Close">✕</button>
        </div>
      }
    >
      {/* Status + summary */}
      <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden mb-4">
        <div className="px-4 py-2.5 flex items-center justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">Status</span>
          {statusBadge(request.status)}
        </div>
        <div className="px-4 py-2.5 flex justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">Pro</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">{proName}</span>
        </div>
        <div className="px-4 py-2.5 flex justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">Duration</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">{request.duration_minutes} min</span>
        </div>
        {request.preferred_court_name && (
          <div className="px-4 py-2.5 flex justify-between text-sm">
            <span className="text-gray-500 dark:text-gray-400">Preferred court</span>
            <span className="font-medium text-gray-900 dark:text-gray-100">{request.preferred_court_name}</span>
          </div>
        )}
        {request.member_note && (
          <div className="px-4 py-2.5 text-sm">
            <p className="text-gray-500 dark:text-gray-400 mb-0.5">Note</p>
            <p className="text-gray-700 dark:text-gray-300">{request.member_note}</p>
          </div>
        )}
        <div className="px-4 py-2.5 flex justify-between text-xs text-gray-400">
          <span>Submitted</span>
          <span>{fmt(request.created_at, clubTimezone)}</span>
        </div>
      </div>

      {/* Proposed time (if status = proposed). linked_reservation_id set
          means this is a reschedule of an already-confirmed lesson — the
          original confirmed reservation is untouched and remains booked
          until the member responds here. */}
      {request.status === "proposed" && request.proposed_starts_at && (
        <div className="ct-card px-4 py-3 mb-4 border-2 border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30">
          <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-1">
            {request.linked_reservation_id
              ? `Reschedule proposed by ${proName}`
              : `Time proposed by ${proName}`}
          </p>
          {request.linked_reservation_id && (
            <p className="text-xs text-blue-700 dark:text-blue-400 mb-1.5">
              Your original confirmed lesson stays booked until you accept or decline this change.
            </p>
          )}
          <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
            {fmt(request.proposed_starts_at, clubTimezone)}
            {request.proposed_ends_at
              ? ` – ${new Date(request.proposed_ends_at).toLocaleTimeString("en-US", {
                  timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
                })}`
              : ""}
          </p>
          {request.proposed_court_name && (
            <p className="text-xs text-blue-700 dark:text-blue-400 mt-0.5">
              Court: {request.proposed_court_name}
            </p>
          )}
          {priceLabel && (
            <p className="text-sm font-semibold text-blue-900 dark:text-blue-100 mt-1.5">
              {priceLabel}
            </p>
          )}
        </div>
      )}

      {/* Confirmed time */}
      {request.status === "confirmed" && request.proposed_starts_at && (
        <div className="ct-card px-4 py-3 mb-4 border-2 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30">
          <p className="text-xs font-semibold text-green-700 dark:text-green-300 mb-1">Confirmed lesson</p>
          <p className="text-sm font-medium text-green-900 dark:text-green-100">
            {fmt(request.proposed_starts_at, clubTimezone)}
            {request.proposed_ends_at
              ? ` – ${new Date(request.proposed_ends_at).toLocaleTimeString("en-US", {
                  timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
                })}`
              : ""}
          </p>
          {request.proposed_court_name && (
            <p className="text-xs text-green-700 dark:text-green-400 mt-0.5">
              Court: {request.proposed_court_name}
            </p>
          )}
          {priceLabel && (
            <p className="text-sm font-semibold text-green-900 dark:text-green-100 mt-1.5">
              {priceLabel}
            </p>
          )}
        </div>
      )}

      {/* Payment state — Phase 34C, own state only, read-only. Pay Now
          (Phase 34F-A) is the Member's own action — mirrors
          ReservationDetailSheet's identical onMemberCancel-analogous
          pattern; this Member never sees Admin's Record Payment control,
          which lives only on /admin/payments and admin/lessons. */}
      {request.status === "confirmed" && paymentState && (
        <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <PaymentStateBadge state={paymentState} />
          {checkoutEligible && isPaymentOpenForRecording(paymentState) && (
            <button
              disabled={checkoutLoading}
              onClick={handlePayNow}
              className={`${ACTION_BUTTON_PRIMARY_COMPACT_TOUCH} disabled:opacity-50`}
            >
              {checkoutLoading ? "Redirecting…" : "Pay Now"}
            </button>
          )}
        </div>
      )}
      {checkoutError && <p className="mb-4 text-xs text-red-500">{checkoutError}</p>}

      {/* Add to Calendar — one-off .ics export (Phase 35B), confirmed,
          not-yet-finished lessons only (using the authoritative
          proposed_ends_at). The export route independently re-derives and
          re-checks this same eligibility, and RLS independently re-derives
          whether this viewer may see the row at all — this is a
          UI-display gate only, never the authorization boundary itself. */}
      {request.status === "confirmed" && request.proposed_ends_at && new Date(request.proposed_ends_at) > new Date() && (
        <a
          href={`/api/calendar/export/lesson/${request.id}`}
          className={`mb-4 flex items-center justify-center ${ACTION_BUTTON_SECONDARY}`}
        >
          Add to Calendar
        </a>
      )}

      {/* Decline reason */}
      {request.status === "declined" && request.decline_reason && (
        <div className="ct-card px-4 py-3 mb-4 border border-red-200 dark:border-red-800">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Decline reason</p>
          <p className="text-sm text-gray-700 dark:text-gray-300">{request.decline_reason}</p>
        </div>
      )}

      {/* Cancellation reason */}
      {request.status === "cancelled" && request.cancellation_reason && (
        <div className="ct-card px-4 py-3 mb-4 border border-gray-200 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Cancellation reason</p>
          <p className="text-sm text-gray-700 dark:text-gray-300">{request.cancellation_reason}</p>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>
      )}

      {/* Actions */}
      <div className="space-y-2">
        {/* Proposed: accept or decline proposal */}
        {request.status === "proposed" && (
          <>
            {!confirmWithdraw && (
              <>
                <button
                  onClick={() => action(() => acceptLessonProposal(request.id, request.pro_id))}
                  disabled={isPending}
                  className="w-full bg-green-600 hover:bg-green-700 text-white rounded-xl py-3 text-sm font-semibold disabled:opacity-50"
                >
                  {isPending ? "Accepting…" : "Accept Proposed Time"}
                </button>
                <button
                  onClick={() => action(() => declineLessonProposal(request.id))}
                  disabled={isPending}
                  className="w-full border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-xl py-3 text-sm font-medium disabled:opacity-50"
                >
                  Decline Proposal
                </button>
              </>
            )}
          </>
        )}

        {/* Pending: withdraw */}
        {request.status === "pending" && !confirmWithdraw && (
          <button
            onClick={() => setConfirmWithdraw(true)}
            className="w-full border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-xl py-3 text-sm font-medium"
          >
            Withdraw Request
          </button>
        )}

        {/* Withdraw confirmation */}
        {confirmWithdraw && (
          <div className="space-y-2">
            <p className="text-sm text-gray-600 dark:text-gray-300 text-center">
              Withdraw this request?
            </p>
            <button
              onClick={() => action(() => withdrawLessonRequest(request.id, clubId))}
              disabled={isPending}
              className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl py-3 text-sm font-semibold disabled:opacity-50"
            >
              {isPending ? "Withdrawing…" : "Yes, Withdraw"}
            </button>
            <button
              onClick={() => setConfirmWithdraw(false)}
              className="w-full text-sm text-gray-500"
            >
              Keep Request
            </button>
          </div>
        )}

        {/* Confirmed, or a pending reschedule proposal on an otherwise-
            confirmed lesson: cancel outright.
            Phase 41B completion: the Member's trigger fetches the
            authoritative in_policy/late preview first (0187) — the
            assigned Pro's trigger opens the panel immediately (simple
            operational confirmation). */}
        {(request.status === "confirmed" ||
          (request.status === "proposed" && request.linked_reservation_id)) && !confirmCancel && (
          <button
            onClick={handleCancelTriggerClick}
            disabled={policyPreviewLoading}
            className="w-full border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-xl py-3 text-sm font-medium disabled:opacity-50"
          >
            {policyPreviewLoading ? "Checking cancellation policy…" : "Cancel Lesson"}
          </button>
        )}

        {confirmCancel && (
          <div className="space-y-2">
            {!isViewerPro && policyChangedNotice && (
              <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
                This lesson&apos;s cancellation status changed while you were reviewing — please confirm again.
              </p>
            )}
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {isViewerPro
                ? "Cancel this confirmed lesson? This will remove it from the calendar."
                : memberLessonCancelCopy(policyPreview, paymentState)}
            </p>
            <textarea
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
              placeholder="Reason (optional)"
              rows={2}
              maxLength={300}
              className="w-full ct-input text-base md:text-sm resize-none"
            />
            <button
              onClick={isViewerPro
                ? () => action(() => cancelLesson({
                    requestId: request.id,
                    memberId:  _userId,
                    proId:     request.pro_id,
                    actorId:   _userId,
                    reason:    cancelReason.trim() || null,
                    expectedClubId: clubId,
                  }))
                : handleMemberCancelConfirmed}
              disabled={isPending || (!isViewerPro && !policyPreview)}
              className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl py-3 text-sm font-semibold disabled:opacity-50"
            >
              {isPending
                ? "Cancelling…"
                : !isViewerPro && policyPreview?.state === "late"
                ? "Cancel Anyway"
                : "Confirm Cancellation"}
            </button>
            <button
              onClick={() => { setConfirmCancel(false); setError(""); setPolicyChangedNotice(false); }}
              disabled={isPending}
              className="w-full text-sm text-gray-500 disabled:opacity-50"
            >
              Keep Lesson
            </button>
          </div>
        )}
      </div>
    </ResponsiveSheet>
  );
}
