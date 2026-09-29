// HAND-MAINTAINED domain/compatibility layer (Phase 45C1).
//
// src/lib/db/database.types.ts is GENERATED — real `supabase gen types`
// output, committed, never hand-edited (see README.md, "Regenerate Supabase
// types"). It reflects raw database STRUCTURE only: every public table and
// function the schema actually has, regardless of RLS/grants — e.g.
// club_memberships appears there because it genuinely exists, even though
// it is fully locked down (RLS-enabled, zero policies, all grants revoked)
// and unreachable via `.from()` by any caller. Type presence does NOT grant
// database permission; RLS/EXECUTE grants/SECURITY DEFINER authorization
// remain authoritative and are audited separately (see Phase 45D).
//
// This file layers a SMALL, EVIDENCE-BACKED set of corrections on top of the
// generated structure — nothing here duplicates full table/function shapes:
//
//   1. Literal string unions for CHECK-constrained columns. Supabase's
//      generator can only produce a literal union from a native Postgres
//      ENUM type — this schema defines zero native enums (confirmed by
//      `Enums: { [_ in never]: never }` in database.types.ts), so every
//      status/role/kind/domain-classifier column generates as plain
//      `string`. Each override below is verified against that column's
//      current CHECK constraint at the migration cited in its comment.
//   2. A handful of confirmed Args/Returns nullability corrections, where
//      the generator provably under- or over-reports nullability (see each
//      override's comment for the specific evidence).
//   3. Two deliberate Insert/Update lockouts (`payments`, `payment_events`)
//      preserving a pre-existing domain rule: these are append-only/
//      rollup ledger tables the app must never write to directly, only via
//      RPCs (record_manual_payment, record_refund, etc.).
//
// IMPORTANT: a literal-union override here documents application-level
// domain knowledge; it does NOT independently verify that Postgres still
// agrees. If a migration adds/removes a CHECK-constrained value, this file
// must be updated by hand in the same change — nothing enforces that
// automatically beyond code review and `pnpm db:types:check` (which only
// catches STRUCTURAL drift, not whether a hand-written union is complete).
//
// notifications.kind / notification_preferences.kind are the one domain
// this project gives a SINGLE canonical declaration (NotificationKind, in
// notification-targets.ts) rather than two independently hand-written
// copies — the previous two-copies approach drifted out of sync once
// already (Phase 45C audit) before this rewrite.

import type { Database as GeneratedDatabase, Json } from "./database.types";
import type { NotificationKind } from "@/lib/notification-targets";

export type { Json };

type GeneratedTables = GeneratedDatabase["public"]["Tables"];
type GeneratedFunctionsRaw = GeneratedDatabase["public"]["Functions"];

// ─────────────────────────────────────────────────────────────────────────
// Systemic correction: RPC Args nullability.
//
// Confirmed by comparing database.types.ts against live SQL signatures and
// several real call sites (e.g. send_announcement_v2, preview_court_
// reservation_price): the generator NEVER marks a function argument as
// accepting `null`, regardless of whether the underlying Postgres parameter
// genuinely does. For an OPTIONAL argument (one with a SQL DEFAULT, `?` in
// generated output) this matters in practice — many existing call sites
// across the app explicitly pass `null` rather than omitting the key
// (confirmed by the scale of compile errors produced while adopting the
// generated file directly: dozens of call sites across courts/events/
// lessons/members/payments actions).
//
// This is safe to correct BLANKET, not case-by-case: `grep` confirms this
// schema defines ZERO `strict` SQL/plpgsql functions (the only Postgres
// modifier that would make passing an explicit NULL for an optional
// parameter behave differently, e.g. short-circuit to a NULL return
// instead of running the function body) across all 210 migrations. Since
// every optional parameter can safely receive an explicit NULL, every
// optional parameter's type may safely include `| null`.
//
// A REQUIRED argument that is also genuinely nullable (no SQL default, but
// the function body still branches on `is null`, e.g.
// send_announcement_v2.p_recipient_user_ids) is NOT covered by this blanket
// rule — optionality (`?`) and nullability are different SQL facts, and the
// generator gets required-but-nullable args wrong in the opposite direction
// (never adds `| null` at all, regardless of optionality). Those are
// corrected individually in FunctionsOverride below, since the generator
// gives no structural signal to detect them automatically.
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
type WidenOptionalArgsToNullable<Args> = {
  [K in keyof Args]: K extends OptionalKeys<Args> ? Args[K] | null : Args[K];
};
type GeneratedFunctions = {
  [FnName in keyof GeneratedFunctionsRaw]: GeneratedFunctionsRaw[FnName] extends {
    Args: infer A;
    Returns: infer R;
  }
    ? Omit<GeneratedFunctionsRaw[FnName], "Args" | "Returns"> & {
        Args: WidenOptionalArgsToNullable<A>;
        Returns: R;
      }
    : GeneratedFunctionsRaw[FnName];
};

/** Replaces the given keys of `Base` with `Override`'s value types, keeping
 * every other key (and Base's own optionality on untouched keys) intact. */
type ApplyOverride<Base, Override> = Omit<Base, keyof Override> & Override;

// ─────────────────────────────────────────────────────────────────────────
// Table overrides
// ─────────────────────────────────────────────────────────────────────────

// club_settings.payment_mode — migration 0143, CHECK unchanged since.
type ClubSettingsRow = { payment_mode: "none" | "manual" | "court_time_payments" };
type ClubSettingsWrite = { payment_mode?: "none" | "manual" | "court_time_payments" };

// payments — migration 0143. domain_type/status CHECK-constrained, unchanged
// since. Insert/Update are deliberately `never`: this is a read-only,
// current-state rollup row per obligation cycle; all writes go through RPCs
// (record_manual_payment, record_refund, void_payment_obligation, etc.).
type PaymentsRow = {
  domain_type: "reservation" | "lesson_request" | "event_participant" | "event_guest" | "program_enrollment";
  status: "unpaid" | "partially_paid" | "paid" | "overpaid" | "partially_refunded" | "refunded" | "waived" | "void";
  payment_mode_at_creation: "manual" | "court_time_payments";
};

// payment_events — migration 0143 created event_type/method CHECK-
// constrained; event_type was later widened twice — 0150 added
// online_payment_recorded, 0153 added online_refund_recorded (both
// verified directly against payment_events_event_type_check's live
// pg_get_constraintdef output, matching 0153's own committed final DROP+
// ADD CONSTRAINT text exactly — no later migration touches this
// constraint). This union previously lagged those two widenings, forcing
// `as any` at every .in("event_type", ...) filter call site (Phase 45C2
// found these; Phase 45C2B corrected the root union here and removed all
// three). Insert/Update deliberately `never`: append-only ledger, written
// exclusively via the RPCs listed above.
type PaymentEventsRow = {
  event_type:
    | "obligation_created"
    | "obligation_amount_adjusted"
    | "manual_payment_recorded"
    | "online_payment_recorded"
    | "refund_recorded"
    | "online_refund_recorded"
    | "reverse_payment_event"
    | "void_payment_obligation"
    | "waived";
  method: "cash" | "check" | "card_terminal" | "bank_transfer" | "digital_wallet" | "other" | null;
};

// profiles.role/status — migration 0131 (role widened to include 'staff').
type ProfilesRow = {
  role: "member" | "pro" | "staff" | "admin";
  status: "active" | "inactive" | "suspended";
};
type ProfilesWrite = {
  role?: "member" | "pro" | "staff" | "admin";
  status?: "active" | "inactive" | "suspended";
};

// reservations — migration 0003 (status/format/cancellation_kind), 0189
// (membership_pricing_class), 0186 (cancellation_policy_state — previously
// missing from this file entirely; added here alongside lesson_requests'
// identical column).
type ReservationsRow = {
  status: "pending" | "confirmed" | "cancelled";
  reason: "member_booking" | "maintenance" | "admin_block" | "event" | "pro_lesson";
  format: "singles" | "doubles" | null;
  cancellation_kind: "member" | "admin" | "system" | null;
  membership_pricing_class: "member" | "non_member" | null;
  cancellation_policy_state: "in_policy" | "grace" | "late" | "not_applicable" | null;
};
type ReservationsWrite = {
  status?: "pending" | "confirmed" | "cancelled";
  reason?: "member_booking" | "maintenance" | "admin_block" | "event" | "pro_lesson";
  format?: "singles" | "doubles" | null;
  cancellation_kind?: "member" | "admin" | "system" | null;
  membership_pricing_class?: "member" | "non_member" | null;
  cancellation_policy_state?: "in_policy" | "grace" | "late" | "not_applicable" | null;
};

// events.status — migration 0004, unchanged since. (events.member_joinable,
// added migration 0062, needed no override — it's a plain boolean and now
// flows through automatically from the generated structure.)
type EventsRow = { status: "scheduled" | "cancelled" };
type EventsWrite = { status?: "scheduled" | "cancelled" };

// programs — migration 0087. enrollment_model is required (no default) on
// Insert; status defaults to 'draft' so it's optional there.
type ProgramsRow = {
  enrollment_model: "program" | "per_session" | "admin_managed";
  status: "draft" | "active" | "cancelled" | "completed";
};
type ProgramsInsert = {
  enrollment_model: "program" | "per_session" | "admin_managed";
  status?: "draft" | "active" | "cancelled" | "completed";
};
type ProgramsUpdate = {
  enrollment_model?: "program" | "per_session" | "admin_managed";
  status?: "draft" | "active" | "cancelled" | "completed";
};

// program_enrollments.status — migration 0087. No default, so required on
// Insert; ordinary partial-update optionality on Update.
type ProgramEnrollmentsRow = { status: "enrolled" | "waitlisted" | "offered" | "cancelled" };
type ProgramEnrollmentsInsert = { status: "enrolled" | "waitlisted" | "offered" | "cancelled" };
type ProgramEnrollmentsUpdate = { status?: "enrolled" | "waitlisted" | "offered" | "cancelled" };

// event_guests.status/attendance_status — migration 0117.
type EventGuestsRow = {
  status: "active" | "cancelled";
  attendance_status: "attended" | "no_show" | null;
};
type EventGuestsWrite = {
  status?: "active" | "cancelled";
  attendance_status?: "attended" | "no_show" | null;
};

// event_participants.role/status/attendance_status — migrations 0004, 0048,
// 0117 respectively, unchanged since.
type EventParticipantsRow = {
  role: "host" | "participant";
  status: "confirmed" | "cancelled" | "waitlisted" | "offered";
  attendance_status: "attended" | "no_show" | null;
};
type EventParticipantsWrite = {
  role?: "host" | "participant";
  status?: "confirmed" | "cancelled" | "waitlisted" | "offered";
  attendance_status?: "attended" | "no_show" | null;
};

// notification_deliveries.channel/status — migration 0019. Both required
// (no default) on Insert; ordinary optionality on Update.
type NotificationDeliveriesRow = {
  channel: "sms" | "email";
  status: "sent" | "failed" | "opted_out" | "no_phone";
};
type NotificationDeliveriesInsert = {
  channel: "sms" | "email";
  status: "sent" | "failed" | "opted_out" | "no_phone";
};
type NotificationDeliveriesUpdate = {
  channel?: "sms" | "email";
  status?: "sent" | "failed" | "opted_out" | "no_phone";
};

// club_invites.role — migration 0131 (widened to include 'staff').
type ClubInvitesRow = { role: "member" | "pro" | "staff" | "admin" };
type ClubInvitesWrite = { role?: "member" | "pro" | "staff" | "admin" };

// lesson_requests — status (0069), last_actor_role (0131), lesson_outcome
// (0070), pricing_basis/unit_price_amount_cents/price_amount_cents (0140),
// cancellation_policy_state (0186).
type LessonRequestsRow = {
  status: "pending" | "proposed" | "confirmed" | "declined" | "withdrawn" | "cancelled";
  last_actor_role: "member" | "pro" | "staff" | "admin" | null;
  lesson_outcome: "completed" | "member_no_show" | "pro_no_show" | "cancelled" | null;
  pricing_basis: "flat" | "hourly" | null;
  cancellation_policy_state: "in_policy" | "grace" | "late" | "not_applicable" | null;
};
type LessonRequestsWrite = {
  status?: "pending" | "proposed" | "confirmed" | "declined" | "withdrawn" | "cancelled";
  last_actor_role?: "member" | "pro" | "staff" | "admin" | null;
  lesson_outcome?: "completed" | "member_no_show" | "pro_no_show" | "cancelled" | null;
  pricing_basis?: "flat" | "hourly" | null;
  cancellation_policy_state?: "in_policy" | "grace" | "late" | "not_applicable" | null;
};

// lesson_types.pricing_basis — migration 0140 (not null, defaults to 'flat').
type LessonTypesRow = { pricing_basis: "flat" | "hourly" };
type LessonTypesWrite = { pricing_basis?: "flat" | "hourly" };

// roster_members.role/status/membership_status — migrations 0131, 0056, 0188.
type RosterMembersRow = {
  role: "member" | "pro" | "staff" | "admin";
  status: "active" | "inactive";
  membership_status: "active" | "inactive" | "suspended" | "non_member";
};
type RosterMembersWrite = {
  role?: "member" | "pro" | "staff" | "admin";
  status?: "active" | "inactive";
  membership_status?: "active" | "inactive" | "suspended" | "non_member";
};

// waiver_versions.status — migration 0192, unchanged since.
type WaiverVersionsRow = { status: "draft" | "published" };
type WaiverVersionsWrite = { status?: "draft" | "published" };

// pilot_inquiries — migration 0105. facility_type/preferred_operating_model
// have no default, so required on Insert; status/preferred_contact_method
// have defaults/are nullable, so optional on Insert. All optional on Update.
type PilotInquiriesRow = {
  status: "new" | "contacted" | "qualified" | "closed";
  preferred_contact_method: "email" | "phone" | "either" | null;
  facility_type:
    | "private_club"
    | "country_club"
    | "hoa_residential"
    | "public_municipal"
    | "tennis_academy"
    | "school_university"
    | "other";
  preferred_operating_model: "staff_managed" | "member_self_service" | "not_sure";
};
type PilotInquiriesInsert = {
  status?: "new" | "contacted" | "qualified" | "closed";
  preferred_contact_method?: "email" | "phone" | "either" | null;
  facility_type:
    | "private_club"
    | "country_club"
    | "hoa_residential"
    | "public_municipal"
    | "tennis_academy"
    | "school_university"
    | "other";
  preferred_operating_model: "staff_managed" | "member_self_service" | "not_sure";
};
type PilotInquiriesUpdate = {
  status?: "new" | "contacted" | "qualified" | "closed";
  preferred_contact_method?: "email" | "phone" | "either" | null;
  facility_type?:
    | "private_club"
    | "country_club"
    | "hoa_residential"
    | "public_municipal"
    | "tennis_academy"
    | "school_university"
    | "other";
  preferred_operating_model?: "staff_managed" | "member_self_service" | "not_sure";
};

// calendar_feed_tokens.feed_type — migration 0173. Required (no default) on
// Insert; optional on Update.
type CalendarFeedTokensRow = { feed_type: "member_personal" | "pro_lessons" };
type CalendarFeedTokensInsert = { feed_type: "member_personal" | "pro_lessons" };
type CalendarFeedTokensUpdate = { feed_type?: "member_personal" | "pro_lessons" };

// notifications / notification_preferences.kind — canonical NotificationKind
// (see notification-targets.ts), not redeclared here. Both required on
// Insert (no default column); ordinary optionality on Update.
type NotificationsRow = { kind: NotificationKind };
type NotificationsInsertRequired = { kind: NotificationKind };
type NotificationsUpdateOptional = { kind?: NotificationKind };

// ── member_notes — UNRESOLVED DISCREPANCY, see Phase 45C1 report ──────────
// member_notes needed NO override as of Phase 45C1A. The Phase 45C1
// discrepancy noted here previously (repo migration history said `content`/
// `p_content`; real generation said `body`/`p_body`) is now resolved and
// VERIFIED (not guessed): a live smoke test confirmed the repository's old
// p_content call site genuinely fails against the live database ("Something
// went wrong" — a real, reproduced failure, not a hypothetical), and direct
// live introspection confirmed body/is_archived/archived_by/p_body as the
// authoritative contract. Migration 0211 (Phase 45C1A) reconciles the
// table/write-RPC migration history to match; the application call sites
// were updated in the same checkpoint (see admin/members/[id]/actions.ts
// and MemberDetailClient.tsx). member_notes' Row/Insert/Update now flow
// through from database.types.ts unmodified — it is already correct.

type TablesOverride = {
  club_settings: Omit<GeneratedTables["club_settings"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["club_settings"]["Row"], ClubSettingsRow>;
    Insert: ApplyOverride<GeneratedTables["club_settings"]["Insert"], ClubSettingsWrite>;
    Update: ApplyOverride<GeneratedTables["club_settings"]["Update"], ClubSettingsWrite>;
  };
  payments: Omit<GeneratedTables["payments"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["payments"]["Row"], PaymentsRow>;
    Insert: never;
    Update: never;
  };
  payment_events: Omit<GeneratedTables["payment_events"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["payment_events"]["Row"], PaymentEventsRow>;
    Insert: never;
    Update: never;
  };
  // payment_disputes — migration 0156. Informational Stripe dispute state,
  // read-only for `authenticated`; every write goes through
  // process_stripe_dispute_webhook_event (service-role only). `status` is
  // deliberately left as plain `string`, not a literal union — Stripe's raw
  // dispute status has no local CHECK constraint; see disputeConfig.ts's
  // own presentDisputeStatus for the UI's safe known-value-plus-fallback
  // mapping.
  payment_disputes: Omit<GeneratedTables["payment_disputes"], "Insert" | "Update"> & {
    Insert: never;
    Update: never;
  };
  profiles: Omit<GeneratedTables["profiles"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["profiles"]["Row"], ProfilesRow>;
    Insert: ApplyOverride<GeneratedTables["profiles"]["Insert"], ProfilesWrite>;
    Update: ApplyOverride<GeneratedTables["profiles"]["Update"], ProfilesWrite>;
  };
  reservations: Omit<GeneratedTables["reservations"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["reservations"]["Row"], ReservationsRow>;
    Insert: ApplyOverride<GeneratedTables["reservations"]["Insert"], ReservationsWrite>;
    Update: ApplyOverride<GeneratedTables["reservations"]["Update"], ReservationsWrite>;
  };
  events: Omit<GeneratedTables["events"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["events"]["Row"], EventsRow>;
    Insert: ApplyOverride<GeneratedTables["events"]["Insert"], EventsWrite>;
    Update: ApplyOverride<GeneratedTables["events"]["Update"], EventsWrite>;
  };
  programs: Omit<GeneratedTables["programs"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["programs"]["Row"], ProgramsRow>;
    Insert: ApplyOverride<GeneratedTables["programs"]["Insert"], ProgramsInsert>;
    Update: ApplyOverride<GeneratedTables["programs"]["Update"], ProgramsUpdate>;
  };
  program_enrollments: Omit<GeneratedTables["program_enrollments"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["program_enrollments"]["Row"], ProgramEnrollmentsRow>;
    Insert: ApplyOverride<GeneratedTables["program_enrollments"]["Insert"], ProgramEnrollmentsInsert>;
    Update: ApplyOverride<GeneratedTables["program_enrollments"]["Update"], ProgramEnrollmentsUpdate>;
  };
  event_guests: Omit<GeneratedTables["event_guests"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["event_guests"]["Row"], EventGuestsRow>;
    Insert: ApplyOverride<GeneratedTables["event_guests"]["Insert"], EventGuestsWrite>;
    Update: ApplyOverride<GeneratedTables["event_guests"]["Update"], EventGuestsWrite>;
  };
  event_participants: Omit<GeneratedTables["event_participants"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["event_participants"]["Row"], EventParticipantsRow>;
    Insert: ApplyOverride<GeneratedTables["event_participants"]["Insert"], EventParticipantsWrite>;
    Update: ApplyOverride<GeneratedTables["event_participants"]["Update"], EventParticipantsWrite>;
  };
  notification_deliveries: Omit<GeneratedTables["notification_deliveries"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["notification_deliveries"]["Row"], NotificationDeliveriesRow>;
    Insert: ApplyOverride<GeneratedTables["notification_deliveries"]["Insert"], NotificationDeliveriesInsert>;
    Update: ApplyOverride<GeneratedTables["notification_deliveries"]["Update"], NotificationDeliveriesUpdate>;
  };
  club_invites: Omit<GeneratedTables["club_invites"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["club_invites"]["Row"], ClubInvitesRow>;
    Insert: ApplyOverride<GeneratedTables["club_invites"]["Insert"], ClubInvitesWrite>;
    Update: ApplyOverride<GeneratedTables["club_invites"]["Update"], ClubInvitesWrite>;
  };
  lesson_requests: Omit<GeneratedTables["lesson_requests"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["lesson_requests"]["Row"], LessonRequestsRow>;
    Insert: ApplyOverride<GeneratedTables["lesson_requests"]["Insert"], LessonRequestsWrite>;
    Update: ApplyOverride<GeneratedTables["lesson_requests"]["Update"], LessonRequestsWrite>;
  };
  lesson_types: Omit<GeneratedTables["lesson_types"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["lesson_types"]["Row"], LessonTypesRow>;
    Insert: ApplyOverride<GeneratedTables["lesson_types"]["Insert"], LessonTypesWrite>;
    Update: ApplyOverride<GeneratedTables["lesson_types"]["Update"], LessonTypesWrite>;
  };
  roster_members: Omit<GeneratedTables["roster_members"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["roster_members"]["Row"], RosterMembersRow>;
    Insert: ApplyOverride<GeneratedTables["roster_members"]["Insert"], RosterMembersWrite>;
    Update: ApplyOverride<GeneratedTables["roster_members"]["Update"], RosterMembersWrite>;
  };
  waiver_versions: Omit<GeneratedTables["waiver_versions"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["waiver_versions"]["Row"], WaiverVersionsRow>;
    Insert: ApplyOverride<GeneratedTables["waiver_versions"]["Insert"], WaiverVersionsWrite>;
    Update: ApplyOverride<GeneratedTables["waiver_versions"]["Update"], WaiverVersionsWrite>;
  };
  pilot_inquiries: Omit<GeneratedTables["pilot_inquiries"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["pilot_inquiries"]["Row"], PilotInquiriesRow>;
    Insert: ApplyOverride<GeneratedTables["pilot_inquiries"]["Insert"], PilotInquiriesInsert>;
    Update: ApplyOverride<GeneratedTables["pilot_inquiries"]["Update"], PilotInquiriesUpdate>;
  };
  calendar_feed_tokens: Omit<GeneratedTables["calendar_feed_tokens"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["calendar_feed_tokens"]["Row"], CalendarFeedTokensRow>;
    Insert: ApplyOverride<GeneratedTables["calendar_feed_tokens"]["Insert"], CalendarFeedTokensInsert>;
    Update: ApplyOverride<GeneratedTables["calendar_feed_tokens"]["Update"], CalendarFeedTokensUpdate>;
  };
  notifications: Omit<GeneratedTables["notifications"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["notifications"]["Row"], NotificationsRow>;
    Insert: ApplyOverride<GeneratedTables["notifications"]["Insert"], NotificationsInsertRequired>;
    Update: ApplyOverride<GeneratedTables["notifications"]["Update"], NotificationsUpdateOptional>;
  };
  notification_preferences: Omit<GeneratedTables["notification_preferences"], "Row" | "Insert" | "Update"> & {
    Row: ApplyOverride<GeneratedTables["notification_preferences"]["Row"], NotificationsRow>;
    Insert: ApplyOverride<GeneratedTables["notification_preferences"]["Insert"], NotificationsInsertRequired>;
    Update: ApplyOverride<GeneratedTables["notification_preferences"]["Update"], NotificationsUpdateOptional>;
  };
};

// ─────────────────────────────────────────────────────────────────────────
// Function overrides.
//
// Two evidence-backed categories:
//
//   A. REQUIRED-BUT-NULLABLE Args. The blanket WidenOptionalArgsToNullable
//      rule above only widens OPTIONAL (`?`) parameters — it cannot detect
//      a REQUIRED parameter that is nonetheless genuinely nullable (no SQL
//      default, but the function body still branches on `is null`, or the
//      app has always passed `null` through it). The generator gives no
//      structural signal to find these automatically; every one below was
//      found by actually adopting the generated file and fixing every
//      resulting compile error against real call sites — this is believed
//      to be the full set as of this checkpoint, not a partial sample.
//   B. RETURNS literal-union corrections, for the same reason as the Table
//      overrides above (CHECK-constrained domains the generator can only
//      type as `string`), applied to composite RETURNS TABLE(...) shapes
//      instead of table columns.
//
// Verified by comparing database.types.ts against each RPC's live SQL
// signature and, where applicable, its actual application call site.
// ─────────────────────────────────────────────────────────────────────────

// Shared literal unions, reused across multiple RPCs returning the same
// domain value (kept as named aliases here so each is written once).
type PaymentLedgerStatus =
  | "unpaid"
  | "partially_paid"
  | "paid"
  | "overpaid"
  | "partially_refunded"
  | "refunded"
  | "waived"
  | "void";
type RefundAttemptStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
type MemberWaiverStatus = "not_required" | "current" | "outdated" | "never_accepted";
type MembershipStatus = "active" | "inactive" | "suspended" | "non_member";
type CardPaymentsStatus = "active" | "pending" | "restricted" | "unsupported";
type ProgramEnrollmentRowStatus = "enrolled" | "waitlisted" | "offered" | "cancelled";

/** Applies a Returns override to a function whose Returns is `Row[]`.
 * Uses indexed access (`Fn["Returns"][number]`), not `extends {Returns:
 * (infer Row)[]}` — GeneratedFunctions' entries are intersection types
 * (from the blanket Args-widening mapped type above), and conditional-type
 * inference over an intersection does not reliably unwrap to the element
 * type; indexed access does. */
type OverrideArrayReturns<Fn extends { Returns: readonly unknown[] }, Override> = Omit<Fn, "Returns"> & {
  Returns: Array<ApplyOverride<Fn["Returns"][number], Override>>;
};
/** Same as OverrideArrayReturns, for a function whose Returns is a single
 * object (RETURNS a record, not RETURNS TABLE/SETOF — no `[]`). */
type OverrideReturns<Fn extends { Returns: object }, Override> = Omit<Fn, "Returns"> & {
  Returns: ApplyOverride<Fn["Returns"], Override>;
};
/** Applies an Args override to a function, leaving Returns untouched. Same
 * indexed-access reasoning as OverrideArrayReturns above. */
type OverrideArgs<Fn extends { Args: unknown; Returns: unknown }, Override> = {
  Args: ApplyOverride<Fn["Args"], Override>;
  Returns: Fn["Returns"];
};

// One shared status override, applied identically across every RPC that
// returns a program_enrollments row (all confirmed via database.types.ts to
// share this exact Returns shape).
type ProgramEnrollmentStatusOverride = { status: ProgramEnrollmentRowStatus };

type FunctionsOverride = {
  // ── Category A: required-but-nullable Args ──────────────────────────────
  // Live SQL (migration 0210) declares `p_recipient_user_ids uuid[]` with no
  // NOT NULL/default and explicitly branches on `is null`; the call site
  // (communicationsActions.ts) passes null for "all" mode.
  send_announcement_v2: OverrideArgs<
    GeneratedFunctions["send_announcement_v2"],
    { p_recipient_user_ids: string[] | null }
  >;
  // Same p_recipient_user_ids nullability fact, same "all" mode reason —
  // this is send_announcement_v2's own read-only preview counterpart
  // (0209), sharing its audience-mode contract exactly.
  preview_announcement_recipients: OverrideArgs<
    GeneratedFunctions["preview_announcement_recipients"],
    { p_recipient_user_ids: string[] | null }
  >;
  // mark_attendance/_roster_participant/_guest — p_attendance_status is
  // cleared back to null (no attendance recorded) as a normal, supported
  // action, not just set.
  mark_attendance: OverrideArgs<GeneratedFunctions["mark_attendance"], { p_attendance_status: string | null }>;
  mark_attendance_roster_participant: OverrideArgs<
    GeneratedFunctions["mark_attendance_roster_participant"],
    { p_attendance_status: string | null }
  >;
  mark_attendance_guest: OverrideArgs<
    GeneratedFunctions["mark_attendance_guest"],
    { p_attendance_status: string | null }
  >;
  // Price-override RPCs — null is the documented "clear the override, fall
  // back to the type/court default" input, not merely an omittable default.
  set_event_price_override: OverrideArgs<
    GeneratedFunctions["set_event_price_override"],
    { p_price_amount_cents: number | null }
  >;
  set_event_type_price: OverrideArgs<
    GeneratedFunctions["set_event_type_price"],
    { p_default_price_amount_cents: number | null }
  >;
  set_program_price: OverrideArgs<GeneratedFunctions["set_program_price"], { p_price_amount_cents: number | null }>;
  create_event_with_price_override: OverrideArgs<
    GeneratedFunctions["create_event_with_price_override"],
    { p_price_amount_cents: number | null }
  >;
  // set_member_notes — clearing the free-text notes field is null, not "".
  set_member_notes: OverrideArgs<GeneratedFunctions["set_member_notes"], { p_notes: string | null }>;
  // update_club_pricing — null means "no default court rate configured".
  update_club_pricing: OverrideArgs<
    GeneratedFunctions["update_club_pricing"],
    {
      p_default_court_hourly_rate_cents: number | null;
      p_default_court_hourly_rate_non_member_cents: number | null;
    }
  >;
  // upsert_court_rate_period — p_id null means "create a new period"; only
  // non-null on the edit-existing-period path.
  upsert_court_rate_period: OverrideArgs<
    GeneratedFunctions["upsert_court_rate_period"],
    { p_id: string | null }
  >;
  // cancel_member_lesson_confirmed — a cancellation reason is optional.
  cancel_member_lesson_confirmed: OverrideArgs<
    GeneratedFunctions["cancel_member_lesson_confirmed"],
    { p_reason: string | null }
  >;
  // set_court_hourly_rate — a non-member-rate-preserving call passes through
  // the current (possibly null/"no override set") member rate unchanged.
  set_court_hourly_rate: OverrideArgs<
    GeneratedFunctions["set_court_hourly_rate"],
    { p_hourly_rate_cents: number | null }
  >;
  // Stripe webhook processors — a PaymentIntent/evidence-due-by date may
  // genuinely be absent on the Stripe object being processed; the RPCs'
  // own bodies treat this as a valid, expected input (never guessed or
  // defaulted by the caller — see route.ts's own comments).
  process_stripe_payment_event: OverrideArgs<
    GeneratedFunctions["process_stripe_payment_event"],
    { p_stripe_payment_intent_id: string | null }
  >;
  // p_refund_attempt_id — resolved from an optional Stripe metadata key
  // (refund.metadata?.court_time_refund_attempt_id ?? null); genuinely
  // absent for a refund this app didn't initiate.
  process_stripe_refund_webhook_event: OverrideArgs<
    GeneratedFunctions["process_stripe_refund_webhook_event"],
    { p_stripe_payment_intent_id: string | null; p_refund_attempt_id: string | null }
  >;
  process_stripe_dispute_webhook_event: OverrideArgs<
    GeneratedFunctions["process_stripe_dispute_webhook_event"],
    { p_stripe_payment_intent_id: string | null; p_evidence_due_by: string | null }
  >;

  // ── Category B: Returns literal-union corrections ────────────────────────
  // Migration 0210's own comment documents genuine null cases for batch_id/
  // body; audience_mode is CHECK-constrained ('all'/'specific') like every
  // other domain column the generator can only type as `string`.
  get_communications_activity: OverrideArrayReturns<
    GeneratedFunctions["get_communications_activity"],
    { batch_id: string | null; body: string | null; audience_mode: "all" | "specific" }
  >;
  get_my_member_waiver_status: OverrideArrayReturns<
    GeneratedFunctions["get_my_member_waiver_status"],
    { status: MemberWaiverStatus }
  >;
  get_member_waiver_status: OverrideArrayReturns<
    GeneratedFunctions["get_member_waiver_status"],
    { status: MemberWaiverStatus }
  >;
  get_members: OverrideArrayReturns<GeneratedFunctions["get_members"], { membership_status: MembershipStatus | null }>;
  // Same nullable-membership fields as get_members, plus the FK id/name
  // pair (migration 0191) — a member need not have a membership type
  // assigned at all.
  get_admin_member_detail: OverrideArrayReturns<
    GeneratedFunctions["get_admin_member_detail"],
    {
      membership_status: MembershipStatus | null; // 0191 — Phase 42C-3A
      membership_type_id: string | null; // 0191 — Phase 42C-3A
      membership_type_name: string | null; // 0191 — Phase 42C-3A
    }
  >;
  get_roster_members: OverrideArrayReturns<
    GeneratedFunctions["get_roster_members"],
    { membership_status: MembershipStatus }
  >;
  // unresolved_prior is itself an array of small ledger-status rows nested
  // inside the outer Returns row — the generator can only see it as opaque
  // Json (a jsonb-aggregated sub-array in the SQL body, not a flat RETURNS
  // TABLE column), so its element shape needs the same treatment as the
  // outer row, applied by hand since it's one level deeper than
  // OverrideArrayReturns reaches.
  get_payment_states_for_domains: OverrideArrayReturns<
    GeneratedFunctions["get_payment_states_for_domains"],
    {
      current_status: PaymentLedgerStatus;
      unresolved_prior: {
        payment_id: string;
        obligation_cycle: number;
        amount_due_cents: number;
        amount_paid_cents: number;
        currency: string;
        status: string;
      }[];
    }
  >;
  get_club_stripe_connect_status: OverrideArrayReturns<
    GeneratedFunctions["get_club_stripe_connect_status"],
    { card_payments_status: CardPaymentsStatus }
  >;
  // begin_refund_request_execution's own Returns shape is identical to
  // open_payment_refund_attempt's (refundActions.ts's own comment) — both
  // feed the same shared executeOnlineRefund tail.
  open_payment_refund_attempt: OverrideArrayReturns<
    GeneratedFunctions["open_payment_refund_attempt"],
    { status: RefundAttemptStatus }
  >;
  begin_refund_request_execution: OverrideArrayReturns<
    GeneratedFunctions["begin_refund_request_execution"],
    { status: RefundAttemptStatus }
  >;
  get_pending_refund_requests_for_payments: OverrideArrayReturns<
    GeneratedFunctions["get_pending_refund_requests_for_payments"],
    { attempt_status: RefundAttemptStatus | null }
  >;
  // Every RPC below returns a program_enrollments row — same override,
  // applied once per function (see ProgramEnrollmentStatusOverride above).
  join_program: OverrideReturns<GeneratedFunctions["join_program"], ProgramEnrollmentStatusOverride>;
  leave_program: OverrideReturns<GeneratedFunctions["leave_program"], ProgramEnrollmentStatusOverride>;
  accept_program_waitlist_offer: OverrideReturns<
    GeneratedFunctions["accept_program_waitlist_offer"],
    ProgramEnrollmentStatusOverride
  >;
  decline_program_waitlist_offer: OverrideReturns<
    GeneratedFunctions["decline_program_waitlist_offer"],
    ProgramEnrollmentStatusOverride
  >;
  add_program_member: OverrideReturns<
    GeneratedFunctions["add_program_member"],
    ProgramEnrollmentStatusOverride
  >;
  remove_program_member: OverrideReturns<
    GeneratedFunctions["remove_program_member"],
    ProgramEnrollmentStatusOverride
  >;
  add_program_roster_member: OverrideReturns<
    GeneratedFunctions["add_program_roster_member"],
    ProgramEnrollmentStatusOverride
  >;
  remove_program_roster_member: OverrideReturns<
    GeneratedFunctions["remove_program_roster_member"],
    ProgramEnrollmentStatusOverride
  >;
  force_confirm_program_roster_member: OverrideReturns<
    GeneratedFunctions["force_confirm_program_roster_member"],
    ProgramEnrollmentStatusOverride
  >;

  // add_member_note/update_member_note needed NO override as of Phase
  // 45C1A — see the TablesOverride comment above for the full resolution.
  // Their Args now correctly flow through as generated (p_body).
  // get_member_notes needs one narrow Returns correction, immediately
  // below.
  //
  // add_member_note's Returns is genuinely weaker in generated output than
  // it needs to be, though: the live function returns `json` (opaque to
  // Postgres' own type system — a SQL `json`/`jsonb` return type carries no
  // structural information for any tool to introspect), so generation can
  // only ever report `Json`. Migration 0211's `add_member_note` body
  // constructs its `json_build_object(...)` result from an explicit,
  // fixed field list — every member_notes column except `club_id` — so
  // that exact field list is narrowly refined here, DERIVED from
  // GeneratedTables["member_notes"]["Row"] via Pick (not manually retyped)
  // so it can never drift from the table's own real column types, and
  // does NOT claim club_id is present, matching migration 0211's
  // json_build_object call exactly.
  // Not expressed via OverrideReturns (that helper merges the override into
  // Fn["Returns"] with ApplyOverride, which only makes sense against an
  // existing object/array shape — generated Returns here is the generic
  // `Json` scalar union, since a SQL `json` return type carries no
  // structural information to introspect). This replaces Returns wholesale
  // instead of refining it.
  add_member_note: Omit<GeneratedFunctions["add_member_note"], "Returns"> & {
    Returns: Pick<
      GeneratedTables["member_notes"]["Row"],
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
    >;
  };

  // get_member_notes (RETURNS TABLE, migration 0132) — the generator
  // reports author_id/archived_at/archived_by as non-null `string`, but
  // these are the SAME three member_notes columns that are genuinely
  // nullable on the table itself (author_id: the author's profile may have
  // been deleted since; archived_at/archived_by: null for any note that
  // has never been archived). This is the same RETURNS-TABLE-nullability
  // generator limitation documented at the top of this file, corrected
  // here narrowly for just these three fields, DERIVED from
  // GeneratedTables["member_notes"]["Row"] via Pick (not manually retyped)
  // so it can never drift from the table's own real nullability. Every
  // other generated field — including the computed `author_name` (a
  // coalesce over a LEFT JOIN, not a table column) — flows through
  // unmodified via OverrideArrayReturns/ApplyOverride. Args are untouched
  // (OverrideArrayReturns only replaces Returns).
  get_member_notes: OverrideArrayReturns<
    GeneratedFunctions["get_member_notes"],
    Pick<GeneratedTables["member_notes"]["Row"], "author_id" | "archived_at" | "archived_by">
  >;

  // restore_member_note needed NO override as of Phase 45C1A3 — migration
  // 0212 is now applied and database.types.ts regenerated, so it flows
  // through from GeneratedFunctions unmodified: { Args: { p_note_id: string
  // }; Returns: undefined }, the exact same shape the generator already
  // produces for archive_member_note (a `returns void` SQL function always
  // generates as `Returns: undefined`, never a hand-written `void`). The
  // Phase 45C1A2 forward declaration that stood in for this before 0212
  // existed live has been removed.

  // get_member_upcoming_activity/get_member_activity_history — Phase 45C1B.
  // The previous full hand-declared overrides here (Phase 45C1A debt)
  // modeled a stale, never-real flat shape (pro_first_name/pro_last_name,
  // proposed_starts_at/ends_at/court_name — none of these are actual raw
  // RPC columns) that existed only to keep the still-unfixed application
  // code compiling. Application code now reads activity rows through
  // normalizeMemberUpcomingActivity/normalizeMemberHistoryActivity
  // (src/app/(app)/admin/members/[id]/activityNormalization.ts), which
  // takes these RPCs' REAL raw generated row shape as input and safely
  // extracts the documented `details` jsonb keys itself — so
  // GeneratedFunctions' raw structure is now the accurate source of truth
  // and these no longer need a full override.
  //
  // Two narrow corrections remain genuinely necessary, both confirmed
  // directly against migration 0132's SQL, not guessed:
  //   1. `activity_type` is a three-way `'reservation'|'event'|'lesson'`
  //      text literal tag (each UNION ALL branch casts a string literal),
  //      which the generator — same as every other CHECK/literal-domain
  //      column in this file — can only ever type as plain `string`.
  //      Refined here so the normalizer needs no unsafe `as` cast to
  //      produce UpcomingItem/HistoryItem's own literal-union
  //      `activity_type` field.
  //   2. `attendance_status`/`outcome` are the same RETURNS-TABLE-
  //      nullability generator limitation already documented and
  //      corrected once for get_member_notes above: each branch of the
  //      UNION explicitly selects `null::text as attendance_status` (every
  //      branch except event) or `null::text as outcome` (every branch
  //      except lesson) — genuinely nullable per-row, but the generator
  //      reports both as non-null `string` regardless.
  get_member_upcoming_activity: OverrideArrayReturns<
    GeneratedFunctions["get_member_upcoming_activity"],
    {
      activity_type: "reservation" | "event" | "lesson";
      attendance_status: string | null;
      outcome: string | null;
    }
  >;
  get_member_activity_history: OverrideArrayReturns<
    GeneratedFunctions["get_member_activity_history"],
    {
      activity_type: "reservation" | "event" | "lesson";
      attendance_status: string | null;
      outcome: string | null;
    }
  >;
};

// ─────────────────────────────────────────────────────────────────────────
// Assembled Database type — everything not explicitly overridden above
// flows straight through from the generated structure, including
// __InternalSupabase, Views, Enums, CompositeTypes, Relationships, and
// every table/function this file doesn't mention at all.
// ─────────────────────────────────────────────────────────────────────────

export type Database = Omit<GeneratedDatabase, "public"> & {
  public: Omit<GeneratedDatabase["public"], "Tables" | "Functions"> & {
    Tables: Omit<GeneratedTables, keyof TablesOverride> & TablesOverride;
    Functions: Omit<GeneratedFunctions, keyof FunctionsOverride> & FunctionsOverride;
  };
};
