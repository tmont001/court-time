// Plain (non-"use server") module. admin/events/actions.ts has a top-level
// "use server" directive, which requires every exported top-level binding to
// be an async Server Action — so the shared select string and the
// synchronous row-mapping helper below cannot live there. Both the initial
// server-side query in events/page.tsx and actions.ts' own
// fetchMoreAdminEvents reload import from this file instead, which is what
// keeps the two query shapes from drifting apart.

// Raw shape returned by the events query (reservations nested for court_id
// derivation — mirrors CalendarShell's own RawEventRow/EventWithDetails split).
export interface RawAdminEventRow {
  id:                        string;
  title:                     string;
  starts_at:                 string;
  ends_at:                   string;
  capacity:                  number;
  status:                    string;
  created_by:                string;
  member_joinable:           boolean;
  archived_at:               string | null;
  archived_by:               string | null;
  event_type_id:             string;
  description:               string | null;
  updated_at:                string;
  program_id:                string | null;
  program_schedule_rule_id:  string | null;
  program_occurrence_date:   string | null;
  is_program_exception:      boolean;
  event_types:               { key: string; label: string; color: string } | null;
  event_participants:        Array<{ profile_id: string | null; role: string; status: string }>;
  // Phase 33E2: status distinguishes an active guest (occupies capacity)
  // from a soft-cancelled one (does not).
  event_guests:               Array<{ id: string; status: string }>;
  reservations:               Array<{ court_id: string; status: string; reason: string }> | null;
  // Phase 34C: required by EditEventSheet's now-folded-in Event Price field.
  price_amount_cents:        number | null;
}

export type AdminEventRow = {
  id:                        string;
  title:                     string;
  starts_at:                 string;
  ends_at:                   string;
  capacity:                  number;
  status:                    string;
  created_by:                string;
  member_joinable:           boolean;
  archived_at:               string | null;
  archived_by:               string | null;
  // Phase 30C2: additional fields required by EditEventSheet.
  event_type_id:             string;
  description:               string | null;
  updated_at:                string;
  program_id:                string | null;
  program_schedule_rule_id:  string | null;
  program_occurrence_date:   string | null;
  is_program_exception:      boolean;
  court_ids:                 string[];
  event_types:               { key: string; label: string; color: string } | null;
  event_participants:        Array<{ profile_id: string | null; role: string; status: string }>;
  // Phase 33E2: status distinguishes an active guest (occupies capacity)
  // from a soft-cancelled one (does not).
  event_guests:               Array<{ id: string; status: string }>;
  // Phase 34C: required by EditEventSheet's now-folded-in Event Price field.
  price_amount_cents:        number | null;
};

// Phase 30C2 fix: the exact set of columns every AdminEventRow consumer
// (initial server-side query in events/page.tsx, and fetchMoreAdminEvents'
// reload query) must select — kept in one place so the two query shapes
// cannot silently drift apart again the way the initial query did (it was
// missing event_type_id/description/updated_at/program_id/
// is_program_exception/reservations entirely, so EditEventSheet received an
// event with court_ids undefined and crashed).
export const ADMIN_EVENT_SELECT = `
  id, title, starts_at, ends_at, capacity, status, created_by, member_joinable,
  archived_at, archived_by, event_type_id, description, updated_at, price_amount_cents,
  program_id, program_schedule_rule_id, program_occurrence_date, is_program_exception,
  event_types(key, label, color),
  event_participants(profile_id, role, status),
  event_guests(id, status),
  reservations(court_id, status, reason)
`;

// Derives court_ids from linked reservations the same way everywhere:
// reason='event' and status='confirmed' — the only reservation status the
// rest of the app (CalendarShell, EventsUpcomingClient, my-schedule, etc.)
// treats as an active event-court booking. `reservations` is defensively
// treated as possibly missing/non-array rather than trusted from its type,
// since a raw Supabase row is a runtime value, not a compile-time guarantee.
export function mapAdminEventRow(r: RawAdminEventRow): AdminEventRow {
  const { reservations, ...rest } = r;
  return {
    ...rest,
    court_ids: (Array.isArray(reservations) ? reservations : [])
      .filter(res => res.reason === "event" && res.status === "confirmed")
      .map(res => res.court_id),
  };
}
