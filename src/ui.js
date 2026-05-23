// SyncPad – ui.js
// All DOM manipulation lives here. No business logic.
import {
  countWords, countChars, formatFileSize, fileEmoji, formatTimestamp,
  escapeHtml,
} from './utils.js';

// ── Screen management ─────────────────────────────────────────────────────────

export function showScreen(name) {
  document.getElementById('loading-screen')?.classList.toggle('hidden', name !== 'loading');
  document.getElementById('passcode-screen')?.classList.toggle('hidden', name !== 'passcode');
  document.getElementById('encryption-screen')?.classList.toggle('hidden', name !== 'encryption');
  document.getElementById('app-screen')?.classList.toggle('hidden', name !== 'app');
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

export function showRemoteNotice({ onApply, onKeep, onCopy, onDismiss } = {}) {
  const el = document.getElementById('remote-notice');
  if (!el) return;
  el.classList.remove('hidden');

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
  const el = document.getElementById('word-count');
  if (!el) return;
  const w = countWords(text);
  const c = countChars(text);
  el.textContent = `${w} word${w !== 1 ? 's' : ''} · ${c} char${c !== 1 ? 's' : ''}`;
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
    item.className = `device-item${isMe ? ' me' : ''}`;
    const roBadge = device.read_only ? ' <span class="device-role">viewer</span>' : '';
    item.innerHTML = `
      <div class="device-dot"></div>
      ${isMe
        ? `<input class="device-name-edit" value="${escapeHtml(device.device_name)}" maxlength="32" title="Edit your device name" />${roBadge}`
        : `<div class="device-name-text">${escapeHtml(device.device_name)}${device.typing ? ' <span class="device-typing">typing…</span>' : ''}${roBadge}</div>`
      }
      <div class="${isMe ? 'device-you' : ''}">${isMe ? 'You' : ''}</div>`;
    if (isMe) {
      const input = item.querySelector('.device-name-edit');
      input.addEventListener('change', () => onNameChange(input.value));
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
  const canDelete = opts.canDelete !== false;
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
        <button class="file-action-btn download" title="Download">⬇</button>
        ${canDelete ? '<button class="file-action-btn delete"   title="Delete">🗑</button>' : ''}
      </div>`;
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

const PANEL_IDS = ['tools-panel', 'files-panel', 'presence-panel', 'settings-panel'];

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
}

// ── Share modal ───────────────────────────────────────────────────────────────

export function populateShareModal({ editableUrl, readOnlyUrl, hasPasscode, hasEncryption } = {}) {
  // Editable URL row
  _wireShareRow('share-editable-text', 'share-editable-copy', editableUrl);
  _renderQr('share-editable-qr', editableUrl);

  // Read-only URL row
  _wireShareRow('share-readonly-text', 'share-readonly-copy', readOnlyUrl);
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
  _wireQrDownload('share-editable-qr-download', 'share-editable-qr');
  _wireQrDownload('share-readonly-qr-download', 'share-readonly-qr');
}

function _wireShareRow(textId, btnId, url) {
  const textEl = document.getElementById(textId);
  if (textEl) textEl.textContent = url || '';
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(url || '');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
    } catch { btn.textContent = 'Copy'; }
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

function _wireQrDownload(btnId, qrContainerId) {
  const btn = document.getElementById(btnId);
  const container = document.getElementById(qrContainerId);
  if (!btn || !container) return;
  btn.onclick = () => {
    const img = container.querySelector('img');
    const canvas = container.querySelector('canvas');
    const src = img?.src || canvas?.toDataURL?.('image/png');
    if (!src) { showToast('QR code is not ready yet.', 'warning'); return; }
    const a = document.createElement('a');
    a.href = src;
    a.download = 'syncpad-qr.png';
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
  const input = document.getElementById('file-input');
  const zone  = document.getElementById('files-upload-zone');
  if (input) {
    input.onchange = () => {
      if (input.files[0]) onFileSelected(input.files[0]);
      input.value = '';
    };
  }
  if (zone) {
    zone.onclick     = () => input?.click();
    zone.ondragover  = (e) => { e.preventDefault(); zone.classList.add('drag-over'); };
    zone.ondragleave = ()  => zone.classList.remove('drag-over');
    zone.ondrop      = (e) => {
      e.preventDefault(); zone.classList.remove('drag-over');
      const f = e.dataTransfer?.files?.[0];
      if (f) onFileSelected(f);
    };
  }
}

// ── Markdown preview ──────────────────────────────────────────────────────────

export function setPreviewMode(showPreview, renderFn) {
  const editor  = document.getElementById('note-editor');
  const preview = document.getElementById('note-preview');
  const btn     = document.getElementById('btn-preview');
  if (!editor || !preview) return;

  if (showPreview) {
    preview.innerHTML = renderFn ? renderFn() : '';
    preview.classList.remove('hidden');
    editor.classList.add('hidden');
    btn?.classList.add('active');
    btn?.setAttribute('aria-pressed', 'true');
    if (btn) btn.textContent = '✎';
    if (btn) btn.title = 'Switch to write mode';
  } else {
    preview.classList.add('hidden');
    editor.classList.remove('hidden');
    btn?.classList.remove('active');
    btn?.setAttribute('aria-pressed', 'false');
    if (btn) btn.textContent = '👁';
    if (btn) btn.title = 'Preview Markdown';
  }
}

export function refreshPreview(renderFn) {
  const preview = document.getElementById('note-preview');
  if (!preview || preview.classList.contains('hidden')) return;
  preview.innerHTML = renderFn ? renderFn() : '';
}

// ── Templates modal ──────────────────────────────────────────────────────────

export function openTemplatesModal(templates, onChoose) {
  const modal = document.getElementById('templates-modal');
  if (!modal) return;

  const body = modal.querySelector('.templates-body');
  if (!body) return;

  // Rebuild the body fresh every open. This keeps the inline choice flow
  // simple (it can replace the body without worrying about restoring it).
  body.innerHTML = '<div id="templates-list" class="templates-list"></div>';
  const list = body.querySelector('#templates-list');
  Object.entries(templates).forEach(([key, t]) => {
    const btn = document.createElement('button');
    btn.className = 'template-btn';
    btn.dataset.key = key;
    btn.innerHTML = `<span class="template-label">${escapeHtml(t.label)}</span>`;
    btn.addEventListener('click', () => _confirmTemplateInsert(key, onChoose));
    list.appendChild(btn);
  });

  // Close button (modal-close class lives in the modal header)
  modal.querySelectorAll('.templates-close').forEach((btn) => {
    btn.onclick = () => closeModal('templates-modal');
  });

  openModal('templates-modal');
}

function _confirmTemplateInsert(key, onChoose) {
  const editor = document.getElementById('note-editor');
  const hasContent = !!editor && editor.value.trim().length > 0;
  if (!hasContent) {
    closeModal('templates-modal');
    onChoose(key, 'replace');
    return;
  }
  _showInlineChoice('This note already has content. What should happen?', [
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
