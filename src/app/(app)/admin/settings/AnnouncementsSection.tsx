"use client";

import { useState, useTransition } from "react";
import { sendAnnouncementAction } from "./actions";

const TITLE_MAX = 100;
const BODY_MAX  = 500;

export default function AnnouncementsSection() {
  const [isPending, startTransition] = useTransition();

  const [title, setTitle]           = useState("");
  const [body,  setBody]            = useState("");
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus]         = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus(null);
    setConfirming(true);
  }

  function handleConfirm() {
    setConfirming(false);
    const formData = new FormData();
    formData.set("title", title);
    formData.set("body",  body);

    startTransition(async () => {
      const result = await sendAnnouncementAction(formData);
      if (result.error) {
        setStatus({ type: "error", message: result.error });
      } else {
        setStatus({ type: "success", message: result.message ?? "Announcement sent." });
        setTitle("");
        setBody("");
        setTimeout(() => setStatus(null), 5000);
      }
    });
  }

  function handleCancel() {
    setConfirming(false);
  }

  const titleOver = title.length > TITLE_MAX;
  const bodyOver  = body.length  > BODY_MAX;
  const canSubmit = title.trim().length > 0 && body.trim().length > 0 && !titleOver && !bodyOver;

  return (
    <div className="space-y-3">
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Subject */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
              Subject
            </label>
            <span className={`text-xs ${titleOver ? "text-red-500" : "text-gray-400 dark:text-gray-500"}`}>
              {title.length}/{TITLE_MAX}
            </span>
          </div>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Court closure this Saturday"
            maxLength={TITLE_MAX + 10}
            required
            disabled={isPending}
            className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 disabled:opacity-40"
          />
        </div>

        {/* Message */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
              Message
            </label>
            <span className={`text-xs ${bodyOver ? "text-red-500" : "text-gray-400 dark:text-gray-500"}`}>
              {body.length}/{BODY_MAX}
            </span>
          </div>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Write your message to members here…"
            rows={4}
            maxLength={BODY_MAX + 10}
            required
            disabled={isPending}
            className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 resize-none disabled:opacity-40"
          />
        </div>

        {/* Confirm step */}
        {confirming ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2.5 space-y-2">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
              Send this announcement to all active members?
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleConfirm}
                disabled={isPending}
                className="px-3 py-1.5 rounded-lg bg-accent text-white dark:text-gray-900 text-xs font-medium disabled:opacity-40"
              >
                {isPending ? "Sending…" : "Yes, send it"}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={isPending}
                className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-600 dark:text-gray-300 disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={isPending || !canSubmit}
              className="px-4 py-2 rounded-lg bg-accent text-white dark:text-gray-900 text-sm font-medium disabled:opacity-40"
            >
              {isPending ? "Sending…" : "Send Announcement"}
            </button>
            {status && (
              <p className={`text-xs font-medium ${
                status.type === "success" ? "text-green-600" : "text-red-500"
              }`}>
                {status.message}
              </p>
            )}
          </div>
        )}
      </form>

      {/* Show status below confirm step too */}
      {confirming && status && (
        <p className={`text-xs font-medium ${
          status.type === "success" ? "text-green-600" : "text-red-500"
        }`}>
          {status.message}
        </p>
      )}
    </div>
  );
}
