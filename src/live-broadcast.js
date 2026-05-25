// SyncPad – live-broadcast.js
// Ephemeral Supabase Broadcast channel for live typing and event signalling.
import { getSupabaseClient } from './supabase.js';
import { getDeviceId, getDeviceName, throttle } from './utils.js';

const THROTTLE_MS = 250;

let _channel  = null;
let _roomId   = null;
let _handlers = {};

// ── Init / Destroy ───────────────────────────────────────────────────────────

export function initBroadcast(roomId, handlers) {
  _roomId   = roomId;
  _handlers = handlers || {};
  const sb       = getSupabaseClient();
  const deviceId = getDeviceId();

  _channel = sb.channel(`room:${roomId}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'typing' },           (m) => { const p = m.payload; if (!p || p.device_id === deviceId) return; _handlers.onRemoteTyping?.(p); })
    .on('broadcast', { event: 'settings' },         (m) => { const p = m.payload; if (!p || p.device_id === deviceId) return; _handlers.onRemoteSettings?.(p); })
    .on('broadcast', { event: 'files' },            (m) => { const p = m.payload; if (!p || p.device_id === deviceId) return; _handlers.onRemoteFiles?.(p); })
    .on('broadcast', { event: 'clear' },            (m) => { const p = m.payload; if (!p || p.device_id === deviceId) return; _handlers.onRemoteClear?.(p); })
    .on('broadcast', { event: 'expired' },          (m) => { const p = m.payload; if (!p || p.device_id === deviceId) return; _handlers.onRemoteExpired?.(p); })
    .on('broadcast', { event: 'view_once_cleared' },(m) => { const p = m.payload; if (!p || p.device_id === deviceId) return; _handlers.onRemoteViewOnce?.(p); })
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
    // Typing/activity messages are metadata-only by design.
    // Note content syncs through the debounced DB save lane + postgres_changes.
    payload: { room_id: _roomId, device_id: getDeviceId(), device_name: getDeviceName(), isTyping: true, ts: Date.now(), seq },
  });
}, THROTTLE_MS);

export function broadcastTyping(seq) { _throttledTyping(seq); }
export function cancelPendingTypingBroadcast() { _throttledTyping.cancel?.(); }

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

/** Signal other devices that the note expired. */
export function broadcastExpired() {
  _send('expired', { ts: Date.now() });
}

/** Signal other devices that a view-once note was consumed. */
export function broadcastViewOnceCleared() {
  _send('view_once_cleared', { ts: Date.now() });
}
