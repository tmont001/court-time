import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "./types";
import type { NotificationKind } from "@/lib/notification-targets";

// Phase 45C1 — this file verifies the ARCHITECTURAL CONTRACT established by
// splitting the schema into a generated structural source of truth
// (src/lib/db/database.types.ts, real Supabase CLI output, never
// hand-edited) plus a thin, evidence-backed domain layer
// (src/lib/db/types.ts). It does NOT re-declare the schema's content a
// fourth time (a hardcoded value list here would itself become another
// source of truth to keep in sync) — it checks STRUCTURE and DELEGATION:
// that the generated file exists and looks generated, that the domain layer
// derives from it rather than duplicating it, that specific previously-
// missing structural objects are now reachable through that derivation, and
// that the domain-layer overrides this checkpoint added are still present.
//
// Where a fact can be expressed as a TYPE (not just a string in a file), it
// is — a `[A] extends [B] ? true : false`-style compile-time assertion
// catches a regression the moment `pnpm tsc` runs, before any test runs at
// all. Plain source-text checks are used only for facts that aren't
// expressible as a type (a file existing, a header not containing certain
// words, a migration not existing).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const DB_TYPES_PATH = "src/lib/db/types.ts";
const GENERATED_PATH = "src/lib/db/database.types.ts";

// ─────────────────────────────────────────────────────────────────────────
// Type-level assertions — fail `pnpm tsc`, not just this test file, the
// moment any of these facts stop holding. Each `_Assert...` type below is
// intentionally never referenced anywhere else: `AssertTrue<T extends
// true>`'s generic constraint alone is what does the work — instantiating
// it with anything other than literal `true` is a compile error at the
// type alias's own declaration, before any test ever runs. The whole point
// is to exist and never be used for anything further.
/* eslint-disable @typescript-eslint/no-unused-vars */
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;

// The domain layer's notifications.kind IS the canonical NotificationKind —
// not a second, independently-maintained copy of it (that was the exact
// drift this checkpoint's predecessor found and fixed).
type _NotificationsKindIsCanonical = AssertTrue<
  AssertEqual<Database["public"]["Tables"]["notifications"]["Row"]["kind"], NotificationKind>
>;
type _NotificationPreferencesKindIsCanonical = AssertTrue<
  AssertEqual<Database["public"]["Tables"]["notification_preferences"]["Row"]["kind"], NotificationKind>
>;

// profiles.role kept its literal union through the generated-structure
// rewrite (table columns are stronger than generation alone can produce —
// see types.ts's own header for why).
type _ProfilesRoleIsLiteralUnion = AssertTrue<
  AssertEqual<Database["public"]["Tables"]["profiles"]["Row"]["role"], "member" | "pro" | "staff" | "admin">
>;

// profiles.active_club_id (migration 0081) is reachable through the
// generated structure — previously entirely absent from the hand-maintained
// file this replaced.
type _ProfilesHasActiveClubId = AssertTrue<
  AssertEqual<Database["public"]["Tables"]["profiles"]["Row"]["active_club_id"], string | null>
>;

// lesson_requests' pricing/outcome/policy columns (migrations 0070, 0140,
// 0186) are reachable — previously entirely absent.
type _LessonRequestsHasPricingColumns = AssertTrue<
  AssertEqual<
    Pick<
      Database["public"]["Tables"]["lesson_requests"]["Row"],
      "lesson_type_id" | "lesson_outcome" | "pricing_basis" | "unit_price_amount_cents" | "price_amount_cents" | "cancellation_policy_state"
    >,
    {
      lesson_type_id: string | null;
      lesson_outcome: "completed" | "member_no_show" | "pro_no_show" | "cancelled" | null;
      pricing_basis: "flat" | "hourly" | null;
      unit_price_amount_cents: number | null;
      price_amount_cents: number | null;
      cancellation_policy_state: "in_policy" | "grace" | "late" | "not_applicable" | null;
    }
  >
>;

// lesson_types, pro_availability_windows, pro_blackout_dates (migration
// 0070) are reachable through the generated structure — previously entirely
// absent tables.
type _PreviouslyMissingTablesExist = AssertTrue<
  AssertEqual<
    keyof Pick<Database["public"]["Tables"], "lesson_types" | "pro_availability_windows" | "pro_blackout_dates">,
    "lesson_types" | "pro_availability_windows" | "pro_blackout_dates"
  >
>;

// club_memberships remains reachable in TYPE (the generated file must not
// delete schema objects to represent authorization — RLS/grants do that
// job, separately) even though no application code can successfully query
// it (AUTH-08: RLS-enabled, zero policies, all grants revoked).
type _ClubMembershipsStillTypeable = AssertTrue<
  AssertEqual<keyof Pick<Database["public"]["Tables"], "club_memberships">, "club_memberships">
>;

// send_announcement_v2.p_recipient_user_ids nullability correction (Phase
// 45C real-generation comparison) is retained.
type _SendAnnouncementNullableRecipients = AssertTrue<
  AssertEqual<
    Database["public"]["Functions"]["send_announcement_v2"]["Args"]["p_recipient_user_ids"],
    string[] | null
  >
>;

// get_communications_activity's Returns nullability corrections (batch_id,
// body) and CHECK-domain correction (audience_mode) are retained.
type _CommunicationsActivityReturnsCorrections = AssertTrue<
  AssertEqual<
    Pick<
      Database["public"]["Functions"]["get_communications_activity"]["Returns"][number],
      "batch_id" | "body" | "audience_mode"
    >,
    { batch_id: string | null; body: string | null; audience_mode: "all" | "specific" }
  >
>;

// p_content / p_body — Phase 45C1A superseded Phase 45C's "naming debt
// only" conclusion with authoritative live evidence: the repository's old
// p_content call site was reproduced FAILING against the live database
// ("Something went wrong"), and direct live introspection confirmed
// p_body/body/is_archived/archived_by as the sole authoritative contract.
// Migration 0211 (created, not yet applied) reconciles migration history;
// application call sites and types.ts's overrides were updated in the same
// checkpoint. add_member_note/update_member_note now correctly use p_body.
type _AddMemberNoteUsesPBody = AssertTrue<
  AssertEqual<keyof Database["public"]["Functions"]["add_member_note"]["Args"], "p_member_id" | "p_body">
>;
type _UpdateMemberNoteUsesPBody = AssertTrue<
  AssertEqual<keyof Database["public"]["Functions"]["update_member_note"]["Args"], "p_note_id" | "p_body">
>;
// add_member_note's Returns is narrowly refined (generated only reports the
// generic `Json` scalar, since a SQL `json` return type carries no
// structural information) — derived from GeneratedTables["member_notes"]
// ["Row"] via Pick in types.ts, matching migration 0211's json_build_object
// field list exactly (every member_notes column except club_id).
type _AddMemberNoteReturnsCanonicalNoteShape = AssertTrue<
  AssertEqual<
    keyof Database["public"]["Functions"]["add_member_note"]["Returns"],
    | "id"
    | "member_id"
    | "author_id"
    | "author_name_snapshot"
    | "body"
    | "is_archived"
    | "created_at"
    | "updated_at"
    | "archived_at"
    | "archived_by"
  >
>;
// member_notes' table Row is no longer overridden at all — it flows through
// from database.types.ts unmodified, and already correctly has `body`
// (never `content`).
type _MemberNotesRowHasBodyNotContent = AssertTrue<
  AssertEqual<"body", Extract<keyof Database["public"]["Tables"]["member_notes"]["Row"], "body">>
>;

// Migration-review correction 2 — get_member_notes' generated Returns
// incorrectly reports author_id/archived_at/archived_by as non-null
// `string` (a RETURNS-TABLE-nullability generator limitation); these are
// the same three member_notes columns that are genuinely nullable on the
// table itself. The narrow types.ts refinement must make all three accept
// `null`, while leaving every other returned field (id/member_id/
// author_name/author_name_snapshot/body/is_archived/created_at/
// updated_at) exactly as generated.
type _GetMemberNotesAuthorIdArchivedAtArchivedByAreNullable = AssertTrue<
  AssertEqual<
    Pick<Database["public"]["Functions"]["get_member_notes"]["Returns"][number], "author_id" | "archived_at" | "archived_by">,
    { author_id: string | null; archived_at: string | null; archived_by: string | null }
  >
>;
// author_name (a computed coalesce over a LEFT JOIN, not a member_notes
// column) is untouched by the refinement — still the generated `string`.
type _GetMemberNotesAuthorNameUntouched = AssertTrue<
  AssertEqual<Database["public"]["Functions"]["get_member_notes"]["Returns"][number]["author_name"], string>
>;

// Phase 45C1A3 — restore_member_note (migration 0212, now applied and
// regenerated) needed NO override: it's reachable through the composed
// Database type via plain flow-through from GeneratedFunctions, with
// exactly the same generated shape as archive_member_note (a `returns
// void` SQL function always generates `Returns: undefined`, never a
// hand-written `void`).
type _RestoreMemberNoteArgsHasNoteId = AssertTrue<
  AssertEqual<Database["public"]["Functions"]["restore_member_note"]["Args"], { p_note_id: string }>
>;
type _RestoreMemberNoteReturnsMatchesArchiveMemberNote = AssertTrue<
  AssertEqual<
    Database["public"]["Functions"]["restore_member_note"]["Returns"],
    Database["public"]["Functions"]["archive_member_note"]["Returns"]
  >
>;
/* eslint-enable @typescript-eslint/no-unused-vars */

// ─────────────────────────────────────────────────────────────────────────
// Runtime/source checks — for facts a TypeScript type can't express.
// ─────────────────────────────────────────────────────────────────────────

describe("database.types.ts is generated, committed, and never hand-edited", () => {
  it("exists as a committed file (not gitignored)", () => {
    expect(existsSync(join(process.cwd(), GENERATED_PATH))).toBe(true);
    // Check actual ignore PATTERNS only — the .gitignore's own explanatory
    // comment legitimately mentions this path in prose.
    const activePatterns = readSource(".gitignore")
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"));
    expect(activePatterns.some((pattern) => GENERATED_PATH.includes(pattern.trim()))).toBe(false);
  });

  it("looks like real supabase gen types output — has the shape only the CLI produces, not something hand-authored", () => {
    const s = readSource(GENERATED_PATH);
    expect(s).toContain("__InternalSupabase");
    expect(s).toContain('PostgrestVersion: "');
    expect(s).toContain("export const Constants = {");
  });

  it("confirms zero native Postgres enums exist — the reason every CHECK-constrained column generates as plain `string`, which is why types.ts's overrides exist at all", () => {
    const s = readSource(GENERATED_PATH);
    expect(s).toMatch(/Enums:\s*\{\s*\[_ in never\]:\s*never\s*\}/);
  });

  it("contains club_memberships, lesson_types, pro_availability_windows, pro_blackout_dates, and archive_event/unarchive_event — all previously absent from the hand-maintained file this replaced", () => {
    const s = readSource(GENERATED_PATH);
    for (const name of [
      "club_memberships",
      "lesson_types",
      "pro_availability_windows",
      "pro_blackout_dates",
    ]) {
      expect(s).toContain(`      ${name}: {`);
    }
    for (const name of ["archive_event", "unarchive_event"]) {
      expect(s).toContain(`      ${name}: {`);
    }
  });
});

describe("types.ts derives from the generated file rather than re-declaring the schema", () => {
  it("imports Database/Json from ./database.types, not a hand-written schema", () => {
    const s = readSource(DB_TYPES_PATH);
    expect(s).toContain('import type { Database as GeneratedDatabase, Json } from "./database.types";');
  });

  it("no longer contains the old misleading placeholder/manual-schema header language", () => {
    const s = readSource(DB_TYPES_PATH);
    expect(s).not.toMatch(/hand-mirrors the Phase 1 schema/);
    expect(s).not.toMatch(/^\/\/ Placeholder — regenerate after applying migrations:/m);
    expect(s).toMatch(/HAND-MAINTAINED domain\/compatibility layer/);
  });

  it("does not manually redeclare the full Tables/Functions maps — most of the 51 tables and 323 functions are never mentioned by name at all", () => {
    const s = readSource(DB_TYPES_PATH);
    const genS = readSource(GENERATED_PATH);
    const genTableNames = Array.from(genS.matchAll(/^      (\w+): \{$/gm)).map((m) => m[1]);
    const mentioned = genTableNames.filter((name) => s.includes(`"${name}"`) || new RegExp(`\\b${name}:`).test(s));
    // A thin layer overrides a bounded minority of objects, not most of them.
    expect(mentioned.length).toBeLessThan(genTableNames.length / 2);
  });

  it("assembles Database via Omit/intersection over the generated type, preserving __InternalSupabase, Views, Enums, CompositeTypes untouched", () => {
    const s = readSource(DB_TYPES_PATH);
    expect(s).toContain("export type Database = Omit<GeneratedDatabase,");
    expect(s).not.toContain("__InternalSupabase:");
    expect(s).not.toMatch(/\n\s*Enums:\s*\{/);
    expect(s).not.toMatch(/\n\s*CompositeTypes:\s*\{/);
  });
});

describe("NotificationKind has exactly one hand-written declaration", () => {
  it("is declared in notification-targets.ts, and only there — types.ts imports it rather than redeclaring it", () => {
    const targetsSrc = readSource("src/lib/notification-targets.ts");
    expect(targetsSrc).toContain("export type NotificationKind =");

    const typesSrc = readSource(DB_TYPES_PATH);
    expect(typesSrc).toContain('import type { NotificationKind } from "@/lib/notification-targets";');
    expect(typesSrc).not.toContain("export type NotificationKind");
    // The 22-value literal union itself (e.g. "reservation_player_activity")
    // must not be re-typed out in types.ts — only referenced by name.
    expect(typesSrc).not.toContain('"reservation_player_activity"');
  });

  it("no compile-time equality guard remains between two independent declarations — there is only one declaration left to compare", () => {
    const targetsSrc = readSource("src/lib/notification-targets.ts");
    expect(targetsSrc).not.toContain("AssertEqual");
  });

  it("notification-targets.ts no longer imports from the domain layer (breaks the circular import types.ts -> notification-targets.ts -> types.ts)", () => {
    const targetsSrc = readSource("src/lib/notification-targets.ts");
    expect(targetsSrc).not.toContain('from "@/lib/db/types"');
    expect(targetsSrc).toContain('from "@/lib/db/database.types"');
  });
});

describe("0210 remains immutable; migration history advanced by exactly two new files as of Phase 45C1A2 (0211, then 0212)", () => {
  // "0212 exists ... and is the highest migration — no 0213" was previously
  // asserted here as a hardcoded "highest migration === 212" ceiling.
  // Removed: that pattern is invalid for a historical checkpoint's
  // regression suite — it cannot prove no LATER, unrelated checkpoint will
  // ever add a migration (several have since: 0213-0216, added by Phase
  // 45D). Replaced with a durable existence check for the two files this
  // checkpoint actually owns; migration-specific claims for later
  // migrations belong in the test suite of the checkpoint that actually
  // owns them. See topLevelBackLinkCleanup.regression.test.ts's own note on
  // this same cleanup.
  it("0211 and 0212 both exist as real migration files on disk", () => {
    expect(() => readSource("supabase/migrations/0211_member_notes_schema_reconciliation.sql")).not.toThrow();
    expect(() => readSource("supabase/migrations/0212_restore_member_note.sql")).not.toThrow();
  });

  it("0210's own content is byte-for-byte unchanged", () => {
    // A content hash-free structural check: 0210 must still end with its own
    // documented closing banner, unmodified.
    const s = readSource("supabase/migrations/0210_phase44d_communications_history_security_closeout.sql");
    expect(s).toContain("End of 0210_phase44d_communications_history_security_closeout.sql");
  });
});
