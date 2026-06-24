"use client";

import { useState, useTransition } from "react";
import { updateProfile } from "./actions";

interface Props {
  firstName: string | null;
  lastName:  string | null;
  phone:     string | null;
}

export default function ProfileEditForm({ firstName, lastName, phone }: Props) {
  const [isPending,    startTransition] = useTransition();
  const [saved,        setSaved]        = useState(false);
  const [saveError,    setSaveError]    = useState<string | null>(null);
  const [currentPhone, setCurrentPhone] = useState(phone ?? "");

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

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          First name
        </label>
        <input
          type="text"
          name="first_name"
          defaultValue={firstName ?? ""}
          className="ct-input"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Last name
        </label>
        <input
          type="text"
          name="last_name"
          defaultValue={lastName ?? ""}
          className="ct-input"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Phone
        </label>
        <input
          type="tel"
          name="phone"
          value={currentPhone}
          onChange={(e) => setCurrentPhone(e.target.value)}
          className="ct-input"
        />
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="ct-button-primary"
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
    </form>
  );
}
