"use client";

// Phase 34C — Program waitlist-offer parity with WaitlistOfferModal
// (Events). Concrete QA finding: Program offer promotion worked in the
// backend (accept_program_waitlist_offer / decline_program_waitlist_offer,
// unchanged), but no comparable app-wide popup ever surfaced it — a Member
// only saw it if they happened to open the Upcoming tab and scroll to the
// right ProgramEnrollmentCard. This mirrors WaitlistOfferModal's structure
// exactly: mounted once in the authenticated layout, dismiss-for-this-tab
// via sessionStorage (never mutates the offer), a static (non-ticking)
// expiry label matching the Event modal's own precedent, and the existing
// accept/decline actions — no new RPCs.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { acceptProgramOffer, declineProgramOffer } from "@/app/(app)/events/programEnrollmentActions";
import { mapProgramError } from "@/app/(app)/events/programErrors";

export interface ProgramOfferData {
  programId:      string;
  programTitle:   string;
  eventTypeLabel: string;
  eventTypeColor: string;
  startsOn:       string;
  endsOn:         string;
  offerExpiresAt: string;
  clubId:         string;
  clubTimezone:   string;
}

interface Props {
  offer: ProgramOfferData | null;
}

function dismissKey(offer: ProgramOfferData): string {
  // Keyed by program + this specific offer's expiry — a renewed/re-offered
  // spot (new offerExpiresAt) is a meaningfully different offer and should
  // be able to reopen even if the prior one was dismissed.
  return `ct_dismissed_program_offer:${offer.programId}:${offer.offerExpiresAt}`;
}

function formatDateOnly(dateISO: string): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC", month: "short", day: "numeric", year: "numeric",
  });
}

export default function ProgramOfferModal({ offer }: Props) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState(true); // default closed until the sessionStorage check below runs
  const [error, setError]         = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!offer) { setDismissed(true); return; }
    const already = typeof window !== "undefined" && sessionStorage.getItem(dismissKey(offer)) === "1";
    setDismissed(already);
    setError("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer?.programId, offer?.offerExpiresAt]);

  if (!offer || dismissed) return null;

  const expiresLabel = new Date(offer.offerExpiresAt).toLocaleString("en-US", {
    timeZone: offer.clubTimezone, month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });

  // Dismiss for this browser tab's session only — never mutates the offer.
  function handleDismiss() {
    if (offer) sessionStorage.setItem(dismissKey(offer), "1");
    setDismissed(true);
  }

  function handleAccept() {
    setError("");
    startTransition(async () => {
      const res = await acceptProgramOffer({ p_program_id: offer!.programId, expectedClubId: offer!.clubId });
      if (res.error) { setError(mapProgramError(res.error.code, res.error.message)); return; }
      router.refresh();
    });
  }

  function handleDecline() {
    setError("");
    startTransition(async () => {
      const res = await declineProgramOffer({ p_program_id: offer!.programId, expectedClubId: offer!.clubId });
      if (res.error) { setError(mapProgramError(res.error.code, res.error.message)); return; }
      router.refresh();
    });
  }

  return (
    <ResponsiveSheet
      onClose={handleDismiss}
      variant="modal"
      mobileInteraction="draggable"
      label="Program Spot Offered"
      header={
        <div className="relative flex items-center justify-center">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Program Spot Offered</h2>
          <button onClick={handleDismiss} className="absolute right-0 text-sm text-gray-400 md:hidden" aria-label="Close">✕</button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="ct-card px-4 py-3">
          <span
            className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white mb-2"
            style={{ background: offer.eventTypeColor }}
          >
            {offer.eventTypeLabel}
          </span>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{offer.programTitle}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {formatDateOnly(offer.startsOn)} – {formatDateOnly(offer.endsOn)}
          </p>
        </div>

        <p className="text-sm text-amber-600 dark:text-amber-400 font-medium">
          A spot has opened up — accept by {expiresLabel} or it will be offered to the next person on the waitlist.
        </p>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <button
          onClick={handleAccept}
          disabled={isPending}
          className="w-full bg-accent text-white dark:text-gray-900 rounded-xl py-3 text-sm font-semibold disabled:opacity-50 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150"
        >
          {isPending ? "Working…" : "Accept"}
        </button>
        <button
          onClick={handleDecline}
          disabled={isPending}
          className="w-full py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50"
        >
          Decline
        </button>
      </div>
    </ResponsiveSheet>
  );
}
