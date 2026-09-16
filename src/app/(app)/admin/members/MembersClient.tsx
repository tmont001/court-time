"use client";

import { useState, useTransition, useMemo, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import Link from "next/link";
import InviteSheet from "./InviteSheet";
import type { InviteRosterMember } from "./InviteSheet";
import AddMemberSheet from "./AddMemberSheet";
import ImportMembersSheet from "./ImportMembersSheet";
import type { EditRosterMember } from "./AddMemberSheet";
import {
  revokeInviteAction,
  resendInviteAction,
  setMemberRoleAction,
  setMemberStatusAction,
  removeMemberAction,
  restoreMemberAction,
  removeRosterMemberAction,
  restoreRosterMemberAction,
  setRosterMemberMembershipStatusAction,
  setRosterMemberMembershipTypeAction,
} from "./actions";

// Phase 42C-3B — explicit wording so this can never be confused with the
// existing lifecycle Active/Suspended/Inactive pill (club_memberships/
// roster_members.status). "Membership: " is always prefixed; the type
// name (if any) follows a middle dot, matching the locked product copy
// exactly: "Membership: Active", "Membership: Active · Adult",
// "Membership: Non-Member", "Membership: Suspended", "Membership: Inactive".
const MEMBERSHIP_STATUS_LABELS: Record<string, string> = {
  active:      "Active",
  inactive:    "Inactive",
  suspended:   "Suspended",
  non_member:  "Non-Member",
};

function membershipLine(
  membershipStatus: string | null,
  membershipTypeName: string | null,
): string | null {
  if (!membershipStatus) return null;
  const statusLabel = MEMBERSHIP_STATUS_LABELS[membershipStatus] ?? membershipStatus;
  return `Membership: ${statusLabel}${membershipTypeName ? ` · ${membershipTypeName}` : ""}`;
}

export type MembershipTypeOption = { id: string; name: string };

const ROLE_LABELS: Record<string, string> = {
  member: "Member",
  pro:    "Pro",
  staff:  "Staff",
  admin:  "Admin",
};

const ROLE_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "pro",    label: "Pro"    },
  { value: "staff",  label: "Staff"  },
  { value: "admin",  label: "Admin"  },
];

// ── Sort ─────────────────────────────────────────────────────────────────────

type SortField = "first_name" | "last_name" | "role" | "status";
type SortDir   = "asc" | "desc";

const SORT_OPTIONS: { field: SortField; label: string }[] = [
  { field: "first_name", label: "First Name" },
  { field: "last_name",  label: "Last Name"  },
  { field: "role",       label: "Role"       },
  { field: "status",     label: "Status"     },
];

const ROLE_ORDER:   Record<string, number> = { admin: 0, staff: 1, pro: 2, member: 3 };
const STATUS_ORDER: Record<string, number> = { active: 0, suspended: 1, inactive: 2, no_account: 3 };

function cmp(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

function formatJoinDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    year:  "numeric",
  });
}

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day:   "numeric",
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

type Member = {
  id:                 string;
  first_name:         string | null;
  last_name:          string | null;
  phone:              string | null;
  role:               string;
  status:             string;
  created_at:         string;
  email:              string | null;
  is_lesson_provider: boolean;
  removed_at:         string | null;
  // Phase 42C-3B — 0190's get_members() has always returned these; the
  // frontend type is only now widened to consume them. Nullable: a
  // legacy/edge-case claimed profile with no matching roster_members row
  // (get_members' own LEFT JOIN) reports null, not a fabricated default.
  membership_status:    "active" | "inactive" | "suspended" | "non_member" | null;
  membership_type_id:   string | null;
  membership_type_name: string | null;
};

// Phase 26D2: the four member-membership actions this club's Admin can take
// on a target's membership in this club specifically. "remove" is
// destructive (confirmed here); "restore" (a removed membership only) is
// handled separately, without a confirmation step — it is not destructive.
type MemberAction = "deactivate" | "reactivate" | "suspend" | "remove";

const CONFIRM_COPY: Record<
  MemberAction,
  { verb: string; verbing: string; body: string; danger: boolean }
> = {
  deactivate: {
    verb: "Deactivate",
    verbing: "Deactivating",
    body: "This member will lose access to booking courts and joining events in this club. Their existing reservations and history will remain intact. This does not affect any other club they belong to.",
    danger: true,
  },
  reactivate: {
    verb: "Reactivate",
    verbing: "Reactivating",
    body: "This member will regain full access to booking courts and joining events in this club. This does not affect any other club they belong to.",
    danger: false,
  },
  suspend: {
    verb: "Suspend",
    verbing: "Suspending",
    body: "This member will immediately lose access to this club until reactivated. Their existing reservations and history will remain intact. This does not affect any other club they belong to.",
    danger: true,
  },
  remove: {
    verb: "Remove",
    verbing: "Removing",
    body: "This removes their membership in this club only. Their account and any other club memberships are not affected, and an admin can restore this membership later.",
    danger: true,
  },
};

export type RosterMember = {
  id:         string;
  first_name: string;
  last_name:  string;
  email:      string | null;
  phone:      string | null;
  role:       string;
  notes:      string | null;
  created_by: string;
  created_at: string;
  // Phase 33E2-correction: durable no-account Member lifecycle.
  status:     string;
  removed_at: string | null;
  // Phase 42C-3B — 0190's get_roster_members() has always returned these;
  // the frontend type is only now widened to consume them. Unlike Member
  // above, membership_status is non-null here: get_roster_members' LEFT
  // JOIN target IS roster_members itself, so the base row always exists
  // for a roster row (membership_status is NOT NULL on the table).
  membership_status:    "active" | "inactive" | "suspended" | "non_member";
  membership_type_id:   string | null;
  membership_type_name: string | null;
};

type PendingInvite = {
  id:          string;
  code:        string;
  role:        string;
  email:       string | null;
  expires_at:  string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at:  string | null;
  created_at:  string;
};

type ListItem =
  | { kind: "profile"; data: Member }
  | { kind: "roster";  data: RosterMember };

type ConfirmDialog = {
  memberId:   string;
  memberName: string;
  action:     MemberAction;
  error?:     string;
};

type DeleteDialog = {
  id:   string;
  name: string;
  error?: string;
};

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  members:        Member[];
  rosterMembers:  RosterMember[];
  pendingInvites: PendingInvite[];
  currentUserId:  string;
  membersError?:  string | null;
  invitesError?:  string | null;
  // Phase 34A4A: the caller's real role — threaded down to AddMemberSheet
  // so it can hide Pro/Admin/invite choices for a Staff caller rather than
  // letting them pick an elevated role and then fail server-side.
  userRole:       string;
  // Phase 42C-3B
  membershipsEnabled: boolean;
  // Active Membership Types only — the newly-assignable pool for the
  // unclaimed-roster editor. Empty for a Staff caller (page.tsx never
  // queries membership_types for Staff — admin-only RLS, never broadened
  // here); RosterCard's editor is itself gated to userRole === "admin",
  // so an empty list is never actually rendered for Staff.
  membershipTypes:    MembershipTypeOption[];
}

export default function MembersClient({
  members,
  rosterMembers,
  pendingInvites,
  currentUserId,
  membersError,
  invitesError,
  userRole,
  membershipsEnabled,
  membershipTypes,
}: Props) {
  const router = useRouter();
  const [inviteSheetOpen, setInviteSheetOpen]   = useState(false);
  const [inviteRosterMember, setInviteRosterMember] = useState<InviteRosterMember | undefined>();
  const [addSheetOpen, setAddSheetOpen]         = useState(false);
  const [importSheetOpen, setImportSheetOpen]   = useState(false);
  const [editMember, setEditMember]             = useState<EditRosterMember | undefined>();
  const [revokeError, setRevokeError]         = useState<string | null>(null);
  const [revokingCode, setRevokingCode]       = useState<string | null>(null);
  const [revokeConfirmCode, setRevokeConfirmCode] = useState<string | null>(null);
  const [resendingCode, setResendingCode]       = useState<string | null>(null);
  const [resendError, setResendError]           = useState<string | null>(null);
  const [generateNewLinkCode, setGenerateNewLinkCode] = useState<string | null>(null);
  const [copiedCode, setCopiedCode]           = useState<string | null>(null);
  const [copyError,  setCopyError]            = useState<string | null>(null);
  const [, startTransition]                   = useTransition();

  // Sort
  const [sortField, setSortField] = useState<SortField>("first_name");
  const [sortDir,   setSortDir]   = useState<SortDir>("asc");

  // Search and filters
  const [search,       setSearch]       = useState("");
  const [roleFilter,   setRoleFilter]   = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // Role change
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);
  const [roleErrors, setRoleErrors]         = useState<Record<string, string>>({});

  // Status change (deactivate/reactivate/suspend/remove — all via the same
  // confirmation dialog, distinguished by ConfirmDialog.action)
  const [confirmDialog, setConfirmDialog]       = useState<ConfirmDialog | null>(null);
  const [statusChangingId, setStatusChangingId] = useState<string | null>(null);

  // UX polish pass (round 2) — claimed-card "Actions ▾" menu. Lifted to
  // this parent so only one card's menu is open at a time across the
  // whole list, matching the established renamingId/editingRateId/
  // confirmDialog single-open-item convention already used throughout
  // this file — the same shape as the unclaimed-roster Membership
  // editor's own editorOpen/onToggleEditor pair below. Selecting an item
  // still calls the SAME onStatusAction handler the buttons always
  // called — this is a pure presentation change, no mutation behavior
  // difference.
  const [actionsMenuOpenId, setActionsMenuOpenId] = useState<string | null>(null);

  // Restore (removed members only) — not destructive, no confirmation dialog
  const [restoringId, setRestoringId]           = useState<string | null>(null);
  const [restoreErrors, setRestoreErrors]       = useState<Record<string, string>>({});

  // Delete roster member
  const [deleteDialog, setDeleteDialog]     = useState<DeleteDialog | null>(null);
  const [deletingId, setDeletingId]         = useState<string | null>(null);

  // Phase 42C-3B — unclaimed-roster Membership editor (Admin only). One
  // roster card's editor open at a time; a single pending/error pair
  // covers both the Status and Type selects for that row, matching
  // ProfileCard's own role-select pending/error shape (roleErrors keyed
  // by member id) rather than inventing a finer-grained per-field state.
  const [membershipEditorOpenId, setMembershipEditorOpenId] = useState<string | null>(null);
  const [membershipPendingId, setMembershipPendingId]       = useState<string | null>(null);
  const [membershipErrors, setMembershipErrors]             = useState<Record<string, string>>({});

  // Phase 26D2: removed memberships are shown in their own section, never
  // mixed into the main roster list/search/sort/filters below.
  const visibleMembers = useMemo(() => members.filter((m) => !m.removed_at), [members]);
  const removedMembers = useMemo(() => members.filter((m) => !!m.removed_at), [members]);

  // Phase 33E2-correction: same split for no-account roster Members — an
  // inactive (removed) one is excluded from the main list/search/sort and
  // shown in the Removed section instead, mirroring visibleMembers/
  // removedMembers above.
  const visibleRosterMembers = useMemo(
    () => rosterMembers.filter((r) => r.status !== "inactive"),
    [rosterMembers],
  );
  const removedRosterMembers = useMemo(
    () => rosterMembers.filter((r) => r.status === "inactive"),
    [rosterMembers],
  );

  // Excludes removed rows explicitly — a removed membership never counts
  // toward "how many active admins does this club have", even if its role/
  // status happen to still read admin/active from before it was removed.
  const activeAdminCount = members.filter(
    (m) => m.role === "admin" && m.status === "active" && !m.removed_at
  ).length;

  const totalCount = visibleMembers.length + visibleRosterMembers.length;

  const hasFilters = search.trim() !== "" || roleFilter !== "" || statusFilter !== "";

  function clearFilters() {
    setSearch("");
    setRoleFilter("");
    setStatusFilter("");
  }

  // Unified list: filter then sort. Removed memberships never enter this
  // list (visibleMembers already excludes them) — they have their own
  // section below, outside the search/filter/sort system entirely.
  const filteredSortedItems = useMemo(() => {
    // 1. Build unified list
    let items: ListItem[] = [
      ...visibleMembers.map((m): ListItem => ({ kind: "profile", data: m })),
      ...visibleRosterMembers.map((r): ListItem => ({ kind: "roster", data: r })),
    ];

    // 2. Apply search
    const q = search.trim().toLowerCase();
    if (q) {
      items = items.filter(item => {
        const first = (item.data.first_name ?? "").toLowerCase();
        const last  = (item.data.last_name  ?? "").toLowerCase();
        const full  = `${first} ${last}`.trim();
        const email = (item.data.email ?? "").toLowerCase();
        const phone = (item.data.phone ?? "").toLowerCase();
        return (
          first.includes(q) || last.includes(q) || full.includes(q) ||
          email.includes(q) || phone.includes(q)
        );
      });
    }

    // 3. Apply role filter
    if (roleFilter) {
      items = items.filter(item => item.data.role === roleFilter);
    }

    // 4. Apply status filter
    if (statusFilter) {
      items = items.filter(item => {
        if (statusFilter === "no_account") return item.kind === "roster";
        if (item.kind === "roster")        return false;
        if (statusFilter === "active")     return item.data.status === "active";
        if (statusFilter === "suspended")  return item.data.status === "suspended";
        if (statusFilter === "inactive")   return item.data.status === "inactive";
        return true;
      });
    }

    // 5. Sort
    items.sort((a, b) => {
      let result = 0;
      const aFirst  = a.data.first_name;
      const bFirst  = b.data.first_name;
      const aLast   = a.data.last_name;
      const bLast   = b.data.last_name;
      const aRole   = a.data.role;
      const bRole   = b.data.role;
      const aStatus = a.kind === "profile" ? a.data.status : "no_account";
      const bStatus = b.kind === "profile" ? b.data.status : "no_account";

      switch (sortField) {
        case "first_name": result = cmp(aFirst, bFirst); break;
        case "last_name":  result = cmp(aLast,  bLast);  break;
        case "role":       result = (ROLE_ORDER[aRole]     ?? 99) - (ROLE_ORDER[bRole]     ?? 99); break;
        case "status":     result = (STATUS_ORDER[aStatus] ?? 99) - (STATUS_ORDER[bStatus] ?? 99); break;
      }
      return sortDir === "asc" ? result : -result;
    });

    return items;
  }, [visibleMembers, visibleRosterMembers, search, roleFilter, statusFilter, sortField, sortDir]);

  function handleSortChip(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  async function handleCopy(code: string) {
    const url = `${window.location.origin}/join/${code}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopyError(null);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode((prev) => (prev === code ? null : prev)), 2000);
    } catch {
      setCopyError(code);
      setTimeout(() => setCopyError((prev) => (prev === code ? null : prev)), 3000);
    }
  }

  function handleRevoke(code: string) {
    setRevokeError(null);
    setRevokingCode(code);
    startTransition(async () => {
      const result = await revokeInviteAction(code);
      setRevokingCode(null);
      setRevokeConfirmCode(null);
      if (result.error) {
        setRevokeError(result.error);
      } else {
        router.refresh();
      }
    });
  }

  function handleResend(inv: PendingInvite) {
    setResendError(null);
    setGenerateNewLinkCode(null);
    setResendingCode(inv.code);
    startTransition(async () => {
      // Phase 33B1: resend_club_invite resolves the roster identity to
      // resend for server-side (reusing the old invite's own
      // roster_member_id, or healing a legacy email-only invite by exact
      // match) — role/email are no longer passed from the client.
      const result = await resendInviteAction(inv.code);
      setResendingCode(null);
      if (result.error) {
        setResendError(result.error);
      } else {
        router.refresh();
      }
    });
  }

  function handleRoleChange(memberId: string, newRole: string) {
    setRoleErrors((prev) => { const next = { ...prev }; delete next[memberId]; return next; });
    setChangingRoleId(memberId);
    startTransition(async () => {
      const result = await setMemberRoleAction(memberId, newRole);
      setChangingRoleId(null);
      if (result.error) {
        setRoleErrors((prev) => ({ ...prev, [memberId]: result.error! }));
      } else {
        router.refresh();
      }
    });
  }

  function openConfirmDialog(member: Member, action: MemberAction) {
    const memberName =
      [member.first_name, member.last_name].filter(Boolean).join(" ") || "this member";
    setConfirmDialog({ memberId: member.id, memberName, action });
  }

  function toggleActionsMenu(memberId: string) {
    setActionsMenuOpenId((prev) => (prev === memberId ? null : memberId));
  }

  function handleConfirmStatus() {
    if (!confirmDialog) return;
    setStatusChangingId(confirmDialog.memberId);
    startTransition(async () => {
      // "remove" is a distinct RPC (removed_at/removed_by); the other three
      // are all set_member_status transitions.
      const result =
        confirmDialog.action === "remove"
          ? await removeMemberAction(confirmDialog.memberId)
          : await setMemberStatusAction(
              confirmDialog.memberId,
              confirmDialog.action === "deactivate"
                ? "inactive"
                : confirmDialog.action === "suspend"
                  ? "suspended"
                  : "active" // reactivate
            );
      setStatusChangingId(null);
      if (result.error) {
        setConfirmDialog((prev) => (prev ? { ...prev, error: result.error } : null));
      } else {
        setConfirmDialog(null);
        router.refresh();
      }
    });
  }

  // Restore (removed members only) — non-destructive, no confirmation.
  function handleRestore(member: Member) {
    if (restoringId) return;
    setRestoreErrors((prev) => {
      const next = { ...prev };
      delete next[member.id];
      return next;
    });
    setRestoringId(member.id);
    startTransition(async () => {
      const result = await restoreMemberAction(member.id);
      setRestoringId(null);
      if (result.error) {
        setRestoreErrors((prev) => ({ ...prev, [member.id]: result.error! }));
      } else {
        router.refresh();
      }
    });
  }

  function openDeleteDialog(rm: RosterMember) {
    const name = [rm.first_name, rm.last_name].filter(Boolean).join(" ");
    setDeleteDialog({ id: rm.id, name });
  }

  // Phase 33E2-correction: this is now a soft removal (remove_roster_member)
  // — the roster identity and its full history are preserved, only marked
  // inactive. No longer calls delete_roster_member.
  function handleConfirmDelete() {
    if (!deleteDialog) return;
    setDeletingId(deleteDialog.id);
    startTransition(async () => {
      const result = await removeRosterMemberAction(deleteDialog.id);
      setDeletingId(null);
      if (result.error) {
        setDeleteDialog((prev) => (prev ? { ...prev, error: result.error } : null));
      } else {
        setDeleteDialog(null);
        router.refresh();
      }
    });
  }

  // Restore (removed no-account roster Members only) — not destructive, no
  // confirmation dialog, mirrors handleRestore for club-membership members.
  // Reuses the same restoringId/restoreErrors state — roster ids and
  // profile ids are both uuids from disjoint tables, so no collision risk.
  function handleRestoreRoster(rm: RosterMember) {
    if (restoringId) return;
    setRestoreErrors((prev) => {
      const next = { ...prev };
      delete next[rm.id];
      return next;
    });
    setRestoringId(rm.id);
    startTransition(async () => {
      const result = await restoreRosterMemberAction(rm.id);
      setRestoringId(null);
      if (result.error) {
        setRestoreErrors((prev) => ({ ...prev, [rm.id]: result.error! }));
      } else {
        router.refresh();
      }
    });
  }

  // Phase 42C-3B — unclaimed-roster Membership editor. Admin only (the
  // button that opens this is itself gated to userRole === "admin" in
  // RosterCard below); Status and Type are independent mutations against
  // the two separate 0188 RPCs, matching the shared Server Actions'
  // own separation.

  function toggleMembershipEditor(rm: RosterMember) {
    setMembershipEditorOpenId((prev) => (prev === rm.id ? null : rm.id));
    setMembershipErrors((prev) => {
      const next = { ...prev };
      delete next[rm.id];
      return next;
    });
  }

  function handleMembershipStatusChange(
    rm: RosterMember,
    status: "active" | "inactive" | "suspended" | "non_member",
  ) {
    setMembershipErrors((prev) => { const next = { ...prev }; delete next[rm.id]; return next; });
    setMembershipPendingId(rm.id);
    startTransition(async () => {
      const result = await setRosterMemberMembershipStatusAction(rm.id, status);
      setMembershipPendingId(null);
      if (result.error) {
        setMembershipErrors((prev) => ({ ...prev, [rm.id]: result.error! }));
      } else {
        router.refresh();
      }
    });
  }

  function handleMembershipTypeChange(rm: RosterMember, membershipTypeId: string) {
    setMembershipErrors((prev) => { const next = { ...prev }; delete next[rm.id]; return next; });
    setMembershipPendingId(rm.id);
    startTransition(async () => {
      const result = await setRosterMemberMembershipTypeAction(rm.id, membershipTypeId || null);
      setMembershipPendingId(null);
      if (result.error) {
        setMembershipErrors((prev) => ({ ...prev, [rm.id]: result.error! }));
      } else {
        router.refresh();
      }
    });
  }

  function openEditSheet(rm: RosterMember) {
    setEditMember({
      id:         rm.id,
      first_name: rm.first_name,
      last_name:  rm.last_name,
      email:      rm.email,
      phone:      rm.phone,
      role:       rm.role,
      notes:      rm.notes,
    });
  }

  function openInviteForRoster(rm: RosterMember) {
    // Send Invite only ever renders for a roster row with a non-null email
    // (RosterCard, below) — email is guaranteed here, matching create_club_
    // invite's roster-first requirement.
    setInviteRosterMember({
      id:        rm.id,
      firstName: rm.first_name,
      lastName:  rm.last_name,
      email:     rm.email!,
      role:      rm.role,
    });
    setInviteSheetOpen(true);
  }

  function closeInviteSheet() {
    setInviteSheetOpen(false);
    setInviteRosterMember(undefined);
  }

  function closeEditSheet() {
    setEditMember(undefined);
  }

  return (
    <>
      {/* Action row */}
      <div className="mx-4 pt-4 pb-2">

        {/* Title + desktop buttons (side by side on md+) */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Members
              {totalCount > 0 && (
                <span className="ml-1.5 text-gray-400 dark:text-gray-500 font-normal">
                  ({totalCount})
                </span>
              )}
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 leading-relaxed">
              Add someone to the roster, even if they do not have an email address yet.
            </p>
          </div>
          {/* Desktop buttons — stacked compact on right, hidden on mobile */}
          <div className="hidden md:flex flex-col items-end gap-1.5 shrink-0">
            <button
              onClick={() => setAddSheetOpen(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
            >
              + Add Member
            </button>
            <button
              onClick={() => setImportSheetOpen(true)}
              className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-500 bg-white dark:bg-gray-800 text-xs font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent hover:bg-gray-50 dark:hover:bg-gray-700/40 motion-safe:transition-all motion-safe:duration-150"
            >
              Import Spreadsheet
            </button>
          </div>
        </div>

        {/* Mobile buttons — full-width stacked, hidden on desktop */}
        <div className="flex flex-col gap-2 mt-3 md:hidden">
          <button
            onClick={() => setAddSheetOpen(true)}
            className="w-full py-2.5 rounded-lg text-sm font-semibold bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
          >
            + Add Member
          </button>
          <button
            onClick={() => setImportSheetOpen(true)}
            className="w-full py-2.5 rounded-lg border border-gray-300 dark:border-gray-500 bg-white dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Import Spreadsheet
          </button>
        </div>

      </div>

      {/* Search + filter controls */}
      {!membersError && totalCount > 0 && (
        <div className="mx-4 mb-3 space-y-2">
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search members by name, email, or phone"
              aria-label="Search members"
              className="ct-input w-full pr-8 text-base md:text-sm"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-0 top-1/2 -translate-y-1/2 p-2.5 flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xs leading-none"
              >
                ✕
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <select
              value={roleFilter}
              onChange={e => setRoleFilter(e.target.value)}
              aria-label="Filter by role"
              className="ct-input text-base md:text-sm flex-1 min-w-0"
            >
              <option value="">All roles</option>
              <option value="member">Member</option>
              <option value="pro">Pro</option>
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              aria-label="Filter by status"
              className="ct-input text-base md:text-sm flex-1 min-w-0"
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="inactive">Inactive</option>
              <option value="no_account">No account</option>
            </select>
          </div>
        </div>
      )}

      {/* Sort controls */}
      {!membersError && totalCount > 1 && (
        <div className="mx-4 mb-2 flex gap-1.5 overflow-x-auto hide-scrollbar">
          {SORT_OPTIONS.map(({ field, label }) => {
            const isActive = sortField === field;
            const arrow = isActive ? (sortDir === "asc" ? " ↑" : " ↓") : "";
            return (
              <button
                key={field}
                onClick={() => handleSortChip(field)}
                className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-accent text-white dark:text-gray-900"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                {label}{arrow}
              </button>
            );
          })}
        </div>
      )}

      {/* Match count + clear */}
      {!membersError && hasFilters && totalCount > 0 && (
        <div className="mx-4 mb-3 flex items-center justify-between">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {filteredSortedItems.length} of {totalCount} member{totalCount !== 1 ? "s" : ""}
          </p>
          <button
            onClick={clearFilters}
            className="text-xs font-medium text-accent hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Member list */}
      {membersError ? (
        <div className="mx-4 mt-2 px-4 py-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-700">
          <p className="text-sm font-semibold text-red-700 dark:text-red-400">Failed to load members</p>
          <p className="text-xs text-red-500 dark:text-red-400 mt-1 break-all">{membersError}</p>
        </div>
      ) : totalCount === 0 ? (
        <div className="flex flex-col items-center justify-center h-32 gap-1">
          <p className="text-gray-400 dark:text-gray-500 text-sm">No members yet.</p>
          <p className="text-gray-400 dark:text-gray-500 text-xs">
            Tap <strong>Add Member</strong> to add someone to the roster.
          </p>
        </div>
      ) : filteredSortedItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-32 gap-2 mx-4">
          <p className="text-gray-400 dark:text-gray-500 text-sm text-center">
            No members match your search or filters.
          </p>
          <button
            onClick={clearFilters}
            className="text-xs font-medium text-accent hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="pb-2">
          {filteredSortedItems.map((item) =>
            item.kind === "profile" ? (
              <ProfileCard
                key={`p-${item.data.id}`}
                member={item.data}
                currentUserId={currentUserId}
                activeAdminCount={activeAdminCount}
                changingRoleId={changingRoleId}
                roleErrors={roleErrors}
                onRoleChange={handleRoleChange}
                onStatusAction={openConfirmDialog}
                membershipsEnabled={membershipsEnabled}
                menuOpen={actionsMenuOpenId === item.data.id}
                onToggleMenu={() => toggleActionsMenu(item.data.id)}
                onCloseMenu={() => setActionsMenuOpenId(null)}
              />
            ) : (
              <RosterCard
                key={`r-${item.data.id}`}
                roster={item.data}
                onEdit={openEditSheet}
                onDelete={openDeleteDialog}
                onInvite={openInviteForRoster}
                membershipsEnabled={membershipsEnabled}
                userRole={userRole}
                membershipTypes={membershipTypes}
                editorOpen={membershipEditorOpenId === item.data.id}
                onToggleEditor={toggleMembershipEditor}
                onStatusChange={handleMembershipStatusChange}
                onTypeChange={handleMembershipTypeChange}
                pending={membershipPendingId === item.data.id}
                error={membershipErrors[item.data.id]}
              />
            )
          )}
        </div>
      )}

      {/* Removed Members section — Phase 26D2, extended Phase 33E2-
          correction to also list removed no-account roster Members. Kept
          entirely separate from the main roster: not searchable/sortable/
          filterable, not counted in totalCount. Club-membership rows only
          ever show removal from THIS club; restoring never touches any
          other club the person belongs to. Roster rows are this club's own
          durable identity — there is no other club to consider. */}
      {(removedMembers.length > 0 || removedRosterMembers.length > 0) && (
        <div className="mx-4 mt-4 mb-6">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Removed from this club
          </p>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
            {removedMembers.map((m) => {
              const fullName =
                [m.first_name, m.last_name].filter(Boolean).join(" ") || "Unnamed member";
              const isRestoring = restoringId === m.id;
              const restoreError = restoreErrors[m.id];
              return (
                <div key={m.id} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
                      {fullName}
                    </p>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                      Removed {m.removed_at ? formatJoinDate(m.removed_at) : ""}
                    </p>
                    {restoreError && (
                      <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">
                        {restoreError}
                      </p>
                    )}
                  </div>
                  <button
                    disabled={isRestoring}
                    onClick={() => handleRestore(m)}
                    className="shrink-0 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-600 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150 disabled:opacity-50"
                  >
                    {isRestoring ? "Restoring…" : "Restore"}
                  </button>
                </div>
              );
            })}
            {removedRosterMembers.map((rm) => {
              const fullName =
                [rm.first_name, rm.last_name].filter(Boolean).join(" ") || "Unnamed member";
              const isRestoring = restoringId === rm.id;
              const restoreError = restoreErrors[rm.id];
              return (
                <div key={rm.id} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate flex items-center gap-1.5">
                      <span className="truncate">{fullName}</span>
                      <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                        No account
                      </span>
                    </p>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                      Removed {rm.removed_at ? formatJoinDate(rm.removed_at) : ""}
                    </p>
                    {restoreError && (
                      <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">
                        {restoreError}
                      </p>
                    )}
                  </div>
                  <button
                    disabled={isRestoring}
                    onClick={() => handleRestoreRoster(rm)}
                    className="shrink-0 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-600 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150 disabled:opacity-50"
                  >
                    {isRestoring ? "Restoring…" : "Restore"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Pending Invites section */}
      <div className="mx-4 mt-4 mb-6">
        <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
          Pending Invites
        </p>

        {invitesError && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700">
            <p className="text-xs font-semibold text-red-700 dark:text-red-400">
              Failed to load invites
            </p>
            <p className="text-xs text-red-600 dark:text-red-400 mt-0.5 break-all">
              {invitesError}
            </p>
          </div>
        )}

        {(revokeError || resendError) && (
          <div className="mb-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700">
            <p className="text-xs text-red-700 dark:text-red-400">{revokeError || resendError}</p>
          </div>
        )}

        {pendingInvites.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-500 py-3">
            No pending invites.
          </p>
        ) : (
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
            {pendingInvites.map((inv) => {
              const isExpired       = new Date(inv.expires_at) <= new Date();
              const isConfirming       = revokeConfirmCode === inv.code;
              const isRevoking         = revokingCode === inv.code;
              const isResending        = resendingCode === inv.code;
              const isConfirmingResend = generateNewLinkCode === inv.code;
              return (
                <div
                  key={inv.id}
                  className="flex items-center justify-between gap-3 px-4 py-3 bg-white dark:bg-gray-800"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                        {ROLE_LABELS[inv.role] ?? inv.role}
                      </span>
                      {isExpired && (
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                          Expired
                        </span>
                      )}
                      <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
                        {inv.email ?? (
                          <span className="text-gray-400 dark:text-gray-500 italic">
                            Any email
                          </span>
                        )}
                      </p>
                    </div>
                    {!isExpired && (
                      <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                        Expires {formatExpiry(inv.expires_at)}
                      </p>
                    )}
                  </div>

                  <div className="shrink-0 flex items-center gap-3">
                    {isConfirming ? (
                      /* Inline revoke confirmation */
                      <>
                        <span className="text-xs text-gray-500 dark:text-gray-400 hidden sm:inline">
                          Revoke?
                        </span>
                        <button
                          onClick={() => setRevokeConfirmCode(null)}
                          className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleRevoke(inv.code)}
                          disabled={isRevoking}
                          className="text-xs font-medium text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-40"
                        >
                          {isRevoking ? "Revoking…" : "Yes, revoke"}
                        </button>
                      </>
                    ) : isExpired ? (
                      /* Expired: offer generate new link with inline confirmation */
                      isConfirmingResend ? (
                        <div className="flex flex-col items-end gap-1.5 min-w-0">
                          <p className="text-xs text-gray-500 dark:text-gray-400 text-right max-w-[220px] leading-snug">
                            The expired link stays unusable. A new 7-day link will be generated — copy and share it manually.
                          </p>
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => setGenerateNewLinkCode(null)}
                              className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => handleResend(inv)}
                              disabled={isResending}
                              className="text-xs font-medium text-accent hover:underline disabled:opacity-40"
                            >
                              {isResending ? "Generating…" : "Generate link"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setGenerateNewLinkCode(inv.code)}
                          disabled={isResending}
                          className="text-xs font-medium text-accent hover:underline disabled:opacity-40"
                        >
                          Generate new link
                        </button>
                      )
                    ) : (
                      /* Active: copy link + revoke (with confirmation) */
                      <>
                        <button
                          onClick={() => handleCopy(inv.code)}
                          className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                        >
                          {copiedCode === inv.code
                            ? "Copied!"
                            : copyError === inv.code
                            ? "Copy failed"
                            : "Copy Link"}
                        </button>
                        <span className="text-gray-200 dark:text-gray-700 select-none">|</span>
                        <button
                          onClick={() => setRevokeConfirmCode(inv.code)}
                          className="text-xs font-medium text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                        >
                          Revoke
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Deactivate / Reactivate / Suspend / Remove confirmation dialog —
          one shared dialog for all four club-scoped status actions,
          distinguished by CONFIRM_COPY. */}
      {confirmDialog && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={() => { if (!statusChangingId) setConfirmDialog(null); }}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-sm px-6 py-6">
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {CONFIRM_COPY[confirmDialog.action].verb} {confirmDialog.memberName}?
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-2 leading-relaxed">
                {CONFIRM_COPY[confirmDialog.action].body}
              </p>
              {confirmDialog.error && (
                <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                  {confirmDialog.error}
                </p>
              )}
              <div className="mt-5 flex gap-3">
                <button
                  disabled={!!statusChangingId}
                  onClick={() => setConfirmDialog(null)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  disabled={!!statusChangingId}
                  onClick={handleConfirmStatus}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium disabled:opacity-50 ${
                    CONFIRM_COPY[confirmDialog.action].danger
                      ? "bg-red-600 dark:bg-red-500 text-white"
                      : "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
                  }`}
                >
                  {statusChangingId
                    ? CONFIRM_COPY[confirmDialog.action].verbing + "…"
                    : CONFIRM_COPY[confirmDialog.action].verb}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Delete roster member confirmation dialog */}
      {deleteDialog && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={() => { if (!deletingId) setDeleteDialog(null); }}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-sm px-6 py-6">
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Remove {deleteDialog.name} from the roster?
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-2 leading-relaxed">
                This member will be marked inactive and won&apos;t appear as a
                target for new bookings, events, or programs. Their existing
                reservation, event, and program history stays intact, and they
                can be restored later.
              </p>
              {deleteDialog.error && (
                <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                  {deleteDialog.error}
                </p>
              )}
              <div className="mt-5 flex gap-3">
                <button
                  disabled={!!deletingId}
                  onClick={() => setDeleteDialog(null)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  disabled={!!deletingId}
                  onClick={handleConfirmDelete}
                  className="flex-1 py-2.5 rounded-xl bg-red-600 dark:bg-red-500 text-white text-sm font-medium disabled:opacity-50"
                >
                  {deletingId ? "Removing…" : "Remove"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Invite sheet */}
      {inviteSheetOpen && inviteRosterMember && (
        <InviteSheet onClose={closeInviteSheet} rosterMember={inviteRosterMember} />
      )}

      {/* Add member sheet */}
      {addSheetOpen && (
        <AddMemberSheet onClose={() => setAddSheetOpen(false)} userRole={userRole} />
      )}

      {/* Edit member sheet */}
      {editMember && (
        <AddMemberSheet onClose={closeEditSheet} editMember={editMember} userRole={userRole} />
      )}

      {/* Import members sheet */}
      {importSheetOpen && (
        <ImportMembersSheet
          onClose={() => setImportSheetOpen(false)}
          rosterMembers={rosterMembers}
          memberEmails={members.map(m => m.email).filter((e): e is string => !!e)}
          pendingInviteEmails={pendingInvites
            .filter(inv => !inv.revoked_at && !inv.accepted_at && new Date(inv.expires_at) > new Date())
            .map(inv => inv.email)
            .filter((e): e is string => !!e)}
        />
      )}
    </>
  );
}

// ── Profile card (auth-linked member) ────────────────────────────────────────

// UX correction pass — the Actions menu's floating popover. Root cause of
// the prior clipping bug: it was `position: absolute`, whose containing
// block for clipping purposes is the card's own border box — and the
// card has `overflow-hidden` (for its own rounded corners), so any part
// of the menu extending past the card's edge was invisibly cut off.
// Fixed here by rendering the menu through a React portal directly into
// document.body: portals escape their parent's DOM subtree entirely (only
// React context is preserved, not layout/clipping/stacking), so the
// card's overflow-hidden can no longer clip it regardless of the card's
// own styling, now or in the future. Position is computed in JS from the
// trigger's getBoundingClientRect() — never CSS `absolute`-relative-to-
// ancestor — so opening the menu can never affect the card's own
// normal-flow height or push surrounding content: the menu literally
// isn't a layout child of the card at all once open.
const ACTIONS_MENU_WIDTH = 160; // matches the prior w-40
const ACTIONS_MENU_VIEWPORT_MARGIN = 8;
const ACTIONS_MENU_GAP = 4; // space between trigger and menu

function ProfileCard({
  member: m,
  currentUserId,
  activeAdminCount,
  changingRoleId,
  roleErrors,
  onRoleChange,
  onStatusAction,
  membershipsEnabled,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
}: {
  member:           Member;
  currentUserId:    string;
  activeAdminCount: number;
  changingRoleId:   string | null;
  roleErrors:       Record<string, string>;
  onRoleChange:     (id: string, role: string) => void;
  onStatusAction:   (m: Member, action: MemberAction) => void;
  membershipsEnabled: boolean;
  menuOpen:      boolean;
  onToggleMenu:  () => void;
  onCloseMenu:   () => void;
}) {
  const fullName =
    [m.first_name, m.last_name].filter(Boolean).join(" ") || "Unnamed member";
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const firstMenuItemRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; placement: "below" | "above" } | null>(null);

  // Reuses the same small hand-rolled menu pattern CalendarFab already
  // established (backdrop click-to-close, role="menu"/"menuitem",
  // ct-popover-enter) rather than introducing a dropdown library.
  // Autofocuses the first item on open; Escape closes and returns focus
  // to the trigger.
  useEffect(() => {
    if (menuOpen) firstMenuItemRef.current?.focus();
  }, [menuOpen]);

  // Viewport-aware positioning: right-aligned to the trigger (matching
  // the prior visual placement) but clamped so it never runs off either
  // horizontal edge, and flipped above the trigger when there isn't room
  // below. Runs on open (using an estimated height, so the FIRST paint is
  // already correctly placed with no visible jump) and once more via
  // rAF after the menu has actually mounted and can be measured exactly
  // (its height varies — 2 items when Suspend is hidden, 3 when shown).
  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPosition(null);
      return;
    }
    const trigger = menuTriggerRef.current;
    if (!trigger) return;

    function computePosition() {
      const rect = trigger!.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const estimatedHeight = menuRef.current?.offsetHeight ?? 136; // ~3-item estimate

      let left = rect.right - ACTIONS_MENU_WIDTH;
      left = Math.max(
        ACTIONS_MENU_VIEWPORT_MARGIN,
        Math.min(left, viewportWidth - ACTIONS_MENU_WIDTH - ACTIONS_MENU_VIEWPORT_MARGIN)
      );

      const fitsBelow = rect.bottom + ACTIONS_MENU_GAP + estimatedHeight <= viewportHeight - ACTIONS_MENU_VIEWPORT_MARGIN;
      const top = fitsBelow
        ? rect.bottom + ACTIONS_MENU_GAP
        : Math.max(ACTIONS_MENU_VIEWPORT_MARGIN, rect.top - ACTIONS_MENU_GAP - estimatedHeight);

      setMenuPosition({ top, left, placement: fitsBelow ? "below" : "above" });
    }

    computePosition();
    const raf = requestAnimationFrame(computePosition);
    return () => cancelAnimationFrame(raf);
  }, [menuOpen]);

  // Scrolling (the page's own inner scroll container or the window)
  // would otherwise leave a fixed-position portal menu visually detached
  // from its trigger — closing on scroll is simpler and safer than
  // continuously repositioning, and matches "click away closes" in
  // spirit. Capture: true so it also catches scroll on any ancestor
  // scroll container, not only window-level scroll.
  useEffect(() => {
    if (!menuOpen) return;
    function handleScroll() {
      onCloseMenu();
    }
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [menuOpen, onCloseMenu]);

  function closeMenuAndRefocus() {
    onCloseMenu();
    menuTriggerRef.current?.focus();
  }

  function selectMenuAction(action: () => void) {
    onCloseMenu();
    action();
  }
  const isActive    = m.status === "active";
  const isSuspended = m.status === "suspended";
  const isSelf      = m.id === currentUserId;
  const isLastAdmin = m.role === "admin" && activeAdminCount <= 1;
  const controlsDisabled = isSelf || isLastAdmin;
  const roleError = roleErrors[m.id];

  return (
    <div
      className={`ct-card mx-4 mb-3 overflow-hidden transition-opacity${
        !isActive ? " opacity-60" : ""
      }`}
    >
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          {/* UX correction pass — mobile hierarchy: the member name is now
              the strongest text on the card on mobile (text-base, same
              size the role <select> below is forced to for iOS zoom-
              prevention — the bold weight is what keeps the name clearly
              dominant even at equal size), settling back to the prior
              text-sm at sm+ where density matters more than mobile
              legibility. */}
          <Link
            href={`/admin/members/${m.id}`}
            className="text-base md:text-sm font-semibold text-gray-900 dark:text-gray-100 truncate hover:text-accent motion-safe:transition-colors"
          >
            {fullName}
          </Link>
          {/* UX correction pass — "Club status" is now a small muted LABEL
              beside a compact semantic badge holding only the value
              (Active/Suspended/Inactive), replacing the single wide pill
              that used to carry the whole phrase "Club status: Active" —
              narrower, and the label/value split reads unambiguously
              without needing the value's own pill to grow to fit a
              sentence. Colors/semantics on the value badge unchanged. */}
          <div className="shrink-0 flex items-center gap-1">
            <span className="text-[10px] text-gray-400 dark:text-gray-500">Club status</span>
            {isActive ? (
              <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                Active
              </span>
            ) : isSuspended ? (
              <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                Suspended
              </span>
            ) : (
              <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                Inactive
              </span>
            )}
          </div>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {m.email ?? "—"}
        </p>
        <p className="text-xs text-gray-400 mt-0.5">
          {m.phone ?? "—"} · Joined {formatJoinDate(m.created_at)}
        </p>
        {/* Phase 42C-3B — one compact, muted line, explicit "Membership: "
            prefix so it can never be confused with the lifecycle pill
            above (Active/Suspended/Inactive). Hidden entirely when
            Memberships are off, and when membership_status is null (a
            legacy claimed profile with no matching roster row — nothing
            to report, not a fabricated default). */}
        {membershipsEnabled && membershipLine(m.membership_status, m.membership_type_name) && (
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            {membershipLine(m.membership_status, m.membership_type_name)}
          </p>
        )}
      </div>

      {/* UX correction pass — Role/View/Actions collapsed into ONE compact
          row ("[ Role ▼ ] [ View ] [ Actions ▾ ]"), replacing the prior
          left-column/right-group split (which is what let the role
          <select> visually dominate the card on mobile). The role select
          keeps its exact iOS-safe font sizing (text-base on mobile,
          preventing Safari's zoom-on-focus — never shrunk below that just
          to look smaller) and now flexes to fill the row's remaining
          width (flex-1, with a floor so it never gets squeezed
          illegibly) while View/Actions stay their natural compact size
          (shrink-0); flex-wrap lets the row fall back to two lines only
          when genuinely too narrow to fit all three, never causing
          horizontal overflow. Saving/error/Last-admin/Lesson-Pro messages
          move to their own line below the row, still directly associated
          with the role control via that vertical adjacency. */}
      <div className="px-4 pb-3 pt-2 border-t border-gray-100 dark:border-gray-700 space-y-1.5">
        <div className="flex items-center flex-wrap gap-1.5">
          <select
            value={m.role}
            disabled={controlsDisabled || changingRoleId === m.id}
            onChange={(e) => onRoleChange(m.id, e.target.value)}
            className="ct-input py-1.5 text-base md:text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed flex-1 min-w-[6rem] md:flex-initial md:w-auto"
          >
            {ROLE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>

          <Link
            href={`/admin/members/${m.id}`}
            className="px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-600 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150"
          >
            View
          </Link>

          {/* Deactivate/Reactivate, Suspend, and Remove consolidated into
              one "Actions ▾" menu (same hand-rolled interaction pattern
              as CalendarFab, src/app/(app)/calendar/CalendarFab.tsx — no
              dropdown library). Mutation behavior is completely
              unchanged: every item still calls the exact same
              onStatusAction(m, ...) this card already called directly.
              The trigger is disabled outright (never opens an all-
              disabled menu) when controlsDisabled (self or last admin).
              UX correction pass — the menu itself is portaled to
              document.body (see the ACTIONS_MENU_* constants/effects
              above for why) so it can never be clipped by this card's
              own overflow-hidden, and opening it never touches this
              card's layout at all — no `relative` wrapper needed here
              any more since positioning is computed in JS, not CSS
              relative-to-ancestor. */}
          <button
            ref={menuTriggerRef}
            type="button"
            disabled={controlsDisabled}
            onClick={onToggleMenu}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Actions for ${fullName}`}
            className="px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-600 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Actions ▾
          </button>

          {menuOpen && createPortal(
            <>
              {/* Transparent backdrop — click anywhere to close */}
              <div className="fixed inset-0 z-40" onClick={onCloseMenu} />

              <div
                ref={menuRef}
                role="menu"
                aria-label={`Actions for ${fullName}`}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeMenuAndRefocus();
                  }
                }}
                style={{
                  position: "fixed",
                  // Rendered off-screen for the one frame before the
                  // first computePosition() call resolves — invisible
                  // (opacity via ct-popover-enter's own keyframe start),
                  // never at a wrong on-screen position.
                  top: menuPosition?.top ?? -9999,
                  left: menuPosition?.left ?? -9999,
                  width: ACTIONS_MENU_WIDTH,
                }}
                className="ct-popover-enter z-50 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden py-1"
              >
                {/* Deactivate/Reactivate — the primary, most common status action */}
                <button
                  ref={firstMenuItemRef}
                  role="menuitem"
                  onClick={() => selectMenuAction(() => onStatusAction(m, isActive ? "deactivate" : "reactivate"))}
                  className={`w-full text-left px-4 py-2.5 text-sm motion-safe:transition-colors motion-safe:duration-100 hover:bg-gray-50 dark:hover:bg-gray-700/60 focus-visible:outline-none focus-visible:bg-gray-50 dark:focus-visible:bg-gray-700/60 ${
                    isActive
                      ? "text-red-600 dark:text-red-400"
                      : "text-gray-700 dark:text-gray-200"
                  }`}
                >
                  {isActive ? "Deactivate" : "Reactivate"}
                </button>
                {/* Suspend — only offered from active, to avoid a confusing
                    inactive->suspended->inactive shuffle */}
                {isActive && (
                  <button
                    role="menuitem"
                    onClick={() => selectMenuAction(() => onStatusAction(m, "suspend"))}
                    className="w-full text-left px-4 py-2.5 text-sm text-amber-700 dark:text-amber-400 hover:bg-gray-50 dark:hover:bg-gray-700/60 motion-safe:transition-colors motion-safe:duration-100 focus-visible:outline-none focus-visible:bg-gray-50 dark:focus-visible:bg-gray-700/60"
                  >
                    Suspend
                  </button>
                )}
                {/* Remove — always available (except the last admin), always
                    destructive-styled and confirmed */}
                <button
                  role="menuitem"
                  onClick={() => selectMenuAction(() => onStatusAction(m, "remove"))}
                  className="w-full text-left px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-gray-50 dark:hover:bg-gray-700/60 motion-safe:transition-colors motion-safe:duration-100 focus-visible:outline-none focus-visible:bg-gray-50 dark:focus-visible:bg-gray-700/60"
                >
                  Remove
                </button>
              </div>
            </>,
            document.body
          )}
        </div>

        {/* Saving/error/Last-admin/Lesson-Pro — moved out from under the
            role select (was a flex-col sibling of just that control) to
            their own line below the whole Role/View/Actions row, since
            the select is no longer in a single-purpose column of its
            own. Still reads as directly associated with Role via
            vertical adjacency; nothing here changed in behavior. */}
        {changingRoleId === m.id && (
          <p className="text-xs text-gray-400 dark:text-gray-500">Saving…</p>
        )}
        {roleError && (
          <p className="text-xs text-red-600 dark:text-red-400">{roleError}</p>
        )}
        {isLastAdmin && (
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Last admin — cannot change.
          </p>
        )}
        {m.is_lesson_provider && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-accent/10 text-accent w-fit">
            {m.role === "staff" ? "Staff · Pro" : "Lesson Pro"}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Roster card (unclaimed member) ───────────────────────────────────────────

function RosterCard({
  roster: rm,
  onEdit,
  onDelete,
  onInvite,
  membershipsEnabled,
  userRole,
  membershipTypes,
  editorOpen,
  onToggleEditor,
  onStatusChange,
  onTypeChange,
  pending,
  error,
}: {
  roster:   RosterMember;
  onEdit:   (rm: RosterMember) => void;
  onDelete: (rm: RosterMember) => void;
  onInvite: (rm: RosterMember) => void;
  membershipsEnabled: boolean;
  userRole:            string;
  membershipTypes:     MembershipTypeOption[];
  editorOpen:          boolean;
  onToggleEditor:      (rm: RosterMember) => void;
  onStatusChange:      (rm: RosterMember, status: "active" | "inactive" | "suspended" | "non_member") => void;
  onTypeChange:        (rm: RosterMember, membershipTypeId: string) => void;
  pending:             boolean;
  error?:              string;
}) {
  const fullName = [rm.first_name, rm.last_name].filter(Boolean).join(" ");
  const details = [rm.email, rm.phone].filter(Boolean).join(" · ");
  const isAdmin = userRole === "admin";

  // Phase 42C-3B — unclaimed roster identities are valid membership
  // identities and must be manageable without first claiming an account
  // (locked product correction). The currently-assigned type, if any, is
  // always included as a selectable option even when it's not in the
  // active-types pool passed down — an inactive type stays attached and
  // must still display/select correctly for its existing holder, just
  // never becomes newly assignable to anyone else. If it's already in
  // the active list (still active), it isn't duplicated.
  const typeOptions: (MembershipTypeOption & { inactive?: boolean })[] = [
    ...membershipTypes,
    ...(rm.membership_type_id && !membershipTypes.some((t) => t.id === rm.membership_type_id)
      ? [{ id: rm.membership_type_id, name: rm.membership_type_name ?? "Unknown type", inactive: true }]
      : []),
  ];

  return (
    <div className="ct-card mx-4 mb-3 overflow-hidden">
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {fullName}
          </p>
          <span className="shrink-0 inline-block px-2 py-0.5 rounded text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
            No account yet
          </span>
        </div>
        {details && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{details}</p>
        )}
        {rm.notes && (
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 italic">{rm.notes}</p>
        )}
        <p className="text-xs text-gray-400 mt-0.5">
          {ROLE_LABELS[rm.role] ?? rm.role} · Added {formatJoinDate(rm.created_at)}
        </p>
        {/* Same explicit wording/visibility rule as ProfileCard's line —
            unclaimed roster identities always have a non-null
            membership_status (the table default), so this only ever
            hides when Memberships themselves are off. */}
        {membershipsEnabled && (
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            {membershipLine(rm.membership_status, rm.membership_type_name)}
          </p>
        )}
      </div>

      <div className="px-4 pb-3 pt-2 border-t border-gray-100 dark:border-gray-700 flex items-center gap-3 flex-wrap">
        <button
          onClick={() => onEdit(rm)}
          className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150"
        >
          Edit
        </button>
        <button
          onClick={() => onDelete(rm)}
          className="px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-800 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 motion-safe:transition-all motion-safe:duration-150"
        >
          Remove
        </button>
        {rm.email && (
          <button
            onClick={() => onInvite(rm)}
            className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150"
          >
            Send Invite
          </button>
        )}
        {/* Phase 42C-3B — Admin only, hidden entirely when Memberships are
            off. Compact: collapsed by default (matches CourtManagementList's
            Rate-row precedent of hiding inputs behind a button rather than
            always rendering them), so a card with no membership activity
            stays exactly as compact as before this feature existed. */}
        {membershipsEnabled && isAdmin && (
          <button
            onClick={() => onToggleEditor(rm)}
            className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150"
          >
            Membership
          </button>
        )}
      </div>

      {membershipsEnabled && isAdmin && editorOpen && (
        <div className="px-4 pb-3 pt-2 border-t border-gray-100 dark:border-gray-700 flex flex-col gap-2">
          <div className="flex flex-col gap-1 min-w-0">
            <label className="text-[10px] text-gray-400 dark:text-gray-500">
              Membership Status
            </label>
            <select
              value={rm.membership_status}
              disabled={pending}
              onChange={(e) => onStatusChange(rm, e.target.value as "active" | "inactive" | "suspended" | "non_member")}
              className="ct-input py-1.5 text-base md:text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="suspended">Suspended</option>
              <option value="non_member">Non-Member</option>
            </select>
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <label className="text-[10px] text-gray-400 dark:text-gray-500">
              Membership Type
            </label>
            <select
              value={rm.membership_type_id ?? ""}
              disabled={pending}
              onChange={(e) => onTypeChange(rm, e.target.value)}
              className="ct-input py-1.5 text-base md:text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">None</option>
              {typeOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.inactive ? " (inactive type)" : ""}
                </option>
              ))}
            </select>
          </div>
          {pending && (
            <p className="text-xs text-gray-400 dark:text-gray-500">Saving…</p>
          )}
          {error && (
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
