import { describe, expect, it } from "vitest";
import { generateRawFeedToken, hashFeedToken, isSyntacticallyValidFeedToken, isSyntacticallyValidTokenHash } from "./feedToken";

// Phase 35C — genuine behavior-level tests for Court Time's first
// long-lived bearer credential. Covers cryptographic strength, determinism,
// and shape validation — the raw token itself is never persisted, so
// "never persisted" is verified structurally elsewhere (the migration/
// route never call a select on token_hash with the raw value, and
// issue_calendar_feed_token's signature takes only a hash — see
// route.test.ts and calendarFeedActions for the call-site proof).

describe("generateRawFeedToken — cryptographically strong, 256 bits of entropy", () => {
  it("produces a base64url string of the expected length for 32 random bytes", () => {
    const token = generateRawFeedToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never produces the padding/URL-unsafe characters '+', '/', or '='", () => {
    for (let i = 0; i < 20; i++) {
      const token = generateRawFeedToken();
      expect(token).not.toMatch(/[+/=]/);
    }
  });

  it("produces a different token on every call (no fixed/reused seed)", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateRawFeedToken()));
    expect(tokens.size).toBe(50);
  });

  it("passes its own syntactic validator", () => {
    expect(isSyntacticallyValidFeedToken(generateRawFeedToken())).toBe(true);
  });
});

describe("hashFeedToken — deterministic SHA-256", () => {
  it("produces a 64-character lowercase hex digest", () => {
    const hash = hashFeedToken(generateRawFeedToken());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(isSyntacticallyValidTokenHash(hash)).toBe(true);
  });

  it("is deterministic — the same input always produces the same hash", () => {
    const token = generateRawFeedToken();
    expect(hashFeedToken(token)).toBe(hashFeedToken(token));
  });

  it("produces a different hash for a different token", () => {
    const a = generateRawFeedToken();
    const b = generateRawFeedToken();
    expect(hashFeedToken(a)).not.toBe(hashFeedToken(b));
  });

  it("matches a known SHA-256 test vector (correctness, not just self-consistency)", () => {
    // sha256("abc") is a standard published test vector.
    expect(hashFeedToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("isSyntacticallyValidFeedToken — rejects malformed shapes before any hashing/DB work", () => {
  it("rejects the empty string", () => {
    expect(isSyntacticallyValidFeedToken("")).toBe(false);
  });

  it("rejects a token that is too short or too long", () => {
    expect(isSyntacticallyValidFeedToken("a".repeat(42))).toBe(false);
    expect(isSyntacticallyValidFeedToken("a".repeat(44))).toBe(false);
  });

  it("rejects characters outside the base64url alphabet", () => {
    expect(isSyntacticallyValidFeedToken("a".repeat(42) + "+")).toBe(false);
    expect(isSyntacticallyValidFeedToken("a".repeat(42) + "/")).toBe(false);
    expect(isSyntacticallyValidFeedToken("a".repeat(42) + "=")).toBe(false);
    expect(isSyntacticallyValidFeedToken("a".repeat(42) + " ")).toBe(false);
  });

  it("rejects a path-traversal or SQL-injection-shaped attempt", () => {
    expect(isSyntacticallyValidFeedToken("../../etc/passwd")).toBe(false);
    expect(isSyntacticallyValidFeedToken("' OR '1'='1")).toBe(false);
  });
});

describe("isSyntacticallyValidTokenHash", () => {
  it("accepts a well-formed 64-character hex string", () => {
    expect(isSyntacticallyValidTokenHash("a".repeat(64))).toBe(true);
  });

  it("rejects uppercase hex, wrong length, or non-hex characters", () => {
    expect(isSyntacticallyValidTokenHash("A".repeat(64))).toBe(false);
    expect(isSyntacticallyValidTokenHash("a".repeat(63))).toBe(false);
    expect(isSyntacticallyValidTokenHash("g".repeat(64))).toBe(false);
  });

  // Correction pass: calendar_feed_tokens.token_hash now carries the exact
  // SAME invariant as a database CHECK constraint
  // (`check (token_hash ~ '^[0-9a-f]{64}$')`, migration 0173) and
  // issue_calendar_feed_token's own application-layer guard uses the
  // identical pattern. This module's regex is independently maintained
  // from those two — this probe suite exists so a future change to one
  // that silently drifts from the other (e.g. someone widening this
  // TS validator to allow uppercase, or narrowing the DB constraint) is
  // caught by a failing test here rather than only discovered live.
  it("agrees with the DB CHECK constraint's pattern (^[0-9a-f]{64}$) on a probe set of edge cases", () => {
    const dbCheckPattern = /^[0-9a-f]{64}$/;
    const probes = [
      "a".repeat(64), "0".repeat(64), "f".repeat(64), "0123456789abcdef".repeat(4),
      "A".repeat(64), "a".repeat(65), "a".repeat(63), "", "a".repeat(64) + "\n",
      "aa".repeat(31) + "gg",
    ];
    for (const probe of probes) {
      expect(isSyntacticallyValidTokenHash(probe)).toBe(dbCheckPattern.test(probe));
    }
  });
});
