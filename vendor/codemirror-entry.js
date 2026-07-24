// SyncPad – vendor/codemirror-entry.js
// Source entry for the vendored CodeMirror 6 bundle. Rebuild with:
//   npm run build:vendor
// The committed artifact is vendor/codemirror.js — a single self-contained
// ES module so the no-build-step app can `import` CM6 locally (no CDN at
// runtime, works offline like the rest of the PWA).

export { EditorState, StateField, StateEffect, RangeSet, RangeSetBuilder, Compartment, Annotation } from '@codemirror/state';
export {
  EditorView, ViewPlugin, ViewUpdate, Decoration, WidgetType,
  keymap, drawSelection, highlightSpecialChars, placeholder,
} from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
export { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
export { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
export { syntaxTree, syntaxHighlighting, HighlightStyle, StreamLanguage } from '@codemirror/language';
export { tags } from '@lezer/highlight';

// Embedded-code-fence language support (fenced ```js / ```python / etc.
// blocks in the Live/Split surface) — fed to markdown()'s codeLanguages
// option in live-editor.js so those blocks get real syntax highlighting
// instead of plain monospace text.
export { javascript } from '@codemirror/lang-javascript';
export { python } from '@codemirror/lang-python';
export { json } from '@codemirror/lang-json';
export { html } from '@codemirror/lang-html';
export { css } from '@codemirror/lang-css';
export { shell } from '@codemirror/legacy-modes/mode/shell';
