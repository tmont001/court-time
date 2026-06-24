"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  adminRemoveParticipant,
  adminForceConfirm,
  adminOfferSpot,
  adminExpireOffer,
  adminRemoveGuest,
  adminAddMember,
  adminAddGuest,
} from "@/app/(app)/admin/events/actions";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RosterRow {
  profile_id:        string;
  display_name:      string;
  role:              string;
  status:            string;
  attendance_status: string | null;
  offer_expires_at:  string | null;
  waitlist_position: number | null;
}

interface MemberOption {
  id:           string;
  display_name: string;
}

// Minimal participant shape needed by parent components to update occupancy counts.
export type RosterParticipantRow = { profile_id: string; role: string; status: string };

interface Props {
  eventId:          string;
  onClose:          () => void;
  clubTimezone?:    string;
  userRole?:        string;
  // Called after every successful roster fetch so parents can update occupancy counts.
  onRosterChange?: (participantRows: RosterParticipantRow[], guestCount: number) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatExpiryTime(isoString: string, tz?: string): string {
  return new Date(isoString).toLocaleTimeString("en-US", {
    ...(tz ? { timeZone: tz } : {}),
    hour:   "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function EventRosterSheet({ eventId, onClose, clubTimezone, userRole, onRosterChange }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const isAdmin  = userRole === "admin" || userRole === "pro";

  // ── Roster state ──────────────────────────────────────────────────────────
  const [rows, setRows]               = useState<RosterRow[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [rowUpdating, setRowUpdating] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors]     = useState<Map<string, string>>(new Map());

  // ── Club / member picker state ────────────────────────────────────────────
  const [clubId, setClubId]                   = useState<string | null>(null);
  const [addMemberOpen, setAddMemberOpen]     = useState(false);
  const [memberList, setMemberList]           = useState<MemberOption[]>([]);
  const [membersLoading, setMembersLoading]   = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [addMemberLoading, setAddMemberLoading] = useState(false);
  const [addMemberError, setAddMemberError]     = useState<string | null>(null);

  // ── Add guest state ────────────────────────────────────────────────────────
  const [addGuestOpen, setAddGuestOpen]     = useState(false);
  const [guestName, setGuestName]           = useState("");
  const [addGuestLoading, setAddGuestLoading] = useState(false);
  const [addGuestError, setAddGuestError]     = useState<string | null>(null);

  // ── Fetch roster ───────────────────────────────────────────────────────────

  function loadRoster() {
    setLoading(true);
    setError(null);
    supabase
      .rpc("get_event_roster", { p_event_id: eventId })
      .then(({ data, error: rpcError }) => {
        if (rpcError) {
          setError("Unable to load roster. Please try again.");
        } else {
          const fetched = (data as RosterRow[]) ?? [];
          setRows(fetched);
          // Notify parent so it can update occupancy counts without a page reload.
          if (onRosterChange) {
            onRosterChange(
              fetched.filter(r => r.role !== "guest").map(r => ({
                profile_id: r.profile_id,
                role:       r.role,
                status:     r.status,
              })),
              fetched.filter(r => r.role === "guest").length,
            );
          }
        }
        setLoading(false);
      });
  }

  useEffect(() => {
    loadRoster();
    if (isAdmin) {
      supabase
        .from("events")
        .select("club_id")
        .eq("id", eventId)
        .single()
        .then(({ data }) => { if (data?.club_id) setClubId(data.club_id); });
    }
  }, [eventId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Attendance handler ────────────────────────────────────────────────────

  async function handleMark(profileId: string, newStatus: string | null) {
    const prevRows = rows;
    setRows(prev => prev.map(r =>
      r.profile_id === profileId ? { ...r, attendance_status: newStatus } : r
    ));
    setRowUpdating(prev => new Set(prev).add(profileId));
    setRowErrors(prev => { const next = new Map(prev); next.delete(profileId); return next; });

    const { error: rpcError } = await supabase.rpc("mark_attendance", {
      p_event_id:          eventId,
      p_profile_id:        profileId,
      p_attendance_status: newStatus,
    });

    setRowUpdating(prev => { const next = new Set(prev); next.delete(profileId); return next; });
    if (rpcError) {
      setRows(prevRows);
      setRowErrors(prev => new Map(prev).set(profileId, "Failed to update. Please try again."));
    }
  }

  // ── Admin per-row action ──────────────────────────────────────────────────

  async function handleAdminAction(
    key:    string,
    action: () => Promise<{ error?: string }>,
  ) {
    setRowUpdating(prev => new Set(prev).add(key));
    setRowErrors(prev => { const next = new Map(prev); next.delete(key); return next; });
    const result = await action();
    setRowUpdating(prev => { const next = new Set(prev); next.delete(key); return next; });
    if (result.error) {
      setRowErrors(prev => new Map(prev).set(key, result.error!));
      return;
    }
    loadRoster();
  }

  // ── Add Member ────────────────────────────────────────────────────────────

  async function openAddMember() {
    setAddMemberOpen(true);
    setAddMemberError(null);
    setMembersLoading(true);
    setMemberList([]);

    if (!clubId) {
      setMembersLoading(false);
      return;
    }

    const activeInEvent = new Set(
      rows
        .filter(r => r.status !== "cancelled" && r.role !== "guest")
        .map(r => r.profile_id),
    );

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, first_name, last_name")
      .eq("club_id", clubId)
      .eq("status", "active");

    const eligible: MemberOption[] = (profiles ?? [])
      .filter(p => !activeInEvent.has(p.id))
      .map(p => ({
        id:           p.id,
        display_name: [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unknown",
      }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));

    setMemberList(eligible);
    setSelectedMemberId(eligible[0]?.id ?? "");
    setMembersLoading(false);
  }

  async function handleAddMember() {
    if (!selectedMemberId) return;
    setAddMemberLoading(true);
    setAddMemberError(null);
    const result = await adminAddMember(eventId, selectedMemberId);
    setAddMemberLoading(false);
    if (result.error) {
      setAddMemberError(result.error);
      return;
    }
    setAddMemberOpen(false);
    setSelectedMemberId("");
    setMemberList([]);
    loadRoster();
  }

  // ── Add Guest ─────────────────────────────────────────────────────────────

  async function handleAddGuest() {
    const name = guestName.trim();
    if (!name) {
      setAddGuestError("Enter a guest name.");
      return;
    }
    setAddGuestLoading(true);
    setAddGuestError(null);
    const result = await adminAddGuest(eventId, name);
    setAddGuestLoading(false);
    if (result.error) {
      setAddGuestError(result.error);
      return;
    }
    setAddGuestOpen(false);
    setGuestName("");
    loadRoster();
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const guests    = rows.filter(r => r.role === "guest");
  const confirmed = rows.filter(r => r.status === "confirmed" && r.role !== "guest");
  const offered   = rows.filter(r => r.status === "offered");
  const waitlisted = rows.filter(r => r.status === "waitlisted");

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Backdrop — above EventDetailSheet (z-50) */}
      <div
        className="fixed inset-0 bg-black/50"
        style={{ zIndex: 60 }}
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        className="ct-sheet-enter fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 rounded-t-2xl shadow-xl flex flex-col"
        style={{ zIndex: 70, maxHeight: "80dvh" }}
      >
        {/* Header */}
        <div className="shrink-0 px-6 pt-5 pb-3">
          <div className="ct-handlebar mx-auto mb-4" />
          <div className="flex items-center justify-between">
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Roster</p>
            <button onClick={onClose} className="text-sm text-gray-400 font-medium">Close</button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto px-6 pb-8">

          {loading && (
            <p className="text-sm text-gray-400 py-8 text-center">Loading roster…</p>
          )}

          {!loading && error && (
            <p className="text-sm text-red-500 py-8 text-center">{error}</p>
          )}

          {!loading && !error && (
            <>
              {/* ── Admin controls: Add Member / Add Guest ─────────────── */}
              {isAdmin && (
                <div className="mb-5 space-y-3">

                  {/* Add Member */}
                  {!addMemberOpen ? (
                    <button
                      onClick={openAddMember}
                      className="text-xs font-medium text-blue-600"
                    >
                      + Add Member
                    </button>
                  ) : (
                    <div className="bg-gray-50 dark:bg-gray-700/60 rounded-xl px-3 py-3">
                      <p className="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-2">
                        Add Member
                      </p>
                      {membersLoading ? (
                        <p className="text-xs text-gray-400">Loading members…</p>
                      ) : memberList.length === 0 ? (
                        <p className="text-xs text-gray-400">No eligible members found.</p>
                      ) : (
                        <div className="flex gap-2 items-center">
                          <select
                            value={selectedMemberId}
                            onChange={e => setSelectedMemberId(e.target.value)}
                            className="flex-1 min-w-0 text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1.5"
                          >
                            {memberList.map(m => (
                              <option key={m.id} value={m.id}>{m.display_name}</option>
                            ))}
                          </select>
                          <button
                            disabled={addMemberLoading || !selectedMemberId}
                            onClick={handleAddMember}
                            className="shrink-0 text-xs font-semibold text-white bg-blue-600 px-3 py-1.5 rounded-lg disabled:opacity-40"
                          >
                            {addMemberLoading ? "Adding…" : "Add"}
                          </button>
                          <button
                            onClick={() => { setAddMemberOpen(false); setAddMemberError(null); }}
                            className="shrink-0 text-xs text-gray-400"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                      {addMemberError && (
                        <p className="text-xs text-red-500 mt-1.5">{addMemberError}</p>
                      )}
                    </div>
                  )}

                  {/* Add Guest */}
                  {!addGuestOpen ? (
                    <button
                      onClick={() => { setAddGuestOpen(true); setAddGuestError(null); }}
                      className="block text-xs font-medium text-blue-600"
                    >
                      + Add Guest
                    </button>
                  ) : (
                    <div className="bg-gray-50 dark:bg-gray-700/60 rounded-xl px-3 py-3">
                      <p className="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-2">
                        Add Guest
                      </p>
                      <div className="flex gap-2 items-center">
                        <input
                          type="text"
                          placeholder="Guest name"
                          value={guestName}
                          onChange={e => setGuestName(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") handleAddGuest(); }}
                          className="flex-1 min-w-0 text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1.5 placeholder-gray-400 dark:placeholder-gray-500"
                        />
                        <button
                          disabled={addGuestLoading}
                          onClick={handleAddGuest}
                          className="shrink-0 text-xs font-semibold text-white bg-blue-600 px-3 py-1.5 rounded-lg disabled:opacity-40"
                        >
                          {addGuestLoading ? "Adding…" : "Add"}
                        </button>
                        <button
                          onClick={() => { setAddGuestOpen(false); setGuestName(""); setAddGuestError(null); }}
                          className="shrink-0 text-xs text-gray-400"
                        >
                          Cancel
                        </button>
                      </div>
                      {addGuestError && (
                        <p className="text-xs text-red-500 mt-1.5">{addGuestError}</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {rows.length === 0 ? (
                <p className={`text-sm text-gray-400 text-center ${isAdmin ? "py-4" : "py-8"}`}>
                  No participants yet.
                </p>
              ) : (
                <>
                  {/* ── Confirmed ───────────────────────────────────────── */}
                  {confirmed.length > 0 && (
                    <div className="mb-5">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        Confirmed ({confirmed.length})
                      </p>
                      {confirmed.map(row => {
                        const isUpdating = rowUpdating.has(row.profile_id);
                        const rowError   = rowErrors.get(row.profile_id);
                        return (
                          <div
                            key={row.profile_id}
                            className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0"
                          >
                            <div className="flex items-center">
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                  {row.display_name}
                                </p>
                                {row.role === "host" && (
                                  <p className="text-xs text-gray-400 mt-0.5">Host</p>
                                )}
                              </div>
                              {isAdmin && row.role !== "host" && (
                                <button
                                  disabled={isUpdating}
                                  onClick={() => handleAdminAction(row.profile_id, () =>
                                    adminRemoveParticipant(eventId, row.profile_id)
                                  )}
                                  className="ml-3 shrink-0 text-[10px] font-semibold text-red-500 disabled:opacity-40"
                                >
                                  {isUpdating ? "…" : "Remove"}
                                </button>
                              )}
                            </div>

                            {/* Attendance controls */}
                            <div className="flex gap-1.5 mt-1.5 flex-wrap">
                              <button
                                disabled={isUpdating}
                                onClick={() => handleMark(row.profile_id, "attended")}
                                className={`px-2 py-0.5 rounded-full text-[10px] font-semibold disabled:opacity-40 ${
                                  row.attendance_status === "attended"
                                    ? "bg-green-100 text-green-700"
                                    : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                                }`}
                              >
                                Attended
                              </button>
                              <button
                                disabled={isUpdating}
                                onClick={() => handleMark(row.profile_id, "no_show")}
                                className={`px-2 py-0.5 rounded-full text-[10px] font-semibold disabled:opacity-40 ${
                                  row.attendance_status === "no_show"
                                    ? "bg-red-100 text-red-600"
                                    : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                                }`}
                              >
                                No-show
                              </button>
                              {row.attendance_status && (
                                <button
                                  disabled={isUpdating}
                                  onClick={() => handleMark(row.profile_id, null)}
                                  className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 disabled:opacity-40"
                                >
                                  Clear
                                </button>
                              )}
                            </div>

                            {rowError && (
                              <p className="text-xs text-red-500 mt-1">{rowError}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* ── Offered ─────────────────────────────────────────── */}
                  {offered.length > 0 && (
                    <div className="mb-5">
                      <p className="text-xs font-semibold text-amber-600 dark:text-amber-500 uppercase tracking-wide mb-2">
                        Offered ({offered.length})
                      </p>
                      {offered.map(row => {
                        const isExpired  = row.offer_expires_at
                          ? new Date(row.offer_expires_at) <= new Date()
                          : false;
                        const isUpdating = rowUpdating.has(row.profile_id);
                        const rowError   = rowErrors.get(row.profile_id);
                        return (
                          <div
                            key={row.profile_id}
                            className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0"
                          >
                            <div className="flex items-start">
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                  {row.display_name}
                                </p>
                                {row.offer_expires_at && (
                                  isExpired ? (
                                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                                      Expired {formatExpiryTime(row.offer_expires_at, clubTimezone)}
                                    </p>
                                  ) : (
                                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                                      Offer expires {formatExpiryTime(row.offer_expires_at, clubTimezone)}
                                    </p>
                                  )
                                )}
                              </div>
                              {isAdmin && (
                                <div className="ml-3 flex gap-2 items-center shrink-0">
                                  <button
                                    disabled={isUpdating}
                                    onClick={() => handleAdminAction(row.profile_id, () =>
                                      adminForceConfirm(eventId, row.profile_id)
                                    )}
                                    className="text-[10px] font-semibold text-green-600 disabled:opacity-40"
                                  >
                                    {isUpdating ? "…" : "Force Confirm"}
                                  </button>
                                  <button
                                    disabled={isUpdating}
                                    onClick={() => handleAdminAction(row.profile_id, () =>
                                      adminExpireOffer(eventId, row.profile_id)
                                    )}
                                    className="text-[10px] font-semibold text-red-500 disabled:opacity-40"
                                  >
                                    {isUpdating ? "…" : "Expire"}
                                  </button>
                                </div>
                              )}
                            </div>
                            {rowError && (
                              <p className="text-xs text-red-500 mt-1">{rowError}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* ── Waitlist ─────────────────────────────────────────── */}
                  {waitlisted.length > 0 && (
                    <div className="mb-5">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        Waitlist ({waitlisted.length})
                      </p>
                      {waitlisted.map(row => {
                        const isUpdating = rowUpdating.has(row.profile_id);
                        const rowError   = rowErrors.get(row.profile_id);
                        return (
                          <div
                            key={row.profile_id}
                            className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0"
                          >
                            <div className="flex items-center">
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                  {row.display_name}
                                </p>
                              </div>
                              <div className="ml-3 flex items-center gap-2 shrink-0">
                                {row.waitlist_position !== null && (
                                  <span className="text-xs font-semibold text-amber-600">
                                    #{row.waitlist_position}
                                  </span>
                                )}
                                {isAdmin && (
                                  <>
                                    <button
                                      disabled={isUpdating}
                                      onClick={() => handleAdminAction(row.profile_id, () =>
                                        adminForceConfirm(eventId, row.profile_id)
                                      )}
                                      className="text-[10px] font-semibold text-green-600 disabled:opacity-40"
                                    >
                                      {isUpdating ? "…" : "Force Confirm"}
                                    </button>
                                    <button
                                      disabled={isUpdating}
                                      onClick={() => handleAdminAction(row.profile_id, () =>
                                        adminOfferSpot(eventId, row.profile_id)
                                      )}
                                      className="text-[10px] font-semibold text-blue-600 disabled:opacity-40"
                                    >
                                      {isUpdating ? "…" : "Offer Spot"}
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                            {rowError && (
                              <p className="text-xs text-red-500 mt-1">{rowError}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* ── Guests ───────────────────────────────────────────── */}
                  {guests.length > 0 && (
                    <div className="mb-5">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        Guests ({guests.length})
                      </p>
                      {guests.map(row => {
                        const isUpdating = rowUpdating.has(row.profile_id);
                        const rowError   = rowErrors.get(row.profile_id);
                        return (
                          <div
                            key={row.profile_id}
                            className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0"
                          >
                            <div className="flex items-center">
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                  {row.display_name}
                                </p>
                              </div>
                              {isAdmin && (
                                <button
                                  disabled={isUpdating}
                                  onClick={() => handleAdminAction(row.profile_id, () =>
                                    adminRemoveGuest(eventId, row.profile_id)
                                  )}
                                  className="ml-3 shrink-0 text-[10px] font-semibold text-red-500 disabled:opacity-40"
                                >
                                  {isUpdating ? "…" : "Remove"}
                                </button>
                              )}
                            </div>
                            {rowError && (
                              <p className="text-xs text-red-500 mt-1">{rowError}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </>
          )}

        </div>
      </div>
    </>
  );
}
