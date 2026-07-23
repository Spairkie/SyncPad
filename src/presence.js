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
// A per-device preference, not room-scoped — survives destroyPresence() so it
// doesn't need to be re-applied on every room navigation. app.js owns the
// persisted (localStorage) value and calls setPresenceHidden() to apply it.
let _hidden           = false;

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
          device_id:     deviceId,
          device_name:   getDeviceName(),
          typing:        false,
          read_only:     _readOnly,
          cursor_line:   null,
          cursor_pos:    null,
          cursor_anchor: null,
          hidden:        _hidden,
          joined_at:     Date.now(),
          tab_id:        tabId,
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
    device_id:     getDeviceId(),
    device_name:   getDeviceName(),
    typing:        false,
    read_only:     _readOnly,
    cursor_line:   null,
    cursor_pos:    null,
    cursor_anchor: null,
    hidden:        _hidden,
    ..._lastTracked,
    ...updates,
  };
  // "Hide my cursor & typing" always wins, even if a caller (e.g. the
  // throttled setCursorLine queued before the toggle flipped) still passes
  // a real position — the device stays in the list, just with no activity.
  if (_hidden) {
    payload.typing        = false;
    payload.cursor_line   = null;
    payload.cursor_pos    = null;
    payload.cursor_anchor = null;
  }
  payload.hidden = _hidden;
  _lastTracked = { ...payload };
  try { await _ch.track(payload); } catch {}
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Mark this device as typing (auto-clears after 3 s). */
export function setTyping(isTyping) {
  if ((_readOnly || _hidden) && isTyping) return;
  clearTimeout(_typingTimer);
  _track({ typing: isTyping });
  if (isTyping) {
    _typingTimer = setTimeout(() => _track({ typing: false }), 3000);
  }
}

/**
 * Toggle "Hide my cursor & typing" — the device stays visible in the
 * connected-devices list, but its cursor position and typing status stop
 * being broadcast to others. A per-device preference (app.js persists it to
 * localStorage), not room state, so it is deliberately untouched by
 * destroyPresence() and must be re-applied by the caller after each
 * initPresence() the same way readOnly is passed in.
 */
export function setPresenceHidden(hidden) {
  _hidden = !!hidden;
  if (_hidden) clearTimeout(_typingTimer);
  _track({});
}

/** Current "Hide my cursor & typing" preference. */
export function isPresenceHidden() {
  return _hidden;
}

/**
 * Broadcast this device's cursor location (throttled).
 * Read-only devices broadcast their scroll position but NOT as "typing".
 * @param {number|null} lineNumber – 1-based line number, or null to clear
 * @param {number|null} [pos]      – precise character offset into the note
 *                                   (selection head), used to render in-text
 *                                   remote carets
 * @param {number|null} [anchor]   – the other end of the selection, if any;
 *                                   equal to pos for a plain caret (no
 *                                   selection) — used to render a remote
 *                                   collaborator's selected range, not just
 *                                   their caret
 */
export const setCursorLine = throttle(function(lineNumber, pos = null, anchor = null) {
  _track({ cursor_line: lineNumber ?? null, cursor_pos: pos ?? null, cursor_anchor: anchor ?? pos ?? null });
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
        // AND across a device's tabs, not "whichever tab tracked most
        // recently" — a device can edit if ANY of its tabs can, so opening
        // a read-only link in a second tab on the same browser doesn't
        // flip your own editable tab's badge to "viewer".
        read_only:   (prev ? prev.read_only : true) && !!e.read_only,
        hidden:      useCurrent ? !!e.hidden : !!prev.hidden,
        cursor_line:   useCurrent ? (e.cursor_line   ?? null) : (prev.cursor_line   ?? null),
        cursor_pos:    useCurrent ? (e.cursor_pos    ?? null) : (prev.cursor_pos    ?? null),
        cursor_anchor: useCurrent ? (e.cursor_anchor ?? null) : (prev.cursor_anchor ?? null),
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
