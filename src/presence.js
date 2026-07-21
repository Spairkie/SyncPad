// SyncPad – presence.js
// Supabase Presence: tracks connected devices, typing state, and cursor activity.
import { getSupabaseClient } from './supabase.js';
import { getDeviceId, getDeviceName, throttle } from './utils.js';

let _ch               = null;
let _roomId           = null;
let _typingTimer      = null;
let _onPresenceChange = null; // (devices: Device[]) => void
let _readOnly         = false;
let _tabId            = null;

function _getTabId() {
  if (_tabId) return _tabId;
  try {
    let id = sessionStorage.getItem('syncpad_tab_id');
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem('syncpad_tab_id', id);
    }
    _tabId = id;
    return id;
  } catch {
    _tabId = crypto.randomUUID();
    return _tabId;
  }
}

/**
 * Initialize presence for a room.
 * @param {string} roomId
 * @param {function(Device[]): void} onPresenceChange
 * @param {object} [opts]
 * @param {boolean} [opts.readOnly]
 */
export function initPresence(roomId, onPresenceChange, { readOnly = false } = {}) {
  destroyPresence();
  _roomId           = roomId;
  _onPresenceChange = onPresenceChange;
  _readOnly         = readOnly;
  const sb       = getSupabaseClient();
  const deviceId = getDeviceId();
  const tabId    = _getTabId();

  _ch = sb.channel(`presence:${roomId}`, { config: { presence: { key: `${deviceId}:${tabId}` } } });

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
          cursor_pos:  null,
          joined_at:   Date.now(),
          tab_id:      tabId,
        });
        notify();
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
    cursor_pos:  null,
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
 * Broadcast this device's cursor location (throttled).
 * Read-only devices broadcast their scroll position but NOT as "typing".
 * @param {number|null} lineNumber – 1-based line number, or null to clear
 * @param {number|null} [pos]      – precise character offset into the note,
 *                                   used to render in-text remote carets
 */
export const setCursorLine = throttle(function(lineNumber, pos = null) {
  _track({ cursor_line: lineNumber ?? null, cursor_pos: pos ?? null });
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
 * @returns {{ device_id, device_name, typing, read_only, cursor_line, cursor_pos, isMe }[]}
 */
export function getConnectedDevices() {
  const state   = getPresenceState();
  const myId    = getDeviceId();
  const byDevice = new Map();

  for (const key of Object.keys(state)) {
    const entries = state[key];
    if (!Array.isArray(entries) || !entries.length) continue;
    for (const e of entries) {
      const id = e.device_id || key.split(':')[0] || key;
      const prev = byDevice.get(id);
      const joined = Number(e.joined_at || 0);
      const prevJoined = Number(prev?.joined_at || 0);
      const useCurrent = !prev || joined >= prevJoined;
      byDevice.set(id, {
        device_id:   id,
        device_name: useCurrent ? (e.device_name || prev?.device_name || 'Unknown') : (prev?.device_name || 'Unknown'),
        typing:      Boolean(prev?.typing || e.typing),
        read_only:   useCurrent ? !!e.read_only : !!prev.read_only,
        cursor_line: useCurrent ? (e.cursor_line ?? null) : (prev.cursor_line ?? null),
        cursor_pos:  useCurrent ? (e.cursor_pos  ?? null) : (prev.cursor_pos  ?? null),
        joined_at:   useCurrent ? joined : prevJoined,
        isMe:        id === myId,
      });
    }
  }

  const devices = Array.from(byDevice.values());
  devices.sort((a, b) => a.isMe ? -1 : b.isMe ? 1 : a.device_name.localeCompare(b.device_name));
  return devices;
}

/** Tear down the presence channel. */
export function destroyPresence() {
  if (_ch) {
    try { _ch.untrack(); } catch {}
    getSupabaseClient().removeChannel(_ch);
    _ch = null;
  }
  clearTimeout(_typingTimer);
  setCursorLine.cancel?.();
  _roomId           = null;
  _onPresenceChange = null;
  _readOnly         = false;
  _lastTracked      = {};
}
