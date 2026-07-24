// SyncPad – app.js
// Routing, room join flow, and event wiring.

import {
  getDeviceId, getDeviceName, setDeviceName,
  generateRoomId, sanitizeRoomId,
  copyToClipboard, insertTimestamp,
  isMobile, isOnline, onOnlineChange,
  buildRoomUrl, buildReadOnlyUrl, getUrlMode, parseDuration,
  escapeHtml, debounce, formatTimestamp, filterCommands,
} from './utils.js';

import { loadRoom, createRoom, clearRoomContent, subscribeToRoom, getOrCreateReadOnlyShareLink, resolveReadOnlyShareLink, getOrCreateRoomCode, resolveRoomCode, recordRoomDeviceView, setDeviceLimit, clearDeviceLimit, updateRoomDisplayName, normalizeRoomDisplayName, submitRoomReport, REPORT_REASONS } from './rooms.js';
import { listRevisions } from './revisions.js';
import { listComments, addComment, deleteComment, subscribeToComments } from './comments.js';

import {
  initBroadcast, destroyBroadcast,
  broadcastSettingsChange, broadcastFilesChange, cancelPendingTypingBroadcast, cancelPendingLiveContentBroadcast,
  broadcastClear, broadcastViewOnceCleared, broadcastCursorChat, broadcastCursorChatReaction,
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
  exportCustomTemplates, importCustomTemplates, BODY_MAX,
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
let _unsubComments = null;
let _expTimer      = null;
let _onlineCleanup = null;   // v1: teardown fn returned by onOnlineChange()
let _monospace     = false;
let _eventsWired   = false;  // v1: guard against double-wiring
let _consumingViewOnce = false; // v1: short-circuit own view-once clear echo
let _viewOnceConsumedByThisSession = false; // session-local allowlist for first consumer view
let _isReadOnly    = false;  // ?mode=read or /share/:token (UI/UX convention, not server-enforced — see joinRoom())
let _shareToken    = null;
let _markdownMode  = 'write'; // 'write' | 'preview' | 'split'
let _showPreview   = false;  // derived: _markdownMode !== 'write'
let _previewObserverWired = false;
let _expPreset = '10m';
// Room-scoped: which remote device_id (if any) the local view auto-scrolls
// to follow. Reset on room navigation like the other room-scoped state below.
let _followedDeviceId = null;
// Raw (not-yet-decrypted-for-display) comments from the last _refreshComments()
// call — re-applied to the live surface whenever it (re)mounts, since
// setCommentAnchors() silently no-ops while unmounted (e.g. the room loaded
// straight into Write mode, where nothing is mounted yet to receive them).
let _lastComments = [];

// ── Slash-command quick-insert menu state (Write mode only) ───────────────────
// Reset on room navigation like the other room-scoped state above/below.
let _slashOpen        = false;
let _slashStart        = null; // editor offset of the triggering '/'
let _slashCoords       = null; // viewport coords, cached at open (the '/' doesn't move as the query grows)
let _slashFiltered     = [];
let _slashActiveIndex  = 0;

const SLASH_MENU_ITEMS = [
  { id: 'h1',            label: 'Heading 1',         hint: '#',        keywords: 'h1 heading title' },
  { id: 'h2',            label: 'Heading 2',         hint: '##',       keywords: 'h2 heading subtitle' },
  { id: 'h3',            label: 'Heading 3',         hint: '###',      keywords: 'h3 heading' },
  { id: 'bold',          label: 'Bold',              hint: '**text**', keywords: 'bold strong' },
  { id: 'italic',        label: 'Italic',            hint: '_text_',   keywords: 'italic emphasis' },
  { id: 'strikethrough', label: 'Strikethrough',     hint: '~~text~~', keywords: 'strikethrough strike' },
  { id: 'highlight',     label: 'Highlight',         hint: '==text==', keywords: 'highlight mark' },
  { id: 'code',          label: 'Inline code',       hint: '`code`',   keywords: 'code inline' },
  { id: 'codeblock',     label: 'Code block',        hint: '```',      keywords: 'code block fence' },
  { id: 'link',          label: 'Link',              hint: '[text](url)', keywords: 'link url hyperlink' },
  { id: 'quote',         label: 'Quote',             hint: '>',        keywords: 'quote blockquote' },
  { id: 'ul',            label: 'Bullet list',       hint: '-',        keywords: 'bullet list unordered' },
  { id: 'ol',            label: 'Numbered list',     hint: '1.',       keywords: 'numbered list ordered' },
  { id: 'checklist',     label: 'Checklist',         hint: '- [ ]',    keywords: 'checklist todo task checkbox' },
  { id: 'hr',            label: 'Divider',           hint: '---',      keywords: 'divider horizontal rule line' },
  { id: 'toc',           label: 'Table of contents', hint: '[TOC]',    keywords: 'toc table contents outline' },
  { id: 'timestamp',     label: 'Insert timestamp',  hint: '',         keywords: 'timestamp time date now' },
  { id: 'template',      label: 'Insert template',   hint: '',         keywords: 'template' },
];

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
// Which editor mode a room opens into. Defaults to Live (Preview) rather
// than Source — most reading/reviewing happens rendered, and Write is one
// segmented-control click away for anyone who wants raw markdown. Once a
// user picks a mode it's remembered like the other preferences above,
// including Write for anyone who prefers it. See _applyMarkdownMode(),
// which persists on every switch, and _resolveInitialEditorMode() below.
const _EDITOR_MODE_KEY = 'syncpad_editor_mode';
function _resolveInitialEditorMode() {
  const stored = localStorage.getItem(_EDITOR_MODE_KEY);
  return (stored === 'write' || stored === 'preview' || stored === 'split') ? stored : 'preview';
}

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

// ── Recent rooms (landing page shortcut list) ───────────────────────────────
// Safe to persist plainly now that room_id alone grants access again (see
// supabase/migrations/0009_revert_edit_token_write_gating.sql) — there's no
// token that could leak by remembering more than the single "last room" slot
// above. Tracks every successful room visit, read-only included — this is a
// personal "places I've been" convenience, not tied to edit permission.
const RECENT_ROOMS_KEY = 'syncpad_recent_rooms';
const RECENT_ROOMS_MAX = 8;

function _loadRecentRooms() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_ROOMS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((r) => r && typeof r.id === 'string') : [];
  } catch { return []; }
}

function _rememberRecentRoom(roomId, name) {
  try {
    const list = _loadRecentRooms().filter((r) => r.id !== roomId);
    list.unshift({ id: roomId, name: (name || '').trim() || roomId, visitedAt: Date.now() });
    localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(list.slice(0, RECENT_ROOMS_MAX)));
  } catch {}
}

function _forgetRecentRoom(roomId) {
  try {
    localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(_loadRecentRooms().filter((r) => r.id !== roomId)));
  } catch {}
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

// A bare 6-character code from the short-code alphabet (see
// supabase/migrations/0002_short_room_codes.sql) — distinct enough from
// generateRoomId()'s "adjective-noun-suffix" shape and from any
// sanitizeRoomId() output containing a URL/slash that a false-positive
// match against a deliberately-chosen custom room id is very unlikely.
// Resolution failure just falls through to the literal-room-id path,
// so this can never make a previously working join stop working.
const SHORT_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/i;

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
      history.replaceState(null, '', `${BASE}/${lastRoom}`);
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
    history.pushState(null, '', `${BASE}/${roomId}`);
    UI.showScreen('loading');
    joinRoom(roomId, { isNewRoom: true });
  };

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

    // Accept full URL (preserving ?mode= so a pasted read-only link keeps
    // working) or a bare ID.
    let id, qs = '';
    try {
      const url = new URL(raw);
      id = _stripBasePath(url.pathname).replace(/^\/+|\/+$/g, '');
      qs = url.search || '';
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
    history.pushState(null, '', `${BASE}/${id}${qs}`);
    UI.showScreen('loading');
    joinRoom(id);
  };

  createBtn?.addEventListener('click', handleCreateRoomClick);
  joinBtn?.addEventListener('click', joinRoom_);
  joinInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom_(); });

  _renderRecentRooms();
}

function _renderRecentRooms() {
  const container = document.getElementById('landing-recent');
  const list = document.getElementById('landing-recent-list');
  if (!container || !list) return;
  const rooms = _loadRecentRooms();
  if (!rooms.length) { container.classList.add('hidden'); list.innerHTML = ''; return; }
  container.classList.remove('hidden');
  list.innerHTML = rooms.map((r) => `
    <div class="landing-recent-item">
      <button class="landing-recent-item-btn" data-room-id="${escapeHtml(r.id)}">
        <span class="landing-recent-name">${escapeHtml(r.name)}</span>
        <span class="landing-recent-time">${escapeHtml(formatTimestamp(r.visitedAt))}</span>
      </button>
      <button class="landing-recent-remove" data-remove-id="${escapeHtml(r.id)}" title="Remove from recent rooms" aria-label="Remove ${escapeHtml(r.name)} from recent rooms">×</button>
    </div>`).join('');
  list.querySelectorAll('.landing-recent-item-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const roomId = btn.dataset.roomId;
      history.pushState(null, '', `${BASE}/${roomId}`);
      UI.showScreen('loading');
      joinRoom(roomId);
    });
  });
  list.querySelectorAll('.landing-recent-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      _forgetRecentRoom(btn.dataset.removeId);
      _renderRecentRooms();
    });
  });
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

async function joinRoom(roomId, { isNewRoom = false } = {}) {
  // Captured BEFORE teardownRealtimeSession(), which (defensively) resets
  // _isReadOnly to false — read after that would silently lose ?mode=read
  // and /share/:token's forced-read-only signal on every single navigation.
  //
  // Forced read-only routes (?mode=read, /share/:token) are a UI/UX
  // convention, not a server-enforced boundary: room_id alone is sufficient
  // to write (see supabase/migrations/0009_revert_edit_token_write_gating.sql
  // for why — the edit-token model this replaced had a real cost in lost-
  // token lockouts and deployment fragility that outweighed its benefit for
  // a personal/demo project not meant to hold anything sensitive). A room
  // owner who needs a link that genuinely can't be used to edit should Lock
  // the room first — editing_locked is enforced server-side regardless of
  // how the write is attempted, unlike this route-based flag.
  const forcedReadOnly = _isReadOnly;

  teardownRealtimeSession();
  _roomId = roomId;
  _viewOnceConsumedByThisSession = false;
  UI.setLoadingMessage('Loading room…');

  try {
    if (isNewRoom) {
      UI.setLoadingMessage('Creating room…');
      _room = await createRoom(roomId);
      _isReadOnly = false;
      history.replaceState(null, '', `${BASE}/${roomId}`);
    } else {
      const room = await loadRoom(roomId);

      if (!room && !forcedReadOnly && SHORT_CODE_RE.test(roomId)) {
        // A short code typed/pasted directly into the URL bar, not just the
        // landing page's join box — resolve it before falling through to
        // "create a room literally named after the code", which a code is
        // never meant to become.
        const resolvedId = await resolveRoomCode(roomId).catch(() => null);
        if (resolvedId) {
          history.replaceState(null, '', `${BASE}/${resolvedId}${location.search}`);
          return joinRoom(resolvedId);
        }
      }

      if (!room && !forcedReadOnly) {
        // Neither an existing room nor a resolvable code: visiting a URL
        // (typed, bookmarked, or a link shared before the room existed) for
        // a name nobody has taken yet creates it and opens it editable,
        // same as the landing page's Create Room button — this is the
        // original "join by name" behavior. A forced-read-only route
        // (?mode=read, /share/:token) never reaches this branch, so a
        // stale/expired read-only link can't be used to claim a fresh room.
        UI.setLoadingMessage('Creating room…');
        _room = await createRoom(roomId);
        _isReadOnly = false;
        history.replaceState(null, '', `${BASE}/${roomId}`);
      } else if (!room) {
        UI.setInfoScreen({
          title: 'Share link unavailable',
          message: 'This read-only link points to a room that does not exist.',
        });
        UI.showScreen('info');
        return;
      } else {
        _isReadOnly = forcedReadOnly;
        _room = room;
      }
    }
  } catch (err) {
    // Log the raw error so RLS / network failures are diagnosable in DevTools.
    console.error('[SyncPad] joinRoom failed for', roomId, err);
    UI.showLoadingError(
      'Could not load room — check your connection and try again.',
      () => joinRoom(roomId, { isNewRoom }),  // retry callback
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
  // Only for genuine editable visits — not read-only share links or
  // ?mode=read, which are bound to someone else's link rather than "my" room.
  if (!_isReadOnly) _rememberLastRoom(_roomId);
  _rememberRecentRoom(_roomId, _room?.room_name);

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
  // that hasn't run supabase/migrations/0005_device_limit.sql yet just has
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
  // Transient state for the loading screen only — safe before real content
  // exists because Write mode needs no content (Preview/Split mount the
  // live surface against the current editor value, which isn't set yet).
  // The user's actual remembered mode is applied below, once content is in
  // place; see _resolveInitialEditorMode() and the setContentNoSave() calls
  // further down.
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

  // Apply the user's remembered editor mode now that real content exists —
  // Preview/Split mount the live surface against the current editor value,
  // so this has to run after setContentNoSave() above, not alongside the
  // 'write' placeholder set earlier for the loading screen.
  const _initialMode = _resolveInitialEditorMode();
  if (_initialMode !== 'write') _applyMarkdownMode(_initialMode);

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
      // payload.pos is a plain text offset — mode-agnostic on the wire.
      // Resolve it to screen coordinates on whichever surface is actually
      // visible locally, independent of what mode the sender was in.
      const live = _markdownMode !== 'write' && LiveEditor.isMounted();
      const coords = live ? LiveEditor.coordsAtPos(payload.pos) : UI.getCaretViewportCoords(payload.pos);
      if (!coords) return;
      UI.showCursorChatBubble({
        deviceId:   payload.device_id,
        deviceName: payload.device_name,
        text:       String(payload.text || '').slice(0, 80),
        x: coords.x, y: coords.y,
        id: payload.id,
      }, (targetId, emoji) => broadcastCursorChatReaction(targetId, emoji));
    },
    onRemoteCursorChatReaction: (payload) => {
      UI.addCursorChatReaction(payload.target_id, payload.emoji);
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

  // Best-effort: a Supabase project that hasn't run
  // supabase/migrations/0003_room_comments.sql yet just never shows any comments —
  // _refreshComments() swallows the failure rather than surfacing an error
  // toast for what is an entirely optional feature.
  _unsubComments = subscribeToComments(_roomId, () => _refreshComments());
  await _refreshComments();

  if (_room.expires_at) setupExpirationTimer();

  wireEvents();

  _onlineCleanup = onOnlineChange((online) => {
    if (online) { UI.hideOfflineBanner(); UI.setStatus('connected'); flushSave(); }
    else        { UI.showOfflineBanner();  UI.setStatus('offline'); }
  });
  if (!isOnline()) UI.showOfflineBanner();

  // Preview is now a possible starting mode (see _resolveInitialEditorMode()
  // above), where the plain textarea is hidden — UI.focusEditor() would
  // silently focus an invisible element and leave no visible caret anywhere.
  if (!isMobile() && !_isReadOnly) _focusActiveEditorSurface();

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
      _insertTextAtActiveCursor(`![${record.filename}](syncpad-file:${record.file_path})\n`);
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
        `Delete "${file.filename}"?`,
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
    onToggleMonospace: () => _toggleMonospace(),
    onOpenSearch: () => {
      UI.openPanel('search-panel');
      document.getElementById('search-input')?.focus();
    },
    onForceClose: () => {
      document.getElementById('more-dropdown')?.classList.remove('open');
      document.getElementById('btn-more')?.setAttribute('aria-expanded', 'false');
      _closeEditorContextMenu();
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
      _insertTextAtActiveCursor(insertTimestamp());
      UI.showToast('Timestamp inserted.', 'success');
    },
    onCopyNote: () => _copyNoteToClipboard(),
    onCursorChat: () => _openCursorChatComposer(),
    onOpenCommandPalette: () => _openCommandPalette(),
  });

}

// ── Command palette ───────────────────────────────────────────────────────────
// A searchable index of app-wide actions, opened with Ctrl/Cmd+K outside the
// editor (see shortcuts.js) or the More menu's "Command Palette" item.
// Actions that already have a guarded, wired button elsewhere (permission
// checks, confirm dialogs, toasts) are run by clicking that button rather
// than re-implementing the guard here — one source of truth per action.

let _paletteFiltered    = [];
let _paletteActiveIndex = 0;

function _clickById(id) {
  return () => document.getElementById(id)?.click();
}

function _paletteCommands() {
  return [
    { id: 'mode-write',   label: 'Source mode (hide preview)',        group: 'View', run: () => _applyMarkdownMode('write') },
    { id: 'mode-preview', label: 'Toggle Live preview mode',          group: 'View', shortcut: 'Ctrl Shift P', keywords: ['preview'], run: () => _applyMarkdownMode(_markdownMode === 'preview' ? 'write' : 'preview') },
    { id: 'mode-split',   label: 'Toggle Split view',                 group: 'View', shortcut: 'Ctrl Shift S', run: () => _applyMarkdownMode(_markdownMode === 'split' ? 'write' : 'split') },
    { id: 'monospace',    label: _monospace ? 'Turn off monospace font' : 'Turn on monospace font', group: 'View', shortcut: 'Ctrl Shift M', keywords: ['font'], run: () => _toggleMonospace() },

    { id: 'panel-tools',    label: 'Open Tools panel',    group: 'Panels', keywords: ['clear', 'import', 'download'], run: () => UI.togglePanel('tools-panel') },
    { id: 'panel-files',    label: 'Open Files panel',    group: 'Panels', keywords: ['attachments', 'upload'], run: () => UI.togglePanel('files-panel') },
    { id: 'panel-devices',  label: 'Open Devices panel',  group: 'Panels', keywords: ['presence', 'collaborators'], run: () => UI.togglePanel('presence-panel') },
    { id: 'panel-settings', label: 'Open Settings panel', group: 'Panels', keywords: ['passcode', 'encryption', 'expiration', 'lock'], run: () => UI.togglePanel('settings-panel') },
    { id: 'panel-find',     label: 'Find & Replace',      group: 'Panels', shortcut: 'Ctrl F', keywords: ['search'], run: () => { UI.openPanel('search-panel'); document.getElementById('search-input')?.focus(); } },
    { id: 'panel-history',  label: 'Open Version History', group: 'Panels', keywords: ['revisions', 'restore'], run: () => _openHistoryPanel() },
    { id: 'panel-comments', label: 'Open Comments',        group: 'Panels', run: () => _openCommentsPanel() },
    { id: 'panel-templates', label: 'Insert a template',   group: 'Panels', run: _clickById('tool-templates') },

    { id: 'share',          label: 'Share this room',                 group: 'Room', shortcut: 'Ctrl Shift K', run: _clickById('btn-share') },
    { id: 'lock',           label: _room?.editing_locked ? 'Unlock editing' : 'Lock editing', group: 'Room', run: _clickById('setting-lock-btn') },
    { id: 'clear-note',     label: 'Clear note for everyone…',        group: 'Room', keywords: ['delete', 'empty'], run: _clickById('tool-clear') },
    { id: 'report-room',    label: 'Report this room',                group: 'Room', run: _clickById('btn-report-room') },

    { id: 'insert-timestamp', label: 'Insert timestamp',              group: 'Edit', shortcut: 'Ctrl Shift T', run: _clickById('btn-insert-ts') },
    { id: 'copy-note',        label: 'Copy note contents',            group: 'Edit', shortcut: 'Ctrl Shift C', run: () => _copyNoteToClipboard() },
    { id: 'import-text',       label: 'Import a text/Markdown file',  group: 'Edit', run: _clickById('tool-import') },
    { id: 'download-md',       label: 'Download note as .md',         group: 'Edit', keywords: ['export'], run: _clickById('tool-download') },
    { id: 'export',            label: 'Export…',                      group: 'Edit', keywords: ['pdf', 'html', 'txt', 'print'], run: _clickById('btn-export') },

    { id: 'about',      label: 'About SyncPad',       group: 'Help', run: _clickById('btn-about') },
    { id: 'shortcuts',  label: 'Keyboard shortcuts',  group: 'Help', shortcut: 'Ctrl /', run: _clickById('btn-shortcuts') },

    ...THEMES.map((t) => ({
      id: `theme-${t.id}`, label: `Theme: ${t.label}`, group: 'Appearance', keywords: ['color', 'dark', 'light'],
      run: () => applyTheme(t.id),
    })),
  ];
}

function _renderPaletteResults() {
  UI.renderCommandPaletteResults(_paletteFiltered, _paletteActiveIndex, _runPaletteCommand);
}

function _runPaletteCommand(id) {
  const cmd = _paletteFiltered.find((c) => c.id === id);
  _closeCommandPalette();
  cmd?.run();
}

function _openCommandPalette() {
  const input = document.getElementById('command-palette-input');
  _paletteFiltered = _paletteCommands();
  _paletteActiveIndex = 0;
  UI.openModal('command-palette-modal');
  if (input) { input.value = ''; input.focus(); }
  _renderPaletteResults();
}

function _closeCommandPalette() {
  UI.closeModal('command-palette-modal');
}

function _wireCommandPalette() {
  document.getElementById('btn-command-palette')?.addEventListener('click', () => {
    closeMoreDropdown();
    _openCommandPalette();
  });

  const input = document.getElementById('command-palette-input');
  input?.addEventListener('input', () => {
    _paletteFiltered = filterCommands(_paletteCommands(), input.value);
    _paletteActiveIndex = 0;
    _renderPaletteResults();
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (_paletteFiltered.length) _paletteActiveIndex = (_paletteActiveIndex + 1) % _paletteFiltered.length;
      _renderPaletteResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (_paletteFiltered.length) _paletteActiveIndex = (_paletteActiveIndex - 1 + _paletteFiltered.length) % _paletteFiltered.length;
      _renderPaletteResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const active = _paletteFiltered[_paletteActiveIndex];
      if (active) _runPaletteCommand(active.id);
    }
  });
}

// Custom templates are already capped at BODY_MAX (templates.js), but nothing
// stopped the editor itself from exceeding it — via typing past it, a native
// paste, a large text-file import, or a template insert/append onto already-
// substantial content. Enforced here, at the single 'input' listener every
// one of those paths dispatches through (typing, paste, and every
// programmatic edit in this file all end with `editor.dispatchEvent(new
// Event('input'))`), rather than at each write site — one choke point that
// can't be missed by a future write path, instead of a growing list of call
// sites that each have to remember to opt in.
function _enforceBodyMax() {
  if (!UI.clampEditorValue(BODY_MAX)) return false;
  UI.showToast(`Content trimmed to the ${BODY_MAX.toLocaleString()}-character limit.`, 'warning', 5000);
  return true;
}

function _wireEditorCore() {
  const editor = document.getElementById('note-editor');

  editor?.addEventListener('input', () => {
    if (!canEdit()) return;
    _enforceBodyMax();
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
    _debouncedRefreshCommentMargin();
    _updateSlashMenu();
  });
  editor?.addEventListener('blur', () => { onEditorBlur(); _closeSlashMenu(); });

  // ── Smart editor keyboard behaviour ────────────────────────────────────────
  editor?.addEventListener('keydown', (e) => {
    if (_handleSlashMenuKeydown(e)) return;
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
        UI.replaceEditorRange(lStart, lEnd, newBlock, lStart, lStart + newBlock.length);
      } else {
        // In a list: insert 2 spaces at caret
        UI.replaceEditorRange(start, end, '  ');
      }
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
        UI.replaceEditorRange(lineStart, pos, '\n', lineStart + 1);
      } else {
        // Continue the list with the next item
        const nextPrefix = olMatch
          ? `${olMatch[1]}${parseInt(olMatch[2], 10) + 1}. `
          : `${match[1]}${match[2]} `;
        UI.replaceEditorRange(pos, editor.selectionEnd, '\n' + nextPrefix);
      }
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
          UI.setEditorSelection(start + 1);
          return;
        }
        const before = editor.value[start - 1];
        const opening = before === undefined || OPENING_CONTEXT.test(before);
        const insert = opening ? '“”' : '”';
        UI.replaceEditorRange(start, start, insert, start + 1); // right after the opening quote either way
        return;
      }

      if (e.key === "'" && start === end) {
        // No pairing for the single quote — it's an apostrophe far more
        // often than it's a quotation mark (don't, it's, '90s), so only its
        // direction (opening ' vs. closing/apostrophe ') is decided here.
        e.preventDefault();
        const before = editor.value[start - 1];
        const opening = before === undefined || OPENING_CONTEXT.test(before);
        UI.replaceEditorRange(start, start, opening ? '‘' : '’');
        return;
      }

      if (e.key === '-' && start === end) {
        const prev = editor.value[start - 1];
        if (prev === '–' || prev === '-') {
          e.preventDefault();
          UI.replaceEditorRange(start - 1, start, prev === '-' ? '–' : '—');
          return;
        }
        // A single hyphen with nothing to combine with — let it type normally.
      }

      if (e.key === '.' && start === end && editor.value.slice(start - 2, start) === '..') {
        e.preventDefault();
        UI.replaceEditorRange(start - 2, start, '…');
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
        UI.replaceEditorRange(start, end, e.key + selected + closeChar, start + 1, start + 1 + selected.length);
        return;
      }

      // ` and " are symmetric — the same character both opens and closes a
      // pair. Typing one immediately before its own kind already sitting at
      // the cursor means "close/skip over", not "open a new nested pair".
      if ((e.key === '`' || e.key === '"') && editor.value[start] === e.key) {
        e.preventDefault();
        UI.setEditorSelection(start + 1);
        return;
      }

      e.preventDefault();
      UI.replaceEditorRange(start, start, e.key + closeChar, start + 1);
      return;
    }

    // ) and ] are only ever closers — skip over one already at the cursor
    // rather than typing a second, redundant one right next to it.
    if ((e.key === ')' || e.key === ']') && editor.selectionStart === editor.selectionEnd && editor.value[editor.selectionStart] === e.key) {
      e.preventDefault();
      UI.setEditorSelection(editor.selectionStart + 1);
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
        UI.replaceEditorRange(pos - 1, pos + 1, '', pos - 1);
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
    _applyFormatToActiveSurface(btn.dataset.mdAction);
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
  editor?.addEventListener('scroll', () => { UI.refreshFocusMode(); _refreshCommentMargin(); });
  window.addEventListener('resize', () => {
    UI.refreshFocusMode();
    UI.refreshTypewriterMode();
    _refreshCommentMargin();
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

  // beforeunload does NOT reliably fire for every real tab-close — mobile
  // Safari/iOS (including this app's own installed-PWA path, see
  // _isStandalonePwa()) is well documented to skip or delay it when a tab is
  // closed/backgrounded rather than navigated. When that happens, this
  // device's presence row is only cleared server-side once its WebSocket
  // eventually times out — until then it keeps counting as "connected",
  // which is the most direct way the device count drifts from reality.
  // pagehide is the modern, more-reliably-fired sibling event (also covers
  // the bfcache-navigation case beforeunload can miss); registering the same
  // cleanup on both costs nothing extra since destroyPresence() is a no-op
  // once _ch is already null; whichever fires first wins.
  const _cleanupOnLeave = () => {
    // setTyping(false) clears the isTyping flag in Supabase Presence so other
    // devices don't see a ghost "typing" indicator after this tab closes.
    // visibilitychange handles tab-hide; these handle close/navigate.
    setTyping(false);
    flushSave();
    destroyPresence();
  };
  window.addEventListener('beforeunload', _cleanupOnLeave);
  window.addEventListener('pagehide', _cleanupOnLeave);
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

// ── Editor selection context menu ───────────────────────────────────────────
// Right-click (or long-press, on touch) a text selection in either surface
// (Source textarea or Live/Split's CM6 pane) for quick formatting/comment
// actions, instead of always having to reach for the toolbar or open the
// Comments panel first.

function _closeEditorContextMenu() {
  document.getElementById('editor-context-menu')?.classList.remove('visible');
}

function _openEditorContextMenu(x, y) {
  const menu = document.getElementById('editor-context-menu');
  if (!menu) return;
  menu.classList.add('visible');
  // Clamp so a right-click near the viewport edge doesn't render off-screen.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth  - rect.width  - 8);
  const top  = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top  = `${Math.max(8, top)}px`;
}

function _wireEditorContextMenu() {
  const menu = document.getElementById('editor-context-menu');
  const wrap = document.querySelector('.editor-wrap');
  if (!menu || !wrap) return;

  wrap.addEventListener('contextmenu', (e) => {
    if (!canEdit()) return; // fall through to the native menu (still lets read-only visitors copy)
    const range = _currentSelectionRange();
    if (!range || range.to <= range.from) return; // no selection — native menu is more useful here
    e.preventDefault();
    _openEditorContextMenu(e.clientX, e.clientY);
  });

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ctx-action]');
    if (!btn) return;
    const action = btn.dataset.ctxAction;
    _closeEditorContextMenu();
    if (action === 'comment') _openCommentsPanel();
    else _applyFormatToActiveSurface(action);
  });

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) _closeEditorContextMenu();
  });
  document.addEventListener('scroll', _closeEditorContextMenu, true);
  window.addEventListener('resize', _closeEditorContextMenu);
}

// Dismiss the slash menu on an outside click (e.g. clicking elsewhere in the
// editor to move the caret away from the trigger) or window resize.
// Deliberately NOT closed on scroll like the context menu above — the
// textarea auto-scrolling to keep the caret visible while its query is
// typed would otherwise close the menu mid-use.
function _wireSlashMenuDismissal() {
  const menu = document.getElementById('slash-menu');
  if (!menu) return;
  document.addEventListener('click', (e) => {
    if (_slashOpen && !menu.contains(e.target)) _closeSlashMenu();
  });
  window.addEventListener('resize', _closeSlashMenu);
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

function _copyNoteToClipboard() {
  return copyToClipboard(UI.getEditorValue())
    .then(ok => ok
      ? UI.showToast('Copied to clipboard.', 'success')
      : UI.showToast('Could not copy.', 'error'));
}

function _wireFooterQuickButtons() {
  // ── Footer quick buttons ───────────────────────────────────────────────────
  document.getElementById('btn-insert-ts')?.addEventListener('click', () => {
    if (!canEdit()) { UI.showToast(editBlockedReason() || 'Editing is disabled.', 'warning'); return; }
    _insertTextAtActiveCursor(insertTimestamp());
  });
  UI.initFooterClock();

  document.getElementById('btn-cursor-chat-fab')?.addEventListener('click', () => _openCursorChatComposer());

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
          // debounced DB save, and live broadcast. The shared 'input' handler
          // (_wireEditorCore) enforces BODY_MAX centrally, so an over-limit
          // import is trimmed the same way any other over-limit edit is.
          editor?.dispatchEvent(new Event('input', { bubbles: true }));
          _refreshPreviewIfActive();
        };
        r.readAsText(f);
      };
      inp.click();
    },

    'tool-templates': () => {
      if (!canUseTemplates()) { UI.showToast(editBlockedReason() || 'Templates are disabled.', 'warning'); return; }
      _openTemplatesModalFresh();
    },
  };

  Object.entries(toolActions).forEach(([id, fn]) => {
    document.getElementById(id)?.addEventListener('click', () => { fn(); UI.closeAllPanels(); });
  });

  // Wired outside toolActions: each of these opens a side panel, and
  // toolActions' blanket closeAllPanels() after every action would close
  // that panel again immediately (tool-find had exactly this bug — opened
  // search-panel and then closeAllPanels() closed it again in the same tick).
  document.getElementById('tool-find')?.addEventListener('click', () => {
    UI.openPanel('search-panel');
    document.getElementById('search-input')?.focus();
  });
  document.getElementById('tool-history')?.addEventListener('click', () => { _openHistoryPanel(); });
  document.getElementById('tool-comments')?.addEventListener('click', () => { _openCommentsPanel(); });

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
    controls.toggleAttribute('inert', isHidden); // keep its clipped controls out of Tab order while collapsed
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
    } catch { UI.showToast('Could not update device limit. Has supabase/migrations/0005_device_limit.sql been run?', 'error', 5000); }
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
  document.getElementById('export-copy-html')?.addEventListener('click', async () => {
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
      if (editor) UI.setEditorSelection(editor.selectionEnd, editor.selectionEnd);
      if (_markdownMode === 'preview' && LiveEditor.isMounted()) {
        const sel = LiveEditor.getSelection();
        LiveEditor.setSelection(sel.to, sel.to);
      }
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
    // Only steal focus from the editor when the search/replace inputs don't
    // own it — otherwise typing in the search panel scrolls away mid-query.
    const active = document.activeElement;
    const searchPanelFocused = active === searchInput || active === replaceInput;
    // Preview mode hides the plain textarea entirely (`editor.classList.add
    // ('hidden')` in UI.setMarkdownMode) — moving its selectionStart/
    // selectionEnd and scrollTop there has no visible effect, which used to
    // be worked around by force-switching back to Write mode just to show
    // the match. That fought the user's chosen mode every time they hit
    // Enter/Next in the search box. Route to the CM6 live surface instead,
    // the same selection+scrollIntoView primitive the TOC widget uses, and
    // only fall back to a mode switch when the live surface failed to mount
    // (rare — classic-renderer fallback has no caret to move at all).
    if (_markdownMode === 'preview' && LiveEditor.isMounted()) {
      LiveEditor.setSelection(m.start, m.end);
      if (!searchPanelFocused && !keepFocus) LiveEditor.focus();
      if (searchCount) searchCount.textContent = `${idx + 1} / ${_searchMatches.length}`;
      return;
    }
    if (_markdownMode === 'preview') _applyMarkdownMode('write');
    if (!searchPanelFocused && !keepFocus) editor.focus();
    UI.setEditorSelection(m.start, m.end);
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
    if (e.key === 'Escape') { UI.closeAllPanels(); _focusActiveEditorSurface(); }
  });
  replaceInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Tab'    && e.shiftKey)  { e.preventDefault(); searchInput?.focus(); }
    if (e.key === 'Enter')  { e.preventDefault(); replaceOne?.click(); }
    if (e.key === 'Escape') { UI.closeAllPanels(); _focusActiveEditorSurface(); }
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
    UI.replaceEditorRange(m.start, m.end, replacement);
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
    // A whole-document, potentially-multi-match transform — not a single
    // contiguous range — so this goes through setEditorValue()'s
    // similar-length cursor-preserve heuristic rather than replaceEditorRange().
    UI.setEditorValue(editor.value.replace(new RegExp(escaped, flags), replacement));
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
    UI.replaceEditorRange(editor.selectionStart, editor.selectionEnd, plain);
  });

}

function _wireEditorPreferenceToggles() {
  // ── Monospace setting button (Settings panel) ──────────────────────────────
  _syncMonospaceSettingUI();

  document.getElementById('setting-monospace-btn')?.addEventListener('click', () => {
    _toggleMonospace();
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

  // These are simple on/off flips, not navigations — clicking one shouldn't
  // steal focus (and with it the caret position/selection) from the editor.
  // preventDefault on mousedown stops the browser's default click-to-focus
  // behavior for pointer users while leaving keyboard activation (Tab +
  // Enter/Space, which never fires mousedown) untouched.
  ['setting-monospace-btn', 'setting-strip-paste-btn', 'setting-smart-punct-btn',
   'setting-focus-mode-btn', 'setting-typewriter-mode-btn', 'setting-hide-presence-btn']
    .forEach((id) => document.getElementById(id)?.addEventListener('mousedown', (e) => e.preventDefault()));
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
  _wireCommandPalette();
  _wireEditorContextMenu();
  _wireSlashMenuDismissal();
}

// ── Editor preference helpers ─────────────────────────────────────────────────
// The single toggle implementation for both the Settings panel button and the
// Ctrl/Cmd+Shift+M keyboard shortcut — previously duplicated between the two,
// which meant the settings button never reflected a shortcut-triggered toggle
// (visibly stale until the panel was closed and reopened) and the two paths
// could silently drift (e.g. a different toast type/duration each).
function _toggleMonospace() {
  _monospace = !_monospace;
  UI.setMonospace(_monospace);
  try { localStorage.setItem('syncpad_monospace', _monospace ? '1' : '0'); } catch {}
  UI.showToast(_monospace ? 'Monospace on.' : 'Monospace off.', 'info', 1800);
  _syncMonospaceSettingUI();
}

function _syncMonospaceSettingUI() {
  const btn = document.getElementById('setting-monospace-btn');
  if (!btn) return;
  btn.textContent = _monospace ? 'On' : 'Off';
  btn.setAttribute('aria-pressed', String(_monospace));
}

// ── Markdown format helpers ───────────────────────────────────────────────────

/**
 * Insert `text` at the caret of whichever surface is actually active —
 * the CM6 live proxy in Preview mode (or Split, when the live pane has
 * focus), the plain textarea otherwise. Mirrors UI.insertAtCursor()'s
 * behaviour, which only ever touches the (possibly hidden) textarea and
 * silently no-ops visually when Preview mode has it hidden. Shared by any
 * "insert this at my cursor" action — timestamp insert today.
 */
function _insertTextAtActiveCursor(text) {
  const useLive = LiveEditor.isMounted() && (_markdownMode === 'preview' || LiveEditor.hasFocus());
  if (useLive) {
    const proxy = LiveEditor.asEditorProxy();
    if (proxy == null) return;
    const start = proxy.selectionStart ?? proxy.value.length;
    const end   = proxy.selectionEnd   ?? start;
    proxy.value = proxy.value.slice(0, start) + text + proxy.value.slice(end);
    proxy.selectionStart = proxy.selectionEnd = start + text.length;
    proxy.dispatchEvent();
  } else {
    UI.insertAtCursor(text);
  }
}

/**
 * Focus whichever editing surface is actually visible/relevant right now —
 * the CM6 live surface in Preview mode (the plain textarea is hidden there
 * and focusing it is a no-op the user can't see), the plain textarea
 * otherwise. Shared by any call site that used to blindly call
 * `editor.focus()` regardless of markdown mode.
 */
function _focusActiveEditorSurface() {
  if (_markdownMode === 'preview' && LiveEditor.isMounted()) {
    LiveEditor.focus();
  } else {
    document.getElementById('note-editor')?.focus();
  }
}

/**
 * Resolve which surface (plain textarea or CM6 live proxy) a formatting
 * action should target, then apply it — shared by the toolbar and the
 * selection context menu so both act on "whichever pane you're actually
 * looking at/selected text in" identically.
 */
function _applyFormatToActiveSurface(action) {
  if (!canEdit()) return;
  const editor = document.getElementById('note-editor');
  // Preview mode: the textarea is hidden, so the live surface is the only
  // real target. Split mode: act on whichever pane currently has focus,
  // textarea by default (matches the toolbar's pre-live-surface behaviour).
  const useLive = LiveEditor.isMounted() && (_markdownMode === 'preview' || LiveEditor.hasFocus());
  if (useLive) {
    _applyMarkdownFormat(action, LiveEditor.asEditorProxy());
  } else if (editor) {
    _applyMarkdownFormat(action, editor);
  }
}

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
      UI.replaceEditorRange(start, end, inner, start, start + inner.length);
    } else {
      const inner = sel || 'text';
      UI.replaceEditorRange(start, end, prefix + inner + suffix, start + prefix.length, start + prefix.length + inner.length);
    }
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
    UI.replaceEditorRange(lStart, lEnd, newBlock, lStart, lStart + newBlock.length);
  };

  // Toggle an ATX heading on the current line (strips any existing # prefix first).
  const toggleHeading = (level) => {
    const prefix = '#'.repeat(level) + ' ';
    const lStart = val.lastIndexOf('\n', start - 1) + 1;
    const lEnd   = (() => { const n = val.indexOf('\n', start); return n === -1 ? val.length : n; })();
    const line   = val.slice(lStart, lEnd);
    const stripped = line.replace(/^#{1,6} /, '');
    const newLine  = line.startsWith(prefix) ? stripped : prefix + stripped;
    UI.replaceEditorRange(lStart, lEnd, newLine, lStart, lStart + newLine.length);
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
    case 'checklist':     toggleLinePrefix('- [ ] '); break;
    case 'link': {
      const insert = sel ? `[${sel}](url)` : '[link text](url)';
      const urlStart = start + insert.indexOf('url');
      UI.replaceEditorRange(start, end, insert, urlStart, urlStart + 3);
      break;
    }
    case 'codeblock': {
      const before = start > 0 && val[start - 1] !== '\n' ? '\n' : '';
      const after  = end < val.length && val[end] !== '\n' ? '\n' : '';
      const inner  = sel || 'code here';
      const insert = `${before}\`\`\`\n${inner}\n\`\`\`${after}`;
      UI.replaceEditorRange(start, end, insert, start + before.length + 4, start + before.length + 4 + inner.length);
      break;
    }
    case 'hr': {
      const before = start > 0 && val[start - 1] !== '\n' ? '\n' : '';
      UI.replaceEditorRange(start, end, `${before}---\n`);
      break;
    }
    case 'toc': {
      const before = start > 0 && val[start - 1] !== '\n' ? '\n' : '';
      const after  = end < val.length && val[end] !== '\n' ? '\n' : '';
      UI.replaceEditorRange(start, end, `${before}[TOC]\n${after}`);
      break;
    }
  }
}

/**
 * Slash-command quick-insert menu (Write mode only — a plain <textarea>
 * gives us caret pixel coordinates via UI.getCaretViewportCoords(), the same
 * measurement cursor chat and comment margin dots already rely on; Live/Split
 * would need the CM6 equivalent wired up separately, left for later).
 */
function _filterSlashItems(query) {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_MENU_ITEMS;
  return SLASH_MENU_ITEMS.filter((it) => it.keywords.includes(q) || it.label.toLowerCase().includes(q));
}

function _closeSlashMenu() {
  if (!_slashOpen) return;
  _slashOpen = false;
  _slashStart = null;
  _slashCoords = null;
  _slashFiltered = [];
  _slashActiveIndex = 0;
  UI.hideSlashMenu();
}

function _renderSlashMenu() {
  UI.showSlashMenu(_slashCoords, _slashFiltered, _slashActiveIndex, _selectSlashItem);
}

function _openSlashMenuAt(pos) {
  const coords = UI.getCaretViewportCoords(pos);
  if (!coords) return;
  _slashOpen = true;
  _slashStart = pos;
  _slashCoords = coords;
  _slashFiltered = SLASH_MENU_ITEMS;
  _slashActiveIndex = 0;
  _renderSlashMenu();
}

function _selectSlashItem(item) {
  const editor = document.getElementById('note-editor');
  if (!editor || _slashStart == null || !item) return;
  const from = _slashStart;
  const to = editor.selectionStart;
  _closeSlashMenu();
  UI.replaceEditorRange(from, to, '');
  editor.focus();
  if (item.id === 'timestamp') UI.insertAtCursor(insertTimestamp());
  else if (item.id === 'template') _openTemplatesModalFresh();
  else _applyMarkdownFormat(item.id, editor);
}

/** Called on every editor input event; only active in Write mode. */
function _updateSlashMenu() {
  if (_markdownMode !== 'write') { _closeSlashMenu(); return; }
  const editor = document.getElementById('note-editor');
  if (!editor) { _closeSlashMenu(); return; }
  const pos = editor.selectionStart;
  if (pos !== editor.selectionEnd) { _closeSlashMenu(); return; }
  const val = editor.value;

  if (_slashOpen) {
    if (pos <= _slashStart || val[_slashStart] !== '/') { _closeSlashMenu(); return; }
    const query = val.slice(_slashStart + 1, pos);
    if (/\s/.test(query)) { _closeSlashMenu(); return; } // whitespace in the query ends the command
    _slashFiltered = _filterSlashItems(query);
    _slashActiveIndex = 0;
    _renderSlashMenu();
    return;
  }

  if (pos > 0 && val[pos - 1] === '/' && canEdit()) {
    // Only trigger at the start of a line (or start of the doc) — "and/or"
    // shouldn't pop the menu open mid-word.
    const before = pos >= 2 ? val[pos - 2] : '\n';
    if (before === '\n' || before === ' ' || before === '\t') _openSlashMenuAt(pos - 1);
  }
}

/** Handle Up/Down/Enter/Tab/Escape while the slash menu is open; returns true if the key was consumed. */
function _handleSlashMenuKeydown(e) {
  if (!_slashOpen) return false;
  if (e.key === 'ArrowDown') { e.preventDefault(); _slashActiveIndex = Math.min(_slashActiveIndex + 1, _slashFiltered.length - 1); _renderSlashMenu(); return true; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); _slashActiveIndex = Math.max(_slashActiveIndex - 1, 0); _renderSlashMenu(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const item = _slashFiltered[_slashActiveIndex];
    if (item) _selectSlashItem(item); else _closeSlashMenu();
    return true;
  }
  if (e.key === 'Escape') { e.preventDefault(); _closeSlashMenu(); return true; }
  return false;
}

function teardownRealtimeSession() {
  try { _unsubRoom?.(); } catch {}
  try { _unsubFiles?.(); } catch {}
  try { _unsubComments?.(); } catch {}
  _unsubRoom = null;
  _unsubFiles = null;
  _unsubComments = null;
  destroyPresence();
  destroyBroadcast();
  destroySync();
  UI.clearCursorChat();
  // Clear any showing "X is typing…" banner and its auto-hide timer so it
  // can never bleed into the next room's loading screen.
  UI.hideTypingIndicator();
  _followedDeviceId = null;
  _lastComments = [];
  UI.renderCommentMargin([]);
  _closeSlashMenu();
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
  // Reset in-memory mode to a safe, content-independent placeholder so the
  // loading screen never shows a stale divider (mode-split, etc.) from the
  // previous room. This is NOT the mode the next room opens into — startApp()
  // applies the user's remembered mode (_resolveInitialEditorMode()) once
  // that room's content is actually loaded, which is what the next room
  // visibly starts in.
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
    _insertTextAtActiveCursor(body);
    // The shared 'input' handler (_wireEditorCore) enforces BODY_MAX centrally.
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

    // Scrubbable time-slider: oldest → newest → "Now" (the live content),
    // reusing the same decrypted previews already computed above.
    const oldestFirst = [...withPreviews].reverse().map((rev) => ({
      label:  formatTimestamp(rev.created_at),
      text:   rev._preview,
      locked: rev._preview == null,
      rev,
    }));
    oldestFirst.push({ label: 'Now', text: UI.getEditorValue(), isNow: true });
    if (canEdit()) {
      UI.renderHistoryScrubber(oldestFirst, (entry) => _restoreRevision(entry.rev));
    } else {
      UI.renderHistoryScrubber([], null);
    }
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

// ── Comments ───────────────────────────────────────────────────────────────────

/** The selection range a new comment would attach to, in whichever surface
 *  (plain textarea or CM6 live surface) is currently active. */
function _currentSelectionRange() {
  if (_markdownMode !== 'write' && LiveEditor.isMounted()) {
    return LiveEditor.getSelection();
  }
  const editor = document.getElementById('note-editor');
  if (!editor) return null;
  return { from: editor.selectionStart, to: editor.selectionEnd };
}

async function _openCommentsPanel() {
  UI.openPanel('comments-panel');
  const range = canEdit() ? _currentSelectionRange() : null;
  const pendingAnchor = range && Number.isFinite(range.from) && Number.isFinite(range.to) ? range : null;
  const anchorPreviewText = pendingAnchor ? UI.getEditorValue().slice(pendingAnchor.from, pendingAnchor.to) : '';
  UI.setCommentComposer({
    pendingAnchor,
    anchorPreviewText,
    onSubmit: (text, anchor) => _submitComment(text, anchor),
  });
  // Only the panel-open fetch shows the loading state — _refreshComments()
  // is also called from the realtime subscription and after submit/delete,
  // where the panel already has content on screen and a loading flash would
  // just be flicker, not useful signal (same reasoning as version history's
  // setHistoryLoading, scoped to its own panel-open path for the same reason).
  UI.setCommentLoading(true);
  try {
    await _refreshComments();
  } finally {
    UI.setCommentLoading(false);
  }
}

async function _submitComment(text, anchor) {
  if (!canEdit()) { UI.showToast(editBlockedReason() || 'Editing is disabled.', 'warning'); return; }
  try {
    const payloadText = _encKey ? await encryptContent(text, _encKey) : text;
    await addComment(_roomId, { anchorFrom: anchor.from, anchorTo: anchor.to, text: payloadText });
    await _refreshComments();
    UI.showToast('Comment added.', 'success');
  } catch {
    UI.showToast('Could not add comment. Has supabase/migrations/0003_room_comments.sql been run?', 'error', 5000);
  }
}

async function _deleteCommentClick(c) {
  if (!canEdit()) { UI.showToast(editBlockedReason() || 'Editing is disabled.', 'warning'); return; }
  const ok = await UI.showConfirm('Delete this comment?', { confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await deleteComment(c.id);
    await _refreshComments();
  } catch {
    UI.showToast('Could not delete comment.', 'error');
  }
}

function _jumpToComment(c) {
  if (_markdownMode !== 'write' && LiveEditor.isMounted()) {
    LiveEditor.scrollToPos(c.anchor_from);
  } else {
    const editor = document.getElementById('note-editor');
    if (editor) { editor.focus(); UI.setEditorSelection(c.anchor_from, c.anchor_to); }
  }
  UI.closeAllPanels();
}

async function _refreshComments() {
  try {
    const comments = await listComments(_roomId);
    const currentText = UI.getEditorValue();
    const withPreviews = await Promise.all(comments.map(async (c) => {
      let preview = c.text || '';
      if (looksEncrypted(preview)) {
        if (!_encKey) { preview = null; }
        else {
          try { preview = await decryptContent(preview, _encKey); }
          catch { preview = null; }
        }
      }
      const anchorPreview = Number.isFinite(c.anchor_from) && Number.isFinite(c.anchor_to) && c.anchor_to > c.anchor_from
        ? currentText.slice(c.anchor_from, c.anchor_to)
        : null;
      return { ...c, _preview: preview, _anchorPreview: anchorPreview };
    }));
    UI.renderCommentsList(withPreviews, {
      onDelete: _deleteCommentClick,
      onJump:   _jumpToComment,
      canDelete: canEdit(),
    });
    _lastComments = withPreviews;
    LiveEditor.setCommentAnchors(withPreviews.map((c) => ({ id: c.id, from: c.anchor_from, to: c.anchor_to })));
    _refreshCommentMargin();
  } catch {
    // Best-effort — a project that hasn't run supabase/migrations/0003_room_comments.sql
    // yet just never shows any comments. See the subscribeToComments() call site.
  }
}

// ── Comment margin dots ─────────────────────────────────────────────────────
// Small markers in the editor's margin at each comment's anchor line, so
// comments are visible while scrolling instead of only discoverable via the
// side panel. Reuses the exact same offset-to-pixel machinery cursor chat
// already needed: UI.getCaretViewportCoords() (mirror-div, Write mode) and
// LiveEditor.coordsAtPos() (CM6, Preview/Split), both viewport-relative —
// converted here to .editor-wrap-relative since that's what the dots are
// positioned against (see .comment-margin-layer's CSS).

function _refreshCommentMargin() {
  const wrap = document.querySelector('.editor-wrap');
  if (!wrap || !_lastComments.length) { UI.renderCommentMargin([]); return; }

  const wrapTop = wrap.getBoundingClientRect().top;
  const live = _markdownMode !== 'write' && LiveEditor.isMounted();

  const dots = _lastComments
    .map((c) => {
      if (!Number.isFinite(c.anchor_from)) return null;
      const coords = live ? LiveEditor.coordsAtPos(c.anchor_from) : UI.getCaretViewportCoords(c.anchor_from);
      if (!coords) return null;
      return { id: c.id, y: coords.y - wrapTop, preview: c._anchorPreview || '' };
    })
    .filter(Boolean);

  UI.renderCommentMargin(dots, _jumpToCommentById);
}

function _jumpToCommentById(id) {
  const c = _lastComments.find((x) => x.id === id);
  if (c) _jumpToComment(c);
}

// ── Preview helpers ───────────────────────────────────────────────────────────

/**
 * Single entry point for every Write/Preview/Split mode change. Preview and
 * Split's right pane use the Typora-style editable CM6 surface; if it fails
 * to mount for any reason the old rendered-HTML preview is the fallback.
 */
function _applyMarkdownMode(mode) {
  // Cursor-chat bubbles/composer are positioned in viewport coordinates
  // specific to whichever surface was visible when they opened (the Write
  // textarea or the CM6 live view) — any mode switch invalidates that
  // position, so clear before switching rather than float a stale bubble.
  UI.clearCursorChat();
  _closeSlashMenu(); // Write-mode-only feature — never valid to keep open across a mode switch
  _markdownMode = mode;
  _showPreview  = mode !== 'write';
  try { localStorage.setItem(_EDITOR_MODE_KEY, mode); } catch {}

  let live = false;
  if (mode === 'preview' || mode === 'split') {
    const container = document.getElementById('note-live');
    if (container) {
      try {
        if (!LiveEditor.isMounted()) {
          LiveEditor.mount(container, UI.getEditorValue(), {
            onChange: _onLiveEditorChange,
            onCursorActivity: _onLiveCursorActivity,
            onImageFiles: (files) => { if (canEdit()) _uploadAndInsertImages(files); },
            readOnly: !canEdit(),
          });
          // CM6 persists across later mode switches (mount() is only called
          // once, guarded above), so this scroll listener only needs wiring
          // here, not on every switch into Preview/Split.
          container.querySelector('.cm-scroller')?.addEventListener('scroll', () => _refreshCommentMargin());
        } else {
          LiveEditor.syncFromText(UI.getEditorValue());
          LiveEditor.setReadOnly(!canEdit());
        }
        live = LiveEditor.isMounted();
        // setCommentAnchors() silently no-ops while unmounted, so the very
        // first mount (or a remount after room navigation) needs today's
        // comments re-applied now that there's a view to receive them —
        // _refreshComments() itself only runs on room load/realtime events,
        // neither of which necessarily follows a later mode switch.
        if (live) {
          LiveEditor.setCommentAnchors(_lastComments.map((c) => ({ id: c.id, from: c.anchor_from, to: c.anchor_to })));
        }
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

  _refreshCommentMargin();
}

// User edits in the live surface flow back through the textarea's normal
// input pipeline (save/broadcast/word count/snapshot) — the textarea stays
// the single source every other module reads.
function _onLiveEditorChange(text) {
  const editor = document.getElementById('note-editor');
  if (!editor || !canEdit()) return;
  UI.setEditorValue(text);
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

// Anchors the composer to the current caret on whichever surface is
// actually visible: the CM6 live surface (Preview/Split) via its own
// coordsAtPos(), or the plain Write-mode textarea via the mirror-div
// measurement in ui.js (LiveEditor stays mounted-but-hidden after
// switching back to Write mode, so isMounted() alone isn't enough — the
// surface has to actually be the visible one for its coordinates to mean
// anything).
function _openCursorChatComposer() {
  const live = _markdownMode !== 'write' && LiveEditor.isMounted();
  let pos, coords;
  if (live) {
    pos = LiveEditor.getCaretPos();
    coords = pos != null ? LiveEditor.coordsAtPos(pos) : null;
  } else {
    const editor = document.getElementById('note-editor');
    pos = editor ? editor.selectionStart : null;
    coords = pos != null ? UI.getCaretViewportCoords(pos) : null;
  }
  if (pos == null || !coords) return;
  UI.openCursorChatComposer(coords, (text) => {
    const id = broadcastCursorChat(text, pos);
    UI.showCursorChatBubble(
      { deviceId: getDeviceId(), deviceName: 'You', text, x: coords.x, y: coords.y, id },
      (targetId, emoji) => broadcastCursorChatReaction(targetId, emoji),
    );
  });
}

function _refreshPreviewIfActive() {
  if (_markdownMode !== 'write') UI.refreshPreview(() => renderMarkdown(UI.getEditorValue()));
}

// Debounced variant — used on every keystroke so heavy markdown docs
// (50 KB+) don't re-render on every character and cause frame drops.
const _debouncedRefreshPreview = debounce(_refreshPreviewIfActive, 300);

// Editing text above a comment's anchor shifts its offset downstream, so
// margin dots need to be recomputed after edits too — debounced for the
// same reason as preview refresh above.
const _debouncedRefreshCommentMargin = debounce(_refreshCommentMargin, 300);

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
