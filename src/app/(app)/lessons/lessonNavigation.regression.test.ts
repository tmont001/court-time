import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Runtime QA (REGRESSION 2, 34F-A) — visible page/surface flicker returned
// to the Member lesson-request flow after the Stripe Checkout return
// wiring was added. This repository's vitest baseline is deliberately
// pure-TypeScript with no jsdom/React Testing Library — a real mount/
// effect-firing test is not available here (see paymentContext.test.ts's
// own header comment for the established precedent: source-inspection is
// the sanctioned fallback for React-adjacent behavior this environment
// cannot render). This is the strongest practical coverage available: it
// asserts the EXACT mechanism of the fix (which browser/router API is
// invoked, and where) rather than a superficial string-presence check.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const CLIENT_PATH = "src/app/(app)/lessons/LessonsClient.tsx";
const PAGE_PATH    = "src/app/(app)/my-schedule/page.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// Root cause — my-schedule/page.tsx reads searchParams directly, so
// next/navigation's router.replace/push with a CHANGED search-param set
// forces Next.js to re-render/re-fetch the route's ENTIRE Server Component
// tree. Because my-schedule/loading.tsx exists, that second, client-
// triggered re-fetch (moments after Stripe's own hard-navigation redirect
// already rendered the page once) visibly re-flashed the skeleton
// fallback. The fix: strip the one-time ?checkout=&lesson= params via the
// raw History API (window.history.replaceState), which updates the URL
// bar with ZERO Next.js navigation/re-render.
// ═══════════════════════════════════════════════════════════════════════════

describe("root-cause preconditions — confirms the mechanism this fix addresses actually exists", () => {
  it("my-schedule/page.tsx reads searchParams directly (tab/request/checkout/lesson) — the precondition for router.replace/push to force a Server Component re-render on a search-param-only change", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain("const sp       = searchParams ? await searchParams : {};");
    expect(s).toContain('const tab      = typeof sp.tab === "string" ? sp.tab : "upcoming";');
    expect(s).toContain('const checkoutParam = typeof sp.checkout === "string" ? sp.checkout : null;');
    expect(s).toContain('const lessonParam   = typeof sp.lesson === "string" ? sp.lesson : null;');
  });

  it("/my-schedule has its own loading.tsx Suspense fallback — the visible skeleton that flashed a second time", () => {
    const s = readFileSync(join(process.cwd(), "src/app/(app)/my-schedule/loading.tsx"), "utf-8");
    expect(s.length).toBeGreaterThan(0);
  });
});

describe("the fix — checkout-return param stripping uses window.history.replaceState, never next/navigation's router", () => {
  const getEffect = () => {
    const s = readSource(CLIENT_PATH);
    const start = s.indexOf("useEffect(() => {\n    if (!initialCheckoutLessonId) return;");
    const end = s.indexOf("}, []);", start) + "}, []);".length;
    expect(start).toBeGreaterThan(-1);
    return s.slice(start, end);
  };

  it("uses window.history.replaceState to update the URL — zero Next.js navigation, zero Server Component re-fetch, zero Suspense/loading.tsx re-trigger", () => {
    const effect = getEffect();
    expect(effect).toContain('window.history.replaceState(null, "", "/my-schedule?tab=lessons");');
  });

  it("does NOT call router.replace/router.push for this specific effect — the exact mechanism that caused the double-flash", () => {
    const effect = getEffect();
    expect(effect).not.toMatch(/router\.(replace|push)/);
  });

  it("still guards on initialCheckoutLessonId and still runs only once on mount (empty dependency array) — behavior otherwise unchanged from the prior round, only the navigation mechanism changed", () => {
    const effect = getEffect();
    expect(effect).toContain("if (!initialCheckoutLessonId) return;");
    expect(effect.trim().endsWith("}, []);")).toBe(true);
  });
});

describe("delta-scoped — the PRE-EXISTING ?request=1 stripping effect (predates 34F-A, not the reported regression) is left untouched", () => {
  it("still uses router.replace, unchanged — this fix is surgically scoped to the NEW checkout-return effect only, per the delta-focused investigation", () => {
    const s = readSource(CLIENT_PATH);
    const start = s.indexOf("useEffect(() => {\n    if (autoOpen) {");
    const end = s.indexOf("}, []);", start) + "}, []);".length;
    expect(start).toBeGreaterThan(-1);
    const effect = s.slice(start, end);
    expect(effect).toContain('router.replace("/my-schedule?tab=lessons", { scroll: false });');
  });

  it("the two stripping effects remain textually distinct, separate useEffect calls — no merged/shared logic that could reintroduce the coupling this fix removes", () => {
    const s = readSource(CLIENT_PATH);
    const occurrences = s.split("useEffect(() => {").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3); // checkout-strip, request=1-strip, paymentStates fetch
  });
});

describe("the detail sheet itself never re-fetches unnecessarily on the checkout-return path", () => {
  it("the initial `selected` state is derived synchronously from initialRequests (already-loaded SSR data) — the sheet renders immediately on first client paint, no extra round-trip before it appears", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).toContain(
      "const [selected, setSelected]       = useState<LessonRequestRow | null>(\n    initialCheckoutLessonId ? initialRequests.find(r => r.id === initialCheckoutLessonId) ?? null : null,\n  );",
    );
  });

  it("payment state freshness for the reopened sheet comes from LessonRequestDetail's own existing fetchPaymentStates effect, not a second lesson-list re-fetch here", () => {
    const s = readSource(CLIENT_PATH);
    // No additional fetchPaymentStates/router.refresh call inside the
    // checkout-return effect itself.
    const start = s.indexOf("useEffect(() => {\n    if (!initialCheckoutLessonId) return;");
    const end = s.indexOf("}, []);", start) + "}, []);".length;
    const effect = s.slice(start, end);
    expect(effect).not.toMatch(/fetchPaymentStates|router\.refresh/);
  });
});
