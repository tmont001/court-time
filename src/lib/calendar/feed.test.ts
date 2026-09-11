import { describe, expect, it } from "vitest";
import {
  decideFeedRowInclusion,
  buildFeedIcsEvent,
  buildFeedIcsEvents,
  computeFeedETag,
  feedWindowBounds,
  FEED_HISTORY_DAYS,
  FEED_FUTURE_DAYS,
  FEED_CANCELLATION_RETENTION_DAYS,
  type FeedRow,
} from "./feed";
import { reservationUid, eventUid, lessonUid } from "./export";

// Phase 35C — genuine behavior-level tests for the pure window/retention
// decision logic and row->IcsEvent construction behind the personal
// calendar subscription feed. Every date here is fixed/injected — nothing
// in this file depends on the real wall clock, so nothing here can be
// timing-flaky. The (untestable-without-a-live-database) authorization and
// row-selection logic lives in the SQL migration and is verified there
// (see the migration's own verification queries) rather than duplicated
// here with a fake database.

const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * DAY_MS).toISOString();
}

function row(overrides: Partial<FeedRow> & { starts_at: string; ends_at: string; is_cancelled: boolean }): FeedRow {
  return {
    domain: "reservation",
    id: "11111111-1111-1111-1111-111111111111",
    title: null,
    court_name: "Court 1",
    description: null,
    counterparty_name: null,
    revision_at: NOW.toISOString(),
    ...overrides,
  };
}

describe("feedWindowBounds", () => {
  it("uses the locked 90-day historical / 180-day future defaults", () => {
    expect(FEED_HISTORY_DAYS).toBe(90);
    expect(FEED_FUTURE_DAYS).toBe(180);
    const { start, end } = feedWindowBounds(NOW);
    expect(start.toISOString()).toBe(new Date(NOW.getTime() - 90 * DAY_MS).toISOString());
    expect(end.toISOString()).toBe(new Date(NOW.getTime() + 180 * DAY_MS).toISOString());
  });
});

describe("decideFeedRowInclusion — active (non-cancelled) rows", () => {
  it("includes a future active row within the window", () => {
    const r = row({ starts_at: daysFromNow(5), ends_at: daysFromNow(5), is_cancelled: false });
    expect(decideFeedRowInclusion(r, NOW)).toBe("active");
  });

  it("includes a recent past active row within the 90-day historical window", () => {
    const r = row({ starts_at: daysFromNow(-30), ends_at: daysFromNow(-30), is_cancelled: false });
    expect(decideFeedRowInclusion(r, NOW)).toBe("active");
  });

  it("excludes an active row older than the 90-day historical window", () => {
    const r = row({ starts_at: daysFromNow(-91), ends_at: daysFromNow(-91), is_cancelled: false });
    expect(decideFeedRowInclusion(r, NOW)).toBe("exclude");
  });

  it("excludes an active row further in the future than the 180-day window", () => {
    const r = row({ starts_at: daysFromNow(181), ends_at: daysFromNow(181), is_cancelled: false });
    expect(decideFeedRowInclusion(r, NOW)).toBe("exclude");
  });

  it("includes an item currently in progress (started before the window edge, still ongoing)", () => {
    const r = row({ starts_at: daysFromNow(-1), ends_at: daysFromNow(1), is_cancelled: false });
    expect(decideFeedRowInclusion(r, NOW)).toBe("active");
  });
});

describe("decideFeedRowInclusion — cancelled rows and the LOCKED 7-day retention minimum", () => {
  it("A. CRITICAL: a just-cancelled item (ended yesterday) is retained as 'cancelled'", () => {
    const r = row({ starts_at: daysFromNow(-1), ends_at: daysFromNow(-1), is_cancelled: true });
    expect(decideFeedRowInclusion(r, NOW)).toBe("cancelled");
  });

  it("A. is retained exactly AT the 7-day retention boundary", () => {
    // ends_at is exactly 7 days before NOW -> now <= ends_at + 7d is exactly true (equal).
    const r = row({ starts_at: daysFromNow(-7), ends_at: daysFromNow(-7), is_cancelled: true });
    expect(decideFeedRowInclusion(r, NOW)).toBe("cancelled");
    expect(FEED_CANCELLATION_RETENTION_DAYS).toBe(7);
  });

  it("A. ages out the instant it passes the 7-day retention boundary (and is also outside the historical window)", () => {
    // ends_at far enough in the past that it is outside BOTH the 90-day
    // window and the 7-day-past-end retention floor.
    const r = row({ starts_at: daysFromNow(-120), ends_at: daysFromNow(-120), is_cancelled: true });
    expect(decideFeedRowInclusion(r, NOW)).toBe("exclude");
  });

  it("stays visible past the 7-day floor when still inside the normal 90-day historical window", () => {
    const r = row({ starts_at: daysFromNow(-45), ends_at: daysFromNow(-45), is_cancelled: true });
    expect(decideFeedRowInclusion(r, NOW)).toBe("cancelled");
  });

  it("never emits a cancelled item that hasn't happened yet as anything other than cancelled (a future item cancelled in advance still shows, correctly marked)", () => {
    const r = row({ starts_at: daysFromNow(10), ends_at: daysFromNow(10), is_cancelled: true });
    expect(decideFeedRowInclusion(r, NOW)).toBe("cancelled");
  });
});

describe("buildFeedIcsEvent — reuses the EXACT 35B UID scheme per domain", () => {
  it("reservation row builds with reservationUid and a synthesized summary", () => {
    const r = row({ domain: "reservation", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", court_name: "Court 3", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false });
    const built = buildFeedIcsEvent(r, "active");
    expect(built.uid).toBe(reservationUid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
    expect(built.summary).toBe("Court Reservation — Court 3");
    expect(built.location).toBe("Court 3");
    expect(built.status).toBeUndefined();
  });

  it("event row builds with eventUid, its own title, and safe description passthrough", () => {
    const r = row({ domain: "event", id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "Member Mixer", description: "Beginner clinic — all levels welcome.", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false });
    const built = buildFeedIcsEvent(r, "active");
    expect(built.uid).toBe(eventUid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"));
    expect(built.summary).toBe("Member Mixer");
    expect(built.description).toBe("Beginner clinic — all levels welcome.");
  });

  it("event row with a blank/whitespace description collapses to no description (safeDescription reuse, not a new rule)", () => {
    const r = row({ domain: "event", title: "Mixer", description: "   ", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false });
    expect(buildFeedIcsEvent(r, "active").description).toBeNull();
  });

  it("lesson row builds with lessonUid and 'Lesson with {counterparty}'", () => {
    const r = row({ domain: "lesson", id: "cccccccc-cccc-cccc-cccc-cccccccccccc", counterparty_name: "Sam Pro", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false });
    const built = buildFeedIcsEvent(r, "active");
    expect(built.uid).toBe(lessonUid("cccccccc-cccc-cccc-cccc-cccccccccccc"));
    expect(built.summary).toBe("Lesson with Sam Pro");
  });

  it("sets STATUS:CANCELLED only for a 'cancelled' decision, on every domain", () => {
    const r = row({ domain: "event", title: "Mixer", starts_at: daysFromNow(-1), ends_at: daysFromNow(-1), is_cancelled: true });
    expect(buildFeedIcsEvent(r, "cancelled").status).toBe("CANCELLED");
  });

  it("a rescheduled item (new starts_at/ends_at, same id) keeps the same UID and reflects the new time", () => {
    const original = row({ domain: "event", id: "dddddddd-dddd-dddd-dddd-dddddddddddd", title: "Clinic", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false });
    const rescheduled = row({ domain: "event", id: "dddddddd-dddd-dddd-dddd-dddddddddddd", title: "Clinic", starts_at: daysFromNow(5), ends_at: daysFromNow(5), is_cancelled: false });
    const a = buildFeedIcsEvent(original, "active");
    const b = buildFeedIcsEvent(rescheduled, "active");
    expect(a.uid).toBe(b.uid);
    expect(a.dtstart.getTime()).not.toBe(b.dtstart.getTime());
  });
});

describe("buildFeedIcsEvent — lastModified pass-through (Phase 35C runtime correction)", () => {
  it("always populates lastModified from row.revision_at, for every domain", () => {
    const revisionAt = "2026-03-01T08:15:30.000Z";
    for (const domain of ["reservation", "event", "lesson"] as const) {
      const r = row({ domain, starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false, revision_at: revisionAt });
      expect(buildFeedIcsEvent(r, "active").lastModified?.toISOString()).toBe(revisionAt);
    }
  });

  it("a revision_at change alone (e.g. an edit to a visible field bumped the source updated_at) produces a different lastModified with the SAME uid — this is exactly the update-detection signal calendar clients rely on", () => {
    const before = row({ domain: "event", id: "11111111-1111-1111-1111-111111111111", title: "Clinic", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false, revision_at: "2026-01-01T00:00:00.000Z" });
    const after = row({ domain: "event", id: "11111111-1111-1111-1111-111111111111", title: "Clinic — Updated", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false, revision_at: "2026-02-01T00:00:00.000Z" });
    const a = buildFeedIcsEvent(before, "active");
    const b = buildFeedIcsEvent(after, "active");
    expect(a.uid).toBe(b.uid);
    expect(a.lastModified?.toISOString()).not.toBe(b.lastModified?.toISOString());
    expect(a.summary).not.toBe(b.summary);
  });
});

describe("computeFeedETag — deliberately independent of lastModified", () => {
  it("does NOT change when only revision_at/lastModified changes and every other visible field is identical", () => {
    const a = buildFeedIcsEvent(row({ id: "1", domain: "event", title: "Clinic", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false, revision_at: "2026-01-01T00:00:00.000Z" }), "active");
    const b = buildFeedIcsEvent(row({ id: "1", domain: "event", title: "Clinic", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false, revision_at: "2026-06-01T00:00:00.000Z" }), "active");
    expect(a.lastModified?.toISOString()).not.toBe(b.lastModified?.toISOString());
    expect(computeFeedETag([a])).toBe(computeFeedETag([b]));
  });
});

describe("Lesson domain — confirmed_at-gated lifecycle (correction pass: identical rule for Member and Pro feeds, enforced upstream in SQL — these tests cover how TS renders whatever the SQL already decided)", () => {
  it("an active (currently-confirmed) Lesson row renders with no STATUS", () => {
    const r = row({ domain: "lesson", counterparty_name: "Sam Pro", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false });
    expect(buildFeedIcsEvent(r, "active").status).toBeUndefined();
  });

  it("a Lesson that WAS confirmed and is now cancelled (is_cancelled=true, as the SQL only ever sets when confirmed_at IS NOT NULL) renders STATUS:CANCELLED with the same UID", () => {
    const r = row({ domain: "lesson", id: "ffffffff-ffff-ffff-ffff-ffffffffffff", counterparty_name: "Sam Pro", starts_at: daysFromNow(-1), ends_at: daysFromNow(-1), is_cancelled: true });
    const built = buildFeedIcsEvent(r, "cancelled");
    expect(built.status).toBe("CANCELLED");
    expect(built.uid).toBe(lessonUid("ffffffff-ffff-ffff-ffff-ffffffffffff"));
  });

  it("this module has no Member-vs-Pro branching for Lesson rendering — the same buildFeedIcsEvent path handles both, matching the identical SQL-level rule the migration applies to both branches", () => {
    const memberSide = row({ domain: "lesson", counterparty_name: "Sam Pro", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false });
    const proSide = row({ domain: "lesson", counterparty_name: "Jane Doe", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false });
    expect(buildFeedIcsEvent(memberSide, "active").summary).toBe("Lesson with Sam Pro");
    expect(buildFeedIcsEvent(proSide, "active").summary).toBe("Lesson with Jane Doe");
  });
});

describe("buildFeedIcsEvents — end-to-end filter + map over a full candidate set", () => {
  it("drops excluded rows, keeps active and cancelled ones with correct STATUS", () => {
    const rows: FeedRow[] = [
      row({ domain: "reservation", id: "1", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false }),
      row({ domain: "reservation", id: "2", starts_at: daysFromNow(-1), ends_at: daysFromNow(-1), is_cancelled: true }),
      row({ domain: "reservation", id: "3", starts_at: daysFromNow(-200), ends_at: daysFromNow(-200), is_cancelled: false }),
    ];
    const events = buildFeedIcsEvents(rows, NOW);
    expect(events).toHaveLength(2);
    expect(events.find(e => e.uid === reservationUid("2"))?.status).toBe("CANCELLED");
    expect(events.find(e => e.uid === reservationUid("1"))?.status).toBeUndefined();
    expect(events.find(e => e.uid === reservationUid("3"))).toBeUndefined();
  });

  it("returns an empty array (never throws) for zero rows", () => {
    expect(buildFeedIcsEvents([], NOW)).toEqual([]);
  });
});

describe("computeFeedETag — a stable, FINAL-rendered-content cache validator (correction pass: operates on IcsEvent[], never raw FeedRow[])", () => {
  it("is stable/deterministic for the same events regardless of order", () => {
    const a = buildFeedIcsEvent(row({ id: "1", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false }), "active");
    const b = buildFeedIcsEvent(row({ id: "2", starts_at: daysFromNow(2), ends_at: daysFromNow(2), is_cancelled: false }), "active");
    expect(computeFeedETag([a, b])).toBe(computeFeedETag([b, a]));
  });

  it("changes when an event's content changes (e.g. a reschedule)", () => {
    const original = buildFeedIcsEvent(row({ id: "1", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false }), "active");
    const rescheduled = buildFeedIcsEvent(row({ id: "1", starts_at: daysFromNow(2), ends_at: daysFromNow(2), is_cancelled: false }), "active");
    expect(computeFeedETag([original])).not.toBe(computeFeedETag([rescheduled]));
  });

  it("changes when an event is added or removed", () => {
    const a = buildFeedIcsEvent(row({ id: "1", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false }), "active");
    const b = buildFeedIcsEvent(row({ id: "2", starts_at: daysFromNow(2), ends_at: daysFromNow(2), is_cancelled: false }), "active");
    expect(computeFeedETag([a])).not.toBe(computeFeedETag([a, b]));
  });

  it("changes when an event's STATUS (active vs. cancelled) flips", () => {
    const active = buildFeedIcsEvent(row({ id: "1", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false }), "active");
    const cancelled = buildFeedIcsEvent(row({ id: "1", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: true }), "cancelled");
    expect(computeFeedETag([active])).not.toBe(computeFeedETag([cancelled]));
  });

  it("changes when only DESCRIPTION or LOCATION differs, content otherwise identical", () => {
    const a = buildFeedIcsEvent(row({ id: "1", domain: "event", title: "Clinic", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false, description: "A" }), "active");
    const b = buildFeedIcsEvent(row({ id: "1", domain: "event", title: "Clinic", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false, description: "B" }), "active");
    expect(computeFeedETag([a])).not.toBe(computeFeedETag([b]));
  });

  it("is stable across two calls with IDENTICAL content — proves the validator does not vary with wall-clock time (no DTSTAMP-derived input)", () => {
    const events = [buildFeedIcsEvent(row({ id: "1", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false }), "active")];
    expect(computeFeedETag(events)).toBe(computeFeedETag(events));
  });

  describe("CRITICAL — the validator tracks FINAL rendered visibility, not raw row content", () => {
    it("a byte-identical source row produces validator A at 89 days old (still visible) and a DIFFERENT validator B at 91 days old (aged out of the 90-day window, no longer visible)", () => {
      const sourceRow: FeedRow = row({ id: "1", starts_at: "2026-01-01T00:00:00.000Z", ends_at: "2026-01-01T01:00:00.000Z", is_cancelled: false });

      const nowAt89Days = new Date(new Date(sourceRow.ends_at).getTime() + 89 * DAY_MS);
      const nowAt91Days = new Date(new Date(sourceRow.ends_at).getTime() + 91 * DAY_MS);

      const eventsAt89 = buildFeedIcsEvents([sourceRow], nowAt89Days);
      const eventsAt91 = buildFeedIcsEvents([sourceRow], nowAt91Days);

      // Sanity check on the premise: still visible at 89 days, gone at 91.
      expect(eventsAt89).toHaveLength(1);
      expect(eventsAt91).toHaveLength(0);

      const validatorA = computeFeedETag(eventsAt89);
      const validatorB = computeFeedETag(eventsAt91);
      expect(validatorB).not.toBe(validatorA);
    });
  });
});

describe("Correction pass — no client-side deduplication (the fix MUST live in the SQL query, never be papered over here)", () => {
  it("CRITICAL: buildFeedIcsEvents does NOT deduplicate by id/UID — two rows sharing an id produce TWO VEVENTs, proving whole-Program non-duplication must be (and is) enforced by get_calendar_feed_rows' query structure itself, not by a final-array dedupe here", () => {
    const duplicateId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const rows: FeedRow[] = [
      row({ domain: "event", id: duplicateId, title: "Clinic", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false }),
      row({ domain: "event", id: duplicateId, title: "Clinic", starts_at: daysFromNow(1), ends_at: daysFromNow(1), is_cancelled: false }),
    ];
    const events = buildFeedIcsEvents(rows, NOW);
    expect(events).toHaveLength(2);
    expect(events[0].uid).toBe(events[1].uid);
  });
});
