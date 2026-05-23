// SyncPad – presence.js
// Supabase Presence: tracks connected devices, typing state, and cursor activity.
import { getSupabaseClient } from './supabase.js';
import { getDeviceId, getDeviceName, throttle } from './utils.js';

let _ch               = null;
let _typingTimer      = null;
let _onPresenceChange = null; // (devices: Device[]) => void
let _readOnly         = false;

/**
 * Initialize presence for a room.
 * @param {string} roomId
 * @param {function(Device[]): void} onPresenceChange
 * @param {object} [opts]
 * @param {boolean} [opts.readOnly]
 */
export function initPresence(roomId, onPresenceChange, opts = {}) {
  _onPresenceChange = onPresenceChange;
  _readOnly         = !!opts.readOnly;
  const sb       = getSupabaseClient();
  const deviceId = getDeviceId();

  _ch = sb.channel(`presence:${roomId}`, { config: { presence: { key: deviceId } } });

  const notify = () => _onPresenceChange?.(getConnectedDevices());

  _ch
    .on('presence', { event: 'sync' },  notify)
    .on('presence', { event: 'join' },  notify)
    .on('presence', { event: 'leave' }, notify)
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await _ch.track({
          device_id:   deviceId,
          device_name: getDeviceName(),
          typing:      false,
          read_only:   _readOnly,
          cursor_line: null,
          joined_at:   Date.now(),
        });
      }
    });

  return _ch;
}

// ── Internal track helper ────────────────────────────────────────────────────

let _lastTracked = {};

async function _track(updates) {
  if (!_ch) return;
  const payload = {
    device_id:   getDeviceId(),
    device_name: getDeviceName(),
    typing:      false,
    read_only:   _readOnly,
    cursor_line: null,
    ..._lastTracked,
    ...updates,
  };
  _lastTracked = { ...payload };
  try { await _ch.track(payload); } catch {}
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Mark this device as typing (auto-clears after 3 s). */
export function setTyping(isTyping) {
  if (_readOnly && isTyping) return;
  clearTimeout(_typingTimer);
  _track({ typing: isTyping });
  if (isTyping) {
    _typingTimer = setTimeout(() => _track({ typing: false }), 3000);
  }
}

/**
 * Broadcast this device's approximate cursor line (throttled).
 * Read-only devices broadcast their scroll position but NOT as "typing".
 * @param {number|null} lineNumber  – 1-based line number, or null to clear
 */
export const setCursorLine = throttle(function(lineNumber) {
  _track({ cursor_line: lineNumber ?? null });
}, 800);

/** Update the displayed device name in the presence channel. */
export async function updatePresenceDeviceName(name) {
  await _track({ device_name: name });
}

/** Get raw Supabase presence state. */
export function getPresenceState() {
  return _ch?.presenceState() || {};
}

/**
 * Returns a normalised array of connected devices, sorted: self first, then alpha.
 * @returns {{ device_id, device_name, typing, read_only, cursor_line, isMe }[]}
 */
export function getConnectedDevices() {
  const state   = getPresenceState();
  const myId    = getDeviceId();
  const devices = [];

  for (const key of Object.keys(state)) {
    const entries = state[key];
    if (!Array.isArray(entries) || !entries.length) continue;
    const e = entries[0];
    devices.push({
      device_id:   e.device_id   || key,
      device_name: e.device_name || 'Unknown',
      typing:      !!e.typing,
      read_only:   !!e.read_only,
      cursor_line: e.cursor_line ?? null,
      isMe:        (e.device_id || key) === myId,
    });
  }

  devices.sort((a, b) => a.isMe ? -1 : b.isMe ? 1 : a.device_name.localeCompare(b.device_name));
  return devices;
}

/** Tear down the presence channel. */
export function destroyPresence() {
  if (_ch) { getSupabaseClient().removeChannel(_ch); _ch = null; }
  clearTimeout(_typingTimer);
  setCursorLine.cancel?.();
  _onPresenceChange = null;
  _readOnly         = false;
  _lastTracked      = {};
}
