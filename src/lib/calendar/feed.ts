// feed.ts — Phase 35C personal calendar subscription: pure feed-row
// eligibility/construction logic.
//
// Deliberately split from the public route (src/app/api/calendar/feed/
// [token]/route.ts), the same way 35B split calendar/export.ts from its
// route: everything here is a PURE function over already-fetched plain
// data — no Supabase client, no I/O, no `crypto` module reachable from a
// client bundle — so window/retention timing decisions and UID/summary
// construction are behavior-tested directly (see feed.test.ts) with fixed
// dates, never the real wall clock.
//
// The SQL boundary (get_calendar_feed_rows, migration 0173) is responsible
// for authorization and candidate-row selection over the same 90-day-back/
// 180-day-forward horizon rendered here. This module makes the PRECISE,
// per-row decision: does this row appear in the feed at all, and if so, as
// an active or a STATUS:CANCELLED VEVENT.
//
// UID scheme is the EXACT SAME one 35B locked (@/lib/calendar/export's
// reservationUid/eventUid/lessonUid) — reused verbatim, never a second
// namespace, so the same underlying item keeps the same UID whether a
// Member encounters it via a 35B one-off export or this 35C subscription.

import { createHash } from "crypto";
import type { IcsEvent } from "@/lib/ics";
import { reservationUid, eventUid, lessonUid, safeDescription } from "@/lib/calendar/export";

export const FEED_HISTORY_DAYS = 90;
export const FEED_FUTURE_DAYS = 180;
export const FEED_CANCELLATION_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function feedWindowBounds(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(now.getTime() - FEED_HISTORY_DAYS * DAY_MS),
    end: new Date(now.getTime() + FEED_FUTURE_DAYS * DAY_MS),
  };
}

export type FeedDomain = "reservation" | "event" | "lesson";

// The exact shape get_calendar_feed_rows (0173, corrected by the 0174
// runtime-correction migration) returns per row, already authorization-
// filtered, already baseline/cancellation-timestamp-gated (see migration
// 0174 — a newly-created subscription never backfills old history, and a
// cancellation never appears unless it happened at-or-after the token's
// own creation), and already carrying only SAFE fields (never payment/
// contact/roster/audit/staff-only data — see that function's own header
// for the per-domain reasoning, reused unchanged from 35B/35B1).
// revision_at is the authoritative "last touched" instant for this row's
// specific feed-visible content, computed per-domain in SQL (0174) from
// existing updated_at columns across every source that affects a visible
// property (title/time/status/court name/description/counterparty name) —
// never a new column invented for this purpose alone.
export interface FeedRow {
  domain: FeedDomain;
  id: string;
  starts_at: string;
  ends_at: string;
  is_cancelled: boolean;
  title: string | null;
  court_name: string | null;
  description: string | null;
  counterparty_name: string | null;
  revision_at: string;
}

export type FeedRowDecision = "active" | "cancelled" | "exclude";

// LOCKED minimum: a cancelled item stays in the feed until at least
// (original scheduled end time + 7 days), and may stay longer still if its
// end time is within the normal historical window — expressed here as an
// explicit, independently-testable OR, not merely relying on the
// historical window (90 days) happening to already exceed the 7-day floor
// in the current configuration.
export function decideFeedRowInclusion(
  row: { starts_at: string; ends_at: string; is_cancelled: boolean },
  now: Date,
): FeedRowDecision {
  const { start: windowStart, end: windowEnd } = feedWindowBounds(now);
  const startsAt = new Date(row.starts_at);
  const endsAt = new Date(row.ends_at);
  const withinWindow = endsAt >= windowStart && startsAt <= windowEnd;

  if (!row.is_cancelled) {
    return withinWindow ? "active" : "exclude";
  }

  const retentionCutoff = new Date(endsAt.getTime() + FEED_CANCELLATION_RETENTION_DAYS * DAY_MS);
  const withinRetention = now <= retentionCutoff;
  return withinWindow || withinRetention ? "cancelled" : "exclude";
}

// Builds one IcsEvent from a feed row. Reuses the exact 35B UID scheme and
// the exact 35B/35B1 safe-description policy (safeDescription) — no new
// privacy surface is introduced here. lastModified is always populated
// from row.revision_at — a SQL-computed, per-domain MAX() over every
// source column that affects this row's visible content (see feed.ts's
// own header and migration 0174) — so a genuine edit to any visible field
// always advances LAST-MODIFIED, and the semantic ETag (computeFeedETag
// below) stays keyed to the actual visible fields, not to this timestamp,
// so an unrelated non-visible change can never falsely invalidate a
// client's cache even if it happens to also advance revision_at.
export function buildFeedIcsEvent(row: FeedRow, decision: "active" | "cancelled"): IcsEvent {
  const status = decision === "cancelled" ? ("CANCELLED" as const) : undefined;
  const lastModified = new Date(row.revision_at);

  switch (row.domain) {
    case "reservation": {
      const courtName = row.court_name ?? "Court";
      return {
        uid: reservationUid(row.id),
        dtstart: new Date(row.starts_at),
        dtend: new Date(row.ends_at),
        summary: `Court Reservation — ${courtName}`,
        location: courtName,
        lastModified,
        status,
      };
    }
    case "event":
      return {
        uid: eventUid(row.id),
        dtstart: new Date(row.starts_at),
        dtend: new Date(row.ends_at),
        summary: row.title ?? "Event",
        location: row.court_name,
        description: safeDescription(row.description),
        lastModified,
        status,
      };
    case "lesson":
      return {
        uid: lessonUid(row.id),
        dtstart: new Date(row.starts_at),
        dtend: new Date(row.ends_at),
        summary: `Lesson with ${row.counterparty_name ?? "Court Time"}`,
        location: row.court_name,
        description: safeDescription(row.description),
        lastModified,
        status,
      };
  }
}

// Filters + maps the full candidate row set into the final ICS event list
// for one feed fetch, at one shared instant.
export function buildFeedIcsEvents(rows: readonly FeedRow[], now: Date): IcsEvent[] {
  const events: IcsEvent[] = [];
  for (const row of rows) {
    const decision = decideFeedRowInclusion(row, now);
    if (decision === "exclude") continue;
    events.push(buildFeedIcsEvent(row, decision));
  }
  return events;
}

// Correction pass: a conditional-request validator derived from the FINAL,
// rendered, feed-visible calendar content — i.e. computed over the
// IcsEvent[] that buildFeedIcsEvents already produced for THIS request
// (after its window/retention inclusion/exclusion decisions), never from
// the raw pre-decision FeedRow[]. This matters because inclusion is
// TIME-DEPENDENT: a row whose content is byte-identical between two
// fetches can still legitimately age out of the rendered feed as `now`
// advances (e.g. crossing the 90-day historical boundary) — an ETag over
// the raw rows would not change in that case and would incorrectly let a
// stale 304 stand in for a feed that actually shrank. Order-independent
// (sorted) so two equivalent event sets always hash identically regardless
// of row order. Every property a change to which should invalidate the
// calendar is covered: uid, dtstart, dtend, summary, location, description,
// status. Deliberately never includes DTSTAMP or anything else request-
// time-varying — buildIcsCalendar's DTSTAMP legitimately differs between
// two calls even for identical content, which is exactly why the served
// ETag must be WEAK (see the route's own header comment) rather than a
// claim of byte-for-byte representation equality.
//
// Deliberately excludes lastModified too, even though it IS a real
// exported property: revision_at is computed (0174) as a MAX() over every
// source column touching this row's visible content, which can be
// slightly over-broad (e.g. an unrelated field on the same source row
// bumping its own updated_at). LAST-MODIFIED is merely an advisory hint to
// calendar clients and tolerates that imprecision; the HTTP-level ETag
// contract does not — it must stay keyed ONLY to fields that are
// genuinely, contractually part of the visible content, so a non-visible
// change can never falsely invalidate a client's cache. Every field that
// actually determines visible content (dtstart/dtend/summary/location/
// description/status) is already hashed directly above, so a real visible
// edit always changes the ETag regardless of lastModified's own precision.
export function computeFeedETag(events: readonly IcsEvent[]): string {
  const canonical = events
    .map(e => JSON.stringify({
      uid: e.uid,
      dtstart: e.dtstart.toISOString(),
      dtend: e.dtend.toISOString(),
      summary: e.summary,
      location: e.location ?? null,
      description: e.description ?? null,
      status: e.status ?? null,
    }))
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex");
}
