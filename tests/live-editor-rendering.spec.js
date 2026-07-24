// tests/live-editor-rendering.spec.js
// The CM6-backed Live/Split surface (live-editor.js) is a separate rendering
// path from markdown.js's static renderMarkdown() — it decorates the same
// plain-markdown source directly rather than producing HTML, so features the
// static renderer supports aren't automatically covered here. GFM tables,
// GitHub-style alerts, and footnotes previously had no decoration at all in
// this surface (rendered as literal, unstyled markdown syntax); this file
// covers the fix.

import { test, expect } from '@playwright/test';
import { createRoom, typeInEditor, setEditorMode } from './helpers.js';

test.describe('Live/Split surface rendering', () => {
  test('GFM table renders as a real <table>, not literal pipe text', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '| Left | Center | Right |\n|:---|:---:|---:|\n| a | b | c |\n');
    await setEditorMode(page, 'preview');
    // Cursor stays at the top of the doc after typing via fill(); move it
    // away so the table isn't in its "being edited, show raw source" state.
    await page.keyboard.press('Control+End');

    const table = page.locator('.note-live table.cm-md-table');
    await expect(table).toBeVisible();
    await expect(table.locator('th').nth(0)).toHaveText('Left');
    await expect(table.locator('td').nth(0)).toHaveText('a');
  });

  test('GFM alert renders as a coloured box with an icon+label, not raw "[!NOTE]"', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '> [!NOTE]\n> Useful information.\n');
    await setEditorMode(page, 'preview');
    await page.keyboard.press('Control+End');

    const alertLine = page.locator('.note-live .cm-md-alert-note');
    await expect(alertLine.first()).toBeVisible();
    await expect(page.locator('.note-live .cm-md-alert-title-note')).toHaveText('ℹ️ Note');
    await expect(page.locator('.note-live')).not.toContainText('[!NOTE]');
  });

  test('all five GFM alert kinds get their own class', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page,
      '> [!NOTE]\n> a\n\n> [!TIP]\n> b\n\n> [!IMPORTANT]\n> c\n\n> [!WARNING]\n> d\n\n> [!CAUTION]\n> e\n',
    );
    await setEditorMode(page, 'preview');
    await page.keyboard.press('Control+End');

    for (const kind of ['note', 'tip', 'important', 'warning', 'caution']) {
      await expect(page.locator(`.note-live .cm-md-alert-${kind}`).first()).toBeVisible();
    }
  });

  test('footnote reference renders as a superscript marker, not literal "[^1]"', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'A sentence with a footnote.[^1]\n\n[^1]: The footnote text.\n');
    await setEditorMode(page, 'preview');
    await page.keyboard.press('Control+Home');

    await expect(page.locator('.note-live sup.cm-md-footnote-ref')).toHaveText('1');
    await expect(page.locator('.note-live')).not.toContainText('[^1]');
  });

  test('clicking into a rendered table reveals its raw markdown for editing', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '| A | B |\n|---|---|\n| 1 | 2 |\n');
    await setEditorMode(page, 'preview');
    await page.keyboard.press('Control+End');
    await expect(page.locator('.note-live table.cm-md-table')).toBeVisible();

    await page.keyboard.press('Control+Home');
    await expect(page.locator('.note-live table.cm-md-table')).toHaveCount(0);
    await expect(page.locator('.note-live')).toContainText('| A | B |');
  });

  test('reference-style link labels fold away like inline links do, but a definition keeps its label visible', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page,
      'Text.\n\n[Reference link][ref1]\n\n[Reference link, collapsed][]\n\n' +
      '[ref1]: https://example.com "Title"\n[Reference link, collapsed]: https://example.com\n',
    );
    await setEditorMode(page, 'preview');
    await page.keyboard.press('Control+Home');

    const live = page.locator('.note-live');
    await expect(live).not.toContainText('[ref1]');
    await expect(live).toContainText('Reference link');
    // The definition lines are a different node shape (LinkReference, not a
    // Link usage) and must keep their own "[id]" label visible.
    await expect(live).toContainText('[ref1]: https://example.com "Title"');
    await expect(live).toContainText('[Reference link, collapsed]: https://example.com');
  });
});
