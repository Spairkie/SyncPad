// SyncPad – permissions.js
// Single source of truth for what the current client is allowed to do.
//
// Inputs are pulled from a small "context" object so this module stays pure
// and easy to reason about. Callers update the context via setPermissionContext
// whenever the relevant state changes (room state, URL mode, encryption lock).
//
// IMPORTANT: these helpers are a UX layer, not the actual security
// boundary — they exist so the UI can gate/disable controls and show the
// right message before ever sending a request, but a determined user can
// still call Supabase directly with the anon key and skip this module
// entirely. What actually stops them differs by flag:
//   - isEditingLocked IS independently enforced server-side too (a locked
//     room's content-change trigger — see supabase/migrations/0001) —
//     bypassing this module doesn't bypass that.
//   - isReadOnlyUrl is a UI/UX convention, not server-enforced: room_id
//     alone is sufficient to write (see supabase/migrations/
//     0009_revert_edit_token_write_gating.sql), so ?mode=read and
//     /share/:token discourage editing in the app's own UI but don't stop a
//     technical visitor from writing directly. Lock a room (isEditingLocked)
//     for an actual guarantee that nobody — owner included — can edit it.
//   - isEncryptedNoKey and isViewOnceConsumed are enforced by what data is
//     actually available (ciphertext without the key is useless; a
//     view-once room's content is really gone server-side after
//     consumption) rather than by a permission check as such.

let _ctx = {
  isReadOnlyUrl:       false, // ?mode=read or /share/:token — UX only, see note above
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

/** Can this client broadcast live note snapshots over Realtime? */
export function canBroadcastLiveContent() {
  return !_anyEditBlock() && !_ctx.isEncryptionEnabled;
}

/** Can this client accept/render live note snapshots from other devices? */
export function canReceiveLiveContent() {
  // Read-only viewers may receive live snapshots for responsiveness.
  // Encrypted rooms remain DB-only unless this client has the key.
  return !_ctx.isEncryptedNoKey && !_ctx.isViewOnceConsumed;
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
  if (_ctx.isReadOnlyUrl)    return 'This link is read-only. Visit the room’s plain URL to make changes.';
  if (_ctx.isEditingLocked)  return 'Editing is locked for this room.';
  if (_ctx.isEncryptedNoKey) return 'Encryption is enabled but you do not have the passphrase yet.';
  if (_ctx.isViewOnceConsumed) return 'This view-once note has already been consumed.';
  return null;
}
