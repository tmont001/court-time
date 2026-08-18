"use client";

// CalendarFab — Phase 29B2 (keyboard model completed in Phase 29B2 source
// review). Replaces the previous stacked "+ Block" / "+ Event" buttons with
// one compact circular + button that opens a small role-based menu. Book
// Court is intentionally never an option here — members book by tapping an
// available slot, and that flow is unchanged. Create Program is intentionally
// never an option here either — it lives in Events → Programs, not the
// Calendar's quick-action surface.
//
// Rendered only for admin/pro by the caller (CalendarShell) — members never
// see this component mounted at all, matching the previous FAB's gating.
//
// Positioned identically to the previous FAB (`absolute bottom-4 right-4`
// inside CalendarShell's own `--page-fill-height`-bounded relative
// container), so it already clears the bottom nav and safe-area inset the
// same way the old buttons did — no new positioning logic was needed for that.
//
// Keyboard model (hand-rolled roving focus, no menu library):
//   - opening the menu (click or Enter/Space on the + button) moves focus to
//     the first item;
//   - ArrowDown/ArrowUp move to the next/previous item, wrapping at the ends;
//   - Home/End jump to the first/last item;
//   - Tab/Shift+Tab are intercepted and contained within the menu (same
//     wrap-around roving as the arrow keys) rather than leaving to the
//     backdrop or page behind it;
//   - Escape closes and returns focus to the + button;
//   - clicking the transparent backdrop closes and returns focus to the +
//     button;
//   - selecting an item closes the menu and invokes its action without
//     re-focusing the + button — the newly opened sheet owns focus from
//     there via its own dialog focus management.
// A single document-level keydown listener is added only while the menu is
// open and removed on close (including on unmount), so no listener leaks.

import { useState, useRef, useEffect, useCallback } from "react";

interface Props {
  userRole: "admin" | "pro";
  onCreateEvent: () => void;
  onCreateBlock: () => void;
  // Phase 33G2: parity fix — Book Lesson is already a first-class staff
  // Calendar workflow via the empty-slot action menu; this gives the
  // global "+" menu the same entry point when no slot is selected.
  onBookLesson: () => void;
}

export default function CalendarFab({ userRole, onCreateEvent, onCreateBlock, onBookLesson }: Props) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs  = useRef<Array<HTMLButtonElement | null>>([]);

  const options: Array<{ label: string; onSelect: () => void }> =
    userRole === "admin"
      ? [
          { label: "Book Lesson", onSelect: onBookLesson },
          { label: "Create Event", onSelect: onCreateEvent },
          { label: "Maintenance Block", onSelect: onCreateBlock },
        ]
      : [
          { label: "Book Lesson", onSelect: onBookLesson },
          { label: "Create Event", onSelect: onCreateEvent },
        ];

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  function select(action: () => void) {
    // Closes without re-focusing the + button — the sheet the action opens
    // takes over focus management on its own (see comment block above).
    setOpen(false);
    action();
  }

  function focusItem(index: number) {
    itemRefs.current[index]?.focus();
  }

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();

    function currentIndex(): number {
      return itemRefs.current.findIndex(el => el === document.activeElement);
    }

    function onKeyDown(e: KeyboardEvent) {
      const count = options.length;
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          close();
          break;
        case "ArrowDown": {
          e.preventDefault();
          const i = currentIndex();
          focusItem(i === -1 ? 0 : (i + 1) % count);
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const i = currentIndex();
          focusItem(i === -1 ? count - 1 : (i - 1 + count) % count);
          break;
        }
        case "Home":
          e.preventDefault();
          focusItem(0);
          break;
        case "End":
          e.preventDefault();
          focusItem(count - 1);
          break;
        case "Tab": {
          // Contain Tab/Shift+Tab inside the menu — same wrap-around roving
          // as the arrow keys, rather than letting focus escape to the
          // backdrop or page content behind it.
          e.preventDefault();
          const i = currentIndex();
          if (e.shiftKey) {
            focusItem(i === -1 ? count - 1 : (i - 1 + count) % count);
          } else {
            focusItem(i === -1 ? 0 : (i + 1) % count);
          }
          break;
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, close, options.length]);

  return (
    <div className="absolute bottom-4 right-4 z-30">
      {open && (
        <>
          {/* Transparent backdrop — click anywhere to close */}
          <div className="fixed inset-0 z-30" onClick={close} />

          <div
            role="menu"
            aria-label="Create"
            className="ct-popover-enter absolute bottom-16 right-0 z-40 w-52 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden py-1"
          >
            {options.map((opt, i) => (
              <button
                key={opt.label}
                ref={el => { itemRefs.current[i] = el; }}
                role="menuitem"
                onClick={() => select(opt.onSelect)}
                className="w-full text-left px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/60 motion-safe:transition-colors motion-safe:duration-100 focus-visible:outline-none focus-visible:bg-gray-50 dark:focus-visible:bg-gray-700/60"
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}

      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Create"
        className="w-14 h-14 rounded-full bg-accent text-white dark:text-gray-900 shadow-md hover:shadow-lg active:scale-[0.97] motion-safe:hover:-translate-y-0.5 motion-safe:transition-all motion-safe:duration-150 flex items-center justify-center text-2xl leading-none font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
      >
        +
      </button>
    </div>
  );
}
