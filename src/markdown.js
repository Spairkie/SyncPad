// SyncPad – markdown.js
// Minimal Markdown → HTML renderer. NO external library.
//
// Supports (targets GFM — GitHub Flavored Markdown — as the reference
// flavor; see the feature-audit note at the bottom of this comment):
//   - headings (# .. ######), with auto-generated anchor ids
//   - bold (**x** or __x__) and italic (*x* or _x_)
//   - strikethrough (~~x~~) and ==highlight==
//   - inline code `x`
//   - fenced code blocks ```lang\n…\n```
//   - links [text](https://…)   (http(s)/mailto only)
//   - images ![alt](https://…)  (http(s) only)
//   - bare URL autolinking (https://example.com)
//   - unordered lists (- / * / +), including nested sub-lists by indentation
//   - ordered lists  (1. 2. …), including nested sub-lists by indentation
//   - GFM-style checklists  - [ ] item   - [x] item
//   - blockquotes  > text
//   - GitHub-style alerts  > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
//   - horizontal rules  --- / *** / ___
//   - GFM tables  | Col | Col |  with | --- | --- | separator, incl. column
//     alignment (:---, ---:, :---:)
//   - footnotes  text[^id]  ...  [^id]: note text
//   - backslash-escaped punctuation  \*  \_  \[  \]  etc.
//   - [TOC] marker → inline table of contents
//   - paragraphs separated by blank lines
//   - hard line breaks (two trailing spaces)
//
// XSS strategy: every raw string segment is HTML-escaped FIRST, then a small
// set of safe markup is reintroduced. No raw HTML pass-through. Link and
// image URLs are validated against a scheme allowlist (http/https/mailto for
// links, http/https only for images — never data:/javascript:).
//
// Deliberately NOT supported (see docs/markdown-feature-audit.md for the
// full flavor comparison and rationale): raw HTML, definition lists,
// subscript/superscript, emoji shortcodes, underline, centered/colored text,
// comments, videos, custom heading-id syntax, and 4-space-indented code
// blocks (ambiguous against this renderer's indent-based list nesting).

import { escapeHtml } from './utils.js';

// ── Constants ─────────────────────────────────────────────────────────────────
/** Matches GFM horizontal rule lines: ---, ***, ___ (with optional spaces). */
const HR_RE = /^(?:-[ \t]*){3,}$|^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$/;

/** One leading glyph per GitHub-style alert kind — see the 'blockquote' case below. */
const _ALERT_ICONS = {
  note: 'ℹ️ ', tip: '💡 ', important: '❗ ', warning: '⚠️ ', caution: '🛑 ',
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Render Markdown to safe HTML.
 * @param {string} src
 * @param {object} [_parentCtx] internal — lets blockquote's recursive call
 *   share this document's checkbox counter and heading-id registry instead
 *   of starting fresh. Not part of the public API; callers should never pass
 *   it — pass a plain ctx (e.g. from renderMarkdownWithToc) if you need to
 *   read state back out after rendering, that's still "top-level" as far as
 *   [TOC]/footnotes are concerned. Only renderMarkdown's own blockquote case
 *   marks its child ctx with _isRecursiveCall, which is the actual signal
 *   used below to skip top-level-only passes.
 * @returns {string} sanitized HTML
 */
export function renderMarkdown(src, _parentCtx) {
  if (!src) return '';
  const ctx = _parentCtx || {
    cbCounter: 0, headingIds: new Set(),
    footnoteDefs: new Map(), footnoteOrder: [],
  };
  const isTopLevel = !ctx._isRecursiveCall;
  let blocks = _splitBlocks(String(src));
  // A [TOC] marker anywhere in the document renders the *whole* document's
  // headings, including ones that appear after it — so the full heading list
  // must be known before the per-block render loop reaches it. Only done once,
  // at the top-level call (not from blockquote's recursive renderMarkdown),
  // and only when a [TOC] block actually exists, to avoid the extra pass
  // otherwise. The ids computed here are then handed out to the *real*
  // heading blocks as the main loop reaches them (via ctx._tocIdQueue) so
  // both passes agree — recomputing independently could disagree on
  // duplicate-heading suffixes (-1, -2, …).
  if (isTopLevel && !ctx._tocEntries && blocks.some((b) => b.type === 'toc')) {
    const idSet = new Set();
    ctx._tocIdQueue = [];
    ctx._tocEntries = _collectHeadingTexts(blocks).map((h) => {
      const id = _slugifyHeading(h.text, idSet);
      ctx._tocIdQueue.push(id);
      return { level: h.level, id, text: _stripHtmlTags(_renderInline(h.text, ctx)) };
    });
  }
  // Footnote definitions ([^id]: text) render only in the references section
  // at the very end of the top-level document, never inline at their source
  // position — pull them out of the normal block stream and into a lookup
  // map. Only collected at the top level (not inside a blockquote); a
  // definition written inside a blockquote is treated as ordinary text,
  // which matches how most lightweight Markdown footnote implementations
  // handle it and keeps this from needing a second recursive collection pass.
  if (isTopLevel && ctx.footnoteDefs) {
    blocks = blocks.filter((b) => {
      if (b.type !== 'footnoteDef') return true;
      if (!ctx.footnoteDefs.has(b.id)) ctx.footnoteDefs.set(b.id, b.text);
      return false;
    });
  }
  const bodyHtml = blocks.map((b) => _renderBlock(b, ctx)).join('\n');
  if (!isTopLevel || !ctx.footnoteOrder?.length) return bodyHtml;
  const items = ctx.footnoteOrder.map((id) => {
    const defText = ctx.footnoteDefs.get(id) || '';
    return `<li id="fn-${id}">${_renderInline(defText, ctx)} <a href="#fnref-${id}" class="footnote-backref" aria-label="Back to content">↩</a></li>`;
  }).join('');
  return `${bodyHtml}\n<section class="footnotes"><hr><ol>${items}</ol></section>`;
}

/** Flatten heading text (in document order) out of a block list, recursing into
 *  blockquotes so [TOC] picks up blockquoted headings too. Used only to
 *  pre-compute the full heading list for the [TOC] block, ahead of the main
 *  per-block render pass. */
function _collectHeadingTexts(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'heading') out.push({ level: b.level, text: b.text });
    else if (b.type === 'blockquote') out.push(..._collectHeadingTexts(_splitBlocks(b.text)));
  }
  return out;
}

/**
 * Like renderMarkdown(), but also returns the flat list of headings
 * encountered (including inside blockquotes), with the exact same ids the
 * rendered HTML's <h1>-<h6> elements carry — for building a table of
 * contents outside the live preview (e.g. exported/printed HTML), where
 * ui.js's DOM-scanning _injectTocNav() has no live preview element to scan.
 * @param {string} src
 * @returns {{ html: string, headings: Array<{level:number,id:string,text:string}> }}
 */
export function renderMarkdownWithToc(src) {
  const ctx = {
    cbCounter: 0, headingIds: new Set(), headings: [],
    footnoteDefs: new Map(), footnoteOrder: [],
  };
  const html = renderMarkdown(src, ctx);
  return { html, headings: ctx.headings };
}

/**
 * Build a standalone "Contents" nav from a headings list (as returned by
 * renderMarkdownWithToc). Returns '' for fewer than two headings, matching
 * the live preview's own threshold for showing a TOC at all.
 * @param {Array<{level:number,id:string,text:string}>} headings
 * @returns {string} sanitized HTML
 */
export function renderTocHtml(headings) {
  if (!headings || headings.length < 2) return '';
  const items = headings.map((h) =>
    `<li style="margin:0.3em 0;padding-left:${(Math.max(1, h.level) - 1) * 0.9}em"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`
  ).join('');
  return `<nav aria-label="Table of contents" style="border:1px solid #ddd;border-radius:8px;background:#f7f7f7;padding:0.8em 1em;margin:0 0 1.4em;font-size:0.9em">
<strong>Contents</strong>
<ul style="list-style:none;margin:0.6em 0 0;padding:0">${items}</ul>
</nav>`;
}

/**
 * Toggle a GFM-style checkbox at a 0-based index inside the source text.
 * Returns the updated source string. The index matches the order in which
 * checkboxes appear top-to-bottom in the rendered preview (the same value
 * used as the data-cb-index attribute).
 *
 * @param {string} src
 * @param {number} index
 * @param {boolean} checked
 * @returns {string}
 */
export function toggleChecklistItem(src, index, checked) {
  if (!src) return src;
  let count = 0;
  const re = /^([ \t]*(?:[-*+]|\d+\.)[ \t]+)\[( |x|X)\](?=[ \t]+)/gm;
  return src.replace(re, (full, prefix) => {
    const thisIndex = count++;
    if (thisIndex !== index) return full;
    return `${prefix}[${checked ? 'x' : ' '}]`;
  });
}

// ── Block splitting ──────────────────────────────────────────────────────────

function _splitBlocks(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]); i++;
      }
      if (i < lines.length) i++; // skip closing fence
      blocks.push({ type: 'code', lang, body: body.join('\n') });
      continue;
    }

    // Horizontal rule — 3+ dashes, asterisks, or underscores, nothing else
    // Must be checked before headings/lists to avoid mis-parsing "---"
    if (HR_RE.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++; continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2] });
      i++; continue;
    }

    // Typora-style inline table-of-contents marker — a line containing only "[TOC]"
    if (/^\[toc\]$/i.test(line.trim())) {
      blocks.push({ type: 'toc' });
      i++; continue;
    }

    // Blockquote — collect consecutive > lines, strip the > prefix
    if (/^>/.test(line)) {
      const bqLines = [];
      while (i < lines.length && /^>/.test(lines[i])) {
        bqLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', text: bqLines.join('\n') });
      continue;
    }

    // GFM table — first row starts with |, second row is the separator
    if (
      /^\|/.test(line) &&
      i + 1 < lines.length &&
      /^\|[-|:\s]+\|/.test(lines[i + 1])
    ) {
      const tableLines = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        tableLines.push(lines[i]); i++;
      }
      // First row = headers, second row = separator (alignment), rest = body rows
      const parseRow = (row) =>
        row.split('|').slice(1, -1).map((c) => c.trim());
      const [headerRow, sepRow, ...bodyLines] = tableLines;
      // GFM column alignment: :--- left, ---: right, :---: center, --- none.
      const aligns = parseRow(sepRow).map((cell) => {
        const left = cell.startsWith(':'), right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return null;
      });
      blocks.push({
        type:    'table',
        headers: parseRow(headerRow),
        aligns,
        rows:    bodyLines.map(parseRow),
      });
      continue;
    }

    // Footnote definition — [^id]: text. Pulled out of normal flow entirely;
    // rendered once, together, in a references section at the end of the
    // document (see renderMarkdown's footnote pre-pass).
    const fn = line.match(/^\[\^([A-Za-z0-9_-]+)\]:[ \t]?(.*)$/);
    if (fn) {
      blocks.push({ type: 'footnoteDef', id: fn[1], text: fn[2] });
      i++; continue;
    }

    // List (unordered, ordered, or checklist)
    if (/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/.test(line)) {
      const items = [];
      const ordered = /^[ \t]*\d+\.[ \t]+/.test(line);
      while (i < lines.length && /^[ \t]*(?:[-*+]|\d+\.)[ \t]+/.test(lines[i])) {
        items.push(lines[i]); i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Blank line
    if (/^\s*$/.test(line)) { i++; continue; }

    // Paragraph (collect contiguous non-blank, non-special lines)
    const para = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^>/.test(lines[i]) &&
      !/^\|/.test(lines[i]) &&
      !HR_RE.test(lines[i].trim()) &&
      !/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/.test(lines[i])
    ) {
      para.push(lines[i]); i++;
    }
    blocks.push({ type: 'paragraph', text: para.join('\n') });
  }

  return blocks;
}

// ── Heading anchors ──────────────────────────────────────────────────────────

/**
 * Derive a stable, URL-safe id for a heading so it can be jumped to (e.g. by
 * a table-of-contents link). Strips inline markup markers first so
 * "**Setup**" and "Setup" produce the same slug. Duplicate headings within
 * the same document get -1, -2, … suffixes; `usedIds` tracks every id
 * actually emitted so far (not just base-text counts) so a heading whose own
 * text collides with an already-generated suffix — e.g. "foo", "foo-1",
 * "foo" — still gets a unique id instead of colliding with the real "foo-1".
 */
function _slugifyHeading(text, usedIds) {
  const base = String(text)
    .replace(/[*_`~=]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-') || 'section';
  let id = base;
  let n = 1;
  while (usedIds.has(id)) { id = `${base}-${n}`; n++; }
  usedIds.add(id);
  return id;
}

/**
 * Reduce already-rendered, self-controlled inline HTML to plain text —
 * the same result a browser's `element.textContent` would give the live
 * preview's DOM-based table of contents, for export paths that have no DOM
 * to read from. Only ever called on this renderer's own output, so a plain
 * tag-strip is safe (no untrusted HTML reaches this function).
 */
function _stripHtmlTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ── Block renderers ──────────────────────────────────────────────────────────

function _renderBlock(block, ctx) {
  switch (block.type) {
    case 'heading': {
      // When a [TOC] block pre-computed the full heading list, reuse its ids
      // in order instead of slugifying again — see renderMarkdown().
      const id = ctx._tocIdQueue ? ctx._tocIdQueue.shift() : _slugifyHeading(block.text, ctx.headingIds);
      ctx.headingIds.add(id);
      const inlineHtml = _renderInline(block.text, ctx);
      // The live preview's TOC reads the rendered heading's textContent, so
      // a heading like "## [API guide](url)" shows just "API guide" there.
      // The export path (renderMarkdownWithToc) has no DOM to read from, so
      // derive the same plain text by stripping tags from the same rendered
      // HTML instead of lightly stripping the raw markdown source — which
      // would otherwise leave link/image syntax showing literally.
      ctx.headings?.push({ level: block.level, id, text: _stripHtmlTags(inlineHtml) });
      return `<h${block.level} id="${id}">${inlineHtml}</h${block.level}>`;
    }

    case 'code':
      return `<pre><code${block.lang ? ` class="language-${escapeHtml(block.lang)}" data-lang="${escapeHtml(block.lang)}"` : ''}>${escapeHtml(block.body)}</code></pre>`;

    case 'list':
      return _renderListTree(block.items, ctx);

    case 'blockquote': {
      // Recursively render the quoted content so nested headings/lists work.
      // Shares the heading-id registry (and the headings accumulator used
      // for the table-of-contents feature) — reusing the same Set/Array
      // reference — so heading anchors stay unique across the whole
      // document. Deliberately gives a *fresh* cbCounter instead of sharing
      // it: this renderer assigns every checkbox a sequential index, but
      // toggleChecklistItem()'s source-line scan only recognizes a checklist
      // marker at the very start of the line, so it never counts a
      // blockquoted item. Sharing the counter would silently misalign the
      // index of every checkbox rendered after the first blockquoted
      // checklist in the document — breaking far more checkboxes than just
      // the blockquoted ones.
      const childCtx = {
        cbCounter: 0, headingIds: ctx.headingIds, headings: ctx.headings, _tocIdQueue: ctx._tocIdQueue,
        footnoteDefs: ctx.footnoteDefs, footnoteOrder: ctx.footnoteOrder,
        _isRecursiveCall: true,
      };
      // GitHub-style alerts: a blockquote whose first line is exactly
      // "[!NOTE]" (or TIP/IMPORTANT/WARNING/CAUTION) renders as a labeled
      // callout instead of a plain blockquote — GFM's own admonition syntax,
      // needs no raw HTML.
      const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/.exec(block.text);
      if (alert) {
        const kind  = alert[1].toLowerCase();
        const label = alert[1][0] + alert[1].slice(1).toLowerCase();
        const rest  = block.text.slice(alert[0].length);
        return `<div class="md-alert md-alert-${kind}"><p class="md-alert-title">${_ALERT_ICONS[kind]}${label}</p>${renderMarkdown(rest, childCtx)}</div>`;
      }
      return `<blockquote>${renderMarkdown(block.text, childCtx)}</blockquote>`;
    }

    case 'hr':
      return `<hr>`;

    // Only reachable inside a blockquote (top-level definitions are already
    // filtered out by renderMarkdown before this switch ever sees them) —
    // render the literal source back out rather than silently dropping it.
    case 'footnoteDef':
      return `<p>${_renderInline(`[^${block.id}]: ${block.text}`, ctx)}</p>`;

    case 'toc': {
      const entries = ctx._tocEntries || [];
      if (entries.length < 2) return '';
      const items = entries.map((h) =>
        `<li class="note-toc-item note-toc-h${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`
      ).join('');
      return `<nav class="md-inline-toc" aria-label="Table of contents"><strong>Contents</strong><ul>${items}</ul></nav>`;
    }

    case 'table': {
      // aligns entries come only from our own parseRow()/left-right check in
      // _splitBlocks — never user text — so inlining them into a style
      // attribute here carries no injection risk.
      const aligns = block.aligns || [];
      const alignAttr = (i) => aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
      const thead = `<thead><tr>${block.headers
        .map((h, i) => `<th${alignAttr(i)}>${_renderInline(h, ctx)}</th>`)
        .join('')}</tr></thead>`;
      const tbody = block.rows.length
        ? `<tbody>${block.rows
            .map((row) => `<tr>${row.map((c, i) => `<td${alignAttr(i)}>${_renderInline(c, ctx)}</td>`).join('')}</tr>`)
            .join('\n')}</tbody>`
        : '';
      return `<table>${thead}${tbody}</table>`;
    }

    case 'paragraph':
      return `<p>${_renderInline(block.text, ctx)}</p>`;
  }
  return '';
}

/**
 * Build nested <ul>/<ol> HTML from a flat array of raw list-item lines (each
 * still carrying its original leading whitespace). A run of lines indented
 * further than the item above them becomes that item's nested sub-list —
 * any consistent indent step (2 spaces, 4 spaces, or a tab) works, since
 * levels are compared relatively rather than against a fixed column width.
 */
function _renderListTree(rawLines, ctx) {
  const items = rawLines.map((raw) => ({
    indent:  raw.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length,
    ordered: /^[ \t]*\d+\.[ \t]+/.test(raw),
    content: raw.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/, ''),
  }));
  const listHtml = _buildListLevel(items, 0, items.length, ctx);

  // Progress badge ("3/5 done") above the list when it's a checklist —
  // counts every checkbox in the block, nested sub-items included.
  let total = 0, checked = 0;
  for (const it of items) {
    const m = it.content.match(/^\[( |x|X)\][ \t]+/);
    if (m) { total++; if (m[1].toLowerCase() === 'x') checked++; }
  }
  if (total > 0) {
    return `<div class="md-checklist-progress">${checked}/${total} done</div>\n${listHtml}`;
  }
  return listHtml;
}

/** Renders items[start, end) that share a base indent as one <ul>/<ol>. */
function _buildListLevel(items, start, end, ctx) {
  if (start >= end) return '';
  const baseIndent = items[start].indent;
  const tag = items[start].ordered ? 'ol' : 'ul';
  let html = '';
  let i = start;
  while (i < end && items[i].indent <= baseIndent) {
    const item = items[i];
    // Consume the run of more-indented lines that follow as this item's
    // nested sub-list.
    let j = i + 1;
    while (j < end && items[j].indent > baseIndent) j++;
    const isTask   = /^\[( |x|X)\][ \t]+/.test(item.content);
    const inner    = _renderListItemContent(item.content, ctx);
    const children = j > i + 1 ? `\n${_buildListLevel(items, i + 1, j, ctx)}` : '';
    html += `<li${isTask ? ' class="md-task"' : ''}>${inner}${children}</li>\n`;
    i = j;
  }
  return `<${tag}>\n${html}</${tag}>`;
}

function _renderListItemContent(strippedContent, ctx) {
  // Checklist item?
  const cb = strippedContent.match(/^\[( |x|X)\][ \t]+(.*)$/);
  if (cb) {
    const checked = cb[1].toLowerCase() === 'x';
    const text    = cb[2];
    const idx     = ctx.cbCounter++;
    return `<label><input type="checkbox" data-cb-index="${idx}"${checked ? ' checked' : ''} />${_renderInline(text, ctx)}</label>`;
  }
  return _renderInline(strippedContent, ctx);
}

// ── Inline renderer ──────────────────────────────────────────────────────────

function _renderInline(raw, ctx) {
  // 1. Extract code spans (their contents are not touched by other inline rules)
  const codeSlots = [];
  let text = String(raw).replace(/`([^`\n]+?)`/g, (_, code) => {
    codeSlots.push(escapeHtml(code));
    return `${codeSlots.length - 1}`;
  });

  // 1.5. Backslash-escaped punctuation — runs after code-span extraction (so
  // real code-span content, already tucked away in codeSlots, is immune to
  // it — matching CommonMark: "backslash escapes do not work... in code
  // spans"), but before everything else, so e.g. \* renders a literal
  // asterisk instead of ever being considered for emphasis.
  const escSlots = [];
  text = text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, (_, ch) => {
    escSlots.push(escapeHtml(ch));
    return `X${escSlots.length - 1}`;
  });

  // 2. Escape everything else
  text = escapeHtml(text);

  // 3. Images — http/https, plus the syncpad-file: pseudo-scheme used for
  // images pasted/dropped straight into the editor (never data:/javascript:).
  // Rendered into an opaque placeholder rather than the final <img> markup,
  // so ** or _ characters in the alt text or URL are never touched by the
  // emphasis/link rules that run afterward (mirrors the code-span and
  // autolink protection below) — otherwise e.g. a URL containing "a*b*.png"
  // would have its src corrupted with a literal <em> tag.
  //
  // syncpad-file: exists because the files bucket is private — a real signed
  // URL expires in ~1h, so one can’t just be embedded as a permanent `src`.
  // ![alt](syncpad-file:<file_path>) instead renders with no `src` at all
  // (a data-syncpad-file attribute holding the path), left for the caller to
  // resolve to a live signed URL asynchronously (see ui.js's image resolver).
  const imgSlots = [];
  text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (full, alt, url) => {
    if (/^https?:/i.test(url)) {
      imgSlots.push(`<img src="${url}" alt="${alt}" loading="lazy">`);
      return `I${imgSlots.length - 1}`;
    }
    const fileMatch = /^syncpad-file:(.+)$/i.exec(url);
    if (fileMatch) {
      imgSlots.push(`<img data-syncpad-file="${fileMatch[1]}" alt="${alt}" loading="lazy">`);
      return `I${imgSlots.length - 1}`;
    }
    return full;
  });

  // 4. Bold, italic, strikethrough (non-greedy).
  // Word-boundary guards (negative lookbehind/ahead on [a-zA-Z0-9]) prevent
  // underscore-based markers from matching inside identifiers like snake_case.
  // Asterisk/tilde markers are left without boundary guards.
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<![a-zA-Z0-9])__([^_\n]+?)__(?![a-zA-Z0-9])/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+?)\*/g,     '<em>$1</em>');
  text = text.replace(/(?<![a-zA-Z0-9])_([^_\n]+?)_(?![a-zA-Z0-9])/g,   '<em>$1</em>');
  text = text.replace(/~~([^~\n]+?)~~/g,     '<del>$1</del>');
  text = text.replace(/==([^=\n]+?)==/g,     '<mark>$1</mark>');

  // 4.5. Footnote references — [^id], only for an id with a real matching
  // [^id]: definition (collected by renderMarkdown before the render loop
  // reaches any inline text); an unmatched [^id] is left as plain literal
  // text rather than linking to nothing. Numbered by first-appearance order
  // across the whole document, tracked on ctx so a footnote referenced twice
  // reuses the same number and both refs still land on separate backrefs.
  if (ctx?.footnoteDefs?.size) {
    text = text.replace(/\[\^([A-Za-z0-9_-]+)\]/g, (full, id) => {
      if (!ctx.footnoteDefs.has(id)) return full;
      let n = ctx.footnoteOrder.indexOf(id);
      const isFirstRef = n === -1;
      if (isFirstRef) { ctx.footnoteOrder.push(id); n = ctx.footnoteOrder.length - 1; }
      const num = n + 1;
      // Only the first reference to a given id gets the fnref-id anchor —
      // the footnotes section's "back to content" link targets that one,
      // same as most footnote implementations do for a multiply-referenced note.
      const anchor = isFirstRef ? ` id="fnref-${id}"` : '';
      return `<sup${anchor}><a href="#fn-${id}">${num}</a></sup>`;
    });
  }

  // 5. Links — http/https/mailto only.
  // NOTE: `url` here comes from step-2-escaped text, so special chars like &
  // are already encoded as &amp;. Do NOT call escapeHtml() again — that would
  // produce double-encoded hrefs like &amp;amp; for URLs with query params.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (full, label, url) => {
    if (!/^(?:https?:|mailto:)/i.test(url)) return full;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // 6. Autolink bare http(s) URLs. The "pre" capture requires the URL to
  // start at the beginning of the string, after whitespace, or after '(' —
  // this naturally excludes matches inside an href="…"/src="…" attribute
  // (always preceded by '"' there) without extra lookaheads. Existing
  // <a>...</a> elements are additionally hidden as opaque placeholders first
  // so a URL used as a link's own visible text (e.g. from a Markdown link
  // whose label is itself a URL) is never re-wrapped in a second, invalid
  // nested anchor.
  const anchorSlots = [];
  text = text.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, (m) => {
    anchorSlots.push(m);
    return `L${anchorSlots.length - 1}`;
  });
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<>"']+)/g, (full, pre, rawUrl) => {
    // Trim trailing punctuation that's more likely sentence punctuation than
    // part of the URL (e.g. "See https://x.com." shouldn't swallow the
    // period). Walk backwards one character at a time rather than matching
    // the whole trailing run at once, so a ')' immediately followed by more
    // punctuation (e.g. the "." in ".../Function_(mathematics).") is still
    // evaluated on its own merits — trimmed only when it's unmatched by an
    // earlier '(' in the URL, never when it legitimately closes one.
    let end = rawUrl.length;
    while (end > 0) {
      const ch = rawUrl[end - 1];
      if (ch === ')') {
        const upTo   = rawUrl.slice(0, end);
        const opens  = (upTo.match(/\(/g) || []).length;
        const closes = (upTo.match(/\)/g) || []).length;
        if (closes <= opens) break; // matched by an earlier '(' — keep it, stop trimming
        end--;
        continue;
      }
      if (/[.,!?;:'"\]]/.test(ch)) { end--; continue; }
      break;
    }
    const url   = rawUrl.slice(0, end);
    const trail = rawUrl.slice(end);
    if (!url) return full;
    return `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
  });
  text = text.replace(/L(\d+)/g, (_, n) => anchorSlots[Number(n)]);

  // 7. Hard line breaks
  text = text.replace(/ {2,}\n/g, '<br>\n');
  text = text.replace(/\n/g, ' ');

  // 8. Restore images
  text = text.replace(/I(\d+)/g, (_, n) => imgSlots[Number(n)]);

  // 9. Restore code spans
  text = text.replace(/(\d+)/g, (_, n) => `<code>${codeSlots[Number(n)]}</code>`);

  // 10. Restore backslash-escaped characters
  text = text.replace(/X(\d+)/g, (_, n) => escSlots[Number(n)]);

  return text;
}
