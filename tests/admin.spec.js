// tests/admin.spec.js
// Admin dashboard: route, login form, unauthenticated access denied.
//
// NOTE: Tests that require the Supabase JS library (CDN-loaded) will be
// skipped if the library fails to load (e.g. in network-restricted environments).

import { test, expect } from '@playwright/test';

// initAdmin() calls sb.auth.getSession() which may take several seconds.
const ADMIN_TIMEOUT = 10_000;

/** Returns true if the Supabase JS library is loaded in the page. */
async function supabaseAvailable(page) {
  return page.evaluate(() => typeof window.supabase !== 'undefined');
}

test.describe('Admin route', () => {
  test('navigating to /SyncPad/admin shows admin screen', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await expect(page.locator('#admin-screen')).not.toHaveClass(/hidden/);
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

  test('admin screen shows login form when not authenticated', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await page.waitForTimeout(2000);
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS not available (CDN blocked)');
      return;
    }
    // Wait for initAdmin() to render the login form
    await page.waitForSelector('#admin-login-btn', { timeout: ADMIN_TIMEOUT });
    await expect(page.locator('#admin-email')).toBeVisible();
    await expect(page.locator('#admin-password')).toBeVisible();
    await expect(page.locator('#admin-login-btn')).toBeVisible();
    await expect(page.locator('#admin-screen')).not.toHaveClass(/hidden/);
  });

  test('login form shows error for missing credentials', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await page.waitForTimeout(2000);
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS not available (CDN blocked)');
      return;
    }
    await page.waitForSelector('#admin-login-btn', { timeout: ADMIN_TIMEOUT });
    await page.click('#admin-login-btn');
    const errorEl = page.locator('#admin-login-error');
    await expect(errorEl).toBeVisible();
    await expect(errorEl).not.toHaveText('');
  });

  test('login form shows error for wrong credentials', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await page.waitForTimeout(2000);
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS not available (CDN blocked)');
      return;
    }
    await page.waitForSelector('#admin-email', { timeout: ADMIN_TIMEOUT });
    await page.fill('#admin-email', 'notadmin@example.com');
    await page.fill('#admin-password', 'wrongpassword123');
    await page.click('#admin-login-btn');
    await expect(page.locator('#admin-login-btn')).toBeDisabled();
    await page.waitForFunction(
      () => {
        const btn = document.getElementById('admin-login-btn');
        const err = document.getElementById('admin-login-error');
        return !btn?.disabled || (err?.textContent?.trim().length ?? 0) > 0;
      },
      { timeout: 8000 },
    );
    const errorEl = page.locator('#admin-login-error');
    const hasError = await errorEl.textContent().then(t => t.trim().length > 0).catch(() => false);
    const btnEnabled = await page.locator('#admin-login-btn').isEnabled().catch(() => false);
    expect(hasError || btnEnabled).toBe(true);
  });

  test('Back to SyncPad button navigates to landing', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await page.waitForTimeout(2000);
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS not available (CDN blocked)');
      return;
    }
    await page.waitForSelector('#admin-login-btn', { timeout: ADMIN_TIMEOUT });
    const backBtn = page.locator('button', { hasText: 'Back to SyncPad' });
    if (await backBtn.count() > 0) {
      await backBtn.click();
      await page.waitForSelector('#landing-screen:not(.hidden)', { timeout: 8000 });
      await expect(page.locator('#landing-screen')).not.toHaveClass(/hidden/);
    }
  });

  test('Enter key in email field moves focus to password field', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await page.waitForTimeout(2000);
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS not available (CDN blocked)');
      return;
    }
    await page.waitForSelector('#admin-email', { timeout: ADMIN_TIMEOUT });
    await page.fill('#admin-email', 'test@example.com');
    await page.press('#admin-email', 'Enter');
    const focused = await page.evaluate(() => document.activeElement?.id);
    expect(focused).toBe('admin-password');
  });
});
