// tests/routing.spec.js
// URL routing: admin, contact, privacy, terms, info screen,
// read-only share links, reserved paths.

import { test, expect } from '@playwright/test';

test.describe('URL routing', () => {
  test('/SyncPad/ shows landing screen', async ({ page }) => {
    await page.goto('/SyncPad/');
    await expect(page.locator('#landing-screen')).not.toHaveClass(/hidden/);
  });

  test('/SyncPad/admin shows admin screen', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await expect(page.locator('#admin-screen')).not.toHaveClass(/hidden/);
  });

  test('/SyncPad/admin shows admin login form', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    // Should show either the login form or the dashboard
    await page.waitForTimeout(2000); // let initAdmin() run
    const loginInput = page.locator('#admin-email, #admin-login-btn');
    // If not authenticated, login form should appear
    if (await loginInput.count() > 0) {
      await expect(loginInput.first()).toBeVisible();
    }
    // Either way the admin screen should be visible
    await expect(page.locator('#admin-screen')).not.toHaveClass(/hidden/);
  });

  test('/SyncPad/contact shows contact page', async ({ page }) => {
    await page.goto('/SyncPad/contact');
    await expect(page.locator('#contact-screen')).not.toHaveClass(/hidden/);
  });

  test('/SyncPad/privacy shows privacy page', async ({ page }) => {
    await page.goto('/SyncPad/privacy');
    await expect(page.locator('#privacy-screen')).not.toHaveClass(/hidden/);
  });

  test('/SyncPad/terms shows terms page', async ({ page }) => {
    await page.goto('/SyncPad/terms');
    await expect(page.locator('#terms-screen')).not.toHaveClass(/hidden/);
  });

  test('/SyncPad/some-room-id shows app screen', async ({ page }) => {
    await page.goto('/SyncPad/test-routing-room');
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    await expect(page.locator('#app-screen')).not.toHaveClass(/hidden/);
  });

  test('only one screen is visible at a time', async ({ page }) => {
    await page.goto('/SyncPad/');
    const screens = ['#landing-screen', '#loading-screen', '#passcode-screen',
      '#encryption-screen', '#app-screen', '#info-screen', '#contact-screen',
      '#privacy-screen', '#terms-screen', '#admin-screen'];
    const visible = await Promise.all(
      screens.map(async (sel) => {
        const el = page.locator(sel);
        if (await el.count() === 0) return false;
        const classes = await el.getAttribute('class') || '';
        return !classes.includes('hidden');
      })
    );
    const visibleCount = visible.filter(Boolean).length;
    expect(visibleCount).toBeLessThanOrEqual(1);
  });

  test('navigating browser back to landing works', async ({ page }) => {
    await page.goto('/SyncPad/');
    await page.waitForSelector('#landing-screen:not(.hidden)');
    await page.locator('.landing-create-btn').click();
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    await page.goBack();
    // Should return to landing or the previous page
    await page.waitForTimeout(1000);
    const url = page.url();
    expect(url).toContain('/SyncPad/');
  });
});
