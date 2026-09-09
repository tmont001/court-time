import { describe, expect, it, vi } from "vitest";
import { fetchAllRowsExhaustively, fetchRowsByIdsExhaustively } from "./exhaustiveRange";

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

// Phase 34G-C2 correction (Issue 3) — genuine unit tests for the
// chunked+exhaustive ID-lookup helper.
describe("fetchRowsByIdsExhaustively", () => {
  it("accumulates >1000 synthetic rows across multiple pages within a single chunk", async () => {
    const allRows = Array.from({ length: 1500 }, (_, i) => ({ id: `id-${i}` }));
    const ids = allRows.map(r => r.id);
    const fetchChunkPage = vi.fn(async (chunkIds: string[], offset: number, limit: number) => ({
      data: allRows.filter(r => chunkIds.includes(r.id)).slice(offset, offset + limit),
      error: null,
    }));

    const { rows, error } = await fetchRowsByIdsExhaustively(ids, fetchChunkPage, { chunkSize: 5000, pageSize: 1000 });

    expect(error).toBeNull();
    expect(rows.length).toBe(1500);
  });

  it("splits a large ID list into multiple chunks and accumulates rows from every chunk", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const fetchChunkPage = vi.fn(async (chunkIds: string[]) => ({
      data: chunkIds.map(id => ({ id })),
      error: null,
    }));

    const { rows, error } = await fetchRowsByIdsExhaustively(ids, fetchChunkPage, { chunkSize: 200 });

    expect(error).toBeNull();
    expect(rows.length).toBe(450);
    // 200 + 200 + 50 — three chunks.
    expect(fetchChunkPage).toHaveBeenCalledTimes(3);
    expect((fetchChunkPage.mock.calls[0][0] as string[]).length).toBe(200);
    expect((fetchChunkPage.mock.calls[1][0] as string[]).length).toBe(200);
    expect((fetchChunkPage.mock.calls[2][0] as string[]).length).toBe(50);
  });

  it("de-duplicates ids before chunking — a repeated id is fetched only once", async () => {
    const ids = ["a", "b", "a", "c", "b"];
    const fetchChunkPage = vi.fn(async (chunkIds: string[]) => ({ data: chunkIds.map(id => ({ id })), error: null }));

    await fetchRowsByIdsExhaustively(ids, fetchChunkPage, { chunkSize: 200 });

    expect(fetchChunkPage.mock.calls[0][0]).toEqual(["a", "b", "c"]);
  });

  it("an error in any later page/chunk fails the whole operation — returns the error, never masks it as success", async () => {
    const fetchChunkPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "a" }], error: null }) // chunk 1 succeeds
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } }); // chunk 2 fails

    const { rows, error } = await fetchRowsByIdsExhaustively(
      ["a", "b"],
      fetchChunkPage,
      { chunkSize: 1 },
    );

    expect(error).toBe("boom");
    // Rows from the successful chunk before the failure may still be
    // present for diagnostics, but the non-null error is the caller's
    // signal to discard them entirely rather than use a partial result.
    expect(rows).toEqual([{ id: "a" }]);
  });

  it("an error mid-page within one chunk also fails the whole operation", async () => {
    const fetchChunkPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "a" }], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "mid-page failure" } });

    const { error } = await fetchRowsByIdsExhaustively(
      ["a", "b", "c"],
      fetchChunkPage,
      { chunkSize: 200, pageSize: 1 },
    );

    expect(error).toBe("mid-page failure");
  });

  it("an empty id list returns an empty result with no error and no calls", async () => {
    const fetchChunkPage = vi.fn(async () => ({ data: [], error: null }));
    const { rows, error } = await fetchRowsByIdsExhaustively([], fetchChunkPage);
    expect(rows).toEqual([]);
    expect(error).toBeNull();
    expect(fetchChunkPage).not.toHaveBeenCalled();
  });
});
