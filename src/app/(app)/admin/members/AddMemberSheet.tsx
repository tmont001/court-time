"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addRosterMemberAction, updateRosterMemberAction } from "./actions";
import ResponsiveSheet from "@/components/ResponsiveSheet";

type Role = "member" | "pro" | "admin";

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "pro",    label: "Pro"    },
  { value: "admin",  label: "Admin"  },
];

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
  onClose: () => void;
  editMember?: EditRosterMember;
}

export default function AddMemberSheet({ onClose, editMember }: Props) {
  const router = useRouter();
  const isEdit = !!editMember;

  const [firstName, setFirstName] = useState(editMember?.first_name ?? "");
  const [lastName, setLastName]   = useState(editMember?.last_name ?? "");
  const [email, setEmail]         = useState(editMember?.email ?? "");
  const [phone, setPhone]         = useState(editMember?.phone ?? "");
  const [role, setRole]           = useState<Role>((editMember?.role as Role) ?? "member");
  const [notes, setNotes]         = useState(editMember?.notes ?? "");
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [successName, setSuccessName] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    setLoading(true);

    if (isEdit) {
      const result = await updateRosterMemberAction(
        editMember!.id, firstName, lastName,
        email || null, phone || null, role, notes || null
      );
      setLoading(false);
      if (result.error) { setError(result.error); return; }
      router.refresh();
      onClose();
    } else {
      const result = await addRosterMemberAction(
        firstName, lastName,
        email || null, phone || null, role, notes || null
      );
      setLoading(false);
      if (result.error) { setError(result.error); return; }
      setSuccessName([firstName.trim(), lastName.trim()].filter(Boolean).join(" "));
    }
  }

  function handleAddAnother() {
    setFirstName("");
    setLastName("");
    setEmail("");
    setPhone("");
    setRole("member");
    setNotes("");
    setError(null);
    setSuccessName(null);
  }

  const inputClass =
    "mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-500 motion-safe:transition-all motion-safe:duration-150";

  return (
    <ResponsiveSheet onClose={onClose} variant="modal">
        {/* Handle + header */}
        <div className="shrink-0 px-6 pt-5 pb-3">
          <div className="ct-handlebar mx-auto mb-4 md:hidden" />
          <div className="flex items-center justify-between pr-8">
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {successName ? "Member Added" : isEdit ? "Edit Member" : "Add Member"}
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
          {successName ? (
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
                <button
                  onClick={onClose}
                  className="ct-button-neutral flex-1 py-3 text-sm font-semibold"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-5 pt-2">
              {!isEdit && (
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                  Add someone to the club roster. They do not need an online account yet.
                </p>
              )}

              {/* First name */}
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  First name
                </label>
                <input
                  type="text"
                  value={firstName}
                  onChange={e => setFirstName(e.target.value)}
                  placeholder="First name"
                  className={inputClass}
                  autoFocus
                />
              </div>

              {/* Last name */}
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Last name
                </label>
                <input
                  type="text"
                  value={lastName}
                  onChange={e => setLastName(e.target.value)}
                  placeholder="Last name"
                  className={inputClass}
                />
              </div>

              {/* Email */}
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Email{" "}
                  <span className="normal-case text-gray-400 dark:text-gray-500">(optional)</span>
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="member@example.com"
                  className={inputClass}
                />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  Optional — you can add this later if they want to sign in.
                </p>
              </div>

              {/* Phone */}
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Phone{" "}
                  <span className="normal-case text-gray-400 dark:text-gray-500">(optional)</span>
                </label>
                <input
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="555-0100"
                  className={inputClass}
                />
              </div>

              {/* Role */}
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Role
                </label>
                <div className="mt-1.5 flex gap-2">
                  {ROLE_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
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
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  For your reference. App access requires signing up.
                </p>
              </div>

              {/* Notes */}
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

              {error && (
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              )}

              <button
                onClick={handleSubmit}
                disabled={loading}
                className="ct-button-neutral w-full py-3 text-sm font-semibold"
              >
                {loading
                  ? isEdit ? "Saving…" : "Adding…"
                  : isEdit ? "Save Changes" : "Add Member"}
              </button>
            </div>
          )}
        </div>
    </ResponsiveSheet>
  );
}
