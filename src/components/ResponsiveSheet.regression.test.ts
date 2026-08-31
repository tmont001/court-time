import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Runtime QA — TWO rounds of correction to the SAME confirmed hydration
// mismatch ("Hydration failed because the server rendered HTML didn't
// match the client," component stack pointing at ResponsiveSheet). Round
// 1 (useState<boolean>(false)) was hydration-SAFE but not visually
// stable: it still produced a deterministic mobile->desktop structural
// FLIP after mount on every real desktop load, which is not acceptable
// for a component being fixed specifically for visible flicker/tearing.
// Round 2 (this round) eliminates the structural flip entirely: exactly
// ONE DOM tree per (mobileInteraction, variant) combination, on BOTH the
// server and the client's first render, with plain CSS media queries
// (matching Tailwind's own `md:` breakpoint, 768px) choosing mobile-vs-
// desktop presentation — never React state, never two copies of
// `children`.
//
// This repository's vitest baseline is deliberately pure-TypeScript with
// no jsdom/React Testing Library — a real SSR-render-then-hydrate-in-
// jsdom test (the only way to literally reproduce React's own hydration
// diffing, or to literally screenshot "does no structural flip occur
// after mount") is not available here. This is the strongest practical
// coverage available: source-inspection proving the exact mechanism of
// the fix — that no render-time browser-API read exists anywhere in the
// component, and that the SAME DOM nodes carry both the mobile and
// desktop presentation via `md:`-prefixed classes — rather than a
// superficial string check.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const SHEET_PATH = "src/components/ResponsiveSheet.tsx";
const CSS_PATH = "src/app/globals.css";
const LESSON_DETAIL_PATH = "src/app/(app)/lessons/LessonRequestDetail.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// 1/2. Structural mobile-vs-desktop rendering is not selected by browser-
// width state during render — no render-time window.matchMedia/innerWidth
// decision anywhere in the render path.
// ═══════════════════════════════════════════════════════════════════════════

describe("1/2. no render-time browser-viewport decision selects which structural tree is returned", () => {
  const src = () => readSource(SHEET_PATH);

  it("isDesktop is never read inside any of the four render/return blocks (draggable-panel, draggable-modal, static-panel, static-modal) — only inside effects, which run after hydration commits", () => {
    const s = src();
    const renderStart = s.indexOf('// ── Render ─');
    expect(renderStart).toBeGreaterThan(-1);
    const renderSection = s.slice(renderStart);
    // isDesktop appears in this section ONLY inside explanatory comments
    // (describing what it USED to do / now does NOT do), never as a live
    // JS expression driving a conditional return.
    const liveReads = renderSection
      .split("\n")
      .filter((line) => line.includes("isDesktop") && !line.trim().startsWith("//") && !line.trim().startsWith("*"));
    expect(liveReads).toEqual([]);
  });

  it("no `if (!isDesktop)` / `if (isDesktop)` branch exists WITHIN THE RENDER SECTION that returns a different JSX tree — isDesktop-gated early returns exist ONLY earlier in the file, inside useEffect bodies gating POST-HYDRATION behavioral logic (verified separately below)", () => {
    const s = src();
    const renderStart = s.indexOf('// ── Render ─');
    const renderSection = s.slice(renderStart);
    expect(renderSection).not.toMatch(/if \(!isDesktop\)/);
    expect(renderSection).not.toMatch(/if \(isDesktop\)/);
    // The two legitimate isDesktop-gated early returns live BEFORE the
    // render section, inside useEffect bodies, neither returning JSX.
    expect(s.slice(0, renderStart)).toContain(
      "if (!isDesktop) return;\n    document.addEventListener(\"keydown\", handleEscapeStatic);",
    );
    expect(s.slice(0, renderStart)).toContain(
      "if (!enabled || isDesktop) return;\n    const handle = handleStripRef.current;",
    );
  });

  it("the useState initializer for isDesktop remains the deterministic, hydration-safe literal from the prior correction round (never re-introduces the old window.matchMedia lazy initializer)", () => {
    const s = src();
    expect(s).toContain("const [isDesktop, setIsDesktop] = useState<boolean>(false);");
    expect(s).not.toMatch(/useState<boolean>\(\s*\(\)\s*=>/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3/4. Responsive CSS classes establish both layouts on ONE structural
// tree; children are never duplicated into separate mobile/desktop trees.
// ═══════════════════════════════════════════════════════════════════════════

describe("3/4. one hydration-stable tree per (mode, variant) — children rendered exactly once, md: classes carry the responsive difference", () => {
  const src = () => readSource(SHEET_PATH);

  it("draggable-modal renders {children} exactly once, inside a single panel carrying both mobile and md: classes on the SAME element (rounded-t-2xl md:rounded-2xl, shadow-xl md:shadow-2xl)", () => {
    const s = src();
    // Isolate the draggable-modal return block specifically (after the
    // draggable-panel block, before the static-mode section).
    const modalStart = s.indexOf('// ── modal (default) variant');
    const staticStart = s.indexOf('// ── Render: "static" mode');
    expect(modalStart).toBeGreaterThan(-1);
    expect(staticStart).toBeGreaterThan(modalStart);
    const modalBlock = s.slice(modalStart, staticStart);
    expect((modalBlock.match(/\{children\}/g) ?? []).length).toBe(1);
    expect(modalBlock).toContain("rounded-t-2xl md:rounded-2xl");
    expect(modalBlock).toContain("shadow-xl md:shadow-2xl");
  });

  it("draggable-panel renders {children} exactly once, on a single panel carrying both mobile and md: classes (rounded-t-2xl md:rounded-none, w-full md:w-[440px])", () => {
    const s = src();
    const panelStart = s.indexOf('if (variant === "panel") {');
    const modalStart = s.indexOf('// ── modal (default) variant');
    expect(panelStart).toBeGreaterThan(-1);
    expect(modalStart).toBeGreaterThan(panelStart);
    const panelBlock = s.slice(panelStart, modalStart);
    expect((panelBlock.match(/\{children\}/g) ?? []).length).toBe(1);
    expect(panelBlock).toContain("rounded-t-2xl md:rounded-none");
    expect(panelBlock).toContain("w-full md:w-[440px] md:max-w-[90vw]");
  });

  it("the positioning wrapper uses ONE flex-based alignment scheme per variant that switches anchor via md: (items-end -> md:items-center for modal; items-end -> md:items-stretch md:justify-end for panel) — never two separate fixed-position wrapper elements", () => {
    const s = src();
    expect(s).toContain("flex items-end justify-center md:items-center md:p-4");
    expect(s).toContain("flex items-end justify-center md:items-stretch md:justify-end");
    // The old two-different-wrapper shapes (bottom-0 left-0 right-0 vs a
    // separate inset-0-flex-centered wrapper) no longer coexist as
    // distinct isDesktop-gated JSX return values.
    expect(s).not.toMatch(/fixed bottom-0 left-0 right-0["'`]/);
  });

  it("no second, desktop-only copy of `children` exists anywhere in the draggable-mode render section", () => {
    const s = src();
    const renderStart = s.indexOf('// ── Render ─');
    const staticStart = s.indexOf('// ── Render: "static" mode');
    const draggableSection = s.slice(renderStart, staticStart);
    expect((draggableSection.match(/\{children\}/g) ?? []).length).toBe(2); // panel + modal, one each
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Mobile drag handle remains present and hidden appropriately at the
// desktop breakpoint (never absent from the DOM tree entirely).
// ═══════════════════════════════════════════════════════════════════════════

describe("5. drag handle — present in the shared tree, CSS-hidden at md:, not JS-gated", () => {
  it("the handle strip carries md:hidden as its responsive visibility class, defined once and reused by both draggable-modal and draggable-panel via the shared `handleStrip` JSX variable", () => {
    const s = readSource(SHEET_PATH);
    expect(s).toContain('const handleStrip = (');
    expect(s).toContain('className="md:hidden shrink-0 flex justify-center py-3');
    // Used (not merely defined) in both variant branches.
    const usages = (s.match(/\{handleStrip\}/g) ?? []).length;
    expect(usages).toBe(2);
  });

  it("still owns the exact same drag pointer handlers and ref — no behavioral change to the gesture itself, only its CSS visibility", () => {
    const s = readSource(SHEET_PATH);
    const handleStripIdx = s.indexOf("const handleStrip = (");
    const closeButtonIdx = s.indexOf("const closeButton = (");
    const block = s.slice(handleStripIdx, closeButtonIdx);
    expect(block).toContain("ref={handleStripRef}");
    expect(block).toContain("onPointerDown={handlePointerDown}");
    expect(block).toContain("onPointerMove={handlePointerMove}");
    expect(block).toContain("onPointerUp={handlePointerUp}");
    expect(block).toContain("onPointerCancel={handlePointerCancel}");
    expect(block).toContain('aria-hidden="true"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Desktop Close control remains present and hidden appropriately on
// mobile (never absent from the DOM tree entirely).
// ═══════════════════════════════════════════════════════════════════════════

describe("6. desktop Close button — present in the shared tree, CSS-hidden below md:, not JS-gated", () => {
  it("the shared closeButtonClassName starts with `hidden md:flex` (mobile-first hidden, desktop visible), defined once and reused by BOTH the draggable-mode close button (closeButton, itself reused across panel+modal) and the static-mode close button (staticCloseButton, itself reused across panel+modal) — never four separately-defined button elements", () => {
    const s = readSource(SHEET_PATH);
    expect(s).toContain(
      'const closeButtonClassName =\n    "hidden md:flex absolute top-4 right-4',
    );
    // Exactly two <button> elements reference the shared className — one
    // for draggable mode (closeButton, rendered via {closeButton} in both
    // the panel and modal blocks below it), one for static mode
    // (staticCloseButton, likewise rendered in both its blocks).
    const usages = (s.match(/className=\{closeButtonClassName\}/g) ?? []).length;
    expect(usages).toBe(2);
    expect((s.match(/\{closeButton\}/g) ?? []).length).toBe(2);
    expect((s.match(/\{staticCloseButton\}/g) ?? []).length).toBe(2);
  });

  it("closeOnce/onClose wiring is unchanged — draggable modes call closeOnce (the guarded, drag-timer-aware close), static modes call the raw onClose prop", () => {
    const s = readSource(SHEET_PATH);
    expect(s).toContain("<button onClick={closeOnce} aria-label=\"Close\" className={closeButtonClassName}>");
    expect(s).toContain("<button onClick={onClose} aria-label=\"Close\" className={closeButtonClassName}>");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Drag behavior remains mobile-only — the touch-listener attachment
// effect is untouched by this round's render restructuring.
// ═══════════════════════════════════════════════════════════════════════════

describe("7. drag gesture remains gated to mobile only, via the SAME post-hydration effect (untouched by this round)", () => {
  it("native touch listeners still only attach when !isDesktop, exactly as before", () => {
    const s = readSource(SHEET_PATH);
    expect(s).toContain("if (!enabled || isDesktop) return;\n    const handle = handleStripRef.current;");
    expect(s).toContain('handle.addEventListener("touchstart", onTouchStart, { passive: true });');
  });

  it("the mouse/pointer fallback still bails out for real touch input, unchanged", () => {
    const s = readSource(SHEET_PATH);
    expect(s).toContain('if (e.pointerType === "touch") return;');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. variant="panel" remains correct — full-height right-edge sidebar at
// desktop, bottom sheet on mobile, via items-stretch rather than a second
// isDesktop-gated tree.
// ═══════════════════════════════════════════════════════════════════════════

describe("8. variant=\"panel\" — correct at both breakpoints via CSS, not a separate JS-selected tree", () => {
  it("md:items-stretch on the wrapper makes the panel naturally fill the full viewport height at desktop (replacing the old fixed right-0 top-0 bottom-0 positioning) while md:justify-end anchors it to the right edge", () => {
    const s = readSource(SHEET_PATH);
    expect(s).toContain("md:items-stretch md:justify-end");
  });

  it("the panel's own responsive max-height class (ct-sheet-panel-max-h) removes the mobile safe-area cap at md: — height is then fully owned by items-stretch, matching the original always-full-height desktop panel exactly", () => {
    const cssSrc = readSource(CSS_PATH);
    const idx = cssSrc.indexOf(".ct-sheet-panel-max-h {");
    const block = cssSrc.slice(idx, cssSrc.indexOf("}", cssSrc.indexOf("max-height: none", idx)) + 1);
    expect(block).toContain("max-height: none");
  });

  it("desktop panel width (440px, capped at 90vw) and mobile full-width are both present as md:-prefixed classes on the same element", () => {
    const s = readSource(SHEET_PATH);
    expect(s).toContain("w-full md:w-[440px] md:max-w-[90vw]");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The two non-Tailwind-expressible responsive pieces — safe-area max-
// height calc() and the entrance-animation keyframe switch — live in
// globals.css, reusing the EXISTING keyframes verbatim.
// ═══════════════════════════════════════════════════════════════════════════

describe("responsive CSS classes in globals.css reuse the existing keyframes, never redefine them", () => {
  const css = () => readSource(CSS_PATH);

  it("ct-sheet-modal-enter plays ct-sheet-enter-keyframes on mobile and ct-modal-enter-keyframes at md:, both already-existing keyframes", () => {
    const s = css();
    const idx = s.indexOf(".ct-sheet-modal-enter {");
    const end = s.indexOf("@media (prefers-reduced-motion: no-preference) {\n  .ct-sheet-panel-enter", idx);
    const block = s.slice(idx, end);
    expect(block).toContain("animation: ct-sheet-enter-keyframes 180ms ease-out both;");
    expect(block).toContain("animation: ct-modal-enter-keyframes 150ms ease-out both;");
    expect(block).toContain("@media (min-width: 768px) {");
  });

  it("ct-sheet-panel-enter plays ct-sheet-enter-keyframes on mobile and ct-panel-enter-keyframes at md:", () => {
    const s = css();
    const idx = s.indexOf(".ct-sheet-panel-enter {");
    const end = s.indexOf(".ct-sheet-modal-max-h {", idx);
    const block = s.slice(idx, end);
    expect(block).toContain("animation: ct-sheet-enter-keyframes 180ms ease-out both;");
    expect(block).toContain("animation: ct-panel-enter-keyframes 180ms ease-out both;");
  });

  it("no new @keyframes were introduced — only new class names selecting between the three pre-existing ones (ct-sheet-enter-keyframes, ct-modal-enter-keyframes, ct-panel-enter-keyframes)", () => {
    const s = css();
    const newKeyframes = s.match(/@keyframes ct-sheet-(modal|panel)-(enter|max-h)/g);
    expect(newKeyframes).toBeNull();
  });

  it("both new animation classes remain gated by prefers-reduced-motion: no-preference, matching every other entrance animation in this file", () => {
    const s = css();
    expect(s).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\n\s*\.ct-sheet-modal-enter/);
    expect(s).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\n\s*\.ct-sheet-panel-enter/);
  });

  it("ct-sheet-modal-max-h matches the exact original safe-area calc() on mobile and 85vh (the original desktop modal's own max-h-[85vh]) at md:", () => {
    const s = css();
    expect(s).toContain("max-height: calc(100dvh - env(safe-area-inset-bottom, 0px) - 1.5rem);");
    const idx = s.indexOf(".ct-sheet-modal-max-h {");
    const block = s.slice(idx, s.indexOf("}", s.indexOf("max-height: 85vh", idx)) + 1);
    expect(block).toContain("max-height: 85vh");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. No suppressHydrationWarning / ssr:false / mounted-null workaround —
// this is a real structural fix, not a suppression.
// ═══════════════════════════════════════════════════════════════════════════

describe("9. the fix is structural, never a suppression/workaround", () => {
  it("no suppressHydrationWarning anywhere in ResponsiveSheet.tsx", () => {
    expect(readSource(SHEET_PATH)).not.toMatch(/suppressHydrationWarning/);
  });

  it("SSR is not disabled for this component — remains a normal \"use client\" component, never dynamic(..., { ssr: false })", () => {
    const s = readSource(SHEET_PATH);
    expect(s).toContain('"use client";');
    expect(s).not.toMatch(/dynamic\(.*ssr:\s*false/);
  });

  it("no mounted-then-null pattern (e.g. `if (!mounted) return null`) was introduced to dodge the mismatch instead of fixing it", () => {
    const s = readSource(SHEET_PATH);
    expect(s).not.toMatch(/const \[mounted, setMounted\]/);
    expect(s).not.toMatch(/if \(!mounted\)\s*return null/);
  });

  it("no arbitrary setTimeout/delay was introduced to paper over a structural swap", () => {
    const s = readSource(SHEET_PATH);
    // The only setTimeout in this file is the pre-existing, unrelated
    // drag-dismiss animation completion timer (DISMISS_ANIM_MS-based),
    // untouched by this round.
    const setTimeoutCalls = s.match(/setTimeout\(/g) ?? [];
    expect(setTimeoutCalls.length).toBe(1);
    expect(s).toContain("dismissTimeoutRef.current = setTimeout(closeOnce, DISMISS_ANIM_MS);");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10/11. Zero workaround required in LessonRequestDetail; representative
// unrelated consumers require zero changes.
// ═══════════════════════════════════════════════════════════════════════════

describe("10. LessonRequestDetail requires zero workaround — plain ResponsiveSheet usage, unchanged public API", () => {
  it("still renders through the standard draggable ResponsiveSheet API with no lesson-specific hydration/viewport handling", () => {
    const s = readSource(LESSON_DETAIL_PATH);
    expect(s).toContain('import ResponsiveSheet from "@/components/ResponsiveSheet";');
    expect(s).toContain('mobileInteraction="draggable"');
    expect(s).not.toMatch(/isDesktop|matchMedia|suppressHydrationWarning|mounted/);
  });
});

describe("11. representative unrelated ResponsiveSheet callers require zero changes", () => {
  it("a modal-variant consumer (CalendarShell) and a panel-variant consumer (EventRosterSheet) both still import the same default export with no call-site changes needed", () => {
    const modalConsumer = readSource("src/app/(app)/calendar/CalendarShell.tsx");
    const panelConsumer = readSource("src/app/(app)/calendar/EventRosterSheet.tsx");
    expect(modalConsumer).toContain('from "@/components/ResponsiveSheet"');
    expect(panelConsumer).toContain('from "@/components/ResponsiveSheet"');
    expect(panelConsumer).toContain('variant="panel"');
  });

  it("ResponsiveSheet's public prop interface (CommonProps/StaticSheetProps/DraggableSheetProps) is completely unchanged", () => {
    const s = readSource(SHEET_PATH);
    expect(s).toContain("interface CommonProps {");
    expect(s).toContain("interface StaticSheetProps extends CommonProps {");
    expect(s).toContain("interface DraggableSheetProps extends CommonProps {");
    expect(s).toContain("export default function ResponsiveSheet(props: Props) {");
    expect(s).toContain("mobileBackdropZ?: number;");
    expect(s).toContain("mobilePanelZ?: number;");
  });

  it("z-index props (mobileBackdropZ/mobilePanelZ) are applied consistently at every breakpoint via inline style, not hardcoded desktop-only Tailwind z-classes — the 4 existing nested-sheet consumers that override these props get correct desktop layering too, not just mobile", () => {
    const s = readSource(SHEET_PATH);
    // No more hardcoded z-40/z-50 Tailwind utility classes remain in the
    // render section — every backdrop/wrapper now uses the prop-driven
    // style instead.
    const renderStart = s.indexOf('// ── Render ─');
    const renderSection = s.slice(renderStart);
    expect(renderSection).not.toMatch(/className="[^"]*\bz-40\b/);
    expect(renderSection).not.toMatch(/className="[^"]*\bz-50\b/);
    expect((renderSection.match(/style=\{\{\s*zIndex: mobileBackdropZ/g) ?? []).length).toBe(4);
    expect((renderSection.match(/style=\{\{\s*zIndex: mobilePanelZ/g) ?? []).length).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Prior 34F-A checkout-return history.replaceState fix remains, kept
// deliberately separate from this ResponsiveSheet correction.
// ═══════════════════════════════════════════════════════════════════════════

describe("12. history.replaceState checkout-return fix remains in place, independent of this ResponsiveSheet correction", () => {
  it("LessonsClient still strips ?checkout=&lesson= via window.history.replaceState, not router.replace", () => {
    const s = readSource("src/app/(app)/lessons/LessonsClient.tsx");
    expect(s).toContain('window.history.replaceState(null, "", "/my-schedule?tab=lessons");');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. Runtime QA (34F-A round 2, Issue 4) — mobile drag-to-dismiss tracked
// the finger roughly. Root cause: the entrance-animation class
// (ct-sheet-modal-enter / ct-sheet-panel-enter) and panelRef — the element
// applyTransform() writes style.transform to directly during a drag — had
// been merged onto the SAME element by the round-1 refactor. A CSS
// animation's fill-mode both/forwards keeps driving `transform` on its
// element with HIGHER cascade priority than a same-element inline style
// for as long as the animation class stays applied (permanently here,
// since it's never removed post-entrance) — so the entrance animation's
// `transform` silently fought applyTransform()'s inline writes during a
// live drag. The fix restores the pre-refactor two-element split: the
// entrance-animation class now lives on the outer positioning wrapper;
// panelRef (max-height, chrome, drag semantics) never carries an
// animation class, so it's the sole owner of `transform` during a drag.
// ═══════════════════════════════════════════════════════════════════════════

describe("13. entrance-animation element and drag-transform element (panelRef) are never the same DOM node", () => {
  const src = () => readSource(SHEET_PATH);

  it("ct-sheet-modal-enter is applied to the positioning wrapper, not to panelRef's own className", () => {
    const s = src();
    const modalStart = s.indexOf('// ── modal (default) variant');
    const staticStart = s.indexOf('// ── Render: "static" mode');
    const modalBlock = s.slice(modalStart, staticStart);
    expect(modalBlock).toContain('className="ct-sheet-modal-enter fixed inset-0 flex items-end justify-center md:items-center md:p-4"');
    // panelRef's own className starts with the max-height class, never the
    // entrance-animation class.
    const panelRefIdx = modalBlock.indexOf("ref={panelRef}");
    const classNameAfterRef = modalBlock.slice(panelRefIdx, modalBlock.indexOf("onClick={(e) => e.stopPropagation()}", panelRefIdx));
    expect(classNameAfterRef).toContain("ct-sheet-modal-max-h");
    expect(classNameAfterRef).not.toContain("ct-sheet-modal-enter");
  });

  it("ct-sheet-panel-enter is applied to the positioning wrapper, not to panelRef's own className", () => {
    const s = src();
    const panelStart = s.indexOf('if (variant === "panel") {');
    const modalStart = s.indexOf('// ── modal (default) variant');
    const panelBlock = s.slice(panelStart, modalStart);
    expect(panelBlock).toContain('className="ct-sheet-panel-enter fixed inset-0 flex items-end justify-center md:items-stretch md:justify-end"');
    const panelRefIdx = panelBlock.indexOf("ref={panelRef}");
    const classNameAfterRef = panelBlock.slice(panelRefIdx, panelBlock.indexOf("onClick={(e) => e.stopPropagation()}", panelRefIdx));
    expect(classNameAfterRef).toContain("ct-sheet-panel-max-h");
    expect(classNameAfterRef).not.toContain("ct-sheet-panel-enter");
  });

  it("applyTransform still writes directly to panelRef.current.style.transform — the fix moved the animation class, not the drag target", () => {
    const s = src();
    const idx = s.indexOf("const applyTransform = useCallback((y: number, animated: boolean) => {");
    const block = s.slice(idx, s.indexOf("}, []);", idx));
    expect(block).toContain("const panel = panelRef.current;");
    expect(block).toContain("panel.style.transform  = y > 0");
  });

  it("the file's own header comment documents the two-element invariant so it isn't silently reintroduced by a future refactor", () => {
    const s = src();
    expect(s).toContain("MUST stay two different DOM elements");
  });
});
