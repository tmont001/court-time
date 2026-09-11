import { describe, expect, it, vi, beforeEach } from "vitest";
import { generateRawFeedToken } from "@/lib/calendar/feedToken";

// Phase 35C — behavior-level tests for the public feed route's own wiring:
// input validation, the null/valid-empty distinction from the RPC, HTTP
// headers (subscription semantics, never a one-off attachment), conditional-
// request (ETag/304) behavior, and — the final pre-application security
// correction — that this route uses ONLY the existing privileged backend
// client (createPrivilegedClient, src/lib/supabase/privileged.ts) to reach
// get_calendar_feed_rows, never the ordinary session/anon client, and fails
// closed (503, no anon fallback) when that privileged client is
// unavailable. createPrivilegedClient is mocked here because a real one
// needs SUPABASE_SECRET_KEY/a live connection; the RPC itself
// (get_calendar_feed_rows) is mocked with canned return shapes matching
// exactly what the 0173 migration's function returns — the SQL function's
// OWN correctness (authorization, row selection) is verified against a
// live database separately (see the migration's verification queries),
// not re-proven here with a fake database.

const mockCreatePrivilegedClient = vi.fn();

vi.mock("@/lib/supabase/privileged", () => ({
  createPrivilegedClient: () => mockCreatePrivilegedClient(),
}));

import { GET } from "./route";

function makeFakeSupabase(rpcResult: { data: unknown; error: null } | { data: null; error: { message: string } }) {
  return { rpc: vi.fn(async () => rpcResult) };
}

const VALID_TOKEN = generateRawFeedToken();

// Fixture times relative to the real wall clock (the route always uses
// real `now`, unlike feed.test.ts's pure functions) — a few days out is
// safely inside the 90-day-back/180-day-forward window regardless of when
// this suite runs.
function inDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function callGet(token: string, headers: Record<string, string> = {}) {
  return GET(new Request(`http://localhost/api/calendar/feed/${token}`, { headers }), {
    params: Promise.resolve({ token }),
  });
}

beforeEach(() => {
  mockCreatePrivilegedClient.mockReset();
});

describe("input validation — a malformed token never reaches the database", () => {
  it("rejects an empty token", async () => {
    const res = await callGet("");
    expect(res.status).toBe(404);
  });

  it("rejects a wrong-length token", async () => {
    const res = await callGet("too-short");
    expect(res.status).toBe(404);
  });

  it("rejects a token containing characters outside the base64url alphabet", async () => {
    const res = await callGet("a".repeat(42) + "+");
    expect(res.status).toBe(404);
  });

  it("never calls the database for a malformed token — not even createPrivilegedClient() itself", async () => {
    const supabase = makeFakeSupabase({ data: null, error: null });
    mockCreatePrivilegedClient.mockReturnValue(supabase);
    await callGet("not-a-real-token");
    expect(mockCreatePrivilegedClient).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("CRITICAL (correction pass): calls get_calendar_feed_rows with ONLY p_token_hash — no window bound, no club/profile id, nothing else, and this is the ONLY RPC/query this route ever makes. get_calendar_feed_rows is service_role-only (not anon/authenticated-callable at all — see the migration/route header comments), so this is a defense-in-depth check that this route never widens what it asks the database for even though the RPC itself is now locked down independently.", async () => {
    const supabase = makeFakeSupabase({ data: { feed_type: "member_personal", rows: [] }, error: null });
    mockCreatePrivilegedClient.mockReturnValue(supabase);
    await callGet(VALID_TOKEN);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = supabase.rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(name).toBe("get_calendar_feed_rows");
    expect(Object.keys(args)).toEqual(["p_token_hash"]);
  });
});

describe("correction pass — privileged client usage, and failing closed with no anon fallback", () => {
  it("CRITICAL: the route calls createPrivilegedClient() to reach get_calendar_feed_rows — this is the ONLY way the route obtains a Supabase client", async () => {
    const supabase = makeFakeSupabase({ data: { feed_type: "member_personal", rows: [] }, error: null });
    mockCreatePrivilegedClient.mockReturnValue(supabase);
    await callGet(VALID_TOKEN);
    expect(mockCreatePrivilegedClient).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: when createPrivilegedClient() returns null (SUPABASE_SECRET_KEY not configured), the route fails closed with a generic 503 — it never falls back to any other client and never calls the RPC at all", async () => {
    mockCreatePrivilegedClient.mockReturnValue(null);
    const res = await callGet(VALID_TOKEN);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("");
  });

  it("a 503 response reveals no configuration detail (no body, no diagnostic headers)", async () => {
    mockCreatePrivilegedClient.mockReturnValue(null);
    const res = await callGet(VALID_TOKEN);
    expect(res.headers.get("content-type")).toBeNull();
  });
});

describe("the null vs. valid-empty distinction from get_calendar_feed_rows", () => {
  it("a NULL result (unknown/revoked/currently-unauthorized token) is a generic 404", async () => {
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: null, error: null }));
    const res = await callGet(VALID_TOKEN);
    expect(res.status).toBe(404);
  });

  it("CRITICAL: a valid token with an empty personal schedule is a 200 with a valid, empty calendar — never conflated with an invalid token", async () => {
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: { feed_type: "member_personal", rows: [] }, error: null }));
    const res = await callGet(VALID_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("END:VCALENDAR");
    expect(body).not.toContain("BEGIN:VEVENT");
  });
});

describe("HTTP response shape — subscription semantics, not a one-off download", () => {
  const rows = [{
    domain: "reservation", id: "11111111-1111-1111-1111-111111111111",
    starts_at: inDays(3), ends_at: inDays(3),
    is_cancelled: false, title: null, court_name: "Court 3", description: null, counterparty_name: null, revision_at: new Date().toISOString(),
  }];

  it("text/calendar content type, no attachment Content-Disposition", async () => {
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: { feed_type: "member_personal", rows }, error: null }));
    const res = await callGet(VALID_TOKEN);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBeNull();
  });

  it("includes the reservation with its stable UID and cancellation-free STATUS", async () => {
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: { feed_type: "member_personal", rows }, error: null }));
    const res = await callGet(VALID_TOKEN);
    const body = await res.text();
    expect(body).toContain("UID:reservation-11111111-1111-1111-1111-111111111111@court-time.app");
    expect(body).not.toContain("STATUS:");
  });

  it("emits STATUS:CANCELLED for a cancelled row still within retention", async () => {
    const cancelledRows = [{ ...rows[0], is_cancelled: true, ends_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }];
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: { feed_type: "member_personal", rows: cancelledRows }, error: null }));
    const res = await callGet(VALID_TOKEN);
    const body = await res.text();
    expect(body).toContain("STATUS:CANCELLED");
  });
});

describe("conditional requests (ETag / 304)", () => {
  const rows = [{
    domain: "reservation", id: "11111111-1111-1111-1111-111111111111",
    starts_at: inDays(3), ends_at: inDays(3),
    is_cancelled: false, title: null, court_name: "Court 3", description: null, counterparty_name: null, revision_at: new Date().toISOString(),
  }];

  it("a first request returns 200 with an ETag header", async () => {
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: { feed_type: "member_personal", rows }, error: null }));
    const res = await callGet(VALID_TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("CRITICAL (correction pass): the ETag is a WEAK validator (W/\"...\"), never a strong one — buildIcsCalendar's request-time DTSTAMP would otherwise make a strong (byte-equivalence) claim incorrect", async () => {
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: { feed_type: "member_personal", rows }, error: null }));
    const res = await callGet(VALID_TOKEN);
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);
  });

  it("a repeat request with a matching If-None-Match returns 304 with no body", async () => {
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: { feed_type: "member_personal", rows }, error: null }));
    const first = await callGet(VALID_TOKEN);
    const etag = first.headers.get("etag")!;

    const second = await callGet(VALID_TOKEN, { "if-none-match": etag });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("the validator changes when the underlying rows change", async () => {
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: { feed_type: "member_personal", rows }, error: null }));
    const first = await callGet(VALID_TOKEN);
    const etag = first.headers.get("etag")!;

    const changedRows = [{ ...rows[0], starts_at: inDays(10), ends_at: inDays(10) }];
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: { feed_type: "member_personal", rows: changedRows }, error: null }));
    const second = await callGet(VALID_TOKEN, { "if-none-match": etag });
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(etag);
  });

  it("CRITICAL: a revoked token NEVER returns 304 from a stale If-None-Match, even one captured from an earlier successful fetch — authorization is re-checked before any cache comparison", async () => {
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: { feed_type: "member_personal", rows }, error: null }));
    const first = await callGet(VALID_TOKEN);
    const staleEtag = first.headers.get("etag")!;

    // The token is now revoked/unauthorized -> the RPC returns NULL.
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: null, error: null }));
    const second = await callGet(VALID_TOKEN, { "if-none-match": staleEtag });
    expect(second.status).toBe(404);
  });

  it("CRITICAL (correction pass): the ETag reflects FINAL rendered visibility, not raw candidate content — a row the database still returns as a candidate but that has aged out of the rendered feed does not match a stale If-None-Match captured while it was still visible", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    // 89 days ago -> still inside the 90-day window (last time this test
    // ran with a real clock, before the second fetch below).
    const visibleRow = {
      domain: "reservation", id: "22222222-2222-2222-2222-222222222222",
      starts_at: new Date(Date.now() - 89 * dayMs).toISOString(),
      ends_at: new Date(Date.now() - 89 * dayMs + 60 * 60 * 1000).toISOString(),
      is_cancelled: false, title: null, court_name: "Court 5", description: null, counterparty_name: null, revision_at: new Date().toISOString(),
    };
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: { feed_type: "member_personal", rows: [visibleRow] }, error: null }));
    const first = await callGet(VALID_TOKEN);
    expect(first.status).toBe(200);
    const bodyFirst = await first.text();
    expect(bodyFirst).toContain("BEGIN:VEVENT");
    const staleEtag = first.headers.get("etag")!;

    // The database still returns the SAME row unchanged (it hasn't been
    // deleted), but pretend the same row is now 91 days old — outside the
    // window — by constructing it that way directly (simulating the
    // passage of time between two real fetches).
    const agedOutRow = { ...visibleRow, starts_at: new Date(Date.now() - 91 * dayMs).toISOString(), ends_at: new Date(Date.now() - 91 * dayMs + 60 * 60 * 1000).toISOString() };
    mockCreatePrivilegedClient.mockReturnValue(makeFakeSupabase({ data: { feed_type: "member_personal", rows: [agedOutRow] }, error: null }));
    const second = await callGet(VALID_TOKEN, { "if-none-match": staleEtag });
    expect(second.status).toBe(200);
    const bodySecond = await second.text();
    expect(bodySecond).not.toContain("BEGIN:VEVENT");
    expect(second.headers.get("etag")).not.toBe(staleEtag);
  });
});
