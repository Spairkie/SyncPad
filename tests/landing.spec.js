// tests/landing.spec.js
// Landing page: rendering, "New room" navigation, "Join room" navigation.

import { test, expect } from '@playwright/test';
import { goToLanding, roomIdFromUrl, supabaseAvailable } from './helpers.js';

test.describe('Landing page', () => {
  test('renders logo, tagline, and action buttons', async ({ page }) => {
    await goToLanding(page);
    await expect(page.locator('.landing-logo')).toBeVisible();
    await expect(page.locator('.landing-tagline')).toBeVisible();
    await expect(page.locator('.landing-create-btn')).toBeVisible();
    await expect(page.locator('.landing-join-input')).toBeVisible();
    await expect(page.locator('.landing-join-btn')).toBeVisible();
  });

  test('"New room" creates a room and navigates to app screen', { timeout: 60_000 }, async ({ page }) => {
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS CDN blocked');
      return;
    }
    await page.click('.landing-create-btn');
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 25_000 });
    expect(page.url()).toMatch(/\/SyncPad\/[a-zA-Z0-9_-]+/);
  });

  test('"New room" URL contains a valid room ID (no reserved paths)', { timeout: 60_000 }, async ({ page }) => {
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS CDN blocked');
      return;
    }
    await page.click('.landing-create-btn');
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 25_000 });
    const roomId = roomIdFromUrl(page.url());
    const reserved = ['admin', 'contact', 'privacy', 'terms', 'share'];
    expect(reserved).not.toContain(roomId);
    expect(roomId.length).toBeGreaterThan(0);
  });

  test('"Join room" input + button navigate to the typed room', { timeout: 60_000 }, async ({ page }) => {
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS CDN blocked');
      return;
    }
    // Use a unique ID so stale Supabase room state from prior runs cannot interfere.
    const roomId = `test-join-btn-${Date.now()}`;
    await page.fill('.landing-join-input', roomId);
    await page.click('.landing-join-btn');
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 25_000 });
    expect(page.url()).toContain(roomId);
  });

  test('"Join room" also works by pressing Enter in the input', { timeout: 60_000 }, async ({ page }) => {
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS CDN blocked');
      return;
    }
    // Use a unique ID so stale Supabase room state from prior runs cannot interfere.
    const roomId = `test-join-enter-${Date.now()}`;
    await page.fill('.landing-join-input', roomId);
    await page.press('.landing-join-input', 'Enter');
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 25_000 });
    expect(page.url()).toContain(roomId);
  });

  test('feature chips are visible on landing', async ({ page }) => {
    await goToLanding(page);
    const chips = page.locator('.landing-chip');
    await expect(chips.first()).toBeVisible();
    expect(await chips.count()).toBeGreaterThanOrEqual(3);
  });
});
