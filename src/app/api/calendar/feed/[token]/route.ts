// Phase 35C — personal calendar subscription feed.
//
// GET /api/calendar/feed/[token] — the ONE public, tokenized endpoint an
// external calendar client (Apple Calendar, Google Calendar "From URL",
// etc.) repeatedly re-fetches with NO Supabase session at all. The ONLY
// authorization input is the opaque token in the path.
//
// SECURITY: this route never resolves a profile_id/club_id itself and then
// goes on to query other tables with elevated privilege. It hashes the
// token, then delegates EVERYTHING else — resolving the token, revalidating
// live role/membership/capability state, and selecting only the narrowly
// permitted schedule rows — to ONE narrow SECURITY DEFINER database
// function (get_calendar_feed_rows, migration 0173) that itself derives
// club/profile/feed scope internally from the token row.
//
// Correction pass (final, pre-application security-boundary fix):
// get_calendar_feed_rows is service_role ONLY — not reachable by anon or
// authenticated at all. A stored token_hash value, on its own, must never
// be a usable bearer credential against Supabase's public PostgREST API;
// if this function were anon/authenticated-callable, anyone who ever
// obtained a token_hash (a database leak, a backup, anything) could call
// it directly with the public anon key and retrieve real calendar data
// WITHOUT the original raw URL token — defeating the entire point of
// hashing it at rest. This route therefore uses the EXISTING privileged
// backend client (createPrivilegedClient(), src/lib/supabase/
// privileged.ts — the same one already used for submit_pilot_inquiry),
// NOT the ordinary session-scoped client from @/lib/supabase/server, and
// NOT a new privileged-client abstraction. That privileged client is used
// for EXACTLY ONE call in this entire route — get_calendar_feed_rows —
// never a direct table query, never a generic profile/club lookup, never
// any other RPC. If SUPABASE_SECRET_KEY is not configured,
// createPrivilegedClient() returns null (it never throws, never falls
// back to a lower-privilege client) and this route fails closed with a
// generic 503 — it never silently serves the feed via an anon client
// instead, which would reopen exactly the hole this correction closes.
// The raw token is still never sent to Postgres — only its SHA-256 hash,
// computed here, ever reaches the privileged RPC call — and neither the
// raw token nor its hash is ever logged by this route.
//
// get_calendar_feed_rows itself takes ONLY the token hash — no window
// parameters. The candidate window is computed entirely inside the
// database from its own now(), hard-coded to the locked 90-day-back/
// 180-day-forward horizon. buildFeedIcsEvents (feed.ts, unit-tested)
// applies this route's own precise per-row window/retention decision over
// the rows the database already returned — it does not influence what
// the database itself queries.
//
// Every failure mode — malformed token, unknown token, revoked token, or a
// token whose role/membership/capability no longer authorizes it — produces
// the SAME generic 404, so a caller probing tokens or watching for a status
// change can never learn which of those applies.
//
// This is a SUBSCRIPTION, not a one-off download (contrast with 35B's
// /api/calendar/export/[domain]/[id], which sets Content-Disposition:
// attachment): no attachment header here, so a calendar client's repeated
// GETs are treated as feed refreshes, and conditional requests (ETag) are
// supported so an unchanged feed costs the client (and, once matched, this
// server) almost nothing.
//
// Correction pass — ETag: computed from the FINAL rendered IcsEvent[]
// (after buildFeedIcsEvents' time-dependent window/retention decisions),
// never from the raw SQL rows. Inclusion is time-dependent — a row whose
// own content never changed can still legitimately age out of the
// rendered feed as `now` advances, and an ETag over the raw rows would
// not reflect that, incorrectly validating a stale 304 for a feed that
// actually shrank. It is served as a WEAK validator (`W/"..."`) because
// buildIcsCalendar's DTSTAMP is request-time and would otherwise make two
// semantically identical responses byte-differ — a strong ETag would be
// an incorrect claim of byte-for-byte representation equality. Computed
// and compared only AFTER the RPC's NULL-check above, so a revoked/
// unauthorized token always 404s regardless of any client-supplied
// If-None-Match — it can never ride through on a stale weak validator
// from an earlier, successful, authorized fetch.

import { NextResponse } from "next/server";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { buildIcsCalendar } from "@/lib/ics";
import { isSyntacticallyValidFeedToken, hashFeedToken } from "@/lib/calendar/feedToken";
import { buildFeedIcsEvents, computeFeedETag, type FeedRow } from "@/lib/calendar/feed";

function notFound(): NextResponse {
  return new NextResponse(null, { status: 404 });
}

// Generic — no configuration detail, no stack trace, nothing token-related.
function serverUnavailable(): NextResponse {
  return new NextResponse(null, { status: 503 });
}

interface FeedRpcResult {
  feed_type: string;
  rows: FeedRow[];
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;

  if (!isSyntacticallyValidFeedToken(token)) {
    return notFound();
  }

  const tokenHash = hashFeedToken(token);
  const now = new Date();

  // Fails closed, never falls back to a lower-privilege client — see this
  // file's own header for why an anon-reachable fallback here would
  // reopen the exact hole this correction closes. Never logs the raw
  // token or its hash, here or in createPrivilegedClient() itself.
  const supabase = createPrivilegedClient();
  if (!supabase) {
    console.error("calendar feed request blocked: SUPABASE_SECRET_KEY is not configured");
    return serverUnavailable();
  }

  const { data } = await supabase.rpc("get_calendar_feed_rows", {
    p_token_hash: tokenHash,
  });

  // NULL means invalid/unknown/revoked/currently-unauthorized — see the
  // RPC's own header. A non-null result (even with an empty rows array) is
  // a valid, currently-authorized feed with nothing scheduled right now.
  if (!data) {
    return notFound();
  }

  const result = data as unknown as FeedRpcResult;
  const rows = result.rows ?? [];

  // The FINAL rendered event set for this request — see this file's own
  // header for why the ETag must be computed from this, not the raw rows.
  const icsEvents = buildFeedIcsEvents(rows, now);

  const etag = `W/"${computeFeedETag(icsEvents)}"`;
  const cacheControl = "private, max-age=0, must-revalidate";

  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": cacheControl },
    });
  }

  const body = buildIcsCalendar(icsEvents, now);

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": cacheControl,
      "ETag": etag,
    },
  });
}
