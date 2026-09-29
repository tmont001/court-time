import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 45C1A2 — Member Note Archive Lifecycle UX.
//
// Confirmed UX defect: after Archive, the client optimistically removed the
// note from local state (setNotes(prev => prev.filter(...))), but
// get_member_notes always returns every note including archived ones (0132's
// own documented intent — "for the client to decide how to render"). After a
// full refresh, the archived row reappeared rendered exactly like an active
// note, including Edit and Archive controls — clicking Archive again hit the
// backend's note_already_archived guard, producing a confusing error.
//
// Fix: ACTIVE/ARCHIVED are derived from is_archived on every render (not
// tracked as separate state), active notes render normally, archived notes
// render muted/collapsed-by-default with a clear "Archived" badge and Restore
// only (no Edit, no Archive), and Archive/Restore now update the note in
// place client-side instead of filtering it out — no refresh required, and
// no path to note_already_archived from the UI. Migration 0212 (created, NOT
// applied) adds the missing restore_member_note RPC, mirroring
// archive_member_note's own contract pattern exactly.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const ACTIONS_PATH    = "src/app/(app)/admin/members/[id]/actions.ts";
const CLIENT_PATH     = "src/app/(app)/admin/members/[id]/MemberDetailClient.tsx";
const TYPES_PATH      = "src/lib/db/types.ts";
const GENERATED_PATH  = "src/lib/db/database.types.ts";
const MIGRATION_0211_PATH = "supabase/migrations/0211_member_notes_schema_reconciliation.sql";
const MIGRATION_0212_PATH = "supabase/migrations/0212_restore_member_note.sql";

function readClient(): string {
  return readSource(CLIENT_PATH);
}
function readMigration0212(): string {
  return readSource(MIGRATION_0212_PATH);
}

// ─────────────────────────────────────────────────────────────────────────
// 1-3. Active/archived derive separately from is_archived; the active list
// never mixes in archived notes.
// ─────────────────────────────────────────────────────────────────────────

describe("active/archived notes derive from is_archived, not tracked as separate state", () => {
  it("activeNotes/archivedNotes are both derived via .filter(n => ...is_archived) on every render", () => {
    const s = readClient();
    expect(s).toContain("const activeNotes   = notes.filter(n => !n.is_archived);");
    expect(s).toContain("const archivedNotes = notes.filter(n => n.is_archived);");
  });

  it("the normal notes list renders activeNotes, never the raw notes array", () => {
    const s = readClient();
    expect(s).toContain("{activeNotes.map(note => (");
    // The raw `notes` array is still used (state itself, and the "any
    // notes at all" zero-state check) but never mapped over directly for
    // the rendered list.
    expect(s).not.toContain("{notes.map(note => (");
  });

  it("archived notes render from a visibly separate archivedNotes.map call", () => {
    const s = readClient();
    expect(s).toContain("{archivedNotes.map(note => (");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Notes tab count uses active notes only.
// ─────────────────────────────────────────────────────────────────────────

describe("Notes tab count reflects ACTIVE notes only", () => {
  it("the tab badge count reads activeNotes.length, not notes.length", () => {
    const s = readClient();
    const idx = s.indexOf('{t === "notes" &&');
    expect(idx).toBeGreaterThan(-1);
    const line = s.slice(idx, s.indexOf("\n", idx));
    expect(line).toContain("activeNotes.length");
    expect(line).not.toContain("notes.length");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4-5. Archived section is collapsed by default; Show archived (N) / Hide
// archived toggle exists.
// ─────────────────────────────────────────────────────────────────────────

describe("archived section is collapsed by default with a Show/Hide toggle", () => {
  it("showArchivedNotes defaults to false", () => {
    const s = readClient();
    expect(s).toContain("const [showArchivedNotes, setShowArchivedNotes]       = useState(false);");
  });

  it("the toggle button reads Show archived (N) / Hide archived and flips showArchivedNotes", () => {
    const s = readClient();
    expect(s).toContain("onClick={() => setShowArchivedNotes(prev => !prev)}");
    expect(s).toContain('{showArchivedNotes ? "Hide archived" : `Show archived (${archivedNotes.length})`}');
  });

  it("the archived note list is only rendered when showArchivedNotes is true", () => {
    const s = readClient();
    const toggleIdx = s.indexOf("onClick={() => setShowArchivedNotes(prev => !prev)}");
    const afterToggle = s.slice(toggleIdx, toggleIdx + 400);
    expect(afterToggle).toContain("{showArchivedNotes && (");
  });

  it("the toggle (and archived section) only appears at all when archivedNotes.length > 0", () => {
    const s = readClient();
    expect(s).toContain("{archivedNotes.length > 0 && (");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6-9. Archived note presentation: clear Archived state, no Edit, no
// Archive, has Restore.
// ─────────────────────────────────────────────────────────────────────────

describe("archived note cards: Archived badge, no Edit/Archive, Restore only", () => {
  function archivedBlock(): string {
    const s = readClient();
    const idx = s.indexOf("{archivedNotes.map(note => (");
    expect(idx).toBeGreaterThan(-1);
    const end = s.indexOf("{/* Archive-note confirmation", idx);
    expect(end).toBeGreaterThan(idx);
    return s.slice(idx, end);
  }

  it("displays a neutral 'Archived' badge", () => {
    const block = archivedBlock();
    expect(block).toContain(">\n                              Archived\n");
  });

  it("shows the archived date via fmtDate(note.archived_at, ...) when archived_at exists", () => {
    const block = archivedBlock();
    expect(block).toContain("{note.archived_at && (");
    expect(block).toContain("fmtDate(note.archived_at, clubTimezone)");
  });

  it("does NOT render an Edit control for an archived note", () => {
    const block = archivedBlock();
    expect(block).not.toContain("handleEditNote");
    expect(block).not.toMatch(/>\s*Edit\s*</);
  });

  it("does NOT render an Archive control for an archived note (no path to note_already_archived from the UI)", () => {
    const block = archivedBlock();
    expect(block).not.toContain("handleArchiveNote");
    expect(block).not.toContain("setArchiveConfirmNoteId");
    expect(block).not.toMatch(/>\s*Archive\s*</);
  });

  it("renders a Restore control wired to handleRestoreNote", () => {
    const block = archivedBlock();
    expect(block).toContain("onClick={() => handleRestoreNote(note.id)}");
    expect(block).toContain('"Restoring…" : "Restore"');
  });

  it("the archived card uses the established muted opacity-60 ct-card treatment (the same convention MembersClient.tsx uses for its own inactive-row muting)", () => {
    const block = archivedBlock();
    expect(block).toContain('className="ct-card px-4 py-3 opacity-60"');
  });

  it("Restore uses the neutral SECONDARY_COMPACT style, not destructive styling", () => {
    const block = archivedBlock();
    const restoreIdx = block.indexOf("onClick={() => handleRestoreNote(note.id)}");
    const restoreTagBlock = block.slice(restoreIdx, restoreIdx + 150);
    expect(restoreTagBlock).toContain("className={ACTION_BUTTON_SECONDARY_COMPACT}");
    expect(restoreTagBlock).not.toContain("DESTRUCTIVE");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Active notes continue to expose Edit + Archive.
// ─────────────────────────────────────────────────────────────────────────

describe("active note cards continue to expose Edit + Archive", () => {
  it("the active-notes block (activeNotes.map) contains both an Edit control and an Archive control", () => {
    const s = readClient();
    const idx = s.indexOf("{activeNotes.map(note => (");
    const end = s.indexOf("{/* Archived notes", idx);
    expect(idx).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(idx);
    const block = s.slice(idx, end);
    expect(block).toContain("onClick={() => handleEditNote(note)}");
    expect(block).toContain(">\n                              Edit\n");
    expect(block).toContain("onClick={() => setArchiveConfirmNoteId(note.id)}");
    expect(block).toContain(">\n                              Archive\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 11-12. Archive/Restore success update local state in place — no
// filtering/deleting on archive, and restore returns the note to active.
// ─────────────────────────────────────────────────────────────────────────

describe("Archive/Restore success paths mutate the note in place, never filter it out of local state", () => {
  it("handleArchiveNote sets is_archived: true (and archived_at) instead of filtering the note out", () => {
    const s = readClient();
    const idx = s.indexOf("function handleArchiveNote(noteId: string) {");
    const end = s.indexOf("\n  function handleRestoreNote", idx);
    expect(idx).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(idx);
    const block = s.slice(idx, end);
    expect(block).toContain("is_archived: true");
    expect(block).not.toContain("prev.filter(n => n.id !== noteId)");
  });

  it("handleRestoreNote clears is_archived/archived_at/archived_by back to active", () => {
    const s = readClient();
    const idx = s.indexOf("function handleRestoreNote(noteId: string) {");
    expect(idx).toBeGreaterThan(-1);
    const end = s.indexOf("\n  }\n", idx);
    const block = s.slice(idx, end);
    expect(block).toContain("restoreMemberNoteAction(noteId)");
    expect(block).toContain("is_archived: false, archived_at: null, archived_by: null");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 13. restoreMemberNoteAction uses restore_member_note.
// ─────────────────────────────────────────────────────────────────────────

describe("restoreMemberNoteAction calls the restore_member_note RPC", () => {
  it("actions.ts's restoreMemberNoteAction calls supabase.rpc(\"restore_member_note\", { p_note_id })", () => {
    const s = readSource(ACTIONS_PATH);
    const idx = s.indexOf("export async function restoreMemberNoteAction(");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 400);
    expect(block).toContain('supabase.rpc("restore_member_note"');
    expect(block).toContain("p_note_id: noteId,");
  });

  it("mapNoteError maps note_not_archived to a safe message", () => {
    const s = readSource(ACTIONS_PATH);
    const mapIdx = s.indexOf("function mapNoteError");
    const mapBlock = s.slice(mapIdx, s.indexOf("return map[msg]", mapIdx));
    expect(mapBlock).toContain("note_not_archived:");
  });

  it("Phase 45C1A3 — types.ts no longer hand-declares restore_member_note; it flows through from database.types.ts now that 0212 is applied and generated types were regenerated", () => {
    const s = readSource(TYPES_PATH);
    expect(s).not.toMatch(/restore_member_note:\s*\{/);
  });

  it("database.types.ts (generated, never hand-edited) structurally contains restore_member_note with the exact same shape as archive_member_note", () => {
    const s = readSource(GENERATED_PATH);
    expect(s).toContain("restore_member_note: { Args: { p_note_id: string }; Returns: undefined }");
    // Same generator, same `returns void` SQL shape -> identical generated
    // TypeScript shape, confirming this isn't a hand-tuned coincidence.
    expect(s).toContain("archive_member_note: { Args: { p_note_id: string }; Returns: undefined }");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 14-16. Migration 0212 — admin-only/same-club scoped, clears only archive
// lifecycle fields, writes an audit_log row.
// ─────────────────────────────────────────────────────────────────────────

describe("0212 — restore_member_note authorization mirrors archive_member_note exactly", () => {
  it("requires an authenticated actor profile", () => {
    const s = readMigration0212();
    expect(s).toContain("select pr.* into v_actor from public.profiles pr where pr.id = auth.uid();");
    expect(s).toContain("if not found then raise exception 'not_authenticated'; end if;");
  });

  it("requires the admin role", () => {
    const s = readMigration0212();
    expect(s).toContain("if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;");
  });

  it("scopes the note lookup to the actor's own club", () => {
    const s = readMigration0212();
    expect(s).toContain("and mn.club_id = v_actor.club_id;");
  });

  it("raises note_not_found when the note doesn't exist (or isn't in the actor's club)", () => {
    const s = readMigration0212();
    expect(s).toContain("if not found then raise exception 'note_not_found'; end if;");
  });

  it("raises note_not_archived when the note is not currently archived (the inverted lifecycle guard vs. archive_member_note's note_already_archived)", () => {
    const s = readMigration0212();
    expect(s).toContain("if not v_note.is_archived then raise exception 'note_not_archived'; end if;");
  });
});

describe("0212 — restore clears ONLY the archive lifecycle fields", () => {
  it("the UPDATE statement sets exactly is_archived/archived_at/archived_by/updated_at", () => {
    const s = readMigration0212();
    const idx = s.indexOf("update public.member_notes");
    const end = s.indexOf("where id = p_note_id;", idx);
    expect(idx).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(idx);
    const block = s.slice(idx, end);
    expect(block).toContain("is_archived = false");
    expect(block).toContain("archived_at = null");
    expect(block).toContain("archived_by = null");
    expect(block).toContain("updated_at  = now()");
    // Never touches body, author identity, or the FK/creation columns.
    for (const untouched of ["body =", "author_id =", "author_name_snapshot =", "created_at =", "member_id =", "club_id ="]) {
      expect(block).not.toContain(untouched);
    }
  });
});

describe("0212 — restore writes an audit_log row", () => {
  it("inserts into audit_log with action=restore_member_note, target_type=member_note, target_id=p_note_id, metadata member_id", () => {
    const s = readMigration0212();
    const idx = s.indexOf("insert into public.audit_log");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf(");", idx) + 1);
    expect(block).toContain("'restore_member_note'");
    expect(block).toContain("'member_note'");
    expect(block).toContain("p_note_id,");
    expect(block).toContain("jsonb_build_object('member_id', v_note.member_id)");
  });
});

describe("0212 — security contract matches archive_member_note (SECURITY DEFINER, search_path, owner, ACL)", () => {
  it("SECURITY DEFINER and explicit search_path", () => {
    const s = readMigration0212();
    expect(s).toContain("security definer");
    expect(s).toContain("set search_path = public, pg_temp");
  });

  it("no STABLE/IMMUTABLE marker — VOLATILE by default, matching archive_member_note", () => {
    const s = readMigration0212();
    expect(s.toLowerCase()).not.toContain("stable");
    expect(s.toLowerCase()).not.toContain("immutable");
  });

  it("owner explicitly restated to postgres", () => {
    const s = readMigration0212();
    expect(s).toContain("alter function public.restore_member_note(uuid) owner to postgres;");
  });

  it("EXECUTE revoked from public and anon, granted only to authenticated and service_role", () => {
    const s = readMigration0212();
    expect(s).toContain("revoke execute on function public.restore_member_note(uuid) from public, anon;");
    expect(s).toContain("grant  execute on function public.restore_member_note(uuid) to authenticated;");
    expect(s).toContain("grant  execute on function public.restore_member_note(uuid) to service_role;");
  });

  it("reloads the PostgREST schema cache, matching 0211's established directive for a new/changed RPC", () => {
    const s = readMigration0212();
    expect(s).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it("wrapped in begin;/commit; matching repo convention", () => {
    const s = readMigration0212();
    expect(s.trimStart().startsWith("-- 0212_restore_member_note.sql")).toBe(true);
    expect(s).toContain("\nbegin;\n");
    expect(s.trim().endsWith("commit;")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 17. No hard-delete action exists anywhere in this checkpoint's changes.
// ─────────────────────────────────────────────────────────────────────────

describe("no hard-delete action was added — Archive/Restore is the entire lifecycle", () => {
  it("actions.ts contains no delete_member_note RPC call or any DELETE-shaped member-note action", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).not.toContain("delete_member_note");
    expect(s).not.toMatch(/deleteMemberNoteAction/);
  });

  it("MemberDetailClient.tsx exposes no Delete control for notes", () => {
    const s = readClient();
    expect(s).not.toMatch(/>\s*Delete\s*</);
    expect(s).not.toContain("handleDeleteNote");
  });

  it("migration 0212 contains no DELETE FROM member_notes and no DROP of the table/row", () => {
    const s = readMigration0212();
    expect(s.toLowerCase()).not.toContain("delete from");
    expect(s.toLowerCase()).not.toContain("drop table");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 18. 0211 is untouched by this checkpoint.
// ─────────────────────────────────────────────────────────────────────────

describe("0211 is untouched by this checkpoint — every prior correction round's content is still present exactly as left", () => {
  it("still opens with its own header and the same background/scope framing", () => {
    const s = readSource(MIGRATION_0211_PATH);
    expect(s).toContain("-- 0211_member_notes_schema_reconciliation.sql");
    expect(s).toContain("Phase 45C1A — reconciles this repository's migration history");
  });

  it("still contains the member_id FK convergence section (migration-review correction 1)", () => {
    const s = readSource(MIGRATION_0211_PATH);
    expect(s).toContain("-- 1a. member_notes — member_id FK convergence (ON DELETE CASCADE)");
    expect(s).toContain("con.conkey = array[v_member_id_attnum]");
  });

  it("still contains the corrected \\mlength fingerprint (final SQL regex correction), never the incorrect \\blength", () => {
    const s = readSource(MIGRATION_0211_PATH);
    expect(s).toContain("\\mlength\\s*\\(");
    expect(s).not.toContain("\\blength");
  });

  it("still contains the explicit public, anon ACL and owner restatements for all three write RPCs (migration-review corrections 3-4)", () => {
    const s = readSource(MIGRATION_0211_PATH);
    for (const fn of ["add_member_note(uuid, text)", "update_member_note(uuid, text)", "archive_member_note(uuid)"]) {
      expect(s).toContain(`revoke execute on function public.${fn} from public, anon;`);
      expect(s).toContain(`alter function public.${fn} owner to postgres;`);
    }
  });

  it("still ends with NOTIFY pgrst reload schema; then commit;", () => {
    const s = readSource(MIGRATION_0211_PATH);
    expect(s.trim().endsWith("commit;")).toBe(true);
    expect(s).toContain("NOTIFY pgrst, 'reload schema';\n\ncommit;");
  });
});
