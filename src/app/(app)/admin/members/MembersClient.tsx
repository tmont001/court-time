"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import InviteSheet from "./InviteSheet";
import { revokeInviteAction } from "./actions";

const ROLE_LABELS: Record<string, string> = {
  member: "Member",
  pro:    "Pro",
  admin:  "Admin",
};

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

interface Props {
  members:        Member[];
  pendingInvites: PendingInvite[];
  membersError?:  string | null;
  invitesError?:  string | null;
}

export default function MembersClient({
  members,
  pendingInvites,
  membersError,
  invitesError,
}: Props) {
  const router = useRouter();
  const [sheetOpen, setSheetOpen]         = useState(false);
  const [revokeError, setRevokeError]     = useState<string | null>(null);
  const [revokingCode, setRevokingCode]   = useState<string | null>(null);
  const [copiedCode, setCopiedCode]       = useState<string | null>(null);
  const [, startTransition]               = useTransition();

  async function handleCopy(code: string) {
    const url = `${window.location.origin}/join/${code}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode((prev) => (prev === code ? null : prev)), 2000);
    } catch {
      // clipboard unavailable — silent fail
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
          {members.map((m) => {
            const fullName =
              [m.first_name, m.last_name].filter(Boolean).join(" ") ||
              "Unnamed member";
            return (
              <div
                key={m.id}
                className="mx-4 mb-3 px-4 py-3 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {fullName}
                  </p>
                  <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                    {ROLE_LABELS[m.role] ?? m.role}
                  </span>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {m.email ?? "—"}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {m.phone ?? "—"} · Joined {formatJoinDate(m.created_at)}
                </p>
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

        {/* Render pendingInvites props directly — no local state layer */}
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
                    {copiedCode === inv.code ? "Copied!" : "Copy Link"}
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

      {/* Invite sheet */}
      {sheetOpen && <InviteSheet onClose={() => setSheetOpen(false)} />}
    </>
  );
}
