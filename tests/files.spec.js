// tests/files.spec.js
// File attachments: multi-file upload, bulk select/delete, and download
// filename correctness (the browser must save the file under its original
// name, not the sanitized/timestamp-prefixed Storage path).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { createRoom, goToLanding, openPanel, waitForToast } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

test.describe('File uploads', () => {
  test('uploading multiple files at once adds all of them to the list', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'files');

    const input = page.locator('#file-input');
    await expect(input).toHaveAttribute('multiple', '');
    await input.setInputFiles([fixture('sample-a.txt'), fixture('sample-b.txt')]);

    await waitForToast(page, /uploaded/i);
    await expect(page.locator('.file-item', { hasText: 'sample-a.txt' })).toBeVisible();
    await expect(page.locator('.file-item', { hasText: 'sample-b.txt' })).toBeVisible();
  });

  test('bulk select mode can select and delete multiple files', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'files');

    await page.locator('#file-input').setInputFiles([fixture('sample-a.txt'), fixture('sample-b.txt')]);
    await waitForToast(page, /uploaded/i);

    await page.locator('#files-select-toggle').click();
    await expect(page.locator('#files-bulk-bar')).not.toHaveClass(/hidden/);

    const checkboxes = page.locator('.file-select-cb');
    await expect(checkboxes).toHaveCount(2);
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();
    await expect(page.locator('#files-bulk-count')).toHaveText('2 selected');

    await page.locator('#files-bulk-delete').click();
    await page.locator('#sp-confirm-ok').click();

    await waitForToast(page, /deleted/i);
    await expect(page.locator('#files-empty')).not.toHaveClass(/hidden/);
  });

  test('downloading a file saves it under its original filename', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'files');

    const originalName = 'My Report (Final).txt';
    await page.locator('#file-input').setInputFiles([fixture(originalName)]);
    await waitForToast(page, /uploaded/i);

    const fileItem = page.locator('.file-item', { hasText: originalName });
    await expect(fileItem).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      fileItem.locator('.file-action-btn.download').click(),
    ]);

    expect(download.suggestedFilename()).toBe(originalName);
  });

  test('copying a file link puts a URL on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await createRoom(page);
    await openPanel(page, 'files');

    await page.locator('#file-input').setInputFiles([fixture('sample-a.txt')]);
    await waitForToast(page, /uploaded/i);

    const fileItem = page.locator('.file-item', { hasText: 'sample-a.txt' });
    await fileItem.locator('.file-action-btn.copy-link').click();
    await waitForToast(page, /link copied/i);

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toMatch(/^https?:\/\//);
  });
});

// ── Copy-link rendering (no Supabase dependency) ────────────────────────────────

test.describe('File list copy-link action', () => {
  test('renders a copy-link button per file that invokes onCopyLink', async ({ page }) => {
    await goToLanding(page);
    const result = await page.evaluate(async () => {
      const ui = await import('/SyncPad/src/ui.js');
      document.getElementById('files-panel').classList.add('open');
      let copied = null;
      ui.renderFilesList(
        [{ id: 1, filename: 'report.pdf', mime_type: 'application/pdf', file_size: 1024, uploaded_at: new Date().toISOString() }],
        async () => {}, async () => {},
        { canDownload: true, canDelete: true, onPreview: async () => {}, onCopyLink: async (f) => { copied = f.filename; } },
      );
      document.querySelector('.file-action-btn.copy-link').click();
      await new Promise((r) => setTimeout(r, 0));
      return { buttonCount: document.querySelectorAll('.file-action-btn').length, copied };
    });
    expect(result.buttonCount).toBe(4); // preview, copy-link, download, delete
    expect(result.copied).toBe('report.pdf');
  });

  test('omits the copy-link button when downloads are disabled', async ({ page }) => {
    await goToLanding(page);
    const hasCopyLinkBtn = await page.evaluate(async () => {
      const ui = await import('/SyncPad/src/ui.js');
      document.getElementById('files-panel').classList.add('open');
      ui.renderFilesList(
        [{ id: 1, filename: 'report.pdf', mime_type: 'application/pdf', file_size: 1024, uploaded_at: new Date().toISOString() }],
        async () => {}, async () => {},
        { canDownload: false, canDelete: true, onCopyLink: async () => {} },
      );
      return !!document.querySelector('.file-action-btn.copy-link');
    });
    expect(hasCopyLinkBtn).toBe(false);
  });
});
