"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  addRosterMemberAction,
  updateRosterMemberAction,
  addRosterMemberAndInviteAction,
} from "./actions";
import ResponsiveSheet from "@/components/ResponsiveSheet";

// ── Types ─────────────────────────────────────────────────────────────────────

type AddMode = "select" | "roster" | "invite";

// Invite mode allows member/pro only — admin invites use the single-invite
// flow in InviteSheet to emphasise the elevated access warning.
type InviteRole = "member" | "pro";
type RosterRole = "member" | "pro" | "admin";

export type EditRosterMember = {
  id:         string;
  first_name: string;
  last_name:  string;
  email:      string | null;
  phone:      string | null;
  role:       string;
  notes:      string | null;
};

interface Props {
  onClose:     () => void;
  editMember?: EditRosterMember;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AddMemberSheet({ onClose, editMember }: Props) {
  const router = useRouter();
  const isEdit = !!editMember;

  // For edit, skip mode selection and go straight to the roster form.
  const [addMode,  setAddMode]  = useState<AddMode>(isEdit ? "roster" : "select");

  // Shared form fields
  const [firstName, setFirstName] = useState(editMember?.first_name ?? "");
  const [lastName,  setLastName]  = useState(editMember?.last_name  ?? "");
  const [email,     setEmail]     = useState(editMember?.email  ?? "");
  const [phone,     setPhone]     = useState(editMember?.phone  ?? "");
  const [role,      setRole]      = useState<string>(editMember?.role ?? "member");
  const [notes,     setNotes]     = useState(editMember?.notes ?? "");

  // UI state
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Success state — one of roster name or invite code
  const [successName, setSuccessName] = useState<string | null>(null);
  const [inviteCode,  setInviteCode]  = useState<string | null>(null);
  const [copied,      setCopied]      = useState(false);

  const origin    = typeof window !== "undefined" ? window.location.origin : "";
  const inviteUrl = inviteCode ? `${origin}/join/${inviteCode}` : "";

  const inputClass =
    "mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-500 motion-safe:transition-all motion-safe:duration-150";

  // ── Validation ─────────────────────────────────────────────────────────────

  function validateEmailField(value: string, required: boolean): boolean {
    const trimmed = value.trim();
    if (!trimmed) {
      if (required) { setEmailError("Email is required."); return false; }
      setEmailError(null); return true;
    }
    if (!isValidEmail(trimmed)) { setEmailError("Enter a valid email address."); return false; }
    setEmailError(null); return true;
  }

  // ── Handlers ───────────────────────────────────────────────────────────────

  async function handleSubmitRoster() {
    if (!validateEmailField(email, false)) return;
    setError(null); setLoading(true);

    if (isEdit) {
      const result = await updateRosterMemberAction(
        editMember!.id, firstName, lastName,
        email || null, phone || null, role, notes || null
      );
      setLoading(false);
      if (result.error) { setError(result.error); return; }
      router.refresh(); onClose();
    } else {
      const result = await addRosterMemberAction(
        firstName, lastName, email || null, phone || null, role, notes || null
      );
      setLoading(false);
      if (result.error) { setError(result.error); return; }
      setSuccessName([firstName.trim(), lastName.trim()].filter(Boolean).join(" "));
    }
  }

  async function handleSubmitInvite() {
    if (!validateEmailField(email, true)) return;
    setError(null); setLoading(true);

    const result = await addRosterMemberAndInviteAction({
      firstName,
      lastName,
      email:     email.trim(),
      role:      role as InviteRole,
      phone:     phone || null,
      notes:     notes || null,
    });
    setLoading(false);
    if (result.error) { setError(result.error); return; }
    setSuccessName([firstName.trim(), lastName.trim()].filter(Boolean).join(" "));
    setInviteCode(result.code ?? null);
  }

  async function handleCopyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* noop */ }
  }

  function handleAddAnother() {
    setFirstName(""); setLastName(""); setEmail(""); setPhone("");
    setRole("member"); setNotes(""); setError(null); setEmailError(null);
    setSuccessName(null); setInviteCode(null); setCopied(false);
    if (!isEdit) setAddMode("select");
  }

  function selectMode(m: "roster" | "invite") {
    setRole("member");
    setError(null); setEmailError(null);
    setAddMode(m);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  // ── Header title ──
  let title = "Add Member";
  if (isEdit)                                   title = "Edit Member";
  else if (addMode === "invite" && inviteCode)   title = "Invite Link Ready";
  else if (addMode === "invite")                 title = "Add and Invite";
  else if (successName)                          title = "Member Added";

  return (
    <ResponsiveSheet
      onClose={onClose}
      variant="modal"
      mobileInteraction="draggable"
      label={title}
      header={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {addMode !== "select" && !isEdit && !successName && !inviteCode && (
              <button
                onClick={() => { setError(null); setEmailError(null); setAddMode("select"); }}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                ←
              </button>
            )}
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</p>
          </div>
          <button onClick={onClose} className="text-sm text-gray-500 dark:text-gray-400 md:hidden">
            Close
          </button>
        </div>
      }
    >
        {/* ── Mode selector ── */}
        {addMode === "select" && (
          <div className="space-y-4 pt-2">
            <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
              Choose how to add this member.
            </p>
            <button
              onClick={() => selectMode("roster")}
              className="w-full text-left rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-4 hover:border-accent hover:bg-gray-50 dark:hover:bg-gray-700/30 motion-safe:transition-all motion-safe:duration-150"
            >
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Add to roster only</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                Add the member to the roster. Email is optional. No invite link is created.
              </p>
            </button>
            <button
              onClick={() => selectMode("invite")}
              className="w-full text-left rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-4 hover:border-accent hover:bg-gray-50 dark:hover:bg-gray-700/30 motion-safe:transition-all motion-safe:duration-150"
            >
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Add and generate invite</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                Add the member and create a 7-day invite link. Email is required. Copy and share the link manually — Court Time does not send it.
              </p>
            </button>
          </div>
        )}

        {/* ── Roster-only success ── */}
        {successName && !inviteCode && (
          <div className="space-y-4 pt-2">
            <div className="rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 px-4 py-4">
              <p className="text-sm font-medium text-green-800 dark:text-green-300">
                Added {successName} to the roster.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleAddAnother}
                className="flex-1 py-3 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150"
              >
                Add Another
              </button>
              <button onClick={() => { router.refresh(); onClose(); }} className="ct-button-neutral flex-1 py-3 text-sm font-semibold">
                Done
              </button>
            </div>
          </div>
        )}

        {/* ── Invite success ── */}
        {inviteCode && (
          <div className="space-y-4 pt-2">
            <div className="rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 px-4 py-4">
              <p className="text-sm font-medium text-green-800 dark:text-green-300">
                {successName} added to the roster. Invite link ready — valid for 7 days.
              </p>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Invite link
              </label>
              <div className="mt-1.5 flex gap-2">
                <input
                  readOnly
                  value={inviteUrl}
                  onFocus={e => e.target.select()}
                  className="flex-1 min-w-0 rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-3 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-gray-50 dark:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
                <button
                  onClick={handleCopyInvite}
                  className="ct-button-neutral shrink-0 px-4 py-3 text-sm font-medium"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">
                Court Time did not send an email. Copy and share this link manually.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleAddAnother}
                className="flex-1 py-3 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-all motion-safe:duration-150"
              >
                Add Another
              </button>
              <button onClick={() => { router.refresh(); onClose(); }} className="ct-button-neutral flex-1 py-3 text-sm font-semibold">
                Done
              </button>
            </div>
          </div>
        )}

        {/* ── Roster form ── */}
        {(addMode === "roster") && !successName && (
          <div className="space-y-5 pt-2">
            {!isEdit && (
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                Add someone to the club roster. They do not need an online account yet.
              </p>
            )}

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                First name
              </label>
              <input
                type="text"
                autoComplete="given-name"
                value={firstName}
                onChange={e => setFirstName(e.target.value)}
                placeholder="First name"
                className={inputClass}
                autoFocus
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Last name
              </label>
              <input
                type="text"
                autoComplete="family-name"
                value={lastName}
                onChange={e => setLastName(e.target.value)}
                placeholder="Last name"
                className={inputClass}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Email{" "}
                <span className="normal-case text-gray-400 dark:text-gray-500">(optional)</span>
              </label>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={e => { setEmail(e.target.value); setEmailError(null); }}
                onBlur={() => validateEmailField(email, false)}
                placeholder="member@example.com"
                className={inputClass}
              />
              {emailError && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">{emailError}</p>
              )}
              {!emailError && (
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  Optional — you can add this later if they want to sign in.
                </p>
              )}
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Phone{" "}
                <span className="normal-case text-gray-400 dark:text-gray-500">(optional)</span>
              </label>
              <input
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="555-0100"
                className={inputClass}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Role
              </label>
              <div className="mt-1.5 flex gap-2" role="radiogroup" aria-label="Role">
                {(["member", "pro", "admin"] as RosterRole[]).map(r => (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={role === r}
                    onClick={() => setRole(r)}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                      role === r
                        ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 border-gray-900 dark:border-gray-100"
                        : "bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600"
                    }`}
                  >
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                For your reference. App access requires signing up.
              </p>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Notes{" "}
                <span className="normal-case text-gray-400 dark:text-gray-500">(optional)</span>
              </label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Tennis level 3.5"
                className={inputClass}
              />
            </div>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

            <button
              onClick={handleSubmitRoster}
              disabled={loading}
              className="ct-button-neutral w-full py-3 text-sm font-semibold"
            >
              {loading
                ? isEdit ? "Saving…" : "Adding…"
                : isEdit ? "Save Changes" : "Add Member"}
            </button>
          </div>
        )}

        {/* ── Invite form ── */}
        {addMode === "invite" && !inviteCode && (
          <div className="space-y-5 pt-2">
            <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
              A 7-day invite link will be generated for this email. Copy and share it manually — Court Time will not send it.
            </p>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                First name
              </label>
              <input
                type="text"
                autoComplete="given-name"
                value={firstName}
                onChange={e => setFirstName(e.target.value)}
                placeholder="First name"
                className={inputClass}
                autoFocus
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Last name
              </label>
              <input
                type="text"
                autoComplete="family-name"
                value={lastName}
                onChange={e => setLastName(e.target.value)}
                placeholder="Last name"
                className={inputClass}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Email
              </label>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={e => { setEmail(e.target.value); setEmailError(null); }}
                onBlur={() => validateEmailField(email, true)}
                placeholder="member@example.com"
                className={inputClass}
              />
              {emailError && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">{emailError}</p>
              )}
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Phone{" "}
                <span className="normal-case text-gray-400 dark:text-gray-500">(optional)</span>
              </label>
              <input
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="555-0100"
                className={inputClass}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Role
              </label>
              <div className="mt-1.5 flex gap-2" role="radiogroup" aria-label="Role">
                {(["member", "pro"] as InviteRole[]).map(r => (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={role === r}
                    onClick={() => setRole(r)}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                      role === r
                        ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 border-gray-900 dark:border-gray-100"
                        : "bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600"
                    }`}
                  >
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Notes{" "}
                <span className="normal-case text-gray-400 dark:text-gray-500">(optional)</span>
              </label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Tennis level 3.5"
                className={inputClass}
              />
            </div>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

            <button
              onClick={handleSubmitInvite}
              disabled={loading}
              className="ct-button-neutral w-full py-3 text-sm font-semibold"
            >
              {loading ? "Generating…" : "Add and Generate Invite"}
            </button>
          </div>
        )}

    </ResponsiveSheet>
  );
}
