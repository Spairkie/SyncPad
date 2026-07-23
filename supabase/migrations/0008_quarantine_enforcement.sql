-- ============================================================
-- SyncPad – Quarantine Enforcement Migration
-- SAFE TO RERUN: CREATE OR REPLACE, fully idempotent.
--
-- Run this in your Supabase project → SQL Editor AFTER BOTH
-- 0006_admin_dashboard_improvements.sql (adds quarantined_at) AND
-- 0007_room_edit_tokens.sql (adds rpc_update_room) have been applied.
-- Skip it if you haven't run both of those — it redefines a function
-- from 0007 to reference a column from 0006, so it fails if either
-- prerequisite is missing.
--
-- What this migration adds
-- ────────────────────────
-- 0006's own header ships an explicit "FRONTEND-ONLY SECURITY WARNING":
-- quarantine had nothing server-side checking it, so a determined user
-- could bypass it by calling the API directly. That warning suggested
-- tightening the base anon RLS policies, but deliberately didn't apply
-- it, since at the time every write still went through those same broad
-- anon policies room_id alone unlocked (see 0007's own header for why
-- that's a dead end for read-only, and the same logic applied here).
--
-- 0007 changes that: every non-admin write now goes through
-- rpc_update_room(), one single choke point. Redefining it here to also
-- reject writes to a quarantined room closes the gap 0006 flagged,
-- without touching RLS at all. A signed-in admin (is_syncpad_admin())
-- still bypasses this, same as the room-lock trigger in 0001 — quarantine
-- and lock are both meant to stop everyone EXCEPT the admin who set them.
-- ============================================================

create or replace function public.rpc_update_room(
  p_room_id    text,
  p_edit_token text,
  p_patch      jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quarantined boolean;
begin
  if not public.verify_edit_token(p_room_id, p_edit_token) then
    raise exception 'Invalid or missing edit token for this room.' using errcode = '42501';
  end if;

  select r.quarantined_at is not null into v_quarantined
    from public.syncpad_rooms r where r.room_id = p_room_id;

  if coalesce(v_quarantined, false) and not public.is_syncpad_admin() then
    raise exception 'This room has been quarantined and cannot be edited.' using errcode = '42501';
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
