-- ============================================================
-- SyncPad – Version History Migration
-- SAFE TO RERUN: all statements use CREATE IF NOT EXISTS,
-- CREATE OR REPLACE, and DROP POLICY IF EXISTS / CREATE POLICY
-- so the script is fully idempotent.
--
-- Run this in your Supabase project → SQL Editor AFTER the
-- base 0001_base_schema.sql has been applied.
--
-- What this migration adds
-- ────────────────────────
--   1. syncpad_room_revisions table
--      One row per saved snapshot of a room's content, so past
--      versions can be listed and restored from the History
--      panel. `content` holds exactly what the client would
--      otherwise write to syncpad_rooms.content — for encrypted
--      rooms that is ciphertext, same as the live room row, so
--      this table needs no separate encryption handling.
--
--   2. Auto-pruning trigger
--      Keeps only the most recent N revisions per room (default
--      50) so history storage doesn't grow unbounded. Runs as
--      SECURITY DEFINER so it can prune rows regardless of the
--      inserting role's own RLS grants.
--
--   3. RLS policies
--      Anon/authenticated baseline read + insert, mirroring the
--      permissive model already used for syncpad_rooms and
--      syncpad_files (this app has no per-user auth — access
--      control is by room-ID/passcode knowledge, enforced
--      client-side). Delete is admin-only, matching the other
--      tables' admin policies.
-- ============================================================

create table if not exists public.syncpad_room_revisions (
  id          uuid        primary key default gen_random_uuid(),
  room_id     text        not null references public.syncpad_rooms(room_id) on delete cascade,
  content     text        not null default '',
  created_at  timestamptz not null default now(),
  device_id   text
);

create index if not exists idx_syncpad_room_revisions_room_id_created_at
  on public.syncpad_room_revisions(room_id, created_at desc);

alter table public.syncpad_room_revisions enable row level security;

-- ── RLS: anon baseline ──────────────────────────────────────
drop policy if exists "anon read room revisions"   on public.syncpad_room_revisions;
drop policy if exists "anon insert room revisions" on public.syncpad_room_revisions;

create policy "anon read room revisions"
  on public.syncpad_room_revisions for select to anon using (true);

create policy "anon insert room revisions"
  on public.syncpad_room_revisions for insert to anon with check (true);

-- ── RLS: authenticated baseline ─────────────────────────────
-- Same reasoning as syncpad_rooms/syncpad_files: once an admin signs in,
-- the shared client sends requests as `authenticated`, so normal room
-- usage (including saving revisions) needs the same baseline access.
drop policy if exists "authenticated baseline read room revisions"   on public.syncpad_room_revisions;
drop policy if exists "authenticated baseline insert room revisions" on public.syncpad_room_revisions;

create policy "authenticated baseline read room revisions"
  on public.syncpad_room_revisions for select to authenticated using (true);

create policy "authenticated baseline insert room revisions"
  on public.syncpad_room_revisions for insert to authenticated with check (true);

-- ── RLS: admin-only delete ──────────────────────────────────
drop policy if exists "admin delete room revisions" on public.syncpad_room_revisions;

create policy "admin delete room revisions"
  on public.syncpad_room_revisions for delete to authenticated
  using (public.is_syncpad_admin());

-- ── Auto-prune: keep only the most recent 50 revisions per room ─────
create or replace function public.prune_syncpad_room_revisions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.syncpad_room_revisions
   where room_id = new.room_id
     and id not in (
       select id from public.syncpad_room_revisions
        where room_id = new.room_id
        order by created_at desc
        limit 50
     );
  return null; -- AFTER trigger; return value is ignored
end;
$$;

do $$
begin
  if not exists (
    select 1
      from pg_trigger
     where tgname = 'syncpad_room_revisions_prune'
       and tgrelid = 'public.syncpad_room_revisions'::regclass
  ) then
    create trigger syncpad_room_revisions_prune
      after insert on public.syncpad_room_revisions
      for each row
      execute function public.prune_syncpad_room_revisions();
  end if;
end $$;

comment on table public.syncpad_room_revisions
  is 'Snapshots of syncpad_rooms.content for version history / restore. Pruned to the 50 most recent rows per room by the syncpad_room_revisions_prune trigger.';

-- ════════════════════════════════════════════════════════════════
-- OPTIONAL: Maintenance queries (run manually as needed)
-- ════════════════════════════════════════════════════════════════
--
-- -- 1) Count revisions per room, largest first
-- select room_id, count(*) as revision_count
-- from   public.syncpad_room_revisions
-- group by room_id
-- order by revision_count desc
-- limit 50;
--
-- -- 2) Total storage used by revision content, in bytes (approx)
-- select sum(octet_length(content)) as approx_bytes
-- from   public.syncpad_room_revisions;
