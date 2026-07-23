-- ============================================================
-- SyncPad – Ephemeral Room Comments Migration
-- SAFE TO RERUN: all statements use CREATE IF NOT EXISTS,
-- CREATE OR REPLACE, and DROP POLICY IF EXISTS / CREATE POLICY
-- so the script is fully idempotent.
--
-- Run this in your Supabase project → SQL Editor AFTER the
-- base supabase-setup.sql has been applied.
--
-- What this migration adds
-- ────────────────────────
--   Lightweight comments anchored to a text range in the note — Notion/
--   Google Docs' most-requested pattern, but scoped to fit SyncPad's
--   ephemeral identity instead of becoming a permanent separate discussion
--   system: a comment has no independent lifetime of its own. It cascades
--   away the moment its room does (expiry, view-once, device-limit, or
--   manual deletion — all of them already just delete/clear the
--   syncpad_rooms row or rely on the FK cascade), and its `text` column
--   holds ciphertext for an encrypted room exactly like syncpad_rooms.content
--   and syncpad_room_revisions.content already do — the client encrypts
--   with the same room passphrase-derived key before insert, so this table
--   needs no separate encryption handling of its own.
--
--   No per-user auth in this app (see syncpad_rooms/syncpad_files RLS), so
--   access control here is identical to those tables: anyone who can reach
--   the room (by link, passcode, or decryption key) can read, add, and
--   delete comments — there's no concept of "your own comment" to protect
--   from other legitimate room participants.
--
--   anchor_from/anchor_to are character offsets into the *plain* markdown
--   string (matching cursor_pos/cursor_anchor in presence.js), so a comment
--   anchored to a range can be rendered as a decoration in the CM6 live
--   surface — see live-editor.js — the same way remote selections are.
-- ============================================================

create table if not exists public.syncpad_room_comments (
  id           uuid        primary key default gen_random_uuid(),
  room_id      text        not null references public.syncpad_rooms(room_id) on delete cascade,
  anchor_from  integer     not null,
  anchor_to    integer     not null,
  text         text        not null,
  device_id    text,
  device_name  text,
  created_at   timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'syncpad_room_comments_text_len_check'
  ) then
    alter table public.syncpad_room_comments
      add constraint syncpad_room_comments_text_len_check
      check (length(text) <= 4000); -- generous headroom over ciphertext's base64 overhead for a short comment
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'syncpad_room_comments_anchor_check'
  ) then
    alter table public.syncpad_room_comments
      add constraint syncpad_room_comments_anchor_check
      check (anchor_from >= 0 and anchor_to >= anchor_from);
  end if;
end $$;

create index if not exists idx_syncpad_room_comments_room_id_created_at
  on public.syncpad_room_comments(room_id, created_at);

alter table public.syncpad_room_comments enable row level security;

drop policy if exists "anon read comments"   on public.syncpad_room_comments;
drop policy if exists "anon insert comments" on public.syncpad_room_comments;
drop policy if exists "anon delete comments" on public.syncpad_room_comments;

create policy "anon read comments"
  on public.syncpad_room_comments for select to anon using (true);
create policy "anon insert comments"
  on public.syncpad_room_comments for insert to anon with check (true);
create policy "anon delete comments"
  on public.syncpad_room_comments for delete to anon using (true);

drop policy if exists "authenticated baseline read comments"   on public.syncpad_room_comments;
drop policy if exists "authenticated baseline insert comments" on public.syncpad_room_comments;
drop policy if exists "authenticated baseline delete comments" on public.syncpad_room_comments;

create policy "authenticated baseline read comments"
  on public.syncpad_room_comments for select to authenticated using (true);
create policy "authenticated baseline insert comments"
  on public.syncpad_room_comments for insert to authenticated with check (true);
create policy "authenticated baseline delete comments"
  on public.syncpad_room_comments for delete to authenticated using (true);

drop policy if exists "admin delete comments" on public.syncpad_room_comments;
create policy "admin delete comments"
  on public.syncpad_room_comments for delete to authenticated using (public.is_syncpad_admin());

-- Realtime: lets the Comments panel live-update across devices via
-- postgres_changes, the same mechanism subscribeToRoom()/subscribeToFiles()
-- already use for syncpad_rooms/syncpad_files.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and tablename = 'syncpad_room_comments'
  ) then
    alter publication supabase_realtime add table public.syncpad_room_comments;
  end if;
end $$;

comment on table public.syncpad_room_comments
  is 'Comments anchored to a text range in a room''s note. No independent lifetime — cascades away when the room does. text is ciphertext for an encrypted room, same as syncpad_rooms.content.';
