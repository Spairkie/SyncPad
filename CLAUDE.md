# CLAUDE.md — SyncPad Development Guide

This file is a reference for AI coding assistants (Claude Code) working on the SyncPad codebase.

---

## 1. Project Overview

SyncPad is a vanilla-JavaScript realtime shared notepad built on Supabase. It has no build step, no bundler, and no framework — ES modules load directly in the browser. Features include live collaborative editing (Supabase Broadcast), durable saves to Postgres, per-room encryption (AES-256-GCM), file uploads with signed-URL caching, Markdown preview, 13 built-in templates plus user-defined custom templates, seven visual themes, presence tracking (devices/cursors/typing indicators), room settings (passcode, expiry, lock), and an admin dashboard backed by Supabase Auth and RLS.

---

## 2. Setup & Running Locally

**Serve the app (port 5555):**
```
npm run serve
```

**Install Playwright browsers (first time only):**
```
npx playwright install
```

**Run the full test suite:**
```
npm test
```

Supabase credentials are injected into `index.html` as `window.SYNCPAD_CONFIG`. No `.env` file or build step is required — just serve and open.

---

## 3. Architecture Overview

### Module Responsibilities

| File | Responsibility |
|---|---|
| `src/app.js` | Client-side routing, event wiring, global state coordination |
| `src/ui.js` | All DOM manipulation — `showConfirm()`, `openTemplatesModal()`, `renderFilesList()`, `renderDevicesList()`, etc. |
| `src/sync.js` | Live typing via Supabase Broadcast + durable save to Postgres (1 s debounce) |
| `src/presence.js` | Device tracking, typing indicators, cursor position broadcasting |
| `src/live-broadcast.js` | Low-level Supabase Broadcast event wiring |
| `src/files.js` | File upload, download, delete, and 55-min signed-URL cache |
| `src/file-preview.js` | In-app preview modal for images, text, CSV, Markdown, and PDF |
| `src/markdown.js` | Safe custom Markdown renderer — no raw HTML pass-through |
| `src/encryption.js` | AES-256-GCM encryption + PBKDF2 key derivation (Web Crypto API) |
| `src/permissions.js` | Frontend permission context — `isReadOnly`, `isOwner`, `isLocked` |
| `src/settings.js` | Room settings handlers — passcode, expiry, lock |
| `src/templates.js` | 13 built-in templates + localStorage custom templates; `BODY_MAX = 50000` |
| `src/theme.js` | CSS variable theme system — 7 themes, toggled via `data-theme` on `<html>` |
| `src/shortcuts.js` | Keyboard shortcut handler |
| `src/admin.js` | Admin dashboard — Supabase Auth (`signInWithPassword`), RLS via `is_syncpad_admin()` |
| `src/utils.js` | `escapeHtml()`, `formatFileSize()`, `countWords()` |
| `src/icons.js` | SVG icon strings |
| `src/supabase.js` | Supabase client initialisation |

### Data Flow

1. `app.js` detects route changes and calls module init functions.
2. `sync.js` subscribes to a Broadcast channel for the current room; on local edits it broadcasts immediately and queues a 1 s debounced Postgres write.
3. `presence.js` tracks connected devices and cursor/typing state via a separate Broadcast channel.
4. `permissions.js` is populated from the room row after load; all UI branches that gate actions must consult it.
5. `ui.js` is the single place that touches the DOM — other modules call `UI.*` functions instead of querying or mutating the DOM directly.
6. `encryption.js` wraps/unwraps content before it reaches the network or the editor; the key and salt are kept in module-level variables and cleared on navigation.

---

## 4. Key Patterns & Conventions

### DOM Manipulation
All DOM writes go through `src/ui.js`. Never manipulate the DOM from `sync.js`, `files.js`, or any other module directly — call or add a function in `ui.js` instead.

### State Management
Room-scoped state lives in module-level variables. Every variable that is room-specific **must** be reset to `null` (or an empty structure) when navigating away from a room. Variables that require this treatment include `_roomId`, `_encKey`, `_encSalt`, `_markdownMode`, `_showPreview`, `_expPreset`, `_expTimer`, `_searchMatches`, and `_searchIndex`.

### Escaping User Content
Any user-supplied string that is interpolated into an HTML template **must** be passed through `escapeHtml()` from `src/utils.js` first. Never trust room names, file names, note bodies, or any other user content without escaping.

```js
import { escapeHtml } from './utils.js';
el.innerHTML = `<span>${escapeHtml(userValue)}</span>`;
```

### Confirm Dialogs
Never call `window.confirm()`. Use the custom async dialog instead:

```js
const ok = await UI.showConfirm('Are you sure?', {
  confirmLabel: 'Delete',
  cancelLabel: 'Cancel',
  danger: true,   // focuses Cancel by default; use for destructive actions
});
if (!ok) return;
```

### Imports
There is no bundler. Use standard ES module `import`/`export` syntax. Paths must be relative (e.g., `'./utils.js'`). Do not use bare specifiers.

### BASE Path
The app is served under `/SyncPad`. This constant is defined in `src/app.js` and `service-worker.js`. Any new route or asset reference must respect this prefix.

### Supabase Credentials
Credentials are read from `window.SYNCPAD_CONFIG` which is injected inline in `index.html`. Do not hard-code keys anywhere else.

### Theme Transitions
Transitions for background-color (0.22 s ease) are applied to `body`, panels, and modals. Do **not** add CSS transitions to buttons — this would clobber interaction feedback (hover/active states).

---

## 5. Common Gotchas

- **`wireEvents()` accumulates listeners.** If called more than once (e.g., on re-navigation) it registers duplicate listeners. Guard calls with a cleanup flag or ensure it is called exactly once per page lifecycle.

- **Room state must be fully reset on navigation.** When leaving a room, reset `_roomId`, `_encKey`, `_encSalt`, `_markdownMode`, `_showPreview`, `_expPreset`, `_expTimer`, `_searchMatches`, and `_searchIndex` to `null` (or empty). Stale state causes subtle bugs that are hard to reproduce.

- **Signed-URL cache eviction.** `src/files.js` caches signed URLs in a `Map` with a 55-minute TTL. When a file is deleted, call the eviction helper so the stale URL is not served to subsequent requests.

- **Expiration minimum is 1 second.** `_buildExpirationDuration()` only requires a positive number (`n > 0`, enforced client-side via the input's `min="1"`) — there is no artificial floor beyond that. A 1-second custom expiry is a legitimate (if aggressive) choice; it is not validated further.

- **Bulk file delete requires `danger: true`.** Pass `{ danger: true }` to `showConfirm()` so that Cancel is focused by default, protecting users from accidental mass deletion.

- **Read-only share links with passcode/encryption.** A read-only visitor to a passcode-protected or encrypted room still sees the normal authentication screen (passcode/encryption prompt) and must pass it to view the room — the info screen is only shown when the room/share link itself doesn't exist. Passing the gate does not grant edit access on a forced-read-only route (`?mode=read`, `/share/:token`) — those stay read-only regardless.

- **`room_id` alone is a sufficient write credential; `?mode=read` and `/share/:token` are a UI/UX convention, not a server-enforced boundary.** A plain room link (typed, bookmarked, or shared) is directly editable — visiting a URL for a room that doesn't exist yet creates it, same as the landing page's Create Room button (see `joinRoom()`'s not-found fallback in `app.js`). `?mode=read` and `/share/:token` discourage editing in the app's own UI but don't stop a technical visitor from writing directly, since they necessarily learn `room_id` from viewing the room's content. For a genuine, server-enforced "nobody can edit this" guarantee, use the room lock feature (`editing_locked`) — it's enforced by a Postgres trigger regardless of how the write is attempted. See `supabase/migrations/0009_revert_edit_token_write_gating.sql` for the reasoning (this reverted an earlier edit-token requirement that turned out to cost more in lost-access lockouts and deployment fragility than it was worth for a project not meant to hold sensitive data).

- **Admin route uses Supabase Auth.** The admin dashboard authenticates via `signInWithPassword` and relies on the `is_syncpad_admin()` RLS function. Anonymous users must not be able to reach admin data even if they manipulate the client.

---

## 6. Adding New Features — Checklist

Work through this list for every new feature or non-trivial change:

- [ ] **DOM changes go in `ui.js`.** Add or modify a function in `src/ui.js` rather than reaching into the DOM from another module.
- [ ] **Escape all user content.** Every user-supplied value rendered into HTML must pass through `escapeHtml()`.
- [ ] **Use `showConfirm()`, not `window.confirm()`.** Any destructive or confirmation flow uses the async custom dialog. Add `danger: true` for irreversible actions.
- [ ] **Guard `wireEvents()`.** If your feature calls `wireEvents()` or attaches listeners, ensure they cannot accumulate across navigations.
- [ ] **Reset state on nav.** If you introduce new room-scoped module variables, add them to the navigation cleanup path in `app.js`.
- [ ] **Respect permissions.** Gate any write or destructive action behind the relevant flag from `src/permissions.js` (`isReadOnly`, `isOwner`, `isLocked`).
- [ ] **Respect `BODY_MAX`.** Content written to the editor must not silently exceed the 50,000-character limit defined in `src/templates.js`.
- [ ] **Evict caches on delete.** If your feature deletes a resource that is cached (e.g., a signed URL), evict the cache entry immediately.
- [ ] **No raw HTML in the Markdown renderer.** `src/markdown.js` intentionally strips raw HTML. Do not add a pass-through — use structured renderer output instead.
- [ ] **Write a Playwright test.** Every user-visible feature should have at least one end-to-end test in `tests/`.

---

## 7. Testing Guidance

Tests live in `tests/` and run with `npm test`. `playwright.config.js` defines four browser projects — `chromium`, `firefox`, `webkit`, and `mobile-chrome` — but only `chromium` is active by default so `npm test` works without a full Playwright browser download; the other three are present but commented out. Uncomment them locally if you have the full browser set installed (`npx playwright install`).

### Test Helpers (`tests/helpers.js`)

| Helper | Purpose |
|---|---|
| `createRoom(page)` | Navigate to landing and create a new room; returns the room URL |
| `goToLanding(page)` | Navigate to the SyncPad landing page |
| `typeInEditor(page, text)` | Type text into the main editor |
| `getEditorContent(page)` | Return the current editor text content |
| `openPanel(page, name)` | Open a named side panel (e.g., `'files'`, `'settings'`) |
| `waitForToast(page, text)` | Wait for a toast notification containing the given text |
| `closePanels(page)` | Close all open side panels |
| `roomIdFromUrl(page)` | Extract the room ID from the current URL |

### Writing New Tests

1. Create a new file in `tests/` named after the feature (e.g., `tests/encryption.spec.js`).
2. Import helpers from `./helpers.js`.
3. Use `test.describe` to group related scenarios.
4. Keep each test focused on a single behaviour — prefer many small tests over one large flow.

### Testing Browser-Only Module Code (`inBrowser()`)

For logic in ES modules that uses browser APIs (Web Crypto, `localStorage`, etc.), use Playwright's `page.evaluate()` to import and exercise the module inside the browser context rather than mocking the APIs in Node:

```js
const result = await page.evaluate(async () => {
  const { someFunction } = await import('/SyncPad/src/utils.js');
  return someFunction('input');
});
```

This avoids the need for a separate Node-compatible build and keeps tests honest about real browser behaviour.

---

## 8. Git Workflow

### Branch Naming
Use the format `claude/<phase>-<description>`, e.g.:
```
claude/phase1-stability
claude/phase2-file-preview-fixes
```

### Commit Message Format
```
<type>(<scope>): <short imperative description>
```

**Types:** `feat`, `fix`, `refactor`, `test`, `chore`, `docs`

**Examples:**
```
feat(files): evict signed-URL cache on deleteFile
fix(sync): reset _roomId to null on room nav
refactor(ui): extract renderDevicesList from app.js
test(encryption): add Playwright tests for AES round-trip
chore(deps): update Playwright to 1.44
```

Keep commits atomic: one logical change per commit. Do not bundle unrelated fixes. Avoid committing directly to `main` — always work on a feature branch and open a PR.
