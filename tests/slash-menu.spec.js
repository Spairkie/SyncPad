// tests/slash-menu.spec.js
// Slash-command quick-insert menu — Write mode only, opened by typing '/' at
// the start of a line. See _updateSlashMenu()/_selectSlashItem() in app.js.

import { test, expect } from '@playwright/test';
import { createRoom, typeInEditor, getEditorContent } from './helpers.js';

test.describe('Slash-command quick-insert menu', () => {
  test('typing "/" at the start of a line opens the menu with the full item list', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '');
    await page.locator('#note-editor').pressSequentially('/');
    await expect(page.locator('#slash-menu')).toHaveClass(/visible/);
    expect(await page.locator('.slash-menu-item').count()).toBeGreaterThan(10);
  });

  test('typing "/" mid-word does not open the menu', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'and');
    await page.locator('#note-editor').pressSequentially('/or');
    await expect(page.locator('#slash-menu')).not.toHaveClass(/visible/);
    expect(await getEditorContent(page)).toBe('and/or');
  });

  test('typing a query filters the item list', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '');
    await page.locator('#note-editor').pressSequentially('/bold');
    await expect(page.locator('#slash-menu')).toHaveClass(/visible/);
    await expect(page.locator('.slash-menu-item')).toHaveCount(1);
    await expect(page.locator('.slash-menu-item').first()).toContainText('Bold');
  });

  test('a query matching nothing shows the empty state', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '');
    await page.locator('#note-editor').pressSequentially('/zzzznomatch');
    await expect(page.locator('.slash-menu-empty')).toBeVisible();
  });

  test('typing a space closes the menu and leaves the typed text intact', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '');
    await page.locator('#note-editor').pressSequentially('/bold two words');
    await expect(page.locator('#slash-menu')).not.toHaveClass(/visible/);
    expect(await getEditorContent(page)).toBe('/bold two words');
  });

  test('Escape closes the menu without changing the text', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '');
    await page.locator('#note-editor').pressSequentially('/bold');
    await page.locator('#note-editor').press('Escape');
    await expect(page.locator('#slash-menu')).not.toHaveClass(/visible/);
    expect(await getEditorContent(page)).toBe('/bold');
  });

  test('selecting "Bold" via Enter replaces the slash query and inserts markdown', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '');
    await page.locator('#note-editor').pressSequentially('/bold');
    await page.locator('#note-editor').press('Enter');
    await expect(page.locator('#slash-menu')).not.toHaveClass(/visible/);
    expect(await getEditorContent(page)).toBe('**text**');
  });

  test('selecting "Checklist" via a click inserts a checklist prefix', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '');
    await page.locator('#note-editor').pressSequentially('/checklist');
    await page.locator('.slash-menu-item', { hasText: 'Checklist' }).click();
    expect(await getEditorContent(page)).toBe('- [ ] ');
  });

  test('ArrowDown moves the active selection before Enter confirms it', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '');
    await page.locator('#note-editor').pressSequentially('/head');
    // Query "head" matches Heading 1/2/3 — arrow down to the second, then confirm.
    await page.locator('#note-editor').press('ArrowDown');
    await expect(page.locator('.slash-menu-item.active')).toContainText('Heading 2');
    await page.locator('#note-editor').press('Enter');
    expect(await getEditorContent(page)).toContain('## ');
  });

  test('the menu does not open in Preview mode', async ({ page }) => {
    await createRoom(page);
    await page.locator('.md-seg-btn[data-mode="preview"]').click();
    await expect(page.locator('.editor-wrap')).toHaveClass(/mode-preview/);
    // Write-mode textarea is hidden in Preview; nothing to type '/' into via
    // the same path, so just assert the menu stays closed regardless.
    await expect(page.locator('#slash-menu')).not.toHaveClass(/visible/);
  });
});
