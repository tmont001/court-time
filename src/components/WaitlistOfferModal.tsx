"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { acceptWaitlistOffer, declineWaitlistOffer } from "@/app/(app)/calendar/actions";

export interface WaitlistOfferData {
  eventId:        string;
  eventTitle:     string;
  eventTypeLabel: string;
  eventTypeColor: string;
  startsAt:       string;
  endsAt:         string;
  offerExpiresAt: string;
  clubId:         string;
  clubTimezone:   string;
}

interface Props {
  offer: WaitlistOfferData | null;
}

function mapOfferError(message: string): string {
  const map: Record<string, string> = {
    not_authenticated: "Your session has expired. Please sign in again.",
    event_not_found:   "This event could not be found.",
    event_archived:    "This event is no longer available.",
    offer_not_found:   "This offer is no longer available.",
    offer_expired:     "This offer has expired.",
  };
  return map[message] ?? "Something went wrong. Please try again.";
}

function dismissKey(offer: WaitlistOfferData): string {
  // Keyed by event + this specific offer's expiry — a renewed/re-offered
  // spot (new offer_expires_at) is a meaningfully different offer and
  // should be able to reopen even if the prior one was dismissed.
  return `ct_dismissed_waitlist_offer:${offer.eventId}:${offer.offerExpiresAt}`;
}

// Phase 33G3: a prominent, app-wide dialog for an account-backed Member's
// active Event waitlist offer — mounted once in the authenticated layout
// (see src/app/(app)/layout.tsx) rather than only appearing as a list row
// on /my-schedule. Reuses the existing accept_waitlist_offer/decline_
// waitlist_offer RPCs (via calendar/actions.ts) — no new waitlist state
// machine. Dismissing (X, backdrop, Escape) never calls either RPC; only
// the explicit Decline button does.
export default function WaitlistOfferModal({ offer }: Props) {
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
  }, [offer?.eventId, offer?.offerExpiresAt]);

  if (!offer || dismissed) return null;

  const startLabel = new Date(offer.startsAt).toLocaleString("en-US", {
    timeZone: offer.clubTimezone, month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
  const endLabel = new Date(offer.endsAt).toLocaleTimeString("en-US", {
    timeZone: offer.clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });
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
      const res = await acceptWaitlistOffer(offer!.eventId, offer!.clubId);
      if (res.error) { setError(mapOfferError(res.error)); return; }
      router.refresh();
    });
  }

  function handleDecline() {
    setError("");
    startTransition(async () => {
      const res = await declineWaitlistOffer(offer!.eventId, offer!.clubId);
      if (res.error) { setError(mapOfferError(res.error)); return; }
      router.refresh();
    });
  }

  return (
    <ResponsiveSheet
      onClose={handleDismiss}
      variant="modal"
      mobileInteraction="draggable"
      label="Spot Offered"
      header={
        <div className="relative flex items-center justify-center">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Spot Offered</h2>
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
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{offer.eventTitle}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{startLabel} – {endLabel}</p>
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
