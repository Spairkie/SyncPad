-- ============================================================
-- SyncPad – Supabase Setup SQL
-- SAFE TO RERUN: all statements are idempotent.
-- Run this in your Supabase project → SQL Editor.
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────

create extension if not exists "pgcrypto";


-- Optional scheduler support:
-- For automatic expired-room cleanup, enable the `pg_cron` extension in
-- Supabase Dashboard → Database → Extensions before running this file.
-- The scheduling block later in this script detects whether pg_cron is
-- available and skips scheduling safely if it is not enabled.

-- ── Tables ───────────────────────────────────────────────────

create table if not exists syncpad_rooms (
  room_id              text        primary key,
  room_name            text        not null default '',
  content              text        not null default '',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by_device    text,
  updated_by_device    text,
  passcode_hash        text,
  passcode_salt        text,
  encryption_enabled   boolean     not null default false,
  encryption_salt      text,
  expires_at           timestamptz,
  view_once            boolean     not null default false,
  viewed               boolean     not null default false,
  editing_locked       boolean     not null default false,
  cleared_reason       text        -- 'expired' | 'view_once' | 'manual' | null
);

-- Safe to rerun on older installs that pre-date editing_locked.
alter table syncpad_rooms
  add column if not exists editing_locked boolean not null default false;

alter table syncpad_rooms
  add column if not exists passcode_salt text;


create table if not exists public.syncpad_room_reports (
  id uuid primary key default gen_random_uuid(),
  room_id text not null,
  share_token text,
  report_reason text not null,
  report_details text,
  reporter_device_id text,
  reporter_mode text not null default 'editable' check (reporter_mode in ('editable', 'readonly')),
  page_url text,
  user_agent text,
  created_at timestamptz not null default now(),
  status text not null default 'new'
);


-- DB-side validation for anonymous room reports (keep in sync with frontend).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'syncpad_room_reports_reason_check'
  ) then
    alter table public.syncpad_room_reports
      add constraint syncpad_room_reports_reason_check
      check (report_reason in ('Spam', 'Abuse or harassment', 'Illegal or harmful content', 'Private information', 'Other'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'syncpad_room_reports_mode_check'
  ) then
    alter table public.syncpad_room_reports
      add constraint syncpad_room_reports_mode_check
      check (reporter_mode in ('editable', 'readonly'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'syncpad_room_reports_details_len_check'
  ) then
    alter table public.syncpad_room_reports
      add constraint syncpad_room_reports_details_len_check
      check (report_details is null or length(report_details) <= 1000);
  end if;
end $$;

create table if not exists syncpad_files (
  id                   uuid        primary key default gen_random_uuid(),
  room_id              text        not null references syncpad_rooms(room_id) on delete cascade,
  filename             text        not null,
  file_path            text        not null,
  file_size            bigint      not null default 0,
  mime_type            text        not null default 'application/octet-stream',
  uploaded_by_device   text,
  uploaded_at          timestamptz not null default now()
);

-- NOTE: ON DELETE CASCADE on syncpad_files removes the metadata rows when a
-- room is deleted from syncpad_rooms. It does NOT remove the physical files
-- in the syncpad-files Storage bucket. Those must be cleaned up separately
-- (e.g. via a Supabase Edge Function or manual bucket management).

-- ── Indexes ──────────────────────────────────────────────────

create index if not exists idx_syncpad_files_room_id
  on syncpad_files(room_id);

create index if not exists idx_syncpad_room_reports_created_at
  on public.syncpad_room_reports(created_at);
create index if not exists idx_syncpad_room_reports_room_id
  on public.syncpad_room_reports(room_id);
create index if not exists idx_syncpad_room_reports_status
  on public.syncpad_room_reports(status);


-- Database owns syncpad_rooms.updated_at on every UPDATE to prevent
-- client clocks or client-supplied timestamps from skewing reconciliation.
create or replace function public.set_syncpad_rooms_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
      from pg_trigger
     where tgname = 'syncpad_rooms_set_updated_at'
       and tgrelid = 'public.syncpad_rooms'::regclass
  ) then
    create trigger syncpad_rooms_set_updated_at
      before update on public.syncpad_rooms
      for each row
      execute function public.set_syncpad_rooms_updated_at();
  end if;
end $$;

create index if not exists idx_syncpad_rooms_expires
  on syncpad_rooms(expires_at)
  where expires_at is not null;

-- ── Row-Level Security ────────────────────────────────────────

alter table syncpad_rooms enable row level security;
alter table syncpad_files enable row level security;
alter table if exists public.syncpad_room_reports enable row level security;
alter table if exists public.syncpad_share_links enable row level security;



-- Optional/future admin support only: current frontend `/admin` route is a placeholder.
-- Keep these objects for possible future authenticated maintenance tooling.
create table if not exists public.syncpad_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

alter table public.syncpad_admins enable row level security;

drop policy if exists "admins can read own admin row" on public.syncpad_admins;
create policy "admins can read own admin row"
  on public.syncpad_admins for select to authenticated
  using (auth.uid() = user_id);

create or replace function public.is_syncpad_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.syncpad_admins a where a.user_id = auth.uid()
  );
$$;

grant execute on function public.is_syncpad_admin() to authenticated;

create table if not exists public.syncpad_share_links (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.syncpad_rooms(room_id) on delete cascade,
  token text unique not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  disabled boolean not null default false
);

create unique index if not exists idx_syncpad_share_links_room_id
  on public.syncpad_share_links(room_id);
create unique index if not exists idx_syncpad_share_links_token
  on public.syncpad_share_links(token);
create index if not exists idx_syncpad_share_links_created_at
  on public.syncpad_share_links(created_at);

drop policy if exists "anon no direct share-link reads" on public.syncpad_share_links;
drop policy if exists "anon no direct share-link writes" on public.syncpad_share_links;

create policy "anon no direct share-link reads"
  on public.syncpad_share_links for select to anon using (false);
create policy "anon no direct share-link writes"
  on public.syncpad_share_links for all to anon using (false) with check (false);

create or replace function public.get_or_create_readonly_share_link(p_room_id text)
returns table(token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
begin
  if p_room_id is null or btrim(p_room_id) = '' then
    return;
  end if;

  select sl.token into v_token
    from public.syncpad_share_links sl
   where sl.room_id = p_room_id and sl.disabled = false
   limit 1;

  if v_token is null then
    v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    insert into public.syncpad_share_links(room_id, token)
    values (p_room_id, v_token)
    on conflict (room_id) do update set disabled = false
    returning syncpad_share_links.token into v_token;
  end if;

  return query select v_token;
end;
$$;

create or replace function public.resolve_readonly_share_link(p_token text)
returns table(room_id text, content text, updated_at timestamptz, encryption_enabled boolean, encryption_salt text, passcode_hash text, passcode_salt text, view_once boolean, viewed boolean, editing_locked boolean, cleared_reason text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_token is null or btrim(p_token) = '' then
    return;
  end if;

  update public.syncpad_share_links
     set last_used_at = now()
   where token = p_token and disabled = false;

  return query
  select r.room_id, r.content, r.updated_at, r.encryption_enabled, r.encryption_salt, r.passcode_hash, r.passcode_salt, r.view_once, r.viewed, r.editing_locked, r.cleared_reason, r.expires_at
    from public.syncpad_share_links sl
    join public.syncpad_rooms r on r.room_id = sl.room_id
   where sl.token = p_token and sl.disabled = false
   limit 1;
end;
$$;

grant execute on function public.get_or_create_readonly_share_link(text) to anon, authenticated;
grant execute on function public.resolve_readonly_share_link(text) to anon, authenticated;

-- Drop-and-recreate makes this script idempotent without needing
-- "create policy if not exists" (which is not supported in all PG versions).

drop policy if exists "anon read rooms"   on syncpad_rooms;
drop policy if exists "anon insert rooms" on syncpad_rooms;
drop policy if exists "anon update rooms" on syncpad_rooms;

create policy "anon read rooms"
  on syncpad_rooms for select to anon using (true);

create policy "anon insert rooms"
  on syncpad_rooms for insert to anon with check (true);

create policy "anon update rooms"
  on syncpad_rooms for update to anon using (true) with check (true);

drop policy if exists "anon read files"   on syncpad_files;
drop policy if exists "anon insert files" on syncpad_files;
drop policy if exists "anon delete files" on syncpad_files;

create policy "anon read files"
  on syncpad_files for select to anon using (true);

create policy "anon insert files"
  on syncpad_files for insert to anon with check (true);

create policy "anon delete files"
  on syncpad_files for delete to anon using (true);

-- ── Authenticated baseline policies ──────────────────────────
-- After an admin signs in at /admin, the Supabase client holds an
-- authenticated session for the rest of the browsing session.
-- The shared anon-key client then sends requests as `authenticated`
-- instead of `anon`, which means the anon policies above no longer
-- apply — so normal room/file operations would fail with RLS errors.
-- These policies give every authenticated user the same baseline
-- access as anon for the normal app features.
-- Admin-only actions (update/delete by admin) are still gated by
-- is_syncpad_admin() in the admin-specific policies below.

drop policy if exists "authenticated baseline read rooms"   on syncpad_rooms;
drop policy if exists "authenticated baseline insert rooms" on syncpad_rooms;
drop policy if exists "authenticated baseline update rooms" on syncpad_rooms;
create policy "authenticated baseline read rooms"
  on syncpad_rooms for select to authenticated using (true);
create policy "authenticated baseline insert rooms"
  on syncpad_rooms for insert to authenticated with check (true);
create policy "authenticated baseline update rooms"
  on syncpad_rooms for update to authenticated using (true) with check (true);

drop policy if exists "authenticated baseline read files"   on syncpad_files;
drop policy if exists "authenticated baseline insert files" on syncpad_files;
drop policy if exists "authenticated baseline delete files" on syncpad_files;
create policy "authenticated baseline read files"
  on syncpad_files for select to authenticated using (true);
create policy "authenticated baseline insert files"
  on syncpad_files for insert to authenticated with check (true);
create policy "authenticated baseline delete files"
  on syncpad_files for delete to authenticated using (true);

-- ── Admin-only policies ────────────────────────────────────────
-- These allow admins to perform elevated actions (delete rooms,
-- update files metadata, etc.) that the baseline policies above
-- do not need to grant. The is_syncpad_admin() check ensures only
-- users in the syncpad_admins table can invoke these.

drop policy if exists "admin read rooms" on syncpad_rooms;
drop policy if exists "admin update rooms" on syncpad_rooms;
drop policy if exists "admin delete rooms" on syncpad_rooms;
create policy "admin read rooms" on syncpad_rooms for select to authenticated using (public.is_syncpad_admin());
create policy "admin update rooms" on syncpad_rooms for update to authenticated using (public.is_syncpad_admin()) with check (public.is_syncpad_admin());
create policy "admin delete rooms" on syncpad_rooms for delete to authenticated using (public.is_syncpad_admin());

drop policy if exists "admin read files" on syncpad_files;
drop policy if exists "admin update files" on syncpad_files;
drop policy if exists "admin delete files" on syncpad_files;
create policy "admin read files" on syncpad_files for select to authenticated using (public.is_syncpad_admin());
create policy "admin update files" on syncpad_files for update to authenticated using (public.is_syncpad_admin()) with check (public.is_syncpad_admin());
create policy "admin delete files" on syncpad_files for delete to authenticated using (public.is_syncpad_admin());

drop policy if exists "anon insert room reports" on public.syncpad_room_reports;
create policy "anon insert room reports"
  on public.syncpad_room_reports for insert to anon with check (true);

-- Future-only admin review access for reported rooms.
drop policy if exists "admin read room reports" on public.syncpad_room_reports;
drop policy if exists "admin update room reports" on public.syncpad_room_reports;
drop policy if exists "admin delete room reports" on public.syncpad_room_reports;
create policy "admin read room reports" on public.syncpad_room_reports for select to authenticated using (public.is_syncpad_admin());
create policy "admin update room reports" on public.syncpad_room_reports for update to authenticated using (public.is_syncpad_admin()) with check (public.is_syncpad_admin());
create policy "admin delete room reports" on public.syncpad_room_reports for delete to authenticated using (public.is_syncpad_admin());

drop policy if exists "admin read share-links" on public.syncpad_share_links;
drop policy if exists "admin update share-links" on public.syncpad_share_links;
drop policy if exists "admin delete share-links" on public.syncpad_share_links;
create policy "admin read share-links" on public.syncpad_share_links for select to authenticated using (public.is_syncpad_admin());
create policy "admin update share-links" on public.syncpad_share_links for update to authenticated using (public.is_syncpad_admin()) with check (public.is_syncpad_admin());
create policy "admin delete share-links" on public.syncpad_share_links for delete to authenticated using (public.is_syncpad_admin());


-- ── Backend expired-room cleanup ──────────────────────────────
-- The browser still clears expired rooms immediately when a user opens one.
-- This database function is the backend safety net for rooms that expire while
-- nobody is online.
--
-- Important encryption detail:
-- The database cannot create an encrypted empty payload because it never knows
-- the user's passphrase. Therefore:
--   • unencrypted expired rooms are cleared in place
--   • encrypted expired rooms are deleted so ciphertext is removed server-side
--
-- Deleting a room cascades syncpad_files metadata rows, but physical Storage
-- objects may still need separate Storage cleanup if the room had attachments.

create or replace function public.cleanup_expired_syncpad_rooms()
returns table(cleared_unencrypted integer, deleted_encrypted integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.syncpad_rooms
     set content = '',
         updated_at = now(),
         updated_by_device = 'backend-cleanup',
         cleared_reason = 'expired',
         expires_at = null
   where expires_at is not null
     and expires_at <= now()
     and coalesce(encryption_enabled, false) = false
     and cleared_reason is distinct from 'expired';

  get diagnostics cleared_unencrypted = row_count;

  delete from public.syncpad_rooms
   where expires_at is not null
     and expires_at <= now()
     and coalesce(encryption_enabled, false) = true;

  get diagnostics deleted_encrypted = row_count;

  return next;
end;
$$;

comment on function public.cleanup_expired_syncpad_rooms()
  is 'Clears unencrypted expired rooms and deletes encrypted expired rooms. Intended for pg_cron or manual SQL maintenance.';

-- Do not expose maintenance cleanup as a public app capability. The scheduled
-- pg_cron job and SQL Editor owner can still run it.
revoke all on function public.cleanup_expired_syncpad_rooms() from public;
revoke all on function public.cleanup_expired_syncpad_rooms() from anon;
revoke all on function public.cleanup_expired_syncpad_rooms() from authenticated;

-- Try to schedule the cleanup every 10 minutes if pg_cron is already enabled.
-- If pg_cron is not enabled, this block only prints a NOTICE and the rest of
-- the setup remains usable. To enable later: Database → Extensions → pg_cron,
-- then rerun this setup file or run the cron.schedule call manually.

do $do$
declare
  existing_job_id bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not enabled; automatic expired-room cleanup was not scheduled. Enable pg_cron and rerun this script to schedule it.';
    return;
  end if;

  select jobid
    into existing_job_id
    from cron.job
   where jobname = 'syncpad-expired-room-cleanup'
   limit 1;

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'syncpad-expired-room-cleanup',
    '*/10 * * * *',
    $job$select public.cleanup_expired_syncpad_rooms();$job$
  );
exception
  when others then
    raise notice 'Could not schedule syncpad expired-room cleanup: %', SQLERRM;
end;
$do$;

-- ── Realtime ─────────────────────────────────────────────────
-- These statements fail if the table is already in the publication.
-- The DO blocks catch the "duplicate_object" error so the script is
-- safe to rerun.

do $$
begin
  alter publication supabase_realtime add table syncpad_rooms;
exception
  when duplicate_object then
    -- table is already in the publication; nothing to do
    null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table syncpad_files;
exception
  when duplicate_object then
    null;
end;
$$;

-- ── Storage bucket ────────────────────────────────────────────
-- The bucket insert is already idempotent via ON CONFLICT DO NOTHING.

insert into storage.buckets (id, name, public)
  values ('syncpad-files', 'syncpad-files', false)
  on conflict (id) do nothing;

-- Storage policies (drop-and-recreate for idempotency)

drop policy if exists "anon upload syncpad files" on storage.objects;
drop policy if exists "anon read syncpad files"   on storage.objects;
drop policy if exists "anon delete syncpad files" on storage.objects;

create policy "anon upload syncpad files"
  on storage.objects for insert to anon
  with check (bucket_id = 'syncpad-files');

create policy "anon read syncpad files"
  on storage.objects for select to anon
  using (bucket_id = 'syncpad-files');

create policy "anon delete syncpad files"
  on storage.objects for delete to anon
  using (bucket_id = 'syncpad-files');

-- Authenticated baseline Storage policies.
-- After admin sign-in the Supabase client uses the authenticated role,
-- so the anon storage policies above no longer apply. Mirror them here
-- so file upload/read/delete continues to work for authenticated users.

drop policy if exists "authenticated upload syncpad files" on storage.objects;
drop policy if exists "authenticated read syncpad files"   on storage.objects;
drop policy if exists "authenticated delete syncpad files" on storage.objects;

create policy "authenticated upload syncpad files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'syncpad-files');

create policy "authenticated read syncpad files"
  on storage.objects for select to authenticated
  using (bucket_id = 'syncpad-files');

create policy "authenticated delete syncpad files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'syncpad-files');

-- ════════════════════════════════════════════════════════════════
-- OPTIONAL: Maintenance queries (run manually as needed)
-- ════════════════════════════════════════════════════════════════
-- These are *not* part of the public app. Run them manually in the
-- SQL editor; do NOT expose them through the anon role.
--
-- -- 1) Manually run expired-room cleanup now
-- select * from public.cleanup_expired_syncpad_rooms();
--
-- -- 2) Check whether the pg_cron cleanup job exists
-- select jobid, jobname, schedule, active
-- from cron.job
-- where jobname = 'syncpad-expired-room-cleanup';
--
-- -- 3) Find rooms that have not been updated in 90+ days
-- select room_id, updated_at, length(content) as content_len
-- from   syncpad_rooms
-- where  updated_at < now() - interval '90 days'
-- order  by updated_at asc
-- limit  200;
--
-- -- 4) Find rooms that have been cleared and are very old
-- select room_id, cleared_reason, updated_at
-- from   syncpad_rooms
-- where  cleared_reason is not null
--   and  updated_at < now() - interval '30 days';
--
-- -- 5) Delete inactive rooms older than 180 days (CAREFUL — irreversible)
-- --    Run query #3 first to confirm the candidates.
-- -- delete from syncpad_rooms
-- -- where updated_at < now() - interval '180 days';
--
-- NOTE: Deleting a syncpad_rooms row cascades syncpad_files metadata, but it
-- does NOT reliably clean physical objects from the syncpad-files Storage
-- bucket. Use the Storage admin UI or a service-role Edge Function for
-- physical Storage cleanup.


create or replace function public.run_cleanup_expired_syncpad_rooms_as_admin()
returns table(cleared_unencrypted integer, deleted_encrypted integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_syncpad_admin() then
    raise exception 'not authorized';
  end if;
  return query select * from public.cleanup_expired_syncpad_rooms();
end;
$$;

grant execute on function public.run_cleanup_expired_syncpad_rooms_as_admin() to authenticated;
