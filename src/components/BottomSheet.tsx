"use client";

import { useState, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BottomSheetProps {
  onClose:   () => void;
  children:  React.ReactNode;
  /** Applied to the content wrapper div below the drag handle. */
  className?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function BottomSheet({ onClose, children, className }: BottomSheetProps) {
  // dragY — how far the panel has been dragged downward (px). Always ≥ 0.
  const [dragY, setDragY]         = useState(0);
  // isDragging — controls whether the CSS transition is active.
  // True during active drag (no transition; panel follows pointer exactly).
  // False at rest / snap-back (transition animates the panel).
  const [isDragging, setIsDragging] = useState(false);

  // Refs so pointer-event callbacks always see fresh values without stale
  // closures — avoids the "first pointermove fires before setState resolves" edge case.
  const isDraggingRef = useRef(false);
  const startYRef     = useRef(0);

  // ── Drag-to-dismiss ───────────────────────────────────────────────────────
  // Handlers are attached to the drag handle only, so scrollable content
  // inside the sheet retains normal scroll behaviour.

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    startYRef.current     = e.clientY;
    isDraggingRef.current = true;
    setIsDragging(true);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDraggingRef.current) return;
    const delta = e.clientY - startYRef.current;
    setDragY(Math.max(0, delta)); // clamp: only allow downward movement
  }

  function handlePointerEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDraggingRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const finalDelta      = Math.max(0, e.clientY - startYRef.current);
    isDraggingRef.current = false;
    setIsDragging(false);
    setDragY(0); // snap back (animated when isDragging is false)
    if (finalDelta > 100) {
      onClose();
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Backdrop — click to close */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Sheet panel */}
      <div
        className={`fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 rounded-t-2xl z-50 shadow-xl${
          isDragging ? "" : " transition-transform duration-200 ease-out"
        }`}
        style={{ transform: `translateY(${dragY}px)` }}
        onClick={(e) => e.stopPropagation()} // prevent panel clicks from reaching backdrop
      >
        {/* Drag handle — wider touch target wraps the visual pill.
            touch-none: prevents the browser claiming the gesture for page scroll
                        before pointermove can fire (critical on iOS/Android).
            select-none: stops text selection from interrupting the drag.
            py-3 gives a ~28 px hit area vs the 4 px pill alone. */}
        <div
          className="flex justify-center pt-3 pb-2 cursor-grab active:cursor-grabbing select-none touch-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
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
