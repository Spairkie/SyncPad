# SyncPad

> **A temporary shared notepad for fast handoff between devices.**  
> Create a room, share an editable or read-only link, and sync notes and files in real time — no account needed.

**Live demo:** `https://spairkie.github.io/SyncPad/`

---

> ⚠️ **Personal / demo project.**  
> SyncPad is a personal project built for learning and portfolio purposes.  
> **Read-only links and room locks are frontend/convenience controls, not backend-enforced security boundaries.**  
> Anyone with the Supabase anon key can call the API directly.  
> View-once is a convenience feature, not a secure destruction guarantee. A viewer may copy, screenshot, save, or otherwise preserve content before it clears.  
> **Do not use SyncPad for passwords, HIPAA/PII, classified information, or any sensitive data.**

---

## Screenshots

> Add screenshots to `docs/screenshots/` after first deploy.

| Landing | Editor | Share Modal |
|---------|--------|-------------|
| `docs/screenshots/landing.png` | `docs/screenshots/editor.png` | `docs/screenshots/share-modal.png` |

| File Preview | Admin placeholder | Mobile |
|---|---|---|
| `docs/screenshots/file-preview.png` | `docs/screenshots/admin-placeholder.png` | `docs/screenshots/mobile.png` |

---

## Project Highlights

- **Vanilla JavaScript** ES module architecture — no build step, no bundler, no framework
- **Supabase Realtime** for live sync via Broadcast (~250 ms) and Presence
- **Shareable temporary rooms** — editable and read-only links, QR codes
- **Markdown editor** with Write / Preview / Split modes and a safe custom renderer
- **File upload and preview** — images, text, Markdown, CSV, PDF (no library)
- **Presence, typing indicator, and cursor/activity tracking**
- **Responsive layout** with 7 themes, bottom action bar on mobile
- **Progressive Web App** (PWA) — installable, offline-capable
- **Thorough documentation** and a working Supabase SQL schema

---

## Features

### Core
- **Landing screen** — create a new room or join by URL or room ID
- **Realtime note sync** — Supabase Broadcast, ~250 ms latency
- **Durable saves** — Postgres write after 1 s of idle; local draft backup
- **Offline drafts** — keystrokes saved to localStorage; sync on reconnect
- **Conflict notice** — Apply / Keep mine / Copy remote / Dismiss when two devices edit simultaneously

### Sharing
- **Editable and read-only share links**
- **Redesigned share modal** with edit-access and read-only cards
- **QR codes** with download button for each link type
- **Room editing lock** — pause edits on all devices (frontend only)

### Content & Editing
- **Markdown** — Write, Preview, and Split view modes
- **Safe Markdown rendering** — custom renderer with no raw HTML pass-through; XSS-safe
- **Images** — `![alt](https://…)` renders inline (http/https only)
- **Bare URL autolinking** — plain `https://…` text becomes a clickable link automatically
- **Nested lists** — indented bullet/numbered sub-items render as proper nested lists
- **Checklist preview** — GFM-style checkboxes; click to toggle in preview
- **Templates Library v2** — 13 built-in templates (meeting, checklist, standup, bug report, code review, and more); searchable modal with two-column preview pane
- **Custom templates** — save, rename, delete, export/import as JSON (localStorage-backed, up to 50 000 chars each)
- **Find & Replace** — case-insensitive search with Prev / Next navigation, Replace, and Replace All
- **Keyboard shortcuts** — see [Keyboard Shortcuts](#keyboard-shortcuts) below
- **Export** — download as `.txt`, `.md`, rendered `.html`, or PDF (browser print); copy as plain text or Markdown
- **Monospace toggle** — switch editor font with `Ctrl/⌘ + Shift + M`
- **Timestamp insert** — add current date/time inline

### Collaboration
- **Presence indicator** — see all connected devices with online count
- **Typing indicator** — shows when another device is actively editing
- **Cursor / activity line** — approximate editor line broadcast to other devices (throttled)
- **Device rename** — tap your device name to rename it locally

### Security & Privacy (all frontend/convenience — see Known Limitations)
- **Passcode gate** — PBKDF2-hashed passcode; convenience only
- **Text encryption** — AES-256-GCM + PBKDF2 in-browser; encrypted rooms use DB-only content sync (no plaintext live snapshots); files are NOT encrypted
- **Auto-expiration** — rooms cleared at open after expiry; pg_cron backend cleanup optional
- **View-once** — note cleared server-side after first non-creator editable viewer

### Files
- **File attachments** — upload up to 10 MB per file; signed download URLs (1 h TTL)
- **Multi-file upload** — select or drag-and-drop multiple files at once; uploaded sequentially with progress
- **Bulk select & delete** — multi-select checkboxes with a confirmation modal for deleting several files at once
- **Correct download filenames** — downloads are saved under the original uploaded filename, not the internal Storage path
- **File preview** — see [File Preview](#file-preview) below
- **Drag-and-drop upload** — drop anywhere on the Files panel or editor area; visible overlay
- **Read-only file access** — read-only users can preview and download files but cannot upload or delete

### Appearance & UX
- **7 themes** — Charcoal Amber, Midnight Blue, Forest Green, Paper Light, Terminal, Mocha Dark, Lavender Light
- **Mobile layout** — bottom action bar with one-thumb access to all major features
- **PWA** — installable on desktop and mobile; offline-capable for cached assets


## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/⌘ + S` | Force save |
| `Ctrl/⌘ + Shift + P` | Toggle Preview mode |
| `Ctrl/⌘ + Shift + S` | Toggle Split view |
| `Ctrl/⌘ + Shift + M` | Toggle Monospace font |
| `Ctrl/⌘ + F` | Open Find & Replace panel |
| `Ctrl/⌘ + B` | Bold selected text |
| `Ctrl/⌘ + I` | Italic selected text |
| `Ctrl/⌘ + K` | Insert Markdown link |
| `Ctrl/⌘ + /` | Open keyboard shortcuts help |
| `Esc` | Close panel / modal / dropdown |

Formatting shortcuts (`B`, `I`, `K`) do nothing in read-only or locked mode.

---

## File Preview

In-app file preview is built with vanilla JS and the Fetch API — no external library.

| File type | Preview behavior |
|---|---|
| PNG, JPG, GIF, WebP | Image shown in modal lightbox |
| SVG | Opens in a new tab for XSS safety |
| PDF | Opens in a new tab via signed URL |
| `.txt`, `.log`, `.json`, `.xml`, `.yaml`, `.sh`, `.js`, `.ts`, etc. | Shown as preformatted plain text |
| `.md`, `.markdown` | Rendered via the built-in safe Markdown renderer |
| `.csv` | Rendered as a plain HTML table (up to 300 rows) |
| All other types | Filename, type, size, and Open / Download button |

Large files (>100 KB) show a truncation warning and display only the first 100 KB.  
All previews use signed URLs — the storage bucket remains private.

Close the preview modal with the ✕ button, clicking the backdrop, or pressing `Esc`.

---


## Storage Orphan Cleanup

### Why orphaned files occur

When a room is deleted, Postgres cascade-deletes the `syncpad_files` metadata rows. However, `ON DELETE CASCADE` does **not** remove the physical objects in the Supabase Storage bucket. Storage and database are separate systems.

Orphaned objects (files in the bucket with no matching metadata row) can accumulate over time.

### Automated cleanup

The optional Supabase Edge Function at `supabase/functions/syncpad-cleanup` can run with a service-role key to:

- delete physical Storage objects for expired rooms before encrypted expired rooms are deleted
- call the existing `cleanup_expired_syncpad_rooms()` database function
- list bucket objects and remove confirmed orphans whose `file_path` no longer exists in `syncpad_files`
- run in dry-run mode first

Example manual invocation after deployment:

```bash
curl -X POST "https://YOUR-PROJECT-REF.functions.supabase.co/syncpad-cleanup" \
  -H "Authorization: Bearer $SYNCPAD_CLEANUP_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"all","dryRun":true}'
```

Set `dryRun` to `false` only after reviewing the dry-run counts.

### Running orphan reconciliation from the admin dashboard

Once deployed, the Cleanup tab's **Storage Orphan Reconciliation** section calls the
same function (`mode: "orphans"`) directly from the browser, authenticated with the
signed-in admin's own Supabase session rather than `SYNCPAD_CLEANUP_SECRET` — the
Edge Function validates that session and checks the user against `syncpad_admins`
itself, so the secret never needs to reach the client. It previews the orphan count
first and only deletes after an explicit confirm. Requires the function to actually
be deployed (`supabase functions deploy syncpad-cleanup`); the button surfaces a
clear error if it isn't reachable.

### Manual cleanup steps

1. **List metadata paths** - query `syncpad_files` for all `file_path` values.
2. **List storage objects** - use Supabase Dashboard -> Storage -> `syncpad-files` bucket, or the Storage REST API.
3. **Cross-reference** - identify objects in storage with no matching `file_path` row.
4. **Delete orphans** - remove only confirmed orphaned objects.

```sql
-- Step 1: all file paths tracked in metadata
SELECT room_id, file_path, filename, file_size
FROM   syncpad_files
ORDER  BY room_id, uploaded_at;

-- NOTE: SQL alone cannot list Supabase Storage bucket objects.
-- Use the Supabase Dashboard or the Storage Management API for step 2.
```

> Always back up before deleting. Deleted storage objects cannot be recovered.

---


## Web3Forms operations (Contact page)

- The Web3Forms access key in `index.html` is a **public frontend key**; do not treat it like a private service-role secret.
- In Web3Forms dashboard, set **Allowed domain** to `spairkie.github.io`.
- Recommended **subject**: `New SyncPad Contact Form Submission`.
- Recommended **from_name**: `SyncPad Contact Form`.
- Keep **hCaptcha disabled** unless/until a frontend hCaptcha widget is implemented.
- Keep Web3Forms `botcheck` honeypot enabled.
- Room-report abuse controls are DB-enforced via reason allowlist + details max length checks and insert-only anon RLS.

## Known Limitations

| Limitation | Notes |
|---|---|
| No backend-enforced permissions | All permission checks are client-side JavaScript |
| No user accounts or authentication | Normal users do not log in; SyncPad is anonymous and link-based |
| Read-only share links are bearer-token links | They hide the room path but are still possession-based access, not identity authorization |
| Room lock is frontend-only | Not a security boundary |
| Admin access requires Supabase Auth | The `/admin` route is protected by `signInWithPassword` + `is_syncpad_admin()` RLS — not for end users |
| View-once is convenience-only | Not a secure destruction guarantee; viewers can still copy or capture content before it clears |
| Files are not end-to-end encrypted | Text encryption covers note content only unless file encryption is explicitly added |
| Passcode is a convenience gate | Hash is checked client-side; not server-enforced |
| Storage cleanup needs service-role maintenance | Admin room deletion removes known physical objects first; backend cleanup paths need the optional `syncpad-cleanup` Edge Function because SQL cannot delete Storage objects |

---

## Technical Notes

### Architecture

```
Browser UI (HTML/CSS/JS)
    └── ES Modules (src/*.js)
            ├── app.js          — routing, event wiring, state coordination
            ├── ui.js           — all DOM manipulation
            ├── sync.js         — live typing + durable save lanes
            ├── presence.js     — device/typing/cursor tracking
            ├── live-broadcast.js — Supabase Broadcast events
            ├── files.js        — upload, download, delete (signed-URL cache)
            ├── file-preview.js — in-app preview modal
            ├── markdown.js     — safe custom Markdown renderer
            ├── encryption.js   — AES-256-GCM + PBKDF2 (Web Crypto)
            ├── permissions.js  — frontend permission context
            ├── settings.js     — room settings (passcode, expiry, etc.)
            ├── templates.js    — 13 built-ins + localStorage custom templates
            ├── theme.js        — CSS variable theme system
            ├── shortcuts.js    — keyboard shortcut handler
            └── admin.js        — admin dashboard (Supabase Auth + RLS)

Supabase Backend
    ├── syncpad_rooms        (Postgres table + Realtime)
    ├── syncpad_files        (Postgres table + Realtime)
    ├── syncpad_share_links  (Postgres table)
    ├── syncpad_room_reports (Postgres table, insert-only for anon)
    └── syncpad-files        (Storage bucket, private, signed URLs)
```

See [`docs/architecture.md`](docs/architecture.md) for the full module-by-module breakdown and data flow diagrams.

### Key design decisions

- **No build step** — ES modules load directly in the browser; deployment is a simple `git push`
- **No raw HTML pass-through** — the Markdown renderer escapes everything first, then applies a safe allow-list of tags
- **Two sync tracks** — Broadcast for live typing (~250 ms), Postgres for durable saves (1 s debounce)
- **Encryption in-browser only** — AES-256-GCM key derived from passphrase via PBKDF2; plaintext never leaves the device over the network when encryption is active
- **Service worker** — network-first caching for same-origin assets; Supabase traffic bypassed entirely
- **Theme system** — CSS custom properties with a `data-theme` attribute on `<html>`; seven themes with zero runtime overhead

### Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML + CSS + ES Modules |
| Realtime sync | Supabase Broadcast |
| Presence | Supabase Presence |
| Database | Supabase Postgres (with RLS) |
| File storage | Supabase Storage (private bucket, signed URLs) |
| Encryption | Web Crypto API (PBKDF2 + AES-GCM-256) |
| Markdown | Custom safe renderer (built from scratch) |
| File preview | Fetch API + vanilla JS (no library) |
| PWA | Service Worker + Web App Manifest |
| Tests | Playwright (chromium, firefox, webkit, mobile) |

---

## Documentation

| Document | Description |
|---|---|
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Step-by-step deploy guide (Supabase, GitHub Pages, custom domain) |
| [`docs/architecture.md`](docs/architecture.md) | Module responsibilities, data flow, state management |
| [`docs/security.md`](docs/security.md) | Security model, encryption, XSS mitigations, known limitations |
| [`docs/playwright.md`](docs/playwright.md) | Running and writing Playwright tests |
| [`CHANGELOG.md`](CHANGELOG.md) | Change history |
| [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) | Pre-release verification checklist |
| [`CLAUDE.md`](CLAUDE.md) | Development guide for AI coding assistants |

---

## Testing

```bash
npm run serve          # start static server on :5555
npx playwright install # one-time browser download
npm test               # run all tests (headless)
npm run test:ui        # Playwright UI mode
npm run test:chrome    # chromium only
npm run test:report    # open HTML report
```

See [`docs/playwright.md`](docs/playwright.md) for the full test guide.

---

## Roadmap

### Recently completed

- [x] Multi-file upload — drag-and-drop and file-picker both accept multiple files at once, uploaded sequentially with per-file progress
- [x] Correct download filenames — downloads now carry the original uploaded filename via a forced-download signed URL, instead of the sanitized/timestamped Storage path name
- [x] PWA last-room resume — installed/standalone launches reopen the last room instead of the landing screen
- [x] Markdown: image embedding (`![alt](url)`), bare-URL autolinking, and nested lists
- [x] Find & Replace — case-sensitive toggle (`Aa`), Replace / Replace All
- [x] Expiration countdown — live "expires in Xh Xm Xs" bar; relative time in settings panel
- [x] Syntax highlighting in preview — Prism.js autoloader for fenced code blocks
- [x] Bulk file delete — multi-select checkboxes with confirmation modal
- [x] File sort — 6 orderings in the Files panel (newest, oldest, name, size)
- [x] Admin dashboard — Supabase Auth gate, rooms / reports / cleanup tabs
- [x] Templates Library v2 — 13 built-ins, searchable modal, export / import JSON
- [x] PDF export — browser `window.print()` in a styled preview window
- [x] Playwright test suite — ~75 scenarios across 6 spec files, 4 browser projects
- [x] Editor modernization — floating card layout, comfortable max writing width, split-view divider

### Takeover roadmap completed

- [x] Keep SyncPad as a transparent demo project and document frontend-only permission boundaries
- [x] Keep file attachments unencrypted and document Storage behavior
- [x] Allow read-only viewers to unlock passcode/encrypted rooms when they separately have the secret
- [x] Keep GitHub Pages `/SyncPad` as the permanent target while centralizing runtime base-path handling
- [x] Delete known physical Storage objects during admin room deletion paths
- [x] Add optional service-role Edge Function for backend Storage cleanup and orphan cleanup
- [x] Batch admin expired-room cleanup queries for larger room sets
- [x] Add real `/share/:token` protected-room regression tests
- [x] Add admin user setup documentation in `docs/admin-setup.md`
- [x] Bump service worker cache version for this release (`syncpad-v18`)

### Outside current demo scope

- Read-only link PIN
- Production-grade backend authorization and rate limiting
- Live deployment verification after Supabase/GitHub Pages secrets are configured

---

## License

Personal / demo project. Not licensed for production use with sensitive data.
