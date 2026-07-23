-- ============================================================
-- SyncPad – Room Edit Tokens Migration
-- SAFE TO RERUN: all statements use CREATE IF NOT EXISTS,
-- CREATE OR REPLACE, and DROP POLICY IF EXISTS / CREATE POLICY
-- so the script is fully idempotent.
--
-- Run this in your Supabase project → SQL Editor AFTER
-- 0001_base_schema.sql has been applied.
--
-- What this migration adds
-- ────────────────────────
-- Real, server-enforced separation between "can view this room" and "can
-- edit this room". Before this migration, both editable and read-only
-- links resolved to the same room_id, and room_id alone was a sufficient
-- credential to write via the anon key — read-only links were a frontend
-- convenience only (see docs/security.md). That is not fixable by
-- tightening RLS on syncpad_rooms alone: a read-only viewer has to
-- receive the room's content to display it, and content is keyed by
-- room_id, so they necessarily learn the room_id too.
--
-- The fix is a second secret, issued only once, only to whoever creates
-- (or is later re-shared) the room:
--
--   1. syncpad_room_edit_tokens — one random 192-bit token per room.
--      RLS-locked like syncpad_share_links/syncpad_room_codes: no direct
--      anon/authenticated table access at all, only through the two
--      SECURITY DEFINER functions below. Deliberately its own table, not
--      a column on syncpad_rooms — syncpad_rooms is in the Realtime
--      publication, and Supabase's postgres_changes payloads are derived
--      from the WAL, bypassing column-level grants/RLS entirely. A column
--      on syncpad_rooms would leak to every connected viewer, read-only
--      included, over the very channel that pushes live content updates.
--
--   2. create_room_with_edit_token(room_id, room_name, created_by_device)
--      — creates the room row and its token atomically, returns the
--      token once. There is no "look up an existing room's token" RPC —
--      that would just recreate the original problem (room_id becoming
--      sufficient to derive write access again). The token is shown to
--      the creator once, embedded in the "editable" link the Share modal
--      generates (?et=…). Losing that link means permanently losing edit
--      access to that room — there is no recovery path by design.
--
--   3. verify_edit_token(room_id, edit_token) — lets the client check
--      up front (at room load) whether a token it's holding is actually
--      valid, so an editable-looking link with a wrong/stale token shows
--      as read-only immediately instead of only failing on first save.
--
--   4. rpc_update_room(room_id, edit_token, patch jsonb) — the one write
--      path every room mutation (content saves, settings, room name,
--      clear, etc.) now goes through. Validates the token before writing
--      anything. Whitelists which columns `patch` may touch; room_id and
--      edit_token itself are never among them.
--
-- Direct anon/authenticated UPDATE and INSERT on syncpad_rooms are
-- revoked below — after this migration every non-admin write to
-- syncpad_rooms must go through rpc_update_room /
-- create_room_with_edit_token. Admin actions (syncpad_admins-gated) are
-- untouched — those already run under a separately-verified
-- is_syncpad_admin() policy, not the edit-token scheme, and legitimately
-- need to bypass a lost/unknown edit token to moderate a room.
--
-- Rooms created before this migration has no edit token and cannot gain
-- one after the fact (same reasoning as #2 above — there's no way to
-- know who the rightful owner is once room_id was the only credential).
-- Fine for a project still under active development; recreate any rooms
-- you're actively using for testing after running this.
-- ============================================================

create table if not exists public.syncpad_room_edit_tokens (
  room_id     text        primary key references public.syncpad_rooms(room_id) on delete cascade,
  edit_token  text        not null,
  created_at  timestamptz not null default now()
);

create unique index if not exists idx_syncpad_room_edit_tokens_token
  on public.syncpad_room_edit_tokens(edit_token);

alter table public.syncpad_room_edit_tokens enable row level security;

drop policy if exists "no direct edit-token reads" on public.syncpad_room_edit_tokens;
drop policy if exists "no direct edit-token writes" on public.syncpad_room_edit_tokens;

create policy "no direct edit-token reads"
  on public.syncpad_room_edit_tokens for select to public using (false);
create policy "no direct edit-token writes"
  on public.syncpad_room_edit_tokens for all to public using (false) with check (false);

-- ── Room creation (room row + its token, atomically) ──────────────────

create or replace function public.create_room_with_edit_token(
  p_room_id           text,
  p_room_name         text,
  p_created_by_device text
) returns table(
  room_id            text,
  room_name          text,
  content            text,
  created_at         timestamptz,
  updated_at         timestamptz,
  created_by_device  text,
  updated_by_device  text,
  encryption_enabled boolean,
  view_once          boolean,
  viewed             boolean,
  edit_token         text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
begin
  if p_room_id is null or btrim(p_room_id) = '' then
    raise exception 'create_room_with_edit_token: p_room_id must not be null or empty';
  end if;

  v_token := encode(gen_random_bytes(24), 'hex'); -- 192 bits, 48 hex chars

  insert into public.syncpad_rooms
    (room_id, room_name, content, created_by_device, updated_by_device, encryption_enabled, view_once, viewed)
  values
    (p_room_id, coalesce(nullif(btrim(p_room_name), ''), p_room_id), '', p_created_by_device, p_created_by_device, false, false, false);

  insert into public.syncpad_room_edit_tokens (room_id, edit_token)
  values (p_room_id, v_token);

  return query
  select r.room_id, r.room_name, r.content, r.created_at, r.updated_at,
         r.created_by_device, r.updated_by_device, r.encryption_enabled, r.view_once, r.viewed,
         v_token
    from public.syncpad_rooms r
   where r.room_id = p_room_id;
end;
$$;

-- ── Token verification (client checks up front, before ever writing) ──

create or replace function public.verify_edit_token(
  p_room_id    text,
  p_edit_token text
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.syncpad_room_edit_tokens t
     where t.room_id = p_room_id
       and t.edit_token = p_edit_token
  );
$$;

-- ── The one write path for token-holding clients ───────────────────────
-- p_patch is a whitelist-applied partial update: any key not listed below
-- is silently ignored (not an error) so callers can keep passing a plain
-- JS object shape without needing to strip unrelated keys first — the
-- existing updateRoomSettings()/updateRoom() call sites already do their
-- own key selection in JS; this is a second, server-side backstop.

create or replace function public.rpc_update_room(
  p_room_id    text,
  p_edit_token text,
  p_patch      jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.verify_edit_token(p_room_id, p_edit_token) then
    raise exception 'Invalid or missing edit token for this room.' using errcode = '42501';
  end if;

  update public.syncpad_rooms r set
    content            = coalesce(p_patch->>'content', r.content),
    room_name          = coalesce(p_patch->>'room_name', r.room_name),
    updated_by_device  = coalesce(p_patch->>'updated_by_device', r.updated_by_device),
    passcode_hash      = case when p_patch ? 'passcode_hash'      then p_patch->>'passcode_hash'                    else r.passcode_hash      end,
    passcode_salt      = case when p_patch ? 'passcode_salt'      then p_patch->>'passcode_salt'                    else r.passcode_salt      end,
    encryption_enabled = case when p_patch ? 'encryption_enabled' then (p_patch->>'encryption_enabled')::boolean    else r.encryption_enabled end,
    encryption_salt    = case when p_patch ? 'encryption_salt'    then p_patch->>'encryption_salt'                  else r.encryption_salt    end,
    expires_at         = case when p_patch ? 'expires_at'         then nullif(p_patch->>'expires_at', '')::timestamptz else r.expires_at       end,
    view_once          = case when p_patch ? 'view_once'          then (p_patch->>'view_once')::boolean             else r.view_once          end,
    viewed             = case when p_patch ? 'viewed'             then (p_patch->>'viewed')::boolean                else r.viewed             end,
    editing_locked     = case when p_patch ? 'editing_locked'     then (p_patch->>'editing_locked')::boolean        else r.editing_locked     end,
    cleared_reason     = case when p_patch ? 'cleared_reason'     then p_patch->>'cleared_reason'                   else r.cleared_reason     end,
    device_limit       = case when p_patch ? 'device_limit'       then nullif(p_patch->>'device_limit', '')::int    else r.device_limit       end
  where r.room_id = p_room_id;
end;
$$;

-- ── View-once consumption (deliberately does NOT require an edit token) ─
-- View-once's whole mechanic is "the act of a real reader viewing the note
-- clears it" — the reader is, by definition, not the room's creator and has
-- no edit token. This is a narrow, self-contained state transition (not a
-- general write): it only ever fires once per room, only when view_once is
-- armed and not yet viewed, and never for the room's own creator. Device id
-- is a client-supplied, non-adversarial value everywhere else in SyncPad
-- (used for attribution, not access control) — treating it the same way
-- here is consistent, not a new weaker trust boundary.

create or replace function public.rpc_consume_view_once(
  p_room_id             text,
  p_replacement_content text,
  p_requesting_device   text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  update public.syncpad_rooms r set
    viewed             = true,
    content            = p_replacement_content,
    updated_by_device  = p_requesting_device,
    cleared_reason     = 'view_once'
  where r.room_id = p_room_id
    and r.view_once = true
    and r.viewed = false
    and r.cleared_reason is distinct from 'view_once'
    and r.created_by_device is distinct from p_requesting_device;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

grant execute on function public.create_room_with_edit_token(text, text, text) to anon, authenticated;
grant execute on function public.verify_edit_token(text, text) to anon, authenticated;
grant execute on function public.rpc_update_room(text, text, jsonb) to anon, authenticated;
grant execute on function public.rpc_consume_view_once(text, text, text) to anon, authenticated;

-- ── Close the credential gap: room_id alone can no longer write ───────
-- rpc_update_room()/create_room_with_edit_token() are SECURITY DEFINER,
-- so they don't need these grants themselves — only direct PostgREST
-- table access (anon's/authenticated's own UPDATE/INSERT requests) does.
-- Admin's own update policy (`admin update rooms`, is_syncpad_admin()
-- gated) is untouched — it's a separate, already-verified path.

drop policy if exists "anon update rooms" on syncpad_rooms;
drop policy if exists "anon insert rooms" on syncpad_rooms;
drop policy if exists "authenticated baseline update rooms" on syncpad_rooms;
drop policy if exists "authenticated baseline insert rooms" on syncpad_rooms;

comment on table public.syncpad_room_edit_tokens
  is 'One write credential per room, separate from room_id. Issued once at room creation via create_room_with_edit_token(); never re-readable afterward. All syncpad_rooms writes from non-admin clients go through rpc_update_room(), which checks this table first.';
