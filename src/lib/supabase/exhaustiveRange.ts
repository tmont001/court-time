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
