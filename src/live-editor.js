// SyncPad – live-editor.js
// The Typora-style editable live-preview surface: a CodeMirror 6 instance
// over the same plain-markdown string the Write textarea holds. Mounted in
// Preview mode (and the right pane of Split); the textarea remains the
// durable source every other module reads — this surface mirrors it both
// ways but never becomes its own store of truth.
//
// Loop safety: user edits here → onChange(text) → app.js writes the
// textarea + dispatches 'input' → the input pipeline calls syncFromText()
// with identical text → no-op. Programmatic doc replacement (syncFromText)
// is annotated so the CM6 update listener never echoes it back out.

import {
  EditorState, EditorView, Compartment, Annotation,
  keymap, drawSelection, placeholder,
  defaultKeymap, history, historyKeymap, indentWithTab,
  markdown, markdownLanguage,
  syntaxHighlighting, HighlightStyle, tags,
  ViewPlugin, Decoration, syntaxTree,
} from '../vendor/codemirror.js';

let _view      = null;
let _onChange  = null;
const _readOnly = new Compartment();

// Marks transactions applied from outside (textarea → CM6) so the update
// listener can tell them apart from real typing in this surface.
const External = Annotation.define();

// Markdown syntax colouring that follows the app's theme variables, so all
// seven themes work without per-theme CM6 config.
const _mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.5em',  fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.3em',  fontWeight: '700' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '650' },
  { tag: tags.heading4, fontWeight: '650' },
  { tag: tags.heading5, fontWeight: '650' },
  { tag: tags.heading6, fontWeight: '650' },
  { tag: tags.strong,   fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link,     color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.url,      color: 'var(--accent)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)' },
  { tag: tags.quote,    color: 'var(--text-secondary)', fontStyle: 'italic' },
  { tag: tags.processingInstruction, color: 'var(--text-muted)' }, // #, *, `, > markers
  { tag: tags.contentSeparator, color: 'var(--text-muted)' },      // --- rules
]);

// ── Seamless-preview decorations ─────────────────────────────────────────────
//
// The Typora behaviour: syntax markers (#, **, *, ~~, `) are hidden wherever
// the cursor isn't, so the document reads as formatted text — and the moment
// the selection touches a formatted element, its raw markers reappear for
// editing. The document itself never changes; these are visual-only
// Decoration.replace ranges recomputed per viewport/selection/doc update.

// Marker node → the enclosing element whose selection-touch reveals it.
const _MARK_NODES = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark']);
const _hideDeco   = Decoration.replace({});
const _codeDeco   = Decoration.mark({ class: 'cm-md-inlinecode' });

function _selectionTouches(state, from, to) {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

const _seamless = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(update) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = this.build(update.view);
    }
  }
  build(view) {
    const { state } = view;
    const ranges = [];
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({
        from, to,
        enter: (nodeRef) => {
          const name = nodeRef.name;

          // Inline-code chip styling rides along with the same tree walk.
          if (name === 'InlineCode') {
            ranges.push(_codeDeco.range(nodeRef.from, nodeRef.to));
            return;
          }
          if (!_MARK_NODES.has(name)) return;

          // Reveal raw syntax while the selection touches the enclosing
          // element (the whole heading / bold span / code span), not just
          // the marker itself — that's what makes entering an element with
          // the caret "open it up" the way Typora does.
          const parent = nodeRef.node.parent;
          const revealFrom = parent ? parent.from : nodeRef.from;
          const revealTo   = parent ? parent.to   : nodeRef.to;
          if (_selectionTouches(state, revealFrom, revealTo)) return;

          // Heading marks also swallow the single space that follows the
          // #s, so "# Title" renders as just "Title".
          let hideTo = nodeRef.to;
          if (name === 'HeaderMark' && state.doc.sliceString(hideTo, hideTo + 1) === ' ') hideTo += 1;
          ranges.push(_hideDeco.range(nodeRef.from, hideTo));
        },
      });
    }
    return Decoration.set(ranges, true); // sort — mark/replace ranges interleave
  }
}, { decorations: (v) => v.decorations });

const _theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'inherit', color: 'var(--text-primary)', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.7', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--text-primary)', padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--text-primary)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    background: 'color-mix(in srgb, var(--accent) 25%, transparent)',
  },
  '.cm-line': { padding: '0' },
});

export function isMounted() { return !!_view; }

/**
 * Mount the surface into `container` (idempotent — remounts if called while
 * already mounted). `onChange(text)` fires only for edits made in this
 * surface, never for syncFromText() applications.
 */
export function mount(container, initialValue, { onChange, readOnly = false } = {}) {
  destroy();
  _onChange = onChange || null;
  _view = new EditorView({
    state: EditorState.create({
      doc: initialValue || '',
      extensions: [
        history(),
        drawSelection(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(_mdHighlight),
        _seamless,
        _theme,
        EditorView.lineWrapping,
        placeholder('Start writing… Your note syncs live across devices.'),
        _readOnly.of(EditorState.readOnly.of(!!readOnly)),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (update.transactions.some((tr) => tr.annotation(External))) return;
          _onChange?.(update.state.doc.toString());
        }),
      ],
    }),
    parent: container,
  });
}

export function destroy() {
  _view?.destroy();
  _view = null;
  _onChange = null;
}

/** Replace the doc from the textarea's value. No-op when already identical. */
export function syncFromText(text) {
  if (!_view) return;
  const current = _view.state.doc.toString();
  if (current === (text ?? '')) return;
  _view.dispatch({
    changes: { from: 0, to: current.length, insert: text ?? '' },
    annotations: External.of(true),
  });
}

export function getValue() {
  return _view ? _view.state.doc.toString() : null;
}

export function setReadOnly(on) {
  _view?.dispatch({ effects: _readOnly.reconfigure(EditorState.readOnly.of(!!on)) });
}

export function focus() { _view?.focus(); }
