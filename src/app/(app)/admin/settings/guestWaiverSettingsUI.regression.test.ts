import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-2B — Guest Waiver Settings UI. Frontend/Server-Action wiring
// only: an independent Settings read for audience='guest', a new
// GuestWaiverSection component mirroring the proven MemberWaiverSection
// (deliberately duplicated, not shared/refactored — see this file's own
// coverage of that decision), and four Guest-specific Server Actions
// mapping 1:1 to the four already-applied 0195 RPCs. No Guest acceptance,
// no invitations, no public route, no reservation_guests/event_guests
// integration, no compliance pills in this checkpoint. 0195 untouched.
//
// Source-inspection style, matching this repository's established
// convention — no live DOM render in this suite.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const SETTINGS_PAGE_PATH        = "src/app/(app)/admin/settings/page.tsx";
const SETTINGS_ACTIONS_PATH     = "src/app/(app)/admin/settings/actions.ts";
const GUEST_WAIVER_SECTION_PATH  = "src/app/(app)/admin/settings/GuestWaiverSection.tsx";

function functionBody(source: string, exportName: string): string {
  const start = source.indexOf(`export async function ${exportName}(`);
  expect(start, `${exportName} not found`).toBeGreaterThan(-1);
  const nextExportIdx = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, nextExportIdx > -1 ? nextExportIdx : undefined);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCOPE — no migration, 0195 untouched, no Guest acceptance/invitation/
// public-route/reservation-event work
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 43B-2B scope guard", () => {
  it("no migration 0196 (or beyond) was created in this checkpoint", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const laterMigrations = files.filter((f) => {
      const match = f.match(/^(\d{4})_/);
      return match !== null && Number(match[1]) > 195;
    });
    expect(laterMigrations).toEqual([]);
  });

  it("0195 still exists untouched — this is a frontend-only checkpoint", () => {
    expect(() => readSource("supabase/migrations/0195_guest_waiver_document_foundation.sql")).not.toThrow();
  });

  it("no Guest acceptance action, invitation/token work, or public route exists in any touched file", () => {
    for (const path of [SETTINGS_PAGE_PATH, SETTINGS_ACTIONS_PATH, GUEST_WAIVER_SECTION_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/accept_guest_waiver|guest_waiver_invitation|guest_waiver_acceptance|token_hash|createPrivilegedClient/i);
    }
  });

  it("no reservation_guests/event_guests/guest_names integration in any touched file", () => {
    for (const path of [SETTINGS_PAGE_PATH, SETTINGS_ACTIONS_PATH, GUEST_WAIVER_SECTION_PATH]) {
      expect(readSource(path)).not.toMatch(/reservation_guests|event_guests|guest_names/);
    }
  });

  it("no Guest compliance pill / bulk compliance work — get_club_member_waiver_compliance is untouched by this checkpoint's Guest files", () => {
    expect(readSource(GUEST_WAIVER_SECTION_PATH)).not.toMatch(/get_club_member_waiver_compliance|guest.*compliance/i);
  });

  it("forbidden terminology never appears in the Guest section: Signed, Signature, DocuSign, Send Waiver, Get Waiver Link", () => {
    const s = readSource(GUEST_WAIVER_SECTION_PATH);
    expect(s).not.toMatch(/Signed|Signature|DocuSign|Send Waiver|Get Waiver Link/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Settings data read — independent audience='guest' load
// ═══════════════════════════════════════════════════════════════════════════

describe("admin/settings/page.tsx — independent audience='guest' Settings read", () => {
  const s = readSource(SETTINGS_PAGE_PATH);

  it("reads waivers/waiver_versions a second time, scoped to audience='guest', as its own independent query (not derived from the Member read)", () => {
    const guestQueryIdx = s.indexOf('.eq("audience", "guest")');
    expect(guestQueryIdx).toBeGreaterThan(-1);
    // A second, distinct .from("waivers") call exists (the first is the
    // Member read already proven in 43A-2).
    const waiversFromCalls = s.match(/\.from\("waivers"\)/g) ?? [];
    expect(waiversFromCalls.length).toBe(2);
    const waiverVersionsFromCalls = s.match(/\.from\("waiver_versions"\)/g) ?? [];
    expect(waiverVersionsFromCalls.length).toBe(2);
  });

  it("does not call a new read RPC for Guest — no get_guest_waiver_status/get_club_guest_waiver_compliance or similar", () => {
    expect(s).not.toMatch(/get_guest_waiver|guest_waiver_status/i);
  });

  it("never reads waiver_acceptances for the Guest read (the file's own comment noting its absence is expected and excluded from this check)", () => {
    const codeOnly = s
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/waiver_acceptances/);
  });

  it("the Member read remains scoped to audience='member', unchanged, and is not conflated with the Guest read (distinct result variables)", () => {
    expect(s).toContain('.eq("audience", "member")');
    expect(s).toMatch(/waiverRow/);
    expect(s).toMatch(/guestWaiverRow/);
    expect(s).not.toMatch(/guestWaiverRow[\s\S]{0,80}audience.{0,20}member/);
  });

  it("passes independently-derived Guest props to GuestWaiverSection — never reusing Member's currentWaiverVersion/draftWaiverVersion/waiverRow variables", () => {
    const propsIdx = s.indexOf("<GuestWaiverSection");
    expect(propsIdx).toBeGreaterThan(-1);
    const propsBlock = s.slice(propsIdx, s.indexOf("/>", propsIdx) + 2);
    expect(propsBlock).not.toMatch(/waiverId=\{waiverRow/);
    expect(propsBlock).not.toMatch(/currentVersion=\{currentWaiverVersion\}/);
    expect(propsBlock).not.toMatch(/draftVersion=\{draftWaiverVersion\}/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Settings placement — separate subsection, after Member, no redesign
// ═══════════════════════════════════════════════════════════════════════════

describe("admin/settings/page.tsx — Guest Waiver subsection placement", () => {
  const s = readSource(SETTINGS_PAGE_PATH);

  it("'Guest Waiver' subsection label appears strictly after 'Member Waiver' and GuestWaiverSection renders strictly after MemberWaiverSection", () => {
    const memberLabelIdx = s.indexOf("Member Waiver");
    const memberComponentIdx = s.indexOf("<MemberWaiverSection");
    const guestLabelIdx = s.indexOf("Guest Waiver", memberComponentIdx);
    const guestComponentIdx = s.indexOf("<GuestWaiverSection", memberComponentIdx);
    expect(memberLabelIdx).toBeGreaterThan(-1);
    expect(memberComponentIdx).toBeGreaterThan(memberLabelIdx);
    expect(guestLabelIdx).toBeGreaterThan(memberComponentIdx);
    expect(guestComponentIdx).toBeGreaterThan(guestLabelIdx);
  });

  it("Guest Waiver stays inside the existing Memberships group — no new top-level section/group heading was introduced", () => {
    const groupHeadings = s.match(/<h2 className="text-base font-bold text-gray-900 dark:text-gray-100">[^<]+<\/h2>/g) ?? [];
    // Still exactly the four locked top-level groups: Club Profile,
    // Memberships, Pricing & Payments, Plan & Access.
    expect(groupHeadings.length).toBe(4);
  });

  it("MemberWaiverSection's own JSX block is untouched in position/props — same waiverId/isRequired/currentVersion/draftVersion props it already had", () => {
    const idx = s.indexOf("<MemberWaiverSection");
    const block = s.slice(idx, s.indexOf("/>", idx) + 2);
    expect(block).toContain("waiverId={waiverRow?.id ?? null}");
    expect(block).toContain("isRequired={waiverRow?.is_required ?? true}");
    expect(block).toContain("currentVersion={currentWaiverVersion}");
    expect(block).toContain("draftVersion={draftWaiverVersion}");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D/E. GuestWaiverSection — four states, dirty-draft guard, Update Waiver,
//      Required for Guests toggle
// ═══════════════════════════════════════════════════════════════════════════

describe("GuestWaiverSection — mirrors the proven MemberWaiverSection state machine with Guest-specific copy", () => {
  const s = readSource(GUEST_WAIVER_SECTION_PATH);

  it("state 1 (no Guest waiver): shows a create-first-waiver empty state with Guest-specific copy", () => {
    expect(s).toContain('waiverId === null && editorMode === "none"');
    expect(s).toMatch(/No Guest waiver has been created yet/);
    expect(s).toMatch(/Create Guest Waiver/);
  });

  it("state 2/4: draft is editable (Title/Body inputs present) whenever isEditingDraft", () => {
    const editorStart = s.indexOf("isEditingDraft &&");
    expect(editorStart).toBeGreaterThan(-1);
    const editorEnd = s.indexOf("Requirement toggle", editorStart);
    const editorBlock = s.slice(editorStart, editorEnd);
    expect(editorBlock).toContain("<input");
    expect(editorBlock).toContain("<textarea");
    expect(editorBlock).toContain("Save Draft");
  });

  it("dirty-draft guard preserved: Publish is disabled and shows helper copy when the editor differs from the saved draft", () => {
    expect(s).toMatch(/const isDraftDirty =/);
    expect(s).toMatch(/disabled=\{isPending \|\| isDraftDirty\}/);
    expect(s).toContain("Save your changes before publishing.");
  });

  it("handlePublish still only ever publishes the authoritative saved draft id, guarded by isDraftDirty", () => {
    const fnStart = s.indexOf("function handlePublish()");
    const fnEnd = s.indexOf("\n  }", fnStart);
    const fn = s.slice(fnStart, fnEnd + 4);
    expect(fn).toContain("if (!draftVersion || isDraftDirty) return;");
    expect(fn).toContain("publishGuestWaiverVersionAction(draftVersion.id)");
  });

  it("state 3: published version is read-only (no <input>/<textarea> in that block) and 'Update Waiver' starts a new-draft workflow prefilled from the current version", () => {
    const blockStart = s.indexOf("CURRENT PUBLISHED VERSION");
    const blockEnd = s.indexOf("Update Waiver");
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const readOnlyBlock = s.slice(blockStart, blockEnd);
    expect(readOnlyBlock).not.toMatch(/<textarea|<input/);
    expect(s).toContain("Update Waiver");
    const fnStart = s.indexOf("function startNewVersion()");
    const fnEnd = s.indexOf("\n  }", fnStart);
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("setTitle(currentVersion.title);");
    expect(fn).toContain("setBody(currentVersion.body);");
  });

  it("state 4: current published version remains visible/rendered even while a draft exists (no gating on !draftVersion for the read-only block)", () => {
    const readOnlyGateIdx = s.indexOf("{currentVersion && (");
    expect(readOnlyGateIdx).toBeGreaterThan(-1);
    const gateLine = s.slice(readOnlyGateIdx, s.indexOf("\n", readOnlyGateIdx));
    expect(gateLine).not.toMatch(/!draftVersion/);
  });

  it("publish confirmation copy never claims Guests will be required to accept — no acceptance mechanism exists yet", () => {
    expect(s).not.toMatch(/Guests will need to accept|Guests who accepted/);
    expect(s).toMatch(/currently published Guest waiver stays unchanged/);
  });

  it("Required for Guests toggle calls setGuestWaiverRequiredAction, and its rendered copy never implies booking/event/check-in enforcement (the file's own top-of-file design-rationale comment mentioning future 'enforcement' is expected and excluded — this checks only the user-facing toggle copy)", () => {
    expect(s).toContain("Required for Guests");
    const fnStart = s.indexOf("function handleRequiredToggle(");
    const fnEnd = s.indexOf("\n  }", fnStart);
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("setGuestWaiverRequiredAction(next)");
    const toggleBlockStart = s.indexOf("Required for Guests");
    const toggleBlockEnd = s.indexOf("</div>\n      )}\n    </div>\n  );", toggleBlockStart);
    const toggleCopy = s.slice(toggleBlockStart, toggleBlockEnd);
    expect(toggleCopy).not.toMatch(/reservation|booking|check-in|event registration|enforc/i);
  });

  it("disabling the requirement never implies delete/unpublish — copy only says published versions/history are preserved", () => {
    const offCopyIdx = s.indexOf("This Guest waiver is not currently marked required");
    expect(offCopyIdx).toBeGreaterThan(-1);
    const offCopy = s.slice(offCopyIdx, offCopyIdx + 250);
    expect(offCopy).not.toMatch(/delete|unpublish|remove/i);
    expect(offCopy).toContain("Published versions and version history are preserved.");
  });

  it("no Signed/Signature/DocuSign/Send Waiver/Get Waiver Link terminology anywhere", () => {
    expect(s).not.toMatch(/Signed|Signature|DocuSign|Send Waiver|Get Waiver Link/);
  });

  // Copy-correctness pass — 43B-2B has no Guest acceptance flow and no
  // Guest/public delivery route yet, so production copy must never claim
  // publishing makes a waiver visible to Guests, or that Guests currently
  // review/accept/get required to accept it. These four phrases are the
  // exact premature-claim patterns identified and removed.
  it("never claims publishing/requiring makes the waiver visible to, reviewed by, or accepted by Guests — no Guest acceptance flow exists yet", () => {
    expect(s).not.toMatch(/visible to Guests/);
    expect(s).not.toMatch(/review and accept/);
    expect(s).not.toMatch(/required to accept/);
    expect(s).not.toMatch(/published or accepted/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Guest Server Actions — 1:1 RPC mapping, Guest-specific error copy,
//    revalidation
// ═══════════════════════════════════════════════════════════════════════════

describe("actions.ts — Guest Waiver Server Actions", () => {
  const s = readSource(SETTINGS_ACTIONS_PATH);

  it("createGuestWaiverDraftAction calls create_guest_waiver_draft and returns the new version id", () => {
    const fn = functionBody(s, "createGuestWaiverDraftAction");
    expect(fn).toContain('supabase.rpc("create_guest_waiver_draft", {');
    expect(fn).toContain("p_title: title,");
    expect(fn).toContain("p_body: body,");
    expect(fn).toContain("versionId: data");
  });

  it("updateGuestWaiverDraftAction calls update_guest_waiver_draft with the version id", () => {
    const fn = functionBody(s, "updateGuestWaiverDraftAction");
    expect(fn).toContain('supabase.rpc("update_guest_waiver_draft", {');
    expect(fn).toContain("p_version_id: versionId,");
  });

  it("publishGuestWaiverVersionAction calls publish_guest_waiver_version with the version id", () => {
    const fn = functionBody(s, "publishGuestWaiverVersionAction");
    expect(fn).toContain('supabase.rpc("publish_guest_waiver_version", {');
    expect(fn).toContain("p_version_id: versionId,");
  });

  it("setGuestWaiverRequiredAction calls set_guest_waiver_required with the boolean flag", () => {
    const fn = functionBody(s, "setGuestWaiverRequiredAction");
    expect(fn).toContain('supabase.rpc("set_guest_waiver_required", {');
    expect(fn).toContain("p_required: required,");
  });

  it("no Guest acceptance action exists in this file", () => {
    expect(s).not.toMatch(/accept_guest_waiver/);
  });

  it("all four Guest actions revalidate /admin/settings on success, exactly like the Member actions", () => {
    for (const name of [
      "createGuestWaiverDraftAction", "updateGuestWaiverDraftAction",
      "publishGuestWaiverVersionAction", "setGuestWaiverRequiredAction",
    ]) {
      const fn = functionBody(s, name);
      expect(fn).toContain('revalidatePath("/admin/settings");');
    }
  });

  it("uses Guest-specific error copy — a distinct message map, not the Member ERROR_MESSAGES object, so a Guest waiver_not_found error never says 'No Member waiver...'", () => {
    expect(s).toMatch(/GUEST_ERROR_MESSAGES/);
    const guestMapStart = s.indexOf("GUEST_ERROR_MESSAGES");
    const guestMapEnd = s.indexOf("};", guestMapStart);
    const guestMap = s.slice(guestMapStart, guestMapEnd);
    expect(guestMap).toMatch(/No Guest waiver has been created yet/);
    expect(guestMap).not.toMatch(/No Member waiver/);
  });

  it("each Guest action reads from GUEST_ERROR_MESSAGES, not the shared Member ERROR_MESSAGES object", () => {
    for (const name of [
      "createGuestWaiverDraftAction", "updateGuestWaiverDraftAction",
      "publishGuestWaiverVersionAction", "setGuestWaiverRequiredAction",
    ]) {
      const fn = functionBody(s, name);
      expect(fn).toMatch(/GUEST_ERROR_MESSAGES\[key\]/);
    }
  });

  it("preserves the same backend error-code matching per action as the Member equivalents (title/body validation, draft_already_exists, waiver_version_not_found, version_not_editable/version_not_draft, waiver_not_found, required_flag_required, insufficient_role)", () => {
    const createFn = functionBody(s, "createGuestWaiverDraftAction");
    expect(createFn).toMatch(/title_required\|body_required\|title_too_long\|body_too_long\|draft_already_exists\|not_authenticated\|insufficient_role/);

    const updateFn = functionBody(s, "updateGuestWaiverDraftAction");
    expect(updateFn).toMatch(/title_required\|body_required\|title_too_long\|body_too_long\|waiver_version_not_found\|version_not_editable\|not_authenticated\|insufficient_role/);

    const publishFn = functionBody(s, "publishGuestWaiverVersionAction");
    expect(publishFn).toMatch(/waiver_version_not_found\|version_not_draft\|not_authenticated\|insufficient_role/);

    const requiredFn = functionBody(s, "setGuestWaiverRequiredAction");
    expect(requiredFn).toMatch(/required_flag_required\|waiver_not_found\|not_authenticated\|insufficient_role/);
  });

  it("the existing Member ERROR_MESSAGES object and Member waiver actions are byte-unchanged — waiver_not_found still says 'No Member waiver has been created yet.'", () => {
    expect(s).toContain('waiver_not_found:              "No Member waiver has been created yet.",');
    const memberCreateFn = functionBody(s, "createMemberWaiverDraftAction");
    expect(memberCreateFn).toContain('supabase.rpc("create_member_waiver_draft", {');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. Permissions — Admin-only, Staff/Member/Pro no authoring access
// ═══════════════════════════════════════════════════════════════════════════

describe("Guest Waiver authoring remains Admin-only — no Settings access widened", () => {
  it("GuestWaiverSection contains no role check of its own — authorization is entirely server-side (the RPCs' own Admin-only gate, confirmed in 0195) and the whole Settings page is already Admin-gated", () => {
    const s = readSource(GUEST_WAIVER_SECTION_PATH);
    expect(s).not.toMatch(/userRole|isOperator|isMembershipAdmin/);
  });

  it("admin/settings/page.tsx's existing Admin-only route gate is unchanged — still redirects any non-admin before any Settings data (Member or Guest) is ever fetched", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    expect(s).toContain('if (profile?.role !== "admin") redirect("/calendar");');
  });
});
