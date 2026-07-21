// SyncPad – vendor/codemirror-entry.js
// Source entry for the vendored CodeMirror 6 bundle. Rebuild with:
//   npm run build:vendor
// The committed artifact is vendor/codemirror.js — a single self-contained
// ES module so the no-build-step app can `import` CM6 locally (no CDN at
// runtime, works offline like the rest of the PWA).

export { EditorState, StateField, StateEffect, RangeSet, RangeSetBuilder, Compartment } from '@codemirror/state';
export {
  EditorView, ViewPlugin, ViewUpdate, Decoration, WidgetType,
  keymap, drawSelection, highlightSpecialChars, placeholder,
} from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
export { markdown, markdownLanguage } from '@codemirror/lang-markdown';
export { syntaxTree, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
export { tags } from '@lezer/highlight';
