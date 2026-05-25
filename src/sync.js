// SyncPad – sync.js
// Coordinates two sync tracks:
//   • Live Typing Lane  – Supabase Broadcast ~250 ms throttle, ephemeral
//   • Save Lane         – Postgres, 1000 ms debounce + flush on blur/unload
//
// Realtime payload contract:
//   Typing/activity broadcasts are metadata-only and intentionally never carry
//   note content. Content sync is handled by DB saves + postgres_changes.
//
// Conflict contract:
//   Active typing (< 3 s) → queue remote updates, show notice.
//   Idle → apply remote updates immediately.
//
// Permission contract:
//   canEdit() and canBroadcastTyping() are checked at the input boundary.
//   Read-only / locked clients never trigger saves or typing broadcasts.

import { saveContent }           from './rooms.js';
import { broadcastTyping }       from './live-broadcast.js';
import { saveDraft, clearDraft } from './offline.js';
import { debounce, getDeviceId } from './utils.js';
import { canEdit, canBroadcastTyping, getPermissionContext } from './permissions.js';

const IDLE_THRESHOLD_MS = 3000;
const SAVE_DEBOUNCE_MS  = 1000;

// ── Module state ──────────────────────────────────────────────────────────────

let _roomId           = null;
let _encryptFn        = null; // async (plaintext: string) → ciphertext: string
let _decryptFn        = null; // async (ciphertext: string) → plaintext: string
let _getEditorVal     = null;
let _setEditorVal     = null;
let _onStatusChange   = null;
let _onPendingRemote  = null;
let _onDismissPending = null;

let _localLastEditAt           = 0;
let _pendingRemoteContent      = null;
let _pendingRemoteTimestamp    = null;
let _applyingRemote            = false;
let _seqNum                    = 0;

// ── Init / Destroy ────────────────────────────────────────────────────────────

export function initSync(opts) {
  _roomId           = opts.roomId;
  _encryptFn        = opts.encryptFn        || null;
  _decryptFn        = opts.decryptFn        || null;
  _getEditorVal     = opts.getEditorVal;
  _setEditorVal     = opts.setEditorVal;
  _onStatusChange   = opts.onStatusChange   || (() => {});
  _onPendingRemote  = opts.onPendingRemote  || (() => {});
  _onDismissPending = opts.onDismissPending || (() => {});

  _localLastEditAt           = 0;
  _pendingRemoteContent      = null;
  _applyingRemote            = false;
  _seqNum                    = 0;
}

export function setEncryption(encryptFn, decryptFn) {
  _encryptFn = encryptFn;
  _decryptFn = decryptFn;
}

export function destroySync() {
  _debouncedSave.cancel?.();
  _roomId    = null;
  _encryptFn = null;
  _decryptFn = null;
}

// ── Local input handler ───────────────────────────────────────────────────────
// Called from the textarea 'input' event. Returns a Promise (fire-and-forget OK).

export async function onLocalInput() {
  if (_applyingRemote) return;
  // If editing is blocked (read-only URL, room lock, or encryption with no
  // key), do nothing. The editor should already be readonly, but defend the
  // boundary here too so a stray keystroke never causes a save or broadcast.
  if (!canEdit()) return;

  // Set the typing timestamp synchronously so conflict detection is accurate
  _localLastEditAt = Date.now();

  const plaintext = _getEditorVal();

  // Save draft immediately. Encrypted rooms store encrypted local drafts only;
  // if draft encryption fails, offline.js refuses to fall back to plaintext.
  await saveDraft(_roomId, plaintext, { encryptFn: _encryptFn });

  // Kick off debounced DB save
  _onStatusChange('saving');
  _debouncedSave();

  // Broadcast metadata-only typing activity (no note text/ciphertext payload).
  // Skip broadcasting in read-only mode (canBroadcastTyping is false).
  if (canBroadcastTyping()) {
    broadcastTyping(++_seqNum);
  }
}

export function onEditorBlur() { return _debouncedSave.flush?.(); }
export function flushSave()    { return _debouncedSave.flush?.(); }
export function cancelPendingSave() { _debouncedSave.cancel?.(); }

// ── Debounced DB save ─────────────────────────────────────────────────────────

const _debouncedSave = debounce(async () => {
  if (!_roomId) return;

  // Re-check permissions at execution time, not only when input occurred.
  // A save may have been queued before another device locked the room, switched
  // this client to read-only, or enabled encryption without this client having
  // the key. In those cases the queued save must not write stale/plaintext data.
  if (!canEdit()) {
    _onStatusChange('saved');
    return;
  }

  try {
    let content = _getEditorVal();
    if (_encryptFn) content = await _encryptFn(content);
    await saveContent(_roomId, content);
    clearDraft(_roomId);
    _onStatusChange('saved');
  } catch {
    _onStatusChange('error');
  }
}, SAVE_DEBOUNCE_MS);

// ── Remote: broadcast typing from another device ──────────────────────────────

export async function handleRemoteTyping(payload) {
  if (_applyingRemote) return;
  if (_mustIgnoreEncryptedRemote()) return;

  // Realtime typing is metadata-only. Remote content must arrive via DB changes.
  if (payload?.ts) _pendingRemoteTimestamp = payload.ts;
}

// ── Remote: Postgres DB change ────────────────────────────────────────────────

export async function handleRemoteDatabaseChange(newRoom) {
  if (_applyingRemote) return;
  if (_mustIgnoreEncryptedRemote()) return;

  if (newRoom.updated_by_device === getDeviceId()) return;

  let remoteText = newRoom.content || '';
  if (_decryptFn && remoteText) {
    try { remoteText = await _decryptFn(remoteText); }
    catch { return; }
  }

  // Do not reject DB updates by comparing server updated_at to local Date.now().
  // Client clocks can drift; we only ignore our own writes via updated_by_device.

  if (_isLocallyActive()) {
    _pendingRemoteContent   = remoteText;
    _pendingRemoteTimestamp = newRoom.updated_at || null;
    _onPendingRemote(remoteText, 'db');
  } else {
    _applyContentSafe(remoteText);
    _onDismissPending();
  }
}

// ── Apply / dismiss pending remote update ─────────────────────────────────────

export function applyPendingRemote() {
  if (_pendingRemoteContent === null) return;
  _applyContentSafe(_pendingRemoteContent);
  _clearPending();
}

export function dismissPendingRemote() {
  _clearPending();
  _onDismissPending();
}

/** Returns the current pending remote content (or null). */
export function getPendingRemote() {
  return _pendingRemoteContent;
}

export function getPendingRemoteTs() {
  return _pendingRemoteTimestamp;
}

function _clearPending() {
  _pendingRemoteContent   = null;
  _pendingRemoteTimestamp = null;
}

// ── Set content without triggering a local save ───────────────────────────────

export function setContentNoSave(plaintext) {
  _applyingRemote = true;
  _setEditorVal(plaintext);
  _applyingRemote = false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _isLocallyActive() {
  return (Date.now() - _localLastEditAt) < IDLE_THRESHOLD_MS;
}

function _mustIgnoreEncryptedRemote() {
  const ctx = getPermissionContext();
  return !!ctx.isEncryptedNoKey && !_decryptFn;
}

function _applyContentSafe(text) {
  _applyingRemote = true;
  _setEditorVal(text);
  _applyingRemote = false;
}
