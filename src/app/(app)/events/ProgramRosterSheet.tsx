"use client";

// ProgramRosterSheet — Phase 27D3B admin/pro whole-program roster sheet.
// Reuses the exact structural pattern already established by
// EventRosterSheet.tsx: ResponsiveSheet panel/sheet, reads via a direct
// browser-client RPC call (get_program_roster is SECURITY DEFINER and
// enforces its own authorization regardless of transport — no stale-club
// guard is needed for a read), writes via "use server" Server Actions
// (add_program_member/remove_program_member/add_program_roster_member/
// remove_program_roster_member/force_confirm_program_roster_member all need
// the stale-active-club preflight guard, which only runs server-side), and
// the same rowUpdating/rowErrors state shape for per-row loading and inline
// errors.
//
// program_enrollments remains the sole roster — this sheet adds no local
// participant/session/waitlist model of its own; it only renders what
// get_program_roster returns and calls the 0092/0115 write RPCs.
//
// Phase 33D2b: profile_id is null for a no-account roster Member enrolled
// directly (program_enrollments.profile_id, now nullable) — every row
// always carries a non-null roster_member_id, the durable enrollment/
// dispatch key regardless of claim status. Mirrors EventRosterSheet.tsx's
// identical profile/roster duality: rowKey(), a MemberOption.source split
// in the Add Member picker, "(No account yet)" labeling, and a roster-aware
// dispatch (profile-based RPC for a claimed row, roster-based RPC for a
// no-account row) for every mutating action.

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import {
  addProgramMember,
  removeProgramMember,
  addProgramRosterMember,
  removeProgramRosterMember,
  forceConfirmProgramRosterMember,
} from "./programRosterActions";
import { mapProgramError } from "./programErrors";
import { ACTION_BUTTON_SECONDARY, ACTION_BUTTON_PRIMARY, ACTION_BUTTON_DESTRUCTIVE_COMPACT, ACTION_BUTTON_POSITIVE_COMPACT } from "./actionButtonStyles";
import { isOperator } from "@/lib/auth/roles";
import PaymentStateBadge from "@/components/PaymentStateBadge";
import RecordPaymentSheet from "@/components/RecordPaymentSheet";
import { fetchPaymentStates } from "@/app/(app)/admin/payments/actions";
import { isPaymentOpenForRecording, type PaymentStateRow } from "@/lib/payments";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProgramRosterRow {
  enrollment_id:     string;
  program_id:        string;
  // Phase 33D2b: null for a no-account roster Member — never null for the
  // durable roster_member_id, which every row carries regardless of claim
  // status.
  profile_id:        string | null;
  roster_member_id:  string;
  first_name:        string | null;
  last_name:         string | null;
  email:             string | null;
  status:            "enrolled" | "waitlisted" | "offered" | "cancelled";
  waitlisted_at:     string | null;
  offer_expires_at:  string | null;
  created_at:        string;
  updated_at:        string;
}

interface MemberOption {
  id:           string;
  display_name: string;
  source:       "profile" | "roster";
}

interface Props {
  programId:     string;
  programTitle:  string;
  // The club this sheet's page was rendered for (the caller's active
  // club) — passed to the write actions as expectedClubId for the
  // stale-club preflight guard (Phase 26F1 pattern).
  clubId:        string;
  clubTimezone?: string;
  // Phase 34C — Record Payment is Admin+Staff only, never Pro (Pro can
  // reach this sheet for a program they created — see ProgramsManageClient's
  // own canManage gate — but must not gain financial authority from that).
  userRole?:     string;
  onClose:       () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function displayName(row: { first_name: string | null; last_name: string | null }): string {
  return [row.first_name, row.last_name].filter(Boolean).join(" ") || "Unknown";
}

function formatExpiryTime(isoString: string, tz?: string): string {
  return new Date(isoString).toLocaleTimeString("en-US", {
    ...(tz ? { timeZone: tz } : {}),
    hour:   "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// Phase 33D2b: a stable per-row key/action-target that works whether the
// row is profile_id-keyed (a claimed enrollee) or only roster_member_id-
// keyed (a no-account enrollee) — every row has at least one of the two,
// and roster_member_id is always present.
function rowKey(row: ProgramRosterRow): string {
  return row.profile_id ?? row.roster_member_id;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ProgramRosterSheet({ programId, programTitle, clubId, clubTimezone, userRole, onClose }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const router   = useRouter();
  const canRecordPayment = isOperator(userRole);

  // ── Roster state ──────────────────────────────────────────────────────────
  const [rows, setRows]               = useState<ProgramRosterRow[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [rowUpdating, setRowUpdating] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors]     = useState<Map<string, string>>(new Map());

  // ── Payment state — Phase 34C ─────────────────────────────────────────────
  // get_program_roster already returns enrollment_id directly (=
  // program_enrollments.id = payments.domain_id) — no extra lookup needed,
  // unlike the Event roster case.
  const [paymentStateByRowKey, setPaymentStateByRowKey] = useState<Map<string, PaymentStateRow>>(new Map());
  const [recordPaymentTarget, setRecordPaymentTarget] = useState<{ rowKey: string; title: string } | null>(null);

  async function loadPaymentStates(currentRows: ProgramRosterRow[]) {
    const enrolledRows = currentRows.filter(r => r.status === "enrolled");
    const enrollmentIds = enrolledRows.map(r => r.enrollment_id);
    if (enrollmentIds.length === 0) {
      setPaymentStateByRowKey(new Map());
      return;
    }
    const { data } = await fetchPaymentStates("program_enrollment", enrollmentIds);
    const idToRowKey = new Map(enrolledRows.map(r => [r.enrollment_id, rowKey(r)]));
    const byRowKey = new Map<string, PaymentStateRow>();
    for (const p of data ?? []) {
      const rk = idToRowKey.get(p.domain_id);
      if (rk) byRowKey.set(rk, p);
    }
    setPaymentStateByRowKey(byRowKey);
  }

  // ── Remove confirmation state — destructive action requires an explicit
  // second click naming the action, matching the requirement that Remove
  // use a confirmation step. Inline (expands in place on the row) rather
  // than a stacked modal, avoiding the z-index layering a third sheet on
  // top of this one would require.
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);

  // ── Add Member picker state ───────────────────────────────────────────────
  const [addMemberOpen, setAddMemberOpen]         = useState(false);
  const [memberList, setMemberList]               = useState<MemberOption[]>([]);
  const [membersLoading, setMembersLoading]       = useState(false);
  // Distinct from "memberList is empty" (a genuinely eligible-member-free
  // program) — a failed lookup must never be silently presented as "no
  // eligible members found".
  const [memberLoadError, setMemberLoadError]     = useState<string | null>(null);
  const [memberSearch, setMemberSearch]           = useState("");
  const [selectedMemberId, setSelectedMemberId]   = useState("");
  const [addMemberLoading, setAddMemberLoading]   = useState(false);
  const [addMemberError, setAddMemberError]       = useState<string | null>(null);

  // ── Fetch roster ───────────────────────────────────────────────────────────

  function loadRoster() {
    setLoading(true);
    setError(null);
    supabase
      .rpc("get_program_roster", { p_program_id: programId })
      .then(({ data, error: rpcError }) => {
        if (rpcError) {
          // eslint-disable-next-line no-console
          console.error("[ProgramRosterSheet] get_program_roster failed:", rpcError.message);
          setError("Unable to load roster. Please try again.");
        } else {
          const fetched = (data as ProgramRosterRow[]) ?? [];
          setRows(fetched);
          loadPaymentStates(fetched);
        }
        setLoading(false);
      });
  }

  useEffect(() => {
    loadRoster();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programId]);

  // ── Add Member ────────────────────────────────────────────────────────────

  async function openAddMember() {
    setAddMemberOpen(true);
    setAddMemberError(null);
    setMemberLoadError(null);
    setMemberSearch("");
    setMembersLoading(true);
    setMemberList([]);

    // Membership-native lookup — get_program_eligible_members (0093)
    // sources eligibility exclusively from club_memberships and already
    // excludes anyone with an enrolled/offered/waitlisted row for this
    // program server-side (a cancelled row or no row at all is a valid
    // re-add candidate, matching add_program_member's own "cancelled ->
    // fresh queue position" support), so no client-side re-filtering
    // against `rows` is needed for the account-holder half.
    //
    // Phase 33D2b: get_program_eligible_roster_members (0115) is the
    // Programs-scoped analog of EventRosterSheet's own get_roster_members()
    // call — deliberately a SEPARATE, narrowly-scoped RPC rather than a
    // broadened get_roster_members() (which is hard admin-only and would
    // exclude a pro managing their own program's roster). Same exclusion
    // rule (already-enrolled/offered/waitlisted for this program) applied
    // server-side, so no client-side re-filtering is needed here either.
    const [accountResult, rosterResult] = await Promise.all([
      supabase.rpc("get_program_eligible_members", { p_program_id: programId }),
      supabase.rpc("get_program_eligible_roster_members", { p_program_id: programId }),
    ]);

    if (accountResult.error || rosterResult.error) {
      setMemberLoadError("Unable to load eligible members. Please try again.");
      setMembersLoading(false);
      return;
    }

    const accountOptions: MemberOption[] = (
      (accountResult.data ?? []) as { profile_id: string; display_name: string }[]
    ).map(m => ({ id: m.profile_id, display_name: m.display_name, source: "profile" as const }));

    const rosterOptions: MemberOption[] = (
      (rosterResult.data ?? []) as { roster_member_id: string; display_name: string }[]
    ).map(m => ({ id: m.roster_member_id, display_name: `${m.display_name} (No account yet)`, source: "roster" as const }));

    const eligible = [...accountOptions, ...rosterOptions]
      .sort((a, b) => a.display_name.localeCompare(b.display_name));

    setMemberList(eligible);
    setSelectedMemberId(eligible[0]?.id ?? "");
    setMembersLoading(false);
  }

  // Filters the already-loaded candidate list client-side (no extra round
  // trip) and keeps the controlled <select>'s value in sync with whatever
  // is still visible after filtering.
  function handleMemberSearchChange(value: string) {
    setMemberSearch(value);
    const filtered = memberList.filter(m =>
      m.display_name.toLowerCase().includes(value.trim().toLowerCase())
    );
    if (!filtered.some(m => m.id === selectedMemberId)) {
      setSelectedMemberId(filtered[0]?.id ?? "");
    }
  }

  async function handleAddMember() {
    if (!selectedMemberId) return;
    setAddMemberLoading(true);
    setAddMemberError(null);

    const selected = memberList.find(m => m.id === selectedMemberId);
    const result = selected?.source === "roster"
      ? await addProgramRosterMember({
          p_program_id:       programId,
          p_roster_member_id: selectedMemberId,
          expectedClubId:     clubId,
        })
      : await addProgramMember({
          p_program_id:   programId,
          p_profile_id:   selectedMemberId,
          expectedClubId: clubId,
        });

    setAddMemberLoading(false);
    if (result.error) {
      setAddMemberError(mapProgramError(result.error.code, result.error.message));
      return;
    }
    setAddMemberOpen(false);
    setSelectedMemberId("");
    setMemberList([]);
    setMemberSearch("");
    loadRoster();
    router.refresh();
  }

  // ── Remove Member ─────────────────────────────────────────────────────────

  async function handleRemove(row: ProgramRosterRow) {
    const key = rowKey(row);
    setRowUpdating(prev => new Set(prev).add(key));
    setRowErrors(prev => { const next = new Map(prev); next.delete(key); return next; });

    const result = row.profile_id
      ? await removeProgramMember({
          p_program_id:   programId,
          p_profile_id:   row.profile_id,
          expectedClubId: clubId,
        })
      : await removeProgramRosterMember({
          p_program_id:       programId,
          p_roster_member_id: row.roster_member_id,
          expectedClubId:     clubId,
        });

    setRowUpdating(prev => { const next = new Set(prev); next.delete(key); return next; });
    setConfirmingRemoveId(null);

    if (result.error) {
      setRowErrors(prev => new Map(prev).set(key, mapProgramError(result.error!.code, result.error!.message)));
      return;
    }
    loadRoster();
    router.refresh();
  }

  // ── Force Confirm (waitlisted or offered -> enrolled) ─────────────────────
  // Phase 33D2b: closes the staff-managed lifecycle gap for a no-account
  // enrollee who has no session to call accept_program_waitlist_offer.
  // Keyed by roster_member_id, so it works for a claimed row too (there is
  // no prior profile-based force-confirm to preserve compatibility with —
  // this capability is new for every enrollee, not just no-account ones).

  async function handleForceConfirm(row: ProgramRosterRow) {
    const key = rowKey(row);
    setRowUpdating(prev => new Set(prev).add(key));
    setRowErrors(prev => { const next = new Map(prev); next.delete(key); return next; });

    const result = await forceConfirmProgramRosterMember({
      p_program_id:       programId,
      p_roster_member_id: row.roster_member_id,
      expectedClubId:     clubId,
    });

    setRowUpdating(prev => { const next = new Set(prev); next.delete(key); return next; });

    if (result.error) {
      setRowErrors(prev => new Map(prev).set(key, mapProgramError(result.error!.code, result.error!.message)));
      return;
    }
    loadRoster();
    router.refresh();
  }

  // ── Derived — already returned in the required section order by
  // get_program_roster (enrolled, offered, waitlisted by waitlisted_at
  // asc, cancelled), so filtering preserves that order within each group.
  const enrolled   = rows.filter(r => r.status === "enrolled");
  const offered    = rows.filter(r => r.status === "offered");
  const waitlisted = rows.filter(r => r.status === "waitlisted");
  const cancelled  = rows.filter(r => r.status === "cancelled");

  // Client-side search over the already-loaded candidate list — no extra
  // round trip per keystroke.
  const filteredMemberList = memberList.filter(m =>
    m.display_name.toLowerCase().includes(memberSearch.trim().toLowerCase())
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
    <ResponsiveSheet
      onClose={onClose}
      variant="panel"
      mobileInteraction="draggable"
      label="Program Roster"
      header={
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Program Roster</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{programTitle}</p>
          </div>
          <button onClick={onClose} className="text-sm text-gray-400 font-medium md:hidden shrink-0 ml-3">
            Close
          </button>
        </div>
      }
    >
        {loading && (
          <p className="text-sm text-gray-400 py-8 text-center">Loading roster…</p>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center gap-2 py-8">
            <p className="text-sm text-red-500 text-center">{error}</p>
            <button
              onClick={loadRoster}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline"
            >
              Try again
            </button>
          </div>
        )}

        {!loading && !error && (
          <>
            {/* ── Add Member ──────────────────────────────────────────── */}
            <div className="mb-5">
              {!addMemberOpen ? (
                <button onClick={openAddMember} className={ACTION_BUTTON_SECONDARY}>
                  + Add Member
                </button>
              ) : (
                <div className="bg-gray-50 dark:bg-gray-700/60 rounded-xl px-3 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-gray-600 dark:text-gray-300">
                      Add Member
                    </p>
                    <button
                      onClick={() => { setAddMemberOpen(false); setAddMemberError(null); }}
                      className="shrink-0 text-xs text-gray-400"
                    >
                      Cancel
                    </button>
                  </div>

                  {membersLoading ? (
                    <p className="text-xs text-gray-400">Loading members…</p>
                  ) : memberLoadError ? (
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-red-500">{memberLoadError}</p>
                      <button
                        onClick={openAddMember}
                        className="shrink-0 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline"
                      >
                        Try again
                      </button>
                    </div>
                  ) : memberList.length === 0 ? (
                    <p className="text-xs text-gray-400">No eligible members found.</p>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={memberSearch}
                        onChange={e => handleMemberSearchChange(e.target.value)}
                        placeholder="Search members…"
                        className="w-full mb-2 text-base md:text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 px-2 py-1.5"
                      />
                      {filteredMemberList.length === 0 ? (
                        <p className="text-xs text-gray-400">No members match your search.</p>
                      ) : (
                        <div className="flex gap-2 items-center flex-wrap">
                          <select
                            value={selectedMemberId}
                            onChange={e => setSelectedMemberId(e.target.value)}
                            className="flex-1 min-w-0 text-base md:text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1.5"
                          >
                            {filteredMemberList.map(m => (
                              <option key={m.id} value={m.id}>{m.display_name}</option>
                            ))}
                          </select>
                          <button
                            disabled={addMemberLoading || !selectedMemberId}
                            onClick={handleAddMember}
                            className={ACTION_BUTTON_PRIMARY}
                          >
                            {addMemberLoading ? "Adding…" : "Add"}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                  {addMemberError && (
                    <p className="text-xs text-red-500 mt-1.5">{addMemberError}</p>
                  )}
                </div>
              )}
            </div>

            {rows.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">No enrollments yet.</p>
            ) : (
              <>
                {/* ── Enrolled ────────────────────────────────────────── */}
                {enrolled.length > 0 && (
                  <div className="mb-5">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      Enrolled ({enrolled.length})
                    </p>
                    {enrolled.map(row => {
                      const key          = rowKey(row);
                      const isUpdating   = rowUpdating.has(key);
                      const rowError     = rowErrors.get(key);
                      const isConfirming = confirmingRemoveId === key;
                      // Phase 33D2b: a no-account enrollee added directly
                      // via add_program_roster_member — never a Guest.
                      const isNoAccount  = !row.profile_id;
                      return (
                        <div key={key} className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0">
                          <div className="flex items-center">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate flex items-center gap-1.5">
                                <span className="truncate">{displayName(row)}</span>
                                {isNoAccount && (
                                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                                    No account yet
                                  </span>
                                )}
                              </p>
                              {row.email && (
                                <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{row.email}</p>
                              )}
                            </div>
                            {!isConfirming && (
                              <button
                                disabled={isUpdating}
                                onClick={() => setConfirmingRemoveId(key)}
                                className={`ml-3 shrink-0 ${ACTION_BUTTON_DESTRUCTIVE_COMPACT}`}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                          {isConfirming && (
                            <div className="mt-2 flex items-center gap-2 flex-wrap bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/60 rounded-lg px-3 py-2">
                              <p className="text-xs text-red-700 dark:text-red-400 flex-1 min-w-0">
                                Remove {displayName(row)} from this program?
                              </p>
                              <button
                                disabled={isUpdating}
                                onClick={() => handleRemove(row)}
                                className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
                              >
                                {isUpdating ? "Removing…" : "Confirm Remove"}
                              </button>
                              <button
                                disabled={isUpdating}
                                onClick={() => setConfirmingRemoveId(null)}
                                className="text-xs text-gray-500 dark:text-gray-400"
                              >
                                Cancel
                              </button>
                            </div>
                          )}

                          {/* Payment state — Phase 34C. Whole Program
                              enrollment obligation only. Admin/Staff only
                              for Record Payment (never Pro). Renders
                              nothing when there is no payment row. */}
                          {paymentStateByRowKey.get(key) && (
                            <div className="mt-1.5 flex items-center gap-2">
                              <PaymentStateBadge state={paymentStateByRowKey.get(key)} />
                              {canRecordPayment && isPaymentOpenForRecording(paymentStateByRowKey.get(key)) && (
                                <button
                                  onClick={() => setRecordPaymentTarget({ rowKey: key, title: displayName(row) })}
                                  className="text-xs font-semibold text-accent hover:underline"
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

                {/* ── Spot Offered ────────────────────────────────────── */}
                {offered.length > 0 && (
                  <div className="mb-5">
                    <p className="text-xs font-semibold text-amber-600 dark:text-amber-500 uppercase tracking-wide mb-2">
                      Spot Offered ({offered.length})
                    </p>
                    {offered.map(row => {
                      const isExpired    = row.offer_expires_at ? new Date(row.offer_expires_at) <= new Date() : false;
                      const key          = rowKey(row);
                      const isUpdating   = rowUpdating.has(key);
                      const rowError     = rowErrors.get(key);
                      const isConfirming = confirmingRemoveId === key;
                      const isNoAccount  = !row.profile_id;
                      return (
                        <div key={key} className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0">
                          <div className="flex items-start">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate flex items-center gap-1.5">
                                <span className="truncate">{displayName(row)}</span>
                                {isNoAccount && (
                                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                                    No account yet
                                  </span>
                                )}
                              </p>
                              {row.email && (
                                <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{row.email}</p>
                              )}
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
                            {!isConfirming && (
                              <div className="ml-3 flex items-center gap-2 shrink-0">
                                {/* Phase 33D2b: staff-managed lifecycle for
                                    an enrollee (no-account or claimed) who
                                    cannot/has not self-accepted the offer. */}
                                <button
                                  disabled={isUpdating}
                                  onClick={() => handleForceConfirm(row)}
                                  className={ACTION_BUTTON_POSITIVE_COMPACT}
                                >
                                  {isUpdating ? "…" : "Force Confirm"}
                                </button>
                                <button
                                  disabled={isUpdating}
                                  onClick={() => setConfirmingRemoveId(key)}
                                  className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
                                >
                                  Remove
                                </button>
                              </div>
                            )}
                          </div>
                          {isConfirming && (
                            <div className="mt-2 flex items-center gap-2 flex-wrap bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/60 rounded-lg px-3 py-2">
                              <p className="text-xs text-red-700 dark:text-red-400 flex-1 min-w-0">
                                Remove {displayName(row)}&apos;s offer for this program?
                              </p>
                              <button
                                disabled={isUpdating}
                                onClick={() => handleRemove(row)}
                                className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
                              >
                                {isUpdating ? "Removing…" : "Confirm Remove"}
                              </button>
                              <button
                                disabled={isUpdating}
                                onClick={() => setConfirmingRemoveId(null)}
                                className="text-xs text-gray-500 dark:text-gray-400"
                              >
                                Cancel
                              </button>
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

                {/* ── Waitlisted ──────────────────────────────────────── */}
                {waitlisted.length > 0 && (
                  <div className="mb-5">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      Waitlisted ({waitlisted.length})
                    </p>
                    {waitlisted.map((row, index) => {
                      const key          = rowKey(row);
                      const isUpdating   = rowUpdating.has(key);
                      const rowError     = rowErrors.get(key);
                      const isConfirming = confirmingRemoveId === key;
                      const isNoAccount  = !row.profile_id;
                      return (
                        <div key={key} className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0">
                          <div className="flex items-center">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate flex items-center gap-1.5">
                                <span className="truncate">{displayName(row)}</span>
                                {isNoAccount && (
                                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                                    No account yet
                                  </span>
                                )}
                              </p>
                              {row.email && (
                                <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{row.email}</p>
                              )}
                            </div>
                            <span className="ml-3 shrink-0 text-xs font-semibold text-amber-600 dark:text-amber-400">
                              #{index + 1}
                            </span>
                            {!isConfirming && (
                              <div className="ml-2 flex items-center gap-2 shrink-0">
                                {/* Phase 33D2b: staff can seat a waitlisted
                                    enrollee directly, matching Force Confirm
                                    parity with the offered section above. */}
                                <button
                                  disabled={isUpdating}
                                  onClick={() => handleForceConfirm(row)}
                                  className={ACTION_BUTTON_POSITIVE_COMPACT}
                                >
                                  {isUpdating ? "…" : "Force Confirm"}
                                </button>
                                <button
                                  disabled={isUpdating}
                                  onClick={() => setConfirmingRemoveId(key)}
                                  className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
                                >
                                  Remove
                                </button>
                              </div>
                            )}
                          </div>
                          {isConfirming && (
                            <div className="mt-2 flex items-center gap-2 flex-wrap bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/60 rounded-lg px-3 py-2">
                              <p className="text-xs text-red-700 dark:text-red-400 flex-1 min-w-0">
                                Remove {displayName(row)} from the waitlist?
                              </p>
                              <button
                                disabled={isUpdating}
                                onClick={() => handleRemove(row)}
                                className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
                              >
                                {isUpdating ? "Removing…" : "Confirm Remove"}
                              </button>
                              <button
                                disabled={isUpdating}
                                onClick={() => setConfirmingRemoveId(null)}
                                className="text-xs text-gray-500 dark:text-gray-400"
                              >
                                Cancel
                              </button>
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

                {/* ── Cancelled — historical, no actions ────────────────── */}
                {cancelled.length > 0 && (
                  <div className="mb-5">
                    <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-2">
                      Cancelled ({cancelled.length})
                    </p>
                    {cancelled.map(row => (
                      <div key={rowKey(row)} className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0">
                        <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
                          {displayName(row)}
                        </p>
                        {row.email && (
                          <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{row.email}</p>
                        )}
                      </div>
                    ))}
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
