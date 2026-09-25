"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  sendAnnouncementAction,
  getAnnouncementRecipientCandidatesAction,
  previewAnnouncementRecipientsAction,
  type AnnouncementRecipientCandidate,
} from "./communicationsActions";

const TITLE_MAX = 100;
const BODY_MAX  = 500;

type AudienceMode = "all" | "specific";

// Phase 44C: the ONE authoritative source for the "This will send to N
// people" line and for Send's enablement — never derived from
// selectedIds.size, which is local/informational only and can drift from
// what the server will actually accept (removed/deactivated/opted-out
// since the candidate list was fetched).
type PreviewState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "no_selection" }
  | { status: "success"; eligibleCount: number; eligibleUserIds: string[] };

// Admin IA Checkpoint 4 (B1) — read-only Timing/Delivery rows. Audience
// was originally a third read-only row here too ("a future audience
// selector — B2 — can replace the Audience row's value without
// redesigning this layout"); Phase 44C is that selector — Audience is now
// the interactive control directly above these two, which remain
// unchanged.
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">{label}</span>
      <span className="text-xs text-gray-700 dark:text-gray-300 text-right">{value}</span>
    </div>
  );
}

function audienceButtonClass(pressed: boolean): string {
  // Selected state is never color-only: pressed also gets a bolder font
  // weight and a leading checkmark glyph, on top of aria-pressed for
  // assistive tech and the border/background color change.
  return `px-3 py-1.5 rounded-full text-xs border transition-colors motion-safe:duration-150 ${
    pressed
      ? "border-accent bg-accent/10 text-accent font-semibold"
      : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 font-medium hover:border-accent/50"
  }`;
}

function candidateDisplayName(c: AnnouncementRecipientCandidate): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unnamed";
}

function matchesSearch(c: AnnouncementRecipientCandidate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const first = (c.firstName ?? "").toLowerCase();
  const last  = (c.lastName  ?? "").toLowerCase();
  const full  = `${c.firstName ?? ""} ${c.lastName ?? ""}`.toLowerCase();
  return first.includes(q) || last.includes(q) || full.includes(q);
}

export default function AnnouncementsSection() {
  const [isPending, startTransition] = useTransition();

  const [title, setTitle]           = useState("");
  const [body,  setBody]            = useState("");
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus]         = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // ─── Phase 44C — audience state ────────────────────────────────────────
  const [audienceMode, setAudienceMode] = useState<AudienceMode>("all");
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set());
  const [search, setSearch]             = useState("");

  const [candidates, setCandidates]               = useState<AnnouncementRecipientCandidate[] | null>(null);
  const [candidatesLoading, setCandidatesLoading]  = useState(false);
  const [candidatesError, setCandidatesError]      = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });

  // Preview race safety: a monotonically increasing request generation,
  // no AbortController/cleanup needed. Only the response matching the
  // CURRENT generation at the moment it resolves is ever applied — an
  // older, slower request that resolves after a newer one has already
  // started can never overwrite that newer state.
  const previewGenerationRef = useRef(0);

  // Fetch the candidate list once, the first time Specific People is
  // selected — cached for the rest of this composer session (including
  // across a successful send, per the locked design: only the audience
  // MODE/selection resets, not the fetched roster).
  useEffect(() => {
    if (audienceMode !== "specific" || candidates !== null || candidatesLoading || candidatesError) return;
    setCandidatesLoading(true);
    getAnnouncementRecipientCandidatesAction().then(res => {
      if (res.error) {
        setCandidatesError(res.error);
      } else {
        setCandidates(res.candidates ?? []);
      }
      setCandidatesLoading(false);
    });
  }, [audienceMode, candidates, candidatesLoading, candidatesError]);

  // Authoritative recipient preview. The generation increments FIRST,
  // before the zero-selection early return — otherwise an in-flight
  // request from a prior, non-empty selection could still resolve after
  // the Admin clears the last selection, pass a generation check taken
  // before this point, and overwrite the correct "no_selection" state with
  // a stale result.
  useEffect(() => {
    const generation = ++previewGenerationRef.current;

    if (audienceMode === "specific" && selectedIds.size === 0) {
      setPreview({ status: "no_selection" });
      return;
    }

    setPreview({ status: "loading" });

    const recipientIds = audienceMode === "specific" ? Array.from(selectedIds) : null;
    previewAnnouncementRecipientsAction(audienceMode, recipientIds).then(res => {
      if (previewGenerationRef.current !== generation) return; // superseded by a newer request
      if (res.error || !res.result) {
        setPreview({ status: "error" });
        return;
      }
      setPreview({
        status:          "success",
        eligibleCount:   res.result.eligibleCount,
        eligibleUserIds: res.result.eligibleUserIds,
      });
    });
    // selectedIds is only ever replaced (never mutated) by toggleCandidate
    // below, so this effect re-runs exactly when its content actually
    // changes, plus whenever audienceMode itself changes.
  }, [audienceMode, selectedIds]);

  function toggleCandidate(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus(null);
    setConfirming(true);
  }

  function handleConfirm() {
    setConfirming(false);
    const formData = new FormData();
    formData.set("title", title);
    formData.set("body",  body);
    formData.set("audienceMode", audienceMode);
    if (audienceMode === "specific") {
      for (const id of selectedIds) formData.append("recipientUserIds", id);
    }

    startTransition(async () => {
      const result = await sendAnnouncementAction(formData);
      if (result.error) {
        setStatus({ type: "error", message: result.error });
      } else {
        setStatus({ type: "success", message: result.message ?? "Announcement sent." });
        setTitle("");
        setBody("");
        // Phase 44C: never leave Specific People armed after a successful
        // send — reset the audience back to its default. The cached
        // candidate roster itself is left alone (still useful if the
        // Admin switches back to Specific for a later announcement).
        setAudienceMode("all");
        setSelectedIds(new Set());
        setSearch("");
        setTimeout(() => setStatus(null), 5000);
      }
    });
  }

  function handleCancel() {
    setConfirming(false);
  }

  const titleOver = title.length > TITLE_MAX;
  const bodyOver  = body.length  > BODY_MAX;

  const previewReady = preview.status === "success" && preview.eligibleCount > 0;
  const canSubmit =
    title.trim().length > 0 && body.trim().length > 0 && !titleOver && !bodyOver &&
    previewReady &&
    (audienceMode === "all" || selectedIds.size > 0);

  const filteredCandidates = (candidates ?? []).filter(c => matchesSearch(c, search));

  function previewText(): string {
    if (audienceMode === "all") {
      if (preview.status === "loading") return "Checking recipients…";
      if (preview.status === "error")   return "Recipient count unavailable. Try again.";
      if (preview.status === "success") {
        return preview.eligibleCount > 0
          ? `This will send to ${preview.eligibleCount} ${preview.eligibleCount === 1 ? "person" : "people"}.`
          : "No one can currently receive announcements.";
      }
      return "";
    }

    // specific
    if (preview.status === "no_selection") return "Select at least one person.";
    if (preview.status === "loading")      return "Checking recipients…";
    if (preview.status === "error")        return "Recipient count unavailable. Try again.";
    if (preview.status === "success") {
      const selectedCount = selectedIds.size;
      if (preview.eligibleCount === 0) return "None of the selected people can currently receive announcements.";
      if (preview.eligibleCount < selectedCount) {
        return `This will send to ${preview.eligibleCount} of ${selectedCount} selected people.`;
      }
      return `This will send to ${preview.eligibleCount} ${preview.eligibleCount === 1 ? "person" : "people"}.`;
    }
    return "";
  }

  function confirmCopy(): string {
    const countClause = preview.status === "success"
      ? ` Right now, that is ${preview.eligibleCount} ${preview.eligibleCount === 1 ? "person" : "people"}.`
      : "";
    const audienceClause = audienceMode === "all"
      ? "This will reach active club users — Members, Staff, Pros, and other Admins — who have announcement notifications enabled, excluding you."
      : `This will send to currently eligible people among your ${selectedIds.size} selected ${selectedIds.size === 1 ? "person" : "people"}.`;
    return `${audienceClause}${countClause} Eligibility is re-checked at the moment you send, and recipients with announcement emails also enabled will additionally receive an email. This cannot be undone.`;
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1 divide-y divide-gray-100 dark:divide-gray-800">
        <div className="py-1.5 space-y-1.5">
          <span id="announcement-audience-label" className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Audience
          </span>
          <div role="group" aria-label="Audience" className="flex gap-2">
            <button
              type="button"
              aria-pressed={audienceMode === "all"}
              disabled={isPending}
              onClick={() => setAudienceMode("all")}
              className={audienceButtonClass(audienceMode === "all") + " disabled:opacity-40"}
            >
              {audienceMode === "all" ? "✓ " : ""}All active club users
            </button>
            <button
              type="button"
              aria-pressed={audienceMode === "specific"}
              disabled={isPending}
              onClick={() => setAudienceMode("specific")}
              className={audienceButtonClass(audienceMode === "specific") + " disabled:opacity-40"}
            >
              {audienceMode === "specific" ? "✓ " : ""}Specific people
            </button>
          </div>
          <p className={`text-xs ${preview.status === "error" ? "text-red-500" : "text-gray-500 dark:text-gray-400"}`}>
            {previewText()}
          </p>
        </div>
        <InfoRow label="Timing" value="Send now" />
        <InfoRow label="Delivery" value="In-app + email when available" />
      </div>

      {audienceMode === "specific" && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search people…"
            disabled={isPending}
            aria-label="Search people"
            className="ct-input disabled:opacity-40"
          />

          {candidatesLoading && (
            <p className="text-xs text-gray-400 dark:text-gray-500 py-2 text-center">Loading people…</p>
          )}
          {candidatesError && (
            <p className="text-xs text-red-500">{candidatesError}</p>
          )}

          {!candidatesLoading && !candidatesError && (
            <>
              <div className="max-h-64 overflow-y-auto space-y-0.5">
                {filteredCandidates.length === 0 ? (
                  <p className="text-xs text-gray-400 dark:text-gray-500 py-2 text-center">No matching people.</p>
                ) : (
                  filteredCandidates.map(c => {
                    const optedOut     = !c.announcementEnabled;
                    const rowDisabled  = optedOut || isPending;
                    const name         = candidateDisplayName(c);
                    return (
                      <label
                        key={c.id}
                        className={`flex items-center gap-2.5 px-2 py-1.5 rounded-lg ${
                          optedOut ? "opacity-60" : ""
                        } ${rowDisabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40"}`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(c.id)}
                          disabled={rowDisabled}
                          onChange={() => toggleCandidate(c.id)}
                          className="h-4 w-4 rounded border-gray-300 accent-accent shrink-0"
                        />
                        <span className="text-sm text-gray-900 dark:text-gray-100 truncate">{name}</span>
                        <span className="text-xs text-gray-400 dark:text-gray-500 capitalize shrink-0">{c.role}</span>
                        {optedOut && (
                          <span className="ml-auto shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400">
                            Announcements off
                          </span>
                        )}
                      </label>
                    );
                  })
                )}
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                {selectedIds.size} selected
              </p>
            </>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Subject */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
              Subject
            </label>
            <span className={`text-xs ${titleOver ? "text-red-500" : "text-gray-400 dark:text-gray-500"}`}>
              {title.length}/{TITLE_MAX}
            </span>
          </div>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Court closure this Saturday"
            maxLength={TITLE_MAX + 10}
            required
            disabled={isPending}
            className="ct-input disabled:opacity-40"
          />
        </div>

        {/* Message */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
              Message
            </label>
            <span className={`text-xs ${bodyOver ? "text-red-500" : "text-gray-400 dark:text-gray-500"}`}>
              {body.length}/{BODY_MAX}
            </span>
          </div>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Write your message to members here…"
            rows={4}
            maxLength={BODY_MAX + 10}
            required
            disabled={isPending}
            className="ct-input resize-none disabled:opacity-40"
          />
        </div>

        {/* Confirm step */}
        {confirming ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2.5 space-y-2">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
              Send this announcement?
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {confirmCopy()}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleConfirm}
                disabled={isPending || !canSubmit}
                className="ct-button-primary px-3 py-1.5 text-xs"
              >
                {isPending ? "Sending…" : "Yes, send it"}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={isPending}
                className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-medium text-gray-600 dark:text-gray-300 disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={isPending || !canSubmit}
              className="ct-button-primary"
            >
              {isPending ? "Sending…" : "Send Announcement"}
            </button>
            {status && (
              <p className={`text-xs font-medium ${
                status.type === "success" ? "text-green-600" : "text-red-500"
              }`}>
                {status.message}
              </p>
            )}
          </div>
        )}
      </form>

      {/* Show status below confirm step too */}
      {confirming && status && (
        <p className={`text-xs font-medium ${
          status.type === "success" ? "text-green-600" : "text-red-500"
        }`}>
          {status.message}
        </p>
      )}
    </div>
  );
}
