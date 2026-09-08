import { describe, expect, it } from "vitest";
import { csvCell, serializeCsv, centsToDecimalString, sanitizeFilenameSegment, type CsvColumn } from "./csv";

// Phase 34G-C2 — genuine unit tests for the CSV serialization helper.
// Covers RFC-4180 escaping, CRLF line endings, formula-injection
// protection (text cells only, never trusted numeric cells), and the
// small filename/money helpers exports depend on.

describe("csvCell — RFC-4180 escaping (§26 A)", () => {
  it("A. a plain value needs no quoting", () => {
    expect(csvCell("Jane Doe")).toBe("Jane Doe");
  });

  it("A. a value containing a comma is quoted", () => {
    expect(csvCell("Doe, Jane")).toBe('"Doe, Jane"');
  });

  it("A. a value containing an embedded double quote is quoted and the quote doubled", () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("A. a value containing a newline (LF) is quoted", () => {
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
  });

  it("A. a value containing a CRLF is quoted", () => {
    expect(csvCell("line one\r\nline two")).toBe('"line one\r\nline two"');
  });

  it("A. empty string and null/undefined all render as an empty, unquoted cell", () => {
    expect(csvCell("")).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("A. a numeric value is stringified", () => {
    expect(csvCell(42)).toBe("42");
  });
});

describe("csvCell — formula-injection protection (§26 B)", () => {
  it("B. a value starting with = is neutralized with a leading apostrophe", () => {
    expect(csvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
  });

  it("B. a value starting with + is neutralized", () => {
    expect(csvCell("+cmd")).toBe("'+cmd");
  });

  it("B. a value starting with - is neutralized", () => {
    expect(csvCell("-evil")).toBe("'-evil");
  });

  it("B. a value starting with @ is neutralized", () => {
    expect(csvCell("@formula")).toBe("'@formula");
  });

  it("B. a value with a leading tab is neutralized", () => {
    expect(csvCell("\tevil")).toBe("'\tevil");
  });

  it("B. a value with a leading CR is neutralized AND RFC-4180-quoted (the raw CR itself also requires quoting)", () => {
    expect(csvCell("\revil")).toBe('"\'\revil"');
  });

  it("B. a neutralized value that also needs RFC-4180 quoting gets both", () => {
    expect(csvCell("=A1,B1")).toBe('"\'=A1,B1"');
  });

  it("B. a value with = in the MIDDLE (not leading) is left untouched", () => {
    expect(csvCell("a=b")).toBe("a=b");
  });
});

describe("csvCell — trusted (protect: false) cells never get neutralized (§26 C)", () => {
  it("C. a genuine negative decimal Amount stays exactly '-10.00', never becomes text", () => {
    expect(csvCell("-10.00", { protect: false })).toBe("-10.00");
  });

  it("C. a positive decimal Amount is untouched", () => {
    expect(csvCell("50.00", { protect: false })).toBe("50.00");
  });

  it("C. an ISO timestamp is untouched even though it doesn't start with a trigger char", () => {
    expect(csvCell("2026-09-02T14:00:00.000Z", { protect: false })).toBe("2026-09-02T14:00:00.000Z");
  });
});

describe("serializeCsv — full document assembly", () => {
  interface Row { name: string; amount: string }
  const columns: CsvColumn<Row>[] = [
    { header: "Name", value: r => r.name },
    { header: "Amount", value: r => r.amount, protect: false },
  ];

  it("uses CRLF line endings between rows and after the header", () => {
    const csv = serializeCsv(columns, [{ name: "Jane", amount: "50.00" }]);
    expect(csv).toBe("Name,Amount\r\nJane,50.00\r\n");
  });

  it("a zero-row export still produces a valid CSV containing only the header row", () => {
    const csv = serializeCsv(columns, []);
    expect(csv).toBe("Name,Amount\r\n");
  });

  it("protects text columns but leaves protect:false columns (e.g. Amount) untouched, even when negative", () => {
    const csv = serializeCsv(columns, [{ name: "=EVIL()", amount: "-10.00" }]);
    expect(csv).toBe("Name,Amount\r\n'=EVIL(),-10.00\r\n");
  });

  it("multiple rows are each terminated with CRLF, including the last", () => {
    const csv = serializeCsv(columns, [
      { name: "A", amount: "1.00" },
      { name: "B", amount: "2.00" },
    ]);
    expect(csv).toBe("Name,Amount\r\nA,1.00\r\nB,2.00\r\n");
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});

describe("centsToDecimalString", () => {
  it("converts positive cents to a plain two-decimal string", () => {
    expect(centsToDecimalString(5000)).toBe("50.00");
  });

  it("converts negative cents to a plain two-decimal string, sign preserved", () => {
    expect(centsToDecimalString(-1000)).toBe("-10.00");
  });

  it("zero cents renders as '0.00', not blank", () => {
    expect(centsToDecimalString(0)).toBe("0.00");
  });

  it("null/undefined render as an empty string (blank cell), never a fabricated 0.00", () => {
    expect(centsToDecimalString(null)).toBe("");
    expect(centsToDecimalString(undefined)).toBe("");
  });
});

describe("sanitizeFilenameSegment", () => {
  it("lowercases and keeps a normal slug unchanged", () => {
    expect(sanitizeFilenameSegment("riverside-tennis")).toBe("riverside-tennis");
  });

  it("collapses spaces/invalid characters to hyphens", () => {
    expect(sanitizeFilenameSegment("Riverside Tennis Club!")).toBe("riverside-tennis-club");
  });

  it("strips leading/trailing hyphens produced by collapsing", () => {
    expect(sanitizeFilenameSegment("  --weird--  ")).toBe("weird");
  });

  it("falls back to 'club' for an entirely-invalid or empty input", () => {
    expect(sanitizeFilenameSegment("")).toBe("club");
    expect(sanitizeFilenameSegment("!!!")).toBe("club");
  });
});
