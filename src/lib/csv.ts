// Phase 34G-C2 — RFC-4180-compatible CSV serialization with spreadsheet
// formula-injection protection. Deliberately NOT a reuse of
// ImportMembersSheet.tsx's own inline CSV row-joining (that code is a
// naive `"${a}","${b}"` template with no escaping of embedded quotes,
// commas, or newlines, and no formula-injection protection at all — unsafe
// for this export's data, which includes free-text member/participant
// names, external references, and notes). This module is the one, shared,
// tested serializer for both Payments CSV exports.

export type CsvCellValue = string | number | null | undefined;

export interface CsvColumn<Row> {
  header: string;
  value: (row: Row) => CsvCellValue;
  // Text cells (the default) get formula-injection neutralization before
  // RFC-4180 escaping — a value starting with =, +, -, @, or a leading
  // tab/CR is prefixed with a leading apostrophe so a spreadsheet never
  // interprets user-entered text as a formula. Set protect: false ONLY for
  // values this codebase itself generates and fully controls the content
  // of — a signed decimal Amount, an ISO date/timestamp, or a UUID — so a
  // genuine negative Amount like "-10.00" is never corrupted into text.
  protect?: boolean;
}

const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;

function neutralizeFormulaInjection(raw: string): string {
  return FORMULA_TRIGGER_RE.test(raw) ? `'${raw}` : raw;
}

function escapeRfc4180(raw: string): string {
  const needsQuoting = /[",\r\n]/.test(raw);
  const escaped = raw.replace(/"/g, '""');
  return needsQuoting ? `"${escaped}"` : escaped;
}

// Renders one cell: null/undefined -> empty string, otherwise String(value),
// optionally formula-neutralized, then RFC-4180 escaped/quoted as needed.
export function csvCell(value: CsvCellValue, options: { protect?: boolean } = {}): string {
  const protect = options.protect ?? true;
  const raw = value === null || value === undefined ? "" : String(value);
  const neutralized = protect ? neutralizeFormulaInjection(raw) : raw;
  return escapeRfc4180(neutralized);
}

// Serializes a full CSV document — header row + one row per item — using
// CRLF line endings throughout (RFC 4180). A zero-row `rows` array still
// produces a valid CSV containing only the header line — never an error,
// never an empty file. Header text is treated as trusted (protect: false)
// since it's always a fixed, code-defined string, never user input.
export function serializeCsv<Row>(columns: CsvColumn<Row>[], rows: Row[]): string {
  const lines = [columns.map(c => csvCell(c.header, { protect: false })).join(",")];
  for (const row of rows) {
    lines.push(columns.map(c => csvCell(c.value(row), { protect: c.protect ?? true })).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// Cents -> plain decimal string for a spreadsheet-friendly, summable
// numeric Amount cell — "50.00" / "-10.00", never a currency-symbol-
// prefixed display string (that's formatMoney's job, for human-facing UI,
// not this export). Null/undefined -> "" (blank cell, never a fabricated
// "0.00").
export function centsToDecimalString(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

// Sanitizes one filename path segment: lowercase, ASCII letters/digits/
// hyphens only, everything else collapsed to a single hyphen, no leading/
// trailing hyphens. Used for the club-slug component of export filenames —
// club slugs are already URL-safe by construction, but this stays
// defensive rather than trusting that invariant at the filename boundary.
export function sanitizeFilenameSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "club";
}
