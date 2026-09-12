import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 36D — regression coverage for the general Lesson-request deep
// link (?request_id=<uuid> on /my-schedule?tab=lessons, and the
// generalized ?lesson=<uuid> Stripe-return param, both decoupled from
// checkout=success), using this repository's established source-
// inspection style (see reservationDeepLink.regression.test.ts's own
// header comment, and lessonNavigation.regression.test.ts's own
// precedent for exactly this component — pure-TypeScript, no jsdom/React
// Testing Library available in this baseline).
//
// SECURITY NOTE this file locks in: unlike the reservation deep link
// (Phase 36B), no server-side re-authorization layer was needed or added
// here. get_my_lesson_requests is already scoped to the caller's own
// durable identity (auth.uid() / current_user_roster_member_id()) —
// LessonsClient only ever looks a deep-linked id up INSIDE that
// already-authorized array, never issuing a second, broader fetch by the
// id. This mirrors the exact reasoning already applied to the Event deep
// link (Phase 36C: RLS already matches the intended visibility) — here
// the RPC's own scoping already matches it, so a client-side lookup
// against its result is sufficient.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PAGE_PATH   = "src/app/(app)/my-schedule/page.tsx";
const CLIENT_PATH = "src/app/(app)/lessons/LessonsClient.tsx";
const DETAIL_PATH = "src/app/(app)/lessons/LessonRequestDetail.tsx";
const SHIM_PATH   = "src/app/(app)/lessons/page.tsx";

describe("my-schedule/page.tsx — ?request_id=<uuid> and ?lesson=<uuid> both resolve to one canonical id, independent of checkout=success", () => {
  const src = () => readSource(PAGE_PATH);

  it("computes initialLessonRequestId from request_id first, then lesson, with no checkout gate on either", () => {
    const s = src();
    const idx = s.indexOf("const initialLessonRequestId =");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf(";", idx) + 1);
    expect(block).not.toContain("checkoutParam");
    expect(block).toContain("requestIdParam && uuidRe.test(requestIdParam)");
    expect(block).toContain("lessonParam    && uuidRe.test(lessonParam)");
  });

  it("passes the resolved id to LessonsClient as initialLessonRequestId — the old checkout-gated prop name is gone entirely", () => {
    const s = src();
    expect(s).toContain("initialLessonRequestId={initialLessonRequestId}");
    expect(s).not.toContain("initialCheckoutLessonId");
  });

  it("a malformed request_id or lesson value is ignored — both go through the same uuidRe.test guard", () => {
    const s = src();
    expect(s).toContain("const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;");
  });
});

describe("LessonsClient.tsx — request_id/lesson lookup stays inside the already-authorized initialRequests array", () => {
  const src = () => readSource(CLIENT_PATH);

  it("selected is derived by finding initialLessonRequestId inside initialRequests — never a second/broader fetch by this id", () => {
    const s = src();
    expect(s).toContain(
      "initialLessonRequestId ? initialRequests.find(r => r.id === initialLessonRequestId) ?? null : null,",
    );
  });

  it("the deep-link effect issues no fetch of its own — no supabase/fetch call, confirming another Member's/nonexistent/no-longer-authorized request simply finds no match (selected stays null) rather than being separately queried", () => {
    const s = src();
    const idx = s.indexOf("if (!initialLessonRequestId) return;");
    expect(idx).toBeGreaterThan(-1);
    const endIdx = s.indexOf("}, [initialLessonRequestId, searchParams]);", idx);
    expect(endIdx).toBeGreaterThan(idx);
    const block = s.slice(idx, endIdx);
    expect(block).not.toMatch(/supabase|\.from\(|fetch\(/);
  });

  it("Phase 36E: depends on [initialLessonRequestId, searchParams], not [] — reactive to a same-route notification click and a repeat click of the same one, and now calls setSelected directly rather than relying solely on the useState initializer (which never re-runs after first mount)", () => {
    const s = src();
    const idx = s.indexOf("if (!initialLessonRequestId) return;");
    const endIdx = s.indexOf("}, [initialLessonRequestId, searchParams]);", idx);
    expect(endIdx).toBeGreaterThan(idx);
    const block = s.slice(idx, endIdx + "}, [initialLessonRequestId, searchParams]);".length);
    expect(block).toMatch(/\},\s*\[initialLessonRequestId,\s*searchParams\]\);/);
    expect(block).not.toMatch(/\},\s*\[\]\);/);
    expect(block).toContain("if (match) setSelected(match);");
  });

  it("useSearchParams is imported and called — the reactivity signal", () => {
    const s = src();
    expect(s).toContain('import { useRouter, useSearchParams } from "next/navigation";');
    expect(s).toContain("const searchParams = useSearchParams();");
  });

  it("strips request_id/lesson/checkout via window.history.replaceState, preserving tab=lessons and any other param, never router.replace", () => {
    const s = src();
    const idx = s.indexOf("if (!initialLessonRequestId) return;");
    const endIdx = s.indexOf("}, [initialLessonRequestId, searchParams]);", idx);
    const block = s.slice(idx, endIdx);
    expect(block).toContain('params.delete("request_id");');
    expect(block).toContain('params.delete("lesson");');
    expect(block).toContain('params.delete("checkout");');
    expect(block).toContain('window.history.replaceState(null, "", query ? `/my-schedule?${query}` : "/my-schedule");');
    expect(block).not.toContain("router.replace(");
  });

  it("the ?request=1 Request-Lesson auto-open effect is untouched — a separate useEffect, still using router.replace, unaffected by this checkpoint", () => {
    const s = src();
    const idx = s.indexOf("useEffect(() => {\n    if (autoOpen) {");
    expect(idx).toBeGreaterThan(-1);
    const endIdx = s.indexOf("}, []);", idx);
    const block = s.slice(idx, endIdx);
    expect(block).toContain('router.replace("/my-schedule?tab=lessons", { scroll: false });');
  });

  it("no Lesson payment/checkout logic is duplicated here — LessonRequestDetail remains the sole owner", () => {
    const s = src();
    expect(s).not.toMatch(/createLessonCheckoutAction|getLessonCheckoutEligibilityAction/);
  });
});

describe("LessonRequestDetail.tsx — every relevant status already renders read-only/actionable correctly (unchanged by this checkpoint)", () => {
  const src = () => readSource(DETAIL_PATH);

  it("declined shows the decline reason, read-only", () => {
    expect(src()).toContain('request.status === "declined" && request.decline_reason');
  });

  it("cancelled shows the cancellation reason, read-only", () => {
    expect(src()).toContain('request.status === "cancelled" && request.cancellation_reason');
  });

  it("proposed/pending/confirmed each still have their own distinct action branch — no new branch was added or removed for this checkpoint", () => {
    const s = src();
    expect(s).toContain('request.status === "proposed" && (');
    expect(s).toContain('request.status === "pending" && !confirmWithdraw && (');
    expect(s).toContain('(request.status === "confirmed" ||');
  });
});

describe("legacy /lessons redirect shim — unchanged, still safe", () => {
  it("still forwards only ?request=1 — there is no historical target_path row carrying a request_id query param for it to drop (bare target_path is always a plain string, e.g. '/lessons', never '/lessons?request_id=...')", () => {
    const s = readSource(SHIM_PATH);
    expect(s).toContain('const extra = sp.request === "1" ? "&request=1" : "";');
    expect(s).toContain("redirect(`/my-schedule?tab=lessons${extra}`);");
  });
});
