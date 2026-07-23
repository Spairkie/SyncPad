// tests/command-palette.spec.js
// Command palette: open/close, filtering, keyboard navigation, and the
// Ctrl+K context split between "insert link" (in the editor) and "open
// palette" (everywhere else).

import { test, expect } from '@playwright/test';
import { createRoom, typeInEditor } from './helpers.js';

async function openPaletteViaShortcut(page) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k');
  await expect(page.locator('#command-palette-modal')).toHaveClass(/visible/);
}

test.describe('Command palette', () => {
  test('Ctrl+K outside the editor opens the palette with a full command list', async ({ page }) => {
    await createRoom(page);
    await openPaletteViaShortcut(page);
    await expect(page.locator('#command-palette-input')).toBeFocused();
    const count = await page.locator('.command-palette-item').count();
    expect(count).toBeGreaterThan(10);
  });

  test('More menu button opens the palette', async ({ page }) => {
    await createRoom(page);
    await page.locator('#btn-more').click();
    await expect(page.locator('#more-dropdown')).toHaveClass(/open/);
    await page.locator('#btn-command-palette').click();
    await expect(page.locator('#command-palette-modal')).toHaveClass(/visible/);
  });

  test('typing filters the command list', async ({ page }) => {
    await createRoom(page);
    await openPaletteViaShortcut(page);
    await page.locator('#command-palette-input').fill('split');
    const labels = await page.locator('.command-palette-item-label').allTextContents();
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label.toLowerCase()).toContain('split');
  });

  test('a query matching nothing shows the empty state', async ({ page }) => {
    await createRoom(page);
    await openPaletteViaShortcut(page);
    await page.locator('#command-palette-input').fill('zzzznomatch');
    await expect(page.locator('.command-palette-empty')).toBeVisible();
  });

  test('Escape closes the palette', async ({ page }) => {
    await createRoom(page);
    await openPaletteViaShortcut(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#command-palette-modal')).not.toHaveClass(/visible/);
  });

  test('clicking the backdrop closes the palette', async ({ page }) => {
    await createRoom(page);
    await openPaletteViaShortcut(page);
    await page.locator('#command-palette-modal').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#command-palette-modal')).not.toHaveClass(/visible/);
  });

  test('Enter runs the active (first) filtered command and closes the palette', async ({ page }) => {
    await createRoom(page);
    await openPaletteViaShortcut(page);
    await page.locator('#command-palette-input').fill('split');
    await page.keyboard.press('Enter');
    await expect(page.locator('#command-palette-modal')).not.toHaveClass(/visible/);
    await expect(page.locator('.editor-wrap')).toHaveClass(/mode-split/);
  });

  test('ArrowDown/ArrowUp move the active selection', async ({ page }) => {
    await createRoom(page);
    await openPaletteViaShortcut(page);
    const firstActiveId = await page.locator('.command-palette-item.active').getAttribute('id');
    await page.keyboard.press('ArrowDown');
    const secondActiveId = await page.locator('.command-palette-item.active').getAttribute('id');
    expect(secondActiveId).not.toBe(firstActiveId);
    await page.keyboard.press('ArrowUp');
    const backToFirstId = await page.locator('.command-palette-item.active').getAttribute('id');
    expect(backToFirstId).toBe(firstActiveId);
  });

  test('Ctrl+K inside the editor with a selection inserts a link instead of opening the palette', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'hello world');
    const editor = page.locator('#note-editor');
    await editor.evaluate((el) => { el.selectionStart = 0; el.selectionEnd = 5; });
    await editor.focus();
    await page.keyboard.press('Control+k');
    await expect(editor).toHaveValue('[hello](url) world');
    await expect(page.locator('#command-palette-modal')).not.toHaveClass(/visible/);
  });

  test('theme commands are listed and clicking one applies the theme', async ({ page }) => {
    await createRoom(page);
    await openPaletteViaShortcut(page);
    await page.locator('#command-palette-input').fill('Midnight Blue');
    await page.locator('.command-palette-item-label', { hasText: 'Midnight Blue' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight-blue');
  });
});
