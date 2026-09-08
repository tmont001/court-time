import { describe, expect, it, vi } from "vitest";
import { fetchAllRowsExhaustively } from "./exhaustiveRange";

// Phase 34G-C1 — genuine unit tests for the generic exhaustive-pagination
// helper. Proves it never silently stops short of the true row count
// (item J) — the exact truncation risk a single unbounded .select() would
// carry.

describe("fetchAllRowsExhaustively", () => {
  it("returns every row across multiple full pages plus one short final page, never truncating", async () => {
    const allRows = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
    const fetchPage = vi.fn(async (offset: number, limit: number) => ({
      data: allRows.slice(offset, offset + limit),
      error: null,
    }));

    const { rows, error } = await fetchAllRowsExhaustively(fetchPage, 1000);

    expect(error).toBeNull();
    expect(rows.length).toBe(2500);
    expect(rows).toEqual(allRows);
    // 1000 + 1000 + 500 — three pages, the third short enough to stop on.
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("stops after exactly one page when the first page is already short", async () => {
    const fetchPage = vi.fn(async () => ({ data: [{ id: 1 }, { id: 2 }], error: null }));
    const { rows } = await fetchAllRowsExhaustively(fetchPage, 1000);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("returns an empty result set (never an error) when there are zero rows", async () => {
    const fetchPage = vi.fn(async () => ({ data: [], error: null }));
    const { rows, error } = await fetchAllRowsExhaustively(fetchPage, 1000);
    expect(rows).toEqual([]);
    expect(error).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("stops immediately on error, returning whatever rows had already accumulated plus the error message — never silently swallowing a mid-pagination failure", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: 1 }], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } });

    const { rows, error } = await fetchAllRowsExhaustively(fetchPage, 1);

    expect(error).toBe("boom");
    expect(rows).toEqual([{ id: 1 }]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("a page exactly equal to pageSize always triggers one more fetch to confirm completion, even if that next page turns out empty", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: 1 }, { id: 2 }], error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    const { rows } = await fetchAllRowsExhaustively(fetchPage, 2);

    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("calls fetchPage with correctly incrementing offsets", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: new Array(3).fill({}), error: null })
      .mockResolvedValueOnce({ data: [{}], error: null });

    await fetchAllRowsExhaustively(fetchPage, 3);

    expect(fetchPage).toHaveBeenNthCalledWith(1, 0, 3);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 3, 3);
  });
});
