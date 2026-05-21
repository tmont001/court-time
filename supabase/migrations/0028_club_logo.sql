-- 0028_club_logo.sql
-- Phase 11C: club logo upload support.
-- Adds logo_url column to clubs and storage RLS policies for club-logos bucket.
-- PREREQUISITE: the club-logos bucket must exist in Supabase Storage before
-- running this migration (public bucket, 2 MB limit, jpeg/png/webp only).
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- clubs.logo_url
-- ---------------------------------------------------------------------------
alter table clubs add column if not exists logo_url text;

-- ---------------------------------------------------------------------------
-- Storage RLS policies for the club-logos bucket.
-- Upload path convention: {club_id}/logo.{ext}
-- The first path segment (folder name) must equal the admin's club_id.
-- ---------------------------------------------------------------------------

-- Public read: any user (authenticated or anon) can view logos.
create policy "club_logos_public_read"
  on storage.objects for select
  using (bucket_id = 'club-logos');

-- Admin insert: authenticated admin whose club_id matches the path prefix.
create policy "club_logos_admin_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'club-logos'
    and (storage.foldername(name))[1] = (
      select club_id::text from profiles where id = auth.uid()
    )
    and (select role from profiles where id = auth.uid()) = 'admin'
  );

-- Admin update: same conditions on existing and new row.
create policy "club_logos_admin_update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'club-logos'
    and (storage.foldername(name))[1] = (
      select club_id::text from profiles where id = auth.uid()
    )
    and (select role from profiles where id = auth.uid()) = 'admin'
  )
  with check (
    bucket_id = 'club-logos'
    and (storage.foldername(name))[1] = (
      select club_id::text from profiles where id = auth.uid()
    )
    and (select role from profiles where id = auth.uid()) = 'admin'
  );

-- Admin delete: authenticated admin whose club_id matches the path prefix.
create policy "club_logos_admin_delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'club-logos'
    and (storage.foldername(name))[1] = (
      select club_id::text from profiles where id = auth.uid()
    )
    and (select role from profiles where id = auth.uid()) = 'admin'
  );
