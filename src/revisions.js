// SyncPad – revisions.js
// Version history: saves/lists snapshots of a room's content
// (syncpad_room_revisions, see supabase/migrations/0004_version_history.sql).
//
// `content` here is exactly what would be written to syncpad_rooms.content —
// for encrypted rooms that means ciphertext, same as the live room row, so
// this module has no separate encryption handling of its own.

import { getSupabaseClient } from './supabase.js';
import { logSupabaseError, getDeviceId } from './utils.js';

const TABLE = 'syncpad_room_revisions';

/** Save a snapshot. Callers should treat this as best-effort. */
export async function saveRevision(roomId, content) {
  const sb = getSupabaseClient();
  const { error } = await sb.from(TABLE).insert({
    room_id:   roomId,
    content:   content || '',
    device_id: getDeviceId(),
  });
  if (error) { logSupabaseError('saveRevision', error, { room_id: roomId }); throw error; }
}

/** List revisions for a room, most recent first. */
export async function listRevisions(roomId) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from(TABLE)
    .select('id, content, created_at, device_id')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false });
  if (error) { logSupabaseError('listRevisions', error, { room_id: roomId }); throw error; }
  return data || [];
}
