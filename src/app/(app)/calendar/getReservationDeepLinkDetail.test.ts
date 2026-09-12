import { describe, expect, it, vi, beforeEach } from "vitest";

// Phase 36B security correction — behavior-level tests for
// getReservationDeepLinkDetail (calendar/actions.ts), the Server Action
// that replaced CalendarShell's direct browser-side `reservations` select
// for the ?reservation=<uuid> deep link. Running the fetch + the
// canOpenReservationDetail rule server-side (rather than in the browser)
// means an unauthorized target's row is never sent to the browser at all
// — only this function's own return value is.
//
// getAuthUser/getAuthProfile/createClient are mocked because they need a
// real Next.js request context (cookies()); "server-only" is mocked
// because it resolves via a bundler-only export condition Next.js
// provides, not a real npm package, so plain Node module resolution (as
// vitest uses) cannot find it otherwise. Every identity input is asserted
// to come from these mocks alone — never from a parameter — proving the
// function cannot be steered by client-supplied club/user/role/roster
// identity. A tiny in-memory fake stands in for what
// reservations_select_same_club RLS would filter in production, exactly
// as the existing convention in src/app/api/calendar/export/[domain]/
// [id]/route.test.ts already does for the same reason.

const mockGetAuthUser    = vi.fn();
const mockGetAuthProfile = vi.fn();
const mockCreateClient   = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/user", () => ({
  getAuthUser:    () => mockGetAuthUser(),
  getAuthProfile: () => mockGetAuthProfile(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));

import { getReservationDeepLinkDetail } from "./actions";

const VALID_ID = "11111111-1111-1111-1111-111111111111";

function reservation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: VALID_ID,
    reason: "member_booking",
    owner_user_id: "member-1",
    roster_member_id: null,
    status: "confirmed",
    ...overrides,
  };
}

function makeFakeSupabase(
  reservationRow: Record<string, unknown> | null,
  rosterMemberId: string | null = null,
) {
  return {
    from: (table: string) => {
      if (table !== "reservations") throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({
          eq: (col: string, val: string) => ({
            single: async () => {
              const match = reservationRow && col === "id" && reservationRow.id === val ? reservationRow : null;
              return match ? { data: match, error: null } : { data: null, error: { message: "not found" } };
            },
          }),
        }),
      };
    },
    rpc: async (name: string) => {
      if (name !== "current_user_roster_member_id") throw new Error(`unexpected rpc: ${name}`);
      return { data: rosterMemberId, error: null };
    },
  };
}

beforeEach(() => {
  mockGetAuthUser.mockReset();
  mockGetAuthProfile.mockReset();
  mockCreateClient.mockReset();
});

describe("getReservationDeepLinkDetail — accepts ONLY a reservation id", () => {
  it("has exactly one parameter — there is no club_id/user_id/role/roster_member_id override anywhere in its signature", () => {
    expect(getReservationDeepLinkDetail.length).toBe(1);
  });

  it("rejects a malformed id before ever touching auth or the database", async () => {
    const result = await getReservationDeepLinkDetail("not-a-uuid");
    expect(result).toBeNull();
    expect(mockGetAuthUser).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("returns null when signed out — never queries the database at all", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result).toBeNull();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("returns null when the caller has no active club membership — never queries the database at all", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "member-1" });
    mockGetAuthProfile.mockResolvedValue({ club_id: null, role: "member" });
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result).toBeNull();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});

describe("getReservationDeepLinkDetail — ownership", () => {
  it("returns the reservation for its owning Member", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "member-1" });
    mockGetAuthProfile.mockResolvedValue({ club_id: "club-1", role: "member" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase(reservation({ owner_user_id: "member-1" })));
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result?.id).toBe(VALID_ID);
  });

  it("returns the reservation for its owning Pro", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "pro-1" });
    mockGetAuthProfile.mockResolvedValue({ club_id: "club-1", role: "pro" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase(reservation({ owner_user_id: "pro-1" })));
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result?.id).toBe(VALID_ID);
  });

  it("plumbs the server-resolved roster member id through for claim-continuity ownership (a pre-claim booking, owner_user_id null)", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "member-1" });
    mockGetAuthProfile.mockResolvedValue({ club_id: "club-1", role: "member" });
    mockCreateClient.mockResolvedValue(
      makeFakeSupabase(reservation({ owner_user_id: null, roster_member_id: "roster-1" }), "roster-1"),
    );
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result?.id).toBe(VALID_ID);
  });

  it("Admin can retrieve an ordinary member booking that is not their own", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "admin-1" });
    mockGetAuthProfile.mockResolvedValue({ club_id: "club-1", role: "admin" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase(reservation({ owner_user_id: "member-1" })));
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result?.id).toBe(VALID_ID);
  });

  it("Staff can retrieve an ordinary member booking that is not their own", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "staff-1" });
    mockGetAuthProfile.mockResolvedValue({ club_id: "club-1", role: "staff" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase(reservation({ owner_user_id: "member-1" })));
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result?.id).toBe(VALID_ID);
  });

  it("another Member cannot retrieve a booking that is not their own — the row is withheld, not merely hidden client-side", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "member-2" });
    mockGetAuthProfile.mockResolvedValue({ club_id: "club-1", role: "member" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase(reservation({ owner_user_id: "member-1" })));
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result).toBeNull();
  });

  it("another Pro cannot retrieve a booking that is not their own", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "pro-2" });
    mockGetAuthProfile.mockResolvedValue({ club_id: "club-1", role: "pro" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase(reservation({ owner_user_id: "pro-1" })));
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result).toBeNull();
  });
});

describe("getReservationDeepLinkDetail — blocked (maintenance/admin_block) reservations", () => {
  it("Admin can retrieve a blocked reservation", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "admin-1" });
    mockGetAuthProfile.mockResolvedValue({ club_id: "club-1", role: "admin" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase(reservation({ reason: "maintenance", owner_user_id: null })));
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result?.id).toBe(VALID_ID);
  });

  it("Staff cannot retrieve a blocked reservation — never widened past the grid's admin-only rule", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "staff-1" });
    mockGetAuthProfile.mockResolvedValue({ club_id: "club-1", role: "staff" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase(reservation({ reason: "maintenance", owner_user_id: null })));
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result).toBeNull();
  });

  it("Member/Pro cannot retrieve a blocked reservation", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "member-1" });
    mockGetAuthProfile.mockResolvedValue({ club_id: "club-1", role: "member" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase(reservation({ reason: "maintenance", owner_user_id: null })));
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result).toBeNull();
  });
});

describe("getReservationDeepLinkDetail — lesson reservations are out of scope for this deep link", () => {
  it("returns null for a pro_lesson reservation even for its own assigned Pro", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "pro-1" });
    mockGetAuthProfile.mockResolvedValue({ club_id: "club-1", role: "pro" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase(reservation({ reason: "pro_lesson", owner_user_id: "pro-1" })));
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result).toBeNull();
  });

  it("returns null for a pro_lesson reservation even for Admin", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "admin-1" });
    mockGetAuthProfile.mockResolvedValue({ club_id: "club-1", role: "admin" });
    mockCreateClient.mockResolvedValue(makeFakeSupabase(reservation({ reason: "pro_lesson", owner_user_id: "pro-1" })));
    const result = await getReservationDeepLinkDetail(VALID_ID);
    expect(result).toBeNull();
  });
});

describe("getReservationDeepLinkDetail — indistinguishable outcomes", () => {
  it("nonexistent/RLS-hidden and unauthorized-for-this-viewer both resolve to the identical null result", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "member-2" });
    mockGetAuthProfile.mockResolvedValue({ club_id: "club-1", role: "member" });

    // Nonexistent / RLS-hidden (e.g. another club) — the RLS-scoped select
    // itself returns no row at all, exactly like a real cross-club lookup.
    mockCreateClient.mockResolvedValue(makeFakeSupabase(null));
    const notFound = await getReservationDeepLinkDetail(VALID_ID);

    // Row exists (same club) but this viewer isn't entitled to its detail.
    mockCreateClient.mockResolvedValue(makeFakeSupabase(reservation({ owner_user_id: "member-1" })));
    const unauthorized = await getReservationDeepLinkDetail(VALID_ID);

    expect(notFound).toBeNull();
    expect(unauthorized).toBeNull();
  });
});
