// tests/templates-custom.spec.js
// Tests for custom template CRUD — save, rename (showPrompt), delete (showConfirm).

import { test, expect } from '@playwright/test';
import { createRoom, typeInEditor, openSettingsPanel, waitForModal } from './helpers.js';

/** Open the templates modal via the tools panel. */
async function openTemplatesModal(page) {
  // Open tools panel
  const toolsPanel = page.locator('#tools-panel');
  if (!await toolsPanel.evaluate(el => el.classList.contains('open'))) {
    const moreBtn = page.locator('#btn-more');
    const dropdown = page.locator('#more-dropdown');
    await moreBtn.click();
    await expect(dropdown).toHaveClass(/open/, { timeout: 2000 });
    await page.locator('#btn-tools').click();
    await expect(toolsPanel).toHaveClass(/open/, { timeout: 3000 });
  }
  // Click the Templates button in the tools panel
  await page.locator('#btn-templates').click();
  await page.waitForSelector('#templates-modal.visible', { timeout: 5000 });
}

/** Switch to the "My Templates" tab inside the modal. */
async function switchToCustomTab(page) {
  await page.locator('.tmpl-tab[data-tab="custom"]').click();
}

test.describe('Custom templates (save / rename / delete)', () => {
  test('save current note as custom template via showPrompt', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'Custom template body content');

    // Trigger save-as-template button
    await openTemplatesModal(page);
    // showPrompt appears when "Save current note as template" is clicked
    const saveBtn = page.locator('#btn-save-as-template');
    await saveBtn.click();

    // Wait for the showPrompt modal
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    await expect(page.locator('#sp-prompt-message')).toContainText('Template name');

    // Fill the name and confirm
    await page.locator('#sp-prompt-input').fill('My Custom Template');
    await page.evaluate(() => document.getElementById('sp-prompt-ok').click());

    // After saving, the modal re-opens or shows a toast
    await page.waitForSelector('#templates-modal.visible', { timeout: 5000 });

    // Switch to custom tab and verify the template appears
    await switchToCustomTab(page);
    await expect(page.locator('#templates-list')).toContainText('My Custom Template', { timeout: 3000 });
  });

  test('rename custom template uses showPrompt with current name pre-filled', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'Rename test content');

    // Save a template first
    await openTemplatesModal(page);
    await page.locator('#btn-save-as-template').click();
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    await page.locator('#sp-prompt-input').fill('Template To Rename');
    await page.evaluate(() => document.getElementById('sp-prompt-ok').click());
    await page.waitForSelector('#templates-modal.visible', { timeout: 5000 });

    // Switch to custom tab and click rename
    await switchToCustomTab(page);
    const renameBtn = page.locator('.custom-tmpl-btn').first();
    await renameBtn.click();

    // showPrompt should appear pre-filled with current name
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    const inputValue = await page.locator('#sp-prompt-input').inputValue();
    expect(inputValue).toBe('Template To Rename');

    // Type a new name
    await page.locator('#sp-prompt-input').fill('Renamed Template');
    await page.evaluate(() => document.getElementById('sp-prompt-ok').click());

    // Template list should show the new name
    await expect(page.locator('#templates-list')).toContainText('Renamed Template', { timeout: 3000 });
    await expect(page.locator('#templates-list')).not.toContainText('Template To Rename');
  });

  test('cancel rename leaves template name unchanged', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'Cancel rename content');

    // Save a template
    await openTemplatesModal(page);
    await page.locator('#btn-save-as-template').click();
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    await page.locator('#sp-prompt-input').fill('Cancel Rename Test');
    await page.evaluate(() => document.getElementById('sp-prompt-ok').click());
    await page.waitForSelector('#templates-modal.visible', { timeout: 5000 });

    // Click rename then cancel
    await switchToCustomTab(page);
    const renameBtn = page.locator('.custom-tmpl-btn').first();
    await renameBtn.click();
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    await page.evaluate(() => document.getElementById('sp-prompt-cancel').click());

    // Name should be unchanged
    await expect(page.locator('#templates-list')).toContainText('Cancel Rename Test', { timeout: 2000 });
  });

  test('delete custom template shows danger showConfirm', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'Delete test content');

    // Save a template
    await openTemplatesModal(page);
    await page.locator('#btn-save-as-template').click();
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    await page.locator('#sp-prompt-input').fill('Template To Delete');
    await page.evaluate(() => document.getElementById('sp-prompt-ok').click());
    await page.waitForSelector('#templates-modal.visible', { timeout: 5000 });

    // Click delete button (the danger custom-tmpl-btn)
    await switchToCustomTab(page);
    const deleteBtn = page.locator('.custom-tmpl-btn.danger').first();
    await deleteBtn.click();

    // showConfirm should appear (danger mode focuses Cancel)
    await page.waitForSelector('#sp-confirm-modal.visible', { timeout: 5000 });
    await expect(page.locator('#sp-confirm-message')).toContainText('Delete template');
    // Danger mode: Cancel is focused by default
    await expect(page.locator('#sp-confirm-cancel')).toBeFocused();

    // Confirm deletion
    await page.evaluate(() => document.getElementById('sp-confirm-ok').click());

    // Template should be gone
    await expect(page.locator('#templates-list')).not.toContainText('Template To Delete', { timeout: 3000 });
  });

  test('cancel delete preserves the template', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'Preserve content');

    // Save a template
    await openTemplatesModal(page);
    await page.locator('#btn-save-as-template').click();
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    await page.locator('#sp-prompt-input').fill('Preserved Template');
    await page.evaluate(() => document.getElementById('sp-prompt-ok').click());
    await page.waitForSelector('#templates-modal.visible', { timeout: 5000 });

    // Click delete then cancel
    await switchToCustomTab(page);
    const deleteBtn = page.locator('.custom-tmpl-btn.danger').first();
    await deleteBtn.click();
    await page.waitForSelector('#sp-confirm-modal.visible', { timeout: 5000 });
    await page.evaluate(() => document.getElementById('sp-confirm-cancel').click());

    // Template should still be there
    await expect(page.locator('#templates-list')).toContainText('Preserved Template', { timeout: 2000 });
  });

  test('save-as-template is hidden in read-only mode', async ({ page }) => {
    await createRoom(page);
    const roomUrl = page.url();
    await page.goto(roomUrl + '?mode=read');
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15000 }).catch(() => {});
    // The save-as-template button has data-readonly-hide and should not be visible
    await expect(page.locator('#btn-save-as-template')).not.toBeVisible();
  });
});
