"use client";

// ResponsiveSheet — renders a bottom sheet on mobile, modal or panel on desktop.
//
// Two interaction modes, selected via `mobileInteraction` (default "static"):
//
// "static" (default, unchanged from before Phase 29B1):
//   Mobile (< 768px): fixed bottom-0 sheet with ct-sheet-enter animation.
//     Decorative handle (if any) is part of `children`. Backdrop click closes.
//     No Escape on mobile, no focus trap, no body-scroll lock.
//   Desktop (>= 768px): centered modal or right-side panel, × close button,
//     Escape key, backdrop click.
//   Existing consumers pass nothing for `mobileInteraction` and render exactly
//   as they did before this file changed — this mode is untouched.
//
// "draggable" (Phase 29B1 — opt-in only, enabled on 3 representative
// consumers so far: CreateProgramSheet, EventDetailSheet, and CalendarShell's
// slot-action sheet):
//   Adds a real drag-to-dismiss gesture on mobile, role="dialog"/aria-modal,
//   a focus trap + focus restoration, Escape on every viewport, and a
//   reference-counted body-scroll lock.
//
//   Mobile touch gesture: ported directly from the former BottomSheet.tsx
//   component's proven, real-device-working mechanics (that component has
//   since been deleted — all of its consumers now render through this file
//   instead) — native `touchstart`/`touchmove`/`touchend`/`touchcancel`
//   listeners attached via addEventListener directly on the drag-handle
//   strip's DOM node (not React's onTouch* JSX props, which register as
//   passive by default and cannot call preventDefault). A Pointer Events fallback
//   remains for mouse input only (desktop dev testing with a mouse-emulated
//   "mobile" viewport) — every pointer handler bails out immediately when
//   `pointerType === "touch"`, so real touch input always goes through the
//   native listeners exclusively, never both paths at once.
//
//   Two-layer mobile panel: an outer wrapper owns the ct-sheet-enter entrance
//   animation, fixed positioning, z-index, and max-height; a separate inner
//   panel (the drag-handle strip + header + scrollable body, holding
//   panelRef and dialog semantics) owns the direct drag `transform`. These
//   are two different DOM elements, so the entrance animation (even with
//   fill-mode `both` retaining its ending transform) can never compete with
//   the drag transform for the same element's `transform` property — no
//   animation-cancellation workaround is needed.
//
//   `active={false}` (e.g. EventDetailSheet while EventRosterSheet is open
//   on top of it) suspends this sheet's own Escape/focus-trap/backdrop/drag
//   AND makes its panel `inert` + `aria-hidden` so it's fully unavailable to
//   keyboard and screen-reader interaction while suspended — restoring both
//   dialog semantics and focus (to whatever was focused just before it went
//   inactive, when that element still exists) when `active` becomes true
//   again.
//
// Children (the scrollable body in "draggable" mode; the whole sheet content
// in "static" mode) manage their own overflow-y-auto in "static" mode. In
// "draggable" mode ResponsiveSheet owns the flex-column/scroll-region
// structure itself — do not add another overflow-y-auto wrapper around
// `children` there.

import { useState, useEffect, useRef, useCallback } from "react";

interface CommonProps {
  onClose: () => void;
  variant?: "modal" | "panel";
  // "default" = max-w-lg; "wide" = max-w-2xl (for multi-step forms)
  size?: "default" | "wide";
  // z-index overrides for mobile — used when layered above another sheet
  mobileBackdropZ?: number;
  mobilePanelZ?: number;
}

interface StaticSheetProps extends CommonProps {
  mobileInteraction?: "static";
  children: React.ReactNode;
}

interface DraggableSheetProps extends CommonProps {
  mobileInteraction: "draggable";
  /** Accessible name for the dialog (sets aria-label). */
  label: string;
  /** Header content — title/back-button/step-indicator. Rendered directly
   *  below the drag-handle strip, outside all drag listeners, so every
   *  control here gets ordinary pointer/click behavior. Also rendered
   *  (without the handle strip) on desktop — single source for both. */
  header: React.ReactNode;
  /** The scrollable body. */
  children: React.ReactNode;
  /** Set false to suspend this sheet's own Escape/focus-trap/backdrop-click
   *  /drag while a nested sheet (enabled or not) is open on top of it (e.g.
   *  EventRosterSheet opened from EventDetailSheet). The sheet stays
   *  visually mounted and layered correctly, but becomes `inert` +
   *  `aria-hidden` — fully unavailable to keyboard/AT — until `active`
   *  is true again, at which point dialog semantics and focus (to
   *  whatever was focused inside this panel right before it went
   *  inactive, if it still exists) are restored. Defaults to true. */
  active?: boolean;
}

type Props = StaticSheetProps | DraggableSheetProps;

// ─── Body-scroll lock — reference counted so nested/sequential enabled
// sheets don't unlock the page while a sibling is still open, and the
// original body overflow value (whatever it was before ANY enabled sheet
// opened) is restored exactly once the last one closes. ──────────────────
let lockCount = 0;
let previousBodyOverflow: string | null = null;

function lockBodyScroll() {
  if (lockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount++;
}

function unlockBodyScroll() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = previousBodyOverflow ?? "";
    previousBodyOverflow = null;
  }
}

// ─── Focus trap helpers ───────────────────────────────────────────────────

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null // rough visibility check
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ─── Drag gesture tuning ────────────────────────────────────────────────

const DISMISS_DISTANCE = 100; // px — downward release beyond this dismisses
const DISMISS_VELOCITY = 0.5; // px/ms (~500px/s) — a quick flick dismisses even under DISMISS_DISTANCE
const MOVE_THRESHOLD    = 6;  // px — minimal dead-zone, just enough to distinguish vertical vs horizontal intent
const DISMISS_ANIM_MS   = 200;

const SHEET_MAX_HEIGHT = "calc(100dvh - env(safe-area-inset-bottom, 0px) - 1.5rem)";

export default function ResponsiveSheet(props: Props) {
  const { onClose, variant = "modal", size = "default", mobileBackdropZ = 40, mobilePanelZ = 50 } = props;
  const enabled = props.mobileInteraction === "draggable";
  const active  = enabled ? (props as DraggableSheetProps).active ?? true : true;

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

  // Guards against onClose firing twice (e.g. a drag-dismiss timer still
  // in flight when Escape or a backdrop click also closes the sheet).
  const closedRef = useRef(false);

  // ── "static" mode: desktop-only Escape, unchanged from before ──────────

  const handleEscapeStatic = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    if (enabled) return; // enabled mode has its own Escape handling below
    if (!isDesktop) return;
    document.addEventListener("keydown", handleEscapeStatic);
    return () => document.removeEventListener("keydown", handleEscapeStatic);
  }, [enabled, isDesktop, handleEscapeStatic]);

  // ── "draggable" mode: shared accessibility + body-lock, both viewports ──

  const panelRef             = useRef<HTMLDivElement>(null);
  const handleStripRef       = useRef<HTMLDivElement>(null);
  const backdropRef          = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const dismissTimeoutRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDismissTimeout = useCallback(() => {
    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
      dismissTimeoutRef.current = null;
    }
  }, []);

  const closeOnce = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    clearDismissTimeout();
    onClose();
  }, [clearDismissTimeout, onClose]);

  // Body-scroll lock — engaged for the lifetime of every mounted enabled
  // sheet, regardless of `active`, so a suspended parent sheet (behind a
  // nested sheet on top of it) still keeps the page locked.
  useEffect(() => {
    if (!enabled) return;
    lockBodyScroll();
    return unlockBodyScroll;
  }, [enabled]);

  // Initial focus + restoration to the pre-open element on unmount.
  useEffect(() => {
    if (!enabled) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel && active) {
      const focusables = getFocusable(panel);
      (focusables[0] ?? panel).focus();
    }
    return () => {
      const prev = previouslyFocusedRef.current;
      if (prev && document.contains(prev)) prev.focus();
    };
    // Only re-run on mount/unmount (and the enabled flag, which never
    // actually changes for a given consumer) — `active`'s own transitions
    // are handled by the separate effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Focus handoff across an `active` transition: capture focus the moment
  // this sheet is suspended by a nested sheet opening on top of it, and
  // restore it (if the element still exists) the moment `active` returns —
  // falling back to the first focusable element, then the panel itself.
  const preInactiveFocusRef = useRef<HTMLElement | null>(null);
  const wasActiveRef        = useRef(active);
  useEffect(() => {
    if (!enabled) return;
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (wasActive === active) return;

    if (!active) {
      preInactiveFocusRef.current = document.activeElement as HTMLElement | null;
      return;
    }

    const target = preInactiveFocusRef.current;
    preInactiveFocusRef.current = null;
    const panel = panelRef.current;
    if (target && document.contains(target)) {
      target.focus();
    } else if (panel) {
      const focusables = getFocusable(panel);
      (focusables[0] ?? panel).focus();
    }
  }, [enabled, active]);

  // Escape (both viewports) + Tab/Shift+Tab containment — only while active
  // (a nested sheet open on top suspends both).
  useEffect(() => {
    if (!enabled || !active) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeOnce();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = getFocusable(panel);
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last  = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled, active, closeOnce]);

  // ── Drag gesture (mobile only) ──────────────────────────────────────────
  // Shared state/helpers used by BOTH the real-touch path (native listeners,
  // below) and the mouse-only Pointer Events fallback (JSX props, further
  // below) — the two never run concurrently for a given gesture.

  const startXRef     = useRef(0);
  const startYRef     = useRef(0);
  const draggingRef   = useRef(false); // committed to a vertical drag (past MOVE_THRESHOLD)
  const trackingRef   = useRef(false); // a gesture is in progress, not yet committed either way
  const dragYRef       = useRef(0);
  const lastYRef        = useRef(0);
  const lastTRef         = useRef(0);
  const velocityRef       = useRef(0); // px/ms, positive = moving down

  const applyTransform = useCallback((y: number, animated: boolean) => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.transition = animated ? `transform ${DISMISS_ANIM_MS}ms ease-out` : "none";
    panel.style.transform  = y > 0 ? `translateY(${y}px)` : "";
  }, []);

  // Live drag feedback — backdrop opacity fades proportionally to how far
  // the sheet has been dragged (never fully to 0 while still tracking, so
  // it reads as "the sheet is being pulled" rather than "already gone").
  const applyDragBackdropOpacity = useCallback((y: number) => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    backdrop.style.transition = "none";
    const progress = Math.min(1, y / DISMISS_DISTANCE);
    backdrop.style.opacity = y > 0 ? String(1 - progress * 0.7) : "";
  }, []);

  // Absolute backdrop opacity — "" resets to the default (full, ~0.3 alpha)
  // look for a spring-back; 0 fades it fully transparent for a real
  // dismiss. These are deliberately two different target values — a
  // dismiss must never "restore" the backdrop to full opacity mid-close.
  const setBackdropOpacity = useCallback((opacity: 0 | "", animated: boolean) => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    backdrop.style.transition = animated ? `opacity ${DISMISS_ANIM_MS}ms ease-out` : "none";
    backdrop.style.opacity = opacity === "" ? "" : "0";
  }, []);

  const resetDrag = useCallback((animated: boolean) => {
    applyTransform(0, animated);
    setBackdropOpacity("", animated);
  }, [applyTransform, setBackdropOpacity]);

  // Slides the panel down, fades the backdrop to fully transparent (never
  // back to full opacity), and calls onClose once the animation finishes —
  // or immediately, with no fixed delay, when the user has requested
  // reduced motion.
  const dismissSheet = useCallback(() => {
    clearDismissTimeout();
    const reduceMotion = prefersReducedMotion();
    setBackdropOpacity(0, !reduceMotion);
    applyTransform(window.innerHeight, !reduceMotion);
    if (reduceMotion) {
      closeOnce();
    } else {
      dismissTimeoutRef.current = setTimeout(closeOnce, DISMISS_ANIM_MS);
    }
  }, [clearDismissTimeout, setBackdropOpacity, applyTransform, closeOnce]);

  const beginDrag = useCallback((x: number, y: number) => {
    clearDismissTimeout();
    startXRef.current = x;
    startYRef.current = y;
    lastYRef.current  = y;
    lastTRef.current  = performance.now();
    dragYRef.current  = 0;
    velocityRef.current = 0;
    draggingRef.current = false;
    trackingRef.current = true;
  }, [clearDismissTimeout]);

  // Returns true once the gesture has committed to an active vertical drag
  // (so the caller knows to preventDefault and suppress native scroll).
  const updateDrag = useCallback((x: number, y: number): boolean => {
    if (!trackingRef.current) return false;
    const deltaX = x - startXRef.current;
    const deltaY = y - startYRef.current;

    if (!draggingRef.current) {
      if (Math.abs(deltaY) < MOVE_THRESHOLD && Math.abs(deltaX) < MOVE_THRESHOLD) return false;
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        // Predominantly horizontal — not a dismiss gesture. Stop tracking
        // for the rest of this gesture so a diagonal correction mid-swipe
        // can't suddenly start dragging the sheet.
        trackingRef.current = false;
        return false;
      }
      draggingRef.current = true;
    }

    const now = performance.now();
    const dt  = now - lastTRef.current;
    if (dt > 0) velocityRef.current = (y - lastYRef.current) / dt;
    lastYRef.current = y;
    lastTRef.current = now;

    const clamped = Math.max(0, deltaY);
    dragYRef.current = clamped;
    applyTransform(clamped, false);
    applyDragBackdropOpacity(clamped);
    return true;
  }, [applyTransform, applyDragBackdropOpacity]);

  const endDragGesture = useCallback(() => {
    if (!trackingRef.current) return;
    trackingRef.current = false;
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const shouldDismiss = dragYRef.current > DISMISS_DISTANCE || velocityRef.current > DISMISS_VELOCITY;
    if (shouldDismiss) dismissSheet(); else resetDrag(true);
  }, [dismissSheet, resetDrag]);

  const cancelDragGesture = useCallback(() => {
    trackingRef.current = false;
    draggingRef.current = false;
    resetDrag(true); // cancel never dismisses
  }, [resetDrag]);

  // ── Real touch input — ported directly from the former BottomSheet.tsx
  // component's proven mechanics (deleted; this file is now the sole
  // consumer of that logic). Registered via addEventListener directly on the handle-strip
  // DOM node, NOT React's onTouch* JSX props: React registers synthetic
  // touchstart/touchmove listeners as passive by default, which silently
  // prevents preventDefault() from taking effect and lets the browser win
  // the scroll gesture before the sheet can respond. touchmove is
  // registered non-passive here specifically so preventDefault works.
  //
  // `active` and the drag callbacks are forwarded through refs, kept fresh
  // every render, rather than listed as effect dependencies — several of
  // those callbacks transitively close over the `onClose` prop, which many
  // consumers pass as a new inline function on every render; depending on
  // them directly would tear down and reattach the native listeners on
  // every single render instead of once per mount. ─────────────────────

  const activeRef = useRef(active);
  const beginDragRef        = useRef(beginDrag);
  const updateDragRef       = useRef(updateDrag);
  const endDragGestureRef   = useRef(endDragGesture);
  const cancelDragGestureRef = useRef(cancelDragGesture);
  useEffect(() => {
    activeRef.current          = active;
    beginDragRef.current        = beginDrag;
    updateDragRef.current       = updateDrag;
    endDragGestureRef.current   = endDragGesture;
    cancelDragGestureRef.current = cancelDragGesture;
  });

  useEffect(() => {
    if (!enabled || isDesktop) return;
    const handle = handleStripRef.current;
    if (!handle) return;

    function onTouchStart(e: TouchEvent) {
      if (!activeRef.current) return;
      const t = e.touches[0];
      beginDragRef.current(t.clientX, t.clientY);
    }

    function onTouchMove(e: TouchEvent) {
      if (!trackingRef.current) return;
      const t = e.touches[0];
      const isDragging = updateDragRef.current(t.clientX, t.clientY);
      if (isDragging) e.preventDefault();
    }

    function onTouchEnd() {
      endDragGestureRef.current();
    }

    function onTouchCancel() {
      cancelDragGestureRef.current();
    }

    handle.addEventListener("touchstart", onTouchStart, { passive: true });
    handle.addEventListener("touchmove", onTouchMove, { passive: false });
    handle.addEventListener("touchend", onTouchEnd, { passive: true });
    handle.addEventListener("touchcancel", onTouchCancel, { passive: true });

    return () => {
      handle.removeEventListener("touchstart", onTouchStart);
      handle.removeEventListener("touchmove", onTouchMove);
      handle.removeEventListener("touchend", onTouchEnd);
      handle.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [enabled, isDesktop]);

  // ── Mouse fallback (non-touch development testing only) — Pointer Events,
  // guarded to skip entirely for pointerType === "touch" so real touch input
  // always goes through the native listeners above, never both. ──────────

  const mousePointerIdRef = useRef<number | null>(null);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "touch") return;
    if (!active) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    mousePointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    beginDrag(e.clientX, e.clientY);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "touch") return;
    if (!trackingRef.current || e.pointerId !== mousePointerIdRef.current) return;
    const isDragging = updateDrag(e.clientX, e.clientY);
    if (isDragging) e.preventDefault();
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "touch") return;
    if (e.pointerId === mousePointerIdRef.current) {
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    }
    endDragGesture();
  }

  function handlePointerCancel(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "touch") return;
    if (e.pointerId === mousePointerIdRef.current) {
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    }
    cancelDragGesture();
  }

  // Clear any pending dismiss timer on unmount.
  useEffect(() => {
    return clearDismissTimeout;
  }, [clearDismissTimeout]);

  // Viewport resize/orientation change while not actively dragging — clear
  // any leftover transform rather than leaving a stale offset.
  useEffect(() => {
    if (!enabled) return;
    function handleResize() {
      if (!trackingRef.current) resetDrag(false);
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [enabled, resetDrag]);

  // ── Render: "draggable" mode ────────────────────────────────────────────

  if (enabled) {
    const { header, children, label } = props as DraggableSheetProps;
    const dialogA11y = {
      role: "dialog" as const,
      "aria-modal": active ? (true as const) : undefined,
      "aria-hidden": active ? undefined : (true as const),
      "aria-label": label,
      tabIndex: -1 as const,
      inert: !active,
    };

    if (!isDesktop) {
      return (
        <>
          <div
            ref={backdropRef}
            className="fixed inset-0 bg-black/30"
            style={{ zIndex: mobileBackdropZ }}
            onClick={active ? closeOnce : undefined}
          />
          {/* Outer wrapper — owns the entrance animation, fixed positioning,
              z-index, and max-height ONLY. Never receives a drag transform,
              so it can't compete with the inner panel for `transform`. */}
          <div
            className="ct-sheet-enter fixed bottom-0 left-0 right-0"
            style={{ zIndex: mobilePanelZ, maxHeight: SHEET_MAX_HEIGHT }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Inner panel — owns the drag transform, visual chrome, and
                dialog semantics. */}
            <div
              ref={panelRef}
              {...dialogA11y}
              className="flex flex-col bg-white dark:bg-gray-800 rounded-t-2xl shadow-xl overflow-hidden"
              style={{ maxHeight: SHEET_MAX_HEIGHT }}
            >
              {/* Dedicated, non-interactive drag-handle strip — the ONLY
                  element that owns the gesture. Spans the full panel width
                  for a comfortable grab target. Nothing interactive lives
                  here, so header controls below are never intercepted. */}
              <div
                ref={handleStripRef}
                className="shrink-0 flex justify-center py-3 touch-none select-none cursor-grab active:cursor-grabbing"
                style={{ touchAction: "none" }}
                aria-hidden="true"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
              >
                <div className="ct-handlebar" />
              </div>
              {/* Header — ordinary interactive content, no drag listeners. */}
              <div className="shrink-0 px-6 pb-3">{header}</div>
              <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-6 pb-8">
                {children}
              </div>
            </div>
          </div>
        </>
      );
    }

    // ── Desktop: right-side panel ───────────────────────────────────────
    if (variant === "panel") {
      return (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={active ? closeOnce : undefined} />
          <div
            ref={panelRef}
            {...dialogA11y}
            className="ct-panel-enter fixed right-0 top-0 bottom-0 z-50 w-[440px] max-w-[90vw] bg-white dark:bg-gray-800 shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={closeOnce}
              aria-label="Close"
              className="absolute top-4 right-4 z-10 w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 motion-safe:transition-colors motion-safe:duration-100 text-lg leading-none"
            >
              ×
            </button>
            <div className="shrink-0 px-6 pt-5 pb-3 md:pr-10">{header}</div>
            <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">{children}</div>
          </div>
        </>
      );
    }

    // ── Desktop: centered modal ──────────────────────────────────────────
    const maxWidthClass = size === "wide" ? "max-w-2xl" : "max-w-lg";
    return (
      <>
        <div className="fixed inset-0 bg-black/30 z-40" />
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={active ? closeOnce : undefined}
        >
          <div
            ref={panelRef}
            {...dialogA11y}
            className={`ct-modal-enter relative bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full ${maxWidthClass} max-h-[85vh] flex flex-col overflow-hidden`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={closeOnce}
              aria-label="Close"
              className="absolute top-4 right-4 z-10 w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 motion-safe:transition-colors motion-safe:duration-100 text-lg leading-none"
            >
              ×
            </button>
            <div className="shrink-0 px-6 pt-5 pb-3 md:pr-10">{header}</div>
            <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">{children}</div>
          </div>
        </div>
      </>
    );
  }

  // ── Render: "static" mode — unchanged from before Phase 29B1 ───────────

  const { children } = props as StaticSheetProps;

  if (!isDesktop) {
    return (
      <>
        <div
          className="fixed inset-0 bg-black/30"
          style={{ zIndex: mobileBackdropZ }}
          onClick={onClose}
        />
        <div
          className="ct-sheet-enter fixed bottom-0 left-0 right-0 flex flex-col bg-white dark:bg-gray-800 rounded-t-2xl shadow-xl overflow-hidden"
          style={{
            zIndex: mobilePanelZ,
            maxHeight: "calc(100dvh - env(safe-area-inset-bottom, 0px) - 1.5rem)",
          }}
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
