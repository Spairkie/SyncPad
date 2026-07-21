// SyncPad – files.js
// File upload, download, and deletion.
//
// Delete order: storage FIRST, then metadata.
// Rationale: if storage succeeds but the metadata delete fails, the orphaned
// DB row points to a nonexistent file (user sees a broken download link).
// If we delete metadata first and storage fails, the user has no way to
// access or delete the file through the UI.
// Broken download links are self-evident; orphaned storage is invisible.
//
// NOTE: ON DELETE CASCADE on syncpad_files only removes the metadata rows
// when a room is deleted. It does NOT remove the physical files in the
// syncpad-files Storage bucket. Those must be cleaned up separately.
import { getSupabaseClient } from './supabase.js';
import { logSupabaseError, getDeviceId } from './utils.js';

const BUCKET   = 'syncpad-files';
const TABLE    = 'syncpad_files';
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

// ── Signed URL cache ──────────────────────────────────────────────────────────
// Supabase signed URLs are valid for 3600 s (1 hour). We cache them for 55 min
// (3300 s) to avoid redundant API calls on every download/preview interaction
// while leaving a 5-minute safety margin before expiry.
//
// Two separate caches are kept because they request different Content-Disposition
// behavior from Storage:
//   _urlCache          – plain signed URL, served inline. Used for previews
//                        (images, PDFs/SVGs opened in a new tab, fetch()'d text/
//                        markdown/CSV) where the browser must render the content,
//                        not download it.
//   _downloadUrlCache   – signed URL requested with `download: <original filename>`,
//                        which makes Storage return a Content-Disposition: attachment
//                        header carrying the real filename. This is required because
//                        the storage path is `${roomId}/${timestamp}_${sanitizedName}`
//                        and the anchor `download` attribute is not honored by modern
//                        browsers for cross-origin URLs — without this, a saved file
//                        would be named e.g. "1737483920123_my_file.pdf" instead of
//                        the name the uploader actually gave it.
const _urlCache         = new Map(); // filePath → { url: string, expiresAt: number }
const _downloadUrlCache = new Map(); // filePath → { url: string, expiresAt: number }
const URL_TTL_MS = 55 * 60 * 1000; // 55 minutes in milliseconds

export async function uploadFile(roomId, file) {
  if (file.size > MAX_SIZE) throw new Error('File too large. Maximum size is 10 MB.');
  const sb       = getSupabaseClient();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = `${roomId}/${Date.now()}_${safeName}`;

  const { error: uploadError } = await sb.storage.from(BUCKET).upload(
    filePath, file, { contentType: file.type || 'application/octet-stream' }
  );
  if (uploadError) {
    logSupabaseError('uploadFile:storage', uploadError, { room_id: roomId });
    throw new Error('Could not upload file.');
  }

  const { data, error: dbError } = await sb.from(TABLE)
    .insert({
      room_id:           roomId,
      filename:          file.name,
      file_path:         filePath,
      file_size:         file.size,
      mime_type:         file.type || null,
      uploaded_by_device: getDeviceId(),
    })
    .select()
    .single();

  if (dbError) {
    logSupabaseError('uploadFile:metadata', dbError, { room_id: roomId });
    // Roll back the storage upload (best-effort — ignore error)
    await sb.storage.from(BUCKET).remove([filePath]).catch(() => {});
    throw new Error('Could not save file metadata.');
  }

  return data;
}

/**
 * Get an inline signed URL for a file — used for previews (images, PDFs/SVGs
 * opened in a new tab, fetch()'d text/markdown/CSV). Renders in the browser
 * rather than forcing a download; does not carry the original filename.
 */
export async function getDownloadUrl(filePath) {
  // Return cached URL if still valid
  const cached = _urlCache.get(filePath);
  if (cached && Date.now() < cached.expiresAt) return cached.url;

  const { data, error } = await getSupabaseClient()
    .storage.from(BUCKET).createSignedUrl(filePath, 3600);
  if (error) {
    logSupabaseError('getDownloadUrl', error, { file_path: filePath });
    throw new Error('Could not generate download link.');
  }
  _urlCache.set(filePath, { url: data.signedUrl, expiresAt: Date.now() + URL_TTL_MS });
  return data.signedUrl;
}

/**
 * Get a signed URL that forces a browser download with the file's original
 * name via a server-set Content-Disposition header. Use this for actual
 * "Download" actions; use getDownloadUrl() for inline preview.
 * @param {string} filePath
 * @param {string} filename  – original filename to save as
 * @param {object} [opts]
 * @param {boolean} [opts.fresh=false]  – bypass the cache and mint a new URL.
 *   A cached entry can be up to 55 minutes old when returned, leaving as
 *   little as ~5 minutes of the underlying 60-minute signed URL's real
 *   lifetime — fine for an immediate download, but not for "copy a link to
 *   share with someone who might not open it right away," where the whole
 *   point is a link that's actually good for close to the full ~55 minutes.
 */
export async function getForceDownloadUrl(filePath, filename, { fresh = false } = {}) {
  const cached = fresh ? null : _downloadUrlCache.get(filePath);
  if (cached && Date.now() < cached.expiresAt) return cached.url;

  const { data, error } = await getSupabaseClient()
    .storage.from(BUCKET).createSignedUrl(filePath, 3600, { download: filename || true });
  if (error) {
    logSupabaseError('getForceDownloadUrl', error, { file_path: filePath });
    throw new Error('Could not generate download link.');
  }
  _downloadUrlCache.set(filePath, { url: data.signedUrl, expiresAt: Date.now() + URL_TTL_MS });
  return data.signedUrl;
}

/**
 * Delete a file. Removes storage first, then metadata.
 *
 * Step 1: Delete from storage. If it fails, abort with an error — the file
 *         remains accessible to the user via the download link.
 * Step 2: Delete the metadata row. If it fails, throw a distinct error so the
 *         caller can surface a clear warning to the user (the physical file
 *         is gone, but the row still appears in the list and points nowhere).
 *
 * The two-step delete intentionally throws on either failure so the caller
 * sees an explicit error instead of silently leaving an inconsistency.
 */
export async function deleteFile(fileId, filePath) {
  const sb = getSupabaseClient();

  // Evict cached signed URLs so stale links are not returned after deletion.
  _urlCache.delete(filePath);
  _downloadUrlCache.delete(filePath);

  // Step 1: Delete from storage. Abort if this fails.
  const { error: se } = await sb.storage.from(BUCKET).remove([filePath]);
  if (se) {
    logSupabaseError('deleteFile:storage', se, { file_path: filePath });
    throw new Error('Could not delete the file from storage.');
  }

  // Step 2: Remove the metadata row. Storage is already gone; surface this.
  const { error: de } = await sb.from(TABLE).delete().eq('id', fileId);
  if (de) {
    logSupabaseError('deleteFile:metadata (orphaned row)', de, { file_id: fileId });
    const err = new Error('File removed from storage, but the metadata row could not be deleted. Refresh the file list.');
    err.code = 'METADATA_DELETE_FAILED';
    throw err;
  }
}

export async function listFiles(roomId) {
  const { data, error } = await getSupabaseClient()
    .from(TABLE).select('*').eq('room_id', roomId)
    .order('uploaded_at', { ascending: false });
  if (error) { logSupabaseError('listFiles', error, { room_id: roomId }); throw error; }
  return data || [];
}

export function subscribeToFiles(roomId, onFilesChange) {
  const sb = getSupabaseClient();
  const ch = sb.channel(`db-files-${roomId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE,
        filter: `room_id=eq.${roomId}` }, () => onFilesChange())
    .subscribe();
  return () => sb.removeChannel(ch);
}
