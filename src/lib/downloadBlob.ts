// Phase 34G-C2 — shared client-side Blob-download primitive, extracted
// from ImportMembersSheet.tsx's own local `triggerDownload` (identical
// body) now that a second consumer (the Payments CSV exports) needs it.
// ImportMembersSheet.tsx's own copy is left untouched — out of scope to
// refactor for this checkpoint.

// Final runtime-QA correction — Excel mis-detects a plain UTF-8 CSV's
// encoding (observed as mojibake: "Manual · Cash" rendering as
// "Manual ¬Σ Cash"). Prepending the standard UTF-8 byte-order-mark makes
// Excel reliably recognize the encoding — this also protects any future
// non-ASCII Member/participant name (e.g. "José García", "François") from
// the same corruption. A pure, separately-tested helper so this fix is
// verifiable without a DOM/Blob environment; RFC-4180 escaping and
// formula-injection protection remain entirely serializeCsv's concern —
// this never touches the CSV's actual content, only prepends the marker.
export const UTF8_BOM = "\uFEFF";

export function withUtf8Bom(csv: string): string {
  return csv.startsWith(UTF8_BOM) ? csv : UTF8_BOM + csv;
}

export function triggerCsvDownload(csv: string, filename: string) {
  const blob = new Blob([withUtf8Bom(csv)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
