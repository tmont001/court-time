// Phase 43B-4A — Guest waiver invitation bearer tokens: the PURE, side-
// effect-free crypto logic only. Same exact technique as
// src/lib/calendar/feedToken.ts (Court Time's first long-lived bearer
// credential carried in a public URL): the raw token is generated AND
// hashed entirely here, server-side, and is NEVER sent to Postgres — only
// its SHA-256 hash ever reaches the database (see supabase/migrations/
// 0198_guest_waiver_invitation_acceptance.sql). 256 bits of entropy
// (crypto.randomBytes(32)), base64url-encoded (URL-safe without percent-
// escaping) for direct use in a future public URL path segment (Phase
// 43B-4B).
//
// Deliberately NO "server-only" guard on THIS file — same reasoning as
// src/lib/stripe/connectConfig.ts's own header comment ("pure, side-
// effect-free... no 'server-only' guard — deliberately importable from
// tests"): Vitest cannot resolve the bare "server-only" package (it is
// only ever hoisted as an internal dependency of `next` itself, not a
// direct project dependency), so a module carrying that import can never
// be exercised directly by a real behavioral test, only mocked — see
// src/lib/supabase/privileged.ts's own tests, all of which mock it rather
// than import it. Unlike connectConfig.ts, nothing in THIS module has a
// legitimate client-side use case, so real (server-side) callers must
// import from guestWaiverTokenServer.ts instead — a tiny wrapper that DOES
// carry "server-only" and re-exports these same functions, giving a hard,
// build-time-enforced guarantee against an accidental Client Component
// import while this file itself stays directly, genuinely testable.
//
// The invitation is SLOT-scoped, not waiver-version-scoped (locked 4A
// design) — this module only generates/hashes the opaque token itself; it
// has no knowledge of reservations, events, or waivers.

import { randomBytes, createHash } from "crypto";

const RAW_TOKEN_BYTES = 32; // 256 bits

// base64url of 32 bytes is always exactly 43 characters (no padding).
const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// A SHA-256 hex digest is always exactly 64 lowercase hex characters.
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

export function generateGuestWaiverToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString("base64url");
}

export function hashGuestWaiverToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

// Cheap shape check BEFORE ever touching the database — a syntactically
// malformed token (wrong length/charset) is rejected without a hash
// computation or a query.
export function isSyntacticallyValidGuestWaiverToken(candidate: string): boolean {
  return RAW_TOKEN_RE.test(candidate);
}

export function isSyntacticallyValidGuestWaiverTokenHash(candidate: string): boolean {
  return TOKEN_HASH_RE.test(candidate);
}
