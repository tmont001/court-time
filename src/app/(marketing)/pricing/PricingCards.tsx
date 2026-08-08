"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PLANS, type Plan } from "./planData";

// Reduced-motion is checked once on mount and on change, so programmatic
// Prev/Next scrolling can skip the smooth-scroll behavior when the visitor
// has asked for it — matches the site's existing prefers-reduced-motion
// conventions elsewhere (MarketingReveal, the product-visual loops).
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mql.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  return reduced;
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div
      className={`h-full flex flex-col rounded-2xl bg-white dark:bg-gray-800 p-6 ${
        plan.isCurrent
          ? "border-2 border-gray-900 dark:border-gray-100 shadow-xl"
          : "border border-gray-200 dark:border-gray-700"
      }`}
    >
      {/* Badge — text-based, not color-only */}
      <span
        className={`self-start inline-block px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide mb-4 ${
          plan.isCurrent
            ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
            : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
        }`}
      >
        {plan.badgeLabel}
      </span>

      <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">{plan.name}</h3>

      <p className="mt-3">
        <span className="text-3xl font-bold text-gray-900 dark:text-gray-100">{plan.monthly}</span>
        <span className="text-sm font-medium text-gray-500 dark:text-gray-400"> / month</span>
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
        or <span className="font-semibold text-gray-700 dark:text-gray-300">{plan.annual} / year</span> — {plan.annualNote}
      </p>

      <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 space-y-1.5 text-xs text-gray-500 dark:text-gray-400">
        <p><span className="text-gray-700 dark:text-gray-300 font-medium">Scale:</span> {plan.intendedScale}</p>
        <p><span className="text-gray-700 dark:text-gray-300 font-medium">Onboarding:</span> {plan.onboarding}</p>
        <p><span className="text-gray-700 dark:text-gray-300 font-medium">Support:</span> {plan.support}</p>
        <p><span className="text-gray-700 dark:text-gray-300 font-medium">No per-member fee</span></p>
      </div>

      <p className="mt-4 text-xs text-gray-500 dark:text-gray-400 flex-1">{plan.availabilityNote}</p>

      <Link
        href={plan.ctaHref}
        className={`mt-5 block w-full text-center py-3 rounded-xl text-sm font-semibold motion-safe:transition-all motion-safe:duration-150 ${
          plan.isCurrent
            ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-300 active:scale-[0.98]"
            : "border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-gray-500 dark:hover:border-gray-400"
        }`}
      >
        {plan.ctaLabel}
      </Link>

      {plan.extraNotes && (
        <p className="mt-3 text-center text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed">
          {plan.extraNotes.join(" · ")}
        </p>
      )}
    </div>
  );
}

export default function PricingCards() {
  const railRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  // Track which card is most visible in the rail so the indicator and the
  // Prev/Next disabled states stay correct whether the visitor swiped,
  // scrolled, or used the buttons.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            const idx = cardRefs.current.findIndex((el) => el === entry.target);
            if (idx !== -1) setActiveIndex(idx);
          }
        }
      },
      { root: rail, threshold: [0.6] }
    );

    cardRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  function goTo(index: number) {
    const target = cardRefs.current[index];
    if (!target) return;
    target.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      inline: "center",
      block: "nearest",
    });
  }

  return (
    <div>
      {/* Plan rail — horizontally scrollable + snapping on mobile/tablet, a plain 3-column grid at lg+ */}
      <div
        ref={railRef}
        role="region"
        aria-label="Pricing plans"
        tabIndex={0}
        className="flex lg:grid lg:grid-cols-3 gap-4 overflow-x-auto lg:overflow-visible snap-x snap-mandatory lg:snap-none pb-2 -mx-4 px-4 lg:mx-0 lg:px-0 hide-scrollbar"
      >
        {PLANS.map((plan, i) => (
          <div
            key={plan.id}
            ref={(el) => { cardRefs.current[i] = el; }}
            className="shrink-0 w-[86%] sm:w-[70%] md:w-[55%] lg:w-auto snap-center"
          >
            <PlanCard plan={plan} />
          </div>
        ))}
      </div>

      {/* Prev/Next + indicator — mobile/tablet only; the desktop grid needs no navigation */}
      <div className="lg:hidden flex items-center justify-center gap-4 mt-4">
        <button
          type="button"
          onClick={() => goTo(activeIndex - 1)}
          disabled={activeIndex === 0}
          aria-label="Previous plan"
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-30 disabled:pointer-events-none motion-safe:transition-colors motion-safe:duration-100 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:focus-visible:ring-gray-500"
        >
          ‹
        </button>

        <div className="flex items-center gap-2">
          <span
            aria-live="polite"
            className="text-xs text-gray-500 dark:text-gray-400 tabular-nums"
          >
            {activeIndex + 1} of {PLANS.length}
          </span>
          <span className="flex items-center gap-1" aria-hidden="true">
            {PLANS.map((plan, i) => (
              <span
                key={plan.id}
                className={`w-1.5 h-1.5 rounded-full ${
                  i === activeIndex ? "bg-gray-900 dark:bg-gray-100" : "bg-gray-300 dark:bg-gray-600"
                }`}
              />
            ))}
          </span>
        </div>

        <button
          type="button"
          onClick={() => goTo(activeIndex + 1)}
          disabled={activeIndex === PLANS.length - 1}
          aria-label="Next plan"
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-30 disabled:pointer-events-none motion-safe:transition-colors motion-safe:duration-100 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:focus-visible:ring-gray-500"
        >
          ›
        </button>
      </div>
    </div>
  );
}
