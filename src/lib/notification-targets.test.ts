import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_TARGET_MAP,
  resolveNotificationTarget,
  getSafeTargetPath,
  type NotificationKind,
} from "./notification-targets";

const RESERVATION_ID = "11111111-1111-1111-1111-111111111111";
const EVENT_ID       = "22222222-2222-2222-2222-222222222222";
const REQUEST_ID     = "33333333-3333-3333-3333-333333333333";

const ALL_KINDS: NotificationKind[] = [
  "reservation_confirmed",
  "reservation_cancelled_by_admin",
  "reservation_cancelled_by_member",
  "reservation_rescheduled",
  "event_cancelled",
  "event_joined",
  "event_updated",
  "waitlist_promoted",
  "waitlist_offer",
  "announcement",
  "lesson_request_received",
  "lesson_request_proposed",
  "lesson_request_confirmed",
  "lesson_request_declined",
  "lesson_cancelled",
  "lesson_provider_reassigned",
  "lesson_admin_requested",
  "refund_request_rejected",
  "refund_request_completed",
];

describe("NOTIFICATION_TARGET_MAP", () => {
  it("has an explicit entry for exactly the 19 authoritative kinds", () => {
    expect(Object.keys(NOTIFICATION_TARGET_MAP).sort()).toEqual([...ALL_KINDS].sort());
    expect(Object.keys(NOTIFICATION_TARGET_MAP)).toHaveLength(19);
  });
});

describe("resolveNotificationTarget — reservation kinds", () => {
  const RESERVATION_KINDS: NotificationKind[] = [
    "reservation_confirmed",
    "reservation_cancelled_by_admin",
    "reservation_cancelled_by_member",
    "reservation_rescheduled",
  ];

  it.each(RESERVATION_KINDS)("%s resolves to the canonical reservation path for every role", (kind) => {
    const metadata = { reservation_id: RESERVATION_ID };
    expect(resolveNotificationTarget(kind, metadata, "member")).toBe(`/calendar?reservation=${RESERVATION_ID}`);
    expect(resolveNotificationTarget(kind, metadata, "pro")).toBe(`/calendar?reservation=${RESERVATION_ID}`);
    expect(resolveNotificationTarget(kind, metadata, "staff")).toBe(`/calendar?reservation=${RESERVATION_ID}`);
    expect(resolveNotificationTarget(kind, metadata, "admin")).toBe(`/calendar?reservation=${RESERVATION_ID}`);
  });
});

describe("resolveNotificationTarget — event/waitlist kinds", () => {
  const EVENT_KINDS: NotificationKind[] = [
    "event_cancelled",
    "event_joined",
    "event_updated",
    "waitlist_promoted",
    "waitlist_offer",
  ];

  it.each(EVENT_KINDS)("%s resolves to the canonical event path for every role", (kind) => {
    const metadata = { event_id: EVENT_ID };
    expect(resolveNotificationTarget(kind, metadata, "member")).toBe(`/calendar?event=${EVENT_ID}`);
    expect(resolveNotificationTarget(kind, metadata, "pro")).toBe(`/calendar?event=${EVENT_ID}`);
    expect(resolveNotificationTarget(kind, metadata, "staff")).toBe(`/calendar?event=${EVENT_ID}`);
    expect(resolveNotificationTarget(kind, metadata, "admin")).toBe(`/calendar?event=${EVENT_ID}`);
  });
});

describe("resolveNotificationTarget — waitlist_offer is polymorphic (Phase 36C: event_id OR program_id)", () => {
  const PROGRAM_ID = "44444444-4444-4444-4444-444444444444";

  it("resolves to the canonical Event path when metadata carries a valid event_id", () => {
    expect(resolveNotificationTarget("waitlist_offer", { event_id: EVENT_ID }, "member"))
      .toBe(`/calendar?event=${EVENT_ID}`);
  });

  it("resolves to the whole-Program enrollment target when metadata carries a valid program_id instead", () => {
    expect(resolveNotificationTarget("waitlist_offer", { program_id: PROGRAM_ID }, "member"))
      .toBe(`/events?program=${PROGRAM_ID}`);
  });

  it("event_id wins when both are present", () => {
    const metadata = { event_id: EVENT_ID, program_id: PROGRAM_ID };
    expect(resolveNotificationTarget("waitlist_offer", metadata, "member")).toBe(`/calendar?event=${EVENT_ID}`);
  });

  it("falls through to the program target when event_id is present but malformed", () => {
    const metadata = { event_id: "not-a-uuid", program_id: PROGRAM_ID };
    expect(resolveNotificationTarget("waitlist_offer", metadata, "member")).toBe(`/events?program=${PROGRAM_ID}`);
  });

  it("falls through to the safe legacy target_path when both event_id and program_id are missing/malformed", () => {
    expect(resolveNotificationTarget("waitlist_offer", { target_path: "/events" }, "member")).toBe("/events");
    expect(resolveNotificationTarget("waitlist_offer", {}, "member")).toBeNull();
    expect(resolveNotificationTarget("waitlist_offer", { event_id: "bad", program_id: "also-bad" }, "member"))
      .toBeNull();
  });

  it("the program target is role-agnostic — every role resolves to the same /events?program= path", () => {
    const metadata = { program_id: PROGRAM_ID };
    expect(resolveNotificationTarget("waitlist_offer", metadata, "member")).toBe(`/events?program=${PROGRAM_ID}`);
    expect(resolveNotificationTarget("waitlist_offer", metadata, "pro")).toBe(`/events?program=${PROGRAM_ID}`);
    expect(resolveNotificationTarget("waitlist_offer", metadata, "admin")).toBe(`/events?program=${PROGRAM_ID}`);
  });

  it("waitlist_promoted is unchanged — it stays event_id-only, never falls back to program_id", () => {
    expect(resolveNotificationTarget("waitlist_promoted", { program_id: PROGRAM_ID }, "member")).toBeNull();
  });
});

describe("resolveNotificationTarget — lesson kinds are role-aware", () => {
  const LESSON_KINDS: NotificationKind[] = [
    "lesson_request_received",
    "lesson_request_proposed",
    "lesson_request_confirmed",
    "lesson_request_declined",
    "lesson_cancelled",
    "lesson_provider_reassigned",
    "lesson_admin_requested",
  ];

  it.each(LESSON_KINDS)("%s sends Member to the Member-facing lesson surface", (kind) => {
    const metadata = { request_id: REQUEST_ID };
    expect(resolveNotificationTarget(kind, metadata, "member"))
      .toBe(`/my-schedule?tab=lessons&request_id=${REQUEST_ID}`);
  });

  it.each(LESSON_KINDS)("%s sends Pro to the canonical staff lesson-management surface", (kind) => {
    const metadata = { request_id: REQUEST_ID };
    expect(resolveNotificationTarget(kind, metadata, "pro")).toBe(`/admin/lessons?lessonId=${REQUEST_ID}`);
  });

  it.each(LESSON_KINDS)("%s sends Staff to the canonical staff lesson-management surface", (kind) => {
    const metadata = { request_id: REQUEST_ID };
    expect(resolveNotificationTarget(kind, metadata, "staff")).toBe(`/admin/lessons?lessonId=${REQUEST_ID}`);
  });

  it.each(LESSON_KINDS)("%s sends Admin to the canonical staff lesson-management surface", (kind) => {
    const metadata = { request_id: REQUEST_ID };
    expect(resolveNotificationTarget(kind, metadata, "admin")).toBe(`/admin/lessons?lessonId=${REQUEST_ID}`);
  });
});

describe("resolveNotificationTarget — announcement (informational, no structured target)", () => {
  it("resolves to null when there is no legacy target_path", () => {
    expect(resolveNotificationTarget("announcement", { title: "Court closure", sender_id: "x" }, "member"))
      .toBeNull();
  });

  it("still honors a legacy target_path if one happened to be present", () => {
    expect(resolveNotificationTarget("announcement", { target_path: "/events" }, "member")).toBe("/events");
  });
});

describe("resolveNotificationTarget — refund_request_rejected / refund_request_completed (Phase 38B, no structured target)", () => {
  it("both map to null in NOTIFICATION_TARGET_MAP — no structured payment domain is introduced in this phase", () => {
    expect(NOTIFICATION_TARGET_MAP.refund_request_rejected).toBeNull();
    expect(NOTIFICATION_TARGET_MAP.refund_request_completed).toBeNull();
  });

  it("safely deep-link to /admin/payments via the existing target_path fallback — the exact producer-set metadata shape", () => {
    expect(resolveNotificationTarget("refund_request_rejected", { request_id: REQUEST_ID, target_path: "/admin/payments" }, "staff"))
      .toBe("/admin/payments");
    expect(resolveNotificationTarget("refund_request_completed", { request_id: REQUEST_ID, target_path: "/admin/payments" }, "staff"))
      .toBe("/admin/payments");
  });

  it("resolve to null when no target_path is present — never fabricates a destination", () => {
    expect(resolveNotificationTarget("refund_request_rejected", { request_id: REQUEST_ID }, "staff")).toBeNull();
    expect(resolveNotificationTarget("refund_request_completed", { request_id: REQUEST_ID }, "staff")).toBeNull();
  });

  it("role-agnostic — the null-domain fallback behaves identically regardless of viewer role", () => {
    for (const role of ["admin", "staff", "pro", "member", null, undefined]) {
      expect(resolveNotificationTarget("refund_request_completed", { target_path: "/admin/payments" }, role))
        .toBe("/admin/payments");
    }
  });
});

describe("resolveNotificationTarget — legacy target_path fallback", () => {
  it("falls back to a safe legacy target_path when the structured id is missing", () => {
    expect(resolveNotificationTarget("reservation_confirmed", { target_path: "/calendar" }, "member"))
      .toBe("/calendar");
  });

  it("falls back to a safe legacy target_path when the structured id is malformed", () => {
    const metadata = { reservation_id: "not-a-uuid", target_path: "/calendar" };
    expect(resolveNotificationTarget("reservation_confirmed", metadata, "member")).toBe("/calendar");
  });

  it("returns null when the structured id is missing and there is no legacy target_path", () => {
    expect(resolveNotificationTarget("reservation_confirmed", {}, "member")).toBeNull();
    expect(resolveNotificationTarget("reservation_confirmed", null, "member")).toBeNull();
  });

  it("prefers the current staff destination over a stale legacy target_path pointing at the old duplicate page", () => {
    // Regression guard for the exact bug the Phase 36 audit found: pro-facing
    // lesson notifications' target_path still says '/events?tab=lessons'
    // (the deprecated duplicate of /admin/lessons). A valid structured id
    // must win over that stale value, not the other way around.
    const metadata = { request_id: REQUEST_ID, target_path: "/events?tab=lessons" };
    expect(resolveNotificationTarget("lesson_request_received", metadata, "pro"))
      .toBe(`/admin/lessons?lessonId=${REQUEST_ID}`);
  });
});

describe("resolveNotificationTarget — unsafe legacy target_path is rejected", () => {
  it("rejects an absolute URL", () => {
    expect(resolveNotificationTarget("announcement", { target_path: "http://evil.example/x" }, "member"))
      .toBeNull();
  });

  it("rejects a protocol-relative URL", () => {
    expect(resolveNotificationTarget("announcement", { target_path: "//evil.example/x" }, "member"))
      .toBeNull();
  });

  it("rejects a path containing a colon (protocol injection)", () => {
    expect(resolveNotificationTarget("announcement", { target_path: "/foo:javascript:alert(1)" }, "member"))
      .toBeNull();
  });

  it("rejects a non-string target_path", () => {
    expect(resolveNotificationTarget("announcement", { target_path: 12345 }, "member")).toBeNull();
  });
});

describe("resolveNotificationTarget — unknown/future kind fails safely", () => {
  it("never throws for a kind outside the known 17, and falls back to a safe legacy path if present", () => {
    expect(() => resolveNotificationTarget("some_future_kind", { target_path: "/somewhere" }, "member"))
      .not.toThrow();
    expect(resolveNotificationTarget("some_future_kind", { target_path: "/somewhere" }, "member"))
      .toBe("/somewhere");
  });

  it("returns null for an unknown kind with no legacy path", () => {
    expect(resolveNotificationTarget("some_future_kind", {}, "member")).toBeNull();
    expect(resolveNotificationTarget("some_future_kind", null, "member")).toBeNull();
  });
});

describe("getSafeTargetPath", () => {
  it("accepts a safe relative path", () => {
    expect(getSafeTargetPath({ target_path: "/lessons" })).toBe("/lessons");
  });

  it("returns null for null/non-object metadata", () => {
    expect(getSafeTargetPath(null)).toBeNull();
    expect(getSafeTargetPath("not-an-object" as unknown as null)).toBeNull();
  });
});
