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
  markdown, markdownLanguage, markdownKeymap,
  closeBrackets, closeBracketsKeymap,
  syntaxHighlighting, HighlightStyle, tags,
  ViewPlugin, Decoration, WidgetType, syntaxTree,
  StateField, StateEffect,
} from '../vendor/codemirror.js';
import { escapeHtml } from './utils.js';

let _view             = null;
let _onChange         = null;
let _onCursorActivity = null;
let _scrollSync       = null; // { editorEl, scrollEl, onEditorScroll, onSelfScroll }
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

// ── ==highlight== extension ──────────────────────────────────────────────────
//
// Not part of CommonMark/GFM, so the base markdown language doesn't parse it.
// Modeled directly on @lezer/markdown's own built-in Strikethrough extension
// (same "==" delimiter shape as "~~") and fed to markdown()'s `extensions`
// option — this plain-object shape (defineNodes + parseInline) is the
// documented public extension mechanism, not an internal API.
const _highlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };
const _highlightExtension = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': tags.special(tags.content) } },
    { name: 'HighlightMark', style: tags.processingInstruction },
  ],
  parseInline: [{
    name: 'Highlight',
    parse(cx, next, pos) {
      if (next !== 61 /* '=' */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
      return cx.addDelimiter(_highlightDelim, pos, pos + 2, !sAfter, !sBefore);
    },
    after: 'Emphasis',
  }],
};

// ── Seamless-preview decorations ─────────────────────────────────────────────
//
// The Typora behaviour: syntax markers (#, **, *, ~~, `) are hidden wherever
// the cursor isn't, so the document reads as formatted text — and the moment
// the selection touches a formatted element, its raw markers reappear for
// editing. The document itself never changes; these are visual-only
// Decoration.replace ranges recomputed per viewport/selection/doc update.

// Marker node → the enclosing element whose selection-touch reveals it.
const _MARK_NODES = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark', 'HighlightMark']);
const _hideDeco      = Decoration.replace({});
const _codeDeco      = Decoration.mark({ class: 'cm-md-inlinecode' });
const _highlightDeco = Decoration.mark({ class: 'cm-md-highlight' });
const _quoteLine     = Decoration.line({ class: 'cm-md-blockquote' });

function _selectionTouches(state, from, to) {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

// Clickable checkbox replacing a task marker ([ ] / [x]). Toggling rewrites
// the marker text through a normal user transaction, so the edit flows out
// through onChange → textarea → the whole save/broadcast pipeline.
class _CheckboxWidget extends WidgetType {
  constructor(checked, from, to) { super(); this.checked = checked; this.from = from; this.to = to; }
  eq(other) { return other.checked === this.checked && other.from === this.from && other.to === this.to; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-md-checkbox';
    box.checked = this.checked;
    box.addEventListener('change', () => {
      if (view.state.readOnly) { box.checked = this.checked; return; }
      view.dispatch({ changes: { from: this.from, to: this.to, insert: box.checked ? '[x]' : '[ ]' } });
    });
    return box;
  }
}

class _BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-md-bullet';
    s.textContent = '•';
    return s;
  }
}

class _HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const hr = document.createElement('span');
    hr.className = 'cm-md-hr';
    return hr;
  }
}

const _bulletWidget = new _BulletWidget();
const _hrWidget     = new _HrWidget();

// ── GFM alerts (> [!NOTE] etc.) ──────────────────────────────────────────────
//
// lezer-markdown's base grammar has no concept of these — a "[!NOTE]" on its
// own line inside a blockquote just parses as an ordinary (unresolved)
// shortcut-reference Link node. Detected here by matching the blockquote's
// first line against GitHub's five alert kinds, mirroring markdown.js's own
// static renderer (_ALERT_ICONS) so Live/Split/Preview shows the same
// coloured box + icon+label the exported HTML already did.
const _ALERT_LABEL = {
  note: 'ℹ️ Note', tip: '💡 Tip', important: '❗ Important', warning: '⚠️ Warning', caution: '🛑 Caution',
};
const _ALERT_LINE_RE = /^>\s*\[!(note|tip|important|warning|caution)\]\s*$/i;

function _blockquoteAlertKind(state, from) {
  const m = _ALERT_LINE_RE.exec(state.doc.lineAt(from).text);
  return m ? m[1].toLowerCase() : null;
}

const _alertLineDeco = Object.fromEntries(
  Object.keys(_ALERT_LABEL).map((kind) => [kind, Decoration.line({ class: `cm-md-alert cm-md-alert-${kind}` })]),
);

class _AlertLabelWidget extends WidgetType {
  constructor(kind) { super(); this.kind = kind; }
  eq(other) { return other.kind === this.kind; }
  toDOM() {
    const span = document.createElement('span');
    span.className = `cm-md-alert-title cm-md-alert-title-${this.kind}`;
    span.textContent = _ALERT_LABEL[this.kind];
    return span;
  }
}

// ── Footnotes ─────────────────────────────────────────────────────────────────
//
// "[^label]" parses the same way "[!NOTE]" does — an unresolved shortcut
// Link node — since footnotes aren't part of lezer-markdown's base grammar
// either. No attempt to relocate definitions into a rendered "Footnotes"
// section the way the static renderer does (this is an editable surface;
// moving text out of document order would fight the user editing it) — just
// enough visual distinction that neither form reads as stray bracket noise.
const _FOOTNOTE_RE = /^\[\^([^\]]+)\]$/;

class _FootnoteRefWidget extends WidgetType {
  constructor(label) { super(); this.label = label; }
  eq(other) { return other.label === this.label; }
  toDOM() {
    const sup = document.createElement('sup');
    sup.className = 'cm-md-footnote-ref';
    sup.textContent = this.label;
    return sup;
  }
}

class _FootnoteDefMarkerWidget extends WidgetType {
  constructor(label) { super(); this.label = label; }
  eq(other) { return other.label === this.label; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-md-footnote-def-marker';
    span.textContent = `${this.label}.`;
    return span;
  }
}

// ── GFM tables ────────────────────────────────────────────────────────────────
//
// The base markdown() config (via markdownLanguage) already parses GFM
// tables into Table/TableHeader/TableRow/TableCell/TableDelimiter nodes —
// same grammar that gives us TaskList/Strikethrough for free — but nothing
// previously turned that tree into an actual <table>, so it just sat there
// as literal pipe-delimited text. Rendered as a whole-block replace widget,
// same "reveal raw source while the selection touches it" pattern as Image.
class _TableWidget extends WidgetType {
  constructor(html) { super(); this.html = html; }
  eq(other) { return other.html === this.html; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table-wrap';
    wrap.innerHTML = this.html;
    return wrap;
  }
  ignoreEvent() { return true; }
}

function _tableAlignments(delimiterText) {
  return delimiterText.split('|').slice(1, -1).map((seg) => {
    const s = seg.trim();
    if (s.startsWith(':') && s.endsWith(':')) return 'center';
    if (s.endsWith(':')) return 'right';
    if (s.startsWith(':')) return 'left';
    return '';
  });
}

function _buildTableHtml(state, tableNode) {
  const rows = [];
  let alignments = [];
  for (let child = tableNode.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableDelimiter') {
      alignments = _tableAlignments(state.doc.sliceString(child.from, child.to));
    } else if (child.name === 'TableHeader' || child.name === 'TableRow') {
      const cells = [];
      for (let cell = child.firstChild; cell; cell = cell.nextSibling) {
        if (cell.name === 'TableCell') cells.push(state.doc.sliceString(cell.from, cell.to).trim());
      }
      rows.push({ header: child.name === 'TableHeader', cells });
    }
  }
  const alignAttr = (i) => (alignments[i] ? ` style="text-align:${alignments[i]}"` : '');
  const headRow   = rows.find((r) => r.header);
  const bodyRows  = rows.filter((r) => !r.header);
  let html = '<table class="cm-md-table">';
  if (headRow) {
    html += '<thead><tr>' + headRow.cells.map((c, i) => `<th${alignAttr(i)}>${escapeHtml(c)}</th>`).join('') + '</tr></thead>';
  }
  if (bodyRows.length) {
    html += '<tbody>' + bodyRows.map((r) =>
      '<tr>' + r.cells.map((c, i) => `<td${alignAttr(i)}>${escapeHtml(c)}</td>`).join('') + '</tr>',
    ).join('') + '</tbody>';
  }
  return html + '</table>';
}

// "3/5 done" badge above a top-level checklist block, counting every
// checkbox in the block including nested sub-items — mirrors the badge the
// rendered-HTML preview shows via markdown.js's own list renderer.
class _ChecklistProgressWidget extends WidgetType {
  constructor(checked, total) { super(); this.checked = checked; this.total = total; }
  eq(other) { return other.checked === this.checked && other.total === this.total; }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-md-checklist-progress';
    el.textContent = `${this.checked}/${this.total} done`;
    return el;
  }
}

// Images pasted straight into the editor use the syncpad-file: pseudo-scheme
// (see markdown.js) since the Storage bucket is private and a real signed
// URL can't be baked into persisted content. Set once via
// setFileImageResolver() — same pattern as ui.js's rendered-preview path —
// so this module doesn't need its own import of files.js.
let _fileImageResolver = null;

/** @param {(filePath: string) => Promise<string>} resolver */
export function setFileImageResolver(resolver) { _fileImageResolver = resolver; }

class _ImageWidget extends WidgetType {
  constructor(alt, url) { super(); this.alt = alt || ''; this.url = url || ''; }
  eq(other) { return other.alt === this.alt && other.url === this.url; }
  toDOM() {
    const img = document.createElement('img');
    img.alt = this.alt;
    img.className = 'cm-md-image';
    img.addEventListener('error', () => img.classList.add('cm-md-image-broken'));

    const fileMatch = /^syncpad-file:(.+)$/i.exec(this.url);
    if (fileMatch && _fileImageResolver) {
      _fileImageResolver(fileMatch[1])
        .then((resolvedUrl) => { img.src = resolvedUrl; })
        .catch(() => img.classList.add('cm-md-image-broken'));
    } else if (/^https?:\/\//i.test(this.url)) {
      img.src = this.url;
    } else {
      img.classList.add('cm-md-image-broken');
    }
    return img;
  }
}

// ── Live remote cursors ──────────────────────────────────────────────────────
//
// Colored in-text carets with name labels for each remote collaborator,
// Google-Docs style. Positions arrive from the presence channel (app.js
// calls setRemoteCursors) and live in a StateField whose decorations are
// mapped through local doc changes, so carets stay visually anchored while
// this device types between presence updates.

class _RemoteCaretWidget extends WidgetType {
  constructor(name, color) { super(); this.name = name; this.color = color; }
  eq(other) { return other.name === this.name && other.color === this.color; }
  toDOM() {
    const caret = document.createElement('span');
    caret.className = 'cm-remote-caret';
    caret.style.borderLeftColor = this.color;
    const label = document.createElement('span');
    label.className = 'cm-remote-caret-label';
    label.style.background = this.color;
    label.textContent = this.name;
    caret.appendChild(label);
    return caret;
  }
  ignoreEvent() { return true; }
}

const _setRemoteCursorsEffect = StateEffect.define();

const _remoteCursorField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(_setRemoteCursorsEffect)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// "3/5 done" badges above top-level checklists. CM6 requires block-level
// widgets to come from a StateField, not a ViewPlugin (the seamless-folding
// plugin above only ever produces inline/replace decorations) — recomputed
// on every doc change by re-walking the syntax tree, which is cheap at
// BODY_MAX's ~50k-character ceiling.
function _computeChecklistBadges(state) {
  const ranges = [];
  syntaxTree(state).iterate({
    enter: (nodeRef) => {
      const name = nodeRef.name;
      if (name !== 'BulletList' && name !== 'OrderedList') return;
      // Nested sub-lists don't get their own badge — only the outermost
      // list of a block, matching the rendered-preview renderer.
      if (nodeRef.node.parent?.name === 'ListItem') return;
      let total = 0, checkedCount = 0;
      syntaxTree(state).iterate({
        from: nodeRef.from, to: nodeRef.to,
        enter: (inner) => {
          if (inner.name !== 'TaskMarker') return;
          total++;
          if (/x/i.test(state.doc.sliceString(inner.from, inner.to))) checkedCount++;
        },
      });
      if (total > 0) {
        ranges.push(Decoration.widget({
          widget: new _ChecklistProgressWidget(checkedCount, total), side: -1, block: true,
        }).range(nodeRef.from));
      }
    },
  });
  return Decoration.set(ranges, true);
}

const _checklistProgressField = StateField.define({
  create: (state) => _computeChecklistBadges(state),
  update(value, tr) { return tr.docChanged ? _computeChecklistBadges(tr.state) : value.map(tr.changes); },
  provide: (f) => EditorView.decorations.from(f),
});

// Typora-style [TOC] marker: a line containing only "[TOC]" gets a rendered
// contents nav placed above it (the literal "[TOC]" text stays visible/
// editable below, same badge-above-content pattern as the checklist
// progress indicator). Non-interactive — this is a document-editing surface,
// not the read-only preview pane, so links here don't need to navigate.
function _stripHeadingMarkup(raw) {
  return raw
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s*#*\s*$/, '')
    .replace(/[*_`~=]/g, '')
    .trim();
}

class _TocWidget extends WidgetType {
  constructor(entries) { super(); this.entries = entries; }
  eq(other) {
    return other.entries.length === this.entries.length &&
      other.entries.every((e, i) => e.level === this.entries[i].level && e.text === this.entries[i].text);
  }
  toDOM() {
    const nav = document.createElement('div');
    nav.className = 'cm-md-inline-toc';
    const label = document.createElement('strong');
    label.textContent = 'Contents';
    nav.appendChild(label);
    const ul = document.createElement('ul');
    for (const e of this.entries) {
      const li = document.createElement('li');
      li.style.paddingLeft = `${(Math.max(1, e.level) - 1) * 0.9}em`;
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = e.text || 'section';
      li.appendChild(a);
      ul.appendChild(li);
    }
    nav.appendChild(ul);
    return nav;
  }
  ignoreEvent() { return true; }
}

function _computeTocBadges(state) {
  const headings = [];
  syntaxTree(state).iterate({
    enter: (nodeRef) => {
      const m = /^ATXHeading([1-6])$/.exec(nodeRef.name);
      if (!m) return;
      headings.push({
        level: Number(m[1]),
        text: _stripHeadingMarkup(state.doc.sliceString(nodeRef.from, nodeRef.to)),
      });
    },
  });
  if (headings.length < 2) return Decoration.none;

  const ranges = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (!/^\[toc\]$/i.test(line.text.trim())) continue;
    ranges.push(Decoration.widget({
      widget: new _TocWidget(headings), side: -1, block: true,
    }).range(line.from));
  }
  return Decoration.set(ranges, true);
}

const _tocField = StateField.define({
  create: (state) => _computeTocBadges(state),
  update(value, tr) { return tr.docChanged ? _computeTocBadges(tr.state) : value.map(tr.changes); },
  provide: (f) => EditorView.decorations.from(f),
});

// GFM tables → real <table>s. A block-replace decoration (unlike the
// additive widgets above) must come from a StateField — CM6 rejects block
// decorations from a ViewPlugin outright ("Block decorations may not be
// specified via plugins"), which is also why this couldn't just be one more
// case in the _seamless plugin above. Recomputed on every transaction, not
// just docChanged, because whether a given table renders as a widget or its
// raw pipe syntax depends on the *selection* (reveal-while-touched, same as
// Image/HorizontalRule) — cheap enough at BODY_MAX's ~50k-char ceiling.
function _computeTableDecorations(state) {
  const ranges = [];
  syntaxTree(state).iterate({
    enter: (nodeRef) => {
      if (nodeRef.name !== 'Table') return;
      if (_selectionTouches(state, nodeRef.from, nodeRef.to)) return;
      const html = _buildTableHtml(state, nodeRef.node);
      ranges.push(Decoration.replace({ widget: new _TableWidget(html), block: true }).range(nodeRef.from, nodeRef.to));
    },
  });
  return Decoration.set(ranges, true);
}

const _tableField = StateField.define({
  create: (state) => _computeTableDecorations(state),
  update(value, tr) { return _computeTableDecorations(tr.state); },
  provide: (f) => EditorView.decorations.from(f),
});

/** Stable per-device caret colour derived from its id. */
export function colorForDevice(deviceId) {
  let hash = 0;
  const s = String(deviceId || '');
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return `hsl(${((hash % 360) + 360) % 360}, 65%, 48%)`;
}

/**
 * Render carets (and selection ranges, when a collaborator has one) for
 * remote collaborators.
 * @param {{ id: string, name: string, pos: number, anchor?: number }[]} cursors
 */
export function setRemoteCursors(cursors) {
  if (!_view) return;
  const docLen = _view.state.doc.length;
  const ranges = [];
  for (const c of (cursors || [])) {
    if (typeof c.pos !== 'number' || c.pos < 0) continue;
    const pos = Math.min(c.pos, docLen);
    const anchor = typeof c.anchor === 'number' && c.anchor >= 0 ? Math.min(c.anchor, docLen) : pos;
    if (anchor !== pos) {
      const from = Math.min(anchor, pos);
      const to   = Math.max(anchor, pos);
      ranges.push(Decoration.mark({
        class: 'cm-remote-selection',
        attributes: { style: `background: color-mix(in srgb, ${colorForDevice(c.id)} 28%, transparent)` },
      }).range(from, to));
    }
    ranges.push(Decoration.widget({
      widget: new _RemoteCaretWidget(c.name || 'Someone', colorForDevice(c.id)),
      side: -1,
    }).range(pos));
  }
  _view.dispatch({
    effects: _setRemoteCursorsEffect.of(Decoration.set(ranges, true)),
    annotations: External.of(true),
  });
}

/**
 * Scroll the local view so `pos` is visible — used by "Follow" mode to
 * jump to where a followed collaborator's cursor/selection currently is.
 * No-op when unmounted or pos is out of range.
 */
export function scrollToPos(pos) {
  if (!_view || typeof pos !== 'number' || pos < 0 || pos > _view.state.doc.length) return;
  _view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
}

// ── Comment anchors ───────────────────────────────────────────────────────────
// A dotted underline marking the text range a comment is attached to —
// display only, no popover; clicking one is handled by the Comments panel's
// own list rather than in-editor, keeping this to the same "decoration
// pushed in from outside" pattern setRemoteCursors() already uses.

const _setCommentAnchorsEffect = StateEffect.define();

const _commentAnchorsField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(_setCommentAnchorsEffect)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * @param {{ id: string, from: number, to: number }[]} comments
 */
export function setCommentAnchors(comments) {
  if (!_view) return;
  const docLen = _view.state.doc.length;
  const ranges = [];
  for (const c of (comments || [])) {
    if (typeof c.from !== 'number' || typeof c.to !== 'number') continue;
    const from = Math.max(0, Math.min(c.from, docLen));
    const to   = Math.max(from, Math.min(c.to, docLen));
    if (to <= from) continue; // point comments (no selected range) have nothing to underline
    ranges.push(Decoration.mark({ class: 'cm-comment-anchor' }).range(from, to));
  }
  _view.dispatch({
    effects: _setCommentAnchorsEffect.of(Decoration.set(ranges, true)),
    annotations: External.of(true),
  });
}

// Extract a Link node's destination for ctrl/cmd+click opening. Only http(s)
// destinations open — same policy as the markdown renderer.
function _linkUrlAt(state, pos) {
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node && node.name !== 'Link') node = node.parent;
  if (!node) return null;
  const urlNode = node.getChild('URL');
  if (!urlNode) return null;
  const url = state.doc.sliceString(urlNode.from, urlNode.to);
  return /^https?:\/\//i.test(url) ? url : null;
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

          // Highlight background spans the whole ==text==; its HighlightMark
          // children still fold/reveal via the generic _MARK_NODES handling
          // below, so this doesn't return — the walk continues into them.
          if (name === 'Highlight') {
            ranges.push(_highlightDeco.range(nodeRef.from, nodeRef.to));
          }


          // Blockquote: styled left border on each line (a GFM-alert kind's
          // coloured variant when the first line is "> [!NOTE]" etc.); the
          // > marks are hidden below via QuoteMark when not being edited.
          if (name === 'Blockquote') {
            const alertKind = _blockquoteAlertKind(state, nodeRef.from);
            const lineDeco  = alertKind ? _alertLineDeco[alertKind] : _quoteLine;
            for (let line = state.doc.lineAt(nodeRef.from); line.from <= nodeRef.to;) {
              ranges.push(lineDeco.range(line.from));
              if (line.to + 1 > state.doc.length) break;
              line = state.doc.lineAt(line.to + 1);
            }
            return;
          }

          // "[!NOTE]" etc. parses as an ordinary (unresolved) shortcut Link
          // node — relabel it to an icon+title when it's alone on the first
          // line of its enclosing blockquote (matches _blockquoteAlertKind's
          // own check, so the two agree on which blockquotes are alerts).
          // Falls through to normal Link handling (below) for anything else.
          if (name === 'Link') {
            const text = state.doc.sliceString(nodeRef.from, nodeRef.to);
            const parent = nodeRef.node.parent;
            const grandparent = parent?.parent;

            const alertMatch = /^\[!(note|tip|important|warning|caution)\]$/i.exec(text);
            if (alertMatch && parent?.name === 'Paragraph' && grandparent?.name === 'Blockquote' &&
                _blockquoteAlertKind(state, grandparent.from) === alertMatch[1].toLowerCase()) {
              if (!_selectionTouches(state, nodeRef.from, nodeRef.to)) {
                ranges.push(Decoration.replace({ widget: new _AlertLabelWidget(alertMatch[1].toLowerCase()) }).range(nodeRef.from, nodeRef.to));
              }
              return false; // skip its LinkMark children — already fully replaced
            }

            const fnMatch = _FOOTNOTE_RE.exec(text);
            if (fnMatch) {
              const isDefinition = parent?.name === 'Paragraph' && nodeRef.from === parent.from &&
                state.doc.sliceString(nodeRef.to, nodeRef.to + 1) === ':';
              if (!_selectionTouches(state, nodeRef.from, nodeRef.to)) {
                const widget = isDefinition ? new _FootnoteDefMarkerWidget(fnMatch[1]) : new _FootnoteRefWidget(fnMatch[1]);
                ranges.push(Decoration.replace({ widget }).range(nodeRef.from, nodeRef.to));
              }
              return false;
            }

            return;
          }

          // GFM tables are handled by _tableField below — block-replace
          // decorations can only come from a StateField, not this plugin
          // ("Block decorations may not be specified via plugins").

          // Horizontal rule → rendered line (revealed while touched).
          if (name === 'HorizontalRule') {
            if (!_selectionTouches(state, nodeRef.from, nodeRef.to)) {
              ranges.push(Decoration.replace({ widget: _hrWidget }).range(nodeRef.from, nodeRef.to));
            }
            return;
          }

          // Task marker ([ ] / [x]) → real clickable checkbox.
          if (name === 'TaskMarker') {
            const parent = nodeRef.node.parent; // Task (the list item content)
            if (parent && _selectionTouches(state, parent.from, parent.to)) return;
            const checked = state.doc.sliceString(nodeRef.from, nodeRef.to).toLowerCase().includes('x');
            let to = nodeRef.to;
            if (state.doc.sliceString(to, to + 1) === ' ') to += 1;
            ranges.push(Decoration.replace({ widget: new _CheckboxWidget(checked, nodeRef.from, nodeRef.to) }).range(nodeRef.from, to));
            return;
          }

          // Bullet list marks → •  (ordered-list numbers read fine as-is;
          // task items get their mark hidden since the checkbox stands in).
          if (name === 'ListMark') {
            const mark = state.doc.sliceString(nodeRef.from, nodeRef.to);
            if (!/^[-*+]$/.test(mark)) return;
            const item = nodeRef.node.parent; // ListItem
            if (item && _selectionTouches(state, item.from, item.to)) return;
            const isTask = !!item?.getChild?.('Task');
            let to = nodeRef.to;
            if (isTask) {
              if (state.doc.sliceString(to, to + 1) === ' ') to += 1;
              ranges.push(_hideDeco.range(nodeRef.from, to));
            } else {
              ranges.push(Decoration.replace({ widget: _bulletWidget }).range(nodeRef.from, nodeRef.to));
            }
            return;
          }

          // Inline images render as an actual <img>, replacing the whole
          // ![alt](url) span, while the selection isn't touching it. Read
          // alt/url from the node's own children (not a raw-text regex) so
          // a URL containing parentheses — e.g. a query string — still
          // parses correctly; the syntax tree already found its boundary.
          if (name === 'Image') {
            if (_selectionTouches(state, nodeRef.from, nodeRef.to)) return; // fall through to raw-text editing
            const marks = nodeRef.node.getChildren('LinkMark');
            const urlNode = nodeRef.node.getChild('URL');
            if (marks.length < 2 || !urlNode) return; // malformed — leave as plain text
            const alt = state.doc.sliceString(marks[0].to, marks[1].from);
            const url = state.doc.sliceString(urlNode.from, urlNode.to);
            ranges.push(Decoration.replace({ widget: new _ImageWidget(alt, url) }).range(nodeRef.from, nodeRef.to));
            return false; // skip descending into the marks this widget already replaces
          }

          // Quote marks and link syntax fold like wave-1 markers do.
          if (name === 'QuoteMark') {
            const parent = nodeRef.node.parent;
            if (parent && _selectionTouches(state, parent.from, parent.to)) return;
            let to = nodeRef.to;
            if (state.doc.sliceString(to, to + 1) === ' ') to += 1;
            ranges.push(_hideDeco.range(nodeRef.from, to));
            return;
          }
          if (name === 'LinkMark' || name === 'URL') {
            let link = nodeRef.node.parent;
            while (link && link.name !== 'Link' && link.name !== 'Image') link = link.parent;
            if (!link) return;
            if (_selectionTouches(state, link.from, link.to)) return;
            // Hide [ ] ( ) marks and the URL — leaving just the link text.
            // For URL also swallow nothing extra; marks bracket it already.
            ranges.push(_hideDeco.range(nodeRef.from, nodeRef.to));
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

/** Current local caret offset into the doc, or null if unmounted. */
export function getCaretPos() {
  return _view ? _view.state.selection.main.head : null;
}

/**
 * Viewport pixel coordinates for a document offset (cursor-chat bubble
 * placement). Returns null when unmounted or the position can't be resolved
 * (e.g. a remote peer's offset from a doc that has since changed length).
 */
export function coordsAtPos(pos) {
  if (!_view || !Number.isFinite(pos) || pos < 0 || pos > _view.state.doc.length) return null;
  try {
    const c = _view.coordsAtPos(pos);
    return c ? { x: c.left, y: c.top } : null;
  } catch { return null; }
}

/**
 * Mount the surface into `container` (idempotent — remounts if called while
 * already mounted). `onChange(text)` fires only for edits made in this
 * surface, never for syncFromText() applications.
 */
export function mount(container, initialValue, { onChange, onCursorActivity, readOnly = false } = {}) {
  destroy();
  _onChange = onChange || null;
  _onCursorActivity = onCursorActivity || null;
  _view = new EditorView({
    state: EditorState.create({
      doc: initialValue || '',
      extensions: [
        history(),
        drawSelection(),
        // Editing parity with the Write textarea's smart behaviours:
        // markdownKeymap continues lists on Enter and deletes markup on
        // Backspace; closeBrackets auto-pairs brackets/quotes.
        closeBrackets(),
        keymap.of([...closeBracketsKeymap, ...markdownKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        markdown({ base: markdownLanguage, extensions: [_highlightExtension] }),
        syntaxHighlighting(_mdHighlight),
        _seamless,
        // Ctrl/Cmd+click a folded link to open it (http(s) only — same
        // destination policy as the markdown renderer).
        EditorView.domEventHandlers({
          mousedown: (e, view) => {
            if (!(e.ctrlKey || e.metaKey)) return false;
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos == null) return false;
            const url = _linkUrlAt(view.state, pos);
            if (!url) return false;
            e.preventDefault();
            window.open(url, '_blank', 'noopener');
            return true;
          },
        }),
        _theme,
        EditorView.lineWrapping,
        placeholder('Start writing… Your note syncs live across devices.'),
        _readOnly.of(EditorState.readOnly.of(!!readOnly)),
        _remoteCursorField,
        _checklistProgressField,
        _tocField,
        _tableField,
        _commentAnchorsField,
        EditorView.updateListener.of((update) => {
          const external = update.transactions.some((tr) => tr.annotation(External));
          if (update.selectionSet && !external) {
            const sel = update.state.selection.main;
            _onCursorActivity?.(sel.head, sel.anchor);
          }
          if (!update.docChanged || external) return;
          _onChange?.(update.state.doc.toString());
        }),
      ],
    }),
    parent: container,
  });
}

export function destroy() {
  unwireScrollSync();
  _view?.destroy();
  _view = null;
  _onChange = null;
  _onCursorActivity = null;
}

// ── Split-mode scroll sync ───────────────────────────────────────────────────
//
// Proportional (percent-of-scrollable-range) sync between the Write textarea
// and this surface's own scroller, mirroring the sync the old rendered pane
// had. Rewired on every mount() since CM6's scrollDOM is a fresh element
// each time the view is (re)created, unlike the old #note-preview div.

export function wireScrollSync(editorEl) {
  unwireScrollSync();
  if (!_view || !editorEl) return;
  const scrollEl = _view.scrollDOM;
  let lock = false;
  const onEditorScroll = () => {
    if (lock) return;
    lock = true;
    const maxScroll = editorEl.scrollHeight - editorEl.clientHeight;
    const ratio = maxScroll > 0 ? editorEl.scrollTop / maxScroll : 0;
    scrollEl.scrollTop = ratio * (scrollEl.scrollHeight - scrollEl.clientHeight);
    requestAnimationFrame(() => { lock = false; });
  };
  const onSelfScroll = () => {
    if (lock) return;
    lock = true;
    const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
    const ratio = maxScroll > 0 ? scrollEl.scrollTop / maxScroll : 0;
    editorEl.scrollTop = ratio * (editorEl.scrollHeight - editorEl.clientHeight);
    requestAnimationFrame(() => { lock = false; });
  };
  editorEl.addEventListener('scroll', onEditorScroll);
  scrollEl.addEventListener('scroll', onSelfScroll);
  _scrollSync = { editorEl, scrollEl, onEditorScroll, onSelfScroll };
}

export function unwireScrollSync() {
  if (!_scrollSync) return;
  const { editorEl, scrollEl, onEditorScroll, onSelfScroll } = _scrollSync;
  editorEl.removeEventListener('scroll', onEditorScroll);
  scrollEl.removeEventListener('scroll', onSelfScroll);
  _scrollSync = null;
}

/** Replace the doc from the textarea's value. No-op when already identical. */
export function syncFromText(text) {
  if (!_view) return;
  const current = _view.state.doc.toString();
  const next = text ?? '';
  if (current === next) return;
  // Apply the smallest single-range change (common prefix/suffix trim)
  // rather than replacing the whole doc — this keeps the surface's own
  // cursor, scroll position, and undo granularity intact when the change
  // came from typing in the split-mode textarea.
  let start = 0;
  const minLen = Math.min(current.length, next.length);
  while (start < minLen && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endCur = current.length, endNext = next.length;
  while (endCur > start && endNext > start && current.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)) { endCur--; endNext--; }
  _view.dispatch({
    changes: { from: start, to: endCur, insert: next.slice(start, endNext) },
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
export function hasFocus() { return !!_view?.hasFocus; }

export function getSelection() {
  if (!_view) return { from: 0, to: 0 };
  const sel = _view.state.selection.main;
  return { from: sel.from, to: sel.to };
}

/** Replace the whole doc and set a new selection — a deliberate user action
 *  (toolbar formatting), not a per-keystroke sync, so a full replace is fine. */
export function applyEdit(text, from, to) {
  if (!_view) return;
  const current = _view.state.doc.toString();
  _view.dispatch({
    changes: { from: 0, to: current.length, insert: text ?? '' },
    selection: { anchor: from ?? 0, head: to ?? from ?? 0 },
  });
  _view.focus();
}

/**
 * A minimal textarea-shaped adapter so callers written against a real
 * <textarea> (e.g. app.js's toolbar formatting logic) can operate on this
 * surface unmodified: they read .value/.selectionStart/.selectionEnd, set
 * new ones, then call dispatchEvent() to commit — mirroring the exact
 * property-then-dispatch sequence those callers already use.
 */
export function asEditorProxy() {
  const sel = getSelection();
  return {
    value: getValue() ?? '',
    selectionStart: sel.from,
    selectionEnd: sel.to,
    dispatchEvent() { applyEdit(this.value, this.selectionStart, this.selectionEnd); },
  };
}
