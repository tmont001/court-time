import { describe, expect, it, vi, beforeEach } from "vitest";

// Phase 35B — behavior-level tests for the export route's own wiring: input
// validation, the Program domain's extra application-level authorization
// (the one place real logic beyond RLS lives in this route), the
// Reservation ownership correction, and full happy-path ICS content.
// getAuthProfile/createClient are mocked because they need a real Next.js
// request context (cookies()) and a real Postgres connection respectively —
// everything downstream of them here is exercised against a small
// in-memory fake Supabase client (see fakeQuery below), standing in for
// what RLS would filter in production.
//
// IMPORTANT SCOPE NOTE: reservation/event/lesson TENANT isolation ("can a
// different club see this row at all") is enforced entirely by the
// ALREADY-EXISTING, independently migration-tested RLS policies this route
// queries through (reservations_select_same_club — 0003/0123/0132;
// events_select_same_club — 0004/0123/0132; lesson_requests_select_member/
// _pro/_admin — 0069/0083/0132; programs_select_same_club — 0087/0123/0132;
// program_enrollments_select — 0087/0115/0168) — this route adds no
// club_id filter of its own for those three domains, so a fake in-memory
// table with no RLS engine cannot meaningfully prove cross-club isolation
// without reimplementing RLS as a second, parallel, drifting authorization
// system in the test double. Cross-USER ownership for Reservation, however,
// IS real application logic added in the correction pass below (Program
// authorization always was) — both are fully behavior-tested here.
//
// All eligibility checks use a fixed, injected `now` — nothing here reads
// the real wall clock, so nothing here can be timing-flaky.

const mockGetAuthProfile = vi.fn();
const mockCreateClient = vi.fn();

vi.mock("@/lib/supabase/user", () => ({
  getAuthProfile: () => mockGetAuthProfile(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));

import { GET } from "./route";

// A tiny in-memory stand-in for a supabase-js query builder: `.select()`/
// `.order()` are no-ops (this mock doesn't project columns), `.eq()`/`.in()`
// filter the seeded rows, `.or("col.eq.val,col2.eq.val2")` mirrors the one
// OR-shape this route ever builds (the durable-identity lookup), and the
// object itself is thenable (so an awaited builder with no terminal method
// — exactly how the route reads `courts` and the Program's `events`
// occurrence list — resolves the same way `.maybeSingle()` does).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeQuery(rows: any[]) {
  let filtered = [...rows];
  const builder = {
    select: () => builder,
    order: () => builder,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eq: (col: string, val: any) => {
      filtered = filtered.filter(r => r[col] === val);
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    in: (col: string, vals: any[]) => {
      filtered = filtered.filter(r => vals.includes(r[col]));
      return builder;
    },
    or: (expr: string) => {
      const clauses = expr.split(",").map(c => {
        const [col, , val] = c.split(".");
        return { col, val };
      });
      filtered = filtered.filter(r => clauses.some(({ col, val }) => String(r[col]) === val));
      return builder;
    },
    maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
    then: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolve: (value: { data: any[]; error: null }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: filtered, error: null }).then(resolve, reject),
  };
  return builder;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeSupabase(tables: Record<string, any[]>, rosterMemberId: string | null = null) {
  return {
    from: (table: string) => fakeQuery(tables[table] ?? []),
    rpc: async (name: string) => {
      if (name === "current_user_roster_member_id") return { data: rosterMemberId, error: null };
      return { data: null, error: null };
    },
  };
}

const VALID_ID = "11111111-1111-1111-1111-111111111111";

async function callGet(domain: string, id: string) {
  return GET(new Request(`http://localhost/api/calendar/export/${domain}/${id}`), {
    params: Promise.resolve({ domain, id }),
  });
}

beforeEach(() => {
  mockGetAuthProfile.mockReset();
  mockCreateClient.mockReset();
});

describe("input validation — never reaches the database for an invalid domain/id", () => {
  it("rejects a domain outside the strict allowlist with 404", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "u1", club_id: "c1", role: "member" });
    const res = await callGet("not-a-real-domain", VALID_ID);
    expect(res.status).toBe(404);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("rejects a malformed id with 404", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "u1", club_id: "c1", role: "member" });
    const res = await callGet("reservation", "not-a-uuid");
    expect(res.status).toBe(404);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("rejects a signed-out caller with 404", async () => {
    mockGetAuthProfile.mockResolvedValue(null);
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("rejects a caller with no active club with 404", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "u1", club_id: null, role: "member" });
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(404);
  });
});

describe("Reservation domain — happy path, historical exclusion, and ownership", () => {
  const futureReservation = {
    id: VALID_ID, court_id: "court-1", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2099-06-01T15:00:00.000Z",
    status: "confirmed", reason: "member_booking", owner_user_id: "member-1", roster_member_id: null,
  };
  const pastReservation = { ...futureReservation, ends_at: "2020-01-01T15:00:00.000Z" };

  it("returns a valid text/calendar response for the Member's own confirmed, future member_booking", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ reservations: [futureReservation], courts: [{ id: "court-1", name: "Court 3" }] }),
    );
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("court-time-reservation.ics");
    const body = await res.text();
    expect(body).toContain("SUMMARY:Court Reservation — Court 3");
    expect(body).toContain(`UID:reservation-${VALID_ID}@court-time.app`);
  });

  it("404s a reservation that has already ended", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ reservations: [pastReservation], courts: [{ id: "court-1", name: "Court 3" }] }),
    );
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("404s a maintenance-block reservation (not one-off-exportable in this checkpoint)", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ reservations: [{ ...futureReservation, reason: "maintenance" }], courts: [] }),
    );
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("404s a cancelled reservation", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ reservations: [{ ...futureReservation, status: "cancelled" }], courts: [] }),
    );
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("404s a nonexistent id", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase({ reservations: [], courts: [] }));
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("Member's own reservation via roster_member_id (pre-claim, owner_user_id null) succeeds", async () => {
    const rosterOwned = { ...futureReservation, owner_user_id: null, roster_member_id: "roster-1" };
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ reservations: [rosterOwned], courts: [{ id: "court-1", name: "Court 3" }] }, "roster-1"),
    );
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(200);
  });

  it("CRITICAL: a Member viewing another Member's reservation is refused, even though RLS/club-wide read visibility would let them SEE it on the calendar", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "someone-else", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ reservations: [futureReservation], courts: [{ id: "court-1", name: "Court 3" }] }),
    );
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("a Pro's own reservation succeeds", async () => {
    const proOwned = { ...futureReservation, owner_user_id: "pro-1" };
    mockGetAuthProfile.mockResolvedValue({ id: "pro-1", club_id: "c1", role: "pro" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ reservations: [proOwned], courts: [{ id: "court-1", name: "Court 3" }] }),
    );
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(200);
  });

  it("a Pro viewing an unrelated Member's reservation is refused", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "pro-1", club_id: "c1", role: "pro" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ reservations: [futureReservation], courts: [{ id: "court-1", name: "Court 3" }] }),
    );
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("Admin may export any same-club eligible reservation regardless of ownership", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "admin-1", club_id: "c1", role: "admin" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ reservations: [futureReservation], courts: [{ id: "court-1", name: "Court 3" }] }),
    );
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(200);
  });

  it("Staff may export any same-club eligible reservation regardless of ownership", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "staff-1", club_id: "c1", role: "staff" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ reservations: [futureReservation], courts: [{ id: "court-1", name: "Court 3" }] }),
    );
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(200);
  });
});

describe("Event domain — eligibility (incl. historical exclusion) and multi-court LOCATION", () => {
  beforeEach(() => {
    mockGetAuthProfile.mockResolvedValue({ id: "u1", club_id: "c1", role: "member" });
  });

  it("returns a valid calendar for a scheduled, future event, joining multiple court names", async () => {
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        events: [{
          id: VALID_ID, title: "Member Mixer", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2099-06-01T16:00:00.000Z",
          status: "scheduled", archived_at: null,
          reservations: [
            { court_id: "court-1", reason: "event", status: "confirmed" },
            { court_id: "court-2", reason: "event", status: "confirmed" },
          ],
        }],
        courts: [{ id: "court-1", name: "Court 1" }, { id: "court-2", name: "Court 2" }],
      }),
    );
    const res = await callGet("event", VALID_ID);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("SUMMARY:Member Mixer");
    expect(body).toContain("LOCATION:Court 1\\, Court 2");
    expect(body).toContain(`UID:event-${VALID_ID}@court-time.app`);
  });

  it("404s an event that has already ended", async () => {
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        events: [{ id: VALID_ID, title: "Past Mixer", starts_at: "2020-01-01T14:00:00.000Z", ends_at: "2020-01-01T15:00:00.000Z", status: "scheduled", archived_at: null, reservations: [] }],
        courts: [],
      }),
    );
    const res = await callGet("event", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("404s an archived event even though its status is still 'scheduled' and it hasn't ended", async () => {
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        events: [{ id: VALID_ID, title: "Old Clinic", starts_at: "2099-01-01T14:00:00.000Z", ends_at: "2099-01-01T15:00:00.000Z", status: "scheduled", archived_at: "2026-02-01T00:00:00.000Z", reservations: [] }],
        courts: [],
      }),
    );
    const res = await callGet("event", VALID_ID);
    expect(res.status).toBe(404);
  });
});

describe("Lesson domain — confirmed-only, not-yet-finished, counterparty-aware SUMMARY", () => {
  it("shows the pro's name to the member viewer for a future confirmed lesson", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        lesson_requests: [{
          id: VALID_ID, member_id: "member-1", pro_id: "pro-1", roster_member_id: "rm-1",
          proposed_starts_at: "2026-06-01T14:00:00.000Z", proposed_ends_at: "2099-06-01T15:00:00.000Z",
          proposed_court_id: "court-1", status: "confirmed",
        }],
        profiles: [{ id: "pro-1", first_name: "Sam", last_name: "Pro" }],
        courts: [{ id: "court-1", name: "Court 4" }],
      }),
    );
    const res = await callGet("lesson", VALID_ID);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("SUMMARY:Lesson with Sam Pro");
    expect(body).toContain("LOCATION:Court 4");
  });

  it("shows both names to an Admin/Staff viewer (neither party)", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "admin-1", club_id: "c1", role: "admin" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        lesson_requests: [{
          id: VALID_ID, member_id: "member-1", pro_id: "pro-1", roster_member_id: "rm-1",
          proposed_starts_at: "2026-06-01T14:00:00.000Z", proposed_ends_at: "2099-06-01T15:00:00.000Z",
          proposed_court_id: null, status: "confirmed",
        }],
        profiles: [
          { id: "member-1", first_name: "Jane", last_name: "Doe" },
          { id: "pro-1", first_name: "Sam", last_name: "Pro" },
        ],
      }),
    );
    const res = await callGet("lesson", VALID_ID);
    const body = await res.text();
    expect(body).toContain("SUMMARY:Lesson: Jane Doe with Sam Pro");
    expect(body).not.toContain("LOCATION:");
  });

  it("404s a pending (not yet confirmed) lesson request", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        lesson_requests: [{ id: VALID_ID, member_id: "member-1", pro_id: "pro-1", roster_member_id: "rm-1", proposed_starts_at: null, proposed_ends_at: null, proposed_court_id: null, status: "pending" }],
      }),
    );
    const res = await callGet("lesson", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("404s a confirmed lesson that has already ended", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        lesson_requests: [{
          id: VALID_ID, member_id: "member-1", pro_id: "pro-1", roster_member_id: "rm-1",
          proposed_starts_at: "2020-01-01T14:00:00.000Z", proposed_ends_at: "2020-01-01T15:00:00.000Z",
          proposed_court_id: null, status: "confirmed",
        }],
      }),
    );
    const res = await callGet("lesson", VALID_ID);
    expect(res.status).toBe(404);
  });
});

describe("Program domain — operator authorization (Admin/Staff/creator-Pro; non-creator Pro refused)", () => {
  const program = { id: VALID_ID, status: "active", archived_at: null, enrollment_model: "program", created_by: "pro-1" };
  const futureOccurrence = { id: "occ-1", program_id: VALID_ID, title: "Week 1", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2099-06-01T15:00:00.000Z", status: "scheduled", archived_at: null, reservations: [{ court_id: "court-1", reason: "event", status: "confirmed" }] };

  it("Admin works regardless of who created the program", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "admin-1", club_id: "c1", role: "admin" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase({ programs: [program], events: [futureOccurrence], program_enrollments: [], courts: [{ id: "court-1", name: "Court 1" }] }));
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(200);
  });

  it("Staff works regardless of who created the program", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "staff-1", club_id: "c1", role: "staff" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase({ programs: [program], events: [futureOccurrence], program_enrollments: [], courts: [{ id: "court-1", name: "Court 1" }] }));
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(200);
  });

  it("the creator Pro works", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "pro-1", club_id: "c1", role: "pro" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase({ programs: [program], events: [futureOccurrence], program_enrollments: [], courts: [{ id: "court-1", name: "Court 1" }] }));
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(200);
  });

  it("CRITICAL: a non-creator Pro gets the same generic 404 — never falls through to the Member enrollment path either", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "pro-2", club_id: "c1", role: "pro" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase({ programs: [program], events: [futureOccurrence], program_enrollments: [], courts: [] }));
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(404);
  });
});

describe("Program domain — Member durable identity (profile_id OR the caller's own current roster_member_id)", () => {
  const program = { id: VALID_ID, status: "active", archived_at: null, enrollment_model: "program", created_by: "pro-1" };
  const futureOccurrence = { id: "occ-1", program_id: VALID_ID, title: "Week 1", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2099-06-01T15:00:00.000Z", status: "scheduled", archived_at: null, reservations: [] };

  it("a whole-program Member enrolled via profile_id is authorized", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ programs: [program], events: [futureOccurrence], program_enrollments: [{ program_id: VALID_ID, profile_id: "member-1", roster_member_id: "roster-x", status: "enrolled" }], courts: [] }),
    );
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(200);
  });

  it("CRITICAL: a claimed Member's pre-claim enrollment (profile_id null, roster_member_id authoritative) is authorized via their OWN resolved roster identity", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase(
        { programs: [program], events: [futureOccurrence], program_enrollments: [{ program_id: VALID_ID, profile_id: null, roster_member_id: "roster-1", status: "enrolled" }], courts: [] },
        "roster-1", // current_user_roster_member_id() resolves to this for the caller
      ),
    );
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(200);
  });

  it("a DIFFERENT roster identity is not accepted — the enrollment row belongs to someone else's roster identity", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase(
        { programs: [program], events: [futureOccurrence], program_enrollments: [{ program_id: VALID_ID, profile_id: null, roster_member_id: "roster-OTHER", status: "enrolled" }], courts: [] },
        "roster-1",
      ),
    );
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("a per_session-model Member is never authorized for the parent schedule, even with a stray enrolled-looking row", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        programs: [{ ...program, enrollment_model: "per_session" }],
        events: [futureOccurrence],
        program_enrollments: [{ program_id: VALID_ID, profile_id: "member-1", roster_member_id: null, status: "enrolled" }],
        courts: [],
      }),
    );
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("a whole-program Member who is only waitlisted is not authorized", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ programs: [program], events: [futureOccurrence], program_enrollments: [{ program_id: VALID_ID, profile_id: "member-1", roster_member_id: null, status: "waitlisted" }], courts: [] }),
    );
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("a Member with no enrollment row at all is not authorized", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ programs: [program], events: [futureOccurrence], program_enrollments: [], courts: [] }),
    );
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("404s a cancelled program regardless of role", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "admin-1", club_id: "c1", role: "admin" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ programs: [{ ...program, status: "cancelled" }], events: [futureOccurrence], program_enrollments: [], courts: [] }),
    );
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(404);
  });
});

describe("Program domain — current/future occurrence filtering and the zero-eligible-occurrences rule", () => {
  const program = { id: VALID_ID, status: "active", archived_at: null, enrollment_model: "program", created_by: "admin-1" };
  const past = { id: "occ-past", program_id: VALID_ID, title: "Week 0 (past)", starts_at: "2020-01-01T14:00:00.000Z", ends_at: "2020-01-01T15:00:00.000Z", status: "scheduled", archived_at: null, reservations: [] };
  const current = { id: "occ-current", program_id: VALID_ID, title: "Week 1 (in progress)", starts_at: "2020-01-01T14:00:00.000Z", ends_at: "2099-01-01T15:00:00.000Z", status: "scheduled", archived_at: null, reservations: [] };
  const future = { id: "occ-future", program_id: VALID_ID, title: "Week 2 (future)", starts_at: "2099-06-01T14:00:00.000Z", ends_at: "2099-06-01T15:00:00.000Z", status: "scheduled", archived_at: null, reservations: [] };
  const cancelled = { id: "occ-cancelled", program_id: VALID_ID, title: "Week 3 (cancelled)", starts_at: "2099-06-08T14:00:00.000Z", ends_at: "2099-06-08T15:00:00.000Z", status: "cancelled", archived_at: null, reservations: [] };
  const archived = { id: "occ-archived", program_id: VALID_ID, title: "Week 4 (archived)", starts_at: "2099-06-15T14:00:00.000Z", ends_at: "2099-06-15T15:00:00.000Z", status: "scheduled", archived_at: "2026-01-01T00:00:00.000Z", reservations: [] };

  it("excludes past occurrences and includes current/future ones, in chronological order, while excluding cancelled/archived ones", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "admin-1", club_id: "c1", role: "admin" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ programs: [program], events: [past, current, future, cancelled, archived], program_enrollments: [], courts: [] }),
    );
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("occ-past");
    expect(body).not.toContain("occ-cancelled");
    expect(body).not.toContain("occ-archived");
    expect(body).toContain(`UID:event-occ-current@court-time.app`);
    expect(body).toContain(`UID:event-occ-future@court-time.app`);
    const currentIdx = body.indexOf("occ-current");
    const futureIdx = body.indexOf("occ-future");
    expect(currentIdx).toBeGreaterThan(-1);
    expect(futureIdx).toBeGreaterThan(currentIdx);
  });

  it("CRITICAL: zero remaining eligible (current/future) occurrences returns the SAME generic 404 — never a successful empty-calendar download", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "admin-1", club_id: "c1", role: "admin" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ programs: [program], events: [past, cancelled, archived], program_enrollments: [], courts: [] }),
    );
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(404);
  });

  it("zero occurrences generated at all also returns 404, not an empty calendar", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "admin-1", club_id: "c1", role: "admin" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({ programs: [program], events: [], program_enrollments: [], courts: [] }),
    );
    const res = await callGet("program", VALID_ID);
    expect(res.status).toBe(404);
  });
});

describe("DESCRIPTION safety (notes/description enhancement)", () => {
  it("Reservation: NEVER emits a DESCRIPTION, even when the row carries a notes value — reservation notes are effectively staff-only for member_booking today", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        reservations: [{
          id: VALID_ID, court_id: "court-1", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2099-06-01T15:00:00.000Z",
          status: "confirmed", reason: "member_booking", owner_user_id: "member-1", roster_member_id: null,
          notes: "Staff-only: this member has a history of late cancellations.",
        }],
        courts: [{ id: "court-1", name: "Court 3" }],
      }),
    );
    const res = await callGet("reservation", VALID_ID);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("DESCRIPTION:");
    expect(body).not.toContain("late cancellations");
  });

  it("Event (standalone, program_id null): NEVER emits a DESCRIPTION, even when the row carries a description value — no product surface shows it to anyone today", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        events: [{
          id: VALID_ID, title: "Member Mixer", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2099-06-01T16:00:00.000Z",
          status: "scheduled", archived_at: null, program_id: null,
          description: "Internal planning note: coordinate with pro shop for demo racquets.",
          reservations: [],
        }],
        courts: [],
      }),
    );
    const res = await callGet("event", VALID_ID);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("DESCRIPTION:");
    expect(body).not.toContain("pro shop");
  });

  it("Event (a generated Program occurrence): includes the PARENT Program's current description, not the occurrence's own (possibly stale) copy", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        events: [{
          id: VALID_ID, title: "Clinic — Week 3", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2099-06-01T16:00:00.000Z",
          status: "scheduled", archived_at: null, program_id: "prog-1",
          description: "STALE: this occurrence's own copy, from generation time, no longer current.",
          reservations: [],
        }],
        programs: [{ id: "prog-1", description: "Beginner clinic — all levels welcome." }],
        courts: [],
      }),
    );
    const res = await callGet("event", VALID_ID);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("DESCRIPTION:Beginner clinic — all levels welcome.");
    expect(body).not.toContain("STALE");
  });

  it("Event (a generated Program occurrence) whose parent Program has no description: omits DESCRIPTION entirely", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        events: [{ id: VALID_ID, title: "Clinic — Week 3", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2099-06-01T16:00:00.000Z", status: "scheduled", archived_at: null, program_id: "prog-1", reservations: [] }],
        programs: [{ id: "prog-1", description: null }],
        courts: [],
      }),
    );
    const res = await callGet("event", VALID_ID);
    const body = await res.text();
    expect(body).not.toContain("DESCRIPTION:");
  });

  it("Lesson: includes the shared member_note when present", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        lesson_requests: [{
          id: VALID_ID, member_id: "member-1", pro_id: "pro-1", roster_member_id: "rm-1",
          proposed_starts_at: "2026-06-01T14:00:00.000Z", proposed_ends_at: "2099-06-01T15:00:00.000Z",
          proposed_court_id: null, status: "confirmed", member_note: "Working on my backhand today.",
        }],
        profiles: [{ id: "pro-1", first_name: "Sam", last_name: "Pro" }],
      }),
    );
    const res = await callGet("lesson", VALID_ID);
    const body = await res.text();
    expect(body).toContain("DESCRIPTION:Working on my backhand today.");
  });

  it("Lesson: omits DESCRIPTION when member_note is null/blank", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        lesson_requests: [{
          id: VALID_ID, member_id: "member-1", pro_id: "pro-1", roster_member_id: "rm-1",
          proposed_starts_at: "2026-06-01T14:00:00.000Z", proposed_ends_at: "2099-06-01T15:00:00.000Z",
          proposed_court_id: null, status: "confirmed", member_note: "   ",
        }],
        profiles: [{ id: "pro-1", first_name: "Sam", last_name: "Pro" }],
      }),
    );
    const res = await callGet("lesson", VALID_ID);
    const body = await res.text();
    expect(body).not.toContain("DESCRIPTION:");
  });

  it("Lesson: a multiline member_note escapes correctly end-to-end (no raw newline embedded in the content line)", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "member-1", club_id: "c1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        lesson_requests: [{
          id: VALID_ID, member_id: "member-1", pro_id: "pro-1", roster_member_id: "rm-1",
          proposed_starts_at: "2026-06-01T14:00:00.000Z", proposed_ends_at: "2099-06-01T15:00:00.000Z",
          proposed_court_id: null, status: "confirmed", member_note: "Focus areas:\nBackhand\nServe toss",
        }],
        profiles: [{ id: "pro-1", first_name: "Sam", last_name: "Pro" }],
      }),
    );
    const res = await callGet("lesson", VALID_ID);
    const body = await res.text();
    expect(body).toContain("DESCRIPTION:Focus areas:\\nBackhand\\nServe toss");
  });

  it("Lesson: CRITICAL — never leaks decline_reason/cancellation_reason/payment/contact data even if present on the row", async () => {
    mockGetAuthProfile.mockResolvedValue({ id: "admin-1", club_id: "c1", role: "admin" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase({
        lesson_requests: [{
          id: VALID_ID, member_id: "member-1", pro_id: "pro-1", roster_member_id: "rm-1",
          proposed_starts_at: "2026-06-01T14:00:00.000Z", proposed_ends_at: "2099-06-01T15:00:00.000Z",
          proposed_court_id: null, status: "confirmed", member_note: "See you then.",
          decline_reason: "SECRET-DECLINE-REASON", cancellation_reason: "SECRET-CANCEL-REASON",
          price_amount_cents: 12345,
        }],
        profiles: [
          { id: "member-1", first_name: "Jane", last_name: "Doe", phone: "555-0100", email: "jane@example.com" },
          { id: "pro-1", first_name: "Sam", last_name: "Pro" },
        ],
      }),
    );
    const res = await callGet("lesson", VALID_ID);
    const body = await res.text();
    expect(body).not.toContain("SECRET-DECLINE-REASON");
    expect(body).not.toContain("SECRET-CANCEL-REASON");
    expect(body).not.toContain("12345");
    expect(body).not.toContain("555-0100");
    expect(body).not.toContain("jane@example.com");
  });

  it("Program parent schedule export: applies the program's description uniformly to every occurrence VEVENT", async () => {
    const program = { id: VALID_ID, status: "active", archived_at: null, enrollment_model: "program", created_by: "admin-1", description: "Beginner clinic — all levels welcome." };
    const occ1 = { id: "occ-1", program_id: VALID_ID, title: "Week 1", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2099-06-01T15:00:00.000Z", status: "scheduled", archived_at: null, reservations: [] };
    const occ2 = { id: "occ-2", program_id: VALID_ID, title: "Week 2", starts_at: "2099-06-08T14:00:00.000Z", ends_at: "2099-06-08T15:00:00.000Z", status: "scheduled", archived_at: null, reservations: [] };
    mockGetAuthProfile.mockResolvedValue({ id: "admin-1", club_id: "c1", role: "admin" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase({ programs: [program], events: [occ1, occ2], program_enrollments: [], courts: [] }));
    const res = await callGet("program", VALID_ID);
    const body = await res.text();
    expect(body.match(/DESCRIPTION:Beginner clinic — all levels welcome\./g)?.length).toBe(2);
  });

  it("Program parent schedule export: omits DESCRIPTION entirely when the program has none", async () => {
    const program = { id: VALID_ID, status: "active", archived_at: null, enrollment_model: "program", created_by: "admin-1", description: null };
    const occ1 = { id: "occ-1", program_id: VALID_ID, title: "Week 1", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2099-06-01T15:00:00.000Z", status: "scheduled", archived_at: null, reservations: [] };
    mockGetAuthProfile.mockResolvedValue({ id: "admin-1", club_id: "c1", role: "admin" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase({ programs: [program], events: [occ1], program_enrollments: [], courts: [] }));
    const res = await callGet("program", VALID_ID);
    const body = await res.text();
    expect(body).not.toContain("DESCRIPTION:");
  });
});
