"use client";

import { useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";

export default function ChangePasswordForm() {
  const [isPending,       startTransition] = useTransition();
  const [saved,           setSaved]        = useState(false);
  const [saveError,       setSaveError]    = useState<string | null>(null);
  const [newPassword,     setNewPassword]  = useState("");
  const [confirmPassword, setConfirm]      = useState("");

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaveError(null);
    setSaved(false);

    if (!newPassword || !confirmPassword) {
      setSaveError("Please fill in both fields.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setSaveError("Passwords do not match.");
      return;
    }
    if (newPassword.length < 8) {
      setSaveError("Password must be at least 8 characters.");
      return;
    }

    startTransition(async () => {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        setSaveError(error.message);
      } else {
        setSaved(true);
        setNewPassword("");
        setConfirm("");
        setTimeout(() => setSaved(false), 3000);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          New password
        </label>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          minLength={8}
          autoComplete="new-password"
          className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Confirm new password
        </label>
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirm(e.target.value)}
          minLength={8}
          autoComplete="new-password"
          className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 rounded-lg bg-accent text-white dark:text-gray-900 text-sm font-medium disabled:opacity-40"
        >
          {isPending ? "Saving…" : "Save password"}
        </button>
        {saved && (
          <p className="text-xs font-medium text-green-600">Password updated.</p>
        )}
        {saveError && (
          <p className="text-xs font-medium text-red-500">{saveError}</p>
        )}
      </div>
    </form>
  );
}
