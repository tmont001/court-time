import { describe, expect, it } from "vitest";
import { UTF8_BOM, withUtf8Bom } from "./downloadBlob";
import { serializeCsv, type CsvColumn } from "./csv";

// Final runtime-QA correction — genuine unit tests for the pure UTF-8 BOM
// helper. triggerCsvDownload itself (DOM/Blob side effects) stays
// untested, matching this project's existing convention for browser-only
// download primitives (ImportMembersSheet.tsx's own triggerDownload was
// never unit tested either) — only the pure prepend logic is testable
// without a DOM environment, and that's exactly where the actual fix lives.

describe("withUtf8Bom", () => {
  it("downloaded CSV text begins with the UTF-8 BOM", () => {
    const result = withUtf8Bom("Name,Amount\r\nJane,50.00\r\n");
    expect(result.startsWith(UTF8_BOM)).toBe(true);
    expect(result.charCodeAt(0)).toBe(0xfeff);
  });

  it("UTF-8 text such as 'Manual · Cash' remains intact after the BOM prepend", () => {
    const result = withUtf8Bom("Source\r\nManual · Cash\r\nOnline · Stripe\r\n");
    expect(result).toContain("Manual · Cash");
    expect(result).toContain("Online · Stripe");
    expect(result).toBe(UTF8_BOM + "Source\r\nManual · Cash\r\nOnline · Stripe\r\n");
  });

  it("accented Member/participant names (José García, François) remain intact", () => {
    const result = withUtf8Bom("Member\r\nJosé García\r\nFrançois\r\n");
    expect(result).toContain("José García");
    expect(result).toContain("François");
  });

  it("negative numeric amounts remain numeric-looking strings, unaffected by the BOM", () => {
    const result = withUtf8Bom("Amount\r\n-10.00\r\n50.00\r\n");
    expect(result).toContain("-10.00");
    expect(result).toContain("50.00");
    // Not corrupted into a quoted/text-protected form by the BOM prepend.
    expect(result).not.toContain('"-10.00"');
  });

  it("does not double-prepend the BOM if the CSV text already starts with one", () => {
    const alreadyPrefixed = UTF8_BOM + "Name\r\nJane\r\n";
    const result = withUtf8Bom(alreadyPrefixed);
    expect(result).toBe(alreadyPrefixed);
    expect(result.startsWith(UTF8_BOM + UTF8_BOM)).toBe(false);
  });

  it("an empty CSV still gets a BOM prepended", () => {
    expect(withUtf8Bom("")).toBe(UTF8_BOM);
  });
});

describe("withUtf8Bom composed with serializeCsv — RFC-4180 and formula-injection protection remain intact end-to-end", () => {
  interface Row { name: string; amount: string }
  const columns: CsvColumn<Row>[] = [
    { header: "Name", value: r => r.name },
    { header: "Amount", value: r => r.amount, protect: false },
  ];

  it("RFC-4180 quoting/escaping (comma, embedded quote) survives the BOM prepend unchanged", () => {
    const csv = serializeCsv(columns, [{ name: 'Doe, "Jane"', amount: "50.00" }]);
    const result = withUtf8Bom(csv);
    expect(result).toBe(UTF8_BOM + 'Name,Amount\r\n"Doe, ""Jane""",50.00\r\n');
  });

  it("formula-injection neutralization ('=EVIL()' -> \"'=EVIL()\") survives the BOM prepend unchanged, while the numeric Amount column stays untouched", () => {
    const csv = serializeCsv(columns, [{ name: "=EVIL()", amount: "-10.00" }]);
    const result = withUtf8Bom(csv);
    expect(result).toBe(UTF8_BOM + "Name,Amount\r\n'=EVIL(),-10.00\r\n");
  });

  it("CRLF line endings are preserved exactly, with the BOM only ever at the very start of the document", () => {
    const csv = serializeCsv(columns, [{ name: "A", amount: "1.00" }, { name: "B", amount: "2.00" }]);
    const result = withUtf8Bom(csv);
    expect(result.indexOf(UTF8_BOM)).toBe(0);
    expect(result.lastIndexOf(UTF8_BOM)).toBe(0);
    expect(result.endsWith("\r\n")).toBe(true);
  });
});
