"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { adminCancelReservation } from "./actions";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReservationBlock {
  id:            string;
  court_id:      string;
  owner_user_id: string;
  starts_at:     string;
  ends_at:       string;
  reason:        string;
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
  reservation:  ReservationBlock;
  courts:       Court[];
  clubTimezone: string;
  onClose:      () => void;
  onCancelled:  () => void;
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
  reservation, courts, clubTimezone, onClose, onCancelled,
}: Props) {
  const supabase = useMemo(() => createClient(), []);

  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [ownerProfile, setOwnerProfile] = useState<OwnerProfile | null>(null);

  useEffect(() => {
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

  // ── Action ────────────────────────────────────────────────────────────────

  async function handleCancel() {
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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 bg-white rounded-t-2xl z-50 px-6 pt-5 pb-8 shadow-xl">

        {/* Handle */}
        <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4" />

        {/* Court */}
        <p className="text-base font-semibold text-gray-900">{courtName}</p>

        {/* Date */}
        <p className="text-sm text-gray-500 mt-0.5">{dateLabel}</p>

        {/* Time */}
        <p className="text-sm text-gray-700 mt-0.5 font-medium">{startLabel} – {endLabel}</p>

        {/* Owner */}
        <p className="text-sm text-gray-500 mt-1">Booked by {ownerName}</p>

        {/* Error */}
        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}

        {/* Cancel */}
        <button
          disabled={loading}
          onClick={handleCancel}
          className="mt-5 w-full py-3 rounded-xl text-sm font-semibold bg-red-50 text-red-600 border border-red-200 disabled:opacity-40"
        >
          {loading ? "Cancelling…" : "Cancel Booking"}
        </button>

      </div>
    </>
  );
}
