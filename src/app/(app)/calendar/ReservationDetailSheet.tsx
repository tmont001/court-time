"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { adminCancelReservation } from "./actions";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import EditReservationSheet from "./EditReservationSheet";
import EditMaintenanceSheet from "./EditMaintenanceSheet";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";

// ─── Types ────────────────────────────────────────────────────────────────────

// Phase 30B1: widened to match the full runtime row CalendarShell already
// fetches (select("*")) and passes through — status, format, player_count,
// guest_names, and updated_at were previously present on the object at
// runtime but inaccessible through this narrower type.
interface ReservationBlock {
  id:                    string;
  court_id:              string;
  owner_user_id:         string;
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
}

interface Court {
  id:            string;
  name:          string;
  display_order: number;
}

interface OwnerProfile {
  id:         string;
  first_name: string | null;
  last_name:  string | null;
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
  onClose:        () => void;
  onCancelled:    () => void;
  // Phase 30B1: fired after a successful admin edit.
  onUpdated:      () => void;
  // When provided, the sheet operates in member-cancel mode (instead of admin).
  onMemberCancel?: () => Promise<{ error?: string }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ownerDisplayName(profile: OwnerProfile): string {
  const first = profile.first_name ?? "";
  const last  = profile.last_name  ?? "";
  const full  = [first, last].filter(Boolean).join(" ");
  return full || "Unknown member";
}

function mapCancelError(message: string): string {
  if (message === STALE_CLUB_CONTEXT_ERROR)  return STALE_CLUB_MESSAGE;
  if (message === "reservation_not_found") return "This booking has already been cancelled.";
  if (message === "insufficient_role")     return "You do not have permission to cancel this booking.";
  return "Something went wrong. Please try again.";
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ReservationDetailSheet({
  reservation, courts, clubTimezone, clubId, isAdmin, onClose, onCancelled, onUpdated, onMemberCancel,
}: Props) {
  const supabase = useMemo(() => createClient(), []);

  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [ownerProfile, setOwnerProfile] = useState<OwnerProfile | null>(null);
  const [editOpen, setEditOpen]         = useState(false);

  useEffect(() => {
    // Owner-profile fetch is only needed for admin mode (to display "Booked by").
    // In member-cancel mode the member is viewing their own booking — skip the fetch.
    if (onMemberCancel) return;

    supabase
      .from("profiles")
      .select("id, first_name, last_name")
      .eq("id", reservation.owner_user_id)
      .single()
      .then(({ data }) => { if (data) setOwnerProfile(data); });
  }, [reservation.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const ownerName = ownerProfile ? ownerDisplayName(ownerProfile) : "Loading…";

  // Admin may edit only a confirmed member_booking reservation whose start
  // is still in the future. Member and Pro owners never see Edit — the
  // first reservation-edit release is admin-only. Authorization comes
  // exclusively from the explicit isAdmin prop, never from whether
  // onMemberCancel happens to be supplied — callback presence is a
  // display-mode signal (member-cancel mode vs. admin mode), not proof of
  // role, and must never substitute for a real authorization check.
  const canEdit =
    isAdmin &&
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

        {/* Owner — admin mode only; member is viewing their own booking */}
        {!onMemberCancel && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Booked by {ownerName}</p>
        )}

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
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); onUpdated(); }}
        />
      )}
    </>
  );
}
