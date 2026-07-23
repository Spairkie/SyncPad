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
//   Ctrl/Cmd + K             Insert markdown link (in the editor) / open the
//                            command palette (everywhere else)
//   Ctrl/Cmd + `             Inline code
//   Ctrl/Cmd + Shift + K     Open share modal
//   Ctrl/Cmd + Shift + T     Insert timestamp
//   Ctrl/Cmd + Shift + C     Copy note
//   Ctrl/Cmd + Shift + /     Send a cursor chat message
//   Ctrl/Cmd + /             Open shortcuts modal
//   Esc                      Close panel / modal / dropdown

import { flushSave } from './sync.js';
import { canEdit }   from './permissions.js';
import * as UI       from './ui.js';

// Provided by app.js at init time
let _onTogglePreview  = null;
let _onToggleSplit    = null;
let _onToggleMonospace = null;
let _onOpenSearch     = null;
let _onForceClose     = null;  // Esc handler
let _onOpenShortcuts  = null;
let _onOpenShare      = null;
let _onInsertTimestamp = null;
let _onCopyNote       = null;
let _onCursorChat     = null;
let _onOpenCommandPalette = null;

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
  _onOpenShare       = handlers.onOpenShare;
  _onInsertTimestamp = handlers.onInsertTimestamp;
  _onCopyNote        = handlers.onCopyNote;
  _onCursorChat      = handlers.onCursorChat;
  _onOpenCommandPalette = handlers.onOpenCommandPalette;
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
  const inTypingField = _isTypingField(document.activeElement);

  // ── Esc — close any open panel/modal/dropdown ────────────────────────────
  if (key === 'Escape') {
    _onForceClose?.();
    return; // don't preventDefault — allow browser default for inputs etc.
  }

  if (!mod) return;
  if (inTypingField && !inEditor) return;

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

  // Ctrl+K outside the editor — command palette. Inside the editor, Ctrl+K
  // stays "insert markdown link" (below) — same key, contextual like Ctrl+F
  // above, so it never fights muscle memory for either use.
  if (key === 'k' && !shift && !inEditor) {
    e.preventDefault();
    _onOpenCommandPalette?.();
    return;
  }

  // ── Shift combos ─────────────────────────────────────────────────────────
  if (shift) {
    if (key === 'P' || key === 'p') { e.preventDefault(); _onTogglePreview?.();   return; }
    if (key === 'S' || key === 's') { e.preventDefault(); _onToggleSplit?.();     return; }
    if (key === 'M' || key === 'm') { e.preventDefault(); _onToggleMonospace?.(); return; }
    if (key === 'K' || key === 'k') { e.preventDefault(); _onOpenShare?.(); return; }
    if (key === 'T' || key === 't') { e.preventDefault(); if (canEdit()) _onInsertTimestamp?.(); return; }
    if (key === 'C' || key === 'c') { e.preventDefault(); _onCopyNote?.(); return; }
    if (key === '?' || key === '/') { e.preventDefault(); _onCursorChat?.(); return; }
  }

  // ── Markdown formatting (editor only, edit mode only) ───────────────────
  if (!inEditor || !canEdit()) return;

  if (key === 'b' && !shift) { e.preventDefault(); _wrapSelection(_editor, '**', '**'); return; }
  if (key === 'i' && !shift) { e.preventDefault(); _wrapSelection(_editor, '_',  '_');  return; }
  if (key === 'k' && !shift) { e.preventDefault(); _insertLink(_editor);                return; }
  if (key === '`' && !shift) { e.preventDefault(); _wrapSelection(_editor, '`',  '`');  return; }
}

function _isTypingField(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  const nonTyping = new Set(['button', 'submit', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden', 'reset']);
  return !nonTyping.has(type);
}

/** Wrap the current textarea selection with prefix/suffix markdown markers. */
function _wrapSelection(editor, prefix, suffix) {
  const start = editor.selectionStart;
  const end   = editor.selectionEnd;
  const sel   = editor.value.slice(start, end);

  // If already wrapped (and there's actual inner content), unwrap.
  // Guard against sel === prefix+suffix (no inner content) to avoid producing empty string.
  if (sel.startsWith(prefix) && sel.endsWith(suffix) && sel.length > prefix.length + suffix.length) {
    const inner = sel.slice(prefix.length, sel.length - suffix.length);
    UI.replaceEditorRange(start, end, inner, start, start + inner.length);
  } else {
    const replacement = prefix + (sel || 'text') + suffix;
    const innerStart = start + prefix.length;
    UI.replaceEditorRange(start, end, replacement, innerStart, innerStart + (sel || 'text').length);
  }
}

/** Insert a [text](url) markdown link at cursor. */
function _insertLink(editor) {
  const start = editor.selectionStart;
  const end   = editor.selectionEnd;
  const sel   = editor.value.slice(start, end).trim();
  const insert = sel ? `[${sel}](url)` : '[link text](url)';
  // Select the "url" part for easy replacement
  const urlStart = start + insert.indexOf('url');
  UI.replaceEditorRange(start, end, insert, urlStart, urlStart + 3);
}
