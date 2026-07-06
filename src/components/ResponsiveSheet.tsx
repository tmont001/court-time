"use client";

// ResponsiveSheet — renders a bottom sheet on mobile, modal or panel on desktop.
//
// Mobile (< 768px): fixed bottom-0 sheet with ct-sheet-enter animation.
//   Backdrop click closes.
//
// Desktop (>= 768px):
//   variant="modal" → centered dialog with ct-modal-enter animation.
//   variant="panel" → right-side panel with ct-panel-enter animation.
//   Both: semi-transparent backdrop, × close button, Escape key, backdrop click.
//
// Children are rendered directly inside the container (no extra scroll wrapper).
// Children that need scrolling should manage their own overflow-y-auto.
// Use `md:hidden` on ct-handlebar or mobile-only elements inside children.

import { useState, useEffect, useCallback } from "react";

interface Props {
  onClose: () => void;
  variant?: "modal" | "panel";
  // "default" = max-w-lg; "wide" = max-w-2xl (for multi-step forms)
  size?: "default" | "wide";
  children: React.ReactNode;
  // z-index overrides for mobile — used when layered above another sheet
  mobileBackdropZ?: number;
  mobilePanelZ?: number;
}

export default function ResponsiveSheet({
  onClose,
  variant = "modal",
  size = "default",
  children,
  mobileBackdropZ = 40,
  mobilePanelZ    = 50,
}: Props) {
  const [isDesktop, setIsDesktop] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches
  );

  useEffect(() => {
    const mq      = window.matchMedia("(min-width: 768px)");
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isDesktop) return;
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isDesktop, handleEscape]);

  // ── Mobile: bottom sheet ──────────────────────────────────────────────────

  if (!isDesktop) {
    return (
      <>
        <div
          className="fixed inset-0 bg-black/30"
          style={{ zIndex: mobileBackdropZ }}
          onClick={onClose}
        />
        <div
          className="ct-sheet-enter fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 rounded-t-2xl shadow-xl"
          style={{ zIndex: mobilePanelZ }}
          onClick={e => e.stopPropagation()}
        >
          {children}
        </div>
      </>
    );
  }

  // ── Desktop: right-side panel ─────────────────────────────────────────────

  if (variant === "panel") {
    return (
      <>
        <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
        <div
          className="ct-panel-enter fixed right-0 top-0 bottom-0 z-50 w-[440px] max-w-[90vw] bg-white dark:bg-gray-800 shadow-2xl flex flex-col overflow-hidden"
          onClick={e => e.stopPropagation()}
        >
          {/* Desktop close button — top-right corner */}
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute top-4 right-4 z-10 w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 motion-safe:transition-colors motion-safe:duration-100 text-lg leading-none"
          >
            ×
          </button>
          {children}
        </div>
      </>
    );
  }

  // ── Desktop: centered modal ───────────────────────────────────────────────
  // Issue 3 fix: onClick={onClose} on the centering div catches backdrop
  // clicks (outside the modal box). The inner modal div's stopPropagation
  // prevents those clicks from reaching the centering div.

  const maxWidthClass = size === "wide" ? "max-w-2xl" : "max-w-lg";

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" />
      {/* Centering wrapper — click anywhere outside modal box closes it */}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div
          className={`ct-modal-enter relative bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full ${maxWidthClass} max-h-[85vh] flex flex-col overflow-hidden`}
          onClick={e => e.stopPropagation()}
        >
          {/* Desktop close button — top-right corner */}
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute top-4 right-4 z-10 w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 motion-safe:transition-colors motion-safe:duration-100 text-lg leading-none"
          >
            ×
          </button>
          {children}
        </div>
      </div>
    </>
  );
}
