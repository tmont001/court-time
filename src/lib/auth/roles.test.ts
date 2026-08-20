import { describe, expect, it } from "vitest";
import {
  canAccessOperationsWorkspace,
  hasAdminAuthority,
  isAdmin,
  isMember,
  isOperator,
  isPro,
  isStaff,
  parseRole,
} from "./roles";

// Phase 34A2 established the pure-predicate baseline; Phase 34A4 gave
// Staff workspace entry and generic operator authority, proven below.
// Pro must never gain operator authority via isOperator — its access
// stays provider-scoped/narrower, handled per-domain at the RPC layer,
// not through this predicate.

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

describe("canAccessOperationsWorkspace — Phase 34A4 behavior", () => {
  it("admin can access the operations workspace", () => {
    expect(canAccessOperationsWorkspace("admin")).toBe(true);
  });

  it("staff can access the operations workspace (34A4)", () => {
    expect(canAccessOperationsWorkspace("staff")).toBe(true);
  });

  it("pro can access the operations workspace (existing behavior preserved)", () => {
    expect(canAccessOperationsWorkspace("pro")).toBe(true);
  });

  it("member cannot access the operations workspace", () => {
    expect(canAccessOperationsWorkspace("member")).toBe(false);
  });

  it("fails closed for null, undefined, and unrecognized values", () => {
    expect(canAccessOperationsWorkspace(null)).toBe(false);
    expect(canAccessOperationsWorkspace(undefined)).toBe(false);
    expect(canAccessOperationsWorkspace("")).toBe(false);
    expect(canAccessOperationsWorkspace("owner")).toBe(false);
  });
});

describe("isOperator — Phase 34A4: Admin or Staff, never Pro", () => {
  it("admin is an operator", () => {
    expect(isOperator("admin")).toBe(true);
  });

  it("staff is an operator", () => {
    expect(isOperator("staff")).toBe(true);
  });

  it("pro is NOT an operator — provider access stays narrower/domain-specific", () => {
    expect(isOperator("pro")).toBe(false);
  });

  it("member is not an operator", () => {
    expect(isOperator("member")).toBe(false);
  });

  it("fails closed for null, undefined, and unrecognized values", () => {
    expect(isOperator(null)).toBe(false);
    expect(isOperator(undefined)).toBe(false);
    expect(isOperator("")).toBe(false);
    expect(isOperator("owner")).toBe(false);
  });
});

describe("hasAdminAuthority — locked behavior, unchanged by 34A4", () => {
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
