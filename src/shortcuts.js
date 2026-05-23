// SyncPad – shortcuts.js
// Keyboard shortcut handling. All modifying shortcuts respect read-only mode.
//
// Shortcuts:
//   Ctrl/Cmd + S             Force save
//   Ctrl/Cmd + Shift + P     Toggle preview
//   Ctrl/Cmd + Shift + S     Split view
//   Ctrl/Cmd + Shift + M     Toggle monospace
//   Ctrl/Cmd + F             Find in note
//   Ctrl/Cmd + B             Bold selected text
//   Ctrl/Cmd + I             Italic selected text
//   Ctrl/Cmd + K             Insert markdown link
//   Ctrl/Cmd + /             Open shortcuts modal
//   Esc                      Close panel / modal / dropdown

import { flushSave } from './sync.js';
import { canEdit }   from './permissions.js';

// Provided by app.js at init time
let _onTogglePreview  = null;
let _onToggleSplit    = null;
let _onToggleMonospace = null;
let _onOpenSearch     = null;
let _onForceClose     = null;  // Esc handler
let _onOpenShortcuts  = null;

/** @type {HTMLTextAreaElement|null} */
let _editor = null;

/**
 * Register all keyboard shortcuts.
 * @param {object} handlers
 * @param {Function} handlers.onTogglePreview
 * @param {Function} handlers.onToggleSplit
 * @param {Function} handlers.onToggleMonospace
 * @param {Function} handlers.onOpenSearch
 * @param {Function} handlers.onForceClose   – called for Esc when not in editor
 * @param {Function} handlers.onOpenShortcuts
 */
export function initShortcuts(handlers) {
  _onTogglePreview   = handlers.onTogglePreview;
  _onToggleSplit     = handlers.onToggleSplit;
  _onToggleMonospace = handlers.onToggleMonospace;
  _onOpenSearch      = handlers.onOpenSearch;
  _onForceClose      = handlers.onForceClose;
  _onOpenShortcuts   = handlers.onOpenShortcuts;
  _editor = document.getElementById('note-editor');

  document.addEventListener('keydown', _handleKeyDown, { capture: false });
}

export function destroyShortcuts() {
  document.removeEventListener('keydown', _handleKeyDown, { capture: false });
}

function _isMod(e) {
  return e.metaKey || e.ctrlKey;
}

function _handleKeyDown(e) {
  const mod   = _isMod(e);
  const shift = e.shiftKey;
  const key   = e.key;
  const inEditor = document.activeElement === _editor;

  // ── Esc — close any open panel/modal/dropdown ────────────────────────────
  if (key === 'Escape') {
    _onForceClose?.();
    return; // don't preventDefault — allow browser default for inputs etc.
  }

  if (!mod) return;

  // ── Ctrl/Cmd shortcuts ───────────────────────────────────────────────────

  // Ctrl+S — force save
  if (key === 's' && !shift) {
    e.preventDefault();
    flushSave();
    return;
  }

  // Ctrl+/ — shortcuts modal
  if (key === '/') {
    e.preventDefault();
    _onOpenShortcuts?.();
    return;
  }

  // Ctrl+F — find in note
  if (key === 'f' && !shift) {
    // Only intercept when editor is focused or no input is focused, to avoid
    // clobbering browser find-in-page when the user is in a settings input.
    if (inEditor || document.activeElement === document.body || document.activeElement === null) {
      e.preventDefault();
      _onOpenSearch?.();
    }
    return;
  }

  // ── Shift combos ─────────────────────────────────────────────────────────
  if (shift) {
    if (key === 'P' || key === 'p') { e.preventDefault(); _onTogglePreview?.();   return; }
    if (key === 'S' || key === 's') { e.preventDefault(); _onToggleSplit?.();     return; }
    if (key === 'M' || key === 'm') { e.preventDefault(); _onToggleMonospace?.(); return; }
  }

  // ── Markdown formatting (editor only, edit mode only) ───────────────────
  if (!inEditor || !canEdit()) return;

  if (key === 'b' && !shift) { e.preventDefault(); _wrapSelection(_editor, '**', '**'); return; }
  if (key === 'i' && !shift) { e.preventDefault(); _wrapSelection(_editor, '_',  '_');  return; }
  if (key === 'k' && !shift) { e.preventDefault(); _insertLink(_editor);                return; }
}

/** Wrap the current textarea selection with prefix/suffix markdown markers. */
function _wrapSelection(editor, prefix, suffix) {
  const start = editor.selectionStart;
  const end   = editor.selectionEnd;
  const sel   = editor.value.slice(start, end);

  // If already wrapped, unwrap
  if (sel.startsWith(prefix) && sel.endsWith(suffix)) {
    const inner = sel.slice(prefix.length, sel.length - suffix.length);
    editor.value = editor.value.slice(0, start) + inner + editor.value.slice(end);
    editor.selectionStart = start;
    editor.selectionEnd   = start + inner.length;
  } else {
    const replacement = prefix + (sel || 'text') + suffix;
    editor.value = editor.value.slice(0, start) + replacement + editor.value.slice(end);
    const innerStart = start + prefix.length;
    editor.selectionStart = innerStart;
    editor.selectionEnd   = innerStart + (sel || 'text').length;
  }
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Insert a [text](url) markdown link at cursor. */
function _insertLink(editor) {
  const start = editor.selectionStart;
  const end   = editor.selectionEnd;
  const sel   = editor.value.slice(start, end).trim();
  const insert = sel ? `[${sel}](url)` : '[link text](url)';
  editor.value = editor.value.slice(0, start) + insert + editor.value.slice(end);
  // Select the "url" part for easy replacement
  const urlStart = start + insert.indexOf('url');
  editor.selectionStart = urlStart;
  editor.selectionEnd   = urlStart + 3;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}
