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
 * @returns {string} sanitized HTML
 */
export function renderMarkdown(src) {
  if (!src) return '';
  const ctx = { cbCounter: 0 };
  const blocks = _splitBlocks(String(src));
  return blocks.map((b) => _renderBlock(b, ctx)).join('\n');
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

// ── Block renderers ──────────────────────────────────────────────────────────

function _renderBlock(block, ctx) {
  switch (block.type) {
    case 'heading':
      return `<h${block.level}>${_renderInline(block.text)}</h${block.level}>`;

    case 'code':
      return `<pre><code${block.lang ? ` class="language-${escapeHtml(block.lang)}" data-lang="${escapeHtml(block.lang)}"` : ''}>${escapeHtml(block.body)}</code></pre>`;

    case 'list':
      return _renderListTree(block.items, ctx);

    case 'blockquote':
      // Recursively render the quoted content so nested headings/lists work
      return `<blockquote>${renderMarkdown(block.text)}</blockquote>`;

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

  // 3. Images — http/https only (never data:/javascript:). Processed before
  // emphasis markup so ** or _ characters inside alt text aren't turned into
  // literal <strong>/<em> tags sitting inside the alt="" attribute value.
  text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (full, alt, url) => {
    if (!/^https?:/i.test(url)) return full;
    return `<img src="${url}" alt="${alt}" loading="lazy">`;
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
    // part of the URL (e.g. "See https://x.com." shouldn't swallow the period).
    let url = rawUrl;
    let trail = '';
    const trailing = url.match(/[.,!?;:'")\]]+$/);
    if (trailing) {
      let cut = trailing[0];
      // Keep a trailing ')' when the URL has an unmatched '(' (Wikipedia-style URLs).
      if (cut.endsWith(')') && (url.match(/\(/g) || []).length > (url.match(/\)/g) || []).length) {
        cut = cut.slice(0, -1);
      }
      if (cut) { url = url.slice(0, -cut.length); trail = cut; }
    }
    if (!url) return full;
    return `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
  });
  text = text.replace(/L(\d+)/g, (_, n) => anchorSlots[Number(n)]);

  // 7. Hard line breaks
  text = text.replace(/ {2,}\n/g, '<br>\n');
  text = text.replace(/\n/g, ' ');

  // 8. Restore code spans
  text = text.replace(/(\d+)/g, (_, n) => `<code>${codeSlots[Number(n)]}</code>`);

  return text;
}
