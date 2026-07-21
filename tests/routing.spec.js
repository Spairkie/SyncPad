// tests/routing.spec.js
// URL routing: admin, contact, privacy, terms, info screen,
// read-only share links, reserved paths.

import { test, expect } from '@playwright/test';
import { supabaseAvailable } from './helpers.js';

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
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS CDN blocked — room loading requires network access');
      return;
    }
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
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS CDN blocked — room creation requires network access');
      return;
    }
    await page.goto('/SyncPad/');
    await page.waitForSelector('#landing-screen:not(.hidden)');
    await page.locator('.landing-create-btn').click();
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    await page.goBack();
    // Actually re-routes back to the landing screen, not just a URL-bar
    // change with the app screen still frozen on-screen underneath it.
    await page.waitForSelector('#landing-screen:not(.hidden)', { timeout: 5000 });
    expect(page.url()).toContain('/SyncPad/');
  });

  test('browser Back/Forward triggers a real re-route via popstate (no Supabase needed)', async ({ page }) => {
    const navigations = [];
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });

    await page.goto('/SyncPad/');
    await page.waitForSelector('#landing-screen:not(.hidden)');
    await page.evaluate(() => { window.__routingTestMarker = true; });
    navigations.length = 0;

    // A pushState-only URL change (what joining a room does) followed by
    // browser Back must produce a real re-route, not a silently-stale screen.
    await page.evaluate(() => history.pushState(null, '', '/SyncPad/some-fake-room-for-routing-test'));
    await page.goBack();
    await page.waitForTimeout(1000); // let the popstate-triggered reload settle

    // A genuine reload creates a fresh JS realm — the marker set before it
    // must be gone, and the frame must have navigated again after Back
    // (not just the single same-document transition goBack() itself causes).
    const markerGone = await page.evaluate(() => typeof window.__routingTestMarker === 'undefined');
    expect(markerGone).toBe(true);
    expect(navigations.length).toBeGreaterThanOrEqual(2);
  });

  test('Back after a hash-only navigation does not reload (would lose in-memory state, e.g. a consumed view-once note)', async ({ page }) => {
    await page.goto('/SyncPad/');
    await page.waitForSelector('#landing-screen:not(.hidden)');
    await page.evaluate(() => { window.__routingTestMarker = true; });

    // Following a same-page anchor link (e.g. a Markdown TOC entry) only
    // changes the hash — the path and query stay identical.
    await page.evaluate(() => history.pushState(null, '', location.pathname + '#some-heading'));
    await page.goBack();
    await page.waitForTimeout(700);

    const markerStillPresent = await page.evaluate(() => window.__routingTestMarker === true);
    expect(markerStillPresent).toBe(true);
  });

  test('Back still reloads after a real navigation, even once a prior hash-only Back has fired', async ({ page }) => {
    await page.goto('/SyncPad/');
    await page.waitForSelector('#landing-screen:not(.hidden)');

    // Exercise the hash-only path first so its no-op doesn't leave the
    // path/search tracker stale for the real navigation that follows.
    await page.evaluate(() => history.pushState(null, '', location.pathname + '#some-heading'));
    await page.goBack();
    await page.waitForTimeout(500);

    await page.evaluate(() => { window.__routingTestMarker = true; });
    await page.evaluate(() => history.pushState(null, '', '/SyncPad/another-fake-room'));
    await page.goBack();
    await page.waitForTimeout(1000);

    const markerGone = await page.evaluate(() => typeof window.__routingTestMarker === 'undefined');
    expect(markerGone).toBe(true);
  });
});
