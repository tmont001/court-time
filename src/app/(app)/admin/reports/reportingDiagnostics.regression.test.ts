import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeReportingRpcError, logReportingRpcFailure } from "./reportingDiagnostics";

function readPageSource(): string {
  return readFileSync(
    join(process.cwd(), "src/app/(app)/admin/reports/page.tsx"),
    "utf-8"
  );
}

// Checkpoint 1 — Reports observability only. Proves the sanitized
// server-side diagnostic this checkpoint adds, without touching RPC logic
// or the user-facing "Data unavailable — try refreshing." UI text (that
// text lives in page.tsx's UnavailableState and is untouched by this
// checkpoint — not re-asserted here since this file covers the new
// logging helper only).

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sanitizeReportingRpcError — pure diagnostic shape", () => {
  it("1+3. includes the rpc name and retains code/message/hint when present", () => {
    const diagnostic = sanitizeReportingRpcError("get_reporting_overview", {
      code: "42883",
      message: 'column "eg.status" does not exist',
      hint: "Perhaps you meant to reference the column eg.status_.",
    });
    expect(diagnostic).toEqual({
      rpc: "get_reporting_overview",
      code: "42883",
      message: 'column "eg.status" does not exist',
      hint: "Perhaps you meant to reference the column eg.status_.",
    });
  });

  it("2. rpc name is correct per call site, not a shared/hardcoded value", () => {
    const a = sanitizeReportingRpcError("get_event_program_summary", { message: "boom" });
    const b = sanitizeReportingRpcError("get_member_engagement_summary", { message: "boom" });
    expect(a.rpc).toBe("get_event_program_summary");
    expect(b.rpc).toBe("get_member_engagement_summary");
  });

  it("omits hint when absent rather than including it as null/undefined", () => {
    const diagnostic = sanitizeReportingRpcError("get_court_utilization", {
      code: "P0001",
      message: "insufficient_role",
    });
    expect(diagnostic).toEqual({ rpc: "get_court_utilization", code: "P0001", message: "insufficient_role" });
    expect("hint" in diagnostic).toBe(false);
  });

  it("4. the sanitized object is a closed allowlist — only rpc/code/message/hint can ever appear, even if the error carries extra fields", () => {
    const diagnostic = sanitizeReportingRpcError("get_waitlist_demand", {
      code: "PGRST301",
      message: "JWT expired",
      hint: null,
      // Deliberately probing that extra/sensitive fields on the error
      // object are never read or forwarded by the sanitizer.
      access_token: "sk_live_should_never_appear",
      authorization: "Bearer super-secret-token",
      cookie: "sb-access-token=super-secret",
      profile: { id: "user-1", email: "member@example.com", full_name: "Jane Member" },
    } as unknown as Parameters<typeof sanitizeReportingRpcError>[1]);

    expect(Object.keys(diagnostic).sort()).toEqual(["code", "message", "rpc"]);
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("sk_live");
    expect(serialized).not.toContain("member@example.com");
    expect(serialized).not.toContain("Jane Member");
  });
});

describe("logReportingRpcFailure — console wiring", () => {
  it("1. logs exactly once, with the sanitized diagnostic, when an error is present", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logReportingRpcFailure("get_reporting_overview", { code: "42883", message: "column does not exist" });

    expect(spy).toHaveBeenCalledTimes(1);
    const [, diagnostic] = spy.mock.calls[0];
    expect(diagnostic).toEqual({
      rpc: "get_reporting_overview",
      code: "42883",
      message: "column does not exist",
    });
  });

  it("6. does not log anything for a null or undefined error (the successful-call shape)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logReportingRpcFailure("get_reservation_summary", null);
    logReportingRpcFailure("get_reservation_summary", undefined);
    expect(spy).not.toHaveBeenCalled();
  });

  it("4. never logs secret-shaped values even if smuggled onto the error object", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logReportingRpcFailure("get_member_engagement_summary", {
      message: "boom",
      // Same probe as above, at the logging wrapper level.
      supabaseKey: "service-role-secret-value",
    } as unknown as Parameters<typeof logReportingRpcFailure>[1]);

    expect(spy).toHaveBeenCalledTimes(1);
    const loggedArgs = spy.mock.calls[0];
    expect(JSON.stringify(loggedArgs)).not.toContain("service-role-secret-value");
  });
});

describe("page.tsx wiring — all six reporting RPCs are logged, UI behavior untouched", () => {
  it("2. logReportingRpcFailure is called once per reporting RPC, with the correct rpc name and its own result.error", () => {
    const s = readPageSource();
    const calls: [string, string][] = [
      ["get_reporting_overview", "overviewResult"],
      ["get_court_utilization", "courtsResult"],
      ["get_reservation_summary", "reservationsResult"],
      ["get_event_program_summary", "eventProgramResult"],
      ["get_waitlist_demand", "waitlistResult"],
      ["get_member_engagement_summary", "engagementResult"],
    ];
    for (const [rpcName, resultVar] of calls) {
      expect(s).toContain(`logReportingRpcFailure("${rpcName}", ${resultVar}.error);`);
    }
  });

  it("5. the UnavailableState user-facing copy is byte-identical to before this checkpoint", () => {
    const s = readPageSource();
    expect(s).toContain("Data unavailable — try refreshing.");
  });

  it("5. every *Failed boolean's computation is unchanged by this checkpoint (still error-or-missing-row, nothing logging-related folded in)", () => {
    const s = readPageSource();
    expect(s).toContain("const overviewFailed = !!overviewResult.error || !overview;");
    expect(s).toContain("const courtsFailed = !!courtsResult.error;");
    expect(s).toContain("const reservationsFailed = !!reservationsResult.error || !reservationSummary;");
    expect(s).toContain("const eventProgramFailed = !!eventProgramResult.error || !eventProgram;");
    expect(s).toContain("const waitlistFailed = !!waitlistResult.error || !waitlist;");
    expect(s).toContain("const engagementFailed = !!engagementResult.error || !engagement;");
  });

  it("this checkpoint introduces no new RPC call and no RPC argument change — rpcArgs is still the sole args object, still built once", () => {
    const s = readPageSource();
    const rpcArgsMatches = s.match(/const rpcArgs = /g) ?? [];
    expect(rpcArgsMatches.length).toBe(1);
    expect(s.match(/supabase\.rpc\(/g)?.length).toBe(6);
  });
});
