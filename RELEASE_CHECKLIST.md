# SyncPad — Release Checklist

Use this checklist before publishing a new version or sharing the demo link.

> ⚠️ Reminder: SyncPad is a personal/demo project. All room controls are frontend-only.  
> View-once is convenience-only, not secure destruction; viewers may still copy or capture content before it clears.  
> Do not use for sensitive data.

---

## 1. Local / Core Tests

- [ ] Landing screen loads at root URL (`/SyncPad/`)
- [ ] **Create room** — lands on `/<roomId>`, editor is ready
- [ ] **Edit note** — text syncs live in a second tab
- [ ] **Refresh room** — content reloads from Supabase correctly
- [ ] **Hard refresh** — app recovers; no blank screen
- [ ] **Join room** by pasting a link into the landing screen join input
- [ ] **Join room** by pasting a bare room ID
- [ ] **Editable link** — opens editor, typing is allowed
- [ ] **Read-only share link** (`/SyncPad/share/:token`) — editor is `readonly`, no upload/delete controls visible
- [ ] **Invalid/missing room** — read-only share link (`/SyncPad/share/:token`) to a nonexistent room shows a clear message, does not crash
- [ ] **Lock editing** — all devices see the edit-blocked banner; typing is disabled
- [ ] **Unlock editing** — banner clears; typing resumes

---

## 2. Collaboration

- [ ] **Two tabs** — device count shows 2, both appear in Devices panel
- [ ] **Typing indicator** — typing in Tab 1 shows "…is typing" in Tab 2
- [ ] **No self-indicator** — typing indicator does NOT appear in the tab you are typing in
- [ ] **Typing stops** — indicator disappears after ~3 s of no typing
- [ ] **Read-only viewer** — appears as "viewer" in Devices panel, not "editor"
- [ ] **Read-only typing** — viewer typing does NOT broadcast a typing indicator to other tabs
- [ ] **Cursor/activity line** — approximate editor line updates in other devices' Devices panel
- [ ] **Device rename** — tap your device name, rename it; other tabs see the new name
- [ ] **Conflict notice** — edit in Tab 1 while Tab 2 has unsaved edits; notice shows Apply / Keep mine / Copy remote / Dismiss

---

## 3. Editor & Tools

- [ ] **Write mode** — textarea is editable, preview hidden
- [ ] **Preview mode** — Markdown rendered, textarea hidden
- [ ] **Split mode** — both visible side by side
- [ ] **Checklist preview** — GFM checkboxes render; checking one updates the raw note
- [ ] **Safe Markdown** — pasting `<script>alert(1)</script>` or raw HTML into the editor does NOT execute or render as HTML in preview
- [ ] **Built-in templates** — at least 3 templates apply correctly (replace and append)
- [ ] **Custom templates** — save, rename, delete; templates persist after refresh
- [ ] **Find in note** — `Ctrl/⌘+F` opens panel; search term highlights; Prev/Next navigate correctly
- [ ] **Export TXT** — downloads a plain-text file
- [ ] **Export MD** — downloads a Markdown file
- [ ] **Export HTML** — downloads a rendered HTML page that opens in a browser
- [ ] **Copy as plain text** — copies to clipboard
- [ ] **Copy as Markdown** — copies to clipboard
- [ ] **Monospace toggle** — `Ctrl/⌘+Shift+M` switches font
- [ ] **Timestamp insert** — footer Time button or `tool-timestamp` inserts current date/time

---

## 4. Keyboard Shortcuts

- [ ] `Ctrl/⌘ + S` — force saves (status briefly shows "Saving…")
- [ ] `Ctrl/⌘ + Shift + P` — toggles Preview mode
- [ ] `Ctrl/⌘ + Shift + S` — toggles Split view
- [ ] `Ctrl/⌘ + Shift + M` — toggles Monospace
- [ ] `Ctrl/⌘ + F` — opens Find panel, focuses search input
- [ ] `Ctrl/⌘ + B` — bolds selected text in Write mode
- [ ] `Ctrl/⌘ + I` — italicizes selected text in Write mode
- [ ] `Ctrl/⌘ + K` — inserts `[link text](url)` in Write mode
- [ ] `Ctrl/⌘ + /` — opens keyboard shortcuts modal
- [ ] `Esc` — closes open panel, modal, or More dropdown
- [ ] `Ctrl/⌘ + B/I/K` in **read-only mode** — does nothing (no text change)
- [ ] `Ctrl/⌘ + B/I/K` in **locked mode** — does nothing

---

## 5. Files

- [ ] **Upload via file picker** — click upload zone, select file, list updates
- [ ] **Drag-and-drop on upload zone** — drop overlay appears; file uploads
- [ ] **Drag-and-drop on Files panel body** — drop anywhere in the panel; overlay appears; file uploads
- [ ] **Drag-and-drop on editor area** — drop onto the textarea area; overlay appears; file uploads
- [ ] **Upload blocked in read-only mode** — dragging a file shows "upload disabled" toast; no upload occurs
- [ ] **File list refreshes** after upload (also in a second tab via Realtime)
- [ ] **Download file** — download button fetches signed URL; file saves
- [ ] **Delete file** — confirm dialog; file disappears from list (also in second tab)
- [ ] **Read-only user** — sees file list with preview + download only; no upload zone, no delete button

---

## 6. File Preview

- [ ] **Preview PNG/JPG/GIF/WebP** — image shown in modal lightbox at full width
- [ ] **Preview SVG** — "Open SVG in new tab" shown (not embedded inline)
- [ ] **Preview PDF** — "Open PDF in new tab" button shown
- [ ] **Preview .txt/.log/.json/.xml** — preformatted plain text shown
- [ ] **Preview .md** — Markdown rendered via safe renderer (no raw HTML)
- [ ] **Preview .csv** — HTML table rendered; header row visible
- [ ] **Unsupported file** (.zip, .docx, etc.) — shows filename, type, size, and Open/Download button
- [ ] **Large file (>100 KB text)** — truncation warning visible; only first ~100 KB shown
- [ ] **Close via ✕ button** — modal closes
- [ ] **Close via backdrop click** — modal closes
- [ ] **Close via Esc key** — modal closes
- [ ] **Download button in preview** — triggers download, then closes modal
- [ ] **Preview works in read-only mode** — preview button present; upload still blocked

---

## 7. Admin route (placeholder)

- [ ] `/SyncPad/admin` opens a placeholder page only
- [ ] No interactive admin dashboard or room-tools panel is exposed
- [ ] Placeholder copy indicates admin dashboard is intentionally shelved

---

## 8. Themes & Appearance

- [ ] **Charcoal Amber** (default) — loads without data-theme attribute; amber accent
- [ ] **Midnight Blue** — blue accent; dark background
- [ ] **Forest Green** — green accent; dark background
- [ ] **Paper Light** — light background; readable text in all panels
- [ ] **Terminal** — bright green accent; high contrast
- [ ] **Theme persists** after page refresh
- [ ] **All text readable** in Paper Light (light mode) — no invisible text

---

## 9. Mobile

- [ ] Landing screen renders correctly on narrow viewport
- [ ] **Bottom action bar** is visible and all 5 buttons are tappable
- [ ] **Share modal** opens full-width; links and QR codes are visible
- [ ] **Files panel** is full-width; upload zone visible; file rows are tappable
- [ ] **File preview modal** fills the viewport; scrollable
- [ ] `/SyncPad/admin` placeholder page renders correctly on mobile viewport
- [ ] **Tap targets** are at least 44×44 px for all buttons
- [ ] **Orientation change** — layout reflows correctly

---

## 10. Deployment

- [ ] `supabase-setup.sql` applied successfully in Supabase SQL Editor
- [ ] `syncpad-files` Storage bucket exists and is **private**
- [ ] Storage policies applied (upload, read, delete for `anon`)
- [ ] GitHub Pages is serving from the correct branch and folder
- [ ] `service-worker.js` cache name is intentionally bumped when cached assets change (currently `syncpad-v8`)
- [ ] Hard refresh (`Ctrl+Shift+R`) loads fresh content, no stale cache issues
- [ ] `404.html` is deployed and room URL redirect works
- [ ] Mobile browser tested (iOS Safari, Android Chrome)
- [ ] Supabase credentials in `index.html` are your real project values

---

## 11. Documentation

- [ ] **View-once caveat is visible** — docs/UX copy clearly says view-once is convenience-only, not secure destruction
- [ ] README.md describes only **actually implemented** features
- [ ] No claims of CSV sorting, syntax highlighting, or automatic storage cleanup
- [ ] Known Limitations section is present and accurate
- [ ] DEPLOYMENT.md has correct SQL and storage setup steps
- [ ] DEPLOYMENT.md security disclaimer is present
- [ ] Screenshots added to `docs/screenshots/` or placeholder paths noted in README
- [ ] `RELEASE_CHECKLIST.md` is present (this file)
