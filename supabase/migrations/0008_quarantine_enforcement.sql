-- ============================================================
-- SyncPad – Quarantine Enforcement Migration
-- SAFE TO RERUN: CREATE OR REPLACE / DROP+CREATE TRIGGER guarded by
-- existence checks, fully idempotent.
--
-- Run this in your Supabase project → SQL Editor AFTER
-- 0006_admin_dashboard_improvements.sql (adds quarantined_at) has been
-- applied. Does NOT require 0007_room_edit_tokens.sql.
--
-- What this migration adds
-- ────────────────────────
-- 0006's own header ships an explicit "FRONTEND-ONLY" warning: quarantine
-- had nothing server-side checking it, so a determined user could bypass
-- it by calling the API directly with the anon key.
--
-- This closes that gap with a BEFORE UPDATE trigger — the same technique
-- 0001's enforce_syncpad_rooms_lock() already uses for the room-lock
-- feature — rather than routing writes through a choke-point RPC. A
-- trigger fires on every UPDATE to syncpad_rooms regardless of which
-- policy or code path permitted it, so it stays correct no matter how
-- room writes are gated at the RLS layer (this migration was originally
-- written against rpc_update_room() from 0007_room_edit_tokens.sql; see
-- 0009_revert_edit_token_write_gating.sql for why that RPC is no longer
-- the client's write path — the trigger approach here doesn't have that
-- dependency at all).
--
-- A signed-in admin (is_syncpad_admin()) still bypasses this, same as the
-- room-lock trigger — quarantine and lock are both meant to stop everyone
-- EXCEPT the admin who set them. The backend cleanup job is exempt too,
-- for the same reason the lock trigger exempts it: an expired room should
-- still be sweepable even if it's also quarantined.
-- ============================================================

create or replace function public.enforce_syncpad_rooms_quarantine()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if OLD.quarantined_at is not null
     and coalesce(NEW.updated_by_device, '') <> 'backend-cleanup'
     and not public.is_syncpad_admin()
  then
    raise exception 'This room has been quarantined and cannot be edited.' using errcode = '42501';
  end if;
  return NEW;
end;
$$;

drop trigger if exists syncpad_rooms_enforce_quarantine on public.syncpad_rooms;

create trigger syncpad_rooms_enforce_quarantine
  before update on public.syncpad_rooms
  for each row
  execute function public.enforce_syncpad_rooms_quarantine();
