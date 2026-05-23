// SyncPad – supabase.js
let _client = null;
export function getSupabaseClient() {
  if (_client) return _client;
  const cfg = window.SYNCPAD_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) throw new Error('SyncPad: Supabase config not found. Set window.SYNCPAD_CONFIG in index.html.');
  _client = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    realtime: { params: { eventsPerSecond: 20 } },
  });
  return _client;
}
