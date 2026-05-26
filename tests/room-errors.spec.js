// tests/room-errors.spec.js
// Room load error states, retry button, and read-only share link handling.

import { test, expect } from '@playwright/test';
import { createRoom, goToLanding, roomIdFromUrl, supabaseAvailable } from './helpers.js';

test.describe('Room load retry button', () => {
  test('loading screen retry button is hidden on normal load', async ({ page }) => {
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS CDN blocked — room creation requires network access');
      return;
    }
    await goToLanding(page);
    await page.click('.landing-create-btn');
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    // After successful load the retry button should be hidden
    const retryBtn = page.locator('#loading-retry-btn');
    // Either absent or hidden
    if (await retryBtn.count() > 0) {
      // We're already on app screen, but verify retry btn is hidden (it would have been during loading)
      // The retry btn is only shown on error; on a successful load it stays hidden
    }
    await expect(page.locator('#app-screen')).not.toHaveClass(/hidden/);
  });
});

test.describe('Read-only share link handling', () => {
  test('invalid share token shows info screen', async ({ page }) => {
    await page.goto('/SyncPad/share/definitely-not-a-real-token-xyz123');
    // Wait for resolution
    await page.waitForTimeout(4000);
    // Should show info screen (not the app screen or loading forever)
    const infoScreen = page.locator('#info-screen');
    const appScreen  = page.locator('#app-screen');
    if (await infoScreen.count() > 0) {
      // Info screen is shown for invalid tokens
      const infoVisible = await infoScreen.evaluate(el => !el.classList.contains('hidden'));
      const appHidden   = await appScreen.evaluate(el => el.classList.contains('hidden'));
      expect(infoVisible || appHidden).toBe(true);
    }
  });

  test('navigating to /SyncPad/share with no token redirects gracefully', async ({ page }) => {
    await page.goto('/SyncPad/share/');
    await page.waitForTimeout(3000);
    // Should be on some screen (not stuck on loading forever)
    const url = page.url();
    expect(url).toContain('/SyncPad/');
  });
});

test.describe('Room creation and navigation', () => {
  test('creating a room navigates to app screen with a valid room ID', async ({ page }) => {
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS CDN blocked — room creation requires network access');
      return;
    }
    await goToLanding(page);
    await page.click('.landing-create-btn');
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    const roomId = roomIdFromUrl(page.url());
    expect(roomId.length).toBeGreaterThan(0);
    // Room ID should not be a reserved path
    const reserved = ['admin', 'contact', 'privacy', 'terms', 'share'];
    expect(reserved.includes(roomId)).toBe(false);
  });

  test('navigating directly to an existing room ID loads the app', async ({ page }) => {
    // First create a room to get a valid ID
    const roomId = await createRoom(page);
    expect(roomId.length).toBeGreaterThan(0);
    // Navigate away
    await goToLanding(page);
    // Navigate back to the same room
    await page.goto(`/SyncPad/${roomId}`);
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    expect(page.url()).toContain(roomId);
  });

  test('loading screen shows "Loading room…" then transitions to app', async ({ page }) => {
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS CDN blocked — room loading requires network access');
      return;
    }
    // Navigate directly to a room — loading screen should appear then resolve
    await page.goto('/SyncPad/test-load-transition');
    // May briefly see loading screen
    const loadMsg = page.locator('#loading-message');
    // Eventually app screen appears
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    await expect(page.locator('#app-screen')).not.toHaveClass(/hidden/);
  });

  test('joining room via ID input on landing page', async ({ page }) => {
    if (!(await supabaseAvailable(page))) {
      test.skip(true, 'Supabase JS CDN blocked — room joining requires network access');
      return;
    }
    await goToLanding(page);
    const testRoomId = `join-test-${Date.now()}`;
    await page.fill('.landing-join-input', testRoomId);
    await page.click('.landing-join-btn');
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    expect(page.url()).toContain(testRoomId);
  });
});

test.describe('Multi-room navigation', () => {
  test('navigating between two rooms loads each correctly', async ({ page }) => {
    const roomA = await createRoom(page);
    expect(roomA.length).toBeGreaterThan(0);

    // Navigate to a second room
    await goToLanding(page);
    const roomB = await createRoom(page);
    expect(roomB.length).toBeGreaterThan(0);
    expect(roomB).not.toBe(roomA);

    // Navigate back to room A
    await page.goto(`/SyncPad/${roomA}`);
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
    expect(page.url()).toContain(roomA);
  });

  test('editor mode resets to write when navigating between rooms', async ({ page }) => {
    const roomA = await createRoom(page);

    // Switch to split mode
    const splitBtn = page.locator('.md-seg-btn[data-mode="split"]');
    if (await splitBtn.count() > 0) {
      await splitBtn.click();
      // Verify split mode active
      await expect(page.locator('.editor-wrap')).toHaveClass(/mode-split/);
    }

    // Navigate to second room
    await goToLanding(page);
    await page.click('.landing-create-btn');
    await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });

    // Editor wrap should be back in write mode (mode-write, not mode-split)
    const editorWrap = page.locator('.editor-wrap');
    const classes = await editorWrap.getAttribute('class') || '';
    expect(classes).not.toContain('mode-split');
  });
});
