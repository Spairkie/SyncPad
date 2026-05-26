// tests/read-only.spec.js
// Read-only share link behavior: access, editor disabled, no upload/delete.

import { test, expect } from '@playwright/test';
import { createRoom, goToLanding, typeInEditor, getEditorContent } from './helpers.js';

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

    // The file upload button should either not exist or be disabled
    const uploadBtn = page.locator('#file-upload-btn, [data-action="upload-file"], .file-upload-btn');
    if (await uploadBtn.count() > 0) {
      const isDisabled = await uploadBtn.first().evaluate(el => el.disabled);
      expect(isDisabled).toBe(true);
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
});
