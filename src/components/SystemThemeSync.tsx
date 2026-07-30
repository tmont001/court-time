"use client";

import { useEffect } from "react";
import { THEME_STORAGE_KEY, dispatchThemeChange } from "@/lib/theme";

// Root-mounted on every route (signed-in and signed-out — see layout.tsx).
// The blocking inline script in layout.tsx handles the initial paint (reads
// localStorage, falls back to system preference, sets the .dark class before
// first paint — no flash). This component only handles LIVE system-theme
// changes that happen while the app is already open: if the visitor never
// made an explicit Light/Dark choice, the site keeps following
// prefers-color-scheme for the rest of the session. It renders nothing.
//
// Every application of a system-driven theme is broadcast via
// dispatchThemeChange so any mounted ThemeToggle updates its icon/label
// immediately instead of drifting from the actual .dark class it doesn't
// own — see ThemeToggle.tsx's THEME_CHANGE_EVENT listener.

export default function SystemThemeSync() {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");

    function handleChange(e: MediaQueryListEvent) {
      // An explicit saved preference always wins — never overwritten here.
      if (localStorage.getItem(THEME_STORAGE_KEY) !== null) return;
      document.documentElement.classList.toggle("dark", e.matches);
      dispatchThemeChange(e.matches);
    }

    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, []);

  return null;
}
