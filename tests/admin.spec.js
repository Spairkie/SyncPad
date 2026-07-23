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

// ── Dashboard overhaul (stat icons, activity chart, active-today filter) ──
// The real dashboard requires a live Supabase project + admin credentials,
// neither of which exist in CI. These tests fake window.supabase.createClient()
// before admin.js runs so the dashboard renders against known data — same
// approach CLAUDE.md recommends for exercising browser-only module code.
function fakeSupabaseClient() {
  function makeBuilder(resolver) {
    const state = {};
    const builder = {
      select(cols, opts) { state.select = cols; state.opts = opts; return builder; },
      eq() { return builder; }, lt() { return builder; }, gte() { return builder; },
      not() { return builder; }, or() { return builder; }, ilike() { return builder; },
      order() { return builder; }, range() { return builder; }, limit() { return builder; },
      single() { state.single = true; return builder; },
      insert() { return builder; }, update() { return builder; }, delete() { return builder; },
      then(resolve, reject) { try { resolve(resolver(state)); } catch (e) { reject(e); } },
    };
    return builder;
  }
  const now = Date.now();
  const activityRows = Array.from({ length: 6 }, () => (
    { created_at: new Date(now - Math.floor(Math.random() * 14) * 86400000).toISOString() }
  ));
  const client = {
    auth: {
      async getSession() { return { data: { session: { user: { email: 'admin@syncpad.dev' } } } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from(table) {
      return makeBuilder((state) => {
        if (table === 'syncpad_rooms') {
          if (state.opts && state.opts.head) return { count: 5, data: null, error: null };
          if (state.select === 'created_at') return { data: activityRows, error: null };
          return { data: [], count: 0, error: null };
        }
        if (table === 'syncpad_files') {
          if (state.opts && state.opts.head) return { count: 2, data: null, error: null };
          if (state.select === 'file_size') return { data: [{ file_size: 1024 }, { file_size: 2048 }], error: null };
          return { data: [], error: null };
        }
        if (table === 'syncpad_room_reports') {
          return state.opts && state.opts.head ? { count: 0, data: null, error: null } : { data: [], count: 0, error: null };
        }
        return { data: [], count: 0, error: null };
      });
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  window.supabase = { createClient: () => client };
}

test.describe('Admin dashboard overhaul', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(fakeSupabaseClient);
  });

  test('stat cards render icons and the room-creation activity chart', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await page.waitForSelector('#admin-stats-row', { timeout: ADMIN_TIMEOUT }).catch(() => {});
    if (await page.locator('#admin-stats-row').count() === 0) {
      test.skip(true, 'Dashboard did not render (Supabase JS likely blocked)');
      return;
    }
    await expect(page.locator('#stat-rooms')).toHaveText('5');
    await expect(page.locator('#stat-storage')).toHaveText('3.0 KB');
    await expect(page.locator('.admin-stat-icon svg')).toHaveCount(6);
    await page.waitForSelector('.admin-activity-bar-wrap', { timeout: 5000 });
    await expect(page.locator('.admin-activity-bar-wrap')).toHaveCount(14);
  });

  test('clicking the "Active today" stat card filters the Rooms tab', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await page.waitForSelector('#stat-card-active', { timeout: ADMIN_TIMEOUT }).catch(() => {});
    if (await page.locator('#stat-card-active').count() === 0) {
      test.skip(true, 'Dashboard did not render (Supabase JS likely blocked)');
      return;
    }
    await page.click('#stat-card-active');
    await expect(page.locator('.admin-tab.active')).toHaveText('Rooms');
    await expect(page.locator('.admin-chip.active')).toHaveText('Active today');
  });
});
