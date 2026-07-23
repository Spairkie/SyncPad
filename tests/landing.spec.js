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

  test('"Join room" falls back to treating an unresolvable short code as a literal room ID', { timeout: 60_000 }, async ({ page }) => {
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS CDN blocked');
      return;
    }
    // Shaped like a real short code (6 chars, short-code alphabet) but never
    // actually issued by get_or_create_room_code — resolveRoomCode() should
    // return null for it, and the join flow must fall through to joining it
    // as a literal room ID rather than erroring or getting stuck.
    await page.fill('.landing-join-input', 'K7X9BQ');
    await page.click('.landing-join-btn');
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 25_000 });
    // sanitizeRoomId() lowercases room IDs, so the fallback path's URL uses
    // the lowercase form even though the typed code was uppercase.
    expect(page.url().toLowerCase()).toContain('k7x9bq');
  });

  test('navigating directly to a URL for a room that does not exist creates and opens it', { timeout: 60_000 }, async ({ page }) => {
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS CDN blocked');
      return;
    }
    // Typing/following a URL for a name nobody has taken yet must behave
    // like the Create Room button (this is the "join by name" behavior the
    // landing join-box tests above exercise via the input; this test
    // exercises the same fallback via direct navigation, which goes
    // through boot()'s route handling instead of the join box).
    const roomId = `test-direct-nav-${Date.now()}`;
    await page.goto(`/SyncPad/${roomId}`);
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 25_000 });
    expect(page.url()).toContain(roomId);
    expect(page.url()).toMatch(/[?&]et=/);
  });

  test('feature chips are visible on landing', async ({ page }) => {
    await goToLanding(page);
    const chips = page.locator('.landing-chip');
    await expect(chips.first()).toBeVisible();
    expect(await chips.count()).toBeGreaterThanOrEqual(3);
  });
});
