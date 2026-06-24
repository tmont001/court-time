"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import InviteSheet from "./InviteSheet";
import { revokeInviteAction, setMemberRoleAction, setMemberStatusAction } from "./actions";

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

// Defined order for role (admin → pro → member) and status (active → inactive).
const ROLE_ORDER:   Record<string, number> = { admin: 0, pro: 1, member: 2 };
const STATUS_ORDER: Record<string, number> = { active: 0, inactive: 1 };

function cmp(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;   // nulls last
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

type Member = {
  id:         string;
  first_name: string | null;
  last_name:  string | null;
  phone:      string | null;
  role:       string;
  status:     string;
  created_at: string;
  email:      string | null;
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

type ConfirmDialog = {
  memberId:   string;
  memberName: string;
  action:     "deactivate" | "reactivate";
  error?:     string;
};

interface Props {
  members:        Member[];
  pendingInvites: PendingInvite[];
  currentUserId:  string;
  membersError?:  string | null;
  invitesError?:  string | null;
}

export default function MembersClient({
  members,
  pendingInvites,
  currentUserId,
  membersError,
  invitesError,
}: Props) {
  const router = useRouter();
  const [sheetOpen, setSheetOpen]       = useState(false);
  const [revokeError, setRevokeError]   = useState<string | null>(null);
  const [revokingCode, setRevokingCode] = useState<string | null>(null);
  const [copiedCode, setCopiedCode]     = useState<string | null>(null);
  const [copyError,  setCopyError]      = useState<string | null>(null);
  const [, startTransition]             = useTransition();

  // Sort
  const [sortField, setSortField] = useState<SortField>("first_name");
  const [sortDir,   setSortDir]   = useState<SortDir>("asc");

  // Role change
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);
  const [roleErrors, setRoleErrors]         = useState<Record<string, string>>({});

  // Status change
  const [confirmDialog, setConfirmDialog]       = useState<ConfirmDialog | null>(null);
  const [statusChangingId, setStatusChangingId] = useState<string | null>(null);

  // How many active admins are in this member list?
  // Derived from the original prop — not sortedMembers — so the count is
  // stable and the last-admin guard is never affected by sort order.
  const activeAdminCount = members.filter(
    (m) => m.role === "admin" && m.status === "active"
  ).length;

  // Sorted view of members — never mutates the prop.
  const sortedMembers = useMemo(() => {
    const sorted = [...members].sort((a, b) => {
      let result = 0;
      switch (sortField) {
        case "first_name":
          result = cmp(a.first_name, b.first_name);
          break;
        case "last_name":
          result = cmp(a.last_name, b.last_name);
          break;
        case "role":
          result = (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99);
          break;
        case "status":
          result = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
          break;
      }
      return sortDir === "asc" ? result : -result;
    });
    return sorted;
  }, [members, sortField, sortDir]);

  function handleSortChip(field: SortField) {
    if (field === sortField) {
      // Toggle direction on the active field.
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

  return (
    <>
      {/* Invite button row */}
      <div className="mx-4 pt-4 pb-2 flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Members
        </p>
        <button
          onClick={() => setSheetOpen(true)}
          className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        >
          + Invite
        </button>
      </div>

      {/* Sort controls */}
      {!membersError && members.length > 1 && (
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
      ) : !members || members.length === 0 ? (
        <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">
          No members yet.
        </div>
      ) : (
        <div className="pb-2">
          {sortedMembers.map((m) => {
            const fullName =
              [m.first_name, m.last_name].filter(Boolean).join(" ") || "Unnamed member";
            const isActive    = m.status === "active";
            const isSelf      = m.id === currentUserId;
            const isLastAdmin = m.role === "admin" && activeAdminCount <= 1;
            // Controls are disabled for own row OR if this is the last active admin.
            const controlsDisabled = isSelf || isLastAdmin;
            const roleError = roleErrors[m.id];

            return (
              <div
                key={m.id}
                className={`mx-4 mb-3 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden transition-opacity${
                  !isActive ? " opacity-60" : ""
                }`}
              >
                {/* Info section */}
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
                </div>

                {/* Action row */}
                <div className="px-4 pb-3 pt-2 border-t border-gray-100 dark:border-gray-700 flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <select
                      value={m.role}
                      disabled={controlsDisabled || changingRoleId === m.id}
                      onChange={(e) => handleRoleChange(m.id, e.target.value)}
                      className="text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-600 px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
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
                    onClick={() => openConfirmDialog(m)}
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
          })}
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
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 disabled:opacity-50"
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

      {/* Invite sheet */}
      {sheetOpen && <InviteSheet onClose={() => setSheetOpen(false)} />}
    </>
  );
}
