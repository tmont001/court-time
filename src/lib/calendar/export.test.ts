import { describe, expect, it } from "vitest";
import {
  isReservationExportEligible,
  isReservationOwnedByViewer,
  canExportReservationForRole,
  buildReservationIcsEvent,
  reservationUid,
  isEventExportEligible,
  buildEventIcsEvent,
  buildEventSummary,
  eventUid,
  resolveLocation,
  isLessonExportEligible,
  resolveLessonCounterparty,
  formatLessonSummary,
  fullDisplayName,
  buildLessonIcsEvent,
  lessonUid,
  isProgramExportEligible,
  canOperatorExportProgramSchedule,
  canMemberExportProgramSchedule,
  buildProgramOccurrenceIcsEvents,
  isProgramOccurrenceExportEligible,
  safeDescription,
} from "./export";

// Phase 35B — genuine behavior-level tests for the pure eligibility/
// authorization/construction logic behind the one-off "Add to Calendar"
// feature. These call the real exported functions with plain data and
// assert on their return values; the (untestable-without-a-live-RLS-
// database) route glue is covered separately and minimally in route.test.ts.
//
// Correction pass (post-35B review): every eligibility function that now
// takes a `now` parameter is always called here with an explicit, fixed
// Date — nothing in this file depends on the real wall clock, so nothing
// here can ever be timing-flaky.

const NOW = new Date("2026-06-01T12:00:00.000Z");
const PAST = new Date("2026-05-01T12:00:00.000Z");
const FUTURE = new Date("2026-07-01T12:00:00.000Z");

describe("Reservation — eligibility (only a confirmed, not-yet-finished member_booking is exportable)", () => {
  it("a confirmed, future member_booking is eligible", () => {
    expect(isReservationExportEligible({ status: "confirmed", reason: "member_booking", ends_at: FUTURE.toISOString() }, NOW)).toBe(true);
  });

  it("a confirmed member_booking currently in progress (starts in the past, ends in the future) is eligible", () => {
    expect(isReservationExportEligible({ status: "confirmed", reason: "member_booking", ends_at: FUTURE.toISOString() }, NOW)).toBe(true);
  });

  it("a confirmed member_booking that has already ended is NOT eligible", () => {
    expect(isReservationExportEligible({ status: "confirmed", reason: "member_booking", ends_at: PAST.toISOString() }, NOW)).toBe(false);
  });

  it("a pending member_booking is not eligible", () => {
    expect(isReservationExportEligible({ status: "pending", reason: "member_booking", ends_at: FUTURE.toISOString() }, NOW)).toBe(false);
  });

  it("a cancelled member_booking is not eligible", () => {
    expect(isReservationExportEligible({ status: "cancelled", reason: "member_booking", ends_at: FUTURE.toISOString() }, NOW)).toBe(false);
  });

  it("a confirmed, future reservation with any other reason (event/pro_lesson/maintenance/admin_block) is not eligible via this domain", () => {
    for (const reason of ["event", "pro_lesson", "maintenance", "admin_block"]) {
      expect(isReservationExportEligible({ status: "confirmed", reason, ends_at: FUTURE.toISOString() }, NOW)).toBe(false);
    }
  });

  it("builds a stable UID and correct dtstart/dtend/summary/location", () => {
    const event = buildReservationIcsEvent(
      { id: "11111111-1111-1111-1111-111111111111", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2026-06-01T15:00:00.000Z" },
      "Court 3",
    );
    expect(event.uid).toBe(reservationUid("11111111-1111-1111-1111-111111111111"));
    expect(event.dtstart.toISOString()).toBe("2026-06-01T14:00:00.000Z");
    expect(event.dtend.toISOString()).toBe("2026-06-01T15:00:00.000Z");
    expect(event.summary).toBe("Court Reservation — Court 3");
    expect(event.location).toBe("Court 3");
  });
});

describe("Reservation — ownership (Member/Pro own-only; Admin/Staff unrestricted)", () => {
  const reservation = { owner_user_id: "member-1", roster_member_id: null };
  const rosterReservation = { owner_user_id: null, roster_member_id: "roster-1" };

  it("isReservationOwnedByViewer matches on owner_user_id", () => {
    expect(isReservationOwnedByViewer(reservation, { id: "member-1", rosterMemberId: null })).toBe(true);
    expect(isReservationOwnedByViewer(reservation, { id: "someone-else", rosterMemberId: null })).toBe(false);
  });

  it("isReservationOwnedByViewer matches on the viewer's OWN current roster identity for a pre-claim booking (owner_user_id null)", () => {
    expect(isReservationOwnedByViewer(rosterReservation, { id: "member-1", rosterMemberId: "roster-1" })).toBe(true);
  });

  it("a different roster identity is NOT accepted", () => {
    expect(isReservationOwnedByViewer(rosterReservation, { id: "member-1", rosterMemberId: "roster-2" })).toBe(false);
    expect(isReservationOwnedByViewer(rosterReservation, { id: "member-1", rosterMemberId: null })).toBe(false);
  });

  it("a Member owning the reservation (by owner_user_id) is authorized", () => {
    expect(canExportReservationForRole("member", reservation, { id: "member-1", rosterMemberId: null })).toBe(true);
  });

  it("a Member owning the reservation (by roster identity, pre-claim) is authorized", () => {
    expect(canExportReservationForRole("member", rosterReservation, { id: "member-1", rosterMemberId: "roster-1" })).toBe(true);
  });

  it("a Member who does NOT own the reservation is NOT authorized", () => {
    expect(canExportReservationForRole("member", reservation, { id: "someone-else", rosterMemberId: null })).toBe(false);
  });

  it("a Pro owning the reservation is authorized", () => {
    expect(canExportReservationForRole("pro", reservation, { id: "member-1", rosterMemberId: null })).toBe(true);
  });

  it("a Pro who does not own an unrelated Member's reservation is NOT authorized", () => {
    expect(canExportReservationForRole("pro", reservation, { id: "pro-1", rosterMemberId: null })).toBe(false);
  });

  it("Admin is authorized for any same-club reservation regardless of ownership", () => {
    expect(canExportReservationForRole("admin", reservation, { id: "someone-else", rosterMemberId: null })).toBe(true);
  });

  it("Staff is authorized for any same-club reservation regardless of ownership", () => {
    expect(canExportReservationForRole("staff", reservation, { id: "someone-else", rosterMemberId: null })).toBe(true);
  });
});

describe("Event — eligibility (scheduled, not archived, not yet finished)", () => {
  it("a scheduled, non-archived, future event is eligible", () => {
    expect(isEventExportEligible({ status: "scheduled", archived_at: null, ends_at: FUTURE.toISOString() }, NOW)).toBe(true);
  });

  it("an event currently in progress is eligible", () => {
    expect(isEventExportEligible({ status: "scheduled", archived_at: null, ends_at: FUTURE.toISOString() }, NOW)).toBe(true);
  });

  it("an event that has already ended is NOT eligible", () => {
    expect(isEventExportEligible({ status: "scheduled", archived_at: null, ends_at: PAST.toISOString() }, NOW)).toBe(false);
  });

  it("a cancelled event is not eligible", () => {
    expect(isEventExportEligible({ status: "cancelled", archived_at: null, ends_at: FUTURE.toISOString() }, NOW)).toBe(false);
  });

  it("an archived event is not eligible even if its status is still scheduled and it hasn't ended", () => {
    expect(isEventExportEligible({ status: "scheduled", archived_at: "2026-01-01T00:00:00.000Z", ends_at: FUTURE.toISOString() }, NOW)).toBe(false);
  });

  it("a generated Program occurrence uses the SAME uid scheme as a standalone Event with that id — no second UID scheme", () => {
    const occurrenceId = "22222222-2222-2222-2222-222222222222";
    const built = buildEventIcsEvent(
      { id: occurrenceId, title: "Clinic — Week 3", starts_at: "2026-06-02T14:00:00.000Z", ends_at: "2026-06-02T15:00:00.000Z" },
      "Court 1",
    );
    expect(built.uid).toBe(eventUid(occurrenceId));
    expect(built.uid).toBe(`event-${occurrenceId}@court-time.app`);
    expect(built.description).toBeNull();
  });

  it("carries a provided description through unchanged when given one", () => {
    const built = buildEventIcsEvent(
      { id: "22222222-2222-2222-2222-222222222222", title: "Clinic — Week 3", starts_at: "2026-06-02T14:00:00.000Z", ends_at: "2026-06-02T15:00:00.000Z" },
      "Court 1",
      "Beginner clinic — all levels welcome.",
    );
    expect(built.description).toBe("Beginner clinic — all levels welcome.");
  });

  it("isProgramOccurrenceExportEligible is the identical rule as isEventExportEligible", () => {
    expect(isProgramOccurrenceExportEligible).toBe(isEventExportEligible);
  });

  it("standalone Event SUMMARY is prefixed with the Event Type label", () => {
    const built = buildEventIcsEvent(
      { id: "22222222-2222-2222-2222-222222222222", title: "Advanced Doubles Drill", starts_at: "2026-06-02T14:00:00.000Z", ends_at: "2026-06-02T15:00:00.000Z" },
      "Court 1",
      null,
      "Clinic",
    );
    expect(built.summary).toBe("Clinic — Advanced Doubles Drill");
  });

  it("a null Event Type label (or none given) leaves SUMMARY as the plain title, unaffected by this checkpoint", () => {
    const built = buildEventIcsEvent(
      { id: "22222222-2222-2222-2222-222222222222", title: "Advanced Doubles Drill", starts_at: "2026-06-02T14:00:00.000Z", ends_at: "2026-06-02T15:00:00.000Z" },
      "Court 1",
    );
    expect(built.summary).toBe("Advanced Doubles Drill");
  });

  it("stable UID is unaffected by whether an Event Type label is applied", () => {
    const occurrenceId = "22222222-2222-2222-2222-222222222222";
    const withLabel = buildEventIcsEvent(
      { id: occurrenceId, title: "Advanced Doubles Drill", starts_at: "2026-06-02T14:00:00.000Z", ends_at: "2026-06-02T15:00:00.000Z" },
      "Court 1",
      null,
      "Clinic",
    );
    const withoutLabel = buildEventIcsEvent(
      { id: occurrenceId, title: "Advanced Doubles Drill", starts_at: "2026-06-02T14:00:00.000Z", ends_at: "2026-06-02T15:00:00.000Z" },
      "Court 1",
    );
    expect(withLabel.uid).toBe(eventUid(occurrenceId));
    expect(withLabel.uid).toBe(withoutLabel.uid);
  });
});

describe("buildEventSummary — Event Type label prefixing, ONE-WAY duplicate-prefix suppression only", () => {
  it("prefixes with '<Label> — <Title>' when the title does not already carry the type", () => {
    expect(buildEventSummary("Advanced Doubles Drill", "Clinic")).toBe("Clinic — Advanced Doubles Drill");
    expect(buildEventSummary("Court Time vs. West Side", "League Match")).toBe("League Match — Court Time vs. West Side");
    expect(buildEventSummary("Friday Night Mixer", "Social")).toBe("Social — Friday Night Mixer");
    expect(buildEventSummary("Club Championships", "Tournament")).toBe("Tournament — Club Championships");
  });

  it("CRITICAL: leaves the title unchanged when it is effectively the same as the label (never 'Clinic — Clinic')", () => {
    expect(buildEventSummary("Clinic", "Clinic")).toBe("Clinic");
    expect(buildEventSummary("clinic", "Clinic")).toBe("clinic");
    expect(buildEventSummary("  Clinic  ", "clinic")).toBe("  Clinic  ");
  });

  it("CRITICAL: leaves the title unchanged when it already begins with the COMPLETE label followed by a real boundary (whitespace, colon, or dash)", () => {
    expect(buildEventSummary("Clinic — Advanced Doubles Drill", "Clinic")).toBe("Clinic — Advanced Doubles Drill");
    expect(buildEventSummary("Clinic: Advanced Doubles Drill", "Clinic")).toBe("Clinic: Advanced Doubles Drill");
    expect(buildEventSummary("Clinic-Advanced Doubles Drill", "Clinic")).toBe("Clinic-Advanced Doubles Drill");
    expect(buildEventSummary("SOCIAL Friday Night Mixer", "Social")).toBe("SOCIAL Friday Night Mixer");
  });

  it("CRITICAL (one-way rule, exact locked examples): a title merely OVERLAPPING the front of a longer label is NOT treated as already prefixed — suppression is never based on the label starting with the title", () => {
    // "League Match" starts with "League", but "League" the title is NOT
    // already type-prefixed just because of that — it still gets prefixed.
    expect(buildEventSummary("League", "League Match")).toBe("League Match — League");
  });

  it("CRITICAL: a title that merely overlaps the label with no real word boundary (e.g. 'Clinical' is a different word than 'Clinic') is NOT suppressed", () => {
    expect(buildEventSummary("Clinical Trial Info Session", "Clinic")).toBe("Clinic — Clinical Trial Info Session");
  });

  it("returns the title unchanged when the label is null, undefined, or blank", () => {
    expect(buildEventSummary("Advanced Doubles Drill", null)).toBe("Advanced Doubles Drill");
    expect(buildEventSummary("Advanced Doubles Drill", undefined)).toBe("Advanced Doubles Drill");
    expect(buildEventSummary("Advanced Doubles Drill", "   ")).toBe("Advanced Doubles Drill");
  });

  it("does not suppress prefixing merely because the label reappears as a substring elsewhere in the title", () => {
    expect(buildEventSummary("Weekend Clinic Series", "Clinic")).toBe("Clinic — Weekend Clinic Series");
  });
});

describe("resolveLocation — court name joining", () => {
  it("returns null for no court ids", () => {
    expect(resolveLocation([], new Map())).toBeNull();
  });

  it("joins multiple distinct court names in order", () => {
    const nameById = new Map([["a", "Court 1"], ["b", "Court 2"]]);
    expect(resolveLocation(["a", "b"], nameById)).toBe("Court 1, Court 2");
  });

  it("deduplicates repeated court ids", () => {
    const nameById = new Map([["a", "Court 1"]]);
    expect(resolveLocation(["a", "a", "a"], nameById)).toBe("Court 1");
  });

  it("silently skips a court id with no known name (dangling/malformed reference) rather than crashing or emitting 'undefined'", () => {
    const nameById = new Map([["a", "Court 1"]]);
    expect(resolveLocation(["a", "missing"], nameById)).toBe("Court 1");
    expect(resolveLocation(["missing"], nameById)).toBeNull();
  });
});

describe("Lesson — eligibility (confirmed, resolved time, not yet finished)", () => {
  it("a confirmed, future lesson with both proposed times is eligible", () => {
    expect(
      isLessonExportEligible({ status: "confirmed", proposed_starts_at: PAST.toISOString(), proposed_ends_at: FUTURE.toISOString() }, NOW),
    ).toBe(true);
  });

  it("a confirmed lesson that has already ended is NOT eligible", () => {
    expect(
      isLessonExportEligible({ status: "confirmed", proposed_starts_at: PAST.toISOString(), proposed_ends_at: PAST.toISOString() }, NOW),
    ).toBe(false);
  });

  it("pending/proposed/declined/withdrawn/cancelled are not eligible", () => {
    for (const status of ["pending", "proposed", "declined", "withdrawn", "cancelled"]) {
      expect(
        isLessonExportEligible({ status, proposed_starts_at: PAST.toISOString(), proposed_ends_at: FUTURE.toISOString() }, NOW),
      ).toBe(false);
    }
  });

  it("defensively excludes a 'confirmed' row missing a resolved time (malformed schedule data)", () => {
    expect(isLessonExportEligible({ status: "confirmed", proposed_starts_at: null, proposed_ends_at: FUTURE.toISOString() }, NOW)).toBe(false);
    expect(isLessonExportEligible({ status: "confirmed", proposed_starts_at: PAST.toISOString(), proposed_ends_at: null }, NOW)).toBe(false);
  });
});

describe("Lesson — counterparty resolution and SUMMARY (never phone/email/notes)", () => {
  const lesson = { member_id: "member-1", pro_id: "pro-1" };

  it("the pro viewing sees the member's name", () => {
    expect(resolveLessonCounterparty("pro-1", lesson)).toBe("member");
  });

  it("the member viewing sees the pro's name", () => {
    expect(resolveLessonCounterparty("member-1", lesson)).toBe("pro");
  });

  it("a viewer who is neither party (Admin/Staff, the only way RLS could have let the row through) sees both names", () => {
    expect(resolveLessonCounterparty("admin-1", lesson)).toBe("both");
  });

  it("a null member_id (no-account Member) never matches the viewer, and correctly falls to 'both'", () => {
    expect(resolveLessonCounterparty("admin-1", { member_id: null, pro_id: "pro-1" })).toBe("both");
  });

  it("formats each counterparty case correctly", () => {
    const names = { memberName: "Jane Doe", proName: "Sam Pro" };
    expect(formatLessonSummary("member", names)).toBe("Lesson with Jane Doe");
    expect(formatLessonSummary("pro", names)).toBe("Lesson with Sam Pro");
    expect(formatLessonSummary("both", names)).toBe("Lesson: Jane Doe with Sam Pro");
  });

  it("builds the ICS event with the resolved summary/location and a stable uid, with no description by default", () => {
    const built = buildLessonIcsEvent(
      { id: "33333333-3333-3333-3333-333333333333", proposed_starts_at: "2026-06-03T14:00:00.000Z", proposed_ends_at: "2026-06-03T15:00:00.000Z" },
      "Lesson with Sam Pro",
      "Court 2",
    );
    expect(built.uid).toBe(lessonUid("33333333-3333-3333-3333-333333333333"));
    expect(built.summary).toBe("Lesson with Sam Pro");
    expect(built.location).toBe("Court 2");
    expect(built.description).toBeNull();
  });

  it("carries a provided member_note-derived description through unchanged", () => {
    const built = buildLessonIcsEvent(
      { id: "33333333-3333-3333-3333-333333333333", proposed_starts_at: "2026-06-03T14:00:00.000Z", proposed_ends_at: "2026-06-03T15:00:00.000Z" },
      "Lesson with Sam Pro",
      "Court 2",
      "Working on my backhand today.",
    );
    expect(built.description).toBe("Working on my backhand today.");
  });
});

describe("fullDisplayName — never leaks phone/email, always a safe fallback", () => {
  it("joins first and last name", () => {
    expect(fullDisplayName({ first_name: "Jane", last_name: "Doe" })).toBe("Jane Doe");
  });

  it("falls back gracefully when only one name part is present", () => {
    expect(fullDisplayName({ first_name: "Jane", last_name: null })).toBe("Jane");
    expect(fullDisplayName({ first_name: null, last_name: "Doe" })).toBe("Doe");
  });

  it("falls back to a generic label when both parts are missing", () => {
    expect(fullDisplayName({ first_name: null, last_name: null })).toBe("Court Time Member");
  });

  it("falls back to the same generic label when the profile itself could not be resolved (e.g. RLS denied it)", () => {
    expect(fullDisplayName(null)).toBe("Court Time Member");
  });
});

describe("Program — parent-row eligibility", () => {
  it("a cancelled program is not eligible regardless of archival", () => {
    expect(isProgramExportEligible({ status: "cancelled", archived_at: null })).toBe(false);
  });

  it("an archived program is not eligible even if not cancelled", () => {
    expect(isProgramExportEligible({ status: "active", archived_at: "2026-01-01T00:00:00Z" })).toBe(false);
  });

  it("draft/active/completed, non-archived programs are eligible", () => {
    for (const status of ["draft", "active", "completed"]) {
      expect(isProgramExportEligible({ status, archived_at: null })).toBe(true);
    }
  });
});

describe("Program — operator authorization (Admin/Staff unrestricted; Pro scoped to programs they created)", () => {
  const program = { created_by: "pro-1" };

  it("Admin is authorized regardless of who created the program", () => {
    expect(canOperatorExportProgramSchedule("admin", program, "someone-else")).toBe(true);
  });

  it("Staff is authorized regardless of who created the program", () => {
    expect(canOperatorExportProgramSchedule("staff", program, "someone-else")).toBe(true);
  });

  it("the creator Pro is authorized", () => {
    expect(canOperatorExportProgramSchedule("pro", program, "pro-1")).toBe(true);
  });

  it("CRITICAL: a non-creator Pro is NOT authorized, even though raw RLS row-visibility for Pro is club-wide", () => {
    expect(canOperatorExportProgramSchedule("pro", program, "pro-2")).toBe(false);
  });

  it("a plain Member is never an authorized operator for this export", () => {
    expect(canOperatorExportProgramSchedule("member", program, "member-1")).toBe(false);
  });
});

describe("Program — Member whole-program enrollment authorization", () => {
  it("a whole-program ('program' enrollment_model) Member with status='enrolled' is authorized", () => {
    expect(canMemberExportProgramSchedule("program", "enrolled")).toBe(true);
  });

  it("a whole-program Member who is only waitlisted/offered/cancelled/never-enrolled is NOT authorized — none of those is a confirmed calendar commitment", () => {
    expect(canMemberExportProgramSchedule("program", "waitlisted")).toBe(false);
    expect(canMemberExportProgramSchedule("program", "offered")).toBe(false);
    expect(canMemberExportProgramSchedule("program", "cancelled")).toBe(false);
    expect(canMemberExportProgramSchedule("program", null)).toBe(false);
  });

  it("CRITICAL: a per_session-enrolled Member never receives the parent Program's full occurrence schedule, even if somehow 'enrolled' were set on a stray row", () => {
    expect(canMemberExportProgramSchedule("per_session", "enrolled")).toBe(false);
  });

  it("an admin_managed program's Member is never authorized for the parent-level export either", () => {
    expect(canMemberExportProgramSchedule("admin_managed", "enrolled")).toBe(false);
  });
});

describe("Program — occurrence-to-VEVENT mapping", () => {
  it("maps each occurrence through the same eventUid scheme, with its resolved location or null", () => {
    const occurrences = [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", title: "Week 1", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2026-06-01T15:00:00.000Z" },
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "Week 2", starts_at: "2026-06-08T14:00:00.000Z", ends_at: "2026-06-08T15:00:00.000Z" },
    ];
    const locationByEventId = new Map<string, string | null>([
      ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Court 1"],
      // second occurrence has no resolvable location — must not crash
    ]);
    const built = buildProgramOccurrenceIcsEvents(occurrences, locationByEventId);
    expect(built).toHaveLength(2);
    expect(built[0].uid).toBe(eventUid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
    expect(built[0].location).toBe("Court 1");
    expect(built[1].uid).toBe(eventUid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"));
    expect(built[1].location).toBeNull();
  });

  it("maps zero occurrences to zero events", () => {
    expect(buildProgramOccurrenceIcsEvents([], new Map())).toEqual([]);
  });

  it("applies the SAME program description uniformly to every occurrence when provided", () => {
    const occurrences = [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", title: "Week 1", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2026-06-01T15:00:00.000Z" },
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "Week 2", starts_at: "2026-06-08T14:00:00.000Z", ends_at: "2026-06-08T15:00:00.000Z" },
    ];
    const built = buildProgramOccurrenceIcsEvents(occurrences, new Map(), "Beginner clinic — all levels welcome.");
    expect(built[0].description).toBe("Beginner clinic — all levels welcome.");
    expect(built[1].description).toBe("Beginner clinic — all levels welcome.");
  });

  it("leaves description null on every occurrence when the program has none", () => {
    const occurrences = [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", title: "Week 1", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2026-06-01T15:00:00.000Z" },
    ];
    const built = buildProgramOccurrenceIcsEvents(occurrences, new Map());
    expect(built[0].description).toBeNull();
  });

  it("Program occurrence SUMMARY is prefixed with each occurrence's OWN Event Type label, resolved per-occurrence rather than assumed uniform", () => {
    const occurrences = [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", title: "Week 1", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2026-06-01T15:00:00.000Z" },
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "Week 2", starts_at: "2026-06-08T14:00:00.000Z", ends_at: "2026-06-08T15:00:00.000Z" },
    ];
    const typeLabelByEventId = new Map<string, string | null>([
      ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Clinic"],
      // second occurrence has no resolvable type label — must not crash
    ]);
    const built = buildProgramOccurrenceIcsEvents(occurrences, new Map(), null, typeLabelByEventId);
    expect(built[0].summary).toBe("Clinic — Week 1");
    expect(built[1].summary).toBe("Week 2");
    expect(built[0].uid).toBe(eventUid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
    expect(built[1].uid).toBe(eventUid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"));
  });

  it("omitting typeLabelByEventId entirely leaves every occurrence's SUMMARY as the plain title (backward compatible)", () => {
    const occurrences = [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", title: "Week 1", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2026-06-01T15:00:00.000Z" },
    ];
    const built = buildProgramOccurrenceIcsEvents(occurrences, new Map());
    expect(built[0].summary).toBe("Week 1");
  });
});

describe("safeDescription — the one place empty/whitespace text collapses to 'no description'", () => {
  it("returns trimmed text unchanged", () => {
    expect(safeDescription("  Bring extra balls.  ")).toBe("Bring extra balls.");
  });

  it("returns null for null, undefined, empty, or whitespace-only text", () => {
    expect(safeDescription(null)).toBeNull();
    expect(safeDescription(undefined)).toBeNull();
    expect(safeDescription("")).toBeNull();
    expect(safeDescription("   ")).toBeNull();
  });

  it("preserves internal newlines/multiline content (only leading/trailing whitespace is trimmed)", () => {
    expect(safeDescription("Line one.\nLine two.")).toBe("Line one.\nLine two.");
  });
});

describe("Program — current/future occurrence filtering (using isProgramOccurrenceExportEligible directly)", () => {
  it("excludes a past occurrence", () => {
    expect(isProgramOccurrenceExportEligible({ status: "scheduled", archived_at: null, ends_at: PAST.toISOString() }, NOW)).toBe(false);
  });

  it("includes an occurrence currently in progress (started in the past, ends in the future)", () => {
    expect(isProgramOccurrenceExportEligible({ status: "scheduled", archived_at: null, ends_at: FUTURE.toISOString() }, NOW)).toBe(true);
  });

  it("includes a future occurrence", () => {
    expect(isProgramOccurrenceExportEligible({ status: "scheduled", archived_at: null, ends_at: FUTURE.toISOString() }, NOW)).toBe(true);
  });

  it("still excludes a cancelled or archived occurrence regardless of timing", () => {
    expect(isProgramOccurrenceExportEligible({ status: "cancelled", archived_at: null, ends_at: FUTURE.toISOString() }, NOW)).toBe(false);
    expect(isProgramOccurrenceExportEligible({ status: "scheduled", archived_at: "2026-01-01T00:00:00Z", ends_at: FUTURE.toISOString() }, NOW)).toBe(false);
  });
});
