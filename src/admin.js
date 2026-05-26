// SyncPad – admin.js
// Admin dashboard: auth gate, room management, reports, cleanup.
// All data access is gated by Supabase RLS (is_syncpad_admin() function).

import { getSupabaseClient } from './supabase.js';
import { escapeHtml, formatFileSize, formatTimestamp } from './utils.js';

// ── Entry point ───────────────────────────────────────────────────────────────

export async function initAdmin() {
  const sb = getSupabaseClient();
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    await _renderDashboard(sb);
  } else {
    _renderLogin(sb);
  }
}

// ── Login form ────────────────────────────────────────────────────────────────

function _renderLogin(sb) {
  const screen = document.getElementById('admin-screen');
  screen.innerHTML = `
    <div class="admin-login-wrap">
      <div class="auth-card" style="max-width:360px">
        <div class="auth-card-icon">🔐</div>
        <h2>Admin Sign In</h2>
        <p>Sign in with your admin account to access the dashboard.</p>
        <input id="admin-email" class="auth-input" type="email" placeholder="Email" autocomplete="email" />
        <input id="admin-password" class="auth-input" type="password" placeholder="Password" autocomplete="current-password" style="margin-top:10px" />
        <div id="admin-login-error" style="font-size:12px;color:var(--red);margin-top:6px;min-height:16px"></div>
        <button id="admin-login-btn" class="auth-btn" style="margin-top:14px">Sign in</button>
        <button onclick="window.location.href='/SyncPad/'" class="auth-btn" style="margin-top:10px;background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border)">Back to SyncPad</button>
      </div>
    </div>
  `;

  const emailEl    = document.getElementById('admin-email');
  const passwordEl = document.getElementById('admin-password');
  const errorEl    = document.getElementById('admin-login-error');
  const loginBtn   = document.getElementById('admin-login-btn');

  async function doLogin() {
    const email    = emailEl.value.trim();
    const password = passwordEl.value;
    if (!email || !password) {
      errorEl.textContent = 'Please enter your email and password.';
      return;
    }
    loginBtn.disabled  = true;
    loginBtn.textContent = 'Signing in…';
    errorEl.textContent  = '';

    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      errorEl.textContent    = error.message || 'Sign-in failed. Please try again.';
      loginBtn.disabled      = false;
      loginBtn.textContent   = 'Sign in';
      return;
    }
    await _renderDashboard(sb);
  }

  loginBtn.addEventListener('click', doLogin);
  passwordEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  emailEl.addEventListener('keydown',    (e) => { if (e.key === 'Enter') passwordEl.focus(); });
}

// ── Dashboard shell ───────────────────────────────────────────────────────────

async function _renderDashboard(sb) {
  const { data: { session } } = await sb.auth.getSession();
  const userEmail = session?.user?.email ?? '';

  const screen = document.getElementById('admin-screen');
  screen.innerHTML = `
    <div class="admin-shell">
      <div class="admin-header">
        <div class="admin-header-brand">🛠️ SyncPad Admin</div>
        <div class="admin-header-actions">
          <span id="admin-user-email" class="admin-user-email">${escapeHtml(userEmail)}</span>
          <button id="admin-logout-btn" class="admin-logout-btn">Sign out</button>
        </div>
      </div>

      <div class="admin-stats-row" id="admin-stats-row">
        <div class="admin-stat-card">
          <div class="admin-stat-value" id="stat-rooms">—</div>
          <div class="admin-stat-label">Total rooms</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-value" id="stat-files">—</div>
          <div class="admin-stat-label">Files</div>
        </div>
        <div class="admin-stat-card admin-stat-card--alert" id="stat-reports-card">
          <div class="admin-stat-value" id="stat-reports">—</div>
          <div class="admin-stat-label">Open reports</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-value" id="stat-expired">—</div>
          <div class="admin-stat-label">Expired rooms</div>
        </div>
      </div>

      <div class="admin-tabs">
        <button class="admin-tab active" data-tab="rooms">Rooms</button>
        <button class="admin-tab" data-tab="reports">Reports</button>
        <button class="admin-tab" data-tab="cleanup">Cleanup</button>
      </div>

      <div class="admin-content" id="admin-content"></div>
    </div>
  `;

  // Logout
  document.getElementById('admin-logout-btn').addEventListener('click', async () => {
    await sb.auth.signOut();
    initAdmin();
  });

  // Tabs
  const tabs      = document.querySelectorAll('.admin-tab');
  const contentEl = document.getElementById('admin-content');
  let   activeTab = 'rooms';

  async function switchTab(tab) {
    activeTab = tab;
    tabs.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
    contentEl.innerHTML = '<div class="admin-loading">Loading…</div>';
    if (tab === 'rooms')   await _renderRoomsTab(sb, contentEl);
    if (tab === 'reports') await _renderReportsTab(sb, contentEl);
    if (tab === 'cleanup') await _renderCleanupTab(sb, contentEl);
  }

  tabs.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  // Load stats and initial tab in parallel
  await Promise.all([
    _loadStats(sb),
    switchTab('rooms'),
  ]);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

async function _loadStats(sb) {
  const [roomsRes, filesRes, reportsRes, expiredRes] = await Promise.allSettled([
    sb.from('syncpad_rooms').select('*', { count: 'exact', head: true }),
    sb.from('syncpad_files').select('*', { count: 'exact', head: true }),
    sb.from('syncpad_room_reports').select('*', { count: 'exact', head: true }).eq('status', 'new'),
    sb.from('syncpad_rooms').select('*', { count: 'exact', head: true })
      .lt('expires_at', new Date().toISOString())
      .not('expires_at', 'is', null),
  ]);

  const get = (res) => res.status === 'fulfilled' ? (res.value.count ?? '—') : '—';

  const statRooms    = document.getElementById('stat-rooms');
  const statFiles    = document.getElementById('stat-files');
  const statReports  = document.getElementById('stat-reports');
  const statExpired  = document.getElementById('stat-expired');

  if (statRooms)   statRooms.textContent   = get(roomsRes);
  if (statFiles)   statFiles.textContent   = get(filesRes);
  if (statReports) statReports.textContent = get(reportsRes);
  if (statExpired) statExpired.textContent  = get(expiredRes);

  // Highlight reports card when count > 0
  const reportCount = reportsRes.status === 'fulfilled' ? (reportsRes.value.count ?? 0) : 0;
  const reportCard  = document.getElementById('stat-reports-card');
  if (reportCard) {
    reportCard.classList.toggle('admin-stat-card--has-alerts', reportCount > 0);
  }
}

// ── Rooms tab ─────────────────────────────────────────────────────────────────

async function _renderRoomsTab(sb, contentEl) {
  const { data: rooms, error } = await sb
    .from('syncpad_rooms')
    .select('room_id, room_name, updated_at, encryption_enabled, passcode_hash, view_once, expires_at, content')
    .order('updated_at', { ascending: false })
    .limit(50);

  if (error) {
    contentEl.innerHTML = _accessDeniedHtml(error);
    return;
  }

  contentEl.innerHTML = `
    <div class="admin-tab-content">
      <div class="admin-toolbar">
        <input id="admin-room-search" class="admin-search-input" placeholder="Search by room ID or name…" />
        <span class="admin-count-label" id="admin-room-count">${rooms.length} room${rooms.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table" id="admin-rooms-table">
          <thead>
            <tr>
              <th>Room ID / Name</th>
              <th>Updated</th>
              <th>Flags</th>
              <th>Content</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="admin-rooms-tbody"></tbody>
        </table>
        <div id="admin-rooms-empty" class="admin-empty hidden">No rooms match your search.</div>
      </div>
    </div>
  `;

  const tbody     = document.getElementById('admin-rooms-tbody');
  const searchEl  = document.getElementById('admin-room-search');
  const countEl   = document.getElementById('admin-room-count');
  const emptyEl   = document.getElementById('admin-rooms-empty');

  function buildFlags(room) {
    const flags = [];
    if (room.encryption_enabled) flags.push('<span class="admin-badge admin-badge--enc" title="Encrypted">ENC</span>');
    if (room.passcode_hash)      flags.push('<span class="admin-badge admin-badge--pass" title="Passcode protected">PASS</span>');
    if (room.view_once)          flags.push('<span class="admin-badge admin-badge--once" title="View once">1×</span>');
    if (_isExpired(room.expires_at)) flags.push('<span class="admin-badge admin-badge--exp" title="Expired">EXP</span>');
    return flags.join(' ') || '<span class="admin-muted">—</span>';
  }

  function renderRows(filter) {
    const q = (filter || '').toLowerCase().trim();
    const filtered = q
      ? rooms.filter(r =>
          (r.room_id   || '').toLowerCase().includes(q) ||
          (r.room_name || '').toLowerCase().includes(q)
        )
      : rooms;

    countEl.textContent = `${filtered.length} room${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      tbody.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    tbody.innerHTML = filtered.map(room => {
      const contentPreview = room.content
        ? escapeHtml(room.content.slice(0, 80)) + (room.content.length > 80 ? '…' : '')
        : '<span class="admin-muted">(empty)</span>';
      return `
        <tr data-room-id="${escapeHtml(room.room_id)}">
          <td>
            <div class="admin-room-id">${escapeHtml(room.room_id)}</div>
            ${room.room_name ? `<div class="admin-room-name">${escapeHtml(room.room_name)}</div>` : ''}
          </td>
          <td class="admin-ts">${formatTimestamp(room.updated_at)}</td>
          <td>${buildFlags(room)}</td>
          <td class="admin-content-preview">${contentPreview}</td>
          <td class="admin-actions">
            <button class="admin-action-btn admin-action-clear" data-room-id="${escapeHtml(room.room_id)}" title="Clear content">🧹</button>
            <button class="admin-action-btn admin-action-delete" data-room-id="${escapeHtml(room.room_id)}" title="Delete room">🗑</button>
          </td>
        </tr>
      `;
    }).join('');

    // Wire clear buttons
    tbody.querySelectorAll('.admin-action-clear').forEach(btn => {
      btn.addEventListener('click', async () => {
        const roomId = btn.dataset.roomId;
        if (!confirm(`Clear all content from room "${roomId}"?\n\nThis cannot be undone.`)) return;
        btn.disabled = true;
        const { error } = await sb.from('syncpad_rooms')
          .update({ content: '', cleared_reason: 'manual' })
          .eq('room_id', roomId);
        if (error) {
          alert(`Error clearing room: ${error.message}`);
          btn.disabled = false;
          return;
        }
        // Update local data and re-render
        const room = rooms.find(r => r.room_id === roomId);
        if (room) room.content = '';
        renderRows(searchEl.value);
        await _loadStats(sb);
      });
    });

    // Wire delete buttons
    tbody.querySelectorAll('.admin-action-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const roomId = btn.dataset.roomId;
        if (!confirm(`Permanently delete room "${roomId}"?\n\nThis will also delete all files in this room. This cannot be undone.`)) return;
        btn.disabled = true;
        const { error } = await sb.from('syncpad_rooms').delete().eq('room_id', roomId);
        if (error) {
          alert(`Error deleting room: ${error.message}`);
          btn.disabled = false;
          return;
        }
        const idx = rooms.findIndex(r => r.room_id === roomId);
        if (idx !== -1) rooms.splice(idx, 1);
        renderRows(searchEl.value);
        await _loadStats(sb);
      });
    });
  }

  searchEl.addEventListener('input', () => renderRows(searchEl.value));
  renderRows('');
}

// ── Reports tab ───────────────────────────────────────────────────────────────

async function _renderReportsTab(sb, contentEl) {
  const { data: reports, error } = await sb
    .from('syncpad_room_reports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    contentEl.innerHTML = _accessDeniedHtml(error);
    return;
  }

  contentEl.innerHTML = `
    <div class="admin-tab-content">
      <div class="admin-toolbar">
        <label class="admin-filter-label">
          <input type="checkbox" id="admin-reports-only-new" checked />
          Show only open reports
        </label>
        <span class="admin-count-label" id="admin-reports-count"></span>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table" id="admin-reports-table">
          <thead>
            <tr>
              <th>Room ID</th>
              <th>Reason</th>
              <th>Details</th>
              <th>Date</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="admin-reports-tbody"></tbody>
        </table>
        <div id="admin-reports-empty" class="admin-empty hidden">No reports to display.</div>
      </div>
    </div>
  `;

  const tbody      = document.getElementById('admin-reports-tbody');
  const filterEl   = document.getElementById('admin-reports-only-new');
  const countEl    = document.getElementById('admin-reports-count');
  const emptyEl    = document.getElementById('admin-reports-empty');

  function statusBadge(status) {
    const cls = status === 'new' ? 'admin-badge--alert' : 'admin-badge--muted';
    return `<span class="admin-badge ${cls}">${escapeHtml(status || '—')}</span>`;
  }

  function renderRows() {
    const onlyNew = filterEl.checked;
    const filtered = onlyNew ? reports.filter(r => r.status === 'new') : reports;
    countEl.textContent = `${filtered.length} report${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      tbody.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    tbody.innerHTML = filtered.map(rep => {
      const details = rep.details ? escapeHtml(String(rep.details).slice(0, 60)) + (String(rep.details).length > 60 ? '…' : '') : '<span class="admin-muted">—</span>';
      return `
        <tr data-report-id="${escapeHtml(String(rep.id))}">
          <td><span class="admin-room-id">${escapeHtml(rep.room_id || '—')}</span></td>
          <td>${escapeHtml(rep.reason || '—')}</td>
          <td class="admin-content-preview">${details}</td>
          <td class="admin-ts">${formatTimestamp(rep.created_at)}</td>
          <td>${statusBadge(rep.status)}</td>
          <td class="admin-actions">
            ${rep.status === 'new'
              ? `<button class="admin-action-btn admin-action-dismiss" data-report-id="${escapeHtml(String(rep.id))}" title="Dismiss report">✓ Dismiss</button>`
              : ''
            }
            ${rep.room_id
              ? `<button class="admin-action-btn admin-action-delete" data-room-id="${escapeHtml(rep.room_id)}" data-report-id="${escapeHtml(String(rep.id))}" title="Delete room">🗑 Delete room</button>`
              : ''
            }
          </td>
        </tr>
      `;
    }).join('');

    // Dismiss buttons
    tbody.querySelectorAll('.admin-action-dismiss').forEach(btn => {
      btn.addEventListener('click', async () => {
        const reportId = btn.dataset.reportId;
        btn.disabled = true;
        const { error } = await sb.from('syncpad_room_reports')
          .update({ status: 'dismissed' })
          .eq('id', reportId);
        if (error) {
          alert(`Error dismissing report: ${error.message}`);
          btn.disabled = false;
          return;
        }
        const rep = reports.find(r => String(r.id) === reportId);
        if (rep) rep.status = 'dismissed';
        renderRows();
        await _loadStats(sb);
      });
    });

    // Delete room buttons (from reports tab)
    tbody.querySelectorAll('.admin-action-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const roomId   = btn.dataset.roomId;
        const reportId = btn.dataset.reportId;
        if (!confirm(`Permanently delete room "${roomId}"?\n\nThis will also delete all files in this room. This cannot be undone.`)) return;
        btn.disabled = true;
        const { error } = await sb.from('syncpad_rooms').delete().eq('room_id', roomId);
        if (error) {
          alert(`Error deleting room: ${error.message}`);
          btn.disabled = false;
          return;
        }
        // Mark all reports for this room as dismissed
        reports.forEach(r => { if (r.room_id === roomId) r.status = 'dismissed'; });
        renderRows();
        await _loadStats(sb);
      });
    });
  }

  filterEl.addEventListener('change', renderRows);
  renderRows();
}

// ── Cleanup tab ───────────────────────────────────────────────────────────────

async function _renderCleanupTab(sb, contentEl) {
  contentEl.innerHTML = `
    <div class="admin-tab-content admin-cleanup">
      <div class="admin-cleanup-section">
        <h3>🧹 Cleanup Expired Rooms</h3>
        <p class="admin-cleanup-desc">
          Run the server-side cleanup function to permanently delete all rooms whose
          expiry time (<code>expires_at</code>) has passed. This calls the
          <code>run_cleanup_expired_syncpad_rooms_as_admin()</code> database function.
        </p>
        <button id="admin-cleanup-btn" class="admin-action-btn admin-action-primary">
          Run cleanup
        </button>
        <div id="admin-cleanup-result" class="admin-cleanup-result hidden"></div>
      </div>

      <hr class="admin-divider" />

      <div class="admin-cleanup-section admin-cleanup-danger">
        <h3>⚠️ Manual Expired Room Deletion</h3>
        <p class="admin-cleanup-desc">
          Directly delete all rooms where <code>expires_at</code> is in the past.
          Use this only if the RPC cleanup function is unavailable. This action is
          <strong>irreversible</strong>.
        </p>
        <button id="admin-manual-cleanup-btn" class="admin-action-btn admin-action-danger">
          Delete all expired rooms now
        </button>
        <div id="admin-manual-cleanup-result" class="admin-cleanup-result hidden"></div>
      </div>
    </div>
  `;

  // RPC cleanup
  document.getElementById('admin-cleanup-btn').addEventListener('click', async () => {
    const btn       = document.getElementById('admin-cleanup-btn');
    const resultEl  = document.getElementById('admin-cleanup-result');
    btn.disabled    = true;
    btn.textContent = 'Running…';
    resultEl.classList.add('hidden');
    resultEl.className = 'admin-cleanup-result';

    const { data, error } = await sb.rpc('run_cleanup_expired_syncpad_rooms_as_admin');

    btn.disabled    = false;
    btn.textContent = 'Run cleanup';

    if (error) {
      resultEl.classList.remove('hidden');
      resultEl.classList.add('admin-cleanup-result--error');
      resultEl.textContent = `Error: ${error.message}`;
      return;
    }

    const count = typeof data === 'number' ? data : (Array.isArray(data) ? data.length : '?');
    resultEl.classList.remove('hidden');
    resultEl.classList.add('admin-cleanup-result--success');
    resultEl.textContent = `✓ Cleanup complete. ${count} expired room${count !== 1 ? 's' : ''} deleted.`;
    await _loadStats(sb);
  });

  // Manual cleanup
  document.getElementById('admin-manual-cleanup-btn').addEventListener('click', async () => {
    const btn      = document.getElementById('admin-manual-cleanup-btn');
    const resultEl = document.getElementById('admin-manual-cleanup-result');

    if (!confirm(
      'Delete ALL rooms where expires_at is in the past?\n\n' +
      'This is permanent and cannot be undone. Continue?'
    )) return;

    btn.disabled    = true;
    btn.textContent = 'Deleting…';
    resultEl.classList.add('hidden');
    resultEl.className = 'admin-cleanup-result';

    const { data, error, count } = await sb
      .from('syncpad_rooms')
      .delete({ count: 'exact' })
      .lt('expires_at', new Date().toISOString())
      .not('expires_at', 'is', null);

    btn.disabled    = false;
    btn.textContent = 'Delete all expired rooms now';

    if (error) {
      resultEl.classList.remove('hidden');
      resultEl.classList.add('admin-cleanup-result--error');
      resultEl.textContent = `Error: ${error.message}`;
      return;
    }

    const deleted = count ?? '?';
    resultEl.classList.remove('hidden');
    resultEl.classList.add('admin-cleanup-result--success');
    resultEl.textContent = `✓ Deleted ${deleted} expired room${deleted !== 1 ? 's' : ''}.`;
    await _loadStats(sb);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _isExpired(expiresAt) {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

function _accessDeniedHtml(error) {
  const isRls = error?.code === 'PGRST301' || error?.message?.includes('permission') || error?.message?.includes('policy');
  return `
    <div class="admin-access-denied">
      <div class="admin-access-denied-icon">🚫</div>
      <div class="admin-access-denied-title">
        ${isRls ? 'You do not have admin access.' : 'Failed to load data.'}
      </div>
      <div class="admin-access-denied-detail">${escapeHtml(error?.message ?? 'Unknown error')}</div>
    </div>
  `;
}
