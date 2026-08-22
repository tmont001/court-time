-- 0143_payment_mode_and_ledger_foundation.sql
-- Phase 34C — Payment Modes + Payment Ledger Foundation.
--
-- Scope of this migration: no existing booking/event/program/Lesson RPC is
-- redefined here, and no historical payment rows are backfilled. It DOES
-- alter club_settings (adds payment_mode, adds a currency-lock trigger —
-- see section 6). payment_mode defaults to 'none', and nothing in
-- 0001-0142 ever calls the obligation-creation helper added here, so this
-- migration is behaviorally inert for every existing scheduling flow: no
-- payments/payment_events rows can be produced by 0143 alone.
--
-- A companion migration, 0144_payment_obligation_wiring.sql, will thread
-- calls to the helpers defined here (_create_payment_obligation,
-- _adjust_payment_obligation, _check_member_reassignment_allowed) into the
-- 17 existing booking/roster RPCs so that obligations actually get created
-- as bookings are confirmed. 0144 is NOT part of this migration and is
-- currently BLOCKED — see the accompanying report. Every existing function
-- 0144 will touch must be redefined from an authoritative Production
-- pg_get_functiondef() export, never reconstructed from migration history,
-- so 0144 cannot be written until that export is supplied.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. club_settings.payment_mode
-- ═══════════════════════════════════════════════════════════════════════════
-- 'none'                 — no payment tracking; no obligations are ever
--                           created while a domain row is confirmed under
--                           this mode.
-- 'manual'                — Admin/Staff record payments received outside
--                           the app (cash, check, card terminal, etc.);
--                           obligations are created for positive-price
--                           confirmations. The ONLY mode 0143's
--                           obligation-creation helper acts on — see
--                           section 7.
-- 'court_time_payments'   — reserved for a future in-app processor
--                           integration (34D+). Accepted by the CHECK
--                           constraint so the column can represent it once
--                           built, but update_club_payment_mode() below
--                           explicitly refuses to set it, and
--                           _create_payment_obligation() explicitly
--                           refuses to create obligations under it — there
--                           is no processor integration yet.
alter table public.club_settings
  add column payment_mode text not null default 'none'
    check (payment_mode in ('none', 'manual', 'court_time_payments'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. payments — current-state row per obligation cycle
-- ═══════════════════════════════════════════════════════════════════════════
-- One row per (domain_type, domain_id, obligation_cycle). A domain
-- commitment gets a new cycle each time it transitions into a priced,
-- confirmed state from a state that had no live obligation (first
-- confirmation, or reactivation after cancellation) — never one row
-- reused forever, because event_participants and program_enrollments can
-- cancel and later reactivate the same row in place, and each such episode
-- is a financially distinct commitment.
--
-- No money-movement fields live here (no amount actually collected, no
-- method, no external reference) — those belong exclusively to
-- payment_events. This table only holds the current rollup derived from
-- that ledger, maintained by a trigger, never written to directly by RPCs.
create table public.payments (
  id                     uuid        primary key default gen_random_uuid(),
  club_id                uuid        not null references public.clubs(id) on delete cascade,

  domain_type            text        not null
                            check (domain_type in (
                              'reservation', 'lesson_request', 'event_participant',
                              'event_guest', 'program_enrollment'
                            )),
  domain_id              uuid        not null,
  obligation_cycle       integer     not null check (obligation_cycle > 0),

  -- Financial identity snapshot, captured once at obligation-creation time
  -- from the domain row's roster_member_id at that moment. Never updated
  -- afterward and never re-derived from the current domain row, because
  -- update_member_reservation / admin_update_member_lesson can reassign the
  -- Member on an existing row — a historical payment must never silently
  -- become a different Member's payment merely because the underlying
  -- booking was reassigned. NULL only for domain_type = 'event_guest',
  -- whose payer identity is unresolved by design (a guest is not a roster
  -- Member), never invented. Structurally enforced below.
  roster_member_id       uuid        references public.roster_members(id),

  amount_due_cents       integer     not null default 0 check (amount_due_cents >= 0),
  amount_paid_cents      integer     not null default 0 check (amount_paid_cents >= 0),
  currency               text        not null check (currency ~ '^[A-Z]{3}$'),

  status                 text        not null default 'unpaid'
                            check (status in (
                              'unpaid', 'partially_paid', 'paid', 'overpaid',
                              'partially_refunded', 'refunded', 'waived', 'void'
                            )),

  -- The club's payment_mode at the moment this obligation was created.
  -- Always 'manual' or 'court_time_payments' — an obligation is never
  -- created while the club's mode is 'none'. 0143's own creation helper
  -- only ever writes 'manual' here (see section 7); 'court_time_payments'
  -- remains a valid stored value for forward-compatibility once 34D
  -- widens the helper, but nothing in 0143 produces it.
  payment_mode_at_creation text      not null
                            check (payment_mode_at_creation in ('manual', 'court_time_payments')),

  created_by             uuid        references public.profiles(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  unique (domain_type, domain_id, obligation_cycle),
  -- Composite-FK target for payment_events below — a hard database
  -- invariant that a payment_event can never reference a payment in a
  -- different club, not merely an RPC-discipline convention.
  unique (id, club_id),

  -- Financial identity integrity: an event_guest payer is unresolved by
  -- design and must never be assigned a roster identity; every other
  -- supported domain has a real Member behind it and must always be
  -- snapshotted. A cross-club roster_member_id is additionally rejected
  -- inside _create_payment_obligation (section 7), since that requires a
  -- lookup this CHECK alone cannot express.
  constraint payments_roster_member_identity_shape check (
    (domain_type = 'event_guest' and roster_member_id is null)
    or (domain_type <> 'event_guest' and roster_member_id is not null)
  )
);

create index payments_domain_idx on public.payments (domain_type, domain_id);
create index payments_club_idx on public.payments (club_id);
create index payments_roster_member_idx on public.payments (roster_member_id) where roster_member_id is not null;

create trigger payments_updated_at
  before update on public.payments
  for each row execute function public.trigger_set_updated_at();

grant select on public.payments to authenticated;

alter table public.payments enable row level security;

create policy "payments_select_admin_staff"
  on public.payments for select
  using (
    club_id = public.current_user_club_id()
    and public.current_user_role() in ('admin', 'staff')
  );
-- Admin/Staff only. No direct payments SELECT for Member or Pro — even
-- though payments rows only carry rollup state (no raw ledger detail),
-- direct table access would leak the netting/prior-cycle-shape decisions
-- that get_payment_states_for_domains deliberately encodes (e.g. never
-- netting separate cycles together, hiding resolved prior cycles, never
-- surfacing prior financial history to a Pro at all). Member/Pro consume
-- payment state exclusively through that sanitized SECURITY DEFINER RPC
-- (section 16) — one read model, not two. No insert/update/delete
-- policies either way: all writes go through the SECURITY DEFINER RPCs
-- below, which run as their owner and are not subject to RLS; direct
-- client mutation is impossible regardless, since authenticated only has
-- table-level SELECT granted above.

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. payment_events — append-only canonical ledger
-- ═══════════════════════════════════════════════════════════════════════════
-- Every financial fact lives here and nowhere else. payments.* is always a
-- derived rollup of this table, recomputed by trigger on insert.
create table public.payment_events (
  id                 uuid        primary key default gen_random_uuid(),
  payment_id         uuid        not null references public.payments(id),
  club_id            uuid        not null references public.clubs(id) on delete cascade,

  event_type         text        not null
                        check (event_type in (
                          'obligation_created',
                          'obligation_amount_adjusted',
                          'manual_payment_recorded',
                          'refund_recorded',
                          'reverse_payment_event',
                          'void_payment_obligation',
                          'waived'
                        )),

  -- Meaning depends on event_type: the obligation amount for
  -- obligation_created/obligation_amount_adjusted; the amount collected for
  -- manual_payment_recorded; the amount returned for refund_recorded; the
  -- amount waived for waived; the amount that was due for
  -- void_payment_obligation. NULL for reverse_payment_event, which carries
  -- no amount of its own — it nullifies whatever amount its target event
  -- already recorded. obligation_amount_adjusted is the one type allowed
  -- to be exactly 0 — a price edited down to $0 on an existing obligation
  -- must be representable as a real "no balance due" state, not force a
  -- void or forbid the edit.
  amount_cents       integer,

  -- Money-movement detail. Only meaningful for manual_payment_recorded /
  -- refund_recorded; NULL otherwise (enforced by the shape constraint
  -- below).
  method             text        check (method is null or method in (
                        'cash', 'check', 'card_terminal', 'bank_transfer',
                        'digital_wallet', 'other'
                      )),
  external_reference text,
  notes              text,

  -- Reversal linkage. Only set (and only meaningful) for
  -- event_type = 'reverse_payment_event'; validated by trigger below.
  reverses_event_id  uuid        references public.payment_events(id),

  actor_id           uuid        references public.profiles(id),

  -- occurred_at: the effective date/time of the money movement (may be
  -- backdated by whoever records it, e.g. "the check cleared last
  -- Tuesday"). created_at: when the ledger row was actually inserted.
  -- Deliberately two different timestamps — never collapse them.
  occurred_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),

  foreign key (payment_id, club_id) references public.payments(id, club_id),

  -- Structural event shape: what each event_type is and is not allowed to
  -- carry. A CASE without an ELSE would make an unmatched event_type pass
  -- (a CHECK treats a NULL result as satisfied) — the explicit `else
  -- false` closes that gap, even though the event_type CHECK above already
  -- restricts values to the 7 branches below.
  constraint payment_events_shape check (
    case event_type
      when 'obligation_created' then
        amount_cents is not null and amount_cents > 0
          and method is null and reverses_event_id is null
          and external_reference is null
      when 'obligation_amount_adjusted' then
        amount_cents is not null and amount_cents >= 0
          and method is null and reverses_event_id is null
          and external_reference is null
      when 'manual_payment_recorded' then
        amount_cents is not null and amount_cents > 0
          and method is not null and reverses_event_id is null
      when 'refund_recorded' then
        amount_cents is not null and amount_cents > 0
          and reverses_event_id is null
      when 'reverse_payment_event' then
        amount_cents is null and method is null and external_reference is null
          and reverses_event_id is not null
      when 'waived' then
        amount_cents is not null and amount_cents > 0
          and method is null and reverses_event_id is null
          and external_reference is null
      when 'void_payment_obligation' then
        amount_cents is not null and amount_cents > 0
          and method is null and reverses_event_id is null
          and external_reference is null
      else false
    end
  )
);

-- At most one reversal per target event (a partial unique index, not a
-- CHECK, since it spans rows).
create unique index payment_events_reverses_event_id_uniq
  on public.payment_events (reverses_event_id)
  where reverses_event_id is not null;

create index payment_events_payment_idx on public.payment_events (payment_id);
create index payment_events_club_idx on public.payment_events (club_id);

grant select on public.payment_events to authenticated;

alter table public.payment_events enable row level security;

-- Admin/Staff only. payment_events carries operational ledger detail
-- (method, external_reference, notes, actor/reversal linkage) that Member
-- and Pro must never see directly — they consume payment state exclusively
-- through get_payment_states_for_domains (section 16), which returns only
-- sanitized rollup fields. Deliberately no payment_events policy for
-- 'pro' or 'member' at all — RLS denies by default with no matching
-- policy.
create policy "payment_events_select_admin_staff"
  on public.payment_events for select
  using (
    club_id = public.current_user_club_id()
    and public.current_user_role() in ('admin', 'staff')
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Reversal-integrity validation trigger
-- ═══════════════════════════════════════════════════════════════════════════
-- Enforces the cross-row rules the shape CHECK above cannot express: the
-- reversal target must exist, belong to the same payment, not be the new
-- row itself, and be one of exactly the two reversible event types. The
-- "at most once" rule is enforced separately by the partial unique index
-- above.
create or replace function public._validate_payment_event_reversal()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_target public.payment_events%rowtype;
begin
  if new.event_type <> 'reverse_payment_event' then
    return new;
  end if;

  if new.reverses_event_id = new.id then
    raise exception 'cannot_reverse_self';
  end if;

  select * into v_target from public.payment_events where id = new.reverses_event_id;
  if not found then
    raise exception 'reversal_target_not_found';
  end if;

  if v_target.payment_id <> new.payment_id then
    raise exception 'reversal_target_mismatched_payment';
  end if;

  if v_target.event_type not in ('manual_payment_recorded', 'refund_recorded') then
    raise exception 'event_type_not_reversible';
  end if;

  return new;
end;
$$;

create trigger payment_events_validate_reversal
  before insert on public.payment_events
  for each row execute function public._validate_payment_event_reversal();

revoke all on function public._validate_payment_event_reversal() from public;
-- Safe to revoke from PUBLIC: trigger firing is system-invoked and does
-- not require its own EXECUTE privilege check.

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Rollup trigger — recomputes payments.{amount_due,amount_paid,status}
-- ═══════════════════════════════════════════════════════════════════════════
-- Status precedence (highest wins): void > waived > overpaid >
-- refunded/partially_refunded (if any non-reversed refund exists) >
-- paid/partially_paid/unpaid (by net-vs-due comparison). Refunded and
-- partially_refunded are tracked as a distinct branch — not purely derived
-- from the numeric net-vs-due comparison — because a fully refunded
-- payment (net = 0) must read as "refunded", not "unpaid", even though the
-- raw numbers alone can't tell those two apart. A due amount adjusted to
-- exactly 0 with nothing paid falls through to 'unpaid' (v_net <= v_due,
-- both 0) — that is intentional: it is presented as "No balance due" by
-- the UI layer (not built yet) purely from amount_due_cents = 0, not from
-- a distinct status value.
create or replace function public._recompute_payment_rollup(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_due    integer;
  v_net    integer;
  v_has_refund boolean;
  v_void   boolean;
  v_waived boolean;
  v_status text;
begin
  select amount_cents into v_due
    from public.payment_events
   where payment_id = p_payment_id
     and event_type in ('obligation_created', 'obligation_amount_adjusted')
     and id not in (
       select reverses_event_id from public.payment_events where reverses_event_id is not null
     )
   order by created_at desc, id desc
   limit 1;
  v_due := coalesce(v_due, 0);

  select
    coalesce(sum(amount_cents) filter (where event_type = 'manual_payment_recorded'), 0)
    - coalesce(sum(amount_cents) filter (where event_type = 'refund_recorded'), 0)
    into v_net
    from public.payment_events
   where payment_id = p_payment_id
     and id not in (
       select reverses_event_id from public.payment_events where reverses_event_id is not null
     );
  v_net := coalesce(v_net, 0);

  select exists(
    select 1 from public.payment_events
     where payment_id = p_payment_id and event_type = 'refund_recorded'
       and id not in (
         select reverses_event_id from public.payment_events where reverses_event_id is not null
       )
  ) into v_has_refund;

  select exists(
    select 1 from public.payment_events
     where payment_id = p_payment_id and event_type = 'void_payment_obligation'
       and id not in (
         select reverses_event_id from public.payment_events where reverses_event_id is not null
       )
  ) into v_void;

  select exists(
    select 1 from public.payment_events
     where payment_id = p_payment_id and event_type = 'waived'
       and id not in (
         select reverses_event_id from public.payment_events where reverses_event_id is not null
       )
  ) into v_waived;

  if v_void then
    v_status := 'void';
  elsif v_waived then
    v_status := 'waived';
  elsif v_net > v_due then
    v_status := 'overpaid';
  elsif v_has_refund then
    if v_net <= 0 then
      v_status := 'refunded';
    elsif v_net < v_due then
      v_status := 'partially_refunded';
    else
      v_status := 'paid';
    end if;
  else
    if v_net <= 0 then
      v_status := 'unpaid';
    elsif v_net < v_due then
      v_status := 'partially_paid';
    else
      v_status := 'paid';
    end if;
  end if;

  update public.payments
     set amount_due_cents = v_due,
         amount_paid_cents = v_net,
         status = v_status
   where id = p_payment_id;
end;
$$;

create or replace function public._payment_events_after_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  perform public._recompute_payment_rollup(new.payment_id);
  return new;
end;
$$;

create trigger payment_events_after_insert
  after insert on public.payment_events
  for each row execute function public._payment_events_after_insert();

revoke all on function public._recompute_payment_rollup(uuid) from public;
revoke all on function public._payment_events_after_insert() from public;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Currency lock on payment history
-- ═══════════════════════════════════════════════════════════════════════════
-- 34B's update_club_pricing already refuses a currency change once any
-- positive price exists anywhere in the club (0142). That check predates
-- payments and knows nothing about it. This is a second, independent
-- guard: once ANY payment obligation exists for a club (regardless of its
-- current amount or status — even a fully refunded/voided one is real
-- financial history), a currency change is rejected here too, no matter
-- which function attempts it. Reuses the exact 'currency_locked_by_pricing'
-- error string from 0142 so no new client-side error branch is needed.
-- Deliberately a structural trigger here in 0143, not a redefinition of
-- update_club_pricing from historical migration text.
create or replace function public._enforce_currency_lock_on_payment_history()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.currency is distinct from old.currency then
    if exists (select 1 from public.payments where club_id = new.club_id) then
      raise exception 'currency_locked_by_pricing';
    end if;
  end if;
  return new;
end;
$$;

create trigger club_settings_currency_lock_on_payment_history
  before update on public.club_settings
  for each row execute function public._enforce_currency_lock_on_payment_history();

revoke all on function public._enforce_currency_lock_on_payment_history() from public;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Internal helper — _create_payment_obligation
-- ═══════════════════════════════════════════════════════════════════════════
-- Called by 0144's wiring (never directly by client code — not granted to
-- authenticated). Gates on price > 0 and payment_mode = 'manual' — in
-- 34C, court_time_payments is schema-reserved but not a functional
-- creation path; 34D will deliberately widen this gate when integrated
-- payments become real. Returns NULL (no-op) when either gate fails, so
-- every call site can call this unconditionally without its own gating
-- logic.
--
-- p_new_cycle distinguishes two call shapes:
--   false (NORMAL, the default) — idempotent "ensure the current
--     obligation exists" call. If the latest payment for this (club_id,
--     domain_type, domain_id) belongs to the SAME roster identity as
--     p_roster_member_id (IS NOT DISTINCT FROM, so NULL/NULL for
--     event_guest matches too), returns its id and creates nothing new —
--     a duplicate ordinary-confirmation call must not manufacture a
--     second financial cycle. If the latest payment belongs to a
--     DIFFERENT roster identity (a domain row was reassigned to a new
--     Member while unpriced, so no obligation was ever created for that
--     reassignment), it is a Member-liability boundary, not a duplicate —
--     a fresh cycle is allocated for the CURRENT identity instead of
--     reusing the prior Member's row. Only genuinely creates cycle 1 when
--     no payment exists at all yet.
--   true (EXPLICIT NEW CYCLE) — used only for a verified
--     cancelled -> reactivated commitment, or a Member reassignment onto
--     a domain row that has already been confirmed resolved with zero
--     retained money. Always allocates MAX(cycle)+1.
-- Cycle allocation is serialized per (domain_type, domain_id) via a
-- transaction-scoped advisory lock, with the
-- UNIQUE(domain_type, domain_id, obligation_cycle) constraint as a hard
-- backstop if that lock were ever bypassed by a future caller.
--
-- Financial identity is validated here, not merely by the table's shape
-- CHECK: for domain_type = 'event_guest', p_roster_member_id must be NULL;
-- for every other domain, it must be a real roster_members row belonging
-- to the SAME club as p_club_id — a cross-club roster identity must never
-- be snapshotted into a payment.
create or replace function public._create_payment_obligation(
  p_club_id          uuid,
  p_domain_type      text,
  p_domain_id        uuid,
  p_roster_member_id uuid,
  p_amount_cents     integer,
  p_actor_id         uuid,
  p_new_cycle        boolean default false
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_mode        text;
  v_currency    text;
  v_next_cycle  integer;
  v_payment_id  uuid;
  v_existing    public.payments%rowtype;
  v_needs_new_cycle boolean;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    return null;
  end if;

  select payment_mode, currency into v_mode, v_currency
    from public.club_settings
   where club_id = p_club_id;

  if v_mode is distinct from 'manual' then
    return null;
  end if;

  if p_domain_type = 'event_guest' then
    if p_roster_member_id is not null then
      raise exception 'event_guest_must_not_have_roster_member_id';
    end if;
  else
    if p_roster_member_id is null then
      raise exception 'roster_member_id_required';
    end if;
    if not exists (
      select 1 from public.roster_members
       where id = p_roster_member_id and club_id = p_club_id
    ) then
      raise exception 'cross_club_roster_member_not_allowed';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_domain_type || ':' || p_domain_id::text, 0));

  if p_new_cycle then
    v_needs_new_cycle := true;
  else
    select * into v_existing
      from public.payments
     where club_id = p_club_id
       and domain_type = p_domain_type
       and domain_id = p_domain_id
     order by obligation_cycle desc
     limit 1;

    if found and v_existing.roster_member_id is not distinct from p_roster_member_id then
      return v_existing.id;
    end if;

    -- found=true here means a latest payment exists but belongs to a
    -- different roster identity — a fresh cycle is needed, same as the
    -- explicit p_new_cycle=true path. found=false means genuinely no
    -- payment exists yet — a fresh cycle 1, handled below.
    v_needs_new_cycle := found;
  end if;

  if v_needs_new_cycle then
    select coalesce(max(obligation_cycle), 0) + 1 into v_next_cycle
      from public.payments
     where club_id = p_club_id
       and domain_type = p_domain_type
       and domain_id = p_domain_id;
  else
    v_next_cycle := 1;
  end if;

  insert into public.payments (
    club_id, domain_type, domain_id, obligation_cycle, roster_member_id,
    amount_due_cents, amount_paid_cents, currency, status,
    payment_mode_at_creation, created_by
  ) values (
    p_club_id, p_domain_type, p_domain_id, v_next_cycle, p_roster_member_id,
    0, 0, v_currency, 'unpaid',
    v_mode, p_actor_id
  ) returning id into v_payment_id;

  insert into public.payment_events (payment_id, club_id, event_type, amount_cents, actor_id)
  values (v_payment_id, p_club_id, 'obligation_created', p_amount_cents, p_actor_id);

  return v_payment_id;
end;
$$;

revoke all on function public._create_payment_obligation(uuid, text, uuid, uuid, integer, uuid, boolean) from public;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Internal helper — _adjust_payment_obligation
-- ═══════════════════════════════════════════════════════════════════════════
-- Used when a price-changing edit touches a domain row that already has a
-- current-cycle obligation. No-op (returns without inserting) if no
-- current obligation exists at all — the caller is responsible for
-- deciding whether to create a fresh obligation instead in that case.
-- p_new_amount_cents = 0 is explicitly VALID here: an existing obligation
-- may legitimately be adjusted down to a real $0 due amount (e.g. a price
-- override removed) without being voided — the row remains a payment row
-- with amount_due_cents = 0. Only NULL or negative is rejected. Fails
-- closed once the current cycle has reached any terminal-ish financial
-- state (refunded, partially_refunded, waived, void) — mutating the due
-- amount after money has been refunded or the obligation formally
-- resolved would make the ledger's history ambiguous. club_id is part of
-- the lookup so this can never resolve another club's obligation.
--
-- p_roster_member_id (Phase 34C lifecycle correction): the latest payment
-- cycle for this domain row may belong to a PRIOR Member if the row was
-- safely reassigned while unpriced — no positive obligation was created
-- at reassignment time (_create_payment_obligation's own price>0 gate),
-- so the old Member's historical cycle is still "latest" by cycle number
-- alone. A price edit must never silently adjust a payment snapshotted to
-- a different roster identity than the one CURRENTLY on the domain row —
-- that would financially reattribute history to someone who never
-- incurred it. If the latest payment's roster_member_id does not match,
-- this is a no-op; the caller's subsequent _create_payment_obligation
-- call is what allocates a fresh cycle for the current Member.
create or replace function public._adjust_payment_obligation(
  p_club_id          uuid,
  p_domain_type      text,
  p_domain_id        uuid,
  p_roster_member_id uuid,
  p_new_amount_cents integer,
  p_actor_id         uuid
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment public.payments%rowtype;
begin
  if p_new_amount_cents is null or p_new_amount_cents < 0 then
    raise exception 'invalid_adjustment_amount';
  end if;

  select * into v_payment
    from public.payments
   where club_id = p_club_id
     and domain_type = p_domain_type
     and domain_id = p_domain_id
   order by obligation_cycle desc
   limit 1
   for update;

  if not found then
    return;
  end if;

  if v_payment.roster_member_id is distinct from p_roster_member_id then
    return;
  end if;

  if v_payment.status not in ('unpaid', 'partially_paid', 'paid', 'overpaid') then
    raise exception 'payment_resolution_conflict';
  end if;

  insert into public.payment_events (payment_id, club_id, event_type, amount_cents, actor_id)
  values (v_payment.id, v_payment.club_id, 'obligation_amount_adjusted', p_new_amount_cents, p_actor_id);
end;
$$;

revoke all on function public._adjust_payment_obligation(uuid, text, uuid, uuid, integer, uuid) from public;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. Internal helper — _check_member_reassignment_allowed
-- ═══════════════════════════════════════════════════════════════════════════
-- Called before update_member_reservation / admin_update_member_lesson
-- perform a Member reassignment (0144). No-op if there is no current
-- obligation (reassignment proceeds freely). club_id is part of the
-- lookup so this can never resolve another club's obligation.
--
-- Eligible to leave behind (reassignment allowed) only when:
--   A. amount_due_cents = 0 AND amount_paid_cents = 0 — the "adjusted to
--      zero" / No-balance-due case, whose technical status is still
--      'unpaid'; or
--   B. status IN ('void', 'waived', 'refunded') AND amount_paid_cents = 0.
-- Status alone is NOT sufficient: a partially-paid obligation that was
-- then waived for its REMAINING balance (e.g. due 100, paid 40, waive 60)
-- has status = 'waived' but still retains $40 from the original Member —
-- that case is correctly rejected here because amount_paid_cents <> 0,
-- even though 'waived' appears in the allow-list above.
create or replace function public._check_member_reassignment_allowed(
  p_club_id     uuid,
  p_domain_type text,
  p_domain_id   uuid
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment public.payments%rowtype;
begin
  select * into v_payment
    from public.payments
   where club_id = p_club_id
     and domain_type = p_domain_type
     and domain_id = p_domain_id
   order by obligation_cycle desc
   limit 1
   for update;

  if not found then
    return;
  end if;

  if v_payment.amount_due_cents = 0 and v_payment.amount_paid_cents = 0 then
    return;
  end if;

  if v_payment.status in ('void', 'waived', 'refunded') and v_payment.amount_paid_cents = 0 then
    return;
  end if;

  raise exception 'payment_resolution_required_before_member_reassignment';
end;
$$;

revoke all on function public._check_member_reassignment_allowed(uuid, text, uuid) from public;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. update_club_payment_mode — Admin only
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.update_club_payment_mode(p_payment_mode text)
returns public.club_settings
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_result  public.club_settings%rowtype;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_payment_mode not in ('none', 'manual', 'court_time_payments') then
    raise exception 'invalid_payment_mode';
  end if;

  if p_payment_mode = 'court_time_payments' then
    raise exception 'court_time_payments_not_available';
  end if;

  update public.club_settings
     set payment_mode = p_payment_mode,
         updated_at = now()
   where club_id = v_club_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'update_club_payment_mode', 'club_settings', v_club_id,
    jsonb_build_object('payment_mode', p_payment_mode));

  return v_result;
end;
$$;

revoke execute on function public.update_club_payment_mode(text) from public, anon;
grant  execute on function public.update_club_payment_mode(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. record_manual_payment — Admin + Staff
-- ═══════════════════════════════════════════════════════════════════════════
-- Deliberately NOT gated on the club's current payment_mode: Staff must be
-- able to resolve an already-existing obligation even if the club has
-- since switched to 'none'. Money already owed does not evaporate because
-- the setting changed.
--
-- Ordinary payment is only accepted when the row is genuinely open for
-- payment: status unpaid/partially_paid, a positive due amount, and paid
-- strictly less than due. This also blocks recording against a due=0/
-- paid=0 "No balance due" row, and against any terminal/resolved state
-- (paid, overpaid, partially_refunded, refunded, waived, void). The
-- recorded amount itself may still exceed the remaining balance in a
-- single action (e.g. $50 due, $60 recorded) — that is how an overpayment
-- is legitimately created, and is intentionally unbounded above.
create or replace function public.record_manual_payment(
  p_payment_id         uuid,
  p_amount_cents       integer,
  p_method             text,
  p_occurred_at        timestamptz default now(),
  p_external_reference text default null,
  p_notes              text default null
)
returns public.payments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_payment public.payments%rowtype;
  v_result  public.payments%rowtype;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid_payment_amount';
  end if;
  if p_method not in ('cash', 'check', 'card_terminal', 'bank_transfer', 'digital_wallet', 'other') then
    raise exception 'invalid_payment_method';
  end if;

  select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
  if not found then raise exception 'payment_not_found'; end if;

  if v_payment.status not in ('unpaid', 'partially_paid')
     or v_payment.amount_due_cents <= 0
     or v_payment.amount_due_cents <= v_payment.amount_paid_cents
  then
    raise exception 'payment_not_open_for_payment';
  end if;

  insert into public.payment_events (
    payment_id, club_id, event_type, amount_cents, method, external_reference, notes, actor_id, occurred_at
  ) values (
    p_payment_id, v_club_id, 'manual_payment_recorded', p_amount_cents, p_method, p_external_reference, p_notes,
    auth.uid(), coalesce(p_occurred_at, now())
  );

  select * into v_result from public.payments where id = p_payment_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'record_manual_payment', 'payment', p_payment_id,
    jsonb_build_object('amount_cents', p_amount_cents, 'method', p_method));

  return v_result;
end;
$$;

revoke execute on function public.record_manual_payment(uuid, integer, text, timestamptz, text, text) from public, anon;
grant  execute on function public.record_manual_payment(uuid, integer, text, timestamptz, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. record_refund — Admin only
-- ═══════════════════════════════════════════════════════════════════════════
-- Deliberately NOT gated on status: refunding retained money must remain
-- possible even after a partial-payment waiver (due 100, paid 40, waived
-- remaining 60 -> status 'waived', amount_paid_cents 40) — refunding that
-- $40 to zero is exactly how a cycle like that becomes eligible for a
-- later Member reassignment (section 9, case B). The only real guard
-- needed is amount: a refund can never exceed what is currently retained,
-- which the amount_paid_cents comparison enforces regardless of status
-- (amount_paid_cents = 0 rows — e.g. void — are already unrefundable
-- since any positive p_amount_cents exceeds 0).
create or replace function public.record_refund(
  p_payment_id         uuid,
  p_amount_cents       integer,
  p_method             text default null,
  p_occurred_at        timestamptz default now(),
  p_external_reference text default null,
  p_notes              text default null
)
returns public.payments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_payment public.payments%rowtype;
  v_result  public.payments%rowtype;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid_refund_amount';
  end if;
  if p_method is not null and p_method not in ('cash', 'check', 'card_terminal', 'bank_transfer', 'digital_wallet', 'other') then
    raise exception 'invalid_payment_method';
  end if;

  select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
  if not found then raise exception 'payment_not_found'; end if;

  if p_amount_cents > v_payment.amount_paid_cents then
    raise exception 'refund_exceeds_amount_paid';
  end if;

  insert into public.payment_events (
    payment_id, club_id, event_type, amount_cents, method, external_reference, notes, actor_id, occurred_at
  ) values (
    p_payment_id, v_club_id, 'refund_recorded', p_amount_cents, p_method, p_external_reference, p_notes,
    auth.uid(), coalesce(p_occurred_at, now())
  );

  select * into v_result from public.payments where id = p_payment_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'record_refund', 'payment', p_payment_id,
    jsonb_build_object('amount_cents', p_amount_cents));

  return v_result;
end;
$$;

revoke execute on function public.record_refund(uuid, integer, text, timestamptz, text, text) from public, anon;
grant  execute on function public.record_refund(uuid, integer, text, timestamptz, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. reverse_payment_event — Admin only
-- ═══════════════════════════════════════════════════════════════════════════
-- Reversing a manual_payment_recorded event must never leave the payment's
-- net amount_paid_cents negative — e.g. $100 paid, $40 refunded (net $60);
-- reversing the original $100 would compute net -$40, which is financially
-- impossible. amount_paid_cents >= 0 is a final DB-level CHECK backstop,
-- but this raises a stable, specific error before ever reaching it.
-- Reversing a refund_recorded event only ever increases retained money, so
-- it needs no such guard.
create or replace function public.reverse_payment_event(p_event_id uuid, p_reason text default null)
returns public.payments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_target  public.payment_events%rowtype;
  v_payment public.payments%rowtype;
  v_result  public.payments%rowtype;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_target from public.payment_events where id = p_event_id and club_id = v_club_id;
  if not found then raise exception 'reversal_target_not_found'; end if;

  if v_target.event_type not in ('manual_payment_recorded', 'refund_recorded') then
    raise exception 'event_type_not_reversible';
  end if;

  select * into v_payment from public.payments where id = v_target.payment_id for update;

  if v_target.event_type = 'manual_payment_recorded' and v_target.amount_cents > v_payment.amount_paid_cents then
    raise exception 'reversal_would_make_net_negative';
  end if;

  insert into public.payment_events (payment_id, club_id, event_type, reverses_event_id, notes, actor_id)
  values (v_target.payment_id, v_club_id, 'reverse_payment_event', p_event_id, p_reason, auth.uid());
  -- The BEFORE-INSERT trigger (section 4) re-validates target existence,
  -- same-payment, and reversibility; the partial unique index (section 3)
  -- rejects a second reversal of the same event.

  select * into v_result from public.payments where id = v_target.payment_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'reverse_payment_event', 'payment_event', p_event_id,
    jsonb_build_object('payment_id', v_target.payment_id, 'reason', p_reason));

  return v_result;
end;
$$;

revoke execute on function public.reverse_payment_event(uuid, text) from public, anon;
grant  execute on function public.reverse_payment_event(uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 14. waive_payment — Admin only
-- ═══════════════════════════════════════════════════════════════════════════
-- Allowed only from status unpaid/partially_paid with a positive
-- remaining balance. Status alone is not a sufficient guard: a
-- partially_refunded row can still have amount_due_cents > amount_paid_cents
-- numerically, but must not be treated as ordinary waivable balance — the
-- explicit status whitelist rejects it (and refunded/waived/void/paid/
-- overpaid) even though some of those could otherwise pass a bare
-- remaining>0 check.
create or replace function public.waive_payment(p_payment_id uuid, p_reason text default null)
returns public.payments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id  uuid;
  v_role     text;
  v_payment  public.payments%rowtype;
  v_remaining integer;
  v_result   public.payments%rowtype;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
  if not found then raise exception 'payment_not_found'; end if;

  if v_payment.status not in ('unpaid', 'partially_paid') then
    raise exception 'payment_not_open_for_waiver';
  end if;

  v_remaining := v_payment.amount_due_cents - v_payment.amount_paid_cents;
  if v_remaining <= 0 then
    raise exception 'no_balance_to_waive';
  end if;

  insert into public.payment_events (payment_id, club_id, event_type, amount_cents, notes, actor_id)
  values (p_payment_id, v_club_id, 'waived', v_remaining, p_reason, auth.uid());

  select * into v_result from public.payments where id = p_payment_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'waive_payment', 'payment', p_payment_id,
    jsonb_build_object('amount_waived_cents', v_remaining, 'reason', p_reason));

  return v_result;
end;
$$;

revoke execute on function public.waive_payment(uuid, text) from public, anon;
grant  execute on function public.waive_payment(uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 15. void_payment_obligation — Admin only
-- ═══════════════════════════════════════════════════════════════════════════
-- Voids an obligation that has zero money retained against it (e.g. it
-- turns out the underlying commitment should never have been charged).
-- Distinct from a refund: a refund returns money that was collected; a
-- void erases a due amount that was never collected. Allowed only from
-- status = 'unpaid' with amount_paid_cents = 0 and a positive due amount
-- — the explicit status check (not just the amount_paid_cents = 0 check)
-- is required because a fully refunded cycle can also have
-- amount_paid_cents = 0 (net back to zero after a refund) while its
-- status is 'refunded', not 'unpaid', and must not be voidable a second
-- time under a different name.
create or replace function public.void_payment_obligation(p_payment_id uuid, p_reason text default null)
returns public.payments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_payment public.payments%rowtype;
  v_result  public.payments%rowtype;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
  if not found then raise exception 'payment_not_found'; end if;

  if v_payment.status <> 'unpaid' then
    raise exception 'payment_not_open_for_void';
  end if;

  if v_payment.amount_paid_cents <> 0 then
    raise exception 'cannot_void_with_retained_payment';
  end if;

  if v_payment.amount_due_cents <= 0 then
    raise exception 'no_balance_to_void';
  end if;

  insert into public.payment_events (payment_id, club_id, event_type, amount_cents, notes, actor_id)
  values (p_payment_id, v_club_id, 'void_payment_obligation', v_payment.amount_due_cents, p_reason, auth.uid());

  select * into v_result from public.payments where id = p_payment_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'void_payment_obligation', 'payment', p_payment_id,
    jsonb_build_object('amount_voided_cents', v_payment.amount_due_cents, 'reason', p_reason));

  return v_result;
end;
$$;

revoke execute on function public.void_payment_obligation(uuid, text) from public, anon;
grant  execute on function public.void_payment_obligation(uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 16. get_payment_states_for_domains — batched, sanitized read RPC
-- ═══════════════════════════════════════════════════════════════════════════
-- Returns one row per requested domain_id: its current (highest-cycle)
-- payment state, plus any PRIOR cycles left unresolved, each represented
-- individually (never netted together — an overpaid $10 prior cycle and
-- an unpaid $50 prior cycle must not collapse into "$40 due", and a
-- partially_refunded cycle's numeric due-minus-paid must never be
-- presented as ordinary collectible debt). This is the ONLY sanctioned
-- read path for Member/Pro payment state — payment_events RLS (section 3)
-- excludes them entirely, and this function returns only rollup fields
-- (never method/external_reference/notes/actor detail), so it doubles as
-- the sanitization boundary as well as the N+1-avoidance boundary.
--
-- Role-gated identically to the payments RLS policies: Admin/Staff see
-- any same-club row; Pro only for domain_type = 'lesson_request' where
-- they are the lesson's CURRENT pro_id — current operational Lesson
-- payment state only, no generic historical ledger access; Member only
-- rows whose SNAPSHOTTED roster_member_id matches their own — never
-- derived from the domain row's current owner, so a Member reassigned off
-- a booking cannot see (and a differently-assigned current Member cannot
-- inherit) another Member's payment history.
--
-- A prior cycle counts as "resolved" (and is excluded from
-- unresolved_prior) when its status is paid/refunded/waived/void, OR when
-- it is the neutral due=0/paid=0 case — otherwise (including overpaid and
-- partially_refunded, which remain genuinely unresolved financial states)
-- it is included, with its own payment_id so an operator can actually act
-- on it.
create or replace function public.get_payment_states_for_domains(
  p_domain_type text,
  p_domain_ids  uuid[]
)
returns table (
  domain_id                  uuid,
  current_payment_id         uuid,
  current_obligation_cycle   integer,
  current_amount_due_cents   integer,
  current_amount_paid_cents  integer,
  current_status             text,
  current_currency           text,
  unresolved_prior           jsonb
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id          uuid;
  v_role             text;
  v_roster_member_id uuid;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role in ('admin', 'staff') then
    null;
  elsif v_role = 'pro' then
    if p_domain_type <> 'lesson_request' then
      raise exception 'insufficient_role';
    end if;
  elsif v_role = 'member' then
    v_roster_member_id := public.current_user_roster_member_id();
    if v_roster_member_id is null then raise exception 'not_authenticated'; end if;
  else
    raise exception 'insufficient_role';
  end if;

  return query
    with ranked as (
      select p.*,
             row_number() over (partition by p.domain_id order by p.obligation_cycle desc) as rn
        from public.payments p
       where p.club_id = v_club_id
         and p.domain_type = p_domain_type
         and p.domain_id = any(p_domain_ids)
         and (
           v_role in ('admin', 'staff')
           or (v_role = 'pro' and exists (
                 select 1 from public.lesson_requests lr
                  where lr.id = p.domain_id and lr.pro_id = auth.uid()
               ))
           or (v_role = 'member' and p.roster_member_id = v_roster_member_id)
         )
    ),
    current_rows as (
      select * from ranked where rn = 1
    ),
    prior_unresolved as (
      select domain_id,
             jsonb_agg(
               jsonb_build_object(
                 'payment_id', id,
                 'obligation_cycle', obligation_cycle,
                 'amount_due_cents', amount_due_cents,
                 'amount_paid_cents', amount_paid_cents,
                 'currency', currency,
                 'status', status
               )
               order by obligation_cycle desc
             ) as items
        from ranked
       where rn > 1
         and status not in ('paid', 'refunded', 'waived', 'void')
         and not (amount_due_cents = 0 and amount_paid_cents = 0)
       group by domain_id
    )
    select
      c.domain_id,
      c.id,
      c.obligation_cycle,
      c.amount_due_cents,
      c.amount_paid_cents,
      c.status,
      c.currency,
      -- Pro gets current operational Lesson payment state only — never
      -- prior financial-cycle visibility, regardless of what the CTEs
      -- above computed. Admin/Staff/Member get real prior-cycle data.
      case when v_role = 'pro' then '[]'::jsonb else coalesce(u.items, '[]'::jsonb) end
    from current_rows c
    left join prior_unresolved u on u.domain_id = c.domain_id;
end;
$$;

revoke execute on function public.get_payment_states_for_domains(text, uuid[]) from public, anon;
grant  execute on function public.get_payment_states_for_domains(text, uuid[]) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor)
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
-- drop function if exists public.get_payment_states_for_domains(text, uuid[]);
-- drop function if exists public.void_payment_obligation(uuid, text);
-- drop function if exists public.waive_payment(uuid, text);
-- drop function if exists public.reverse_payment_event(uuid, text);
-- drop function if exists public.record_refund(uuid, integer, text, timestamptz, text, text);
-- drop function if exists public.record_manual_payment(uuid, integer, text, timestamptz, text, text);
-- drop function if exists public.update_club_payment_mode(text);
-- drop function if exists public._check_member_reassignment_allowed(uuid, text, uuid);
-- drop function if exists public._adjust_payment_obligation(uuid, text, uuid, uuid, integer, uuid);
-- drop function if exists public._create_payment_obligation(uuid, text, uuid, uuid, integer, uuid, boolean);
-- drop trigger if exists club_settings_currency_lock_on_payment_history on public.club_settings;
-- drop function if exists public._enforce_currency_lock_on_payment_history();
-- drop trigger if exists payment_events_after_insert on public.payment_events;
-- drop function if exists public._payment_events_after_insert();
-- drop function if exists public._recompute_payment_rollup(uuid);
-- drop trigger if exists payment_events_validate_reversal on public.payment_events;
-- drop function if exists public._validate_payment_event_reversal();
-- drop table if exists public.payment_events;
-- drop table if exists public.payments;
-- alter table public.club_settings drop column if exists payment_mode;
-- commit;
