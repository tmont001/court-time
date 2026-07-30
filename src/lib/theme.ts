"use client";

// Shared client-only theme constants — kept in one place so SystemThemeSync
// and ThemeToggle can't drift out of sync on the storage key or event name.
// The blocking bootstrap script in layout.tsx is plain inline JS (it has to
// run before any module loads) and duplicates THEME_STORAGE_KEY's literal
// value by necessity — keep that string in sync with this one by hand.

export const THEME_STORAGE_KEY = "court-time-theme";

// Fired on `window` whenever the active theme changes for a reason other
// than the listening component's own direct DOM read — i.e. by
// SystemThemeSync following a live OS change, or by one ThemeToggle instance
// after a manual toggle, so every other mounted ThemeToggle instance updates
// without needing to re-read the DOM itself.
export const THEME_CHANGE_EVENT = "ct-theme-change";

export interface ThemeChangeDetail {
  dark: boolean;
}

export function dispatchThemeChange(dark: boolean) {
  window.dispatchEvent(
    new CustomEvent<ThemeChangeDetail>(THEME_CHANGE_EVENT, { detail: { dark } })
  );
}
