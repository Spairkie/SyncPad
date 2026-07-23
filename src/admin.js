// SyncPad – admin.js
// Admin dashboard: auth gate, room management, reports, files, audit, cleanup.
// All data access is gated by Supabase RLS (is_syncpad_admin() function).

import { getSupabaseClient } from './supabase.js';
import { escapeHtml, formatFileSize, formatTimestamp } from './utils.js';
import { showConfirm, showPrompt, showAlert } from './ui.js';
import { getIcon } from './icons.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const FILES_BUCKET             = 'syncpad-files';
const STORAGE_REMOVE_BATCH_SIZE = 100;
const ADMIN_QUERY_BATCH_SIZE   = 100;
const ROOMS_PAGE_SIZE          = 25;
const FILES_PAGE_SIZE          = 50;
const AUDIT_PAGE_SIZE          = 50;
const REPORTS_PAGE_SIZE        = 50;
// PostgREST caps unpaginated selects at its own default page size — any
// "fetch every matching row" query (as opposed to the paginated tab UIs
// above, which intentionally fetch one page at a time) must page through
// with .range() or it silently drops rows past the first page. Mirrors the
// selectAll() helper in supabase/functions/syncpad-cleanup/index.ts.
const SELECT_ALL_PAGE_SIZE     = 1000;

// ── Module-level dashboard state (reset on every dashboard init) ──────────────

let _sb             = null;
let _session        = null;
let _activeTab      = 'rooms';
let _lastRefreshed  = null;
let _refreshedTimer = null;
let _shortcutsHandler = null;

// Rooms tab state
let _rooms          = [];
let _roomsOffset    = 0;
let _roomsTotal     = 0;
let _roomsFilter    = 'all';
let _roomsSort      = { col: 'updated_at', dir: 'desc' };
let _roomsSearch    = '';
let _roomsSelected  = new Set();
let _hasQuarantine  = false; // set after probing schema

// Reports tab state
let _reports        = [];
let _reportsOffset  = 0;
let _reportsFilter  = 'new';
let _reportsTotal   = 0;

// Files tab state
let _files          = [];
let _filesOffset    = 0;
let _filesTotal     = 0;

// Audit tab state
let _audit          = [];
let _auditOffset    = 0;
let _hasAuditTable  = false;

// ── Path helpers ──────────────────────────────────────────────────────────────

function _basePath() {
  const raw = String(window.SYNCPAD_CONFIG?.basePath ?? '/SyncPad').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}
function _homePath()  { return `${_basePath() || ''}/`; }
function _roomUrl(id) { return `${_basePath() || ''}/${encodeURIComponent(id)}`; }

// ── Entry point ───────────────────────────────────────────────────────────────

/** Lazy-load the admin-only stylesheet — regular room pages never fetch it. */
function _loadAdminStylesheet() {
  if (document.getElementById('admin-stylesheet')) return;
  const link = document.createElement('link');
  link.id = 'admin-stylesheet';
  link.rel = 'stylesheet';
  link.href = '/SyncPad/styles/admin.css';
  document.head.appendChild(link);
}

export async function initAdmin() {
  _loadAdminStylesheet();
  let sb;
  try { sb = getSupabaseClient(); }
  catch { _renderUnavailable(); return; }

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await _renderDashboard(sb, session);
    else          _renderLogin(sb);
  } catch (err) {
    console.error('[admin] initAdmin failed:', err);
    _renderUnavailable();
  }
}

// ── Unavailable state ─────────────────────────────────────────────────────────

function _renderUnavailable() {
  const screen = document.getElementById('admin-screen');
  if (!screen) return;
  screen.innerHTML = `
    <div class="admin-login-wrap">
      <div class="auth-card auth-card--centered admin-login-card">
        <div class="auth-card-icon">⚠️</div>
        <h2>Admin unavailable</h2>
        <p>Could not connect to Supabase. Check your network connection and try again.</p>
        <button onclick="window.location.reload()" class="auth-btn" style="margin-top:14px">Retry</button>
        <button id="admin-unavailable-home" class="auth-btn admin-secondary-btn">Back to SyncPad</button>
      </div>
    </div>`;
  document.getElementById('admin-unavailable-home')?.addEventListener('click', () => {
    window.location.href = _homePath();
  });
}

// ── Login form ────────────────────────────────────────────────────────────────

function _renderLogin(sb) {
  const screen = document.getElementById('admin-screen');
  screen.innerHTML = `
    <div class="admin-login-wrap">
      <div class="auth-card admin-login-card">
        <div class="auth-card-icon">🔐</div>
        <h2>Admin Sign In</h2>
        <p>Sign in with your admin account to access the dashboard.</p>
        <input id="admin-email"    class="auth-input" type="email"    placeholder="Email"    autocomplete="email" />
        <input id="admin-password" class="auth-input" type="password" placeholder="Password" autocomplete="current-password" style="margin-top:10px" />
        <div id="admin-login-error" class="admin-login-error"></div>
        <button id="admin-login-btn"  class="auth-btn" style="margin-top:14px">Sign in</button>
        <button id="admin-login-home" class="auth-btn admin-secondary-btn">Back to SyncPad</button>
      </div>
    </div>`;

  const emailEl    = document.getElementById('admin-email');
  const passwordEl = document.getElementById('admin-password');
  const errorEl    = document.getElementById('admin-login-error');
  const loginBtn   = document.getElementById('admin-login-btn');

  async function doLogin() {
    const email    = emailEl.value.trim();
    const password = passwordEl.value;
    if (!email || !password) { errorEl.textContent = 'Please enter your email and password.'; return; }
    loginBtn.disabled = true; loginBtn.textContent = 'Signing in…'; errorEl.textContent = '';
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      errorEl.textContent = error.message || 'Sign-in failed.';
      loginBtn.disabled = false; loginBtn.textContent = 'Sign in';
      return;
    }
    await _renderDashboard(sb, data.session);
  }

  loginBtn.addEventListener('click', doLogin);
  passwordEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  emailEl.addEventListener('keydown',    (e) => { if (e.key === 'Enter') passwordEl.focus(); });
  document.getElementById('admin-login-home')?.addEventListener('click', () => {
    window.location.href = _homePath();
  });
}

// ── Dashboard shell ───────────────────────────────────────────────────────────

async function _renderDashboard(sb, session) {
  _sb = sb; _session = session;
  _activeTab = 'rooms';

  // Probe schema for optional features
  _hasQuarantine = await _probeColumn(sb, 'syncpad_rooms', 'quarantined_at');
  _hasAuditTable = await _probeTable(sb, 'syncpad_admin_audit_logs');

  const screen = document.getElementById('admin-screen');
  screen.innerHTML = `
    <div class="admin-shell">

      <div class="admin-header">
        <div class="admin-header-brand">🛠️ SyncPad Admin</div>
        <div class="admin-header-actions">
          <span class="admin-user-email">${escapeHtml(session?.user?.email ?? '')}</span>
          <span class="admin-refreshed-label" id="admin-refreshed-label" title="Last data refresh"></span>
          <button class="admin-icon-btn" id="admin-refresh-btn" title="Refresh (r)" aria-label="Refresh dashboard">↺</button>
          <button class="admin-logout-btn" id="admin-logout-btn">Sign out</button>
        </div>
      </div>

      <div class="admin-stats-row" id="admin-stats-row">
        <div class="admin-stat-card admin-stat-card--clickable" id="stat-card-rooms" data-target-tab="rooms" role="button" tabindex="0" title="Go to Rooms tab">
          <div class="admin-stat-icon">${getIcon('edit', 16)}</div>
          <div class="admin-stat-value admin-skeleton" id="stat-rooms">—</div>
          <div class="admin-stat-label">Total rooms</div>
        </div>
        <div class="admin-stat-card admin-stat-card--clickable" id="stat-card-active" data-target-tab="rooms" data-filter="active-today" role="button" tabindex="0" title="Show rooms active in the last 24h">
          <div class="admin-stat-icon">${getIcon('users', 16)}</div>
          <div class="admin-stat-value admin-skeleton" id="stat-active">—</div>
          <div class="admin-stat-label">Active today</div>
        </div>
        <div class="admin-stat-card admin-stat-card--clickable" id="stat-card-files" data-target-tab="files" role="button" tabindex="0" title="Go to Files tab">
          <div class="admin-stat-icon">${getIcon('files', 16)}</div>
          <div class="admin-stat-value admin-skeleton" id="stat-files">—</div>
          <div class="admin-stat-label">Files</div>
        </div>
        <div class="admin-stat-card" id="stat-card-storage" title="Total size of all uploaded files">
          <div class="admin-stat-icon">${getIcon('upload', 16)}</div>
          <div class="admin-stat-value admin-skeleton" id="stat-storage">—</div>
          <div class="admin-stat-label">Storage used</div>
        </div>
        <div class="admin-stat-card admin-stat-card--alert admin-stat-card--clickable" id="stat-card-reports" data-target-tab="reports" role="button" tabindex="0" title="Go to Reports tab">
          <div class="admin-stat-icon">${getIcon('warning', 16)}</div>
          <div class="admin-stat-value admin-skeleton" id="stat-reports">—</div>
          <div class="admin-stat-label">Open reports</div>
        </div>
        <div class="admin-stat-card admin-stat-card--clickable" id="stat-card-expired" data-target-tab="rooms" data-filter="expired" role="button" tabindex="0" title="Show expired rooms">
          <div class="admin-stat-icon">${getIcon('clock', 16)}</div>
          <div class="admin-stat-value admin-skeleton" id="stat-expired">—</div>
          <div class="admin-stat-label">Expired rooms</div>
        </div>
      </div>

      <div class="admin-activity" id="admin-activity">
        <div class="admin-activity-header">
          <h3>Room creation — last 14 days</h3>
          <span class="admin-activity-total" id="admin-activity-total"></span>
        </div>
        <div class="admin-activity-chart" id="admin-activity-chart"><div class="admin-skeleton-bar" style="height:64px"></div></div>
      </div>

      <div class="admin-tabs" id="admin-tabs" role="tablist">
        <button class="admin-tab active" data-tab="rooms"   role="tab" aria-selected="true">Rooms</button>
        <button class="admin-tab"        data-tab="reports" role="tab" aria-selected="false">Reports</button>
        <button class="admin-tab"        data-tab="files"   role="tab" aria-selected="false">Files</button>
        <button class="admin-tab"        data-tab="audit"   role="tab" aria-selected="false">Audit Log</button>
        <button class="admin-tab"        data-tab="cleanup" role="tab" aria-selected="false">Cleanup</button>
      </div>

      <div class="admin-content" id="admin-content"></div>

    </div>

    <!-- Room detail drawer -->
    <div class="admin-drawer" id="admin-drawer" aria-hidden="true">
      <div class="admin-drawer-inner" id="admin-drawer-inner"></div>
    </div>
    <div class="admin-drawer-backdrop" id="admin-drawer-backdrop"></div>
  `;

  // ── Stat card click navigation ────────────────────────────────
  screen.querySelectorAll('.admin-stat-card--clickable').forEach(card => {
    const onClick = () => {
      const tab    = card.dataset.targetTab;
      const filter = card.dataset.filter;
      if (filter && tab === 'rooms') _roomsFilter = filter;
      switchTab(tab);
    };
    card.addEventListener('click', onClick);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } });
  });

  // ── Tab switching ──────────────────────────────────────────────
  const contentEl = document.getElementById('admin-content');

  // Tab-specific filters (e.g. _roomsFilter) are set directly by the caller
  // — see the stat-card click handler above — before switchTab() runs, not
  // threaded through here.
  async function switchTab(tab) {
    _activeTab = tab;
    document.querySelectorAll('.admin-tab').forEach(btn => {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    contentEl.innerHTML = _skeletonTabHtml();
    if (tab === 'rooms')   await _renderRoomsTab(contentEl);
    if (tab === 'reports') await _renderReportsTab(contentEl);
    if (tab === 'files')   await _renderFilesTab(contentEl);
    if (tab === 'audit')   await _renderAuditTab(contentEl);
    if (tab === 'cleanup') await _renderCleanupTab(contentEl);
    _lastRefreshed = new Date();
    _updateRefreshedLabel();
  }

  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ── Drawer close ──────────────────────────────────────────────
  document.getElementById('admin-drawer-backdrop').addEventListener('click', _closeDrawer);

  // ── Refresh button ────────────────────────────────────────────
  document.getElementById('admin-refresh-btn').addEventListener('click', async () => {
    const btn = document.getElementById('admin-refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '↻'; }
    await Promise.all([_loadStats(), switchTab(_activeTab)]);
    if (btn) { btn.disabled = false; btn.textContent = '↺'; }
  });

  // ── Logout ────────────────────────────────────────────────────
  document.getElementById('admin-logout-btn').addEventListener('click', async () => {
    _teardownDashboard();
    await sb.auth.signOut();
    initAdmin();
  });

  // ── Keyboard shortcuts ────────────────────────────────────────
  _setupKeyboardShortcuts(switchTab);

  // ── Initial load ──────────────────────────────────────────────
  await Promise.all([_loadStats(), switchTab('rooms')]);
}

function _teardownDashboard() {
  if (_shortcutsHandler) {
    document.removeEventListener('keydown', _shortcutsHandler);
    _shortcutsHandler = null;
  }
  if (_refreshedTimer) { clearInterval(_refreshedTimer); _refreshedTimer = null; }
  _rooms = []; _reports = []; _files = []; _audit = [];
  _roomsSelected.clear();
}

function _setupKeyboardShortcuts(switchTab) {
  if (_shortcutsHandler) document.removeEventListener('keydown', _shortcutsHandler);
  _shortcutsHandler = (e) => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    const inInput = tag === 'input' || tag === 'textarea' || tag === 'select';
    // Esc — close drawer
    if (e.key === 'Escape') { _closeDrawer(); return; }
    if (inInput) return;
    // / — focus search
    if (e.key === '/') {
      e.preventDefault();
      const search = document.getElementById('admin-room-search') ||
                     document.getElementById('admin-files-search');
      search?.focus();
      return;
    }
    // r — refresh
    if (e.key === 'r' || e.key === 'R') {
      document.getElementById('admin-refresh-btn')?.click();
    }
  };
  document.addEventListener('keydown', _shortcutsHandler);
}

function _updateRefreshedLabel() {
  if (_refreshedTimer) clearInterval(_refreshedTimer);
  const update = () => {
    const el = document.getElementById('admin-refreshed-label');
    if (!el || !_lastRefreshed) return;
    const secs = Math.floor((Date.now() - _lastRefreshed) / 1000);
    if (secs < 5)   { el.textContent = 'Updated just now'; return; }
    if (secs < 60)  { el.textContent = `Updated ${secs}s ago`; return; }
    if (secs < 3600){ el.textContent = `Updated ${Math.floor(secs / 60)}m ago`; return; }
    el.textContent = `Updated ${_lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };
  update();
  _refreshedTimer = setInterval(update, 10000);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

const ACTIVITY_DAYS = 14;

async function _loadStats() {
  ['stat-rooms', 'stat-active', 'stat-files', 'stat-storage', 'stat-reports', 'stat-expired'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('admin-skeleton');
  });

  const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const activitySinceIso = new Date(Date.now() - ACTIVITY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [roomsRes, filesRes, reportsRes, expiredRes, activeRes, storageRes, activityRes] = await Promise.allSettled([
    _sb.from('syncpad_rooms').select('*', { count: 'exact', head: true }),
    _sb.from('syncpad_files').select('*', { count: 'exact', head: true }),
    _sb.from('syncpad_room_reports').select('*', { count: 'exact', head: true }).eq('status', 'new'),
    _sb.from('syncpad_rooms').select('*', { count: 'exact', head: true })
      .lt('expires_at', new Date().toISOString()).not('expires_at', 'is', null),
    _sb.from('syncpad_rooms').select('*', { count: 'exact', head: true }).gte('updated_at', dayAgoIso),
    // No SUM() over PostgREST without a DB function — for a personal-project-scale
    // table this is a small enough row set to sum client-side.
    _sb.from('syncpad_files').select('file_size'),
    _sb.from('syncpad_rooms').select('created_at').gte('created_at', activitySinceIso),
  ]);

  const get = (res) => res.status === 'fulfilled' ? (res.value.count ?? '—') : '—';

  const update = (id, val) => {
    const el = document.getElementById(id);
    if (el) { el.textContent = val; el.classList.remove('admin-skeleton'); }
  };
  update('stat-rooms',   get(roomsRes));
  update('stat-active',  get(activeRes));
  update('stat-files',   get(filesRes));
  update('stat-reports', get(reportsRes));
  update('stat-expired', get(expiredRes));

  const totalBytes = storageRes.status === 'fulfilled'
    ? (storageRes.value.data || []).reduce((sum, r) => sum + (r.file_size || 0), 0)
    : null;
  update('stat-storage', totalBytes == null ? '—' : formatFileSize(totalBytes));

  const reportCount = reportsRes.status === 'fulfilled' ? (reportsRes.value.count ?? 0) : 0;
  const card = document.getElementById('stat-card-reports');
  if (card) card.classList.toggle('admin-stat-card--has-alerts', reportCount > 0);

  const createdAts = activityRes.status === 'fulfilled' ? (activityRes.value.data || []).map(r => r.created_at) : [];
  _renderActivityChart(createdAts);
}

// ── Activity chart (rooms created per day, last N days) ────────────────────
// Dependency-free inline SVG — no charting library, matching the rest of the
// app's "no build step" approach. Single series (room creations), so per the
// project's chart conventions this needs no legend, just the title above it
// and a hover tooltip per bar.

function _renderActivityChart(createdAtIsoStrings) {
  const container = document.getElementById('admin-activity-chart');
  const totalEl = document.getElementById('admin-activity-total');
  if (!container) return;

  // Bucket by local calendar day, oldest first.
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push({ date: d, count: 0 });
  }
  const dayIndex = new Map(days.map((d, i) => [d.date.toDateString(), i]));
  for (const iso of createdAtIsoStrings) {
    const d = new Date(iso);
    d.setHours(0, 0, 0, 0);
    const idx = dayIndex.get(d.toDateString());
    if (idx != null) days[idx].count++;
  }

  const total = days.reduce((s, d) => s + d.count, 0);
  if (totalEl) totalEl.textContent = `${total} new room${total === 1 ? '' : 's'}`;

  if (total === 0) {
    container.innerHTML = `<div class="admin-activity-empty">No rooms created in the last ${ACTIVITY_DAYS} days.</div>`;
    return;
  }

  const max = Math.max(...days.map(d => d.count), 1);
  const barWidth = 100 / days.length;
  const bars = days.map((d, i) => {
    const heightPct = (d.count / max) * 100;
    const label = d.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `
      <div class="admin-activity-bar-wrap" style="width:${barWidth}%" tabindex="0"
           title="${escapeHtml(label)}: ${d.count} room${d.count === 1 ? '' : 's'}">
        <div class="admin-activity-bar" style="height:${Math.max(heightPct, d.count > 0 ? 4 : 0)}%"></div>
        <span class="admin-activity-bar-label">${i % 2 === 0 || days.length <= 7 ? escapeHtml(d.date.getDate().toString()) : ''}</span>
      </div>`;
  }).join('');

  container.innerHTML = `<div class="admin-activity-bars">${bars}</div>`;
}

// ── Schema probing ────────────────────────────────────────────────────────────

async function _probeColumn(sb, table, column) {
  try {
    const { error } = await sb.from(table).select(column).limit(0);
    return !error;
  } catch { return false; }
}

async function _probeTable(sb, table) {
  try {
    const { error } = await sb.from(table).select('id').limit(0);
    return !error;
  } catch { return false; }
}

// ── Rooms tab ─────────────────────────────────────────────────────────────────

async function _renderRoomsTab(contentEl) {
  _roomsOffset = 0;
  _rooms = [];
  _roomsSelected.clear();

  const selectCols = [
    'room_id', 'room_name', 'updated_at', 'created_at', 'expires_at',
    'encryption_enabled', 'passcode_hash', 'view_once', 'editing_locked', 'content',
    ..._hasQuarantine ? ['quarantined_at', 'quarantine_reason'] : [],
  ].join(', ');

  // ── Load first page ───────────────────────────────────────────
  const result = await _fetchRooms(selectCols, 0);
  if (result.error) { contentEl.innerHTML = _accessDeniedHtml(result.error); return; }
  _rooms = result.data || [];
  _roomsTotal = result.count ?? 0;

  // ── Build UI ───────────────────────────────────────────────────
  contentEl.innerHTML = `
    <div class="admin-tab-content">

      <div class="admin-filter-chips" id="admin-room-filter-chips" role="group" aria-label="Filter rooms">
        ${_roomFilterChips()}
      </div>

      <div class="admin-toolbar">
        <input id="admin-room-search" class="admin-search-input" placeholder="Search by ID or name… (press /)" autocomplete="off" />
        <span class="admin-count-label" id="admin-room-count"></span>
      </div>

      <div class="admin-bulk-bar hidden" id="admin-rooms-bulk-bar">
        <span class="admin-bulk-label" id="admin-bulk-label"></span>
        <button class="admin-action-btn admin-action-clear" id="admin-bulk-clear">🧹 Clear selected</button>
        <button class="admin-action-btn admin-action-danger" id="admin-bulk-delete">🗑 Delete selected</button>
        <button class="admin-action-btn" id="admin-bulk-deselect">✕ Deselect all</button>
      </div>

      <div class="admin-table-wrap" id="admin-rooms-table-wrap">
        <table class="admin-table" id="admin-rooms-table">
          <thead>
            <tr>
              <th class="admin-th-check"><input type="checkbox" id="admin-rooms-select-all" aria-label="Select all visible rooms" /></th>
              <th class="admin-th-sortable" data-col="room_name">Room <span class="admin-sort-icon" id="sort-icon-room_name"></span></th>
              <th class="admin-th-sortable" data-col="updated_at">Updated <span class="admin-sort-icon" id="sort-icon-updated_at">↓</span></th>
              <th class="admin-th-sortable" data-col="created_at">Created <span class="admin-sort-icon" id="sort-icon-created_at"></span></th>
              <th>Flags</th>
              <th class="admin-th-content-hide">Content</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="admin-rooms-tbody"></tbody>
        </table>
        <div id="admin-rooms-empty" class="admin-empty hidden"></div>
      </div>

      <div class="admin-load-more-row" id="admin-rooms-load-more-row">
        <button class="admin-load-more-btn hidden" id="admin-rooms-load-more">Load more rooms</button>
      </div>

    </div>`;

  _wireRoomsTab(contentEl, selectCols);
}

function _roomFilterChips() {
  const filters = [
    { id: 'all',         label: 'All' },
    { id: 'active',      label: 'Active' },
    { id: 'active-today', label: 'Active today' },
    { id: 'expired',     label: 'Expired' },
    { id: 'encrypted',   label: 'Encrypted' },
    { id: 'passcode',    label: 'Passcode' },
    { id: 'locked',      label: 'Locked' },
    ...(_hasQuarantine ? [{ id: 'quarantined', label: 'Quarantined' }] : []),
  ];
  return filters.map(f =>
    `<button class="admin-chip${_roomsFilter === f.id ? ' active' : ''}" data-filter="${f.id}">${f.label}</button>`
  ).join('');
}

async function _fetchRooms(selectCols, offset) {
  let q = _sb.from('syncpad_rooms')
    .select(selectCols, { count: 'exact' })
    .order(_roomsSort.col, { ascending: _roomsSort.dir === 'asc' })
    .range(offset, offset + ROOMS_PAGE_SIZE - 1);

  // Apply server-side filter
  const now = new Date().toISOString();
  if (_roomsFilter === 'active')      q = q.or(`expires_at.is.null,expires_at.gt.${now}`);
  else if (_roomsFilter === 'active-today') q = q.gte('updated_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  else if (_roomsFilter === 'expired') q = q.lt('expires_at', now).not('expires_at', 'is', null);
  else if (_roomsFilter === 'encrypted') q = q.eq('encryption_enabled', true);
  else if (_roomsFilter === 'passcode')  q = q.not('passcode_hash', 'is', null);
  else if (_roomsFilter === 'locked')    q = q.eq('editing_locked', true);
  else if (_roomsFilter === 'quarantined' && _hasQuarantine)
    q = q.not('quarantined_at', 'is', null);

  // Apply search
  if (_roomsSearch) {
    // PostgREST's .or() filter string treats comma/parenthesis/period as
    // syntax (condition separators, grouping), so a search term containing
    // one would otherwise break the query — wrap the value in double quotes
    // (escaping any backslash/quote within it) so it's taken literally.
    const s = `%${_escapePostgrestFilterValue(_roomsSearch)}%`;
    q = q.or(`room_id.ilike."${s}",room_name.ilike."${s}"`);
  }

  return q;
}

function _escapePostgrestFilterValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function _wireRoomsTab(contentEl, selectCols) {
  const tbody      = document.getElementById('admin-rooms-tbody');
  const searchEl   = document.getElementById('admin-room-search');
  const countEl    = document.getElementById('admin-room-count');
  const emptyEl    = document.getElementById('admin-rooms-empty');
  const bulkBar    = document.getElementById('admin-rooms-bulk-bar');
  const bulkLabel  = document.getElementById('admin-bulk-label');
  const loadMoreBtn = document.getElementById('admin-rooms-load-more');

  // ── Search (debounced) ─────────────────────────────────────────
  let searchTimer;
  searchEl.value = _roomsSearch;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      _roomsSearch = searchEl.value.trim();
      _roomsOffset = 0; _rooms = []; _roomsSelected.clear();
      const r = await _fetchRooms(selectCols, 0);
      if (!r.error) { _rooms = r.data || []; _roomsTotal = r.count ?? 0; }
      renderRows();
    }, 300);
  });

  // ── Filter chips ───────────────────────────────────────────────
  document.getElementById('admin-room-filter-chips')?.addEventListener('click', async (e) => {
    const chip = e.target.closest('.admin-chip');
    if (!chip) return;
    _roomsFilter = chip.dataset.filter;
    _roomsOffset = 0; _rooms = []; _roomsSelected.clear();
    document.querySelectorAll('.admin-chip').forEach(c => c.classList.toggle('active', c === chip));
    const r = await _fetchRooms(selectCols, 0);
    if (!r.error) { _rooms = r.data || []; _roomsTotal = r.count ?? 0; }
    renderRows();
  });

  // ── Column sorting ─────────────────────────────────────────────
  document.querySelectorAll('.admin-th-sortable').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', async () => {
      const col = th.dataset.col;
      if (_roomsSort.col === col) {
        _roomsSort.dir = _roomsSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        _roomsSort = { col, dir: 'desc' };
      }
      // Update sort icons
      document.querySelectorAll('.admin-sort-icon').forEach(ic => ic.textContent = '');
      const icon = document.getElementById(`sort-icon-${col}`);
      if (icon) icon.textContent = _roomsSort.dir === 'asc' ? '↑' : '↓';

      _roomsOffset = 0; _rooms = []; _roomsSelected.clear();
      const r = await _fetchRooms(selectCols, 0);
      if (!r.error) { _rooms = r.data || []; _roomsTotal = r.count ?? 0; }
      renderRows();
    });
  });

  // ── Select-all checkbox ────────────────────────────────────────
  document.getElementById('admin-rooms-select-all')?.addEventListener('change', (e) => {
    const checked = e.target.checked;
    _rooms.forEach(r => checked ? _roomsSelected.add(r.room_id) : _roomsSelected.delete(r.room_id));
    tbody.querySelectorAll('.admin-row-check').forEach(cb => { cb.checked = checked; });
    updateBulkBar();
  });

  // ── Bulk action bar ────────────────────────────────────────────
  function updateBulkBar() {
    const count = _roomsSelected.size;
    bulkBar.classList.toggle('hidden', count === 0);
    if (bulkLabel) bulkLabel.textContent = `${count} room${count !== 1 ? 's' : ''} selected`;
  }

  document.getElementById('admin-bulk-deselect')?.addEventListener('click', () => {
    _roomsSelected.clear();
    tbody.querySelectorAll('.admin-row-check').forEach(cb => { cb.checked = false; });
    const selectAll = document.getElementById('admin-rooms-select-all');
    if (selectAll) selectAll.checked = false;
    updateBulkBar();
  });

  document.getElementById('admin-bulk-clear')?.addEventListener('click', async () => {
    const ids = Array.from(_roomsSelected);
    const ok = await showConfirm(
      `Clear content from ${ids.length} room${ids.length !== 1 ? 's' : ''}?\n\nThe rooms are kept; only the note text is removed. This cannot be undone.`,
      { confirmLabel: 'Clear all', danger: true }
    );
    if (!ok) return;
    let errs = 0;
    for (const batch of _chunks(ids, ADMIN_QUERY_BATCH_SIZE)) {
      const { error } = await _sb.from('syncpad_rooms')
        .update({ content: '', cleared_reason: 'manual' })
        .in('room_id', batch);
      if (error) { errs++; console.error('[admin] bulk-clear error', error); }
      else {
        batch.forEach(id => {
          const room = _rooms.find(r => r.room_id === id);
          if (room) room.content = '';
        });
      }
    }
    await _logAdminAction('bulk_clear_rooms', { metadata: { count: ids.length } });
    _roomsSelected.clear();
    updateBulkBar();
    renderRows();
    await _loadStats();
    if (errs) await showAlert(`${errs} room(s) could not be cleared. Check console for details.`);
    else _showToast(`Cleared ${ids.length} room${ids.length !== 1 ? 's' : ''}.`, 'success');
  });

  document.getElementById('admin-bulk-delete')?.addEventListener('click', async () => {
    const ids = Array.from(_roomsSelected);
    const ok = await _adminTypedConfirm(
      `Permanently delete ${ids.length} room${ids.length !== 1 ? 's' : ''}?`,
      `This will delete all files in these rooms and cannot be undone.\n\nType DELETE to confirm:`,
      'DELETE',
    );
    if (!ok) return;
    let errs = 0;
    for (const id of ids) {
      const { error } = await _deleteRoomAndStorage(id);
      if (error) { errs++; console.error('[admin] bulk-delete error', id, error); }
      else {
        const idx = _rooms.findIndex(r => r.room_id === id);
        if (idx !== -1) _rooms.splice(idx, 1);
      }
    }
    await _logAdminAction('bulk_delete_rooms', { metadata: { count: ids.length } });
    _roomsSelected.clear();
    updateBulkBar();
    renderRows();
    await _loadStats();
    if (errs) await showAlert(`${errs} room(s) could not be deleted. Check console for details.`);
    else _showToast(`Deleted ${ids.length} room${ids.length !== 1 ? 's' : ''}.`, 'success');
  });

  // ── Load more ──────────────────────────────────────────────────
  loadMoreBtn?.addEventListener('click', async () => {
    loadMoreBtn.disabled = true; loadMoreBtn.textContent = 'Loading…';
    _roomsOffset += ROOMS_PAGE_SIZE;
    const r = await _fetchRooms(selectCols, _roomsOffset);
    if (!r.error && r.data?.length) {
      _rooms.push(...r.data);
      renderRows(true); // true = append (don't rebuild whole tbody)
    }
    loadMoreBtn.disabled = false; loadMoreBtn.textContent = 'Load more rooms';
  });

  // ── Row renderer ───────────────────────────────────────────────
  function buildFlags(room) {
    const flags = [];
    if (room.encryption_enabled) flags.push('<span class="admin-badge admin-badge--enc" title="Encrypted">ENC</span>');
    if (room.passcode_hash)      flags.push('<span class="admin-badge admin-badge--pass" title="Passcode">PASS</span>');
    if (room.view_once)          flags.push('<span class="admin-badge admin-badge--once" title="View-once">1×</span>');
    if (_isExpired(room.expires_at)) flags.push('<span class="admin-badge admin-badge--exp" title="Expired">EXP</span>');
    if (room.editing_locked)     flags.push('<span class="admin-badge admin-badge--muted" title="Editing locked">🔒</span>');
    if (_hasQuarantine && room.quarantined_at) flags.push('<span class="admin-badge admin-badge--alert" title="Quarantined">⛔</span>');
    return flags.join(' ') || '<span class="admin-muted">—</span>';
  }

  function renderRows(append = false) {
    const visibleRooms = append ? _rooms.slice(-ROOMS_PAGE_SIZE) : _rooms;

    if (!append) tbody.innerHTML = '';

    if (!_rooms.length) {
      emptyEl.textContent = _roomsSearch || _roomsFilter !== 'all'
        ? 'No rooms match your search / filter.' : 'No rooms found.';
      emptyEl.classList.remove('hidden');
      if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    const rows = visibleRooms.map(room => {
      const contentPreview = room.encryption_enabled
        ? '<span class="admin-muted admin-badge admin-badge--enc">Encrypted</span>'
        : room.content
          ? escapeHtml(room.content.slice(0, 80)) + (room.content.length > 80 ? '…' : '')
          : '<span class="admin-muted">(empty)</span>';
      const isChecked = _roomsSelected.has(room.room_id);
      return `
        <tr data-room-id="${escapeHtml(room.room_id)}">
          <td><input type="checkbox" class="admin-row-check" data-room-id="${escapeHtml(room.room_id)}" ${isChecked ? 'checked' : ''} aria-label="Select room ${escapeHtml(room.room_id)}" /></td>
          <td>
            <button class="admin-room-id-btn admin-room-id" data-room-id="${escapeHtml(room.room_id)}" title="View room details">${escapeHtml(room.room_id)}</button>
            ${room.room_name ? `<div class="admin-room-name">${escapeHtml(room.room_name)}</div>` : ''}
          </td>
          <td class="admin-ts">${formatTimestamp(room.updated_at)}</td>
          <td class="admin-ts">${formatTimestamp(room.created_at)}</td>
          <td>${buildFlags(room)}</td>
          <td class="admin-content-preview admin-th-content-hide">${contentPreview}</td>
          <td class="admin-actions">
            <a class="admin-action-btn admin-action-link" href="${_roomUrl(room.room_id)}" target="_blank" rel="noopener" title="Open room">↗</a>
            <button class="admin-action-btn admin-action-copy" data-room-id="${escapeHtml(room.room_id)}" title="Copy room link">🔗</button>
            <button class="admin-action-btn admin-action-detail" data-room-id="${escapeHtml(room.room_id)}" title="View details">…</button>
            <button class="admin-action-btn admin-action-clear" data-room-id="${escapeHtml(room.room_id)}" title="Clear note content">🧹</button>
            <button class="admin-action-btn admin-action-delete" data-room-id="${escapeHtml(room.room_id)}" title="Delete room permanently">🗑</button>
          </td>
        </tr>`;
    }).join('');
    tbody.insertAdjacentHTML('beforeend', rows);

    // Count display
    const loaded = _rooms.length;
    const total  = _roomsTotal;
    if (countEl) countEl.textContent = total > loaded
      ? `Showing ${loaded} of ${total} rooms`
      : `${total} room${total !== 1 ? 's' : ''}`;

    // Load more visibility
    if (loadMoreBtn) loadMoreBtn.classList.toggle('hidden', loaded >= total);

    // Wire newly-added rows
    _wireRows(tbody, updateBulkBar, selectCols, renderRows);
  }

  renderRows();
}

function _wireRows(tbody, updateBulkBar, selectCols, renderRows) {
  // Checkbox selection
  tbody.querySelectorAll('.admin-row-check:not([data-wired])').forEach(cb => {
    cb.dataset.wired = '1';
    cb.addEventListener('change', () => {
      const id = cb.dataset.roomId;
      if (cb.checked) _roomsSelected.add(id);
      else            _roomsSelected.delete(id);
      const selectAll = document.getElementById('admin-rooms-select-all');
      if (selectAll) selectAll.checked = _rooms.every(r => _roomsSelected.has(r.room_id));
      updateBulkBar();
    });
  });

  // Room ID / name click → detail drawer
  tbody.querySelectorAll('.admin-room-id-btn:not([data-wired])').forEach(btn => {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => _openRoomDetail(btn.dataset.roomId));
  });

  // Detail button
  tbody.querySelectorAll('.admin-action-detail:not([data-wired])').forEach(btn => {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => _openRoomDetail(btn.dataset.roomId));
  });

  // Copy link button
  tbody.querySelectorAll('.admin-action-copy:not([data-wired])').forEach(btn => {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const url = `${location.origin}${_roomUrl(btn.dataset.roomId)}`;
      navigator.clipboard.writeText(url).then(
        () => _showToast('Room link copied.', 'success'),
        () => _showToast('Could not copy link.', 'error'),
      );
    });
  });

  // Clear button
  tbody.querySelectorAll('.admin-action-clear:not([data-wired])').forEach(btn => {
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const roomId = btn.dataset.roomId;
      const ok = await showConfirm(
        `Clear content from room "${roomId}"?\n\nThe room is kept; only the note text is removed.`,
        { confirmLabel: 'Clear content', danger: true },
      );
      if (!ok) return;
      btn.disabled = true;
      const { error } = await _sb.from('syncpad_rooms')
        .update({ content: '', cleared_reason: 'manual' }).eq('room_id', roomId);
      if (error) {
        await showAlert(`Error clearing room: ${_friendlyErrorMessage(error)}`);
        btn.disabled = false; return;
      }
      const room = _rooms.find(r => r.room_id === roomId);
      if (room) room.content = '';
      await _logAdminAction('clear_room', { target_room_id: roomId });
      renderRows();
      await _loadStats();
      _showToast('Room content cleared.', 'success');
    });
  });

  // Delete button
  tbody.querySelectorAll('.admin-action-delete:not([data-wired])').forEach(btn => {
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const roomId = btn.dataset.roomId;
      const ok = await _adminTypedConfirm(
        `Delete room "${roomId}"?`,
        `This permanently removes the room, all files, and all reports.\n\nType the room ID to confirm:`,
        roomId,
      );
      if (!ok) return;
      btn.disabled = true;
      const { error } = await _deleteRoomAndStorage(roomId);
      if (error) {
        await showAlert(`Error deleting room: ${_friendlyErrorMessage(error)}`);
        btn.disabled = false; return;
      }
      const idx = _rooms.findIndex(r => r.room_id === roomId);
      if (idx !== -1) _rooms.splice(idx, 1);
      await _logAdminAction('delete_room', { target_room_id: roomId });
      renderRows();
      await _loadStats();
      _showToast('Room deleted.', 'success');
    });
  });
}

// ── Room detail drawer ────────────────────────────────────────────────────────

async function _openRoomDetail(roomId) {
  const drawer    = document.getElementById('admin-drawer');
  const inner     = document.getElementById('admin-drawer-inner');
  const backdrop  = document.getElementById('admin-drawer-backdrop');
  if (!drawer || !inner) return;

  inner.innerHTML = `<div class="admin-drawer-loading">Loading room details…</div>`;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  backdrop.classList.add('visible');

  // Fetch detailed room data
  const selectCols = [
    'room_id', 'room_name', 'content', 'created_at', 'updated_at', 'expires_at',
    'encryption_enabled', 'passcode_hash', 'view_once', 'viewed', 'editing_locked',
    'cleared_reason',
    ...(_hasQuarantine ? ['quarantined_at', 'quarantined_by', 'quarantine_reason'] : []),
  ].join(', ');

  const [roomRes, filesRes, reportsRes] = await Promise.allSettled([
    _sb.from('syncpad_rooms').select(selectCols).eq('room_id', roomId).single(),
    _sb.from('syncpad_files').select('id, filename, file_size, mime_type, uploaded_at').eq('room_id', roomId),
    _sb.from('syncpad_room_reports').select('id, report_reason, status, created_at').eq('room_id', roomId).order('created_at', { ascending: false }).limit(5),
  ]);

  const room    = roomRes.status === 'fulfilled'    ? roomRes.value.data    : null;
  const files   = filesRes.status === 'fulfilled'   ? filesRes.value.data  || [] : [];
  const reports = reportsRes.status === 'fulfilled' ? reportsRes.value.data || [] : [];

  if (!room) {
    inner.innerHTML = `<div class="admin-drawer-loading">Room not found or access denied.</div>`;
    return;
  }

  const totalFileSize = files.reduce((s, f) => s + (f.file_size || 0), 0);
  const isQuarantined = _hasQuarantine && !!room.quarantined_at;

  inner.innerHTML = `
    <div class="admin-drawer-header">
      <h2 class="admin-drawer-title">Room Details</h2>
      <button class="admin-drawer-close" id="admin-drawer-close-btn" aria-label="Close drawer">✕</button>
    </div>

    <div class="admin-drawer-body">

      <div class="admin-detail-section">
        <div class="admin-detail-row admin-detail-row--id">
          <span class="admin-detail-label">Room ID</span>
          <span class="admin-detail-value admin-detail-id">${escapeHtml(room.room_id)}
            <button class="admin-detail-copy" data-copy="${escapeHtml(room.room_id)}" title="Copy room ID">📋</button>
          </span>
        </div>
        ${room.room_name ? `
        <div class="admin-detail-row">
          <span class="admin-detail-label">Name</span>
          <span class="admin-detail-value">${escapeHtml(room.room_name)}</span>
        </div>` : ''}
        <div class="admin-detail-row">
          <span class="admin-detail-label">Created</span>
          <span class="admin-detail-value">${_fullDate(room.created_at)}</span>
        </div>
        <div class="admin-detail-row">
          <span class="admin-detail-label">Last updated</span>
          <span class="admin-detail-value">${_fullDate(room.updated_at)}</span>
        </div>
        <div class="admin-detail-row">
          <span class="admin-detail-label">Expires</span>
          <span class="admin-detail-value">${room.expires_at ? `${_fullDate(room.expires_at)} (${_isExpired(room.expires_at) ? 'expired' : 'active'})` : 'Never'}</span>
        </div>
      </div>

      <div class="admin-detail-section">
        <div class="admin-detail-row">
          <span class="admin-detail-label">Encrypted</span>
          <span class="admin-detail-value">${room.encryption_enabled ? '🔐 Yes' : 'No'}</span>
        </div>
        <div class="admin-detail-row">
          <span class="admin-detail-label">Passcode</span>
          <span class="admin-detail-value">${room.passcode_hash ? '🔑 Yes' : 'No'}</span>
        </div>
        <div class="admin-detail-row">
          <span class="admin-detail-label">View-once</span>
          <span class="admin-detail-value">${room.view_once ? `Yes${room.viewed ? ' (viewed)' : ' (not yet viewed)'}` : 'No'}</span>
        </div>
        <div class="admin-detail-row">
          <span class="admin-detail-label">Editing locked</span>
          <span class="admin-detail-value">${room.editing_locked ? '🔒 Yes' : 'No'}</span>
        </div>
        ${_hasQuarantine ? `
        <div class="admin-detail-row">
          <span class="admin-detail-label">Quarantined</span>
          <span class="admin-detail-value">${isQuarantined ? `⛔ Yes — ${escapeHtml(room.quarantine_reason || '')} (${_fullDate(room.quarantined_at)})` : 'No'}</span>
        </div>` : ''}
      </div>

      <div class="admin-detail-section">
        <div class="admin-detail-row">
          <span class="admin-detail-label">Files</span>
          <span class="admin-detail-value">${files.length} file${files.length !== 1 ? 's' : ''} (${formatFileSize(totalFileSize)})</span>
        </div>
        <div class="admin-detail-row">
          <span class="admin-detail-label">Reports</span>
          <span class="admin-detail-value">${reports.length ? reports.map(r => `<span class="admin-badge admin-badge--${r.status === 'new' ? 'alert' : 'muted'}">${escapeHtml(r.report_reason || r.status)}</span>`).join(' ') : 'None'}</span>
        </div>
        ${!room.encryption_enabled && room.content ? `
        <div class="admin-detail-row admin-detail-row--vertical">
          <span class="admin-detail-label">Content preview</span>
          <pre class="admin-detail-content-preview">${escapeHtml(room.content.slice(0, 300))}${room.content.length > 300 ? '\n…' : ''}</pre>
        </div>` : ''}
      </div>

      <div class="admin-detail-actions">
        <a class="admin-action-btn admin-action-primary" href="${_roomUrl(room.room_id)}" target="_blank" rel="noopener">↗ Open room</a>
        <button class="admin-action-btn admin-detail-copy" data-copy="${location.origin}${_roomUrl(room.room_id)}">🔗 Copy link</button>
        <button class="admin-action-btn admin-action-clear" id="drawer-clear-btn" data-room-id="${escapeHtml(room.room_id)}">🧹 Clear content</button>
        ${room.editing_locked
          ? `<button class="admin-action-btn" id="drawer-unlock-btn" data-room-id="${escapeHtml(room.room_id)}">🔓 Unlock editing</button>`
          : `<button class="admin-action-btn" id="drawer-lock-btn" data-room-id="${escapeHtml(room.room_id)}">🔒 Lock editing</button>`
        }
        ${_hasQuarantine && !isQuarantined
          ? `<button class="admin-action-btn admin-action-danger" id="drawer-quarantine-btn" data-room-id="${escapeHtml(room.room_id)}">⛔ Quarantine</button>`
          : ''}
        ${_hasQuarantine && isQuarantined
          ? `<button class="admin-action-btn" id="drawer-unquarantine-btn" data-room-id="${escapeHtml(room.room_id)}">✅ Unquarantine</button>`
          : ''}
        <button class="admin-action-btn admin-action-danger" id="drawer-delete-btn" data-room-id="${escapeHtml(room.room_id)}">🗑 Delete room</button>
      </div>

    </div>`;

  // Wire drawer buttons
  document.getElementById('admin-drawer-close-btn')?.addEventListener('click', _closeDrawer);

  inner.querySelectorAll('.admin-detail-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copy).then(
        () => _showToast('Copied.', 'success'),
        () => _showToast('Could not copy.', 'error'),
      );
    });
  });

  document.getElementById('drawer-clear-btn')?.addEventListener('click', async () => {
    const ok = await showConfirm(`Clear content from room "${room.room_id}"?`, { confirmLabel: 'Clear', danger: true });
    if (!ok) return;
    const { error } = await _sb.from('syncpad_rooms').update({ content: '', cleared_reason: 'manual' }).eq('room_id', room.room_id);
    if (error) { await showAlert(`Error: ${_friendlyErrorMessage(error)}`); return; }
    await _logAdminAction('clear_room', { target_room_id: room.room_id });
    _showToast('Room cleared.', 'success');
    _closeDrawer();
    await _loadStats();
  });

  document.getElementById('drawer-lock-btn')?.addEventListener('click', async () => {
    const { error } = await _sb.from('syncpad_rooms').update({ editing_locked: true }).eq('room_id', room.room_id);
    if (error) { await showAlert(`Error: ${_friendlyErrorMessage(error)}`); return; }
    await _logAdminAction('lock_editing', { target_room_id: room.room_id });
    _showToast('Editing locked.', 'success'); _closeDrawer();
  });
  document.getElementById('drawer-unlock-btn')?.addEventListener('click', async () => {
    const { error } = await _sb.from('syncpad_rooms').update({ editing_locked: false }).eq('room_id', room.room_id);
    if (error) { await showAlert(`Error: ${_friendlyErrorMessage(error)}`); return; }
    await _logAdminAction('unlock_editing', { target_room_id: room.room_id });
    _showToast('Editing unlocked.', 'success'); _closeDrawer();
  });

  document.getElementById('drawer-quarantine-btn')?.addEventListener('click', async () => {
    const reasonInput = await showPrompt('Enter a reason for quarantine (optional):', { placeholder: 'e.g. Abusive content' });
    if (reasonInput === null) return; // user cancelled
    // admin_quarantine_room() rejects an empty p_reason server-side. Supply a
    // default here so the RPC and the raw-update fallback below always agree
    // on a non-empty reason, rather than the fallback silently accepting an
    // empty one the RPC intentionally disallows.
    const reason = reasonInput.trim() || 'No reason provided';
    const { error } = await _sb.rpc('admin_quarantine_room', {
      p_room_id: room.room_id, p_reason: reason, p_quarantined_by: _session?.user?.email || 'admin',
    });
    if (error) {
      // Fall back to direct update if RPC not available
      const { error: e2 } = await _sb.from('syncpad_rooms').update({
        quarantined_at: new Date().toISOString(),
        quarantined_by: _session?.user?.email || 'admin',
        quarantine_reason: reason,
      }).eq('room_id', room.room_id);
      if (e2) { await showAlert(`Error: ${_friendlyErrorMessage(e2)}`); return; }
    }
    await _logAdminAction('quarantine_room', { target_room_id: room.room_id, metadata: { reason } });
    _showToast('Room quarantined.', 'success'); _closeDrawer();
  });

  document.getElementById('drawer-unquarantine-btn')?.addEventListener('click', async () => {
    const { error } = await _sb.rpc('admin_unquarantine_room', { p_room_id: room.room_id });
    if (error) {
      const { error: e2 } = await _sb.from('syncpad_rooms').update({
        quarantined_at: null, quarantined_by: null, quarantine_reason: null,
      }).eq('room_id', room.room_id);
      if (e2) { await showAlert(`Error: ${_friendlyErrorMessage(e2)}`); return; }
    }
    await _logAdminAction('unquarantine_room', { target_room_id: room.room_id });
    _showToast('Room unquarantined.', 'success'); _closeDrawer();
  });

  document.getElementById('drawer-delete-btn')?.addEventListener('click', async () => {
    const ok = await _adminTypedConfirm(
      `Delete room "${room.room_id}"?`,
      `This permanently removes the room, all files, and all reports. Type the room ID to confirm:`,
      room.room_id,
    );
    if (!ok) return;
    const { error } = await _deleteRoomAndStorage(room.room_id);
    if (error) { await showAlert(`Error: ${_friendlyErrorMessage(error)}`); return; }
    const idx = _rooms.findIndex(r => r.room_id === room.room_id);
    if (idx !== -1) _rooms.splice(idx, 1);
    await _logAdminAction('delete_room', { target_room_id: room.room_id });
    _showToast('Room deleted.', 'success');
    _closeDrawer();
    // Re-render the rooms table
    const tbody = document.getElementById('admin-rooms-tbody');
    if (tbody) {
      const row = tbody.querySelector(`tr[data-room-id="${CSS.escape(room.room_id)}"]`);
      row?.remove();
    }
    await _loadStats();
  });
}

function _closeDrawer() {
  const drawer    = document.getElementById('admin-drawer');
  const backdrop  = document.getElementById('admin-drawer-backdrop');
  if (!drawer) return;
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  backdrop?.classList.remove('visible');
}

// ── Reports tab ───────────────────────────────────────────────────────────────

async function _renderReportsTab(contentEl) {
  _reportsOffset = 0;
  _reports = [];

  const result = await _fetchReports(0);
  if (result.error) { contentEl.innerHTML = _accessDeniedHtml(result.error); return; }
  _reports = result.data || [];
  _reportsTotal = result.count ?? 0;

  contentEl.innerHTML = `
    <div class="admin-tab-content">

      <div class="admin-filter-chips" id="admin-report-filter-chips" role="group" aria-label="Filter reports">
        ${_reportFilterChips()}
      </div>

      <div class="admin-toolbar">
        <span class="admin-count-label" id="admin-reports-count"></span>
      </div>

      <div class="admin-table-wrap">
        <table class="admin-table">
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
        <div id="admin-reports-empty" class="admin-empty hidden"></div>
      </div>

      <div class="admin-load-more-row">
        <button class="admin-load-more-btn hidden" id="admin-reports-load-more">Load more reports</button>
      </div>

    </div>`;

  _wireReportsTab();
}

function _reportFilterChips() {
  const filters = [
    { id: 'new',      label: 'New' },
    { id: 'reviewed', label: 'Reviewed' },
    { id: 'dismissed',label: 'Dismissed' },
    { id: 'all',      label: 'All' },
  ];
  return filters.map(f =>
    `<button class="admin-chip${_reportsFilter === f.id ? ' active' : ''}" data-filter="${f.id}">${f.label}</button>`
  ).join('');
}

async function _fetchReports(offset) {
  let q = _sb.from('syncpad_room_reports')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + REPORTS_PAGE_SIZE - 1);
  if (_reportsFilter !== 'all') q = q.eq('status', _reportsFilter);
  return q;
}

function _wireReportsTab() {
  const tbody    = document.getElementById('admin-reports-tbody');
  const emptyEl  = document.getElementById('admin-reports-empty');
  const countEl  = document.getElementById('admin-reports-count');
  const loadMore = document.getElementById('admin-reports-load-more');

  // Filter chips
  document.getElementById('admin-report-filter-chips')?.addEventListener('click', async (e) => {
    const chip = e.target.closest('.admin-chip');
    if (!chip) return;
    _reportsFilter = chip.dataset.filter;
    _reportsOffset = 0; _reports = [];
    document.querySelectorAll('#admin-report-filter-chips .admin-chip').forEach(c => c.classList.toggle('active', c === chip));
    const r = await _fetchReports(0);
    if (!r.error) { _reports = r.data || []; _reportsTotal = r.count ?? 0; }
    renderRows();
  });

  // Load more
  loadMore?.addEventListener('click', async () => {
    loadMore.disabled = true; loadMore.textContent = 'Loading…';
    _reportsOffset += REPORTS_PAGE_SIZE;
    const r = await _fetchReports(_reportsOffset);
    if (!r.error && r.data?.length) {
      _reports.push(...r.data);
      _reportsTotal = r.count ?? _reportsTotal;
      renderRows(true);
    }
    loadMore.disabled = false; loadMore.textContent = 'Load more reports';
  });

  function statusBadge(status) {
    const map = { new: 'admin-badge--alert', reviewed: 'admin-badge--reviewed', dismissed: 'admin-badge--muted' };
    return `<span class="admin-badge ${map[status] || 'admin-badge--muted'}">${escapeHtml(status || '—')}</span>`;
  }

  function renderRows(append = false) {
    const visibleReports = append ? _reports.slice(-REPORTS_PAGE_SIZE) : _reports;
    if (!append) tbody.innerHTML = '';

    if (!_reports.length) {
      emptyEl.textContent = _reportsFilter === 'new'
        ? '✅ No open reports. You\'re all caught up!' : 'No reports match this filter.';
      emptyEl.classList.remove('hidden');
      if (countEl) countEl.textContent = '0 reports';
      if (loadMore) loadMore.classList.add('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    const rows = visibleReports.map(rep => {
      const details = rep.report_details
        ? escapeHtml(String(rep.report_details).slice(0, 80)) + (String(rep.report_details).length > 80 ? '…' : '')
        : '<span class="admin-muted">—</span>';
      return `
        <tr data-report-id="${escapeHtml(String(rep.id))}">
          <td>
            <button class="admin-room-id-btn admin-room-id" data-room-id="${escapeHtml(rep.room_id || '')}">${escapeHtml(rep.room_id || '—')}</button>
          </td>
          <td>${escapeHtml(rep.report_reason || '—')}</td>
          <td class="admin-content-preview">${details}</td>
          <td class="admin-ts">${formatTimestamp(rep.created_at)}</td>
          <td>${statusBadge(rep.status)}</td>
          <td class="admin-actions">
            ${rep.status === 'new'
              ? `<button class="admin-action-btn admin-action-primary"    data-report-id="${escapeHtml(String(rep.id))}" data-action="review">✓ Review</button>
                 <button class="admin-action-btn"                          data-report-id="${escapeHtml(String(rep.id))}" data-action="dismiss">✕ Dismiss</button>`
              : ''
            }
            ${rep.room_id
              ? `<button class="admin-action-btn admin-action-detail"     data-room-id="${escapeHtml(rep.room_id)}" data-action="view-room">👁 Room</button>
                 <button class="admin-action-btn admin-action-delete"     data-room-id="${escapeHtml(rep.room_id)}" data-report-id="${escapeHtml(String(rep.id))}" data-action="delete-room">🗑 Delete</button>`
              : ''
            }
          </td>
        </tr>`;
    }).join('');
    tbody.insertAdjacentHTML('beforeend', rows);

    const loaded = _reports.length;
    if (countEl) countEl.textContent = `${loaded} report${loaded !== 1 ? 's' : ''}`;
    if (loadMore) loadMore.classList.toggle('hidden', loaded >= (_reportsTotal || loaded));

    // Wire actions
    tbody.querySelectorAll('button[data-action]:not([data-wired])').forEach(btn => {
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        const action   = btn.dataset.action;
        const reportId = btn.dataset.reportId;
        const roomId   = btn.dataset.roomId;

        if (action === 'review') {
          btn.disabled = true;
          const { error } = await _sb.from('syncpad_room_reports').update({ status: 'reviewed' }).eq('id', reportId);
          if (error) { await showAlert(`Error: ${_friendlyErrorMessage(error)}`); btn.disabled = false; return; }
          const rep = _reports.find(r => String(r.id) === reportId);
          if (rep) rep.status = 'reviewed';
          await _logAdminAction('review_report', { target_report_id: reportId });
          renderRows();
          await _loadStats();
        }
        if (action === 'dismiss') {
          btn.disabled = true;
          const { error } = await _sb.from('syncpad_room_reports').update({ status: 'dismissed' }).eq('id', reportId);
          if (error) { await showAlert(`Error: ${_friendlyErrorMessage(error)}`); btn.disabled = false; return; }
          const rep = _reports.find(r => String(r.id) === reportId);
          if (rep) rep.status = 'dismissed';
          await _logAdminAction('dismiss_report', { target_report_id: reportId });
          renderRows();
          await _loadStats();
        }
        if (action === 'view-room') {
          _openRoomDetail(roomId);
        }
        if (action === 'delete-room') {
          const ok = await _adminTypedConfirm(
            `Delete room "${roomId}"?`,
            `Permanently deletes the room and all files. Type the room ID to confirm:`,
            roomId,
          );
          if (!ok) return;
          btn.disabled = true;
          const { error } = await _deleteRoomAndStorage(roomId);
          if (error) { await showAlert(`Error: ${_friendlyErrorMessage(error)}`); btn.disabled = false; return; }
          _reports.forEach(r => { if (r.room_id === roomId) r.status = 'reviewed'; });
          await _logAdminAction('delete_room', { target_room_id: roomId });
          renderRows();
          await _loadStats();
          _showToast('Room deleted.', 'success');
        }
      });
    });

    // Room ID links in reports
    tbody.querySelectorAll('.admin-room-id-btn:not([data-wired])').forEach(btn => {
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => { if (btn.dataset.roomId) _openRoomDetail(btn.dataset.roomId); });
    });
  }

  renderRows();
}

// ── Files tab ─────────────────────────────────────────────────────────────────

async function _renderFilesTab(contentEl) {
  _filesOffset = 0; _files = [];

  const [filesRes, statsRes] = await Promise.allSettled([
    _sb.from('syncpad_files')
      .select('id, filename, room_id, file_size, mime_type, uploaded_at, file_path', { count: 'exact' })
      .order('uploaded_at', { ascending: false })
      .range(0, FILES_PAGE_SIZE - 1),
    _sb.from('syncpad_files').select('file_size'),
  ]);

  if (filesRes.status === 'rejected' || filesRes.value?.error) {
    contentEl.innerHTML = _accessDeniedHtml(filesRes.value?.error || filesRes.reason);
    return;
  }

  _files     = filesRes.value.data || [];
  _filesTotal = filesRes.value.count ?? 0;

  const allFiles   = statsRes.status === 'fulfilled' ? statsRes.value.data || [] : [];
  const totalSize  = allFiles.reduce((s, f) => s + (f.file_size || 0), 0);

  contentEl.innerHTML = `
    <div class="admin-tab-content">

      <div class="admin-file-stats-row">
        <div class="admin-file-stat">
          <div class="admin-file-stat-value">${_filesTotal}</div>
          <div class="admin-file-stat-label">Total files</div>
        </div>
        <div class="admin-file-stat">
          <div class="admin-file-stat-value">${formatFileSize(totalSize)}</div>
          <div class="admin-file-stat-label">Total storage used</div>
        </div>
      </div>

      <div class="admin-toolbar">
        <input id="admin-files-search" class="admin-search-input" placeholder="Search by filename or room ID…" autocomplete="off" />
        <span class="admin-count-label" id="admin-files-count"></span>
      </div>

      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Room ID</th>
              <th>Size</th>
              <th>Uploaded</th>
              <th>Type</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="admin-files-tbody"></tbody>
        </table>
        <div id="admin-files-empty" class="admin-empty hidden">No files found.</div>
      </div>

      <div class="admin-load-more-row">
        <button class="admin-load-more-btn hidden" id="admin-files-load-more">Load more files</button>
      </div>

    </div>`;

  _wireFilesTab();
}

function _wireFilesTab() {
  const tbody    = document.getElementById('admin-files-tbody');
  const emptyEl  = document.getElementById('admin-files-empty');
  const countEl  = document.getElementById('admin-files-count');
  const loadMore = document.getElementById('admin-files-load-more');
  const searchEl = document.getElementById('admin-files-search');

  let allFiles = [..._files]; // local copy for search

  let searchTimer;
  searchEl?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = searchEl.value.toLowerCase().trim();
      const filtered = q
        ? _files.filter(f => f.filename.toLowerCase().includes(q) || f.room_id.toLowerCase().includes(q))
        : _files;
      renderRows(filtered);
    }, 250);
  });

  loadMore?.addEventListener('click', async () => {
    loadMore.disabled = true; loadMore.textContent = 'Loading…';
    _filesOffset += FILES_PAGE_SIZE;
    const { data, error } = await _sb.from('syncpad_files')
      .select('id, filename, room_id, file_size, mime_type, uploaded_at, file_path')
      .order('uploaded_at', { ascending: false })
      .range(_filesOffset, _filesOffset + FILES_PAGE_SIZE - 1);
    if (!error && data?.length) {
      _files.push(...data);
      allFiles = [..._files];
      // Re-apply the active search filter (if any) to the newly-extended set
      // and do a full (non-append) re-render, so "Load more" doesn't silently
      // drop back to showing unfiltered results.
      const q = searchEl?.value.toLowerCase().trim();
      const filtered = q
        ? allFiles.filter(f => f.filename.toLowerCase().includes(q) || f.room_id.toLowerCase().includes(q))
        : allFiles;
      renderRows(filtered, false);
    }
    loadMore.disabled = false; loadMore.textContent = 'Load more files';
  });

  function renderRows(files, append = false) {
    if (!append) tbody.innerHTML = '';

    if (!files.length) {
      emptyEl.classList.remove('hidden');
      if (countEl) countEl.textContent = '0 files';
      if (loadMore) loadMore.classList.add('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    const visibleFiles = append ? files.slice(-FILES_PAGE_SIZE) : files;
    tbody.insertAdjacentHTML('beforeend', visibleFiles.map(f => `
      <tr data-file-id="${escapeHtml(String(f.id))}">
        <td class="admin-filename">${escapeHtml(f.filename || '—')}</td>
        <td>
          <button class="admin-room-id-btn admin-room-id" data-room-id="${escapeHtml(f.room_id || '')}">${escapeHtml(f.room_id || '—')}</button>
        </td>
        <td class="admin-ts">${formatFileSize(f.file_size)}</td>
        <td class="admin-ts">${formatTimestamp(f.uploaded_at)}</td>
        <td class="admin-ts">${escapeHtml((f.mime_type || '').split('/')[1] || f.mime_type || '—')}</td>
        <td class="admin-actions">
          <button class="admin-action-btn admin-action-delete" data-file-id="${escapeHtml(String(f.id))}" data-file-path="${escapeHtml(f.file_path || '')}" data-filename="${escapeHtml(f.filename || '')}" title="Delete file">🗑 Delete</button>
        </td>
      </tr>`).join(''));

    if (countEl) countEl.textContent = `${_files.length}${_filesTotal > _files.length ? ' of ' + _filesTotal : ''} file${_files.length !== 1 ? 's' : ''}`;
    if (loadMore) loadMore.classList.toggle('hidden', _files.length >= _filesTotal);

    // Wire room ID links
    tbody.querySelectorAll('.admin-room-id-btn:not([data-wired])').forEach(btn => {
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => { if (btn.dataset.roomId) _openRoomDetail(btn.dataset.roomId); });
    });

    // Wire delete buttons
    tbody.querySelectorAll('.admin-action-delete:not([data-wired])').forEach(btn => {
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        const fileId   = btn.dataset.fileId;
        const filePath = btn.dataset.filePath;
        const filename = btn.dataset.filename;
        const ok = await showConfirm(`Delete file "${filename}"?\nThis cannot be undone.`, { confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        btn.disabled = true;

        // Delete from storage first, then DB
        const { error: se } = await _sb.storage.from(FILES_BUCKET).remove([filePath]);
        if (se) {
          await showAlert(`Storage delete error: ${_friendlyErrorMessage(se)}\nThe file may already be missing.`);
          // Continue to remove DB row regardless
        }
        const { error: de } = await _sb.from('syncpad_files').delete().eq('id', fileId);
        if (de) { await showAlert(`DB row delete error: ${_friendlyErrorMessage(de)}`); btn.disabled = false; return; }

        const idx = _files.findIndex(f => String(f.id) === fileId);
        if (idx !== -1) { _files.splice(idx, 1); allFiles = [..._files]; }
        await _logAdminAction('delete_file', { target_file_id: fileId });
        const row = tbody.querySelector(`tr[data-file-id="${CSS.escape(fileId)}"]`);
        row?.remove();
        _filesTotal = Math.max(0, _filesTotal - 1);
        if (countEl) countEl.textContent = `${_files.length} file${_files.length !== 1 ? 's' : ''}`;
        await _loadStats();
        _showToast('File deleted.', 'success');
      });
    });
  }

  renderRows(allFiles);
}

// ── Audit log tab ─────────────────────────────────────────────────────────────

async function _renderAuditTab(contentEl) {
  if (!_hasAuditTable) {
    contentEl.innerHTML = `
      <div class="admin-tab-content">
        <div class="admin-empty admin-audit-empty">
          <div class="admin-audit-empty-icon">📋</div>
          <div class="admin-audit-empty-title">Audit log not configured</div>
          <div class="admin-audit-empty-body">
            The <code>syncpad_admin_audit_logs</code> table does not exist yet.
            Run the migration to enable audit logging for all admin actions.
          </div>
          <div class="admin-audit-empty-actions">
            <a class="admin-action-btn admin-action-primary" href="https://github.com/Spairkie/SyncPad/blob/main/supabase/migrations/0006_admin_dashboard_improvements.sql" target="_blank" rel="noopener">View migration SQL</a>
          </div>
        </div>
      </div>`;
    return;
  }

  _auditOffset = 0; _audit = [];
  const { data, error, count } = await _sb
    .from('syncpad_admin_audit_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(0, AUDIT_PAGE_SIZE - 1);

  if (error) { contentEl.innerHTML = _accessDeniedHtml(error); return; }
  _audit = data || [];

  contentEl.innerHTML = `
    <div class="admin-tab-content">
      <div class="admin-toolbar">
        <span class="admin-count-label" id="admin-audit-count"></span>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Admin</th>
              <th>Action</th>
              <th>Target Room</th>
              <th>Result</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody id="admin-audit-tbody"></tbody>
        </table>
        <div id="admin-audit-empty" class="admin-empty hidden">No audit logs found.</div>
      </div>
      <div class="admin-load-more-row">
        <button class="admin-load-more-btn hidden" id="admin-audit-load-more">Load more logs</button>
      </div>
    </div>`;

  const tbody    = document.getElementById('admin-audit-tbody');
  const emptyEl  = document.getElementById('admin-audit-empty');
  const countEl  = document.getElementById('admin-audit-count');
  const loadMore = document.getElementById('admin-audit-load-more');
  let total = count ?? 0;

  function renderRows(append = false) {
    const visible = append ? _audit.slice(-AUDIT_PAGE_SIZE) : _audit;
    if (!append) tbody.innerHTML = '';
    if (!_audit.length) {
      emptyEl.textContent = 'No audit logs yet.'; emptyEl.classList.remove('hidden');
      if (countEl) countEl.textContent = '0 entries';
      return;
    }
    emptyEl.classList.add('hidden');
    tbody.insertAdjacentHTML('beforeend', visible.map(log => `
      <tr>
        <td class="admin-ts">${escapeHtml(log.admin_email || '—')}</td>
        <td><code class="admin-audit-action">${escapeHtml(log.action_type || '—')}</code></td>
        <td>${log.target_room_id ? `<button class="admin-room-id-btn admin-room-id" data-room-id="${escapeHtml(log.target_room_id)}">${escapeHtml(log.target_room_id)}</button>` : '<span class="admin-muted">—</span>'}</td>
        <td><span class="admin-badge ${log.result === 'failure' ? 'admin-badge--alert' : 'admin-badge--reviewed'}">${escapeHtml(log.result || 'success')}</span></td>
        <td class="admin-ts">${formatTimestamp(log.created_at)}</td>
      </tr>`).join(''));

    if (countEl) countEl.textContent = `${_audit.length}${total > _audit.length ? ' of ' + total : ''} log entries`;
    if (loadMore) loadMore.classList.toggle('hidden', _audit.length >= total);

    tbody.querySelectorAll('.admin-room-id-btn:not([data-wired])').forEach(btn => {
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => _openRoomDetail(btn.dataset.roomId));
    });
  }

  loadMore?.addEventListener('click', async () => {
    loadMore.disabled = true; loadMore.textContent = 'Loading…';
    _auditOffset += AUDIT_PAGE_SIZE;
    const { data: more, error: e2 } = await _sb
      .from('syncpad_admin_audit_logs')
      .select('*').order('created_at', { ascending: false })
      .range(_auditOffset, _auditOffset + AUDIT_PAGE_SIZE - 1);
    if (!e2 && more?.length) { _audit.push(...more); renderRows(true); }
    loadMore.disabled = false; loadMore.textContent = 'Load more logs';
  });

  renderRows();
}

// ── Cleanup tab ───────────────────────────────────────────────────────────────

async function _renderCleanupTab(contentEl) {
  contentEl.innerHTML = `
    <div class="admin-tab-content admin-cleanup">
      <div class="admin-cleanup-section">
        <h3>🧹 Cleanup Expired Rooms</h3>
        <p class="admin-cleanup-desc">
          Run the server-side cleanup function to permanently delete all rooms whose
          expiry time (<code>expires_at</code>) has passed. This calls the
          <code>run_cleanup_expired_syncpad_rooms_as_admin()</code> database function.
        </p>
        <button id="admin-cleanup-btn" class="admin-action-btn admin-action-primary">Run cleanup</button>
        <div id="admin-cleanup-result" class="admin-cleanup-result hidden"></div>
      </div>

      <hr class="admin-divider" />

      <div class="admin-cleanup-section admin-cleanup-danger">
        <h3>⚠️ Manual Expired Room Deletion</h3>
        <p class="admin-cleanup-desc">
          Directly delete all rooms where <code>expires_at</code> is in the past.
          Use this only if the RPC function is unavailable. This action is <strong>irreversible</strong>.
        </p>
        <button id="admin-manual-cleanup-btn" class="admin-action-btn admin-action-danger">Delete all expired rooms now</button>
        <div id="admin-manual-cleanup-result" class="admin-cleanup-result hidden"></div>
      </div>

      <hr class="admin-divider" />

      <div class="admin-cleanup-section">
        <h3>🗑️ Storage Orphan Reconciliation</h3>
        <p class="admin-cleanup-desc">
          Calls the <code>syncpad-cleanup</code> Edge Function to find files that exist in
          Storage but have no matching <code>syncpad_files</code> row — left behind by
          interrupted uploads or gaps this dashboard doesn't otherwise cover — and remove
          them. Starts with a dry run; nothing is deleted until you confirm the count.
          Requires the Edge Function to be deployed (<code>supabase functions deploy syncpad-cleanup</code>).
        </p>
        <button id="admin-orphan-preview-btn" class="admin-action-btn admin-action-primary">Preview orphaned files</button>
        <div id="admin-orphan-result" class="admin-cleanup-result hidden"></div>
      </div>
    </div>`;

  document.getElementById('admin-cleanup-btn').addEventListener('click', async () => {
    const btn = document.getElementById('admin-cleanup-btn');
    const resultEl = document.getElementById('admin-cleanup-result');
    const ok = await showConfirm('Run server-side cleanup to delete all expired rooms?', { confirmLabel: 'Run cleanup' });
    if (!ok) return;
    btn.disabled = true; btn.textContent = 'Running…';
    resultEl.classList.add('hidden'); resultEl.className = 'admin-cleanup-result';

    // The RPC deletes DB rows for expired encrypted rooms outright, but a raw
    // SQL delete never touches Storage — it would silently orphan their files.
    // Snapshot which rooms it's about to delete and sweep their files first,
    // the same way the manual danger-button path already does.
    const { storagePaths, error: snapshotErr } = await _listExpiredEncryptedRoomFilePaths();
    if (snapshotErr) {
      btn.disabled = false; btn.textContent = 'Run cleanup';
      resultEl.classList.remove('hidden'); resultEl.classList.add('admin-cleanup-result--error');
      resultEl.textContent = `Error: ${snapshotErr.message}`;
      return;
    }
    const { error: storageErr } = await _removeStorageObjects(storagePaths);
    if (storageErr) {
      btn.disabled = false; btn.textContent = 'Run cleanup';
      resultEl.classList.remove('hidden'); resultEl.classList.add('admin-cleanup-result--error');
      resultEl.textContent = `Error clearing storage: ${storageErr.message}`;
      return;
    }

    const { data, error } = await _sb.rpc('run_cleanup_expired_syncpad_rooms_as_admin');
    btn.disabled = false; btn.textContent = 'Run cleanup';
    if (error) {
      resultEl.classList.remove('hidden'); resultEl.classList.add('admin-cleanup-result--error');
      resultEl.textContent = `Error: ${_friendlyErrorMessage(error)}`;
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    const cleared = row?.cleared_unencrypted ?? 0;
    const deleted = row?.deleted_encrypted ?? 0;
    resultEl.classList.remove('hidden'); resultEl.classList.add('admin-cleanup-result--success');
    resultEl.textContent = `✓ Cleanup complete. ${cleared} room${cleared !== 1 ? 's' : ''} cleared, ${deleted} encrypted room${deleted !== 1 ? 's' : ''} deleted (${storagePaths.length} file${storagePaths.length !== 1 ? 's' : ''} removed from storage).`;
    await _logAdminAction('cleanup_expired', { metadata: { cleared_unencrypted: cleared, deleted_encrypted: deleted, storage_files_removed: storagePaths.length } });
    await _loadStats();
  });

  document.getElementById('admin-manual-cleanup-btn').addEventListener('click', async () => {
    const btn = document.getElementById('admin-manual-cleanup-btn');
    const resultEl = document.getElementById('admin-manual-cleanup-result');
    const ok = await showConfirm('Delete ALL rooms where expires_at is in the past?\n\nThis is permanent and cannot be undone.', { confirmLabel: 'Delete all expired', danger: true });
    if (!ok) return;
    btn.disabled = true; btn.textContent = 'Deleting…';
    resultEl.classList.add('hidden'); resultEl.className = 'admin-cleanup-result';
    const { error, count } = await _deleteExpiredRoomsAndStorage();
    btn.disabled = false; btn.textContent = 'Delete all expired rooms now';
    if (error) {
      resultEl.classList.remove('hidden'); resultEl.classList.add('admin-cleanup-result--error');
      resultEl.textContent = `Error: ${_friendlyErrorMessage(error)}`; return;
    }
    const deleted = count ?? '?';
    resultEl.classList.remove('hidden'); resultEl.classList.add('admin-cleanup-result--success');
    resultEl.textContent = `✓ Deleted ${deleted} expired room${deleted !== 1 ? 's' : ''}.`;
    await _logAdminAction('manual_cleanup_expired', { metadata: { deleted_count: deleted } });
    await _loadStats();
  });

  _wireOrphanReconciliation();
}

function _wireOrphanReconciliation() {
  const previewBtn = document.getElementById('admin-orphan-preview-btn');
  const resultEl   = document.getElementById('admin-orphan-result');

  const invoke = (dryRun) => _sb.functions.invoke('syncpad-cleanup', { body: { mode: 'orphans', dryRun } });

  const showError = (error) => {
    resultEl.classList.remove('hidden'); resultEl.className = 'admin-cleanup-result admin-cleanup-result--error';
    resultEl.textContent = `Error: ${error?.message || 'Edge Function unavailable — is it deployed?'}`;
  };

  const runRemoval = async (orphanCount) => {
    const ok = await showConfirm(
      `Permanently delete ${orphanCount} orphaned file${orphanCount !== 1 ? 's' : ''} from storage?\n\nThis cannot be undone.`,
      { confirmLabel: 'Delete orphaned files', danger: true },
    );
    if (!ok) return;
    previewBtn.disabled = true;
    const { data, error } = await invoke(false);
    previewBtn.disabled = false; previewBtn.textContent = 'Preview orphaned files';
    if (error) { showError(error); return; }
    const removed = data?.orphans?.storageObjects?.removed ?? 0;
    resultEl.classList.remove('hidden'); resultEl.className = 'admin-cleanup-result admin-cleanup-result--success';
    resultEl.textContent = `✓ Removed ${removed} orphaned file${removed !== 1 ? 's' : ''} from storage.`;
    await _logAdminAction('reconcile_storage_orphans', { metadata: { removed } });
  };

  previewBtn.addEventListener('click', async () => {
    previewBtn.disabled = true; previewBtn.textContent = 'Scanning…';
    resultEl.classList.add('hidden'); resultEl.className = 'admin-cleanup-result';
    const { data, error } = await invoke(true);
    previewBtn.disabled = false; previewBtn.textContent = 'Preview orphaned files';
    if (error) { showError(error); return; }

    const orphanCount = data?.orphans?.orphanObjects ?? 0;
    const storedCount = data?.orphans?.storedObjects ?? 0;
    const trackedCount = data?.orphans?.trackedObjects ?? 0;
    resultEl.classList.remove('hidden'); resultEl.className = 'admin-cleanup-result';
    if (!orphanCount) {
      resultEl.classList.add('admin-cleanup-result--success');
      resultEl.textContent = `✓ No orphans found (${storedCount} stored, ${trackedCount} tracked).`;
      return;
    }
    resultEl.innerHTML = `Found <strong>${orphanCount}</strong> orphaned file${orphanCount !== 1 ? 's' : ''} out of ${storedCount} stored (${trackedCount} tracked). `;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'admin-action-btn admin-action-danger';
    removeBtn.textContent = `Remove ${orphanCount} orphaned file${orphanCount !== 1 ? 's' : ''}`;
    removeBtn.style.marginTop = '0.5rem';
    removeBtn.addEventListener('click', () => runRemoval(orphanCount));
    resultEl.appendChild(document.createElement('br'));
    resultEl.appendChild(removeBtn);
  });
}

// ── Audit logging ─────────────────────────────────────────────────────────────

async function _logAdminAction(actionType, details = {}) {
  if (!_hasAuditTable || !_sb) return;
  try {
    await _sb.from('syncpad_admin_audit_logs').insert({
      admin_email:     _session?.user?.email,
      action_type:     actionType,
      target_room_id:  details.target_room_id || null,
      target_file_id:  details.target_file_id || null,
      target_report_id: details.target_report_id || null,
      result:          details.result || 'success',
      error_msg:       details.error_msg || null,
      metadata:        details.metadata || null,
    });
  } catch { /* silently swallow — audit failure must not break admin actions */ }
}

// ── Storage helpers ───────────────────────────────────────────────────────────

async function _listRoomFilePaths(roomId) {
  const { rows, error } = await _selectAllPages((from, to) =>
    _sb.from('syncpad_files').select('file_path').eq('room_id', roomId).order('id').range(from, to)
  );
  if (error) return { paths: [], error };
  return { paths: rows.map(r => r.file_path).filter(Boolean), error: null };
}

async function _removeStorageObjects(paths) {
  const unique = Array.from(new Set((paths || []).filter(Boolean)));
  for (let i = 0; i < unique.length; i += STORAGE_REMOVE_BATCH_SIZE) {
    const { error } = await _sb.storage.from(FILES_BUCKET).remove(unique.slice(i, i + STORAGE_REMOVE_BATCH_SIZE));
    if (error) return { error };
  }
  return { error: null };
}

function _chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Page through every row matching a query via .range(), rather than relying
 * on a single unpaginated select — which PostgREST silently truncates at its
 * own default page size. `queryFactory(from, to)` must apply `.range(from, to)`
 * to the same query each call — and must also apply a stable `.order()` on a
 * unique column. Without one, PostgREST doesn't guarantee the same row
 * ordering between separate paginated requests, so rows can be skipped or
 * duplicated across pages once a query matches more than one page's worth —
 * silently dropping a file path from a cleanup sweep while the accompanying
 * delete still removes every matching row.
 */
async function _selectAllPages(queryFactory) {
  const rows = [];
  for (let from = 0; ; from += SELECT_ALL_PAGE_SIZE) {
    const to = from + SELECT_ALL_PAGE_SIZE - 1;
    const { data, error } = await queryFactory(from, to);
    if (error) return { rows, error };
    const page = data || [];
    rows.push(...page);
    if (page.length < SELECT_ALL_PAGE_SIZE) break;
  }
  return { rows, error: null };
}

async function _deleteRoomAndStorage(roomId) {
  const { paths, error: listErr } = await _listRoomFilePaths(roomId);
  if (listErr) return { error: listErr };
  const { error: storageErr } = await _removeStorageObjects(paths);
  if (storageErr) return { error: storageErr };
  const { error } = await _sb.from('syncpad_rooms').delete().eq('room_id', roomId);
  if (!error) {
    // syncpad_room_reports.room_id has no FK to syncpad_rooms, so report rows
    // survive the room delete. Mark any still-"new" reports reviewed so they
    // don't keep reappearing in the "New" filter/stat card pointing at a room
    // that no longer exists. Best-effort: the room delete already succeeded
    // and must not be reported as failed because of this secondary write.
    try {
      await _sb.from('syncpad_room_reports').update({ status: 'reviewed' }).eq('room_id', roomId).eq('status', 'new');
    } catch (e) {
      console.error('[admin] failed to mark reports reviewed after room delete', e);
    }
  }
  return { error };
}

async function _listExpiredEncryptedRoomFilePaths() {
  const nowIso = new Date().toISOString();
  const { rows: rooms, error: roomsErr } = await _selectAllPages((from, to) =>
    _sb.from('syncpad_rooms').select('room_id')
      .lt('expires_at', nowIso).not('expires_at', 'is', null).eq('encryption_enabled', true)
      .order('room_id').range(from, to)
  );
  if (roomsErr) return { storagePaths: [], error: roomsErr };
  const roomIds = rooms.map(r => r.room_id).filter(Boolean);
  if (!roomIds.length) return { storagePaths: [], error: null };

  const paths = [];
  for (const batch of _chunks(roomIds, ADMIN_QUERY_BATCH_SIZE)) {
    const { rows, error } = await _selectAllPages((from, to) =>
      _sb.from('syncpad_files').select('file_path').in('room_id', batch).order('id').range(from, to)
    );
    if (error) return { storagePaths: [], error };
    paths.push(...rows.map(r => r.file_path).filter(Boolean));
  }
  return { storagePaths: paths, error: null };
}

async function _deleteExpiredRoomsAndStorage() {
  const nowIso = new Date().toISOString();
  const { rows: rooms, error: roomsErr } = await _selectAllPages((from, to) =>
    _sb.from('syncpad_rooms').select('room_id').lt('expires_at', nowIso).not('expires_at', 'is', null)
      .order('room_id').range(from, to)
  );
  if (roomsErr) return { error: roomsErr, count: null };
  const roomIds = rooms.map(r => r.room_id).filter(Boolean);
  if (!roomIds.length) return { error: null, count: 0 };

  const files = [];
  for (const batch of _chunks(roomIds, ADMIN_QUERY_BATCH_SIZE)) {
    const { rows, error } = await _selectAllPages((from, to) =>
      _sb.from('syncpad_files').select('file_path').in('room_id', batch).order('id').range(from, to)
    );
    if (error) return { error, count: null };
    files.push(...rows);
  }
  const { error: storageErr } = await _removeStorageObjects(files.map(r => r.file_path));
  if (storageErr) return { error: storageErr, count: null };

  let deleted = 0;
  for (const batch of _chunks(roomIds, ADMIN_QUERY_BATCH_SIZE)) {
    const { error, count } = await _sb.from('syncpad_rooms').delete({ count: 'exact' }).in('room_id', batch);
    if (error) return { error, count: null };
    deleted += count || 0;
  }

  // Mirrors _deleteRoomAndStorage()'s report cleanup, batched the same way as
  // the rest of this function. syncpad_room_reports.room_id has no FK to
  // syncpad_rooms, so report rows survive the room delete — best-effort, the
  // room deletes already succeeded and must not be reported as failed because
  // of this secondary write.
  for (const batch of _chunks(roomIds, ADMIN_QUERY_BATCH_SIZE)) {
    try {
      await _sb.from('syncpad_room_reports').update({ status: 'reviewed' }).in('room_id', batch).eq('status', 'new');
    } catch (e) {
      console.error('[admin] failed to mark reports reviewed after expired-room cleanup', e);
    }
  }

  return { error: null, count: deleted };
}

// ── Utility helpers ───────────────────────────────────────────────────────────

function _isExpired(expiresAt) {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

function _fullDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return dateStr; }
}

function _showToast(message, type = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast${type ? ' toast-' + type : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => { toast.classList.remove('visible'); setTimeout(() => toast.remove(), 300); }, 2800);
}

// Shared by every admin query/mutation error path — a session that expires
// mid-action should read exactly the same as one that expired before the
// page loaded, per docs/security.md ("You do not have admin access.",
// not the raw Postgres/PostgREST error).
function _isRlsError(error) {
  return error?.code === 'PGRST301' || error?.message?.includes('permission') || error?.message?.includes('policy');
}

function _friendlyErrorMessage(error) {
  return _isRlsError(error) ? 'You do not have admin access.' : (error?.message || 'Unknown error');
}

function _accessDeniedHtml(error) {
  const isRls = _isRlsError(error);
  return `
    <div class="admin-access-denied">
      <div class="admin-access-denied-icon">🚫</div>
      <div class="admin-access-denied-title">${isRls ? 'You do not have admin access.' : 'Failed to load data.'}</div>
      ${isRls ? '' : `<div class="admin-access-denied-detail">${escapeHtml(error?.message ?? 'Unknown error')}</div>`}
      <div style="margin-top:1rem">
        <button onclick="window.location.reload()" class="admin-action-btn admin-action-primary">Retry</button>
      </div>
    </div>`;
}

function _skeletonTabHtml() {
  return `
    <div class="admin-tab-content admin-skeleton-tab" aria-busy="true" aria-label="Loading…">
      <div class="admin-toolbar">
        <div class="admin-skeleton-bar" style="width:220px;height:32px;border-radius:6px"></div>
        <div class="admin-skeleton-bar" style="width:80px;height:16px;border-radius:4px"></div>
      </div>
      <div class="admin-table-wrap">
        ${Array.from({ length: 5 }, () => `
          <div class="admin-skeleton-row">
            <div class="admin-skeleton-bar" style="width:5%;height:14px;border-radius:3px"></div>
            <div class="admin-skeleton-bar" style="width:22%;height:14px;border-radius:3px"></div>
            <div class="admin-skeleton-bar" style="width:12%;height:14px;border-radius:3px"></div>
            <div class="admin-skeleton-bar" style="width:12%;height:14px;border-radius:3px"></div>
            <div class="admin-skeleton-bar" style="width:10%;height:14px;border-radius:3px"></div>
            <div class="admin-skeleton-bar" style="width:18%;height:14px;border-radius:3px"></div>
          </div>`).join('')}
      </div>
    </div>`;
}

// ── Admin dialog helpers ──────────────────────────────────────────────────────

function _adminGetHost() {
  return document.getElementById('admin-screen') || document.body;
}

function _adminTypedConfirm(title, description, expectedValue) {
  return new Promise((resolve) => {
    _ensureAdminDialogStyles();
    const host = _adminGetHost();
    const el = document.createElement('div');
    el.className = 'admin-dialog-backdrop';
    el.innerHTML = `
      <div class="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="adlg-title">
        <div id="adlg-title" class="admin-dialog-title">${escapeHtml(title)}</div>
        <p class="admin-dialog-msg">${escapeHtml(description).replace(/\n/g, '<br>')}</p>
        <input class="admin-dialog-input" type="text" autocomplete="off" spellcheck="false"
          placeholder="${escapeHtml(expectedValue)}" aria-label="Confirmation input" />
        <div class="admin-dialog-actions">
          <button class="admin-dialog-cancel admin-dialog-btn">Cancel</button>
          <button class="admin-dialog-ok admin-dialog-btn admin-dialog-btn--danger" disabled>Confirm</button>
        </div>
      </div>`;
    host.appendChild(el);
    const input = el.querySelector('.admin-dialog-input');
    const okBtn = el.querySelector('.admin-dialog-ok');
    const cleanup = (r) => { el.remove(); document.removeEventListener('keydown', onKey); resolve(r); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); cleanup(false); } };
    input.addEventListener('input', () => { okBtn.disabled = input.value !== expectedValue; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !okBtn.disabled) cleanup(true); });
    okBtn.addEventListener('click', () => { if (!okBtn.disabled) cleanup(true); });
    el.querySelector('.admin-dialog-cancel').addEventListener('click', () => cleanup(false));
    el.addEventListener('click', (e) => { if (e.target === el) cleanup(false); });
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => input.focus());
  });
}

let _adminDialogStylesInjected = false;
function _ensureAdminDialogStyles() {
  if (_adminDialogStylesInjected) return;
  _adminDialogStylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.admin-dialog-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999}
.admin-dialog{background:var(--bg-surface,#1e1e2e);border:1px solid var(--border,#333);border-radius:10px;padding:1.5rem;max-width:440px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.4)}
.admin-dialog-title{font-weight:700;font-size:1rem;margin-bottom:.5rem;color:var(--text-primary,#e0e0e0)}
.admin-dialog-msg{margin:0 0 1rem;font-size:.9rem;color:var(--text-secondary,#aaa);line-height:1.5;white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word}
.admin-dialog-title{overflow-wrap:break-word;word-break:break-word}
.admin-dialog-input{width:100%;padding:.5rem .75rem;font-size:.875rem;border:1px solid var(--border,#333);border-radius:6px;background:var(--bg-elevated,#252538);color:var(--text-primary,#e0e0e0);margin-bottom:1rem;box-sizing:border-box;font-family:monospace}
.admin-dialog-input:focus{outline:none;border-color:var(--accent,#f5a623)}
.admin-dialog-actions{display:flex;justify-content:flex-end;gap:.5rem;flex-wrap:wrap}
.admin-dialog-btn{padding:.45rem 1rem;border-radius:6px;border:1px solid var(--border,#333);font-size:.875rem;cursor:pointer;transition:opacity .15s}
.admin-dialog-btn:disabled{opacity:.4;cursor:not-allowed}
.admin-dialog-btn--primary{background:var(--accent,#f5a623);color:var(--text-inverse,#000);border-color:var(--accent,#f5a623)}
.admin-dialog-btn--danger{background:var(--red,#f87171);color:var(--text-inverse,#fff);border-color:var(--red,#f87171)}
.admin-dialog-cancel{background:var(--bg-elevated,#252538);color:var(--text-primary,#e0e0e0)}
`;
  document.head.appendChild(style);
}
