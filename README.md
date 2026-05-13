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

## 7. Regenerate Supabase types after future migrations

After any schema change, regenerate `src/lib/db/types.ts`:

```bash
pnpm dlx supabase gen types typescript --project-id <your-project-id> > src/lib/db/types.ts
```

The placeholder `src/lib/db/types.ts` already contains hand-written types that match Phase 1's schema, so the build passes before first generation.

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

## Phase 1 acceptance checklist

- [ ] Sign in as member, pro, and admin users
- [ ] Land on `/calendar` — full empty shell visible (date strip, view toggle, court chips, timeline with 5 court columns)
- [ ] Navigate between Calendar, Book, My Schedule, and Profile tabs
- [ ] Profile page shows first name, last name, email, and correct role badge
- [ ] Sign Out redirects to `/sign-in`
- [ ] Schema in Supabase matches the migration (7 tables, RLS enabled on all)
- [ ] 5 event types exist in `event_types` with the specified default values
