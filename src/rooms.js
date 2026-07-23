// SyncPad – rooms.js
import { getSupabaseClient } from './supabase.js';
import { logSupabaseError, getDeviceId } from './utils.js';

const TABLE = 'syncpad_rooms';

export const REPORT_REASONS = new Set(['Spam', 'Abuse or harassment', 'Illegal or harmful content', 'Private information', 'Other']);
const REPORTS_TABLE = 'syncpad_room_reports';

// ── Edit token (session-scoped write credential) ────────────────────────────
// Room content/settings writes are no longer possible with room_id alone —
// see supabase/migrations/0007_room_edit_tokens.sql for why (a read-only
// viewer necessarily learns room_id too, so room_id can't double as the
// write credential). Every write function below reads this module-level
// token rather than taking it as a parameter, so app.js/settings.js/sync.js
// keep calling the same functions they always have — app.js just calls
// setEditToken() once when a room loads (or right after creating one), and
// resets it to null on navigation, exactly like permissions.js's context.
let _editToken = null;
export function setEditToken(token) { _editToken = token || null; }
export function getEditToken() { return _editToken; }

async function _rpcUpdateRoom(roomId, patch, label) {
  const sb = getSupabaseClient();
  const { error } = await sb.rpc('rpc_update_room', {
    p_room_id: roomId,
    p_edit_token: _editToken,
    p_patch: patch,
  });
  if (error) { logSupabaseError(label, error, { room_id: roomId }); throw error; }
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function loadRoom(roomId) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from(TABLE).select('*').eq('room_id', roomId).maybeSingle();
  if (error) { logSupabaseError('loadRoom', error, { room_id: roomId }); throw error; }
  return data;
}

/** Check whether a held edit token is actually valid for a room, before ever attempting a write. */
export async function verifyEditToken(roomId, token) {
  if (!token) return false;
  const sb = getSupabaseClient();
  const { data, error } = await sb.rpc('verify_edit_token', { p_room_id: roomId, p_edit_token: token });
  if (error) { logSupabaseError('verifyEditToken', error, { room_id: roomId }); return false; }
  return !!data;
}

/**
 * Consume a view-once room server-side. Deliberately does NOT require an
 * edit token — a view-once reader is, by definition, not the room's
 * creator and never holds one. See rpc_consume_view_once() in
 * supabase/migrations/0007_room_edit_tokens.sql.
 * @returns {Promise<boolean>} true if this call consumed the note
 */
export async function consumeViewOnceRemote(roomId, replacementContent, requestingDevice) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.rpc('rpc_consume_view_once', {
    p_room_id: roomId,
    p_replacement_content: replacementContent,
    p_requesting_device: requestingDevice,
  });
  if (error) { logSupabaseError('consumeViewOnceRemote', error, { room_id: roomId }); throw error; }
  return !!data;
}

// ── Create ───────────────────────────────────────────────────────────────────
// Returns the new room row plus its edit_token (shown here once — there is
// no "look up an existing room's token" path, by design). Caller is
// responsible for calling setEditToken() with it and keeping it (in the URL)
// or edit access is permanently lost.

export async function createRoom(roomId) {
  const sb       = getSupabaseClient();
  const deviceId = getDeviceId();
  const { data, error } = await sb.rpc('create_room_with_edit_token', {
    p_room_id: roomId,
    p_room_name: roomId,
    p_created_by_device: deviceId,
  });

  if (error) {
    // Race/collision on room_id (vanishingly rare given generateRoomId()'s
    // entropy): unlike the old insert-based flow, we can't fall back to
    // loadRoom() here — that would silently hand the caller someone else's
    // room read-only (no edit token for it). Callers should regenerate a
    // fresh room_id and retry.
    logSupabaseError('createRoom', error, { room_id: roomId });
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (row?.edit_token) setEditToken(row.edit_token);
  return row;
}

// ── Content save (used by sync.js only) ──────────────────────────────────────

export async function saveContent(roomId, content) {
  await _rpcUpdateRoom(roomId, {
    content,
    updated_by_device: getDeviceId(),
    cleared_reason: null,
  }, 'saveContent');
}

export function normalizeRoomDisplayName(title) {
  const trimmed = (title || '').trim();
  if (!trimmed) return '';
  return trimmed.slice(0, 80);
}

export async function updateRoomDisplayName(roomId, title) {
  const roomName = normalizeRoomDisplayName(title);
  await _rpcUpdateRoom(roomId, {
    room_name: roomName,
    updated_by_device: getDeviceId(),
  }, 'updateRoomDisplayName');
}

// ── Settings-only update (strips content to prevent accidental overwrites) ───

export async function updateRoomSettings(roomId, settings) {
  const safe = { ...settings };
  delete safe.content;
  delete safe.room_id;

  // DB owns updated_at via trigger; client should not stamp it with local time.
  safe.updated_by_device = getDeviceId();

  await _rpcUpdateRoom(roomId, safe, 'updateRoomSettings');
}

// ── Full update (allows content — used by encryption/expiration/view-once) ───

export async function updateRoom(roomId, data) {
  const safe = { ...data };
  delete safe.room_id; // never allow overwriting the PK
  await _rpcUpdateRoom(roomId, safe, 'updateRoom');
}

// ── Clear content ─────────────────────────────────────────────────────────────

export async function clearRoomContent(roomId, reason, replacementContent = '') {
  await _rpcUpdateRoom(roomId, {
    content: replacementContent,
    updated_by_device: getDeviceId(),
    cleared_reason: reason || 'manual',
  }, 'clearRoomContent');
}



export async function getOrCreateReadOnlyShareLink(roomId) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.rpc('get_or_create_readonly_share_link', { p_room_id: roomId });
  if (error) { logSupabaseError('getOrCreateReadOnlyShareLink', error, { room_id: roomId }); throw error; }
  return Array.isArray(data) ? data[0] || null : data;
}

export async function resolveReadOnlyShareLink(token) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.rpc('resolve_readonly_share_link', { p_token: token });
  if (error) { logSupabaseError('resolveReadOnlyShareLink', error, { token }); throw error; }
  return Array.isArray(data) ? data[0] || null : data;
}

// ── Short room codes ─────────────────────────────────────────────────────────
// A short (6-char), human-typeable/speakable alternate spelling of a room's
// full id, for reading aloud or typing on another device. Since the edit
// token redesign (0007_room_edit_tokens.sql), resolving a code only ever
// yields room_id — never an edit token — so joining by code is always
// read-only, the same as visiting the plain link. See
// supabase/migrations/0002_short_room_codes.sql for the generation/lookup RPCs.

export async function getOrCreateRoomCode(roomId) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.rpc('get_or_create_room_code', { p_room_id: roomId });
  if (error) { logSupabaseError('getOrCreateRoomCode', error, { room_id: roomId }); throw error; }
  const row = Array.isArray(data) ? data[0] || null : data;
  return row?.code || null;
}

export async function resolveRoomCode(code) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.rpc('resolve_room_code', { p_code: code });
  if (error) { logSupabaseError('resolveRoomCode', error, { code }); throw error; }
  const row = Array.isArray(data) ? data[0] || null : data;
  return row?.room_id || null;
}

// ── Device-limited rooms ("burn after N devices join") ───────────────────────
// See supabase/migrations/0005_device_limit.sql. Call once per room load, mirroring
// how consumeViewOnce() is called — the caller already has the content in
// hand from loadRoom() and keeps showing it even when this call reports the
// limit was just hit by this very view.

export async function recordRoomDeviceView(roomId, deviceId) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.rpc('record_room_device_view', { p_room_id: roomId, p_device_id: deviceId });
  if (error) { logSupabaseError('recordRoomDeviceView', error, { room_id: roomId }); throw error; }
  const row = Array.isArray(data) ? data[0] || null : data;
  return { deviceCount: row?.device_count ?? null, deviceLimit: row?.device_limit ?? null, expired: !!row?.expired };
}

export async function setDeviceLimit(roomId, limit) {
  await updateRoomSettings(roomId, { device_limit: limit });
}

export async function clearDeviceLimit(roomId) {
  await updateRoomSettings(roomId, { device_limit: null });
}


export async function submitRoomReport({ roomId, shareToken = null, reason, details = '', mode = 'editable', pageUrl = null, userAgent = null, reporterDeviceId = null } = {}) {
  const sb = getSupabaseClient();
  const normalizedRoomId = (roomId || '').trim();
  const normalizedReason = (reason || '').trim();
  const normalizedDetails = (details || '').trim().slice(0, 1000);
  const normalizedMode = mode === 'readonly' ? 'readonly' : 'editable';

  if (!normalizedRoomId) throw new Error('Room ID is required for report submission.');
  if (!REPORT_REASONS.has(normalizedReason)) throw new Error('Invalid report reason.');

  const payload = {
    room_id: normalizedRoomId,
    share_token: shareToken ? String(shareToken).trim() : null,
    report_reason: normalizedReason,
    report_details: normalizedDetails || null,
    reporter_device_id: reporterDeviceId ? String(reporterDeviceId).trim() : null,
    reporter_mode: normalizedMode,
    page_url: pageUrl ? String(pageUrl) : null,
    user_agent: userAgent ? String(userAgent) : null,
  };

  const { error } = await sb.from(REPORTS_TABLE).insert(payload);
  if (error) {
    logSupabaseError('submitRoomReport', error, { room_id: normalizedRoomId, reporter_mode: normalizedMode });
    throw error;
  }
}


// ── Realtime subscription ─────────────────────────────────────────────────────

export function subscribeToRoom(roomId, onRoomChange) {
  const sb = getSupabaseClient();
  const ch = sb.channel(`db-room-${roomId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: TABLE, filter: `room_id=eq.${roomId}` },
        (payload) => onRoomChange({ event: 'UPDATE', room: payload.new }))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: TABLE, filter: `room_id=eq.${roomId}` },
        () => onRoomChange({ event: 'DELETE', room: null }))
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') {
        logSupabaseError('subscribeToRoom', new Error('Channel error'), { room_id: roomId });
      }
    });
  return () => sb.removeChannel(ch);
}
