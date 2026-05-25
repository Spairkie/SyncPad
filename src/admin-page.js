import { getSupabaseClient } from './supabase.js';
import { escapeHtml, formatFileSize, formatTimestamp } from './utils.js';

const ADMIN_CHECK_TIMEOUT_MS = 10000;

const PHASE = {
  LOADING_SESSION: 'loading-session',
  LOGGED_OUT: 'logged-out',
  CHECKING_ADMIN: 'checking-admin',
  DENIED: 'denied',
  LOADING_DASHBOARD: 'loading-dashboard',
  DASHBOARD: 'dashboard',
  ERROR: 'error',
};

const state = {
  phase: PHASE.LOADING_SESSION,
  session: null,
  isAdmin: false,
  rooms: [],
  filesByRoom: new Map(),
  shareSet: new Set(),
  filter: 'all',
  sort: 'updated_desc',
  search: '',
  selectedRoomId: null,
  authError: '',
  adminCheckError: '',
  dashboardErrors: [],
  pendingSignOut: false,
  inFlight: false,
  refreshQueued: false,
  lastValidatedSessionKey: null,
};

let _authSub = null;
let _renderQueued = false;

export async function mountAdminPage() {
  const root = document.getElementById('admin-screen');
  if (!root) return;

  root.innerHTML = _shell();
  _unsubscribeAuth();
  _resetAdminState({ keepSession: true });
  state.phase = PHASE.LOADING_SESSION;
  _queueRender();

  const sb = getSupabaseClient();
  _authSub = sb.auth.onAuthStateChange((_event, session) => {
    state.session = session || null;
    if (!session) {
      state.lastValidatedSessionKey = null;
      state.isAdmin = false;
      state.phase = PHASE.LOGGED_OUT;
      _clearDashboardData();
      _queueRender();
      return;
    }
    _scheduleRefresh('auth-change');
  });

  await refreshAdminState('mount', { force: true });
}

export async function refreshAdminState(reason = 'manual', options = {}) {
  const { force = false, dashboardOnly = false } = options;
  if (state.inFlight) {
    state.refreshQueued = true;
    return;
  }

  state.inFlight = true;
  try {
    const sb = getSupabaseClient();
    let session = state.session;

    if (!session || force || reason === 'mount' || reason === 'login') {
      if (!dashboardOnly) {
        state.phase = PHASE.LOADING_SESSION;
        _queueRender();
      }
      const { data, error } = await sb.auth.getSession();
      session = data?.session || null;
      state.session = session;
      if (error) {
        state.authError = error.message || 'Could not check current auth session.';
        state.phase = PHASE.ERROR;
        return;
      }
    }

    if (!session || state.pendingSignOut) {
      state.pendingSignOut = false;
      state.phase = PHASE.LOGGED_OUT;
      state.isAdmin = false;
      state.lastValidatedSessionKey = null;
      _clearDashboardData();
      return;
    }

    const sessionKey = _sessionKey(session);
    const skipAdminCheck = !force && !dashboardOnly && state.lastValidatedSessionKey === sessionKey && state.isAdmin;

    if (!skipAdminCheck && !dashboardOnly) {
      state.phase = PHASE.CHECKING_ADMIN;
      state.authError = '';
      state.adminCheckError = '';
      _queueRender();

      const adminCheck = await _checkAdminWithTimeout(ADMIN_CHECK_TIMEOUT_MS);
      if (!adminCheck.ok) {
        state.isAdmin = false;
        state.adminCheckError = adminCheck.message;
        state.phase = PHASE.ERROR;
        console.error('[admin] admin check failed', adminCheck.message);
        return;
      }

      state.isAdmin = adminCheck.isAdmin;
      state.lastValidatedSessionKey = sessionKey;
      if (!adminCheck.isAdmin) {
        state.phase = PHASE.DENIED;
        _clearDashboardData();
        return;
      }
    }

    if (!state.isAdmin) {
      state.phase = PHASE.DENIED;
      return;
    }

    state.phase = PHASE.LOADING_DASHBOARD;
    _queueRender();
    await _loadData();
    state.phase = PHASE.DASHBOARD;
  } finally {
    state.inFlight = false;
    _queueRender();
    if (state.refreshQueued) {
      state.refreshQueued = false;
      setTimeout(() => refreshAdminState('queued'), 0);
    }
  }
}

function _scheduleRefresh(reason) {
  if (state.inFlight) {
    state.refreshQueued = true;
    return;
  }
  setTimeout(() => {
    refreshAdminState(reason).catch((error) => {
      state.adminCheckError = error?.message || 'Admin refresh failed.';
      state.phase = PHASE.ERROR;
      console.error('[admin] refresh failed', error);
      _queueRender();
    });
  }, 0);
}

function _sessionKey(session) {
  if (!session) return '';
  return `${session.user?.id || ''}:${session.access_token || ''}`;
}

function _resetAdminState({ keepSession = false } = {}) {
  if (!keepSession) state.session = null;
  state.isAdmin = false;
  state.authError = '';
  state.adminCheckError = '';
  state.dashboardErrors = [];
  state.pendingSignOut = false;
  state.lastValidatedSessionKey = null;
  _clearDashboardData();
}

function _clearDashboardData() {
  state.rooms = [];
  state.filesByRoom = new Map();
  state.shareSet = new Set();
}

function _unsubscribeAuth() {
  const sub = _authSub?.data?.subscription || _authSub?.subscription || _authSub;
  if (sub?.unsubscribe) sub.unsubscribe();
  _authSub = null;
}

function _queueRender() {
  if (_renderQueued) return;
  _renderQueued = true;
  setTimeout(() => {
    _renderQueued = false;
    _render().catch((err) => {
      const el = document.getElementById('admin-content');
      if (!el) return;
      el.innerHTML = _errorHtml('Admin render failed', err?.message || String(err || 'Unknown render error.'));
      _wireErrorActions();
    });
  }, 0);
}

function _shell() { return '<div class="admin-wrap"><div id="admin-content"></div></div>'; }

async function _render() {
  const el = document.getElementById('admin-content');
  if (!el) return;

  if (state.phase === PHASE.LOADING_SESSION) {
    el.innerHTML = _loadingHtml('Checking admin session…');
    return;
  }
  if (state.phase === PHASE.LOGGED_OUT) {
    el.innerHTML = _loginHtml(state.authError || state.adminCheckError);
    _wireLogin();
    return;
  }
  if (state.phase === PHASE.CHECKING_ADMIN) {
    el.innerHTML = _loadingHtml('Verifying admin access…');
    return;
  }
  if (state.phase === PHASE.DENIED) {
    el.innerHTML = _deniedHtml();
    document.getElementById('admin-signout')?.addEventListener('click', _signOut);
    _wireBackToSyncPad();
    return;
  }
  if (state.phase === PHASE.LOADING_DASHBOARD) {
    el.innerHTML = _loadingHtml('Loading admin dashboard…');
    return;
  }
  if (state.phase === PHASE.ERROR) {
    el.innerHTML = _errorHtml('Could not load admin', state.authError || state.adminCheckError || 'Unknown admin error.');
    _wireErrorActions();
    return;
  }

  el.innerHTML = _dashboardHtml();
  _wireDashboard();
}

async function _checkAdminWithTimeout(timeoutMs) { /* unchanged */
  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Admin access check timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    });
    const rpcPromise = getSupabaseClient().rpc('is_syncpad_admin');
    const { data, error } = await Promise.race([rpcPromise, timeoutPromise]);
    if (error) return { ok: false, message: error.message || 'Failed to check admin access.' };
    return { ok: true, isAdmin: !!data };
  } catch (error) {
    return { ok: false, message: error?.message || 'Failed to check admin access.' };
  }
}

async function _signOut() {
  const button = document.getElementById('admin-signout');
  if (button) button.disabled = true;
  state.pendingSignOut = true;
  const { error } = await getSupabaseClient().auth.signOut();
  if (error) {
    state.authError = error.message || 'Sign out failed.';
    state.phase = PHASE.ERROR;
  } else {
    _resetAdminState();
    state.phase = PHASE.LOGGED_OUT;
  }
  _queueRender();
}

async function _loadData() {
  const sb = getSupabaseClient();
  state.dashboardErrors = [];
  const [roomsRes, filesRes, sharesRes] = await Promise.all([
    sb.from('syncpad_rooms').select('*').limit(500).order('updated_at', { ascending: false }),
    sb.from('syncpad_files').select('id,room_id,filename,file_size,mime_type,file_path,uploaded_at').limit(2000),
    sb.from('syncpad_share_links').select('room_id,token,created_at,last_used_at,disabled').limit(2000),
  ]);
  const rooms = roomsRes.data || [];
  const files = filesRes.data || [];
  const shares = sharesRes.data || [];
  if (roomsRes.error) state.dashboardErrors.push(`Rooms query failed: ${roomsRes.error.message || 'Unknown error.'}`);
  if (filesRes.error) state.dashboardErrors.push(`Files query failed: ${filesRes.error.message || 'Unknown error.'}`);
  if (sharesRes.error) state.dashboardErrors.push(`Share links query failed: ${sharesRes.error.message || 'Unknown error.'}`);
  state.rooms = rooms;
  state.filesByRoom = files.reduce((m, f) => { const a = m.get(f.room_id) || []; a.push(f); m.set(f.room_id, a); return m; }, new Map());
  state.shareSet = new Set(shares.filter((s) => !s.disabled).map((s) => s.room_id));
}

function _loadingHtml(message) { return `<section class="auth-card admin-card"><h2>SyncPad Admin</h2><p>${escapeHtml(message)}</p>${_backToSyncPadLink()}</section>`; }
function _loginHtml(error = '') { return `<section class="auth-card admin-card"><h2>SyncPad Admin Login</h2><p>Sign in with your admin account.</p><input id="admin-email" class="auth-input" placeholder="Email" /><input id="admin-password" class="auth-input" type="password" placeholder="Password" /><button id="admin-login" class="auth-btn">Sign in</button><div id="admin-error" class="auth-error">${escapeHtml(error || '')}</div>${_backToSyncPadLink()}</section>`; }
function _deniedHtml() { return `<section class="auth-card admin-card"><h2>Access denied</h2><p>This account is not an approved SyncPad admin.</p><button id="admin-signout" class="auth-btn">Sign out</button>${_backToSyncPadLink()}</section>`; }
function _errorHtml(title, message) { return `<section class="auth-card admin-card"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message || 'Unknown admin error.')}</p><div class="admin-controls"><button id="admin-retry" class="auth-btn">Retry</button><button id="admin-signout" class="auth-btn">Sign out</button></div>${_backToSyncPadLink()}</section>`; }
function _backToSyncPadLink() { return '<p><a href="/SyncPad/" id="admin-back-link">Back to SyncPad</a></p>'; }

function _stats(){const rooms=state.rooms; const now=Date.now(); const totalFiles=[...state.filesByRoom.values()].reduce((a,b)=>a+b.length,0); const totalSize=[...state.filesByRoom.values()].flat().reduce((a,f)=>a+(f.file_size||0),0); return {total:rooms.length, active:rooms.filter(r=>Date.now()-new Date(r.updated_at).getTime()<7*86400000).length, expired:rooms.filter(r=>r.expires_at&&new Date(r.expires_at)<now).length, encrypted:rooms.filter(r=>r.encryption_enabled).length, passcode:rooms.filter(r=>!!r.passcode_hash).length, viewOnce:rooms.filter(r=>r.view_once).length, withFiles:rooms.filter(r=>(state.filesByRoom.get(r.room_id)||[]).length>0).length, totalFiles, totalSize};}
function _filteredRooms(){let r=[...state.rooms]; const q=state.search.toLowerCase(); if(q) r=r.filter(x=>x.room_id.toLowerCase().includes(q)||(x.room_name||'').toLowerCase().includes(q)); const now=Date.now(); if(state.filter==='encrypted')r=r.filter(x=>x.encryption_enabled); if(state.filter==='passcode')r=r.filter(x=>x.passcode_hash); if(state.filter==='view_once')r=r.filter(x=>x.view_once); if(state.filter==='consumed')r=r.filter(x=>x.viewed); if(state.filter==='expired')r=r.filter(x=>x.expires_at&&new Date(x.expires_at)<now); if(state.filter==='locked')r=r.filter(x=>x.editing_locked); if(state.filter==='files')r=r.filter(x=>(state.filesByRoom.get(x.room_id)||[]).length>0); if(state.filter==='inactive')r=r.filter(x=>Date.now()-new Date(x.updated_at).getTime()>30*86400000); const [field,dir]=state.sort.split('_'); r.sort((a,b)=> (new Date(a[field])-new Date(b[field]))*(dir==='asc'?1:-1)); return r; }
function _dashboardHtml(){const s=_stats(); const rows=_filteredRooms().map(r=>{const files=state.filesByRoom.get(r.room_id)||[]; const sz=files.reduce((a,f)=>a+(f.file_size||0),0); return `<tr data-room="${escapeHtml(r.room_id)}"><td>${escapeHtml(r.room_id)}</td><td>${escapeHtml(r.room_name||'')}</td><td>${formatTimestamp(r.created_at)}</td><td>${formatTimestamp(r.updated_at)}</td><td>${r.expires_at?formatTimestamp(r.expires_at):'—'}</td><td>${r.encryption_enabled?'Yes':'No'}</td><td>${r.passcode_hash?'Yes':'No'}</td><td>${r.view_once?'Yes':'No'}</td><td>${r.viewed?'Yes':'No'}</td><td>${r.editing_locked?'Yes':'No'}</td><td>${files.length}</td><td>${formatFileSize(sz)}</td><td>${escapeHtml(r.cleared_reason||'')}</td><td>${state.shareSet.has(r.room_id)?'Yes':'No'}</td></tr>`;}).join(''); const errorBlock = state.dashboardErrors.length ? `<section class="auth-card admin-card"><h3>Dashboard data loaded with errors</h3><ul>${state.dashboardErrors.map((e)=>`<li>${escapeHtml(e)}</li>`).join('')}</ul></section>` : ''; return `<header class="admin-header"><h1>SyncPad Admin</h1><div>${escapeHtml(state.session?.user?.email||'')}</div><button id="admin-refresh" class="landing-join-btn">Refresh</button><button id="admin-signout" class="landing-join-btn">Sign out</button><a href="/SyncPad/" class="landing-join-btn">Back to SyncPad</a></header>${errorBlock}<p class="admin-warning">Deleting database rows may remove file metadata, but may not delete physical Supabase Storage objects unless explicitly deleted from Storage.</p><div class="admin-stats">${Object.entries(s).map(([k,v])=>`<div class='admin-stat'><strong>${v}</strong><span>${k}</span></div>`).join('')}</div><div class="admin-controls"><input id="admin-search" class="auth-input" placeholder="Search room_id or room_name" value="${escapeHtml(state.search)}"><select id="admin-filter" class="auth-input"><option value="all">all</option><option value="encrypted">encrypted</option><option value="passcode">passcode protected</option><option value="view_once">view-once</option><option value="consumed">consumed/viewed</option><option value="expired">expired</option><option value="locked">editing locked</option><option value="files">has files</option><option value="inactive">inactive</option></select><select id="admin-sort" class="auth-input"><option value="updated_desc">updated_at newest</option><option value="updated_asc">updated_at oldest</option><option value="created_desc">created_at newest</option><option value="created_asc">created_at oldest</option></select><button id="admin-export" class="landing-join-btn">Export CSV</button></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>room_id</th><th>room_name</th><th>created_at</th><th>updated_at</th><th>expires_at</th><th>enc</th><th>passcode</th><th>view_once</th><th>viewed</th><th>locked</th><th>files</th><th>size</th><th>cleared_reason</th><th>share</th></tr></thead><tbody>${rows}</tbody></table></div><div id="admin-detail"></div>`}

function _wireBackToSyncPad() { document.getElementById('admin-back-link')?.addEventListener('click', () => {}); }
function _wireErrorActions() {
  document.getElementById('admin-retry')?.addEventListener('click', () => refreshAdminState('retry', { force: true }));
  document.getElementById('admin-signout')?.addEventListener('click', _signOut);
  _wireBackToSyncPad();
}
function _wireLogin(){document.getElementById('admin-login')?.addEventListener('click', async()=>{const email=document.getElementById('admin-email')?.value?.trim(); const password=document.getElementById('admin-password')?.value; const errorEl = document.getElementById('admin-error'); const loginBtn=document.getElementById('admin-login'); if (errorEl) errorEl.textContent = ''; if(loginBtn) loginBtn.disabled=true; const {error}=await getSupabaseClient().auth.signInWithPassword({email,password}); if(error){if (errorEl) errorEl.textContent=error.message;} else { await refreshAdminState('login', { force: true }); } if(loginBtn) loginBtn.disabled=false;}); _wireBackToSyncPad();}
function _wireDashboard(){document.getElementById('admin-signout')?.addEventListener('click',_signOut); document.getElementById('admin-refresh')?.addEventListener('click',()=>refreshAdminState('refresh', { force: true, dashboardOnly: true })); document.getElementById('admin-search')?.addEventListener('input',(e)=>{state.search=e.target.value; _queueRender();}); document.getElementById('admin-filter').value=state.filter; document.getElementById('admin-filter')?.addEventListener('change',(e)=>{state.filter=e.target.value; _queueRender();}); document.getElementById('admin-sort').value=state.sort; document.getElementById('admin-sort')?.addEventListener('change',(e)=>{state.sort=e.target.value; _queueRender();}); document.getElementById('admin-export')?.addEventListener('click',_exportCsv); document.querySelectorAll('tr[data-room]').forEach(tr=>tr.addEventListener('click',()=>_openDetail(tr.dataset.room)))}
async function _openDetail(roomId){const room=state.rooms.find(r=>r.room_id===roomId); const files=state.filesByRoom.get(roomId)||[]; const el=document.getElementById('admin-detail'); const encrypted=!!room.encryption_enabled; el.innerHTML=`<div class='admin-detail'><h3>Room ${escapeHtml(roomId)}</h3><p>${encrypted?'Encrypted content cannot be previewed safely.':`Content preview: ${escapeHtml((room.content||'').slice(0,600))}`}</p><p>Files: ${files.map(f=>escapeHtml(f.filename)).join(', ')||'None'}</p><input id='confirm-clear' class='auth-input' placeholder='Type CLEAR to clear room'><button id='btn-clear-room' class='landing-join-btn'>Clear room content</button><input id='confirm-delete' class='auth-input' placeholder='Type DELETE to delete room'><button id='btn-delete-room' class='landing-join-btn'>Delete room</button></div>`; document.getElementById('btn-clear-room').onclick=async()=>{if(document.getElementById('confirm-clear').value!=='CLEAR')return alert('Type CLEAR'); await getSupabaseClient().from('syncpad_rooms').update({content:'',cleared_reason:'manual',updated_at:new Date().toISOString()}).eq('room_id',roomId); refreshAdminState('clear-room', { force: true, dashboardOnly: true });}; document.getElementById('btn-delete-room').onclick=async()=>{if(document.getElementById('confirm-delete').value!=='DELETE')return alert('Type DELETE'); await getSupabaseClient().from('syncpad_rooms').delete().eq('room_id',roomId); refreshAdminState('delete-room', { force: true, dashboardOnly: true });};}
function _exportCsv(){const rows=_filteredRooms(); const header=['room_id','room_name','created_at','updated_at','expires_at','encrypted','passcode','view_once','viewed','editing_locked','file_count','total_file_size','cleared_reason','share_link_exists']; const body=rows.map(r=>{const files=state.filesByRoom.get(r.room_id)||[]; const sz=files.reduce((a,f)=>a+(f.file_size||0),0); return [r.room_id,r.room_name||'',r.created_at,r.updated_at,r.expires_at||'',!!r.encryption_enabled,!!r.passcode_hash,!!r.view_once,!!r.viewed,!!r.editing_locked,files.length,sz,r.cleared_reason||'',state.shareSet.has(r.room_id)].map(v=>`"${String(v).replaceAll('"','""')}"`).join(',');}); const csv=[header.join(','),...body].join('\n'); const blob=new Blob([csv],{type:'text/csv'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='syncpad-admin-rooms.csv'; a.click(); URL.revokeObjectURL(a.href);} 
