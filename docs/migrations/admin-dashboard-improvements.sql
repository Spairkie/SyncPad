-- ============================================================
-- SyncPad – Admin Dashboard Improvements Migration
-- SAFE TO RERUN: all statements use CREATE IF NOT EXISTS,
-- ALTER … ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, and
-- DROP POLICY IF EXISTS / CREATE POLICY so the script is fully
-- idempotent.
--
-- Run this in your Supabase project → SQL Editor AFTER the
-- base supabase-setup.sql has been applied.
--
-- What this migration adds
-- ────────────────────────
--   1. syncpad_admin_audit_logs table
--      Persists a record of every action an admin takes so
--      there is a durable audit trail for compliance and
--      incident investigation.
--
--   2. Quarantine columns on syncpad_rooms
--      Lightweight first-class quarantine support:
--      quarantined_at, quarantined_by, quarantine_reason,
--      downloads_disabled.
--
--   3. Indexes on the new table and new columns.
--
--   4. RLS policies – admin-read-only on audit logs; admin-
--      only INSERT via a SECURITY DEFINER helper function.
--
--   5. log_admin_action() – SECURITY DEFINER RPC so the
--      frontend admin can write audit rows without a direct
--      INSERT policy that would expose the table to all
--      authenticated users.
--
--   6. admin_quarantine_room()   – RPC to quarantine a room.
--   7. admin_unquarantine_room() – RPC to lift a quarantine.
--
-- ⚠ FRONTEND-ONLY SECURITY WARNING ⚠
-- ─────────────────────────────────────────────────────────────
-- The quarantine feature added here is FRONTEND-ENFORCED by
-- default.  The existing "anon read rooms" and "anon update
-- rooms" RLS policies (see supabase-setup.sql) allow any
-- anonymous user to read and update ANY room, regardless of
-- quarantine status.  That means a determined user can bypass
-- the quarantine by:
--   • calling the Supabase REST API directly with the anon key
--   • using the Supabase JS client without loading the app UI
--
-- To make quarantine TRULY server-enforced you must tighten
-- the anon RLS policies on syncpad_rooms.  Example:
--
--   drop policy if exists "anon read rooms" on syncpad_rooms;
--   create policy "anon read rooms"
--     on syncpad_rooms for select to anon
--     using (quarantined_at is null);         -- block quarantined rooms from anon reads
--
--   drop policy if exists "anon update rooms" on syncpad_rooms;
--   create policy "anon update rooms"
--     on syncpad_rooms for update to anon
--     using  (quarantined_at is null)         -- block writes to quarantined rooms
--     with check (quarantined_at is null);
--
-- Those drops + recreates are NOT included in this migration
-- because changing the base anon policies is an intentional
-- breaking change that may affect other parts of the app.  An
-- operator must review and apply them explicitly.
--
-- Similarly, downloads_disabled only blocks the frontend from
-- generating signed-URL requests.  The Storage bucket itself
-- still allows any anon user with a known object path to
-- request a signed URL unless a Storage policy is added to
-- deny requests for files whose room is quarantined.
-- ============================================================


-- ════════════════════════════════════════════════════════════════
-- SECTION 1 – syncpad_admin_audit_logs
-- ════════════════════════════════════════════════════════════════
-- Every admin action (clear, delete, quarantine, review report,
-- etc.) should call log_admin_action() (defined in Section 4)
-- immediately after the action succeeds or fails.  The row is
-- immutable once written — no UPDATE or DELETE is ever issued
-- against this table except by a superuser performing emergency
-- corrections.

create table if not exists public.syncpad_admin_audit_logs (
  -- Surrogate primary key – universally unique, client-free.
  id               uuid        primary key default gen_random_uuid(),

  -- The email address of the authenticated admin who performed
  -- the action.  Stored as plain text (not a FK to auth.users)
  -- so the record survives even if the admin account is later
  -- removed.  Populated by log_admin_action() from
  -- auth.email() at call time.
  admin_email      text,

  -- Machine-readable action identifier.
  -- Suggested values (extend as needed):
  --   'clear_room'         – admin cleared a room's content
  --   'delete_room'        – admin permanently deleted a room
  --   'quarantine_room'    – admin quarantined a room
  --   'unquarantine_room'  – admin lifted quarantine on a room
  --   'delete_file'        – admin deleted a file attachment
  --   'review_report'      – admin changed a report's status
  --   'dismiss_report'     – admin dismissed a report
  --   'lock_room'          – admin set editing_locked = true
  --   'unlock_room'        – admin set editing_locked = false
  --   'disable_downloads'  – admin set downloads_disabled = true
  --   'enable_downloads'   – admin set downloads_disabled = false
  --   'run_cleanup'        – admin triggered expired-room cleanup
  action_type      text        not null,

  -- Optional FK to the affected room.  SET NULL on room deletion
  -- so the audit record survives even after the room is gone.
  target_room_id   text        references public.syncpad_rooms(room_id) on delete set null,

  -- Optional identifiers for affected file or report rows.
  -- Stored as plain uuid rather than FK so the log row survives
  -- after the target row is deleted.
  target_file_id   uuid,
  target_report_id uuid,

  -- 'success' | 'failure'
  -- Use 'failure' + error_msg when catching exceptions in the
  -- calling PL/pgSQL or the frontend.
  result           text        not null default 'success',
  error_msg        text,

  -- Free-form JSON for any extra context (IP address captured
  -- by the Edge Function, before/after values, etc.).
  -- Keep PII out of here – store only operationally relevant
  -- data.
  metadata         jsonb,

  created_at       timestamptz not null default now()
);

comment on table public.syncpad_admin_audit_logs
  is 'Immutable audit trail of every action performed by a SyncPad admin. Written via log_admin_action(); never updated or deleted by the app.';

comment on column public.syncpad_admin_audit_logs.action_type
  is 'Machine-readable action type. Suggested values: clear_room, delete_room, quarantine_room, unquarantine_room, delete_file, review_report, dismiss_report, lock_room, unlock_room, disable_downloads, enable_downloads, run_cleanup.';

comment on column public.syncpad_admin_audit_logs.result
  is 'Outcome of the action: ''success'' (default) or ''failure''. On failure, populate error_msg.';

comment on column public.syncpad_admin_audit_logs.metadata
  is 'Optional free-form JSONB for extra context (e.g. before/after values). Keep PII out.';


-- ════════════════════════════════════════════════════════════════
-- SECTION 2 – Quarantine columns on syncpad_rooms
-- ════════════════════════════════════════════════════════════════
-- These columns are all nullable / defaulting to false so that
-- existing rows are unaffected by the migration.
--
-- Usage in frontend (src/app.js or src/ui.js):
--   if (room.quarantined_at) {
--     // Show "This room has been quarantined" blocking screen.
--     // Do not render the editor or file list.
--   }
--   if (room.downloads_disabled) {
--     // Hide / disable all "Download" buttons in the files panel.
--   }
--
-- See the FRONTEND-ONLY SECURITY WARNING in the file header for
-- the limitations of this approach and how to harden it with RLS.

-- Timestamp when the room was quarantined.
-- NULL means the room is NOT quarantined.
-- Non-null means it IS quarantined — check this column first.
alter table public.syncpad_rooms
  add column if not exists quarantined_at timestamptz;

-- The admin email (or device id / system identifier) that
-- triggered the quarantine, for audit cross-reference.
alter table public.syncpad_rooms
  add column if not exists quarantined_by text;

-- Free-text reason recorded at quarantine time for display in
-- the admin dashboard and optionally to the end user.
alter table public.syncpad_rooms
  add column if not exists quarantine_reason text;

-- When true the frontend should suppress all signed-URL
-- generation and file download links for this room.
-- Note: this does NOT prevent direct Storage API calls.
-- Pair with a Storage policy if server-side enforcement is
-- needed (see FRONTEND-ONLY SECURITY WARNING).
alter table public.syncpad_rooms
  add column if not exists downloads_disabled boolean not null default false;

comment on column public.syncpad_rooms.quarantined_at
  is 'Non-null when the room is quarantined. The frontend checks this column and shows a blocked-room screen. See admin-dashboard-improvements.sql for server-side enforcement notes.';

comment on column public.syncpad_rooms.quarantined_by
  is 'Email or identifier of the admin who quarantined the room. Populated by admin_quarantine_room().';

comment on column public.syncpad_rooms.quarantine_reason
  is 'Human-readable reason for the quarantine, shown in the admin dashboard.';

comment on column public.syncpad_rooms.downloads_disabled
  is 'When true, the frontend suppresses file download links for this room. Server-side enforcement requires an additional Storage policy (see migration header).';


-- ════════════════════════════════════════════════════════════════
-- SECTION 3 – Indexes
-- ════════════════════════════════════════════════════════════════

-- Audit logs: time-range scans are the most common admin query
-- ("show me all actions in the last 24 hours").
create index if not exists idx_audit_logs_created_at
  on public.syncpad_admin_audit_logs(created_at desc);

-- Audit logs: filter by admin who performed the action.
create index if not exists idx_audit_logs_admin_email
  on public.syncpad_admin_audit_logs(admin_email);

-- Audit logs: look up all actions that touched a specific room.
create index if not exists idx_audit_logs_target_room_id
  on public.syncpad_admin_audit_logs(target_room_id)
  where target_room_id is not null;

-- Audit logs: look up all actions of a specific type
-- (e.g. "show all quarantine events").
create index if not exists idx_audit_logs_action_type
  on public.syncpad_admin_audit_logs(action_type);

-- Rooms: fast lookup of quarantined rooms (a common admin dashboard
-- view).  The partial index only covers rows where the column is
-- non-null, keeping it small.
create index if not exists idx_syncpad_rooms_quarantined_at
  on public.syncpad_rooms(quarantined_at)
  where quarantined_at is not null;

-- Rooms: fast lookup of rooms with downloads disabled.
create index if not exists idx_syncpad_rooms_downloads_disabled
  on public.syncpad_rooms(downloads_disabled)
  where downloads_disabled = true;


-- ════════════════════════════════════════════════════════════════
-- SECTION 4 – RLS policies for syncpad_admin_audit_logs
-- ════════════════════════════════════════════════════════════════
-- Design decisions:
--
--   • Anon users: NO access at all.  The table must never be
--     readable or writable by unauthenticated requests.
--
--   • Authenticated non-admin users: read the policies below.
--     The baseline policies in supabase-setup.sql do NOT grant
--     baseline access to this table, so the default deny applies
--     to non-admin authenticated users.
--
--   • Authenticated admin users: SELECT only via RLS.
--     INSERT is handled exclusively through log_admin_action()
--     (a SECURITY DEFINER function defined in this section), so
--     there is no direct INSERT policy exposed to the role.
--     This prevents an admin from crafting arbitrary log rows
--     that contradict the server-recorded truth.
--
--   • UPDATE / DELETE: no policy is created, so both are denied
--     to all roles by default.  Audit rows are immutable.

alter table public.syncpad_admin_audit_logs enable row level security;

-- Anon: explicit deny for every operation (belt-and-suspenders;
-- default deny already applies but we make the intent clear).
drop policy if exists "anon no audit log reads"  on public.syncpad_admin_audit_logs;
drop policy if exists "anon no audit log writes" on public.syncpad_admin_audit_logs;
create policy "anon no audit log reads"
  on public.syncpad_admin_audit_logs for select to anon
  using (false);
create policy "anon no audit log writes"
  on public.syncpad_admin_audit_logs for all to anon
  using (false) with check (false);

-- Admin: SELECT only.  INSERT goes through log_admin_action().
drop policy if exists "admin read audit logs" on public.syncpad_admin_audit_logs;
create policy "admin read audit logs"
  on public.syncpad_admin_audit_logs for select to authenticated
  using (public.is_syncpad_admin());

-- No INSERT policy is created for the authenticated role here.
-- All inserts must go through log_admin_action() below, which
-- runs as SECURITY DEFINER and bypasses RLS for the insert.


-- ── log_admin_action() ────────────────────────────────────────
-- SECURITY DEFINER: runs as the function owner (postgres), not
-- as the calling role, so it can INSERT into the audit log
-- regardless of RLS.  The caller's identity is verified by
-- is_syncpad_admin() before the insert proceeds.
--
-- Parameters
--   p_action_type      – required; see action_type comment above
--   p_target_room_id   – optional room that was acted on
--   p_target_file_id   – optional file that was acted on
--   p_target_report_id – optional report that was acted on
--   p_result           – 'success' (default) or 'failure'
--   p_error_msg        – error detail when p_result = 'failure'
--   p_metadata         – any extra JSONB context
--
-- Returns the uuid of the newly created audit log row.
--
-- Frontend usage (src/admin.js):
--   const { data } = await supabase.rpc('log_admin_action', {
--     p_action_type:    'delete_room',
--     p_target_room_id: roomId,
--     p_result:         'success',
--   });

create or replace function public.log_admin_action(
  p_action_type      text,
  p_target_room_id   text    default null,
  p_target_file_id   uuid    default null,
  p_target_report_id uuid    default null,
  p_result           text    default 'success',
  p_error_msg        text    default null,
  p_metadata         jsonb   default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id         uuid;
  v_admin_email text;
begin
  -- Gate: only admins may write audit logs.
  if not public.is_syncpad_admin() then
    raise exception 'log_admin_action: caller is not a SyncPad admin';
  end if;

  -- Capture the calling admin's email from the JWT claim.
  -- auth.email() is available in SECURITY DEFINER context.
  v_admin_email := auth.email();

  insert into public.syncpad_admin_audit_logs (
    admin_email,
    action_type,
    target_room_id,
    target_file_id,
    target_report_id,
    result,
    error_msg,
    metadata
  ) values (
    v_admin_email,
    p_action_type,
    p_target_room_id,
    p_target_file_id,
    p_target_report_id,
    coalesce(p_result, 'success'),
    p_error_msg,
    p_metadata
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.log_admin_action(text, text, uuid, uuid, text, text, jsonb)
  is 'SECURITY DEFINER: verifies the caller is a SyncPad admin then inserts an immutable audit-log row. All admin actions should call this immediately after they complete.';

-- Grant EXECUTE to authenticated so admin users can call it via RPC.
-- Anon access is intentionally withheld.
grant execute on function public.log_admin_action(text, text, uuid, uuid, text, text, jsonb)
  to authenticated;

revoke execute on function public.log_admin_action(text, text, uuid, uuid, text, text, jsonb)
  from anon;


-- ════════════════════════════════════════════════════════════════
-- SECTION 5 – admin_quarantine_room()
-- ════════════════════════════════════════════════════════════════
-- Sets quarantined_at, quarantined_by, and quarantine_reason on
-- the target room, then writes an audit log row.
--
-- Parameters
--   p_room_id      – room_id of the room to quarantine (required)
--   p_reason       – human-readable reason (required)
--   p_quarantined_by – admin email or identifier (required)
--
-- Raises an exception if:
--   • the caller is not an admin
--   • p_room_id does not match any existing room
--
-- Returns void.  The frontend should check for a Postgres
-- exception and display an error toast if one is raised.
--
-- Frontend usage (src/admin.js):
--   await supabase.rpc('admin_quarantine_room', {
--     p_room_id:        roomId,
--     p_reason:         'Spam / harmful content',
--     p_quarantined_by: currentAdminEmail,
--   });

create or replace function public.admin_quarantine_room(
  p_room_id        text,
  p_reason         text,
  p_quarantined_by text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows_affected integer;
begin
  -- ── Auth check ───────────────────────────────────────────────
  if not public.is_syncpad_admin() then
    raise exception 'admin_quarantine_room: caller is not a SyncPad admin';
  end if;

  -- ── Validate inputs ──────────────────────────────────────────
  if p_room_id is null or btrim(p_room_id) = '' then
    raise exception 'admin_quarantine_room: p_room_id must not be null or empty';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'admin_quarantine_room: p_reason must not be null or empty';
  end if;

  if p_quarantined_by is null or btrim(p_quarantined_by) = '' then
    raise exception 'admin_quarantine_room: p_quarantined_by must not be null or empty';
  end if;

  -- ── Apply quarantine ─────────────────────────────────────────
  update public.syncpad_rooms
     set quarantined_at     = now(),
         quarantined_by     = p_quarantined_by,
         quarantine_reason  = p_reason,
         -- Automatically disable downloads when quarantined.
         -- The admin can re-enable them independently via a
         -- separate update if the room is later reviewed.
         downloads_disabled = true
   where room_id = p_room_id;

  get diagnostics v_rows_affected = row_count;

  if v_rows_affected = 0 then
    raise exception 'admin_quarantine_room: room % not found', p_room_id;
  end if;

  -- ── Write audit log ──────────────────────────────────────────
  -- Fires synchronously so the log row and the quarantine update
  -- are in the same transaction.  If this call raises, the whole
  -- transaction is rolled back, which is the correct behaviour.
  perform public.log_admin_action(
    p_action_type    => 'quarantine_room',
    p_target_room_id => p_room_id,
    p_result         => 'success',
    p_metadata       => jsonb_build_object(
                          'reason',         p_reason,
                          'quarantined_by', p_quarantined_by
                        )
  );
end;
$$;

comment on function public.admin_quarantine_room(text, text, text)
  is 'SECURITY DEFINER: quarantines a room by setting quarantined_at and related columns, then writes an audit log row. Raises an exception for non-admin callers or missing rooms.';

grant execute on function public.admin_quarantine_room(text, text, text)
  to authenticated;

revoke execute on function public.admin_quarantine_room(text, text, text)
  from anon;


-- ════════════════════════════════════════════════════════════════
-- SECTION 6 – admin_unquarantine_room()
-- ════════════════════════════════════════════════════════════════
-- Clears all quarantine columns on the target room and writes an
-- audit log row.  Downloads are re-enabled automatically.
--
-- Parameters
--   p_room_id – room_id of the room to unquarantine (required)
--
-- Raises an exception if:
--   • the caller is not an admin
--   • p_room_id does not match any existing room
--
-- Returns void.
--
-- Frontend usage (src/admin.js):
--   await supabase.rpc('admin_unquarantine_room', {
--     p_room_id: roomId,
--   });

create or replace function public.admin_unquarantine_room(
  p_room_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows_affected integer;
begin
  -- ── Auth check ───────────────────────────────────────────────
  if not public.is_syncpad_admin() then
    raise exception 'admin_unquarantine_room: caller is not a SyncPad admin';
  end if;

  -- ── Validate input ───────────────────────────────────────────
  if p_room_id is null or btrim(p_room_id) = '' then
    raise exception 'admin_unquarantine_room: p_room_id must not be null or empty';
  end if;

  -- ── Clear quarantine ─────────────────────────────────────────
  update public.syncpad_rooms
     set quarantined_at     = null,
         quarantined_by     = null,
         quarantine_reason  = null,
         downloads_disabled = false
   where room_id = p_room_id;

  get diagnostics v_rows_affected = row_count;

  if v_rows_affected = 0 then
    raise exception 'admin_unquarantine_room: room % not found', p_room_id;
  end if;

  -- ── Write audit log ──────────────────────────────────────────
  perform public.log_admin_action(
    p_action_type    => 'unquarantine_room',
    p_target_room_id => p_room_id,
    p_result         => 'success'
  );
end;
$$;

comment on function public.admin_unquarantine_room(text)
  is 'SECURITY DEFINER: lifts quarantine on a room by clearing quarantined_at and related columns, re-enables downloads, then writes an audit log row. Raises an exception for non-admin callers or missing rooms.';

grant execute on function public.admin_unquarantine_room(text)
  to authenticated;

revoke execute on function public.admin_unquarantine_room(text)
  from anon;


-- ════════════════════════════════════════════════════════════════
-- SECTION 7 – Frontend integration notes (non-executable)
-- ════════════════════════════════════════════════════════════════
--
-- 1. CHECKING QUARANTINE IN THE APP
--    After loading a room row, check:
--
--      if (room.quarantined_at) {
--        UI.showQuarantinedScreen(room.quarantine_reason);
--        return;   // do not proceed to render the editor
--      }
--
--    The quarantine check should happen before any decryption
--    attempt, passcode prompt, or editor initialisation.
--
-- 2. CHECKING DOWNLOADS_DISABLED
--    Before calling src/files.js to generate a signed URL:
--
--      if (room.downloads_disabled) {
--        // Hide "Download" buttons; do not call getSignedUrl().
--      }
--
-- 3. CALLING THE QUARANTINE RPCs FROM src/admin.js
--
--      // Quarantine
--      const { error } = await supabase.rpc('admin_quarantine_room', {
--        p_room_id:        roomId,
--        p_reason:         reason,
--        p_quarantined_by: adminEmail,
--      });
--
--      // Unquarantine
--      const { error } = await supabase.rpc('admin_unquarantine_room', {
--        p_room_id: roomId,
--      });
--
-- 4. LOGGING CUSTOM ADMIN ACTIONS
--    For actions not handled by the quarantine RPCs (e.g.
--    clearing a room, reviewing a report), call:
--
--      await supabase.rpc('log_admin_action', {
--        p_action_type:    'clear_room',     // or 'review_report', etc.
--        p_target_room_id: roomId,
--        p_result:         'success',
--        p_metadata:       { cleared_reason: 'manual' },
--      });
--
-- 5. SERVER-SIDE QUARANTINE ENFORCEMENT (OPTIONAL)
--    To block anonymous API access to quarantined rooms, replace
--    the base anon read/update policies in supabase-setup.sql
--    with the tightened versions shown in the FRONTEND-ONLY
--    SECURITY WARNING at the top of this file.  Do this only
--    after verifying that no other app behaviour depends on
--    unconditional anon read access to all rooms.
--
-- ════════════════════════════════════════════════════════════════
-- END OF MIGRATION
-- ════════════════════════════════════════════════════════════════
