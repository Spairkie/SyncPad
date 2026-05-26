// tests/search.spec.js
// Find & Replace panel: open, search, navigation, replace, focus preservation.

import { test, expect } from '@playwright/test';
import { createRoom } from './helpers.js';

async function openSearchPanel(page) {
  // Open the search panel via keyboard shortcut or button
  await page.keyboard.press('Control+f');
  await page.waitForSelector('#search-panel.open', { timeout: 5000 });
}

test.describe('Find & Replace panel', () => {
  test('opens with Ctrl+F and search input is focused', async ({ page }) => {
    await createRoom(page);
    await openSearchPanel(page);
    await expect(page.locator('#search-input')).toBeFocused();
  });

  test('closes with Escape', async ({ page }) => {
    await createRoom(page);
    await openSearchPanel(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-panel')).not.toHaveClass(/open/);
  });

  test('shows match count for found term', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('apple banana apple cherry apple');
    await openSearchPanel(page);
    await page.locator('#search-input').fill('apple');
    const count = page.locator('#search-count');
    await expect(count).toContainText('1 / 3');
  });

  test('shows "No results" when term not found', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('hello world');
    await openSearchPanel(page);
    await page.locator('#search-input').fill('xyz_not_found');
    await expect(page.locator('#search-count')).toContainText('No results');
  });

  test('Next / Prev buttons cycle through matches', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('cat dog cat bird cat');
    await openSearchPanel(page);
    await page.locator('#search-input').fill('cat');
    await expect(page.locator('#search-count')).toContainText('1 / 3');

    await page.locator('#search-next').click();
    await expect(page.locator('#search-count')).toContainText('2 / 3');

    await page.locator('#search-next').click();
    await expect(page.locator('#search-count')).toContainText('3 / 3');

    // Wraps around
    await page.locator('#search-next').click();
    await expect(page.locator('#search-count')).toContainText('1 / 3');

    await page.locator('#search-prev').click();
    await expect(page.locator('#search-count')).toContainText('3 / 3');
  });

  test('Enter in search input advances to next match', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('x y x y x');
    await openSearchPanel(page);
    await page.locator('#search-input').fill('x');
    await expect(page.locator('#search-count')).toContainText('1 / 3');
    await page.keyboard.press('Enter');
    await expect(page.locator('#search-count')).toContainText('2 / 3');
  });

  test('search input stays focused after Next click', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('go go go');
    await openSearchPanel(page);
    await page.locator('#search-input').fill('go');
    await page.locator('#search-next').click();
    // Search input should still be focused (not the editor)
    await expect(page.locator('#search-input')).toBeFocused();
  });

  test('Replace replaces current match and keeps replace input focused', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('foo bar foo');
    await openSearchPanel(page);
    await page.locator('#search-input').fill('foo');
    await page.locator('#replace-input').fill('baz');
    await page.locator('#replace-one').click();
    // After replace, replace input should retain focus
    await expect(page.locator('#replace-input')).toBeFocused();
    const content = await page.locator('#note-editor').inputValue();
    expect(content).toMatch(/^baz bar foo/);
  });

  test('Replace All replaces all matches and focuses search input', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('foo foo foo');
    await openSearchPanel(page);
    await page.locator('#search-input').fill('foo');
    await page.locator('#replace-input').fill('bar');
    await page.locator('#replace-all').click();
    // Search input should be focused
    await expect(page.locator('#search-input')).toBeFocused();
    const content = await page.locator('#note-editor').inputValue();
    expect(content).toBe('bar bar bar');
  });

  test('Tab from search input moves focus to replace input', async ({ page }) => {
    await createRoom(page);
    await openSearchPanel(page);
    await page.locator('#search-input').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#replace-input')).toBeFocused();
  });

  test('Shift+Tab from replace input moves focus back to search input', async ({ page }) => {
    await createRoom(page);
    await openSearchPanel(page);
    await page.locator('#replace-input').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#search-input')).toBeFocused();
  });

  test('Aa button is visible in search bar', async ({ page }) => {
    await createRoom(page);
    await openSearchPanel(page);
    const caseBtn = page.locator('#search-case');
    await expect(caseBtn).toBeVisible();
    await expect(caseBtn).toHaveAttribute('aria-pressed', 'false');
  });

  test('Aa button toggles case-sensitive search', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('Apple apple APPLE');
    await openSearchPanel(page);
    await page.locator('#search-input').fill('apple');

    // Case-insensitive by default — all 3 should match
    await expect(page.locator('#search-count')).toContainText('3');

    // Enable case-sensitive — only the lowercase one should match
    await page.locator('#search-case').click();
    await expect(page.locator('#search-case')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#search-count')).toContainText('1');

    // Disable — back to 3 matches
    await page.locator('#search-case').click();
    await expect(page.locator('#search-case')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#search-count')).toContainText('3');
  });

  test('Replace All respects case-sensitive mode', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('Foo foo FOO');
    await openSearchPanel(page);
    await page.locator('#search-input').fill('foo');
    await page.locator('#replace-input').fill('bar');

    // Enable case-sensitive — only the lowercase 'foo' should be replaced
    await page.locator('#search-case').click();
    await page.locator('#replace-all').click();

    const content = await page.locator('#note-editor').inputValue();
    expect(content).toBe('Foo bar FOO');
  });
});
