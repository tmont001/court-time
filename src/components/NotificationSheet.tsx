"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import BottomSheet from "@/components/BottomSheet";
import type { Json } from "@/lib/db/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface NotificationRow {
  id:         string;
  kind:       string;
  body:       string;
  is_read:    boolean;
  metadata:   Json | null;
  created_at: string;
}

interface Props {
  onClose: () => void;
  onRead:  () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins   = Math.floor(diffMs / 60_000);
  if (mins < 1)   return "Just now";
  if (mins < 60)  return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function NotificationSheet({ onClose, onRead }: Props) {
  const supabase = useMemo(() => createClient(), []);

  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [loading, setLoading]             = useState(true);

  // Lazy init from window so there is no mobile→desktop flicker on mount.
  // This component only mounts after a user click so window is always defined.
  const [isDesktop, setIsDesktop] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from("notifications")
        .select("id, kind, body, is_read, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(20);
      setNotifications(data ?? []);
      setLoading(false);
    }
    load();
  }, [supabase]);

  const hasUnread = notifications.some(n => !n.is_read);

  async function handleMarkRead(id: string) {
    setNotifications(prev =>
      prev.map(n => n.id === id ? { ...n, is_read: true } : n)
    );
    await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("id", id);
    onRead();
  }

  async function handleMarkAllRead() {
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("is_read", false);
    onRead();
  }

  // ── Shared notification list ───────────────────────────────────────────────

  const listContent = loading ? (
    <p className="text-center text-sm text-gray-400 py-8">Loading…</p>
  ) : notifications.length === 0 ? (
    <p className="text-center text-sm text-gray-400 py-8">
      You&apos;re all caught up.
    </p>
  ) : (
    <>{notifications.map(n => {
      const isAnnouncement    = n.kind === "announcement";
      const announcementTitle = isAnnouncement
        ? ((n.metadata as Record<string, string> | null)?.title ?? null)
        : null;

      return (
        <div
          key={n.id}
          onClick={!n.is_read ? () => handleMarkRead(n.id) : undefined}
          className={`flex items-start gap-3 py-3 border-b border-gray-100 dark:border-gray-700 last:border-b-0 rounded-lg -mx-2 px-2 ${
            !n.is_read
              ? "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 motion-safe:transition-colors motion-safe:duration-100"
              : ""
          }`}
        >
          {/* Unread dot — amber for announcements, blue for all others */}
          <span
            className={`mt-1.5 shrink-0 w-2 h-2 rounded-full ${
              !n.is_read
                ? isAnnouncement ? "bg-amber-400" : "bg-blue-500"
                : "bg-transparent"
            }`}
          />
          <div className="flex-1 min-w-0">
            {announcementTitle && (
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-0.5 truncate">
                📢 {announcementTitle}
              </p>
            )}
            <p className="text-sm text-gray-800 dark:text-gray-200 leading-snug">{n.body}</p>
          </div>
          <p className="shrink-0 text-xs text-gray-400 mt-0.5 ml-2">
            {relativeTime(n.created_at)}
          </p>
        </div>
      );
    })}</>
  );

  // ── Desktop: anchored dropdown below the bell ─────────────────────────────
  // Positioned fixed top-14 (below the sticky header) right-4. z-50 puts it
  // above the sidebar (z-40). The transparent backdrop captures click-away.

  if (isDesktop) {
    return (
      <>
        {/* Transparent backdrop — click anywhere to close */}
        <div className="fixed inset-0 z-40" onClick={onClose} />

        <div
          className="ct-popover-enter fixed top-14 right-4 z-50 w-96 max-w-[calc(100vw-5rem)] bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden"
          style={{ maxHeight: "min(60vh, 480px)" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Title row */}
          <div className="px-5 pt-4 pb-3 border-b border-gray-100 dark:border-gray-700 shrink-0 flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Notifications</p>
            {hasUnread && (
              <button
                onClick={handleMarkAllRead}
                className="text-xs text-blue-600 dark:text-blue-400 font-medium hover:text-blue-800 dark:hover:text-blue-300 motion-safe:transition-colors motion-safe:duration-100"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* Scrollable list */}
          <div className="overflow-y-auto flex-1 px-5 pb-2">
            {listContent}
          </div>
        </div>
      </>
    );
  }

  // ── Mobile: bottom sheet with drag handle ─────────────────────────────────

  return (
    <BottomSheet onClose={onClose}>
      <div className="px-6 pt-5 pb-3">
        <div className="flex items-center justify-between">
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Notifications</p>
          {hasUnread && (
            <button
              onClick={handleMarkAllRead}
              className="text-xs text-blue-600 dark:text-blue-400 font-medium hover:text-blue-800 dark:hover:text-blue-300 motion-safe:transition-colors motion-safe:duration-100"
            >
              Mark all read
            </button>
          )}
        </div>
      </div>
      <div className="overflow-y-auto max-h-[55vh] pb-8 px-6">
        {listContent}
      </div>
    </BottomSheet>
  );
}
