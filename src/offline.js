// SyncPad – offline.js
// Local draft persistence. Online/offline helpers live in utils.js.
//
// Security note:
//   Drafts for encrypted rooms are stored encrypted, never as localStorage
//   plaintext. Plain rooms keep plaintext drafts so v1 can still recover work
//   without a passphrase.

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PREFIX = 'syncpad_draft_';
const SCHEMA_VERSION = 2;

function _key(roomId) { return PREFIX + roomId; }

/**
 * Save the current editor content as a local draft.
 *
 * @param {string} roomId
 * @param {string} content plaintext editor content
 * @param {{ encryptFn?: ((plaintext: string) => Promise<string>)|null }} [options]
 */
export async function saveDraft(roomId, content, options = {}) {
  try {
    const encryptFn = options?.encryptFn || null;
    const encrypted = !!encryptFn;
    const storedContent = encrypted ? await encryptFn(content) : content;

    localStorage.setItem(_key(roomId), JSON.stringify({
      v:         SCHEMA_VERSION,
      room_id:   roomId,
      content:   storedContent,
      encrypted,
      timestamp: Date.now(),
    }));
  } catch {
    // If encrypted draft writing fails, intentionally do NOT fall back to
    // plaintext. That would violate the encryption contract.
  }
}

/**
 * Load a saved draft. Returns null if none / expired.
 * The caller decrypts encrypted drafts only after the room passphrase is known.
 *
 * @returns {{ room_id: string, content: string, encrypted?: boolean, timestamp: number }|null}
 */
export function loadDraft(roomId) {
  try {
    const raw = localStorage.getItem(_key(roomId));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.timestamp > TTL_MS) { clearDraft(roomId); return null; }
    return entry;
  } catch { return null; }
}

/** Remove a saved draft. */
export function clearDraft(roomId) {
  try { localStorage.removeItem(_key(roomId)); } catch {}
}

/**
 * Returns true if the draft is newer than the room's last DB update.
 * @param {{ timestamp: number }} draft
 * @param {string|null} roomUpdatedAt  ISO timestamp string
 */
export function isDraftNewer(draft, roomUpdatedAt) {
  if (!draft) return false;
  if (!roomUpdatedAt) return true;
  return draft.timestamp > new Date(roomUpdatedAt).getTime();
}
