"use client";

// Phase 43B-3E — relocated from src/app/(app)/admin/settings/ into the
// new Admin Members hub's Waivers tab (/admin/members/waivers). Pure
// route relocation: no business logic changed. setMemberWaiverRequiredAction
// still lives in admin/settings/actions.ts, waiverPdfActions.ts still
// lives in admin/settings/waiverPdfActions.ts (both imported by absolute
// path below rather than moved — see this checkpoint's own report for
// why Server Actions were deliberately left in place).
//
// Phase 43B-3B — Admin authoring UI for the club's one Member waiver,
// rewritten for the PDF-only product pivot. Court Time is NOT a waiver-
// authoring product: new revisions are PDF uploads only, normal UI never
// shows "Version N", and internal version_number/status stay purely
// evidence/history (still driven entirely by publish_waiver_pdf_version /
// discard_waiver_draft, 0196, applied/immutable — this component never
// re-derives any of that business logic).
//
// A pre-existing, unpublished TEXT draft (from the retired 43A-2 editor)
// may still exist for a club that hasn't touched this page since the
// pivot — it is NEVER silently discarded. This component surfaces it and
// requires an explicit, confirmed Admin action (discardWaiverDraftAction)
// before a PDF can be uploaded.
//
// Actual upload sequencing (authorize -> direct browser upload -> finalize)
// lives in the shared useWaiverPdfUpload hook — see that file's header for
// why this one piece is shared while everything else here (JSX, copy,
// props) remains fully independent of GuestWaiverSection, per the existing
// full-duplication precedent for this pair of components.

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setMemberWaiverRequiredAction } from "@/app/(app)/admin/settings/actions";
import { discardWaiverDraftAction, getAdminWaiverPdfViewUrlAction } from "@/app/(app)/admin/settings/waiverPdfActions";
import { useWaiverPdfUpload } from "./useWaiverPdfUpload";
import {
  ACTION_BUTTON_PRIMARY,
  ACTION_BUTTON_SECONDARY,
  ACTION_BUTTON_SECONDARY_COMPACT,
  ACTION_BUTTON_DESTRUCTIVE_COMPACT,
} from "@/components/styles/actionButtonStyles";

export interface CurrentWaiverDocument {
  versionId:        string;
  publishedAt:       string;
  isPdfBacked:        boolean;
  originalFilename:   string | null; // present only when isPdfBacked
  legacyTitle:        string | null; // present only when !isPdfBacked
  legacyBody:         string | null; // present only when !isPdfBacked
}

export interface LegacyDraftVersion {
  id:    string;
  title: string;
  body:  string;
}

interface Props {
  waiverId:       string | null;
  isRequired:     boolean;
  currentDocument: CurrentWaiverDocument | null;
  legacyDraft:     LegacyDraftVersion | null;
}

type Status = { type: "success" | "error"; message: string };

export default function MemberWaiverSection({
  waiverId, isRequired, currentDocument, legacyDraft,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status | null>(null);
  const [requiredPending, setRequiredPending] = useState(false);

  const [mode, setMode] = useState<"none" | "uploading" | "replacing">("none");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [showingLegacyText, setShowingLegacyText] = useState(false);
  const [viewPending, setViewPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const upload = useWaiverPdfUpload("member", () => {
    setMode("none");
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setStatus({ type: "success", message: "Member waiver published." });
    router.refresh();
  });

  function showStatus(s: Status) {
    setStatus(s);
    if (s.type === "success") setTimeout(() => setStatus(null), 2500);
  }

  function startUpload() {
    setStatus(null);
    setSelectedFile(null);
    setMode("uploading");
  }

  function startReplace() {
    setStatus(null);
    setSelectedFile(null);
    setMode("replacing");
  }

  function cancelUploadPanel() {
    setMode("none");
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    upload.reset();
  }

  function handleFileChosen(file: File | null) {
    setSelectedFile(file);
  }

  function handleConfirmUpload() {
    if (!selectedFile) return;
    upload.upload(selectedFile);
  }

  function handleDiscardDraft() {
    if (!legacyDraft) return;
    startTransition(async () => {
      const result = await discardWaiverDraftAction(legacyDraft.id);
      setConfirmingDiscard(false);
      if (result.error) {
        showStatus({ type: "error", message: result.error });
      } else {
        showStatus({ type: "success", message: "Old draft discarded." });
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

  async function handleViewPdf() {
    setStatus(null);
    setViewPending(true);
    const result = await getAdminWaiverPdfViewUrlAction("member");
    setViewPending(false);
    if (result.error || !result.url) {
      showStatus({ type: "error", message: "Could not open the PDF. Please try again." });
      return;
    }
    window.open(result.url, "_blank", "noopener,noreferrer");
  }

  const canUploadNow = legacyDraft === null;

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

      {/* ── Legacy unpublished text draft — must be explicitly discarded before any PDF upload ── */}
      {legacyDraft && (
        <div className="rounded-xl border border-amber-300 dark:border-amber-800/60 px-4 py-3 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            Old text draft found
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            &quot;{legacyDraft.title}&quot; is an unpublished draft from before PDF waivers. It must be
            discarded before you can upload a PDF.
          </p>
          {confirmingDiscard ? (
            <div className="space-y-2 rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-3">
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                This permanently deletes the unpublished draft text. This cannot be undone.
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setConfirmingDiscard(false)}
                  className={ACTION_BUTTON_SECONDARY_COMPACT}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDiscardDraft}
                  disabled={isPending}
                  className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
                >
                  {isPending ? "Discarding…" : "Discard Draft"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDiscard(true)}
              className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
            >
              Discard Old Draft
            </button>
          )}
        </div>
      )}

      {/* ── No current waiver yet ── */}
      {!currentDocument && mode === "none" && (
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 px-4 py-5 text-center space-y-3">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No Member waiver has been added yet.
          </p>
          {canUploadNow && (
            <button type="button" onClick={startUpload} className={ACTION_BUTTON_PRIMARY}>
              Upload Waiver
            </button>
          )}
        </div>
      )}

      {/* ── Current PDF-backed waiver ── */}
      {currentDocument && currentDocument.isPdfBacked && mode === "none" && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Member Waiver
          </p>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {currentDocument.originalFilename ?? "waiver.pdf"}
          </p>
          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            Last updated {new Date(currentDocument.publishedAt).toLocaleDateString()}
          </p>
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <button
              type="button"
              onClick={handleViewPdf}
              disabled={viewPending}
              className={ACTION_BUTTON_SECONDARY_COMPACT}
            >
              {viewPending ? "Opening…" : "View PDF"}
            </button>
            {canUploadNow && (
              <button type="button" onClick={startReplace} className={ACTION_BUTTON_SECONDARY_COMPACT}>
                Replace Waiver
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Current legacy TEXT-backed waiver — no text re-authoring, only View/Replace-with-PDF ── */}
      {currentDocument && !currentDocument.isPdfBacked && mode === "none" && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Current waiver
          </p>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Legacy text waiver
          </p>
          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            Last updated {new Date(currentDocument.publishedAt).toLocaleDateString()}
          </p>
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <button
              type="button"
              onClick={() => setShowingLegacyText((v) => !v)}
              className={ACTION_BUTTON_SECONDARY_COMPACT}
            >
              {showingLegacyText ? "Hide Waiver" : "View Waiver"}
            </button>
            {canUploadNow && (
              <button type="button" onClick={startReplace} className={ACTION_BUTTON_SECONDARY_COMPACT}>
                Replace with PDF
              </button>
            )}
          </div>
          {showingLegacyText && (
            <div className="mt-2 rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-3 max-h-64 overflow-y-auto">
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                {currentDocument.legacyTitle}
              </p>
              <p className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap">
                {currentDocument.legacyBody}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Upload / Replace panel ── */}
      {(mode === "uploading" || mode === "replacing") && (
        <div className="rounded-xl border border-accent/40 overflow-hidden">
          <div className="px-4 py-3 space-y-3">
            {mode === "replacing" && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Replacing the current waiver will require Members to agree to the new waiver.
                The current document stays in effect until this upload finishes successfully.
              </p>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              onChange={(e) => handleFileChosen(e.target.files?.[0] ?? null)}
              className="block w-full text-xs text-gray-500 dark:text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-accent file:text-white dark:file:text-gray-900"
            />
            {selectedFile && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {selectedFile.name} · {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
              </p>
            )}
            {upload.error && (
              <p className="text-xs text-red-600 dark:text-red-400">{upload.error}</p>
            )}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleConfirmUpload}
                disabled={!selectedFile || upload.state === "authorizing" || upload.state === "uploading" || upload.state === "finalizing"}
                className={ACTION_BUTTON_PRIMARY}
              >
                {upload.state === "authorizing" ? "Preparing…"
                  : upload.state === "uploading" ? "Uploading…"
                  : upload.state === "finalizing" ? "Finalizing…"
                  : mode === "replacing" ? "Upload & Replace" : "Upload"}
              </button>
              <button
                type="button"
                onClick={cancelUploadPanel}
                className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Requirement toggle ── */}
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
