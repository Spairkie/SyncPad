# Changelog

All notable changes to SyncPad are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

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
