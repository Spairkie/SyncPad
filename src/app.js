// SyncPad – app.js
// Routing, room join flow, and event wiring.

import {
  getDeviceId, getDeviceName, setDeviceName,
  generateRoomId, sanitizeRoomId,
  copyToClipboard, insertTimestamp,
  isMobile, isOnline, onOnlineChange,
  buildRoomUrl, buildReadOnlyUrl, getUrlMode, parseDuration,
  escapeHtml, debounce, formatTimestamp,
} from './utils.js';

import { loadRoom, createRoom, clearRoomContent, subscribeToRoom, getOrCreateReadOnlyShareLink, resolveReadOnlyShareLink, getOrCreateRoomCode, resolveRoomCode, recordRoomDeviceView, setDeviceLimit, clearDeviceLimit, updateRoomDisplayName, normalizeRoomDisplayName, submitRoomReport, REPORT_REASONS } from './rooms.js';
import { listRevisions } from './revisions.js';

import {
  initBroadcast, destroyBroadcast,
  broadcastSettingsChange, broadcastFilesChange, cancelPendingTypingBroadcast, cancelPendingLiveContentBroadcast,
  broadcastClear, broadcastViewOnceCleared, broadcastCursorChat,
} from './live-broadcast.js';

import {
  initPresence, destroyPresence,
  setTyping, updatePresenceDeviceName, setCursorLine, setPresenceHidden,
} from './presence.js';

import {
  initSync, destroySync,
  onLocalInput, onEditorBlur, flushSave, cancelPendingSave,
  handleRemoteTyping, handleRemoteLiveContent, handleRemoteDatabaseChange,
  setContentNoSave, applyPendingRemote, dismissPendingRemote, getPendingRemote, getPendingRemoteTs,
  setEncryption, snapshotBeforeDestructiveChange,
} from './sync.js';

import { uploadFile, listFiles, deleteFile, getDownloadUrl, getForceDownloadUrl, subscribeToFiles } from './files.js';

import {
  checkPasscode, setPasscode, removePasscode,
  enableEncryption, disableEncryption, unlockEncryption,
  setExpiration, clearExpiration, handleExpiration,
  enableViewOnce, disableViewOnce, consumeViewOnce, resetViewOnceNote,
  setEditingLocked,
} from './settings.js';

import { encryptContent, decryptContent, looksEncrypted } from './encryption.js';
import { loadDraft, clearDraft, isDraftNewer }              from './offline.js';
import * as LiveEditor from './live-editor.js';

import {
  setPermissionContext, canEdit, canChangeSettings, canToggleLock, canUploadFiles,
  canDeleteFiles, canUseTemplates, canUseChecklist, canClearNote, canImportText, canPaste,
  editBlockedReason,
} from './permissions.js';

import { renderMarkdown, renderMarkdownWithToc, renderTocHtml, toggleChecklistItem } from './markdown.js';
import {
  TEMPLATES, getTemplate, getCustomTemplates,
  saveCustomTemplate, renameCustomTemplate, deleteCustomTemplate,
  exportCustomTemplates, importCustomTemplates,
} from './templates.js';
import { loadSavedTheme, applyTheme, THEMES, getSavedTheme }  from './theme.js';
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
let _onlineCleanup = null;   // v1: teardown fn returned by onOnlineChange()
let _monospace     = false;
let _eventsWired   = false;  // v1: guard against double-wiring
let _consumingViewOnce = false; // v1: short-circuit own view-once clear echo
let _viewOnceConsumedByThisSession = false; // session-local allowlist for first consumer view
let _isReadOnly    = false;  // v1: ?mode=read or /share/:token
let _shareToken    = null;
let _markdownMode  = 'write'; // 'write' | 'preview' | 'split'
let _showPreview   = false;  // derived: _markdownMode !== 'write'
let _previewObserverWired = false;
let _expPreset = '10m';
// Room-scoped: which remote device_id (if any) the local view auto-scrolls
// to follow. Reset on room navigation like the other room-scoped state below.
let _followedDeviceId = null;

// ── Search state ──────────────────────────────────────────────────────────────
let _searchMatches    = []; // [{start,end}]
let _searchIndex      = -1;
let _searchTerm       = '';
let _caseSensitive    = false; // toggled by Aa button in F&R panel; reset on nav

// ── Editor preferences (user-global, persisted to localStorage) ───────────────
const _STRIP_PASTE_KEY = 'syncpad_strip_paste';
let _stripPaste = localStorage.getItem(_STRIP_PASTE_KEY) === 'true';
// Off by default — it rewrites what you actually typed, which is a bigger
// surprise than a purely visual preference, and some notes (code, URLs)
// need literal straight quotes/hyphens preserved.
const _SMART_PUNCT_KEY = 'syncpad_smart_punct';
let _smartPunct = localStorage.getItem(_SMART_PUNCT_KEY) === 'true';
const _FOCUS_MODE_KEY = 'syncpad_focus_mode';
let _focusMode = localStorage.getItem(_FOCUS_MODE_KEY) === 'true';
const _TYPEWRITER_MODE_KEY = 'syncpad_typewriter_mode';
let _typewriterMode = localStorage.getItem(_TYPEWRITER_MODE_KEY) === 'true';
const _HIDE_PRESENCE_KEY = 'syncpad_hide_presence';
let _hidePresence = localStorage.getItem(_HIDE_PRESENCE_KEY) === 'true';

// ── Files state ───────────────────────────────────────────────────────────────
let _filesSelectMode = false;
let _selectedFiles   = new Set(); // Set<file.id>
let _filesSort       = 'newest';  // sort order for the files panel (not room-scoped)


const BASE = _normalizeBasePath(window.SYNCPAD_CONFIG?.basePath ?? '/SyncPad');
const EXPIRATION_TIMER_MAX_DELAY_MS = 2147483647;

// ── PWA last-room resume ───────────────────────────────────────────────────────
// When launched as an installed/standalone PWA, boot() skips the landing screen
// and reopens the last editable room the user visited, so the app behaves like a
// native app that reopens where you left off instead of a link-sharing tool that
// always starts at "create or join". Regular browser tabs are unaffected — this
// only applies when display-mode is standalone (or iOS's legacy navigator.standalone).
const LAST_ROOM_KEY       = 'syncpad_last_room_id';
const RESUME_SUPPRESS_KEY = 'syncpad_suppress_resume';

function _isStandalonePwa() {
  try {
    return window.matchMedia?.('(display-mode: standalone)')?.matches === true
        || window.navigator?.standalone === true;
  } catch { return false; }
}

function _rememberLastRoom(roomId) {
  try { localStorage.setItem(LAST_ROOM_KEY, roomId); } catch {}
}

// Any control that deliberately navigates to the app root (header logo,
// "Back to SyncPad" links, view-once "Go home" button, etc.) must call this
// first so boot() shows the real landing screen instead of immediately
// resuming back into this room.
function _suppressNextResume() {
  try { sessionStorage.setItem(RESUME_SUPPRESS_KEY, '1'); } catch {}
}

// A plain <a href="{BASE}/"> to the app root — the header logo and every
// "Back to SyncPad" link on the contact/privacy/terms/info screens — is a
// real page navigation, so it can't be caught by the room-scoped, one-time
// wireEvents() wiring (some of those screens are reachable without ever
// joining a room in this session at all). One delegated listener here
// catches all of them, present and future, instead of wiring each link
// individually and risking new ones being missed.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  if (!a) return;
  const rootUrl = `${location.origin}${BASE}/`;
  if (a.href === rootUrl || a.href === `${location.origin}${BASE}`) {
    _suppressNextResume();
  }
});

// The app changes the URL with history.pushState/replaceState (room joins,
// the admin route, contact-form success, etc.) but never listens for the
// browser's own Back/Forward buttons, which fire `popstate` without
// reloading — so the address bar changed but every on-screen room, panel,
// and realtime connection stayed exactly as they were. boot() is a single
// entry point with several one-shot, order-dependent side effects (consuming
// the PWA-resume-suppression flag, a sessionStorage 404-redirect, generating
// a fresh room id) that isn't safe to silently re-run mid-session on an
// arbitrary popstate. A full reload re-runs that same already-correct,
// already-tested boot sequence against the URL the browser just navigated
// to — the same trade-off the app already makes for "join a different room
// by editing the URL bar and pressing Enter".
//
// Following a same-page anchor link (e.g. a Markdown table-of-contents
// entry, href="#some-heading") and then pressing Back also fires popstate,
// even though the route itself hasn't changed — only the hash has. Reloading
// there would be actively harmful, not just an unnecessary flicker: a
// view-once note's only remaining copy after the server clears its content
// lives in memory (_viewOnceConsumedByThisSession), so a reload at the wrong
// moment permanently loses it. Only reload when the path or query actually
// changed; a hash-only difference is left to the browser's own default
// same-page scroll-to-anchor behavior.
//
// _lastRoutePathAndSearch has to stay in sync with every history mutation,
// not just popstate — the app's own pushState/replaceState calls (room
// joins, the admin route, etc.) change the URL too, and if left unsynced
// the tracker goes stale the moment the app itself navigates, making the
// very next Back incorrectly look like a no-op hash change and silently
// skip the reload it actually needs. Wrapping both methods once here keeps
// it accurate regardless of which existing or future call site navigates.
let _lastRoutePathAndSearch = location.pathname + location.search;
const _origPushState    = history.pushState.bind(history);
const _origReplaceState = history.replaceState.bind(history);
history.pushState = (...args) => {
  _origPushState(...args);
  _lastRoutePathAndSearch = location.pathname + location.search;
};
history.replaceState = (...args) => {
  _origReplaceState(...args);
  _lastRoutePathAndSearch = location.pathname + location.search;
};
window.addEventListener('popstate', () => {
  const current = location.pathname + location.search;
  if (current === _lastRoutePathAndSearch) return;
  _lastRoutePathAndSearch = current;
  location.reload();
});

// Pasted/dropped images reference a private-bucket file path (markdown.js's
// syncpad-file: scheme) rather than a baked-in URL, since a real signed URL
// expires in ~1h and can't just be stored in the note text. This resolver is
// stateless with respect to the current room, so it's wired once here rather
// than re-wired on every room join.
UI.setFileImageResolver(getDownloadUrl);
LiveEditor.setFileImageResolver(getDownloadUrl);

function _normalizeBasePath(basePath) {
  const raw = String(basePath || '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

function _stripBasePath(pathname) {
  if (!BASE) return pathname;
  return pathname === BASE || pathname.startsWith(`${BASE}/`)
    ? pathname.slice(BASE.length) || '/'
    : pathname;
}

// Use REPORT_REASONS imported from rooms.js to keep client and server in sync.
const REPORT_REASON_OPTIONS = REPORT_REASONS;

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
  const cleaned = _stripBasePath(location.pathname).replace(/^\/+|\/+$/g, '');
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
    // Standalone PWA launches resume the last room instead of showing landing,
    // unless the user just deliberately navigated Home (one-shot suppression).
    let suppressResume = false;
    try { suppressResume = sessionStorage.getItem(RESUME_SUPPRESS_KEY) === '1'; } catch {}
    if (suppressResume) { try { sessionStorage.removeItem(RESUME_SUPPRESS_KEY); } catch {} }

    let lastRoom = null;
    if (!suppressResume && _isStandalonePwa()) {
      try { lastRoom = localStorage.getItem(LAST_ROOM_KEY); } catch {}
    }

    if (lastRoom) {
      const qs = location.search || '';
      history.replaceState(null, '', `${BASE}/${lastRoom}${qs}`);
      await joinRoom(lastRoom);
      return;
    }

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
      showRoomCode: false, // no room-owning identity in a read-only session to generate one from
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
  let roomCode = '';
  let roomCodeError = false;
  try {
    roomCode = await getOrCreateRoomCode(_roomId) || '';
    if (!roomCode) roomCodeError = true;
  } catch {
    roomCodeError = true;
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
    roomCode,
    roomCodeError,
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

  // A bare 6-character code from the short-code alphabet (see
  // docs/migrations/short-room-codes.sql) — distinct enough from
  // generateRoomId()'s "adjective-noun-suffix" shape and from any
  // sanitizeRoomId() output containing a URL/slash that a false-positive
  // match against a deliberately-chosen custom room id is very unlikely.
  // Resolution failure just falls through to the existing room-id path
  // below rather than erroring, so this can never make a previously
  // working join input stop working.
  const SHORT_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/i;

  const joinRoom_ = async () => {
    const raw = joinInput?.value?.trim();
    if (!raw) return;

    if (SHORT_CODE_RE.test(raw)) {
      try {
        const resolvedId = await resolveRoomCode(raw);
        if (resolvedId) {
          history.pushState(null, '', `${BASE}/${resolvedId}`);
          UI.showScreen('loading');
          joinRoom(resolvedId);
          return;
        }
      } catch { /* fall through to the literal-room-id path below */ }
    }

    // Accept full URL or bare ID
    let id;
    try {
      const url = new URL(raw);
      id = _stripBasePath(url.pathname).replace(/^\/+|\/+$/g, '');
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

function _showQuarantinedScreen(room) {
  UI.setInfoScreen({
    title: 'Room unavailable',
    message: room?.quarantine_reason
      ? `This room has been quarantined by an administrator. Reason: ${room.quarantine_reason}`
      : 'This room has been quarantined by an administrator and is no longer accessible.',
  });
  UI.showScreen('info');
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
  } catch (err) {
    // Log the raw error so RLS / network failures are diagnosable in DevTools.
    console.error('[SyncPad] joinRoom failed for', roomId, err);
    UI.showLoadingError(
      'Could not load room — check your connection and try again.',
      () => joinRoom(roomId),  // retry callback
    );
    return;
  }

  // Quarantine blocks the room entirely — before any passcode prompt,
  // decryption attempt, or editor initialization. quarantined_at/
  // quarantine_reason only exist if the optional admin-dashboard migration
  // has been applied; absent columns are simply undefined/falsy here, so
  // this is a no-op for installs that haven't run it.
  if (_room.quarantined_at) {
    _showQuarantinedScreen(_room);
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
  const passcode = input?.value || '';
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

  // Remember this room for PWA "resume last room" (see _isStandalonePwa()).
  // Only for genuine editable visits — not read-only share links or ?mode=read,
  // which are bound to someone else's link rather than "my" room.
  if (!_isReadOnly) _rememberLastRoom(_roomId);

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

  // ── Device limit: record this device's join, clearing the room once the
  // configured number of distinct devices has been reached ─────────────────
  // The creator's own devices don't consume a slot — same reasoning as
  // View-once's isCreator exclusion above. Best-effort: a Supabase project
  // that hasn't run docs/migrations/device-limit.sql yet just has
  // device_limit stay null forever, so this never fires for it.
  if (_room.device_limit && !isCreator) {
    try {
      const result = await recordRoomDeviceView(_roomId, deviceId);
      if (result.expired) _room = await loadRoom(_roomId);
    } catch { /* non-fatal — see comment above */ }
  }

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
  UI.setFocusMode(_focusMode);
  UI.setTypewriterMode(_typewriterMode);
  UI.setReadOnlyMode(_isReadOnly);
  // Ensure the editor always starts in write mode when entering a new room,
  // since _markdownMode was reset to 'write' in teardownRealtimeSession().
  UI.setMarkdownMode('write', null);
  UI.setLockedMode(!!_room.editing_locked);
  UI.renderThemePicker(THEMES, getSavedTheme(), (id) => applyTheme(id));

  initSync({
    roomId:           _roomId,
    encryptFn:        _encKey ? (pt) => encryptContent(pt, _encKey) : null,
    decryptFn:        _encKey ? (ct) => decryptContent(ct, _encKey) : null,
    getEditorVal:     UI.getEditorValue,
    setEditorVal:     (text) => { UI.setEditorValue(text); LiveEditor.syncFromText(text); UI.updateWordCount(text); _refreshPreviewIfActive(); },
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
    onRemoteCursorChat: (payload) => {
      // Only meaningful where there's a real caret to anchor to — the CM6
      // live surface, the same place remote carets themselves render.
      // Write mode has no per-character screen coordinates to place a
      // bubble at (and LiveEditor stays mounted-but-hidden there), so the
      // message is silently dropped rather than faked into a wrong position.
      if (_markdownMode === 'write' || !LiveEditor.isMounted()) return;
      const coords = LiveEditor.coordsAtPos(payload.pos);
      if (!coords) return;
      UI.showCursorChatBubble({
        deviceId:   payload.device_id,
        deviceName: payload.device_name,
        text:       String(payload.text || '').slice(0, 80),
        x: coords.x, y: coords.y,
      });
    },
  });

  initPresence(_roomId, (devices) => {
    UI.updateDeviceCount(devices.length);
    // A followed device that disconnected (or hid its presence) can't be
    // followed anymore — drop it rather than leaving a dead toggle active.
    if (_followedDeviceId && !devices.some((d) => d.device_id === _followedDeviceId && !d.isMe)) {
      _followedDeviceId = null;
    }
    UI.renderDevicesList(devices, deviceId, (name) => {
      setDeviceName(name);
      updatePresenceDeviceName(getDeviceName());
    }, {
      followedDeviceId: _followedDeviceId,
      onToggleFollow: (id) => { _followedDeviceId = _followedDeviceId === id ? null : id; },
    });
    // Render remote collaborators' carets/selections in the live surface
    // (no-op when it isn't mounted).
    LiveEditor.setRemoteCursors(
      devices
        .filter((d) => !d.isMe && typeof d.cursor_pos === 'number')
        .map((d) => ({ id: d.device_id, name: d.device_name, pos: d.cursor_pos, anchor: d.cursor_anchor })),
    );
    // "Follow" mode: jump the local view to the followed device's cursor as
    // it moves. Only meaningful where there's a real caret to scroll to —
    // the CM6 live surface — same gating as cursor chat.
    if (_followedDeviceId && _markdownMode !== 'write' && LiveEditor.isMounted()) {
      const followed = devices.find((d) => d.device_id === _followedDeviceId);
      if (followed && typeof followed.cursor_pos === 'number') {
        LiveEditor.scrollToPos(followed.cursor_pos);
      }
    }
  }, { readOnly: _isReadOnly });
  // Re-applied on every room entry — destroyPresence() deliberately leaves
  // this preference alone since it's per-device, not room state (see
  // presence.js), so the fresh channel from initPresence() above always
  // starts back at the default until this runs.
  setPresenceHidden(_hidePresence);

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

  _onlineCleanup = onOnlineChange((online) => {
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

  // Live quarantine: an admin can quarantine a room while it's open in this
  // tab. Tear down and block immediately, before applying any other part of
  // this update, so no further content/settings changes are processed.
  if (newRoom.quarantined_at) {
    teardownRealtimeSession();
    _showQuarantinedScreen(newRoom);
    return;
  }

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

  if (newRoom.cleared_reason === 'device_limit' && prev?.cleared_reason !== 'device_limit') {
    clearDraft(_roomId);
    if (isOwnWrite) {
      // This device's own join was the one that hit the limit — it already
      // has the content in hand from startApp() (captured before the
      // clearing write), so don't wipe what it just earned the right to see.
      _updatePermissionContext();
    } else {
      cancelPendingSave();
      cancelPendingTypingBroadcast();
      cancelPendingLiveContentBroadcast();
      setContentNoSave('');
      UI.updateWordCount('');
      _refreshPreviewIfActive();
      UI.showToast('This room reached its device limit and has been cleared from the server.', 'warning', 6000);
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
  LiveEditor.setReadOnly(!canEdit()); // keep the live surface's gate in lockstep
  UI.setEditBlockedReason(editBlockedReason());
  _updateViewOnceConsumedUI();
}

function _updateViewOnceConsumedUI() {
  const consumed = _room?.view_once && _room?.cleared_reason === 'view_once' && !!_room?.viewed && !_viewOnceConsumedByThisSession;
  UI.setViewOnceConsumedPanel({
    visible: !!consumed,
    readOnly: !!_isReadOnly,
    onGoHome: _suppressNextResume,
    onStartNew: async () => {
      if (_isReadOnly) return;
      try {
        await snapshotBeforeDestructiveChange();
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

function _sortFiles(files) {
  const arr = [...files];
  switch (_filesSort) {
    case 'oldest':    return arr.sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at));
    case 'name-asc':  return arr.sort((a, b) => a.filename.localeCompare(b.filename));
    case 'name-desc': return arr.sort((a, b) => b.filename.localeCompare(a.filename));
    case 'size-desc': return arr.sort((a, b) => b.file_size - a.file_size);
    case 'size-asc':  return arr.sort((a, b) => a.file_size - b.file_size);
    default:          return arr.sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at)); // newest
  }
}

/**
 * Upload one or more images pasted/dropped straight into the editor and
 * insert a syncpad-file: markdown reference for each at the cursor —
 * mirrors the Files panel's own multi-upload flow (sequential, one progress
 * indicator, one summary toast) rather than duplicating a second UX for it.
 */
async function _uploadAndInsertImages(files) {
  if (!canUploadFiles()) {
    UI.showToast(editBlockedReason() || 'File upload is disabled. Text-encrypted rooms do not allow new file uploads in v1.', 'warning');
    return;
  }
  const tooLarge = files.filter(f => f.size > 10 * 1024 * 1024);
  const toUpload = files.filter(f => f.size <= 10 * 1024 * 1024);
  if (tooLarge.length) {
    UI.showToast(
      tooLarge.length === files.length ? 'Image too large (max 10 MB).' : `${tooLarge.length} image${tooLarge.length !== 1 ? 's' : ''} skipped (max 10 MB).`,
      'error',
    );
  }
  if (!toUpload.length) return;

  UI.setUploadingState(true, toUpload.length > 1 ? `Uploading image 1 of ${toUpload.length}…` : 'Uploading image…');
  let succeeded = 0, failed = 0;
  for (let i = 0; i < toUpload.length; i++) {
    if (toUpload.length > 1) UI.setUploadingState(true, `Uploading image ${i + 1} of ${toUpload.length}…`);
    try {
      const record = await uploadFile(_roomId, toUpload[i]);
      UI.insertAtCursor(`![${record.filename}](syncpad-file:${record.file_path})\n`);
      succeeded++;
    } catch { failed++; }
  }
  UI.setUploadingState(false);

  if (succeeded) { broadcastFilesChange(); await refreshFiles(); }

  if (!failed) {
    UI.showToast(succeeded === 1 ? 'Image uploaded.' : `${succeeded} images uploaded.`, 'success');
  } else if (succeeded) {
    UI.showToast(`${succeeded} uploaded, ${failed} failed.`, 'error');
  } else {
    UI.showToast(failed === 1 ? 'Could not upload image.' : 'Could not upload images.', 'error');
  }
}

async function refreshFiles() {
  let files;
  try {
    files = _sortFiles(await listFiles(_roomId));
  } catch {
    UI.showToast('Could not load files — check your connection.', 'error');
    return;
  }
  UI.renderFilesList(
    files,
    async (file) => {
      try {
        const url = await getForceDownloadUrl(file.file_path, file.filename);
        const a   = document.createElement('a');
        a.href = url; a.download = file.filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      } catch { UI.showToast('Could not download file.', 'error'); }
    },
    async (file) => {
      if (!canDeleteFiles()) { UI.showToast(editBlockedReason() || 'File deletion is disabled.', 'warning'); return; }
      const ok = await UI.showConfirm(
        `Delete "${escapeHtml(file.filename)}"?`,
        { confirmLabel: 'Delete', danger: true },
      );
      if (!ok) return;
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
      canDownload: !_room?.downloads_disabled,
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
                const url = await getForceDownloadUrl(f.file_path, f.filename);
                const a   = document.createElement('a');
                a.href = url; a.download = f.filename;
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
              } catch { UI.showToast('Could not download file.', 'error'); }
            }
          );
        } catch { UI.showToast('Could not open preview.', 'error'); }
      },
      onCopyLink: async (file) => {
        try {
          // Always mint a fresh URL rather than reusing a cached one — a
          // cached entry can already be up to 55 minutes old, and this link
          // is meant to be shared and possibly opened later, not used
          // immediately like the Download button.
          const url = await getForceDownloadUrl(file.file_path, file.filename, { fresh: true });
          const ok  = await copyToClipboard(url);
          UI.showToast(
            ok ? `Link copied — valid ~55 min.` : 'Could not copy link.',
            ok ? 'success' : 'error',
          );
        } catch { UI.showToast('Could not create link.', 'error'); }
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

function _openTemplatesModalFresh() {
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
            if (count < 0) { UI.showToast('Invalid file - expected a JSON object of templates.', 'error'); return; }
            UI.showToast(`Imported ${count} template${count !== 1 ? 's' : ''}.`, 'success');
            UI.closeModal('templates-modal');
            setTimeout(_openTemplatesModalFresh, 150);
          };
          r.readAsText(f);
        };
        inp.click();
      },
    }
  );
}

function closeMoreDropdown() {
  document.getElementById('more-dropdown')?.classList.remove('open');
  document.getElementById('btn-more')?.setAttribute('aria-expanded', 'false');
}

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

// Exported HTML/PDF are standalone documents with no live JS to resolve
// syncpad-file: image references (see markdown.js/ui.js) the way the
// preview pane does — resolve each to an actual signed URL once, up front,
// and bake it in. An image whose file was since deleted (or fails to
// resolve for any reason) is left as-is: no `src`, alt text still shows.
const _resolveFileImageRefsForExport = async (html) => {
  const paths = [...new Set(Array.from(html.matchAll(/data-syncpad-file="([^"]+)"/g), (m) => m[1]))];
  if (!paths.length) return html;
  const urlByPath = new Map();
  await Promise.all(paths.map(async (path) => {
    try { urlByPath.set(path, await getDownloadUrl(path)); } catch { /* left unresolved */ }
  }));
  return html.replace(/<img data-syncpad-file="([^"]+)"([^>]*)>/g, (full, path, rest) => {
    const url = urlByPath.get(path);
    return url ? `<img src="${escapeHtml(url)}"${rest}>` : full;
  });
};

function _wireShortcuts() {
  initShortcuts({
    onTogglePreview:    () => {
      _applyMarkdownMode(_markdownMode === 'preview' ? 'write' : 'preview');
    },
    onToggleSplit: () => {
      _applyMarkdownMode(_markdownMode === 'split' ? 'write' : 'split');
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
    onCursorChat: () => _openCursorChatComposer(),
  });

}

function _wireEditorCore() {
  const editor = document.getElementById('note-editor');

  editor?.addEventListener('input', () => {
    if (!canEdit()) return;
    onLocalInput(); // returns a Promise — intentional fire-and-forget
    setTyping(true);
    UI.updateWordCount(UI.getEditorValue());
    UI.refreshFocusMode(); // no-op unless focus mode is on
    UI.refreshTypewriterMode(); // no-op unless typewriter mode is on
    // Mirror into the live-preview surface (no-op when unmounted, and when
    // the change originated there the text is identical so nothing happens).
    LiveEditor.syncFromText(UI.getEditorValue());
    // Debounced so large documents don't re-render markdown on every keystroke.
    _debouncedRefreshPreview();
  });
  editor?.addEventListener('blur', () => onEditorBlur());

  // ── Smart editor keyboard behaviour ────────────────────────────────────────
  editor?.addEventListener('keydown', (e) => {
    if (!canEdit() || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;

    // Tab / Shift+Tab — indent/dedent only when there is a multi-character selection
    // OR the cursor is at the start of a line with content (i.e. indenting makes sense).
    // For a plain Tab on an empty/cursor-only position outside a list, fall through so
    // the browser can move focus to the next element (keyboard accessibility).
    if (e.key === 'Tab') {
      const val   = editor.value;
      const start = editor.selectionStart;
      const end   = editor.selectionEnd;
      const hasSelection = start !== end;
      // Determine if the cursor line has non-whitespace content or is part of a list
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const lineText  = val.slice(lineStart, start + (end - start));
      const inList    = /^\s*[-*+]|\s*\d+\./.test(lineText);

      // Only intercept Tab if: there's a multi-char selection to indent, OR cursor is in a list.
      // Otherwise let Tab propagate so keyboard focus moves naturally.
      if (!hasSelection && !inList) return;

      e.preventDefault();
      if (hasSelection) {
        // Multi-line selection: indent or dedent each line
        const lStart = val.lastIndexOf('\n', start - 1) + 1;
        const lEnd   = (() => { const n = val.indexOf('\n', end - 1); return n === -1 ? val.length : n; })();
        const block  = val.slice(lStart, lEnd);
        const newBlock = e.shiftKey
          ? block.split('\n').map((l) => l.startsWith('  ') ? l.slice(2) : l.startsWith(' ') ? l.slice(1) : l).join('\n')
          : block.split('\n').map((l) => '  ' + l).join('\n');
        editor.value = val.slice(0, lStart) + newBlock + val.slice(lEnd);
        editor.selectionStart = lStart;
        editor.selectionEnd   = lStart + newBlock.length;
      } else {
        // In a list: insert 2 spaces at caret
        editor.value = val.slice(0, start) + '  ' + val.slice(end);
        editor.selectionStart = editor.selectionEnd = start + 2;
      }
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // Enter — auto-continue list items
    if (e.key === 'Enter') {
      const val = editor.value;
      const pos = editor.selectionStart;
      if (editor.selectionStart !== editor.selectionEnd) return; // has selection
      const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
      const lineText  = val.slice(lineStart, pos);

      const ulMatch = lineText.match(/^([ \t]*)([-*+]) /);
      const olMatch = lineText.match(/^([ \t]*)(\d+)\. /);
      const match   = ulMatch || olMatch;
      if (!match) return;

      const content = lineText.slice(match[0].length);
      e.preventDefault();
      if (!content.trim()) {
        // Empty item — break out of the list
        editor.value = val.slice(0, lineStart) + '\n' + val.slice(pos);
        editor.selectionStart = editor.selectionEnd = lineStart + 1;
      } else {
        // Continue the list with the next item
        const nextPrefix = olMatch
          ? `${olMatch[1]}${parseInt(olMatch[2], 10) + 1}. `
          : `${match[1]}${match[2]} `;
        const insertion = '\n' + nextPrefix;
        editor.value = val.slice(0, pos) + insertion + val.slice(editor.selectionEnd);
        editor.selectionStart = editor.selectionEnd = pos + insertion.length;
      }
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // Smart punctuation (opt-in, off by default) — curly quotes, en/em
    // dashes, and an ellipsis character, converted as you type. Checked
    // before plain auto-pair below so a "smart" double quote wins over the
    // straight-quote pairing when the preference is on.
    if (_smartPunct) {
      const start = editor.selectionStart;
      const end   = editor.selectionEnd;
      const OPENING_CONTEXT = /[\s([{‘“]/; // whitespace, start of doc, or another opening bracket/quote

      if (e.key === '"' && start === end) {
        e.preventDefault();
        // Close/skip over a quote (either style) already sitting at the cursor.
        if (editor.value[start] === '”' || editor.value[start] === '"') {
          editor.selectionStart = editor.selectionEnd = start + 1;
          return;
        }
        const before = editor.value[start - 1];
        const opening = before === undefined || OPENING_CONTEXT.test(before);
        const insert = opening ? '“”' : '”';
        editor.value = editor.value.slice(0, start) + insert + editor.value.slice(start);
        editor.selectionStart = editor.selectionEnd = start + 1; // right after the opening quote either way
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }

      if (e.key === "'" && start === end) {
        // No pairing for the single quote — it's an apostrophe far more
        // often than it's a quotation mark (don't, it's, '90s), so only its
        // direction (opening ' vs. closing/apostrophe ') is decided here.
        e.preventDefault();
        const before = editor.value[start - 1];
        const opening = before === undefined || OPENING_CONTEXT.test(before);
        editor.value = editor.value.slice(0, start) + (opening ? '‘' : '’') + editor.value.slice(start);
        editor.selectionStart = editor.selectionEnd = start + 1;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }

      if (e.key === '-' && start === end) {
        const prev = editor.value[start - 1];
        if (prev === '–' || prev === '-') {
          e.preventDefault();
          editor.value = editor.value.slice(0, start - 1) + (prev === '-' ? '–' : '—') + editor.value.slice(start);
          editor.selectionStart = editor.selectionEnd = start;
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
        // A single hyphen with nothing to combine with — let it type normally.
      }

      if (e.key === '.' && start === end && editor.value.slice(start - 2, start) === '..') {
        e.preventDefault();
        editor.value = editor.value.slice(0, start - 2) + '…' + editor.value.slice(start);
        editor.selectionStart = editor.selectionEnd = start - 1;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    }

    // Auto-pair ( [ ` " — the unambiguous set only. Markdown's *, _ are
    // deliberately excluded: they're used both singly (italic) and doubled
    // (bold), so "does typing * open or close a pair" has no single correct
    // answer the way it does for parens/brackets/backtick/quote.
    const AUTOPAIR_OPEN_TO_CLOSE = { '(': ')', '[': ']', '`': '`', '"': '"' };
    if (Object.prototype.hasOwnProperty.call(AUTOPAIR_OPEN_TO_CLOSE, e.key)) {
      const start = editor.selectionStart;
      const end   = editor.selectionEnd;
      const closeChar = AUTOPAIR_OPEN_TO_CLOSE[e.key];

      if (start !== end) {
        // Wrap the selection instead of replacing it, and keep the original
        // text selected — matches the toolbar's bold/italic/link wrapping.
        e.preventDefault();
        const selected = editor.value.slice(start, end);
        editor.value = editor.value.slice(0, start) + e.key + selected + closeChar + editor.value.slice(end);
        editor.selectionStart = start + 1;
        editor.selectionEnd   = start + 1 + selected.length;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }

      // ` and " are symmetric — the same character both opens and closes a
      // pair. Typing one immediately before its own kind already sitting at
      // the cursor means "close/skip over", not "open a new nested pair".
      if ((e.key === '`' || e.key === '"') && editor.value[start] === e.key) {
        e.preventDefault();
        editor.selectionStart = editor.selectionEnd = start + 1;
        return;
      }

      e.preventDefault();
      editor.value = editor.value.slice(0, start) + e.key + closeChar + editor.value.slice(start);
      editor.selectionStart = editor.selectionEnd = start + 1;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // ) and ] are only ever closers — skip over one already at the cursor
    // rather than typing a second, redundant one right next to it.
    if ((e.key === ')' || e.key === ']') && editor.selectionStart === editor.selectionEnd && editor.value[editor.selectionStart] === e.key) {
      e.preventDefault();
      editor.selectionStart = editor.selectionEnd = editor.selectionStart + 1;
      return;
    }

    // Backspace right in the middle of an empty auto-inserted pair (e.g. the
    // cursor sitting between "(" and ")" with nothing typed in between yet)
    // removes both characters, not just the opener — otherwise every
    // auto-paired closer left behind has to be deleted separately by hand.
    if (e.key === 'Backspace' && editor.selectionStart === editor.selectionEnd && editor.selectionStart > 0) {
      const pos  = editor.selectionStart;
      const prev = editor.value[pos - 1];
      const next = editor.value[pos];
      if (AUTOPAIR_OPEN_TO_CLOSE[prev] === next) {
        e.preventDefault();
        editor.value = editor.value.slice(0, pos - 1) + editor.value.slice(pos + 1);
        editor.selectionStart = editor.selectionEnd = pos - 1;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    }
  });

}

function _wireEditorToolbarAndLifecycle() {
  const editor = document.getElementById('note-editor');

  // ── Markdown toolbar ────────────────────────────────────────────────────────
  document.getElementById('md-toolbar')?.addEventListener('mousedown', (e) => {
    // mousedown (not click) so we can preventDefault before the editor loses focus
    const btn = e.target.closest('[data-md-action]');
    if (!btn) return;
    e.preventDefault(); // keep editor focus
    if (!canEdit()) return;
    // Preview mode: the textarea is hidden, so the live surface is the only
    // real target. Split mode: act on whichever pane currently has focus,
    // textarea by default (matches the toolbar's pre-live-surface behaviour).
    const useLive = LiveEditor.isMounted() && (_markdownMode === 'preview' || LiveEditor.hasFocus());
    if (useLive) {
      _applyMarkdownFormat(btn.dataset.mdAction, LiveEditor.asEditorProxy());
    } else if (editor) {
      _applyMarkdownFormat(btn.dataset.mdAction, editor);
    }
  });

  // Broadcast cursor line on selection/click (throttled in presence.js at 800ms).
  // selectionEnd is reported as the "head" (matches CM6's convention, and is
  // where the caret itself renders for a forward selection) with
  // selectionStart as the anchor — so a Write-mode user's selected range
  // shows up as a highlighted span for collaborators viewing in Preview/Split,
  // not just a caret.
  const _broadcastCursor = () => {
    if (!editor) return;
    const pos    = editor.selectionEnd;
    const before = editor.value.substring(0, pos);
    const line   = (before.match(/\n/g) || []).length + 1;
    setCursorLine(line, pos, editor.selectionStart);
    UI.refreshFocusMode(); // no-op unless focus mode is on
    UI.refreshTypewriterMode(); // no-op unless typewriter mode is on
  };
  editor?.addEventListener('keyup',    _broadcastCursor);
  editor?.addEventListener('mouseup',  _broadcastCursor);
  editor?.addEventListener('touchend', _broadcastCursor);

  // Focus mode's dimmed band tracks the caret's pixel position, which shifts
  // under scrolling (same line, different viewport offset) and under
  // resizing (text re-wraps at a different width, changing the caret's line).
  // Typewriter mode only re-centers on resize, not on scroll — re-centering
  // on every scroll event would fight the user's own manual scrolling.
  editor?.addEventListener('scroll', () => UI.refreshFocusMode());
  window.addEventListener('resize', () => {
    UI.refreshFocusMode();
    UI.refreshTypewriterMode();
  });

  // Block paste keystrokes when the editor is locked. The textarea readonly
  // attribute does the heavy lifting; this is belt-and-suspenders.
  editor?.addEventListener('paste', (e) => {
    if (!canPaste()) { e.preventDefault(); return; }
    const items = Array.from(e.clipboardData?.items || []);
    const imageFiles = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (!imageFiles.length) return;
    e.preventDefault();
    // Stop the paste-sanitization listener below from also handling this
    // event — clipboard image paste carries no meaningful text/plain to strip.
    e.stopImmediatePropagation();
    _uploadAndInsertImages(imageFiles);
  });
  editor?.addEventListener('dragover', (e) => {
    if (!canEdit()) return;
    if (Array.from(e.dataTransfer?.items || []).some((it) => it.kind === 'file')) e.preventDefault();
  });
  editor?.addEventListener('drop', (e) => {
    if (!canEdit()) { e.preventDefault(); return; }
    const imageFiles = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
    if (!imageFiles.length) return;
    e.preventDefault();
    _uploadAndInsertImages(imageFiles);
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

}

function _wireHeader() {
  // ── Header ─────────────────────────────────────────────────────────────────
  document.getElementById('btn-tools')?.addEventListener('click', () => { closeMoreDropdown(); UI.togglePanel('tools-panel'); });
  document.getElementById('btn-files')?.addEventListener('click', () => { closeMoreDropdown(); UI.togglePanel('files-panel'); });
  document.getElementById('btn-presence')?.addEventListener('click', () => { closeMoreDropdown(); UI.togglePanel('presence-panel'); });
  document.getElementById('btn-settings')?.addEventListener('click', () => { closeMoreDropdown(); UI.togglePanel('settings-panel'); });
  document.getElementById('btn-about')?.addEventListener('click', () => { closeMoreDropdown(); UI.openModal('about-modal'); });
  // A-3: device-count-badge — keyboard accessibility (role="button" set in HTML)
  const deviceCountBtn = document.getElementById('device-count-btn');
  deviceCountBtn?.addEventListener('click', () => UI.togglePanel('presence-panel'));
  deviceCountBtn?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); UI.togglePanel('presence-panel'); }
  });

  // More dropdown toggle
  const moreBtn      = document.getElementById('btn-more');
  const moreDropdown = document.getElementById('more-dropdown');
  moreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = moreDropdown?.classList.toggle('open');
    moreBtn.setAttribute('aria-expanded', String(!!open));
    // A-4: move focus to the first menu item when the dropdown opens.
    if (open) {
      const firstItem = moreDropdown?.querySelector('[role="menuitem"]');
      requestAnimationFrame(() => firstItem?.focus());
    }
  });
  // A-4: Arrow-key navigation and Escape within the more-dropdown.
  moreDropdown?.addEventListener('keydown', (e) => {
    const items = [...(moreDropdown.querySelectorAll('[role="menuitem"]'))];
    const idx   = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMoreDropdown();
      moreBtn?.focus();
    } else if (e.key === 'Tab') {
      // Close the dropdown when tabbing out of it.
      closeMoreDropdown();
    }
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

}

function _wireSegmentedMarkdownControl() {
  // ── Segmented markdown control ─────────────────────────────────────────────
  document.querySelectorAll('.md-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (!mode) return;
      _applyMarkdownMode(mode);
    });
  });

}

function _wireMobileActionBar() {
  // ── Mobile action bar ──────────────────────────────────────────────────────
  document.getElementById('mob-btn-share')?.addEventListener('click', () => {
    _openShareModal();
  });
  document.getElementById('mob-btn-files')?.addEventListener('click',    () => UI.togglePanel('files-panel'));
  document.getElementById('mob-btn-tools')?.addEventListener('click',    () => UI.togglePanel('tools-panel'));
  document.getElementById('mob-btn-presence')?.addEventListener('click', () => UI.togglePanel('presence-panel'));
  document.getElementById('mob-btn-settings')?.addEventListener('click', () => UI.togglePanel('settings-panel'));

}

function _wireFooterQuickButtons() {
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

  document.getElementById('btn-cursor-chat')?.addEventListener('click', () => _openCursorChatComposer());

}

function _wirePanelsAndModals() {
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


}

function _wireTools() {
  const editor = document.getElementById('note-editor');

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

    'tool-clear': async () => {
      if (!canClearNote()) { UI.showToast(editBlockedReason() || 'Clear is disabled.', 'warning'); return; }
      if (!await UI.showConfirm('Clear the note for everyone? This cannot be undone.', { confirmLabel: 'Clear', danger: true })) return;
      doClearNote();
    },

    'tool-download': () => {
      // Export as Markdown (.md). Content is plain text / Markdown.
      _downloadBlob(UI.getEditorValue(), `${_roomId}.md`, 'text/markdown');
      UI.showToast('Downloaded .md', 'success');
    },

    'tool-import': () => {
      if (!canImportText()) { UI.showToast(editBlockedReason() || 'Import is disabled.', 'warning'); return; }
      const inp = Object.assign(document.createElement('input'), {
        type: 'file', accept: '.txt,.md,text/plain,text/markdown',
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
    'tool-find':       () => { UI.openPanel('search-panel'); document.getElementById('search-input')?.focus(); },
    'tool-templates': () => {
      if (!canUseTemplates()) { UI.showToast(editBlockedReason() || 'Templates are disabled.', 'warning'); return; }
      _openTemplatesModalFresh();
    },
  };

  Object.entries(toolActions).forEach(([id, fn]) => {
    document.getElementById(id)?.addEventListener('click', () => { fn(); UI.closeAllPanels(); });
  });

  // Wired outside toolActions: it opens a side panel (like tool-find should),
  // and toolActions' blanket closeAllPanels() after every action would close
  // that panel again immediately.
  document.getElementById('tool-history')?.addEventListener('click', () => { _openHistoryPanel(); });

}

function _wireFiles() {
  // ── Files ──────────────────────────────────────────────────────────────────
  UI.setFileHandlers(async (files) => {
    if (!canUploadFiles()) { UI.showToast(editBlockedReason() || 'File upload is disabled. Text-encrypted rooms do not allow new file uploads in v1.', 'warning'); return; }

    const tooLarge = files.filter(f => f.size > 10 * 1024 * 1024);
    const toUpload = files.filter(f => f.size <= 10 * 1024 * 1024);
    if (tooLarge.length) {
      UI.showToast(
        tooLarge.length === files.length
          ? 'File too large (max 10 MB).'
          : `${tooLarge.length} file${tooLarge.length !== 1 ? 's' : ''} skipped (max 10 MB).`,
        'error',
      );
    }
    if (!toUpload.length) return;

    UI.setUploadingState(true, toUpload.length > 1 ? `Uploading 1 of ${toUpload.length}…` : 'Uploading…');
    let succeeded = 0, failed = 0;
    // Sequential (not Promise.all) so the progress indicator can report which
    // file is in flight, and so a slow/failing upload doesn't race storage
    // writes for the same room against each other.
    for (let i = 0; i < toUpload.length; i++) {
      if (toUpload.length > 1) UI.setUploadingState(true, `Uploading ${i + 1} of ${toUpload.length}…`);
      try {
        await uploadFile(_roomId, toUpload[i]);
        succeeded++;
      } catch { failed++; }
    }
    UI.setUploadingState(false);

    if (succeeded) { broadcastFilesChange(); await refreshFiles(); }

    if (!failed) {
      UI.showToast(succeeded === 1 ? 'File uploaded.' : `${succeeded} files uploaded.`, 'success');
    } else if (succeeded) {
      UI.showToast(`${succeeded} uploaded, ${failed} failed.`, 'error');
    } else {
      UI.showToast(failed === 1 ? 'Could not upload file.' : 'Could not upload files.', 'error');
    }
  });

}

function _wireFilesSortOrder() {
  // ── Files — sort order ────────────────────────────────────────────────────
  document.getElementById('files-sort')?.addEventListener('change', (e) => {
    _filesSort = e.target.value;
    refreshFiles();
  });

}

function _wireFilesBulkSelect() {
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
    let allFiles;
    try { allFiles = await listFiles(_roomId); }
    catch { UI.showToast('Could not load files — check your connection.', 'error'); return; }
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

}

function _wireSettings() {
  // ── Settings ───────────────────────────────────────────────────────────────
  document.getElementById('setting-passcode-btn')?.addEventListener('click', async () => {
    if (!canChangeSettings()) { UI.showToast(editBlockedReason() || 'Settings are disabled.', 'warning'); return; }
    if (_room.passcode_hash) {
      if (!await UI.showConfirm('Remove the room passcode?', { confirmLabel: 'Remove', danger: true })) return;
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
      const pc = await UI.showPrompt('Set a new passcode:', { placeholder: 'Passcode…', confirmLabel: 'Set passcode' });
      if (!pc?.trim()) return;
      try {
        await setPasscode(_roomId, pc);
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
      if (!await UI.showConfirm('Disable encryption? Content will be stored in plaintext.', { confirmLabel: 'Disable', danger: true })) return;
      await flushSave();
      cancelPendingTypingBroadcast();
      cancelPendingLiveContentBroadcast();
      const pp = await UI.showPrompt('Enter the current passphrase to confirm:', { placeholder: 'Passphrase…', confirmLabel: 'Confirm' });
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
      let existingFiles;
      try { existingFiles = await listFiles(_roomId); }
      catch { existingFiles = []; } // non-critical — just skip the warning if file list fails
      if (existingFiles.length && !await UI.showConfirm('This room has file attachments. SyncPad v1 encrypts note text only — files are not encrypted. Continue?', { confirmLabel: 'Continue' })) return;
      const pp = await UI.showPrompt('Set an encryption passphrase:', { placeholder: 'Passphrase…', confirmLabel: 'Enable encryption' });
      if (!pp?.trim()) return;
      // PBKDF2 key derivation takes 1-3 s — indicate progress on the button.
      if (encBtn) { encBtn.disabled = true; encBtn.textContent = 'Encrypting…'; }
      try {
        const { salt, key } = await enableEncryption(_roomId, UI.getEditorValue(), pp);
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
  document.querySelectorAll('[data-exp-preset]').forEach((el) => el.addEventListener('click', () => _selectExpirationPreset(el.dataset.expPreset || '10m')));
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
  _selectExpirationPreset('10m');

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

  document.getElementById('setting-dl-btn')?.addEventListener('click', async () => {
    if (!canChangeSettings()) { UI.showToast(editBlockedReason() || 'Settings are disabled.', 'warning'); return; }
    try {
      if (_room.device_limit) {
        await clearDeviceLimit(_roomId);
        UI.showToast('Device limit removed.', 'success');
      } else {
        const input = document.getElementById('setting-dl-input');
        const n = Math.round(Number(input?.value));
        if (!Number.isFinite(n) || n < 1 || n > 50) {
          UI.showToast('Enter a device limit between 1 and 50.', 'warning');
          return;
        }
        await setDeviceLimit(_roomId, n);
        UI.showToast(`Device limit set. The note clears once ${n} device${n === 1 ? '' : 's'} have joined.`, 'success', 5000);
      }
      _room = await loadRoom(_roomId);
      _renderRoomHeader();
      UI.renderSettingsPanel(_room);
      broadcastSettingsChange();
    } catch { UI.showToast('Could not update device limit. Has docs/migrations/device-limit.sql been run?', 'error', 5000); }
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

}

function _wireExportModal() {
  // ── Export modal ───────────────────────────────────────────────────────────
  document.getElementById('btn-export')?.addEventListener('click', () => {
    closeMoreDropdown();
    UI.openModal('export-modal');
  });
  document.getElementById('export-modal-close')?.addEventListener('click', () => UI.closeModal('export-modal'));

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
  document.getElementById('export-html')?.addEventListener('click', async () => {
    if (!_requireContent()) return;
    const { html: bodyHtml, headings } = renderMarkdownWithToc(UI.getEditorValue());
    const resolvedBody = await _resolveFileImageRefsForExport(bodyHtml);
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SyncPad – ${escapeHtml(_roomId)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.7}
pre{background:#f5f5f5;padding:1em;border-radius:4px;overflow:auto}code{background:#f5f5f5;padding:2px 4px;border-radius:2px}
blockquote{border-left:3px solid #ccc;margin:0;padding-left:1em;color:#666}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}</style>
</head><body>${renderTocHtml(headings)}${resolvedBody}</body></html>`;
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
    const resolvedHtml = await _resolveFileImageRefsForExport(renderMarkdown(UI.getEditorValue()));
    const ok = await copyToClipboard(resolvedHtml);
    if (ok) UI.showToast('Copied as HTML.', 'success');
    else    UI.showToast('Could not copy.', 'error');
  });
  document.getElementById('export-pdf')?.addEventListener('click', async () => {
    if (!_requireContent()) return;
    // window.open() must happen synchronously within the click handler, before
    // any await — browsers only allow it without a popup-blocker prompt when
    // it's the direct, unbroken result of a user gesture.
    const win = window.open('', '_blank');
    if (!win) { UI.showToast('Pop-up blocked — allow pop-ups and try again.', 'warning'); return; }
    const content = UI.getEditorValue();
    const { html: renderedHtml, headings } = renderMarkdownWithToc(content);
    const resolvedHtml = await _resolveFileImageRefsForExport(renderedHtml);
    const title = escapeHtml(_room?.room_name?.trim() || _roomId);
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
</head><body>${renderTocHtml(headings)}${resolvedHtml}</body></html>`);
    win.document.close();
    win.print();
  });

}

function _wireKeyboardShortcutsModal() {
  // ── Keyboard shortcuts modal ───────────────────────────────────────────────
  document.getElementById('btn-shortcuts')?.addEventListener('click', () => {
    closeMoreDropdown();
    UI.openModal('shortcuts-modal');
  });
  document.getElementById('shortcuts-modal-close')?.addEventListener('click', () => UI.closeModal('shortcuts-modal'));

}

function _wireSaveAsTemplate() {
  // ── Save as template ───────────────────────────────────────────────────────
  document.getElementById('btn-save-as-template')?.addEventListener('click', async () => {
    const body = UI.getEditorValue().trim();
    if (!body) { UI.showToast('The note is empty — nothing to save as a template.', 'warning'); return; }
    const label = await UI.showPrompt('Template name:', { defaultValue: 'My template', confirmLabel: 'Save' });
    if (!label?.trim()) return;
    try {
      const { truncated } = saveCustomTemplate(label.trim(), body);
      UI.showToast(
        truncated
          ? `Saved as template "${label.trim()}" (body capped at 50 KB).`
          : `Saved as template "${label.trim()}".`,
        'success',
      );
      if (document.getElementById('templates-modal')?.classList.contains('visible')) {
        UI.closeModal('templates-modal');
        setTimeout(_openTemplatesModalFresh, 150);
      }
    } catch (err) {
      if (err?.code === 'QUOTA_EXCEEDED') { UI.showToast('Browser storage is full — template could not be saved.', 'error'); return; }
      UI.showToast('Could not save template.', 'error');
    }
  });

}

function _wireFindReplacePanel() {
  const editor = document.getElementById('note-editor');

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
    } else if (searchCount) {
      searchCount.textContent = 'No results';
    }
    _syncReplaceButtons();
  };

  const _jumpToMatch = (idx, { keepFocus = false } = {}) => {
    if (!editor || !_searchMatches.length) return;
    const m = _searchMatches[idx];
    if (!m) return;
    // Switch to write mode if in preview
    if (_markdownMode !== 'write' && _markdownMode !== 'split') {
      _applyMarkdownMode('write');
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

}

function _wirePasteSanitization() {
  const editor = document.getElementById('note-editor');

  // ── Paste sanitization ─────────────────────────────────────────────────────
  // Strip HTML/RTF formatting on paste when the user preference is enabled.
  // We intercept the paste event on the editor and substitute plain-text only.
  editor?.addEventListener('paste', (e) => {
    if (!_stripPaste) return;
    // Must not mutate the editor when editing is blocked (read-only, locked,
    // encrypted without a key) — the other paste listener above only calls
    // preventDefault() for the native paste, which does not stop this
    // separate listener on the same event from still running.
    if (!canPaste()) return;
    const plain = e.clipboardData?.getData('text/plain');
    if (plain === undefined) return;
    e.preventDefault();
    const start   = editor.selectionStart;
    const end     = editor.selectionEnd;
    editor.value  = editor.value.slice(0, start) + plain + editor.value.slice(end);
    editor.setSelectionRange(start + plain.length, start + plain.length);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });

}

function _wireEditorPreferenceToggles() {
  // ── Monospace setting button (Settings panel) ──────────────────────────────
  const _updateMonospaceSettingUI = () => {
    const btn = document.getElementById('setting-monospace-btn');
    if (!btn) return;
    btn.textContent = _monospace ? 'On' : 'Off';
    btn.setAttribute('aria-pressed', String(_monospace));
  };
  _updateMonospaceSettingUI();

  document.getElementById('setting-monospace-btn')?.addEventListener('click', () => {
    _toggleMonospace();
    _updateMonospaceSettingUI();
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

  // ── Smart-punctuation setting button ───────────────────────────────────────
  const _updateSmartPunctUI = () => {
    const btn = document.getElementById('setting-smart-punct-btn');
    if (!btn) return;
    btn.textContent = _smartPunct ? 'On' : 'Off';
    btn.setAttribute('aria-pressed', String(_smartPunct));
  };
  _updateSmartPunctUI();

  document.getElementById('setting-smart-punct-btn')?.addEventListener('click', () => {
    _smartPunct = !_smartPunct;
    try { localStorage.setItem(_SMART_PUNCT_KEY, String(_smartPunct)); } catch {}
    _updateSmartPunctUI();
    UI.showToast(
      _smartPunct ? 'Smart punctuation: On' : 'Smart punctuation: Off',
      'info', 2000
    );
  });

  // ── Focus-mode setting button ───────────────────────────────────────────────
  const _updateFocusModeUI = () => {
    const btn = document.getElementById('setting-focus-mode-btn');
    if (!btn) return;
    btn.textContent = _focusMode ? 'On' : 'Off';
    btn.setAttribute('aria-pressed', String(_focusMode));
  };
  _updateFocusModeUI();

  document.getElementById('setting-focus-mode-btn')?.addEventListener('click', () => {
    _focusMode = !_focusMode;
    try { localStorage.setItem(_FOCUS_MODE_KEY, String(_focusMode)); } catch {}
    UI.setFocusMode(_focusMode);
    _updateFocusModeUI();
    UI.showToast(_focusMode ? 'Focus mode: On' : 'Focus mode: Off', 'info', 2000);
  });

  // ── Typewriter-mode setting button ───────────────────────────────────────────
  const _updateTypewriterModeUI = () => {
    const btn = document.getElementById('setting-typewriter-mode-btn');
    if (!btn) return;
    btn.textContent = _typewriterMode ? 'On' : 'Off';
    btn.setAttribute('aria-pressed', String(_typewriterMode));
  };
  _updateTypewriterModeUI();

  document.getElementById('setting-typewriter-mode-btn')?.addEventListener('click', () => {
    _typewriterMode = !_typewriterMode;
    try { localStorage.setItem(_TYPEWRITER_MODE_KEY, String(_typewriterMode)); } catch {}
    UI.setTypewriterMode(_typewriterMode);
    _updateTypewriterModeUI();
    UI.showToast(_typewriterMode ? 'Typewriter mode: On' : 'Typewriter mode: Off', 'info', 2000);
  });

  // ── Hide-my-cursor-&-typing setting button ──────────────────────────────────
  const _updateHidePresenceUI = () => {
    const btn = document.getElementById('setting-hide-presence-btn');
    if (!btn) return;
    btn.textContent = _hidePresence ? 'On' : 'Off';
    btn.setAttribute('aria-pressed', String(_hidePresence));
  };
  _updateHidePresenceUI();

  document.getElementById('setting-hide-presence-btn')?.addEventListener('click', () => {
    _hidePresence = !_hidePresence;
    try { localStorage.setItem(_HIDE_PRESENCE_KEY, String(_hidePresence)); } catch {}
    setPresenceHidden(_hidePresence);
    _updateHidePresenceUI();
    UI.showToast(_hidePresence ? 'Cursor & typing hidden from others' : 'Cursor & typing visible to others', 'info', 2000);
  });

}

function wireEvents() {
  // Shortcuts are always re-wired: they were destroyed in teardownRealtimeSession()
  // and their callbacks reference module-level state, not captured room locals.
  _wireShortcuts();

  // All DOM element listeners below are one-time-only. On multi-room navigation
  // shortcuts are re-wired above, but these must not accumulate.
  if (_eventsWired) return;
  _eventsWired = true;

  _wireEditorCore();
  _wireEditorToolbarAndLifecycle();
  _wireHeader();
  _wireSegmentedMarkdownControl();
  _wireMobileActionBar();
  _wireFooterQuickButtons();
  _wirePanelsAndModals();
  _wireTools();
  _wireFiles();
  _wireFilesSortOrder();
  _wireFilesBulkSelect();
  _wireSettings();
  _wireExportModal();
  _wireKeyboardShortcutsModal();
  _wireSaveAsTemplate();
  _wireFindReplacePanel();
  _wirePasteSanitization();
  _wireEditorPreferenceToggles();
}

// ── Editor preference helpers ─────────────────────────────────────────────────
function _toggleMonospace() {
  _monospace = !_monospace;
  UI.setMonospace(_monospace);
  try { localStorage.setItem('syncpad_monospace', _monospace ? '1' : '0'); } catch {}
  UI.showToast(_monospace ? 'Monospace on.' : 'Monospace off.', 'info', 1800);
}

// ── Markdown format helpers ───────────────────────────────────────────────────
/**
 * Apply a formatting action to the editor textarea.
 * Called by the toolbar (mousedown) and can be reused by other code.
 * @param {string} action  – matches data-md-action attribute
 * @param {HTMLTextAreaElement} editor
 */
function _applyMarkdownFormat(action, editor) {
  if (!editor) return;
  const val   = editor.value;
  const start = editor.selectionStart;
  const end   = editor.selectionEnd;
  const sel   = val.slice(start, end);

  // Wrap selection (or "text" placeholder) with prefix/suffix markers.
  // Toggles off if already wrapped.
  const wrapSel = (prefix, suffix = prefix) => {
    // Unwrap only when there is at least one inner character (length strictly greater
    // than prefix+suffix combined) so selecting exactly '``' or '**' doesn't delete content.
    if (sel.startsWith(prefix) && sel.endsWith(suffix) && sel.length > prefix.length + suffix.length) {
      const inner = sel.slice(prefix.length, sel.length - suffix.length);
      editor.value = val.slice(0, start) + inner + val.slice(end);
      editor.selectionStart = start;
      editor.selectionEnd   = start + inner.length;
    } else {
      const inner = sel || 'text';
      editor.value = val.slice(0, start) + prefix + inner + suffix + val.slice(end);
      editor.selectionStart = start + prefix.length;
      editor.selectionEnd   = start + prefix.length + inner.length;
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // Toggle a line-level prefix on every line touched by the selection.
  const toggleLinePrefix = (prefix) => {
    const lStart = val.lastIndexOf('\n', start - 1) + 1;
    const eolPos = end > start ? end - 1 : end;
    const lEnd   = (() => { const n = val.indexOf('\n', eolPos); return n === -1 ? val.length : n; })();
    const block  = val.slice(lStart, lEnd);
    const lines2 = block.split('\n');
    const allHave = lines2.every((l) => l.startsWith(prefix));
    const newBlock = allHave
      ? lines2.map((l) => l.slice(prefix.length)).join('\n')
      : lines2.map((l) => prefix + l).join('\n');
    editor.value = val.slice(0, lStart) + newBlock + val.slice(lEnd);
    editor.selectionStart = lStart;
    editor.selectionEnd   = lStart + newBlock.length;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // Toggle an ATX heading on the current line (strips any existing # prefix first).
  const toggleHeading = (level) => {
    const prefix = '#'.repeat(level) + ' ';
    const lStart = val.lastIndexOf('\n', start - 1) + 1;
    const lEnd   = (() => { const n = val.indexOf('\n', start); return n === -1 ? val.length : n; })();
    const line   = val.slice(lStart, lEnd);
    const stripped = line.replace(/^#{1,6} /, '');
    const newLine  = line.startsWith(prefix) ? stripped : prefix + stripped;
    editor.value = val.slice(0, lStart) + newLine + val.slice(lEnd);
    editor.selectionStart = lStart;
    editor.selectionEnd   = lStart + newLine.length;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  };

  switch (action) {
    case 'bold':          wrapSel('**', '**'); break;
    case 'italic':        wrapSel('_',  '_');  break;
    case 'strikethrough': wrapSel('~~', '~~'); break;
    case 'highlight':     wrapSel('==', '=='); break;
    case 'code':          wrapSel('`',  '`');  break;
    case 'h1':            toggleHeading(1);    break;
    case 'h2':            toggleHeading(2);    break;
    case 'h3':            toggleHeading(3);    break;
    case 'quote':         toggleLinePrefix('> '); break;
    case 'ul':            toggleLinePrefix('- '); break;
    case 'ol':            toggleLinePrefix('1. '); break;
    case 'link': {
      const insert = sel ? `[${sel}](url)` : '[link text](url)';
      editor.value = val.slice(0, start) + insert + val.slice(end);
      const urlStart = start + insert.indexOf('url');
      editor.selectionStart = urlStart;
      editor.selectionEnd   = urlStart + 3;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      break;
    }
    case 'codeblock': {
      const before = start > 0 && val[start - 1] !== '\n' ? '\n' : '';
      const after  = end < val.length && val[end] !== '\n' ? '\n' : '';
      const inner  = sel || 'code here';
      const insert = `${before}\`\`\`\n${inner}\n\`\`\`${after}`;
      editor.value = val.slice(0, start) + insert + val.slice(end);
      editor.selectionStart = start + before.length + 4;
      editor.selectionEnd   = start + before.length + 4 + inner.length;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      break;
    }
    case 'hr': {
      const before = start > 0 && val[start - 1] !== '\n' ? '\n' : '';
      const ins = `${before}---\n`;
      editor.value = val.slice(0, start) + ins + val.slice(end);
      editor.selectionStart = editor.selectionEnd = start + ins.length;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      break;
    }
    case 'toc': {
      const before = start > 0 && val[start - 1] !== '\n' ? '\n' : '';
      const after  = end < val.length && val[end] !== '\n' ? '\n' : '';
      const ins = `${before}[TOC]\n${after}`;
      editor.value = val.slice(0, start) + ins + val.slice(end);
      editor.selectionStart = editor.selectionEnd = start + ins.length;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      break;
    }
  }
}

function teardownRealtimeSession() {
  try { _unsubRoom?.(); } catch {}
  try { _unsubFiles?.(); } catch {}
  _unsubRoom = null;
  _unsubFiles = null;
  destroyPresence();
  destroyBroadcast();
  destroySync();
  UI.clearCursorChat();
  _followedDeviceId = null;
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
  // Remove the online/offline listener registered in startApp(). Without this
  // each room navigation accumulates a new listener on window, causing duplicate
  // flushSave calls and stale status updates after re-connecting.
  _onlineCleanup?.();
  _onlineCleanup = null;
  // Reset encryption keys so a key from an encrypted room is never used to
  // silently encrypt saves in a subsequent non-encrypted room.
  _encKey  = null;
  _encSalt = null;
  // Reset editor mode so the next room always starts in plain-write view
  // rather than inheriting preview / split mode from the previous room.
  // setMarkdownMode() cleans up DOM mode classes immediately (mode-split, etc.)
  // so the card layout doesn't show a stale divider during the loading screen.
  _markdownMode = 'write';
  _showPreview  = false;
  UI.setMarkdownMode('write', null);
  // Tear down the live-preview surface so the next room mounts fresh rather
  // than briefly showing this room's content.
  LiveEditor.destroy();
  // Reset expiration preset — both the variable AND the settings-panel DOM
  // (preset button highlighting, custom-row visibility) — so a room where
  // "Custom" was selected doesn't leave the panel visually showing Custom
  // with its inputs open in the next room even though _expPreset is back to
  // the default.
  _selectExpirationPreset('10m');
  // Exit bulk-select mode so the next room starts with a clean files panel.
  _filesSelectMode = false;
  _selectedFiles   = new Set();
  document.getElementById('files-bulk-bar')?.classList.add('hidden');
  document.getElementById('files-select-toggle')?.classList.remove('active');
  // Reset view-once consumption guard. If this flag is left true from a previous
  // room, the next room's handleRoomRealtime handler will silently skip a
  // view-once clear event that it should actually surface to the user.
  _consumingViewOnce = false;
  // Cancel any queued debounced preview refresh from the previous room so it
  // does not fire in the next room's context and render stale content.
  _debouncedRefreshPreview.cancel?.();
  // Reset the preview-click listener guard so the next room can wire it when
  // the user enters preview mode. Without this, the guard stays true and the
  // listener is never re-wired after the first navigation.
  _previewObserverWired = false;
  // Reset room object so stale room data never leaks into a subsequent session
  // (e.g. settings callbacks that fire after teardown read _room for its values).
  _room   = null;
  _roomId = null;
  // Defense-in-depth: clear URL-derived flags. Both are re-set from the URL on
  // every room navigation (lines ~191–197) before being read, so there is no
  // functional bug if they linger. Clearing here ensures no stale value is
  // observable in the window between teardown and the next route resolution.
  _isReadOnly = false;
  _shareToken = null;
  // Reset the scroll-sync guard so it can re-wire on the next split-mode entry.
  UI.resetScrollSync();
  // Reset the presence announcer so the next room's already-connected devices
  // aren't announced to screen readers as having just joined.
  UI.resetPresenceAnnouncer();
}

// ── Templates handler ─────────────────────────────────────────────────────────

async function _onTemplateChosen(key, mode) {
  const body = getTemplate(key);
  if (body == null) return;
  if (!canUseTemplates()) { UI.showToast(editBlockedReason() || 'Templates are disabled.', 'warning'); return; }

  const editor = document.getElementById('note-editor');

  if (mode === 'insert') {
    // Insert at the current cursor position; fall back to append if no editor focus.
    UI.insertAtCursor(body);
    editor?.dispatchEvent(new Event('input', { bubbles: true }));
    UI.updateWordCount(UI.getEditorValue());
    _refreshPreviewIfActive();
    UI.showToast('Template inserted.', 'success');
    return;
  }

  const current = UI.getEditorValue();
  let next;
  if (mode === 'append') {
    next = current && body ? `${current.replace(/\s+$/, '')}\n\n${body}` : (current + body);
  } else { // 'replace'
    next = body;
  }

  // 'replace' overwrites the whole note and 'append' can meaningfully change
  // it — preserve the pre-template content in history before either happens.
  await snapshotBeforeDestructiveChange();
  UI.setEditorValue(next);
  editor?.dispatchEvent(new Event('input', { bubbles: true }));
  UI.updateWordCount(UI.getEditorValue());
  _refreshPreviewIfActive();
  UI.closeModal('templates-modal');
  UI.showToast(mode === 'append' ? 'Template appended.' : 'Template applied.', 'success');
}


// ── Version history ───────────────────────────────────────────────────────────

async function _openHistoryPanel() {
  UI.openPanel('history-panel');
  UI.setHistoryLoading(true);
  try {
    const revisions = await listRevisions(_roomId);
    const withPreviews = await Promise.all(revisions.map(async (rev) => {
      let preview = rev.content || '';
      if (looksEncrypted(preview)) {
        if (!_encKey) { preview = null; }
        else {
          try { preview = await decryptContent(preview, _encKey); }
          catch { preview = null; }
        }
      }
      return { ...rev, _preview: preview };
    }));
    UI.renderHistoryList(withPreviews, _restoreRevision, {
      canRestore: canEdit(),
      deviceId:   getDeviceId(),
    });
  } catch {
    UI.showToast('Could not load version history.', 'error');
  } finally {
    UI.setHistoryLoading(false);
  }
}

async function _restoreRevision(rev) {
  if (!canEdit()) { UI.showToast(editBlockedReason() || 'Editing is disabled.', 'warning'); return; }

  const ok = await UI.showConfirm(
    `Restore the version from ${formatTimestamp(rev.created_at)}? Your current content will be saved to history first.`,
    { confirmLabel: 'Restore', danger: true }
  );
  if (!ok) return;

  let plaintext = rev.content || '';
  if (looksEncrypted(plaintext)) {
    if (!_encKey) { UI.showToast('Cannot restore an encrypted version without the passphrase.', 'error'); return; }
    try { plaintext = await decryptContent(plaintext, _encKey); }
    catch { UI.showToast('Could not decrypt this version.', 'error'); return; }
  }

  await snapshotBeforeDestructiveChange();

  UI.setEditorValue(plaintext);
  const editor = document.getElementById('note-editor');
  editor?.dispatchEvent(new Event('input', { bubbles: true }));
  UI.updateWordCount(UI.getEditorValue());
  _refreshPreviewIfActive();
  UI.closeAllPanels();
  UI.showToast('Version restored.', 'success');
}


// ── Preview helpers ───────────────────────────────────────────────────────────

/**
 * Single entry point for every Write/Preview/Split mode change. Preview and
 * Split's right pane use the Typora-style editable CM6 surface; if it fails
 * to mount for any reason the old rendered-HTML preview is the fallback.
 */
function _applyMarkdownMode(mode) {
  // Cursor-chat bubbles/composer are positioned in viewport coordinates from
  // the live surface, which is about to be hidden (or was never shown) —
  // leaving them up would float a stale bubble over whatever mode follows.
  if (mode === 'write') UI.clearCursorChat();
  _markdownMode = mode;
  _showPreview  = mode !== 'write';

  let live = false;
  if (mode === 'preview' || mode === 'split') {
    const container = document.getElementById('note-live');
    if (container) {
      try {
        if (!LiveEditor.isMounted()) {
          LiveEditor.mount(container, UI.getEditorValue(), {
            onChange: _onLiveEditorChange,
            onCursorActivity: _onLiveCursorActivity,
            readOnly: !canEdit(),
          });
        } else {
          LiveEditor.syncFromText(UI.getEditorValue());
          LiveEditor.setReadOnly(!canEdit());
        }
        live = LiveEditor.isMounted();
      } catch { live = false; }
    }
  }

  UI.setMarkdownMode(mode, () => renderMarkdown(UI.getEditorValue()), { live });
  if (_showPreview && !live) _wirePreviewClickOnce();

  // Proportional scroll sync only makes sense when both panes are visible.
  if (mode === 'split' && live) {
    LiveEditor.wireScrollSync(document.getElementById('note-editor'));
  } else {
    LiveEditor.unwireScrollSync();
  }
}

// User edits in the live surface flow back through the textarea's normal
// input pipeline (save/broadcast/word count/snapshot) — the textarea stays
// the single source every other module reads.
function _onLiveEditorChange(text) {
  const editor = document.getElementById('note-editor');
  if (!editor || !canEdit()) return;
  editor.value = text;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

// Cursor/selection movement in the live surface broadcasts the same
// presence payload the textarea's keyup/mouseup path does — line for the
// devices list, precise offset(s) for in-text remote carets/selections.
function _onLiveCursorActivity(head, anchor) {
  const before = UI.getEditorValue().slice(0, head);
  const line   = (before.match(/\n/g) || []).length + 1;
  setCursorLine(line, head, anchor);
}

// Cursor chat only makes sense where there's a real caret to anchor a bubble
// to — the CM6 live surface (Preview/Split), the same place remote carets
// themselves render. Write mode's plain textarea has no per-character
// screen coordinates to place one at.
function _openCursorChatComposer() {
  // LiveEditor stays mounted (just hidden) after switching back to Write
  // mode, so isMounted() alone isn't enough — the surface has to actually
  // be the visible one for its screen coordinates to mean anything.
  if (_markdownMode === 'write' || !LiveEditor.isMounted()) {
    UI.showToast('Switch to Preview or Split mode to send a cursor chat.', 'info', 3000);
    return;
  }
  const pos = LiveEditor.getCaretPos();
  const coords = pos != null ? LiveEditor.coordsAtPos(pos) : null;
  if (!coords) return;
  UI.openCursorChatComposer(coords, (text) => {
    broadcastCursorChat(text, pos);
    UI.showCursorChatBubble({ deviceId: getDeviceId(), deviceName: 'You', text, x: coords.x, y: coords.y });
  });
}

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
    await snapshotBeforeDestructiveChange();
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
