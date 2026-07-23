// SyncPad – comments.js
// Ephemeral comments anchored to a text range in a room's note
// (syncpad_room_comments, see docs/migrations/room-comments.sql).
//
// `text` here is exactly what would be written for an encrypted room's
// content — ciphertext, encrypted by the caller with the same room key —
// so this module has no separate encryption handling of its own, same as
// revisions.js.

import { getSupabaseClient } from './supabase.js';
import { logSupabaseError, getDeviceId, getDeviceName } from './utils.js';

const TABLE = 'syncpad_room_comments';

/** List comments for a room, oldest first (matches reading order in the note). */
export async function listComments(roomId) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from(TABLE)
    .select('id, anchor_from, anchor_to, text, device_id, device_name, created_at')
    .eq('room_id', roomId)
    .order('created_at', { ascending: true });
  if (error) { logSupabaseError('listComments', error, { room_id: roomId }); throw error; }
  return data || [];
}

/**
 * @param {string} roomId
 * @param {{ anchorFrom: number, anchorTo: number, text: string }} comment
 */
export async function addComment(roomId, { anchorFrom, anchorTo, text }) {
  const sb = getSupabaseClient();
  const { error } = await sb.from(TABLE).insert({
    room_id:     roomId,
    anchor_from: Math.max(0, anchorFrom | 0),
    anchor_to:   Math.max(anchorFrom | 0, anchorTo | 0),
    text:        text || '',
    device_id:   getDeviceId(),
    device_name: getDeviceName(),
  });
  if (error) { logSupabaseError('addComment', error, { room_id: roomId }); throw error; }
}

export async function deleteComment(commentId) {
  const sb = getSupabaseClient();
  const { error } = await sb.from(TABLE).delete().eq('id', commentId);
  if (error) { logSupabaseError('deleteComment', error, { id: commentId }); throw error; }
}

export function subscribeToComments(roomId, onCommentsChange) {
  const sb = getSupabaseClient();
  const ch = sb.channel(`db-comments-${roomId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE,
        filter: `room_id=eq.${roomId}` }, () => onCommentsChange())
    .subscribe();
  return () => sb.removeChannel(ch);
}
