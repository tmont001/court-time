import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 43A-2 — Member Waiver UI. Admin authoring (Settings -> Memberships),
// Member self-service review/acceptance (/waivers/member), the /profile
// status card, and Admin-only compliance display on Member Detail. Wraps
// the immutable 0192/0193 RPCs only — no new migration, no booking/lesson/
// event enforcement, no Admin proxy acceptance. Source-inspection style,
// matching this repository's established convention (no live Postgres/DOM
// render in this suite).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const SETTINGS_ACTIONS_PATH   = "src/app/(app)/admin/settings/actions.ts";
const WAIVER_SECTION_PATH     = "src/app/(app)/admin/settings/MemberWaiverSection.tsx";
const SETTINGS_PAGE_PATH      = "src/app/(app)/admin/settings/page.tsx";
const PROFILE_PAGE_PATH       = "src/app/(app)/profile/page.tsx";
const WAIVER_CARD_PATH        = "src/app/(app)/profile/WaiverStatusCard.tsx";
const WAIVER_PAGE_PATH         = "src/app/(app)/waivers/member/page.tsx";
const WAIVER_ACCEPT_ACTIONS_PATH = "src/app/(app)/waivers/member/actions.ts";
const WAIVER_ACCEPT_CLIENT_PATH  = "src/app/(app)/waivers/member/WaiverAcceptanceClient.tsx";
const MEMBER_DETAIL_PAGE_PATH    = "src/app/(app)/admin/members/[id]/page.tsx";
const MEMBER_DETAIL_CLIENT_PATH  = "src/app/(app)/admin/members/[id]/MemberDetailClient.tsx";

function functionBody(source: string, exportName: string): string {
  const start = source.indexOf(`export async function ${exportName}(`);
  expect(start, `${exportName} not found`).toBeGreaterThan(-1);
  const nextExportIdx = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, nextExportIdx > -1 ? nextExportIdx : undefined);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCOPE — no new migration, no enforcement, 0192/0193 immutable
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 43A-2 scope guard", () => {
  it("no unauthorized migration beyond 0195 exists (0194 is Phase 43B-1A, a later, unrelated migration)", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const laterMigrations = files.filter((f) => {
      const match = f.match(/^(\d{4})_/);
      return match !== null && Number(match[1]) > 195;
    });
    expect(laterMigrations).toEqual([]);
  });

  it("0192 and 0193 both still exist untouched — this UI pass reads/calls them, never edits them", () => {
    expect(() => readSource("supabase/migrations/0192_member_waiver_foundation.sql")).not.toThrow();
    expect(() => readSource("supabase/migrations/0193_fix_member_waiver_status_accepted_at_ambiguity.sql")).not.toThrow();
  });

  it("no new UI file references reservations, lessons, events, or programs — no booking/lesson/event enforcement was added", () => {
    for (const path of [
      SETTINGS_ACTIONS_PATH, WAIVER_SECTION_PATH, WAIVER_PAGE_PATH,
      WAIVER_ACCEPT_ACTIONS_PATH, WAIVER_ACCEPT_CLIENT_PATH, WAIVER_CARD_PATH,
    ]) {
      const s = readSource(path);
      expect(s).not.toMatch(/create_reservation|create_member_reservation|create_lesson_request|book_lesson|register_for_event|event_participants|program_enrollments/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN SETTINGS — Server Actions
// ═══════════════════════════════════════════════════════════════════════════

describe("Admin Settings actions.ts — Member Waiver RPC wrappers", () => {
  const s = readSource(SETTINGS_ACTIONS_PATH);

  it("createMemberWaiverDraftAction calls create_member_waiver_draft and returns the new version id", () => {
    const fn = functionBody(s, "createMemberWaiverDraftAction");
    expect(fn).toContain('supabase.rpc("create_member_waiver_draft", {');
    expect(fn).toContain("p_title: title,");
    expect(fn).toContain("p_body: body,");
    expect(fn).toContain("versionId: data");
  });

  it("updateMemberWaiverDraftAction calls update_member_waiver_draft with the version id", () => {
    const fn = functionBody(s, "updateMemberWaiverDraftAction");
    expect(fn).toContain('supabase.rpc("update_member_waiver_draft", {');
    expect(fn).toContain("p_version_id: versionId,");
  });

  it("publishMemberWaiverVersionAction calls publish_member_waiver_version with the version id", () => {
    const fn = functionBody(s, "publishMemberWaiverVersionAction");
    expect(fn).toContain('supabase.rpc("publish_member_waiver_version", {');
    expect(fn).toContain("p_version_id: versionId,");
  });

  it("setMemberWaiverRequiredAction calls set_member_waiver_required with the boolean flag", () => {
    const fn = functionBody(s, "setMemberWaiverRequiredAction");
    expect(fn).toContain('supabase.rpc("set_member_waiver_required", {');
    expect(fn).toContain("p_required: required,");
  });

  it("no action in this file calls accept_member_waiver — no Admin proxy acceptance path exists", () => {
    expect(s).not.toMatch(/accept_member_waiver/);
  });

  it("every waiver action maps the RPC's own error codes to specific user-facing messages, not a generic catch-all only", () => {
    expect(s).toContain("title_required:               \"Please enter a title.\",");
    expect(s).toContain("draft_already_exists:          \"A draft already exists");
    expect(s).toContain("version_not_editable:          \"Published waiver wording can't be edited");
    expect(s).toContain("version_not_draft:             \"That version is already published.\",");
    expect(s).toContain("waiver_not_found:              \"No Member waiver has been created yet.\",");
  });

  it("all four waiver actions revalidate /admin/settings after a successful mutation", () => {
    for (const name of [
      "createMemberWaiverDraftAction", "updateMemberWaiverDraftAction",
      "publishMemberWaiverVersionAction", "setMemberWaiverRequiredAction",
    ]) {
      const fn = functionBody(s, name);
      expect(fn).toContain('revalidatePath("/admin/settings");');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN SETTINGS — data read (page.tsx) and section placement
// ═══════════════════════════════════════════════════════════════════════════

describe("Admin Settings page.tsx — Member Waiver data read and placement", () => {
  const s = readSource(SETTINGS_PAGE_PATH);

  it("reads waivers and waiver_versions directly (Admin RLS-scoped table reads), not a new RPC", () => {
    expect(s).toContain('.from("waivers")');
    expect(s).toContain('.from("waiver_versions")');
    expect(s).not.toMatch(/\.rpc\("get_member_waiver_compliance|\.rpc\("get_waiver_acceptance_rate/);
  });

  it("does not read waiver_acceptances directly — no roster-wide compliance table/acceptance-rate dashboard in this checkpoint", () => {
    expect(s).not.toMatch(/waiver_acceptances/);
  });

  it("MemberWaiverSection is rendered inside the Memberships group, after Membership Types, with its own 'Member Waiver' subsection label", () => {
    const membershipsGroupStart = s.indexOf('<h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Memberships</h2>');
    const pricingGroupStart = s.indexOf('<h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Pricing & Payments</h2>');
    const waiverLabelIdx = s.indexOf("Member Waiver", membershipsGroupStart);
    const waiverComponentIdx = s.indexOf("<MemberWaiverSection");
    expect(membershipsGroupStart).toBeGreaterThan(-1);
    expect(waiverLabelIdx).toBeGreaterThan(membershipsGroupStart);
    expect(waiverComponentIdx).toBeGreaterThan(waiverLabelIdx);
    expect(pricingGroupStart).toBeGreaterThan(waiverComponentIdx);
  });

  it("passes waiverId/isRequired/currentVersion/draftVersion — the exact shape MemberWaiverSection expects", () => {
    const propsIdx = s.indexOf("<MemberWaiverSection");
    const propsBlock = s.slice(propsIdx, s.indexOf("/>", propsIdx));
    expect(propsBlock).toContain("waiverId={waiverRow?.id ?? null}");
    expect(propsBlock).toContain("isRequired={waiverRow?.is_required ?? true}");
    expect(propsBlock).toContain("currentVersion={currentWaiverVersion}");
    expect(propsBlock).toContain("draftVersion={draftWaiverVersion}");
  });

  it("page.tsx itself performs no waiver mutation — only reads plus prop-passing (all writes live in Server Actions)", () => {
    const waiverSectionStart = s.indexOf("Phase 43A-2");
    const rest = s.slice(waiverSectionStart);
    expect(rest).not.toMatch(/\.rpc\(|\.update\(|\.insert\(|\.delete\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN SETTINGS — MemberWaiverSection component states
// ═══════════════════════════════════════════════════════════════════════════

describe("MemberWaiverSection — state machine, draft/published separation, confirmation", () => {
  const s = readSource(WAIVER_SECTION_PATH);

  it("state 1 (no waiver yet): shows explanation + Create button, gated on waiverId === null", () => {
    expect(s).toContain('waiverId === null && editorMode === "none"');
    expect(s).toContain("No Member waiver has been created yet.");
    expect(s).toContain("Create Member Waiver");
  });

  it("the current published version block is READ-ONLY — renders as plain text (<p>), never inside an <input>/<textarea>", () => {
    const blockStart = s.indexOf("CURRENT PUBLISHED VERSION");
    const blockEnd = s.indexOf("Update Waiver");
    const block = s.slice(blockStart, blockEnd);
    expect(block).not.toMatch(/<textarea|<input/);
    expect(block).toContain("whitespace-pre-wrap");
  });

  it("the action label is 'Update Waiver' — the old 'Start New Version' user-facing label is gone", () => {
    expect(s).toContain("Update Waiver");
    expect(s).not.toMatch(/>\s*Start New Version\s*</);
  });

  it("opening Update Waiver shows helper copy naming the current version number and stating the published waiver stays unchanged until publish", () => {
    expect(s).toMatch(/Creates a draft based on Version \{currentVersion(\?\.)?\.versionNumber\}/);
    expect(s).toContain("The currently published waiver stays unchanged until you publish the update.");
  });

  it("'Update Waiver' only appears when published with no draft (state 3), and prefills title/body from currentVersion", () => {
    expect(s).toContain("currentVersion && !draftVersion && editorMode === \"none\"");
    const fnStart = s.indexOf("function startNewVersion()");
    const fnEnd = s.indexOf("\n  }", fnStart);
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("setTitle(currentVersion.title);");
    expect(fn).toContain("setBody(currentVersion.body);");
  });

  it("the draft editor (editable Title/Body + Save Draft) renders for states 2/3(mid-new-version)/4 — never for the read-only current version", () => {
    expect(s).toContain('const isEditingDraft = editorMode === "edit-draft" || editorMode === "new-version" || editorMode === "create";');
    const editorStart = s.indexOf("isEditingDraft &&");
    const editorEnd = s.indexOf("Requirement toggle", editorStart);
    const editorBlock = s.slice(editorStart, editorEnd);
    expect(editorBlock).toContain("<input");
    expect(editorBlock).toContain("<textarea");
    expect(editorBlock).toContain("Save Draft");
  });

  it("Publish requires an explicit inline confirmation before calling the RPC — the confirm step's text differs for a first-ever publish vs. a new-version publish, and both mention reacceptance", () => {
    expect(s).toContain("confirmingPublish ?");
    expect(s).toContain("Publishing will make this waiver current and Members will need to accept it.");
    expect(s).toContain("Publishing will make this the current waiver version. Members who accepted the previous version will need to accept this one.");
  });

  it("Publish is only reachable from a REAL saved draft (draftVersion prop, not the ephemeral new-version prefill) — handlePublish guards on draftVersion, and always publishes draftVersion.id, never a locally-edited value", () => {
    const fnStart = s.indexOf("function handlePublish()");
    const fnEnd = s.indexOf("\n  }", fnStart);
    const fn = s.slice(fnStart, fnEnd + 4);
    expect(fn).toContain("if (!draftVersion || isDraftDirty) return;");
    expect(fn).toContain('publishMemberWaiverVersionAction(draftVersion.id)');
  });

  it("isDraftDirty compares the live editor title/body against the authoritative saved draftVersion.title/body — only meaningful in edit-draft mode with a real draft", () => {
    const constStart = s.indexOf("const isDraftDirty =");
    const constEnd = s.indexOf(";", s.indexOf("draftVersion.body", constStart));
    const block = s.slice(constStart, constEnd);
    expect(block).toContain('editorMode === "edit-draft"');
    expect(block).toContain("draftVersion !== null");
    expect(block).toContain("title !== draftVersion.title");
    expect(block).toContain("body !== draftVersion.body");
  });

  it("Publish is disabled whenever isDraftDirty is true — an unsaved edit cannot be published, only the last-saved wording can", () => {
    const idx = s.indexOf('onClick={() => setConfirmingPublish(true)}');
    expect(idx).toBeGreaterThan(-1);
    const button = s.slice(s.lastIndexOf("<button", idx), s.indexOf(">", s.indexOf("Publish", idx)));
    expect(button).toContain("disabled={isPending || isDraftDirty}");
  });

  it("dirty state shows concise helper copy telling the Admin to save first", () => {
    expect(s).toContain("{isDraftDirty && (");
    expect(s).toContain("Save your changes before publishing.");
  });

  it("editing while the publish confirmation is open auto-closes the confirmation (a stale confirmation can never be clicked through to publish unsaved wording)", () => {
    const fnStart = s.indexOf("if (isDraftDirty && confirmingPublish) setConfirmingPublish(false);");
    expect(fnStart).toBeGreaterThan(-1);
  });

  it("Save Draft remains unchanged: it alone can clear the dirty state, and Publish never triggers a save itself — no combined save+publish action exists", () => {
    const publishFn = s.slice(s.indexOf("function handlePublish()"), s.indexOf("\n  }", s.indexOf("function handlePublish()")) + 4);
    expect(publishFn).not.toMatch(/createMemberWaiverDraftAction|updateMemberWaiverDraftAction|handleSaveDraft\(\)/);
    const saveDraftFn = s.slice(s.indexOf("function handleSaveDraft()"), s.indexOf("\n  }", s.indexOf("function handleSaveDraft()")) + 4);
    expect(saveDraftFn).not.toMatch(/publishMemberWaiverVersionAction|handlePublish\(\)/);
  });

  it("an unchanged saved draft is publishable: on load AND immediately after a successful Save Draft, the resync effect sets title/body to EXACTLY draftVersion's own values, so isDraftDirty evaluates false and Publish is enabled again", () => {
    const effectStart = s.indexOf("if (draftVersion) {");
    const effectEnd = s.indexOf("}", s.indexOf("setConfirmingPublish(false);", effectStart));
    const effect = s.slice(effectStart, effectEnd);
    expect(effect).toContain("setTitle(draftVersion.title);");
    expect(effect).toContain("setBody(draftVersion.body);");
  });

  it("Save Draft branches update vs. create by editor mode — 'edit-draft' updates the existing draft id, anything else creates a new one", () => {
    const fnStart = s.indexOf("function handleSaveDraft()");
    const fnEnd = s.indexOf("\n  }", fnStart);
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain('editorMode === "edit-draft" && draftVersion');
    expect(fn).toContain("updateMemberWaiverDraftAction(draftVersion.id, trimmedTitle, trimmedBody)");
    expect(fn).toContain("createMemberWaiverDraftAction(trimmedTitle, trimmedBody)");
  });

  it("the Required toggle calls setMemberWaiverRequiredAction and never references waiver_versions/waiver_acceptances/publish/draft RPCs — preserves the locked model semantics (disable/re-enable never touches acceptance history)", () => {
    const fnStart = s.indexOf("function handleRequiredToggle(");
    const fnEnd = s.indexOf("\n  }", fnStart);
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("setMemberWaiverRequiredAction(next)");
    expect(fn).not.toMatch(/create_member_waiver_draft|update_member_waiver_draft|publish_member_waiver_version|accept_member_waiver/);
  });

  it("turning the requirement off shows explanatory copy that nothing published or accepted is affected", () => {
    expect(s).toContain("Nothing published or accepted is affected");
  });

  it("never implies booking/lesson/event enforcement exists — Phase 43A has none; the toggle's user-facing copy says the waiver becomes 'required again', not that anything is 'enforced'", () => {
    const toggleCopyStart = s.indexOf("Required for Members");
    const toggleCopyEnd = s.indexOf("</p>", s.indexOf("Members are not currently required", toggleCopyStart));
    const toggleCopy = s.slice(toggleCopyStart, toggleCopyEnd);
    expect(toggleCopy).not.toMatch(/enforcement|enforce/i);
    expect(s).toContain("Turning this back on makes the current waiver required again.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PROFILE — role-agnostic read, quiet not_required, all four states
// ═══════════════════════════════════════════════════════════════════════════

describe("Profile page.tsx — role-agnostic get_my_member_waiver_status, drafts never exposed", () => {
  const s = readSource(PROFILE_PAGE_PATH);

  it("calls get_my_member_waiver_status with no role/profile-role gate around it — role-agnostic per locked decision 6", () => {
    expect(s).toContain('supabase.rpc("get_my_member_waiver_status")');
    const rpcIdx = s.indexOf('supabase.rpc("get_my_member_waiver_status")');
    const surrounding = s.slice(Math.max(0, rpcIdx - 300), rpcIdx);
    expect(surrounding).not.toMatch(/role\s*===\s*["']admin["']|role\s*===\s*["']staff["']/);
  });

  it("never reads waiver_versions or waivers directly — the RPC is the sole canonical read on this page, so a draft can never leak here", () => {
    expect(s).not.toMatch(/\.from\("waiver_versions"\)|\.from\("waivers"\)/);
  });

  it("only renders the WaiverStatusCard when status !== not_required — an hr never dangles above an omitted (null) card", () => {
    expect(s).toContain('waiverStatus.status !== "not_required"');
  });
});

describe("WaiverStatusCard — four states, quiet not_required, accepted date shown", () => {
  const s = readSource(WAIVER_CARD_PATH);

  it("returns null for not_required — quiet omission, no alarming treatment", () => {
    expect(s).toContain('if (status === "not_required") return null;');
  });

  it("never_accepted shows 'needs your acceptance' with current title/version, action links to /waivers/member", () => {
    expect(s).toContain("Waiver needs your acceptance");
    expect(s).toContain("Review & Accept");
  });

  it("outdated clearly explains a newer version now requires review, distinct action label", () => {
    expect(s).toContain("The club published an updated waiver");
    expect(s).toContain("Review Updated Waiver");
  });

  it("current shows Accepted + the accepted date, with an optional View Waiver action", () => {
    expect(s).toContain('status === "current"');
    expect(s).toContain("Accepted");
    expect(s).toContain("acceptedAt ? new Date(acceptedAt).toLocaleDateString()");
    expect(s).toContain("View Waiver");
  });

  it("all three non-quiet states link to the same /waivers/member acceptance page", () => {
    expect(s).toContain('href="/waivers/member"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WAIVER ACCEPTANCE PAGE — exact current version only, stale handling, text render
// ═══════════════════════════════════════════════════════════════════════════

describe("/waivers/member page.tsx — canonical read, exact current version only, quiet not_required", () => {
  const s = readSource(WAIVER_PAGE_PATH);

  it("get_my_member_waiver_status is the sole read on this page", () => {
    expect((s.match(/\.rpc\(/g) ?? []).length).toBe(1);
    expect(s).toContain('supabase.rpc("get_my_member_waiver_status")');
  });

  it("renders body with whitespace-pre-wrap on plain text, never dangerouslySetInnerHTML", () => {
    expect(s).toContain("whitespace-pre-wrap");
    expect(s).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("passes waiver.current_version_id (the value just read from the RPC) into WaiverAcceptanceClient — never a client-invented/arbitrary id", () => {
    const propsIdx = s.indexOf("<WaiverAcceptanceClient");
    const propsBlock = s.slice(propsIdx, s.indexOf("/>", propsIdx) + 2);
    expect(propsBlock).toContain("currentVersionId={waiver.current_version_id}");
    expect(propsBlock).toContain("initialStatus={waiver.status");
    expect(propsBlock).toContain("initialAcceptedAt={waiver.accepted_at}");
  });

  it("keys WaiverAcceptanceClient by waiver.current_version_id — a published v1 -> v2 forces a full remount, deterministically clearing any stale-version client state instead of relying on prop-sync", () => {
    const propsIdx = s.indexOf("<WaiverAcceptanceClient");
    const propsBlock = s.slice(propsIdx, s.indexOf("/>", propsIdx) + 2);
    expect(propsBlock).toContain("key={waiver.current_version_id}");
  });

  it("shows a quiet 'No waiver is currently required' state with a path back to Account when not required/absent", () => {
    expect(s).toContain("No waiver is currently required.");
    expect(s).toContain('href="/profile"');
  });
});

describe("waivers/member/actions.ts — acceptMemberWaiverAction: role-agnostic, self-only, stale handling", () => {
  const s = readSource(WAIVER_ACCEPT_ACTIONS_PATH);

  it("takes exactly one argument — the version being accepted — no roster/user id parameter, no Admin-proxy variant", () => {
    expect(s).toContain("export async function acceptMemberWaiverAction(\n  waiverVersionId: string\n)");
    expect(s).not.toMatch(/rosterMemberId|onBehalfOf|targetUserId/);
  });

  it("calls accept_member_waiver with p_waiver_version_id only", () => {
    expect(s).toContain('supabase.rpc("accept_member_waiver", {');
    expect(s).toContain("p_waiver_version_id: waiverVersionId,");
  });

  it("maps stale_waiver_version to a distinct, actionable message and flags it via a separate `stale` field", () => {
    expect(s).toContain("stale_waiver_version:      \"A newer version of this waiver has been published. Refresh to review it.\",");
    expect(s).toContain('stale: key === "stale_waiver_version",');
  });

  it("this is the ONLY file in the app that calls accept_member_waiver", () => {
    const grepTargets = [
      "src/app/(app)/admin/settings/actions.ts",
      "src/app/(app)/admin/members/[id]/page.tsx",
      "src/app/(app)/admin/members/[id]/MemberDetailClient.tsx",
      "src/app/(app)/profile/page.tsx",
      "src/app/(app)/profile/WaiverStatusCard.tsx",
    ];
    for (const path of grepTargets) {
      expect(readSource(path)).not.toMatch(/accept_member_waiver/);
    }
  });
});

describe("WaiverAcceptanceClient — Accept button, stale-version Refresh path, no client-side version invention", () => {
  const s = readSource(WAIVER_ACCEPT_CLIENT_PATH);

  it("accepts currentVersionId as a required prop and passes it verbatim to the action — never constructs/guesses a version id", () => {
    expect(s).toContain("currentVersionId: string;");
    expect(s).toContain("acceptMemberWaiverAction(currentVersionId)");
  });

  it("on a stale-version error, shows a Refresh action (router.refresh()) instead of retrying the same stale accept", () => {
    expect(s).toContain("setIsStale(Boolean(result.stale));");
    expect(s).toContain("isStale ? (");
    expect(s).toContain('onClick={() => router.refresh()}');
  });

  it("once current, shows Accepted + the accepted date, no further action button", () => {
    const currentBlockStart = s.indexOf('if (status === "current")');
    const currentBlockEnd = s.indexOf("\n  }", currentBlockStart);
    const block = s.slice(currentBlockStart, currentBlockEnd);
    expect(block).toContain("Accepted");
    expect(block).not.toMatch(/<button/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN MEMBER DETAIL — Admin-only, Staff never fetches, no proxy control
// ═══════════════════════════════════════════════════════════════════════════

describe("Admin Member Detail page.tsx — get_member_waiver_status widened to Admin+Staff (43B-1A/43B-1B)", () => {
  const s = readSource(MEMBER_DETAIL_PAGE_PATH);

  it("the RPC call is gated on isOperator(profile.role) && rosterMemberIdForWaiver — Phase 43B-1B widened this from the original isAdmin-only gate, matching 0194's own server-side Admin-or-Staff widening", () => {
    const idx = s.indexOf('supabase.rpc("get_member_waiver_status"');
    expect(idx).toBeGreaterThan(-1);
    const precedingBlock = s.slice(Math.max(0, idx - 200), idx);
    expect(precedingBlock).toContain("isOperator(profile.role) && rosterMemberIdForWaiver");
    expect(precedingBlock).not.toContain("isAdmin && rosterMemberIdForWaiver");
  });

  it("a Member/Pro caller (isOperator === false) gets data: null for this read — never an empty-but-attempted call (the whole route already redirects non-operators before this point)", () => {
    const idx = s.indexOf('supabase.rpc("get_member_waiver_status"');
    const ternaryBlock = s.slice(idx - 250, idx + 300);
    expect(ternaryBlock).toContain(": { data: null }");
  });

  it("passes the mapped waiverStatus prop through to MemberDetailClient", () => {
    expect(s).toContain("waiverStatus={waiverStatusRow}");
  });
});

describe("MemberDetailClient — Waiver display is Admin+Staff (canViewWaiverCompliance), read-only, no proxy accept control", () => {
  const s = readSource(MEMBER_DETAIL_CLIENT_PATH);

  it("the Waiver block is gated on canViewWaiverCompliance, deliberately NOT isMembershipAdmin — Staff now sees this read-only block while still never gaining Membership Status/Type editing (which stays on isMembershipAdmin)", () => {
    const idx = s.indexOf("Waiver group (Phase 43A-2");
    expect(idx).toBeGreaterThan(-1);
    const blockStart = s.indexOf("{canViewWaiverCompliance && waiverStatus", idx);
    expect(blockStart).toBeGreaterThan(idx);
    expect(s).not.toMatch(/\{isMembershipAdmin && waiverStatus/);
  });

  it("renders all FOUR locked semantic states: Current (+accepted date), Needs acceptance, Updated waiver needs acceptance, and Not required", () => {
    const idx = s.indexOf("Waiver group (Phase 43A-2");
    const blockEnd = s.indexOf("{/* Stats */}", idx);
    const block = s.slice(idx, blockEnd);
    expect(block).toContain("Current");
    expect(block).toContain("Needs acceptance");
    expect(block).toContain("Updated waiver needs acceptance");
    expect(block).toContain("Accepted {fmtDate(waiverStatus.acceptedAt, clubTimezone)}");
    expect(block).toMatch(/waiverStatus\.status === "not_required"[\s\S]*?Not required/);
  });

  it("the Waiver block renders for EVERY waiverStatus (including not_required) once canViewWaiverCompliance — no longer gated on status !== not_required", () => {
    const idx = s.indexOf("Waiver group (Phase 43A-2");
    const gateIdx = s.indexOf("{canViewWaiverCompliance && waiverStatus", idx);
    expect(gateIdx).toBeGreaterThan(idx);
    const gateLine = s.slice(gateIdx, s.indexOf("\n", gateIdx));
    expect(gateLine).not.toMatch(/status !== "not_required"/);
  });

  it("no edit or accept control exists anywhere in the Waiver block — display only, neither Admin nor Staff can accept for the Member", () => {
    const idx = s.indexOf("Waiver group (Phase 43A-2");
    const blockEnd = s.indexOf("{/* Stats */}", idx);
    const block = s.slice(idx, blockEnd);
    expect(block).not.toMatch(/<button|<select|<input|onClick/);
  });

  it("this file never calls accept_member_waiver, create_member_waiver_draft, update_member_waiver_draft, publish_member_waiver_version, or set_member_waiver_required", () => {
    expect(s).not.toMatch(/accept_member_waiver|create_member_waiver_draft|update_member_waiver_draft|publish_member_waiver_version|set_member_waiver_required/);
  });

  it("the waiverStatus prop type only carries status/versionNumber/acceptedAt — no title/body ever reaches Member Detail (that belongs to the acceptance surface, not a compliance summary)", () => {
    const typeStart = s.indexOf("export interface MemberWaiverStatus {");
    const typeEnd = s.indexOf("\n}", typeStart);
    const type = s.slice(typeStart, typeEnd);
    expect(type).not.toMatch(/title|body/);
  });
});
