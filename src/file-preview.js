// SyncPad – file-preview.js
// Inline file preview modal: images, PDF, text, Markdown, CSV, unsupported.
//
// Security notes:
//   - All filenames / MIME types run through escapeHtml before rendering.
//   - Text content is HTML-escaped before display (or fed through the existing
//     safe Markdown renderer for .md files).
//   - SVG files are opened in a new tab rather than embedded as raw SVG.
//   - PDF files are opened in a new tab via signed URL.
//   - No raw HTML pass-through from file content at any point.
//   - Signed URLs are fetched through the existing getDownloadUrl helper; the
//     bucket remains private.

import { renderMarkdown } from './markdown.js';
import { escapeHtml, formatFileSize } from './utils.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const PREVIEW_TEXT_LIMIT = 100_000; // ~100 KB; show truncation warning above this

const IMAGE_MIME_SET = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);
const IMAGE_EXT_SET = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const TEXT_EXT_SET  = new Set([
  '.txt', '.log', '.json', '.xml', '.yaml', '.yml',
  '.sh', '.bash', '.js', '.mjs', '.ts', '.css', '.html', '.htm',
  '.ini', '.conf', '.env', '.toml',
]);

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Open the file preview modal for the given file metadata row.
 *
 * @param {object}   file         – row from syncpad_files
 * @param {Function} getSignedUrl – async (filePath) => string  (existing helper)
 * @param {Function} onDownload   – async (file) => void         (existing helper)
 */
export async function openFilePreview(file, getSignedUrl, onDownload) {
  _ensureModal();
  const modal = document.getElementById('file-preview-modal');
  if (!modal) return;

  // Show loading state immediately
  _setPreviewMeta(file.filename, file.file_size);
  _setBody(`<div class="preview-loading"><div class="mini-spinner"></div><span>Loading preview…</span></div>`);
  modal.classList.add('open');

  // Wire close + download (idempotent — replaces previous handlers)
  _wireModalControls(file, onDownload);

  const { mime_type: mime, filename, file_path } = file;
  const ext = _ext(filename);

  try {
    const url = await getSignedUrl(file_path);
    if (_isImage(mime, ext))     { _renderImage(file, url);                   }
    else if (_isSvg(ext))        { _renderSvgLink(file, url);                 }
    else if (_isPdf(mime, ext))  { _renderPdf(file, url);                     }
    else if (_isMarkdown(ext))   { await _renderText(file, url, 'markdown');  }
    else if (_isCsv(mime, ext))  { await _renderText(file, url, 'csv');       }
    else if (_isText(mime, ext)) { await _renderText(file, url, 'text');      }
    else                         { _renderUnsupported(file, url);             }
  } catch (err) {
    _setBody(`<div class="preview-unsupported">
      <p class="preview-error">Could not load preview.</p>
      <p class="preview-unsupported-meta">${escapeHtml(err?.message || 'Unknown error')}</p>
    </div>`);
  }
}

// ── Type detection helpers ────────────────────────────────────────────────────

function _ext(filename) {
  const m = (filename || '').toLowerCase().match(/\.[^.]+$/);
  return m ? m[0] : '';
}

function _isImage(mime, ext) {
  return IMAGE_MIME_SET.has(mime) || IMAGE_EXT_SET.has(ext);
}
function _isSvg(ext)      { return ext === '.svg'; }
function _isPdf(mime, ext){ return mime === 'application/pdf' || ext === '.pdf'; }
function _isMarkdown(ext) { return ext === '.md' || ext === '.markdown'; }
function _isCsv(mime, ext){ return mime === 'text/csv' || ext === '.csv'; }
function _isText(mime, ext) {
  return TEXT_EXT_SET.has(ext)
      || (mime && (mime.startsWith('text/') || mime === 'application/json'));
}

// ── Body renderers ─────────────────────────────────────────────────────────────

function _renderImage(file, url) {
  const img = document.createElement('img');
  img.className = 'preview-image';
  img.alt       = file.filename;
  img.onerror   = () => _setBody('<p class="preview-error">Image could not be loaded.</p>');
  const body = document.getElementById('file-preview-body');
  if (!body) return;
  body.innerHTML = '';
  body.appendChild(img);
  img.src = url; // set after append to avoid timing issues
}

function _renderSvgLink(file, url) {
  _setBody(`<div class="preview-unsupported">
    <div class="preview-type-badge">SVG</div>
    <p class="preview-unsupported-name">${escapeHtml(file.filename)}</p>
    <p class="preview-size">${formatFileSize(file.file_size)}</p>
    <p class="preview-unsupported-msg">SVG files are opened in a new tab for safety.</p>
    <a class="preview-open-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open SVG</a>
  </div>`);
}

function _renderPdf(file, url) {
  _setBody(`<div class="preview-pdf">
    <div class="preview-type-badge">PDF</div>
    <p class="preview-unsupported-name">${escapeHtml(file.filename)}</p>
    <p class="preview-size">${formatFileSize(file.file_size)}</p>
    <a class="preview-open-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open PDF in new tab</a>
  </div>`);
}

async function _renderText(file, url, mode) {
  let text;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    _setBody(`<p class="preview-error">Could not fetch file content: ${escapeHtml(err.message)}</p>`);
    return;
  }

  const truncated = text.length > PREVIEW_TEXT_LIMIT;
  const display   = truncated ? text.slice(0, PREVIEW_TEXT_LIMIT) : text;
  const warning   = truncated
    ? `<div class="preview-truncation-warning">⚠ Large file — showing first ${Math.round(PREVIEW_TEXT_LIMIT / 1024)} KB only.</div>`
    : '';

  if (mode === 'markdown') {
    _setBody(`${warning}<div class="preview-markdown-body">${renderMarkdown(display)}</div>`);
  } else if (mode === 'csv') {
    _setBody(`${warning}<div class="preview-csv-wrap">${_csvToTable(display)}</div>`);
  } else {
    _setBody(`${warning}<pre class="preview-text-body">${escapeHtml(display)}</pre>`);
  }
}

function _renderUnsupported(file, url) {
  const rawExt = _ext(file.filename).slice(1).toUpperCase() || '?';
  _setBody(`<div class="preview-unsupported">
    <div class="preview-type-badge">${escapeHtml(rawExt)}</div>
    <p class="preview-unsupported-name">${escapeHtml(file.filename)}</p>
    <p class="preview-unsupported-meta">${formatFileSize(file.file_size)} · ${escapeHtml(file.mime_type || 'unknown type')}</p>
    <p class="preview-unsupported-msg">Preview not available for this file type.</p>
    <a class="preview-open-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open / Download</a>
  </div>`);
}

// ── CSV → HTML table ──────────────────────────────────────────────────────────

function _csvToTable(text) {
  const lines = text.trim().split('\n');
  if (!lines.length) return '<p>Empty file.</p>';

  const parseRow = (line) => {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    return cells;
  };

  const ROW_CAP = 300; // guard against huge CSV freezing the DOM
  const visibleLines = lines.slice(0, ROW_CAP + 1);
  const capped = lines.length > ROW_CAP + 1;

  const [header, ...body] = visibleLines;
  const thHtml = parseRow(header).map(c => `<th>${escapeHtml(c.trim())}</th>`).join('');
  const trHtml = body.map(r =>
    `<tr>${parseRow(r).map(c => `<td>${escapeHtml(c.trim())}</td>`).join('')}</tr>`
  ).join('');

  const cap = capped ? `<p class="preview-truncation-warning">Showing first ${ROW_CAP} rows.</p>` : '';
  return `<table class="preview-csv-table"><thead><tr>${thHtml}</tr></thead><tbody>${trHtml}</tbody></table>${cap}`;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function _setBody(html) {
  const body = document.getElementById('file-preview-body');
  if (body) body.innerHTML = html;
}

function _setPreviewMeta(name, size) {
  const t = document.getElementById('file-preview-title');
  const m = document.getElementById('file-preview-meta');
  if (t) t.textContent = name;
  if (m) m.textContent = formatFileSize(size);
}

function _wireModalControls(file, onDownload) {
  const modal  = document.getElementById('file-preview-modal');
  const close  = document.getElementById('file-preview-close');
  const dlBtn  = document.getElementById('file-preview-download');

  const doClose = () => modal?.classList.remove('open');

  if (close)  close.onclick  = doClose;
  if (dlBtn)  dlBtn.onclick  = () => { onDownload(file); doClose(); };

  // Close on backdrop click
  if (modal) modal.onclick = (e) => { if (e.target === modal) doClose(); };
}

// ── Ensure modal HTML exists in the DOM ───────────────────────────────────────
// Called lazily on first preview open; index.html may already contain it.

function _ensureModal() {
  if (document.getElementById('file-preview-modal')) return;
  const el = document.createElement('div');
  el.id        = 'file-preview-modal';
  el.className = 'file-preview-backdrop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `
    <div class="file-preview-dialog">
      <div class="file-preview-header">
        <div class="file-preview-header-info">
          <span id="file-preview-title" class="file-preview-title"></span>
          <span id="file-preview-meta"  class="file-preview-meta"></span>
        </div>
        <div class="file-preview-header-btns">
          <button id="file-preview-download" class="file-preview-dl-btn" title="Download">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download
          </button>
          <button id="file-preview-close" class="file-preview-close-btn" aria-label="Close preview">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
      <div id="file-preview-body" class="file-preview-body"></div>
    </div>`;
  document.body.appendChild(el);
}
