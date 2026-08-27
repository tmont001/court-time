"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { adminCancelReservation } from "./actions";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import EditReservationSheet from "./EditReservationSheet";
import EditMaintenanceSheet from "./EditMaintenanceSheet";
import PriceSummary from "@/components/PriceSummary";
import PaymentStateBadge from "@/components/PaymentStateBadge";
import RecordPaymentSheet from "@/components/RecordPaymentSheet";
import { formatMoney } from "@/lib/money";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { fetchPaymentStates } from "@/app/(app)/admin/payments/actions";
import { isPaymentOpenForRecording, type PaymentStateRow } from "@/lib/payments";
import {
  getReservationCheckoutEligibilityAction,
  createReservationCheckoutAction,
} from "./reservationCheckoutActions";
import { ACTION_BUTTON_PRIMARY_COMPACT_TOUCH } from "@/lib/actionButtonStyles";

// ─── Types ────────────────────────────────────────────────────────────────────

// Phase 30B1: widened to match the full runtime row CalendarShell already
// fetches (select("*")) and passes through — status, format, player_count,
// guest_names, and updated_at were previously present on the object at
// runtime but inaccessible through this narrower type.
// Phase 33C2: owner_user_id is now nullable (0108) — a staff-created
// no-account-Member booking has no authenticated owner. roster_member_id
// added — the durable Member identity, always set for reason=
// 'member_booking' (enforced by 0108's reservations_member_booking_
// identity_guard trigger), used as the display fallback when owner_user_id
// is null.
interface ReservationBlock {
  id:                    string;
  court_id:              string;
  owner_user_id:         string | null;
  roster_member_id:      string | null;
  starts_at:             string;
  ends_at:               string;
  status:                string;
  reason:                string;
  format:                string | null;
  player_count:          number | null;
  guest_names:           string[] | null;
  notes:                 string | null;
  show_notes_to_members: boolean;
  updated_at:            string;
  // Phase 34B: snapshotted at booking/edit time — never a live-resolved
  // "current rate," so a legacy pre-pricing reservation correctly stays
  // NULL here even after the club later configures pricing.
  hourly_rate_cents:     number | null;
  price_amount_cents:    number | null;
}

interface Court {
  id:                string;
  name:              string;
  display_order:     number;
  hourly_rate_cents?: number | null;
}

// Phase 33C2: replaces the old OwnerProfile-only shape — the reservation's
// "who this is for" display now resolves from either profiles
// (owner_user_id set) or roster_members (owner_user_id null, no-account
// Member). claimed distinguishes the two for the "No account yet" badge —
// never labeled as a Guest, per the locked identity model.
interface MemberDisplay {
  name:    string;
  claimed: boolean;
}

function fullName(p: { first_name: string | null; last_name: string | null }): string {
  const full = [p.first_name, p.last_name].filter(Boolean).join(" ");
  return full || "Unknown member";
}

interface Props {
  reservation:    ReservationBlock;
  courts:         Court[];
  clubTimezone:   string;
  clubId:         string;
  // Phase 30D correction: explicit Admin-role authorization for Edit/Edit
  // Block eligibility. Callback presence (onMemberCancel below) is a UI
  // display-mode signal, not an authorization source, and must never be
  // used to derive it.
  isAdmin:        boolean;
  // Phase 34A4A: admin+staff (isOperator) — matches roster_members RLS
  // (roster_members_select_admin, 0132). Deliberately separate from
  // isAdmin: this gates only the no-account Member name lookup below, not
  // canEditMaintenance, which remains admin-only exactly as before.
  canSeeRosterIdentity: boolean;
  // Phase 34A4A: admin+staff (isOperator) — matches update_member_
  // reservation's own role check (0132: v_role in ('admin','staff')).
  // Gates canEdit for reason='member_booking' only. Deliberately separate
  // from isAdmin: canEditMaintenance (maintenance/admin blocks) stays
  // isAdmin-only, unchanged.
  canManageMemberReservation: boolean;
  currency:                    string;
  defaultCourtHourlyRateCents: number | null;
  onClose:        () => void;
  onCancelled:    () => void;
  // Phase 30B1: fired after a successful admin edit.
  onUpdated:      () => void;
  // When provided, the sheet operates in member-cancel mode (instead of admin).
  onMemberCancel?: () => Promise<{ error?: string }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapCancelError(message: string): string {
  if (message === STALE_CLUB_CONTEXT_ERROR)  return STALE_CLUB_MESSAGE;
  if (message === "reservation_not_found") return "This booking has already been cancelled.";
  if (message === "insufficient_role")     return "You do not have permission to cancel this booking.";
  return "Something went wrong. Please try again.";
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ReservationDetailSheet({
  reservation, courts, clubTimezone, clubId, isAdmin, canSeeRosterIdentity, canManageMemberReservation, currency, defaultCourtHourlyRateCents, onClose, onCancelled, onUpdated, onMemberCancel,
}: Props) {
  const supabase = useMemo(() => createClient(), []);

  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [memberDisplay, setMemberDisplay] = useState<MemberDisplay | null>(null);
  const [editOpen, setEditOpen]           = useState(false);

  // Phase 34C — payment state, fetched via the sanitized batched read
  // boundary. Only meaningful for member_booking reservations (the only
  // domain that can ever be priced/tracked here).
  const [paymentState, setPaymentState] = useState<PaymentStateRow | null>(null);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);

  // Phase 34D-D1 — whether THIS reservation's obligation was created under
  // court_time_payments (never re-derived from the club's CURRENT payment
  // mode, which may have changed since). Only fetched in member-cancel
  // mode (the viewer owns this booking) — this is purely a UI-gating
  // signal for whether Pay Now renders at all; createReservationCheckoutAction
  // always re-derives eligibility fresh itself and never trusts this flag.
  const [checkoutEligible, setCheckoutEligible] = useState(false);
  const [checkoutLoading, setCheckoutLoading]   = useState(false);
  const [checkoutError, setCheckoutError]       = useState<string | null>(null);

  async function loadPaymentState() {
    if (reservation.reason !== "member_booking") return;
    const { data } = await fetchPaymentStates("reservation", [reservation.id]);
    setPaymentState(data?.[0] ?? null);
  }

  useEffect(() => {
    loadPaymentState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservation.id]);

  useEffect(() => {
    if (!onMemberCancel || reservation.reason !== "member_booking") {
      setCheckoutEligible(false);
      return;
    }
    getReservationCheckoutEligibilityAction(reservation.id, clubId).then(({ eligible }) => {
      setCheckoutEligible(eligible);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservation.id]);

  async function handlePayNow() {
    setCheckoutLoading(true);
    setCheckoutError(null);
    const result = await createReservationCheckoutAction(reservation.id, clubId);
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

  useEffect(() => {
    // Owner display is only needed for admin mode (to display "Booked by").
    // In member-cancel mode the member is viewing their own booking — skip the fetch.
    if (onMemberCancel) return;

    if (reservation.owner_user_id) {
      // Claimed/self-service booking — unchanged from before this checkpoint.
      supabase
        .from("profiles")
        .select("first_name, last_name")
        .eq("id", reservation.owner_user_id)
        .single()
        .then(({ data }) => {
          setMemberDisplay({ name: data ? fullName(data) : "Unknown member", claimed: true });
        });
      return;
    }

    if (reservation.roster_member_id && canSeeRosterIdentity) {
      // Phase 33C2: staff-created no-account-Member booking — owner_user_id
      // is null by design (0108's locked identity model). The Member's name
      // comes from roster_members via roster_member_id instead. This is a
      // durable Member identity, never a Guest — never relabeled as one.
      // roster_members has operator-only RLS (roster_members_select_admin,
      // widened admin+staff by 0132), so this fetch is only attempted when
      // canSeeRosterIdentity (isOperator) holds — the same gate used by the
      // booking-flow Member picker.
      supabase
        .from("roster_members")
        .select("first_name, last_name")
        .eq("id", reservation.roster_member_id)
        .single()
        .then(({ data }) => {
          setMemberDisplay({ name: data ? fullName(data) : "Unknown member", claimed: false });
        });
      return;
    }

    // No owner_user_id, and either no roster_member_id or the viewer lacks
    // admin-only roster_members read access — resolve to a neutral, honest
    // state rather than leaving the sheet stuck on "Loading…" forever.
    setMemberDisplay({ name: "Club Member", claimed: false });
  }, [reservation.id, reservation.owner_user_id, reservation.roster_member_id, canSeeRosterIdentity]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived display values ────────────────────────────────────────────────

  const courtName = courts.find(c => c.id === reservation.court_id)?.name ?? "Court";

  const dateLabel = new Date(reservation.starts_at).toLocaleDateString("en-US", {
    timeZone: clubTimezone, weekday: "long", month: "long", day: "numeric",
  });
  const startLabel = new Date(reservation.starts_at).toLocaleTimeString("en-US", {
    timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });
  const endLabel = new Date(reservation.ends_at).toLocaleTimeString("en-US", {
    timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });

  const ownerName = memberDisplay ? memberDisplay.name : "Loading…";

  // Admin or Staff (canManageMemberReservation) may edit only a confirmed
  // member_booking reservation whose start is still in the future. Member
  // and Pro owners never see Edit. Authorization comes exclusively from
  // the explicit canManageMemberReservation prop, never from whether
  // onMemberCancel happens to be supplied — callback presence is a
  // display-mode signal (member-cancel mode vs. operator mode), not proof
  // of role, and must never substitute for a real authorization check.
  const canEdit =
    canManageMemberReservation &&
    reservation.reason === "member_booking" &&
    reservation.status === "confirmed" &&
    new Date(reservation.starts_at) > new Date();

  // Phase 30D: Admin-only edit of a single maintenance block. There is no
  // durable multi-court group identity in this schema — this always edits
  // exactly the reservation row that was clicked (see the Phase 30D audit).
  // Same isAdmin-only authorization source as canEdit above.
  const canEditMaintenance =
    isAdmin &&
    reservation.reason === "maintenance" &&
    reservation.status === "confirmed" &&
    new Date(reservation.starts_at) > new Date();

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleAdminCancel() {
    setLoading(true);
    setError(null);
    const result = await adminCancelReservation(reservation.id, clubId);
    if (result?.error) {
      setError(mapCancelError(result.error));
      setLoading(false);
      return;
    }
    onCancelled();
  }

  async function handleMemberCancel() {
    if (!onMemberCancel) return;
    setLoading(true);
    setError(null);
    const result = await onMemberCancel();
    if (result?.error) {
      setError(result.error === STALE_CLUB_CONTEXT_ERROR ? STALE_CLUB_MESSAGE : result.error);
      setLoading(false);
      return;
    }
    onCancelled();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <ResponsiveSheet
        onClose={onClose}
        variant="modal"
        mobileInteraction="draggable"
        label={courtName}
        header={null}
        active={!editOpen}
      >
        {/* Court */}
        <p className="text-base font-semibold text-gray-900 dark:text-gray-100 pr-8">{courtName}</p>

        {/* Date */}
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{dateLabel}</p>

        {/* Time */}
        <p className="text-sm text-gray-700 dark:text-gray-300 mt-0.5 font-medium">{startLabel} – {endLabel}</p>

        {/* Owner — admin mode only; member is viewing their own booking.
            member_booking rows get the fuller "Member" row inside the
            details box below instead of this line, to avoid showing the
            same person twice. */}
        {!onMemberCancel && reservation.reason !== "member_booking" && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Booked by {ownerName}</p>
        )}

        {/* Reservation details — admin mode only, member_booking reason
            only. Phase 33C2 completion: format/player count/guest names/
            notes were entered at booking/edit time but not previously
            visible here — the Member row also carries the "No account
            yet" badge prominently (fixes it not being visibly shown in
            the compact "Booked by" line this replaces for member_booking
            rows) — never labeled as a Guest. Empty/unset fields are not
            rendered at all. */}
        {!onMemberCancel && reservation.reason === "member_booking" && (
          <div className="mt-3 rounded-xl border border-gray-200 dark:border-gray-600 divide-y divide-gray-100 dark:divide-gray-700">
            <div className="px-3 py-2 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Member</span>
              <span className="flex items-center gap-1.5 text-sm text-gray-900 dark:text-gray-100">
                {ownerName}
                {memberDisplay && !memberDisplay.claimed && (
                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                    No account yet
                  </span>
                )}
              </span>
            </div>
            {reservation.format && (
              <div className="px-3 py-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Format</span>
                <span className="text-sm text-gray-900 dark:text-gray-100 capitalize">{reservation.format}</span>
              </div>
            )}
            {reservation.player_count != null && (
              <div className="px-3 py-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Player count</span>
                <span className="text-sm text-gray-900 dark:text-gray-100">{reservation.player_count}</span>
              </div>
            )}
            {reservation.guest_names && reservation.guest_names.length > 0 && (
              <div className="px-3 py-2">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Guests</span>
                <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5">{reservation.guest_names.join(", ")}</p>
              </div>
            )}
            {reservation.notes?.trim() && (
              <div className="px-3 py-2">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Notes</span>
                <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5">{reservation.notes.trim()}</p>
              </div>
            )}
          </div>
        )}

        {/* Price — snapshotted at booking/edit time, shown read-only here.
            Member sees it hidden entirely when unpriced; operator sees
            "No price set." Never a live-resolved "today's rate." */}
        {reservation.reason === "member_booking" && (
          <PriceSummary
            label="Price"
            amountCents={reservation.price_amount_cents}
            currency={currency}
            viewer={onMemberCancel ? "member" : "operator"}
            breakdown={
              reservation.hourly_rate_cents !== null
                ? `${formatMoney(reservation.hourly_rate_cents, currency)}/hour`
                : null
            }
            className="mt-3"
          />
        )}

        {/* Payment state — Phase 34C. Renders nothing when there is no
            payment row (never fabricates "Unpaid"). Record Payment is
            Admin/Staff only (canManageMemberReservation — the same role
            gate as Edit) and only offered when the balance is genuinely
            open. Pay Now (Phase 34D-D1) is the Member/Pro owner's own
            action — onMemberCancel presence is the same "this is my own
            booking" UI-eligibility mirror the Cancel button below already
            uses; real ownership and online-payability are independently
            re-derived server-side by createReservationCheckoutAction,
            never trusted from this client-side gate alone. */}
        {reservation.reason === "member_booking" && paymentState && (
          <div className="mt-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <PaymentStateBadge state={paymentState} />
            {!onMemberCancel && canManageMemberReservation && isPaymentOpenForRecording(paymentState) && (
              <button
                onClick={() => setRecordPaymentOpen(true)}
                className={ACTION_BUTTON_PRIMARY_COMPACT_TOUCH}
              >
                Record Payment
              </button>
            )}
            {onMemberCancel && checkoutEligible && isPaymentOpenForRecording(paymentState) && (
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
        {checkoutError && <p className="mt-2 text-xs text-red-500">{checkoutError}</p>}

        {/* Maintenance notes — only for maintenance/admin_block reason */}
        {reservation.reason === "maintenance" && (
          <div className="mt-3">
            {reservation.notes?.trim() ? (
              <>
                <p className="text-sm text-gray-700 dark:text-gray-300">{reservation.notes.trim()}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {reservation.show_notes_to_members ? "Visible to members" : "Hidden from members"}
                </p>
              </>
            ) : (
              <p className="text-xs text-gray-400 dark:text-gray-500">No reason added.</p>
            )}
          </div>
        )}

        {/* Error */}
        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}

        {/* Edit — admin mode only, eligible reservations only */}
        {(canEdit || canEditMaintenance) && (
          <button
            disabled={loading}
            onClick={() => setEditOpen(true)}
            className="mt-5 w-full py-3 rounded-xl text-sm font-semibold bg-gray-50 dark:bg-gray-700/60 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-600 disabled:opacity-40"
          >
            {canEditMaintenance ? "Edit Block" : "Edit"}
          </button>
        )}

        {/* Cancel — member mode or admin mode */}
        <button
          disabled={loading}
          onClick={onMemberCancel ? handleMemberCancel : handleAdminCancel}
          className={`w-full py-3 rounded-xl text-sm font-semibold bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 disabled:opacity-40 ${(canEdit || canEditMaintenance) ? "mt-3" : "mt-5"}`}
        >
          {loading ? "Cancelling…" : reservation.reason === "maintenance" ? "Cancel Block" : "Cancel Booking"}
        </button>

      </ResponsiveSheet>

      {/* ── Edit sheet — admin only, layers above this sheet ────────────── */}
      {editOpen && canEditMaintenance && (
        <EditMaintenanceSheet
          block={reservation}
          courts={courts}
          clubId={clubId}
          clubTimezone={clubTimezone}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); onUpdated(); }}
        />
      )}
      {editOpen && canEdit && (
        <EditReservationSheet
          reservation={reservation}
          courts={courts}
          clubId={clubId}
          clubTimezone={clubTimezone}
          currency={currency}
          defaultCourtHourlyRateCents={defaultCourtHourlyRateCents}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); onUpdated(); }}
        />
      )}

      {recordPaymentOpen && paymentState && (
        <RecordPaymentSheet
          paymentId={paymentState.current_payment_id}
          clubId={clubId}
          amountDueCents={paymentState.current_amount_due_cents}
          amountPaidCents={paymentState.current_amount_paid_cents}
          currency={paymentState.current_currency}
          title={`${courtName} — ${dateLabel}`}
          onClose={() => setRecordPaymentOpen(false)}
          onRecorded={() => { setRecordPaymentOpen(false); loadPaymentState(); }}
        />
      )}
    </>
  );
}
