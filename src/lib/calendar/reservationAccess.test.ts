import { describe, expect, it } from "vitest";
import { canOpenReservationDetail, isOwnReservation, type ReservationAccessRow } from "./reservationAccess";

const MEMBER_ID = "member-1";
const OTHER_MEMBER_ID = "member-2";
const ROSTER_ID = "roster-1";

const memberBooking: ReservationAccessRow = {
  reason: "member_booking",
  ownerUserId: MEMBER_ID,
  rosterMemberId: null,
};

const blockedRow: ReservationAccessRow = {
  reason: "maintenance",
  ownerUserId: null,
  rosterMemberId: null,
};

const lessonRow: ReservationAccessRow = {
  reason: "pro_lesson",
  ownerUserId: "pro-1",
  rosterMemberId: null,
};

describe("canOpenReservationDetail — ownership", () => {
  it("the owning Member may open their own booking", () => {
    expect(
      canOpenReservationDetail(memberBooking, { userId: MEMBER_ID, userRosterMemberId: null, role: "member" }),
    ).toBe(true);
  });

  it("the owning Pro may open their own booking", () => {
    const proBooking: ReservationAccessRow = { reason: "member_booking", ownerUserId: "pro-1", rosterMemberId: null };
    expect(
      canOpenReservationDetail(proBooking, { userId: "pro-1", userRosterMemberId: null, role: "pro" }),
    ).toBe(true);
  });

  it("claim-continuity: a pre-claim roster identity matches via roster_member_id, not owner_user_id", () => {
    const preClaim: ReservationAccessRow = { reason: "member_booking", ownerUserId: null, rosterMemberId: ROSTER_ID };
    expect(
      canOpenReservationDetail(preClaim, { userId: MEMBER_ID, userRosterMemberId: ROSTER_ID, role: "member" }),
    ).toBe(true);
    expect(isOwnReservation(preClaim, { userId: MEMBER_ID, userRosterMemberId: ROSTER_ID, role: "member" }))
      .toBe(true);
  });

  it("another Member/Pro cannot force-open a booking that isn't their own (a manually edited URL must not leak it)", () => {
    expect(
      canOpenReservationDetail(memberBooking, { userId: OTHER_MEMBER_ID, userRosterMemberId: null, role: "member" }),
    ).toBe(false);
    expect(
      canOpenReservationDetail(memberBooking, { userId: "pro-2", userRosterMemberId: null, role: "pro" }),
    ).toBe(false);
  });
});

describe("canOpenReservationDetail — operators", () => {
  it("Admin may open any member_booking reservation, own or not", () => {
    expect(
      canOpenReservationDetail(memberBooking, { userId: "admin-1", userRosterMemberId: null, role: "admin" }),
    ).toBe(true);
  });

  it("Staff may open any member_booking reservation, own or not", () => {
    expect(
      canOpenReservationDetail(memberBooking, { userId: "staff-1", userRosterMemberId: null, role: "staff" }),
    ).toBe(true);
  });
});

describe("canOpenReservationDetail — blocked (maintenance/admin_block) reservations", () => {
  it("Admin may open a blocked reservation", () => {
    expect(
      canOpenReservationDetail(blockedRow, { userId: "admin-1", userRosterMemberId: null, role: "admin" }),
    ).toBe(true);
  });

  it("Staff may NOT open a blocked reservation — never widened past the grid's admin-only rule", () => {
    expect(
      canOpenReservationDetail(blockedRow, { userId: "staff-1", userRosterMemberId: null, role: "staff" }),
    ).toBe(false);
  });

  it("Member/Pro may NOT open a blocked reservation, even their own club's", () => {
    expect(
      canOpenReservationDetail(blockedRow, { userId: MEMBER_ID, userRosterMemberId: null, role: "member" }),
    ).toBe(false);
    expect(
      canOpenReservationDetail(blockedRow, { userId: "pro-1", userRosterMemberId: null, role: "pro" }),
    ).toBe(false);
  });
});

describe("canOpenReservationDetail — lesson reservations are out of scope for this sheet", () => {
  it("never opens via this path regardless of role or ownership — lessons have their own surfaces", () => {
    expect(
      canOpenReservationDetail(lessonRow, { userId: "pro-1", userRosterMemberId: null, role: "pro" }),
    ).toBe(false);
    expect(
      canOpenReservationDetail(lessonRow, { userId: "admin-1", userRosterMemberId: null, role: "admin" }),
    ).toBe(false);
  });
});
