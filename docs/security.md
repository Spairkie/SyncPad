# SyncPad Security Model

> **Scope:** This document describes the security architecture of SyncPad as a personal/demo project. SyncPad is not designed for sensitive data — see [Known Limitations](#known-limitations--threat-model) before storing anything confidential.

---

## Table of Contents

1. [Security Model Overview](#security-model-overview)
2. [Text Encryption](#text-encryption)
3. [XSS Mitigations](#xss-mitigations)
4. [File Access and Signed URLs](#file-access-and-signed-urls)
5. [Supabase RLS Summary](#supabase-rls-summary)
6. [Admin Security](#admin-security)
7. [Known Limitations / Threat Model](#known-limitations--threat-model)
8. [Before Going to Production](#before-going-to-production)

---

## Security Model Overview

SyncPad has two distinct categories of access controls: controls that are enforced by the backend (Supabase RLS policies and RPCs) and controls that are implemented purely in frontend JavaScript. The distinction matters because frontend-only controls can be bypassed by anyone who can call the Supabase REST API directly using the public anon key.

### Frontend-Only Controls (NOT Backend-Enforced)

These features exist as UX conveniences. They do not constitute security boundaries.

| Feature | How It Works | Bypass |
|---|---|---|
| Read-only share links | Bearer token embedded in `/share/:token`; token resolves to a room and the frontend enters read-only mode | Anyone with the anon key can call the Supabase REST API directly and write to the room |
| Room lock | `is_locked` is a JavaScript-checked flag in the room record | Calling the API directly ignores the lock |
| Passcode protection | PBKDF2 hash of the passcode is stored in `syncpad_rooms`; the client computes and compares the hash | The hash is readable by anyone with the anon key; the passcode itself is not stored, but a determined attacker can attempt offline brute-force against the hash |
| View-once rooms | Server clears content after the first non-creator editable view | A viewer can still copy or screenshot content before the server clears it; the clearing is not atomic with the act of viewing |

### Backend-Enforced Controls

These controls are implemented as Supabase Row Level Security (RLS) policies and server-side functions. They cannot be bypassed through the REST API with only the anon key.

| Feature | Mechanism |
|---|---|
| Per-table access control | RLS policies on `syncpad_rooms`, `syncpad_files`, `syncpad_share_links`, `syncpad_room_reports` |
| Room reports | Anon users can INSERT only; no SELECT, UPDATE, or DELETE |
| Admin access | `is_syncpad_admin()` database function checked by Supabase Auth and RLS on every admin query |
| Share token resolution | Exposed via RPC only for anon users — no direct table SELECT on `syncpad_share_links` |

---

## Text Encryption

SyncPad supports optional in-browser AES-256-GCM encryption for room text content. When encryption is enabled, plaintext is never transmitted over the network.

### Algorithm and Key Derivation

- **Cipher:** AES-256-GCM (authenticated encryption — provides both confidentiality and integrity)
- **Key derivation:** PBKDF2 with SHA-256, 200,000 iterations for text encryption
- **Salt:** Generated per room, stored in `syncpad_rooms.encryption_salt`
- **Passphrase:** Provided by the user — never stored anywhere

The key is derived entirely in the browser from the user's passphrase and the room salt. The derived key is held in memory for the session and discarded when the page is closed.

### What IS Encrypted

- Room text content stored in the database
- Real-time sync uses database-only content delivery when encryption is active — plaintext Broadcast channel snapshots are suppressed

### What Is NOT Encrypted

- File attachments — files are uploaded to Supabase Storage unencrypted (see [File Access and Signed URLs](#file-access-and-signed-urls))
- Room metadata (title, creation time, settings flags, encryption salt)
- Share link records

### Threat Model for Encrypted Rooms

Encryption protects against a passive observer who can read the Supabase database but does not know the passphrase. It does not protect against:

- An attacker who obtains the passphrase
- Compromise of the client device or browser
- Offline dictionary attacks against a weak passphrase (the PBKDF2 iteration count raises the cost but does not eliminate the risk)

---

## XSS Mitigations

User-supplied content is rendered in several contexts. The following mitigations are applied.

### HTML Escaping

`escapeHtml()` from `utils.js` is applied to all user content before it is inserted into the DOM as HTML. This covers room text rendered outside the Markdown path, room IDs used in export `<title>` elements, and other interpolated values.

### Markdown Renderer

The Markdown renderer does not pass raw HTML through. Its pipeline is:

1. All input is escaped with `escapeHtml()` first
2. A safe allow-list of HTML tags is applied — only explicitly permitted tags survive
3. No arbitrary HTML pass-through

`javascript:` link hrefs are blocked: the renderer checks the protocol of any link before emitting an `<a>` tag. Links with a `javascript:` protocol are dropped.

### SVG Files

SVG files are not previewed inline. They are opened in a new browser tab. This prevents execution of embedded scripts that SVG files can legally contain.

---

## File Access and Signed URLs

Files are stored in a private Supabase Storage bucket named `syncpad-files`. The bucket is never made public.

### Access Flow

1. A client requests a file by its storage path.
2. The backend generates a signed URL valid for 1 hour.
3. The client fetches the file directly from the signed URL.

### Signed URL Cache

`files.js` maintains an in-memory signed URL cache with a 55-minute TTL (5 minutes shorter than the URL lifetime) to avoid redundant signing API calls. The cache entry for a file is evicted immediately when that file is deleted.

### Encryption Note

Files are uploaded and stored unencrypted. Signed URLs provide time-limited access control, but anyone who obtains a valid signed URL within its 1-hour window can download the file. Do not store sensitive files in SyncPad.

---

## Supabase RLS Summary

Row Level Security is enabled on all SyncPad tables. The policies are the authoritative enforcement layer for data access.

| Table | Anon SELECT | Anon INSERT | Anon UPDATE | Anon DELETE | Notes |
|---|---|---|---|---|---|
| `syncpad_rooms` | Policy-gated | Yes (room creation) | Policy-gated | No | Read restricted by share link and lock logic at RLS level |
| `syncpad_files` | Policy-gated | Policy-gated | No | No | Access tied to room access |
| `syncpad_share_links` | No direct access | Policy-gated | No | No | Resolution via RPC only |
| `syncpad_room_reports` | No | Yes (insert only) | No | No | Reports are write-only for anon users |

Admin queries are additionally gated by the `is_syncpad_admin()` function, which is evaluated server-side on every request. A user without the admin flag in Supabase Auth cannot satisfy this predicate regardless of what they send in the request.

---

## Admin Security

- The `/admin` route requires authentication via Supabase Auth (email and password).
- Every admin database query is gated by the `is_syncpad_admin()` RLS policy — there is no admin-only API surface that bypasses RLS.
- JWT expiry and insufficient privilege errors (`PGRST301`) are surfaced to the admin UI as the human-readable message "You do not have admin access." rather than exposing internal error details.

### Admin session and Supabase role

SyncPad uses a single shared Supabase client for both the normal app and the admin dashboard. After a user signs in via Supabase Auth at `/admin`, the client's effective role changes from `anon` to `authenticated`. Supabase RLS policies are role-specific — policies written for `to anon` do not apply to `authenticated` requests, and vice versa.

Without a matching set of baseline policies for the `authenticated` role, normal app operations (loading rooms, uploading files, etc.) fail with RLS permission errors after admin login. The `supabase-setup.sql` script includes **authenticated baseline** policies that mirror the anon policies for `syncpad_rooms`, `syncpad_files`, and the `syncpad-files` storage bucket. These do not grant additional privileges — they simply ensure normal app features continue to work during an authenticated session. Elevated admin actions (delete rooms, bulk manage files) are still gated by `is_syncpad_admin()` in separate policies.

---

## Known Limitations / Threat Model

SyncPad is a personal/demo project. The following are known weaknesses that should be understood before using it for anything important.

**Anonymous by design.** SyncPad has no backend-enforced user identity system. There are no user accounts tied to rooms at the database level. "Ownership" of a room is a frontend concept only.

**Anon key is public.** The Supabase anon key is embedded in the frontend bundle and is not secret. Anyone who reads the page source has the anon key and can call the Supabase REST API directly, bypassing all frontend-only controls (read-only links, room lock, passcode, view-once).

**Room IDs are short random strings.** If the character space and length of room IDs are known, an attacker with enough requests can enumerate rooms. There is no rate limiting described in this document — evaluate Supabase's built-in rate limiting and consider whether it is sufficient.

**Passcode hashes are accessible.** The PBKDF2 hash of a room passcode is stored in `syncpad_rooms` and is readable to anyone with the anon key. The passcode itself is not stored, but offline brute-force against a weak passcode is possible.

**Files are not end-to-end encrypted.** Files sit in Supabase Storage in plaintext. Signed URLs provide time-limited access but not encryption at rest from Supabase's perspective.

**localStorage is origin-scoped.** Custom templates and drafts stored in `localStorage` are accessible to any JavaScript running on the same origin. If a third-party script is ever loaded on the SyncPad origin (analytics, embeds), it would have access to this data.

**View-once is not atomic.** The server clears view-once content after the first qualifying view, but there is a window between the content being delivered to the client and the server clearing it. A viewer can copy or screenshot the content before it is cleared.

**Recommendation:** Do NOT use SyncPad to store passwords, personal health information (HIPAA/PHI), personally identifiable information (PII), classified or regulated data, or any information that would cause harm if disclosed.

---

## Before Going to Production

If SyncPad is ever deployed for broader use, the following items should be addressed first.

**Web3Forms allowed domain.** The contact/report form uses Web3Forms. Configure the allowed domain in the Web3Forms dashboard to restrict form submissions to your production domain. Without this, anyone can submit forms using your Web3Forms key from any origin.

**RLS audit.** SyncPad intentionally keeps room and file RLS broad for a transparent demo project. If the project ever changes direction toward real backend-enforced sharing, redesign room access around server-verifiable room/share tokens before tightening policies.

**Storage bucket review.** Confirm the `syncpad-files` bucket has no public access enabled. Review the storage policies to ensure that file SELECT and INSERT are tied to room membership in a way that RLS enforces, not just frontend logic.

**Rate limiting.** Evaluate Supabase's built-in rate limiting for the REST API and RPC endpoints. Consider adding application-level rate limiting for room creation and share link resolution to reduce the viability of room ID enumeration.

**Room ID entropy.** If room IDs are short, consider increasing their length or character space to raise the cost of brute-force enumeration.

**PBKDF2 iterations.** Passcode hashes use 100,000 PBKDF2 iterations and text encryption uses 200,000. Review current OWASP guidance before any broader launch and adjust if needed.

**Content Security Policy.** Add a `Content-Security-Policy` header that restricts script sources to your own origin. This hardens the XSS mitigations already present in the code by providing a browser-enforced second line of defense.

**Dependency audit.** Run `npm audit` (or equivalent) and resolve high/critical findings before launch.
