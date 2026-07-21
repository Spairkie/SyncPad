// tests/markdown.spec.js
// Markdown renderer: headings, bold, italic, code, links, checklists, CSV preview.
// These tests validate the renderMarkdown() output through the preview pane.

import { test, expect } from '@playwright/test';
import { createRoom } from './helpers.js';

/**
 * Switch to preview mode and return the preview pane locator.
 */
async function withPreview(page, markdown) {
  await createRoom(page);
  await page.locator('#note-editor').fill(markdown);
  await page.locator('.md-seg-btn[data-mode="preview"]').click();
  return page.locator('#note-preview');
}

test.describe('Markdown preview', () => {
  test('renders H1–H3 headings', async ({ page }) => {
    const preview = await withPreview(page, '# Heading 1\n## Heading 2\n### Heading 3');
    await expect(preview.locator('h1')).toContainText('Heading 1');
    await expect(preview.locator('h2')).toContainText('Heading 2');
    await expect(preview.locator('h3')).toContainText('Heading 3');
  });

  test('renders bold text', async ({ page }) => {
    const preview = await withPreview(page, '**bold word**');
    await expect(preview.locator('strong')).toContainText('bold word');
  });

  test('renders italic text', async ({ page }) => {
    const preview = await withPreview(page, '*italic word*');
    await expect(preview.locator('em')).toContainText('italic word');
  });

  test('renders inline code', async ({ page }) => {
    const preview = await withPreview(page, 'Use `console.log()` here.');
    await expect(preview.locator('code')).toContainText('console.log()');
  });

  test('renders fenced code block', async ({ page }) => {
    const preview = await withPreview(page, '```js\nconst x = 1;\n```');
    await expect(preview.locator('pre code')).toContainText('const x = 1;');
  });

  test('renders unordered list', async ({ page }) => {
    const preview = await withPreview(page, '- Item A\n- Item B\n- Item C');
    const items = preview.locator('ul li');
    expect(await items.count()).toBe(3);
    await expect(items.first()).toContainText('Item A');
  });

  test('renders ordered list', async ({ page }) => {
    const preview = await withPreview(page, '1. First\n2. Second\n3. Third');
    const items = preview.locator('ol li');
    expect(await items.count()).toBe(3);
  });

  test('renders GFM checklist items', async ({ page }) => {
    const preview = await withPreview(page, '- [x] Done\n- [ ] Pending');
    const checkboxes = preview.locator('input[type="checkbox"]');
    expect(await checkboxes.count()).toBe(2);
    const checked   = await checkboxes.nth(0).isChecked();
    const unchecked = await checkboxes.nth(1).isChecked();
    expect(checked).toBe(true);
    expect(unchecked).toBe(false);
  });

  test('renders safe links (https only)', async ({ page }) => {
    const preview = await withPreview(page, '[SyncPad](https://example.com)');
    const link = preview.locator('a');
    await expect(link).toHaveAttribute('href', 'https://example.com');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('does not render javascript: links', async ({ page }) => {
    // eslint-disable-next-line no-script-url
    const preview = await withPreview(page, '[xss](javascript:alert(1))');
    // The raw text should appear but no actual href with javascript:
    const link = preview.locator('a');
    expect(await link.count()).toBe(0);
  });

  test('does not double-escape & in URLs', async ({ page }) => {
    const preview = await withPreview(page, '[Link](https://example.com?a=1&b=2)');
    const link = preview.locator('a');
    // href should contain & not &amp;
    const href = await link.getAttribute('href');
    expect(href).toContain('a=1&b=2');
    expect(href).not.toContain('&amp;');
  });

  test('snake_case does not trigger italic', async ({ page }) => {
    const preview = await withPreview(page, 'foo_bar_baz is a variable name');
    // Should not create <em> elements for the underscores
    expect(await preview.locator('em').count()).toBe(0);
    await expect(preview).toContainText('foo_bar_baz');
  });

  test('renders images with http(s) src', async ({ page }) => {
    const preview = await withPreview(page, '![a picture](https://example.com/pic.png)');
    const img = preview.locator('img');
    await expect(img).toHaveAttribute('src', 'https://example.com/pic.png');
    await expect(img).toHaveAttribute('alt', 'a picture');
  });

  test('blocks javascript: and data: image URLs', async ({ page }) => {
    const preview = await withPreview(page, '![x](javascript:alert(1))\n\n![y](data:text/html,<script>alert(1)</script>)');
    expect(await preview.locator('img').count()).toBe(0);
  });

  test('autolinks bare URLs', async ({ page }) => {
    const preview = await withPreview(page, 'Check out https://example.com for more.');
    const link = preview.locator('a');
    await expect(link).toHaveAttribute('href', 'https://example.com');
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('autolink trims trailing sentence punctuation', async ({ page }) => {
    const preview = await withPreview(page, 'See https://example.com/page. Thanks.');
    const link = preview.locator('a');
    const href = await link.getAttribute('href');
    expect(href).toBe('https://example.com/page');
    await expect(preview).toContainText('page. Thanks.');
  });

  test('autolink does not corrupt plain digit tokens near a URL', async ({ page }) => {
    // Regression check: bare "L2"/numbers must not be mistaken for an
    // internal placeholder and rendered as "undefined".
    const preview = await withPreview(page, 'Our L2 cache, see https://example.com/l2 for details.');
    await expect(preview).not.toContainText('undefined');
    await expect(preview).toContainText('L2 cache');
  });

  test('autolink keeps a balanced closing paren before trailing punctuation', async ({ page }) => {
    // "Function_(mathematics)" is a legitimate balanced path segment — only
    // the sentence period after it should be trimmed, not the ')' itself.
    const preview = await withPreview(page, 'See https://en.wikipedia.org/wiki/Function_(mathematics). Thanks.');
    const link = preview.locator('a');
    const href = await link.getAttribute('href');
    expect(href).toBe('https://en.wikipedia.org/wiki/Function_(mathematics)');
    await expect(preview).toContainText('mathematics). Thanks.');
  });

  test('image src/alt are not corrupted by emphasis markers', async ({ page }) => {
    // Regression check: a URL or alt text containing * must not have its
    // src/alt mangled by the bold/italic rules that run after image parsing.
    const preview = await withPreview(page, '![alt](https://example.com/a*b*.png)\n\n![*emph*](https://example.com/x.png)');
    const imgs = preview.locator('img');
    await expect(imgs.nth(0)).toHaveAttribute('src', 'https://example.com/a*b*.png');
    await expect(imgs.nth(1)).toHaveAttribute('alt', '*emph*');
  });

  test('does not double-wrap a link whose label is itself a URL', async ({ page }) => {
    const preview = await withPreview(page, '[https://example.com](https://example.com)');
    expect(await preview.locator('a').count()).toBe(1);
  });

  test('renders nested unordered lists', async ({ page }) => {
    const preview = await withPreview(page, '- a\n  - a1\n  - a2\n- b');
    const topList = preview.locator('ul').first();
    const topItems = topList.locator(':scope > li');
    expect(await topItems.count()).toBe(2);
    const nestedList = topItems.first().locator('ul');
    expect(await nestedList.locator('li').count()).toBe(2);
  });

  test('renders nested checklist items with independently toggleable checkboxes', async ({ page }) => {
    const preview = await withPreview(page, '- [ ] parent\n  - [x] child');
    const checkboxes = preview.locator('input[type="checkbox"]');
    expect(await checkboxes.count()).toBe(2);
    expect(await checkboxes.nth(0).isChecked()).toBe(false);
    expect(await checkboxes.nth(1).isChecked()).toBe(true);
  });

  test('headings get unique ids for the table of contents', async ({ page }) => {
    const preview = await withPreview(page, '# Intro\n\n## Setup\n\n## Setup\n\n### Deep bit');
    const ids = await preview.locator('h1, h2, h3').evaluateAll((els) => els.map((e) => e.id));
    expect(ids).toEqual(['intro', 'setup', 'setup-1', 'deep-bit']);
  });

  test('a heading whose text matches an auto-generated suffix still gets a unique id', async ({ page }) => {
    // "foo", "foo-1", "foo" must not collide on the real "foo-1" heading.
    const preview = await withPreview(page, '# foo\n\n## foo-1\n\n### foo');
    const ids = await preview.locator('h1, h2, h3').evaluateAll((els) => els.map((e) => e.id));
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(['foo', 'foo-1', 'foo-2']);
  });

  test('headings inside a blockquote share the document-level id registry', async ({ page }) => {
    const preview = await withPreview(page, '# Setup\n\n> # Setup');
    const ids = await preview.locator('h1').evaluateAll((els) => els.map((e) => e.id));
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(['setup', 'setup-1']);
  });

  test('a checkbox after a blockquoted checklist keeps its own toggleable index', async ({ page }) => {
    // Blockquoted checklist items are rendered but toggleChecklistItem()'s
    // source-line scan never counts them (its regex requires the list
    // marker at the very start of the line, not after a `>`). Sharing the
    // render-time checkbox counter across the blockquote boundary used to
    // give every checkbox after a blockquoted one an index the scanner
    // didn't recognize — clicking it silently did nothing and the checkbox
    // reverted on the next render. The counter is deliberately independent
    // per blockquote now, so the *rendered* index can duplicate a quoted
    // item's, but a normal top-level checkbox always matches a real,
    // toggleable source line.
    const preview = await withPreview(page, '> - [ ] quoted\n\n- [ ] normal');
    const checkboxes = preview.locator('input[type="checkbox"]');
    await expect(checkboxes).toHaveCount(2);
    await checkboxes.nth(1).check(); // the second rendered checkbox is "normal"
    // Toggling the real ("normal") checkbox must actually update the source,
    // not silently no-op — verified by round-tripping through the editor.
    await page.locator('.md-seg-btn[data-mode="write"]').click();
    const content = await page.locator('#note-editor').inputValue();
    expect(content).toContain('- [x] normal');
    expect(content).toContain('> - [ ] quoted');
  });
});

test.describe('Table of contents', () => {
  test('shows a Contents nav for notes with 2+ headings, linking to each one', async ({ page }) => {
    const preview = await withPreview(page, '# Intro\n\n## Setup\n\n### Deep bit');
    const toc = preview.locator('.note-toc');
    await expect(toc).toBeVisible();
    const links = toc.locator('a');
    expect(await links.count()).toBe(3);
    await expect(links.nth(2)).toHaveAttribute('href', '#deep-bit');
  });

  test('omits the Contents nav for notes with fewer than 2 headings', async ({ page }) => {
    const preview = await withPreview(page, '# Just one heading\n\nSome text.');
    await expect(preview.locator('.note-toc')).toHaveCount(0);
  });
});
