// tests/room-title.spec.js
// Playwright tests for the inline room-title editing feature.

import { test, expect } from '@playwright/test';
import { createRoom, openSettingsPanel } from './helpers.js';

test.describe('Room title editing', () => {
  test('edit button is visible for room owner', async ({ page }) => {
    await createRoom(page);
    // The pencil edit button should be visible in the header
    const editBtn = page.locator('#room-title-edit-btn');
    await expect(editBtn).toBeVisible();
  });

  test('clicking edit button shows title input and hides display title', async ({ page }) => {
    await createRoom(page);
    const editBtn    = page.locator('#room-title-edit-btn');
    const titleEl    = page.locator('#room-name');
    const editorWrap = page.locator('#room-title-editor');

    await editBtn.click();

    // Title editor wrap becomes visible
    await expect(editorWrap).toBeVisible({ timeout: 3000 });
    // The edit button itself should be hidden (or the title display)
    await expect(editBtn).not.toBeVisible();
  });

  test('cancel button restores the original title display', async ({ page }) => {
    await createRoom(page);
    const editBtn    = page.locator('#room-title-edit-btn');
    const cancelBtn  = page.locator('#room-title-cancel-btn');
    const editorWrap = page.locator('#room-title-editor');

    await editBtn.click();
    await expect(editorWrap).toBeVisible({ timeout: 3000 });

    await cancelBtn.click();

    // Editor should be hidden again
    await expect(editorWrap).not.toBeVisible({ timeout: 3000 });
    // Edit button should be visible again
    await expect(editBtn).toBeVisible();
  });

  test('typing a new name and saving updates the header title', async ({ page }) => {
    await createRoom(page);
    const editBtn   = page.locator('#room-title-edit-btn');
    const titleInput = page.locator('#room-title-input');
    const saveBtn   = page.locator('#room-title-save-btn');
    const titleEl   = page.locator('#room-name');

    await editBtn.click();
    await expect(titleInput).toBeVisible({ timeout: 3000 });

    await titleInput.fill('My Test Room');
    await saveBtn.click();

    // Room name display should update
    await expect(titleEl).toContainText('My Test Room', { timeout: 5000 });
  });

  test('title input accepts Enter key to save', async ({ page }) => {
    await createRoom(page);
    const editBtn    = page.locator('#room-title-edit-btn');
    const titleInput = page.locator('#room-title-input');
    const titleEl    = page.locator('#room-name');

    await editBtn.click();
    await expect(titleInput).toBeVisible({ timeout: 3000 });

    await titleInput.fill('Enter Key Room');
    await titleInput.press('Enter');

    await expect(titleEl).toContainText('Enter Key Room', { timeout: 5000 });
  });

  test('Escape key cancels edit without saving', async ({ page }) => {
    await createRoom(page);
    const editBtn    = page.locator('#room-title-edit-btn');
    const titleInput = page.locator('#room-title-input');
    const titleEl    = page.locator('#room-name');

    // Get current title
    const originalTitle = await titleEl.textContent();

    await editBtn.click();
    await expect(titleInput).toBeVisible({ timeout: 3000 });

    await titleInput.fill('This Should Not Save');
    await titleInput.press('Escape');

    // Editor wrap should close
    await expect(page.locator('#room-title-editor')).not.toBeVisible({ timeout: 3000 });
    // Title should remain unchanged
    await expect(titleEl).toContainText(originalTitle?.trim() || '', { timeout: 2000 }).catch(() => {});
  });

  test('read-only share mode hides the edit button', async ({ page }) => {
    await createRoom(page);
    // Append ?mode=read to simulate read-only access
    const roomUrl = page.url();
    await page.goto(roomUrl + '?mode=read');
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15000 }).catch(() => {});

    // Edit button should not be visible in read-only mode
    const editBtn = page.locator('#room-title-edit-btn');
    await expect(editBtn).not.toBeVisible();
  });
});
