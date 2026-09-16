"use client";

// Phase 43A-2 — Admin authoring UI for the club's one Member waiver
// (0192/0193 RPCs). Draft/published-only, exactly one waiver document per
// club, exactly one draft at a time — all enforced server-side; this
// component only ever calls create/update/publish/set-required, never
// re-derives those rules. Publishing (first-ever or a new version) always
// requires an explicit inline confirmation before the RPC is called — a
// published version is immutable, so the confirmation step is the last
// chance to catch a mistake. Body content renders as plain text
// (whitespace-pre-wrap on a <p>, never dangerouslySetInnerHTML) — matches
// ClubRulesSection/help's own established pattern for club-authored text.

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  createMemberWaiverDraftAction,
  updateMemberWaiverDraftAction,
  publishMemberWaiverVersionAction,
  setMemberWaiverRequiredAction,
} from "./actions";
import {
  ACTION_BUTTON_PRIMARY,
  ACTION_BUTTON_SECONDARY,
  ACTION_BUTTON_SECONDARY_COMPACT,
  ACTION_BUTTON_DESTRUCTIVE_COMPACT,
} from "@/components/styles/actionButtonStyles";

const TITLE_MAX = 300;
const BODY_MAX = 20000;

export interface CurrentWaiverVersion {
  id:            string;
  versionNumber: number;
  title:         string;
  body:          string;
  publishedAt:   string;
}

export interface DraftWaiverVersion {
  id:            string;
  versionNumber: number;
  title:         string;
  body:          string;
}

interface Props {
  waiverId:       string | null;
  isRequired:     boolean;
  currentVersion: CurrentWaiverVersion | null;
  draftVersion:   DraftWaiverVersion | null;
}

type Status = { type: "success" | "error"; message: string };

// Which editable form, if any, is showing. "new-version" is a LOCAL-ONLY
// pre-fill (copied from currentVersion) — nothing exists server-side for
// it until Save Draft is actually clicked, at which point it becomes a
// real draft via createMemberWaiverDraftAction (not an update).
type EditorMode = "none" | "create" | "edit-draft" | "new-version";

export default function MemberWaiverSection({
  waiverId, isRequired, currentVersion, draftVersion,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status | null>(null);

  // Lazy initializers so the very first render (including SSR — effects
  // never run server-side) already shows a real draft's editor, rather
  // than flashing "none" until the resync effect below fires post-hydration.
  const [editorMode, setEditorMode] = useState<EditorMode>(() => (draftVersion ? "edit-draft" : "none"));
  const [title, setTitle] = useState(() => draftVersion?.title ?? "");
  const [body, setBody] = useState(() => draftVersion?.body ?? "");
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [requiredPending, setRequiredPending] = useState(false);

  // A real, server-saved draft is ALWAYS immediately editable — no explicit
  // "start editing" click required (states 2 and 4 both show the editor by
  // default). This also supersedes any local ephemeral "new-version"/
  // "create" pre-fill the instant createMemberWaiverDraftAction succeeds
  // and the page re-renders with a real draftVersion — same
  // resync-after-router.refresh() pattern MembershipTypesSection already
  // uses (an effect keyed on the prop object, which only changes on a
  // fresh server render, never while the Admin is actively typing).
  useEffect(() => {
    if (draftVersion) {
      setEditorMode("edit-draft");
      setTitle(draftVersion.title);
      setBody(draftVersion.body);
      setConfirmingPublish(false);
    } else {
      setEditorMode((mode) => (mode === "edit-draft" ? "none" : mode));
    }
  }, [draftVersion]);

  function showStatus(s: Status) {
    setStatus(s);
    if (s.type === "success") setTimeout(() => setStatus(null), 2500);
  }

  function startCreate() {
    setStatus(null);
    setTitle("");
    setBody("");
    setEditorMode("create");
  }

  function startNewVersion() {
    if (!currentVersion) return;
    setStatus(null);
    setTitle(currentVersion.title);
    setBody(currentVersion.body);
    setEditorMode("new-version");
  }

  function cancelEditor() {
    if (editorMode === "edit-draft" && draftVersion) {
      // A real, server-saved draft is always editable — "Cancel" here
      // discards unsaved local edits (reverts to the last saved draft
      // text) rather than hiding the editor, which must stay visible.
      setTitle(draftVersion.title);
      setBody(draftVersion.body);
    } else {
      setEditorMode("none");
    }
    setConfirmingPublish(false);
    setStatus(null);
  }

  function handleSaveDraft() {
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (!trimmedTitle || !trimmedBody) return;
    setStatus(null);
    startTransition(async () => {
      const result =
        editorMode === "edit-draft" && draftVersion
          ? await updateMemberWaiverDraftAction(draftVersion.id, trimmedTitle, trimmedBody)
          : await createMemberWaiverDraftAction(trimmedTitle, trimmedBody);
      if (result.error) {
        showStatus({ type: "error", message: result.error });
      } else {
        showStatus({ type: "success", message: "Draft saved." });
        router.refresh();
      }
    });
  }

  function handlePublish() {
    // Defense in depth: the Publish button is already disabled/hidden
    // whenever this would be true, but handlePublish must never publish
    // anything but the exact, already-saved draft wording, regardless of
    // how it's invoked.
    if (!draftVersion || isDraftDirty) return;
    setStatus(null);
    startTransition(async () => {
      const result = await publishMemberWaiverVersionAction(draftVersion.id);
      if (result.error) {
        showStatus({ type: "error", message: result.error });
      } else {
        setEditorMode("none");
        setConfirmingPublish(false);
        showStatus({ type: "success", message: "Waiver published." });
        router.refresh();
      }
    });
  }

  function handleRequiredToggle(next: boolean) {
    setStatus(null);
    setRequiredPending(true);
    startTransition(async () => {
      const result = await setMemberWaiverRequiredAction(next);
      setRequiredPending(false);
      if (result.error) {
        showStatus({ type: "error", message: result.error });
      } else {
        showStatus({
          type: "success",
          message: next ? "Waiver requirement enabled." : "Waiver requirement disabled.",
        });
        router.refresh();
      }
    });
  }

  const isEditingDraft = editorMode === "edit-draft" || editorMode === "new-version" || editorMode === "create";

  // A saved draft may only be published as EXACTLY what was saved — never
  // whatever happens to be sitting in the editor at the moment Publish is
  // clicked. If the editor differs from draftVersion.title/body, the Admin
  // has unsaved edits: Publish must be disabled until an explicit Save
  // Draft brings the saved draft back in sync with what's on screen.
  const isDraftDirty =
    editorMode === "edit-draft" &&
    draftVersion !== null &&
    (title !== draftVersion.title || body !== draftVersion.body);

  // If the Admin edits Title/Body while the publish confirmation is open,
  // the confirmation is no longer about the currently-visible wording —
  // close it immediately rather than leave a disabled Publish button
  // sitting inside an already-open confirmation panel.
  useEffect(() => {
    if (isDraftDirty && confirmingPublish) setConfirmingPublish(false);
  }, [isDraftDirty, confirmingPublish]);

  return (
    <div className="space-y-3">
      {status && (
        <div className={`px-3 py-2 rounded-lg text-xs font-medium ${
          status.type === "success"
            ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400"
        }`}>
          {status.message}
        </div>
      )}

      {/* ── 1. NO WAIVER YET ── */}
      {waiverId === null && editorMode === "none" && (
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 px-4 py-5 text-center space-y-3">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No Member waiver has been created yet. Draft one below — it won&apos;t be visible to
            Members until you publish it.
          </p>
          <button type="button" onClick={startCreate} className={ACTION_BUTTON_PRIMARY}>
            Create Member Waiver
          </button>
        </div>
      )}

      {/* ── CURRENT PUBLISHED VERSION (read-only) — states 3 and 4 ── */}
      {currentVersion && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800/60 flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Current Published Version
              </p>
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate mt-0.5">
                {currentVersion.title}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400">
                Version {currentVersion.versionNumber}
              </span>
            </div>
          </div>
          <div className="px-4 py-3 space-y-2">
            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              Published {new Date(currentVersion.publishedAt).toLocaleDateString()}
            </p>
            <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
              {currentVersion.body}
            </p>
          </div>
        </div>
      )}

      {/* ── Update Waiver (state 3 only: published, no draft) ── */}
      {currentVersion && !draftVersion && editorMode === "none" && (
        <button type="button" onClick={startNewVersion} className={ACTION_BUTTON_SECONDARY}>
          Update Waiver
        </button>
      )}

      {/* ── DRAFT editor — states 2, 3 (mid-new-version), and 4 ── */}
      {isEditingDraft && (
        <div className="rounded-xl border border-amber-300 dark:border-amber-800/60 overflow-hidden">
          <div className="px-4 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800/60">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
              Draft — not visible to Members
            </p>
          </div>
          <div className="px-4 py-3 space-y-3">
            {editorMode === "new-version" && currentVersion && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Creates a draft based on Version {currentVersion.versionNumber}. The currently published waiver stays unchanged until you publish the update.
              </p>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                Title
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={TITLE_MAX}
                placeholder="Member Waiver"
                className="ct-input"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                Waiver Text
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={BODY_MAX}
                rows={10}
                placeholder="Enter the full waiver text Members will review and accept…"
                className="ct-input resize-y"
              />
              <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500 text-right tabular-nums">
                {body.length}/{BODY_MAX}
              </p>
            </div>

            {confirmingPublish ? (
              /* ── Publish confirmation ── */
              <div className="space-y-2 rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-3">
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  {draftVersion?.versionNumber === 1
                    ? "Publishing will make this waiver current and Members will need to accept it."
                    : "Publishing will make this the current waiver version. Members who accepted the previous version will need to accept this one."}
                </p>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setConfirmingPublish(false)}
                    className={ACTION_BUTTON_SECONDARY_COMPACT}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handlePublish}
                    disabled={isPending}
                    className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
                  >
                    {isPending ? "Publishing…" : "Publish"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={handleSaveDraft}
                    disabled={isPending || !title.trim() || !body.trim()}
                    className={ACTION_BUTTON_PRIMARY}
                  >
                    {isPending ? "Saving…" : "Save Draft"}
                  </button>
                  {draftVersion && editorMode === "edit-draft" && (
                    <button
                      type="button"
                      onClick={() => setConfirmingPublish(true)}
                      disabled={isPending || isDraftDirty}
                      className={ACTION_BUTTON_SECONDARY}
                    >
                      Publish
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={cancelEditor}
                    className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400"
                  >
                    Cancel
                  </button>
                </div>
                {/* Published versions are immutable — Publish must only
                    ever act on the exact wording last saved, never on
                    whatever is currently sitting unsaved in the editor. */}
                {isDraftDirty && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Save your changes before publishing.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Requirement toggle — any waiver identity, real or ephemeral-pending ── */}
      {waiverId !== null && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Required for Members
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {isRequired
                ? "Members must accept the current version."
                : "Members are not currently required to accept this waiver. Nothing published or accepted is affected. Turning this back on makes the current waiver required again."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isRequired}
            onClick={() => handleRequiredToggle(!isRequired)}
            disabled={requiredPending}
            className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
              isRequired ? "bg-accent" : "bg-gray-300 dark:bg-gray-600"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                isRequired ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      )}
    </div>
  );
}
