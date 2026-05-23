// SyncPad – dashboard.js
// Lightweight Admin / Room Tools dashboard.
//
// ⚠️  IMPORTANT SECURITY NOTICE
// These are FRONTEND-ONLY convenience controls for a personal/demo project.
// They are NOT backend-enforced. Anyone with the Supabase anon key can call
// the API directly. Do not use SyncPad for sensitive data.

import { escapeHtml, formatFileSize, formatTimestamp } from './utils.js';

const PANEL_ID = 'admin-panel';

/**
 * Open the Admin / Room Tools dashboard.
 *
 * @param {object} opts
 * @param {object}   opts.room               – current room record
 * @param {string}   opts.roomId             – room ID
 * @param {string}   opts.BASE               – base path, e.g. '/SyncPad'
 * @param {Array}    opts.files              – current file list
 * @param {Array}    opts.devices            – current presence device list
 * @param {string}   opts.myDeviceId         – local device ID
 * @param {string}   opts.myDeviceName       – local device name
 * @param {boolean}  opts.isReadOnly         – ?mode=read
 * @param {boolean}  opts.encKeyActive       – encryption enabled AND key held
 * @param {boolean}  opts.supabaseConfigured – SYNCPAD_CONFIG present
 * @param {Function} opts.onCopyEditableLink
 * @param {Function} opts.onCopyReadOnlyLink
 * @param {Function} opts.onLock             – async toggle lock
 * @param {Function} opts.onClear            – async clear note
 * @param {Function} opts.onOpenFiles        – open files panel
 * @param {Function} opts.onClose            – close dashboard
 */
export function openDashboard(opts) {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;

  const body = panel.querySelector('.panel-body');
  if (body) body.innerHTML = _buildDashboardHtml(opts);

  // Wire action buttons
  _wireButtons(panel, opts);

  // Open the panel (standard side panel pattern)
  document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
  panel.classList.add('open');
  document.getElementById('panel-backdrop')?.classList.add('visible');
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function _buildDashboardHtml(opts) {
  const { room, roomId, files, devices, myDeviceId, myDeviceName,
          isReadOnly, encKeyActive, supabaseConfigured } = opts;

  const totalSize = files.reduce((s, f) => s + (f.file_size || 0), 0);
  const locked    = !!room?.editing_locked;
  const online    = navigator.onLine !== false;

  // Detect Realtime connection via status dot class
  const statusDot = document.getElementById('status-dot');
  const rtConnected = statusDot && !statusDot.classList.contains('offline')
                   && !statusDot.classList.contains('reconnecting');

  const currentTheme = (() => {
    try { return localStorage.getItem('syncpad_theme') || 'charcoal-amber'; } catch { return 'charcoal-amber'; }
  })();

  const shortDeviceId = (myDeviceId || '').slice(0, 8);

  return `
<!-- ── Security notice ──────────────────────────────────────────────────── -->
<div class="dash-security-notice">
  <strong>⚠ Frontend convenience controls only.</strong>
  Room tools are not backend-enforced. Anyone with the Supabase anon key can
  bypass these controls. Do not store sensitive data in SyncPad.
</div>

<!-- ── Room info ─────────────────────────────────────────────────────────── -->
<section class="dash-section">
  <div class="dash-section-title">Room Info</div>
  <div class="dash-info-grid">
    ${_row('Room ID',        escapeHtml(roomId))}
    ${_row('Room name',      room?.name ? escapeHtml(room.name) : '<em>None</em>')}
    ${_row('Created',        room?.created_at ? formatTimestamp(room.created_at) : '—')}
    ${_row('Last updated',   room?.updated_at  ? formatTimestamp(room.updated_at)  : '—')}
    ${_row('Expires',        room?.expires_at  ? formatTimestamp(room.expires_at)  : 'Never')}
    ${_row('Editing locked', locked ? '<span class="dash-badge warn">Locked</span>' : '<span class="dash-badge ok">Unlocked</span>')}
    ${_row('URL mode',       isReadOnly ? '<span class="dash-badge warn">Read-only link</span>' : '<span class="dash-badge ok">Editable link</span>')}
    ${_row('Encryption',     room?.encryption_enabled ? `<span class="dash-badge warn">On${encKeyActive ? ' (key held)' : ' (no key)'}</span>` : '<span class="dash-badge ok">Off</span>')}
    ${_row('Passcode',       room?.passcode_hash ? '<span class="dash-badge warn">Set</span>' : '<span class="dash-badge ok">None</span>')}
    ${_row('View-once',      room?.view_once ? '<span class="dash-badge warn">On</span>' : '<span class="dash-badge ok">Off</span>')}
    ${room?.cleared_reason ? _row('Cleared reason', `<code>${escapeHtml(room.cleared_reason)}</code>`) : ''}
  </div>
</section>

<!-- ── Room actions ───────────────────────────────────────────────────────── -->
<section class="dash-section">
  <div class="dash-section-title">Room Actions</div>
  <div class="dash-action-grid">
    <button class="dash-btn" id="dash-copy-edit">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      Copy editable link
    </button>
    <button class="dash-btn" id="dash-copy-ro">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      Copy read-only link
    </button>
    ${!isReadOnly ? `
    <button class="dash-btn${locked ? '' : ' warn'}" id="dash-toggle-lock">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${locked ? '<path d="M5 11V7a7 7 0 0 1 14 0v4"/><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><circle cx="12" cy="16" r="1"/>' : '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/><circle cx="12" cy="16" r="1"/>'}</svg>
      ${locked ? 'Unlock editing' : 'Lock editing'}
    </button>
    <button class="dash-btn danger" id="dash-clear-note">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
      Clear note
    </button>` : ''}
  </div>
  <p class="dash-action-note">Settings (expiration, passcode, encryption, view-once) are in the Settings panel.</p>
</section>

<!-- ── File stats ────────────────────────────────────────────────────────── -->
<section class="dash-section">
  <div class="dash-section-title">File Stats</div>
  <div class="dash-info-grid">
    ${_row('Files',      String(files.length))}
    ${_row('Total size', formatFileSize(totalSize))}
  </div>
  ${files.length ? `
  <div class="dash-file-list">
    ${files.map(f => `
      <div class="dash-file-row">
        <span class="dash-file-name">${escapeHtml(f.filename)}</span>
        <span class="dash-file-size">${formatFileSize(f.file_size)}</span>
      </div>`).join('')}
  </div>` : '<p class="dash-empty">No files uploaded yet.</p>'}
  <button class="dash-btn" id="dash-open-files">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
    Open Files panel
  </button>
</section>

<!-- ── Presence diagnostics ──────────────────────────────────────────────── -->
<section class="dash-section">
  <div class="dash-section-title">Presence Diagnostics</div>
  <div class="dash-info-grid">
    ${_row('Active devices', String(devices.length))}
  </div>
  ${devices.length ? `
  <div class="dash-device-list">
    ${devices.map(d => `
      <div class="dash-device-row">
        <span class="dash-device-dot${d.read_only ? ' ro' : ''}"></span>
        <span class="dash-device-name">${escapeHtml(d.device_name || 'Unknown')}</span>
        <span class="dash-device-badges">
          ${d.device_id === myDeviceId ? '<span class="dash-badge ok">You</span>' : ''}
          ${d.read_only ? '<span class="dash-badge warn">Viewer</span>' : '<span class="dash-badge">Editor</span>'}
          ${d.typing    ? '<span class="dash-badge accent">Typing</span>' : ''}
          ${d.cursor_line ? `<span class="dash-badge muted">Line ${d.cursor_line}</span>` : ''}
        </span>
      </div>`).join('')}
  </div>` : '<p class="dash-empty">No devices connected.</p>'}
</section>

<!-- ── App diagnostics ───────────────────────────────────────────────────── -->
<section class="dash-section">
  <div class="dash-section-title">App Diagnostics</div>
  <div class="dash-info-grid">
    ${_row('Supabase configured', supabaseConfigured ? '<span class="dash-badge ok">Yes</span>' : '<span class="dash-badge danger">No</span>')}
    ${_row('Realtime',           rtConnected ? '<span class="dash-badge ok">Connected</span>' : '<span class="dash-badge warn">Disconnected</span>')}
    ${_row('Network',            online ? '<span class="dash-badge ok">Online</span>' : '<span class="dash-badge warn">Offline</span>')}
    ${_row('Theme',              escapeHtml(currentTheme))}
    ${_row('Room mode',          isReadOnly ? 'Read-only URL' : 'Editable URL')}
    ${_row('Device name',        escapeHtml(myDeviceName))}
    ${_row('Device ID (short)',  escapeHtml(shortDeviceId) + '…')}
  </div>
</section>

<!-- ── Maintenance ──────────────────────────────────────────────────────── -->
<section class="dash-section">
  <div class="dash-section-title">Maintenance</div>

  <div class="dash-maintenance-card">
    <strong>Expired room cleanup</strong>
    <p>Expired rooms are cleared automatically by a <code>pg_cron</code> job
    (if enabled in Supabase). The <code>syncpad-setup.sql</code> script includes
    a ready-made schedule. See DEPLOYMENT.md → "Scheduled cleanup".</p>
  </div>

  <div class="dash-maintenance-card">
    <strong>Storage orphan cleanup</strong>
    <p>Deleting a room removes its metadata rows (via cascade), but physical
    files in Supabase Storage are <em>not</em> automatically deleted. To clean
    orphaned storage objects:</p>
    <ol class="dash-ol">
      <li>List all <code>syncpad_files</code> metadata paths.</li>
      <li>Compare against objects listed in the <strong>syncpad-files</strong> bucket.</li>
      <li>Delete only objects with no matching metadata row.</li>
    </ol>
    <p>See README.md → "Storage Orphan Cleanup" for full instructions and
    pseudo-SQL. Always back up before deleting.</p>
  </div>
</section>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _row(label, value) {
  return `<div class="dash-row"><span class="dash-label">${escapeHtml(label)}</span><span class="dash-value">${value}</span></div>`;
}

function _wireButtons(panel, opts) {
  const { onCopyEditableLink, onCopyReadOnlyLink, onLock, onClear, onOpenFiles, onClose } = opts;

  panel.querySelector('#dash-copy-edit')?.addEventListener('click', onCopyEditableLink, { once: true });
  panel.querySelector('#dash-copy-ro')?.addEventListener('click',   onCopyReadOnlyLink,  { once: true });
  panel.querySelector('#dash-toggle-lock')?.addEventListener('click', async () => {
    await onLock?.();
    // Refresh dashboard after lock toggle
    openDashboard(opts);
  }, { once: true });
  panel.querySelector('#dash-clear-note')?.addEventListener('click', async () => {
    await onClear?.();
  }, { once: true });
  panel.querySelector('#dash-open-files')?.addEventListener('click', () => {
    panel.classList.remove('open');
    document.getElementById('panel-backdrop')?.classList.remove('visible');
    onOpenFiles?.();
  }, { once: true });

  // NOTE: .panel-close is already handled by the global wireEvents listener
  // (document.querySelectorAll('.panel-close')). We do NOT add another listener
  // here to avoid accumulating handlers on repeated dashboard opens.
}
