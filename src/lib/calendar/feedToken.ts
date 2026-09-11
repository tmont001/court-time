// feedToken.ts — Phase 35C: Court Time's first long-lived bearer credential
// carried in a public URL.
//
// The raw token is generated AND hashed entirely here, server-side, and is
// NEVER sent to Postgres — only its SHA-256 hash ever reaches the database
// (see supabase/migrations/0173_calendar_feed_subscriptions.sql's own
// header for why: a value that never appears in a SQL statement parameter
// can never appear in a SQL log line or pg_stat_statements either).
//
// 256 bits of entropy (crypto.randomBytes(32)), base64url-encoded (URL-safe
// without percent-escaping) for direct use in a subscription URL path
// segment.

import { randomBytes, createHash } from "crypto";

const RAW_TOKEN_BYTES = 32; // 256 bits

// base64url of 32 bytes is always exactly 43 characters (no padding).
const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// A SHA-256 hex digest is always exactly 64 lowercase hex characters.
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

export function generateRawFeedToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString("base64url");
}

export function hashFeedToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

// Cheap shape check BEFORE ever touching the database — a syntactically
// malformed token (wrong length/charset) is rejected without a hash
// computation or a query. A well-formed-but-unknown/revoked token still
// falls through to the same generic 404 the database resolution produces.
export function isSyntacticallyValidFeedToken(candidate: string): boolean {
  return RAW_TOKEN_RE.test(candidate);
}

export function isSyntacticallyValidTokenHash(candidate: string): boolean {
  return TOKEN_HASH_RE.test(candidate);
}
