// SyncPad – live-broadcast.js
// Ephemeral Supabase Broadcast channel for live typing and event signalling.
import { getSupabaseClient } from './supabase.js';
import { getDeviceId, getDeviceName, throttle } from './utils.js';

export const LIVE_CONTENT_BROADCAST_MAX_CHARS = 32000;
export const LIVE_CONTENT_BROADCAST_THROTTLE_MS = 250;

let _channel  = null;
let _roomId   = null;
let _handlers = {};

// ── Init / Destroy ───────────────────────────────────────────────────────────

export function initBroadcast(roomId, handlers) {
  _roomId   = roomId;
  _handlers = handlers || {};
  const sb       = getSupabaseClient();
  const deviceId = getDeviceId();

  // Each handler is wrapped in try/catch so a bug in a downstream callback
  // cannot abort the Supabase Realtime subscription for the whole session.
  const _safeCall = (callback, payload) => {
    try { callback?.(payload); } catch (err) { console.error('[broadcast] handler error', err); }
  };
  // Build a self-filtering listener: ignore messages we sent ourselves.
  const _on = (event, handlerKey) => (message) => {
    const payload = message.payload;
    if (!payload || payload.device_id === deviceId) return;
    _safeCall(_handlers[handlerKey], payload);
  };

  _channel = sb.channel(`room:${roomId}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'typing' },           _on('typing',           'onRemoteTyping'))
    .on('broadcast', { event: 'content_live' },     _on('content_live',     'onRemoteLiveContent'))
    .on('broadcast', { event: 'settings' },         _on('settings',         'onRemoteSettings'))
    .on('broadcast', { event: 'files' },            _on('files',            'onRemoteFiles'))
    .on('broadcast', { event: 'clear' },            _on('clear',            'onRemoteClear'))
    .on('broadcast', { event: 'view_once_cleared' },_on('view_once_cleared','onRemoteViewOnce'))
    .on('broadcast', { event: 'cursor_chat' },      _on('cursor_chat',      'onRemoteCursorChat'))
    .on('broadcast', { event: 'cursor_chat_reaction' }, _on('cursor_chat_reaction', 'onRemoteCursorChatReaction'))
    .subscribe();

  return _channel;
}

export function destroyBroadcast() {
  if (_channel) { getSupabaseClient().removeChannel(_channel); _channel = null; }
  _roomId   = null;
  _handlers = {};
}

// ── Internal send helper ──────────────────────────────────────────────────────

function _send(event, payload) {
  if (!_channel) return;
  _channel.send({ type: 'broadcast', event, payload: { device_id: getDeviceId(), ...payload } });
}

// ── Typing (throttled) ────────────────────────────────────────────────────────

const _throttledTyping = throttle(function (seq) {
  if (!_channel || !_roomId) return;
  _channel.send({
    type:    'broadcast',
    event:   'typing',
    // Typing/activity lane is metadata-only.
    payload: { room_id: _roomId, device_id: getDeviceId(), device_name: getDeviceName(), isTyping: true, ts: Date.now(), seq },
  });
}, LIVE_CONTENT_BROADCAST_THROTTLE_MS);

export function broadcastTyping(seq) { _throttledTyping(seq); }
export function cancelPendingTypingBroadcast() { _throttledTyping.cancel?.(); }

const _throttledLiveContent = throttle(function (seq, content) {
  if (!_channel || !_roomId) return;
  const text = String(content ?? '');
  if (text.length > LIVE_CONTENT_BROADCAST_MAX_CHARS) return;
  _channel.send({
    type: 'broadcast',
    event: 'content_live',
    payload: {
      type: 'content_live',
      room_id: _roomId,
      device_id: getDeviceId(),
      device_name: getDeviceName(),
      ts: Date.now(),
      seq,
      content: text,
      content_chars: text.length,
    },
  });
}, LIVE_CONTENT_BROADCAST_THROTTLE_MS);

export function broadcastLiveContent(seq, content) { _throttledLiveContent(seq, content); }
export function cancelPendingLiveContentBroadcast() { _throttledLiveContent.cancel?.(); }

// ── Event broadcasts ──────────────────────────────────────────────────────────

/** Signal other devices to refresh room settings. */
export function broadcastSettingsChange() {
  _send('settings', { ts: Date.now() });
}

/** Signal other devices to refresh the file list. */
export function broadcastFilesChange() {
  _send('files', { ts: Date.now() });
}

/** Signal other devices that the note was manually cleared. */
export function broadcastClear(reason) {
  _send('clear', { reason: reason || 'manual', ts: Date.now() });
}

/** Signal other devices that a view-once note was consumed. */
export function broadcastViewOnceCleared() {
  _send('view_once_cleared', { ts: Date.now() });
}

/**
 * Send an ephemeral "cursor chat" message anchored to a caret position
 * (Figma's cursor-chat pattern). Never written to Postgres or the revision
 * history — receiving devices show it as a fading bubble and discard it.
 * @param {string} text
 * @param {number} pos – character offset into the note, for positioning
 *                        the bubble near the sender's caret.
 * @returns {string} a message id, so the sender's own local bubble echo can
 *                    be reacted to (via broadcastCursorChatReaction) the same
 *                    way a received one can.
 */
export function broadcastCursorChat(text, pos) {
  const trimmed = String(text || '').trim().slice(0, 80);
  if (!trimmed) return null;
  const id = `${getDeviceId()}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
  _send('cursor_chat', { device_name: getDeviceName(), text: trimmed, pos, ts: Date.now(), id });
  return id;
}

/**
 * Send an emoji quick-react targeting a specific cursor-chat message id.
 * Fire-and-forget, same as the message itself — not persisted, and the
 * target bubble may have already faded on some devices by the time this
 * arrives, in which case they simply have nothing to attach it to.
 * @param {string} targetId
 * @param {string} emoji
 */
export function broadcastCursorChatReaction(targetId, emoji) {
  if (!targetId || !emoji) return;
  _send('cursor_chat_reaction', { target_id: targetId, emoji });
}
