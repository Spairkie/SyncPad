// SyncPad – app.js
// Routing, room join flow, and event wiring.

import {
  getDeviceId, getDeviceName, setDeviceName,
  generateRoomId, sanitizeRoomId,
  copyToClipboard, insertTimestamp,
  isMobile, isOnline, onOnlineChange,
  buildRoomUrl, buildReadOnlyUrl, getUrlMode, parseDuration,
  escapeHtml, debounce,
} from './utils.js';

import { loadRoom, createRoom, clearRoomContent, subscribeToRoom, getOrCreateReadOnlyShareLink, resolveReadOnlyShareLink, updateRoomDisplayName, normalizeRoomDisplayName, submitRoomReport } from './rooms.js';

import {
  initBroadcast, destroyBroadcast,
  broadcastSettingsChange, broadcastFilesChange, cancelPendingTypingBroadcast, cancelPendingLiveContentBroadcast,
  broadcastClear, broadcastViewOnceCleared,
} from './live-broadcast.js';

import {
  initPresence, destroyPresence,
  setTyping, updatePresenceDeviceName, setCursorLine,
} from './presence.js';

import {
  initSync, destroySync,
  onLocalInput, onEditorBlur, flushSave, cancelPendingSave,
  handleRemoteTyping, handleRemoteLiveContent, handleRemoteDatabaseChange,
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
  exportCustomTemplates, importCustomTemplates,
} from './templates.js';
import { loadSavedTheme, applyTheme, THEMES }  from './theme.js';
import { initShortcuts, destroyShortcuts }     from './shortcuts.js';

import * as UI from './ui.js';
import { openFilePreview } from './file-preview.js';
import { initAdmin } from './admin.js';

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
let _viewOnceConsumedByThisSession = false; // session-local allowlist for first consumer view
let _isReadOnly    = false;  // v1: ?mode=read or /share/:token
let _shareToken    = null;
let _markdownMode  = 'write'; // 'write' | 'preview' | 'split'
let _showPreview   = false;  // derived: _markdownMode !== 'write'
let _previewObserverWired = false;
let _expPreset = '30s';

// ── Search state ──────────────────────────────────────────────────────────────
let _searchMatches    = []; // [{start,end}]
let _searchIndex      = -1;
let _searchTerm       = '';
let _caseSensitive    = false; // toggled by Aa button in F&R panel; reset on nav

// ── Editor preferences (user-global, persisted to localStorage) ───────────────
const _STRIP_PASTE_KEY = 'syncpad_strip_paste';
let _stripPaste = localStorage.getItem(_STRIP_PASTE_KEY) === 'true';

// ── Files bulk-select state ───────────────────────────────────────────────────
let _filesSelectMode = false;
let _selectedFiles   = new Set(); // Set<file.id>


const BASE = '/SyncPad';
const EXPIRATION_TIMER_MAX_DELAY_MS = 2147483647;


const REPORT_REASON_OPTIONS = new Set(['Spam', 'Abuse or harassment', 'Illegal or harmful content', 'Private information', 'Other']);

function _resetReportRoomModal() {
  const reasonEl = document.getElementById('report-room-reason');
  const detailsEl = document.getElementById('report-room-details');
  const errEl = document.getElementById('report-room-error');
  const okEl = document.getElementById('report-room-success');
  const submitEl = document.getElementById('report-room-submit');
  const charEl = document.getElementById('report-room-charcount');
  if (reasonEl) reasonEl.value = '';
  if (detailsEl) detailsEl.value = '';
  if (charEl) charEl.textContent = '0 / 1000';
  errEl?.classList.add('hidden');
  okEl?.classList.add('hidden');
  if (submitEl) { submitEl.disabled = false; submitEl.textContent = 'Submit report'; }
}

const RESERVED_ROOM_PATHS = new Set(['admin', 'contact', 'privacy', 'terms', 'share', 'assets', 'src', 'styles', 'docs']);

function _parseRoute() {
  const cleaned = location.pathname.replace(BASE, '').replace(/^\/+|\/+$/g, '');
  if (!cleaned) return { type: 'landing' };

  if (cleaned === 'contact') return { type: 'contact' };
  if (cleaned === 'privacy') return { type: 'privacy' };
  if (cleaned === 'terms') return { type: 'terms' };
  if (cleaned === 'admin') return { type: 'admin' };
  if (cleaned === 'share') {
    return {
      type: 'info',
      title: 'Share link unavailable',
      message: 'This read-only link is missing its token. Please use the full /share/:token URL.',
    };
  }

  const shareMatch = cleaned.match(/^share\/(.+)$/);
  if (shareMatch) {
    const token = shareMatch[1].replace(/^\/+|\/+$/g, '');
    if (!token) {
      return {
        type: 'info',
        title: 'Share link unavailable',
        message: 'This read-only link is missing its token. Please use the full /share/:token URL.',
      };
    }
    return { type: 'share', token };
  }

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
    initAdmin().catch((err) => {
      console.error('[admin] initAdmin failed:', err);
    });
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
  if (_isReadOnly) {
    const currentReadOnlyUrl = location.origin + location.pathname + location.search + location.hash;
    UI.populateShareModal({
      editableUrl: '',
      readOnlyUrl: currentReadOnlyUrl,
      readOnlyError: false,
      roomPath: '',
      roomDisplayTitle: (_room?.room_name || '').trim() || _roomId,
      hasPasscode: !!_room?.passcode_hash,
      hasEncryption: !!_room?.encryption_enabled,
      hasReadOnlyLink: !!currentReadOnlyUrl,
      isEditingLocked: !!_room?.editing_locked,
      hasViewOnce: !!_room?.view_once,
      expiresAt: _room?.expires_at || null,
    });
    UI.openModal('share-modal');
    return;
  }

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
    roomPath: `/${_roomId}` ,
    roomDisplayTitle: (_room?.room_name || '').trim() || _roomId,
    hasPasscode: !!_room?.passcode_hash,
    hasEncryption: !!_room?.encryption_enabled,
    hasReadOnlyLink: !!readOnlyUrl,
    isEditingLocked: !!_room?.editing_locked,
    hasViewOnce: !!_room?.view_once,
    expiresAt: _room?.expires_at || null,
  });
  UI.openModal('share-modal');
}

function wireLandingEvents() {
  const createBtn = document.getElementById('landing-create-btn');
  const joinInput = document.getElementById('landing-join-input');
  const joinBtn   = document.getElementById('landing-join-btn');

  const handleCreateRoomClick = () => {
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

  createBtn?.addEventListener('click', handleCreateRoomClick);
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

  const sentFlag = new URLSearchParams(location.search).get('sent');
  if (sentFlag === '1') {
    status.textContent = 'Thanks! Your message was sent successfully.';
    status.className = 'contact-status success';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    status.textContent = 'Sending message…';
    status.className = 'contact-status';

    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    payload.access_key = key;

    try {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) throw new Error(data?.message || 'Submit failed');
      status.textContent = 'Message sent successfully.';
      status.className = 'contact-status success';
      form.reset();
      history.replaceState(null, '', `${BASE}/contact?sent=1`);
    } catch (err) {
      status.textContent = 'Could not send message right now. Please try again later.';
      status.className = 'contact-status error';
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
  _viewOnceConsumedByThisSession = false;
  UI.setLoadingMessage('Loading room…');

  try {
    let room = await loadRoom(roomId);
    if (!room) {
      // Read-only clients should NOT auto-create rooms; the room must already exist.
      if (_isReadOnly) {
        UI.setInfoScreen({
          title: 'Share link unavailable',
          message: 'This read-only link points to a room that does not exist.',
        });
        UI.showScreen('info');
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

  // Read-only share links cannot satisfy passcode or encryption prompts —
  // the viewer doesn't have the credentials. Show a clear info screen instead
  // of leaving them stuck at an auth form they can never complete.
  if (_isReadOnly && (_room.passcode_hash || _room.encryption_enabled)) {
    UI.setInfoScreen({
      title: 'Room is locked',
      message: 'This read-only link points to a room protected by a passcode or encryption key. Contact the room owner for access.',
    });
    UI.showScreen('info');
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
  // PBKDF2 key derivation takes 1-3 s — show a spinner so the UI doesn't
  // look frozen. Preserve the button label so we can restore it on error.
  const origLabel = btn?.textContent ?? 'Decrypt & Open';
  if (btn) { btn.disabled = true; btn.textContent = 'Decrypting…'; }

  try {
    const key = await unlockEncryption(passphrase, _room.encryption_salt);
    if (!_room.content || !looksEncrypted(_room.content)) {
      throw new Error('Encrypted room content is missing or invalid.');
    }
    await decryptContent(_room.content, key); // verify — throws if wrong passphrase
    _encKey  = key;
    _encSalt = _room.encryption_salt;
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = origLabel; }
    UI.showEncryptionError('Wrong passphrase. Could not decrypt the note.');
    input?.focus(); input?.select();
    return;
  }
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
    !_room.viewed &&
    _room.cleared_reason !== 'view_once'
  );

  // ── Initial permission context ─────────────────────────────────────────────
  _updatePermissionContext();

  // ── Render ─────────────────────────────────────────────────────────────────
  UI.showScreen('app');
  _renderRoomHeader();
  UI.setEncryptionBadge(!!_room.encryption_enabled);
  UI.setViewOnceBadge(!!_room.view_once);
  UI.renderSettingsPanel(_room);
  UI.setStatus('connected');
  UI.setMonospace(_monospace);
  UI.setReadOnlyMode(_isReadOnly);
  // Ensure the editor always starts in write mode when entering a new room,
  // since _markdownMode was reset to 'write' in teardownRealtimeSession().
  UI.setMarkdownMode('write', null);
  UI.setLockedMode(!!_room.editing_locked);
  UI.renderThemePicker(THEMES, getSavedTheme_(), (id) => applyTheme(id));

  initSync({
    roomId:           _roomId,
    encryptFn:        _encKey ? (pt) => encryptContent(pt, _encKey) : null,
    decryptFn:        _encKey ? (ct) => decryptContent(ct, _encKey) : null,
    getEditorVal:     UI.getEditorValue,
    setEditorVal:     (text) => { UI.setEditorValue(text); UI.updateWordCount(text); _refreshPreviewIfActive(); },
    onStatusChange:   UI.setStatus,
    onPendingRemote:  (remoteText) => UI.showRemoteNotice({
      onApply:   () => { applyPendingRemote();   UI.hideRemoteNotice(); },
      onKeep:    () => { dismissPendingRemote(); UI.hideRemoteNotice(); },
      onCopy:    async () => {
        const ok = await copyToClipboard(remoteText ?? getPendingRemote() ?? '');
        if (ok) UI.showToast('Remote content copied.', 'success');
        else    UI.showToast('Could not copy.', 'error');
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
    onRemoteLiveContent: async (payload) => {
      if (_isEncryptedWithoutKey()) return;
      await handleRemoteLiveContent(payload);
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
      cancelPendingSave();
      cancelPendingTypingBroadcast();
      cancelPendingLiveContentBroadcast();
      clearDraft(_roomId);
      setContentNoSave('');
      UI.updateWordCount('');
      _refreshPreviewIfActive();
      UI.showToast('Note was cleared by another device.', 'warning');
    },
    onRemoteViewOnce: async () => {
      cancelPendingSave();
      cancelPendingTypingBroadcast();
      cancelPendingLiveContentBroadcast();
      clearDraft(_roomId);
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

  _unsubRoom = subscribeToRoom(_roomId, async ({ event, room }) => {
    if (event === 'DELETE') {
      cancelPendingSave();
      cancelPendingTypingBroadcast();
      cancelPendingLiveContentBroadcast();
      if (_expTimer) { clearTimeout(_expTimer); _expTimer = null; }
      UI.setEditorEditable(false);
      UI.showToast('This room no longer exists.', 'error', 6000);
      UI.setStatus('offline');
      return;
    }
    const prev = _room;
    _room = room;
    await _handleRoomStateTransition(prev, room);
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
        _viewOnceConsumedByThisSession = true;
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

  if (!_encKey) {
    // Draft is encrypted but we have no key. The most common cause is that
    // encryption was removed from the room after the draft was saved — the
    // ciphertext is now permanently unreadable. Clear it and warn the user so
    // they know work may have been lost.
    if (!_room?.encryption_enabled) {
      clearDraft(_roomId);
      UI.showToast(
        'A local draft from when this room was encrypted could not be restored (encryption has since been removed). Draft discarded.',
        'warning',
        8000,
      );
    }
    return null;
  }
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
  cancelPendingLiveContentBroadcast();
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
    cancelPendingLiveContentBroadcast();
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
  // Settings-only writes still change updated_by_device and DB-managed updated_at,
  // but they do not change content. Avoid treating those as stale remote text updates.
  if (shouldApplyRemoteContent) {
    await handleRemoteDatabaseChange(newRoom);
  }

  _renderRoomHeader();
  UI.renderSettingsPanel(_room);
  UI.setEncryptionBadge(!!_room.encryption_enabled);
  UI.setViewOnceBadge(!!_room.view_once);
  UI.setLockedMode(!!_room.editing_locked);

  // ── Clear/expired/view-once toasts ─────────────────────────────────────────
  if (newRoom.cleared_reason === 'expired' && prev?.cleared_reason !== 'expired') {
    cancelPendingSave();
    cancelPendingTypingBroadcast();
    cancelPendingLiveContentBroadcast();
    clearDraft(_roomId);
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
    if (_consumingViewOnce || _viewOnceConsumedByThisSession || isOwnWrite) {
      _consumingViewOnce = false;
      _updatePermissionContext();
    } else {
      cancelPendingSave();
      cancelPendingTypingBroadcast();
      cancelPendingLiveContentBroadcast();
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
    isViewOnceConsumed: (_room?.cleared_reason === 'view_once' && !!_room?.viewed && !_viewOnceConsumedByThisSession),
  });
  UI.setEditorEditable(canEdit());
  UI.setEditBlockedReason(editBlockedReason());
  _updateViewOnceConsumedUI();
}

function _updateViewOnceConsumedUI() {
  const consumed = _room?.view_once && _room?.cleared_reason === 'view_once' && !!_room?.viewed && !_viewOnceConsumedByThisSession;
  UI.setViewOnceConsumedPanel({
    visible: !!consumed,
    readOnly: !!_isReadOnly,
    onStartNew: async () => {
      if (_isReadOnly) return;
      try {
        await resetViewOnceNote(_roomId, await _emptyContentForCurrentEncryption(), true);
        clearDraft(_roomId);
        _room = await loadRoom(_roomId);
        _viewOnceConsumedByThisSession = false;
        setContentNoSave('');
        UI.updateWordCount('');
        _refreshPreviewIfActive();
        _updatePermissionContext();
        _renderRoomHeader();
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
  _expTimer = null;
  if (!_room?.expires_at) return;
  const armExpirationTimer = () => {
    clearTimeout(_expTimer);
    _expTimer = null;
    if (!_room?.expires_at) return;
    const remaining = new Date(_room.expires_at) - Date.now();
    if (remaining <= 0) {
      void (async () => {
        const didClear = await handleExpiration(_roomId, _room, await _emptyContentForCurrentEncryption());
        if (didClear) {
          setContentNoSave('');
          UI.updateWordCount('');
          UI.hideExpirationBar();
          _refreshPreviewIfActive();
          UI.showToast('This note expired and was cleared.', 'warning', 5000);
          broadcastSettingsChange();
        }
      })();
      return;
    }

    const nextDelay = Math.min(remaining, EXPIRATION_TIMER_MAX_DELAY_MS);
    _expTimer = setTimeout(() => {
      armExpirationTimer();
    }, nextDelay);
  };

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

  armExpirationTimer();
}

// ── File refresh ──────────────────────────────────────────────────────────────

function _updateBulkBar() {
  const n = _selectedFiles.size;
  const countEl  = document.getElementById('files-bulk-count');
  const deleteEl = document.getElementById('files-bulk-delete');
  if (countEl)  countEl.textContent = `${n} selected`;
  if (deleteEl) deleteEl.disabled   = n === 0;
}

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
      selectMode: _filesSelectMode,
      selectedIds: _selectedFiles,
      onSelectionChange: (file, checked) => {
        if (checked) _selectedFiles.add(file.id);
        else         _selectedFiles.delete(file.id);
        _updateBulkBar();
      },
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



function _renderRoomHeader() {
  UI.setRoomName({
    roomId: _roomId,
    roomName: _room?.room_name || '',
    canEditTitle: canEdit() && !(_room?.view_once && _room?.cleared_reason === 'view_once' && !!_room?.viewed && !_viewOnceConsumedByThisSession),
  });
}

function _selectExpirationPreset(preset) {
  _expPreset = preset;
  document.querySelectorAll('[data-exp-preset]').forEach((el) => el.classList.toggle('is-active', el.dataset.expPreset === preset));
  document.getElementById('exp-custom-row')?.classList.toggle('hidden', preset !== 'custom');
  _updateExpirationPreview();
}

function _buildExpirationDuration() {
  if (_expPreset !== 'custom') return _expPreset;
  const value = document.getElementById('exp-custom-value')?.value?.trim();
  const unit = document.getElementById('exp-custom-unit')?.value?.trim();
  if (!value) return { error: 'Please enter a number for custom auto-expire.' };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { error: 'Custom auto-expire must be a number greater than 0.' };
  if (!['s', 'm', 'h', 'd'].includes(unit)) return { error: 'Unsupported unit. Use seconds, minutes, hours, or days.' };
  // Enforce a 5-minute minimum to prevent accidental near-immediate expiry.
  const seconds = unit === 's' ? n : unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : n * 86400;
  if (seconds < 300) return { error: 'Minimum auto-expire duration is 5 minutes.' };
  return `${n}${unit}`;
}

function _updateExpirationPreview() {
  const preview = document.getElementById('setting-exp-preview');
  if (!preview) return;
  const built = _buildExpirationDuration();
  if (typeof built === 'object' && built?.error) {
    preview.textContent = 'Preview: Select a valid duration.';
    return;
  }
  const ms = parseDuration(built);
  if (!ms) { preview.textContent = 'Preview: Select a valid duration.'; return; }
  preview.textContent = `Preview: This room will clear around ${new Date(Date.now() + ms).toLocaleString()}.`;
}
// ── Event wiring (guarded against double-wire) ────────────────────────────────

function wireEvents() {
  // Shortcuts are always re-wired: they were destroyed in teardownRealtimeSession()
  // and their callbacks reference module-level state, not captured room locals.
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
      document.getElementById('search-input')?.focus();
    },
    onForceClose: () => {
      document.getElementById('more-dropdown')?.classList.remove('open');
      document.getElementById('btn-more')?.setAttribute('aria-expanded', 'false');
      UI.closeAllPanels();
      UI.closeAllModals();
    },
    onOpenShortcuts: () => UI.openModal('shortcuts-modal'),
    onOpenShare: () => {
      _openShareModal();
      UI.showToast('Share opened.', 'success');
    },
    onInsertTimestamp: () => {
      if (!canEdit()) { UI.showToast(editBlockedReason() || 'Editing is disabled.', 'warning'); return; }
      UI.insertAtCursor(insertTimestamp());
      UI.showToast('Timestamp inserted.', 'success');
    },
    onCopyNote: () => {
      copyToClipboard(UI.getEditorValue())
        .then(ok => ok
          ? UI.showToast('Copied to clipboard.', 'success')
          : UI.showToast('Could not copy.', 'error'));
    },
  });

  // All DOM element listeners below are one-time-only. On multi-room navigation
  // shortcuts are re-wired above, but these must not accumulate.
  if (_eventsWired) return;
  _eventsWired = true;

  const editor = document.getElementById('note-editor');

  editor?.addEventListener('input', () => {
    if (!canEdit()) return;
    onLocalInput(); // returns a Promise — intentional fire-and-forget
    setTyping(true);
    UI.updateWordCount(UI.getEditorValue());
    // Debounced so large documents don't re-render markdown on every keystroke.
    _debouncedRefreshPreview();
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
    // setTyping(false) clears the isTyping flag in Supabase Presence so other
    // devices don't see a ghost "typing" indicator after this tab closes.
    // visibilitychange handles tab-hide; beforeunload handles close/navigate.
    setTyping(false);
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
  document.getElementById('btn-about')?.addEventListener('click', () => { closeMoreDropdown(); UI.openModal('about-modal'); });
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
      .then(ok => ok
        ? UI.showToast('Room link copied!', 'success')
        : UI.showToast('Could not copy link.', 'error'));
  });

  document.getElementById('room-title-edit-btn')?.addEventListener('click', () => {
    if (!canEdit()) return;
    UI.setRoomTitleEditMode(true, (_room?.room_name || '').trim());
  });
  document.getElementById('room-title-cancel-btn')?.addEventListener('click', () => UI.setRoomTitleEditMode(false));
  const saveTitle = async () => {
    if (!canEdit()) return;
    const input = document.getElementById('room-title-input');
    const normalized = normalizeRoomDisplayName(input?.value || '');
    // No-op when the name hasn't actually changed — avoids an unnecessary DB
    // write and a misleading "Room title updated." toast on blur without edits.
    if (normalized === (_room?.room_name || '').trim()) {
      UI.setRoomTitleEditMode(false);
      return;
    }
    const saveBtn = document.getElementById('room-title-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    try {
      await updateRoomDisplayName(_roomId, normalized);
      _room.room_name = normalized;
      _renderRoomHeader();
      UI.setRoomTitleEditMode(false);
      UI.showToast('Room title updated.', 'success');
    } catch {
      // Keep edit mode open so the user can retry without clicking Edit again.
      if (saveBtn) saveBtn.disabled = false;
      input?.focus();
      input?.select();
      UI.showToast('Could not save title — check your connection and try again.', 'error');
    }
  };
  document.getElementById('room-title-save-btn')?.addEventListener('click', saveTitle);
  document.getElementById('room-title-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveTitle(); }
    if (e.key === 'Escape') { e.preventDefault(); UI.setRoomTitleEditMode(false); }
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
    copyToClipboard(UI.getEditorValue())
      .then(ok => ok
        ? UI.showToast('Copied to clipboard.', 'success')
        : UI.showToast('Could not copy.', 'error'));
  });
  document.getElementById('btn-insert-ts')?.addEventListener('click', () => {
    if (!canEdit()) { UI.showToast(editBlockedReason() || 'Editing is disabled.', 'warning'); return; }
    UI.insertAtCursor(insertTimestamp());
  });
  UI.initFooterClock();

  // ── Panels / modals ────────────────────────────────────────────────────────
  document.querySelectorAll('.panel-close').forEach(btn =>
    btn.addEventListener('click', () => UI.closeAllPanels())
  );
  document.getElementById('panel-backdrop')?.addEventListener('click', () => UI.closeAllPanels());

  document.querySelectorAll('.modal-backdrop').forEach(backdrop =>
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) UI.closeAllModals(); })
  );
  document.getElementById('share-modal-close')?.addEventListener('click', () => UI.closeModal('share-modal'));
  document.getElementById('about-modal-close')?.addEventListener('click', () => UI.closeModal('about-modal'));

  document.getElementById('btn-report-room')?.addEventListener('click', () => {
    closeMoreDropdown();
    _resetReportRoomModal();
    UI.openModal('report-room-modal');
  });
  document.getElementById('report-room-cancel')?.addEventListener('click', () => UI.closeModal('report-room-modal'));
  document.getElementById('report-room-details')?.addEventListener('input', (e) => {
    const details = e.target;
    if (!details) return;
    if (details.value.length > 1000) details.value = details.value.slice(0, 1000);
    const charEl = document.getElementById('report-room-charcount');
    if (charEl) charEl.textContent = `${details.value.length} / 1000`;
  });
  document.getElementById('report-room-submit')?.addEventListener('click', async () => {
    const reasonEl = document.getElementById('report-room-reason');
    const detailsEl = document.getElementById('report-room-details');
    const errEl = document.getElementById('report-room-error');
    const okEl = document.getElementById('report-room-success');
    const submitEl = document.getElementById('report-room-submit');
    const reason = (reasonEl?.value || '').trim();
    const details = (detailsEl?.value || '').trim();

    errEl?.classList.add('hidden');
    if (okEl) okEl.classList.add('hidden');

    if (!REPORT_REASON_OPTIONS.has(reason)) {
      if (errEl) { errEl.textContent = 'Please select a valid reason.'; errEl.classList.remove('hidden'); }
      return;
    }

    if (details.length > 1000) {
      if (errEl) { errEl.textContent = 'Details must be 1000 characters or fewer.'; errEl.classList.remove('hidden'); }
      return;
    }

    try {
      if (submitEl) { submitEl.disabled = true; submitEl.textContent = 'Submitting…'; }
      await submitRoomReport({
        roomId: _roomId,
        shareToken: _isReadOnly ? _shareToken : null,
        reason,
        details,
        mode: _isReadOnly ? 'readonly' : 'editable',
        pageUrl: location.href,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        reporterDeviceId: getDeviceId(),
      });
      if (okEl) okEl.classList.remove('hidden');
      UI.showToast('Report submitted. Thank you.', 'success');
      setTimeout(() => UI.closeModal('report-room-modal'), 900);
    } catch {
      if (errEl) {
        errEl.textContent = 'Could not submit report right now. Please try again.';
        errEl.classList.remove('hidden');
      }
      if (submitEl) { submitEl.disabled = false; submitEl.textContent = 'Submit report'; }
    }
  });


  // ── Tools ──────────────────────────────────────────────────────────────────
  const toolActions = {
    'tool-copy': () =>
      copyToClipboard(UI.getEditorValue())
        .then(ok => ok
          ? UI.showToast('Note copied.', 'success')
          : UI.showToast('Could not copy.', 'error')),

    'tool-copy-link': () =>
      copyToClipboard(buildRoomUrl(BASE, _roomId))
        .then(ok => ok
          ? UI.showToast('Link copied.', 'success')
          : UI.showToast('Could not copy link.', 'error')),

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
        if (f.size > 5 * 1024 * 1024) {
          UI.showToast('File too large (max 5 MB for text import).', 'error');
          return;
        }
        const r = new FileReader();
        r.onerror = () => UI.showToast('Could not read file.', 'error');
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

      const _openTemplates = () => {
        UI.openTemplatesModal(
          TEMPLATES,
          getCustomTemplates(),
          _onTemplateChosen,
          (key) => { deleteCustomTemplate(key); },
          (key, label) => { renameCustomTemplate(key, label); },
          {
            onExport: () => {
              const json = exportCustomTemplates();
              const blob = new Blob([json], { type: 'application/json' });
              const a    = Object.assign(document.createElement('a'), {
                href: URL.createObjectURL(blob), download: 'syncpad-templates.json',
              });
              document.body.appendChild(a); a.click(); document.body.removeChild(a);
              URL.revokeObjectURL(a.href);
              UI.showToast('Templates exported.', 'success');
            },
            onImport: () => {
              const inp = Object.assign(document.createElement('input'), {
                type: 'file', accept: 'application/json,.json',
              });
              inp.onchange = () => {
                const f = inp.files[0]; if (!f) return;
                if (f.size > 1024 * 1024) { UI.showToast('File too large (max 1 MB for template import).', 'error'); return; }
                const r = new FileReader();
                r.onerror = () => UI.showToast('Could not read file.', 'error');
                r.onload = (e) => {
                  let count;
                  try { count = importCustomTemplates(String(e.target.result)); }
                  catch (err) {
                    if (err?.code === 'QUOTA_EXCEEDED') { UI.showToast('Browser storage is full — could not import templates.', 'error'); return; }
                    UI.showToast('Import failed.', 'error'); return;
                  }
                  if (count < 0) { UI.showToast('Invalid file — expected a JSON object of templates.', 'error'); return; }
                  UI.showToast(`Imported ${count} template${count !== 1 ? 's' : ''}.`, 'success');
                  UI.closeModal('templates-modal');
                  setTimeout(_openTemplates, 150); // reopen with fresh data
                };
                r.readAsText(f);
              };
              inp.click();
            },
          }
        );
      };

      _openTemplates();
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

  // ── Files — bulk select ────────────────────────────────────────────────────
  document.getElementById('files-select-toggle')?.addEventListener('click', () => {
    _filesSelectMode = !_filesSelectMode;
    _selectedFiles.clear();
    document.getElementById('files-select-toggle')?.classList.toggle('active', _filesSelectMode);
    document.getElementById('files-bulk-bar')?.classList.toggle('hidden', !_filesSelectMode);
    _updateBulkBar();
    refreshFiles();
  });
  document.getElementById('files-bulk-cancel')?.addEventListener('click', () => {
    _filesSelectMode = false;
    _selectedFiles.clear();
    document.getElementById('files-select-toggle')?.classList.remove('active');
    document.getElementById('files-bulk-bar')?.classList.add('hidden');
    refreshFiles();
  });
  document.getElementById('files-bulk-delete')?.addEventListener('click', async () => {
    if (!_selectedFiles.size) return;
    if (!canDeleteFiles()) { UI.showToast(editBlockedReason() || 'File deletion is disabled.', 'warning'); return; }
    const count = _selectedFiles.size;
    const ok = await UI.showConfirm(
      `Permanently delete ${count} file${count !== 1 ? 's' : ''}? This cannot be undone.`,
      { confirmLabel: 'Delete', danger: true },
    );
    if (!ok) return;
    const ids = [..._selectedFiles];
    _selectedFiles.clear();
    let failed = 0;
    // Load current file list so we have file_path for each id
    const allFiles = await listFiles(_roomId);
    for (const id of ids) {
      const f = allFiles.find(x => x.id === id);
      if (!f) continue;
      try {
        await deleteFile(f.id, f.file_path);
      } catch { failed++; }
    }
    broadcastFilesChange();
    if (failed) UI.showToast(`${ids.length - failed} deleted, ${failed} failed.`, 'error');
    else        UI.showToast(`${ids.length} file${ids.length !== 1 ? 's' : ''} deleted.`, 'success');
    await refreshFiles();
    _updateBulkBar();
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
        _renderRoomHeader();
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
        _renderRoomHeader();
        UI.renderSettingsPanel(_room);
        broadcastSettingsChange();
        UI.showToast('Passcode set.', 'success');
      } catch { UI.showToast('Could not set passcode.', 'error'); }
    }
  });

  document.getElementById('setting-enc-btn')?.addEventListener('click', async () => {
    if (!canChangeSettings()) { UI.showToast(editBlockedReason() || 'Settings are disabled.', 'warning'); return; }
    const encBtn = document.getElementById('setting-enc-btn');
    if (_room.encryption_enabled) {
      if (!confirm('Disable encryption? Content will be stored in plaintext.')) return;
      await flushSave();
      cancelPendingTypingBroadcast();
      cancelPendingLiveContentBroadcast();
      const pp = prompt('Enter the current encryption passphrase to confirm:');
      if (!pp) return;
      // PBKDF2 key derivation takes 1-3 s — indicate progress on the button.
      if (encBtn) { encBtn.disabled = true; encBtn.textContent = 'Decrypting…'; }
      try {
        // Pass plaintext (editor value), passphrase, stored salt, and current DB ciphertext
        await disableEncryption(_roomId, UI.getEditorValue(), pp, _encSalt, _room.content);
        _encKey = null; _encSalt = null;
        // v1: tell sync.js the new encrypt/decrypt fns immediately.
        setEncryption(null, null);
        _room   = await loadRoom(_roomId);
        clearDraft(_roomId);
        _updatePermissionContext();
        _renderRoomHeader();
        UI.renderSettingsPanel(_room);
        UI.setEncryptionBadge(false);
        UI.showEncryptionLockedBanner(false);
        broadcastSettingsChange();
        UI.showToast('Encryption disabled.', 'success');
      } catch (err) {
        UI.renderSettingsPanel(_room); // restore button state
        UI.showToast(err.message || 'Could not disable encryption.', 'error', 4000);
      }
    } else {
      await flushSave();
      cancelPendingTypingBroadcast();
      cancelPendingLiveContentBroadcast();
      const existingFiles = await listFiles(_roomId);
      if (existingFiles.length && !confirm('This room has file attachments. SyncPad v1 encrypts note text only, not files. Continue enabling text encryption?')) return;
      const pp = prompt('Set an encryption passphrase (share it with anyone who needs to read this note):');
      if (!pp?.trim()) return;
      // PBKDF2 key derivation takes 1-3 s — indicate progress on the button.
      if (encBtn) { encBtn.disabled = true; encBtn.textContent = 'Encrypting…'; }
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
        _renderRoomHeader();
        UI.renderSettingsPanel(_room);
        UI.setEncryptionBadge(true);
        broadcastSettingsChange();
        UI.showToast('Encryption enabled.', 'success');
      } catch {
        UI.renderSettingsPanel(_room); // restore button state
        UI.showToast('Could not enable encryption.', 'error');
      }
    }
  });

  // Toggle the expiration controls panel open/closed. The button label is
  // 'Set' (no expiration) or 'Modify' (expiration exists). The actual removal
  // is handled by setting-exp-remove-btn inside the controls section.
  document.getElementById('setting-exp-btn')?.addEventListener('click', () => {
    const controls = document.getElementById('setting-exp-controls');
    if (!controls) return;
    const isHidden = controls.classList.toggle('hidden');
    if (!isHidden) _updateExpirationPreview(); // refresh preview when expanding
  });
  document.querySelectorAll('[data-exp-preset]').forEach((el) => el.addEventListener('click', () => _selectExpirationPreset(el.dataset.expPreset || '30s')));
  document.getElementById('exp-custom-value')?.addEventListener('input', _updateExpirationPreview);
  document.getElementById('exp-custom-unit')?.addEventListener('change', _updateExpirationPreview);
  document.getElementById('setting-exp-apply-btn')?.addEventListener('click', async () => {
    if (!canChangeSettings()) { UI.showToast(editBlockedReason() || 'Settings are disabled.', 'warning'); return; }
    const errorEl = document.getElementById('setting-exp-error');
    if (errorEl) { errorEl.textContent = ''; errorEl.classList.add('hidden'); }
    const built = _buildExpirationDuration();
    if (typeof built === 'object' && built?.error) {
      if (errorEl) { errorEl.textContent = built.error; errorEl.classList.remove('hidden'); }
      return;
    }
    try {
      await setExpiration(_roomId, built);
      _room = await loadRoom(_roomId);
      _renderRoomHeader();
      UI.renderSettingsPanel(_room);
      setupExpirationTimer();
      broadcastSettingsChange();
      UI.showToast('Auto-expire set.', 'success');
    } catch { UI.showToast('Could not set auto-expire.', 'error'); }
  });
  document.getElementById('setting-exp-remove-btn')?.addEventListener('click', async () => {
    if (!canChangeSettings()) { UI.showToast(editBlockedReason() || 'Settings are disabled.', 'warning'); return; }
    if (!_room.expires_at) { UI.showToast('No auto-expire is currently set.', 'warning'); return; }
    try {
      await clearExpiration(_roomId);
      _room = await loadRoom(_roomId);
      _renderRoomHeader();
      UI.renderSettingsPanel(_room);
      UI.hideExpirationBar();
      broadcastSettingsChange();
      UI.showToast('Auto-expire removed.', 'success');
    } catch { UI.showToast('Could not remove auto-expire.', 'error'); }
  });
  _selectExpirationPreset('30s');

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
      _renderRoomHeader();
      UI.renderSettingsPanel(_room);
      broadcastSettingsChange();
    } catch { UI.showToast('Could not update view-once setting.', 'error'); }
  });

  // Lock-editing toggle
  document.getElementById('setting-lock-btn')?.addEventListener('click', async () => {
    if (!canToggleLock()) { UI.showToast(editBlockedReason() || 'Lock controls are disabled.', 'warning'); return; }
    const target = !_room.editing_locked;
    try {
      if (target) { await flushSave(); cancelPendingTypingBroadcast(); cancelPendingLiveContentBroadcast(); }
      await setEditingLocked(_roomId, target);
      _room = await loadRoom(_roomId);
      _updatePermissionContext();
      _renderRoomHeader();
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

  // Shared guard: all export actions are meaningless on an empty note.
  const _requireContent = () => {
    if (UI.getEditorValue().trim()) return true;
    UI.showToast('Nothing to export — the note is empty.', 'warning');
    return false;
  };

  document.getElementById('export-txt')?.addEventListener('click', () => {
    if (!_requireContent()) return;
    _downloadBlob(UI.getEditorValue(), `${_roomId}.txt`, 'text/plain');
    UI.showToast('Downloaded .txt', 'success');
  });
  document.getElementById('export-md')?.addEventListener('click', () => {
    if (!_requireContent()) return;
    _downloadBlob(UI.getEditorValue(), `${_roomId}.md`, 'text/markdown');
    UI.showToast('Downloaded .md', 'success');
  });
  document.getElementById('export-html')?.addEventListener('click', () => {
    if (!_requireContent()) return;
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SyncPad – ${escapeHtml(_roomId)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.7}
pre{background:#f5f5f5;padding:1em;border-radius:4px;overflow:auto}code{background:#f5f5f5;padding:2px 4px;border-radius:2px}
blockquote{border-left:3px solid #ccc;margin:0;padding-left:1em;color:#666}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}</style>
</head><body>${renderMarkdown(UI.getEditorValue())}</body></html>`;
    _downloadBlob(html, `${_roomId}.html`, 'text/html');
    UI.showToast('Downloaded .html', 'success');
  });
  document.getElementById('export-copy-text')?.addEventListener('click', async () => {
    if (!_requireContent()) return;
    const ok = await copyToClipboard(UI.getEditorValue());
    if (ok) UI.showToast('Copied plain text.', 'success');
    else    UI.showToast('Could not copy.', 'error');
  });
  document.getElementById('export-copy-md')?.addEventListener('click', async () => {
    if (!_requireContent()) return;
    // Copy rendered HTML so users can paste into rich-text editors, email, docs, etc.
    const ok = await copyToClipboard(renderMarkdown(UI.getEditorValue()));
    if (ok) UI.showToast('Copied as HTML.', 'success');
    else    UI.showToast('Could not copy.', 'error');
  });
  document.getElementById('export-pdf')?.addEventListener('click', () => {
    if (!_requireContent()) return;
    const content = UI.getEditorValue();
    const renderedHtml = renderMarkdown(content);
    const title = escapeHtml(_room?.room_name?.trim() || _roomId);
    const win = window.open('', '_blank');
    if (!win) { UI.showToast('Pop-up blocked — allow pop-ups and try again.', 'warning'); return; }
    win.document.write(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  @media print { body { margin: 0; } }
  body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px;
         color: #1a1a1a; line-height: 1.75; font-size: 15px; }
  h1,h2,h3,h4,h5,h6 { line-height: 1.3; margin: 1.5em 0 0.5em; }
  pre { background: #f5f5f5; padding: 1em; border-radius: 4px; overflow: auto; font-size: 13px; }
  code { background: #f5f5f5; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #ccc; margin: 0; padding-left: 1em; color: #666; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ddd; padding: 6px 10px; }
  img { max-width: 100%; }
  a { color: #0066cc; }
</style>
</head><body>${renderedHtml}</body></html>`);
    win.document.close();
    win.print();
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
    try {
      const { truncated } = saveCustomTemplate(label.trim(), body);
      UI.showToast(
        truncated
          ? `Saved as template "${label.trim()}" (body capped at 50 KB).`
          : `Saved as template "${label.trim()}".`,
        'success',
      );
    } catch (err) {
      if (err?.code === 'QUOTA_EXCEEDED') { UI.showToast('Browser storage is full — template could not be saved.', 'error'); return; }
      UI.showToast('Could not save template.', 'error');
    }
  });

  // ── Find & Replace panel ───────────────────────────────────────────────────
  const searchInput  = document.getElementById('search-input');
  const searchCount  = document.getElementById('search-count');
  const replaceInput = document.getElementById('replace-input');
  const replaceOne   = document.getElementById('replace-one');
  const replaceAll   = document.getElementById('replace-all');

  // Enable/disable replace buttons based on edit permission and match count.
  const _syncReplaceButtons = () => {
    const enabled = canEdit() && _searchMatches.length > 0;
    if (replaceOne) replaceOne.disabled = !enabled;
    if (replaceAll) replaceAll.disabled = !enabled;
  };

  const _runSearch = () => {
    const raw = searchInput?.value || '';
    _searchTerm = _caseSensitive ? raw : raw.toLowerCase();
    _searchMatches = [];
    _searchIndex   = -1;
    if (!_searchTerm || !editor) {
      if (searchCount) searchCount.textContent = '';
      // Collapse any selection left by the previous _jumpToMatch() call so the
      // editor doesn't keep showing a stale highlighted range.
      if (editor) editor.setSelectionRange(editor.selectionEnd, editor.selectionEnd);
      _syncReplaceButtons();
      return;
    }
    const text = _caseSensitive ? editor.value : editor.value.toLowerCase();
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
    _syncReplaceButtons();
  };

  const _jumpToMatch = (idx, { keepFocus = false } = {}) => {
    if (!editor || !_searchMatches.length) return;
    const m = _searchMatches[idx];
    if (!m) return;
    // Switch to write mode if in preview
    if (_markdownMode !== 'write' && _markdownMode !== 'split') {
      _markdownMode = 'write'; _showPreview = false;
      UI.setMarkdownMode('write');
    }
    // Only steal focus from the editor when the search/replace inputs don't
    // own it — otherwise typing in the search panel scrolls away mid-query.
    const active = document.activeElement;
    const searchPanelFocused = active === searchInput || active === replaceInput;
    if (!searchPanelFocused && !keepFocus) editor.focus();
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
  // Single consolidated keydown handler for the search input.
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!_searchMatches.length) return;
      _searchIndex = (_searchIndex + 1) % _searchMatches.length;
      // Enter navigates — focus the editor so the selection highlight is visible.
      editor?.focus();
      _jumpToMatch(_searchIndex);
    }
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); replaceInput?.focus(); }
    if (e.key === 'Escape') { UI.closeAllPanels(); editor?.focus(); }
  });
  replaceInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Tab'    && e.shiftKey)  { e.preventDefault(); searchInput?.focus(); }
    if (e.key === 'Enter')  { e.preventDefault(); replaceOne?.click(); }
    if (e.key === 'Escape') { UI.closeAllPanels(); editor?.focus(); }
  });

  document.getElementById('search-next')?.addEventListener('click', () => {
    if (!_searchMatches.length) return;
    _searchIndex = (_searchIndex + 1) % _searchMatches.length;
    _jumpToMatch(_searchIndex);
    // Return focus to search input so keyboard nav continues naturally.
    searchInput?.focus();
  });
  document.getElementById('search-prev')?.addEventListener('click', () => {
    if (!_searchMatches.length) return;
    _searchIndex = (_searchIndex - 1 + _searchMatches.length) % _searchMatches.length;
    _jumpToMatch(_searchIndex);
    searchInput?.focus();
  });

  // Replace current match and advance to the next one.
  replaceOne?.addEventListener('click', () => {
    if (!canEdit()) { UI.showToast(editBlockedReason() || 'Editing is disabled.', 'warning'); return; }
    if (!_searchMatches.length || !editor) return;
    const m = _searchMatches[Math.max(0, _searchIndex)];
    if (!m) return;
    const replacement = replaceInput?.value ?? '';
    editor.value = editor.value.slice(0, m.start) + replacement + editor.value.slice(m.end);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    UI.updateWordCount(editor.value);
    _refreshPreviewIfActive();
    // Re-index so positions reflect the changed content, then advance.
    _runSearch();
    if (_searchMatches.length > 0) {
      _searchIndex = Math.min(_searchIndex, _searchMatches.length - 1);
      _jumpToMatch(_searchIndex, { keepFocus: true });
    }
    // Keep focus in the replace input so the user can continue replacing.
    replaceInput?.focus();
  });

  // Replace every match at once.
  replaceAll?.addEventListener('click', () => {
    if (!canEdit()) { UI.showToast(editBlockedReason() || 'Editing is disabled.', 'warning'); return; }
    if (!_searchMatches.length || !_searchTerm || !editor) return;
    const count = _searchMatches.length;
    const replacement = replaceInput?.value ?? '';
    // Escape the raw search term for safe use in RegExp.
    // Use the un-lowercased raw input for the pattern when case-sensitive.
    const rawTerm = searchInput?.value || '';
    const escaped = rawTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags   = _caseSensitive ? 'g' : 'gi';
    editor.value = editor.value.replace(new RegExp(escaped, flags), replacement);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    UI.updateWordCount(editor.value);
    _refreshPreviewIfActive();
    _runSearch();
    UI.showToast(`Replaced ${count} match${count !== 1 ? 'es' : ''}.`, 'success');
    // Return focus to search so the user can start a new query.
    searchInput?.focus();
  });

  // ── Case-sensitive toggle (Aa button) ─────────────────────────────────────
  const caseBtn = document.getElementById('search-case');
  caseBtn?.addEventListener('click', () => {
    _caseSensitive = !_caseSensitive;
    caseBtn.setAttribute('aria-pressed', String(_caseSensitive));
    caseBtn.classList.toggle('is-active', _caseSensitive);
    _runSearch();
    searchInput?.focus();
  });

  // ── Paste sanitization ─────────────────────────────────────────────────────
  // Strip HTML/RTF formatting on paste when the user preference is enabled.
  // We intercept the paste event on the editor and substitute plain-text only.
  editor?.addEventListener('paste', (e) => {
    if (!_stripPaste) return;
    const plain = e.clipboardData?.getData('text/plain');
    if (plain === undefined) return;
    e.preventDefault();
    const start   = editor.selectionStart;
    const end     = editor.selectionEnd;
    editor.value  = editor.value.slice(0, start) + plain + editor.value.slice(end);
    editor.setSelectionRange(start + plain.length, start + plain.length);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // ── Strip-paste setting button ─────────────────────────────────────────────
  const _updateStripPasteUI = () => {
    const btn = document.getElementById('setting-strip-paste-btn');
    if (!btn) return;
    btn.textContent = _stripPaste ? 'On' : 'Off';
    btn.setAttribute('aria-pressed', String(_stripPaste));
  };
  _updateStripPasteUI();

  document.getElementById('setting-strip-paste-btn')?.addEventListener('click', () => {
    _stripPaste = !_stripPaste;
    try { localStorage.setItem(_STRIP_PASTE_KEY, String(_stripPaste)); } catch {}
    _updateStripPasteUI();
    UI.showToast(
      _stripPaste ? 'Paste formatting strip: On' : 'Paste formatting strip: Off',
      'info', 2000
    );
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
  // Remove the keydown handler so wireEvents() can install fresh callbacks
  // on the next room join. DOM element listeners (editor, buttons, etc.) are
  // protected by the _eventsWired guard and must NOT be reset here — resetting
  // _eventsWired would cause them to accumulate on multi-room navigation.
  destroyShortcuts();
  cancelPendingTypingBroadcast();
  cancelPendingLiveContentBroadcast();
  // Clear stale search state so the next room starts with a clean search panel.
  _searchMatches = [];
  _searchIndex   = -1;
  _searchTerm    = '';
  _caseSensitive = false;
  const _scEl = document.getElementById('search-count');
  if (_scEl) _scEl.textContent = '';
  const _siEl = document.getElementById('search-input');
  if (_siEl) _siEl.value = '';
  // Reset the Aa toggle to case-insensitive so the next room starts fresh.
  const _caseEl = document.getElementById('search-case');
  if (_caseEl) { _caseEl.classList.remove('is-active'); _caseEl.setAttribute('aria-pressed', 'false'); }
  // Cancel any pending expiration timer. The callback closes over the
  // module-level _roomId / _room which will be updated to the NEXT room
  // before the timer fires — letting a stale timer run risks expiring the
  // wrong room.
  clearTimeout(_expTimer);
  _expTimer = null;
  // Reset encryption keys so a key from an encrypted room is never used to
  // silently encrypt saves in a subsequent non-encrypted room.
  _encKey  = null;
  _encSalt = null;
  // Reset editor mode so the next room always starts in plain-write view
  // rather than inheriting preview / split mode from the previous room.
  _markdownMode = 'write';
  _showPreview  = false;
  // Reset expiration preset so the settings panel shows a sensible default
  // rather than whatever preset was last selected in the previous room.
  _expPreset = '30s';
  // Exit bulk-select mode so the next room starts with a clean files panel.
  _filesSelectMode = false;
  _selectedFiles   = new Set();
  document.getElementById('files-bulk-bar')?.classList.add('hidden');
  document.getElementById('files-select-toggle')?.classList.remove('active');
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

// Debounced variant — used on every keystroke so heavy markdown docs
// (50 KB+) don't re-render on every character and cause frame drops.
const _debouncedRefreshPreview = debounce(_refreshPreviewIfActive, 300);

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

const INSTALL_DISMISSED_KEY = 'syncpad_install_dismissed';
let _deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstall = e;
  if (localStorage.getItem(INSTALL_DISMISSED_KEY) === '1') return;
  UI.showInstallBar(
    async () => { _deferredInstall?.prompt(); await _deferredInstall?.userChoice; _deferredInstall = null; },
    () => { localStorage.setItem(INSTALL_DISMISSED_KEY, '1'); }
  );
});

// ── Draft storage warning ─────────────────────────────────────────────────────
// Fires at most once per page load when offline.js detects QuotaExceededError.
// Using { once: true } so repeated keystrokes don't re-show the toast.
window.addEventListener('syncpad:draft-storage-full', () => {
  UI.showToast(
    'Browser storage is full — local drafts cannot be saved. Your notes still sync to the server.',
    'warning',
    8000,
  );
}, { once: true });

// ── Start ─────────────────────────────────────────────────────────────────────

boot();
