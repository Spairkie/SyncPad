// SyncPad – rooms.js
import { getSupabaseClient } from './supabase.js';
import { logSupabaseError, getDeviceId } from './utils.js';

const TABLE = 'syncpad_rooms';

export const REPORT_REASONS = new Set(['Spam', 'Abuse or harassment', 'Illegal or harmful content', 'Private information', 'Other']);
const REPORTS_TABLE = 'syncpad_room_reports';

// ── Read ─────────────────────────────────────────────────────────────────────

export async function loadRoom(roomId) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from(TABLE).select('*').eq('room_id', roomId).maybeSingle();
  if (error) { logSupabaseError('loadRoom', error, { room_id: roomId }); throw error; }
  return data;
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function createRoom(roomId) {
  const sb       = getSupabaseClient();
  const deviceId = getDeviceId();
  const { data, error } = await sb.from(TABLE)
    .insert({
      room_id:            roomId,
      room_name:          roomId,
      content:            '',
      created_by_device:  deviceId,
      updated_by_device:  deviceId,
      encryption_enabled: false,
      view_once:          false,
      viewed:             false,
    })
    .select()
    .single();

  if (error) {
    // Race condition: another client created it first
    if (error.code === '23505') return loadRoom(roomId);
    logSupabaseError('createRoom', error, { room_id: roomId });
    throw error;
  }
  return data;
}

// ── Content save (used by sync.js only) ──────────────────────────────────────

export async function saveContent(roomId, content) {
  const sb = getSupabaseClient();
  const { error } = await sb.from(TABLE).update({
    content,
    updated_by_device: getDeviceId(),
    cleared_reason:    null,
  }).eq('room_id', roomId);
  if (error) { logSupabaseError('saveContent', error, { room_id: roomId }); throw error; }
}

export function normalizeRoomDisplayName(title) {
  const trimmed = (title || '').trim();
  if (!trimmed) return '';
  return trimmed.slice(0, 80);
}

export async function updateRoomDisplayName(roomId, title) {
  const sb = getSupabaseClient();
  const roomName = normalizeRoomDisplayName(title);
  const { error } = await sb.from(TABLE).update({
    room_name: roomName,
    updated_by_device: getDeviceId(),
  }).eq('room_id', roomId);
  if (error) { logSupabaseError('updateRoomDisplayName', error, { room_id: roomId }); throw error; }
}

// ── Settings-only update (strips content to prevent accidental overwrites) ───

export async function updateRoomSettings(roomId, settings) {
  const sb   = getSupabaseClient();
  const safe = { ...settings };
  delete safe.content;
  delete safe.room_id;

  // DB owns updated_at via trigger; client should not stamp it with local time.
  safe.updated_by_device = getDeviceId();

  const { error } = await sb.from(TABLE).update(safe).eq('room_id', roomId);
  if (error) { logSupabaseError('updateRoomSettings', error, { room_id: roomId }); throw error; }
}

// ── Full update (allows content — used by encryption/expiration/view-once) ───

export async function updateRoom(roomId, data) {
  const sb   = getSupabaseClient();
  const safe = { ...data };
  delete safe.room_id; // never allow overwriting the PK
  const { error } = await sb.from(TABLE).update(safe).eq('room_id', roomId);
  if (error) { logSupabaseError('updateRoom', error, { room_id: roomId }); throw error; }
}

// ── Clear content ─────────────────────────────────────────────────────────────

export async function clearRoomContent(roomId, reason, replacementContent = '') {
  const sb = getSupabaseClient();
  const { error } = await sb.from(TABLE).update({
    content:           replacementContent,
    updated_by_device: getDeviceId(),
    cleared_reason:    reason || 'manual',
  }).eq('room_id', roomId);
  if (error) { logSupabaseError('clearRoomContent', error, { room_id: roomId }); throw error; }
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
// full id — same access level as the editable link, just shorter. See
// docs/migrations/short-room-codes.sql for the generation/lookup RPCs and
// the reasoning behind treating it as equivalent (not reduced) trust.

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
// See docs/migrations/device-limit.sql. Call once per room load, mirroring
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
