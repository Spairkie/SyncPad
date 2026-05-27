// tests/settings.spec.js
// Settings panel: opening, expiration validation (5-min minimum),
// theme switching, file sort.

import { test, expect } from '@playwright/test';
import { createRoom, openPanel, openMoreMenu, waitForToast } from './helpers.js';

async function openSettingsPanel(page) {
  await openMoreMenu(page);
  await page.locator('#btn-settings').click();
  await page.waitForSelector('#settings-panel.open', { timeout: 5000 });
}

test.describe('Settings panel', () => {
  test('opens and shows room settings', async ({ page }) => {
    await createRoom(page);
    await openSettingsPanel(page);
    await expect(page.locator('#settings-panel')).toBeVisible();
    // Should show some setting rows
    await expect(page.locator('#setting-passcode-btn')).toBeVisible();
  });

  test('expiration preset buttons are visible', async ({ page }) => {
    await createRoom(page);
    await openSettingsPanel(page);
    // Expand expiration controls
    await page.locator('#setting-exp-btn').click();
    const expControls = page.locator('#setting-exp-controls');
    await expect(expControls).toBeVisible();
    // Should have at least one preset button
    await expect(page.locator('[data-exp-preset]').first()).toBeVisible();
  });

  test('30-second expiry preset is removed (B-2)', async ({ page }) => {
    await createRoom(page);
    await openSettingsPanel(page);
    await page.locator('#setting-exp-btn').click();
    // The 30s preset chip must not exist — it was below the 5-minute minimum
    await expect(page.locator('[data-exp-preset="30s"]')).toHaveCount(0);
  });

  test('10-minute expiry preset is first and active by default (B-2)', async ({ page }) => {
    await createRoom(page);
    await openSettingsPanel(page);
    await page.locator('#setting-exp-btn').click();
    // First preset chip should be the 10m one
    const firstChip = page.locator('[data-exp-preset]').first();
    await expect(firstChip).toHaveAttribute('data-exp-preset', '10m');
    await expect(firstChip).toHaveClass(/is-active/);
  });

  test('custom expiration rejects values below 5 minutes', async ({ page }) => {
    await createRoom(page);
    await openSettingsPanel(page);
    await page.locator('#setting-exp-btn').click();
    // Select custom preset
    await page.locator('[data-exp-preset="custom"]').click();
    // Enter 30 seconds (less than 5 min = 300s)
    await page.locator('#exp-custom-value').fill('30');
    await page.locator('#exp-custom-unit').selectOption('s');
    await page.locator('#setting-exp-apply-btn').click();
    // Should show error
    const errorEl = page.locator('#setting-exp-error');
    await expect(errorEl).toBeVisible();
    await expect(errorEl).toContainText('5 minutes');
  });

  test('custom expiration accepts values of 5 minutes', async ({ page }) => {
    await createRoom(page);
    await openSettingsPanel(page);
    await page.locator('#setting-exp-btn').click();
    await page.locator('[data-exp-preset="custom"]').click();
    await page.locator('#exp-custom-value').fill('5');
    await page.locator('#exp-custom-unit').selectOption('m');
    // Error should not be shown (we don't submit to DB in unit test context,
    // but validation should pass — the apply btn click either succeeds or
    // shows a DB-level error, not the validation error).
    const errorEl = page.locator('#setting-exp-error');
    // Either hidden or doesn't contain the "5 minutes" message
    await page.locator('#setting-exp-apply-btn').click();
    // If error is visible, it should NOT be about the 5-minute minimum
    if (await errorEl.isVisible()) {
      const text = await errorEl.textContent();
      expect(text).not.toContain('5 minutes');
    }
  });

  test('custom expiration rejects 4 minutes', async ({ page }) => {
    await createRoom(page);
    await openSettingsPanel(page);
    await page.locator('#setting-exp-btn').click();
    await page.locator('[data-exp-preset="custom"]').click();
    await page.locator('#exp-custom-value').fill('4');
    await page.locator('#exp-custom-unit').selectOption('m');
    await page.locator('#setting-exp-apply-btn').click();
    await expect(page.locator('#setting-exp-error')).toContainText('5 minutes');
  });

  test('theme picker renders theme options', async ({ page }) => {
    await createRoom(page);
    await openSettingsPanel(page);
    const themeOptions = page.locator('.theme-option');
    expect(await themeOptions.count()).toBeGreaterThanOrEqual(4);
  });

  test('clicking a theme option applies it to the document', async ({ page }) => {
    await createRoom(page);
    await openSettingsPanel(page);
    const themes = page.locator('.theme-option');
    // Click the second theme option
    await themes.nth(1).click();
    // data-theme attribute on <html> should be updated
    const htmlTheme = await page.locator('html').getAttribute('data-theme');
    expect(htmlTheme).toBeTruthy();
    expect(htmlTheme).not.toBe('');
  });

  test('strip formatting on paste toggle is visible', async ({ page }) => {
    await createRoom(page);
    await openSettingsPanel(page);
    const btn = page.locator('#setting-strip-paste-btn');
    await expect(btn).toBeVisible();
  });

  test('strip formatting on paste toggles between On and Off', async ({ page }) => {
    await createRoom(page);
    await openSettingsPanel(page);
    const btn = page.locator('#setting-strip-paste-btn');

    // Default state is Off
    await expect(btn).toHaveText('Off');

    // Click to enable
    await btn.click();
    await expect(btn).toHaveText('On');

    // Click to disable
    await btn.click();
    await expect(btn).toHaveText('Off');
  });
});

test.describe('File sort', () => {
  test('file sort dropdown is visible in the files panel', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'files');
    const sortSelect = page.locator('#files-sort');
    await expect(sortSelect).toBeVisible();
  });

  test('file sort dropdown has the expected ordering options', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'files');
    const sortSelect = page.locator('#files-sort');
    const options = await sortSelect.locator('option').allTextContents();
    // Should include at least newest, oldest, name-asc, name-desc
    const joined = options.join(' ').toLowerCase();
    expect(joined).toContain('newest');
    expect(joined).toContain('oldest');
    expect(joined).toContain('name');
  });

  test('file sort defaults to "newest"', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'files');
    const sortSelect = page.locator('#files-sort');
    const value = await sortSelect.inputValue();
    expect(value).toBe('newest');
  });
});
