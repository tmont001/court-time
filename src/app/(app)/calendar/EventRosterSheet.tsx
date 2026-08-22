"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import {
  adminRemoveParticipant,
  adminForceConfirm,
  adminOfferSpot,
  adminExpireOffer,
  adminRemoveGuest,
  adminAddGuest,
  adminAddRosterParticipant,
  adminRemoveRosterParticipant,
  adminForceConfirmRosterParticipant,
  adminOfferSpotRosterParticipant,
  adminExpireOfferRosterParticipant,
  markAttendance,
  markAttendanceRosterParticipant,
  markAttendanceGuest,
} from "@/app/(app)/admin/events/actions";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { canAccessOperationsWorkspace, isOperator } from "@/lib/auth/roles";
import {
  ACTION_BUTTON_SECONDARY,
  ACTION_BUTTON_DESTRUCTIVE_COMPACT,
  ACTION_BUTTON_POSITIVE_COMPACT,
  ACTION_BUTTON_INFO_COMPACT,
  ACTION_BUTTON_PRIMARY_COMPACT_TOUCH,
} from "@/app/(app)/events/actionButtonStyles";
import PaymentStateBadge from "@/components/PaymentStateBadge";
import RecordPaymentSheet from "@/components/RecordPaymentSheet";
import { fetchPaymentStates } from "@/app/(app)/admin/payments/actions";
import { isPaymentOpenForRecording, type PaymentStateRow } from "@/lib/payments";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RosterRow {
  // Phase 33D2: null for a no-account roster Member added directly as a
  // participant (event_participants.profile_id, now nullable) — never
  // null for a guest row (event_guests.id is always populated here).
  profile_id:        string | null;
  display_name:      string;
  role:              string;
  status:            string;
  attendance_status: string | null;
  offer_expires_at:  string | null;
  waitlist_position: number | null;
  roster_member_id:  string | null;
}

// Phase 33E2 (0118): id is always a roster_member_id — get_event_eligible_
// members is the single source for both claimed and no-account candidates,
// and admin_add_roster_participant safely handles both identity classes
// keyed by roster_member_id, so no source discriminant is needed anymore.
interface MemberOption {
  id:           string;
  display_name: string;
}

// Phase 33D2: a stable per-row key/action-target that works whether the
// row is profile_id-keyed (guest, or a claimed participant) or only
// roster_member_id-keyed (a no-account participant added directly to
// event_participants). Every row has at least one of the two.
function rowKey(row: RosterRow): string {
  return row.profile_id ?? row.roster_member_id ?? "";
}

// Minimal participant shape needed by parent components to update occupancy
// counts (and, for EventDetailSheet, claim-continuity ownership matching).
export type RosterParticipantRow = { profile_id: string | null; roster_member_id: string | null; role: string; status: string };

interface Props {
  eventId:          string;
  // The club this sheet's page was rendered for (the admin's active club).
  // Passed through to the roster-mutation actions as expectedClubId so they
  // can detect a stale club context before writing (Phase 26F1). Distinct
  // from the `eventClubId` state below, which is the event's own club_id,
  // fetched separately for the member-picker query.
  clubId:           string;
  onClose:          () => void;
  clubTimezone?:    string;
  userRole?:        string;
  // When true, all mutation controls are hidden and a read-only notice is shown.
  // Used for archived events.
  readOnly?:        boolean;
  // Increment to trigger a roster reload (e.g. after join/leave in parent).
  refreshTick?:     number;
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

export default function EventRosterSheet({ eventId, clubId, onClose, clubTimezone, userRole, readOnly = false, refreshTick, onRosterChange }: Props) {
  const supabase = useMemo(() => createClient(), []);
  // Phase 34A: admin+pro+staff (canAccessOperationsWorkspace) — every RPC
  // this flag gates (admin_add_roster_participant, admin_remove_*,
  // admin_force_confirm*, admin_offer_spot*, admin_expire_offer*,
  // mark_attendance*) was widened to the same three roles with no
  // ownership restriction (0136), so this single choke point widens
  // identically for all of them.
  const isAdmin  = canAccessOperationsWorkspace(userRole);
  // Phase 34C — Record Payment is strictly Admin+Staff, never Pro. Distinct
  // from `isAdmin` above (which, despite its name, means "operations
  // workspace access" = admin+pro+staff) — using that for payments would
  // incorrectly grant Pro a financial action.
  const canRecordPayment = isOperator(userRole);

  // ── Roster state ──────────────────────────────────────────────────────────
  const [rows, setRows]               = useState<RosterRow[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [rowUpdating, setRowUpdating] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors]     = useState<Map<string, string>>(new Map());

  // ── Payment state — Phase 34C ─────────────────────────────────────────────
  // get_event_roster does not expose the underlying event_participants.id
  // (only profile_id/roster_member_id), which is required as
  // payments.domain_id — resolved via a small direct table read (RLS-
  // permitted, same-club) rather than widening that RPC. Guests need no
  // such lookup: a guest row's `profile_id` field IS event_guests.id
  // already (see handleMarkGuest's own comment on this same aliasing).
  const [paymentStateByRowKey, setPaymentStateByRowKey] = useState<Map<string, PaymentStateRow>>(new Map());
  const [recordPaymentTarget, setRecordPaymentTarget] = useState<{
    rowKey: string; domainType: "event_participant" | "event_guest"; domainId: string; title: string;
  } | null>(null);

  async function loadPaymentStates(currentRows: RosterRow[]) {
    const confirmedRows = currentRows.filter(r => r.status === "confirmed" && r.role !== "guest" && r.role !== "host");
    const guestRows     = currentRows.filter(r => r.role === "guest");

    const idByKey: Map<string, string> = new Map();
    const keyById: Map<string, string> = new Map();
    if (confirmedRows.length > 0) {
      const { data } = await supabase
        .from("event_participants")
        .select("id, profile_id, roster_member_id")
        .eq("event_id", eventId)
        .eq("status", "confirmed");
      for (const p of data ?? []) {
        const k = p.profile_id ?? p.roster_member_id ?? "";
        if (!k) continue;
        idByKey.set(k, p.id);
        keyById.set(p.id, k);
      }
    }

    const participantDomainIds = confirmedRows
      .map(r => idByKey.get(rowKey(r)))
      .filter((id): id is string => !!id);
    const guestDomainIds = guestRows.map(r => rowKey(r)).filter(Boolean);

    const [pResult, gResult] = await Promise.all([
      participantDomainIds.length > 0
        ? fetchPaymentStates("event_participant", participantDomainIds)
        : Promise.resolve({ data: [] as PaymentStateRow[] }),
      guestDomainIds.length > 0
        ? fetchPaymentStates("event_guest", guestDomainIds)
        : Promise.resolve({ data: [] as PaymentStateRow[] }),
    ]);

    const byRowKey = new Map<string, PaymentStateRow>();
    for (const p of pResult.data ?? []) {
      const rk = keyById.get(p.domain_id);
      if (rk) byRowKey.set(rk, p);
    }
    for (const g of gResult.data ?? []) {
      byRowKey.set(g.domain_id, g); // guest rowKey === domain_id directly
    }
    setPaymentStateByRowKey(byRowKey);
  }

  // ── Club / member picker state ────────────────────────────────────────────
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
          // eslint-disable-next-line no-console
          console.error("[EventRosterSheet] get_event_roster failed:", rpcError.message);
          setError("Unable to load roster. Please try again.");
        } else {
          const fetched = (data as RosterRow[]) ?? [];
          setRows(fetched);
          loadPaymentStates(fetched);
          // Notify parent so it can update occupancy counts without a page reload.
          if (onRosterChange) {
            onRosterChange(
              fetched.filter(r => r.role !== "guest").map(r => ({
                profile_id:       r.profile_id,
                roster_member_id: r.roster_member_id,
                role:             r.role,
                status:           r.status,
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
  }, [eventId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload roster when parent signals a join/leave has occurred.
  useEffect(() => {
    if (refreshTick === undefined || refreshTick === 0) return;
    loadRoster();
  }, [refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Attendance handler ────────────────────────────────────────────────────

  // Phase 33D2a: takes the whole row so it can dispatch to the profile_id-
  // keyed RPC for a claimed participant or the roster_member_id-keyed RPC
  // for a no-account one — every row has exactly one of the two.
  async function handleMark(row: RosterRow, newStatus: string | null) {
    const key = rowKey(row);
    const prevRows = rows;
    setRows(prev => prev.map(r =>
      rowKey(r) === key ? { ...r, attendance_status: newStatus } : r
    ));
    setRowUpdating(prev => new Set(prev).add(key));
    setRowErrors(prev => { const next = new Map(prev); next.delete(key); return next; });

    const result = row.profile_id
      ? await markAttendance(eventId, row.profile_id, newStatus, clubId)
      : await markAttendanceRosterParticipant(eventId, row.roster_member_id!, newStatus, clubId);

    setRowUpdating(prev => { const next = new Set(prev); next.delete(key); return next; });
    if (result.error) {
      setRows(prevRows);
      const code = result.error.trim();
      const msg = code === STALE_CLUB_CONTEXT_ERROR
        ? STALE_CLUB_MESSAGE
        : code === "event_archived"
          ? "This event is archived and its roster is read-only."
          : "Failed to update. Please try again.";
      setRowErrors(prev => new Map(prev).set(key, msg));
    }
  }

  // Phase 33E2: true-Guest attendance parity — a guest row's `profile_id`
  // field is actually event_guests.id (aliased by get_event_roster's
  // guest_rows CTE), so it doubles as the guest's own row key/target here.
  async function handleMarkGuest(row: RosterRow, newStatus: string | null) {
    const key = rowKey(row);
    const prevRows = rows;
    setRows(prev => prev.map(r =>
      rowKey(r) === key ? { ...r, attendance_status: newStatus } : r
    ));
    setRowUpdating(prev => new Set(prev).add(key));
    setRowErrors(prev => { const next = new Map(prev); next.delete(key); return next; });

    const result = await markAttendanceGuest(eventId, row.profile_id!, newStatus, clubId);

    setRowUpdating(prev => { const next = new Set(prev); next.delete(key); return next; });
    if (result.error) {
      setRows(prevRows);
      const code = result.error.trim();
      const msg = code === STALE_CLUB_CONTEXT_ERROR
        ? STALE_CLUB_MESSAGE
        : code === "event_archived"
          ? "This event is archived and its roster is read-only."
          : "Failed to update. Please try again.";
      setRowErrors(prev => new Map(prev).set(key, msg));
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

  // Phase 33E2 (0118): single admin+pro, club-scoped, roster_members-
  // sourced eligibility RPC — replaces the old dual profiles/get_members
  // (claimed) + get_roster_members (no-account) lookup, which either used
  // profiles.status (a stale legacy projection that never clears on
  // club_memberships removal — see 0081's trg_project_membership_to_profile)
  // or left the claimed source empty for a Pro caller (get_members is
  // admin-only). get_event_eligible_members is authorized identically to
  // every other Event roster-management RPC (admin, pro, or staff — same
  // club; 0136), so every operator role gets a correct, identical
  // candidate list.
  async function openAddMember() {
    setAddMemberOpen(true);
    setAddMemberError(null);
    setMembersLoading(true);
    setMemberList([]);

    // Excludes a roster identity already on the roster via EITHER path — a
    // linked event_guests row (unclaimed-only, legacy) or a direct event_
    // participants row (claimed or no-account, current). get_event_
    // eligible_members already excludes active event_participants rows
    // server-side; this additionally covers the legacy event_guests link,
    // which that RPC does not check.
    const activeRosterIds = new Set(
      rows
        .filter(r => r.roster_member_id && (r.role === "guest" || r.status !== "cancelled"))
        .map(r => r.roster_member_id!),
    );

    const { data, error } = await supabase.rpc("get_event_eligible_members", { p_event_id: eventId });
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[EventRosterSheet] get_event_eligible_members failed:", error.message);
    }

    const eligible: MemberOption[] = (data ?? [])
      .filter(m => !activeRosterIds.has(m.roster_member_id))
      .map(m => ({
        id:           m.roster_member_id,
        display_name: m.has_account ? m.display_name : `${m.display_name} (No account yet)`,
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

    // Phase 33E2 (0118): every candidate is now keyed by roster_member_id
    // (claimed or no-account) — admin_add_roster_participant resolves the
    // linked account internally (claimed_by, possibly null) and handles
    // both identity classes safely, so a single dispatch path replaces the
    // old profile-vs-roster branch.
    const result = await adminAddRosterParticipant(eventId, selectedMemberId, clubId);

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
    const result = await adminAddGuest(eventId, name, clubId);
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

  const rosterGuests = rows.filter(r => r.role === "guest" && r.roster_member_id);
  const anonGuests   = rows.filter(r => r.role === "guest" && !r.roster_member_id);
  // Exclude host rows from the attending display — creators are recorded via
  // events.created_by and join the roster only if explicitly added (Phase 21I-D).
  // Old events may still carry a legacy host row; filtering prevents double-counting.
  const confirmed    = rows.filter(r => r.status === "confirmed" && r.role !== "guest" && r.role !== "host");
  const offered      = rows.filter(r => r.status === "offered");
  const waitlisted   = rows.filter(r => r.status === "waitlisted");
  const totalAttending = confirmed.length + rosterGuests.length + anonGuests.length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
    {/* On mobile: z-60 backdrop / z-70 panel to layer above EventDetailSheet.
        On desktop: ResponsiveSheet uses default z-40/z-50 (EventDetailSheet not visible).
        This sheet is always the topmost overlay when open (nothing nests above
        it), so it never needs `active={false}` itself — it owns its own real
        drag/Escape/focus-trap/backdrop now instead of deferring to Phase 29B2. */}
    <ResponsiveSheet
      onClose={onClose}
      variant="panel"
      mobileBackdropZ={60}
      mobilePanelZ={70}
      mobileInteraction="draggable"
      label="Roster"
      header={
        <div className="flex items-center justify-between">
          <div>
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Roster</p>
            {!loading && !error && totalAttending > 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {totalAttending} attending
              </p>
            )}
          </div>
          {/* Close — mobile only; desktop uses ResponsiveSheet × button */}
          <button onClick={onClose} className="text-sm text-gray-400 font-medium md:hidden">Close</button>
        </div>
      }
    >
          {loading && (
            <p className="text-sm text-gray-400 py-8 text-center">Loading roster…</p>
          )}

          {!loading && error && (
            <p className="text-sm text-red-500 py-8 text-center">{error}</p>
          )}

          {!loading && !error && (
            <>
              {/* Read-only notice — shown for archived events */}
              {readOnly && (
                <div className="mb-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/60 px-3 py-2">
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Archived event — roster is read-only.
                  </p>
                </div>
              )}

              {/* ── Admin controls: Add Member / Add Guest ─────────────── */}
              {isAdmin && !readOnly && (
                <div className="mb-5 space-y-3">

                  {/* Add Member */}
                  {!addMemberOpen ? (
                    <button
                      onClick={openAddMember}
                      className={ACTION_BUTTON_SECONDARY}
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
                            className="flex-1 min-w-0 text-base md:text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1.5"
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
                      className={`block ${ACTION_BUTTON_SECONDARY}`}
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
                          className="flex-1 min-w-0 text-base md:text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1.5 placeholder-gray-400 dark:placeholder-gray-500"
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
                <p className={`text-sm text-gray-400 text-center ${isAdmin && !readOnly ? "py-4" : "py-8"}`}>
                  No participants yet.
                </p>
              ) : (
                <>
                  {/* ── Signed-in members ─────────────────────────────── */}
                  {confirmed.length > 0 && (
                    <div className="mb-5">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        Signed-In Members ({confirmed.length})
                      </p>
                      {confirmed.map(row => {
                        const key         = rowKey(row);
                        const isUpdating  = rowUpdating.has(key);
                        const rowError    = rowErrors.get(key);
                        // Phase 33D2: a no-account participant added directly
                        // via admin_add_roster_participant — never a Guest.
                        const isNoAccount = row.role !== "guest" && !row.profile_id;
                        return (
                          <div
                            key={key}
                            className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0"
                          >
                            <div className="flex items-center">
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate flex items-center gap-1.5">
                                  <span className="truncate">{row.display_name}</span>
                                  {isNoAccount && (
                                    <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                                      No account yet
                                    </span>
                                  )}
                                </p>
                                {row.role === "host" && (
                                  <p className="text-xs text-gray-400 mt-0.5">Host</p>
                                )}
                              </div>
                              {isAdmin && !readOnly && row.role !== "host" && (
                                <button
                                  disabled={isUpdating}
                                  onClick={() => handleAdminAction(key, () =>
                                    isNoAccount
                                      ? adminRemoveRosterParticipant(eventId, row.roster_member_id!, clubId)
                                      : adminRemoveParticipant(eventId, row.profile_id!, clubId)
                                  )}
                                  className={`ml-3 shrink-0 ${ACTION_BUTTON_DESTRUCTIVE_COMPACT}`}
                                >
                                  {isUpdating ? "…" : "Remove"}
                                </button>
                              )}
                            </div>

                            {/* Attendance: interactive controls (editable) or status label
                                (read-only). Phase 33D2a: roster-aware for both claimed and
                                no-account rows — handleMark dispatches to the profile_id-
                                or roster_member_id-keyed RPC based on the row itself. */}
                            {readOnly ? (
                              row.attendance_status && (
                                <div className="mt-1.5">
                                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                    row.attendance_status === "attended"
                                      ? "bg-green-100 text-green-700"
                                      : "bg-red-100 text-red-600"
                                  }`}>
                                    {row.attendance_status === "attended" ? "Attended" : "No-show"}
                                  </span>
                                </div>
                              )
                            ) : (
                              <div className="flex gap-1.5 mt-1.5 flex-wrap">
                                <button
                                  disabled={isUpdating}
                                  onClick={() => handleMark(row, "attended")}
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
                                  onClick={() => handleMark(row, "no_show")}
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
                                    onClick={() => handleMark(row, null)}
                                    className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 disabled:opacity-40"
                                  >
                                    Clear
                                  </button>
                                )}
                              </div>
                            )}

                            {/* Payment state — Phase 34C. Admin/Staff only
                                (never Pro — see canRecordPayment's own
                                comment above). Renders nothing when there
                                is no payment row. */}
                            {paymentStateByRowKey.get(key) && (
                              <div className="mt-1.5 flex flex-col sm:flex-row sm:items-center gap-2">
                                <PaymentStateBadge state={paymentStateByRowKey.get(key)} />
                                {canRecordPayment && !readOnly && isPaymentOpenForRecording(paymentStateByRowKey.get(key)) && (
                                  <button
                                    onClick={() => setRecordPaymentTarget({
                                      rowKey: key,
                                      domainType: "event_participant",
                                      domainId: paymentStateByRowKey.get(key)!.current_payment_id,
                                      title: row.display_name,
                                    })}
                                    className={ACTION_BUTTON_PRIMARY_COMPACT_TOUCH}
                                  >
                                    Record Payment
                                  </button>
                                )}
                              </div>
                            )}

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
                        const isExpired   = row.offer_expires_at
                          ? new Date(row.offer_expires_at) <= new Date()
                          : false;
                        const key         = rowKey(row);
                        const isUpdating  = rowUpdating.has(key);
                        const rowError    = rowErrors.get(key);
                        // Phase 33D2a: roster-aware for both claimed and
                        // no-account rows — dispatches to the profile_id- or
                        // roster_member_id-keyed RPC based on the row itself.
                        const isNoAccount = !row.profile_id;
                        return (
                          <div
                            key={key}
                            className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0"
                          >
                            <div className="flex items-start">
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate flex items-center gap-1.5">
                                  <span className="truncate">{row.display_name}</span>
                                  {isNoAccount && (
                                    <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                                      No account yet
                                    </span>
                                  )}
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
                              {isAdmin && !readOnly && (
                                <div className="ml-3 flex gap-2 items-center shrink-0">
                                  <button
                                    disabled={isUpdating}
                                    onClick={() => handleAdminAction(key, () =>
                                      isNoAccount
                                        ? adminForceConfirmRosterParticipant(eventId, row.roster_member_id!, clubId)
                                        : adminForceConfirm(eventId, row.profile_id!, clubId)
                                    )}
                                    className={ACTION_BUTTON_POSITIVE_COMPACT}
                                  >
                                    {isUpdating ? "…" : "Force Confirm"}
                                  </button>
                                  <button
                                    disabled={isUpdating}
                                    onClick={() => handleAdminAction(key, () =>
                                      isNoAccount
                                        ? adminExpireOfferRosterParticipant(eventId, row.roster_member_id!, clubId)
                                        : adminExpireOffer(eventId, row.profile_id!, clubId)
                                    )}
                                    className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
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
                        const key         = rowKey(row);
                        const isUpdating  = rowUpdating.has(key);
                        const rowError    = rowErrors.get(key);
                        // Phase 33D2a: force-confirm/offer-spot are now
                        // roster-aware for both claimed and no-account rows.
                        const isNoAccount = !row.profile_id;
                        return (
                          <div
                            key={key}
                            className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0"
                          >
                            <div className="flex items-center">
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate flex items-center gap-1.5">
                                  <span className="truncate">{row.display_name}</span>
                                  {isNoAccount && (
                                    <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                                      No account yet
                                    </span>
                                  )}
                                </p>
                              </div>
                              <div className="ml-3 flex items-center gap-2 shrink-0">
                                {row.waitlist_position !== null && (
                                  <span className="text-xs font-semibold text-amber-600">
                                    #{row.waitlist_position}
                                  </span>
                                )}
                                {isAdmin && !readOnly && (
                                  <>
                                    <button
                                      disabled={isUpdating}
                                      onClick={() => handleAdminAction(key, () =>
                                        isNoAccount
                                          ? adminForceConfirmRosterParticipant(eventId, row.roster_member_id!, clubId)
                                          : adminForceConfirm(eventId, row.profile_id!, clubId)
                                      )}
                                      className={ACTION_BUTTON_POSITIVE_COMPACT}
                                    >
                                      {isUpdating ? "…" : "Force Confirm"}
                                    </button>
                                    <button
                                      disabled={isUpdating}
                                      onClick={() => handleAdminAction(key, () =>
                                        isNoAccount
                                          ? adminOfferSpotRosterParticipant(eventId, row.roster_member_id!, clubId)
                                          : adminOfferSpot(eventId, row.profile_id!, clubId)
                                      )}
                                      className={ACTION_BUTTON_INFO_COMPACT}
                                    >
                                      {isUpdating ? "…" : "Offer Spot"}
                                    </button>
                                  </>
                                )}
                                {isAdmin && !readOnly && isNoAccount && (
                                  <button
                                    disabled={isUpdating}
                                    onClick={() => handleAdminAction(key, () =>
                                      adminRemoveRosterParticipant(eventId, row.roster_member_id!, clubId)
                                    )}
                                    className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
                                  >
                                    {isUpdating ? "…" : "Remove"}
                                  </button>
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

                  {/* ── No account yet (roster-linked) ──────────────────── */}
                  {rosterGuests.length > 0 && (
                    <div className="mb-5">
                      <p className="text-xs font-semibold text-amber-600 dark:text-amber-500 uppercase tracking-wide mb-2">
                        No Account Yet ({rosterGuests.length})
                      </p>
                      {rosterGuests.map(row => {
                        const key        = rowKey(row);
                        const isUpdating = rowUpdating.has(key);
                        const rowError   = rowErrors.get(key);
                        return (
                          <div
                            key={key}
                            className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0"
                          >
                            <div className="flex items-center">
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                  {row.display_name}
                                </p>
                              </div>
                              {isAdmin && !readOnly && (
                                <button
                                  disabled={isUpdating}
                                  onClick={() => handleAdminAction(key, () =>
                                    adminRemoveGuest(eventId, row.profile_id!, clubId)
                                  )}
                                  className={`ml-3 shrink-0 ${ACTION_BUTTON_DESTRUCTIVE_COMPACT}`}
                                >
                                  {isUpdating ? "…" : "Remove"}
                                </button>
                              )}
                            </div>

                            {/* Phase 33E2: Guest attendance — same UX pattern as Member rows. */}
                            {readOnly ? (
                              row.attendance_status && (
                                <div className="mt-1.5">
                                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                    row.attendance_status === "attended"
                                      ? "bg-green-100 text-green-700"
                                      : "bg-red-100 text-red-600"
                                  }`}>
                                    {row.attendance_status === "attended" ? "Attended" : "No-show"}
                                  </span>
                                </div>
                              )
                            ) : (
                              <div className="flex gap-1.5 mt-1.5 flex-wrap">
                                <button
                                  disabled={isUpdating}
                                  onClick={() => handleMarkGuest(row, "attended")}
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
                                  onClick={() => handleMarkGuest(row, "no_show")}
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
                                    onClick={() => handleMarkGuest(row, null)}
                                    className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 disabled:opacity-40"
                                  >
                                    Clear
                                  </button>
                                )}
                              </div>
                            )}

                            {/* Payment state — Phase 34C. Guest obligations
                                are operator-only (guest payer identity is
                                intentionally unresolved) — never shown to
                                Members, and this whole sheet is already
                                operator-scoped. */}
                            {paymentStateByRowKey.get(key) && (
                              <div className="mt-1.5 flex flex-col sm:flex-row sm:items-center gap-2">
                                <PaymentStateBadge state={paymentStateByRowKey.get(key)} />
                                {canRecordPayment && !readOnly && isPaymentOpenForRecording(paymentStateByRowKey.get(key)) && (
                                  <button
                                    onClick={() => setRecordPaymentTarget({
                                      rowKey: key,
                                      domainType: "event_guest",
                                      domainId: paymentStateByRowKey.get(key)!.current_payment_id,
                                      title: row.display_name,
                                    })}
                                    className={ACTION_BUTTON_PRIMARY_COMPACT_TOUCH}
                                  >
                                    Record Payment
                                  </button>
                                )}
                              </div>
                            )}

                            {rowError && (
                              <p className="text-xs text-red-500 mt-1">{rowError}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* ── Guests (anonymous) ─────────────────────────────── */}
                  {anonGuests.length > 0 && (
                    <div className="mb-5">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        Guests ({anonGuests.length})
                      </p>
                      {anonGuests.map(row => {
                        const key        = rowKey(row);
                        const isUpdating = rowUpdating.has(key);
                        const rowError   = rowErrors.get(key);
                        return (
                          <div
                            key={key}
                            className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0"
                          >
                            <div className="flex items-center">
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                  {row.display_name}
                                </p>
                              </div>
                              {isAdmin && !readOnly && (
                                <button
                                  disabled={isUpdating}
                                  onClick={() => handleAdminAction(key, () =>
                                    adminRemoveGuest(eventId, row.profile_id!, clubId)
                                  )}
                                  className={`ml-3 shrink-0 ${ACTION_BUTTON_DESTRUCTIVE_COMPACT}`}
                                >
                                  {isUpdating ? "…" : "Remove"}
                                </button>
                              )}
                            </div>

                            {/* Phase 33E2: Guest attendance — same UX pattern as Member rows. */}
                            {readOnly ? (
                              row.attendance_status && (
                                <div className="mt-1.5">
                                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                    row.attendance_status === "attended"
                                      ? "bg-green-100 text-green-700"
                                      : "bg-red-100 text-red-600"
                                  }`}>
                                    {row.attendance_status === "attended" ? "Attended" : "No-show"}
                                  </span>
                                </div>
                              )
                            ) : (
                              <div className="flex gap-1.5 mt-1.5 flex-wrap">
                                <button
                                  disabled={isUpdating}
                                  onClick={() => handleMarkGuest(row, "attended")}
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
                                  onClick={() => handleMarkGuest(row, "no_show")}
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
                                    onClick={() => handleMarkGuest(row, null)}
                                    className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 disabled:opacity-40"
                                  >
                                    Clear
                                  </button>
                                )}
                              </div>
                            )}

                            {/* Payment state — Phase 34C. Guest obligations
                                are operator-only (guest payer identity is
                                intentionally unresolved) — never shown to
                                Members, and this whole sheet is already
                                operator-scoped. */}
                            {paymentStateByRowKey.get(key) && (
                              <div className="mt-1.5 flex flex-col sm:flex-row sm:items-center gap-2">
                                <PaymentStateBadge state={paymentStateByRowKey.get(key)} />
                                {canRecordPayment && !readOnly && isPaymentOpenForRecording(paymentStateByRowKey.get(key)) && (
                                  <button
                                    onClick={() => setRecordPaymentTarget({
                                      rowKey: key,
                                      domainType: "event_guest",
                                      domainId: paymentStateByRowKey.get(key)!.current_payment_id,
                                      title: row.display_name,
                                    })}
                                    className={ACTION_BUTTON_PRIMARY_COMPACT_TOUCH}
                                  >
                                    Record Payment
                                  </button>
                                )}
                              </div>
                            )}

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

    </ResponsiveSheet>

    {recordPaymentTarget && (() => {
      const state = paymentStateByRowKey.get(recordPaymentTarget.rowKey);
      if (!state) return null;
      return (
        <RecordPaymentSheet
          paymentId={state.current_payment_id}
          clubId={clubId}
          amountDueCents={state.current_amount_due_cents}
          amountPaidCents={state.current_amount_paid_cents}
          currency={state.current_currency}
          title={recordPaymentTarget.title}
          onClose={() => setRecordPaymentTarget(null)}
          onRecorded={() => { setRecordPaymentTarget(null); loadPaymentStates(rows); }}
        />
      );
    })()}
    </>
  );
}
