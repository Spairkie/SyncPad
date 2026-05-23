// SyncPad – rooms.js
import { getSupabaseClient } from './supabase.js';
import { logSupabaseError, getDeviceId } from './utils.js';

const TABLE = 'syncpad_rooms';

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
    updated_at:        new Date().toISOString(),
    updated_by_device: getDeviceId(),
    cleared_reason:    null,
  }).eq('room_id', roomId);
  if (error) { logSupabaseError('saveContent', error, { room_id: roomId }); throw error; }
}

// ── Settings-only update (strips content to prevent accidental overwrites) ───

export async function updateRoomSettings(roomId, settings) {
  const sb   = getSupabaseClient();
  const safe = { ...settings };
  delete safe.content;
  delete safe.room_id;

  // Settings-only writes still need a fresh stamp so remote clients can tell
  // who changed lock/passcode/expiration/view-once state and avoid treating
  // stale content metadata as the latest writer.
  safe.updated_at = new Date().toISOString();
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
    updated_at:        new Date().toISOString(),
    updated_by_device: getDeviceId(),
    cleared_reason:    reason || 'manual',
  }).eq('room_id', roomId);
  if (error) { logSupabaseError('clearRoomContent', error, { room_id: roomId }); throw error; }
}

// ── Realtime subscription ─────────────────────────────────────────────────────

export function subscribeToRoom(roomId, onRoomChange) {
  const sb = getSupabaseClient();
  const ch = sb.channel(`db-room-${roomId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: TABLE, filter: `room_id=eq.${roomId}` },
        (payload) => onRoomChange(payload.new))
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') {
        logSupabaseError('subscribeToRoom', new Error('Channel error'), { room_id: roomId });
      }
    });
  return () => sb.removeChannel(ch);
}
