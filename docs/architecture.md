# SyncPad Architecture

SyncPad is a vanilla-JS realtime notepad built on Supabase with no build step. There is no bundler, no framework, and no compilation phase — the browser loads ES modules directly from disk.

---

## 1. High-Level Architecture Diagram

```
Browser (HTML + CSS + ES Modules)
    ├── index.html               — shell, Supabase config, screen containers
    ├── service-worker.js        — network-first PWA cache
    └── src/*.js                 — ES modules (no bundler)
            ├── app.js           — router, event wiring, global state
            ├── ui.js            — all DOM manipulation
            ├── sync.js          — dual-track sync (Broadcast + Postgres)
            ├── presence.js      — device list, typing indicator, cursor line
            ├── live-broadcast.js — Supabase Broadcast event dispatch
            ├── files.js         — upload, signed-URL cache, delete
            ├── file-preview.js  — in-app preview modal
            ├── markdown.js      — safe custom renderer
            ├── encryption.js    — AES-256-GCM + PBKDF2
            ├── permissions.js   — frontend permission context
            ├── settings.js      — room settings handlers
            ├── templates.js     — built-in + custom templates
            ├── theme.js         — CSS variable theme system
            ├── shortcuts.js     — keyboard shortcut handler
            ├── admin.js         — admin dashboard (Supabase Auth)
            └── utils.js / icons.js / supabase.js — helpers

Supabase
    ├── syncpad_rooms       (Postgres + Realtime)
    ├── syncpad_files       (Postgres + Realtime)
    ├── syncpad_share_links (Postgres)
    ├── syncpad_room_reports (Postgres)
    └── syncpad-files       (Storage bucket, private, signed URLs)
```

---

## 2. Module Responsibilities

### `app.js`
The application entry point and central coordinator. It owns the URL router, wires all cross-module event listeners, and holds the canonical module-level state variables (see §5). It does NOT perform DOM manipulation directly — all rendering is delegated to `ui.js`.

### `ui.js`
Contains every function that reads from or writes to the DOM. All `document.querySelector`, `innerHTML`, `classList`, and event-listener registrations for UI elements live here. It does NOT contain business logic, network calls, or application state.

### `sync.js`
Implements the dual-track synchronisation strategy (Broadcast lane + Durable lane). It decides when to write to Postgres (1 s debounce), handles incoming Realtime events from other tabs, and performs conflict detection. It does NOT directly manage WebSocket subscription lifecycle — that is coordinated through `live-broadcast.js` and Supabase's Realtime client.

### `presence.js`
Tracks which devices are currently in the room and renders the device list, typing indicator, and cursor-line highlight. It consumes Supabase Presence events to maintain a live roster. It does NOT persist presence data to the database — presence state is ephemeral and lives only in the Realtime channel.

### `live-broadcast.js`
Provides a thin abstraction over Supabase Broadcast channels. It dispatches outbound broadcast events and registers listeners that other modules subscribe to. It does NOT implement any sync logic itself — it is purely a transport layer for the Broadcast lane.

### `files.js`
Handles file upload to the `syncpad-files` Storage bucket, maintains the signed-URL cache (`_urlCache`, 55-min TTL), and implements file deletion. It does NOT render file previews — that responsibility belongs to `file-preview.js`.

### `file-preview.js`
Renders the in-app preview modal for attached files (images, PDFs, text, etc.). It requests signed URLs from `files.js` and inserts the appropriate preview element into the modal. It does NOT manage the file list or interact with Storage directly.

### `markdown.js`
Implements a safe, custom Markdown renderer without relying on an external library. It sanitises output to prevent XSS and applies SyncPad-specific rendering rules. It does NOT handle editing or preview toggling — those are managed by `app.js` and `ui.js`.

### `encryption.js`
Provides AES-256-GCM encryption and decryption using the Web Crypto API, with PBKDF2 key derivation. It exposes functions to encrypt/decrypt room content given a passphrase and salt. It does NOT store keys or passphrases — key material is held in `app.js` module-level state and never written to disk or the database.

### `permissions.js`
Maintains the frontend permission context for the current session (e.g. read-only vs. read-write, owner status). It exposes getter functions used throughout the app to gate UI actions. It does NOT enforce permissions on the server; SyncPad intentionally keeps normal room/file RLS broad for a transparent demo project.

### `settings.js`
Implements handlers for the room settings panel: expiry presets, passcode changes, read-only toggles, and share-link management. It does NOT own the settings UI structure — the DOM is defined in `ui.js` and `index.html`.

### `templates.js`
Manages the 13 built-in templates and any custom templates persisted in `localStorage` under the key `syncpad_custom_templates`. It exposes `exportCustomTemplates()` and `importCustomTemplates(json)`, and enforces the `BODY_MAX = 50,000` character limit. It does NOT render the template picker UI — that is handled by `ui.js`.

### `theme.js`
Applies and persists the active theme by writing to the `data-theme` attribute on `<html>`, which triggers CSS custom-property cascades defined in `styles/base.css`. It does NOT contain any CSS itself — all theme colours and transition rules live in the stylesheet.

### `shortcuts.js`
Registers global `keydown` listeners and maps key combinations to application actions (formatting, navigation, search, etc.). It does NOT implement the actions themselves — it calls into `app.js` or `ui.js` functions.

### `admin.js`
Implements the `/admin` dashboard: Supabase Auth sign-in, RLS-gated admin queries, and the three admin tabs (Rooms, Reports, Cleanup). It calls the `run_cleanup_expired_syncpad_rooms_as_admin` RPC for the Cleanup tab. It does NOT share any state or logic with the regular room flow — it is a self-contained screen activated only on the `/admin` route.

### `utils.js`
Collects small, stateless helper functions (string formatting, date utilities, debounce, etc.) used across multiple modules. It does NOT import from any other SyncPad module — it is a pure utility leaf with no side effects.

---

## 3. Data Flow — Editing a Note

1. **User types** in the `<textarea>` inside the editor screen.
2. An `input` event fires, handled in `app.js` via `wireEvents()`.
3. `app.js` immediately calls `sync.js` → **Broadcast lane**: the current textarea value is published on the Supabase Broadcast channel for the room (~250 ms latency). No database write occurs.
4. **Other tabs/devices** receive the Broadcast event via `live-broadcast.js`, which dispatches it to `sync.js` on the receiving side.
5. `sync.js` (receiver) calls `ui.js` to update the textarea with the incoming content, carefully avoiding a cursor-jump for the local user.
6. Back on the **originating tab**, a 1-second debounce timer is (re)started on every keystroke.
7. When the debounce fires, `sync.js` → **Durable lane**: the content is written to the `syncpad_rooms` row in Postgres (encrypted if text encryption is enabled).
8. Supabase **Postgres Realtime** fires an `UPDATE` event on all other subscribers.
9. `sync.js` (receiver, durable lane) receives the Realtime event and performs a **conflict check**: if the incoming `updated_at` timestamp is older than the local last-save timestamp, the update is discarded to avoid overwriting a more recent local edit.
10. If the conflict check passes, `ui.js` updates the textarea on the remote tab.

---

## 4. Data Flow — Joining a Room

1. The browser loads `index.html`; `app.js` reads `window.location`.
2. The **router** in `app.js` parses the URL path to extract the room ID (e.g. `/r/<roomId>`).
3. `app.js` calls **`joinRoom(roomId)`**.
4. `joinRoom()` issues a Supabase query against `syncpad_rooms` for the given ID.
5. If the room has a passcode, `ui.js` renders the passcode prompt and verifies a PBKDF2 hash client-side. If the room has text encryption, the submitted passphrase is passed to `encryption.js` to derive `_encKey` and `_encSalt`, which are stored in `app.js` module-level state.
6. `permissions.js` is updated with the resolved permission context (owner, read-only, anonymous, etc.).
7. `app.js` calls **`wireEvents()`** to attach all editor, toolbar, and settings event listeners for this room session.
8. Three Supabase subscriptions are started:
   - **Realtime** on `syncpad_rooms` (durable sync lane)
   - **Presence** channel (device roster and typing indicator)
   - **Broadcast** channel (live typing lane, via `live-broadcast.js`)
9. `ui.js` renders the editor screen, populates the textarea with the room's current content (decrypted if needed), and shows the presence device list.

---

## 5. State Management

`app.js` holds all module-level state in file-scoped `let` variables. No global `window` properties are used for application state.

| Variable | Purpose |
|---|---|
| `_roomId` | Active room identifier |
| `_room` | Full room row object fetched from Supabase |
| `_encKey` | Derived AES-256-GCM CryptoKey (null if unencrypted) |
| `_encSalt` | PBKDF2 salt for the current encryption passphrase |
| `_markdownMode` | Boolean — whether Markdown rendering is enabled |
| `_showPreview` | Boolean — whether the Markdown preview pane is visible |
| `_expPreset` | Selected expiry preset string |
| `_expTimer` | Handle for the expiry countdown interval |
| `_searchMatches` | Array of match positions for the current search query |
| `_searchIndex` | Index of the currently highlighted search match |

**Critical invariant**: every variable in this table must be explicitly reset in both `navigateToRoom()` and `leaveRoom()`. Failing to reset any variable can cause state bleed between room sessions (e.g. a stale encryption key being applied to an unencrypted room).

---

## 6. Sync Tracks

SyncPad uses two parallel synchronisation tracks to balance perceived latency against durability.

### Broadcast Lane (live typing)
- **Transport**: Supabase Broadcast channel (WebSocket message, no DB write)
- **Latency**: ~250 ms
- **Use case**: Propagating keystrokes in real time so collaborators see typing as it happens
- **Durability**: None — if a tab is offline or joins after a broadcast, the message is lost
- **Implementation**: `sync.js` sends via `live-broadcast.js`; receivers update `ui.js` directly

### Durable Lane (persistence)
- **Transport**: 1-second debounce → `UPDATE` on `syncpad_rooms` in Postgres → Supabase Realtime fires on all subscribers
- **Latency**: 1 s debounce + Realtime propagation (~100–300 ms)
- **Use case**: Persisting the authoritative room content and propagating it to tabs that may have missed broadcast events
- **Durability**: Full — content survives page refreshes, reconnections, and new joiners
- **Conflict detection**: Receiver compares incoming `updated_at` against local last-save timestamp; stale updates are discarded

---

## 7. Signed URL Cache

Supabase Storage signed URLs are expensive to generate (one HTTPS round-trip each) and expire after a fixed window. `files.js` maintains:

```js
const _urlCache = new Map(); // fileId → { url, expiresAt }
```

- **TTL**: 55 minutes (conservative margin below Supabase's 60-minute signed-URL lifetime)
- **Cache hit**: The cached URL is returned immediately with no API call
- **Cache miss**: A new signed URL is fetched from Supabase Storage and stored with a fresh `expiresAt = Date.now() + 55 * 60 * 1000`
- **Cache eviction**: Entries are removed immediately on `deleteFile()` to prevent returning URLs for deleted objects
- **Benefit**: Eliminates redundant API calls when the same file is previewed or linked multiple times within a session

---

## 8. Templates System

### Built-in Templates
- 13 entries hardcoded in `templates.js`
- Each entry has the shape `{ label, desc, body }`
- Read-only — users cannot modify or delete built-in templates

### Custom Templates
- Stored in `localStorage` under the key `syncpad_custom_templates` as a JSON array
- Subject to a body character limit: `BODY_MAX = 50,000` chars per template
- **Export**: `exportCustomTemplates()` returns a JSON string of all custom templates, suitable for download or clipboard copy
- **Import**: `importCustomTemplates(json)` parses the JSON string, validates entries, merges them into the stored list, and returns the count of successfully imported templates, or `-1` on parse/validation error

---

## 9. Admin Dashboard

The `/admin` route activates `admin.js` exclusively and is completely isolated from the regular room flow.

### Authentication
- `initAdmin()` is called by the router
- Renders a sign-in form; on submit, calls `supabase.auth.signInWithPassword()`
- Supabase RLS policies enforce the `is_syncpad_admin()` predicate on all admin queries — unauthenticated or non-admin sessions receive empty result sets or errors

### Tabs

| Tab | Data source | Actions |
|---|---|---|
| **Rooms** | 50 most recent `syncpad_rooms` rows; client-side search filter; flag badges for reported rooms | Clear content, Delete room |
| **Reports** | 100 most recent `syncpad_room_reports` rows | Dismiss report, Delete reported room |
| **Cleanup** | — | Remove known Storage objects in admin deletion paths, then invoke/delete via Supabase |

The optional `supabase/functions/syncpad-cleanup` Edge Function runs with a service-role key, deletes known Storage objects for encrypted expired rooms before DB cleanup, and can remove orphaned bucket objects after a dry run. It's callable both as a backend cron/curl job (`SYNCPAD_CLEANUP_SECRET`) and directly from the admin dashboard's Cleanup tab, authenticated with the admin's own Supabase session instead.

---

## 10. PWA / Service Worker

`service-worker.js` implements a **network-first** caching strategy for all same-origin assets.

- **Cache name**: `syncpad-v9`
- **Strategy**: Every request is attempted over the network first. On success, the response is cloned and stored in the cache. On network failure, the cache is used as a fallback.
- **Bypass**: All requests to Supabase endpoints (different origin) bypass the service worker entirely and go directly to the network.
- **Cache invalidation**: Increment `CACHE_NAME` (e.g. `syncpad-v9`) to force all clients to discard the old cache on next activation.

---

## 11. CSS Architecture

Styles are split across several plain CSS files under `styles/`, loaded via ordered `<link>` tags in `index.html` (later files override earlier ones at equal specificity, mirroring the original single style.css's rule order): `base.css` (theme variables, reset, loading screen) → `landing.css` → `app-shell.css` (header) → `editor.css` → `panels.css` (side panels) → `modals.css` → `file-preview.css` → `room-tools.css`. `admin.css` is lazy-loaded by `admin.js` only on the `/admin` route. There is no preprocessor, no CSS-in-JS, no utility framework, and no build/bundling step — every file is served as-is.

### Theming
- Themes are defined as sets of CSS custom properties (`--color-bg`, `--color-text`, etc.) scoped to `[data-theme="<name>"]` selectors on `<html>`
- `theme.js` switches the active theme by writing `document.documentElement.dataset.theme = themeName`
- The chosen theme is persisted in `localStorage` and restored on page load

### Available Themes
| Theme key | Description |
|---|---|
| `charcoal-amber` | Dark charcoal background with amber accent (default) |
| `midnight-blue` | Deep navy tones with blue highlights |
| `forest-green` | Dark green palette |
| `paper-light` | Light parchment — the only light theme |
| `terminal` | High-contrast black with green monospace aesthetic |

### Transitions
Theme switches animate smoothly, but only on appropriate elements to avoid janky flashes on interactive controls:

- **Animated** (0.22 s ease): `body`, panels, modals — `background-color` only
- **NOT animated**: buttons — instant colour change to preserve click responsiveness
