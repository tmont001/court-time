"use client";

import { useRef, useEffect } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BottomSheetProps {
  onClose:   () => void;
  children:  React.ReactNode;
  /** Applied to the content wrapper div below the drag handle. */
  className?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function BottomSheet({ onClose, children, className }: BottomSheetProps) {
  const panelRef   = useRef<HTMLDivElement>(null);
  const handleRef  = useRef<HTMLDivElement>(null);

  // All drag state as refs — never triggers a React re-render.
  // Direct DOM mutation keeps transform updates at 60 fps on mobile.
  const startYRef  = useRef(0);
  const dragYRef   = useRef(0);  // current clamped drag distance (px, ≥ 0)
  const activeRef  = useRef(false); // true while a gesture is in progress

  // Mirror onClose in a ref so the touch-event closure always calls the
  // latest version even if the parent re-renders with a new function reference.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // ── Touch events ──────────────────────────────────────────────────────────
  // Registered via addEventListener (not React synthetic events) because:
  //  1. React 17+ registers all synthetic touch listeners as passive,
  //     which prevents calling e.preventDefault() — the browser claims
  //     the scroll gesture before touchmove can fire.
  //  2. Direct DOM transform on each frame avoids React's render queue,
  //     which introduces visible lag during fast gestures on mobile.

  useEffect(() => {
    const handle = handleRef.current;
    const panel  = panelRef.current;
    if (!handle || !panel) return;

    // Capture as non-nullable aliases so nested closures can access without
    // additional null checks (TypeScript narrows to HTMLDivElement here).
    const p = panel;
    const h = handle; // used only to satisfy the guard — event listeners use `el`

    void h; // mark as intentionally unused after guard

    /** Directly set the panel translateY — no React re-render. */
    function setPos(y: number, animated: boolean) {
      p.style.transition = animated ? "transform 200ms ease-out" : "none";
      p.style.transform  = `translateY(${Math.max(0, y)}px)`;
    }

    /** Decide what to do when the finger lifts. */
    function settle(finalY: number) {
      activeRef.current = false;
      if (finalY > 80) {
        // Animate off-screen, then fire onClose (80 px threshold — forgiving on mobile)
        setPos(window.innerHeight, true);
        setTimeout(() => onCloseRef.current(), 220);
      } else {
        setPos(0, true); // snap back to resting position
      }
    }

    function onTouchStart(e: TouchEvent) {
      activeRef.current = true;
      startYRef.current = e.touches[0].clientY;
      dragYRef.current  = 0;
      setPos(0, false); // clear any leftover transform without animation
    }

    function onTouchMove(e: TouchEvent) {
      if (!activeRef.current) return;
      const delta = e.touches[0].clientY - startYRef.current;
      dragYRef.current = Math.max(0, delta); // clamp: no upward movement
      setPos(dragYRef.current, false);
      // Prevent the browser from triggering page scroll while pulling the
      // handle downward.  Must be in a non-passive listener to work.
      if (delta > 0) e.preventDefault();
    }

    function onTouchEnd() {
      if (!activeRef.current) return;
      settle(dragYRef.current);
    }

    handle.addEventListener("touchstart",  onTouchStart,  { passive: true  });
    handle.addEventListener("touchmove",   onTouchMove,   { passive: false }); // non-passive: allows preventDefault
    handle.addEventListener("touchend",    onTouchEnd,    { passive: true  });
    handle.addEventListener("touchcancel", onTouchEnd,    { passive: true  });

    return () => {
      handle.removeEventListener("touchstart",  onTouchStart);
      handle.removeEventListener("touchmove",   onTouchMove);
      handle.removeEventListener("touchend",    onTouchEnd);
      handle.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []); // stable refs — no deps needed

  // ── Pointer events — desktop mouse-drag fallback ──────────────────────────
  // On a real touch device, touchmove's preventDefault() suppresses the
  // companion pointermove events, so these handlers only fire for mouse
  // input.  Guard on pointerType === "touch" as a belt-and-suspenders safety.

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "touch") return; // touch path above handles mobile
    e.currentTarget.setPointerCapture(e.pointerId);
    activeRef.current = true;
    startYRef.current = e.clientY;
    dragYRef.current  = 0;
    const panel = panelRef.current;
    if (panel) { panel.style.transition = "none"; panel.style.transform = "translateY(0px)"; }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!activeRef.current || e.pointerType === "touch") return;
    const delta = e.clientY - startYRef.current;
    dragYRef.current = Math.max(0, delta);
    const panel = panelRef.current;
    if (panel) panel.style.transform = `translateY(${dragYRef.current}px)`;
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!activeRef.current || e.pointerType === "touch") return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    activeRef.current = false;
    const panel   = panelRef.current;
    const finalY  = dragYRef.current;
    if (!panel) return;
    if (finalY > 80) {
      panel.style.transition = "transform 200ms ease-out";
      panel.style.transform  = `translateY(${window.innerHeight}px)`;
      setTimeout(() => onCloseRef.current(), 220);
    } else {
      panel.style.transition = "transform 200ms ease-out";
      panel.style.transform  = "translateY(0px)";
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Backdrop — click to close */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Sheet panel — transform is controlled entirely via direct DOM mutation,
          NOT via React state, to avoid per-frame re-renders during gesture. */}
      <div
        ref={panelRef}
        className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 rounded-t-2xl z-50 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle
            py-3 → ~26 px vertical padding gives a ~30 px tall hit area
                   (vs. 4 px for the pill alone) — easy to grab on mobile.
            touch-none + touchAction:"none" → both Tailwind and inline style
                   tell the browser this element owns the touch gesture;
                   prevents the scroll heuristic from stealing it.
            select-none → stops accidental text selection during drag. */}
        <div
          ref={handleRef}
          className="flex justify-center py-3 cursor-grab active:cursor-grabbing select-none touch-none"
          style={{ touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="w-10 h-1 bg-gray-200 dark:bg-gray-600 rounded-full" />
        </div>

        {/* Content */}
        <div className={className ?? ""}>
          {children}
        </div>
      </div>
    </>
  );
}
