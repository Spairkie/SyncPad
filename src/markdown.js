// SyncPad – markdown.js
// Minimal Markdown → HTML renderer. NO external library.
//
// Supports:
//   - headings (# .. ######)
//   - bold (**x** or __x__) and italic (*x* or _x_)
//   - inline code `x`
//   - fenced code blocks ```lang\n…\n```
//   - links [text](https://…)   (http(s)/mailto only)
//   - unordered lists (- / * / +)
//   - ordered lists  (1. 2. …)
//   - GFM-style checklists  - [ ] item   - [x] item
//   - paragraphs separated by blank lines
//   - hard line breaks (two trailing spaces)
//
// XSS strategy: every raw string segment is HTML-escaped FIRST, then a small
// set of safe markup is reintroduced. No raw HTML pass-through. Link hrefs
// are validated to start with http://, https://, or mailto:.

import { escapeHtml } from './utils.js';

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

    // Heading
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2] });
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

    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const itemsHtml = block.items.map((it) => _renderListItem(it, ctx)).join('\n');
      return `<${tag}>\n${itemsHtml}\n</${tag}>`;
    }

    case 'paragraph':
      return `<p>${_renderInline(block.text)}</p>`;
  }
  return '';
}

function _renderListItem(rawLine, ctx) {
  const stripped = rawLine.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/, '');

  // Checklist item?
  const cb = stripped.match(/^\[( |x|X)\][ \t]+(.*)$/);
  if (cb) {
    const checked = cb[1].toLowerCase() === 'x';
    const text    = cb[2];
    const idx     = ctx.cbCounter++;
    return `<li class="md-task"><label><input type="checkbox" data-cb-index="${idx}"${checked ? ' checked' : ''} />${_renderInline(text)}</label></li>`;
  }

  return `<li>${_renderInline(stripped)}</li>`;
}

// ── Inline renderer ──────────────────────────────────────────────────────────

function _renderInline(raw) {
  // 1. Extract code spans (their contents are not touched by other inline rules)
  const codeSlots = [];
  let text = String(raw).replace(/`([^`\n]+?)`/g, (_, code) => {
    codeSlots.push(escapeHtml(code));
    return `\u0001${codeSlots.length - 1}\u0001`;
  });

  // 2. Escape everything else
  text = escapeHtml(text);

  // 3. Bold then italic (non-greedy).
  // Word-boundary guards (negative lookbehind/ahead on [a-zA-Z0-9]) prevent
  // underscore-based markers from matching inside identifiers like snake_case.
  // Asterisk markers are left without boundary guards (less common in code).
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<![a-zA-Z0-9])__([^_\n]+?)__(?![a-zA-Z0-9])/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+?)\*/g,     '<em>$1</em>');
  text = text.replace(/(?<![a-zA-Z0-9])_([^_\n]+?)_(?![a-zA-Z0-9])/g,   '<em>$1</em>');

  // 4. Links — http/https/mailto only.
  // NOTE: `url` here comes from step-2-escaped text, so special chars like &
  // are already encoded as &amp;. Do NOT call escapeHtml() again — that would
  // produce double-encoded hrefs like &amp;amp; for URLs with query params.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (full, label, url) => {
    if (!/^(?:https?:|mailto:)/i.test(url)) return full;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // 5. Hard line breaks
  text = text.replace(/ {2,}\n/g, '<br>\n');
  text = text.replace(/\n/g, ' ');

  // 6. Restore code spans
  text = text.replace(/\u0001(\d+)\u0001/g, (_, n) => `<code>${codeSlots[Number(n)]}</code>`);

  return text;
}
