import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 36D — regression coverage locking in the re-audited finding that
// every current producer of all seven Lesson notification kinds already
// carries `request_id` in its metadata — confirmed against the ACTUAL
// final effective SQL (the highest-numbered migration that still CREATE
// OR REPLACEs each function), not any prior audit's citations. No
// migration is needed for Phase 36D.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function functionBody(src: string, signature: string, maxLen = 20000): string {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  const nextFn = src.indexOf("create or replace function", start + signature.length);
  const end = nextFn === -1 ? start + maxLen : Math.min(nextFn, start + maxLen);
  return src.slice(start, end);
}

const M0101 = "supabase/migrations/0101_lesson_reschedule_foundation.sql";
const M0111 = "supabase/migrations/0111_staff_managed_lessons_identity.sql";
const M0132 = "supabase/migrations/0132_staff_operational_authorization.sql";
const M0146 = "supabase/migrations/0146_member_lesson_pricing_guard.sql";
const M0159 = "supabase/migrations/0159_lesson_online_payment_checkout.sql";

describe("lesson_request_received — every producer carries request_id", () => {
  it("submit_lesson_request, final effective body 0146", () => {
    const body = functionBody(readSource(M0146), "create or replace function public.submit_lesson_request(");
    expect(body).toContain("'lesson_request_received'");
    expect(body).toContain("jsonb_build_object('request_id', v_result.id, 'target_path', '/events?tab=lessons')");
  });

  it("reassign_lesson_provider's new-pro copy, final effective body 0132", () => {
    const body = functionBody(readSource(M0132), "create or replace function public.reassign_lesson_provider(");
    const idx = body.indexOf("'lesson_request_received'");
    expect(idx).toBeGreaterThan(-1);
    const block = body.slice(idx, idx + 400);
    expect(block).toMatch(/'request_id',\s*p_request_id/);
  });
});

describe("lesson_request_proposed — propose_lesson_time, final effective body 0159", () => {
  it("carries request_id", () => {
    const body = functionBody(readSource(M0159), "create or replace function public.propose_lesson_time(");
    expect(body).toContain("'lesson_request_proposed'");
    expect(body).toContain("jsonb_build_object('request_id', p_request_id, 'target_path', '/lessons')");
  });
});

describe("lesson_request_confirmed — every producer carries request_id in both its member and pro copies", () => {
  it("accept_lesson_proposal, final effective body 0111", () => {
    const body = functionBody(readSource(M0111), "create or replace function public.accept_lesson_proposal(");
    const memberIdx = body.indexOf("-- Notify member");
    const proIdx    = body.indexOf("-- Notify pro");
    expect(memberIdx).toBeGreaterThan(-1);
    expect(proIdx).toBeGreaterThan(memberIdx);
    expect(body.slice(memberIdx, proIdx)).toContain("jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)");
    expect(body.slice(proIdx, proIdx + 700)).toContain("jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)");
  });

  it("admin_create_member_lesson, final effective body 0132", () => {
    const body = functionBody(readSource(M0132), "create or replace function public.admin_create_member_lesson(");
    const proIdx    = body.indexOf("if p_pro_id <> auth.uid() then");
    const memberIdx = body.indexOf("if v_member_id is not null then", proIdx);
    expect(proIdx).toBeGreaterThan(-1);
    expect(memberIdx).toBeGreaterThan(proIdx);
    expect(body.slice(proIdx, memberIdx)).toContain("jsonb_build_object('request_id', v_result.id, 'reservation_id', v_res_id)");
    expect(body.slice(memberIdx, memberIdx + 700)).toContain("jsonb_build_object('request_id', v_result.id, 'reservation_id', v_res_id)");
  });

  it("admin_update_member_lesson, final effective body 0159", () => {
    const body = functionBody(readSource(M0159), "create or replace function public.admin_update_member_lesson(");
    const proIdx    = body.indexOf("if v_scheduling_changed or v_pro_changed then");
    const memberIdx = body.indexOf("if v_member_id is not null and (v_scheduling_changed or v_pro_changed or v_member_changed) then");
    expect(proIdx).toBeGreaterThan(-1);
    expect(memberIdx).toBeGreaterThan(proIdx);
    expect(body.slice(proIdx, memberIdx)).toContain("jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)");
    expect(body.slice(memberIdx, memberIdx + 700)).toContain("jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)");
  });
});

describe("lesson_request_declined — decline_lesson_request, final effective body 0101", () => {
  it("carries request_id", () => {
    const body = functionBody(readSource(M0101), "create or replace function public.decline_lesson_request(");
    expect(body).toContain("'lesson_request_declined'");
    expect(body).toContain("jsonb_build_object('request_id', p_request_id, 'target_path', '/lessons')");
  });
});

describe("lesson_cancelled — cancel_lesson, final effective body 0159, both the pro and member copies", () => {
  it("carries request_id in both conditional notification inserts", () => {
    const body = functionBody(readSource(M0159), "create or replace function public.cancel_lesson(");
    const proIdx    = body.indexOf("if v_actor_role <> 'pro' and v_request.pro_id is not null then");
    const memberIdx = body.indexOf("if v_actor_role <> 'member' and v_current_member_id is not null then");
    expect(proIdx).toBeGreaterThan(-1);
    expect(memberIdx).toBeGreaterThan(proIdx);
    expect(body.slice(proIdx, memberIdx)).toContain("'lesson_cancelled'");
    expect(body.slice(proIdx, memberIdx)).toContain("jsonb_build_object('request_id', p_request_id)");
    expect(body.slice(memberIdx, memberIdx + 700)).toContain("'lesson_cancelled'");
    expect(body.slice(memberIdx, memberIdx + 700)).toContain("jsonb_build_object('request_id', p_request_id)");
  });
});

describe("lesson_provider_reassigned — reassign_lesson_provider, final effective body 0132, both the old-pro and member copies", () => {
  it("carries request_id in both notification inserts", () => {
    const body = functionBody(readSource(M0132), "create or replace function public.reassign_lesson_provider(");
    const oldProIdx = body.indexOf("'lesson_provider_reassigned'");
    expect(oldProIdx).toBeGreaterThan(-1);
    const memberIdx = body.indexOf("'lesson_provider_reassigned'", oldProIdx + 1);
    expect(memberIdx).toBeGreaterThan(oldProIdx);
    expect(body.slice(oldProIdx, oldProIdx + 500)).toMatch(/'request_id',\s*p_request_id/);
    expect(body.slice(memberIdx, memberIdx + 500)).toMatch(/'request_id',\s*p_request_id/);
  });
});

// lesson_admin_requested's only producer, admin_create_lesson_request, was
// retired in Phase 44A (migration 0208, zero live callers) — see
// phase44aAuthorizationHardening.regression.test.ts for the retirement
// assertions. The notification kind itself, its email template
// (lessonAdminRequestedTemplate), and its deep-link target mapping are
// deliberately NOT removed: historical notification rows created before
// 0208 may still need to render. No current producer test remains for it.
