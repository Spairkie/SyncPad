-- ============================================================
-- SyncPad – Device Limit Migration ("burn after N devices join")
-- SAFE TO RERUN: all statements use CREATE IF NOT EXISTS,
-- CREATE OR REPLACE, and ALTER ... ADD COLUMN IF NOT EXISTS so
-- the script is fully idempotent.
--
-- Run this in your Supabase project → SQL Editor AFTER the
-- base supabase-setup.sql has been applied.
--
-- What this migration adds
-- ────────────────────────
--   A room-owner-configurable cap on how many distinct devices may ever
--   join a room before its content clears — a live-collaboration take on
--   burn-after-reading. The existing View-once feature already covers "the
--   first reader consumes it"; this generalizes that to "clears once N
--   different people have joined", which suits an actual multi-person
--   working session better than a single-reader model, while still
--   guaranteeing the room can't outlive its intended audience.
--
--   Deliberately NOT "expires when everyone disconnects" — that would
--   require server-side presence tracking (Supabase Presence is a Realtime-
--   only concept with no Postgres-visible state), which is a materially
--   bigger lift than a per-room settings field. Counting distinct joins is
--   reliable with the existing schema: it's decided once, synchronously, at
--   load time via a SECURITY DEFINER RPC — nothing has to observe an absence.
--
--   1. syncpad_rooms.device_limit — nullable int; null/0 means unlimited
--      (the existing default), matching how expires_at being null already
--      means "no expiry".
--
--   2. syncpad_room_seen_devices — one row per (room, device) that has ever
--      loaded the room, so re-joins by the same device never count twice.
--      RLS locked down like the other support tables (share links, room
--      codes) — only reachable through the RPC below.
--
--   3. record_room_device_view(room_id, device_id) — call once per room
--      load (after the creator/read-only exclusions the client already
--      applies for View-once, mirrored here). Idempotent per device;
--      returns whether this call was the one that hit the limit and
--      cleared the room, so the caller can still show the content it
--      already has in hand (same pattern as consumeViewOnce()).
-- ============================================================

alter table public.syncpad_rooms
  add column if not exists device_limit integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'syncpad_rooms_device_limit_check'
  ) then
    alter table public.syncpad_rooms
      add constraint syncpad_rooms_device_limit_check
      check (device_limit is null or (device_limit >= 1 and device_limit <= 50));
  end if;
end $$;

create table if not exists public.syncpad_room_seen_devices (
  room_id      text        not null references public.syncpad_rooms(room_id) on delete cascade,
  device_id    text        not null,
  first_seen_at timestamptz not null default now(),
  primary key (room_id, device_id)
);

alter table public.syncpad_room_seen_devices enable row level security;

drop policy if exists "anon no direct seen-device reads" on public.syncpad_room_seen_devices;
drop policy if exists "anon no direct seen-device writes" on public.syncpad_room_seen_devices;

create policy "anon no direct seen-device reads"
  on public.syncpad_room_seen_devices for select to anon using (false);
create policy "anon no direct seen-device writes"
  on public.syncpad_room_seen_devices for all to anon using (false) with check (false);

create or replace function public.record_room_device_view(p_room_id text, p_device_id text)
returns table(device_count int, device_limit int, expired boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit   int;
  v_count   int;
  v_expired boolean := false;
begin
  if p_room_id is null or btrim(p_room_id) = '' or p_device_id is null or btrim(p_device_id) = '' then
    return;
  end if;

  insert into public.syncpad_room_seen_devices(room_id, device_id)
  values (p_room_id, p_device_id)
  on conflict (room_id, device_id) do nothing;

  select r.device_limit into v_limit
    from public.syncpad_rooms r
   where r.room_id = p_room_id;

  select count(*) into v_count
    from public.syncpad_room_seen_devices sd
   where sd.room_id = p_room_id;

  if v_limit is not null and v_count >= v_limit then
    update public.syncpad_rooms
       set content = '',
           cleared_reason = 'device_limit',
           device_limit = null, -- one-shot: don't re-trigger once cleared
           -- Lets the client's isOwnWrite check (updated_by_device === my
           -- device id) recognize its own join as the trigger, the same
           -- signal it already uses to avoid wiping content it just earned
           -- the right to see — see app.js's _handleRoomStateTransition.
           updated_by_device = p_device_id
     where room_id = p_room_id
       and cleared_reason is distinct from 'device_limit';
    v_expired := true;
  end if;

  return query select v_count, v_limit, v_expired;
end;
$$;

grant execute on function public.record_room_device_view(text, text) to anon, authenticated;

comment on table public.syncpad_room_seen_devices
  is 'One row per distinct device that has ever loaded a room with device_limit set. Feeds record_room_device_view(), which clears the room once the count reaches the limit.';
