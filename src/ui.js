// SyncPad – ui.js
// All DOM manipulation lives here. No business logic.
import { TEMPLATE_CATEGORY_ORDER } from './templates.js';
import {
  countWords, countChars, estimateReadingTime, formatFileSize, fileEmoji, formatTimestamp,
  escapeHtml, copyToClipboard,
} from './utils.js';
import { getIcon } from './icons.js';

let _footerClockTimer = null;
const _footerTimeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

// ── Private helpers ───────────────────────────────────────────────────────────

/** Return a human-readable "in X" string for an ISO expiry date. */
function _expiresIn(isoDate) {
  const ms = new Date(isoDate) - Date.now();
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  if (s < 120)  return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 120)  return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48)   return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

// ── Screen management ─────────────────────────────────────────────────────────

export function showScreen(name) {
  document.getElementById('landing-screen')?.classList.toggle('hidden',    name !== 'landing');
  document.getElementById('loading-screen')?.classList.toggle('hidden',    name !== 'loading');
  document.getElementById('passcode-screen')?.classList.toggle('hidden',   name !== 'passcode');
  document.getElementById('encryption-screen')?.classList.toggle('hidden', name !== 'encryption');
  document.getElementById('app-screen')?.classList.toggle('hidden',        name !== 'app');
  document.getElementById('info-screen')?.classList.toggle('hidden',       name !== 'info');
  document.getElementById('contact-screen')?.classList.toggle('hidden',    name !== 'contact');
  document.getElementById('privacy-screen')?.classList.toggle('hidden',    name !== 'privacy');
  document.getElementById('terms-screen')?.classList.toggle('hidden',      name !== 'terms');
  document.getElementById('admin-screen')?.classList.toggle('hidden',      name !== 'admin');
}

export function setInfoScreen({ title = '', message = '' } = {}) {
  const t = document.getElementById('info-title');
  const m = document.getElementById('info-message');
  if (t) t.textContent = title;
  if (m) m.textContent = message;
}

export function setLoadingMessage(msg) {
  const el = document.getElementById('loading-message');
  if (el) el.textContent = msg;
  // Hide any stale retry button when we're loading normally.
  const retryBtn = document.getElementById('loading-retry-btn');
  const spinner  = document.getElementById('loading-spinner');
  if (retryBtn) retryBtn.classList.add('hidden');
  if (spinner)  spinner.style.display = '';
}

/**
 * Switch the loading screen into an error state.
 * Shows the message, hides the spinner, and reveals the retry button.
 * @param {string} msg — error message to display
 * @param {() => void} onRetry — called when the user clicks "Try again"
 */
export function showLoadingError(msg, onRetry) {
  const msgEl    = document.getElementById('loading-message');
  const retryBtn = document.getElementById('loading-retry-btn');
  const spinner  = document.getElementById('loading-spinner');
  if (msgEl)    msgEl.textContent = msg;
  if (spinner)  spinner.style.display = 'none';
  if (retryBtn) {
    retryBtn.classList.remove('hidden');
    // Replace the old listener before adding the new one.
    retryBtn.onclick = () => {
      retryBtn.classList.add('hidden');
      if (spinner) spinner.style.display = '';
      if (onRetry) onRetry();
    };
  }
}

// ── Status indicator ──────────────────────────────────────────────────────────

const STATUS_MAP = {
  connected:    { dot: 'connected',    label: 'Connected' },
  saving:       { dot: 'saving',       label: 'Saving…' },
  saved:        { dot: 'saved',        label: 'Saved' },
  offline:      { dot: 'offline',      label: 'Offline — edits saved locally' },
  reconnecting: { dot: 'reconnecting', label: 'Reconnecting…' },
  error:        { dot: 'error',        label: 'Save failed' },
};

export function setStatus(key) {
  const s   = STATUS_MAP[key] || STATUS_MAP.connected;
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (dot)  dot.className  = `status-dot ${s.dot}`;
  if (text) text.textContent = s.label;
}

// ── Toast notifications ───────────────────────────────────────────────────────

export function showToast(message, type = '', duration = 2800) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className  = `toast${type ? ` ${type}` : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 260);
  }, duration);
}

// ── Cursor chat (Figma-style ephemeral message near a caret) ──────────────────
// Bubbles live in #cursor-chat-layer, a full-viewport fixed layer — see
// style.css. Never persisted; a bubble is just a DOM node with a timer.

const _cursorChatBubbles = new Map(); // device_id -> { el, timer }
let _cursorChatComposerEl = null;

/**
 * Open a small inline input at `{x, y}` (viewport coordinates, e.g. from
 * LiveEditor.coordsAtPos()) for composing a cursor-chat message. Only one
 * composer at a time — opening a new one discards any other in progress.
 * @param {{x:number, y:number}} coords
 * @param {(text: string) => void} onSubmit – called with the trimmed text on Enter; not called on cancel.
 */
export function openCursorChatComposer(coords, onSubmit) {
  closeCursorChatComposer();
  const layer = document.getElementById('cursor-chat-layer');
  if (!layer) return;

  const wrap = document.createElement('div');
  wrap.className = 'cursor-chat-composer';
  wrap.style.left = `${coords.x}px`;
  wrap.style.top  = `${coords.y}px`;

  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 80;
  input.placeholder = 'Say something…';
  input.setAttribute('aria-label', 'Cursor chat message');
  wrap.appendChild(input);
  layer.appendChild(wrap);
  _cursorChatComposerEl = wrap;
  input.focus();

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = input.value.trim();
      closeCursorChatComposer();
      if (text) onSubmit?.(text);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCursorChatComposer();
    }
  });
  input.addEventListener('blur', () => closeCursorChatComposer());
}

export function closeCursorChatComposer() {
  // Removing a focused input can synchronously fire its own 'blur' handler
  // (which also calls this function) before .remove() returns — null the
  // reference out first so that re-entrant call sees nothing to do, instead
  // of racing to remove the same node twice.
  const el = _cursorChatComposerEl;
  _cursorChatComposerEl = null;
  el?.remove();
}

/**
 * Show (or replace) an ephemeral cursor-chat bubble from `deviceId`, fading
 * out on its own after ~5s. A second message from the same device before
 * the first fades replaces it and resets the timer, rather than stacking.
 * @param {{deviceId: string, deviceName: string, text: string, x: number, y: number}} msg
 */
export function showCursorChatBubble({ deviceId, deviceName, text, x, y }) {
  const layer = document.getElementById('cursor-chat-layer');
  if (!layer) return;

  const existing = _cursorChatBubbles.get(deviceId);
  if (existing) { clearTimeout(existing.timer); existing.el.remove(); }

  const el = document.createElement('div');
  el.className = 'cursor-chat-bubble';
  el.style.left = `${x}px`;
  el.style.top  = `${y}px`;
  el.innerHTML = `
    <span class="cursor-chat-bubble-name">${escapeHtml(deviceName || 'Someone')}</span>
    <span class="cursor-chat-bubble-text">${escapeHtml(text)}</span>`;
  layer.appendChild(el);

  const timer = setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => { el.remove(); _cursorChatBubbles.delete(deviceId); }, 400);
  }, 5000);
  _cursorChatBubbles.set(deviceId, { el, timer });

  // The bubble itself is a purely visual, viewport-positioned element — a
  // screen reader has no way to discover it otherwise, so announce it
  // through the same live region presence typing/join events use.
  const region = document.getElementById('presence-live-region');
  if (region) region.textContent = `${deviceName || 'Someone'} says: ${text}`;
}

/** Clear every cursor-chat bubble/composer immediately — used on room navigation. */
export function clearCursorChat() {
  for (const { el, timer } of _cursorChatBubbles.values()) { clearTimeout(timer); el.remove(); }
  _cursorChatBubbles.clear();
  closeCursorChatComposer();
}

// ── Remote update notice (4 actions: Apply / Keep mine / Copy remote / Dismiss) ─

export function showRemoteNotice({ onApply, onKeep, onCopy, onDismiss, localText, remoteText, remoteTs } = {}) {
  const el = document.getElementById('remote-notice');
  if (!el) return;
  el.classList.remove('hidden');

  // Populate meta line (time)
  const metaEl = document.getElementById('remote-notice-meta');
  if (metaEl) {
    if (remoteTs) {
      const ago = _relativeTime(remoteTs);
      metaEl.textContent = ago ? `· ${ago}` : '';
    } else {
      metaEl.textContent = '';
    }
  }

  // Populate word counts
  const countsEl = document.getElementById('remote-notice-counts');
  if (countsEl) {
    const localW  = localText  != null ? countWords(localText)  : null;
    const remoteW = remoteText != null ? countWords(remoteText) : null;
    if (localW != null && remoteW != null) {
      countsEl.textContent = `Your version: ${localW} words  ·  Incoming: ${remoteW} words`;
      countsEl.classList.remove('hidden');
    } else {
      countsEl.classList.add('hidden');
    }
  }

  const wire = (id, handler) => {
    const btn = el.querySelector(`#${id}`);
    if (!btn) return;
    btn.onclick = handler || null;
    btn.classList.toggle('hidden', !handler);
  };

  wire('remote-apply-btn',   onApply);
  wire('remote-keep-btn',    onKeep);
  wire('remote-copy-btn',    onCopy);
  wire('remote-dismiss-btn', onDismiss);
}

function _relativeTime(ts) {
  if (!ts) return '';
  // ts may be a Unix ms number (from live-broadcast) or an ISO string (from DB
  // updated_at). Coerce to ms so arithmetic doesn't produce NaN.
  const msTs  = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const diffMs = Date.now() - msTs;
  if (!isFinite(diffMs) || diffMs < 0) return 'just now';
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  return `${Math.floor(diffMs / 3_600_000)}h ago`;
}

export function hideRemoteNotice() {
  document.getElementById('remote-notice')?.classList.add('hidden');
}

// ── Typing indicator ──────────────────────────────────────────────────────────

let _typingTimer = null;

export function showTypingIndicator(deviceName) {
  const el = document.getElementById('typing-indicator');
  if (!el) return;
  el.textContent = `${deviceName} is typing…`;
  el.classList.remove('hidden');
  document.getElementById('note-editor')?.classList.add('remote-typing');
  clearTimeout(_typingTimer);
  _typingTimer = setTimeout(hideTypingIndicator, 3500);
}

export function hideTypingIndicator() {
  document.getElementById('typing-indicator')?.classList.add('hidden');
  document.getElementById('note-editor')?.classList.remove('remote-typing');
}

// ── Expiration bar ────────────────────────────────────────────────────────────

let _expInterval = null;

export function showExpirationBar(expiresAt, onCancel) {
  const bar = document.getElementById('expiration-bar');
  if (!bar) return;
  bar.classList.remove('hidden');
  const cancelBtn = bar.querySelector('.exp-cancel');
  if (cancelBtn) cancelBtn.onclick = onCancel;
  clearInterval(_expInterval);

  function update() {
    const remaining = new Date(expiresAt) - Date.now();
    const timeEl = bar.querySelector('.exp-time');
    if (!timeEl) return;
    if (remaining <= 0) { timeEl.textContent = 'Expired'; clearInterval(_expInterval); return; }
    const s = Math.floor(remaining / 1000) % 60;
    const m = Math.floor(remaining / 60000) % 60;
    const h = Math.floor(remaining / 3600000);
    timeEl.textContent = h > 0
      ? `${h}h ${m}m ${String(s).padStart(2,'0')}s`
      : m > 0
        ? `${m}m ${String(s).padStart(2,'0')}s`
        : `${s}s`;
  }
  update();
  _expInterval = setInterval(update, 1000);
}

export function hideExpirationBar() {
  document.getElementById('expiration-bar')?.classList.add('hidden');
  clearInterval(_expInterval);
}

// ── Header / room info ────────────────────────────────────────────────────────

export function setRoomName({ roomId, roomName = '', canEditTitle = false } = {}) {
  const titleEl = document.getElementById('room-name');
  const pathEl = document.getElementById('room-path-label');
  const editBtn = document.getElementById('room-title-edit-btn');
  const normalizedName = (roomName || '').trim();
  const displayName = normalizedName || roomId || '';
  if (titleEl) titleEl.textContent = displayName;
  if (pathEl) {
    const showPath = !!roomId && !!normalizedName && normalizedName !== roomId;
    pathEl.textContent = `Room path: /${roomId || ''}`;
    pathEl.classList.toggle('hidden', !showPath);
  }
  if (editBtn) editBtn.classList.toggle('hidden', !canEditTitle);
}

export function setRoomTitleEditMode(editing, initialValue = '') {
  const display = document.getElementById('room-name-display');
  const editor = document.getElementById('room-title-editor');
  const input = document.getElementById('room-title-input');
  display?.classList.toggle('hidden', !!editing);
  editor?.classList.toggle('hidden', !editing);
  if (editing && input) {
    input.value = initialValue || '';
    input.focus();
    input.select();
  }
}

// ── Word / char count ─────────────────────────────────────────────────────────

export function updateWordCount(text) {
  const w = countWords(text);
  const c = countChars(text);
  const mins = estimateReadingTime(text);
  const readingLabel = mins > 0 ? ` · ${mins} min read` : '';
  const label = `${w} word${w !== 1 ? 's' : ''} · ${c} char${c !== 1 ? 's' : ''}${readingLabel}`;
  const el = document.getElementById('word-count');
  if (el) el.textContent = label;
  const tb = document.getElementById('toolbar-word-count');
  if (tb) tb.textContent = label;
}

// ── Device count ──────────────────────────────────────────────────────────────

export function updateDeviceCount(n) {
  const el = document.getElementById('device-count');
  if (el) el.textContent = `${n} connected`;
}

export function updateFooterClock() {
  const btn = document.getElementById('btn-insert-ts');
  const timeEl = document.getElementById('footer-current-time');
  if (!btn || !timeEl) return;
  const currentTime = _footerTimeFormatter.format(new Date());
  timeEl.textContent = currentTime;
  const label = `Insert timestamp, current time ${currentTime}`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

export function initFooterClock() {
  updateFooterClock();
  if (_footerClockTimer) return;
  _footerClockTimer = window.setInterval(updateFooterClock, 60_000);
}

// ── Devices list (presence panel) ─────────────────────────────────────────────

// Tracks other devices' state across renders so join/leave/started-typing
// transitions can be announced to screen readers. null means "not primed for
// this room yet" — the first render after joining seeds this without
// announcing anything, since devices already in the room aren't "joining"
// from this user's perspective. Reset on room navigation via resetPresenceAnnouncer().
let _prevDeviceStates = null;

/** Must be called on room navigation so a new room's first render doesn't
 *  announce its already-present devices as having just joined. */
export function resetPresenceAnnouncer() {
  _prevDeviceStates = null;
}

function _announcePresenceChanges(devices, myDeviceId) {
  const region = document.getElementById('presence-live-region');
  const others = devices.filter(d => d.device_id && d.device_id !== myDeviceId);
  const nextStates = new Map();

  if (_prevDeviceStates === null) {
    others.forEach(d => nextStates.set(d.device_id, { typing: !!d.typing, name: d.device_name || 'A device' }));
    _prevDeviceStates = nextStates;
    return;
  }

  const messages = [];
  others.forEach((d) => {
    const name = d.device_name || 'A device';
    const prev = _prevDeviceStates.get(d.device_id);
    // Per-keystroke cursor-line movement is deliberately not announced here —
    // only join/leave/started-typing, or a live region would fire constantly.
    if (!prev) messages.push(`${name} joined.`);
    else if (!prev.typing && d.typing) messages.push(`${name} started typing.`);
    nextStates.set(d.device_id, { typing: !!d.typing, name });
  });
  _prevDeviceStates.forEach((prev, id) => {
    if (!nextStates.has(id)) messages.push(`${prev.name} left.`);
  });

  _prevDeviceStates = nextStates;
  if (region && messages.length) region.textContent = messages.join(' ');
}

export function renderDevicesList(devices, myDeviceId, onNameChange) {
  const list = document.getElementById('devices-list');
  if (!list) return;
  _announcePresenceChanges(devices, myDeviceId);
  list.setAttribute('role', 'list');
  list.innerHTML = '';
  if (!devices.length) {
    list.innerHTML = '<div class="device-empty">No other devices connected</div>';
    return;
  }
  devices.forEach(device => {
    const isMe = device.device_id === myDeviceId;
    const item = document.createElement('div');
    item.className = `device-item${isMe ? ' me' : ''}${device.read_only ? ' viewer' : ''}${device.typing ? ' typing' : ''}`;
    item.setAttribute('role', 'listitem');
    item.dataset.deviceId = device.device_id || '';

    const roBadge = device.read_only
      ? '<span class="device-role">viewer</span>'
      : '<span class="device-role">editor</span>';

    // Activity sub-text: typing beats cursor line
    let activityHtml = '';
    if (!isMe) {
      if (device.typing) {
        activityHtml = '<span class="device-activity typing">Typing…</span>';
      } else if (Number.isFinite(device.cursor_line)) {
        // cursor_line comes from Supabase Presence, settable by any connected
        // peer with no server-side validation — type-guard it to a finite
        // number (its only legitimate shape) rather than trusting it blindly,
        // and still escape it before it reaches innerHTML.
        activityHtml = `<span class="device-activity">Near line ${escapeHtml(String(device.cursor_line))}</span>`;
      } else if (device.read_only) {
        activityHtml = '<span class="device-activity muted">Viewing</span>';
      }
    }

    item.innerHTML = `
      <div class="device-dot"></div>
      <div class="device-info">
        ${isMe
          ? `<input class="device-name device-name-edit" value="${escapeHtml(device.device_name || '')}" maxlength="32" title="Tap to rename your device" aria-label="Your device name" />`
          : `<div class="device-name device-name-text">${escapeHtml(device.device_name || 'Unknown device')}</div>`
        }
        <div class="device-meta">${roBadge}${activityHtml}</div>
      </div>
      <div class="${isMe ? 'device-you' : ''}">${isMe ? 'You' : ''}</div>`;

    if (isMe) {
      const input = item.querySelector('.device-name-edit');
      input?.addEventListener('change', () => onNameChange(input.value));
      input?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        input.blur();
      });
    }
    list.appendChild(item);
  });
}

// ── Files list ────────────────────────────────────────────────────────────────

export function renderFilesList(files, onDownload, onDelete, opts = {}) {
  const list  = document.getElementById('files-list');
  const empty = document.getElementById('files-empty');
  if (!list) return;
  list.setAttribute('role', 'list');
  list.innerHTML = '';
  if (!files?.length) { empty?.classList.remove('hidden'); return; }
  empty?.classList.add('hidden');
  const canDelete         = opts.canDelete         !== false;
  const canDownload       = opts.canDownload       !== false;
  const onPreview         = opts.onPreview         || null;
  const onCopyLink        = opts.onCopyLink        || null;
  const selectMode        = !!opts.selectMode;
  const selectedIds       = opts.selectedIds        || new Set();
  const onSelectionChange = opts.onSelectionChange  || null;
  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'file-item' + (selectMode ? ' file-item--selectable' : '');
    item.setAttribute('role', 'listitem');
    item.innerHTML = `
      ${selectMode ? `<input type="checkbox" class="file-select-cb" aria-label="Select ${escapeHtml(file.filename)}"${selectedIds.has(file.id) ? ' checked' : ''}>` : ''}
      <div class="file-emoji" aria-hidden="true">${fileEmoji(file.mime_type, file.filename)}</div>
      <div class="file-info">
        <div class="file-name">${escapeHtml(file.filename)}</div>
        <div class="file-meta">${formatFileSize(file.file_size)} · ${formatTimestamp(file.uploaded_at)}</div>
      </div>
      <div class="file-actions">
        ${(!selectMode && canDownload && onPreview) ? `<button class="file-action-btn preview" title="Preview ${escapeHtml(file.filename)}" aria-label="Preview ${escapeHtml(file.filename)}">${getIcon('eye', 15)}</button>` : ''}
        ${(!selectMode && canDownload && onCopyLink) ? `<button class="file-action-btn copy-link" title="Copy link to ${escapeHtml(file.filename)}" aria-label="Copy link to ${escapeHtml(file.filename)}">${getIcon('link', 15)}</button>` : ''}
        ${(!selectMode && canDownload) ? `<button class="file-action-btn download" title="Download ${escapeHtml(file.filename)}" aria-label="Download ${escapeHtml(file.filename)}">${getIcon('download', 15)}</button>` : ''}
        ${(!selectMode && canDelete) ? `<button class="file-action-btn delete" title="Delete ${escapeHtml(file.filename)}" aria-label="Delete ${escapeHtml(file.filename)}">${getIcon('trash', 15)}</button>` : ''}
      </div>`;
    if (selectMode && onSelectionChange) {
      const cb = item.querySelector('.file-select-cb');
      cb.addEventListener('change', () => onSelectionChange(file, cb.checked));
      // Clicking the row body also toggles the checkbox
      item.addEventListener('click', (e) => {
        if (e.target === cb) return;
        cb.checked = !cb.checked;
        onSelectionChange(file, cb.checked);
      });
    }
    if (!selectMode) {
      if (canDownload && onPreview) item.querySelector('.preview').addEventListener('click', () => onPreview(file));
      if (canDownload && onCopyLink) {
        const copyBtn = item.querySelector('.copy-link');
        copyBtn.addEventListener('click', async () => {
          copyBtn.disabled = true;
          try { await onCopyLink(file); } finally { copyBtn.disabled = false; }
        });
      }
      const dlBtn = canDownload ? item.querySelector('.download') : null;
      if (dlBtn) {
        dlBtn.addEventListener('click', async () => {
          // Briefly disable the button while the signed URL is fetched so
          // double-clicks don't fire two simultaneous download requests.
          dlBtn.disabled = true;
          try { await onDownload(file); } finally { dlBtn.disabled = false; }
        });
      }
      if (canDelete) {
        item.querySelector('.delete').addEventListener('click', () => onDelete(file));
      }
    }
    list.appendChild(item);
  });
}

export function setUploadingState(uploading, label = 'Uploading…') {
  document.getElementById('uploading-indicator')?.classList.toggle('hidden', !uploading);
  const textEl = document.getElementById('uploading-indicator-text');
  if (textEl && uploading) textEl.textContent = label;
}

// ── Version history ──────────────────────────────────────────────────────────

export function setHistoryLoading(loading) {
  document.getElementById('history-loading')?.classList.toggle('hidden', !loading);
}

/**
 * `revisions` items: { id, created_at, device_id, _preview }, where _preview
 * is the caller's already-decrypted (or plaintext) snippet — null if it
 * couldn't be decrypted (shown as a locked placeholder) — and the id is
 * passed back to onRestore untouched so the caller can look up the full
 * (still-encrypted-if-applicable) content to restore.
 */
export function renderHistoryList(revisions, onRestore, opts = {}) {
  const list  = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  if (!list) return;
  list.setAttribute('role', 'list');
  list.innerHTML = '';
  if (!revisions?.length) { empty?.classList.remove('hidden'); return; }
  empty?.classList.add('hidden');
  const canRestore = opts.canRestore !== false;
  const thisDeviceId = opts.deviceId || null;

  revisions.forEach((rev) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.setAttribute('role', 'listitem');
    const isThisDevice = thisDeviceId && rev.device_id === thisDeviceId;
    const preview = rev._preview == null
      ? '<span class="history-preview-locked">🔒 Encrypted — open with the passphrase to preview</span>'
      : escapeHtml((rev._preview || '').replace(/\s+/g, ' ').trim().slice(0, 140)) || '<span class="history-preview-empty">(empty note)</span>';
    item.innerHTML = `
      <div class="history-info">
        <div class="history-meta">${formatTimestamp(rev.created_at)}${isThisDevice ? ' · this device' : ''}</div>
        <div class="history-preview">${preview}</div>
      </div>
      <div class="history-actions">
        ${canRestore ? `<button class="history-restore-btn" title="Restore this version" aria-label="Restore version from ${escapeHtml(formatTimestamp(rev.created_at))}">${getIcon('restore', 15)}<span>Restore</span></button>` : ''}
      </div>`;
    if (canRestore) {
      item.querySelector('.history-restore-btn').addEventListener('click', () => onRestore(rev));
    }
    list.appendChild(item);
  });
}

// ── Panels ────────────────────────────────────────────────────────────────────

const PANEL_IDS = ['tools-panel', 'files-panel', 'presence-panel', 'settings-panel', 'search-panel', 'history-panel'];
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Unlike every modal dialog, side panels didn't move focus into themselves
// or trap Tab within them — a keyboard/screen-reader user opening Files or
// Settings stayed focused on whatever button they just clicked, with no
// indication focus had moved anywhere. Tracks the trap's cleanup + the
// triggering element so closeAllPanels() can tear it down and hand focus back.
let _panelFocusTrap = null;

function _panelFocusables(panel) {
  return Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter(el => el.offsetParent !== null);
}

export function openPanel(id) {
  const trigger = document.activeElement;
  closeAllPanels();
  const panel = document.getElementById(id);
  if (!panel) return;
  panel.classList.add('open');
  document.getElementById('panel-backdrop')?.classList.add('visible');

  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = _panelFocusables(panel);
    if (!items.length) return;
    const first = items[0];
    const last  = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  };
  document.addEventListener('keydown', onKey);
  _panelFocusTrap = { trigger, onKey };

  requestAnimationFrame(() => {
    const items = _panelFocusables(panel);
    (items[0] || panel).focus();
  });
}

export function closeAllPanels() {
  PANEL_IDS.forEach(p => document.getElementById(p)?.classList.remove('open'));
  document.getElementById('panel-backdrop')?.classList.remove('visible');
  if (_panelFocusTrap) {
    document.removeEventListener('keydown', _panelFocusTrap.onKey);
    const { trigger } = _panelFocusTrap;
    _panelFocusTrap = null;
    if (trigger?.focus && document.body.contains(trigger)) trigger.focus();
  }
}

export function togglePanel(id) {
  const el = document.getElementById(id);
  el?.classList.contains('open') ? closeAllPanels() : openPanel(id);
}

// ── Modals ────────────────────────────────────────────────────────────────────

export function openModal(id)  { document.getElementById(id)?.classList.add('visible'); }
export function closeModal(id) { document.getElementById(id)?.classList.remove('visible'); }
export function closeAllModals() {
  document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('visible'));
  // File preview uses .open (different backdrop class); close it here too
  document.getElementById('file-preview-modal')?.classList.remove('open');
}

// ── Share modal ───────────────────────────────────────────────────────────────

export function populateShareModal({
  editableUrl, readOnlyUrl, readOnlyError = false, hasPasscode, hasEncryption,
  roomPath = '', roomDisplayTitle = '', hasReadOnlyLink = false, isEditingLocked = false,
  hasViewOnce = false, expiresAt = null, roomCode = '', roomCodeError = false, showRoomCode = true,
} = {}) {
  const roomPathEl = document.getElementById('share-room-path');
  const titleEl = document.getElementById('share-modal-title');
  const displayTitle = (roomDisplayTitle || '').trim() || (roomPath || '').replace(/^\//, '') || 'room';
  if (titleEl) titleEl.textContent = `Share "${displayTitle}"`;
  if (roomPathEl) {
    const normalizedPath = (roomPath || '').replace(/^\//, '');
    roomPathEl.textContent = normalizedPath && normalizedPath !== displayTitle ? `Path: /${normalizedPath}` : '';
  }
  const securityNotesEl = document.getElementById('share-security-notes');
  if (securityNotesEl) {
    const chips = [];
    if (hasPasscode) chips.push('<span class="share-security-chip">Passcode required</span>');
    if (hasEncryption) chips.push('<span class="share-security-chip">Encryption passphrase required</span>');
    securityNotesEl.innerHTML = chips.join('');
    securityNotesEl.classList.toggle('hidden', chips.length === 0);
  }

  _wireShareRow({ fieldId: 'share-editable-text', copyBtnId: 'share-editable-copy', openId: 'share-editable-open', nativeBtnId: 'share-editable-native-btn', errorId: 'share-editable-error', url: editableUrl });
  _renderQr('share-editable-qr', editableUrl);
  _wireQrToggle('share-editable-qr-toggle', 'share-editable-qr-wrap', !!editableUrl);

  const readOnlyDisplay = readOnlyUrl || (readOnlyError ? 'Could not create read-only link. Check Supabase setup.' : 'Generating read-only link…');
  _wireShareRow({ fieldId: 'share-readonly-text', copyBtnId: 'share-readonly-copy', openId: 'share-readonly-open', nativeBtnId: 'share-readonly-native-btn', errorId: 'share-readonly-error', url: readOnlyUrl, displayValue: readOnlyDisplay });
  _renderQr('share-readonly-qr', readOnlyUrl);
  _wireQrToggle('share-readonly-qr-toggle', 'share-readonly-qr-wrap', !!readOnlyUrl);
  _wireQrDownload('share-editable-qr-download', 'share-editable-qr', 'syncpad-editable-qr.png');
  _wireQrDownload('share-readonly-qr-download', 'share-readonly-qr', 'syncpad-readonly-qr.png', !readOnlyUrl);

  // A read-only viewer session has no room-owning identity to generate a
  // code from (same reason it gets an empty editableUrl above) — the
  // section is hidden entirely rather than shown disabled.
  const codeSection = document.getElementById('share-code-section');
  if (codeSection) codeSection.classList.toggle('hidden', !showRoomCode);
  if (showRoomCode) {
    const codeDisplay = roomCode || (roomCodeError ? 'Could not create a short code. Check Supabase setup.' : 'Generating short code…');
    _wireShareRow({ fieldId: 'share-code-text', copyBtnId: 'share-code-copy', openId: null, nativeBtnId: null, errorId: 'share-code-error', url: roomCode, displayValue: codeDisplay });
  }
}

function _wireShareRow({ fieldId, copyBtnId, openId, nativeBtnId, errorId, url, displayValue = url }) {
  const fieldEl = document.getElementById(fieldId);
  if (fieldEl) { fieldEl.value = displayValue || ''; fieldEl.title = displayValue || ''; }
  const errorEl = document.getElementById(errorId);
  if (errorEl) { errorEl.textContent = ''; errorEl.classList.add('hidden'); }

  const openEl = document.getElementById(openId);
  if (openEl) {
    openEl.href = url || '#';
    openEl.classList.toggle('is-disabled', !url);
    openEl.setAttribute('aria-disabled', url ? 'false' : 'true');
    openEl.tabIndex = url ? 0 : -1;
  }

  const copyBtn = document.getElementById(copyBtnId);
  if (copyBtn) {
    copyBtn.disabled = !url;
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = async () => {
      if (!url) return;
      const ok = await copyToClipboard(url);
      if (ok) {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
      } else if (errorEl) {
        errorEl.textContent = 'Copy failed. Select the URL and copy manually.';
        errorEl.classList.remove('hidden');
      }
    };
  }

  _wireNativeShare(nativeBtnId, url, 'Share link');
}

function _wireQrToggle(toggleId, wrapId, enabled) {
  const toggleBtn = document.getElementById(toggleId);
  const wrap = document.getElementById(wrapId);
  if (!toggleBtn || !wrap) return;
  const allToggles = ['share-editable-qr-toggle', 'share-readonly-qr-toggle'];
  const allWraps = ['share-editable-qr-wrap', 'share-readonly-qr-wrap'];
  if (!enabled) {
    toggleBtn.classList.add('hidden');
    wrap.classList.add('hidden');
    toggleBtn.classList.remove('is-active');
    toggleBtn.setAttribute('aria-expanded', 'false');
    return;
  }
  toggleBtn.classList.remove('hidden');
  toggleBtn.classList.remove('is-active');
  toggleBtn.setAttribute('aria-expanded', 'false');
  toggleBtn.title = 'Show QR code';
  toggleBtn.setAttribute('aria-label', toggleBtn.id.includes('editable') ? 'Show QR for editable link' : 'Show QR for read-only link');
  wrap.classList.add('hidden');
  toggleBtn.onclick = () => {
    const willShow = wrap.classList.contains('hidden');
    if (willShow) {
      allWraps.forEach((id) => document.getElementById(id)?.classList.add('hidden'));
      allToggles.forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.remove('is-active');
        btn.setAttribute('aria-expanded', 'false');
        btn.title = id.includes('editable') ? 'Show QR for editable link' : 'Show QR for read-only link';
        btn.setAttribute('aria-label', btn.title);
      });
    }
    wrap.classList.toggle('hidden', !willShow);
    toggleBtn.classList.toggle('is-active', willShow);
    toggleBtn.title = willShow
      ? (toggleBtn.id.includes('editable') ? 'Hide QR for editable link' : 'Hide QR for read-only link')
      : (toggleBtn.id.includes('editable') ? 'Show QR for editable link' : 'Show QR for read-only link');
    toggleBtn.setAttribute('aria-label', toggleBtn.title);
    toggleBtn.setAttribute('aria-expanded', willShow ? 'true' : 'false');
  };
}

function _renderQr(containerId, url) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  if (!url || !window.QRCode) return;
  try {
    // Read QR colours from the active theme's CSS variables so the code adapts
    // to all seven themes rather than always using the Charcoal Amber palette.
    const cs = getComputedStyle(document.documentElement);
    const colorDark  = cs.getPropertyValue('--accent').trim()  || '#f5a623';
    const colorLight = cs.getPropertyValue('--bg-base').trim() || '#18181c';
    new window.QRCode(el, {
      text: url,
      width: 144,
      height: 144,
      colorDark,
      colorLight,
    });
  } catch {}
}

function _wireQrDownload(btnId, qrContainerId, filename, disabled = false) {
  const btn = document.getElementById(btnId);
  const container = document.getElementById(qrContainerId);
  if (!btn || !container) return;
  btn.disabled = !!disabled;
  btn.onclick = () => {
    if (disabled) return;
    const img = container.querySelector('img');
    const canvas = container.querySelector('canvas');
    const src = img?.src || canvas?.toDataURL?.('image/png');
    if (!src) { showToast('QR code is not ready yet.', 'warning'); return; }
    const a = document.createElement('a');
    a.href = src;
    a.download = filename || 'syncpad-qr.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };
}

function _wireNativeShare(btnId, url, label) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const hasNativeShare = !!navigator.share;
  const canShare = !!(hasNativeShare && url);
  btn.classList.toggle('hidden', !hasNativeShare);
  btn.disabled = !canShare;
  btn.setAttribute('aria-label', label);
  btn.title = hasNativeShare ? '' : 'Native share is not available on this device.';
  btn.onclick = () => {
    if (!canShare) return;
    navigator.share({ title: 'SyncPad', text: label, url }).catch(() => {});
  };
}

// ── Auth error helpers ────────────────────────────────────────────────────────

export function showPasscodeError(msg) {
  const el    = document.getElementById('passcode-error');
  const input = document.getElementById('passcode-input');
  if (el) el.textContent = msg;
  // Use .oninput (not addEventListener) so repeated calls never accumulate listeners.
  // The handler clears itself after firing once.
  if (input) { input.classList.add('error'); input.oninput = () => { clearPasscodeError(); input.oninput = null; }; }
}
export function clearPasscodeError() {
  const el    = document.getElementById('passcode-error');
  const input = document.getElementById('passcode-input');
  if (el) el.textContent = '';
  if (input) { input.classList.remove('error'); input.oninput = null; }
}

export function showEncryptionError(msg) {
  const el    = document.getElementById('encryption-error');
  const input = document.getElementById('encryption-input');
  if (el) el.textContent = msg;
  // Use .oninput so repeated calls never accumulate listeners.
  if (input) { input.classList.add('error'); input.oninput = () => { clearEncryptionError(); input.oninput = null; }; }
}
export function clearEncryptionError() {
  const el = document.getElementById('encryption-error');
  if (el) el.textContent = '';
  const input = document.getElementById('encryption-input');
  if (input) { input.classList.remove('error'); input.oninput = null; }
}

// ── Editor helpers ────────────────────────────────────────────────────────────

export function setEditorValue(text) {
  const editor = document.getElementById('note-editor');
  if (!editor) return;
  const start = editor.selectionStart;
  const end   = editor.selectionEnd;
  const prev  = editor.value;
  editor.value = text;
  // Cursor-preserve: only nudge if lengths are close
  if (typeof start === 'number' && Math.abs(text.length - prev.length) < 200) {
    const offset = text.length - prev.length;
    editor.selectionStart = Math.max(0, start + offset);
    editor.selectionEnd   = Math.max(0, end   + offset);
  }
}

export function getEditorValue() {
  return document.getElementById('note-editor')?.value ?? '';
}

export function focusEditor() {
  document.getElementById('note-editor')?.focus();
}

export function insertAtCursor(text) {
  const editor = document.getElementById('note-editor');
  if (!editor) return;
  if (editor.readOnly) return; // honor the readonly attribute
  const start = editor.selectionStart ?? editor.value.length;
  const end   = editor.selectionEnd   ?? start;
  editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
  editor.selectionStart = editor.selectionEnd = start + text.length;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

export function setMonospace(on) {
  document.getElementById('note-editor')?.classList.toggle('monospace', on);
  document.getElementById('note-preview')?.classList.toggle('monospace', on);
  document.getElementById('note-live')?.classList.toggle('monospace', on);
}

// ── Focus mode ───────────────────────────────────────────────────────────────
//
// A plain <textarea> has no per-paragraph DOM nodes to dim individually, so
// "dim everything but the current paragraph" is done with a CSS mask
// gradient on the textarea itself, anchored to the caret's actual pixel
// position (a fixed vertical band around it stays fully opaque, everything
// above/below fades). The caret's Y offset is measured with the standard
// "mirror div" technique — an offscreen div cloning the textarea's exact
// font/padding/wrapping, holding the text up to the caret, whose trailing
// marker's offsetTop gives the same line-wrapped position the browser
// itself would use, then adjusted by the textarea's own scroll position.

let _focusModeOn = false;

export function setFocusMode(on) {
  _focusModeOn = on;
  const editor = document.getElementById('note-editor');
  editor?.classList.toggle('focus-mode', on);
  if (on) refreshFocusMode();
}

/** Recompute the dimmed band's position — call on cursor move, scroll, input, or resize. */
export function refreshFocusMode() {
  if (!_focusModeOn) return;
  const editor = document.getElementById('note-editor');
  if (!editor) return;
  const caretY    = _measureCaretPixelY(editor);
  const visibleY  = caretY - editor.scrollTop;
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 24;
  editor.style.setProperty('--focus-y', `${visibleY + lineHeight / 2}px`);
  editor.style.setProperty('--focus-band', `${lineHeight}px`);
}

const _CARET_MIRROR_PROPS = [
  'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
  'textIndent', 'wordSpacing',
];

function _measureCaretPixelY(editor) {
  const mirror = document.createElement('div');
  const cs = getComputedStyle(editor);
  _CARET_MIRROR_PROPS.forEach((prop) => { mirror.style[prop] = cs[prop]; });
  mirror.style.position   = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap   = 'break-word';
  mirror.style.top  = '0';
  mirror.style.left = '-9999px';
  mirror.textContent = editor.value.slice(0, editor.selectionStart);
  const marker = document.createElement('span');
  marker.textContent = '.';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const y = marker.offsetTop;
  document.body.removeChild(mirror);
  return y;
}

// ── Typewriter mode ──────────────────────────────────────────────────────────
//
// Keeps the caret's line vertically centered in the editor's viewport, like
// Typora's typewriter mode. The textarea is given top/bottom padding equal
// to half its own viewport height — via the --typewriter-pad custom property,
// consumed by the .typewriter-mode rule in style.css — so that even the
// first/last line of the document can still be scrolled to center. The
// caret's pixel position reuses the same mirror-div measurement as focus
// mode (which already accounts for that padding, since the mirror clones
// the textarea's live computed style).

let _typewriterModeOn = false;

export function setTypewriterMode(on) {
  _typewriterModeOn = on;
  const editor = document.getElementById('note-editor');
  if (!editor) return;
  if (on) {
    // Measure — and set --typewriter-pad — before the class (and its
    // padding) is applied, so this first measurement reflects the editor's
    // normal un-padded box rather than being skewed by the CSS rule's own
    // fallback padding (var(--typewriter-pad, 40vh)), which briefly applies
    // once the class lands but before this property has a real value.
    editor.style.setProperty('--typewriter-pad', `${editor.clientHeight / 2}px`);
  }
  editor.classList.toggle('typewriter-mode', on);
  if (on) refreshTypewriterMode();
}

/** Recompute the centering scroll position — call on cursor move, input, or resize. */
export function refreshTypewriterMode() {
  if (!_typewriterModeOn) return;
  const editor = document.getElementById('note-editor');
  if (!editor) return;
  editor.style.setProperty('--typewriter-pad', `${editor.clientHeight / 2}px`);
  const caretY     = _measureCaretPixelY(editor);
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 24;
  const target     = caretY + lineHeight / 2 - editor.clientHeight / 2;
  editor.scrollTop = Math.max(0, target);
}

/**
 * Toggle the textarea between editable and readonly. Keeps the textarea
 * selectable (so the user can copy text in read-only mode), but blocks
 * keystrokes and input events.
 */
export function setEditorEditable(editable) {
  const editor = document.getElementById('note-editor');
  if (!editor) return;
  editor.readOnly = !editable;
  editor.classList.toggle('readonly', !editable);
}

/**
 * Sets the human-readable banner explaining why editing is blocked
 * (null hides it).
 */
export function setEditBlockedReason(reason) {
  const bar = document.getElementById('edit-blocked-bar');
  const txt = document.getElementById('edit-blocked-text');
  if (!bar || !txt) return;
  if (!reason) {
    bar.classList.add('hidden');
    txt.textContent = '';
    return;
  }
  bar.classList.remove('hidden');
  txt.textContent = reason;
}

// ── Read-only / lock indicators ──────────────────────────────────────────────

export function setReadOnlyMode(on) {
  document.body.classList.toggle('read-only-mode', !!on);
  document.getElementById('readonly-badge')?.classList.toggle('hidden', !on);
  // Hide all action buttons that have no place in read-only mode.
  document.querySelectorAll('[data-readonly-hide]').forEach((el) => {
    el.classList.toggle('hidden', !!on);
  });
}

export function setLockedMode(on) {
  document.body.classList.toggle('lock-mode', !!on);
  document.getElementById('locked-badge')?.classList.toggle('hidden', !on);
}

export function showEncryptionLockedBanner(visible, onReload) {
  const bar = document.getElementById('enc-locked-bar');
  if (!bar) return;
  bar.classList.toggle('hidden', !visible);
  const btn = bar.querySelector('.enc-locked-reload-btn');
  if (btn && onReload) btn.onclick = onReload;
}

// ── Settings panel ────────────────────────────────────────────────────────────

export function renderSettingsPanel(room) {
  const pcStatus  = document.getElementById('setting-passcode-status');
  const encStatus = document.getElementById('setting-enc-status');
  const expStatus = document.getElementById('setting-exp-status');
  const voStatus  = document.getElementById('setting-vo-status');
  const lockStatus = document.getElementById('setting-lock-status');

  if (pcStatus)  pcStatus.textContent  = room.passcode_hash      ? 'Protected'  : 'None';
  if (encStatus) encStatus.textContent = room.encryption_enabled ? 'Enabled for note text' : 'Off';
  if (expStatus) expStatus.textContent = room.expires_at
    ? `${new Date(room.expires_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} (${_expiresIn(room.expires_at)})`
    : 'Never';
  if (voStatus) {
    voStatus.textContent = !room.view_once ? 'Off'
      : room.viewed || room.cleared_reason === 'view_once' ? 'Used (cleared)'
      : 'Armed';
  }
  if (lockStatus) lockStatus.textContent = room.editing_locked ? 'Locked' : 'Unlocked';

  // Action button labels
  const pcBtn   = document.getElementById('setting-passcode-btn');
  const encBtn  = document.getElementById('setting-enc-btn');
  const expBtn  = document.getElementById('setting-exp-btn');
  const voBtn   = document.getElementById('setting-vo-btn');
  const lockBtn = document.getElementById('setting-lock-btn');

  if (pcBtn)   pcBtn.textContent   = room.passcode_hash      ? 'Remove'  : 'Set';
  if (encBtn)  encBtn.textContent  = room.encryption_enabled ? 'Disable' : 'Enable';
  // 'Modify' when an expiration is already set — the actual Remove button is
  // inside the collapsible controls section (setting-exp-remove-btn).
  if (expBtn)  expBtn.textContent  = room.expires_at         ? 'Modify'  : 'Set expiry';
  if (voBtn)   voBtn.textContent   = room.view_once          ? 'Disable' : 'Enable';
  if (lockBtn) lockBtn.textContent = room.editing_locked     ? 'Unlock'  : 'Lock';
}

// ── Offline banner ────────────────────────────────────────────────────────────

export function showOfflineBanner() {
  document.getElementById('offline-banner')?.classList.add('visible');
}
export function hideOfflineBanner() {
  document.getElementById('offline-banner')?.classList.remove('visible');
}

// ── SW update bar ─────────────────────────────────────────────────────────────

export function showUpdateBar(onUpdate) {
  const bar = document.getElementById('sw-update-bar');
  if (!bar) return;
  bar.classList.add('visible');
  // Use .onclick (idempotent re-assignment) rather than addEventListener,
  // even with {once:true} — 'updatefound' can legitimately fire more than
  // once per session, and addEventListener would stack a new listener (each
  // closing over a different `worker`) before the first ever fires.
  const btn = bar.querySelector('.sw-update-btn');
  if (btn) btn.onclick = onUpdate;
}

// ── PWA install bar ───────────────────────────────────────────────────────────

export function showInstallBar(onInstall, onDismiss) {
  const bar = document.getElementById('pwa-install-bar');
  if (!bar) return;
  bar.classList.add('visible');
  const installBtn = bar.querySelector('.install');
  if (installBtn) installBtn.onclick = onInstall;
  const dismissBtn = bar.querySelector('.dismiss');
  if (dismissBtn) {
    dismissBtn.onclick = () => { bar.classList.remove('visible'); onDismiss?.(); };
  }
}

// ── Encryption badge ──────────────────────────────────────────────────────────

export function setEncryptionBadge(visible) {
  document.getElementById('encryption-badge')?.classList.toggle('hidden', !visible);
}

export function setViewOnceBadge(visible) {
  document.getElementById('view-once-badge')?.classList.toggle('hidden', !visible);
}

export function setViewOnceConsumedPanel({
  visible = false,
  readOnly = false,
  onStartNew = null,
  onGoHome = null,
} = {}) {
  const panel = document.getElementById('view-once-consumed-panel');
  const title = document.getElementById('view-once-consumed-title');
  const msg = document.getElementById('view-once-consumed-message');
  const startBtn = document.getElementById('view-once-start-new-btn');
  const homeBtn = document.getElementById('view-once-go-home-btn');
  if (!panel || !title || !msg || !startBtn || !homeBtn) return;

  panel.classList.toggle('hidden', !visible);
  if (!visible) return;

  title.textContent = 'View-once note already viewed';
  msg.textContent = readOnly
    ? 'This read-only note has already been viewed. Ask the editable room holder to reset it if needed.'
    : 'This room’s view-once note has already been opened. You can reset this room to start a new note.';

  startBtn.classList.toggle('hidden', !!readOnly);
  startBtn.onclick = readOnly ? null : onStartNew;
  homeBtn.onclick = () => {
    onGoHome?.();
    const raw = String(window.SYNCPAD_CONFIG?.basePath ?? '/SyncPad').trim();
    const base = (!raw || raw === '/') ? '' : `/${raw.replace(/^\/+|\/+$/g, '')}`;
    window.location.href = `${base}/`;
  };
}

// ── File upload zone ──────────────────────────────────────────────────────────

/**
 * Wire all file-upload entry points (picker, upload zone drop, panel-wide
 * drop, editor-area drop). Every entry point can yield more than one file
 * (multi-select picker, multi-file drag-and-drop); onFilesSelected always
 * receives a non-empty array of File objects.
 * @param {(files: File[]) => void} onFilesSelected
 */
export function setFileHandlers(onFilesSelected) {
  const input       = document.getElementById('file-input');
  const zone        = document.getElementById('files-upload-zone');
  const panel       = document.getElementById('files-panel');
  const editorArea  = document.querySelector('.editor-area');

  if (input) {
    input.onchange = () => {
      if (input.files.length) onFilesSelected(Array.from(input.files));
      input.value = '';
    };
  }

  // Click on the upload zone opens the file picker
  if (zone) zone.onclick = () => input?.click();

  // ── Per-zone drag style (upload zone) ─────────────────────────────────────
  if (zone) {
    zone.ondragover  = (e) => { e.preventDefault(); zone.classList.add('drag-over'); };
    zone.ondragleave = ()  => zone.classList.remove('drag-over');
    zone.ondrop      = (e) => {
      e.preventDefault(); zone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) onFilesSelected(files);
    };
  }

  // ── Panel-wide drop (full files panel body) ────────────────────────────────
  // Shows an overlay across the entire panel so users can drop anywhere.
  if (panel) {
    let _dragDepth = 0;  // track enter/leave depth for nested elements
    const overlay  = _ensureDropOverlay(panel, 'Drop files here to upload');

    panel.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      _dragDepth++;
      overlay?.classList.add('visible');
    });
    panel.addEventListener('dragleave', () => {
      _dragDepth = Math.max(0, _dragDepth - 1);
      if (_dragDepth === 0) overlay?.classList.remove('visible');
    });
    panel.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      _dragDepth = 0;
      overlay?.classList.remove('visible');
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) onFilesSelected(files);
    });
  }

  // ── Editor-area drop ───────────────────────────────────────────────────────
  // Allows dropping files onto the note editor area to trigger an upload.
  if (editorArea) {
    let _edDragDepth = 0;
    const edOverlay = _ensureDropOverlay(editorArea, 'Drop files to upload to this room');

    editorArea.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      _edDragDepth++;
      edOverlay?.classList.add('visible');
    });
    editorArea.addEventListener('dragleave', () => {
      _edDragDepth = Math.max(0, _edDragDepth - 1);
      if (_edDragDepth === 0) edOverlay?.classList.remove('visible');
    });
    editorArea.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    editorArea.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      _edDragDepth = 0;
      edOverlay?.classList.remove('visible');
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) onFilesSelected(files);
    });
  }
}

/** Create (or reuse) a drop overlay element inside a container. */
function _ensureDropOverlay(container, label) {
  let overlay = container.querySelector('.drop-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'drop-overlay';
    overlay.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      <span>${label}</span>`;
    // Make the container a positioning parent if it isn't already
    const pos = getComputedStyle(container).position;
    if (pos === 'static') container.style.position = 'relative';
    container.appendChild(overlay);
  }
  return overlay;
}

// ── Markdown mode (Write / Preview / Split) ───────────────────────────────────

/**
 * Switch the editor to one of three modes.
 * @param {'write'|'preview'|'split'} mode
 * @param {Function|null} [renderFn]  – called to produce preview HTML
 */
export function setMarkdownMode(mode, renderFn, { live = false } = {}) {
  const editor   = document.getElementById('note-editor');
  const preview  = document.getElementById('note-preview');
  const livePane = document.getElementById('note-live');
  const wrap     = document.querySelector('.editor-wrap');
  if (!editor || !preview) return;

  // Clear all stale mode classes so no previous mode leaks into the next.
  // split-mode is the legacy alias — keep removing it for backward compat.
  wrap?.classList.remove('mode-write', 'mode-preview', 'mode-split', 'split-mode');
  wrap?.classList.toggle('live-preview', !!(live && livePane));

  // Update segmented control
  document.querySelectorAll('.md-seg-btn').forEach(btn => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  // In live mode the Typora-style editable surface (#note-live) takes the
  // place #note-preview held; the rendered-HTML pane stays for the non-live
  // fallback (live editor failed to load) and for export paths.
  const showPane = (pane) => {
    preview.classList.toggle('hidden',  pane !== 'preview');
    livePane?.classList.toggle('hidden', pane !== 'live');
  };

  if (mode === 'write') {
    editor.classList.remove('hidden');
    showPane(null);
    wrap?.classList.add('mode-write');
  } else if (mode === 'preview') {
    editor.classList.add('hidden');
    showPane(live && livePane ? 'live' : 'preview');
    wrap?.classList.add('mode-preview');
    if (!(live && livePane) && renderFn) { preview.innerHTML = renderFn(); _prismHighlight(preview); _injectTocNav(preview); _resolveFileImages(preview); }
  } else if (mode === 'split') {
    editor.classList.remove('hidden');
    showPane(live && livePane ? 'live' : 'preview');
    wrap?.classList.add('mode-split');
    if (!(live && livePane) && renderFn) {
      preview.innerHTML = renderFn(); _prismHighlight(preview); _injectTocNav(preview); _resolveFileImages(preview);
      _wireScrollSync(editor, preview);
    }
  }
}

// ── Pasted/dropped image resolution (preview mode) ─────────────────────────────

// Images pasted straight into the editor reference a private-bucket file path
// (see markdown.js's syncpad-file: scheme) rather than a baked-in URL, since a
// real signed URL expires in ~1h and can't just be stored in the note. Set
// once via setFileImageResolver() so every render path (preview/split modes,
// which re-render on nearly every keystroke) doesn't need its own plumbing.
let _fileImageResolver = null;

/** @param {(filePath: string) => Promise<string>} resolver */
export function setFileImageResolver(resolver) { _fileImageResolver = resolver; }

function _resolveFileImages(container) {
  if (!_fileImageResolver) return;
  container.querySelectorAll('img[data-syncpad-file]').forEach((img) => {
    const filePath = img.dataset.syncpadFile;
    if (!filePath) return;
    _fileImageResolver(filePath).then((url) => {
      img.src = url;
      img.removeAttribute('data-syncpad-file');
    }).catch(() => {
      img.classList.add('img-broken');
      img.alt = img.alt ? `${img.alt} (image unavailable)` : 'Image unavailable';
    });
  });
}

// ── Table of contents (preview mode) ──────────────────────────────────────────

// Preview re-renders on every debounced keystroke (split mode) and would
// otherwise reset an open <details> back to closed each time; remember the
// user's choice across renders instead.
let _tocOpen = false;

function _injectTocNav(preview) {
  const headings = Array.from(preview.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'));
  if (headings.length < 2) return;

  const items = headings.map((h) => {
    const level = Number(h.tagName[1]);
    return `<li class="note-toc-item note-toc-h${level}"><a href="#${h.id}">${escapeHtml(h.textContent)}</a></li>`;
  }).join('');

  const nav = document.createElement('nav');
  nav.className = 'note-toc';
  nav.setAttribute('aria-label', 'Table of contents');
  nav.innerHTML = `
    <details${_tocOpen ? ' open' : ''}>
      <summary>Contents</summary>
      <ul>${items}</ul>
    </details>`;
  nav.querySelector('details').addEventListener('toggle', (e) => { _tocOpen = e.target.open; });
  preview.insertBefore(nav, preview.firstChild);
}

// ── Scroll synchronisation (split mode) ──────────────────────────────────────
let _scrollSyncWired = false;
/** Reset the scroll-sync guard so _wireScrollSync can re-attach on the next split-mode entry.
 *  Must be called from teardownRealtimeSession so the guard doesn't persist across rooms. */
export function resetScrollSync() { _scrollSyncWired = false; }
function _wireScrollSync(editor, preview) {
  if (_scrollSyncWired) return;
  _scrollSyncWired = true;
  let _lock = false;
  editor.addEventListener('scroll', () => {
    if (_lock || preview.classList.contains('hidden')) return;
    _lock = true;
    const maxScroll = editor.scrollHeight - editor.clientHeight;
    const ratio = maxScroll > 0 ? editor.scrollTop / maxScroll : 0;
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
    requestAnimationFrame(() => { _lock = false; });
  });
  preview.addEventListener('scroll', () => {
    if (_lock || editor.classList.contains('hidden')) return;
    _lock = true;
    const maxScroll = preview.scrollHeight - preview.clientHeight;
    const ratio = maxScroll > 0 ? preview.scrollTop / maxScroll : 0;
    editor.scrollTop = ratio * (editor.scrollHeight - editor.clientHeight);
    requestAnimationFrame(() => { _lock = false; });
  });
}



export function refreshPreview(renderFn) {
  const preview = document.getElementById('note-preview');
  if (!preview || preview.classList.contains('hidden')) return;
  preview.innerHTML = renderFn ? renderFn() : '';
  if (renderFn) { _prismHighlight(preview); _injectTocNav(preview); _resolveFileImages(preview); }
}

/** Call Prism.js syntax highlighting if it is loaded. */
function _prismHighlight(container) {
  try {
    if (typeof Prism !== 'undefined') Prism.highlightAllUnder(container);
  } catch {}
}

// ── Theme picker ──────────────────────────────────────────────────────────────

/**
 * Render the theme picker in #theme-picker.
 * @param {Array<{id,label,swatch}>} themes
 * @param {string}   currentId
 * @param {Function} onSelect  – called with theme id
 */
export function renderThemePicker(themes, currentId, onSelect) {
  const container = document.getElementById('theme-picker');
  if (!container) return;
  container.innerHTML = '';
  themes.forEach(t => {
    const btn = document.createElement('button');
    const isActive = t.id === currentId;
    btn.className = `theme-option${isActive ? ' active' : ''}`;
    btn.dataset.themeId = t.id;
    btn.title = t.label;
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    // Dual-swatch: background color + accent color gives a realistic preview
    const bgColor     = escapeHtml(t.bg     || '#1c1c1e');
    const accentColor = escapeHtml(t.swatch || '#f5a623');
    btn.innerHTML = `
      <span class="theme-preview" aria-hidden="true">
        <span class="theme-preview-bg"  style="background:${bgColor}"></span>
        <span class="theme-preview-dot" style="background:${accentColor}"></span>
      </span>
      <span class="theme-label">${escapeHtml(t.label)}</span>
      <span class="theme-check">${getIcon('check', 13)}</span>`;
    btn.addEventListener('click', () => {
      onSelect(t.id);
      renderThemePicker(themes, t.id, onSelect);
    });
    container.appendChild(btn);
  });
}

// ── Templates modal ──────────────────────────────────────────────────────────

/**
 * Open the templates modal.
 * @param {object}   builtins   – TEMPLATES constant
 * @param {object}   customs    – result of getCustomTemplates()
 * @param {Function} onChoose   – (key, mode) => void
 * @param {Function} onDelete   – (key) => void
 * @param {Function} onRename   – (key, newLabel) => void
 * @param {object}   [io={}]    – optional { onExport, onImport } callbacks
 */
export function openTemplatesModal(builtins, customs, onChoose, onDelete, onRename, { onExport, onImport } = {}) {
  const modal = document.getElementById('templates-modal');
  if (!modal) return;

  let _activeTab = 'insert';

  const _render = () => {
    const body = modal.querySelector('.templates-body');
    if (!body) return;
    body.innerHTML = '';

    if (_activeTab === 'insert') {
      _renderInsertTab(body, builtins, customs, onChoose);
    } else {
      _renderCustomTab(body, customs, onDelete, onRename, _render, { onExport, onImport });
    }
  };

  // Tab wiring
  modal.querySelectorAll('.tmpl-tab').forEach(tab => {
    tab.onclick = () => {
      modal.querySelectorAll('.tmpl-tab').forEach(t => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
      _activeTab = tab.dataset.tab;
      _render();
    };
  });

  // Close buttons
  modal.querySelectorAll('.templates-close').forEach(btn => {
    btn.onclick = () => closeModal('templates-modal');
  });

  _render();
  openModal('templates-modal');
}

function _renderInsertTab(body, builtins, customs, onChoose) {
  // ── Search bar ───────────────────────────────────────────────
  const searchWrap = document.createElement('div');
  searchWrap.className = 'tmpl-search-wrap';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search templates…';
  searchInput.className = 'tmpl-search-input';
  searchInput.autocomplete = 'off';
  searchInput.setAttribute('aria-label', 'Search templates');
  searchWrap.appendChild(searchInput);
  body.appendChild(searchWrap);

  // ── Two-column layout: list + preview ────────────────────────
  const twoCol = document.createElement('div');
  twoCol.className = 'tmpl-two-col';

  const listCol = document.createElement('div');
  listCol.className = 'tmpl-list-col';

  const previewCol = document.createElement('div');
  previewCol.className = 'tmpl-preview-col';

  const previewHdr = document.createElement('div');
  previewHdr.className = 'tmpl-preview-hdr';
  previewHdr.textContent = 'Preview';

  const previewEl = document.createElement('pre');
  previewEl.className = 'tmpl-preview-body';
  previewEl.textContent = 'Select a template to preview its content.';

  previewCol.appendChild(previewHdr);
  previewCol.appendChild(previewEl);

  const showPreview = (t) => {
    const lines = (t.body || '').trimEnd();
    const LIMIT = 1200;
    previewHdr.textContent = t.label || 'Preview';
    previewEl.textContent = lines.length
      ? (lines.length > LIMIT ? lines.slice(0, LIMIT) + '\n…' : lines)
      : `(${t.desc || 'Empty template'})`;
  };

  // ── Template list with category group headers ────────────────
  const list = document.createElement('div');
  list.className = 'templates-list';
  list.setAttribute('role', 'list');

  const buildList = (filter) => {
    list.innerHTML = '';
    const f = filter.toLowerCase().trim();

    // Match against label, description, and body for deeper search
    const matchFn = (t) => !f
      || t.label.toLowerCase().includes(f)
      || (t.desc  || '').toLowerCase().includes(f)
      || (t.body  || '').toLowerCase().includes(f);

    // ── Custom templates ──────────────────────────────────────
    const customEntries = Object.entries(customs).filter(([, t]) => matchFn(t));
    if (customEntries.length) {
      const hdr = document.createElement('div');
      hdr.className = 'templates-group-label';
      hdr.textContent = 'My Templates';
      list.appendChild(hdr);
      customEntries.forEach(([key, t]) => list.appendChild(_makeTemplateBtn(key, t, onChoose, showPreview)));
    }

    // ── Built-in templates grouped by category ────────────────
    const builtinEntries = Object.entries(builtins).filter(([, t]) => matchFn(t));

    if (f) {
      // While searching, show all matches flat (no category headers) for speed
      if (builtinEntries.length) {
        if (customEntries.length) {
          const sep = document.createElement('div');
          sep.className = 'templates-group-label';
          sep.textContent = 'Built-in';
          list.appendChild(sep);
        }
        builtinEntries.forEach(([key, t]) => list.appendChild(_makeTemplateBtn(key, t, onChoose, showPreview)));
      }
    } else {
      // No filter — group by category in preferred order
      const byCategory = new Map();
      builtinEntries.forEach(([key, t]) => {
        const cat = t.category || 'Other';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat).push([key, t]);
      });

      const categoryOrder = [...TEMPLATE_CATEGORY_ORDER];
      // Add any categories not in the preferred order at the end
      for (const cat of byCategory.keys()) {
        if (!categoryOrder.includes(cat)) categoryOrder.push(cat);
      }

      for (const cat of categoryOrder) {
        const entries = byCategory.get(cat);
        if (!entries?.length) continue;
        const hdr = document.createElement('div');
        hdr.className = 'templates-group-label';
        hdr.textContent = cat;
        list.appendChild(hdr);
        entries.forEach(([key, t]) => list.appendChild(_makeTemplateBtn(key, t, onChoose, showPreview)));
      }
    }

    if (!customEntries.length && !builtinEntries.length) {
      const none = document.createElement('div');
      none.className = 'tmpl-no-results';
      none.textContent = 'No templates match your search.';
      list.appendChild(none);
    }
  };

  buildList('');
  searchInput.addEventListener('input', () => buildList(searchInput.value));

  listCol.appendChild(list);
  twoCol.appendChild(listCol);
  twoCol.appendChild(previewCol);
  body.appendChild(twoCol);

  // Focus search on open
  requestAnimationFrame(() => searchInput.focus());
}

function _renderCustomTab(body, customs, onDelete, onRename, rerender, { onExport, onImport } = {}) {
  // ── Export / Import bar ──────────────────────────────────────
  if (onExport || onImport) {
    const ioBar = document.createElement('div');
    ioBar.className = 'tmpl-io-bar';
    if (onExport) {
      const expBtn = document.createElement('button');
      expBtn.className = 'tmpl-io-btn';
      expBtn.title = 'Export all custom templates as JSON';
      expBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export JSON`;
      expBtn.disabled = Object.keys(customs).length === 0;
      expBtn.addEventListener('click', onExport);
      ioBar.appendChild(expBtn);
    }
    if (onImport) {
      const impBtn = document.createElement('button');
      impBtn.className = 'tmpl-io-btn';
      impBtn.title = 'Import templates from a JSON file';
      impBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Import JSON`;
      impBtn.addEventListener('click', onImport);
      ioBar.appendChild(impBtn);
    }
    body.appendChild(ioBar);
  }

  // ── Template list ─────────────────────────────────────────────
  const keys = Object.keys(customs);

  if (!keys.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-state-title">No custom templates yet</div>
      <div class="empty-state-sub">Use "Save current note as template" below to create one.</div>`;
    body.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'templates-list custom-templates-list';
  list.setAttribute('role', 'list');
  keys.forEach(key => {
    const t    = customs[key];
    const item = document.createElement('div');
    item.className = 'custom-template-item';
    item.setAttribute('role', 'listitem');

    const label = document.createElement('span');
    label.className = 'custom-template-label';
    label.textContent = t.label;

    const actions = document.createElement('div');
    actions.className = 'custom-template-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'custom-tmpl-btn';
    renameBtn.title = 'Rename';
    renameBtn.setAttribute('aria-label', `Rename template "${t.label}"`);
    renameBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    renameBtn.addEventListener('click', async () => {
      const newName = await showPrompt('Rename template:', { defaultValue: t.label, confirmLabel: 'Rename' });
      if (newName?.trim()) { onRename(key, newName.trim()); rerender(); }
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'custom-tmpl-btn danger';
    delBtn.title = 'Delete';
    delBtn.setAttribute('aria-label', `Delete template "${t.label}"`);
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
    delBtn.addEventListener('click', async () => {
      const ok = await showConfirm(`Delete template "${t.label}"?`, { confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      onDelete(key);
      rerender();
    });

    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);
    item.appendChild(label);
    item.appendChild(actions);
    list.appendChild(item);
  });

  body.appendChild(list);
}

function _makeTemplateBtn(key, t, onChoose, onHover) {
  const btn = document.createElement('button');
  btn.className = 'template-btn';
  btn.dataset.key = key;
  btn.setAttribute('role', 'listitem');
  btn.innerHTML = `
    <span class="template-label">${escapeHtml(t.label)}</span>
    ${t.desc ? `<span class="template-desc">${escapeHtml(t.desc)}</span>` : ''}`;
  btn.addEventListener('click', () => _confirmTemplateInsert(key, t.label, onChoose));
  if (onHover) {
    btn.addEventListener('mouseenter', () => onHover(t));
    btn.addEventListener('focus',      () => onHover(t));
  }
  return btn;
}

function _confirmTemplateInsert(key, label, onChoose) {
  const editor = document.getElementById('note-editor');
  const hasContent = !!editor && editor.value.trim().length > 0;
  if (!hasContent) {
    closeModal('templates-modal');
    onChoose(key, 'replace');
    return;
  }
  _showInlineChoice(`Apply "${escapeHtml(label)}"`, [
    { label: 'Insert at cursor', value: 'insert',  kind: 'primary',   desc: 'Add at the cursor position' },
    { label: 'Append to note',   value: 'append',  kind: '',          desc: 'Add at the end of the note' },
    { label: 'Replace note',     value: 'replace', kind: 'danger',    desc: 'Overwrite all current content' },
    { label: 'Cancel',           value: null,       kind: 'cancel',   desc: null },
  ], (choice) => { if (choice) onChoose(key, choice); });
}

function _showInlineChoice(message, choices, onPick) {
  const modal = document.getElementById('templates-modal');
  if (!modal) return;
  const body = modal.querySelector('.templates-body');
  if (!body) return;
  body.innerHTML = `
    <p class="template-choice-msg">${message}</p>
    <div class="template-choice-actions"></div>
  `;
  const actions = body.querySelector('.template-choice-actions');
  choices.forEach((c) => {
    const b = document.createElement('button');
    b.className = `template-choice-btn ${c.kind || ''}`;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'template-choice-btn-label';
    labelSpan.textContent = c.label;
    b.appendChild(labelSpan);
    if (c.desc) {
      const descSpan = document.createElement('span');
      descSpan.className = 'template-choice-btn-desc';
      descSpan.textContent = c.desc;
      b.appendChild(descSpan);
    }
    b.addEventListener('click', () => { closeModal('templates-modal'); onPick(c.value); }, { once: true });
    actions.appendChild(b);
  });
}

// ── Confirm modal ─────────────────────────────────────────────────────────────

/**
 * Show a themed confirm dialog. Returns a Promise<boolean> that resolves when
 * the user clicks Confirm (true) or Cancel/backdrop (false).
 *
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.confirmLabel='Confirm']
 * @param {string} [opts.cancelLabel='Cancel']
 * @param {boolean} [opts.danger=false]  – uses red confirm button
 */
export function showConfirm(message, { confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    _ensureConfirmModal();
    const modal      = document.getElementById('sp-confirm-modal');
    const msgEl      = document.getElementById('sp-confirm-message');
    const okBtn      = document.getElementById('sp-confirm-ok');
    const cancelBtn  = document.getElementById('sp-confirm-cancel');
    if (!modal || !msgEl || !okBtn || !cancelBtn) { resolve(false); return; }

    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    okBtn.className   = `modal-actions-btn${danger ? ' modal-btn-danger' : ' modal-btn-confirm'}`;
    cancelBtn.textContent = cancelLabel;

    const cleanup = (result) => {
      modal.classList.remove('visible');
      okBtn.onclick     = null;
      cancelBtn.onclick = null;
      modal.onclick     = null;
      document.removeEventListener('keydown', _onConfirmKey);
      resolve(result);
    };

    const _onConfirmKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      if (e.key === 'Enter'  && document.activeElement === okBtn) cleanup(true);
      // Focus trap — keep Tab cycling within the two modal buttons.
      if (e.key === 'Tab') {
        const focusables = [cancelBtn, okBtn].filter(btn => !btn.disabled);
        const first = focusables[0];
        const last  = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    };

    okBtn.onclick     = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    modal.onclick     = (e) => { if (e.target === modal) cleanup(false); };
    document.addEventListener('keydown', _onConfirmKey);

    modal.classList.add('visible');
    // Focus the safer button by default (Cancel for danger, Confirm otherwise).
    requestAnimationFrame(() => (danger ? cancelBtn : okBtn).focus());
  });
}

function _ensureConfirmModal() {
  if (document.getElementById('sp-confirm-modal')) return;
  const el = document.createElement('div');
  el.id        = 'sp-confirm-modal';
  el.className = 'modal-backdrop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'sp-confirm-message');
  el.innerHTML = `
    <div class="modal confirm-modal-inner">
      <p id="sp-confirm-message" class="confirm-modal-message"></p>
      <div class="modal-actions">
        <button id="sp-confirm-cancel" class="modal-actions-btn modal-btn-cancel"></button>
        <button id="sp-confirm-ok"     class="modal-actions-btn modal-btn-confirm"></button>
      </div>
    </div>`;
  document.body.appendChild(el);
}

// ── Alert modal ───────────────────────────────────────────────────────────────

/**
 * Show a themed single-button alert dialog. Returns a Promise<void> that
 * resolves once the user dismisses it (OK, Escape, or backdrop click).
 *
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.okLabel='OK']
 */
export function showAlert(message, { okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    _ensureAlertModal();
    const modal = document.getElementById('sp-alert-modal');
    const msgEl = document.getElementById('sp-alert-message');
    const okBtn = document.getElementById('sp-alert-ok');
    if (!modal || !msgEl || !okBtn) { resolve(); return; }

    msgEl.textContent = message;
    okBtn.textContent = okLabel;

    const cleanup = () => {
      modal.classList.remove('visible');
      okBtn.onclick = null;
      modal.onclick = null;
      document.removeEventListener('keydown', _onAlertKey);
      resolve();
    };

    const _onAlertKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); cleanup(); }
    };

    okBtn.onclick = cleanup;
    modal.onclick = (e) => { if (e.target === modal) cleanup(); };
    document.addEventListener('keydown', _onAlertKey);

    modal.classList.add('visible');
    requestAnimationFrame(() => okBtn.focus());
  });
}

function _ensureAlertModal() {
  if (document.getElementById('sp-alert-modal')) return;
  const el = document.createElement('div');
  el.id        = 'sp-alert-modal';
  el.className = 'modal-backdrop';
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'sp-alert-message');
  el.innerHTML = `
    <div class="modal confirm-modal-inner">
      <p id="sp-alert-message" class="confirm-modal-message"></p>
      <div class="modal-actions">
        <button id="sp-alert-ok" class="modal-actions-btn modal-btn-confirm"></button>
      </div>
    </div>`;
  document.body.appendChild(el);
}

// ── Prompt modal ──────────────────────────────────────────────────────────────

/**
 * Show a themed single-input prompt dialog.
 * Returns a Promise<string|null> — the raw (untrimmed) input value, or null if cancelled/empty.
 *
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.defaultValue='']
 * @param {string} [opts.placeholder='']
 * @param {string} [opts.confirmLabel='OK']
 * @param {string} [opts.cancelLabel='Cancel']
 */
export function showPrompt(message, { defaultValue = '', placeholder = '', confirmLabel = 'OK', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    _ensurePromptModal();
    const modal     = document.getElementById('sp-prompt-modal');
    const msgEl     = document.getElementById('sp-prompt-message');
    const inputEl   = document.getElementById('sp-prompt-input');
    const okBtn     = document.getElementById('sp-prompt-ok');
    const cancelBtn = document.getElementById('sp-prompt-cancel');
    if (!modal || !msgEl || !inputEl || !okBtn || !cancelBtn) { resolve(null); return; }

    msgEl.textContent      = message;
    inputEl.value          = defaultValue;
    inputEl.placeholder    = placeholder || '';
    okBtn.textContent      = confirmLabel;
    cancelBtn.textContent  = cancelLabel;

    const cleanup = (result) => {
      modal.classList.remove('visible');
      okBtn.onclick        = null;
      cancelBtn.onclick    = null;
      modal.onclick        = null;
      inputEl.onkeydown    = null;
      document.removeEventListener('keydown', _onKey);
      resolve(result);
    };

    const _onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
      // Focus trap — Tab cycles: input → cancelBtn → okBtn → input.
      if (e.key === 'Tab') {
        const focusables = [inputEl, cancelBtn, okBtn].filter(el => !el.disabled);
        const first = focusables[0];
        const last  = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    };

    inputEl.onkeydown = (e) => {
      // Return the RAW (untrimmed) value so callers that use the result as a
      // passphrase or password receive exactly what the user typed. Callers
      // that want trimmed input (template names, passcodes) call .trim() at
      // the point of use. Resolves null only when the field is truly empty.
      if (e.key === 'Enter') { e.preventDefault(); cleanup(inputEl.value || null); }
    };

    okBtn.onclick     = () => { cleanup(inputEl.value || null); };
    cancelBtn.onclick = () => cleanup(null);
    modal.onclick     = (e) => { if (e.target === modal) cleanup(null); };
    document.addEventListener('keydown', _onKey);

    modal.classList.add('visible');
    requestAnimationFrame(() => { inputEl.focus(); inputEl.select(); });
  });
}

function _ensurePromptModal() {
  if (document.getElementById('sp-prompt-modal')) return;
  const el = document.createElement('div');
  el.id        = 'sp-prompt-modal';
  el.className = 'modal-backdrop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'sp-prompt-message');
  el.innerHTML = `
    <div class="modal confirm-modal-inner">
      <p id="sp-prompt-message" class="confirm-modal-message"></p>
      <input id="sp-prompt-input" class="auth-input prompt-modal-input" />
      <div class="modal-actions">
        <button id="sp-prompt-cancel" class="modal-actions-btn modal-btn-cancel"></button>
        <button id="sp-prompt-ok"     class="modal-actions-btn modal-btn-confirm"></button>
      </div>
    </div>`;
  document.body.appendChild(el);
}
