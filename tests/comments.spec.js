// tests/comments.spec.js
// Ephemeral comments anchored to a text range — opt-in, cascade away with
// the room (see supabase/migrations/0003_room_comments.sql), no independent lifetime.

import { test, expect } from '@playwright/test';
import { createRoom, typeInEditor, getShareUrl } from './helpers.js';

/** Open the Tools panel, then the Comments panel from inside it. */
async function openCommentsPanel(page) {
  const toolsPanel = page.locator('#tools-panel');
  if (!await toolsPanel.evaluate(el => el.classList.contains('open'))) {
    await page.locator('#btn-more').click();
    await expect(page.locator('#more-dropdown')).toHaveClass(/open/, { timeout: 2000 });
    await page.locator('#btn-tools').click();
    await expect(toolsPanel).toHaveClass(/open/, { timeout: 3000 });
  }
  await page.locator('#tool-comments').click();
  await page.waitForSelector('#comments-panel.open', { timeout: 5000 });
}

test.describe('Comments', () => {
  test('opening the panel with no selection shows the hint, not the composer', async ({ page }) => {
    await createRoom(page);
    await openCommentsPanel(page);
    await expect(page.locator('#comment-composer-hint')).toBeVisible();
  });

  test('selecting text in Write mode shows the composer with an anchor preview', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'Some text to comment on.');
    // Select "text" (chars 5-9) via the textarea's own selection API.
    await page.locator('#note-editor').evaluate((el) => {
      el.focus();
      el.setSelectionRange(5, 9);
    });
    await openCommentsPanel(page);
    await expect(page.locator('#comment-composer')).toBeVisible();
    await expect(page.locator('#comment-composer-anchor')).toContainText('text');
  });

  test('comments panel is unavailable in read-only mode', async ({ page }) => {
    await createRoom(page);
    const readonlyUrl = await getShareUrl(page, 'readonly');
    await page.goto(readonlyUrl);
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    await openCommentsPanel(page);
    // data-readonly-hide keeps both the composer and the hint out of a
    // read-only viewer's panel — they can read comments, not add them.
    await expect(page.locator('#comment-composer')).toBeHidden();
    await expect(page.locator('#comment-composer-hint')).toBeHidden();
  });

  test('adding a comment shows a margin dot at its anchor, which jumps back to it on click', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'Some text to comment on, right here.');
    await page.locator('#note-editor').evaluate((el) => {
      el.focus();
      el.setSelectionRange(5, 9); // "text"
    });
    await openCommentsPanel(page);
    await page.locator('#comment-composer-input').fill('margin dot test');
    await page.locator('#comment-composer-btn').click();
    await page.waitForTimeout(500); // _refreshComments() + margin recompute

    await expect(page.locator('.comment-dot')).toHaveCount(1);

    // Move the selection/caret elsewhere so a click on the dot is a
    // detectable change, then click it and confirm it re-selects the anchor.
    await page.locator('#note-editor').evaluate((el) => el.setSelectionRange(0, 0));
    await page.locator('.comment-dot').first().click();
    await page.waitForTimeout(200);
    const sel = await page.locator('#note-editor').evaluate((el) => ({ start: el.selectionStart, end: el.selectionEnd }));
    expect(sel).toEqual({ start: 5, end: 9 });
  });
});
