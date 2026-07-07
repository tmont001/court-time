"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import InviteSheet from "./InviteSheet";
import AddMemberSheet from "./AddMemberSheet";
import ImportMembersSheet from "./ImportMembersSheet";
import type { EditRosterMember } from "./AddMemberSheet";
import {
  revokeInviteAction,
  setMemberRoleAction,
  setMemberStatusAction,
  setMemberNotesAction,
  deleteRosterMemberAction,
} from "./actions";

const ROLE_LABELS: Record<string, string> = {
  member: "Member",
  pro:    "Pro",
  admin:  "Admin",
};

const ROLE_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "pro",    label: "Pro"    },
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

const ROLE_ORDER:   Record<string, number> = { admin: 0, pro: 1, member: 2 };
const STATUS_ORDER: Record<string, number> = { active: 0, inactive: 1, no_account: 2 };

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
  id:          string;
  first_name:  string | null;
  last_name:   string | null;
  phone:       string | null;
  role:        string;
  status:      string;
  created_at:  string;
  email:       string | null;
  admin_notes: string | null;
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
  action:     "deactivate" | "reactivate";
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
}

export default function MembersClient({
  members,
  rosterMembers,
  pendingInvites,
  currentUserId,
  membersError,
  invitesError,
}: Props) {
  const router = useRouter();
  const [inviteSheetOpen, setInviteSheetOpen]   = useState(false);
  const [inviteEmail, setInviteEmail]           = useState<string | undefined>();
  const [addSheetOpen, setAddSheetOpen]         = useState(false);
  const [importSheetOpen, setImportSheetOpen]   = useState(false);
  const [editMember, setEditMember]             = useState<EditRosterMember | undefined>();
  const [revokeError, setRevokeError]         = useState<string | null>(null);
  const [revokingCode, setRevokingCode]       = useState<string | null>(null);
  const [copiedCode, setCopiedCode]           = useState<string | null>(null);
  const [copyError,  setCopyError]            = useState<string | null>(null);
  const [, startTransition]                   = useTransition();

  // Sort
  const [sortField, setSortField] = useState<SortField>("first_name");
  const [sortDir,   setSortDir]   = useState<SortDir>("asc");

  // Role change
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);
  const [roleErrors, setRoleErrors]         = useState<Record<string, string>>({});

  // Status change
  const [confirmDialog, setConfirmDialog]       = useState<ConfirmDialog | null>(null);
  const [statusChangingId, setStatusChangingId] = useState<string | null>(null);

  // Delete roster member
  const [deleteDialog, setDeleteDialog]     = useState<DeleteDialog | null>(null);
  const [deletingId, setDeletingId]         = useState<string | null>(null);

  const activeAdminCount = members.filter(
    (m) => m.role === "admin" && m.status === "active"
  ).length;

  const totalCount = members.length + rosterMembers.length;

  // Unified sorted list
  const sortedItems = useMemo(() => {
    const items: ListItem[] = [
      ...members.map((m): ListItem => ({ kind: "profile", data: m })),
      ...rosterMembers.map((r): ListItem => ({ kind: "roster", data: r })),
    ];
    items.sort((a, b) => {
      let result = 0;
      const aFirst = a.data.first_name;
      const bFirst = b.data.first_name;
      const aLast  = a.data.last_name;
      const bLast  = b.data.last_name;
      const aRole  = a.data.role;
      const bRole  = b.data.role;
      const aStatus = a.kind === "profile" ? a.data.status : "no_account";
      const bStatus = b.kind === "profile" ? b.data.status : "no_account";

      switch (sortField) {
        case "first_name":
          result = cmp(aFirst, bFirst);
          break;
        case "last_name":
          result = cmp(aLast, bLast);
          break;
        case "role":
          result = (ROLE_ORDER[aRole] ?? 99) - (ROLE_ORDER[bRole] ?? 99);
          break;
        case "status":
          result = (STATUS_ORDER[aStatus] ?? 99) - (STATUS_ORDER[bStatus] ?? 99);
          break;
      }
      return sortDir === "asc" ? result : -result;
    });
    return items;
  }, [members, rosterMembers, sortField, sortDir]);

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
      if (result.error) {
        setRevokeError(result.error);
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

  function openConfirmDialog(member: Member) {
    const memberName =
      [member.first_name, member.last_name].filter(Boolean).join(" ") || "this member";
    const action: "deactivate" | "reactivate" =
      member.status === "active" ? "deactivate" : "reactivate";
    setConfirmDialog({ memberId: member.id, memberName, action });
  }

  function handleConfirmStatus() {
    if (!confirmDialog) return;
    const newStatus = confirmDialog.action === "deactivate" ? "inactive" : "active";
    setStatusChangingId(confirmDialog.memberId);
    startTransition(async () => {
      const result = await setMemberStatusAction(confirmDialog.memberId, newStatus);
      setStatusChangingId(null);
      if (result.error) {
        setConfirmDialog((prev) => (prev ? { ...prev, error: result.error } : null));
      } else {
        setConfirmDialog(null);
        router.refresh();
      }
    });
  }

  function openDeleteDialog(rm: RosterMember) {
    const name = [rm.first_name, rm.last_name].filter(Boolean).join(" ");
    setDeleteDialog({ id: rm.id, name });
  }

  function handleConfirmDelete() {
    if (!deleteDialog) return;
    setDeletingId(deleteDialog.id);
    startTransition(async () => {
      const result = await deleteRosterMemberAction(deleteDialog.id);
      setDeletingId(null);
      if (result.error) {
        setDeleteDialog((prev) => (prev ? { ...prev, error: result.error } : null));
      } else {
        setDeleteDialog(null);
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

  function openInviteForRoster(email: string) {
    setInviteEmail(email);
    setInviteSheetOpen(true);
  }

  function closeInviteSheet() {
    setInviteSheetOpen(false);
    setInviteEmail(undefined);
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

      {/* Sort controls */}
      {!membersError && totalCount > 1 && (
        <div className="mx-4 mb-3 flex gap-1.5 overflow-x-auto hide-scrollbar">
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

      {/* Member list */}
      {membersError ? (
        <div className="mx-4 mt-2 px-4 py-3 bg-red-50 rounded-xl border border-red-200">
          <p className="text-sm font-semibold text-red-700">Failed to load members</p>
          <p className="text-xs text-red-500 mt-1 break-all">{membersError}</p>
        </div>
      ) : totalCount === 0 ? (
        <div className="flex flex-col items-center justify-center h-32 gap-1">
          <p className="text-gray-400 dark:text-gray-500 text-sm">No members yet.</p>
          <p className="text-gray-400 dark:text-gray-500 text-xs">
            Tap <strong>Add Member</strong> to add someone to the roster.
          </p>
        </div>
      ) : (
        <div className="pb-2">
          {sortedItems.map((item) =>
            item.kind === "profile" ? (
              <ProfileCard
                key={`p-${item.data.id}`}
                member={item.data}
                currentUserId={currentUserId}
                activeAdminCount={activeAdminCount}
                changingRoleId={changingRoleId}
                roleErrors={roleErrors}
                onRoleChange={handleRoleChange}
                onStatusToggle={openConfirmDialog}
              />
            ) : (
              <RosterCard
                key={`r-${item.data.id}`}
                roster={item.data}
                onEdit={openEditSheet}
                onDelete={openDeleteDialog}
                onInvite={openInviteForRoster}
              />
            )
          )}
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

        {revokeError && (
          <div className="mb-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700">
            <p className="text-xs text-red-700 dark:text-red-400">{revokeError}</p>
          </div>
        )}

        {pendingInvites.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-500 py-3">
            No pending invites.
          </p>
        ) : (
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
            {pendingInvites.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between gap-3 px-4 py-3 bg-white dark:bg-gray-800"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                      {ROLE_LABELS[inv.role] ?? inv.role}
                    </span>
                    <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
                      {inv.email ?? (
                        <span className="text-gray-400 dark:text-gray-500 italic">
                          Any email
                        </span>
                      )}
                    </p>
                  </div>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                    Expires {formatExpiry(inv.expires_at)}
                  </p>
                </div>
                <div className="shrink-0 flex items-center gap-3">
                  <button
                    onClick={() => handleCopy(inv.code)}
                    className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    {copiedCode === inv.code
                      ? "Copied!"
                      : copyError === inv.code
                      ? "Copy failed — select manually."
                      : "Copy Link"}
                  </button>
                  <span className="text-gray-200 dark:text-gray-700 select-none">|</span>
                  <button
                    onClick={() => handleRevoke(inv.code)}
                    disabled={revokingCode === inv.code}
                    className="text-xs font-medium text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-40"
                  >
                    {revokingCode === inv.code ? "Revoking…" : "Revoke"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Deactivate / Reactivate confirmation dialog */}
      {confirmDialog && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={() => { if (!statusChangingId) setConfirmDialog(null); }}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-sm px-6 py-6">
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {confirmDialog.action === "deactivate" ? "Deactivate" : "Reactivate"}{" "}
                {confirmDialog.memberName}?
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-2 leading-relaxed">
                {confirmDialog.action === "deactivate"
                  ? "This member will lose access to booking courts and joining events. Their existing reservations and history will remain intact."
                  : "This member will regain full access to booking courts and joining events."}
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
                    confirmDialog.action === "deactivate"
                      ? "bg-red-600 dark:bg-red-500 text-white"
                      : "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
                  }`}
                >
                  {statusChangingId
                    ? confirmDialog.action === "deactivate"
                      ? "Deactivating…"
                      : "Reactivating…"
                    : confirmDialog.action === "deactivate"
                      ? "Deactivate"
                      : "Reactivate"}
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
                This only removes the roster entry. It does not affect any signed-in account.
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
      {inviteSheetOpen && (
        <InviteSheet onClose={closeInviteSheet} initialEmail={inviteEmail} />
      )}

      {/* Add member sheet */}
      {addSheetOpen && (
        <AddMemberSheet onClose={() => setAddSheetOpen(false)} />
      )}

      {/* Edit member sheet */}
      {editMember && (
        <AddMemberSheet onClose={closeEditSheet} editMember={editMember} />
      )}

      {/* Import members sheet */}
      {importSheetOpen && (
        <ImportMembersSheet
          onClose={() => setImportSheetOpen(false)}
          rosterMembers={rosterMembers}
        />
      )}
    </>
  );
}

// ── Profile card (auth-linked member) ────────────────────────────────────────

function ProfileCard({
  member: m,
  currentUserId,
  activeAdminCount,
  changingRoleId,
  roleErrors,
  onRoleChange,
  onStatusToggle,
}: {
  member:           Member;
  currentUserId:    string;
  activeAdminCount: number;
  changingRoleId:   string | null;
  roleErrors:       Record<string, string>;
  onRoleChange:     (id: string, role: string) => void;
  onStatusToggle:   (m: Member) => void;
}) {
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesValue, setNotesValue]     = useState(m.admin_notes ?? "");
  const [notesSaving, setNotesSaving]   = useState(false);
  const [notesSaved, setNotesSaved]     = useState(false);
  const [notesError, setNotesError]     = useState<string | null>(null);

  const fullName =
    [m.first_name, m.last_name].filter(Boolean).join(" ") || "Unnamed member";
  const isActive    = m.status === "active";
  const isSelf      = m.id === currentUserId;
  const isLastAdmin = m.role === "admin" && activeAdminCount <= 1;
  const controlsDisabled = isSelf || isLastAdmin;
  const roleError = roleErrors[m.id];

  async function saveNotes() {
    const trimmed = notesValue.trim();
    if (trimmed === (m.admin_notes ?? "")) {
      setNotesEditing(false);
      return;
    }
    setNotesSaving(true);
    setNotesError(null);
    const result = await setMemberNotesAction(m.id, trimmed || null);
    setNotesSaving(false);
    if (result.error) {
      setNotesError(result.error);
      return;
    }
    setNotesEditing(false);
    setNotesSaved(true);
    setTimeout(() => setNotesSaved(false), 2000);
  }

  return (
    <div
      className={`ct-card mx-4 mb-3 overflow-hidden transition-opacity${
        !isActive ? " opacity-60" : ""
      }`}
    >
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {fullName}
          </p>
          {isActive ? (
            <span className="shrink-0 inline-block px-2 py-0.5 rounded text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
              Active
            </span>
          ) : (
            <span className="shrink-0 inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
              Inactive
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {m.email ?? "—"}
        </p>
        <p className="text-xs text-gray-400 mt-0.5">
          {m.phone ?? "—"} · Joined {formatJoinDate(m.created_at)}
        </p>

        {/* Admin notes */}
        <div className="mt-1.5">
          {notesEditing ? (
            <div className="flex gap-1.5 items-start">
              <input
                type="text"
                value={notesValue}
                onChange={e => setNotesValue(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") saveNotes(); if (e.key === "Escape") { setNotesEditing(false); setNotesValue(m.admin_notes ?? ""); } }}
                placeholder="Add notes…"
                autoFocus
                className="flex-1 min-w-0 text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-2 py-1 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <button
                disabled={notesSaving}
                onClick={saveNotes}
                className="shrink-0 text-xs font-medium text-accent disabled:opacity-40"
              >
                {notesSaving ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => { setNotesEditing(false); setNotesValue(m.admin_notes ?? ""); setNotesError(null); }}
                className="shrink-0 text-xs text-gray-400"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => { setNotesEditing(true); setNotesValue(m.admin_notes ?? ""); }}
              className="text-xs text-left"
            >
              {m.admin_notes ? (
                <span className="text-gray-400 dark:text-gray-500 italic">{m.admin_notes}</span>
              ) : (
                <span className="text-gray-300 dark:text-gray-600">Add notes</span>
              )}
            </button>
          )}
          {notesSaved && <p className="text-xs text-green-600 dark:text-green-400 mt-0.5">Saved</p>}
          {notesError && <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">{notesError}</p>}
        </div>
      </div>

      <div className="px-4 pb-3 pt-2 border-t border-gray-100 dark:border-gray-700 flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <select
            value={m.role}
            disabled={controlsDisabled || changingRoleId === m.id}
            onChange={(e) => onRoleChange(m.id, e.target.value)}
            className="ct-input py-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {ROLE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
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
        </div>

        <button
          disabled={controlsDisabled}
          onClick={() => onStatusToggle(m)}
          className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            isActive
              ? "border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
              : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          }`}
        >
          {isActive ? "Deactivate" : "Reactivate"}
        </button>
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
}: {
  roster:   RosterMember;
  onEdit:   (rm: RosterMember) => void;
  onDelete: (rm: RosterMember) => void;
  onInvite: (email: string) => void;
}) {
  const fullName = [rm.first_name, rm.last_name].filter(Boolean).join(" ");
  const details = [rm.email, rm.phone].filter(Boolean).join(" · ");

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
      </div>

      <div className="px-4 pb-3 pt-2 border-t border-gray-100 dark:border-gray-700 flex items-center gap-3">
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
            onClick={() => onInvite(rm.email!)}
            className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150"
          >
            Send Invite
          </button>
        )}
      </div>
    </div>
  );
}
