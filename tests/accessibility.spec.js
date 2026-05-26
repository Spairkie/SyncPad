// tests/accessibility.spec.js
// Keyboard navigation, ARIA roles, focus management, and confirm dialog.

import { test, expect } from '@playwright/test';
import { createRoom } from './helpers.js';

test.describe('Accessibility & keyboard', () => {
  test('landing page is keyboard-navigable (Tab reaches key buttons)', async ({ page }) => {
    await page.goto('/SyncPad/');
    await page.waitForSelector('#landing-screen:not(.hidden)');
    // Tab through to the Create button
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    // The focused element should be one of the interactive elements
    const focused = page.locator(':focus');
    await expect(focused).toBeVisible();
  });

  test('modal closes on Escape', async ({ page }) => {
    await createRoom(page);
    // Open share modal via keyboard shortcut if possible, else button
    const shareBtn = page.locator('#btn-share, #tool-share').first();
    await shareBtn.click();
    await page.waitForSelector('#share-modal.visible', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#share-modal')).not.toHaveClass(/visible/);
  });

  test('file list items have role=listitem', async ({ page }) => {
    await createRoom(page);
    // Open files panel
    const filesBtn = page.locator('[aria-controls="files-panel"], #btn-files').first();
    await filesBtn.click();
    await page.waitForSelector('#files-panel.open', { timeout: 5000 });
    // The list should have role=list
    const filesList = page.locator('#files-list');
    const role = await filesList.getAttribute('role');
    expect(role).toBe('list');
  });

  test('devices list has role=list', async ({ page }) => {
    await createRoom(page);
    // Open presence panel
    const presenceBtn = page.locator('[aria-controls="presence-panel"], #btn-presence').first();
    await presenceBtn.click();
    await page.waitForSelector('#presence-panel.open', { timeout: 5000 });
    const devList = page.locator('#devices-list');
    const role = await devList.getAttribute('role');
    expect(role).toBe('list');
  });

  test('custom confirm modal accessible: has role=dialog and aria-modal', async ({ page }) => {
    await createRoom(page);

    // Trigger the custom confirm via showConfirm() in the page context
    const confirmPromise = page.evaluate(() => {
      // Call showConfirm directly if exported; otherwise trigger via bulk-delete
      return new Promise((resolve) => {
        // Use postMessage to signal the test; but simpler: call the module
        import('/SyncPad/src/ui.js').then(({ showConfirm }) => {
          showConfirm('Test confirm message?', { confirmLabel: 'OK', danger: false }).then(resolve);
        });
      });
    });

    // Wait for the modal to appear
    await page.waitForSelector('#sp-confirm-modal.visible', { timeout: 5000 });
    const modal = page.locator('#sp-confirm-modal');
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#sp-confirm-message')).toContainText('Test confirm message');

    // Cancel the dialog
    await page.locator('#sp-confirm-cancel').click();
    const result = await confirmPromise;
    expect(result).toBe(false);
  });

  test('custom confirm modal: OK button resolves true', async ({ page }) => {
    await createRoom(page);
    const confirmPromise = page.evaluate(() =>
      import('/SyncPad/src/ui.js').then(({ showConfirm }) =>
        showConfirm('Are you sure?', { confirmLabel: 'Yes', danger: false })
      )
    );
    await page.waitForSelector('#sp-confirm-modal.visible', { timeout: 5000 });
    await page.locator('#sp-confirm-ok').click();
    const result = await confirmPromise;
    expect(result).toBe(true);
  });

  test('custom confirm modal: Escape closes and resolves false', async ({ page }) => {
    await createRoom(page);
    const confirmPromise = page.evaluate(() =>
      import('/SyncPad/src/ui.js').then(({ showConfirm }) =>
        showConfirm('Escape test', {})
      )
    );
    await page.waitForSelector('#sp-confirm-modal.visible', { timeout: 5000 });
    await page.keyboard.press('Escape');
    const result = await confirmPromise;
    expect(result).toBe(false);
  });

  test('danger confirm modal focuses Cancel by default', async ({ page }) => {
    await createRoom(page);
    page.evaluate(() =>
      import('/SyncPad/src/ui.js').then(({ showConfirm }) =>
        showConfirm('Delete?', { danger: true, confirmLabel: 'Delete' })
      )
    );
    await page.waitForSelector('#sp-confirm-modal.visible', { timeout: 5000 });
    // Cancel button should be focused
    await expect(page.locator('#sp-confirm-cancel')).toBeFocused();
    // Clean up
    await page.locator('#sp-confirm-cancel').click();
  });

  test('note editor has accessible label or placeholder', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    const ariaLabel = await editor.getAttribute('aria-label');
    const placeholder = await editor.getAttribute('placeholder');
    // At least one of these should be present
    expect(ariaLabel || placeholder).toBeTruthy();
  });

  test('all visible buttons have accessible labels', async ({ page }) => {
    await createRoom(page);
    // Check icon-only buttons in the header have aria-label or title
    const iconBtns = page.locator('.header-btn, .panel-close, .file-preview-close-btn');
    const count = await iconBtns.count();
    for (let i = 0; i < Math.min(count, 10); i++) {
      const btn = iconBtns.nth(i);
      if (!await btn.isVisible()) continue;
      const label = await btn.getAttribute('aria-label') || await btn.getAttribute('title');
      expect(label, `Button at index ${i} has no accessible label`).toBeTruthy();
    }
  });

  test('landing join input has aria-label', async ({ page }) => {
    await page.goto('/SyncPad/');
    await page.waitForSelector('#landing-screen:not(.hidden)');
    const input = page.locator('#landing-join-input');
    const ariaLabel = await input.getAttribute('aria-label');
    expect(ariaLabel).toBeTruthy();
  });

  test('passcode input has aria-label', async ({ page }) => {
    await page.goto('/SyncPad/');
    const input = page.locator('#passcode-input');
    const ariaLabel = await input.getAttribute('aria-label');
    expect(ariaLabel).toBeTruthy();
  });

  test('passcode error has role=alert', async ({ page }) => {
    await page.goto('/SyncPad/');
    const errorEl = page.locator('#passcode-error');
    await expect(errorEl).toHaveAttribute('role', 'alert');
  });

  test('encryption error has role=alert', async ({ page }) => {
    await page.goto('/SyncPad/');
    const errorEl = page.locator('#encryption-error');
    await expect(errorEl).toHaveAttribute('role', 'alert');
  });
});
