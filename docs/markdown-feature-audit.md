# Markdown feature audit

SyncPad's Markdown renderer (`src/markdown.js`) targets **GitHub Flavored
Markdown (GFM)** as its reference flavor — it's the most widely recognized
extended Markdown spec (GitHub, GitLab, Reddit, Discourse, and most chat/doc
tools either implement it directly or something very close to it), and its
feature set fits naturally within `markdown.js`'s hard constraint of never
passing through raw HTML (see `CLAUDE.md` — "No raw HTML in the Markdown
renderer"). Most GFM features are pure text syntax; the handful of common
"hacks"-page features that inherently require raw HTML in virtually every
implementation (`<center>`, inline `style=`, HTML comments, `<video>`) are
listed below as out of scope for that reason.

This audit checks the 33 features on the Markdown Guide's basic, extended,
and hacks pages against SyncPad's actual behavior.

## Supported

| Feature | Notes |
|---|---|
| Headings | `#` – `######`, auto-generates an anchor id |
| Paragraphs | blank-line separated |
| Line Breaks | two trailing spaces → `<br>` |
| Emphasis | `**bold**`, `*italic*`, `__bold__`, `_italic_` |
| Blockquotes | `>` |
| Lists | ordered/unordered, nested by indentation |
| Code | inline `` `x` ``, fenced ` ``` ` blocks |
| Horizontal Rules | `---`, `***`, `___` |
| Links | `[text](url)` — http(s)/mailto only |
| Images | `![alt](url)` — http(s) only, plus an internal `syncpad-file:` scheme for pasted attachments |
| Escaping Characters | `\*`, `\_`, `\[`, etc. — standard CommonMark punctuation set |
| Tables | GFM `| Col |` syntax |
| Table Formatting (alignment) | `:---`, `---:`, `:---:` in the separator row |
| Fenced Code Blocks | ` ```lang ` |
| Footnotes | `text[^id]` + `[^id]: note` — GFM added this in 2021 |
| Heading IDs | auto-generated from heading text; no custom-id syntax (see below) |
| Strikethrough | `~~text~~` |
| Task Lists | `- [ ]` / `- [x]`, with a live "n/m done" progress badge |
| Highlight | `==text==` — not core GFM, but common (Obsidian, Typora) and already shipped |
| Automatic URL Linking | bare `https://…` autolinks |
| Disabling Automatic URL Linking | wrap in backtick code span — code spans are extracted before autolinking runs |
| Admonitions | GFM alerts — `> [!NOTE]`/`[!TIP]`/`[!IMPORTANT]`/`[!WARNING]`/`[!CAUTION]` |
| Table of Contents | Typora-style `[TOC]` marker |
| Link Targets | not per-link syntax — SyncPad opens every external link in a new tab (`target="_blank"`) by consistent site-wide policy instead |

## Deliberately not supported

| Feature | Why |
|---|---|
| HTML | `markdown.js` intentionally strips raw HTML for XSS safety (`CLAUDE.md`) — this is a hard constraint, not an oversight |
| Center | every common implementation needs raw HTML (`<center>`/`align=`) to do this in plain Markdown |
| Color | same — needs inline `style=` |
| Comments | `<!-- -->` is raw HTML |
| Videos | needs an `<iframe>`/`<video>` embed; no text-only Markdown syntax covers this |
| Definition Lists | a Markdown Extra/PHP Markdown Extra feature, not GFM |
| Subscript / Superscript | Pandoc/kramdown extensions, not GFM |
| Underline | no flavor has a clean non-HTML syntax for this (`__x__` is bold in GFM); introducing a non-standard marker would surprise anyone pasting content from elsewhere |
| Custom Heading IDs (`{#id}`) | Pandoc/Markdown Extra syntax, not GFM — auto-generated ids already cover the actual use case (linkable headings) |
| Emoji shortcodes (`:smile:`) | popular on GitHub's UI but not part of the GFM spec itself; would need a sizeable shortcode→Unicode data table for a large win. Genuine Unicode emoji (😀) already renders fine as plain text with no special handling needed |
| Symbols (typographic replacement) | SyncPad already does this at typing time via the opt-in Smart Punctuation editor feature; doing it again at render time would double-process already-converted text |
| Indent (Tab) → code block | CommonMark's 4-space-indent rule is ambiguous against this renderer's indent-based list-nesting logic; fenced code blocks already cover the same need unambiguously |
| Image Size / Image Captions | not in GFM; needs either an attribute-syntax extension (Kramdown-style `{width=…}`) or raw HTML |

## Both renderers

SyncPad has two rendering surfaces:
- `markdown.js` — the classic parser, used for read-only-viewer preview,
  HTML/print export, and the reference behavior this audit describes.
- `src/live-editor.js` — the CodeMirror 6 "Live" mode surface, which uses
  `@codemirror/lang-markdown`'s own GFM-aware syntax tree plus custom
  decorations for the seamless-preview effect (hiding syntax markers away
  from the caret). It parses everything `markdown.js` does structurally
  (including tables, task lists, and strikethrough, which are built into
  `@codemirror/lang-markdown`'s base language), but new constructs added
  here (alerts, footnotes) don't yet have matching custom decorations there
  — they still edit and save correctly, they just don't get the extra
  visual polish (colored alert box, numbered footnote markers) until viewed
  through the classic renderer (read-only view, export, or Preview-adjacent
  paths). Worth a follow-up pass if these see real usage.
