import { describe, expect, it } from "vitest";
import { resolveNotificationTarget } from "@/lib/notification-targets";

// Phase 36E — integration-contract coverage for NotificationSheet's use of
// resolveNotificationTarget(kind, metadata, viewerRole). This exercises the
// REAL exported resolver (not a reimplementation) against the exact
// metadata SHAPES each real producer across Phases 36A-D actually writes,
// proving the contract NotificationSheet's click handler depends on for
// every kind it will encounter in production.
//
// This is deliberately a focused subset, not a re-test of every resolver
// edge case (fallback ordering, malformed-id handling, etc.) — those are
// already exhaustively covered by src/lib/notification-targets.test.ts
// and stay green independent of this file. This file's job is narrower:
// "given what a real notification row of this kind actually looks like,
// does the resolver hand NotificationSheet the right path."

const RESERVATION_ID = "11111111-1111-1111-1111-111111111111";
const EVENT_ID       = "22222222-2222-2222-2222-222222222222";
const PROGRAM_ID      = "33333333-3333-3333-3333-333333333333";
const REQUEST_ID      = "44444444-4444-4444-4444-444444444444";

describe("Reservation kinds — all four resolve via metadata.reservation_id", () => {
  const kinds = [
    "reservation_confirmed",
    "reservation_cancelled_by_admin",
    "reservation_cancelled_by_member",
    "reservation_rescheduled",
  ];

  it.each(kinds)("%s -> /calendar?reservation=<id>", (kind) => {
    expect(resolveNotificationTarget(kind, { reservation_id: RESERVATION_ID }, "member"))
      .toBe(`/calendar?reservation=${RESERVATION_ID}`);
  });
});

describe("Event kinds — event_joined/event_updated/event_cancelled resolve via metadata.event_id", () => {
  const kinds = ["event_joined", "event_updated", "event_cancelled"];

  it.each(kinds)("%s -> /calendar?event=<id>", (kind) => {
    expect(resolveNotificationTarget(kind, { event_id: EVENT_ID }, "member"))
      .toBe(`/calendar?event=${EVENT_ID}`);
  });
});

describe("waitlist_promoted — always event_id (accept_waitlist_offer / admin_force_confirm shape)", () => {
  it("resolves via metadata.event_id, with the accompanying triggered_by field present but unused", () => {
    expect(resolveNotificationTarget("waitlist_promoted", { event_id: EVENT_ID, triggered_by: "actor-1" }, "member"))
      .toBe(`/calendar?event=${EVENT_ID}`);
  });
});

describe("waitlist_offer — polymorphic: the Event-occurrence shape (advance_waitlist_offer / admin_offer_spot)", () => {
  it("resolves to the Event path when metadata carries event_id + offer_expires_at + triggered_by", () => {
    const metadata = { event_id: EVENT_ID, offer_expires_at: "2026-01-01T00:00:00Z", triggered_by: "actor-1" };
    expect(resolveNotificationTarget("waitlist_offer", metadata, "member")).toBe(`/calendar?event=${EVENT_ID}`);
  });
});

describe("waitlist_offer — polymorphic: the whole-Program shape (_advance_program_waitlist_offer, no event_id)", () => {
  it("resolves to the Program enrollment path when metadata carries only program_id + offer_expires_at + triggered_by", () => {
    const metadata = { program_id: PROGRAM_ID, offer_expires_at: "2026-01-01T00:00:00Z", triggered_by: "actor-1" };
    expect(resolveNotificationTarget("waitlist_offer", metadata, "member")).toBe(`/events?program=${PROGRAM_ID}`);
  });
});

describe("Lesson kinds — all seven resolve via metadata.request_id, role-routed", () => {
  const kinds = [
    "lesson_request_received",
    "lesson_request_proposed",
    "lesson_request_confirmed",
    "lesson_request_declined",
    "lesson_cancelled",
    "lesson_provider_reassigned",
    "lesson_admin_requested",
  ];

  it.each(kinds)("%s -> Member path for role=member", (kind) => {
    expect(resolveNotificationTarget(kind, { request_id: REQUEST_ID }, "member"))
      .toBe(`/my-schedule?tab=lessons&request_id=${REQUEST_ID}`);
  });

  it.each(kinds)("%s -> /admin/lessons for role=pro", (kind) => {
    expect(resolveNotificationTarget(kind, { request_id: REQUEST_ID }, "pro"))
      .toBe(`/admin/lessons?lessonId=${REQUEST_ID}`);
  });

  it.each(kinds)("%s -> /admin/lessons for role=staff", (kind) => {
    expect(resolveNotificationTarget(kind, { request_id: REQUEST_ID }, "staff"))
      .toBe(`/admin/lessons?lessonId=${REQUEST_ID}`);
  });

  it.each(kinds)("%s -> /admin/lessons for role=admin", (kind) => {
    expect(resolveNotificationTarget(kind, { request_id: REQUEST_ID }, "admin"))
      .toBe(`/admin/lessons?lessonId=${REQUEST_ID}`);
  });
});

describe("structured target wins over stale legacy target_path — the exact real-world Lesson case", () => {
  it("a Pro-facing lesson row still carrying the stale '/events?tab=lessons' target_path resolves to the canonical /admin/lessons?lessonId=, never the stale page-level path", () => {
    const metadata = { request_id: REQUEST_ID, target_path: "/events?tab=lessons" };
    expect(resolveNotificationTarget("lesson_request_received", metadata, "pro"))
      .toBe(`/admin/lessons?lessonId=${REQUEST_ID}`);
  });

  it("a Member-facing lesson row still carrying the stale '/lessons' target_path resolves to the canonical /my-schedule path", () => {
    const metadata = { request_id: REQUEST_ID, target_path: "/lessons" };
    expect(resolveNotificationTarget("lesson_request_declined", metadata, "member"))
      .toBe(`/my-schedule?tab=lessons&request_id=${REQUEST_ID}`);
  });
});

describe("legacy rows with no structured target at all still navigate via a safe target_path", () => {
  it("a pre-Phase-36A row (target_path only, no request_id) still opens the legacy page", () => {
    expect(resolveNotificationTarget("lesson_request_declined", { target_path: "/lessons" }, "member"))
      .toBe("/lessons");
  });
});

describe("unsafe legacy target_path is non-navigable", () => {
  it("an absolute URL never becomes a navigation target", () => {
    expect(resolveNotificationTarget("announcement", { target_path: "https://evil.example/x" }, "member"))
      .toBeNull();
  });
});

describe("no target at all remains informational, never null-pointer/throws", () => {
  it("a row with empty metadata resolves to null", () => {
    expect(resolveNotificationTarget("reservation_confirmed", {}, "member")).toBeNull();
    expect(resolveNotificationTarget("reservation_confirmed", null, "member")).toBeNull();
  });

  it("announcement (title/sender_id/announcement_batch_id shape, no target_path) resolves to null — informational by design", () => {
    const metadata = { title: "Court closure", sender_id: "admin-1", announcement_batch_id: "batch-1" };
    expect(resolveNotificationTarget("announcement", metadata, "member")).toBeNull();
  });
});
