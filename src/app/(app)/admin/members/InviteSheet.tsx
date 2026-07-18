"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createInviteAction } from "./actions";
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

interface Props {
  onClose: () => void;
  initialEmail?: string;
}

export default function InviteSheet({ onClose, initialEmail }: Props) {
  const router = useRouter();

  const [role, setRole]                 = useState<Role>("member");
  const [email, setEmail]               = useState(initialEmail ?? "");
  const [expiryDays, setExpiryDays]     = useState(7);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [copied, setCopied]             = useState(false);

  const origin     = typeof window !== "undefined" ? window.location.origin : "";
  const inviteUrl  = generatedCode ? `${origin}/join/${generatedCode}` : "";
  const isAdmin    = role === "admin";
  const btnLabel   = isAdmin ? "Generate Admin Invite" : "Generate Link";

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  async function handleGenerate() {
    setError(null);
    const trimmedEmail = email.trim();
    if (trimmedEmail && !EMAIL_RE.test(trimmedEmail)) {
      setError("Enter a valid email address.");
      return;
    }
    setLoading(true);
    const result = await createInviteAction(role, trimmedEmail || null, expiryDays);
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
    setRole("member");
    setEmail("");
    setExpiryDays(7);
    setError(null);
    setCopied(false);
  }

  return (
    <ResponsiveSheet onClose={onClose} variant="modal">
        {/* Handle + header */}
        <div className="shrink-0 px-6 pt-5 pb-3">
          <div className="ct-handlebar mx-auto mb-4 md:hidden" />
          <div className="flex items-center justify-between pr-8">
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
        </div>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">

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
                    className="flex-1 min-w-0 rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 bg-gray-50 dark:bg-gray-700 focus:outline-none"
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

              {/* Role selector */}
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Role
                </label>
                <div className="mt-1.5 flex gap-2">
                  {ROLE_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
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

              {/* Email restriction */}
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Restrict to email{" "}
                  <span className="normal-case text-gray-400 dark:text-gray-500">
                    (optional)
                  </span>
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="member@example.com"
                  className="mt-1.5 w-full rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500"
                />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  If filled, only that email address can accept this invite.
                </p>
              </div>

              {/* Expiry selector */}
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Expires after
                </label>
                <div className="mt-1.5 flex gap-2">
                  {EXPIRY_OPTIONS.map(({ label, days }) => (
                    <button
                      key={days}
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
        </div>
    </ResponsiveSheet>
  );
}
