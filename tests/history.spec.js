// tests/history.spec.js
// Version history: opening the panel, the empty state, and the
// snapshot-before-Clear-note → Restore round trip.

import { test, expect } from '@playwright/test';
import { createRoom, typeInEditor, waitForToast, getShareUrl } from './helpers.js';

/** Open the Tools panel, then the Version History panel from inside it. */
async function openHistoryPanel(page) {
  const toolsPanel = page.locator('#tools-panel');
  if (!await toolsPanel.evaluate(el => el.classList.contains('open'))) {
    await page.locator('#btn-more').click();
    await expect(page.locator('#more-dropdown')).toHaveClass(/open/, { timeout: 2000 });
    await page.locator('#btn-tools').click();
    await expect(toolsPanel).toHaveClass(/open/, { timeout: 3000 });
  }
  await page.locator('#tool-history').click();
  await page.waitForSelector('#history-panel.open', { timeout: 5000 });
}

test.describe('Version history', () => {
  test('opening the panel on a fresh room shows the empty state', async ({ page }) => {
    await createRoom(page);
    await openHistoryPanel(page);
    await expect(page.locator('#history-empty')).toBeVisible();
    await expect(page.locator('#history-list .history-item')).toHaveCount(0);
  });

  test('clearing the note snapshots the prior content, which can then be restored', async ({ page }) => {
    await createRoom(page);
    const original = 'Content that must survive a Clear.';
    await typeInEditor(page, original);

    // Clear note — snapshotBeforeDestructiveChange() fires unthrottled, so
    // this is the fast, reliable way to get a revision without waiting on
    // the 2-minute periodic snapshot throttle.
    const toolsPanel = page.locator('#tools-panel');
    await page.locator('#btn-more').click();
    await expect(page.locator('#more-dropdown')).toHaveClass(/open/, { timeout: 2000 });
    await page.locator('#btn-tools').click();
    await expect(toolsPanel).toHaveClass(/open/, { timeout: 3000 });
    await page.locator('#tool-clear').click();
    await page.waitForSelector('#sp-confirm-modal.visible', { timeout: 5000 });
    await page.locator('#sp-confirm-ok').click();
    await waitForToast(page, 'cleared');

    expect(await page.locator('#note-editor').inputValue()).toBe('');

    await openHistoryPanel(page);
    const item = page.locator('#history-list .history-item').first();
    await expect(item).toBeVisible();
    await expect(item.locator('.history-preview')).toContainText('Content that must survive a Clear');

    await item.locator('.history-restore-btn').click();
    await page.waitForSelector('#sp-confirm-modal.visible', { timeout: 5000 });
    await page.locator('#sp-confirm-ok').click();
    await waitForToast(page, 'restored');

    expect(await page.locator('#note-editor').inputValue()).toBe(original);
  });

  test('the scrubber slider appears once a revision exists, defaulting to "Now"', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'First version of the note.');

    const toolsPanel = page.locator('#tools-panel');
    await page.locator('#btn-more').click();
    await expect(page.locator('#more-dropdown')).toHaveClass(/open/, { timeout: 2000 });
    await page.locator('#btn-tools').click();
    await expect(toolsPanel).toHaveClass(/open/, { timeout: 3000 });
    await page.locator('#tool-clear').click();
    await page.waitForSelector('#sp-confirm-modal.visible', { timeout: 5000 });
    await page.locator('#sp-confirm-ok').click();
    await waitForToast(page, 'cleared');

    await typeInEditor(page, 'Second version, after the clear.');
    await openHistoryPanel(page);

    const scrubber = page.locator('#history-scrubber');
    await expect(scrubber).toBeVisible();
    await expect(page.locator('#history-scrubber-label')).toHaveText('Now');
    await expect(page.locator('#history-scrubber-preview')).toHaveText('Second version, after the clear.');
    await expect(page.locator('#history-scrubber-restore-btn')).toBeDisabled();

    // Drag to the oldest position (min of the range).
    const slider = page.locator('#history-slider');
    await slider.evaluate((el) => { el.value = el.min; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await expect(page.locator('#history-scrubber-label')).not.toHaveText('Now');
    await expect(page.locator('#history-scrubber-preview')).toContainText('First version of the note.');
    await expect(page.locator('#history-scrubber-restore-btn')).toBeEnabled();
  });

  test('the scrubber is hidden on a fresh room with no revisions yet', async ({ page }) => {
    await createRoom(page);
    await openHistoryPanel(page);
    await expect(page.locator('#history-scrubber')).toHaveClass(/hidden/);
  });

  test('Restore is hidden in read-only mode', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'some content');
    await page.waitForTimeout(1200); // let the debounced save land before reload

    // Simulate read-only by visiting the room's own read-only share link,
    // rather than poking internal state directly.
    const readonlyUrl = await getShareUrl(page, 'readonly');
    await page.goto(readonlyUrl);
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });

    await openHistoryPanel(page);
    await expect(page.locator('.history-restore-btn')).toHaveCount(0);
  });
});
