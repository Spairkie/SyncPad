// SyncPad – settings.js
// Passcode, encryption, expiration, and view-once management.
import { updateRoomSettings, updateRoom, consumeViewOnceRemote } from './rooms.js';
import { generateSalt, deriveKey, encryptContent, decryptContent, looksEncrypted } from './encryption.js';
import { hashPasscode, getDeviceId, parseDuration } from './utils.js';

// ── Passcode ──────────────────────────────────────────────────────────────────

export async function setPasscode(roomId, passcode) {
  const salt = generateSalt();
  const hash = await hashPasscode(passcode, salt);
  await updateRoomSettings(roomId, { passcode_hash: hash, passcode_salt: salt });
}

export async function checkPasscode(room, passcode) {
  if (!room.passcode_hash) return true;
  // Guard: if a passcode is set but the salt is missing (data corruption),
  // refuse rather than silently computing an unsalted hash that will never
  // match the PBKDF2 hash stored in the DB, causing correct codes to fail.
  if (!room.passcode_salt) return false;
  const hash = await hashPasscode(passcode, room.passcode_salt);
  return hash === room.passcode_hash;
}

export async function removePasscode(roomId) {
  await updateRoomSettings(roomId, { passcode_hash: null, passcode_salt: null });
}

// ── Encryption ────────────────────────────────────────────────────────────────

/**
 * Enable encryption on a room.
 * Derives a new key from the passphrase, encrypts current plaintext,
 * and atomically saves the ciphertext + metadata.
 * @returns {{ salt: string, key: CryptoKey }}
 */
export async function enableEncryption(roomId, plaintextContent, passphrase) {
  const salt      = generateSalt();
  const key       = await deriveKey(passphrase, salt);
  const encrypted = await encryptContent(plaintextContent ?? '', key);
  // syncpad_rooms.updated_at is DB-owned; clients should not send it.
  await updateRoom(roomId, {
    encryption_enabled: true,
    encryption_salt:    salt,
    content:            encrypted,
    updated_by_device:  getDeviceId(),
  });
  return { salt, key };
}

/**
 * Disable encryption on a room.
 *
 * SECURITY: Verifies the passphrase against the current ciphertext stored in
 * the database BEFORE saving plaintext. Throws if verification fails so the
 * caller can show an error without any DB write occurring.
 *
 * @param {string}     roomId
 * @param {string}     plaintextContent      – current editor value (already decrypted)
 * @param {string}     passphrase            – passphrase to verify
 * @param {string}     salt                  – stored encryption_salt
 * @param {string}     currentDbCiphertext   – _room.content at call time
 * @throws {Error}     if passphrase is wrong
 */
export async function disableEncryption(
  roomId, plaintextContent, passphrase, salt, currentDbCiphertext
) {
  // Verify when ciphertext is present. enableEncryption() always writes an
  // encrypted payload now, even for an empty note, so wrong passphrases fail.
  if (salt && currentDbCiphertext && looksEncrypted(currentDbCiphertext)) {
    let verifyKey;
    try {
      verifyKey = await deriveKey(passphrase, salt);
    } catch {
      throw new Error('Wrong passphrase. Could not disable encryption.');
    }
    try {
      await decryptContent(currentDbCiphertext, verifyKey);
    } catch {
      throw new Error('Wrong passphrase. Could not disable encryption.');
    }
  }

  await updateRoom(roomId, {
    encryption_enabled: false,
    encryption_salt:    null,
    content:            plaintextContent,
    updated_by_device:  getDeviceId(),
  });
}

/**
 * Derive a CryptoKey from passphrase + stored salt (used on load to unlock).
 * @returns {Promise<CryptoKey>}
 */
export async function unlockEncryption(passphrase, salt) {
  return deriveKey(passphrase, salt);
}

// ── Expiration ────────────────────────────────────────────────────────────────

/**
 * @param {string} durationStr  e.g. "10m", "1h", "2d", "30s"
 * @returns {Promise<string>} ISO timestamp of expiry
 */
export async function setExpiration(roomId, durationStr) {
  const ms = parseDuration(durationStr);
  if (!ms || ms <= 0) throw new Error('Invalid duration');
  const expires_at = new Date(Date.now() + ms).toISOString();
  await updateRoomSettings(roomId, { expires_at, cleared_reason: null });
  return expires_at;
}

export async function clearExpiration(roomId) {
  await updateRoomSettings(roomId, { expires_at: null });
}

/**
 * Clear the room if it has expired.
 * Idempotent: no-op if already cleared or not yet expired.
 * @returns {Promise<boolean>} true if this call cleared the content
 */
export async function handleExpiration(roomId, room, replacementContent = '') {
  if (room.cleared_reason === 'expired') return false;
  if (!room.expires_at)                  return false;
  if (new Date(room.expires_at) > new Date()) return false;

  try {
    await updateRoom(roomId, {
      content:           replacementContent,
      updated_by_device: getDeviceId(),
      cleared_reason:    'expired',
      expires_at:        null,
    });
  } catch {
    // A locked room's content is protected server-side even from its own
    // expiration clearing (see syncpad_rooms_enforce_lock in
    // supabase/migrations/0001_base_schema.sql) — the backend cleanup job or an admin will clear
    // it instead. Any other failure here (network, RLS) is equally
    // non-fatal: the room just stays visibly expired until the next visit.
    return false;
  }
  return true;
}

// ── Editing lock ──────────────────────────────────────────────────────────────
// Lock mode controls editing. Passcode controls entry. They are independent.
// The lock state is sent through updateRoomSettings so the `content` column
// is NEVER touched by a lock toggle.

export async function setEditingLocked(roomId, locked) {
  await updateRoomSettings(roomId, { editing_locked: !!locked });
}

// ── View-once ─────────────────────────────────────────────────────────────────

export async function enableViewOnce(roomId) {
  await updateRoomSettings(roomId, { view_once: true, viewed: false });
}

export async function disableViewOnce(roomId) {
  await updateRoomSettings(roomId, { view_once: false, viewed: false });
}

/**
 * Consume a view-once note: mark viewed and clear durable DB content.
 *
 * IMPORTANT: The caller is responsible for displaying the note BEFORE calling
 * this function. The content should be captured for display before the DB
 * write clears it.
 *
 * Idempotent: no-op if already consumed or creator.
 * @returns {Promise<boolean>} true if this call consumed the note
 */
export async function consumeViewOnce(roomId, room, isCreator, replacementContent = '') {
  if (!room.view_once)  return false;
  if (isCreator)        return false;
  if (room.viewed || room.cleared_reason === 'view_once') return false;

  // Deliberately not updateRoom() — a view-once reader typically has no
  // edit token (they're not the creator), so this goes through a narrow
  // dedicated RPC instead. See consumeViewOnceRemote()'s doc comment.
  return consumeViewOnceRemote(roomId, replacementContent, getDeviceId());
}

export async function resetViewOnceNote(roomId, replacementContent = '', keepViewOnce = true) {
  await updateRoom(roomId, {
    content:           replacementContent,
    view_once:         !!keepViewOnce,
    viewed:            false,
    cleared_reason:    null,
    updated_by_device: getDeviceId(),
  });
}
