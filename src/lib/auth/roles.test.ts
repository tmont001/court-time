import { describe, expect, it } from "vitest";
import {
  canAccessOperationsWorkspace,
  hasAdminAuthority,
  isAdmin,
  isMember,
  isPro,
  isStaff,
  parseRole,
} from "./roles";

// Phase 34A2: proves the CURRENT locked authorization boundary. Staff is a
// legal `Role` value but must carry zero runtime authority until a later
// checkpoint's migration/enforcement work — see the module comment in
// roles.ts. Do not add a passing "staff -> operational access" case here
// without that work landing first.

describe("role identity predicates", () => {
  it("identifies each role exactly, including null/undefined/unknown", () => {
    expect(isAdmin("admin")).toBe(true);
    expect(isAdmin("pro")).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
    expect(isAdmin("bogus")).toBe(false);

    expect(isPro("pro")).toBe(true);
    expect(isPro("admin")).toBe(false);

    expect(isMember("member")).toBe(true);
    expect(isMember("admin")).toBe(false);

    // Not yet a live database value — the predicate still recognizes the
    // string today so it is ready the moment migration 0131 lands.
    expect(isStaff("staff")).toBe(true);
    expect(isStaff("admin")).toBe(false);
  });
});

describe("parseRole", () => {
  it("narrows known role strings and rejects everything else", () => {
    expect(parseRole("admin")).toBe("admin");
    expect(parseRole("pro")).toBe("pro");
    expect(parseRole("staff")).toBe("staff");
    expect(parseRole("member")).toBe("member");
    expect(parseRole("owner")).toBeNull();
    expect(parseRole(null)).toBeNull();
    expect(parseRole(undefined)).toBeNull();
    expect(parseRole("")).toBeNull();
  });
});

describe("canAccessOperationsWorkspace — locked Phase 33 behavior", () => {
  it("admin can access the operations workspace", () => {
    expect(canAccessOperationsWorkspace("admin")).toBe(true);
  });

  it("pro can access the operations workspace", () => {
    expect(canAccessOperationsWorkspace("pro")).toBe(true);
  });

  it("member cannot access the operations workspace", () => {
    expect(canAccessOperationsWorkspace("member")).toBe(false);
  });

  it("staff cannot access the operations workspace yet (locked off in 34A2)", () => {
    expect(canAccessOperationsWorkspace("staff")).toBe(false);
  });

  it("fails closed for null, undefined, and unrecognized values", () => {
    expect(canAccessOperationsWorkspace(null)).toBe(false);
    expect(canAccessOperationsWorkspace(undefined)).toBe(false);
    expect(canAccessOperationsWorkspace("")).toBe(false);
    expect(canAccessOperationsWorkspace("owner")).toBe(false);
  });
});

describe("hasAdminAuthority — locked Phase 33 behavior", () => {
  it("only admin has admin authority", () => {
    expect(hasAdminAuthority("admin")).toBe(true);
    expect(hasAdminAuthority("pro")).toBe(false);
    expect(hasAdminAuthority("member")).toBe(false);
    expect(hasAdminAuthority("staff")).toBe(false);
  });

  it("fails closed for null, undefined, and unrecognized values", () => {
    expect(hasAdminAuthority(null)).toBe(false);
    expect(hasAdminAuthority(undefined)).toBe(false);
    expect(hasAdminAuthority("owner")).toBe(false);
  });
});
