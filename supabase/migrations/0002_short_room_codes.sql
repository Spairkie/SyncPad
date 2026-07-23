-- ============================================================
-- SyncPad – Short Room Codes Migration
-- SAFE TO RERUN: all statements use CREATE IF NOT EXISTS,
-- CREATE OR REPLACE, and DROP POLICY IF EXISTS / CREATE POLICY
-- so the script is fully idempotent.
--
-- Run this in your Supabase project → SQL Editor AFTER the
-- base 0001_base_schema.sql has been applied.
--
-- What this migration adds
-- ────────────────────────
--   A short (6-character), human-typeable/speakable code as a companion
--   to a room's full link — e.g. reading "K7X-9BQ" aloud on a call, or
--   typing it on a phone, is easier than a long URL. Opt-in and generated
--   on demand (same model as the existing read-only share link, NOT
--   auto-created for every room), because it's a *second* bearer credential
--   for the room and every room that has one is one more thing that can be
--   guessed/enumerated.
--
--   Security note: a code is drawn from a 30-symbol alphabet (excludes
--   0/O/1/I/L/U to avoid misreads), so 6 characters is 30^6 ≈ 729 million
--   combinations — the same order of magnitude as the random suffix
--   already used in client-generated room ids (utils.js's generateRoomId,
--   36^6 ≈ 2.18 billion), not a materially weaker access path. Resolving a
--   code only ever returns the plain room_id — the client then loads that
--   room through the exact same passcode/encryption gate a normal room
--   visit goes through. A code is not a separate, higher-trust grant.
--
--   1. syncpad_room_codes table
--      One optional row per room. RLS locked down like syncpad_share_links
--      — no direct anon/authenticated table access, only through the two
--      SECURITY DEFINER functions below.
--
--   2. get_or_create_room_code(room_id) — returns the room's existing code,
--      or generates, stores, and returns a new one. Retries on the rare
--      collision instead of trusting the random draw to be unique.
--
--   3. resolve_room_code(code) — the landing page's "Join by code" lookup.
--      Returns only room_id, nothing else, so it cannot be used to bypass
--      a room's passcode/encryption the way loading a room directly can't
--      either.
-- ============================================================

create table if not exists public.syncpad_room_codes (
  room_id     text        primary key references public.syncpad_rooms(room_id) on delete cascade,
  code        text        not null,
  created_at  timestamptz not null default now()
);

create unique index if not exists idx_syncpad_room_codes_code
  on public.syncpad_room_codes(code);

alter table public.syncpad_room_codes enable row level security;

drop policy if exists "anon no direct room-code reads" on public.syncpad_room_codes;
drop policy if exists "anon no direct room-code writes" on public.syncpad_room_codes;

create policy "anon no direct room-code reads"
  on public.syncpad_room_codes for select to anon using (false);
create policy "anon no direct room-code writes"
  on public.syncpad_room_codes for all to anon using (false) with check (false);

create or replace function public.get_or_create_room_code(p_room_id text)
returns table(code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code      text;
  v_alphabet  text := '23456789ABCDEFGHJKMNPQRSTVWXYZ'; -- excludes 0/O/1/I/L/U
  v_candidate text;
  v_attempt   int  := 0;
begin
  if p_room_id is null or btrim(p_room_id) = '' then
    return;
  end if;

  select rc.code into v_code
    from public.syncpad_room_codes rc
   where rc.room_id = p_room_id
   limit 1;

  while v_code is null and v_attempt < 10 loop
    v_attempt := v_attempt + 1;
    v_candidate := '';
    for i in 1..6 loop
      v_candidate := v_candidate || substr(v_alphabet, (floor(random() * length(v_alphabet)) + 1)::int, 1);
    end loop;

    begin
      insert into public.syncpad_room_codes(room_id, code)
      values (p_room_id, v_candidate);
      v_code := v_candidate;
    exception
      when unique_violation then
        -- Either a concurrent call already gave this room a code (room_id
        -- conflict) or v_candidate collided with another room's code (the
        -- unique index on code) — either way, check for this room's code
        -- and retry the loop if it's still not there.
        select rc.code into v_code
          from public.syncpad_room_codes rc
         where rc.room_id = p_room_id
         limit 1;
    end;
  end loop;

  return query select v_code;
end;
$$;

create or replace function public.resolve_room_code(p_code text)
returns table(room_id text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_code is null or btrim(p_code) = '' then
    return;
  end if;

  return query
  select rc.room_id
    from public.syncpad_room_codes rc
   where rc.code = upper(btrim(p_code))
   limit 1;
end;
$$;

grant execute on function public.get_or_create_room_code(text) to anon, authenticated;
grant execute on function public.resolve_room_code(text) to anon, authenticated;

comment on table public.syncpad_room_codes
  is 'Optional short human-typeable code per room, generated on demand via get_or_create_room_code(). resolve_room_code() is the only read path and returns just room_id — the code is an alternate spelling of the room link, not a separate access grant.';
