"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import EventRosterSheet, { type RosterParticipantRow } from "./EventRosterSheet";
import EditEventSheet from "./EditEventSheet";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { cancelEvent, joinEvent, leaveEvent, acceptWaitlistOffer, declineWaitlistOffer } from "./actions";
import { setEventMemberJoinableAction } from "@/app/(app)/admin/events/actions";
import { ACTION_BUTTON_SECONDARY, ACTION_BUTTON_DESTRUCTIVE } from "@/app/(app)/events/actionButtonStyles";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { canAccessOperationsWorkspace, isOperator } from "@/lib/auth/roles";
import PriceSummary from "@/components/PriceSummary";
import EventJoinConfirmModal from "@/components/EventJoinConfirmModal";
import PaymentStateBadge from "@/components/PaymentStateBadge";
import { fetchPaymentStates } from "@/app/(app)/admin/payments/actions";
import { isPaymentOpenForRecording, type PaymentStateRow } from "@/lib/payments";
import { ACTION_BUTTON_PRIMARY_COMPACT_TOUCH } from "@/lib/actionButtonStyles";
import { getEventCheckoutEligibilityAction, createEventCheckoutAction } from "./eventCheckoutActions";

// ─── Types (same shape as CalendarShell; redefined here to avoid circular import) ─

interface EventParticipant {
  // Phase 33D2: null for a no-account participant added directly to
  // event_participants. Known display-only gap (documented, not fixed in
  // this checkpoint): myPart below still resolves via profile_id ===
  // userId only, so a claimed Member whose pre-claim participation was
  // staff-added will not show as "already joined" HERE specifically —
  // My Schedule (page.tsx) already resolves this correctly via the
  // roster-aware query fix, and leave_event/accept_waitlist_offer/
  // decline_waitlist_offer (server-side) already authorize correctly
  // regardless of what this component displays.
  profile_id: string | null;
  roster_member_id: string | null;
  role: string;
  status: string;
  offer_expires_at?: string | null;
  // Phase 34F-B: the event_participants row's own id — the domain_id
  // needed to read this participant's payment state via fetchPaymentStates
  // ("event_participant", [id]). Optional, matching offer_expires_at's own
  // existing optionality immediately above: EventRosterSheet's onRosterCha
  // nge callback (RosterParticipantRow, get_event_roster's own return
  // shape) does not carry either field, an existing, pre-34F-B gap this
  // migration does not widen — the payment-state effect below simply skips
  // itself when id is unavailable, exactly like the offer-expiry UI
  // already tolerates a missing offer_expires_at after a roster refresh.
  id?: string;
}

interface EventWithDetails {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  status: string;
  created_by: string;
  member_joinable: boolean;
  // Phase 30C2: additional fields required by EditEventSheet.
  event_type_id: string;
  description: string | null;
  updated_at: string;
  program_id: string | null;
  price_amount_cents: number | null;
  event_types: {
    key: string;
    label: string;
    color: string;
    shows_participant_names: boolean;
  };
  event_participants: EventParticipant[];
  // Phase 33E2: status distinguishes an active guest (occupies capacity)
  // from a soft-cancelled one (does not).
  event_guests: Array<{ id: string; status: string }>;
  court_ids: string[];
}

interface Court {
  id: string;
  name: string;
  display_order: number;
}

interface ParticipantProfile {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

interface Props {
  event: EventWithDetails;
  courts: Court[];
  userId: string;
  // Phase 33D2: the signed-in user's own durable Member identity for this
  // club, if claimed — resolved server-side (same source CalendarShell
  // already uses for reservations/lessons). Lets a claimed Member be
  // recognized as already participating in an event that was added for
  // them, by staff, before they had an account.
  userRosterMemberId: string | null;
  userRole: string;
  clubTimezone: string;
  clubId: string;
  currency: string;
  onClose: () => void;
  onRefresh: () => void;
  // Phase 33G3: lets a successful, non-lifecycle mutation (currently just
  // the member-joinable toggle) patch CalendarShell's own authoritative
  // `events` state in place — without this, CalendarShell's array (and any
  // later reopen of this same Event, which remounts from a fresh `event`
  // prop) kept showing the pre-mutation value until a full page reload,
  // even though the DB write had already succeeded. Deliberately narrower
  // than onRefresh: no refetch, no sheet close, called only after the RPC
  // confirms success — never as an optimistic pre-mutation guess. Typed to
  // exactly the one field this actually patches today (not
  // Partial<EventWithDetails>) — CalendarShell's own EventWithDetails is a
  // separately-declared, structurally-similar-but-not-identical type (see
  // this file's own top-of-file note on why), so a broad Partial<> here
  // would invite a cross-type mismatch for fields neither side actually
  // exchanges through this callback.
  onEventUpdated: (eventId: string, patch: { member_joinable?: boolean; price_amount_cents?: number | null }) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatParticipantName(profile: ParticipantProfile): string {
  const first      = profile.first_name ?? "?";
  const lastInitial = profile.last_name
    ? profile.last_name[0].toUpperCase() + "."
    : "";
  return lastInitial ? `${first} ${lastInitial}` : first;
}

function mapJoinError(message: string): string {
  if (message === STALE_CLUB_CONTEXT_ERROR) return STALE_CLUB_MESSAGE;
  if (message === "event_full")             return "This event is now full.";
  if (message === "already_joined")         return "You're already signed up.";
  if (message === "event_already_started")  return "This event has already started.";
  if (message === "event_not_available")    return "This event is no longer available.";
  if (message === "event_not_joinable")     return "This event is admin-managed. Contact the office to be added to the roster.";
  if (message === "event_archived")         return "This event is archived and no longer available.";
  if (message === "capability_not_available") return "This feature isn't available at your club right now. Contact the office for help.";
  if (message === "member_schedule_conflict") return "The member already has another confirmed commitment at that time.";
  return "Something went wrong. Please try again.";
}

function mapLeaveError(message: string): string {
  if (message === STALE_CLUB_CONTEXT_ERROR) return STALE_CLUB_MESSAGE;
  if (message === "not_joined")        return "You are not signed up for this event.";
  if (message === "not_authenticated") return "Please sign in to continue.";
  if (message === "event_archived")    return "This event is archived.";
  return "Something went wrong. Please try again.";
}

function mapOfferError(message: string): string {
  if (message === STALE_CLUB_CONTEXT_ERROR) return STALE_CLUB_MESSAGE;
  if (message === "offer_not_found")   return "This offer is no longer valid.";
  if (message === "offer_expired")     return "Your offer has expired. You can rejoin the waitlist if you're still interested.";
  if (message === "not_authenticated") return "Please sign in to continue.";
  if (message === "event_archived")    return "This event is archived and no longer available.";
  if (message === "member_schedule_conflict") return "You already have another confirmed commitment at that time.";
  return "Something went wrong. Please try again.";
}

// ─── Component ───────────────────────────────────────────────────────────────

const MAX_NAMES = 5;

export default function EventDetailSheet({
  event, courts, userId, userRosterMemberId, userRole, clubTimezone, clubId, currency, onClose, onRefresh, onEventUpdated,
}: Props) {
  const supabase = useMemo(() => createClient(), []);

  const [loading, setLoading]                         = useState(false);
  const [error, setError]                             = useState<string | null>(null);
  const [localParticipants, setLocalParticipants]     = useState<EventParticipant[]>(event.event_participants);
  const [localGuestCount, setLocalGuestCount]         = useState(
    event.event_guests?.filter(g => g.status === "active").length ?? 0
  );
  // Phase 33D2a fix: null = not yet resolved (show "Loading participants…");
  // [] = resolved with zero matching profiles — a real, valid end state
  // once no-account participants exist (see the fetch effect below), not
  // an in-progress one. Collapsing these into a single [] meant a
  // confirmed no-account-only roster showed "Loading participants…"
  // forever, since the effect returned before ever calling setState.
  const [participantProfiles, setParticipantProfiles] = useState<ParticipantProfile[] | null>(null);
  const [cancelConfirming, setCancelConfirming]       = useState(false);
  const [cancelLoading, setCancelLoading]             = useState(false);
  const [cancelError, setCancelError]                 = useState<string | null>(null);
  const [rosterOpen, setRosterOpen]                   = useState(false);
  const [rosterRefreshTick, setRosterRefreshTick]     = useState(0);
  const [offerLoading, setOfferLoading]               = useState<"accept" | "pass" | null>(null);
  const [offerError, setOfferError]                   = useState<string | null>(null);
  const [editOpen, setEditOpen]                       = useState(false);
  // Phase 33G3: reuses the exact same set_event_member_joinable RPC (via
  // setEventMemberJoinableAction) already wired up on /admin/events'
  // "Manage Events" list — closing the parity gap where an Event created
  // from Calendar could only have its joinability changed by navigating
  // away to that separate page. No new RPC/migration.
  const [localMemberJoinable, setLocalMemberJoinable] = useState(event.member_joinable);
  const [joinableSaving, setJoinableSaving]           = useState(false);
  const [joinableError, setJoinableError]             = useState<string | null>(null);

  // Phase 34B: Event price — post-creation-only edit, never rewrites
  // already-created participant/guest price snapshots. Phase 34C: the
  // standalone inline Edit/Save/Cancel control that used to live here was
  // removed — Admin now edits price from within Edit Event (EditEventSheet)
  // instead. This sheet only ever displays the resolved price now.
  const localPriceCents = event.price_amount_cents;
  // Phase 33G3 runtime QA: parity with AdminEventsClient's confirmation —
  // an Open-to-Members event with existing active participants requires
  // explicit confirmation before becoming admin-managed (set_event_member_
  // joinable itself has no participant-count guard; this is a client-side
  // UX gate only, same as /admin/events).
  const [confirmingMakeAdminManaged, setConfirmingMakeAdminManaged] = useState(false);

  // Phase 34F-B — own read-only payment state via the sanitized batched
  // read boundary, mirroring LessonRequestDetail's identical pattern
  // exactly. No Record Payment here — Member never mutates payments; that
  // control lives only on /admin/payments and the roster's own Admin
  // tools. Populated below once myPart (the caller's own participant row)
  // is resolved and confirmed.
  const [paymentState, setPaymentState] = useState<PaymentStateRow | null>(null);
  // Whether THIS participant's obligation was created under
  // court_time_payments (never re-derived from the club's CURRENT payment
  // mode). Purely a UI-gating signal for whether Pay Now renders at all —
  // createEventCheckoutAction always re-derives eligibility fresh itself
  // and never trusts this flag.
  const [checkoutEligible, setCheckoutEligible] = useState(false);
  const [checkoutLoading, setCheckoutLoading]   = useState(false);
  const [checkoutError, setCheckoutError]       = useState<string | null>(null);

  // ── Derived values ────────────────────────────────────────────────────────

  // Only confirmed participants with role = 'participant' consume capacity.
  // Hosts never count toward capacity — matches the backend join_event logic.
  const confirmedParticipants = localParticipants
    .filter(p => p.status === "confirmed" && p.role === "participant")
    .sort((a, b) => (a.profile_id ?? "").localeCompare(b.profile_id ?? ""));

  // Phase 18B: offered rows also hold a spot (capacity guard: confirmed+offered).
  const offeredParticipants = localParticipants
    .filter(p => p.status === "offered");

  // Waitlisted: only truly-waitlisted rows (excludes offered and guests).
  const waitlistedParticipants = localParticipants
    .filter(p => p.status === "waitlisted");

  const confirmedCount  = confirmedParticipants.length;
  const offeredCount    = offeredParticipants.length;
  const guestCount      = localGuestCount;
  const waitlistCount   = waitlistedParticipants.length;
  // Full when confirmed + offered + guests reach capacity (Phase 19A).
  const isFull          = (confirmedCount + offeredCount + guestCount) >= event.capacity;
  // Phase 33G3: identical formula to AdminEventsClient's activeParticipantCount
  // (confirmed/offered/waitlisted, role-agnostic — no participant "counts as
  // a stake" filter here, matching that surface exactly).
  const activeParticipantCount = localParticipants.filter(
    p => p.status === "confirmed" || p.status === "offered" || p.status === "waitlisted"
  ).length;

  // Exclude cancelled rows — a user who left should be treated as not joined.
  // Phase 33D2: matches via profile_id OR the caller's own current roster
  // identity — a claimed Member whose participation was added by staff
  // before they had an account (profile_id null, roster_member_id set) is
  // recognized here the same way My Schedule's query already is. Display-
  // matching only — actual authorization for leave/accept/decline remains
  // entirely server-side (leave_event/accept_waitlist_offer/decline_
  // waitlist_offer independently re-resolve ownership, never trusting the
  // client).
  const myPart       = localParticipants.find(
    p => (p.profile_id === userId || (userRosterMemberId !== null && p.roster_member_id === userRosterMemberId))
      && p.status !== "cancelled"
  );
  const isHost       = myPart?.role === "host";
  const isWaitlisted = myPart?.status === "waitlisted";
  const isOffered    = myPart?.status === "offered";
  // Phase 34F-B — eligibility point per the locked audit model: confirmed
  // participant AND the parent Event still scheduled (cancel_event does
  // NOT cascade into event_participants.status — a cancelled Event's
  // confirmed participant rows are intentionally preserved as historical,
  // so event.status must be checked independently here, exactly like
  // eventParticipantLifecycleLabel already does on /admin/payments).
  const isConfirmed  = myPart?.status === "confirmed" && event.status === "scheduled";

  // Offer expiry (client-side). Evaluated once per render; no polling needed
  // because the sheet closes/re-opens on every action refresh.
  const myOfferExpiresAt  = isOffered ? (myPart?.offer_expires_at ?? null) : null;
  const offerExpired      = myOfferExpiresAt ? new Date(myOfferExpiresAt) <= new Date() : false;

  // 1-based position among waitlisted rows (order matches DB created_at order;
  // CalendarShell fetches participants in insertion order as a proxy).
  const myWaitlistPosition = isWaitlisted
    ? waitlistedParticipants.findIndex(
        p => p.profile_id === userId || (userRosterMemberId !== null && p.roster_member_id === userRosterMemberId)
      ) + 1
    : null;

  // Members should not be able to join or waitlist for events that have already started.
  const isPastEvent    = new Date(event.starts_at) < new Date();
  // Phase 30C2 correction: event-management ownership (cancel/edit) is
  // determined by events.created_by, matching the corrected cancel_event
  // RPC contract exactly — never by roster Host status. create_event has
  // not auto-inserted a host participant row since migration 0058, so a
  // Pro's own events would otherwise never satisfy an isHost-based check.
  // Phase 34A: widened admin -> isOperator (admin+staff) — Pro's existing
  // owner-scoped behavior is unchanged.
  const canCancelEvent = isOperator(userRole) || (userRole === "pro" && event.created_by === userId);
  // Edit was Admin-only in Phase 30C — no Pro exception, unlike
  // cancellation. Phase 34A: widened admin -> isOperator; Pro is still
  // never admitted here (update_event, 0136, never gained a Pro path).
  const canEdit         = isOperator(userRole) && event.status === "scheduled" && !isPastEvent;
  const canViewRoster  = canAccessOperationsWorkspace(userRole);
  // Phase 33G3: same admin-or-own-Pro-event authorization as canCancelEvent
  // (mirrors AdminEventsClient's canActOnEvent gating for this identical toggle).
  const canToggleMemberJoinable = canCancelEvent && event.status === "scheduled" && !isPastEvent;

  // Total active participants shown in the roster button label (confirmed + offered + waitlisted + guests).
  const rosterCount = localParticipants.filter(
    p => p.status === "confirmed" || p.status === "offered" || p.status === "waitlisted"
  ).length + guestCount;

  const courtNames = event.court_ids
    .map(id => courts.find(c => c.id === id)?.name ?? "Court")
    .join(", ");

  const dateLabel = new Date(event.starts_at).toLocaleDateString("en-US", {
    timeZone: clubTimezone, weekday: "long", month: "long", day: "numeric",
  });
  const startLabel = new Date(event.starts_at).toLocaleTimeString("en-US", {
    timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });
  const endLabel = new Date(event.ends_at).toLocaleTimeString("en-US", {
    timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });

  // ── Fetch participant profiles for events that show names ─────────────────

  useEffect(() => {
    if (!event.event_types.shows_participant_names) return;
    // Phase 33D2: a no-account participant has no profile_id to resolve a
    // name for here — filtered out rather than sent to `.in("id", ...)`.
    const ids = confirmedParticipants
      .map(p => p.profile_id)
      .filter((id): id is string => id !== null);
    // Phase 33D2a fix: zero resolvable ids (e.g. every confirmed
    // participant is a no-account Member) is itself a resolved state —
    // must still call setParticipantProfiles([]) so the render below stops
    // showing "Loading participants…", which it would otherwise do
    // forever since this effect never runs again for the same event.
    if (ids.length === 0) {
      setParticipantProfiles([]);
      return;
    }
    supabase
      .from("profiles")
      .select("id, first_name, last_name")
      .in("id", ids)
      .then(({ data, error }) => {
        if (error) {
          // eslint-disable-next-line no-console
          console.error("[EventDetailSheet] participant profile lookup failed:", error.message);
        }
        setParticipantProfiles(data ?? []);
      });
  }, [event.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleJoin() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await joinEvent(event.id, clubId);
    if (rpcError) {
      setError(mapJoinError(rpcError));
      setLoading(false);
      return;
    }
    setRosterRefreshTick(t => t + 1);
    onRefresh();
    onClose();
  }

  // Phase 34C — positive-price Join confirmation, same policy as
  // EventsUpcomingClient's EventJoinConfirmModal. Free/unpriced events keep
  // the existing direct handleJoin() call untouched.
  const [showJoinConfirm, setShowJoinConfirm] = useState(false);
  function requestJoin() {
    if (event.price_amount_cents !== null && event.price_amount_cents > 0) {
      setShowJoinConfirm(true);
      return;
    }
    void handleJoin();
  }

  async function handleLeave() {
    setLoading(true);
    setError(null);
    const result = await leaveEvent(event.id, clubId);
    if (result?.error) {
      setError(mapLeaveError(result.error));
      setLoading(false);
      return;
    }
    setRosterRefreshTick(t => t + 1);
    onRefresh();
    onClose();
  }

  async function handleCancelEvent() {
    setCancelLoading(true);
    setCancelError(null);
    const result = await cancelEvent(event.id, clubId);
    if (result?.error) {
      setCancelError(
        result.error === STALE_CLUB_CONTEXT_ERROR ? STALE_CLUB_MESSAGE :
        result.error === "event_not_found"  ? "This event has already been cancelled." :
        result.error === "event_archived"   ? "This event is archived and cannot be cancelled." :
        "Something went wrong. Please try again."
      );
      setCancelLoading(false);
      return;
    }
    onRefresh();
    onClose();
  }

  // Phase 34F-B — payment state + Checkout eligibility, mirroring
  // LessonRequestDetail's identical two-effect pattern exactly. Re-runs
  // whenever the caller's own participant status or the event's own
  // status changes (e.g. accepting a waitlist offer, or the event being
  // cancelled while this sheet is open).
  useEffect(() => {
    if (!isConfirmed || !myPart?.id) {
      setPaymentState(null);
      return;
    }
    const participantId = myPart.id;
    let cancelled = false;
    (async () => {
      const { data } = await fetchPaymentStates("event_participant", [participantId]);
      if (!cancelled) setPaymentState(data?.[0] ?? null);
    })();
    return () => { cancelled = true; };
  }, [isConfirmed, myPart?.id]);

  useEffect(() => {
    if (!isConfirmed) {
      setCheckoutEligible(false);
      return;
    }
    getEventCheckoutEligibilityAction(event.id, clubId).then(({ eligible }) => {
      setCheckoutEligible(eligible);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id, isConfirmed]);

  async function handlePayNow() {
    setCheckoutLoading(true);
    setCheckoutError(null);
    const result = await createEventCheckoutAction(event.id, clubId, clubTimezone);
    if (result.error) {
      setCheckoutError(result.error);
      setCheckoutLoading(false);
      return;
    }
    if (result.url) {
      // External Stripe-hosted destination — a plain browser navigation.
      window.location.href = result.url;
    }
  }

  async function handleToggleMemberJoinable() {
    const next = !localMemberJoinable;
    setJoinableError(null);
    setJoinableSaving(true);
    setLocalMemberJoinable(next); // optimistic — matches AdminEventsClient's pattern
    const result = await setEventMemberJoinableAction(event.id, next, clubId);
    setJoinableSaving(false);
    if (result.error) {
      setLocalMemberJoinable(!next); // revert
      setJoinableError(result.error);
      return;
    }
    // Phase 33G3 fix: patch CalendarShell's own authoritative state now
    // that the RPC has actually confirmed success — only then, never
    // before, so this is not optimistic phantom state. This is what makes
    // closing and reopening this same Event (a fresh mount, re-reading
    // CalendarShell's `events` array) show the persisted value without a
    // full page reload.
    onEventUpdated(event.id, { member_joinable: next });
    // Still no onRefresh() here — unlike Cancel/Join/Leave, this toggle
    // doesn't warrant closing the sheet or a full events refetch.
  }

  async function handleAcceptOffer() {
    setOfferLoading("accept");
    setOfferError(null);
    const result = await acceptWaitlistOffer(event.id, clubId);
    if (result?.error) {
      setOfferError(mapOfferError(result.error));
      setOfferLoading(null);
      return;
    }
    onRefresh();
    onClose();
  }

  async function handlePassOffer() {
    setOfferLoading("pass");
    setOfferError(null);
    const result = await declineWaitlistOffer(event.id, clubId);
    if (result?.error) {
      setOfferError(mapOfferError(result.error));
      setOfferLoading(null);
      return;
    }
    onRefresh();
    onClose();
  }

  // ── Button ────────────────────────────────────────────────────────────────

  // Disable join/waitlist for past events (members cannot join retroactively).
  // Leave actions remain available so members who are already confirmed can leave.
  const joinBlockedByPast = isPastEvent && !myPart && !isHost;
  const buttonDisabled = isHost || loading || joinBlockedByPast;

  const buttonLabel = loading
    ? (isHost ? "You're the Host" : isWaitlisted || (!myPart && isFull) ? "Joining…" : "Leaving…")
    : isHost          ? "You're the Host"
    : joinBlockedByPast ? "Event has passed"
    : isWaitlisted    ? `Leave Waitlist${myWaitlistPosition ? ` (#${myWaitlistPosition})` : ""}`
    : myPart          ? "Leave Event"
    : isFull          ? "Join Waitlist"
    : "Join Event";

  const handleAction = (myPart && !isHost) ? handleLeave : requestJoin;

  const buttonClass = isHost || joinBlockedByPast
    ? "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
    : isWaitlisted
    ? "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-700"
    : myPart
    ? "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-700"
    : "bg-accent text-white dark:text-gray-900";

  // ── Participant display ────────────────────────────────────────────────────

  const shownParticipants = confirmedParticipants.slice(0, MAX_NAMES);
  const nameRemainder     = confirmedParticipants.length - MAX_NAMES;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <ResponsiveSheet
        onClose={onClose}
        variant="modal"
        mobileInteraction="draggable"
        label={event.title}
        header={null}
        active={!rosterOpen && !editOpen}
      >
        {/* Event type pill + admin-managed badge */}
        <div className="flex items-center gap-1.5 mb-3 flex-wrap">
          <span
            className="inline-block rounded-full px-2.5 py-1 text-[11px] font-semibold text-white"
            style={{ background: event.event_types.color }}
          >
            {event.event_types.label}
          </span>
          {!localMemberJoinable && (
            <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
              Admin-managed
            </span>
          )}
          {event.program_id && canAccessOperationsWorkspace(userRole) && (
            <a
              href="/events?tab=programs"
              className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/50"
            >
              Part of a Program →
            </a>
          )}
        </div>

        {/* Title */}
        <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{event.title}</p>

        {/* Date */}
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{dateLabel}</p>

        {/* Time */}
        <p className="text-sm text-gray-700 dark:text-gray-300 mt-0.5 font-medium">
          {startLabel} – {endLabel}
        </p>

        {/* Courts */}
        {courtNames && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{courtNames}</p>
        )}

        {/* Capacity — confirmed + offered + guests all consume a spot */}
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          {confirmedCount + offeredCount + guestCount} of {event.capacity} spots filled
          {waitlistCount > 0 ? ` · ${waitlistCount} on waitlist` : "."}
        </p>

        {/* Phase 34B: price display. Phase 34C: the standalone inline
            Edit/Save/Cancel control that used to live here was removed —
            Admin now edits price from within Edit Event instead (see the
            "Edit Event" button below). Everyone sees the resolved price
            read-only here, hidden entirely for Members when unset (never
            implies payment is required). */}
        <PriceSummary
          label="Event price"
          amountCents={localPriceCents}
          currency={currency}
          viewer={isOperator(userRole) ? "operator" : "member"}
          breakdown={localPriceCents !== null ? "per participant" : null}
          className="mt-1.5"
        />

        {/* View Roster — admin/pro only */}
        {canViewRoster && (
          <button
            onClick={() => setRosterOpen(true)}
            className={`mt-2 ${ACTION_BUTTON_SECONDARY}`}
          >
            View Roster ({rosterCount})
          </button>
        )}

        {/* Participant names (only when event type opts in) */}
        {event.event_types.shows_participant_names && confirmedCount > 0 && (
          <div className="mt-3">
            {participantProfiles === null ? (
              <p className="text-xs text-gray-400 dark:text-gray-500">Loading participants…</p>
            ) : participantProfiles.length > 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {shownParticipants
                  .map(p => {
                    const prof = participantProfiles.find(pr => pr.id === p.profile_id);
                    return prof ? formatParticipantName(prof) : null;
                  })
                  .filter((name): name is string => name !== null)
                  .join(", ")}
                {nameRemainder > 0 && `, +${nameRemainder} more`}
              </p>
            ) : null}
          </div>
        )}

        {/* ── Offered state — replaces the standard action button ── */}
        {isOffered ? (
          offerExpired ? (
            /* Offer has expired client-side */
            <div className="mt-5">
              <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-4 py-3 text-center">
                <p className="text-sm text-amber-800 dark:text-amber-300">
                  This offer has expired. Rejoin the waitlist if you&apos;re still interested.
                </p>
              </div>
              {offerError && <p className="mt-2 text-xs text-red-500">{offerError}</p>}
              <button
                disabled={loading}
                onClick={requestJoin}
                className="mt-3 w-full py-3 rounded-xl text-sm font-semibold bg-accent text-white dark:text-gray-900 disabled:opacity-40"
              >
                {loading ? "Joining…" : isFull ? "Rejoin Waitlist" : "Rejoin Event"}
              </button>
            </div>
          ) : (
            /* Active offer — show deadline + Accept / Pass */
            <div className="mt-5">
              <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-4 py-3">
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                  Spot offered
                </p>
                {myOfferExpiresAt && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                    Accept by{" "}
                    {new Date(myOfferExpiresAt).toLocaleTimeString("en-US", {
                      timeZone: clubTimezone,
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: true,
                    })}
                  </p>
                )}
              </div>
              {offerError && <p className="mt-2 text-xs text-red-500">{offerError}</p>}
              <div className="flex gap-3 mt-3">
                <button
                  disabled={!!offerLoading}
                  onClick={handlePassOffer}
                  className="flex-1 py-3 rounded-xl text-sm font-semibold border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 disabled:opacity-40"
                >
                  {offerLoading === "pass" ? "Passing…" : "Pass"}
                </button>
                <button
                  disabled={!!offerLoading}
                  onClick={handleAcceptOffer}
                  className="flex-1 py-3 rounded-xl text-sm font-semibold bg-green-600 text-white disabled:opacity-40"
                >
                  {offerLoading === "accept" ? "Accepting…" : "Accept Spot"}
                </button>
              </div>
            </div>
          )
        ) : !localMemberJoinable && !myPart && !isHost ? (
          /* Admin-managed event — member not on roster, hide join/waitlist */
          <div className="mt-5 rounded-xl bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 px-4 py-3 text-center">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Admin-managed event. Contact the office to be added to the roster.
            </p>
          </div>
        ) : (
          /* Normal state — Join / Leave / Waitlist / Host */
          <>
            {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
            <button
              disabled={buttonDisabled}
              onClick={handleAction}
              className={`mt-5 w-full py-3 rounded-xl text-sm font-semibold disabled:opacity-40 ${buttonClass}`}
            >
              {buttonLabel}
            </button>
          </>
        )}

        {/* Payment state — Phase 34F-B, own state only, read-only. Pay Now
            is the Member's own action for their own confirmed registration
            — mirrors LessonRequestDetail's identical pattern exactly; this
            Member never sees Admin's Record Payment control, which lives
            only on /admin/payments and this event's own roster Admin
            tools. Renders only for the owning Member's own confirmed,
            still-scheduled participation (isConfirmed already encodes
            both) — never for a waitlisted/offered participant, another
            Member, a guest, or an Admin/Staff/Pro viewing this sheet. */}
        {isConfirmed && paymentState && (
          <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <PaymentStateBadge state={paymentState} />
            {checkoutEligible && isPaymentOpenForRecording(paymentState) && (
              <button
                disabled={checkoutLoading}
                onClick={handlePayNow}
                className={`${ACTION_BUTTON_PRIMARY_COMPACT_TOUCH} disabled:opacity-50`}
              >
                {checkoutLoading ? "Redirecting…" : "Pay Now"}
              </button>
            )}
          </div>
        )}
        {checkoutError && <p className="mt-2 text-xs text-red-500">{checkoutError}</p>}

        {/* Edit — admin-only, eligible events only */}
        {canEdit && (
          <button
            onClick={() => setEditOpen(true)}
            className="mt-4 w-full py-3 rounded-xl text-sm font-semibold bg-gray-50 dark:bg-gray-700/60 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-600"
          >
            Edit Event
          </button>
        )}

        {/* Members can join toggle — admin, or the Pro who created this event */}
        {canToggleMemberJoinable && (
          confirmingMakeAdminManaged ? (
            /* ── Make Admin-managed confirmation — parity with AdminEventsClient ── */
            <div className="mt-4 rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-3 space-y-1.5">
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                Make this event admin-managed?
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {activeParticipantCount}{" "}
                {activeParticipantCount === 1 ? "participant is" : "participants are"}{" "}
                on this event. They will remain on the roster, but new members
                won&rsquo;t be able to self-join from the calendar.
              </p>
              {joinableError && <p className="text-xs text-red-500">{joinableError}</p>}
              <div className="flex items-center gap-2 pt-0.5">
                <button
                  onClick={() => { setConfirmingMakeAdminManaged(false); setJoinableError(null); }}
                  className={ACTION_BUTTON_SECONDARY}
                >
                  Keep open
                </button>
                <button
                  onClick={() => { setConfirmingMakeAdminManaged(false); handleToggleMemberJoinable(); }}
                  disabled={joinableSaving}
                  className={ACTION_BUTTON_DESTRUCTIVE}
                >
                  {joinableSaving ? "Saving…" : "Make admin-managed"}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-gray-200 dark:border-gray-600 px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Members can join this event</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {localMemberJoinable
                    ? "Members can sign up from the calendar."
                    : "Admin-managed — only staff can add members to the roster."}
                </p>
                {joinableError && <p className="text-xs text-red-500 mt-1">{joinableError}</p>}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={localMemberJoinable}
                disabled={joinableSaving}
                onClick={() => {
                  if (localMemberJoinable && activeParticipantCount > 0) {
                    // Open → Admin-managed with active participants: confirm first.
                    setJoinableError(null);
                    setConfirmingMakeAdminManaged(true);
                  } else {
                    // Admin-managed → Open, or Open → Admin-managed with no participants: proceed directly.
                    handleToggleMemberJoinable();
                  }
                }}
                className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full border-2 border-transparent transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 ${
                  localMemberJoinable ? "bg-accent" : "bg-gray-200 dark:bg-gray-600"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    localMemberJoinable ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          )
        )}

        {/* Cancel Event — admin, or the Pro who created this event */}
        {canCancelEvent && (
          <div className="mt-4">
            {!cancelConfirming ? (
              <button
                onClick={() => setCancelConfirming(true)}
                className="w-full py-3 rounded-xl text-sm font-semibold bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 disabled:opacity-40"
              >
                Cancel Event
              </button>
            ) : (
              <div>
                <p className="text-xs text-gray-600 dark:text-gray-400 mb-2 text-center">Cancel this event?</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setCancelConfirming(false); setCancelError(null); }}
                    className="flex-1 py-3 rounded-xl text-sm font-semibold border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 disabled:opacity-40"
                  >
                    Keep
                  </button>
                  <button
                    disabled={cancelLoading}
                    onClick={handleCancelEvent}
                    className="flex-1 py-3 rounded-xl text-sm font-semibold bg-red-600 text-white disabled:opacity-40"
                  >
                    {cancelLoading ? "Cancelling…" : "Yes, cancel"}
                  </button>
                </div>
                {cancelError && <p className="mt-2 text-xs text-red-500 text-center">{cancelError}</p>}
              </div>
            )}
          </div>
        )}

      </ResponsiveSheet>

      {/* ── Event Roster Sheet — admin/pro only, layers above this sheet ── */}
      {rosterOpen && (
        <EventRosterSheet
          eventId={event.id}
          clubId={clubId}
          clubTimezone={clubTimezone}
          userRole={userRole}
          refreshTick={rosterRefreshTick}
          onClose={() => setRosterOpen(false)}
          onRosterChange={(rows: RosterParticipantRow[], gc: number) => {
            setLocalParticipants(rows);
            setLocalGuestCount(gc);
          }}
        />
      )}

      {/* ── Edit Event Sheet — admin only, layers above this sheet ──────── */}
      {editOpen && (
        <EditEventSheet
          event={event}
          courts={courts}
          clubId={clubId}
          clubTimezone={clubTimezone}
          currency={currency}
          isAdmin={userRole === "admin"}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); onRefresh(); }}
        />
      )}

      {showJoinConfirm && event.price_amount_cents !== null && (
        <EventJoinConfirmModal
          eventTitle={event.title}
          priceCents={event.price_amount_cents}
          currency={currency}
          willWaitlist={isFull}
          submitting={loading}
          onConfirm={() => { setShowJoinConfirm(false); void handleJoin(); }}
          onCancel={() => setShowJoinConfirm(false)}
        />
      )}
    </>
  );
}
