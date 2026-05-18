"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import NotificationSheet from "@/components/NotificationSheet";

export default function NotificationBell() {
  const supabase = useMemo(() => createClient(), []);
  const [count, setCount] = useState(0);
  const [open,  setOpen]  = useState(false);

  const fetchCount = useCallback(async () => {
    const { count: n } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("is_read", false);
    setCount(n ?? 0);
  }, [supabase]);

  useEffect(() => { fetchCount(); }, [fetchCount]);

  const badge = count > 9 ? "9+" : count > 0 ? String(count) : null;

  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Notifications"
        className="w-8 h-8 flex items-center justify-center text-gray-500"
      >
        <span className="relative">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>

          {badge !== null && (
            <span className="absolute -top-1 -right-1.5 flex items-center justify-center min-w-[16px] h-4 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none px-0.5 select-none">
              {badge}
            </span>
          )}
        </span>
      </button>

      {open && (
        <NotificationSheet
          onClose={() => setOpen(false)}
          onRead={fetchCount}
        />
      )}
    </>
  );
}
