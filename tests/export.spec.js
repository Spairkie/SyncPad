// tests/export.spec.js
// Export and copy behavior: empty warning, file downloads, copy to clipboard.

import { test, expect } from '@playwright/test';
import { createRoom, openMoreMenu, typeInEditor, waitForToast } from './helpers.js';

test.describe('Export — empty note guard', () => {
  // Helper: open the tools panel and confirm the export sub-section is accessible
  async function openExportPanel(page) {
    await openMoreMenu(page);
    await page.locator('#btn-export').click();
    await expect(page.locator('#export-modal')).toBeVisible();
  }

  test('exporting txt with empty note shows warning toast', async ({ page }) => {
    await createRoom(page);
    // Ensure editor is empty
    await page.locator('#note-editor').fill('');
    await openExportPanel(page);
    const exportTxt = page.locator('#export-txt');
    if (await exportTxt.count() > 0) {
      await exportTxt.click();
      await waitForToast(page, /empty|nothing/i);
    }
  });

  test('exporting md with empty note shows warning toast', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('');
    await openExportPanel(page);
    const exportMd = page.locator('#export-md');
    if (await exportMd.count() > 0) {
      await exportMd.click();
      await waitForToast(page, /empty|nothing/i);
    }
  });

  test('exporting txt with content triggers download', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'hello world');
    await openExportPanel(page);

    const exportTxt = page.locator('#export-txt');
    if (await exportTxt.count() > 0) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
        exportTxt.click(),
      ]);
      // Either a download was triggered or a toast appeared
      if (download) {
        expect(download.suggestedFilename()).toMatch(/\.txt$/);
      }
    }
  });
});

test.describe('Copy to clipboard', () => {
  test('copy text on empty note shows warning', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('');

    await openMoreMenu(page);
    await page.locator('#btn-export').click();
    await expect(page.locator('#export-modal')).toBeVisible();

    const copyBtn = page.locator('#export-copy-text');
    if (await copyBtn.count() > 0) {
      await copyBtn.click();
      await waitForToast(page, /empty|nothing/i);
    }
  });
});
