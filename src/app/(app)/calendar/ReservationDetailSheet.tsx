"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { adminCancelReservation } from "./actions";
import ResponsiveSheet from "@/components/ResponsiveSheet";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReservationBlock {
  id:                    string;
  court_id:              string;
  owner_user_id:         string;
  starts_at:             string;
  ends_at:               string;
  reason:                string;
  notes:                 string | null;
  show_notes_to_members: boolean;
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
  onClose:        () => void;
  onCancelled:    () => void;
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
  if (message === "reservation_not_found") return "This booking has already been cancelled.";
  if (message === "insufficient_role")     return "You do not have permission to cancel this booking.";
  return "Something went wrong. Please try again.";
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ReservationDetailSheet({
  reservation, courts, clubTimezone, onClose, onCancelled, onMemberCancel,
}: Props) {
  const supabase = useMemo(() => createClient(), []);

  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [ownerProfile, setOwnerProfile] = useState<OwnerProfile | null>(null);

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

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleAdminCancel() {
    setLoading(true);
    setError(null);
    const result = await adminCancelReservation(reservation.id);
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
      setError(result.error);
      setLoading(false);
      return;
    }
    onCancelled();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <ResponsiveSheet onClose={onClose} variant="modal">
      <div className="px-6 pt-5 pb-8 overflow-y-auto flex-1">

      {/* Handle — hidden on desktop */}
      <div className="ct-handlebar mx-auto mb-4 md:hidden" />

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

      {/* Cancel — member mode or admin mode */}
      <button
        disabled={loading}
        onClick={onMemberCancel ? handleMemberCancel : handleAdminCancel}
        className="mt-5 w-full py-3 rounded-xl text-sm font-semibold bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 disabled:opacity-40"
      >
        {loading ? "Cancelling…" : "Cancel Booking"}
      </button>

      </div>
    </ResponsiveSheet>
  );
}
