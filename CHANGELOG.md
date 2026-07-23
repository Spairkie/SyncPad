# Changelog

All notable changes to SyncPad are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Phase 20 — Server-side lock enforcement, presence accuracy, Supabase setup docs, command palette

Branch: `claude/codebase-review-testing-fjicqa`

#### Fixed
- **Room lock was frontend-only, despite being the one permission control that could actually be enforced server-side.** Every other write-permission control (read-only links, `?mode=read`) is necessarily UX-only, because an editable and a read-only link for the same room share the same `room_id` and anon key — there's no separate credential to check. `editing_locked` is different: it's server-stored room state, not a property of which link someone followed. Added `enforce_syncpad_rooms_lock()`, a `BEFORE UPDATE` trigger on `syncpad_rooms` (in `supabase-setup.sql`) that rejects any content change to a locked room regardless of what calls the API — exempting the backend expiry-cleanup job and signed-in admins, both of which need to override a lock. `docs/security.md`, `README.md`, and `DEPLOYMENT.md` updated to stop describing room lock as frontend-only.
- **The connected-devices panel misattributed its own "editor"/"viewer" badge when the same device had two tabs open on a room** (e.g. testing by opening the main link in one tab and its read-only link in another) — `presence.js`'s device-merge logic picked whichever tab's presence entry tracked *most recently* to decide the merged device's `read_only` flag, so opening a read-only tab could flip your own editable tab's badge to "viewer" in the panel. Changed to an AND-reduce across a device's tabs (can edit if *any* tab can), verified with an isolated presence-state simulation covering single-tab, same-device-two-tabs, and multi-device scenarios.
- **`tool-find` (Find in Tools panel) opened and then immediately closed the search panel in the same tick** — its handler ran through `toolActions`' blanket `closeAllPanels()` after every action, which undid the `openPanel('search-panel')` it had just called. The exact same bug the code's own comment already flagged as fixed for `tool-history`/`tool-comments`, just never applied to `tool-find` itself. Moved it out of `toolActions`, matching those two.
- **`shortcuts.js` had two leftover direct `editor.value`/`selectionStart`/`selectionEnd` writes** (`_wrapSelection`, `_insertLink`) that the Phase 18 editor-DOM-boundary migration missed because it was scoped to `app.js` only. Migrated both to `UI.replaceEditorRange()`.
- **DEPLOYMENT.md's setup steps never mentioned four of five optional feature migrations** (`short-room-codes.sql`, `room-comments.sql`, `version-history.sql`, `device-limit.sql`, `admin-dashboard-improvements.sql`) — a fresh Supabase project set up by following the docs literally would have short codes, comments, version history, device-limit rooms, and admin quarantine/audit-log all silently non-functional. Added a table listing every optional migration, what it enables, and the symptom if it's skipped. The Share modal's short-code error message now points directly at the migration file instead of a generic "check Supabase setup."
- **Two UI label-wrapping inconsistencies**: the Export modal's "Copy as HTML" row wrapped to two lines while every other row (including longer labels) stayed on one line — its sibling description text ("Copy rendered HTML to clipboard", the longest in the list) was crowding the label column in that row only, with no per-row consistency. Labels are now `flex-shrink: 0` in their own `.export-label` span; descriptions wrap instead, since they're secondary text. The new Command Palette's More-menu entry had the same issue, fixed by letting `#more-dropdown` size to its widest row instead of a fixed `min-width`.

#### Added
- **Command palette** (`Ctrl/⌘+K` outside the editor, or More menu → Command Palette): a searchable, keyboard-navigable list of ~30 app-wide actions — view modes, every panel, sharing, room lock, clear/export/import, and all 7 themes. Filtering is a plain token-substring match (`filterCommands()` in `utils.js`, deliberately not fuzzy-scored, for predictable results); rendering lives in `ui.js` (`renderCommandPaletteResults()`); the action registry lives in `app.js` and, where a guarded button already exists for an action (permission checks, confirm dialogs, toasts), runs it via the same button rather than re-implementing the guard. `Ctrl/⌘+K` stays "insert markdown link" inside the editor — same key, contextual, mirroring how `Ctrl+F` already splits behavior on focus. Covered by `tests/command-palette.spec.js`.

#### Changed
- Re-verified all ~38 Markdown Guide features against the renderer directly (no changes needed — output matched the Phase 19 audit exactly, confirming no regressions).

### Phase 19 — Live/Split focus indicator, Markdown Guide compliance pass

Branch: `claude/codebase-review-testing-fjicqa`

#### Fixed
- **The Live/Split editing surface had no focus indicator at all.** The Source textarea's subtle accent-line-on-focus (a `2px` `outline` that `.editor-wrap`'s `overflow:hidden` + rounded corners clip down to a thin sliver along the card's inner edge, not a full ring) only applied to `#note-editor`. `.note-live` — CodeMirror's mount point, occupying the identical grid cell — had no equivalent, and CM6's own default focus outline was separately suppressed in `live-editor.js`'s theme, so focusing Live or the right pane of Split showed no visual feedback whatsoever. Added `.note-live:focus-within` (not `:focus-visible` — the real focus target is CM6's nested contenteditable `.cm-content`, not `.note-live` itself) to the same shared rule `#note-editor:focus-visible` uses. Verified via cropped pixel-region screenshots that the line now appears correctly scoped to whichever pane has focus.
- **Titled links and images were completely broken, not just missing title support**: `[text](url "title")` and `![alt](url "title")` — standard CommonMark syntax — failed to match the link/image regex at all (which required the URL capture to contain no whitespace) and fell through as raw, partially-mangled literal text. Now parses and renders the optional title as a `title` attribute.
- **Reference-style links (`[text][id]` / collapsed `[text][]` + `[id]: url "title"`) were entirely unimplemented** — core CommonMark/basic-syntax, silently missing. Added a definition-collection pre-pass mirroring the existing footnote-definition pattern (single-line definitions only, pulled out of the normal block stream, resolved at first use). An id that's defined but never referenced renders nothing, which doubles as support for the common `[comment]: <> (text)` invisible-comment convention — verified working for both the `<>` -style and `[//]:` -style variants.
- **Angle-bracket autolinks (`<https://…>`, `<mailto:…>`, bare `<user@host>`) were unsupported** — CommonMark's explicit autolink syntax fell through as escaped literal text (`&lt;https://…&gt;`) since nothing recognized the wrapped form. Bare `https://…` autolinking already covered most real usage; this closes the gap for the explicit-bracket form.

All four fixes verified against SyncPad's actual renderer output (not just inspecting the source) for every feature on the Markdown Guide's basic, extended, and hacks pages, plus every existing regression test in `tests/markdown.spec.js` re-checked directly against the modified renderer — zero regressions across ~38 feature checks + 12 existing regression cases. `docs/markdown-feature-audit.md` updated to match, including a newly-identified (and deliberately deferred) gap: Setext-style headings (`Text\n===`) aren't supported — ATX (`#`) already covers headings and is what the toolbar inserts, and the `---` underline form is genuinely ambiguous with horizontal rules in a single-pass block scanner.

### Phase 18 — Full-repo review: test infra, editor DOM boundary, admin error handling

Branch: `claude/codebase-review-testing-fjicqa`

Every file in `src/`, `styles/`, `index.html`, and the service worker read in full, cross-checked against 3 independent agent passes over `app.js`/`ui.js`/`admin.js`, a live 291-test Playwright run, and a visual pass across all 7 themes and desktop/mobile layouts.

#### Fixed
- **The entire Playwright suite failed to start**: `package.json` had no `"type": "module"` while every test file uses ES import/export; under Playwright's parallel file loading, Node's per-file CJS-then-ESM reparse fallback could misattribute a CommonJS parse error to the wrong spec file. The actual offender was `tests/spa-server.js`'s three `require()` calls, the only CommonJS left in the repo. Added `"type": "module"`, converted `spa-server.js` to ES module imports.
- **View-once "already viewed" overlay could be visually hidden by an open side panel**: `.view-once-consumed-panel`'s `z-index: 55` carried a stale comment claiming it was "above side-panels (50)" — side panels were later bumped to `140`/`135` to fix a different overlap bug, and this one was never updated to match. Bumped to `150`.
- **Double-escaped filename in the single-file delete confirm**: `app.js` passed `escapeHtml(file.filename)` into `UI.showConfirm()`, which already escapes via `textContent` — a filename with `&` showed literal `&amp;` in the dialog.
- **Comment delete had no handler-level permission check**: unlike comment submit, `_deleteCommentClick()` relied entirely on the delete button being UI-gated by `canEdit()`, not a check inside the handler itself — the same shape as the Phase 14 paste-permission bug, closed before it could become reachable.
- **Admin "delete all expired rooms now" skipped the report-cleanup step** that `_deleteRoomAndStorage()` already does for every other delete path (marking related `'new'` reports `'reviewed'` so they don't keep pointing at a deleted room) — added the same step, batched to match the rest of the function's batching.
- **Typing indicator could bleed into the next room**: `teardownRealtimeSession()` reset nearly every other piece of room-scoped UI state but never cleared a still-showing "X is typing…" banner or its auto-hide timer.
- **`BODY_MAX` (50,000 chars) was unenforced** on text-file import, template append, template insert, and native paste — only custom-template saves respected it. Enforced centrally in the editor's single `input` listener (the one choke point every edit path already dispatches through) rather than at each write site.
- **Admin mutation errors leaked raw Postgres/PostgREST messages**: only the tab-load paths translated a PGRST301/permission failure into "You do not have admin access." (per `docs/security.md`); every delete/lock/quarantine/cleanup action showed the raw error instead. All ~15 mutation error paths now share the same translation.

#### Changed
- **`app.js` no longer writes `editor.value`/`selectionStart`/`selectionEnd` directly** (23 call sites: auto-pair, smart punctuation, indent/list-continue, search replace, paste sanitization, toolbar formatting). Added `UI.replaceEditorRange()` and `UI.setEditorSelection()` to `ui.js` as the general-purpose siblings of the existing `UI.insertAtCursor()`/`UI.setEditorValue()`, so `ui.js` is now actually the single DOM touchpoint the module boundary in `CLAUDE.md`/`docs/architecture.md` describes, not just for whole-document replacement.
- Consolidated the passcode/encryption error-field show/clear helpers in `ui.js` into one generic implementation (4 public functions unchanged, same call sites).
- Unified the Settings-panel and keyboard-shortcut monospace toggles into one `_toggleMonospace()` — the keyboard-shortcut path previously left the Settings panel's button showing stale state until the panel was closed and reopened.
- Wired up `UI.setCommentLoading()` (already-built plumbing, never called) to the Comments panel's open path, matching Version History's existing loading-state pattern.
- Removed an unreachable `{ filter }` param from admin's `_renderRoomsTab()` / `switchTab()` — no caller ever populated it; the real filter path is the stat-card click handler setting `_roomsFilter` directly.
- Renamed the export modal's `#export-copy-md` button id to `#export-copy-html` — it copies rendered HTML, not Markdown, and has since the feature was last changed.
- Merged two CSS rules each fully overridden by a later "polish" declaration (`.share-room-title`, `.report-room-modal`), removed the entirely-unused `.share-card-title`.
- Added `src/comments.js` to the service worker's precache list (only recently-added module missing from it); bumped cache to `syncpad-v37`.
- Corrected doc drift: `CLAUDE.md`/`README.md`'s "4 browser projects" claim now notes only `chromium` runs by default (`playwright.config.js`), README's Export description now says "HTML" not "Markdown", `spa-server.js`'s usage comment now matches its actual `PORT` env var (not a positional arg it never read).

### Phase 17 — UI bug-fix pass, CSS modularization, Markdown feature audit

Branch: `claude/repo-review-refactor-kba1k5`

#### Fixed
- **Side panels rendered behind the app header**: `.side-panel`/`.panel-backdrop` z-index was below `.app-header`, hiding every panel's header (including its close button) at the top of the viewport. All 7 panels already had a close button in their markup — it was just invisible.
- **Write/Live/Split editor surfaces had mismatched typography**: `.note-live` and `.note-preview` were missing the `letter-spacing` and a `768px` `font-size` bump that `#note-editor` picked up only through a disconnected "UI modernization pass" override block.
- **Custom auto-expire had an undocumented 5-minute floor**: dropped to "greater than 0" per product decision.
- **Editor lost focus/selection when clicking a settings toggle**: the 6 on/off toggle buttons now use `mousedown` `preventDefault()` so they don't steal focus from the editor mid-edit.
- **`[TOC]` silently rendered as nothing in the HTML-export/print path**: `renderMarkdownWithToc()`'s top-level detection was tied to the same internal flag as blockquote recursion, so its own [TOC] pre-pass never ran. Introduced an explicit `_isRecursiveCall` marker instead of overloading "was a ctx passed in at all" to mean two different things.
- **GFM table alignment markers (`:---`, `---:`, `:---:`) were parsed and silently discarded** — every table rendered left-aligned regardless of what the separator row said.

#### Added
- Backslash-escaped punctuation (`\*`, `\_`, `\[`, etc.) — standard CommonMark escaping, previously unsupported.
- Footnotes: `text[^id]` + `[^id]: note text`, numbered by first appearance, rendered in a references section with backlinks.
- GitHub-style alerts: `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]` render as labeled callouts instead of plain blockquotes.
- Removed 4 Tools-panel entries (Copy Note, Timestamp, Share, Select All) that duplicated always-visible footer/header controls or native browser behavior (Ctrl+A).
- Renamed the Write/Preview/Split mode labels to Source/Live/Split — "Preview" wrongly implied a read-only view when it's actually an editable Typora-style live-rendered surface.
- `docs/markdown-feature-audit.md` — full audit of SyncPad's Markdown support against the Markdown Guide's basic/extended/hacks feature set, with rationale for what's intentionally out of scope (raw HTML, center/color, definition lists, subscript/superscript, etc.).

#### Changed
- **Split `styles/style.css` (3,059 lines) into 9 files** under `styles/` (`base.css`, `landing.css`, `app-shell.css`, `editor.css`, `panels.css`, `modals.css`, `file-preview.css`, `room-tools.css`, plus the already-separate `admin.css`), loaded via ordered `<link>` tags that preserve the original cascade exactly. `admin.css` is lazy-loaded by `admin.js` only on the `/admin` route — regular room pages no longer fetch or parse it. Verified byte-for-byte against the pre-split file (every rule reconstructs in order; only blank-line spacing and two intentional header-comment edits differ).
- Resolved a real merge conflict between this branch and `main` (both had independently implemented the same live-surface gap fixes) via a merge commit rather than a rebase, to resolve the overlapping content exactly once.
- Bumped the service worker cache version several times across this phase (currently `syncpad-v36`) to match the precache-asset changes above.

### Phase 16 — Responsive text wrapping in modals and toasts

Branch: `claude/repo-review-refactor-kba1k5`

#### Fixed
- **Confirm/prompt modal message overflowed instead of wrapping**: a long unbroken token (a filename with no spaces, e.g. `Delete "AVD-Instructions.pdf"?` with a much longer real-world filename) ran past the modal's bounds at every viewport size, including desktop — `overflow-wrap`/`word-break` were never set on `.confirm-modal-message`. Also hardened `.modal-actions` (`flex-wrap` + `min-width: 0` on buttons) against longer confirm/cancel labels overflowing the row.
- **Admin dashboard's separate dialog system had the identical bug**: `.admin-dialog-msg`/`.admin-dialog-title` (used for messages like `Delete file "..."?` and `Delete room "..."?`) had no wrap protection either.
- **Toast messages could be almost entirely cut off**: `.toast` used `white-space: nowrap` with only a `max-width` cap and no overflow handling — a longer message (several existing error toasts run a full sentence) rendered at roughly double its visible width, silently hiding most of the text. Toasts now wrap normally, capped at a reasonable width.
- Bumped service worker cache to `syncpad-v19`.

### Phase 15 — Codex review follow-ups (PWA resume, image/autolink corruption)

Branch: `claude/repo-review-refactor-kba1k5`

Automated review on the merged PR surfaced three real bugs; all confirmed with a reproduction before fixing.

#### Fixed
- **PWA resume suppression missed every root-navigation link except the header logo**: the view-once panel's "Go home" button, and every plain `<a href="/SyncPad/">` "Back to SyncPad" link on the contact/privacy/terms/info screens (including the one a quarantined-room viewer lands on), bypassed the one-shot suppression flag — clicking them in a standalone PWA just bounced straight back into the same room. Replaced the single `.header-logo`-specific listener with one delegated `click` listener that catches any anchor navigating to the app root, plus a new `onGoHome` callback for the view-once panel's button (not a real anchor).
- **Markdown images could be corrupted by the emphasis rules that ran after them**: `![alt](url)` was rendered to real `<img>` markup before the bold/italic/strikethrough regexes ran, so a `*`/`_` character inside the URL or alt text got rewritten into a literal `<em>`/`<strong>` tag sitting inside the `src=`/`alt=` attribute (e.g. `![alt](https://x.com/a*b*.png)` corrupted the `src`). Images are now rendered into an opaque placeholder first and restored at the very end, mirroring the existing code-span/anchor protection.
- **Autolink trimming could strip a legitimate closing parenthesis**: the trailing-punctuation trim matched a whole run of punctuation at once (e.g. `).`), so a balanced URL like `.../Function_(mathematics).` had its real closing `)` stripped along with the sentence period, corrupting the link target. Rewrote the trim to walk backwards one character at a time, evaluating each `)` on its own merits (only trimmed when unmatched by an earlier `(` in the URL).

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
