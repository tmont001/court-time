import { describe, expect, it } from "vitest";
import {
  generateGuestWaiverToken,
  hashGuestWaiverToken,
  isSyntacticallyValidGuestWaiverToken,
  isSyntacticallyValidGuestWaiverTokenHash,
} from "./guestWaiverToken";

// Phase 43B-4A — genuine behavior-level tests for the Guest waiver
// invitation bearer credential, mirroring src/lib/calendar/feedToken.
// test.ts exactly (same technique: crypto.randomBytes(32) -> base64url,
// SHA-256 lowercase hex). Covers cryptographic strength, determinism, and
// shape validation. "Raw token never persisted by DB contract" is proven
// structurally in guestWaiverFoundation.regression.test.ts (this
// checkpoint's migration source-inspection suite) — that only the hash
// ever reaches a SQL statement parameter across every function in 0198 —
// not here, since this module has no database access of its own.

describe("generateGuestWaiverToken — cryptographically strong, 256 bits of entropy", () => {
  it("produces a base64url string of the expected length for 32 random bytes", () => {
    const token = generateGuestWaiverToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never produces the padding/URL-unsafe characters '+', '/', or '='", () => {
    for (let i = 0; i < 20; i++) {
      const token = generateGuestWaiverToken();
      expect(token).not.toMatch(/[+/=]/);
    }
  });

  it("produces a different token on every call (no fixed/reused seed)", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateGuestWaiverToken()));
    expect(tokens.size).toBe(50);
  });

  it("passes its own syntactic validator", () => {
    expect(isSyntacticallyValidGuestWaiverToken(generateGuestWaiverToken())).toBe(true);
  });
});

describe("hashGuestWaiverToken — deterministic SHA-256", () => {
  it("produces a 64-character lowercase hex digest", () => {
    const hash = hashGuestWaiverToken(generateGuestWaiverToken());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(isSyntacticallyValidGuestWaiverTokenHash(hash)).toBe(true);
  });

  it("is deterministic — the same input always produces the same hash", () => {
    const token = generateGuestWaiverToken();
    expect(hashGuestWaiverToken(token)).toBe(hashGuestWaiverToken(token));
  });

  it("produces a different hash for a different token", () => {
    const a = generateGuestWaiverToken();
    const b = generateGuestWaiverToken();
    expect(hashGuestWaiverToken(a)).not.toBe(hashGuestWaiverToken(b));
  });

  it("matches a known SHA-256 test vector (correctness, not just self-consistency)", () => {
    // sha256("abc") is a standard published test vector.
    expect(hashGuestWaiverToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("isSyntacticallyValidGuestWaiverToken — rejects malformed shapes before any hashing/DB work", () => {
  it("rejects the empty string", () => {
    expect(isSyntacticallyValidGuestWaiverToken("")).toBe(false);
  });

  it("rejects a token that is too short or too long", () => {
    expect(isSyntacticallyValidGuestWaiverToken("a".repeat(42))).toBe(false);
    expect(isSyntacticallyValidGuestWaiverToken("a".repeat(44))).toBe(false);
  });

  it("rejects characters outside the base64url alphabet", () => {
    expect(isSyntacticallyValidGuestWaiverToken("a".repeat(42) + "+")).toBe(false);
    expect(isSyntacticallyValidGuestWaiverToken("a".repeat(42) + "/")).toBe(false);
    expect(isSyntacticallyValidGuestWaiverToken("a".repeat(42) + "=")).toBe(false);
    expect(isSyntacticallyValidGuestWaiverToken("a".repeat(42) + " ")).toBe(false);
  });

  it("rejects a path-traversal or SQL-injection-shaped attempt", () => {
    expect(isSyntacticallyValidGuestWaiverToken("../../etc/passwd")).toBe(false);
    expect(isSyntacticallyValidGuestWaiverToken("' OR '1'='1")).toBe(false);
  });
});

describe("isSyntacticallyValidGuestWaiverTokenHash", () => {
  it("accepts a well-formed 64-character hex string", () => {
    expect(isSyntacticallyValidGuestWaiverTokenHash("a".repeat(64))).toBe(true);
  });

  it("rejects uppercase hex, wrong length, or non-hex characters", () => {
    expect(isSyntacticallyValidGuestWaiverTokenHash("A".repeat(64))).toBe(false);
    expect(isSyntacticallyValidGuestWaiverTokenHash("a".repeat(63))).toBe(false);
    expect(isSyntacticallyValidGuestWaiverTokenHash("g".repeat(64))).toBe(false);
  });

  // Same drift-detection probe as feedToken.test.ts — this module's regex
  // is independently maintained from the DB CHECK constraints in 0198
  // (token_hash ~ '^[0-9a-f]{64}$', on both new tables) — this suite
  // exists so a future silent divergence is caught here, not only live.
  it("agrees with the DB CHECK constraint's pattern (^[0-9a-f]{64}$) on a probe set of edge cases", () => {
    const dbCheckPattern = /^[0-9a-f]{64}$/;
    const probes = [
      "a".repeat(64), "0".repeat(64), "f".repeat(64), "0123456789abcdef".repeat(4),
      "A".repeat(64), "a".repeat(65), "a".repeat(63), "", "a".repeat(64) + "\n",
      "aa".repeat(31) + "gg",
    ];
    for (const probe of probes) {
      expect(isSyntacticallyValidGuestWaiverTokenHash(probe)).toBe(dbCheckPattern.test(probe));
    }
  });
});
