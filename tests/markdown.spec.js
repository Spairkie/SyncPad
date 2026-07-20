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
});
