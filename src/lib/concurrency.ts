// Phase 45B — bounded-concurrency notification fan-out.
//
// sendAnnouncementAction and cancelEvent both dispatch one independent,
// network-bound notification per recipient after their RPC returns. A club-
// wide announcement can eventually reach hundreds/thousands of recipients,
// so neither a fully sequential loop (Server Action latency scales linearly
// with roster size) nor an unbounded Promise.all (every recipient's
// SMS/email dispatch in flight at once) is acceptable. This runs `worker`
// over `items` with at most `limit` in flight at a time — chunked
// Promise.all, no external dependency, no queue/background infrastructure.
//
// `worker` is expected to isolate its own failure (as both call sites
// already do via a per-item try/catch) — a rejection here is not given any
// special handling, so an unhandled rejection would still reject the
// current chunk's Promise.all and skip starting the next chunk.
export async function runWithBoundedConcurrency<T>(
  items:   readonly T[],
  limit:   number,
  worker:  (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(worker));
  }
}

// No repo evidence favors a different value — small enough to bound
// simultaneous outbound SMS/email/DB calls, large enough that this is a
// real improvement over one-at-a-time dispatch.
export const DEFAULT_DISPATCH_CONCURRENCY = 8;
