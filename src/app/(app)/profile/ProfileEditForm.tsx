"use client";

import { useState, useTransition } from "react";
import { updateProfile, updateSmsPreference } from "./actions";

interface Props {
  firstName: string | null;
  lastName:  string | null;
  phone:     string | null;
  smsOptIn:  boolean;
}

export default function ProfileEditForm({ firstName, lastName, phone, smsOptIn }: Props) {
  const [isPending,    startTransition]    = useTransition();
  const [smsPending,   startSmsTransition] = useTransition();
  const [saved,        setSaved]           = useState(false);
  const [saveError,    setSaveError]       = useState<string | null>(null);
  const [smsChecked,   setSmsChecked]      = useState(smsOptIn);
  const [smsSaved,     setSmsSaved]        = useState(false);
  const [smsError,     setSmsError]        = useState<string | null>(null);
  // Track the current phone value so the no-phone guard can read it client-side
  const [currentPhone, setCurrentPhone]    = useState(phone ?? "");

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setSaveError(null);
    startTransition(async () => {
      const result = await updateProfile(formData);
      if (result?.error) {
        setSaveError(result.error);
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    });
  }

  function handleSmsChange(e: React.ChangeEvent<HTMLInputElement>) {
    const nextChecked = e.target.checked;
    setSmsError(null);

    // Client-side guard: block opt-in if the phone field is currently empty.
    // The server action performs the authoritative check.
    if (nextChecked && currentPhone.replace(/\D/g, "").length === 0) {
      setSmsError("Add a phone number first.");
      return;
    }

    setSmsChecked(nextChecked);
    startSmsTransition(async () => {
      const result = await updateSmsPreference(nextChecked);
      if (result?.error) {
        setSmsError(result.error);
        setSmsChecked(!nextChecked); // revert on error
      } else {
        setSmsSaved(true);
        setTimeout(() => setSmsSaved(false), 2000);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">
          First name
        </label>
        <input
          type="text"
          name="first_name"
          defaultValue={firstName ?? ""}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">
          Last name
        </label>
        <input
          type="text"
          name="last_name"
          defaultValue={lastName ?? ""}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">
          Phone
        </label>
        <input
          type="tel"
          name="phone"
          value={currentPhone}
          onChange={(e) => setCurrentPhone(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-medium disabled:opacity-40"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        {saved && (
          <p className="text-xs font-medium text-green-600">Saved</p>
        )}
        {saveError && (
          <p className="text-xs font-medium text-red-500">{saveError}</p>
        )}
      </div>

      <hr className="border-gray-100" />

      <div className="space-y-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Text notifications
        </p>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={smsChecked}
            onChange={handleSmsChange}
            disabled={smsPending}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-400 disabled:opacity-40"
          />
          <span className="text-sm text-gray-700 leading-snug">
            Text me when my reservation is cancelled, an event I&apos;m in is cancelled,
            or I&apos;m moved off the waitlist.
          </span>
        </label>
        <p className="text-xs text-gray-400 pl-7">
          Standard message rates apply. Reply STOP at any time to unsubscribe.
        </p>
        {smsSaved && (
          <p className="text-xs font-medium text-green-600 pl-7">Updated</p>
        )}
        {smsError && (
          <p className="text-xs font-medium text-red-500 pl-7">{smsError}</p>
        )}
      </div>
    </form>
  );
}
