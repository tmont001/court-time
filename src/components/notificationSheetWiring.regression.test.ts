import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 36E — regression coverage for wiring NotificationSheet to the
// Phase 36A resolver, using this repository's established source-
// inspection style (see reservationDeepLink.regression.test.ts's own
// header comment, itself citing reservationCheckout.regression.test.ts,
// for why: this baseline is deliberately pure-TypeScript, no jsdom/React
// Testing Library available for a "use client" component). Real resolver
// BEHAVIOR (which path each kind produces) is covered by
// notificationSheetIntegration.test.ts, which calls the real function —
// this file only locks in HOW NotificationSheet wires to it.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const SHEET_PATH  = "src/components/NotificationSheet.tsx";
const BELL_PATH   = "src/components/NotificationBell.tsx";
const HEADER_PATH = "src/components/Header.tsx";

describe("NotificationSheet uses the canonical resolver — no local route-building logic", () => {
  const src = () => readSource(SHEET_PATH);

  it("imports resolveNotificationTarget from the canonical module, not the old getSafeTargetPath-only import", () => {
    const s = src();
    expect(s).toContain('import { resolveNotificationTarget } from "@/lib/notification-targets";');
    expect(s).not.toContain("getSafeTargetPath");
  });

  it("calls resolveNotificationTarget(n.kind, n.metadata, userRole) — not a switch/if-chain reimplementing routing", () => {
    const s = src();
    const occurrences = s.split("resolveNotificationTarget(n.kind, n.metadata, userRole)").length - 1;
    expect(occurrences).toBe(2); // click handler + render-time isActionable calc
    expect(s).not.toMatch(/switch\s*\(\s*n\.kind/);
    expect(s).not.toMatch(/kind === "reservation_|kind === "event_|kind === "lesson_/);
  });

  it("accepts userRole as a prop rather than querying Supabase for it", () => {
    const s = src();
    expect(s).toContain("userRole: string | null;");
    expect(s).toContain("export default function NotificationSheet({ onClose, onRead, userRole }: Props) {");
  });
});

describe("click/read/close/navigate ordering is unchanged from the pre-36E implementation", () => {
  const src = () => readSource(SHEET_PATH);

  it("mark-read (if unread) happens before resolving/navigating, and is still fire-and-forget — navigation never awaits it", () => {
    const s = src();
    const idx = s.indexOf("const handleNotificationClick = useCallback((n: NotificationRow) => {");
    const endIdx = s.indexOf("}, [router, onClose, userRole]);", idx);
    const block = s.slice(idx, endIdx);
    const markReadIdx = block.indexOf("handleMarkRead(n.id);");
    const resolveIdx  = block.indexOf("resolveNotificationTarget(");
    expect(markReadIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(markReadIdx);
    expect(block).not.toContain("await handleMarkRead");
  });

  it("onClose() is still called before router.push(targetPath) — sheet closes as part of navigating away", () => {
    const s = src();
    const idx = s.indexOf("const handleNotificationClick");
    const block = s.slice(idx, idx + 500);
    const closeIdx = block.indexOf("onClose();");
    const pushIdx  = block.indexOf("router.push(targetPath);");
    expect(closeIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(closeIdx);
  });

  it("isActionable is still !n.is_read || !!targetPath — an unread notification with no resolvable target remains clickable (mark-read-only), unchanged", () => {
    const s = src();
    expect(s).toContain("const isActionable = !n.is_read || !!targetPath;");
  });

  it("a resolver-null notification never manufactures a link — no fallback path construction anywhere in this file", () => {
    const s = src();
    expect(s).not.toMatch(/targetPath\s*\?\?\s*["'`]\//);
  });
});

describe("keyboard accessibility was added to actionable rows (a genuine gap fixed while wiring, not a redesign)", () => {
  const src = () => readSource(SHEET_PATH);

  it("actionable rows carry role=\"button\", tabIndex={0}, and an Enter/Space onKeyDown handler — same pattern already used for CalendarShell's clickable pro_lesson blocks", () => {
    const s = src();
    expect(s).toContain('role={isActionable ? "button" : undefined}');
    expect(s).toContain("tabIndex={isActionable ? 0 : undefined}");
    expect(s).toMatch(/onKeyDown=\{isActionable \? \(e\) => \{\s*if \(e\.key === "Enter" \|\| e\.key === " "\) \{ e\.preventDefault\(\); handleNotificationClick\(n\); \}\s*\} : undefined\}/);
  });

  it("non-actionable rows get no role/tabIndex/onKeyDown — unchanged from the read-only, non-interactive presentation", () => {
    const s = src();
    expect(s).toContain('role={isActionable ? "button" : undefined}');
    // Confirms the ternary's false branch is explicitly undefined, not a
    // fallback value that would make every row focusable.
    expect(s).not.toMatch(/role="button"[^{]/);
  });
});

describe("announcement rendering is unaffected — still title/dot special-cased, still falls back to resolver-driven navigability like every other kind", () => {
  it("announcementTitle logic is untouched", () => {
    const s = readSource(SHEET_PATH);
    expect(s).toContain('const isAnnouncement    = n.kind === "announcement";');
    expect(s).toContain("(n.metadata as Record<string, string> | null)?.title ?? null");
  });
});

describe("viewer role is threaded from an existing server boundary (Header's own profile query) — no new fetch, no metadata-trusted role", () => {
  it("Header selects role from its own already-running profiles query and passes it down as a plain prop, not a new round-trip", () => {
    const s = readSource(HEADER_PATH);
    expect(s).toContain('.select("club_id, first_name, last_name, role")');
    expect(s).toContain("<NotificationBell userRole={userRole} />");
  });

  it("NotificationBell forwards userRole through to NotificationSheet unchanged — no derivation, no Supabase lookup of its own", () => {
    const s = readSource(BELL_PATH);
    expect(s).toContain("export default function NotificationBell({ userRole }: Props) {");
    expect(s).toContain("userRole={userRole}");
  });

  it("NotificationSheet itself never queries profiles/auth for role — it only receives the prop", () => {
    const s = readSource(SHEET_PATH);
    expect(s).not.toMatch(/\.from\("profiles"\)|auth\.getUser\(\)[\s\S]*role/);
  });
});

describe("NotificationSheet does not query reservations/events/programs/lesson_requests to decide navigation — it only reads its own already-fetched notification rows", () => {
  it("the only .from(...) call in this file is the notifications list load and the two mark-read updates", () => {
    const s = readSource(SHEET_PATH);
    const fromCalls = s.match(/\.from\("(\w+)"\)/g) ?? [];
    expect(fromCalls.every(c => c === '.from("notifications")')).toBe(true);
  });
});
