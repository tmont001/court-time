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
];

describe("NOTIFICATION_TARGET_MAP", () => {
  it("has an explicit entry for exactly the 17 authoritative kinds", () => {
    expect(Object.keys(NOTIFICATION_TARGET_MAP).sort()).toEqual([...ALL_KINDS].sort());
    expect(Object.keys(NOTIFICATION_TARGET_MAP)).toHaveLength(17);
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
