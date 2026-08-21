"use client";

// ProgramEnrollmentCard — Phase 27D2 member-facing whole-program enrollment
// card, rendered inside the Upcoming tab's Programs section
// (EventsUpcomingClient). One card per program (not per generated
// session) — enrollment is at the program level, so the action state
// matrix here operates on the caller's single program_enrollments row,
// never on any individual generated event.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  joinProgram,
  leaveProgram,
  acceptProgramOffer,
  declineProgramOffer,
  type MemberProgramCard,
  type EnrollmentResult,
} from "./programEnrollmentActions";
import { mapProgramError } from "./programErrors";
import { ACTION_BUTTON_PRIMARY, ACTION_BUTTON_DESTRUCTIVE } from "./actionButtonStyles";
import PriceSummary from "@/components/PriceSummary";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatTimeOfDay(time: string): string {
  const [hStr, mStr] = time.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const h12 = h % 12 || 12;
  const ampm = h < 12 ? "AM" : "PM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatDateOnly(dateISO: string): string {
  // starts_on/ends_on are plain dates (YYYY-MM-DD) — format without any
  // timezone conversion, since there is no time-of-day component to shift.
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC", month: "short", day: "numeric", year: "numeric",
  });
}

function formatOfferTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function scheduleSummary(rules: MemberProgramCard["rules"]): string {
  if (rules.length === 0) return "Schedule to be announced";
  return rules.map(r => `${DAY_NAMES[r.day_of_week]} ${formatTimeOfDay(r.start_time)}`).join(", ");
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  program:      MemberProgramCard;
  clubId:       string;
  clubTimezone: string;
  currency:     string;
  /** Phase 33F3B: false at a Staff-Managed club — hides Join Program and
   * Rejoin Waitlist (new/re-entry). Leave, Leave Waitlist, Pass, and
   * Accept Spot (existing-commitment continuity) are unaffected. A
   * program can still appear here for a Staff-Managed Member with a
   * cancelled enrollment history (my_enrollment maps that to status===null,
   * same as never-enrolled) — this flag is what stops that state from
   * offering a new Join button. */
  memberSelfService: boolean;
}

type PendingKind = "join" | "leave" | "accept" | "decline" | "rejoin" | null;

const PENDING_LABEL: Record<Exclude<PendingKind, null>, string> = {
  join:    "Joining…",
  leave:   "Leaving…",
  accept:  "Accepting…",
  decline: "Passing…",
  rejoin:  "Rejoining…",
};

export default function ProgramEnrollmentCard({ program, clubId, clubTimezone, currency, memberSelfService }: Props) {
  const router = useRouter();
  // Single-transition protection, unchanged: one useTransition guards every
  // action on this card, so only one can ever be in flight at a time.
  // pendingKind additionally records *which* action that in-flight
  // transition is, purely to pick the right pending label below — it does
  // not add a second concurrency guard.
  const [isPending, startTransition] = useTransition();
  const [pendingKind, setPendingKind] = useState<PendingKind>(null);
  const [error, setError] = useState<string | null>(null);

  const enrollment = program.my_enrollment;
  const status     = enrollment?.status ?? null;

  const offerExpiresAt = status === "offered" ? enrollment!.offer_expires_at : null;
  // Point-in-time check at render/interaction time — matches the existing
  // per-event offer-expiry pattern in EventsUpcomingClient (no live-ticking
  // countdown exists anywhere in this codebase to be consistent with).
  const offerExpired = offerExpiresAt ? new Date(offerExpiresAt) <= new Date() : false;

  function run(
    kind: Exclude<PendingKind, null>,
    action: () => Promise<{ data?: EnrollmentResult; error?: { code?: string; message: string } }>,
  ) {
    setError(null);
    setPendingKind(kind);
    startTransition(async () => {
      const result = await action();
      setPendingKind(null);
      if (result.error) {
        setError(mapProgramError(result.error.code, result.error.message));
        return;
      }
      // Refreshes this Server Component tree so both this card's own
      // my_enrollment and any generated event cards' materialized
      // event_participants rows reflect the write that just committed.
      router.refresh();
    });
  }

  const handleJoin    = () => run("join",    () => joinProgram({ p_program_id: program.id, expectedClubId: clubId }));
  const handleLeave   = () => run("leave",   () => leaveProgram({ p_program_id: program.id, expectedClubId: clubId }));
  const handleAccept  = () => run("accept",  () => acceptProgramOffer({ p_program_id: program.id, expectedClubId: clubId }));
  const handleDecline = () => run("decline", () => declineProgramOffer({ p_program_id: program.id, expectedClubId: clubId }));
  // Rejoin calls the same join_program RPC as handleJoin, but is a
  // distinct button in a distinct state (offered-and-expired) with its own
  // pending label — kept separate rather than parameterizing handleJoin so
  // the kind passed to run() always matches the label the user clicked.
  const handleRejoin  = () => run("rejoin",  () => joinProgram({ p_program_id: program.id, expectedClubId: clubId }));

  return (
    <div className="ct-card px-4 py-3">
      {/* Type pill + enrollment status badge */}
      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
        {program.event_type && (
          <span
            className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
            style={{ background: program.event_type.color }}
          >
            {program.event_type.label}
          </span>
        )}
        {status === "enrolled" && (
          <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
            Enrolled
          </span>
        )}
        {status === "waitlisted" && (
          <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
            Waitlisted
          </span>
        )}
        {status === "offered" && !offerExpired && (
          <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
            Spot Available
          </span>
        )}
        {status === "offered" && offerExpired && (
          <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
            Offer Expired
          </span>
        )}
      </div>

      {/* Title + description */}
      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{program.title}</p>
      {program.description && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{program.description}</p>
      )}

      {/* Program window + weekly schedule */}
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        {formatDateOnly(program.starts_on)} – {formatDateOnly(program.ends_on)}
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        {scheduleSummary(program.rules)}
      </p>
      <PriceSummary
        label="Program price"
        amountCents={program.price_amount_cents}
        currency={currency}
        viewer="member"
        breakdown={program.price_amount_cents !== null ? "for the full program" : null}
        className="mt-0.5"
      />

      {/* Offer deadline */}
      {status === "offered" && !offerExpired && offerExpiresAt && (
        <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5 font-medium">
          Accept by {formatOfferTime(offerExpiresAt, clubTimezone)}
        </p>
      )}

      {/* Whole-program enrollment note */}
      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1 italic">
        Enrolling covers the full program — no per-session sign-up needed.
      </p>

      {/* Inline error */}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 mt-2.5 pt-2.5 border-t border-gray-100 dark:border-gray-700">
        {/* Phase 33F3B: new-entry — hidden at a Staff-Managed club. */}
        {status === null && memberSelfService && (
          <button onClick={handleJoin} disabled={isPending} className={ACTION_BUTTON_PRIMARY}>
            {isPending && pendingKind === "join" ? PENDING_LABEL.join : "Join Program"}
          </button>
        )}
        {status === "enrolled" && (
          <button onClick={handleLeave} disabled={isPending} className={ACTION_BUTTON_DESTRUCTIVE}>
            {isPending && pendingKind === "leave" ? PENDING_LABEL.leave : "Leave Program"}
          </button>
        )}
        {status === "waitlisted" && (
          <button onClick={handleLeave} disabled={isPending} className={ACTION_BUTTON_DESTRUCTIVE}>
            {isPending && pendingKind === "leave" ? PENDING_LABEL.leave : "Leave Waitlist"}
          </button>
        )}
        {status === "offered" && !offerExpired && (
          <>
            <button onClick={handleDecline} disabled={isPending} className={ACTION_BUTTON_DESTRUCTIVE}>
              {isPending && pendingKind === "decline" ? PENDING_LABEL.decline : "Pass"}
            </button>
            <button onClick={handleAccept} disabled={isPending} className={ACTION_BUTTON_PRIMARY}>
              {isPending && pendingKind === "accept" ? PENDING_LABEL.accept : "Accept Spot"}
            </button>
          </>
        )}
        {/* Phase 33F3B: re-entry — hidden at a Staff-Managed club. */}
        {status === "offered" && offerExpired && memberSelfService && (
          <button onClick={handleRejoin} disabled={isPending} className={ACTION_BUTTON_PRIMARY}>
            {isPending && pendingKind === "rejoin" ? PENDING_LABEL.rejoin : "Rejoin Waitlist"}
          </button>
        )}
      </div>
    </div>
  );
}
