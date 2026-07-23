// tests/cursor-chat.spec.js
// Cursor chat: an ephemeral, Figma-style message anchored to the current
// caret position. Works on every surface — the CM6 live view (Preview/
// Split) via its own coordsAtPos(), and the plain Write-mode textarea via
// the mirror-div caret measurement in ui.js (getCaretViewportCoords()).

import { test, expect } from '@playwright/test';
import { createRoom, setEditorMode, typeInEditor } from './helpers.js';

test.describe('Cursor chat', () => {
  test('clicking the trigger in Write mode opens a composer input', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'Some text to place a caret in.');
    await page.locator('#btn-cursor-chat').click();
    await expect(page.locator('.cursor-chat-composer input')).toBeVisible();
  });

  test('sending a message in Write mode shows a positioned local bubble', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'Some text to place a caret in.');
    await page.locator('#btn-cursor-chat').click();
    const input = page.locator('.cursor-chat-composer input');
    await input.fill('hello from write mode');
    await input.press('Enter');

    const bubble = page.locator('.cursor-chat-bubble');
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText('hello from write mode');
    const box = await bubble.boundingBox();
    expect(box?.x).toBeGreaterThan(0);
    expect(box?.y).toBeGreaterThan(0);
  });

  test('switching mode clears any open composer', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'Some text.');
    await page.locator('#btn-cursor-chat').click();
    await expect(page.locator('.cursor-chat-composer')).toHaveCount(1);

    await setEditorMode(page, 'preview');
    await expect(page.locator('.cursor-chat-composer')).toHaveCount(0);
  });

  test('clicking the trigger in Preview mode opens a composer input', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '# Title\n\nSome text to place a caret in.');
    await setEditorMode(page, 'preview');
    await page.locator('#btn-cursor-chat').click();
    await expect(page.locator('.cursor-chat-composer input')).toBeVisible();
  });

  test('Escape closes the composer without sending anything', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '# Title\n\nSome text.');
    await setEditorMode(page, 'preview');
    await page.locator('#btn-cursor-chat').click();
    const input = page.locator('.cursor-chat-composer input');
    await input.fill('never sent');
    await input.press('Escape');
    await expect(page.locator('.cursor-chat-composer')).toHaveCount(0);
    await expect(page.locator('.cursor-chat-bubble')).toHaveCount(0);
  });

  test('pressing Enter sends the message and shows a local fading bubble', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '# Title\n\nSome text to place a caret in.');
    await setEditorMode(page, 'preview');
    await page.locator('#btn-cursor-chat').click();
    const input = page.locator('.cursor-chat-composer input');
    await input.fill('hello room');
    await input.press('Enter');

    await expect(page.locator('.cursor-chat-composer')).toHaveCount(0);
    const bubble = page.locator('.cursor-chat-bubble');
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText('hello room');
  });

  test('switching back to Write mode clears any open composer', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '# Title\n\nSome text.');
    await setEditorMode(page, 'preview');
    await page.locator('#btn-cursor-chat').click();
    await expect(page.locator('.cursor-chat-composer')).toHaveCount(1);

    await setEditorMode(page, 'write');
    await expect(page.locator('.cursor-chat-composer')).toHaveCount(0);
  });

  test('the keyboard shortcut (Ctrl+Shift+/) opens the composer in Preview mode', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '# Title\n\nSome text.');
    await setEditorMode(page, 'preview');
    await page.keyboard.press('Control+Shift+/');
    await expect(page.locator('.cursor-chat-composer input')).toBeVisible();
  });
});
