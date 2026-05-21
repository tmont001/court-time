"use client";

import { useState, useTransition } from "react";
import { updateClubName } from "./actions";
import ClubLogoUpload from "./ClubLogoUpload";
import ThemePicker from "./ThemePicker";

interface Props {
  clubName:  string;
  logoUrl:   string | null;
  themeKey:  string;
}

export default function ClubBrandingSection({ clubName, logoUrl, themeKey }: Props) {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setStatus(null);
    startTransition(async () => {
      const result = await updateClubName(formData);
      if (result.error) {
        setStatus({ type: "error", message: result.error });
      } else {
        setStatus({ type: "success", message: "Saved" });
        setTimeout(() => setStatus(null), 2000);
      }
    });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Club name
          </label>
          <input
            type="text"
            name="club_name"
            defaultValue={clubName}
            required
            maxLength={100}
            className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
          />
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Shown in the app header for all members.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={isPending}
            className="px-4 py-2 rounded-lg bg-accent text-white dark:text-gray-900 text-sm font-medium disabled:opacity-40"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
          {status && (
            <p className={`text-xs font-medium ${
              status.type === "success" ? "text-green-600" : "text-red-500"
            }`}>
              {status.message}
            </p>
          )}
        </div>
      </form>

      <div>
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Club logo</p>
        <ClubLogoUpload
          currentLogoUrl={logoUrl}
          clubInitial={(clubName || "C").charAt(0).toUpperCase()}
        />
      </div>

      <div>
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Color theme</p>
        <ThemePicker currentTheme={themeKey} />
      </div>
    </div>
  );
}
