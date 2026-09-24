"use client";

import { useEffect, useState } from "react";
import {
  getReservationRoster,
  getReservationEligibleRosterMembers,
  getReservationGuestWaiverComplianceAction,
  addReservationParticipant,
  removeReservationParticipant,
  addReservationGuest,
  removeReservationGuest,
  mintReservationGuestWaiverInvitationAction,
  type ReservationRosterRow,
  type ReservationEligibleRosterMember,
  type GuestWaiverComplianceRow,
} from "./actions";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import {
  ACTION_BUTTON_SECONDARY_COMPACT,
  ACTION_BUTTON_DESTRUCTIVE_COMPACT,
  ACTION_BUTTON_PRIMARY_COMPACT,
} from "@/components/styles/actionButtonStyles";

// Phase 37D — Admin/Staff reservation participant/guest roster. Renders
// ONLY for reason='member_booking' reservations, gated entirely by the
// parent (ReservationDetailSheet) rendering this component only when
// canManageMemberReservation (isOperator: admin+staff) holds — Member/Pro
// own-reservation UX is explicitly out of scope here (Phase 37E). This is
// a presentation-only gate: every read and write below goes exclusively
// through the Phase 37C (0179) SECURITY DEFINER RPCs, which independently
// re-derive and enforce the real authorization server-side. This
// component never queries reservation_participants/reservation_guests
// directly — both tables have zero client-facing RLS policies and zero
// direct grants by design.

// ─── Types ───────────────────────────────────────────────────────────────

interface Props {
  reservationId: string;
  clubId:        string;
  // Authoritative read-only signal from the parent's own already-loaded
  // reservation row — never re-derived from a roster read, so an empty
  // roster never has to guess whether it's empty-because-cancelled or
  // empty-because-no-one-was-added-yet (Phase 37D locked requirement).
  isCancelled:   boolean;
  // Phase 39C-1 correction — optional, fired only after a roster mutation
  // that actually SUCCEEDED and can change occupied-seat count (add/remove
  // participant, add/remove guest). This is UI coordination only: the
  // parent (ReservationDetailSheet) uses it to bump a refresh revision so
  // the sibling ReservationPlayerSearchSection re-fetches its own
  // canonical get_reservation_player_search state — this component never
  // computes or shares occupancy data itself, and never calls this on a
  // failed mutation or on a read-only load.
  onRosterChanged?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function mapRosterError(code: string): string {
  if (code === STALE_CLUB_CONTEXT_ERROR) return STALE_CLUB_MESSAGE;
  switch (code) {
    case "reservation_not_found":
      return "This booking could not be found.";
    case "reservation_not_participant_eligible":
      return "This booking does not support a player roster.";
    case "reservation_roster_locked":
      return "This booking is cancelled — its roster is read-only.";
    case "roster_member_not_found":
      return "That club member could not be found.";
    case "roster_member_inactive":
      return "That club member is no longer active.";
    case "guest_display_name_required":
      return "Enter a guest name.";
    case "guest_display_name_too_long":
      return "Guest name is too long (max 100 characters).";
    // Phase 37E: this section is now reachable by a Member (previously
    // Admin/Staff only, who are never gated by member_self_service). The
    // presentation gate should already prevent a Staff-Managed Member from
    // ever reaching this UI at all (see ReservationDetailSheet's render
    // gate comment), but 0179's own capability_not_available remains the
    // authoritative backstop for a narrow stale-tab edge case (the club's
    // tier changes to Staff-Managed while this sheet is already open) —
    // never a raw database error reaching the user.
    case "capability_not_available":
      return "Self-service booking management is not available for this club.";
    // Phase 43B-4B — mint_reservation_guest_waiver_invitation's own two
    // fail-closed errors (0198): no current published Guest waiver, or
    // the club currently has Guest waiver Required turned off.
    case "no_current_guest_waiver":
      return "No Guest waiver is currently published for this club.";
    case "guest_waiver_not_required":
      return "A Guest waiver isn't currently required at this club.";
    case "reservation_guest_not_found":
      return "That guest could not be found.";
    default:
      return "Something went wrong. Please try again.";
  }
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

function eligibleOptionLabel(m: ReservationEligibleRosterMember): string {
  const roleSuffix   = m.role !== "member" ? ` (${capitalize(m.role)})` : "";
  const holderSuffix = m.is_reservation_holder ? " — Reservation holder" : "";
  return `${m.display_name}${roleSuffix}${holderSuffix}`;
}

// Phase 43B-5B — same three-state vocabulary/visual treatment established
// on /admin/members (43B-5A) for Member compliance: never_accepted and
// outdated share one "Needs acceptance" label; no red (informational, not
// an error/blocking condition); never exposes waiver_version_id/
// "Version N". Kept local to this file rather than importing from
// MembersClient.tsx — same small-duplication precedent this waiver UI
// already established (MemberWaiverSection/GuestWaiverSection).
const GUEST_WAIVER_STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  current: {
    label: "Accepted",
    className: "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400",
  },
  never_accepted: {
    label: "Needs acceptance",
    className: "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400",
  },
  outdated: {
    label: "Needs acceptance",
    className: "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400",
  },
  not_required: {
    label: "Not required",
    className: "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400",
  },
};

function GuestWaiverPill({ status }: { status: string }) {
  const config = GUEST_WAIVER_STATUS_CONFIG[status];
  if (!config) return null;
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${config.className}`}>
      {config.label}
    </span>
  );
}

// ─── Component ───────────────────────────────────────────────────────────

export default function ReservationRosterSection({ reservationId, clubId, isCancelled, onRosterChanged }: Props) {
  const [rows, setRows]       = useState<ReservationRosterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  // Phase 43B-5B — keyed by relationship_id (reservation_guests.id) only;
  // never merged onto participant rows.
  const [guestCompliance, setGuestCompliance] = useState<Map<string, GuestWaiverComplianceRow>>(new Map());

  const [rowUpdating, setRowUpdating] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors]     = useState<Map<string, string>>(new Map());
  const [copiedKey, setCopiedKey]     = useState<string | null>(null);

  // ── Add club member ──────────────────────────────────────────────────
  const [addMemberOpen, setAddMemberOpen]         = useState(false);
  const [memberList, setMemberList]               = useState<ReservationEligibleRosterMember[]>([]);
  const [membersLoading, setMembersLoading]       = useState(false);
  const [selectedMemberId, setSelectedMemberId]   = useState("");
  const [addMemberLoading, setAddMemberLoading]   = useState(false);
  const [addMemberError, setAddMemberError]       = useState<string | null>(null);

  // ── Add guest ─────────────────────────────────────────────────────────
  const [addGuestOpen, setAddGuestOpen]       = useState(false);
  const [guestName, setGuestName]             = useState("");
  const [addGuestLoading, setAddGuestLoading] = useState(false);
  const [addGuestError, setAddGuestError]     = useState<string | null>(null);

  function loadRoster() {
    setLoading(true);
    setError(null);
    getReservationRoster(reservationId, clubId).then(({ data, error: rpcError }) => {
      if (rpcError) {
        setError(mapRosterError(rpcError));
      } else {
        setRows(data ?? []);
      }
      setLoading(false);
    });
    // Phase 43B-5B — loaded alongside the roster, set-based (one call for
    // every Guest in this reservation, never per-Guest). Informational
    // only: a failure here silently leaves the Waiver indicator hidden
    // (compliance map stays empty) rather than surfacing a second error
    // banner over the roster itself, which is not blocked by this at all.
    getReservationGuestWaiverComplianceAction(reservationId, clubId).then(({ data }) => {
      setGuestCompliance(new Map((data ?? []).map((row) => [row.relationship_id, row])));
    });
  }

  useEffect(() => {
    loadRoster();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservationId]);

  // ── Remove ────────────────────────────────────────────────────────────

  // ── Add club member ──────────────────────────────────────────────────
  //
  // Extracted so it can be called both when the picker is first opened AND
  // as a background refresh after a participant removal — a removed
  // participant must become eligible again immediately, including while
  // the picker is already open (Phase 37D correction). Never queries
  // roster tables directly — get_reservation_eligible_roster_members
  // remains the sole source. Preserves the current selection when it is
  // still present in the refreshed list (e.g. an unrelated removal while
  // browsing the picker); falls back to the first option otherwise —
  // covers both the initial open (no prior selection) and a refresh that
  // drops the previously-selected candidate.

  async function loadEligibleMembers() {
    setMembersLoading(true);
    setAddMemberError(null);

    const { data, error: rpcError } = await getReservationEligibleRosterMembers(reservationId, clubId);
    setMembersLoading(false);

    if (rpcError) {
      setAddMemberError(mapRosterError(rpcError));
      setMemberList([]);
      return;
    }

    const eligible = [...(data ?? [])].sort((a, b) => a.display_name.localeCompare(b.display_name));
    setMemberList(eligible);
    setSelectedMemberId(prev =>
      eligible.some(m => m.roster_member_id === prev) ? prev : (eligible[0]?.roster_member_id ?? ""),
    );
  }

  async function openAddMember() {
    setAddMemberOpen(true);
    setSelectedMemberId("");
    await loadEligibleMembers();
  }

  async function handleAddMember() {
    if (!selectedMemberId || addMemberLoading) return;
    setAddMemberLoading(true);
    setAddMemberError(null);

    const result = await addReservationParticipant(reservationId, clubId, selectedMemberId);

    setAddMemberLoading(false);
    if (result.error) {
      setAddMemberError(mapRosterError(result.error));
      return;
    }
    setAddMemberOpen(false);
    setSelectedMemberId("");
    setMemberList([]);
    loadRoster();
    onRosterChanged?.();
  }

  async function handleRemoveParticipant(row: ReservationRosterRow) {
    const key = row.relationship_id;
    setRowUpdating(prev => new Set(prev).add(key));
    setRowErrors(prev => { const next = new Map(prev); next.delete(key); return next; });

    const result = await removeReservationParticipant(reservationId, clubId, row.relationship_id);

    setRowUpdating(prev => { const next = new Set(prev); next.delete(key); return next; });
    if (result.error) {
      setRowErrors(prev => new Map(prev).set(key, mapRosterError(result.error!)));
      return;
    }
    loadRoster();
    onRosterChanged?.();
    // The just-removed roster identity becomes eligible again — refresh
    // the picker if it's currently open so it reflects that immediately,
    // rather than showing a stale list until the sheet is reopened.
    if (addMemberOpen) {
      loadEligibleMembers();
    }
  }

  async function handleRemoveGuest(row: ReservationRosterRow) {
    const key = row.relationship_id;
    setRowUpdating(prev => new Set(prev).add(key));
    setRowErrors(prev => { const next = new Map(prev); next.delete(key); return next; });

    const result = await removeReservationGuest(reservationId, clubId, row.relationship_id);

    setRowUpdating(prev => { const next = new Set(prev); next.delete(key); return next; });
    if (result.error) {
      setRowErrors(prev => new Map(prev).set(key, mapRosterError(result.error!)));
      return;
    }
    // Guest removal has no effect on roster-member eligibility — no
    // picker refresh needed here.
    loadRoster();
    onRosterChanged?.();
  }

  // Phase 43B-4B — "Copy Waiver Link". Every successful call ROTATES the
  // Guest slot's prior active invitation (0198's own locked semantics) —
  // this is unconditional, not something this handler can opt out of.
  // The URL is shown exactly once (never re-fetchable, since only the
  // token's hash is stored) and is never logged.
  async function handleCopyWaiverLink(row: ReservationRosterRow) {
    const key = row.relationship_id;
    setRowUpdating(prev => new Set(prev).add(key));
    setRowErrors(prev => { const next = new Map(prev); next.delete(key); return next; });
    setCopiedKey(null);

    const result = await mintReservationGuestWaiverInvitationAction(reservationId, clubId, row.relationship_id);

    setRowUpdating(prev => { const next = new Set(prev); next.delete(key); return next; });
    if (result.error || !result.url) {
      setRowErrors(prev => new Map(prev).set(key, mapRosterError(result.error ?? "")));
      return;
    }

    try {
      await navigator.clipboard.writeText(result.url);
      setCopiedKey(key);
    } catch {
      setRowErrors(prev => new Map(prev).set(key, "Link created but couldn't copy automatically. Try again."));
    }
  }

  // ── Add guest ─────────────────────────────────────────────────────────

  async function handleAddGuest() {
    if (addGuestLoading) return;
    const name = guestName.trim();
    if (!name) {
      setAddGuestError("Enter a guest name.");
      return;
    }
    setAddGuestLoading(true);
    setAddGuestError(null);

    const result = await addReservationGuest(reservationId, clubId, name);

    setAddGuestLoading(false);
    if (result.error) {
      setAddGuestError(mapRosterError(result.error));
      return;
    }
    setAddGuestOpen(false);
    setGuestName("");
    loadRoster();
    onRosterChanged?.();
  }

  // ── Derived ───────────────────────────────────────────────────────────

  const participants = rows.filter(r => r.kind === "participant");
  const guests        = rows.filter(r => r.kind === "guest");
  const isEmpty        = !loading && !error && rows.length === 0;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="mt-3 rounded-xl border border-gray-200 dark:border-gray-600 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Players &amp; Guests
        </span>
        {isCancelled && (
          <span className="text-[11px] text-gray-400 dark:text-gray-500 italic">Read-only</span>
        )}
      </div>

      {loading && (
        <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">Loading players…</p>
      )}

      {!loading && error && (
        <p className="text-sm text-red-500 mt-2">{error}</p>
      )}

      {!loading && !error && (
        <div className="mt-2">
          {isEmpty && (
            <p className="text-sm text-gray-400 dark:text-gray-500">
              No players or guests have been added.
            </p>
          )}

          {participants.length > 0 && (
            <div className={guests.length > 0 ? "mb-3" : ""}>
              <p className="text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-1">
                Club members
              </p>
              {participants.map(row => {
                const isUpdating = rowUpdating.has(row.relationship_id);
                const rowError   = rowErrors.get(row.relationship_id);
                return (
                  <div key={row.relationship_id} className="py-1.5 flex items-center gap-2">
                    <span className="flex-1 min-w-0 text-sm text-gray-900 dark:text-gray-100 truncate flex items-center gap-1.5">
                      <span className="truncate">{row.display_name}</span>
                      {row.is_holder && (
                        <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                          Reservation holder
                        </span>
                      )}
                    </span>
                    {!isCancelled && (
                      <button
                        type="button"
                        aria-label={`Remove ${row.display_name} from players`}
                        disabled={isUpdating}
                        onClick={() => handleRemoveParticipant(row)}
                        className={`shrink-0 ${ACTION_BUTTON_DESTRUCTIVE_COMPACT}`}
                      >
                        {isUpdating ? "…" : "Remove"}
                      </button>
                    )}
                    {rowError && <p className="text-xs text-red-500 mt-1">{rowError}</p>}
                  </div>
                );
              })}
            </div>
          )}

          {guests.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-1">
                Guests
              </p>
              {guests.map(row => {
                const isUpdating = rowUpdating.has(row.relationship_id);
                const rowError   = rowErrors.get(row.relationship_id);
                const compliance = guestCompliance.get(row.relationship_id);
                return (
                  <div key={row.relationship_id} className="py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 min-w-0 text-sm text-gray-900 dark:text-gray-100 truncate">
                      {row.display_name}
                    </span>
                    {!isCancelled && (
                      <button
                        type="button"
                        aria-label={`Copy waiver link for guest ${row.display_name}`}
                        title="Creating a new link replaces the previous Guest waiver link."
                        disabled={isUpdating}
                        onClick={() => handleCopyWaiverLink(row)}
                        className={`shrink-0 ${ACTION_BUTTON_SECONDARY_COMPACT}`}
                      >
                        {isUpdating ? "…" : copiedKey === row.relationship_id ? "Copied!" : "Copy Waiver Link"}
                      </button>
                    )}
                    {!isCancelled && (
                      <button
                        type="button"
                        aria-label={`Remove guest ${row.display_name}`}
                        disabled={isUpdating}
                        onClick={() => handleRemoveGuest(row)}
                        className={`shrink-0 ${ACTION_BUTTON_DESTRUCTIVE_COMPACT}`}
                      >
                        {isUpdating ? "…" : "Remove"}
                      </button>
                    )}
                  </div>
                  {/* Phase 43B-5B — hidden entirely when the club has no
                      current Guest waiver (waiver_configured=false),
                      matching the 43B-5A Member-compliance pattern.
                      Shown for every other status, including
                      not_required. Informational only — no action, no
                      enforcement. */}
                  {compliance && compliance.waiver_configured && (
                    <div className="mt-0.5 flex items-center gap-1">
                      <span className="text-[10px] text-gray-400 dark:text-gray-500">Waiver</span>
                      <GuestWaiverPill status={compliance.status} />
                    </div>
                  )}
                  {rowError && <p className="text-xs text-red-500 mt-1">{rowError}</p>}
                  </div>
                );
              })}
            </div>
          )}

          {!isCancelled && (
            <div className="mt-3 space-y-2">
              {!addMemberOpen ? (
                <button
                  type="button"
                  onClick={openAddMember}
                  className={`block w-full ${ACTION_BUTTON_SECONDARY_COMPACT}`}
                >
                  + Add club member
                </button>
              ) : (
                <div className="bg-gray-50 dark:bg-gray-700/60 rounded-lg px-2.5 py-2.5">
                  {membersLoading ? (
                    <p className="text-xs text-gray-400">Loading eligible members…</p>
                  ) : memberList.length === 0 ? (
                    <p className="text-xs text-gray-400">No eligible members found.</p>
                  ) : (
                    <div className="flex gap-2 items-center flex-wrap">
                      <select
                        aria-label="Select a club member to add"
                        value={selectedMemberId}
                        onChange={e => setSelectedMemberId(e.target.value)}
                        className="flex-1 min-w-0 text-base md:text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1.5"
                      >
                        {memberList.map(m => (
                          <option key={m.roster_member_id} value={m.roster_member_id}>
                            {eligibleOptionLabel(m)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={addMemberLoading || !selectedMemberId}
                        onClick={handleAddMember}
                        className={`shrink-0 ${ACTION_BUTTON_PRIMARY_COMPACT}`}
                      >
                        {addMemberLoading ? "Adding…" : "Add"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setAddMemberOpen(false); setAddMemberError(null); }}
                        className="shrink-0 text-xs text-gray-400"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {addMemberError && <p className="text-xs text-red-500 mt-1.5">{addMemberError}</p>}
                </div>
              )}

              {!addGuestOpen ? (
                <button
                  type="button"
                  onClick={() => { setAddGuestOpen(true); setAddGuestError(null); }}
                  className={`block w-full ${ACTION_BUTTON_SECONDARY_COMPACT}`}
                >
                  + Add guest
                </button>
              ) : (
                <div className="bg-gray-50 dark:bg-gray-700/60 rounded-lg px-2.5 py-2.5">
                  <div className="flex gap-2 items-center flex-wrap">
                    <input
                      type="text"
                      aria-label="Guest name"
                      placeholder="Guest name"
                      value={guestName}
                      onChange={e => setGuestName(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") handleAddGuest(); }}
                      className="flex-1 min-w-0 text-base md:text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1.5 placeholder-gray-400 dark:placeholder-gray-500"
                    />
                    <button
                      type="button"
                      disabled={addGuestLoading}
                      onClick={handleAddGuest}
                      className={`shrink-0 ${ACTION_BUTTON_PRIMARY_COMPACT}`}
                    >
                      {addGuestLoading ? "Adding…" : "Add"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setAddGuestOpen(false); setGuestName(""); setAddGuestError(null); }}
                      className="shrink-0 text-xs text-gray-400"
                    >
                      Cancel
                    </button>
                  </div>
                  {addGuestError && <p className="text-xs text-red-500 mt-1.5">{addGuestError}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
