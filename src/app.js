// SyncPad – app.js
// Routing, room join flow, and event wiring.

import {
  getDeviceId, getDeviceName, setDeviceName,
  generateRoomId, sanitizeRoomId,
  copyToClipboard, insertTimestamp,
  isMobile, isOnline, onOnlineChange,
  buildRoomUrl, buildReadOnlyUrl, getUrlMode,
} from './utils.js';

import { loadRoom, createRoom, clearRoomContent, subscribeToRoom, getOrCreateReadOnlyShareLink, resolveReadOnlyShareLink } from './rooms.js';

import {
  initBroadcast, destroyBroadcast,
  broadcastSettingsChange, broadcastFilesChange, cancelPendingTypingBroadcast,
  broadcastClear, broadcastViewOnceCleared,
} from './live-broadcast.js';

import {
  initPresence, destroyPresence,
  setTyping, updatePresenceDeviceName, setCursorLine,
} from './presence.js';

import {
  initSync, destroySync,
  onLocalInput, onEditorBlur, flushSave, cancelPendingSave,
  handleRemoteTyping, handleRemoteDatabaseChange,
  setContentNoSave, applyPendingRemote, dismissPendingRemote, getPendingRemote, getPendingRemoteTs,
  setEncryption,
} from './sync.js';

import { uploadFile, listFiles, deleteFile, getDownloadUrl, subscribeToFiles } from './files.js';

import {
  checkPasscode, setPasscode, removePasscode,
  enableEncryption, disableEncryption, unlockEncryption,
  setExpiration, clearExpiration, handleExpiration,
  enableViewOnce, disableViewOnce, consumeViewOnce, resetViewOnceNote,
  setEditingLocked,
} from './settings.js';

import { encryptContent, decryptContent, looksEncrypted } from './encryption.js';
import { loadDraft, clearDraft, isDraftNewer }              from './offline.js';

import {
  setPermissionContext, canEdit, canChangeSettings, canToggleLock, canUploadFiles,
  canDeleteFiles, canUseTemplates, canUseChecklist, canClearNote, canImportText, canPaste,
  editBlockedReason,
} from './permissions.js';

import { renderMarkdown, toggleChecklistItem } from './markdown.js';
import {
  TEMPLATES, getTemplate, getCustomTemplates,
  saveCustomTemplate, renameCustomTemplate, deleteCustomTemplate,
} from './templates.js';
import { loadSavedTheme, applyTheme, THEMES }  from './theme.js';
import { initShortcuts, destroyShortcuts }     from './shortcuts.js';

import * as UI from './ui.js';
import { openFilePreview } from './file-preview.js';

// ── State ─────────────────────────────────────────────────────────────────────

let _room          = null;
let _roomId        = null;
let _encKey        = null;   // CryptoKey | null
let _encSalt       = null;
let _unsubRoom     = null;
let _unsubFiles    = null;
let _expTimer      = null;
let _monospace     = false;
let _eventsWired   = false;  // v1: guard against double-wiring
let _consumingViewOnce = false; // v1: short-circuit own view-once clear echo
let _isReadOnly    = false;  // v1: ?mode=read or /share/:token
let _shareToken    = null;
let _markdownMode  = 'write'; // 'write' | 'preview' | 'split'
let _showPreview   = false;  // derived: _markdownMode !== 'write'
let _previewObserverWired = false;

// ── Search state ──────────────────────────────────────────────────────────────
let _searchMatches = []; // [{start,end}]
let _searchIndex   = -1;
let _searchTerm    = '';


const BASE = '/SyncPad';

const RESERVED_ROOM_PATHS = new Set(['admin', 'contact', 'privacy', 'terms', 'share', 'assets', 'src', 'styles', 'docs']);

function _parseRoute() {
  const cleaned = location.pathname.replace(BASE, '').replace(/^\/+|\/+$/g, '');
  if (!cleaned) return { type: 'landing' };

  if (cleaned === 'contact') return { type: 'contact' };
  if (cleaned === 'privacy') return { type: 'privacy' };
  if (cleaned === 'terms') return { type: 'terms' };
  if (cleaned === 'admin') return { type: 'admin' };

  const shareMatch = cleaned.match(/^share\/([^/]+)$/);
  if (shareMatch) return { type: 'share', token: shareMatch[1] };

  return { type: 'room', roomId: cleaned };
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  // Apply saved theme immediately to avoid flash
  loadSavedTheme();

  UI.showScreen('loading');

  // Load locally-stored monospace preference
  try { _monospace = localStorage.getItem('syncpad_monospace') === '1'; } catch {}

  const redirectRoom = sessionStorage.getItem('syncpad_redirect_room');
  if (redirectRoom) {
    sessionStorage.removeItem('syncpad_redirect_room');
    // Preserve any query string (so ?mode=read survives the 404 redirect)
    const qs = location.search || '';
    history.replaceState(null, '', `${BASE}/${redirectRoom}${qs}`);
  }

  // URL mode (?mode=read)
  _isReadOnly = getUrlMode() === 'read';

  const route = _parseRoute();

  if (route.type === 'share') {
    _isReadOnly = true;
    _shareToken = route.token;
    await joinReadOnlyShareRoute(route.token);
    return;
  }

  if (route.type === 'landing' && !redirectRoom) {
    UI.showScreen('landing');
    wireLandingEvents();
    return;
  }

  if (route.type === 'admin') {
    UI.showScreen('admin');
    return;
  }

  if (route.type === 'contact' || route.type === 'privacy' || route.type === 'terms') {
    if (route.type === 'contact') wireContactEvents();
    UI.showScreen(route.type);
    return;
  }

  if (route.type === 'info') {
    UI.setInfoScreen({ title: route.title, message: route.message });
    UI.showScreen('info');
    return;
  }

  const rawRoomId = redirectRoom || route.roomId || generateRoomId();
  const sanitizedRoomId = sanitizeRoomId(rawRoomId);
  const blockedRoom = RESERVED_ROOM_PATHS.has(sanitizedRoomId.toLowerCase());
  const roomId = blockedRoom ? generateRoomId() : sanitizedRoomId;

  if (!redirectRoom && (route.type !== 'room' || roomId !== route.roomId || blockedRoom)) {
    const qs = location.search || '';
    history.replaceState(null, '', `${BASE}/${roomId}${qs}`);
  }

  await joinRoom(roomId);
}

// ── Landing screen ────────────────────────────────────────────────────────────

async function _openShareModal() {
  let readOnlyUrl = '';
  let readOnlyError = false;
  try {
    const share = await getOrCreateReadOnlyShareLink(_roomId);
    readOnlyUrl = buildReadOnlyUrl(BASE, share?.token || '');
    if (!share?.token) readOnlyError = true;
  } catch {
    readOnlyError = true;
    UI.showToast('Could not create read-only link.', 'error');
  }
  UI.populateShareModal({
    editableUrl: buildRoomUrl(BASE, _roomId),
    readOnlyUrl,
    readOnlyError,
    roomPath: `/${_roomId}`,
    hasPasscode: !!_room?.passcode_hash,
    hasEncryption: !!_room?.encryption_enabled,
    hasReadOnlyLink: !!readOnlyUrl,
    isEditingLocked: !!_room?.editing_locked,
  });
  UI.openModal('share-modal');
}

function wireLandingEvents() {
  const createBtn = document.getElementById('landing-create-btn');
  const joinInput = document.getElementById('landing-join-input');
  const joinBtn   = document.getElementById('landing-join-btn');

  const createRoom = () => {
    const roomId = generateRoomId();
    const qs     = location.search || '';
    history.pushState(null, '', `${BASE}/${roomId}${qs}`);
    UI.showScreen('loading');
    joinRoom(roomId);
  };

  const joinRoom_ = () => {
    const raw = joinInput?.value?.trim();
    if (!raw) return;
    // Accept full URL or bare ID
    let id;
    try {
      const url = new URL(raw);
      id = url.pathname.replace(BASE, '').replace(/^\/+|\/+$/g, '');
    } catch {
      id = raw;
    }
    id = sanitizeRoomId(id);
    if (!id) { joinInput.focus(); return; }
    if (RESERVED_ROOM_PATHS.has(id.toLowerCase())) {
      UI.showToast('That room name is reserved. Choose a different room ID.', 'warning');
      joinInput.focus();
      return;
    }
    history.pushState(null, '', `${BASE}/${id}`);
    UI.showScreen('loading');
    joinRoom(id);
  };

  createBtn?.addEventListener('click', createRoom);
  joinBtn?.addEventListener('click', joinRoom_);
  joinInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom_(); });
}


let _contactEventsWired = false;

function _getWeb3FormsKey() {
  return (window.SYNCPAD_CONFIG?.web3FormsAccessKey || '').trim();
}

function _isPlaceholderWeb3Key(key) {
  const normalized = (key || '').toLowerCase();
  return !normalized || normalized.includes('replace') || normalized.includes('placeholder') || normalized.includes('your_');
}

function wireContactEvents() {
  if (_contactEventsWired) return;
  _contactEventsWired = true;

  const form = document.getElementById('contact-form');
  const status = document.getElementById('contact-status');
  const submit = document.getElementById('contact-submit');
  if (!form || !status || !submit) return;

  const key = _getWeb3FormsKey();
  const configured = !_isPlaceholderWeb3Key(key);

  if (!configured) {
    submit.disabled = true;
    status.textContent = 'Contact form is not configured yet.';
    status.className = 'contact-status warning';
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    status.textContent = 'Sending message…';
    status.className = 'contact-status';
    const payload = {
      access_key: key,
      subject: 'SyncPad contact form submission',
      from_name: `${document.getElementById('contact-first-name')?.value || ''} ${document.getElementById('contact-last-name')?.value || ''}`.trim(),
      email: document.getElementById('contact-email')?.value || '',
      message: document.getElementById('contact-message')?.value || '',
    };
    try {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) throw new Error(data?.message || 'Submit failed');
      status.textContent = 'Message sent successfully.';
      status.className = 'contact-status success';
      form.reset();
    } catch (err) {
      status.textContent = 'Could not send message right now. Please try again later.';
      status.className = 'contact-status error';
    } finally {
      submit.disabled = false;
    }
  });
}

async function _emptyContentForCurrentEncryption() {
  return _encKey ? await encryptContent('', _encKey) : '';
}

// ── Join flow ─────────────────────────────────────────────────────────────────

async function joinReadOnlyShareRoute(token) {
  UI.setLoadingMessage('Opening read-only share link…');
  try {
    const resolved = await resolveReadOnlyShareLink(token);
    if (!resolved?.room_id) {
      UI.setInfoScreen({
        title: 'Share link unavailable',
        message: 'This read-only link is invalid, disabled, or the room no longer exists.',
      });
      UI.showScreen('info');
      return;
    }
    await joinRoom(resolved.room_id);
  } catch {
    UI.setInfoScreen({
      title: 'Share link unavailable',
      message: 'This read-only link is invalid, disabled, or the room no longer exists.',
    });
    UI.showScreen('info');
  }
}

async function joinRoom(roomId) {
  teardownRealtimeSession();
  _roomId = roomId;
  UI.setLoadingMessage('Loading room…');

  try {
    let room = await loadRoom(roomId);
    if (!room) {
      // Read-only clients should NOT auto-create rooms; the room must already exist.
      if (_isReadOnly) {
        UI.setLoadingMessage('This read-only link points to a room that does not exist.');
        return;
      }
      UI.setLoadingMessage('Creating room…');
      room = await createRoom(roomId);
    }
    _room = room;
  } catch {
    UI.setLoadingMessage('Could not load room. Check your connection and reload.');
    return;
  }

  if (_room.passcode_hash) {
    UI.showScreen('passcode');
    const badge = document.getElementById('passcode-room-badge');
    if (badge) badge.textContent = roomId;
    return;
  }

  if (_room.encryption_enabled) {
    UI.showScreen('encryption');
    const badge = document.getElementById('encryption-room-badge');
    if (badge) badge.textContent = roomId;
    return;
  }

  await startApp();
}

// ── Auth handlers ─────────────────────────────────────────────────────────────

async function onPasscodeSubmit() {
  const input    = document.getElementById('passcode-input');
  const passcode = input?.value?.trim() || '';
  if (!passcode) { UI.showPasscodeError('Please enter the passcode.'); return; }

  UI.clearPasscodeError();
  const btn = document.getElementById('passcode-submit-btn');
  if (btn) btn.disabled = true;
  let ok = false;
  try {
    ok = await checkPasscode(_room, passcode);
  } catch {
    if (btn) btn.disabled = false;
    UI.showPasscodeError('Could not verify the passcode. Please reload and try again.');
    return;
  }
  if (btn) btn.disabled = false;

  if (!ok) { UI.showPasscodeError('Incorrect passcode. Please try again.'); return; }

  if (_room.encryption_enabled) {
    UI.showScreen('encryption');
    const badge = document.getElementById('encryption-room-badge');
    if (badge) badge.textContent = _roomId;
    return;
  }
  await startApp();
}

async function onEncryptionSubmit() {
  const input      = document.getElementById('encryption-input');
  const passphrase = input?.value || '';
  if (!passphrase) { UI.showEncryptionError('Please enter the encryption passphrase.'); return; }

  UI.clearEncryptionError();
  const btn = document.getElementById('encryption-submit-btn');
  if (btn) btn.disabled = true;

  try {
    const key = await unlockEncryption(passphrase, _room.encryption_salt);
    if (!_room.content || !looksEncrypted(_room.content)) {
      throw new Error('Encrypted room content is missing or invalid.');
    }
    await decryptContent(_room.content, key); // verify — throws if wrong passphrase
    _encKey  = key;
    _encSalt = _room.encryption_salt;
  } catch {
    if (btn) btn.disabled = false;
    UI.showEncryptionError('Wrong passphrase. Could not decrypt the note.');
    return;
  }
  if (btn) btn.disabled = false;
  await startApp();
}

// ── Start app ─────────────────────────────────────────────────────────────────

async function startApp() {
  UI.setLoadingMessage('Starting…');
  UI.showScreen('loading');

  // ── Expiration check ───────────────────────────────────────────────────────
  if (_room.expires_at && new Date(_room.expires_at) <= new Date()) {
    await handleExpiration(_roomId, _room, await _emptyContentForCurrentEncryption());
    _room = await loadRoom(_roomId);
  }

  // ── Decrypt content for display ────────────────────────────────────────────
  // Must happen BEFORE view-once consumption so the viewer actually sees the note.
  let displayContent = _room.content || '';
  if (_encKey && displayContent && looksEncrypted(displayContent)) {
    try { displayContent = await decryptContent(displayContent, _encKey); }
    catch { displayContent = ''; }
  }

  // ── View-once: decide if this session should consume ───────────────────────
  // Use created_by_device (persists across refreshes) so the creator can't
  // accidentally consume their own note. Read-only viewers do NOT consume
  // view-once — they would be unable to keep editing afterward, and the
  // creator presumably wants real readers to consume it.
  const deviceId  = getDeviceId();
  const isCreator = _room.created_by_device === deviceId;
  const shouldConsumeViewOnce = (
    _room.view_once &&
    !isCreator &&
    !_isReadOnly &&
    !_room.viewed &&
    _room.cleared_reason !== 'view_once'
  );

  // ── Initial permission context ─────────────────────────────────────────────
  _updatePermissionContext();

  // ── Render ─────────────────────────────────────────────────────────────────
  UI.showScreen('app');
  UI.setRoomName(_roomId);
  UI.setEncryptionBadge(!!_room.encryption_enabled);
  UI.setViewOnceBadge(!!_room.view_once);
  UI.renderSettingsPanel(_room);
  UI.setStatus('connected');
  UI.setMonospace(_monospace);
  UI.setReadOnlyMode(_isReadOnly);
  UI.setLockedMode(!!_room.editing_locked);
  UI.renderThemePicker(THEMES, getSavedTheme_(), (id) => applyTheme(id));

  initSync({
    roomId:           _roomId,
    encryptFn:        _encKey ? (pt) => encryptContent(pt, _encKey) : null,
    decryptFn:        _encKey ? (ct) => decryptContent(ct, _encKey) : null,
    getEditorVal:     UI.getEditorValue,
    setEditorVal:     (text) => { UI.setEditorValue(text); _refreshPreviewIfActive(); },
    onStatusChange:   UI.setStatus,
    onPendingRemote:  (remoteText) => UI.showRemoteNotice({
      onApply:   () => { applyPendingRemote();   UI.hideRemoteNotice(); },
      onKeep:    () => { dismissPendingRemote(); UI.hideRemoteNotice(); },
      onCopy:    async () => {
        try { await copyToClipboard(remoteText ?? getPendingRemote() ?? ''); UI.showToast('Remote content copied.', 'success'); }
        catch { UI.showToast('Could not copy.', 'error'); }
      },
      onDismiss: () => { UI.hideRemoteNotice(); },
      localText:  UI.getEditorValue(),
      remoteText: remoteText,
      remoteTs:   getPendingRemoteTs(),
    }),
    onDismissPending: UI.hideRemoteNotice,
  });

  // Set initial content — prefer local draft if newer than DB.
  // Encrypted-room drafts are stored encrypted in localStorage and are only
  // decrypted after the room passphrase has already unlocked _encKey.
  const draft = loadDraft(_roomId);
  const draftText = await _decodeLocalDraft(draft);
  if (draftText !== null && isDraftNewer(draft, _room.updated_at) && canEdit()) {
    setContentNoSave(draftText);
    UI.showToast('Restored unsaved local draft.', 'warning', 5000);
  } else {
    setContentNoSave(displayContent);
  }
  UI.updateWordCount(UI.getEditorValue());

  initBroadcast(_roomId, {
    onRemoteTyping: async (payload) => {
      if (_isEncryptedWithoutKey()) return;
      UI.showTypingIndicator(payload.device_name || 'Someone');
      await handleRemoteTyping(payload);
      _refreshPreviewIfActive();
    },
    onRemoteSettings: async () => {
      // Another device changed settings — reload and re-render. Do NOT
      // re-broadcast here or it creates an echo loop.
      const prev = _room;
      _room = await loadRoom(_roomId);
      await _handleRoomStateTransition(prev, _room);
    },
    onRemoteFiles: async () => refreshFiles(),
    onRemoteClear: async () => {
      setContentNoSave('');
      UI.updateWordCount('');
      _refreshPreviewIfActive();
      UI.showToast('Note was cleared by another device.', 'warning');
    },
    onRemoteExpired: async () => {
      setContentNoSave('');
      UI.updateWordCount('');
      UI.hideExpirationBar();
      _refreshPreviewIfActive();
      UI.showToast('This note expired and was cleared.', 'warning', 5000);
    },
    onRemoteViewOnce: async () => {
      setContentNoSave('');
      UI.updateWordCount('');
      _refreshPreviewIfActive();
      UI.showToast('This note was view-once and has been cleared from the server.', 'warning', 6000);
    },
  });

  initPresence(_roomId, (devices) => {
    UI.updateDeviceCount(devices.length);
    UI.renderDevicesList(devices, deviceId, (name) => {
      setDeviceName(name);
      updatePresenceDeviceName(getDeviceName());
    });
  }, { readOnly: _isReadOnly });

  _unsubRoom = subscribeToRoom(_roomId, async (newRoom) => {
    const prev = _room;
    _room = newRoom;
    await _handleRoomStateTransition(prev, newRoom);
  });

  _unsubFiles = subscribeToFiles(_roomId, () => refreshFiles());
  await refreshFiles();

  if (_room.expires_at) setupExpirationTimer();

  wireEvents();

  onOnlineChange((online) => {
    if (online) { UI.hideOfflineBanner(); UI.setStatus('connected'); flushSave(); }
    else        { UI.showOfflineBanner();  UI.setStatus('offline'); }
  });
  if (!isOnline()) UI.showOfflineBanner();

  if (!isMobile() && !_isReadOnly) UI.focusEditor();

  // ── View-once: consume AFTER the note is visible to the user ───────────────
  // Set _consumingViewOnce so the subscribeToRoom postgres echo of our own
  // clear doesn't wipe the editor we just rendered.
  if (shouldConsumeViewOnce) {
    _consumingViewOnce = true;
    try {
      const consumed = await consumeViewOnce(_roomId, _room, false, await _emptyContentForCurrentEncryption());
      if (consumed) {
        _room = await loadRoom(_roomId);
        clearDraft(_roomId);
        _updatePermissionContext();
        broadcastViewOnceCleared();
        UI.showToast(
          'This was a view-once note. It has been cleared from the server, but remains visible on this device until you leave.',
          'warning', 8000
        );
      }
    } catch {
      // Race condition — another device may have consumed it first. Ignore.
    } finally {
      // If the Postgres echo never arrives, do not leave this client in a
      // permanent self-consumer state. We already reloaded _room above when the
      // consume succeeded, so permission state remains correct.
      _consumingViewOnce = false;
      _updatePermissionContext();
    }
  }
}

async function _decodeLocalDraft(draft) {
  if (!draft) return null;
  if (!draft.encrypted) {
    // Legacy/plain drafts must not be restored into encrypted rooms. Clear them
    // so an older v1 test build cannot leave plaintext localStorage behind.
    if (_room?.encryption_enabled) { clearDraft(_roomId); return null; }
    return draft.content ?? '';
  }

  if (!_encKey) return null;
  try { return await decryptContent(draft.content || '', _encKey); }
  catch {
    // Wrong/corrupt local draft ciphertext should not block room loading.
    clearDraft(_roomId);
    return null;
  }
}

function _isEncryptedWithoutKey(room = _room) {
  return !!room?.encryption_enabled && !_encKey;
}

function _enterEncryptedNoKeyMode(newRoom, { showToast = false } = {}) {
  cancelPendingSave();
  cancelPendingTypingBroadcast();
  _encKey = null;
  _encSalt = newRoom?.encryption_salt || null;
  setEncryption(null, null);
  clearDraft(_roomId);
  setContentNoSave('');
  UI.updateWordCount('');
  _refreshPreviewIfActive();
  UI.showEncryptionLockedBanner(true, () => { location.reload(); });
  if (showToast) {
    UI.showToast('Encryption was enabled by another device. Reload to enter the passphrase.', 'warning', 7000);
  }
}

// ── Room state transitions (encryption / lock / view-once / clear) ───────────
//
// Called from BOTH the broadcast 'settings' handler and the postgres_changes
// subscription. Centralising the logic keeps the two paths consistent.
async function _handleRoomStateTransition(prev, newRoom) {
  if (!newRoom) return;

  // Save echoes from our own writes
  const ourId = getDeviceId();
  const isOwnWrite = newRoom.updated_by_device === ourId;

  // ── Encryption transitions ─────────────────────────────────────────────────
  // Apply encryption-mode changes BEFORE applying remote content. Otherwise a
  // client can try to decrypt newly-plaintext content after remote encryption is
  // disabled, or briefly render ciphertext after encryption is enabled.
  const wasEnc = !!prev?.encryption_enabled;
  const nowEnc = !!newRoom.encryption_enabled;
  let shouldApplyRemoteContent = prev?.content !== newRoom.content;

  if (nowEnc && !_encKey) {
    // Encryption is active and this client does not have the key. This is not
    // only a transition guard: every future encrypted Broadcast/DB payload must
    // be ignored so ciphertext can never render in the editor.
    _enterEncryptedNoKeyMode(newRoom, { showToast: !wasEnc && !isOwnWrite });
    shouldApplyRemoteContent = false;
  } else if (wasEnc && !nowEnc) {
    // Encryption just got turned off. Switch sync.js back to plaintext BEFORE
    // applying the new room content, because newRoom.content is now plaintext.
    cancelPendingTypingBroadcast();
    _encKey = null;
    _encSalt = null;
    setEncryption(null, null);
    UI.showEncryptionLockedBanner(false);
  } else if (nowEnc && _encKey) {
    // Salt/key did not change, but make sure sync.js still has the active fns
    // after any room-state reload or subscription race.
    setEncryption(
      (pt) => encryptContent(pt, _encKey),
      (ct) => decryptContent(ct, _encKey),
    );
  }

  // Update permissions before any await so queued saves immediately see lock,
  // read-only, view-once-consumed, or encrypted-without-key state.
  _updatePermissionContext();

  // ── Apply remote DB content after encryption state is current ──────────────
  // Settings-only writes stamp updated_at/updated_by_device, but they do not
  // change content. Avoid treating those as stale remote text updates.
  if (shouldApplyRemoteContent) {
    await handleRemoteDatabaseChange(newRoom);
  }

  UI.renderSettingsPanel(_room);
  UI.setEncryptionBadge(!!_room.encryption_enabled);
  UI.setViewOnceBadge(!!_room.view_once);
  UI.setLockedMode(!!_room.editing_locked);

  // ── Clear/expired/view-once toasts ─────────────────────────────────────────
  if (newRoom.cleared_reason === 'expired' && prev?.cleared_reason !== 'expired') {
    setContentNoSave('');
    UI.updateWordCount('');
    UI.hideExpirationBar();
    _refreshPreviewIfActive();
    UI.showToast('This note expired and was cleared.', 'warning', 5000);
  }

  if (newRoom.cleared_reason === 'view_once' && prev?.cleared_reason !== 'view_once') {
    clearDraft(_roomId);
    // v1: do not clear the local editor if WE were the consumer, but lock it so
    // the consumed note never gets saved back to the server.
    if (_consumingViewOnce || isOwnWrite) {
      _consumingViewOnce = false;
      _updatePermissionContext();
    } else {
      setContentNoSave('');
      UI.updateWordCount('');
      _refreshPreviewIfActive();
      UI.showToast('This note was view-once and has been cleared from the server.', 'warning', 6000);
    }
  }

  if (newRoom.expires_at) setupExpirationTimer();
  else UI.hideExpirationBar();

  _refreshPreviewIfActive();
  _updateViewOnceConsumedUI();
}

function _updatePermissionContext() {
  setPermissionContext({
    isReadOnlyUrl:    _isReadOnly,
    isEditingLocked:  !!_room?.editing_locked,
    isEncryptedNoKey: !!_room?.encryption_enabled && !_encKey,
    isEncryptionEnabled: !!_room?.encryption_enabled,
    isCleared:        !!_room?.cleared_reason,
    isViewOnceConsumed: _room?.cleared_reason === 'view_once' && !!_room?.viewed,
  });
  UI.setEditorEditable(canEdit());
  UI.setEditBlockedReason(editBlockedReason());
  _updateViewOnceConsumedUI();
}

function _updateViewOnceConsumedUI() {
  const consumed = _room?.view_once && _room?.cleared_reason === 'view_once' && !!_room?.viewed;
  UI.setViewOnceConsumedPanel({
    visible: !!consumed,
    readOnly: !!_isReadOnly,
    onStartNew: async () => {
      if (_isReadOnly || !canChangeSettings()) return;
      try {
        await resetViewOnceNote(_roomId, await _emptyContentForCurrentEncryption(), true);
        clearDraft(_roomId);
        _room = await loadRoom(_roomId);
        setContentNoSave('');
        UI.updateWordCount('');
        _refreshPreviewIfActive();
        _updatePermissionContext();
        UI.renderSettingsPanel(_room);
        UI.setViewOnceBadge(!!_room.view_once);
        broadcastSettingsChange();
        broadcastClear();
        UI.showToast('Started a new view-once note.', 'success');
      } catch {
        UI.showToast('Could not reset this view-once note.', 'error');
      }
    },
  });
}

// ── Expiration timer ──────────────────────────────────────────────────────────

function setupExpirationTimer() {
  clearTimeout(_expTimer);
  if (!_room?.expires_at) return;
  const remaining = new Date(_room.expires_at) - Date.now();
  if (remaining <= 0) return;

  UI.showExpirationBar(_room.expires_at, async () => {
    if (!canChangeSettings()) { UI.showToast(editBlockedReason() || 'Cannot change settings.', 'warning'); return; }
    try {
      await clearExpiration(_roomId);
      _room = await loadRoom(_roomId);
      UI.hideExpirationBar();
      broadcastSettingsChange();
      UI.showToast('Expiration removed.', 'success');
    } catch { UI.showToast('Could not remove expiration.', 'error'); }
  });

  _expTimer = setTimeout(async () => {
    const didClear = await handleExpiration(_roomId, _room, await _emptyContentForCurrentEncryption());
    if (didClear) {
      setContentNoSave('');
      UI.updateWordCount('');
      UI.hideExpirationBar();
      _refreshPreviewIfActive();
      UI.showToast('This note expired and was cleared.', 'warning', 5000);
      broadcastSettingsChange();
    }
  }, remaining);
}

// ── File refresh ──────────────────────────────────────────────────────────────

async function refreshFiles() {
  const files = await listFiles(_roomId);
  UI.renderFilesList(
    files,
    async (file) => {
      try {
        const url = await getDownloadUrl(file.file_path);
        const a   = document.createElement('a');
        a.href = url; a.download = file.filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      } catch { UI.showToast('Could not download file.', 'error'); }
    },
    async (file) => {
      if (!canDeleteFiles()) { UI.showToast(editBlockedReason() || 'File deletion is disabled.', 'warning'); return; }
      if (!confirm(`Delete "${file.filename}"?`)) return;
      try {
        await deleteFile(file.id, file.file_path);
        UI.showToast('File deleted.', 'success');
        broadcastFilesChange();
        await refreshFiles();
      } catch (err) {
        const msg = err?.code === 'METADATA_DELETE_FAILED'
          ? err.message
          : 'Could not delete file.';
        UI.showToast(msg, 'error', 5000);
        await refreshFiles();
      }
    },
    {
      canDelete: canDeleteFiles(),
      onPreview: async (file) => {
        try {
          await openFilePreview(
            file,
            getDownloadUrl,
            async (f) => {
              try {
                const url = await getDownloadUrl(f.file_path);
                const a   = document.createElement('a');
                a.href = url; a.download = f.filename;
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
              } catch { UI.showToast('Could not download file.', 'error'); }
            }
          );
        } catch { UI.showToast('Could not open preview.', 'error'); }
      },
    }
  );
}

// ── Event wiring (guarded against double-wire) ────────────────────────────────

function wireEvents() {
  if (_eventsWired) return; // v1: guard against double-wiring
  _eventsWired = true;

  const editor = document.getElementById('note-editor');

  editor?.addEventListener('input', () => {
    if (!canEdit()) return;
    onLocalInput(); // returns a Promise — intentional fire-and-forget
    setTyping(true);
    UI.updateWordCount(UI.getEditorValue());
  });
  editor?.addEventListener('blur', () => onEditorBlur());

  // Broadcast cursor line on selection/click (throttled in presence.js at 800ms)
  const _broadcastCursor = () => {
    if (!editor) return;
    const pos    = editor.selectionStart;
    const before = editor.value.substring(0, pos);
    const line   = (before.match(/\n/g) || []).length + 1;
    setCursorLine(line);
  };
  editor?.addEventListener('keyup',    _broadcastCursor);
  editor?.addEventListener('mouseup',  _broadcastCursor);
  editor?.addEventListener('touchend', _broadcastCursor);

  // Block paste keystrokes when the editor is locked. The textarea readonly
  // attribute does the heavy lifting; this is belt-and-suspenders.
  editor?.addEventListener('paste', (e) => {
    if (!canPaste()) { e.preventDefault(); }
  });
  editor?.addEventListener('drop', (e) => {
    if (!canEdit()) { e.preventDefault(); }
  });

  window.addEventListener('beforeunload', () => {
    flushSave();
    destroyPresence();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushSave();
      setTyping(false);
      setCursorLine(null);
    }
  });

  // ── Header ─────────────────────────────────────────────────────────────────
  document.getElementById('btn-tools')?.addEventListener('click', () => { closeMoreDropdown(); UI.togglePanel('tools-panel'); });
  document.getElementById('btn-files')?.addEventListener('click', () => { closeMoreDropdown(); UI.togglePanel('files-panel'); });
  document.getElementById('btn-presence')?.addEventListener('click', () => { closeMoreDropdown(); UI.togglePanel('presence-panel'); });
  document.getElementById('btn-settings')?.addEventListener('click', () => { closeMoreDropdown(); UI.togglePanel('settings-panel'); });
  document.getElementById('device-count-btn')?.addEventListener('click', () => UI.togglePanel('presence-panel'));

  // More dropdown toggle
  const moreBtn      = document.getElementById('btn-more');
  const moreDropdown = document.getElementById('more-dropdown');
  function closeMoreDropdown() {
    moreDropdown?.classList.remove('open');
    moreBtn?.setAttribute('aria-expanded', 'false');
  }
  moreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = moreDropdown?.classList.toggle('open');
    moreBtn.setAttribute('aria-expanded', String(!!open));
  });
  document.addEventListener('click', (e) => {
    if (!moreDropdown?.contains(e.target) && e.target !== moreBtn) closeMoreDropdown();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMoreDropdown(); UI.closeAllPanels(); UI.closeAllModals(); } });

  document.getElementById('btn-share')?.addEventListener('click', () => {
    _openShareModal();
  });

  document.getElementById('room-name')?.addEventListener('click', () => {
    copyToClipboard(buildRoomUrl(BASE, _roomId))
      .then(() => UI.showToast('Room link copied!', 'success'));
  });

  // ── Segmented markdown control ─────────────────────────────────────────────
  document.querySelectorAll('.md-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (!mode) return;
      _markdownMode = mode;
      _showPreview  = _markdownMode !== 'write';
      UI.setMarkdownMode(_markdownMode, () => renderMarkdown(UI.getEditorValue()));
      if (_showPreview) _wirePreviewClickOnce();
    });
  });

  // ── Mobile action bar ──────────────────────────────────────────────────────
  document.getElementById('mob-btn-share')?.addEventListener('click', () => {
    _openShareModal();
  });
  document.getElementById('mob-btn-files')?.addEventListener('click',    () => UI.togglePanel('files-panel'));
  document.getElementById('mob-btn-tools')?.addEventListener('click',    () => UI.togglePanel('tools-panel'));
  document.getElementById('mob-btn-presence')?.addEventListener('click', () => UI.togglePanel('presence-panel'));
  document.getElementById('mob-btn-settings')?.addEventListener('click', () => UI.togglePanel('settings-panel'));

  // ── Footer quick buttons ───────────────────────────────────────────────────
  document.getElementById('btn-copy-footer')?.addEventListener('click', () => {
    copyToClipboard(UI.getEditorValue()).then(() => UI.showToast('Copied to clipboard.', 'success'));
  });
  document.getElementById('btn-insert-ts')?.addEventListener('click', () => {
    if (!canEdit()) { UI.showToast(editBlockedReason() || 'Editing is disabled.', 'warning'); return; }
    UI.insertAtCursor(insertTimestamp());
  });

  // ── Panels / modals ────────────────────────────────────────────────────────
  document.querySelectorAll('.panel-close').forEach(btn =>
    btn.addEventListener('click', () => UI.closeAllPanels())
  );
  document.getElementById('panel-backdrop')?.addEventListener('click', () => UI.closeAllPanels());

  document.querySelectorAll('.modal-backdrop').forEach(backdrop =>
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) UI.closeAllModals(); })
  );
  document.getElementById('share-modal-close')?.addEventListener('click', () => UI.closeModal('share-modal'));

  // ── Tools ──────────────────────────────────────────────────────────────────
  const toolActions = {
    'tool-copy': () =>
      copyToClipboard(UI.getEditorValue()).then(() => UI.showToast('Note copied.', 'success')),

    'tool-copy-link': () =>
      copyToClipboard(buildRoomUrl(BASE, _roomId))
        .then(() => UI.showToast('Link copied.', 'success')),

    'tool-paste': async () => {
      if (!canPaste()) { UI.showToast(editBlockedReason() || 'Paste is disabled.', 'warning'); return; }
      try { UI.insertAtCursor(await navigator.clipboard.readText()); }
      catch { UI.showToast('Clipboard access denied.', 'error'); }
    },

    'tool-share': () => { _openShareModal(); },

    'tool-clear': () => {
      if (!canClearNote()) { UI.showToast(editBlockedReason() || 'Clear is disabled.', 'warning'); return; }
      if (!confirm('Clear the note for everyone? This cannot be undone.')) return;
      doClearNote();
    },

    'tool-download': () => {
      const blob = new Blob([UI.getEditorValue()], { type: 'text/plain' });
      const a    = Object.assign(document.createElement('a'), {
        href:     URL.createObjectURL(blob),
        download: `${_roomId}.txt`,
      });
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(a.href);
    },

    'tool-import': () => {
      if (!canImportText()) { UI.showToast(editBlockedReason() || 'Import is disabled.', 'warning'); return; }
      const inp = Object.assign(document.createElement('input'), {
        type: 'file', accept: '.txt,text/plain',
      });
      inp.onchange = () => {
        const f = inp.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = (e) => {
          UI.setEditorValue(String(e.target.result ?? ''));
          // Trigger the normal local-input pipeline: word count, draft save,
          // debounced DB save, and live broadcast.
          editor?.dispatchEvent(new Event('input', { bubbles: true }));
          _refreshPreviewIfActive();
        };
        r.readAsText(f);
      };
      inp.click();
    },

    'tool-timestamp':  () => {
      if (!canEdit()) { UI.showToast(editBlockedReason() || 'Editing is disabled.', 'warning'); return; }
      UI.insertAtCursor(insertTimestamp());
    },
    'tool-select-all': () => { editor?.focus(); editor?.setSelectionRange(0, editor.value.length); },
    'tool-monospace':  () => {
      _monospace = !_monospace;
      UI.setMonospace(_monospace);
      try { localStorage.setItem('syncpad_monospace', _monospace ? '1' : '0'); } catch {}
      UI.showToast(_monospace ? 'Monospace on.' : 'Monospace off.');
    },
    'tool-templates': () => {
      if (!canUseTemplates()) { UI.showToast(editBlockedReason() || 'Templates are disabled.', 'warning'); return; }
      UI.openTemplatesModal(
        TEMPLATES,
        getCustomTemplates(),
        _onTemplateChosen,
        (key) => { deleteCustomTemplate(key); },
        (key, label) => { renameCustomTemplate(key, label); },
      );
    },
  };

  Object.entries(toolActions).forEach(([id, fn]) => {
    document.getElementById(id)?.addEventListener('click', () => { fn(); UI.closeAllPanels(); });
  });

  // ── Files ──────────────────────────────────────────────────────────────────
  UI.setFileHandlers(async (file) => {
    if (!canUploadFiles()) { UI.showToast(editBlockedReason() || 'File upload is disabled. Text-encrypted rooms do not allow new file uploads in v1.', 'warning'); return; }
    if (file.size > 10 * 1024 * 1024) { UI.showToast('File too large (max 10 MB).', 'error'); return; }
    UI.setUploadingState(true);
    try {
      await uploadFile(_roomId, file);
      UI.showToast('File uploaded.', 'success');
      broadcastFilesChange();
      await refreshFiles();
    } catch { UI.showToast('Could not upload file.', 'error'); }
    finally  { UI.setUploadingState(false); }
  });

  // ── Settings ───────────────────────────────────────────────────────────────
  document.getElementById('setting-passcode-btn')?.addEventListener('click', async () => {
    if (!canChangeSettings()) { UI.showToast(editBlockedReason() || 'Settings are disabled.', 'warning'); return; }
    if (_room.passcode_hash) {
      if (!confirm('Remove the room passcode?')) return;
      try {
        await removePasscode(_roomId);
        _room = await loadRoom(_roomId);
        _updatePermissionContext();
        UI.renderSettingsPanel(_room);
        broadcastSettingsChange();
        UI.showToast('Passcode removed.', 'success');
      } catch { UI.showToast('Could not remove passcode.', 'error'); }
    } else {
      const pc = prompt('Set a new passcode (shared with everyone who joins):');
      if (!pc?.trim()) return;
      try {
        await setPasscode(_roomId, pc.trim());
        _room = await loadRoom(_roomId);
        _updatePermissionContext();
        UI.renderSettingsPanel(_room);
        broadcastSettingsChange();
        UI.showToast('Passcode set.', 'success');
      } catch { UI.showToast('Could not set passcode.', 'error'); }
    }
  });

  document.getElementById('setting-enc-btn')?.addEventListener('click', async () => {
    if (!canChangeSettings()) { UI.showToast(editBlockedReason() || 'Settings are disabled.', 'warning'); return; }
    if (_room.encryption_enabled) {
      if (!confirm('Disable encryption? Content will be stored in plaintext.')) return;
      await flushSave();
      cancelPendingTypingBroadcast();
      const pp = prompt('Enter the current encryption passphrase to confirm:');
      if (!pp) return;
      try {
        // Pass plaintext (editor value), passphrase, stored salt, and current DB ciphertext
        await disableEncryption(_roomId, UI.getEditorValue(), pp, _encSalt, _room.content);
        _encKey = null; _encSalt = null;
        // v1: tell sync.js the new encrypt/decrypt fns immediately.
        setEncryption(null, null);
        _room   = await loadRoom(_roomId);
        clearDraft(_roomId);
        _updatePermissionContext();
        UI.renderSettingsPanel(_room);
        UI.setEncryptionBadge(false);
        UI.showEncryptionLockedBanner(false);
        broadcastSettingsChange();
        UI.showToast('Encryption disabled.', 'success');
      } catch (err) {
        UI.showToast(err.message || 'Could not disable encryption.', 'error', 4000);
      }
    } else {
      await flushSave();
      cancelPendingTypingBroadcast();
      const existingFiles = await listFiles(_roomId);
      if (existingFiles.length && !confirm('This room has file attachments. SyncPad v1 encrypts note text only, not files. Continue enabling text encryption?')) return;
      const pp = prompt('Set an encryption passphrase (share it with anyone who needs to read this note):');
      if (!pp?.trim()) return;
      try {
        const { salt, key } = await enableEncryption(_roomId, UI.getEditorValue(), pp.trim());
        _encKey = key; _encSalt = salt;
        // v1: switch sync.js to encrypted lane immediately.
        setEncryption(
          (pt) => encryptContent(pt, _encKey),
          (ct) => decryptContent(ct, _encKey),
        );
        _room   = await loadRoom(_roomId);
        clearDraft(_roomId);
        _updatePermissionContext();
        UI.renderSettingsPanel(_room);
        UI.setEncryptionBadge(true);
        broadcastSettingsChange();
        UI.showToast('Encryption enabled.', 'success');
      } catch { UI.showToast('Could not enable encryption.', 'error'); }
    }
  });

  document.getElementById('setting-exp-btn')?.addEventListener('click', async () => {
    if (!canChangeSettings()) { UI.showToast(editBlockedReason() || 'Settings are disabled.', 'warning'); return; }
    if (_room.expires_at) {
      if (!confirm('Remove the expiration?')) return;
      try {
        await clearExpiration(_roomId);
        _room = await loadRoom(_roomId);
        UI.renderSettingsPanel(_room);
        UI.hideExpirationBar();
        broadcastSettingsChange();
        UI.showToast('Expiration removed.', 'success');
      } catch { UI.showToast('Could not remove expiration.', 'error'); }
    } else {
      const dur = prompt('Expire after how long? (examples: 30s, 10m, 1h, 2d)');
      if (!dur?.trim()) return;
      try {
        await setExpiration(_roomId, dur.trim());
        _room = await loadRoom(_roomId);
        UI.renderSettingsPanel(_room);
        setupExpirationTimer();
        broadcastSettingsChange();
        UI.showToast('Expiration set.', 'success');
      } catch { UI.showToast('Invalid duration. Try: 30s, 10m, 1h, 2d.', 'error'); }
    }
  });

  document.getElementById('setting-vo-btn')?.addEventListener('click', async () => {
    if (!canChangeSettings()) { UI.showToast(editBlockedReason() || 'Settings are disabled.', 'warning'); return; }
    try {
      if (_room.view_once) {
        await disableViewOnce(_roomId);
        UI.showToast('View-once disabled.', 'success');
      } else {
        await enableViewOnce(_roomId);
        UI.showToast('View-once enabled. The note clears after the first viewer sees it.', 'success', 5000);
      }
      _room = await loadRoom(_roomId);
      UI.renderSettingsPanel(_room);
      broadcastSettingsChange();
    } catch { UI.showToast('Could not update view-once setting.', 'error'); }
  });

  // Lock-editing toggle
  document.getElementById('setting-lock-btn')?.addEventListener('click', async () => {
    if (!canToggleLock()) { UI.showToast(editBlockedReason() || 'Lock controls are disabled.', 'warning'); return; }
    const target = !_room.editing_locked;
    try {
      if (target) { await flushSave(); cancelPendingTypingBroadcast(); }
      await setEditingLocked(_roomId, target);
      _room = await loadRoom(_roomId);
      _updatePermissionContext();
      UI.renderSettingsPanel(_room);
      UI.setLockedMode(!!_room.editing_locked);
      broadcastSettingsChange();
      UI.showToast(target ? 'Editing locked.' : 'Editing unlocked.', 'success');
    } catch { UI.showToast('Could not update editing lock.', 'error'); }
  });

  // ── Export modal ───────────────────────────────────────────────────────────
  document.getElementById('btn-export')?.addEventListener('click', () => {
    closeMoreDropdown();
    UI.openModal('export-modal');
  });
  document.getElementById('export-modal-close')?.addEventListener('click', () => UI.closeModal('export-modal'));

  const _downloadBlob = (content, filename, mime) => {
    const blob = new Blob([content], { type: mime });
    const a    = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
  };

  document.getElementById('export-txt')?.addEventListener('click', () => {
    _downloadBlob(UI.getEditorValue(), `${_roomId}.txt`, 'text/plain');
    UI.showToast('Downloaded .txt', 'success');
  });
  document.getElementById('export-md')?.addEventListener('click', () => {
    _downloadBlob(UI.getEditorValue(), `${_roomId}.md`, 'text/markdown');
    UI.showToast('Downloaded .md', 'success');
  });
  document.getElementById('export-html')?.addEventListener('click', () => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SyncPad – ${_roomId}</title>
<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.7}
pre{background:#f5f5f5;padding:1em;border-radius:4px;overflow:auto}code{background:#f5f5f5;padding:2px 4px;border-radius:2px}
blockquote{border-left:3px solid #ccc;margin:0;padding-left:1em;color:#666}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}</style>
</head><body>${renderMarkdown(UI.getEditorValue())}</body></html>`;
    _downloadBlob(html, `${_roomId}.html`, 'text/html');
    UI.showToast('Downloaded .html', 'success');
  });
  document.getElementById('export-copy-text')?.addEventListener('click', async () => {
    await copyToClipboard(UI.getEditorValue());
    UI.showToast('Copied plain text.', 'success');
  });
  document.getElementById('export-copy-md')?.addEventListener('click', async () => {
    await copyToClipboard(UI.getEditorValue());
    UI.showToast('Copied Markdown.', 'success');
  });

  // ── Keyboard shortcuts modal ───────────────────────────────────────────────
  document.getElementById('btn-shortcuts')?.addEventListener('click', () => {
    closeMoreDropdown();
    UI.openModal('shortcuts-modal');
  });
  document.getElementById('shortcuts-modal-close')?.addEventListener('click', () => UI.closeModal('shortcuts-modal'));

  // ── Save as template ───────────────────────────────────────────────────────
  document.getElementById('btn-save-as-template')?.addEventListener('click', () => {
    const body = UI.getEditorValue().trim();
    if (!body) { UI.showToast('The note is empty — nothing to save as a template.', 'warning'); return; }
    const label = prompt('Template name:', 'My template');
    if (!label?.trim()) return;
    saveCustomTemplate(label.trim(), body);
    UI.showToast(`Saved as template "${label.trim()}".`, 'success');
  });

  // ── Search panel ───────────────────────────────────────────────────────────
  const searchInput = document.getElementById('search-input');
  const searchCount = document.getElementById('search-count');

  const _runSearch = () => {
    _searchTerm = (searchInput?.value || '').toLowerCase();
    _searchMatches = [];
    _searchIndex   = -1;
    if (!_searchTerm || !editor) { if (searchCount) searchCount.textContent = ''; return; }
    const text = editor.value.toLowerCase();
    let pos = 0;
    while (true) {
      const idx = text.indexOf(_searchTerm, pos);
      if (idx === -1) break;
      _searchMatches.push({ start: idx, end: idx + _searchTerm.length });
      pos = idx + 1;
    }
    if (_searchMatches.length > 0) {
      _searchIndex = 0;
      _jumpToMatch(0);
    }
    if (searchCount) {
      searchCount.textContent = _searchMatches.length > 0
        ? `${_searchMatches.length} match${_searchMatches.length !== 1 ? 'es' : ''}`
        : 'No matches';
    }
  };

  const _jumpToMatch = (idx) => {
    if (!editor || !_searchMatches.length) return;
    const m = _searchMatches[idx];
    if (!m) return;
    // Switch to write mode if in preview
    if (_markdownMode !== 'write' && _markdownMode !== 'split') {
      _markdownMode = 'write'; _showPreview = false;
      UI.setMarkdownMode('write');
    }
    editor.focus();
    editor.setSelectionRange(m.start, m.end);
    // Scroll into view
    try {
      const before = editor.value.substring(0, m.start);
      const lineNum = (before.match(/\n/g) || []).length;
      const lineH   = parseInt(getComputedStyle(editor).lineHeight) || 20;
      editor.scrollTop = Math.max(0, lineNum * lineH - editor.clientHeight / 2);
    } catch {}
    if (searchCount) searchCount.textContent = `${idx + 1} / ${_searchMatches.length}`;
  };

  searchInput?.addEventListener('input', _runSearch);
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!_searchMatches.length) return;
      _searchIndex = (_searchIndex + 1) % _searchMatches.length;
      _jumpToMatch(_searchIndex);
    }
    if (e.key === 'Escape') { UI.closeAllPanels(); editor?.focus(); }
  });

  document.getElementById('search-next')?.addEventListener('click', () => {
    if (!_searchMatches.length) return;
    _searchIndex = (_searchIndex + 1) % _searchMatches.length;
    _jumpToMatch(_searchIndex);
  });
  document.getElementById('search-prev')?.addEventListener('click', () => {
    if (!_searchMatches.length) return;
    _searchIndex = (_searchIndex - 1 + _searchMatches.length) % _searchMatches.length;
    _jumpToMatch(_searchIndex);
  });

  // ── Keyboard shortcuts init ────────────────────────────────────────────────
  initShortcuts({
    onTogglePreview:    () => {
      const next = _markdownMode === 'preview' ? 'write' : 'preview';
      _markdownMode = next; _showPreview = next !== 'write';
      UI.setMarkdownMode(next, () => renderMarkdown(UI.getEditorValue()));
      if (_showPreview) _wirePreviewClickOnce();
    },
    onToggleSplit: () => {
      const next = _markdownMode === 'split' ? 'write' : 'split';
      _markdownMode = next; _showPreview = next !== 'write';
      UI.setMarkdownMode(next, () => renderMarkdown(UI.getEditorValue()));
      if (_showPreview) _wirePreviewClickOnce();
    },
    onToggleMonospace: () => {
      _monospace = !_monospace;
      UI.setMonospace(_monospace);
      try { localStorage.setItem('syncpad_monospace', _monospace ? '1' : '0'); } catch {}
      UI.showToast(_monospace ? 'Monospace on.' : 'Monospace off.');
    },
    onOpenSearch: () => {
      UI.openPanel('search-panel');
      searchInput?.focus();
    },
    onForceClose: () => {
      closeMoreDropdown();
      UI.closeAllPanels();
      UI.closeAllModals();
    },
    onOpenShortcuts: () => UI.openModal('shortcuts-modal'),
  });
}

function teardownRealtimeSession() {
  try { _unsubRoom?.(); } catch {}
  try { _unsubFiles?.(); } catch {}
  _unsubRoom = null;
  _unsubFiles = null;
  destroyPresence();
  destroyBroadcast();
  destroySync();
  cancelPendingTypingBroadcast();
}

// ── Templates handler ─────────────────────────────────────────────────────────

function _onTemplateChosen(key, mode) {
  const body = getTemplate(key);
  if (body == null) return;
  if (!canUseTemplates()) { UI.showToast(editBlockedReason() || 'Templates are disabled.', 'warning'); return; }

  const editor = document.getElementById('note-editor');
  const current = UI.getEditorValue();

  let next;
  if (mode === 'append') {
    next = current && body ? `${current.replace(/\s+$/, '')}\n\n${body}` : (current + body);
  } else { // 'replace'
    next = body;
  }

  UI.setEditorValue(next);
  editor?.dispatchEvent(new Event('input', { bubbles: true }));
  UI.updateWordCount(UI.getEditorValue());
  _refreshPreviewIfActive();
  UI.closeModal('templates-modal');
  UI.showToast(mode === 'append' ? 'Template appended.' : 'Template applied.', 'success');
}

// ── Theme helper (avoids importing getSavedTheme into app.js separately) ─────

function getSavedTheme_() {
  try { return localStorage.getItem('syncpad_theme') || 'charcoal-amber'; } catch {}
  return 'charcoal-amber';
}

// ── Preview helpers ───────────────────────────────────────────────────────────

function _refreshPreviewIfActive() {
  if (_markdownMode !== 'write') UI.refreshPreview(() => renderMarkdown(UI.getEditorValue()));
}

function _wirePreviewClickOnce() {
  if (_previewObserverWired) return;
  _previewObserverWired = true;
  document.getElementById('note-preview')?.addEventListener('click', (e) => {
    const cb = e.target;
    if (!(cb instanceof HTMLInputElement) || cb.type !== 'checkbox') return;
    if (!canUseChecklist()) {
      e.preventDefault();
      UI.showToast(editBlockedReason() || 'Editing is disabled.', 'warning');
      cb.checked = !cb.checked; // revert visual change
      return;
    }
    const idx = Number(cb.dataset.cbIndex);
    if (!Number.isFinite(idx)) return;
    const updated = toggleChecklistItem(UI.getEditorValue(), idx, cb.checked);
    UI.setEditorValue(updated);
    document.getElementById('note-editor')?.dispatchEvent(new Event('input', { bubbles: true }));
    _refreshPreviewIfActive();
  });
}


/** Snapshot the current presence device list. */
function _getPresenceDevices() {
  // Presence devices are tracked in presence.js; expose via the rendered list
  // by reading the devices-list DOM. This is a lightweight approach that avoids
  // coupling presence.js state to app.js.
  const listEl = document.getElementById('devices-list');
  if (!listEl) return [];
  const items = listEl.querySelectorAll('.device-item');
  const devices = [];
  items.forEach(el => {
    devices.push({
      device_id:   el.dataset.deviceId || '',
      device_name: el.querySelector('.device-name')?.textContent?.trim() || 'Unknown',
      read_only:   el.classList.contains('viewer'),
      typing:      el.classList.contains('typing'),
      cursor_line: null,
    });
  });
  return devices;
}



async function doClearNote() {
  try {
    await clearRoomContent(_roomId, 'manual', await _emptyContentForCurrentEncryption());
    setContentNoSave('');
    UI.updateWordCount('');
    _refreshPreviewIfActive();
    broadcastClear('manual');
    UI.showToast('Note cleared.', 'success');
    _room = await loadRoom(_roomId);
    _updatePermissionContext();
  } catch { UI.showToast('Could not clear the note.', 'error'); }
}

// ── Auth event binding (top-level, before boot) ───────────────────────────────

document.getElementById('passcode-submit-btn')
  ?.addEventListener('click', onPasscodeSubmit);
document.getElementById('passcode-input')
  ?.addEventListener('keydown', (e) => { if (e.key === 'Enter') onPasscodeSubmit(); });

document.getElementById('encryption-submit-btn')
  ?.addEventListener('click', onEncryptionSubmit);
document.getElementById('encryption-input')
  ?.addEventListener('keydown', (e) => { if (e.key === 'Enter') onEncryptionSubmit(); });

// ── PWA / Service Worker ──────────────────────────────────────────────────────
//
// v1: wait for controllerchange (the new SW has actually taken
// control) before reloading. SKIP_WAITING alone doesn't guarantee the new
// SW is in control of the page yet, which can cause split-version reloads.

if ('serviceWorker' in navigator) {
  let _refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_refreshing) return;
    _refreshing = true;
    location.reload();
  });

  navigator.serviceWorker
    .register(`${BASE}/service-worker.js`, { scope: `${BASE}/` })
    .then((reg) => {
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            UI.showUpdateBar(() => {
              worker.postMessage({ type: 'SKIP_WAITING' });
              // location.reload() now fires via controllerchange above.
            });
          }
        });
      });
    })
    .catch(() => {});
}

let _deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstall = e;
  UI.showInstallBar(
    async () => { _deferredInstall?.prompt(); await _deferredInstall?.userChoice; _deferredInstall = null; },
    () => {}
  );
});

// ── Start ─────────────────────────────────────────────────────────────────────

boot();
