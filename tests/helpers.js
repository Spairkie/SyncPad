// tests/helpers.js
// Shared Playwright helpers for SyncPad tests.

import { test, expect } from '@playwright/test';

/** Navigate to the SyncPad root and wait for the landing screen. */
export async function goToLanding(page) {
  await page.goto('/SyncPad/');
  await page.waitForSelector('#landing-screen:not(.hidden)', { timeout: 10_000 });
}

/**
 * Returns true if the Supabase JS library loaded successfully from CDN.
 * When the environment's network policy blocks cdn.jsdelivr.net or the
 * Supabase API host, window.supabase is undefined and all room operations fail.
 * Use this to skip tests gracefully rather than timing out.
 */
export async function supabaseAvailable(page) {
  await page.goto('/SyncPad/');
  return page.evaluate(() => typeof window.supabase !== 'undefined');
}

/**
 * Create a new room via the landing page "New room" button.
 * Automatically skips the calling test when Supabase is not reachable
 * (CDN blocked, network policy) so flaky timeouts become clean skips.
 * @returns {string} The room path (e.g. "abc123")
 */
export async function createRoom(page) {
  await goToLanding(page);
  // Detect CDN-blocked environments early so tests skip gracefully instead
  // of spending 15–30 s waiting for a timeout they can never win.
  const sbAvail = await page.evaluate(() => typeof window.supabase !== 'undefined');
  if (!sbAvail) {
    test.skip(true, 'Supabase JS CDN blocked — room creation requires network access');
  }
  await page.click('.landing-create-btn');
  await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15_000 });
  await page.waitForFunction(() => window.__syncpadEventsWired === true, null, { timeout: 5000 });
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
  if (!panelId.endsWith('-panel')) panelId = `${panelId}-panel`;
  const panel = page.locator(`#${panelId}`);
  if (await panel.evaluate(el => el.classList.contains('open'))) return;

  const desktopButtons = {
    'tools-panel': '#btn-tools',
    'files-panel': '#btn-files',
    'presence-panel': '#btn-presence',
    'settings-panel': '#btn-settings',
  };
  const mobileButtons = {
    'tools-panel': '#mob-btn-tools',
    'files-panel': '#mob-btn-files',
    'presence-panel': '#mob-btn-presence',
    'settings-panel': '#mob-btn-settings',
  };

  const mobileSelector = mobileButtons[panelId];
  const mobileBtn = mobileSelector ? page.locator(mobileSelector) : null;
  if (mobileBtn && await mobileBtn.isVisible().catch(() => false)) {
    await mobileBtn.click();
    await expect(panel).toHaveClass(/open/);
    return;
  }

  if (desktopButtons[panelId]) {
    await openMoreMenu(page);
    await page.locator(desktopButtons[panelId]).click();
    await expect(panel).toHaveClass(/open/);
    return;
  }

  const btn = page.locator(`[aria-controls="${panelId}"], [data-panel="${panelId}"]`).first();
  await btn.click();
  await expect(panel).toHaveClass(/open/);
}

export async function openMoreMenu(page) {
  const moreBtn = page.locator('#btn-more');
  const dropdown = page.locator('#more-dropdown');
  await expect(moreBtn).toBeVisible();

  for (let attempt = 0; attempt < 5; attempt++) {
    if (await dropdown.evaluate(el => el.classList.contains('open')).catch(() => false)) return;
    await moreBtn.click();
    try {
      await expect(dropdown).toHaveClass(/open/, { timeout: 1000 });
      return;
    } catch {
      await page.waitForTimeout(250);
    }
  }
  await expect(dropdown).toHaveClass(/open/);
}

export async function setEditorMode(page, mode) {
  const button = page.locator(`.md-seg-btn[data-mode="${mode}"]`);
  const wrap = page.locator('.editor-wrap');
  await expect(button).toBeVisible();

  for (let attempt = 0; attempt < 5; attempt++) {
    const classes = await wrap.getAttribute('class').catch(() => '') || '';
    if (classes.includes(`mode-${mode}`)) return;
    await button.click();
    try {
      await expect(wrap).toHaveClass(new RegExp(`mode-${mode}`), { timeout: 1000 });
      return;
    } catch {
      await page.waitForTimeout(250);
    }
  }
  await expect(wrap).toHaveClass(new RegExp(`mode-${mode}`));
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

/**
 * Open the settings panel via the more-menu.
 * Convenience wrapper used across multiple spec files.
 */
export async function openSettingsPanel(page) {
  await openMoreMenu(page);
  await page.locator('#btn-settings').click();
  await page.waitForSelector('#settings-panel.open', { timeout: 5000 });
}

/**
 * Wait for a modal with the given id to become visible.
 * @param {import('@playwright/test').Page} page
 * @param {string} id — the modal element id (without `#`)
 * @param {number} [timeout=5000]
 */
export async function waitForModal(page, id, timeout = 5000) {
  await page.waitForSelector(`#${id}.visible`, { timeout });
}

/**
 * Close a modal with the given id by clicking the visible close/cancel button.
 * @param {import('@playwright/test').Page} page
 * @param {string} id — the modal element id
 */
export async function closeModal(page, id) {
  const closeSelectors = [
    `#${id} .modal-close`,
    `#${id} [data-modal-close]`,
    `#${id} .modal-btn-cancel`,
    `#${id}-close`,
  ];
  for (const sel of closeSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForSelector(`#${id}.visible`, { state: 'hidden', timeout: 3000 }).catch(() => {});
      return;
    }
  }
}

/**
 * Open the share modal and return the URL shown in the specified link field.
 * Closes the modal afterwards.
 *
 * @param {import('@playwright/test').Page} page
 * @param {'editable'|'readonly'} [type='editable'] — which link to read
 * @returns {Promise<string>} The URL value from the share input field
 */
export async function getShareUrl(page, type = 'editable') {
  // Open share modal — prefer the desktop button, fall back to mobile
  const shareBtn = page.locator('#btn-share');
  const mobShareBtn = page.locator('#mob-btn-share');
  if (await mobShareBtn.isVisible().catch(() => false)) {
    await mobShareBtn.click();
  } else {
    await shareBtn.click();
  }
  await page.waitForSelector('#share-modal.visible', { timeout: 5000 });

  const inputId = type === 'readonly' ? '#share-readonly-text' : '#share-editable-text';
  const value = await page.locator(inputId).inputValue();

  // Close the modal
  await page.locator('#share-modal-close').click();
  await page.waitForSelector('#share-modal.visible', { state: 'hidden', timeout: 3000 }).catch(() => {});

  return value;
}
