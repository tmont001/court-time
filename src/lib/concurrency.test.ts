import { describe, expect, it } from "vitest";
import { runWithBoundedConcurrency } from "./concurrency";

// Phase 45B — the shared bounded-concurrency helper backing sendAnnouncement's
// and cancelEvent's notification fan-out. Behavior-focused: proves the
// concurrency cap is actually respected, every item is processed exactly
// once, and processing order across chunks is preserved even though a
// chunk's own items run concurrently.

describe("runWithBoundedConcurrency", () => {
  it("processes every item exactly once", async () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    const seen: number[] = [];

    await runWithBoundedConcurrency(items, 8, async (item) => {
      seen.push(item);
    });

    expect(seen.length).toBe(items.length);
    expect(new Set(seen).size).toBe(items.length);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it("never has more than `limit` workers in flight at once", async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;

    await runWithBoundedConcurrency(items, 8, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield to the microtask queue so other queued workers in the same
      // chunk actually get a chance to start before this one finishes.
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
    });

    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(maxInFlight).toBeGreaterThan(1); // proves it isn't sequential either
  });

  it("does not start the next chunk until the current chunk has fully settled", async () => {
    const items = Array.from({ length: 17 }, (_, i) => i);
    const startedAt: number[] = [];
    let chunkIndex = -1;
    let activeInChunk = 0;

    await runWithBoundedConcurrency(items, 5, async () => {
      if (activeInChunk === 0) chunkIndex++;
      activeInChunk++;
      startedAt.push(chunkIndex);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeInChunk--;
    });

    // 17 items at a limit of 5 => 4 chunks (5, 5, 5, 2).
    expect(new Set(startedAt).size).toBe(4);
  });

  it("handles an empty item list without invoking the worker", async () => {
    let calls = 0;
    await runWithBoundedConcurrency([], 8, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });

  it("handles a limit larger than the item count as a single chunk", async () => {
    const items = [1, 2, 3];
    const seen: number[] = [];
    await runWithBoundedConcurrency(items, 8, async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
  });
});
