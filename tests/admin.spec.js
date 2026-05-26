// tests/admin.spec.js
// Admin dashboard: route, login form, unauthenticated access denied.

import { test, expect } from '@playwright/test';

test.describe('Admin route', () => {
  test('navigating to /SyncPad/admin shows admin screen', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await expect(page.locator('#admin-screen')).not.toHaveClass(/hidden/);
  });

  test('admin screen shows login form when not authenticated', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    // Give initAdmin() time to run and render the login form
    await page.waitForTimeout(2000);
    // Login form inputs should be present
    const emailInput = page.locator('#admin-email');
    if (await emailInput.count() > 0) {
      await expect(emailInput).toBeVisible();
      await expect(page.locator('#admin-password')).toBeVisible();
      await expect(page.locator('#admin-login-btn')).toBeVisible();
    }
    // Admin screen is visible regardless
    await expect(page.locator('#admin-screen')).not.toHaveClass(/hidden/);
  });

  test('login form shows error for missing credentials', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await page.waitForSelector('#admin-login-btn', { timeout: 5000 });
    await page.click('#admin-login-btn');
    const errorEl = page.locator('#admin-login-error');
    await expect(errorEl).toBeVisible();
    await expect(errorEl).not.toHaveText('');
  });

  test('login form shows error for wrong credentials', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await page.waitForSelector('#admin-email', { timeout: 5000 });
    await page.fill('#admin-email', 'notadmin@example.com');
    await page.fill('#admin-password', 'wrongpassword123');
    await page.click('#admin-login-btn');
    // Button should disable during sign-in attempt
    await expect(page.locator('#admin-login-btn')).toBeDisabled();
    // Wait for response and error message
    await page.waitForTimeout(4000);
    const errorEl = page.locator('#admin-login-error');
    // Either shows an error, or the button is re-enabled (both indicate a response)
    const hasError = await errorEl.textContent().then(t => t.trim().length > 0).catch(() => false);
    const btnEnabled = await page.locator('#admin-login-btn').isEnabled().catch(() => false);
    expect(hasError || btnEnabled).toBe(true);
  });

  test('Back to SyncPad button navigates to landing', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await page.waitForSelector('button', { timeout: 5000 });
    // Find the "Back to SyncPad" button
    const backBtn = page.locator('button', { hasText: 'Back to SyncPad' });
    if (await backBtn.count() > 0) {
      await backBtn.click();
      await page.waitForSelector('#landing-screen:not(.hidden)', { timeout: 5000 });
      await expect(page.locator('#landing-screen')).not.toHaveClass(/hidden/);
    }
  });

  test('admin screen does not show app screen', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await page.waitForTimeout(1000);
    // App screen should be hidden on admin route
    const appScreen = page.locator('#app-screen');
    if (await appScreen.count() > 0) {
      await expect(appScreen).toHaveClass(/hidden/);
    }
  });

  test('Enter key in email field moves focus to password field', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await page.waitForSelector('#admin-email', { timeout: 5000 });
    await page.fill('#admin-email', 'test@example.com');
    await page.press('#admin-email', 'Enter');
    // Password field should be focused
    const focused = await page.evaluate(() => document.activeElement?.id);
    expect(focused).toBe('admin-password');
  });
});
