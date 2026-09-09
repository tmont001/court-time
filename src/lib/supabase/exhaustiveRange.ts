// Phase 34G-C1 — generic helper for exhaustively paging through a
// Supabase/PostgREST result set via repeated .range() calls, rather than
// relying on a single unbounded .select() (which PostgREST silently caps
// at its own default row limit — nothing in this codebase has previously
// needed to avoid that, since every existing large-list read either caps
// intentionally, at page.tsx.MAX_ROWS =500 style limits, or pages a small
// UI window at a time). Deliberately generic over the row shape and over
// the query itself (a plain page-fetching callback, not a Supabase query
// builder type) so this is trivially reusable anywhere a bulk, tenant-
// scoped read must not silently truncate — including 34G-C2's CSV
// exports, which need the identical guarantee over potentially large
// payment_events result sets.

const DEFAULT_PAGE_SIZE = 1000;

export interface ExhaustiveRangeResult<T> {
  rows: T[];
  error: string | null;
}

// `fetchPage(offset, limit)` must itself apply `.range(offset, offset +
// limit - 1)` (or equivalent) to the caller's own query — this helper only
// owns the looping/accumulation, never the query shape itself.
export async function fetchAllRowsExhaustively<T>(
  fetchPage: (offset: number, limit: number) => Promise<{ data: T[] | null; error: { message: string } | null }>,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<ExhaustiveRangeResult<T>> {
  const rows: T[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await fetchPage(offset, pageSize);
    if (error) return { rows, error: error.message };

    const page = data ?? [];
    rows.push(...page);

    // A page shorter than the requested size is the only reliable
    // "no more rows" signal — never assume completion from a full page,
    // which could simply mean the next page is also full.
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return { rows, error: null };
}

// Phase 34G-C2 correction — a large `.in(<column>, ids)` clause carries two
// independent truncation risks: (1) a single query can still silently cap
// at PostgREST's default row limit even when the ID list is small (the
// exact risk fetchAllRowsExhaustively above already solves), and (2) an
// arbitrarily large ID list sent in ONE query can itself be unreasonable
// (URL/query-plan size) regardless of how many rows come back. This helper
// solves both together: it de-duplicates and splits `ids` into bounded
// chunks, exhaustively pages EACH chunk via fetchAllRowsExhaustively, and
// accumulates every row across every chunk.
//
// Fails EXPLICITLY and IMMEDIATELY on any chunk/page error — never returns
// a partial result as if it were a success. Financial export data must
// never silently ship a truncated read; the caller is expected to check
// `error` and discard `rows` entirely when it is non-null (rows accumulated
// before the failing chunk are still returned alongside the error purely
// for diagnostic/logging purposes, never for display or export).
export async function fetchRowsByIdsExhaustively<T>(
  ids: string[],
  fetchChunkPage: (
    chunkIds: string[],
    offset: number,
    limit: number,
  ) => Promise<{ data: T[] | null; error: { message: string } | null }>,
  options: { chunkSize?: number; pageSize?: number } = {},
): Promise<ExhaustiveRangeResult<T>> {
  const chunkSize = options.chunkSize ?? 200;
  const uniqueIds = [...new Set(ids)];
  const rows: T[] = [];

  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunkIds = uniqueIds.slice(i, i + chunkSize);
    const chunkResult = await fetchAllRowsExhaustively<T>(
      (offset, limit) => fetchChunkPage(chunkIds, offset, limit),
      options.pageSize,
    );
    if (chunkResult.error) {
      // Stop immediately — do not attempt further chunks, and the caller
      // must treat `rows` here as informational only, never usable output.
      return { rows, error: chunkResult.error };
    }
    rows.push(...chunkResult.rows);
  }

  return { rows, error: null };
}
