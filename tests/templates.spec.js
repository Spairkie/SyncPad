// tests/templates.spec.js
// Templates modal: open, tab switching, insert, search/filter,
// save as template, custom template delete.

import { test, expect } from '@playwright/test';
import { createRoom, waitForToast } from './helpers.js';

async function openTemplatesModal(page) {
  // Try direct button first; may be in "more" dropdown
  const directBtn = page.locator('#tool-templates');
  if (await directBtn.isVisible()) {
    await directBtn.click();
  } else {
    await page.locator('#btn-more, .header-btn[title*="ore"]').first().click();
    await page.locator('#tool-templates').click();
  }
  await expect(page.locator('#templates-modal')).toBeVisible({ timeout: 5000 });
}

test.describe('Templates modal', () => {
  test('opens from tools panel', async ({ page }) => {
    await createRoom(page);
    // Open tools panel
    await page.locator('#btn-tools, [aria-controls="tools-panel"]').first().click();
    await page.waitForSelector('#tools-panel.open', { timeout: 5000 });
    await openTemplatesModal(page);
    await expect(page.locator('#templates-modal')).toBeVisible();
  });

  test('shows built-in templates in Insert tab', async ({ page }) => {
    await createRoom(page);
    await openTemplatesModal(page);
    // The insert tab should be active by default
    const buttons = page.locator('.template-btn');
    expect(await buttons.count()).toBeGreaterThanOrEqual(7);
  });

  test('has at least 13 built-in templates after Phase 3', async ({ page }) => {
    await createRoom(page);
    await openTemplatesModal(page);
    const buttons = page.locator('.template-btn');
    expect(await buttons.count()).toBeGreaterThanOrEqual(13);
  });

  test('search filter reduces visible templates', async ({ page }) => {
    await createRoom(page);
    await openTemplatesModal(page);
    const allCount = await page.locator('.template-btn').count();
    await page.locator('.tmpl-search-input').fill('meeting');
    // Should show fewer buttons
    await page.waitForTimeout(100);
    const filteredCount = await page.locator('.template-btn').count();
    expect(filteredCount).toBeLessThan(allCount);
    expect(filteredCount).toBeGreaterThanOrEqual(1);
  });

  test('search shows "No templates match" for garbage input', async ({ page }) => {
    await createRoom(page);
    await openTemplatesModal(page);
    await page.locator('.tmpl-search-input').fill('zzz_no_match_xyz');
    await page.waitForTimeout(100);
    await expect(page.locator('.tmpl-no-results')).toBeVisible();
  });

  test('hovering a template shows preview', async ({ page }) => {
    await createRoom(page);
    await openTemplatesModal(page);
    const firstBtn = page.locator('.template-btn').first();
    await firstBtn.hover();
    // Preview column should now show content (not the placeholder)
    const preview = page.locator('.tmpl-preview-body');
    await expect(preview).toBeVisible();
  });

  test('My Templates tab shows empty state when no customs exist', async ({ page }) => {
    await createRoom(page);
    // Clear any persisted custom templates
    await page.evaluate(() => localStorage.removeItem('syncpad_custom_templates'));
    await openTemplatesModal(page);
    await page.locator('.tmpl-tab[data-tab="custom"]').click();
    await expect(page.locator('.empty-state-title')).toContainText('No custom templates');
  });

  test('save note as template and see it in My Templates', async ({ page }) => {
    await createRoom(page);
    await page.evaluate(() => localStorage.removeItem('syncpad_custom_templates'));

    // Type some content
    await page.locator('#note-editor').fill('This is my test template content');

    // Open templates modal and click Save
    await openTemplatesModal(page);
    // Fill in the prompt — we can't control window.prompt easily, use evaluate
    page.on('dialog', async (dialog) => {
      await dialog.accept('My Test Template');
    });
    await page.locator('#btn-save-as-template').click();

    await waitForToast(page, 'Saved as template');

    // Reopen modal and check My Templates tab
    await openTemplatesModal(page);
    await page.locator('.tmpl-tab[data-tab="custom"]').click();
    await expect(page.locator('.custom-template-label').filter({ hasText: 'My Test Template' })).toBeVisible();
  });

  test('inserting a template into empty editor uses replace mode', async ({ page }) => {
    await createRoom(page);
    await page.evaluate(() => localStorage.removeItem('syncpad_custom_templates'));
    // Empty editor
    await page.locator('#note-editor').fill('');
    await openTemplatesModal(page);
    // Click the first non-blank template
    const buttons = page.locator('.template-btn');
    // Find Checklist button
    const checklistBtn = page.locator('.template-btn').filter({ hasText: 'Checklist' });
    await checklistBtn.click();
    // Should close modal and insert content
    await expect(page.locator('#templates-modal')).toBeHidden({ timeout: 3000 });
    const content = await page.locator('#note-editor').inputValue();
    expect(content.trim().length).toBeGreaterThan(0);
  });

  test('closes with close button', async ({ page }) => {
    await createRoom(page);
    await openTemplatesModal(page);
    await page.locator('.templates-close').first().click();
    await expect(page.locator('#templates-modal')).toBeHidden({ timeout: 3000 });
  });
});
