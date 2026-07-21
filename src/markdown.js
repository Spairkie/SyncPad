// SyncPad – markdown.js
// Minimal Markdown → HTML renderer. NO external library.
//
// Supports:
//   - headings (# .. ######)
//   - bold (**x** or __x__) and italic (*x* or _x_)
//   - strikethrough (~~x~~)
//   - inline code `x`
//   - fenced code blocks ```lang\n…\n```
//   - links [text](https://…)   (http(s)/mailto only)
//   - images ![alt](https://…)  (http(s) only)
//   - bare URL autolinking (https://example.com)
//   - unordered lists (- / * / +), including nested sub-lists by indentation
//   - ordered lists  (1. 2. …), including nested sub-lists by indentation
//   - GFM-style checklists  - [ ] item   - [x] item
//   - blockquotes  > text
//   - horizontal rules  --- / *** / ___
//   - GFM tables  | Col | Col |  with | --- | --- | separator
//   - paragraphs separated by blank lines
//   - hard line breaks (two trailing spaces)
//
// XSS strategy: every raw string segment is HTML-escaped FIRST, then a small
// set of safe markup is reintroduced. No raw HTML pass-through. Link and
// image URLs are validated against a scheme allowlist (http/https/mailto for
// links, http/https only for images — never data:/javascript:).

import { escapeHtml } from './utils.js';

// ── Constants ─────────────────────────────────────────────────────────────────
/** Matches GFM horizontal rule lines: ---, ***, ___ (with optional spaces). */
const HR_RE = /^(?:-[ \t]*){3,}$|^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$/;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Render Markdown to safe HTML.
 * @param {string} src
 * @param {object} [_parentCtx] internal — lets blockquote's recursive call
 *   share this document's checkbox counter and heading-id registry instead
 *   of starting fresh. Not part of the public API; callers should never pass it.
 * @returns {string} sanitized HTML
 */
export function renderMarkdown(src, _parentCtx) {
  if (!src) return '';
  const ctx = _parentCtx || { cbCounter: 0, headingIds: new Set() };
  const blocks = _splitBlocks(String(src));
  return blocks.map((b) => _renderBlock(b, ctx)).join('\n');
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
  const ctx = { cbCounter: 0, headingIds: new Set(), headings: [] };
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
      // First row = headers, second row = separator (skip), rest = body rows
      const parseRow = (row) =>
        row.split('|').slice(1, -1).map((c) => c.trim());
      const [headerRow, _sep, ...bodyLines] = tableLines;
      blocks.push({
        type:    'table',
        headers: parseRow(headerRow),
        rows:    bodyLines.map(parseRow),
      });
      continue;
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
    .replace(/[*_`~]/g, '')
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

// ── Block renderers ──────────────────────────────────────────────────────────

function _renderBlock(block, ctx) {
  switch (block.type) {
    case 'heading': {
      const id = _slugifyHeading(block.text, ctx.headingIds);
      ctx.headings?.push({ level: block.level, id, text: block.text.replace(/[*_`~]/g, '') });
      return `<h${block.level} id="${id}">${_renderInline(block.text)}</h${block.level}>`;
    }

    case 'code':
      return `<pre><code${block.lang ? ` class="language-${escapeHtml(block.lang)}" data-lang="${escapeHtml(block.lang)}"` : ''}>${escapeHtml(block.body)}</code></pre>`;

    case 'list':
      return _renderListTree(block.items, ctx);

    case 'blockquote':
      // Recursively render the quoted content so nested headings/lists work,
      // sharing this document's ctx so checkbox indices and heading ids stay
      // unique across the whole document instead of restarting inside the quote.
      return `<blockquote>${renderMarkdown(block.text, ctx)}</blockquote>`;

    case 'hr':
      return `<hr>`;

    case 'table': {
      const thead = `<thead><tr>${block.headers
        .map((h) => `<th>${_renderInline(h)}</th>`)
        .join('')}</tr></thead>`;
      const tbody = block.rows.length
        ? `<tbody>${block.rows
            .map((row) => `<tr>${row.map((c) => `<td>${_renderInline(c)}</td>`).join('')}</tr>`)
            .join('\n')}</tbody>`
        : '';
      return `<table>${thead}${tbody}</table>`;
    }

    case 'paragraph':
      return `<p>${_renderInline(block.text)}</p>`;
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
  return _buildListLevel(items, 0, items.length, ctx);
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
    return `<label><input type="checkbox" data-cb-index="${idx}"${checked ? ' checked' : ''} />${_renderInline(text)}</label>`;
  }
  return _renderInline(strippedContent);
}

// ── Inline renderer ──────────────────────────────────────────────────────────

function _renderInline(raw) {
  // 1. Extract code spans (their contents are not touched by other inline rules)
  const codeSlots = [];
  let text = String(raw).replace(/`([^`\n]+?)`/g, (_, code) => {
    codeSlots.push(escapeHtml(code));
    return `${codeSlots.length - 1}`;
  });

  // 2. Escape everything else
  text = escapeHtml(text);

  // 3. Images — http/https only (never data:/javascript:). Rendered into an
  // opaque placeholder rather than the final <img> markup, so ** or _
  // characters in the alt text or URL are never touched by the emphasis/
  // link rules that run afterward (mirrors the code-span and autolink
  // protection below) — otherwise e.g. a URL containing "a*b*.png" would
  // have its src corrupted with a literal <em> tag.
  const imgSlots = [];
  text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (full, alt, url) => {
    if (!/^https?:/i.test(url)) return full;
    imgSlots.push(`<img src="${url}" alt="${alt}" loading="lazy">`);
    return `I${imgSlots.length - 1}`;
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

  return text;
}
