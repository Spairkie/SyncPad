# Changelog

All notable changes to SyncPad are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Phase 14 — Security/permission fixes, quarantine enforcement, admin bugs

Branch: `claude/repo-review-refactor-kba1k5`

Follow-up pass after a full-repo review (`app.js`, `ui.js`, `admin.js`, `index.html`/`service-worker.js`/`style.css` each read in full) surfaced several real bugs beyond the Phase 13 feature work.

#### Security
- **XSS via Presence `cursor_line`**: `renderDevicesList()` in `ui.js` interpolated `device.cursor_line` into `innerHTML` unescaped. `cursor_line` comes from Supabase Presence, settable by any connected peer with no server-side validation — a malicious peer could inject arbitrary HTML that rendered on every other connected device. Fixed with a `Number.isFinite()` type guard (its only legitimate shape) plus `escapeHtml()` as defense in depth.
- **Permission bypass on paste**: the strip-paste-formatting feature's `paste` listener on `#note-editor` mutated `editor.value` directly without checking `canPaste()`/`canEdit()`, so a read-only/locked/encrypted-without-key user with that preference enabled could still visibly paste and mutate the editor locally (the save itself was already blocked, but the UI wrongly behaved as editable).
- **Quarantine had no effect outside the admin dashboard**: `admin.js` fully implements room quarantine (RPCs, audit log, UI), but nothing in the regular app checked `room.quarantined_at`/`downloads_disabled` — a quarantined room stayed fully visible and editable to normal users. `joinRoom()` and the live room-state-transition handler now block/kick out of quarantined rooms with an info screen (before any passcode prompt, decryption attempt, or editor init); `downloads_disabled` now hides file preview/download actions.

#### Fixed
- **Toasts invisible behind the admin dashboard**: `#toast-container` (z-index 500) rendered behind `.auth-screen`/`#admin-screen` (z-index 900) — every toast shown while the admin dashboard was open (most admin actions, via `admin.js`'s own `_showToast` sharing the same container) was invisible. Bumped to z-index 1100.
- **Admin: deleting a room from the Reports tab didn't persist report status** — only an in-memory mutation, never a DB write. Reports stayed `status:'new'` forever, pointing at a deleted room, reappearing in the "New" filter/stat card. Moved the fix into `_deleteRoomAndStorage()` itself so all four delete call sites (bulk, drawer, Reports tab) are covered.
- **Admin: Reports tab "Load more" used a stale total** after switching filter chips (captured once in a closure param instead of a reassignable module-level variable, unlike the Rooms tab). Now mirrors the Rooms tab's `_roomsTotal` pattern via a new `_reportsTotal`.
- **Admin: Files tab "Load more" silently dropped an active search filter**, always re-rendering the full unfiltered set. Now re-applies the filter and does a full re-render after loading more.
- **Admin: quarantine RPC fallback allowed an empty reason** the RPC itself intentionally rejects server-side. Both paths now agree on a non-empty default.
- **`_expPreset` DOM desync across room navigation**: picking "Custom" expiry in one room left the settings panel visually showing Custom (with inputs open) in the next room, even though the underlying preset had reset to the default. Teardown now resyncs the DOM, not just the variable.
- **Dead code**: `ui.js`'s `setMonospace()` referenced a `#tool-monospace` element that doesn't exist anywhere in `index.html` (the real toggle, `#setting-monospace-btn`, is already handled separately in `app.js`) — removed the no-op branch.
- **Duplicate SW-update-bar/install-bar click handlers**: used `addEventListener(..., {once:true})`, which can still stack duplicate listeners if `showUpdateBar()`/`showInstallBar()` are called again before the first fires (`updatefound` can legitimately fire more than once per session). Switched to idempotent `.onclick` assignment.
- **Hardcoded hex colors bypassing the theme system**: admin dashboard badges/buttons/device-dot and the contact-form status colors used raw hex instead of `var(--green)/--yellow/--red)`, so they didn't adapt across all 7 themes.
- Stale docs: README/CLAUDE.md said "5 themes" (actual: 7, matching `theme.js`); README's release checklist referenced an old service-worker cache version.
- Minor markup cleanup: redundant inline `style="display:none"` alongside `class="hidden"`; an inline style moved to a CSS class.

#### Changed
- Service worker cache bumped to `syncpad-v18`.

---

### Phase 13 — Multi-file uploads, download filenames, PWA resume, Markdown features

Branch: `claude/repo-review-refactor-kba1k5`

#### Fixed
- **Download filename correctness**: `getForceDownloadUrl()` added to `files.js`, requesting the signed URL with Supabase Storage's `download: <filename>` option so the response carries a `Content-Disposition` header with the real uploaded filename. Previously the anchor `download` attribute was silently ignored by modern browsers for cross-origin URLs, so saved files were named after the internal `${timestamp}_${sanitizedName}` Storage path instead of what the uploader actually named them. Preview signed URLs (images, PDFs/SVGs opened in a new tab, fetched text/CSV/Markdown) are unaffected and remain inline.
- **Landing join input treated as a credential field**: `#landing-join-input` now sets `type="text"`, a non-generic `name`, `autocapitalize="off"`, `autocorrect="off"`, and `data-lpignore`/`data-1p-ignore`/`data-bwignore`/`data-form-type="other"` so password managers (LastPass, 1Password, Bitwarden, Dashlane) stop offering to save/autofill it and the browser stops remembering prior entries.

#### Added
- **Multi-file upload**: the file picker, upload-zone drop, panel-wide drop, and editor-area drop all now accept multiple files at once (`setFileHandlers` passes a `File[]` instead of a single `File`). Files upload sequentially with a "Uploading N of M…" progress indicator; a failure on one file doesn't abort the rest, and the final toast reports a success/failure summary.
- **PWA last-room resume**: launching the installed/standalone PWA now reopens the last editable room visited (tracked in `localStorage` as `syncpad_last_room_id`) instead of showing the landing screen. Deliberately navigating Home via the header logo sets a one-shot `sessionStorage` suppression flag so users can still reach the landing screen; a later fresh launch resumes normally. Regular browser tabs are unaffected — the landing screen still shows by default.
- **Markdown images**: `![alt](https://…)` renders an `<img>` in the preview, restricted to the same http/https-only scheme allowlist used for links (never `data:`/`javascript:`).
- **Markdown autolinking**: bare `https://…`/`http://…` URLs in prose are automatically turned into links, without touching URLs already inside code spans, existing `[text](url)` links, or `href`/`src` attribute values.
- **Markdown nested lists**: indented bullet/numbered sub-items now render as properly nested `<ul>`/`<ol>` elements (previously all indentation levels were flattened into one list).
- `tests/files.spec.js` — multi-file upload, bulk select/delete, and download-filename coverage.
- `tests/markdown.spec.js` — coverage for images, autolinking (including a regression test that plain tokens like "L2" are never corrupted), and nested lists.

#### Changed
- Service worker cache bumped to `syncpad-v17` (precached assets changed).

---

### Phase 12 — Stabilization: admin polish, retry button, new Playwright tests

Branch: `claude/festive-wright-sqhOL`

#### Fixed
- **Room load retry button**: `joinRoom()` now uses `UI.showLoadingError()` instead of a plain text message on failure. Shows a "Try again" button that re-triggers `joinRoom()` without a page reload. The loading spinner is hidden during error state and restored on retry.
- **Admin `confirm()` / `alert()` replaced**: all `window.confirm()` and `window.alert()` calls in `admin.js` removed. Replaced with async `_adminConfirm()` and `_adminAlert()` helpers that use themed modal dialogs consistent with the admin UI (inline CSS, no dependency on `ui.js`).
- **Admin delete: typed confirmation**: permanent room deletion now requires the user to type the room ID before the Delete button is enabled, preventing accidental mass deletion.
- **Admin reports: reviewed state**: the "Dismiss" button now sets `status = 'reviewed'` (was `dismissed`) and the action label is "✓ Review". The status badge mapping now distinguishes `reviewed` (green) from `dismissed` (muted).

#### Added
- **Admin refresh button**: a `↺` button in the admin header reloads both the stats row and the current tab without requiring a full page refresh.
- **Admin loading skeletons**: tab content now shows animated shimmer skeleton rows while data loads, replacing the plain "Loading…" text.
- **Admin access-denied Retry**: the access-denied error state now includes a "Retry" button that reloads the page.
- **`UI.showLoadingError(msg, onRetry)`**: new export in `ui.js`. Hides the loading spinner, shows the error message, and reveals a "Try again" button wired to the given callback.
- **Loading screen retry button**: `#loading-retry-btn` added to `index.html`; styled in `styles/style.css`.
- **New Playwright test files**:
  - `tests/admin.spec.js` — 6 tests for admin route rendering, login form validation, wrong-credential error, back button, and keyboard navigation
  - `tests/room-errors.spec.js` — 8 tests for room creation, direct-URL navigation, loading transition, join via ID input, multi-room nav, editor mode reset
  - `tests/read-only.spec.js` — 5 tests for read-only mode: editor disabled, input rejected, upload absent, indicator present, invalid token info screen
  - `tests/editor-modes.spec.js` — 7 tests for mode classes (`mode-write`, `mode-preview`, `mode-split`), pane visibility, aria-pressed correctness, preview rendering
  - `tests/export.spec.js` — 5 tests for empty-note export warning, txt download, and copy-to-clipboard empty warning

#### Changed
- **Admin badge**: added `admin-badge--reviewed` (green) variant to `styles/style.css`.
- **Admin skeleton CSS**: `@keyframes admin-shimmer`, `.admin-skeleton`, `.admin-skeleton-bar`, `.admin-skeleton-row` added to `styles/style.css`.
- **Admin refresh icon button**: `.admin-icon-btn` style added to `styles/style.css`.

---

### Phase 11 — Editor mode-class fix, authenticated RLS baseline, docs update

Branch: `claude/festive-wright-sqhOL`

#### Fixed
- **Editor layout bug**: `.editor-wrap` now uses an explicit `grid-template-columns: 1fr` default (single-pane) instead of `repeat(auto-fit, ...)`. The `auto-fit` approach could produce an unwanted second column on wide screens even when only one pane is visible, causing a phantom vertical divider in Write mode.
- **Mode class hygiene**: `setMarkdownMode()` in `ui.js` now removes all stale mode classes (`mode-write`, `mode-preview`, `mode-split`, `split-mode`) before adding the correct one, preventing any class leaking across navigation.
- **Teardown DOM reset**: `teardownRealtimeSession()` now calls `UI.setMarkdownMode('write', null)` immediately so the editor card has no stale `mode-split` class during the loading screen of the next room.
- **Admin sign-in breaks room creation**: after visiting `/admin` and signing in, the Supabase client holds an `authenticated` session. The existing policies only covered `anon`, causing `loadRoom` / `createRoom` / file operations to fail. Added idempotent `authenticated` baseline policies for `syncpad_rooms`, `syncpad_files`, and `storage.objects` that mirror the anon permissions.
- **`joinRoom` silent errors**: actual Supabase/RLS errors are now logged to the console via `console.error()` while the user-facing message stays simple.

#### Changed
- **Editor card max-width**: Write/Preview mode card capped at `900px` (was 1400px); Split mode expands to 1400px. This eliminates the "large empty box" feeling on wide desktops.
- **Split-mode CSS**: divider selector updated to `.editor-wrap.mode-split #note-editor`; old `.split-mode` kept as a fallback alias.
- **README roadmap**: completed items marked ✅; realistic near-term and future roadmap added.
- **DEPLOYMENT.md**: troubleshooting row added for the admin-session RLS bug; admin session/role section added to Security reminder.
- **docs/security.md**: new "Admin session and Supabase role" section explaining the `anon` → `authenticated` role transition and the baseline policy fix.

---

### Phase 10 — Missing test coverage (Phase 8 & 9 gaps)

Branch: `claude/festive-wright-sqhOL` · Commit: `test(phase-10): fill accessibility and file-sort test gaps`

#### Added
- `accessibility.spec.js`: 3 new tests — `#encryption-input` has `aria-label`, `#exp-custom-value` has `aria-label`, `#exp-custom-unit` has `aria-label`
- `settings.spec.js`: 3 new tests in a `File sort` describe block — sort dropdown visible, expected options present, default value is `"newest"`

---

### Sidequest — Editor UI Modernization

Branch: `claude/festive-wright-sqhOL` · Commit: `refactor(editor): floating card layout, height fix, split divider, readable max-width`

#### Fixed
- **Outer gap**: `.editor-wrap` now uses `margin-block: 1rem` (all-around margins) instead of `margin-block-start: 1.5rem`, giving the card space to breathe on all sides including the bottom
- **Inner gap**: `#note-editor` now has `height: 100%` and `overflow-y: auto`, filling the full grid cell so clicking anywhere inside the empty area focuses the editor
- **`.remote-notice` not clipped**: moved out of `.editor-wrap` to be a sibling in `.editor-area`; `overflow: hidden` on the card now correctly clips only the textarea/preview to the rounded corners without affecting the conflict notice

#### Changed
- **Floating page card**: `.editor-wrap` gains `background: var(--bg-surface)`, `border: 1px solid var(--border)`, `border-radius: var(--radius-lg)`, `box-shadow: var(--shadow-md)`, `overflow: hidden`; `gap` reduced from `2rem` to `0`; padding removed (inner panes own their own padding)
- **Split view divider**: replaced heavy gap between panes with a single `border-right: 1px solid var(--border)` on `#note-editor` in `.split-mode`
- **Typography & padding**: `#note-editor` and `.note-preview` use `padding: 1.25rem 1rem` on mobile; on desktop (`≥ 768px`) `padding: 2rem max(5%, calc((100% - 800px) / 2))` — the `max()` formula keeps readable text at ≤ 800px width on very wide panes while falling back to 5% on narrower ones
- All new colors use existing CSS variables (`--bg-surface`, `--border`, `--shadow-md`, `--radius-lg`) — no hardcoded values

---

### Phase 8 — Bug Fix: view-once teardown + accessibility labels

Branch: `claude/phase1-stability` · Commit: `fix(phase-8): view-once teardown bug + accessibility labels on auth/landing inputs`

#### Fixed
- `teardownRealtimeSession()`: reset `_consumingViewOnce` to `false` so the flag from a previous room never silently swallows view-once clear events in the next room

#### Changed
- `#landing-join-input`: added `aria-label="Room link or ID to join"`
- `#passcode-input`: added `aria-label="Room passcode"`
- `#encryption-input`: added `aria-label="Encryption passphrase"`
- `#passcode-error`: added `role="alert" aria-live="assertive"` so screen readers announce failed login attempts
- `#encryption-error`: same `role="alert"` treatment
- `#exp-custom-value` / `#exp-custom-unit`: added `aria-label` for expiration amount and unit inputs

#### Added
- `accessibility.spec.js`: 4 new tests covering the above `aria-label` and `role` attributes

---

### Phase 7 — Find & Replace Polish + Paste Sanitization

Branch: `claude/phase1-stability` · Commit: `feat(phase-7): case-sensitive search toggle + paste sanitization setting`

#### Added
- **Case-sensitive search (`Aa` button)**: toggle inside the search bar; `_caseSensitive` flag resets to `false` on room navigation; hint updated to "Aa = case-sensitive"
- **Replace All**: now uses `'g'` flag (not `'gi'`) when case-sensitive mode is active; uses the unmodified raw search term for the `RegExp` pattern
- **Strip formatting on paste**: new **Editor** section in Settings panel; persists to `localStorage` key `syncpad_strip_paste`; intercepts `paste` events on the editor and substitutes `text/plain` data only
- `search.spec.js`: 3 new tests — Aa button visible, case-sensitive toggle (3→1→3 matches), Replace All respects case mode
- `settings.spec.js`: 2 new tests — strip-paste button visible, On/Off toggle

#### Changed
- Search hint text from "Case-insensitive · Replace requires edit access." → "Replace requires edit access. Aa = case-sensitive."

---

### Phase 6 — Documentation

#### Added
- `CLAUDE.md`: AI agent development guide for working with the SyncPad codebase
- `CHANGELOG.md`: this file, covering all phases in Keep a Changelog format
- `docs/architecture.md`: system architecture overview
- `docs/security.md`: security model documentation
- `docs/playwright.md`: Playwright test suite guide
- `README.md`: updated to reflect all completed phases

---

### Phase 5 — Playwright Test Suite

Branch: `claude/phase1-stability` · Commit: `feat(phase-5): Playwright test suite — 6 spec files, ~60 scenarios`

#### Added
- `playwright.config.js`: static file server on port 5555, 4 browser projects (Chromium, Firefox, WebKit, Mobile Chrome), 2 CI retries, `fullyParallel` enabled
- `tests/helpers.js`: shared test utilities — `createRoom`, `goToLanding`, `typeInEditor`, `getEditorContent`, `openPanel`, `waitForToast`, `closePanels`, `roomIdFromUrl`
- `tests/landing.spec.js`: 6 tests covering the landing page
- `tests/editor.spec.js`: 8 tests covering core editor behaviour
- `tests/markdown.spec.js`: 12 tests covering Markdown rendering
- `tests/search.spec.js`: 10 tests covering Find & Replace
- `tests/settings.spec.js`: 6 tests covering settings panel
- `tests/routing.spec.js`: 8 tests covering client-side routing
- `tests/accessibility.spec.js`: 8 tests covering ARIA and keyboard navigation
- `tests/utils.spec.js`: 16 unit tests executed via an `inBrowser()` helper
- `package.json` scripts: `test`, `test:ui`, `test:headed`, `test:report`, `test:chrome`, `serve`
- `.gitignore` entries: `playwright-report/`, `test-results/`, `playwright/.cache/`, `node_modules/`

---

### Phase 4 — Admin Dashboard

Branch: `claude/phase1-stability` · Commit: `feat(phase-4): admin dashboard — auth gate, rooms, reports, cleanup`

#### Added
- `src/admin.js`: complete admin dashboard implementation (~567 lines)
- `/admin` route now renders a full dashboard instead of a placeholder
- Supabase Auth gate requiring email and password before any dashboard data loads
- `is_syncpad_admin()` RLS function gates all Supabase queries so non-admins receive no data
- **Rooms tab**: displays the 50 latest rooms with client-side search and flag badges (`ENC`, `PASS`, `1×`, `EXP`); per-room Clear and Delete actions
- **Reports tab**: displays the 100 latest reports; "show only new" checkbox filter; per-report Dismiss and Delete-room actions
- **Cleanup tab**: one-click invocation of `run_cleanup_expired_syncpad_rooms_as_admin()` RPC with manual-delete fallback and result display
- Stat cards showing total rooms, active rooms, total files, and pending reports
- Human-readable error message for Supabase `PGRST301` (insufficient privileges)

---

### Phase 3 — Templates Library v2

Branch: `claude/phase1-stability` · Commit: `feat(phase-3): Templates Library v2`

#### Added
- 6 new built-in templates: `standup`, `bug-report`, `code-review`, `weekly-review`, `shopping-list`, `project-brief` (total now 13, up from ~7)
- Each template exposes `label`, `desc` (subtitle), and `body` fields
- Templates modal v2: searchable input, two-column layout with list pane and live preview pane
- Export custom templates as a JSON file
- Import custom templates from a JSON file via `importCustomTemplates(json)`, which returns the count of imported templates or `-1` on invalid input
- `QUOTA_EXCEEDED` storage error is now surfaced to the user (was previously silent)
- `BODY_MAX = 50,000` character limit enforced for custom template bodies

#### Changed
- `saveCustomTemplate()` now returns `{ key, truncated }` instead of just `key`, so callers can detect when the body was silently trimmed

---

### Phase 2 — Accessibility & Polish

Branch: `claude/phase1-stability` · Commit: `feat(phase-2): accessibility, theme transitions, expiration validation, confirm modal`

#### Added
- `role="list"` on `#files-list` and `#devices-list`; `role="listitem"` on their child elements
- `aria-label="Preview {filename}"`, `aria-label="Download {filename}"`, and `aria-label="Delete {filename}"` on file list action buttons
- `aria-hidden="true"` on decorative emoji inside file list items
- CSS theme transitions: `background-color`, `border-color`, and `color` transition over `0.22s ease` on `body`, panels, and modals (buttons are excluded to avoid sluggish click feedback)
- Custom `showConfirm(message, { confirmLabel, cancelLabel, danger })` modal returning `Promise<boolean>`
  - Injected lazily into the DOM with `role="dialog"` and `aria-modal="true"`
  - `danger: true` moves default focus to the Cancel button
  - Escape key closes the modal and resolves `false`

#### Changed
- Minimum expiration duration enforced at 5 minutes (300 seconds) inside `_buildExpirationDuration()`
- All `window.confirm()` calls replaced with the new `showConfirm()` modal

#### Fixed
- Shortcuts modal legal links were rendered outside the `.modal` dialog element; they are now correctly placed inside it

---

### Phase 1 — Stability

Branch: `claude/phase1-stability` · Commit: `fix(phase-1): stability, focus, loading states, URL cache, CSV hardening`

#### Fixed
- `_relativeTime()` was producing `"Invalid Date"` in the conflict banner due to missing timestamp coercion; sync timestamps are now coerced to numbers before use
- PWA install bar dismiss state was not persisted across page loads
- `formatTimestamp()` cross-day context bug caused incorrect date labels when the current day and the document's last-modified day differed
- `wireEvents()` was appending new DOM event listeners on every room navigation without removing the previous ones, causing a memory leak; listeners are now torn down before re-attachment
- Markdown renderer was double-escaping URLs (e.g. `%2520` instead of `%20`)
- Markdown italic regex was matching underscores inside `snake_case` words; word-boundary guards added
- Find & Replace search state was not reset when navigating to a different room
- `copyToClipboard()` in the share modal was broken and now functions correctly
- Stale `_expTimer` from a previous room was firing in the context of the newly loaded room
- `_encKey` and `_encSalt` were not cleared on room navigation, causing encryption state to leak across rooms
- `_markdownMode`, `_showPreview`, and `_expPreset` were not reset on room navigation

#### Removed
- Dead `_getPresenceDevices()` function (unreachable code)
- Dead `broadcastExpired()` function (unreachable code)

#### Added
- Signed URL cache in `files.js`: a `Map` with a 55-minute TTL, automatically evicted when a file is deleted, eliminating redundant Supabase Storage signing requests
- CSV table rendering hardened against malformed input

---

### Phase 0 — CSS Grid & Find/Replace Focus

Branch: `claude/phase1-stability` · Commit: `refactor: CSS Grid editor layout + Find & Replace focus preservation`

#### Changed
- `.editor-wrap` layout migrated from flexbox to CSS Grid using `repeat(auto-fit, minmax(min(100%, 400px), 1fr))` for responsive multi-pane behaviour

#### Fixed
- Find & Replace inputs lost focus after each keystroke during live search; focus is now preserved correctly throughout search operations

---

[Unreleased]: https://github.com/saihanswissle/SyncPad/compare/HEAD...HEAD
