"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createRosterInviteAction } from "./actions";
import ResponsiveSheet from "@/components/ResponsiveSheet";

type Role = "member" | "pro" | "admin";

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "pro",    label: "Pro"    },
  { value: "admin",  label: "Admin"  },
];

const EXPIRY_OPTIONS = [
  { label: "1 day",   days: 1  },
  { label: "7 days",  days: 7  },
  { label: "30 days", days: 30 },
];

// Phase 33B1: this sheet only ever opens for an EXISTING roster identity —
// its one trigger site is the "Send Invite" button on a roster member row
// (MembersClient.tsx). The email is no longer a free-form field: an invite
// is always bound to this specific roster_member_id, matching create_club_
// invite's roster-first requirement. See 0107's migration header,
// "ROSTER-FIRST INVITATIONS", for why this was narrowed rather than removed.
export interface InviteRosterMember {
  id:         string;
  firstName:  string;
  lastName:   string;
  email:      string; // guaranteed non-null — the "Send Invite" button only
                       // renders for roster rows that already have one.
  role:       string;
}

interface Props {
  onClose:      () => void;
  rosterMember: InviteRosterMember;
}

export default function InviteSheet({ onClose, rosterMember }: Props) {
  const router = useRouter();

  const initialRole: Role =
    rosterMember.role === "pro" || rosterMember.role === "admin" ? rosterMember.role : "member";

  const [role, setRole]                   = useState<Role>(initialRole);
  const [expiryDays, setExpiryDays]       = useState(7);
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [copied, setCopied]               = useState(false);

  const origin     = typeof window !== "undefined" ? window.location.origin : "";
  const inviteUrl  = generatedCode ? `${origin}/join/${generatedCode}` : "";
  const isAdmin    = role === "admin";
  const btnLabel   = isAdmin ? "Generate Admin Invite" : "Generate Link";
  const fullName   = [rosterMember.firstName, rosterMember.lastName].filter(Boolean).join(" ");

  async function handleGenerate() {
    setError(null);
    setLoading(true);
    const result = await createRosterInviteAction(rosterMember.id, role, expiryDays);
    setLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.code) {
      setGeneratedCode(result.code);
      router.refresh(); // update pending invites list
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — user can still select the field manually
    }
  }

  function handleGenerateAnother() {
    setGeneratedCode(null);
    setRole(initialRole);
    setExpiryDays(7);
    setError(null);
    setCopied(false);
  }

  return (
    <ResponsiveSheet
      onClose={onClose}
      variant="modal"
      mobileInteraction="draggable"
      label={generatedCode ? "Invite Link Ready" : "Send Invite"}
      header={
        <div className="flex items-center justify-between">
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {generatedCode ? "Invite Link Ready" : "Send Invite"}
          </p>
          {/* Close — mobile only; desktop uses ResponsiveSheet × button */}
          <button
            onClick={onClose}
            className="text-sm text-gray-500 dark:text-gray-400 md:hidden"
          >
            Close
          </button>
        </div>
      }
    >
          {generatedCode ? (
            /* ── Success: display link ── */
            <div className="space-y-4 pt-2">
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Shareable link
                </label>
                <div className="mt-1.5 flex gap-2">
                  <input
                    readOnly
                    value={inviteUrl}
                    onFocus={(e) => e.target.select()}
                    className="flex-1 min-w-0 rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-3 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-gray-50 dark:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  />
                  <button
                    onClick={handleCopy}
                    className="ct-button-neutral shrink-0 px-4 py-3 text-sm font-medium"
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>

              <p className="text-xs text-gray-500 dark:text-gray-400">
                This link expires in {expiryDays} day{expiryDays !== 1 ? "s" : ""}.
                Share it directly — do not post it publicly.
              </p>

              <button
                onClick={handleGenerateAnother}
                className="w-full py-3 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Generate Another
              </button>
            </div>
          ) : (
            /* ── Form ── */
            <div className="space-y-5 pt-2">

              {/* Who this invite is for — read-only, roster-bound */}
              <div className="rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-3">
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Inviting
                </label>
                <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">{fullName}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{rosterMember.email}</p>
              </div>

              {/* Role selector */}
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Role
                </label>
                <div className="mt-1.5 flex gap-2" role="radiogroup" aria-label="Role">
                  {ROLE_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      role="radio"
                      aria-checked={role === value}
                      onClick={() => setRole(value)}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                        role === value
                          ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 border-gray-900 dark:border-gray-100"
                          : "bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Admin warning */}
              {isAdmin && (
                <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-4 py-3">
                  <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 mb-1">
                    Admin access
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                    Admin access grants full club control — members, courts, settings,
                    branding, booking rules, and the ability to send invites. Only share
                    this link with someone you fully trust to manage your club.
                  </p>
                </div>
              )}

              {/* Expiry selector */}
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Expires after
                </label>
                <div className="mt-1.5 flex gap-2" role="radiogroup" aria-label="Expires after">
                  {EXPIRY_OPTIONS.map(({ label, days }) => (
                    <button
                      key={days}
                      role="radio"
                      aria-checked={expiryDays === days}
                      onClick={() => setExpiryDays(days)}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                        expiryDays === days
                          ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 border-gray-900 dark:border-gray-100"
                          : "bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {error && (
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              )}

              {/* Generate button — amber for admin, dark for member/pro */}
              <button
                onClick={handleGenerate}
                disabled={loading}
                className={`w-full py-3 text-sm font-semibold disabled:opacity-50 ${
                  isAdmin
                    ? "rounded-xl bg-amber-600 dark:bg-amber-500 text-white"
                    : "ct-button-neutral"
                }`}
              >
                {loading ? "Generating…" : btnLabel}
              </button>

            </div>
          )}
    </ResponsiveSheet>
  );
}
