# SyncPad

A live shared notepad with real-time sync across all your devices.
No account needed — share the URL to collaborate instantly.

**Deploy target:** `https://spairkie.github.io/SyncPad/`

---

## Features

- **Live sync** — changes stream to all connected devices via Supabase Broadcast (~250 ms)
- **Durable saves** — content written to Postgres after 1 s of idle time; safe on refresh
- **Passcode gate** — optional shared passcode for normal app entry, stored as a salted PBKDF2 hash. This is a convenience gate, not backend access control; use text encryption for real note confidentiality
- **Text encryption** — AES-256-GCM with PBKDF2 (200 k iterations). Note text is encrypted in-browser before reaching Supabase. Live Broadcast text is also encrypted — plaintext note text never leaves your device over Supabase Realtime
- **Read-only share links** — share a viewable-but-not-editable app view. This is enforced by the frontend, not by Supabase RLS
- **Lock editing** — pause edits across all devices while keeping the note visible
- **Markdown preview** — toggle a clean preview, with clickable checklist boxes
- **Templates** — meeting notes, daily plan, checklist, troubleshooting, and more
- **File attachments** — upload files up to 10 MB per room; signed download URLs. New uploads are blocked while text encryption is enabled because v1 does not encrypt files
- **Auto-expiration** — rooms clear when opened after expiry, and the included Supabase cleanup function/pg_cron schedule clears expired rooms server-side when nobody is online
- **View-once** — the note is displayed to the first non-creator editable viewer, then the durable server copy is cleared. Read-only links do not consume view-once notes
- **Offline drafts** — keystrokes are saved to localStorage; encrypted rooms store drafts encrypted locally, and content syncs on reconnect
- **PWA** — installable on desktop and mobile

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Plain HTML + CSS + ES Modules (no build step, no bundler) |
| Live typing | Supabase Broadcast |
| Presence | Supabase Presence |
| Storage | Supabase Postgres + Storage |
| Encryption | Web Crypto API (PBKDF2 + AES-GCM-256) |
| Markdown | Custom safe renderer (no library, no raw HTML pass-through) |
| Hosting | GitHub Pages |
| Fonts | DM Sans + DM Mono (Google Fonts CDN) |
| QR codes | qrcodejs (jsDelivr CDN) |

---

## Setup

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a free project.
2. Optional but recommended: enable **pg_cron** in **Database → Extensions** so expired-room cleanup can run automatically.
3. In **SQL Editor**, paste and run `supabase-setup.sql`. The script is **safe to rerun** — all statements are idempotent. It creates tables, RLS policies, Storage bucket policies, the expired-room cleanup function, and schedules cleanup every 10 minutes if `pg_cron` is enabled.
4. Confirm the `syncpad-files` Storage bucket was created (**Storage → Buckets**). If not, create it manually (private, not public).

### 2. Configure credentials

Open `index.html` and replace the placeholder values near the bottom of `<head>`:

```html
<script>
  window.SYNCPAD_CONFIG = {
    supabaseUrl:     'https://YOUR_PROJECT.supabase.co',
    supabaseAnonKey: 'YOUR_ANON_KEY_HERE',
  };
</script>
```

Your **anon key** is at Supabase Dashboard → Settings → API → `anon public`.

### 3. Deploy to GitHub Pages

```bash
git init
git remote add origin https://github.com/spairkie/SyncPad.git
git add .
git commit -m "Initial SyncPad deploy"
git push -u origin main
```

In the GitHub repo → **Settings → Pages**, set source to `main` branch, root `/`.

The app will be live at `https://spairkie.github.io/SyncPad/`. For a slower step-by-step walkthrough, see [`DEPLOYMENT.md`](DEPLOYMENT.md).

---

## v1 Release Correctness Fixes

These correctness fixes are included in the initial v1 deploy build.

1. **Encryption state propagates immediately.** Toggling encryption now installs the new encrypt/decrypt functions into the sync pipeline on the fly. No reload is needed before live typing and DB saves switch over.
2. **Remote encryption changes never leak ciphertext.** If another device enables encryption while you are connected and you have no key, the editor is cleared and an "Encrypted — reload to enter passphrase" banner appears. Future encrypted Broadcast and database updates are ignored until the room is unlocked, so ciphertext is never shown.
3. **View-once keeps the note visible locally without resaving.** The first non-creator viewer keeps the note on screen after the server is cleared, but the editor is locked so the consumed note cannot be written back to the database. A toast explains what happened. The viewer's own clear echo is suppressed so the note does not vanish from underneath them.
4. **No duplicate event listeners.** `wireEvents()` is guarded so it can only run once per page load. No more duplicate saves, broadcasts, or toasts.
5. **Cleaner Import .txt path.** The duplicate FileReader block was removed. Import is treated as a normal local edit (word count, draft save, debounced DB save, live broadcast), and it respects read-only mode and editing lock.
6. **Service worker updates wait for control change.** The new SW posts `SKIP_WAITING` and only reloads when the browser actually swaps in the new controller. No double reloads, no broken first-paint after deploy.
7. **Service worker bypasses Supabase entirely.** Any URL on a `*.supabase.co`, `*.supabase.in`, or `*.supabase.io` host passes straight through — Realtime, REST, Auth, and Storage all skip the cache. Cross-origin requests are not cached. Non-GET requests pass through untouched. Every fetch path returns a valid `Response` (no "Failed to convert value to Response" errors).
8. **Safer file delete.** Storage objects are removed first; only then is metadata deleted. If metadata deletion fails after Storage succeeded, a specific warning is shown so the user knows what happened.
9. **Encrypted empty states stay verifiable.** Empty encrypted rooms, manual clears, expirations, and view-once clears now store encrypted empty payloads, so a wrong passphrase still fails after reload.
10. **Settings writes are stamped.** Settings-only changes update `updated_at` and `updated_by_device`, preventing stale writer metadata from causing false remote-content conflicts.
11. **Passcodes are salted.** New passcodes use salted PBKDF2 hashes via `passcode_salt`. The legacy unsalted check path remains only for graceful compatibility.
12. **Text-encrypted rooms block new file uploads.** File attachments are not encrypted in v1, so new uploads are disabled while text encryption is on.
13. **Encrypted local drafts.** Encrypted-room drafts are encrypted before being written to localStorage and decrypted only after the passphrase unlocks the room.
14. **Stronger room ID entropy.** New room IDs now use `crypto.getRandomValues()` instead of `Math.random()`.
15. **Backend expired-room cleanup.** `supabase-setup.sql` now includes `public.cleanup_expired_syncpad_rooms()` and an optional pg_cron schedule. Unencrypted expired rooms are cleared in place; encrypted expired rooms are deleted because the database cannot write an encrypted empty note without the passphrase.

---

## v1 Features

### Read-only share links

Append `?mode=read` to any room URL to open it in read-only mode:

```
https://spairkie.github.io/SyncPad/room-name           ← editable
https://spairkie.github.io/SyncPad/room-name?mode=read ← read-only
```

A read-only visitor can:

- view the note (and live updates)
- copy the note
- download the note as `.txt`

A read-only visitor **cannot**:

- type, paste, import `.txt`, or insert templates
- clear the note
- change passcode / encryption / expiration / view-once / lock
- upload or delete files
- broadcast active typing

The textarea is set to `readonly`, not `disabled`, so selecting and copying text still works on every platform. A "Read-only mode" badge appears in the header.

**Security note:** Read-only mode is a **frontend convenience**, not a security boundary. It prevents edits in the normal SyncPad interface, but the current v1 Supabase policies still allow anon backend writes. Anyone with the public anon key and room ID could call the backend directly. Real read-only enforcement would require per-room server-side tokens/policies and is intentionally out of scope for v1.

### Lock editing

A new room setting **Lock editing** pauses edits across every device without changing the note content. Useful while reviewing.

- Editing, clear, paste, import, templates, and checklist toggles are all disabled while locked.
- The note remains visible.
- The lock state syncs live to other devices via the existing settings-change broadcast.
- The lock state is stored in `syncpad_rooms.editing_locked` and survives refresh.
- Lock toggling **does not rewrite note content** — it only updates the settings column.
- Read-only mode and lock mode are independent. If either is active, editing is blocked.

### Better share modal

The share modal now shows two link rows side-by-side:

- **Editable link** with copy button and QR code
- **Read-only link** with copy button and QR code

Each QR has a small "Download QR" button below it. The passcode warning ("share separately") and a new encryption warning ("the passphrase is not included in this link") appear conditionally. A "Send to another device" section gives the 3-step QR flow.

The passcode and the encryption passphrase are **never** included in the share link.

### Tools

- One-click **Copy room URL** (footer button + clickable room name)
- **Download .txt** of the current note
- **Import .txt** (treated as a normal edit; blocked in read-only / locked)
- **Word & character count** updates locally — never triggers a DB write
- **Insert timestamp** (treated as a normal edit)
- **Select all**
- **Monospace toggle** — preference persists in `localStorage`
- **Active device counter** in the header (click to see device list)
- **Typing glow** on the editor while someone else is typing

### Templates

A `📝 Templates` tool inserts a starter into the current note. If the note is not empty, you are asked whether to **Replace**, **Append**, or **Cancel**.

Built-in templates:

- Blank note
- Checklist
- Meeting notes
- Quick links
- Troubleshooting notes
- Daily plan
- Email draft

Templates are disabled in read-only and locked editing modes. Inserting a template behaves like any other edit — it broadcasts live and saves to the DB on the normal debounce.

### Markdown preview

A `👁` button in the header toggles a read-only preview pane. The note content remains plain text in the database — preview is rendered client-side only.

Supported:

- Headings, **bold**, *italic*, `inline code`
- Fenced ```code blocks```
- Unordered, ordered, and GFM checklist lists
- Links (only `http://`, `https://`, `mailto:`)
- Blockquotes, horizontal rules
- Hard line breaks (two trailing spaces)

**Safety:** The renderer escapes all text first and then re-introduces a strictly limited set of safe HTML constructs. Raw HTML in the source is never passed through. No external library is used.

**Limitation:** Preview is display-only. Editing happens in Write mode.

### Checklist mode

In Markdown preview, lines like `- [ ] task` render as clickable checkboxes. Clicking a checkbox edits the underlying plain text (`[ ]` ↔ `[x]`) and syncs / saves like any other edit. Checkboxes are disabled in read-only and locked editing modes.

### Better conflict options

The "Remote update available" notice now offers four actions:

- **Apply** — replace the local note with the pending remote content
- **Keep mine** — discard the remote update
- **Copy remote** — copy the remote content to clipboard (so you can merge by hand)
- **Dismiss** — hide the notice but keep local content

There is no automatic merging. The goal is a clear human choice when two people type at once.

---

## PWA and Offline Behavior

The service worker **caches same-origin assets** (HTML, CSS, JS modules, icons) after the first visit. Subsequent visits can load the app shell from cache even without a network connection.

**Hard rules:**

- Any URL on a `*.supabase.co` / `.supabase.in` / `.supabase.io` host is **never cached**. This covers Realtime, REST, Auth, and Storage.
- Any cross-origin URL passes through without caching.
- Non-`GET` requests pass through untouched.
- Navigation requests under `/SyncPad/` fall back to cached `/SyncPad/index.html`.

**Important limitation:** The app loads two scripts from CDN at startup:

- `@supabase/supabase-js` from jsDelivr
- `qrcodejs` from jsDelivr

Cross-origin scripts are **not** cached by the service worker. If a user visits for the first time (or after clearing cache) while offline, the app will not start because these CDN scripts are unavailable. To make the app fully offline-capable, vendor those two scripts into `/assets/` and update the `<script>` tags in `index.html` plus the precache list in `service-worker.js`.

---

## Architecture: Two Sync Tracks

```
 You type            Broadcast lane           Other devices
 ─────────────────────────────────────────────────────────
 keystroke  →  encrypt (if enc) → broadcast  →  decrypt → show
              throttled ~250 ms                  (ephemeral, no DB write)

 1 s idle   →  encrypt (if enc) → saveContent → DB       →  subscribeToRoom
              debounced 1000 ms                            → decrypt → show
```

**Conflict resolution:** If you are actively typing (< 3 s since last keystroke) when a remote update arrives, it is queued and the four-button "Remote update available" notice appears. When you are idle, remote updates are applied automatically.

---

## Text Encryption Details

| Detail | Value |
|---|---|
| Algorithm | AES-GCM 256-bit |
| Key derivation | PBKDF2, 200 000 iterations, SHA-256 |
| Salt | 32 random bytes, hex-encoded, stored in DB (not secret) |
| IV | 12 random bytes, prepended to each ciphertext |
| Broadcast | Content is encrypted before sending — no plaintext over Supabase Realtime |

The passphrase never leaves your browser. Supabase stores only ciphertext for note text.
Passphrases, derived keys, and decrypted note text are **never** written to the console.

**Files are not encrypted in v1.** Existing file attachments remain normal Supabase Storage objects with signed download links. New uploads are blocked while text encryption is enabled so the app does not imply file encryption it does not provide.

---

## View-Once Flow

1. Creator sets view-once in Settings.
2. Creator shares the editable room link.
3. The first non-creator **editable** visitor opens the link.
4. The app decrypts and **displays** the content.
5. The app then clears the durable DB content and sets `viewed = true`.
6. All other connected clients receive the change and clear their editors.
7. The consuming viewer keeps the note visible locally with a clear toast:
   *"This was a view-once note. It has been cleared from the server, but remains visible on this device until you leave."*

The creator (identified by `created_by_device` in the DB, persistent across refreshes) never consumes their own view-once note. Read-only links also do **not** consume view-once notes. View-once is a normal-app workflow, not a guaranteed burn-after-reading security boundary, because direct backend access could bypass the frontend consume step.

---

## File Deletion Order

Files are deleted from **Storage first**, then metadata. If Storage removal fails, the operation aborts and the file remains accessible. If metadata removal fails *after* Storage succeeded, a specific warning is surfaced ("File removed from storage but metadata cleanup failed"). This prevents silent orphaned objects.

`ON DELETE CASCADE` on `syncpad_files` removes metadata rows when a room row is deleted from `syncpad_rooms`. It does **not** remove physical files from the `syncpad-files` Storage bucket.

---

## Room cleanup and storage cleanup

Expired rooms now have a backend cleanup path in `supabase-setup.sql`:

- `public.cleanup_expired_syncpad_rooms()` clears expired unencrypted rooms in place.
- Expired encrypted rooms are deleted instead of cleared, because the database cannot create an encrypted empty note without the user's passphrase.
- If `pg_cron` is enabled before running the setup script, the script schedules `syncpad-expired-room-cleanup` to run every 10 minutes.
- If `pg_cron` is not enabled, the function is still created and you can run it manually:

```sql
select * from public.cleanup_expired_syncpad_rooms();
```

This cleanup is only for expiration. Inactive non-expired rooms can still accumulate over time. Sample inactive-room cleanup queries remain at the bottom of `supabase-setup.sql`.

`ON DELETE CASCADE` on `syncpad_files` removes metadata rows when a room row is deleted from `syncpad_rooms`. It does **not** reliably remove physical files from the `syncpad-files` Storage bucket. Use the Storage admin UI or a service-role Edge Function if you need physical Storage cleanup.

---

## Project Structure

```
SyncPad/
├── index.html              # Single-page app shell
├── 404.html                # GitHub Pages SPA routing fallback (preserves ?query)
├── manifest.json           # PWA manifest
├── service-worker.js       # Offline cache + update prompt
├── supabase-setup.sql      # Idempotent DB + storage setup
├── README.md
├── DEPLOYMENT.md            # Step-by-step Supabase + GitHub Pages deployment guide
├── styles/
│   └── style.css
├── src/
│   ├── app.js              # Bootstrap, routing, event wiring
│   ├── ui.js               # All DOM manipulation
│   ├── sync.js             # Broadcast + DB sync coordination
│   ├── rooms.js            # Supabase room CRUD
│   ├── live-broadcast.js   # Supabase Broadcast (live typing)
│   ├── presence.js         # Supabase Presence (device list)
│   ├── files.js            # File upload / download / delete
│   ├── settings.js         # Passcode, encryption, expiration, view-once, lock
│   ├── encryption.js       # AES-256-GCM + PBKDF2 (Web Crypto API)
│   ├── offline.js          # Draft persistence (localStorage)
│   ├── permissions.js      # canEdit / canChangeSettings / etc.
│   ├── markdown.js         # Safe Markdown renderer + checklist toggle
│   ├── templates.js        # Built-in note templates
│   ├── supabase.js         # Supabase client singleton
│   └── utils.js            # Shared helpers (incl. buildRoomUrl, getUrlMode)
└── assets/
    ├── icon-192.png
    └── icon-512.png
```

---

## Testing checklist

### Routing

- [ ] `/SyncPad/` creates a random room.
- [ ] `/SyncPad/test-room` creates or joins `test-room`.
- [ ] `/SyncPad/test-room?mode=read` opens in read-only.
- [ ] Refreshing a read-only URL stays in read-only.

### Core sync

- [ ] Live typing works between two browser windows.
- [ ] Database save debounce still works (no DB write while typing fast).
- [ ] No cursor jumping during remote updates.
- [ ] No save loops.
- [ ] No console errors.

### Text encryption

- [ ] Encrypted live typing works **immediately** after enabling encryption (no reload).
- [ ] Disabling encryption works immediately without reload.
- [ ] Remote enabling encryption shows the "encrypted, reload to unlock" banner instead of ciphertext.
- [ ] Plaintext is never logged.

### View-once

- [ ] First non-creator viewer sees the note.
- [ ] Server clears durable content after view-once is consumed.
- [ ] The consuming viewer's editor stays populated with a clear toast.
- [ ] Other clients clear normally.
- [ ] No repeated clear loops.

### Read-only mode

- [ ] Can view, copy, and download the note.
- [ ] Cannot type, paste, import, or insert templates.
- [ ] Cannot clear, change settings, or upload / delete files.
- [ ] Still receives live updates.

### Room lock

- [ ] Enabling lock on one device locks all others immediately.
- [ ] Locked clients cannot edit, paste, import, template, or clear.
- [ ] Unlocking restores editing.
- [ ] Lock state survives refresh.
- [ ] Toggling the lock does not rewrite note content.

### Share modal

- [ ] Editable link copies correctly.
- [ ] Read-only link copies correctly.
- [ ] Both QR codes display and download.
- [ ] Passcode warning appears when a passcode is set.
- [ ] Text encryption warning appears when encryption is enabled.
- [ ] Send-to-phone steps are visible.

### Tools

- [ ] Copy link, download `.txt`, import `.txt`, timestamp, select all, monospace all work.
- [ ] Monospace preference persists in `localStorage`.
- [ ] Active device counter updates as devices connect / disconnect.
- [ ] Tools respect read-only and lock mode.

### Templates

- [ ] Each template inserts the expected starter text.
- [ ] Non-empty note prompts Replace / Append / Cancel.
- [ ] Template insert syncs and saves.
- [ ] Templates are disabled in read-only / locked mode.

### Markdown

- [ ] Write / Preview toggle works.
- [ ] Headings, lists, code, links, checklists render correctly.
- [ ] Plain text remains the saved source (no HTML in DB).
- [ ] No XSS from `<script>`, `<img onerror>`, `javascript:` links, etc.

### Checklist mode

- [ ] Checkboxes render in preview.
- [ ] Clicking a checkbox updates plain text and syncs to other devices.
- [ ] Disabled in read-only / locked mode.

### Conflict

- [ ] Notice appears during simultaneous typing.
- [ ] Apply, Keep mine, Copy remote, and Dismiss all work as expected.
- [ ] No save loops.

### Files

- [ ] Upload, download, and delete all work.
- [ ] Other clients see file changes without refresh.
- [ ] File actions do not trigger note saves.

### PWA

- [ ] App still loads from `/SyncPad/`.
- [ ] Refreshing `/SyncPad/test-room` works.
- [ ] After a deploy, the SW update bar appears and reloads cleanly once clicked.
- [ ] Supabase requests bypass the service worker cache.
- [ ] No service worker console errors.

---

## Known limitations / skipped features

- **Read-only mode is a frontend convenience, not a security boundary.** Anyone with the public anon key can call the backend directly. Server-side enforcement would need per-room tokens and is intentionally out of scope.
- **Room lock is intentionally UI-only in v1.** It coordinates normal SyncPad clients, but it is not a backend enforcement policy.
- **Text encryption does not encrypt files.** New file uploads are blocked when text encryption is enabled, but existing files remain regular Supabase Storage objects.
- **Markdown is plain text in the database.** Preview is client-side only — there is no rich-text editor.
- **Inactive non-expired rooms are not auto-deleted.** Expired rooms have a cleanup function and optional pg_cron schedule, but general inactive-room retention is still a manual maintenance decision.
- **Physical Storage files are not removed by `ON DELETE CASCADE`.** Only `syncpad_files` metadata rows are removed. Storage cleanup is a separate job.
- **CDN scripts (Supabase JS, qrcodejs) are not cached** by the service worker. First load needs a network. Vendor them locally if full offline support is required.
- **No history / versions.** SyncPad is a live notepad, not a document store. Use Download `.txt` for snapshots.

---

## License

MIT
