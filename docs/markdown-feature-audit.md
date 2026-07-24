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

This audit checks the ~38 features on the Markdown Guide's basic, extended,
and hacks pages against SyncPad's actual behavior — verified by running
`renderMarkdown()` directly against each page's own example syntax (not just
inspecting the source), so this table reflects real output, not intent.

## Supported

| Feature | Notes |
|---|---|
| Headings | `#` – `######`, auto-generates an anchor id (ATX style only — see Setext below) |
| Paragraphs | blank-line separated |
| Line Breaks | two trailing spaces → `<br>` |
| Emphasis | `**bold**`, `*italic*`, `__bold__`, `_italic_` |
| Blockquotes | `>`, including nesting and other block elements inside |
| Lists | ordered/unordered, nested by indentation |
| Code | inline `` `x` ``, fenced ` ``` ` blocks |
| Horizontal Rules | `---`, `***`, `___` |
| Links | `[text](url "title")` — http(s)/mailto only; title is optional |
| Images | `![alt](url "title")` — http(s) only, plus an internal `syncpad-file:` scheme for pasted attachments; title is optional |
| Reference-style Links | `[text][id]` / collapsed `[text][]` + `[id]: url "title"` — single-line definitions only. An id defined but never referenced renders nothing, which doubles as support for the common `[comment]: <> (text)` invisible-comment convention |
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
| Angle-bracket Autolinks | `<https://…>`, `<mailto:x@y.com>`, and bare `<x@y.com>` — CommonMark's explicit autolink syntax |
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
| Comments (`<!-- -->`) | raw HTML — out of scope per the XSS policy above. The non-HTML `[comment]: <> (text)` reference-link convention *does* work (see Reference-style Links above) — it's a legitimate Markdown construct, not a raw-HTML pass-through |
| Videos | needs an `<iframe>`/`<video>` embed; no text-only Markdown syntax covers this |
| Definition Lists | a Markdown Extra/PHP Markdown Extra feature, not GFM |
| Subscript / Superscript | Pandoc/kramdown extensions, not GFM |
| Underline | no flavor has a clean non-HTML syntax for this (`__x__` is bold in GFM); introducing a non-standard marker would surprise anyone pasting content from elsewhere |
| Custom Heading IDs (`{#id}`) | Pandoc/Markdown Extra syntax, not GFM — auto-generated ids already cover the actual use case (linkable headings) |
| Setext Headings (`Text\n===`, `Text\n---`) | basic CommonMark, but a legacy alternate style to the `#`/`##` ATX form SyncPad already implements (and the toolbar's H1/H2/H3 buttons insert). The `---` underline form is also genuinely ambiguous with horizontal rules — CommonMark itself resolves this with a lookback rule this renderer's single-pass block scanner doesn't have. Low real-world value for a quick-notepad tool given ATX already covers headings; revisit only if requested |
| Emoji shortcodes (`:smile:`) | popular on GitHub's UI but not part of the GFM spec itself; would need a sizeable shortcode→Unicode data table for a large win. Genuine Unicode emoji (😀) already renders fine as plain text with no special handling needed |
| Symbols (typographic replacement) | SyncPad already does this at typing time via the opt-in Smart Punctuation editor feature; doing it again at render time would double-process already-converted text |
| Indent (Tab) → code block | CommonMark's 4-space-indent rule is ambiguous against this renderer's indent-based list-nesting logic; fenced code blocks already cover the same need unambiguously |
| Image Size / Image Captions | not in GFM; needs either an attribute-syntax extension (Kramdown-style `{width=…}`) or raw HTML |

## Both renderers

SyncPad has two rendering surfaces:
- `markdown.js` — the classic parser, used for read-only-viewer preview
  (when the live surface fails to mount), HTML/print export, copy-as-HTML,
  and the reference behavior this audit describes.
- `src/live-editor.js` — the CodeMirror 6 "Live" mode surface, which
  Preview and Split modes actually show whenever it mounts successfully
  (virtually always, in practice — the classic renderer above is mostly a
  fallback + export-time code path, not something most users see day to
  day). It uses `@codemirror/lang-markdown`'s own GFM-aware syntax tree plus
  custom decorations for the seamless-preview effect (hiding syntax markers
  away from the caret). As of Phase 30, tables, GFM alerts, and footnotes
  all have matching custom decorations here too — previously (reported
  directly: "a lot of the features are broken/do not work as they should")
  tables rendered as literal unstyled pipe text, alerts as a plain
  blockquote showing the raw `[!NOTE]` marker, and footnotes as literal
  `[^1]` bracket-caret text, none of which had been caught because this
  audit's "parses everything markdown.js does structurally" claim was true
  of the syntax tree but didn't mean any of it actually *rendered* —
  parsing and decorating are different steps, and only the latter existed
  for headings/emphasis/lists/links/images/blockquotes/code/highlight/`[TOC]`/
  checklists before this fix. Confirmed via a byte-for-byte diff against a
  prior golden HTML export of this repo's own markdown feature-test document
  (`syncpad-markdown-test.md`) for the classic renderer, then a targeted CM6
  mount harness for the live surface specifically. Footnotes still don't get
  a relocated "Footnotes" section the way the classic renderer's read-only
  output does (just an inline superscript + a labeled definition line) —
  moving text out of document order isn't appropriate for an editable
  surface the way it is for a read-only render.
