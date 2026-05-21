"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { uploadClubLogo, deleteClubLogo } from "./actions";

interface Props {
  currentLogoUrl: string | null;
  clubInitial: string;
}

const MAX_BYTES   = 2 * 1024 * 1024;
const ALLOWED     = ["image/jpeg", "image/png", "image/webp"];

export default function ClubLogoUpload({ currentLogoUrl, clubInitial }: Props) {
  const router        = useRouter();
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [pendingAction, setPendingAction] = useState<"upload" | "delete" | null>(null);
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so same file can be re-selected after an error
    if (!file) return;

    if (!ALLOWED.includes(file.type)) {
      setStatus({ type: "error", message: "Only JPEG, PNG, and WebP images are allowed." });
      return;
    }
    if (file.size > MAX_BYTES) {
      setStatus({ type: "error", message: "File must be 2 MB or smaller." });
      return;
    }

    const formData = new FormData();
    formData.append("logo", file);
    setStatus(null);
    setPendingAction("upload");
    startTransition(async () => {
      const result = await uploadClubLogo(formData);
      setPendingAction(null);
      if (result.error) {
        setStatus({ type: "error", message: result.error });
      } else {
        setStatus({ type: "success", message: "Logo saved." });
        router.refresh();
        setTimeout(() => setStatus(null), 2500);
      }
    });
  }

  function handleDelete() {
    setStatus(null);
    setPendingAction("delete");
    startTransition(async () => {
      const result = await deleteClubLogo();
      setPendingAction(null);
      if (result.error) {
        setStatus({ type: "error", message: result.error });
      } else {
        setStatus({ type: "success", message: "Logo removed." });
        router.refresh();
        setTimeout(() => setStatus(null), 2500);
      }
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        {/* Preview */}
        {currentLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={currentLogoUrl}
            width={56}
            height={56}
            alt="Club logo"
            className="rounded-lg object-contain border border-gray-200 dark:border-gray-700 flex-shrink-0"
          />
        ) : (
          <div className="w-14 h-14 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center text-lg font-semibold text-gray-500 dark:text-gray-400 flex-shrink-0">
            {clubInitial}
          </div>
        )}

        {/* Actions */}
        <div className="space-y-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isPending}
            className="px-3 py-1.5 rounded-lg bg-accent text-white dark:text-gray-900 text-xs font-medium disabled:opacity-40"
          >
            {pendingAction === "upload" ? "Uploading…" : "Upload logo"}
          </button>
          {currentLogoUrl && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={isPending}
              className="px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-800 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40"
            >
              {pendingAction === "delete" ? "Removing…" : "Remove logo"}
            </button>
          )}
          <p className="text-[10px] text-gray-400 dark:text-gray-500">
            JPEG, PNG, or WebP · max 2 MB
          </p>
        </div>
      </div>

      {status && (
        <p className={`text-xs font-medium ${
          status.type === "success"
            ? "text-green-600 dark:text-green-400"
            : "text-red-500 dark:text-red-400"
        }`}>
          {status.message}
        </p>
      )}
    </div>
  );
}
