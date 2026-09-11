// ics.ts — Phase 35B: a small, hand-rolled RFC 5545 (iCalendar) serializer.
//
// No dependency is added for this — the surface needed (VCALENDAR/VEVENT,
// TEXT escaping, line folding) is small, fully specified, and every value
// this module receives is already known/typed server-side, so a tested
// ~100-line serializer is lower total cost and lower supply-chain surface
// than vetting/pinning a third-party library.
//
// CRITICAL: RFC 5545 line folding (§3.1) is defined in OCTETS (UTF-8 bytes),
// not JS string.length/UTF-16 code units. foldContentLine below folds by
// encoding each Unicode code point to UTF-8 and tracking the running byte
// count — never JS string length — so a fold can never land inside a
// multi-byte UTF-8 sequence.

export interface IcsEvent {
  uid: string;
  dtstart: Date;
  dtend: Date;
  summary: string;
  location?: string | null;
  // Phase 35B (notes/description enhancement): free text, e.g. a Lesson's
  // shared member_note or a Program's participant-visible description.
  // Reuses the exact same TEXT escaping/folding as SUMMARY/LOCATION below —
  // RFC 5545 draws no distinction between TEXT-valued properties, so
  // multiline/comma/semicolon/backslash/Unicode all work identically.
  // Callers decide WHETHER a given field is safe to put here at all (see
  // @/lib/calendar/export's safeDescription and the per-domain callers in
  // the route) — this module only ever serializes what it's given.
  description?: string | null;
  // Phase 35C runtime correction: the authoritative "this VEVENT's visible
  // content last changed at this instant" signal, derived server-side per
  // domain from existing updated_at columns (and any other column whose
  // change affects a feed-visible property — see
  // @/lib/calendar/feed.ts and migration 0174 for the exact per-domain
  // formula). Optional and 35B-backward-compatible: 35B's one-off exports
  // never set this and remain unaffected; 35C's subscription feed always
  // does. Emitted as LAST-MODIFIED, the same UTC DATE-TIME form as DTSTAMP.
  lastModified?: Date;
  status?: "CONFIRMED" | "CANCELLED";
}

const FOLD_LIMIT_OCTETS = 75;
const PROD_ID = "-//Court Time//Calendar Export//EN";

const utf8Encoder = new TextEncoder();

// RFC 5545 §3.3.11 TEXT escaping. Order matters: the backslash escape MUST
// run first, before any of the other replacements introduce new backslashes
// of their own — otherwise a comma/semicolon/newline's inserted backslash
// would itself get escaped on a later pass.
export function escapeIcsText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\n/g, "\\n");
}

// RFC 5545 §3.1 content-line folding. Operates on Unicode code points (JS
// string iteration already never splits a surrogate pair, so a multi-byte
// character is always handled atomically) and measures each code point's
// UTF-8 byte length via TextEncoder — never string length — before deciding
// whether it still fits in the current 75-octet physical line. A
// continuation line's mandatory single leading space is charged against
// that line's own 75-octet budget, so no physical line (folded or not) ever
// exceeds FOLD_LIMIT_OCTETS octets.
export function foldContentLine(line: string): string {
  let out = "";
  let lineOctets = 0;
  let isFirstPhysicalLine = true;

  for (const ch of line) {
    const chOctets = utf8Encoder.encode(ch).length;
    const budget = isFirstPhysicalLine ? FOLD_LIMIT_OCTETS : FOLD_LIMIT_OCTETS - 1;
    if (lineOctets > 0 && lineOctets + chOctets > budget) {
      out += "\r\n ";
      isFirstPhysicalLine = false;
      lineOctets = 0;
    }
    out += ch;
    lineOctets += chOctets;
  }
  return out;
}

// YYYYMMDDTHHMMSSZ — always UTC ("Z" form). Phase 35B never emits a
// VTIMEZONE/TZID: every domain's authoritative start/end is already a
// timestamptz (UTC instant) in Postgres, so formatting it directly in UTC
// is both simplest and correct — the importing calendar client renders it
// in the viewer's own configured timezone, exactly as intended.
export function formatIcsUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function buildVevent(event: IcsEvent, dtstamp: string): string[] {
  const lines = [
    "BEGIN:VEVENT",
    foldContentLine(`UID:${event.uid}`),
    foldContentLine(`DTSTAMP:${dtstamp}`),
    foldContentLine(`DTSTART:${formatIcsUtc(event.dtstart)}`),
    foldContentLine(`DTEND:${formatIcsUtc(event.dtend)}`),
    foldContentLine(`SUMMARY:${escapeIcsText(event.summary)}`),
  ];
  if (event.location) {
    lines.push(foldContentLine(`LOCATION:${escapeIcsText(event.location)}`));
  }
  if (event.description) {
    lines.push(foldContentLine(`DESCRIPTION:${escapeIcsText(event.description)}`));
  }
  if (event.lastModified) {
    lines.push(foldContentLine(`LAST-MODIFIED:${formatIcsUtc(event.lastModified)}`));
  }
  if (event.status) {
    lines.push(foldContentLine(`STATUS:${event.status}`));
  }
  lines.push("END:VEVENT");
  return lines;
}

// Serializes a complete VCALENDAR document — zero or more VEVENTs — with
// CRLF line endings throughout, per RFC 5545. A zero-event array still
// produces a valid, importable (empty) calendar, never an error. DTSTAMP is
// the moment of generation (now), shared by every VEVENT in one export —
// never a stored value, per RFC 5545 §3.8.7.2.
//
// SEQUENCE remains deliberately omitted, reassessed and reconfirmed during
// the Phase 35C runtime correction (which DID add LAST-MODIFIED, precisely
// because runtime evidence showed update semantics matter for a
// subscription): no domain table carries a genuine monotonic revision
// counter, and deriving one from a timestamp (e.g. epoch seconds) would be
// exactly the brittle, direction-unstable arithmetic explicitly rejected in
// favor of the combination this module and @/lib/calendar/feed.ts actually
// implement — stable UID + LAST-MODIFIED + changed DTSTART/DTEND/SUMMARY/
// LOCATION/STATUS + a semantic ETag at the HTTP layer. Revisit only if real
// calendar-client behavior (Apple/Google) is observed to require it.
export function buildIcsCalendar(events: IcsEvent[], now: Date = new Date()): string {
  const dtstamp = formatIcsUtc(now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    foldContentLine(`PRODID:${PROD_ID}`),
    "CALSCALE:GREGORIAN",
  ];
  for (const event of events) {
    lines.push(...buildVevent(event, dtstamp));
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
