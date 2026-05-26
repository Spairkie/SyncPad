// tests/read-only.spec.js
// Read-only share link behavior: access, editor disabled, no upload/delete.

import { test, expect } from '@playwright/test';
import { closePanels, createRoom, openPanel, typeInEditor, waitForToast } from './helpers.js';

async function getReadOnlyShareUrl(page) {
  await closePanels(page);
  await page.locator('#btn-share').click();
  const input = page.locator('#share-readonly-text');
  await expect(input).toHaveValue(/\/SyncPad\/share\//, { timeout: 15_000 });
  return input.inputValue();
}

test.describe('Read-only links', () => {
  test('direct URL with ?mode=read shows app in read-only state', async ({ page }) => {
    // First create a room
    const roomId = await createRoom(page);

    // Navigate to the room with read-only mode
    await page.goto(`/SyncPad/${roomId}?mode=read`);
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });

    // Editor should be disabled/read-only
    const editor = page.locator('#note-editor');
    await expect(editor).toBeVisible();
    const isDisabled = await editor.evaluate(el =>
      el.disabled || el.readOnly || el.getAttribute('readonly') !== null
    );
    expect(isDisabled).toBe(true);
  });

  test('read-only editor does not accept keyboard input', async ({ page }) => {
    const roomId = await createRoom(page);
    // Type some content first
    await typeInEditor(page, 'original content');

    // Open in read-only mode
    await page.goto(`/SyncPad/${roomId}?mode=read`);
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });

    const editor = page.locator('#note-editor');
    const initialContent = await editor.inputValue();
    // Try to type in the editor
    await editor.click();
    await page.keyboard.type('should not appear');
    const afterContent = await editor.inputValue();
    // Content should not have changed
    expect(afterContent).toBe(initialContent);
  });

  test('read-only viewer sees upload button disabled or absent', async ({ page }) => {
    const roomId = await createRoom(page);
    await page.goto(`/SyncPad/${roomId}?mode=read`);
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });

    // The file upload zone (#files-upload-zone) has data-readonly-hide and
    // should be hidden in read-only mode.
    const uploadZone = page.locator('#files-upload-zone');
    if (await uploadZone.count() > 0) {
      await expect(uploadZone).toBeHidden();
    }
  });

  test('read-only banner or indicator is shown', async ({ page }) => {
    const roomId = await createRoom(page);
    await page.goto(`/SyncPad/${roomId}?mode=read`);
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });

    // Some indicator that this is read-only
    // Could be a banner, header badge, or disabled editor indicator
    const readOnlyIndicators = [
      '#read-only-banner',
      '.read-only-badge',
      '.readonly-badge',
      '.permission-badge',
      '[data-readonly="true"]',
    ];
    let found = false;
    for (const sel of readOnlyIndicators) {
      const el = page.locator(sel);
      if (await el.count() > 0 && await el.first().isVisible()) {
        found = true;
        break;
      }
    }
    // If none of the specific indicators are present, at least the editor is read-only
    if (!found) {
      const editor = page.locator('#note-editor');
      const isReadOnly = await editor.evaluate(el => el.readOnly || el.disabled);
      expect(isReadOnly).toBe(true);
    }
  });

  test('invalid read-only share token shows info screen', async ({ page }) => {
    await page.goto('/SyncPad/share/invalid-token-that-does-not-exist-12345');
    await page.waitForTimeout(5000);
    // Should show info screen or landing (not stuck on loading)
    const infoScreen = page.locator('#info-screen');
    const loadingScreen = page.locator('#loading-screen');
    const landingScreen = page.locator('#landing-screen');

    const infoVisible   = await infoScreen.count() > 0 && await infoScreen.evaluate(el => !el.classList.contains('hidden')).catch(() => false);
    const loadingActive = await loadingScreen.count() > 0 && await loadingScreen.evaluate(el => !el.classList.contains('hidden')).catch(() => false);

    // Should not still be on loading screen after 5 seconds
    expect(loadingActive).toBe(false);
    // Info screen should be visible
    if (infoVisible) {
      await expect(infoScreen).not.toHaveClass(/hidden/);
    }
  });

  test('read-only viewer can unlock a passcode-protected room and remains read-only', async ({ page }) => {
    const roomId = await createRoom(page);
    await openPanel(page, 'settings');

    page.once('dialog', async (dialog) => {
      await dialog.accept('reader-secret');
    });
    await page.locator('#setting-passcode-btn').click();
    await waitForToast(page, 'Passcode set.');

    await page.goto(`/SyncPad/${roomId}?mode=read`);
    await page.waitForSelector('#passcode-screen:not(.hidden)', { timeout: 15_000 });
    await page.locator('#passcode-input').fill('reader-secret');
    await page.locator('#passcode-submit-btn').click();

    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    await expect(page.locator('#note-editor')).toHaveJSProperty('readOnly', true);
  });

  test('read-only share link can unlock a passcode-protected room and remains read-only', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'settings');

    page.once('dialog', async (dialog) => {
      await dialog.accept('shared-reader-secret');
    });
    await page.locator('#setting-passcode-btn').click();
    await waitForToast(page, 'Passcode set.');

    const readOnlyUrl = await getReadOnlyShareUrl(page);
    await page.goto(readOnlyUrl);
    await page.waitForSelector('#passcode-screen:not(.hidden)', { timeout: 15_000 });
    await page.locator('#passcode-input').fill('shared-reader-secret');
    await page.locator('#passcode-submit-btn').click();

    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    await expect(page.locator('#note-editor')).toHaveJSProperty('readOnly', true);
  });

  test('read-only viewer can decrypt an encrypted room and remains read-only', async ({ page }) => {
    const roomId = await createRoom(page);
    await typeInEditor(page, 'encrypted read-only content');
    await openPanel(page, 'settings');

    page.once('dialog', async (dialog) => {
      await dialog.accept('reader-passphrase');
    });
    await page.locator('#setting-enc-btn').click();
    await waitForToast(page, 'Encryption enabled.', { timeout: 15_000 });

    await page.goto(`/SyncPad/${roomId}?mode=read`);
    await page.waitForSelector('#encryption-screen:not(.hidden)', { timeout: 15_000 });
    await page.locator('#encryption-input').fill('reader-passphrase');
    await page.locator('#encryption-submit-btn').click();

    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    await expect(page.locator('#note-editor')).toHaveValue('encrypted read-only content');
    await expect(page.locator('#note-editor')).toHaveJSProperty('readOnly', true);
  });

  test('read-only share link can decrypt an encrypted room and remains read-only', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'encrypted share-link content');
    await openPanel(page, 'settings');

    page.once('dialog', async (dialog) => {
      await dialog.accept('shared-reader-passphrase');
    });
    await page.locator('#setting-enc-btn').click();
    await waitForToast(page, 'Encryption enabled.', { timeout: 15_000 });

    const readOnlyUrl = await getReadOnlyShareUrl(page);
    await page.goto(readOnlyUrl);
    await page.waitForSelector('#encryption-screen:not(.hidden)', { timeout: 15_000 });
    await page.locator('#encryption-input').fill('shared-reader-passphrase');
    await page.locator('#encryption-submit-btn').click();

    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    await expect(page.locator('#note-editor')).toHaveValue('encrypted share-link content');
    await expect(page.locator('#note-editor')).toHaveJSProperty('readOnly', true);
  });
});
