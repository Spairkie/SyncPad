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

create index if not exists idx_syncpad_rooms_expires
  on syncpad_rooms(expires_at)
  where expires_at is not null;

-- ── Row-Level Security ────────────────────────────────────────

alter table syncpad_rooms enable row level security;
alter table syncpad_files enable row level security;

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
