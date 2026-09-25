import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Phase 44C — Communications Composer Audience UI.
//
// Source-inspection style, matching this repository's established
// baseline (vitest.config.mts: "no jsdom, no component/browser testing").
// These tests prove the UI/action code is WIRED correctly — right
// functions called, right props/params passed, right conditional
// branches present — not that a browser actually renders/behaves
// correctly. Real interactive behavior is verified by browser QA
// (see the Phase 44C report), not by this suite.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const ANNOUNCEMENTS_PATH = "src/app/(app)/admin/communications/AnnouncementsSection.tsx";
const ACTIONS_PATH       = "src/app/(app)/admin/communications/communicationsActions.ts";
const ACTIVITY_PATH      = "src/app/(app)/admin/communications/CommunicationsActivitySection.tsx";

let cachedUiSrc: string | null = null;
function uiSrc(): string {
  if (cachedUiSrc === null) cachedUiSrc = readSource(ANNOUNCEMENTS_PATH);
  return cachedUiSrc;
}

let cachedActionsSrc: string | null = null;
function actionsSrc(): string {
  if (cachedActionsSrc === null) cachedActionsSrc = readSource(ACTIONS_PATH);
  return cachedActionsSrc;
}

describe("AUDIENCE TOGGLE", () => {
  it("default audience state is 'all'", () => {
    expect(uiSrc()).toContain('useState<AudienceMode>("all")');
  });

  it("both option labels exist", () => {
    const s = uiSrc();
    expect(s).toContain("All active club users");
    expect(s).toContain("Specific people");
  });

  it("uses role=\"group\" with an accessible label, and aria-pressed on each option", () => {
    const s = uiSrc();
    expect(s).toContain('role="group" aria-label="Audience"');
    expect(s).toContain('aria-pressed={audienceMode === "all"}');
    expect(s).toContain('aria-pressed={audienceMode === "specific"}');
  });

  it("selected state is not color-only — a checkmark glyph and font-weight change accompany the color/border change", () => {
    const s = uiSrc();
    expect(s).toContain('{audienceMode === "all" ? "✓ " : ""}');
    expect(s).toContain('{audienceMode === "specific" ? "✓ " : ""}');
    expect(s).toContain("font-semibold");
  });

  it("Timing and Delivery InfoRows remain unchanged", () => {
    const s = uiSrc();
    expect(s).toContain('<InfoRow label="Timing" value="Send now" />');
    expect(s).toContain('<InfoRow label="Delivery" value="In-app + email when available" />');
  });

  it("the old fixed Audience InfoRow is gone — Audience is no longer a static row", () => {
    expect(uiSrc()).not.toMatch(/<InfoRow label="Audience"/);
  });

  it("no out-of-scope audience controls were added — no role filter, no membership-type filter, no Select All, no saved audiences", () => {
    const s = uiSrc();
    expect(s).not.toMatch(/select all/i);
    expect(s).not.toMatch(/membership.?type/i);
    expect(s).not.toMatch(/saved audience/i);
    expect(s).not.toMatch(/role.?based.?filter|filter.*by.*role/i);
  });
});

describe("ALL-MODE PREVIEW", () => {
  it("calls previewAnnouncementRecipientsAction with the mode and a null recipient list for 'all'", () => {
    const s = uiSrc();
    expect(s).toContain('const recipientIds = audienceMode === "specific" ? Array.from(selectedIds) : null;');
    expect(s).toContain("previewAnnouncementRecipientsAction(audienceMode, recipientIds)");
  });

  it("loading/error/zero/positive count copy exists exactly as specified", () => {
    const s = uiSrc();
    expect(s).toContain("Checking recipients…");
    expect(s).toContain("Recipient count unavailable. Try again.");
    expect(s).toContain("No one can currently receive announcements.");
    expect(s).toContain(
      '`This will send to ${preview.eligibleCount} ${preview.eligibleCount === 1 ? "person" : "people"}.`'
    );
  });

  it("Send cannot proceed without a successful, positive preview", () => {
    const s = uiSrc();
    const idx = s.indexOf("const previewReady");
    expect(idx).toBeGreaterThan(-1);
    expect(s.slice(idx, idx + 100)).toContain('preview.status === "success" && preview.eligibleCount > 0');
    const canSubmitIdx = s.indexOf("const canSubmit");
    expect(s.slice(canSubmitIdx, canSubmitIdx + 250)).toContain("previewReady");
  });

  it("the confirmation step's \"Yes, send it\" button also honors the CURRENT canSubmit state, not isPending alone — Audience/title/body/selection can still change while confirming is open", () => {
    const s = uiSrc();
    const idx = s.indexOf("Yes, send it");
    expect(idx).toBeGreaterThan(-1);
    const before = s.slice(Math.max(0, idx - 200), idx);
    expect(before).toContain("disabled={isPending || !canSubmit}");
  });
});

describe("SPECIFIC PEOPLE PICKER", () => {
  it("uses getAnnouncementRecipientCandidatesAction, fetched once and cached", () => {
    const s = uiSrc();
    expect(s).toContain("getAnnouncementRecipientCandidatesAction()");
    expect(s).toContain("candidates !== null || candidatesLoading || candidatesError");
  });

  it("search input exists, client-side only, no RPC per keystroke", () => {
    const s = uiSrc();
    expect(s).toContain('aria-label="Search people"');
    expect(s).toContain("onChange={e => setSearch(e.target.value)}");
    // The candidate action is called exactly once in the whole file — the
    // one-time fetch — never again from inside the search handler.
    const candidateActionCalls = (s.match(/getAnnouncementRecipientCandidatesAction\(\)/g) ?? []).length;
    expect(candidateActionCalls).toBe(1);
  });

  it("search matches first name, last name, and the combined display name, case-insensitively", () => {
    const s = uiSrc();
    const idx = s.indexOf("function matchesSearch");
    const body = s.slice(idx, idx + 400);
    expect(body).toContain(".toLowerCase()");
    expect(body).toContain("first.includes(q) || last.includes(q) || full.includes(q)");
  });

  it("role is displayed as secondary text only — no role-based filtering logic exists", () => {
    const s = uiSrc();
    expect(s).toContain("{c.role}");
    expect(s).not.toMatch(/filter\([^)]*\.role/);
  });

  it("no email, phone, or membership-type data is rendered for a candidate row — 'email' legitimately appears elsewhere in this file only as prose/the pre-existing Delivery channel description, never as candidate data", () => {
    const s = uiSrc();
    const idx = s.indexOf("filteredCandidates.map(c =>");
    expect(idx).toBeGreaterThan(-1);
    const end = s.indexOf("})", idx);
    const rowBlock = s.slice(idx, end);
    expect(rowBlock).not.toMatch(/\bphone\b/i);
    expect(rowBlock).not.toMatch(/\bemail\b/i);
    expect(rowBlock).not.toMatch(/membership.?type/i);
  });

  it("opted-out candidates remain rendered (no filter excludes them from the list)", () => {
    const s = uiSrc();
    expect(s).toContain("filteredCandidates.map(c =>");
    expect(s).not.toMatch(/filteredCandidates\s*=[\s\S]{0,120}announcementEnabled/);
  });

  it("opted-out candidate's checkbox is disabled, muted, and explicitly labeled — never color-only", () => {
    const s = uiSrc();
    expect(s).toContain("const optedOut     = !c.announcementEnabled;");
    expect(s).toContain("const rowDisabled  = optedOut || isPending;");
    expect(s).toContain('disabled={rowDisabled}');
    expect(s).toContain('optedOut ? "opacity-60" : ""');
    expect(s).toContain("Announcements off");
  });

  it("there is no Admin override for an opted-out person's preference", () => {
    const s = uiSrc();
    expect(s).not.toMatch(/override.*preference|force.*enable/i);
  });

  it("a lightweight, non-authoritative selected count is shown", () => {
    const s = uiSrc();
    expect(s).toContain("{selectedIds.size} selected");
  });
});

describe("SPECIFIC-MODE PREVIEW", () => {
  it("zero selected people skips the preview call entirely and shows the empty-selection helper text", () => {
    const s = uiSrc();
    const idx = s.indexOf('if (audienceMode === "specific" && selectedIds.size === 0)');
    expect(idx).toBeGreaterThan(-1);
    const guardBlock = s.slice(idx, idx + 150);
    expect(guardBlock).toContain('setPreview({ status: "no_selection" });');
    expect(guardBlock).toContain("return;");
    // The guard returns BEFORE the fetch call further down in the effect.
    const fetchIdx = s.indexOf("previewAnnouncementRecipientsAction(audienceMode, recipientIds)");
    expect(fetchIdx).toBeGreaterThan(idx);
    expect(s).toContain("Select at least one person.");
  });

  it("the authoritative eligibleCount — never selectedIds.size — drives the sendable copy, including the 'N of M' partial-eligibility case", () => {
    const s = uiSrc();
    expect(s).toContain("const selectedCount = selectedIds.size;");
    expect(s).toContain('if (preview.eligibleCount === 0) return "None of the selected people can currently receive announcements.";');
    expect(s).toContain("if (preview.eligibleCount < selectedCount) {");
    expect(s).toContain("`This will send to ${preview.eligibleCount} of ${selectedCount} selected people.`");
  });

  it("the Specific-mode 'everyone selected remains eligible' case uses singular/plural correctly — 'person' for exactly 1, 'people' otherwise; the 'N of M' partial-eligibility copy is intentionally left invariant (always plural 'selected people')", () => {
    const s = uiSrc();
    expect(s).toContain(
      '`This will send to ${preview.eligibleCount} ${preview.eligibleCount === 1 ? "person" : "people"}.`'
    );
  });

  it("zero eligible and preview error both keep previewReady false (Send stays disabled)", () => {
    const s = uiSrc();
    // previewReady only becomes true for status "success" AND a positive
    // count — "error"/"loading"/"no_selection" and a zero success count
    // are all excluded by this single condition.
    expect(s).toContain('preview.status === "success" && preview.eligibleCount > 0');
  });
});

describe("PREVIEW RACE SAFETY", () => {
  it("uses a monotonically increasing request-generation ref, not a library, not global state", () => {
    const s = uiSrc();
    expect(s).toContain("const previewGenerationRef = useRef(0);");
    expect(s).toContain("const generation = ++previewGenerationRef.current;");
    expect(s).toContain("if (previewGenerationRef.current !== generation) return;");
  });

  it("the generation increments BEFORE the zero-selection early return, not after — otherwise an in-flight request from a prior non-empty selection could still resolve after the Admin clears the last selection and overwrite the correct no_selection state with a stale result", () => {
    const s = uiSrc();
    const effectStart = s.indexOf("// Authoritative recipient preview.");
    expect(effectStart).toBeGreaterThan(-1);
    const generationIdx  = s.indexOf("const generation = ++previewGenerationRef.current;", effectStart);
    const earlyReturnIdx = s.indexOf('if (audienceMode === "specific" && selectedIds.size === 0) {', effectStart);
    expect(generationIdx).toBeGreaterThan(-1);
    expect(earlyReturnIdx).toBeGreaterThan(-1);
    expect(generationIdx).toBeLessThan(earlyReturnIdx);
  });

  it("no new dependency was introduced for this", () => {
    const s = uiSrc();
    expect(s).toMatch(/^import \{ useEffect, useRef, useState, useTransition \} from "react";$/m);
  });
});

describe("SEND ACTION — extends the existing action only", () => {
  it("sendAnnouncementAction remains the only exported send action in this file", () => {
    const s = actionsSrc();
    const sendActionExports = [...s.matchAll(/export async function (\w*[Ss]end\w*Action)\(/g)].map(m => m[1]);
    expect(sendActionExports).toEqual(["sendAnnouncementAction"]);
  });

  it("AnnouncementsSection sets audienceMode on the FormData, and appends one recipientUserIds entry per selected id for Specific mode only", () => {
    const s = uiSrc();
    expect(s).toContain('formData.set("audienceMode", audienceMode);');
    const idx = s.indexOf('if (audienceMode === "specific") {');
    expect(idx).toBeGreaterThan(-1);
    expect(s.slice(idx, idx + 150)).toContain('formData.append("recipientUserIds", id);');
  });

  it("All mode never appends recipientUserIds — the action treats it as null", () => {
    const s = actionsSrc();
    expect(s).toContain(
      'const recipientUserIds = audienceMode === "specific" ? formData.getAll("recipientUserIds").map(String) : null;'
    );
  });

  it("an absent audienceMode defaults to \"all\"; an explicit unrecognized value is rejected, never silently coerced to \"all\"", () => {
    const s = actionsSrc();
    expect(s).toContain('const rawAudienceMode = formData.get("audienceMode") as string | null;');
    expect(s).toContain('const audienceMode    = rawAudienceMode === null ? "all" : rawAudienceMode;');
    expect(s).toContain('if (audienceMode !== "all" && audienceMode !== "specific") {');
    expect(s).toContain("return { error: AUDIENCE_ERROR_MESSAGES.invalid_audience };");
  });

  it("still calls the canonical four-argument send_announcement_v2 RPC with both audience params", () => {
    const s = actionsSrc();
    const idx = s.indexOf('supabase.rpc("send_announcement_v2", {');
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 250);
    expect(block).toContain("p_audience_mode:       audienceMode,");
    expect(block).toContain("p_recipient_user_ids:  recipientUserIds,");
  });

  it("no_eligible_recipients and invalid_audience both reach the error-message path with the specified copy", () => {
    const s = actionsSrc();
    expect(s).toContain('no_eligible_recipients: "None of the selected people can currently receive this announcement."');
    expect(s).toContain('invalid_audience:       "Invalid audience selection."');
    expect(s).toMatch(/mapAudienceError[\s\S]{0,300}no_eligible_recipients/);
  });

  it("partial-survivor success copy uses the RPC's actual recipientCount, never claiming the full original selection was reached", () => {
    const s = actionsSrc();
    const idx = s.indexOf("audienceMode === \"specific\" && selectedCount > 0 && recipientCount < selectedCount");
    expect(idx).toBeGreaterThan(-1);
    expect(s.slice(idx, idx + 200)).toContain(
      "`Announcement sent to ${recipientCount} of ${selectedCount} selected people.`"
    );
  });

  it("sendAnnouncementAction never reads a preview/eligibleCount value as authorization — it only ever reads formData (a documentation comment explaining WHY may still mention 'preview' in prose)", () => {
    const s = actionsSrc();
    const start = s.indexOf("export async function sendAnnouncementAction(");
    const end   = s.indexOf("\n}\n", start);
    const body  = s.slice(start, end);
    expect(body).not.toMatch(/eligibleCount|eligible_count/);
    expect(body).not.toMatch(/previewAnnouncementRecipientsAction|AnnouncementPreviewResult/);
  });
});

describe("SUCCESS RESET", () => {
  it("title/body still reset on success", () => {
    const s = uiSrc();
    const idx = s.indexOf('setStatus({ type: "success"');
    const block = s.slice(idx, idx + 400);
    expect(block).toContain('setTitle("");');
    expect(block).toContain('setBody("");');
  });

  it("audience resets to All, selections clear, and search clears — Specific People is never left armed after a send", () => {
    const s = uiSrc();
    const idx = s.indexOf('setStatus({ type: "success"');
    const block = s.slice(idx, idx + 500);
    expect(block).toContain('setAudienceMode("all");');
    expect(block).toContain("setSelectedIds(new Set());");
    expect(block).toContain('setSearch("");');
  });

  it("the fetched candidate roster itself is NOT cleared on success — it may stay cached for the session", () => {
    const s = uiSrc();
    const idx = s.indexOf('setStatus({ type: "success"');
    const block = s.slice(idx, idx + 500);
    expect(block).not.toMatch(/setCandidates\(null\)/);
  });
});

describe("BOUNDARIES — no out-of-scope work introduced", () => {
  // "No migration was introduced by 44C" is a checkpoint/worktree
  // validation (confirmed via `git status` in each checkpoint's own
  // report), not a permanent repository invariant — a brittle
  // repository-global "highest migration number" style assertion here
  // would go stale the moment a later, legitimate phase adds one, exactly
  // as happened with the equivalent Phase 39C-2B test removed during
  // Phase 44A. Not reintroduced.

  it("Activity UI has no audience-mode/history work — untouched by this checkpoint", () => {
    const s = readSource(ACTIVITY_PATH);
    expect(s).not.toMatch(/audienceMode|audience_mode/);
  });

  it("no SMS reference was introduced in the Compose UI", () => {
    expect(uiSrc()).not.toMatch(/sms/i);
  });

  it("no scheduling, chat/reply, or bulk-import construct was introduced", () => {
    const s = uiSrc();
    expect(s).not.toMatch(/cron|scheduled_send|schedule/i);
    expect(s).not.toMatch(/reply|thread|chat/i);
    expect(s).not.toMatch(/csv|bulk.?import/i);
  });

  it("no new component file was created for the picker — it lives inline in AnnouncementsSection.tsx", () => {
    expect(existsSync(join(process.cwd(), "src/app/(app)/admin/communications/AudiencePicker.tsx"))).toBe(false);
    expect(existsSync(join(process.cwd(), "src/app/(app)/admin/communications/SpecificPeoplePicker.tsx"))).toBe(false);
  });
});
