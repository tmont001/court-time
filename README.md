# Court Time — Phase 1

Tennis court booking platform. Phase 1 delivers an authenticated shell with a Calendar Day View, auth flow, and user profile.

---

## Prerequisites

- **Node 20 LTS** (use `nvm use` — `.nvmrc` pins it)
- **pnpm** — install once: `curl -fsSL https://get.pnpm.io/install.sh | sh -`

---

## 1. Create a cloud Supabase project

1. Go to [supabase.com](https://supabase.com) → New project.
2. Choose a region close to your users and set a strong database password.
3. After the project is ready, go to **Project Settings → API** and copy:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`

---

## 2. Configure environment variables

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-public-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

> `SUPABASE_SERVICE_ROLE_KEY` is not used in Phase 1 application code but is included for future server-side admin operations.

---

## 3. Apply migrations

### Option A — SQL Editor (simplest)

1. Open the Supabase dashboard → **SQL Editor**.
2. Paste and run `supabase/migrations/0001_initial_schema.sql`.
3. Paste and run `supabase/migrations/0002_rls_policies.sql`.

### Option B — Supabase CLI

```bash
pnpm dlx supabase link --project-ref <your-project-id>
pnpm dlx supabase db push
```

---

## 4. Run the seed file

In the SQL Editor, paste and run `supabase/seed.sql`.

This inserts:
- Riverside Tennis Club
- Club settings (14-day booking window, 24-hour cancellation window)
- Courts 1–5
- Operating hours (Sun–Sat, 8 AM–7 PM)
- 5 event types with their default capacity/duration/court-count values

---

## 5. Create test users

Do **not** add users to the seed file — create them via Supabase Auth:

1. Go to **Authentication → Users → Add user**.
2. Create three users:
   | Email | Password |
   |---|---|
   | member@riverside.example | (choose one) |
   | pro@riverside.example | (choose one) |
   | admin@riverside.example | (choose one) |

3. The `on_auth_user_created` trigger automatically creates a `profiles` row with `role = 'member'` for each new user.

4. Promote the pro and admin users via **SQL Editor**:

```sql
update profiles
set role = 'pro'
where id = (
  select id from auth.users where email = 'pro@riverside.example'
);

update profiles
set role = 'admin'
where id = (
  select id from auth.users where email = 'admin@riverside.example'
);
```

---

## 6. Start the dev server

```bash
pnpm install   # if you haven't already
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). You will be redirected to `/sign-in`.

---

## 7. Database types: generated structural source + domain layer

Two files, two different jobs:

- **`src/lib/db/database.types.ts`** — real `supabase gen types` output, **committed**, **never hand-edited**. It reflects raw database STRUCTURE only: every public table and function the schema has, regardless of RLS/grants. (`club_memberships`, for example, appears here because it genuinely exists — even though it's fully locked down at the RLS/grant layer and unreachable via `.from()` by any caller. Type presence never implies database permission; RLS/EXECUTE grants/SECURITY DEFINER authorization are audited separately.)
- **`src/lib/db/types.ts`** — a small, **hand-maintained** domain/compatibility layer over the generated file. Application code keeps importing `Database`/`Json` from here (`@/lib/db/types`), exactly as before — this split changed zero import paths anywhere else in the app. It layers on:
  - **Literal string unions for CHECK-constrained columns.** Supabase's generator can only produce a literal union from a native Postgres ENUM type — this schema defines zero native enums, so every status/role/kind column generates as plain `string`. `types.ts` restores the stronger type for columns where that matters (`profiles.role`, `reservations.status`, `notifications.kind`, etc.), each verified against its current CHECK constraint.
  - **A handful of confirmed Args/Returns nullability corrections**, where the generator provably under- or over-reports nullability (it never marks a function argument as accepting `null`, regardless of whether the SQL genuinely does).
  - Two deliberate `Insert`/`Update` lockouts (`payments`, `payment_events`) preserving an intentional domain rule: these are append-only/rollup ledger tables the app must never write to directly, only via RPCs.

  Everything **not** explicitly overridden flows straight through from the generated file automatically — new tables/functions added by a future regeneration appear with no manual copying required.

**Regenerating (only when you intend to update the committed generated file):**

```bash
# One-time setup: log in once (opens a browser), or set SUPABASE_ACCESS_TOKEN
pnpm dlx supabase@2.118.0 login

# Your project ref is the subdomain in its dashboard URL
# (https://supabase.com/dashboard/project/<ref>) — not a secret, but keep it
# out of shell history if you'd rather not.
SUPABASE_PROJECT_REF=<your-project-ref> pnpm run db:types:generate
```

This overwrites `src/lib/db/database.types.ts` directly — review the diff, and re-check `src/lib/db/types.ts`'s overrides still make sense (a migration can add/remove a CHECK-constrained value that a literal-union override needs to track by hand) before committing.

**Verifying without touching anything (CI-safe, local-safe):**

```bash
SUPABASE_PROJECT_REF=<your-project-ref> pnpm run db:types:check
```

`db:types:check` (`scripts/db-types-check.sh`) generates a real, disposable comparison file to a private temp path, diffs it against the committed `database.types.ts`, prints the diff and exits non-zero on any drift, and always cleans up the temp file — it **never** writes to `database.types.ts` itself. It fails loudly (not silently) if `SUPABASE_PROJECT_REF` is unset or the CLI isn't authenticated. Both commands pin the same exact Supabase CLI version (`2.118.0`) so they can never disagree about output shape due to a version skew between them. Neither command commits or requires committing an access token.

---

## Project structure

```
src/
  app/
    (auth)/          # Unauthenticated pages (sign-in, forgot-password, reset-password, welcome)
    (app)/           # Authenticated pages (calendar, book, my-schedule, profile)
    layout.tsx       # Root layout
    page.tsx         # Redirects to /calendar
  components/
    Header.tsx       # Top bar (club name, screen title, bell placeholder)
    BottomNav.tsx    # Four-tab bottom navigation
  lib/
    supabase/
      client.ts      # Browser Supabase client
      server.ts      # Server Component Supabase client
      middleware.ts  # Session refresh helper
    db/
      types.ts       # Generated (or placeholder) database types
supabase/
  migrations/
    0001_initial_schema.sql
    0002_rls_policies.sql
  seed.sql
middleware.ts        # Next.js middleware — session refresh + auth guard
```

---

## Troubleshooting

### Calendar shows only "All" / No courts visible

**Root cause.** The seed data (`clubs`, `courts`, `event_types`) is in the database, but the logged-in user either has no matching `profiles` row or the row's `club_id` does not match the seeded club. The RLS policy on `courts` evaluates `club_id = current_user_club_id()`, where `current_user_club_id()` reads the authenticated user's profile. A missing or mismatched profile means every court row is filtered out, with no error returned.

**Step 1 — Verify the data.**

Run the following queries in the Supabase SQL Editor:

```sql
-- Row counts (all should be > 0 after seeding)
select count(*) as club_count        from clubs;
select count(*) as court_count       from courts;
select count(*) as event_type_count  from event_types;
select count(*) as profile_count     from profiles;

-- Inspect every profile and its linked auth user
select
  p.id,
  u.email,
  p.club_id,
  p.role,
  p.status
from profiles p
left join auth.users u on u.id = p.id;
```

If `profile_count` is 0, or `club_id` is NULL, proceed to Step 2.

**Step 2 — Create or fix the profile row.**

Find your auth user UUID in the Supabase dashboard under **Authentication → Users**, then run:

```sql
-- Insert a new profile, or update an existing one with the wrong club_id
insert into profiles (id, club_id, role, status)
values (
  '<your-auth-user-id>',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',   -- Riverside club UUID from seed.sql
  'member',
  'active'
)
on conflict (id) do update
  set club_id = excluded.club_id,
      status  = excluded.status;
```

Reload `/calendar` — courts should appear.

**Why the trigger may have missed.** The `on_auth_user_created` trigger inserts a profile row when a new auth user is created. If the `clubs` table was empty at that moment (user created before seed.sql was applied), the trigger's `select id from clubs where slug = 'riverside'` returns nothing and the insert fails silently. The fix is the manual insert above.

---

## Phase 1 acceptance checklist

- [ ] Sign in as member, pro, and admin users
- [ ] Land on `/calendar` — full empty shell visible (date strip, view toggle, court chips, timeline with 5 court columns)
- [ ] Navigate between Calendar, Book, My Schedule, and Profile tabs
- [ ] Profile page shows first name, last name, email, and correct role badge
- [ ] Sign Out redirects to `/sign-in`
- [ ] Schema in Supabase matches the migration (7 tables, RLS enabled on all)
- [ ] 5 event types exist in `event_types` with the specified default values
