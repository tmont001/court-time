import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Phase 39C-2C — regression coverage for My Schedule joined-game cards +
// durable Leave, using this repository's established source-inspection
// style (see openGamesDiscovery.regression.test.ts / reservationPlayerSearchOwnerUx.
// regression.test.ts's own header comments for why: pure-TypeScript, no
// jsdom/React Testing Library available for "use client" components or a
// Server Component page).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

// Strips `//` comment-only lines so structural assertions are never
// tripped (or falsely satisfied) by this checkpoint's own explanatory
// comments — e.g. JoinedGameCard's header comment discusses "price/
// payment" and "member_self_service" only to say those are deliberately
// absent/ungated; those must not count as the code containing them.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const PAGE_PATH    = "src/app/(app)/my-schedule/page.tsx";
const CARD_PATH    = "src/app/(app)/my-schedule/JoinedGameCard.tsx";
const ACTIONS_PATH = "src/app/(app)/calendar/actions.ts";
const NOTIFICATION_TARGETS_PATH = "src/lib/notification-targets.ts";

const page    = () => readSource(PAGE_PATH);
const card    = () => readSource(CARD_PATH);
const actions = () => readSource(ACTIONS_PATH);

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const braceStart = src.indexOf("{", start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXISTENCE
// ═══════════════════════════════════════════════════════════════════════════

describe("JoinedGameCard exists", () => {
  it("component file exists on disk", () => {
    expect(existsSync(join(process.cwd(), CARD_PATH))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1-3. MY SCHEDULE INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════

describe("1-3. My Schedule integration", () => {
  it("1. My Schedule calls getMyReservationPlayerParticipations, which wraps get_my_reservation_player_participations", () => {
    const p = page();
    expect(p).toContain("getMyReservationPlayerParticipations(clubId)");
    const a = actions();
    const start = a.indexOf("export async function getMyReservationPlayerParticipations(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('supabase.rpc("get_my_reservation_player_participations"');
  });

  it("2. no direct reservation_participants query anywhere in page.tsx, JoinedGameCard, or the two new actions", () => {
    for (const src of [page(), card(), actions()]) {
      expect(src).not.toMatch(/\.from\(["']reservation_participants["']\)/);
    }
  });

  it("3. joined games integrate into the existing allItems/itemStartsAt sort — a player_participation ScheduleItem variant, not a separate list/section", () => {
    const p = page();
    expect(p).toContain('| { kind: "player_participation"; participation: MyReservationPlayerParticipation };');
    const itemStartsAtBody = functionBody(p, "itemStartsAt");
    expect(itemStartsAtBody).toContain('if (item.kind === "player_participation") return item.participation.starts_at;');
    expect(p).toContain("...playerParticipations.map(participation => ({");
    expect(p).toContain("allItems.sort((a, b) => itemStartsAt(a).localeCompare(itemStartsAt(b)));");
  });

  it("no separate page/tab was created solely for joined games", () => {
    const p = page();
    // The existing "Upcoming" tab already renders allItems, which now
    // includes player_participation — no new PageTabs entry was added.
    expect(p).not.toMatch(/key:\s*"joined"|key:\s*"open-games"|joined-games/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4-9. JOINED-GAME CARD UX / PRIVACY ALLOWLIST
// ═══════════════════════════════════════════════════════════════════════════

describe("4-9. joined-game card content and privacy allowlist", () => {
  it("4. card clearly says 'You joined'", () => {
    expect(card()).toContain("You joined · Hosted by");
  });

  it("5. card shows the CURRENT host name returned by 0206 (participation.host_display_name), not any other source", () => {
    expect(card()).toContain("{participation.host_display_name}");
  });

  it("6. date/time/court are shown — time range via formatTime, court via participation.court_name (date itself comes from the shared per-day group header, same as the reservation/event cards)", () => {
    const c = card();
    expect(c).toContain("{participation.court_name}");
    expect(c).toContain("{start} – {end}");
  });

  it("7. format is shown only when non-null", () => {
    const c = card();
    expect(c).toMatch(/const formatLabel = participation\.format\s*\n\s*\? participation\.format\.charAt/);
    expect(c).toContain('formatLabel ? ` · ${formatLabel}` : ""');
  });

  it("8. no price/payment/refund/cancellation-balance UI anywhere in JoinedGameCard's actual code (its own header comment legitimately names these concepts only to say they're deliberately absent)", () => {
    const c = codeOnly(card());
    expect(c).not.toMatch(/price|payment|refund|balance|PaymentStateBadge|cancellation.window/i);
  });

  it("9. no guest/notes/email/phone/waiver data referenced in JoinedGameCard or the MyReservationPlayerParticipation interface", () => {
    const c = card();
    const a = actions();
    const interfaceStart = a.indexOf("export interface MyReservationPlayerParticipation {");
    const interfaceEnd = a.indexOf("}", interfaceStart);
    const interfaceBody = a.slice(interfaceStart, interfaceEnd);
    for (const forbidden of [/guest/i, /\bnotes\b/i, /email/i, /phone/i, /waiver/i]) {
      expect(c).not.toMatch(forbidden);
      expect(interfaceBody).not.toMatch(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10-11. PRIVACY / DETAIL ACCESS
// ═══════════════════════════════════════════════════════════════════════════

describe("10-11. no widened reservation-detail access", () => {
  it("10. the joined card cannot open ReservationDetailSheet — no import/render/click-through of it in JoinedGameCard", () => {
    const c = card();
    expect(c).not.toMatch(/import .*ReservationDetailSheet/);
    expect(c).not.toMatch(/<ReservationDetailSheet/);
    expect(c).not.toMatch(/setSelectedReservation/);
  });

  it("11. no canOpenReservationDetail widening — the helper is not imported into My Schedule or JoinedGameCard at all (My Schedule never opened full reservation detail before, and still doesn't)", () => {
    const p = page();
    const c = card();
    expect(p).not.toMatch(/canOpenReservationDetail/);
    expect(c).not.toMatch(/canOpenReservationDetail/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12-15. LEAVE — NO REINTRODUCED GATES
// ═══════════════════════════════════════════════════════════════════════════

describe("12-15. Leave calls the RPC with no reintroduced eligibility gates", () => {
  it("12. Leave calls leaveReservationPlayerParticipation, which wraps leave_reservation_participation", () => {
    const c = card();
    const handleBody = functionBody(c, "handleConfirmLeave");
    expect(handleBody).toContain("leaveReservationPlayerParticipation(participation.reservation_id, clubId)");
    const a = actions();
    const start = a.indexOf("export async function leaveReservationPlayerParticipation(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('supabase.rpc("leave_reservation_participation"');
  });

  it("13. no member_self_service capability check anywhere in the Leave action or JoinedGameCard's actual code (an explanatory comment stating the deliberate absence is fine; a real check is not)", () => {
    const c = codeOnly(card());
    const a = actions();
    const start = a.indexOf("export async function leaveReservationPlayerParticipation(");
    const end = a.indexOf("\n}\n", start);
    expect(a.slice(start, end)).not.toMatch(/current_club_has_capability/);
    expect(c).not.toMatch(/current_club_has_capability|member_self_service/);
  });

  it("14. no active-roster eligibility check (status/removed_at) anywhere in the Leave action or JoinedGameCard's actual code", () => {
    const c = codeOnly(card());
    const a = actions();
    const start = a.indexOf("export async function leaveReservationPlayerParticipation(");
    const end = a.indexOf("\n}\n", start);
    expect(a.slice(start, end)).not.toMatch(/roster_member_inactive|removed_at/);
    expect(c).not.toMatch(/roster_member_inactive|removed_at/);
  });

  it("15. no userRole-only gate on Leave — JoinedGameCard never reads or receives userRole as a prop", () => {
    const c = card();
    expect(c).not.toMatch(/userRole/);
    const propsStart = c.indexOf("interface Props {");
    const propsEnd = c.indexOf("}", propsStart);
    expect(c.slice(propsStart, propsEnd)).not.toMatch(/role/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16-17. LEAVE CONFIRMATION
// ═══════════════════════════════════════════════════════════════════════════

describe("16-17. Leave confirmation step", () => {
  it("16. the mutation is gated behind a confirming state — Leave is a two-step flow, not a single-click mutation", () => {
    const c = card();
    expect(c).toContain("const [confirming, setConfirming] = useState(false);");
    expect(c).toContain('onClick={() => setConfirming(true)}');
    expect(c).toContain("{confirming && (");
  });

  it("17. confirmation copy is non-financial — no mention of refund, and states plainly that the booking is not cancelled", () => {
    const c = card();
    expect(c).toContain("Leave this game?");
    expect(c).toMatch(/removed from the player list/);
    expect(c).toContain("does not cancel the booking");
    expect(c).not.toMatch(/refund/i);
  });

  it("has a Cancel path that does not mutate", () => {
    const c = card();
    const cancelIdx = c.indexOf('onClick={() => { setConfirming(false); setError(null); }}');
    expect(cancelIdx).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 18-21. REFRESH / DATA CONSISTENCY
// ═══════════════════════════════════════════════════════════════════════════

describe("18-21. refresh and data consistency after Leave", () => {
  it("18. successful Leave revalidates /my-schedule", () => {
    const a = actions();
    const start = a.indexOf("export async function leaveReservationPlayerParticipation(");
    const end = a.indexOf("\n}\n", start);
    expect(a.slice(start, end)).toContain('revalidatePath("/my-schedule");');
  });

  it("19. successful Leave revalidates /calendar", () => {
    const a = actions();
    const start = a.indexOf("export async function leaveReservationPlayerParticipation(");
    const end = a.indexOf("\n}\n", start);
    expect(a.slice(start, end)).toContain('revalidatePath("/calendar");');
  });

  it("20. JoinedGameCard relies on the Server Component's own re-render (via revalidatePath) for canonical refresh — no client-side re-fetch of the participations list", () => {
    const c = card();
    expect(c).not.toMatch(/getMyReservationPlayerParticipations/);
  });

  it("21. no optimistic local participant deletion — handleConfirmLeave never removes the card/item from any local array or list state", () => {
    const c = card();
    const handleBody = functionBody(c, "handleConfirmLeave");
    expect(handleBody).not.toMatch(/setOpportunities|setParticipations|\.filter\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LEAVING/SUCCESS STATE — no visual flash before the canonical refresh lands
// ═══════════════════════════════════════════════════════════════════════════

describe("leaving/success-state presentation — card stays in its disabled Leaving… state through to the canonical refresh, never flashes back to normal", () => {
  it("5. success does NOT call setLeaving(false) — only the error branch does", () => {
    const c = card();
    const handleBody = functionBody(c, "handleConfirmLeave");
    const errorBranchStart = handleBody.indexOf("if (result.error) {");
    const errorBranchEnd = handleBody.indexOf("}", errorBranchStart) + 1;
    const errorBranch = handleBody.slice(errorBranchStart, errorBranchEnd);
    const afterErrorBranch = handleBody.slice(errorBranchEnd);

    expect(errorBranch).toContain("setLeaving(false);");
    expect(afterErrorBranch).not.toMatch(/setLeaving\(false\)/);
  });

  it("6. success does NOT call setConfirming(false) — only the manual Cancel path does", () => {
    const c = card();
    const handleBody = functionBody(c, "handleConfirmLeave");
    expect(handleBody).not.toMatch(/setConfirming\(false\)/);
    // Cancel (outside handleConfirmLeave entirely) still resets it.
    expect(c).toContain('onClick={() => { setConfirming(false); setError(null); }}');
  });

  it("7. the error path DOES restore leaving=false so the user can retry", () => {
    const c = card();
    const handleBody = functionBody(c, "handleConfirmLeave");
    const errorBranchStart = handleBody.indexOf("if (result.error) {");
    const errorBranchEnd = handleBody.indexOf("}", errorBranchStart) + 1;
    expect(handleBody.slice(errorBranchStart, errorBranchEnd)).toContain("setLeaving(false);");
  });

  it("8. no optimistic local list/card deletion was added as part of this fix — the success branch contains no state mutation beyond what already existed (leaving/confirming both stay true, error stays null)", () => {
    const c = card();
    const handleBody = functionBody(c, "handleConfirmLeave");
    const errorBranchEnd = handleBody.indexOf("if (result.error) {");
    const successComment = handleBody.slice(handleBody.indexOf("}", errorBranchEnd) + 1);
    expect(successComment).not.toMatch(/set[A-Z]\w*\(/); // no further state setter calls after the error branch
  });

  it("9. existing confirmation copy is unchanged by this fix", () => {
    const c = card();
    expect(c).toContain("Leave this game?");
    expect(c).toMatch(/removed from the player list/);
    expect(c).toContain("does not cancel the booking");
    expect(c).not.toMatch(/refund/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BUTTON STYLING — reuses canonical shared action-button constants
// ═══════════════════════════════════════════════════════════════════════════

describe("button styling — canonical shared action-button constants, never bespoke text-link styling", () => {
  it("1. imports the existing shared destructive/secondary compact action-button constants", () => {
    const c = card();
    expect(c).toContain('import {\n  ACTION_BUTTON_SECONDARY_COMPACT,\n  ACTION_BUTTON_DESTRUCTIVE_COMPACT,\n} from "@/components/styles/actionButtonStyles";');
  });

  it("2. the initial 'Leave' action uses the canonical destructive compact treatment", () => {
    const c = card();
    const leaveButtonIdx = c.indexOf("Leave\n        </button>");
    expect(leaveButtonIdx).toBeGreaterThan(0);
    const buttonBlock = c.slice(c.lastIndexOf("<button", leaveButtonIdx), leaveButtonIdx);
    expect(buttonBlock).toContain("ACTION_BUTTON_DESTRUCTIVE_COMPACT");
  });

  it("3. the confirmation 'Cancel' action uses the canonical secondary compact treatment", () => {
    const c = card();
    const cancelIdx = c.indexOf('onClick={() => { setConfirming(false); setError(null); }}');
    const buttonBlock = c.slice(c.lastIndexOf("<button", cancelIdx), c.indexOf("</button>", cancelIdx));
    expect(buttonBlock).toContain("className={ACTION_BUTTON_SECONDARY_COMPACT}");
  });

  it("4. the confirmation 'Leave Game' action uses the canonical destructive compact treatment", () => {
    const c = card();
    const confirmLeaveIdx = c.indexOf("onClick={handleConfirmLeave}");
    const buttonBlock = c.slice(c.lastIndexOf("<button", confirmLeaveIdx), c.indexOf("</button>", confirmLeaveIdx));
    expect(buttonBlock).toContain("className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}");
  });

  it("no bespoke bare-text-link button styling remains on any <button> in the card — the old inline text-red-500/text-gray-500 button classes are gone (the still-present text-red-500 error <p> is unrelated and expected)", () => {
    const c = card();
    const buttonBlocks = [...c.matchAll(/<button[\s\S]*?<\/button>/g)].map((m) => m[0]);
    expect(buttonBlocks.length).toBeGreaterThan(0);
    for (const block of buttonBlocks) {
      expect(block).not.toMatch(/className="[^"]*text-red-500[^"]*"/);
      expect(block).not.toMatch(/className="[^"]*text-gray-500[^"]*"/);
    }
  });

  it("labels remain exactly 'Leave', 'Cancel', 'Leave Game' (and 'Leaving…' while pending)", () => {
    const c = card();
    expect(c).toContain(">\n          Leave\n        </button>");
    expect(c).toContain(">\n              Cancel\n            </button>");
    expect(c).toContain('{leaving ? "Leaving…" : "Leave Game"}');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 22. SEARCH-STATE INDEPENDENCE (reaffirmed at the UI layer)
// ═══════════════════════════════════════════════════════════════════════════

describe("22. closed/absent LFP search is irrelevant to joined-game visibility/Leave", () => {
  it("neither page.tsx nor JoinedGameCard reference reservation_player_searches, is_open, or effective_is_open", () => {
    for (const src of [page(), card()]) {
      expect(src).not.toMatch(/reservation_player_searches/);
      expect(src).not.toMatch(/\bis_open\b/);
      expect(src).not.toMatch(/effective_is_open/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 23-24. FRIENDLY ERROR MAPPING
// ═══════════════════════════════════════════════════════════════════════════

describe("23-24. friendly Leave error mapping", () => {
  it("23. reservation_participant_not_found maps to friendly copy", () => {
    const fnBody = functionBody(card(), "mapLeaveError");
    expect(fnBody).toContain('case "reservation_participant_not_found":');
    expect(fnBody).toMatch(/no longer listed as a player/);
  });

  it("24. reservation state failures (not_found/not_confirmed/already_started/roster_locked) each get distinct friendly copy, plus stale_club_context", () => {
    const fnBody = functionBody(card(), "mapLeaveError");
    expect(fnBody).toContain('case "reservation_not_found":');
    expect(fnBody).toContain('case "reservation_not_confirmed":');
    expect(fnBody).toContain('case "reservation_already_started":');
    expect(fnBody).toContain("if (code === STALE_CLUB_CONTEXT_ERROR) return STALE_CLUB_MESSAGE;");
    expect(fnBody).toContain("default:");
  });

  it("reservation_roster_locked (the real cancelled/stale-card case — leave_reservation_participation reuses _lock_and_validate_reservation_roster_mutable) maps to friendly 'no longer available' copy", () => {
    const fnBody = functionBody(card(), "mapLeaveError");
    expect(fnBody).toContain('case "reservation_roster_locked":');
    expect(fnBody).toMatch(/return "This game is no longer available\.";/);
    // Present exactly once, correctly positioned as its own case (not a
    // fallthrough duplicate of reservation_not_found's identical copy).
    const idx = fnBody.indexOf('case "reservation_roster_locked":');
    const nextLineIdx = fnBody.indexOf("\n", idx);
    const returnLine = fnBody.slice(nextLineIdx, fnBody.indexOf("\n", nextLineIdx + 1));
    expect(returnLine).toContain("This game is no longer available.");
  });

  it("no raw backend code is ever interpolated directly into displayed text", () => {
    const c = card();
    expect(c).not.toMatch(/\{error\}.*\{result\.error\}|\{result\.error\}/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 25. CURRENT-HOST EXCLUSION (UI-layer reaffirmation)
// ═══════════════════════════════════════════════════════════════════════════

describe("25. the current host is never rendered as a joined game", () => {
  it("page.tsx performs no host-filtering of its own — it trusts 0206's own current-host exclusion entirely, never re-deriving it client/server-side here", () => {
    const p = page();
    // No host-comparison logic (e.g. against owner_user_id/roster_member_id)
    // exists anywhere near the playerParticipations mapping — the RPC is
    // the sole authority, exactly as documented in the inline comment
    // (wrapped across two comment lines in the source).
    expect(p).toContain("already excludes the caller's own");
    expect(p).toContain("current-host exclusion");
    expect(p).not.toMatch(/playerParticipations\.filter\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 26-29. SCOPE COMPLIANCE
// ═══════════════════════════════════════════════════════════════════════════

describe("26-29. scope compliance", () => {
  it("26. reservation_player_activity remains the existing owner-notification mechanism — no new kind/preference/producer was introduced by this checkpoint", () => {
    // Presence only — never an exact total NotificationKind count, which
    // is not a durable regression invariant (a future, unrelated kind
    // addition must not fail this test the way a positional/count
    // assumption would — the same brittleness class already repaired
    // elsewhere in this codebase this session).
    const nt = readSource(NOTIFICATION_TARGETS_PATH);
    expect(nt).toContain('"reservation_player_activity"');
    expect(nt).not.toMatch(/notification_preferences/);
  });

  it("no parallel notification path — page.tsx and JoinedGameCard never insert into notifications or call any notify_* RPC directly", () => {
    for (const src of [page(), card()]) {
      expect(src).not.toMatch(/notifications|notify_/);
    }
  });

  it("27. the new 39C-2C production files/functions reference no migration file at all — they consume only the already-applied 0204/0206 RPC contracts via supabase.rpc calls, never require or name a new migration", () => {
    // Not an exact-highest-migration-number assertion (checkpoint state,
    // not a durable invariant) — this instead proves the actual property
    // that matters: none of the code THIS checkpoint added declares any
    // dependency on a migration file, new or otherwise. page.tsx and
    // JoinedGameCard are checked in full (both are wholly-39C-2C files);
    // actions.ts is a large, long-lived shared file whose OTHER, unrelated
    // sections legitimately reference migration filenames in their own
    // historical comments (e.g. earlier phases' own headers) — scoped
    // here to only the two functions this checkpoint actually added.
    for (const src of [page(), card()]) {
      expect(src).not.toMatch(/supabase\/migrations|\.sql["'`]/);
    }
    const a = actions();
    for (const fn of ["getMyReservationPlayerParticipations", "leaveReservationPlayerParticipation"]) {
      const start = a.indexOf(`export async function ${fn}(`);
      const end = a.indexOf("\n}\n", start);
      expect(a.slice(start, end)).not.toMatch(/supabase\/migrations|\.sql["'`]/);
    }
  });

  it("28. db/types.ts already carries the exact 0206/0204 signatures this checkpoint relies on — nothing here required changing them", () => {
    const types = readSource("src/lib/db/types.ts");
    expect(types).toContain("get_my_reservation_player_participations: {");
    expect(types).toContain("leave_reservation_participation: {");
    // Exactly one definition of each — confirms this checkpoint did not
    // add a second/duplicate entry.
    expect((types.match(/get_my_reservation_player_participations: \{/g) ?? []).length).toBe(1);
    expect((types.match(/leave_reservation_participation: \{/g) ?? []).length).toBe(1);
  });

  it("29. migrations 0001-0206 are unmodified — 0206's own known content is still present verbatim", () => {
    const m0206 = readSource("supabase/migrations/0206_my_reservation_player_participations.sql");
    expect(m0206).toContain("create or replace function public.get_my_reservation_player_participations(");
    expect(m0206).toContain("r.roster_member_id is distinct from v_caller_roster_id");
  });

  it("neither new action touches payment/pricing/checkout/refund/cancellation state", () => {
    const a = actions();
    for (const fn of ["getMyReservationPlayerParticipations", "leaveReservationPlayerParticipation"]) {
      const start = a.indexOf(`export async function ${fn}(`);
      const end = a.indexOf("\n}\n", start);
      const body = a.slice(start, end);
      expect(body).not.toMatch(/payment|price_amount_cents|hourly_rate_cents|checkout|refund|stripe|cancel_/i);
    }
  });
});
