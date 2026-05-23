// SyncPad – permissions.js
// Single source of truth for what the current client is allowed to do.
//
// Inputs are pulled from a small "context" object so this module stays pure
// and easy to reason about. Callers update the context via setPermissionContext
// whenever the relevant state changes (room state, URL mode, encryption lock).
//
// IMPORTANT: these helpers are a UX / convenience layer. They are NOT a
// security boundary. A determined user can call Supabase directly with the
// anon key. Real enforcement would require server-side RLS keyed to a
// per-room session token, which is out of scope for v1.

let _ctx = {
  isReadOnlyUrl:       false, // ?mode=read
  isEditingLocked:     false, // room.editing_locked
  isEncryptedNoKey:    false, // room.encryption_enabled && we have no key
  isEncryptionEnabled: false, // room.encryption_enabled (files are not text-encrypted)
  isCleared:           false, // room.cleared_reason set & no local override
  isViewOnceConsumed:  false, // view-once already used, server cleared
};

export function setPermissionContext(patch) {
  _ctx = { ..._ctx, ...patch };
}

export function getPermissionContext() {
  return { ..._ctx };
}

// ── Composite blockers ───────────────────────────────────────────────────────

function _anyEditBlock() {
  return _ctx.isReadOnlyUrl
      || _ctx.isEditingLocked
      || _ctx.isEncryptedNoKey
      || _ctx.isViewOnceConsumed;
}

// ── Public predicates ────────────────────────────────────────────────────────

/** Can this client type into the editor and have it sync? */
export function canEdit() {
  return !_anyEditBlock();
}

/** Can this client send live typing broadcasts? */
export function canBroadcastTyping() {
  return !_anyEditBlock();
}

/** Can this client toggle passcode / encryption / expiration / view-once? */
export function canChangeSettings() {
  // Read-only and lock both disable settings UI.
  // Lock has its own predicate so an already-locked room can still be unlocked.
  return !_ctx.isReadOnlyUrl && !_ctx.isEditingLocked && !_ctx.isEncryptedNoKey && !_ctx.isViewOnceConsumed;
}

/** Can this client toggle the room editing lock itself? */
export function canToggleLock() {
  // A locked room must still be unlockable from an editable link by someone who
  // has passed passcode/encryption gates. Read-only links and encrypted-no-key
  // clients may not change the lock.
  return !_ctx.isReadOnlyUrl && !_ctx.isEncryptedNoKey && !_ctx.isViewOnceConsumed;
}

export function canUploadFiles() {
  // File attachments are stored in Supabase Storage and are not protected by
  // the room text-encryption key, so v1 blocks new uploads while text
  // encryption is enabled to avoid a false sense of end-to-end file security.
  return !_anyEditBlock() && !_ctx.isEncryptionEnabled;
}

export function canDeleteFiles() {
  return !_anyEditBlock();
}

export function canUseTemplates() {
  return !_anyEditBlock();
}

export function canUseChecklist() {
  return !_anyEditBlock();
}

export function canClearNote() {
  return !_anyEditBlock();
}

export function canImportText() {
  return !_anyEditBlock();
}

export function canPaste() {
  return !_anyEditBlock();
}

/** Reasoned, human-readable explanation of why editing is blocked. */
export function editBlockedReason() {
  if (_ctx.isReadOnlyUrl)    return 'This is a read-only share link.';
  if (_ctx.isEditingLocked)  return 'Editing is locked for this room.';
  if (_ctx.isEncryptedNoKey) return 'Encryption is enabled but you do not have the passphrase yet.';
  if (_ctx.isViewOnceConsumed) return 'This view-once note has already been consumed.';
  return null;
}
