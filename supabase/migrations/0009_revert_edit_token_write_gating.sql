-- ============================================================
-- SyncPad – Revert Edit-Token Write Gating
-- SAFE TO RERUN: uses DROP POLICY IF EXISTS / CREATE POLICY.
--
-- Only needed if you already ran 0007_room_edit_tokens.sql on this
-- project — it dropped the four policies this migration restores. A
-- brand-new project that never ran 0007 already has these policies from
-- 0001 and doesn't need this file at all.
--
-- Why
-- ────
-- 0007 made room_id insufficient to write, requiring a separate edit
-- token minted once at room creation and never recoverable if lost.
-- That closed a real gap (a "read-only" share link's read-only status
-- wasn't server-enforced), but the cost — permanent lockout on a lost
-- token, no cross-device/cross-browser recovery, an extra migration
-- dependency that broke a live deployment on first real use — turned
-- out to outweigh the benefit for a personal/demo project that was
-- never meant to hold anything sensitive to begin with (see
-- DEPLOYMENT.md's own "not for sensitive data" framing, and
-- docs/security.md, which already documented room content as "not
-- secret to holders of room_id" even before 0007 existed).
--
-- This restores room_id as a sufficient write credential — a plain
-- link (or a guessed/typed room name) is directly editable again, no
-- token required, matching the app's original design. A link that
-- can't be used to edit still exists via /share/:token
-- (get_or_create_readonly_share_link / resolve_readonly_share_link,
-- both from 0001) — its "read-only" guarantee is a UI/UX convention
-- again rather than a server-enforced one (a technical visitor could
-- still call the update path directly with the room_id they
-- necessarily learn from viewing the room's content, e.g. from the
-- realtime channel name). For an ACTUAL, server-enforced "nobody can
-- edit this" guarantee, use the room lock feature instead —
-- editing_locked is enforced by the syncpad_rooms_enforce_lock
-- trigger (0001) no matter how the write is attempted, and this
-- migration doesn't touch that.
--
-- The syncpad_room_edit_tokens table and its four functions
-- (create_room_with_edit_token, verify_edit_token, rpc_update_room,
-- rpc_consume_view_once) from 0007/0008 are left in place — inert,
-- unused by the client after this migration, but harmless. Nothing
-- here drops them.
--
-- One consequence: 0008_quarantine_enforcement.sql originally worked by
-- redefining rpc_update_room() to reject writes to a quarantined room —
-- since the client no longer calls that RPC after this migration, that
-- enforcement stops firing. 0008 has been rewritten to a BEFORE UPDATE
-- trigger instead (the same technique 0001's room-lock trigger already
-- uses), which doesn't depend on rpc_update_room at all. If you're
-- applying migrations to a project that already ran the original 0007+
-- 0008, re-run the current 0008_quarantine_enforcement.sql after this
-- one to pick up the trigger-based version.
-- ============================================================

drop policy if exists "anon insert rooms" on syncpad_rooms;
drop policy if exists "anon update rooms" on syncpad_rooms;

create policy "anon insert rooms"
  on syncpad_rooms for insert to anon with check (true);

create policy "anon update rooms"
  on syncpad_rooms for update to anon using (true) with check (true);

drop policy if exists "authenticated baseline insert rooms" on syncpad_rooms;
drop policy if exists "authenticated baseline update rooms" on syncpad_rooms;

create policy "authenticated baseline insert rooms"
  on syncpad_rooms for insert to authenticated with check (true);

create policy "authenticated baseline update rooms"
  on syncpad_rooms for update to authenticated using (true) with check (true);
