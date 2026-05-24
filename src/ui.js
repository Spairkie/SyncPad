// SyncPad – ui.js
// All DOM manipulation lives here. No business logic.
import {
  countWords, countChars, formatFileSize, fileEmoji, formatTimestamp,
  escapeHtml,
} from './utils.js';
import { getIcon } from './icons.js';

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
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'just now';
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

export function setRoomName(name) {
  const el = document.getElementById('room-name');
  if (el) el.textContent = name;
}

// ── Word / char count ─────────────────────────────────────────────────────────

export function updateWordCount(text) {
  const w = countWords(text);
  const c = countChars(text);
  const label = `${w} word${w !== 1 ? 's' : ''} · ${c} char${c !== 1 ? 's' : ''}`;
  const el = document.getElementById('word-count');
  if (el) el.textContent = label;
  const tb = document.getElementById('toolbar-word-count');
  if (tb) tb.textContent = label;
}

// ── Device count ──────────────────────────────────────────────────────────────

export function updateDeviceCount(n) {
  const el = document.getElementById('device-count');
  if (el) el.textContent = n;
}

// ── Devices list (presence panel) ─────────────────────────────────────────────

export function renderDevicesList(devices, myDeviceId, onNameChange) {
  const list = document.getElementById('devices-list');
  if (!list) return;
  list.innerHTML = '';
  devices.forEach(device => {
    const isMe = device.device_id === myDeviceId;
    const item = document.createElement('div');
    item.className = `device-item${isMe ? ' me' : ''}${device.read_only ? ' viewer' : ''}${device.typing ? ' typing' : ''}`;
    item.dataset.deviceId = device.device_id || '';

    const roBadge = device.read_only
      ? '<span class="device-role">viewer</span>'
      : '<span class="device-role">editor</span>';

    // Activity sub-text: typing beats cursor line
    let activityHtml = '';
    if (!isMe) {
      if (device.typing) {
        activityHtml = '<span class="device-activity typing">Typing…</span>';
      } else if (device.cursor_line != null) {
        activityHtml = `<span class="device-activity">Near line ${device.cursor_line}</span>`;
      } else if (device.read_only) {
        activityHtml = '<span class="device-activity muted">Viewing</span>';
      }
    }

    item.innerHTML = `
      <div class="device-dot"></div>
      <div class="device-info">
        ${isMe
          ? `<input class="device-name device-name-edit" value="${escapeHtml(device.device_name)}" maxlength="32" title="Tap to rename your device" aria-label="Your device name" />`
          : `<div class="device-name device-name-text">${escapeHtml(device.device_name)}</div>`
        }
        <div class="device-meta">${roBadge}${activityHtml}</div>
      </div>
      <div class="${isMe ? 'device-you' : ''}">${isMe ? 'You' : ''}</div>`;

    if (isMe) {
      const input = item.querySelector('.device-name-edit');
      input?.addEventListener('change', () => onNameChange(input.value));
    }
    list.appendChild(item);
  });
}

// ── Files list ────────────────────────────────────────────────────────────────

export function renderFilesList(files, onDownload, onDelete, opts = {}) {
  const list  = document.getElementById('files-list');
  const empty = document.getElementById('files-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!files?.length) { empty?.classList.remove('hidden'); return; }
  empty?.classList.add('hidden');
  const canDelete  = opts.canDelete  !== false;
  const onPreview  = opts.onPreview  || null;
  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
      <div class="file-emoji">${fileEmoji(file.mime_type, file.filename)}</div>
      <div class="file-info">
        <div class="file-name">${escapeHtml(file.filename)}</div>
        <div class="file-meta">${formatFileSize(file.file_size)} · ${formatTimestamp(file.uploaded_at)}</div>
      </div>
      <div class="file-actions">
        ${onPreview ? `<button class="file-action-btn preview" title="Preview">${getIcon('eye', 15)}</button>` : ''}
        <button class="file-action-btn download" title="Download">${getIcon('download', 15)}</button>
        ${canDelete ? `<button class="file-action-btn delete" title="Delete">${getIcon('trash', 15)}</button>` : ''}
      </div>`;
    if (onPreview) item.querySelector('.preview').addEventListener('click', () => onPreview(file));
    item.querySelector('.download').addEventListener('click', () => onDownload(file));
    if (canDelete) {
      item.querySelector('.delete').addEventListener('click', () => onDelete(file));
    }
    list.appendChild(item);
  });
}

export function setUploadingState(uploading) {
  document.getElementById('uploading-indicator')?.classList.toggle('hidden', !uploading);
}

// ── Panels ────────────────────────────────────────────────────────────────────

const PANEL_IDS = ['tools-panel', 'files-panel', 'presence-panel', 'settings-panel', 'search-panel', 'admin-panel'];

export function openPanel(id) {
  closeAllPanels();
  document.getElementById(id)?.classList.add('open');
  document.getElementById('panel-backdrop')?.classList.add('visible');
}

export function closeAllPanels() {
  PANEL_IDS.forEach(p => document.getElementById(p)?.classList.remove('open'));
  document.getElementById('panel-backdrop')?.classList.remove('visible');
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

export function populateShareModal({ editableUrl, readOnlyUrl, readOnlyError = false, hasPasscode, hasEncryption } = {}) {
  // Editable URL row
  _wireShareRow('share-editable-text', 'share-editable-copy', editableUrl);
  _renderQr('share-editable-qr', editableUrl);

  // Read-only URL row
  const readOnlyDisplay = readOnlyUrl || (readOnlyError ? 'Could not create read-only link. Check Supabase setup.' : '');
  _wireShareRow('share-readonly-text', 'share-readonly-copy', readOnlyUrl, readOnlyDisplay);
  _renderQr('share-readonly-qr', readOnlyUrl);

  // Warnings
  document.getElementById('share-passcode-notice')?.classList.toggle('hidden', !hasPasscode);
  document.getElementById('share-encryption-notice')?.classList.toggle('hidden', !hasEncryption);

  // Native share
  const nativeBtn = document.getElementById('share-native-btn');
  if (nativeBtn) {
    if (navigator.share) {
      nativeBtn.classList.remove('hidden');
      nativeBtn.onclick = () => navigator.share({ title: 'SyncPad', url: editableUrl }).catch(() => {});
    } else {
      nativeBtn.classList.add('hidden');
    }
  }

  // QR-download buttons
  _wireQrDownload('share-editable-qr-download', 'share-editable-qr', 'syncpad-editable-qr.png');
  _wireQrDownload('share-readonly-qr-download', 'share-readonly-qr', 'syncpad-readonly-qr.png', !readOnlyUrl);
}

function _wireShareRow(textId, btnId, url, displayValue = url) {
  const textEl = document.getElementById(textId);
  if (textEl) textEl.textContent = displayValue || '';
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = !url;
  btn.onclick = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url || '');
      showToast('Link copied to clipboard.', 'success');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    } catch {
      btn.textContent = 'Copy';
    }
  };
}

function _renderQr(containerId, url) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  if (!url || !window.QRCode) return;
  try {
    new window.QRCode(el, {
      text:       url,
      width:      144,
      height:     144,
      colorDark:  '#f5a623',
      colorLight: '#18181c',
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

// ── Auth error helpers ────────────────────────────────────────────────────────

export function showPasscodeError(msg) {
  const el = document.getElementById('passcode-error');
  if (el) el.textContent = msg;
  document.getElementById('passcode-input')?.classList.add('error');
}
export function clearPasscodeError() {
  const el = document.getElementById('passcode-error');
  if (el) el.textContent = '';
  document.getElementById('passcode-input')?.classList.remove('error');
}

export function showEncryptionError(msg) {
  const el = document.getElementById('encryption-error');
  if (el) el.textContent = msg;
  document.getElementById('encryption-input')?.classList.add('error');
}
export function clearEncryptionError() {
  const el = document.getElementById('encryption-error');
  if (el) el.textContent = '';
  document.getElementById('encryption-input')?.classList.remove('error');
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
  const btn = document.getElementById('tool-monospace');
  const label = btn?.querySelector('.tool-label');
  if (label) label.textContent = on ? 'Monospace ✓' : 'Monospace';
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
    ? new Date(room.expires_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
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
  if (expBtn)  expBtn.textContent  = room.expires_at         ? 'Remove'  : 'Set';
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
  bar.querySelector('.sw-update-btn')?.addEventListener('click', onUpdate, { once: true });
}

// ── PWA install bar ───────────────────────────────────────────────────────────

export function showInstallBar(onInstall, onDismiss) {
  const bar = document.getElementById('pwa-install-bar');
  if (!bar) return;
  bar.classList.add('visible');
  bar.querySelector('.install')?.addEventListener('click', onInstall, { once: true });
  bar.querySelector('.dismiss')?.addEventListener('click', () => {
    bar.classList.remove('visible'); onDismiss?.();
  }, { once: true });
}

// ── Encryption badge ──────────────────────────────────────────────────────────

export function setEncryptionBadge(visible) {
  document.getElementById('encryption-badge')?.classList.toggle('hidden', !visible);
}

// ── File upload zone ──────────────────────────────────────────────────────────

export function setFileHandlers(onFileSelected) {
  const input       = document.getElementById('file-input');
  const zone        = document.getElementById('files-upload-zone');
  const panel       = document.getElementById('files-panel');
  const editorArea  = document.querySelector('.editor-area');

  if (input) {
    input.onchange = () => {
      if (input.files[0]) onFileSelected(input.files[0]);
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
      const f = e.dataTransfer?.files?.[0];
      if (f) onFileSelected(f);
    };
  }

  // ── Panel-wide drop (full files panel body) ────────────────────────────────
  // Shows an overlay across the entire panel so users can drop anywhere.
  if (panel) {
    let _dragDepth = 0;  // track enter/leave depth for nested elements
    const overlay  = _ensureDropOverlay(panel, 'Drop file here to upload');

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
      const f = e.dataTransfer?.files?.[0];
      if (f) onFileSelected(f);
    });
  }

  // ── Editor-area drop ───────────────────────────────────────────────────────
  // Allows dropping a file onto the note editor area to trigger an upload.
  if (editorArea) {
    let _edDragDepth = 0;
    const edOverlay = _ensureDropOverlay(editorArea, 'Drop file to upload to this room');

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
      const f = e.dataTransfer?.files?.[0];
      if (f) onFileSelected(f);
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
export function setMarkdownMode(mode, renderFn) {
  const editor  = document.getElementById('note-editor');
  const preview = document.getElementById('note-preview');
  const wrap    = document.querySelector('.editor-wrap');
  if (!editor || !preview) return;

  // Update segmented control
  document.querySelectorAll('.md-seg-btn').forEach(btn => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  if (mode === 'write') {
    editor.classList.remove('hidden');
    preview.classList.add('hidden');
    wrap?.classList.remove('split-mode');
  } else if (mode === 'preview') {
    editor.classList.add('hidden');
    preview.classList.remove('hidden');
    wrap?.classList.remove('split-mode');
    if (renderFn) preview.innerHTML = renderFn();
  } else if (mode === 'split') {
    editor.classList.remove('hidden');
    preview.classList.remove('hidden');
    wrap?.classList.add('split-mode');
    if (renderFn) preview.innerHTML = renderFn();
  }
}

/** Backward-compatible shim — delegates to setMarkdownMode. */
export function setPreviewMode(showPreview, renderFn) {
  setMarkdownMode(showPreview ? 'preview' : 'write', renderFn);
}

export function refreshPreview(renderFn) {
  const preview = document.getElementById('note-preview');
  if (!preview || preview.classList.contains('hidden')) return;
  preview.innerHTML = renderFn ? renderFn() : '';
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
    btn.className = `theme-option${t.id === currentId ? ' active' : ''}`;
    btn.dataset.themeId = t.id;
    btn.title = t.label;
    btn.innerHTML = `
      <span class="theme-swatch" style="background:${escapeHtml(t.swatch)}"></span>
      <span class="theme-label">${escapeHtml(t.label)}</span>
      <span class="theme-check" style="opacity:${t.id === currentId ? 1 : 0}">
        ${getIcon('check', 13)}
      </span>`;
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
 * @param {object} builtins   – TEMPLATES constant
 * @param {object} customs    – result of getCustomTemplates()
 * @param {Function} onChoose – (key, mode) => void
 * @param {Function} onDelete – (key) => void  – called when user deletes a custom template
 * @param {Function} onRename – (key, newLabel) => void
 */
export function openTemplatesModal(builtins, customs, onChoose, onDelete, onRename) {
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
      _renderCustomTab(body, customs, onDelete, onRename, _render);
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
  const list = document.createElement('div');
  list.className = 'templates-list';

  const hasCustom = Object.keys(customs).length > 0;
  if (hasCustom) {
    const header = document.createElement('div');
    header.className = 'templates-group-label';
    header.textContent = 'My Templates';
    list.appendChild(header);
    Object.entries(customs).forEach(([key, t]) => {
      list.appendChild(_makeTemplateBtn(key, t, onChoose));
    });
    const sep = document.createElement('div');
    sep.className = 'templates-group-label';
    sep.textContent = 'Built-in';
    list.appendChild(sep);
  }

  Object.entries(builtins).forEach(([key, t]) => {
    list.appendChild(_makeTemplateBtn(key, t, onChoose));
  });

  body.appendChild(list);
}

function _renderCustomTab(body, customs, onDelete, onRename, rerender) {
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
  keys.forEach(key => {
    const t    = customs[key];
    const item = document.createElement('div');
    item.className = 'custom-template-item';

    const label = document.createElement('span');
    label.className = 'custom-template-label';
    label.textContent = t.label;

    const actions = document.createElement('div');
    actions.className = 'custom-template-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'custom-tmpl-btn';
    renameBtn.title = 'Rename';
    renameBtn.setAttribute('aria-label', 'Rename template');
    renameBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    renameBtn.addEventListener('click', () => {
      const newName = prompt('Rename template:', t.label);
      if (newName?.trim()) { onRename(key, newName.trim()); rerender(); }
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'custom-tmpl-btn danger';
    delBtn.title = 'Delete';
    delBtn.setAttribute('aria-label', 'Delete template');
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
    delBtn.addEventListener('click', () => {
      if (!confirm(`Delete template "${t.label}"?`)) return;
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

function _makeTemplateBtn(key, t, onChoose) {
  const btn = document.createElement('button');
  btn.className = 'template-btn';
  btn.dataset.key = key;
  btn.innerHTML = `<span class="template-label">${escapeHtml(t.label)}</span>`;
  btn.addEventListener('click', () => _confirmTemplateInsert(key, t.label, onChoose));
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
  _showInlineChoice(`Apply "${label}"?`, [
    { label: 'Replace note', value: 'replace', kind: 'danger' },
    { label: 'Append',       value: 'append',  kind: 'primary' },
    { label: 'Cancel',       value: null,      kind: 'cancel' },
  ], (choice) => { if (choice) onChoose(key, choice); });
}

function _showInlineChoice(message, choices, onPick) {
  const modal = document.getElementById('templates-modal');
  if (!modal) return;
  const body = modal.querySelector('.templates-body');
  if (!body) return;
  body.innerHTML = `
    <p class="template-choice-msg">${escapeHtml(message)}</p>
    <div class="template-choice-actions"></div>
  `;
  const actions = body.querySelector('.template-choice-actions');
  choices.forEach((c) => {
    const b = document.createElement('button');
    b.textContent = c.label;
    b.className = `template-choice-btn ${c.kind || ''}`;
    b.addEventListener('click', () => { closeModal('templates-modal'); onPick(c.value); }, { once: true });
    actions.appendChild(b);
  });
}
