// tests/helpers.js
// Shared Playwright helpers for SyncPad tests.

import { expect } from '@playwright/test';

/** Navigate to the SyncPad root and wait for the landing screen. */
export async function goToLanding(page) {
  await page.goto('/SyncPad/');
  await page.waitForSelector('#landing-screen:not(.hidden)', { timeout: 10_000 });
}

/**
 * Create a new room via the landing page "New room" button.
 * Waits for the app screen to be visible.
 * @returns {string} The room path (e.g. "abc123")
 */
export async function createRoom(page) {
  await goToLanding(page);
  await page.click('.landing-create-btn');
  await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
  // Extract room ID from URL
  const url = page.url();
  const match = url.match(/\/SyncPad\/([^/?#]+)/);
  return match?.[1] ?? '';
}

/**
 * Type text into the note editor.
 * Clears any existing content first.
 */
export async function typeInEditor(page, text, { clear = true } = {}) {
  const editor = page.locator('#note-editor');
  await editor.click();
  if (clear) await editor.fill('');
  await editor.fill(text);
}

/** Get the current editor content. */
export async function getEditorContent(page) {
  return page.locator('#note-editor').inputValue();
}

/** Open a named side panel (tools, files, presence, settings, search). */
export async function openPanel(page, panelId) {
  const panel = page.locator(`#${panelId}`);
  if (await panel.evaluate(el => el.classList.contains('open'))) return;
  // Find the toggle button by its aria-controls or data attribute
  const btn = page.locator(`[aria-controls="${panelId}"], [data-panel="${panelId}"]`).first();
  await btn.click();
  await expect(panel).toHaveClass(/open/);
}

/** Wait for a toast notification containing the given text. */
export async function waitForToast(page, textOrPattern, options = {}) {
  const toast = page.locator('.toast').filter({ hasText: textOrPattern });
  await expect(toast).toBeVisible({ timeout: options.timeout ?? 5000 });
}

/** Close any open panel by clicking the backdrop. */
export async function closePanels(page) {
  const backdrop = page.locator('#panel-backdrop');
  if (await backdrop.evaluate(el => el.classList.contains('visible'))) {
    await backdrop.click();
  }
}

/** Parse a room URL and return the room ID. */
export function roomIdFromUrl(url) {
  const match = url.match(/\/SyncPad\/([^/?#]+)/);
  return match?.[1] ?? '';
}
