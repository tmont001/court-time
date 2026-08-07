"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const MOBILE_MENU_ID = "marketing-mobile-menu";

const MOBILE_LINKS = [
  { href: "/", label: "Home" },
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/contact", label: "Request a Pilot" },
  { href: "/sign-in", label: "Sign in" },
];

export default function MarketingNav() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  // Close the menu whenever the route changes (e.g. back/forward navigation).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape and outside-click close the menu; only wired up while open.
  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target as Node;
      if (
        panelRef.current?.contains(target) ||
        buttonRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const closeMenu = () => setOpen(false);

  return (
    <header className="sticky top-0 z-30 bg-white/90 dark:bg-gray-900/90 backdrop-blur border-b border-gray-100 dark:border-gray-800">
      <div className="max-w-5xl mx-auto px-3 sm:px-4 h-14 flex items-center justify-between gap-3">

        {/* Wordmark */}
        <Link
          href="/"
          className="shrink-0 text-sm font-semibold text-gray-900 dark:text-gray-100 tracking-tight hover:text-accent motion-safe:transition-colors motion-safe:duration-150"
        >
          Court Time
        </Link>

        {/* Desktop nav — visible on sm+ */}
        <nav className="hidden sm:flex items-center gap-6">
          <Link
            href="/features"
            className="text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-150"
          >
            Features
          </Link>
          <Link
            href="/pricing"
            className="text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-150"
          >
            Pricing
          </Link>
          <Link
            href="/contact"
            className="text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-150"
          >
            Request a Pilot
          </Link>
        </nav>

        {/* Desktop: Sign in */}
        <div className="hidden sm:block">
          <Link
            href="/sign-in"
            className="text-sm font-medium text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 px-3 py-1.5 rounded-lg hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
          >
            Sign in
          </Link>
        </div>

        {/* Mobile: filled primary CTA + menu toggle */}
        <div className="flex sm:hidden items-center gap-2">
          <Link
            href="/contact"
            className="px-3 py-1.5 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs font-semibold whitespace-nowrap hover:bg-gray-700 dark:hover:bg-gray-300 motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:focus-visible:ring-gray-500"
          >
            Request a pilot
          </Link>
          <button
            ref={buttonRef}
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls={MOBILE_MENU_ID}
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:focus-visible:ring-gray-500"
          >
            {open ? (
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-4.5 h-4.5" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-4.5 h-4.5" aria-hidden="true">
                <path d="M3 5.5h14M3 10h14M3 14.5h14" strokeLinecap="round" />
              </svg>
            )}
          </button>
        </div>

      </div>

      {/* Mobile menu panel */}
      {open && (
        <div
          id={MOBILE_MENU_ID}
          ref={panelRef}
          className="sm:hidden border-t border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3"
        >
          <nav className="flex flex-col">
            {MOBILE_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={closeMenu}
                className="py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 border-b border-gray-50 dark:border-gray-800 last:border-b-0 motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:focus-visible:ring-gray-500 rounded"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}
