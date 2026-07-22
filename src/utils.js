// SyncPad – utils.js

// ── Device identity ──────────────────────────────────────────────────────────

const DEVICE_ID_KEY   = 'syncpad_device_id';
const DEVICE_NAME_KEY = 'syncpad_device_name';

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_ID_KEY, id); }
  return id;
}

export function getDeviceName() {
  return localStorage.getItem(DEVICE_NAME_KEY) || _generateDefaultDeviceName();
}

export function setDeviceName(name) {
  const safe = (name || '').trim().slice(0, 32);
  localStorage.setItem(DEVICE_NAME_KEY, safe || _generateDefaultDeviceName());
}

function _generateDefaultDeviceName() {
  const adj  = ['Blue','Swift','Quiet','Cool','Bright','Steady','Nimble','Sharp'];
  const noun = ['Hawk','Wave','Leaf','Stone','Star','Cloud','Rain','Tree'];
  const name = `${adj[Math.floor(Math.random()*adj.length)]}${noun[Math.floor(Math.random()*noun.length)]}${Math.floor(Math.random()*100)}`;
  localStorage.setItem(DEVICE_NAME_KEY, name);
  return name;
}

// ── Room ID generation ───────────────────────────────────────────────────────

const ADJECTIVES = ['calm','swift','bright','quiet','cool','warm','clear','crisp','deep','free','vast','bold','pure','soft','wild','keen'];
const NOUNS      = ['lake','pine','dusk','dawn','tide','gale','reef','mist','peak','cove','bay','glen','ford','vale','hill','fen'];

function _secureRandomInt(maxExclusive) {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0xffffffff) {
    throw new Error('Invalid random range');
  }

  // Rejection sampling avoids modulo bias. This keeps room IDs backed by
  // crypto.getRandomValues() instead of Math.random().
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % maxExclusive;
}

function _secureRandomBase36(byteCount = 6) {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  return value.toString(36).padStart(10, '0').slice(0, 10);
}

export function generateRoomId() {
  const adj    = ADJECTIVES[_secureRandomInt(ADJECTIVES.length)];
  const noun   = NOUNS[_secureRandomInt(NOUNS.length)];
  const suffix = _secureRandomBase36(6);
  return `${adj}-${noun}-${suffix}`;
}

export function sanitizeRoomId(raw) {
  return (raw || '').toLowerCase().trim()
    .replace(/[^a-z0-9\-_]/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 64) || generateRoomId();
}

// ── Throttle / debounce ──────────────────────────────────────────────────────

export function throttle(fn, ms) {
  let lastCall = 0, timer = null, pendingArgs = null, pendingThis = null;
  function throttled(...args) {
    const now = Date.now();
    const remaining = ms - (now - lastCall);
    if (remaining <= 0) {
      clearTimeout(timer); timer = null; pendingArgs = null; pendingThis = null;
      lastCall = now; fn.apply(this, args);
    } else {
      pendingArgs = args;
      pendingThis = this;
      if (!timer) {
        timer = setTimeout(() => {
          lastCall = Date.now(); timer = null;
          const callArgs = pendingArgs;
          const callThis = pendingThis;
          pendingArgs = null; pendingThis = null;
          fn.apply(callThis, callArgs);
        }, remaining);
      }
    }
  }
  throttled.cancel = () => {
    clearTimeout(timer); timer = null; pendingArgs = null; pendingThis = null;
  };
  return throttled;
}

export function debounce(fn, ms) {
  let timer = null, pendingArgs = null;
  function debounced(...args) {
    pendingArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(this, pendingArgs); pendingArgs = null; }, ms);
  }
  debounced.cancel = () => { clearTimeout(timer); timer = null; pendingArgs = null; };
  debounced.flush  = function () {
    if (timer !== null) {
      clearTimeout(timer); timer = null;
      if (pendingArgs !== null) {
        const args = pendingArgs;
        pendingArgs = null;
        return fn.apply(this, args);
      }
    }
    return undefined;
  };
  return debounced;
}

// ── Crypto helpers ───────────────────────────────────────────────────────────

export async function hashPasscode(passcode, saltHex = null) {
  // v1 initial deploy uses salted PBKDF2 for passcodes. The no-salt path is
  // retained only to allow legacy/placeholder rooms to be checked gracefully.
  if (saltHex) {
    const salt = new Uint8Array(String(saltHex).match(/.{2}/g).map(h => parseInt(h, 16)));
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passcode),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
      material,
      256
    );
    return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const data = new TextEncoder().encode(passcode);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let b = '';
  for (let i = 0; i < bytes.byteLength; i++) b += String.fromCharCode(bytes[i]);
  return btoa(b);
}

export function base64ToBuf(b64) {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── Clipboard ────────────────────────────────────────────────────────────────

export async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy');
    document.body.removeChild(ta); return true;
  } catch { return false; }
}

// ── Text stats ───────────────────────────────────────────────────────────────

export function countWords(text) {
  return (text || '').trim() === '' ? 0 : (text.trim().match(/\S+/g) || []).length;
}

export function countChars(text) { return (text || '').length; }

export function estimateReadingTime(text) {
  const words = countWords(text);
  if (words === 0) return 0;
  return Math.max(1, Math.round(words / 200));
}

// ── File helpers ─────────────────────────────────────────────────────────────

export function formatFileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024)    return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function fileEmoji(mime, filename) {
  if (!mime && !filename) return '📎';
  const m = mime || '';
  const f = (filename || '').toLowerCase();
  if (m.startsWith('image/'))  return '🖼️';
  if (m.startsWith('video/'))  return '🎬';
  if (m.startsWith('audio/'))  return '🎵';
  if (m === 'application/pdf' || f.endsWith('.pdf')) return '📄';
  if (m.includes('zip') || m.includes('tar') || m.includes('gzip') || f.endsWith('.zip') || f.endsWith('.tar')) return '📦';
  if (m.startsWith('text/'))   return '📝';
  return '📎';
}

export function formatTimestamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    // Today: show time only — "3:45 PM"
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) {
    // This year, different day: "Jan 12, 3:45 PM"
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  // Different year: "Jan 12, 2023"
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function insertTimestamp() {
  return new Date().toLocaleString([], {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

// ── Duration parser ──────────────────────────────────────────────────────────
/**
 * Parse a human duration string and return milliseconds.
 * Accepts: "30s", "10m", "2h", "3d"  (or plain numbers treated as minutes).
 * @param {string} str
 * @returns {number|null} milliseconds, or null if unparseable
 */
export function parseDuration(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  if (!isFinite(n) || n <= 0) return null;
  const unit = match[2] || 'm';
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(n * (multipliers[unit] ?? 60_000));
}

// ── Error logging ────────────────────────────────────────────────────────────

function isDebugEnabled() {
  try { return localStorage.getItem('syncpad_debug') === '1'; } catch { return false; }
}

export function logSupabaseError(context, error, extra = {}) {
  if (!isDebugEnabled()) return;
  const safe = { ...extra };
  delete safe.content; delete safe.passcode; delete safe.passcode_hash; delete safe.encryption_key;
  console.error('[SyncPad]', context, {
    message: error?.message, code: error?.code,
    details: error?.details, hint: error?.hint, ...safe
  });
}

// ── Env helpers ──────────────────────────────────────────────────────────────

export function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function isOnline() {
  return navigator.onLine !== false;
}

/**
 * Register online/offline callbacks.
 * @param {function(boolean): void} callback  – called with true when online, false when offline
 * @returns {function} cleanup function
 */
export function onOnlineChange(callback) {
  const handleOnline  = () => callback(true);
  const handleOffline = () => callback(false);
  window.addEventListener('online',  handleOnline);
  window.addEventListener('offline', handleOffline);
  return () => {
    window.removeEventListener('online',  handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}

// ── URL helpers ──────────────────────────────────────────────────────────────

/**
 * Build the canonical editable room URL for sharing.
 * @param {string} basePath  – e.g. '/SyncPad'
 * @param {string} roomId
 * @returns {string}
 */
export function buildRoomUrl(basePath, roomId) {
  return `${location.origin}${basePath}/${roomId}`;
}

/**
 * Build the read-only room URL.
 * @param {string} basePath
 * @param {string} roomId
 * @returns {string}
 */
export function buildReadOnlyUrl(basePath, tokenOrRoomId) {
  return `${location.origin}${basePath}/share/${encodeURIComponent(tokenOrRoomId)}`;
}

/**
 * Read the `?mode=` query parameter. Returns 'read' if read-only mode is
 * requested via the URL, otherwise null.
 */
export function getUrlMode() {
  try {
    const sp = new URLSearchParams(location.search);
    const m  = (sp.get('mode') || '').toLowerCase();
    return m === 'read' ? 'read' : null;
  } catch { return null; }
}

// ── HTML escape ──────────────────────────────────────────────────────────────

/**
 * Escape a string for safe insertion as HTML text content.
 * Use this for ALL untrusted strings rendered via innerHTML.
 */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
