// tests/editor.spec.js
// Core editor: typing, word count, read-only badge, monospace toggle,
// split/preview mode, export actions.

import { test, expect } from '@playwright/test';
import { createRoom, typeInEditor, getEditorContent, waitForToast } from './helpers.js';

test.describe('Editor', () => {
  test('displays the text area and accepts input', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await expect(editor).toBeVisible();
    await editor.fill('Hello SyncPad!');
    expect(await editor.inputValue()).toBe('Hello SyncPad!');
  });

  test('word count updates as user types', async ({ page }) => {
    await createRoom(page);
    const wc = page.locator('#word-count, #toolbar-word-count').first();
    await page.locator('#note-editor').fill('one two three');
    await expect(wc).toContainText('3 word');
  });

  test('word count shows 0 words on empty editor', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await editor.fill('');
    const wc = page.locator('#word-count, #toolbar-word-count').first();
    await expect(wc).toContainText('0 word');
  });

  test('preview mode hides editor and shows preview pane', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('# Preview heading');
    // Click the Preview segment button
    await page.locator('.md-seg-btn[data-mode="preview"]').click();
    await expect(page.locator('#note-editor')).toBeHidden();
    await expect(page.locator('#note-preview')).toBeVisible();
    await expect(page.locator('#note-preview')).toContainText('Preview heading');
  });

  test('split mode shows both editor and preview', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('**bold** text');
    await page.locator('.md-seg-btn[data-mode="split"]').click();
    await expect(page.locator('#note-editor')).toBeVisible();
    await expect(page.locator('#note-preview')).toBeVisible();
    await expect(page.locator('#note-preview')).toContainText('bold');
  });

  test('returning to write mode hides preview', async ({ page }) => {
    await createRoom(page);
    await page.locator('.md-seg-btn[data-mode="preview"]').click();
    await expect(page.locator('#note-preview')).toBeVisible();
    await page.locator('.md-seg-btn[data-mode="write"]').click();
    await expect(page.locator('#note-preview')).toBeHidden();
    await expect(page.locator('#note-editor')).toBeVisible();
  });

  test('export modal opens when export button clicked', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('export me');
    // Open export modal (button might be in more dropdown)
    const exportBtn = page.locator('#btn-export');
    if (await exportBtn.isVisible()) {
      await exportBtn.click();
    } else {
      await page.locator('#btn-more').click();
      await page.locator('#btn-export').click();
    }
    await expect(page.locator('#export-modal')).toBeVisible({ timeout: 3000 });
  });

  test('export modal shows warning toast on empty note', async ({ page }) => {
    await createRoom(page);
    // Clear editor
    await page.locator('#note-editor').fill('');
    const exportBtn = page.locator('#btn-export');
    if (await exportBtn.isVisible()) {
      await exportBtn.click();
    } else {
      await page.locator('#btn-more').click();
      await page.locator('#btn-export').click();
    }
    // Click export .txt button in modal
    await page.locator('#export-txt').click();
    await waitForToast(page, 'empty');
  });
});
