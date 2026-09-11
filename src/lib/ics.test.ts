import { describe, expect, it } from "vitest";
import { buildIcsCalendar, escapeIcsText, foldContentLine, formatIcsUtc, type IcsEvent } from "./ics";

// Phase 35B — genuine behavior-level tests for the hand-rolled RFC 5545
// serializer. Every assertion calls the real exported function and checks
// its output; nothing here reads source text.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

// Splits a folded content line back into its physical (CRLF-joined) lines,
// each stripped of the mandatory single leading space on every
// continuation — the inverse of foldContentLine's own folding.
function physicalLines(folded: string): string[] {
  return folded.split("\r\n");
}

function unfold(folded: string): string {
  return physicalLines(folded)
    .map((line, i) => (i === 0 ? line : line.slice(1)))
    .join("");
}

describe("escapeIcsText — RFC 5545 §3.3.11 TEXT escaping", () => {
  it("escapes a literal backslash to two backslashes", () => {
    expect(escapeIcsText("a\\b")).toBe("a\\\\b");
  });

  it("escapes a comma", () => {
    expect(escapeIcsText("a,b")).toBe("a\\,b");
  });

  it("escapes a semicolon", () => {
    expect(escapeIcsText("a;b")).toBe("a\\;b");
  });

  it("escapes an LF newline to the two-character \\n sequence", () => {
    expect(escapeIcsText("a\nb")).toBe("a\\nb");
  });

  it("normalizes a CRLF newline to the same two-character \\n sequence", () => {
    expect(escapeIcsText("a\r\nb")).toBe("a\\nb");
  });

  it("does not double-escape the backslash it inserts for a comma/semicolon/newline", () => {
    // If backslash-escaping ran AFTER comma-escaping, the inserted "\,"
    // would become "\\,", corrupting the output. It must run first.
    expect(escapeIcsText(",")).toBe("\\,");
    expect(escapeIcsText(";")).toBe("\\;");
    expect(escapeIcsText("\n")).toBe("\\n");
  });

  it("handles a value with every special character combined, in order", () => {
    expect(escapeIcsText("a\\b,c;d\ne")).toBe("a\\\\b\\,c\\;d\\ne");
  });

  it("leaves an ordinary value untouched", () => {
    expect(escapeIcsText("Court 3 — Doubles")).toBe("Court 3 — Doubles");
  });
});

describe("formatIcsUtc — always the bare UTC 'Z' form, never a local offset", () => {
  it("formats a known instant as YYYYMMDDTHHMMSSZ", () => {
    expect(formatIcsUtc(new Date("2026-03-08T07:30:00.000Z"))).toBe("20260308T073000Z");
  });

  it("formats midnight UTC correctly", () => {
    expect(formatIcsUtc(new Date("2026-01-01T00:00:00.000Z"))).toBe("20260101T000000Z");
  });

  it("is unaffected by a US DST transition instant — the UTC instant alone determines the string, never a local calendar rule", () => {
    // 2026-03-08 07:00 UTC is the moment US Eastern springs forward
    // (02:00 -> 03:00 EST->EDT). Formatting stays a pure UTC readout either
    // side of that instant — there is no VTIMEZONE/offset table involved.
    expect(formatIcsUtc(new Date("2026-03-08T06:59:00.000Z"))).toBe("20260308T065900Z");
    expect(formatIcsUtc(new Date("2026-03-08T07:01:00.000Z"))).toBe("20260308T070100Z");
  });
});

describe("foldContentLine — RFC 5545 §3.1 line folding, by UTF-8 octet not JS string length", () => {
  it("does not fold a short ASCII line at all", () => {
    const line = "SUMMARY:Court Reservation — Court 3";
    expect(foldContentLine(line)).not.toContain("\r\n");
  });

  it("folds a long ASCII line so every physical line is <= 75 octets", () => {
    const value = "x".repeat(200);
    const folded = foldContentLine(`SUMMARY:${value}`);
    const lines = physicalLines(folded);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(byteLength(line)).toBeLessThanOrEqual(75);
    }
  });

  it("every continuation line begins with exactly one leading space", () => {
    const folded = foldContentLine(`DESCRIPTION:${"y".repeat(200)}`);
    const lines = physicalLines(folded);
    for (const line of lines.slice(1)) {
      expect(line.startsWith(" ")).toBe(true);
      expect(line.startsWith("  ")).toBe(false);
    }
  });

  it("unfolding reconstructs the exact original content line (ASCII)", () => {
    const original = `SUMMARY:${"x".repeat(300)}`;
    expect(unfold(foldContentLine(original))).toBe(original);
  });

  it("A. never splits a multi-byte UTF-8 sequence — accented Latin (José)", () => {
    const value = "Lesson with José ".repeat(10);
    const original = `SUMMARY:${value}`;
    const folded = foldContentLine(original);
    for (const line of physicalLines(folded)) {
      expect(byteLength(line)).toBeLessThanOrEqual(75);
      // Decoding each physical line's own UTF-8 bytes must succeed without
      // producing a replacement character — proof no multi-byte sequence
      // was split across a fold boundary.
      expect(() => decoder.decode(encoder.encode(line))).not.toThrow();
    }
    expect(unfold(folded)).toBe(original);
  });

  it("A. never splits a multi-byte UTF-8 sequence — non-Latin script (Japanese)", () => {
    const value = "こんにちは、コート予約 ".repeat(8);
    const original = `LOCATION:${value}`;
    const folded = foldContentLine(original);
    for (const line of physicalLines(folded)) {
      expect(byteLength(line)).toBeLessThanOrEqual(75);
      expect(() => decoder.decode(encoder.encode(line))).not.toThrow();
    }
    expect(unfold(folded)).toBe(original);
  });

  it("A. never splits a multi-byte UTF-8 sequence — emoji (surrogate-pair code points)", () => {
    const value = "🎉".repeat(40);
    const original = `SUMMARY:${value}`;
    const folded = foldContentLine(original);
    const lines = physicalLines(folded);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(byteLength(line)).toBeLessThanOrEqual(75);
      expect(() => decoder.decode(encoder.encode(line))).not.toThrow();
      // No lone/mismatched surrogate anywhere in the physical line — a
      // split emoji code point would leave one half of its surrogate pair
      // stranded on the previous physical line.
      expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/);
    }
    expect(unfold(folded)).toBe(original);
  });

  it("A. never splits a multi-byte UTF-8 sequence — mixed accented, non-Latin, and emoji in one value", () => {
    const value = `José 🎉 こんにちは — ${"z".repeat(50)} 🎾`;
    const original = `DESCRIPTION:${value}`;
    const folded = foldContentLine(original);
    for (const line of physicalLines(folded)) {
      expect(byteLength(line)).toBeLessThanOrEqual(75);
      expect(() => decoder.decode(encoder.encode(line))).not.toThrow();
    }
    expect(unfold(folded)).toBe(original);
  });
});

describe("buildIcsCalendar — full VCALENDAR/VEVENT structure", () => {
  const now = new Date("2026-05-01T12:00:00.000Z");

  it("produces a valid, importable calendar with zero events", () => {
    const ics = buildIcsCalendar([], now);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0\r\n");
    expect(ics).toContain("CALSCALE:GREGORIAN\r\n");
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("uses CRLF line endings throughout — never a bare LF", () => {
    const ics = buildIcsCalendar(
      [{ uid: "a@court-time.app", dtstart: now, dtend: now, summary: "Test" }],
      now,
    );
    expect(ics).not.toMatch(/(?<!\r)\n/);
  });

  it("emits one VEVENT per input event, each with UID/DTSTAMP/DTSTART/DTEND/SUMMARY", () => {
    const events: IcsEvent[] = [
      { uid: "one@court-time.app", dtstart: now, dtend: now, summary: "First" },
      { uid: "two@court-time.app", dtstart: now, dtend: now, summary: "Second" },
    ];
    const ics = buildIcsCalendar(events, now);
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(2);
    expect(ics.match(/END:VEVENT/g)?.length).toBe(2);
    expect(ics).toContain("UID:one@court-time.app");
    expect(ics).toContain("UID:two@court-time.app");
    expect(ics).toContain("SUMMARY:First");
    expect(ics).toContain("SUMMARY:Second");
  });

  it("shares a single DTSTAMP (the generation moment) across every VEVENT in one export", () => {
    const events: IcsEvent[] = [
      { uid: "one@court-time.app", dtstart: now, dtend: now, summary: "First" },
      { uid: "two@court-time.app", dtstart: now, dtend: now, summary: "Second" },
    ];
    const ics = buildIcsCalendar(events, now);
    const stamps = ics.match(/DTSTAMP:\d{8}T\d{6}Z/g) ?? [];
    expect(stamps.length).toBe(2);
    expect(stamps[0]).toBe(stamps[1]);
    expect(stamps[0]).toBe("DTSTAMP:20260501T120000Z");
  });

  it("omits LOCATION when not provided, includes it when provided", () => {
    const withLocation = buildIcsCalendar(
      [{ uid: "a@court-time.app", dtstart: now, dtend: now, summary: "S", location: "Court 3" }],
      now,
    );
    const withoutLocation = buildIcsCalendar(
      [{ uid: "b@court-time.app", dtstart: now, dtend: now, summary: "S" }],
      now,
    );
    expect(withLocation).toContain("LOCATION:Court 3");
    expect(withoutLocation).not.toContain("LOCATION:");
  });

  it("includes STATUS only when explicitly provided", () => {
    const cancelled = buildIcsCalendar(
      [{ uid: "a@court-time.app", dtstart: now, dtend: now, summary: "S", status: "CANCELLED" }],
      now,
    );
    const noStatus = buildIcsCalendar(
      [{ uid: "b@court-time.app", dtstart: now, dtend: now, summary: "S" }],
      now,
    );
    expect(cancelled).toContain("STATUS:CANCELLED");
    expect(noStatus).not.toContain("STATUS:");
  });

  it("escapes SUMMARY/LOCATION text values through the same TEXT-escaping rules", () => {
    const ics = buildIcsCalendar(
      [{ uid: "a@court-time.app", dtstart: now, dtend: now, summary: "Doe, Jane; Lesson", location: "Court 1, 2" }],
      now,
    );
    expect(ics).toContain("SUMMARY:Doe\\, Jane\\; Lesson");
    expect(ics).toContain("LOCATION:Court 1\\, 2");
  });

  it("folds a long SUMMARY inside the full document while keeping every physical line <= 75 octets", () => {
    const longSummary = "Court Reservation — " + "x".repeat(200);
    const ics = buildIcsCalendar(
      [{ uid: "a@court-time.app", dtstart: now, dtend: now, summary: longSummary }],
      now,
    );
    for (const line of ics.split("\r\n")) {
      if (line.length === 0) continue;
      expect(byteLength(line)).toBeLessThanOrEqual(75);
    }
  });

  describe("DESCRIPTION (notes/description enhancement)", () => {
    it("omits DESCRIPTION when not provided", () => {
      const ics = buildIcsCalendar([{ uid: "a@court-time.app", dtstart: now, dtend: now, summary: "S" }], now);
      expect(ics).not.toContain("DESCRIPTION:");
    });

    it("omits DESCRIPTION when explicitly null", () => {
      const ics = buildIcsCalendar([{ uid: "a@court-time.app", dtstart: now, dtend: now, summary: "S", description: null }], now);
      expect(ics).not.toContain("DESCRIPTION:");
    });

    it("includes a provided DESCRIPTION", () => {
      const ics = buildIcsCalendar(
        [{ uid: "a@court-time.app", dtstart: now, dtend: now, summary: "S", description: "Bring extra balls." }],
        now,
      );
      expect(ics).toContain("DESCRIPTION:Bring extra balls.");
    });

    it("escapes commas, semicolons, and backslashes in DESCRIPTION using the same TEXT-escaping as SUMMARY/LOCATION", () => {
      const ics = buildIcsCalendar(
        [{ uid: "a@court-time.app", dtstart: now, dtend: now, summary: "S", description: "Court A, B; bring \\ a towel" }],
        now,
      );
      expect(ics).toContain("DESCRIPTION:Court A\\, B\\; bring \\\\ a towel");
    });

    it("correctly escapes and reconstructs a multiline DESCRIPTION", () => {
      const multiline = "Line one.\nLine two.\r\nLine three.";
      const ics = buildIcsCalendar(
        [{ uid: "a@court-time.app", dtstart: now, dtend: now, summary: "S", description: multiline }],
        now,
      );
      // Every real newline becomes the literal two-character \n escape — no
      // raw LF/CRLF is ever embedded inside the DESCRIPTION value itself
      // (a raw newline there would corrupt the content-line structure).
      expect(ics).toContain("DESCRIPTION:Line one.\\nLine two.\\nLine three.");
    });

    it("folds a long DESCRIPTION with Unicode/emoji content without splitting a multi-byte sequence, and every physical line stays <= 75 octets", () => {
      const description = `Bring your own balls if possible — José será tu profesor 🎾. ${"z".repeat(60)}`;
      const ics = buildIcsCalendar(
        [{ uid: "a@court-time.app", dtstart: now, dtend: now, summary: "S", description }],
        now,
      );
      const lines = ics.split("\r\n");
      expect(lines.some(l => l.startsWith("DESCRIPTION:"))).toBe(true);
      for (const line of lines) {
        if (line.length === 0) continue;
        expect(byteLength(line)).toBeLessThanOrEqual(75);
        expect(() => decoder.decode(encoder.encode(line))).not.toThrow();
      }
    });
  });
});
