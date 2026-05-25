import { getSupabaseClient } from './supabase.js';
import { escapeHtml, formatFileSize, formatTimestamp } from './utils.js';

const state = { session: null, isAdmin: false, rooms: [], filesByRoom: new Map(), shareSet: new Set(), filter: 'all', sort: 'updated_desc', search: '', selectedRoomId: null };

export async function mountAdminPage() {
  const root = document.getElementById('admin-screen');
  if (!root) return;
  root.innerHTML = _shell();
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  state.session = data?.session || null;
  await _render();
  supabase.auth.onAuthStateChange(async (_event, session) => { state.session = session; await _render(); });
}

function _shell(){return `<div class="admin-wrap"><div id="admin-content"></div></div>`;}

async function _render(){
  const el = document.getElementById('admin-content'); if (!el) return;
  if (!state.session) { el.innerHTML = _loginHtml(); _wireLogin(); return; }
  state.isAdmin = await _checkAdmin();
  if (!state.isAdmin) { el.innerHTML = _deniedHtml(); document.getElementById('admin-signout')?.addEventListener('click', _signOut); return; }
  await _loadData();
  el.innerHTML = _dashboardHtml();
  _wireDashboard();
}

async function _checkAdmin(){ const { data } = await getSupabaseClient().rpc('is_syncpad_admin'); return !!data; }
async function _signOut(){ await getSupabaseClient().auth.signOut(); }

async function _loadData(){
  const sb = getSupabaseClient();
  const { data: rooms=[] } = await sb.from('syncpad_rooms').select('*').limit(500).order('updated_at',{ascending:false});
  const { data: files=[] } = await sb.from('syncpad_files').select('id,room_id,filename,file_size,mime_type,file_path,uploaded_at').limit(2000);
  const { data: shares=[] } = await sb.from('syncpad_share_links').select('room_id,token,created_at,last_used_at,disabled').limit(2000);
  state.rooms = rooms;
  state.filesByRoom = files.reduce((m,f)=>{const a=m.get(f.room_id)||[];a.push(f);m.set(f.room_id,a);return m;}, new Map());
  state.shareSet = new Set((shares||[]).filter(s=>!s.disabled).map(s=>s.room_id));
}

function _loginHtml(){return `<section class="auth-card admin-card"><h2>SyncPad Admin Login</h2><p>Sign in with your admin account.</p><input id="admin-email" class="auth-input" placeholder="Email" /><input id="admin-password" class="auth-input" type="password" placeholder="Password" /><button id="admin-login" class="auth-btn">Sign in</button><div id="admin-error" class="auth-error"></div></section>`}
function _deniedHtml(){return `<section class="auth-card admin-card"><h2>Access denied</h2><p>This account is not an approved SyncPad admin.</p><button id="admin-signout" class="auth-btn">Sign out</button></section>`}

function _stats(){const rooms=state.rooms; const now=Date.now(); const totalFiles=[...state.filesByRoom.values()].reduce((a,b)=>a+b.length,0); const totalSize=[...state.filesByRoom.values()].flat().reduce((a,f)=>a+(f.file_size||0),0); return {total:rooms.length, active:rooms.filter(r=>Date.now()-new Date(r.updated_at).getTime()<7*86400000).length, expired:rooms.filter(r=>r.expires_at&&new Date(r.expires_at)<now).length, encrypted:rooms.filter(r=>r.encryption_enabled).length, passcode:rooms.filter(r=>!!r.passcode_hash).length, viewOnce:rooms.filter(r=>r.view_once).length, withFiles:rooms.filter(r=>(state.filesByRoom.get(r.room_id)||[]).length>0).length, totalFiles, totalSize};}

function _filteredRooms(){let r=[...state.rooms]; const q=state.search.toLowerCase(); if(q) r=r.filter(x=>x.room_id.toLowerCase().includes(q)||(x.room_name||'').toLowerCase().includes(q)); const now=Date.now(); if(state.filter==='encrypted')r=r.filter(x=>x.encryption_enabled); if(state.filter==='passcode')r=r.filter(x=>x.passcode_hash); if(state.filter==='view_once')r=r.filter(x=>x.view_once); if(state.filter==='consumed')r=r.filter(x=>x.viewed); if(state.filter==='expired')r=r.filter(x=>x.expires_at&&new Date(x.expires_at)<now); if(state.filter==='locked')r=r.filter(x=>x.editing_locked); if(state.filter==='files')r=r.filter(x=>(state.filesByRoom.get(x.room_id)||[]).length>0); if(state.filter==='inactive')r=r.filter(x=>Date.now()-new Date(x.updated_at).getTime()>30*86400000); const [field,dir]=state.sort.split('_'); r.sort((a,b)=> (new Date(a[field])-new Date(b[field]))*(dir==='asc'?1:-1)); return r; }

function _dashboardHtml(){const s=_stats(); const rows=_filteredRooms().map(r=>{const files=state.filesByRoom.get(r.room_id)||[]; const sz=files.reduce((a,f)=>a+(f.file_size||0),0); return `<tr data-room="${escapeHtml(r.room_id)}"><td>${escapeHtml(r.room_id)}</td><td>${escapeHtml(r.room_name||'')}</td><td>${formatTimestamp(r.created_at)}</td><td>${formatTimestamp(r.updated_at)}</td><td>${r.expires_at?formatTimestamp(r.expires_at):'—'}</td><td>${r.encryption_enabled?'Yes':'No'}</td><td>${r.passcode_hash?'Yes':'No'}</td><td>${r.view_once?'Yes':'No'}</td><td>${r.viewed?'Yes':'No'}</td><td>${r.editing_locked?'Yes':'No'}</td><td>${files.length}</td><td>${formatFileSize(sz)}</td><td>${escapeHtml(r.cleared_reason||'')}</td><td>${state.shareSet.has(r.room_id)?'Yes':'No'}</td></tr>`;}).join(''); return `<header class="admin-header"><h1>SyncPad Admin</h1><div>${escapeHtml(state.session.user.email||'')}</div><button id="admin-refresh" class="landing-join-btn">Refresh</button><button id="admin-signout" class="landing-join-btn">Sign out</button></header><p class="admin-warning">Deleting database rows may remove file metadata, but may not delete physical Supabase Storage objects unless explicitly deleted from Storage.</p><div class="admin-stats">${Object.entries(s).map(([k,v])=>`<div class='admin-stat'><strong>${v}</strong><span>${k}</span></div>`).join('')}</div><div class="admin-controls"><input id="admin-search" class="auth-input" placeholder="Search room_id or room_name" value="${escapeHtml(state.search)}"><select id="admin-filter" class="auth-input"><option value="all">all</option><option value="encrypted">encrypted</option><option value="passcode">passcode protected</option><option value="view_once">view-once</option><option value="consumed">consumed/viewed</option><option value="expired">expired</option><option value="locked">editing locked</option><option value="files">has files</option><option value="inactive">inactive</option></select><select id="admin-sort" class="auth-input"><option value="updated_desc">updated_at newest</option><option value="updated_asc">updated_at oldest</option><option value="created_desc">created_at newest</option><option value="created_asc">created_at oldest</option></select><button id="admin-export" class="landing-join-btn">Export CSV</button></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>room_id</th><th>room_name</th><th>created_at</th><th>updated_at</th><th>expires_at</th><th>enc</th><th>passcode</th><th>view_once</th><th>viewed</th><th>locked</th><th>files</th><th>size</th><th>cleared_reason</th><th>share</th></tr></thead><tbody>${rows}</tbody></table></div><div id="admin-detail"></div>`}

function _wireLogin(){document.getElementById('admin-login')?.addEventListener('click', async()=>{const email=document.getElementById('admin-email')?.value?.trim(); const password=document.getElementById('admin-password')?.value; const {error}=await getSupabaseClient().auth.signInWithPassword({email,password}); if(error) document.getElementById('admin-error').textContent=error.message;});}
function _wireDashboard(){document.getElementById('admin-signout')?.addEventListener('click',_signOut); document.getElementById('admin-refresh')?.addEventListener('click',_render); document.getElementById('admin-search')?.addEventListener('input',(e)=>{state.search=e.target.value; _render();}); document.getElementById('admin-filter').value=state.filter; document.getElementById('admin-filter')?.addEventListener('change',(e)=>{state.filter=e.target.value; _render();}); document.getElementById('admin-sort').value=state.sort; document.getElementById('admin-sort')?.addEventListener('change',(e)=>{state.sort=e.target.value; _render();}); document.getElementById('admin-export')?.addEventListener('click',_exportCsv); document.querySelectorAll('tr[data-room]').forEach(tr=>tr.addEventListener('click',()=>_openDetail(tr.dataset.room)));}
async function _openDetail(roomId){const room=state.rooms.find(r=>r.room_id===roomId); const files=state.filesByRoom.get(roomId)||[]; const el=document.getElementById('admin-detail'); const encrypted=!!room.encryption_enabled; el.innerHTML=`<div class='admin-detail'><h3>Room ${escapeHtml(roomId)}</h3><p>${encrypted?'Encrypted content cannot be previewed safely.':`Content preview: ${escapeHtml((room.content||'').slice(0,600))}`}</p><p>Files: ${files.map(f=>escapeHtml(f.filename)).join(', ')||'None'}</p><input id='confirm-clear' class='auth-input' placeholder='Type CLEAR to clear room'><button id='btn-clear-room' class='landing-join-btn'>Clear room content</button><input id='confirm-delete' class='auth-input' placeholder='Type DELETE to delete room'><button id='btn-delete-room' class='landing-join-btn'>Delete room</button></div>`; document.getElementById('btn-clear-room').onclick=async()=>{if(document.getElementById('confirm-clear').value!=='CLEAR')return alert('Type CLEAR'); await getSupabaseClient().from('syncpad_rooms').update({content:'',cleared_reason:'manual',updated_at:new Date().toISOString()}).eq('room_id',roomId); await _render();}; document.getElementById('btn-delete-room').onclick=async()=>{if(document.getElementById('confirm-delete').value!=='DELETE')return alert('Type DELETE'); await getSupabaseClient().from('syncpad_rooms').delete().eq('room_id',roomId); await _render();};}
function _exportCsv(){const rows=_filteredRooms(); const header=['room_id','room_name','created_at','updated_at','expires_at','encrypted','passcode','view_once','viewed','editing_locked','file_count','total_file_size','cleared_reason','share_link_exists']; const body=rows.map(r=>{const files=state.filesByRoom.get(r.room_id)||[]; const sz=files.reduce((a,f)=>a+(f.file_size||0),0); return [r.room_id,r.room_name||'',r.created_at,r.updated_at,r.expires_at||'',!!r.encryption_enabled,!!r.passcode_hash,!!r.view_once,!!r.viewed,!!r.editing_locked,files.length,sz,r.cleared_reason||'',state.shareSet.has(r.room_id)].map(v=>`"${String(v).replaceAll('"','""')}"`).join(',');}); const csv=[header.join(','),...body].join('\n'); const blob=new Blob([csv],{type:'text/csv'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='syncpad-admin-rooms.csv'; a.click(); URL.revokeObjectURL(a.href);} 
