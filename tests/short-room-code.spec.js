// tests/short-room-code.spec.js
// Short, human-typeable/speakable room codes — an alternate spelling of the
// editable room link, generated on demand in the share modal.

import { test, expect } from '@playwright/test';
import { closePanels, createRoom } from './helpers.js';

test.describe('Short room codes', () => {
  test('the share modal shows a generated code for the room owner', async ({ page }) => {
    await createRoom(page);
    await closePanels(page);
    await page.locator('#btn-share').click();
    const codeField = page.locator('#share-code-text');
    // 6 characters from the short-code alphabet (2-9, A-Z minus I/L/O/U).
    await expect(codeField).toHaveValue(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/, { timeout: 15_000 });
  });

  test('copying the code uses the clipboard button', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await createRoom(page);
    await closePanels(page);
    await page.locator('#btn-share').click();
    const codeField = page.locator('#share-code-text');
    await expect(codeField).toHaveValue(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/, { timeout: 15_000 });
    const code = await codeField.inputValue();

    await page.locator('#share-code-copy').click();
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(code);
  });

  test('the code section is hidden in a read-only session', async ({ page }) => {
    const roomId = await createRoom(page);
    await page.goto(`/SyncPad/${roomId}?mode=read`);
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    await closePanels(page);
    await page.locator('#btn-share').click();
    await expect(page.locator('#share-modal')).toBeVisible();
    await expect(page.locator('#share-code-section')).toHaveClass(/hidden/);
  });
});
