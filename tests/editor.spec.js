// tests/editor.spec.js
// Core editor: typing, word count, read-only badge, monospace toggle,
// split/preview mode, export actions.

import { test, expect } from '@playwright/test';
import { createRoom, openMoreMenu, openPanel, setEditorMode, waitForToast } from './helpers.js';

test.describe('Editor', () => {
  test('displays the text area and accepts input', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await expect(editor).toBeVisible();
    await editor.fill('Hello SyncPad!');
    expect(await editor.inputValue()).toBe('Hello SyncPad!');
  });

  test('word count updates as user types', async ({ page }) => {
    await createRoom(page);
    const wc = page.locator('#word-count, #toolbar-word-count').first();
    await page.locator('#note-editor').fill('one two three');
    await expect(wc).toContainText('3 word');
  });

  test('word count shows 0 words on empty editor', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await editor.fill('');
    const wc = page.locator('#word-count, #toolbar-word-count').first();
    await expect(wc).toContainText('0 word');
  });

  test('preview mode hides editor and shows preview pane', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('# Preview heading');
    await setEditorMode(page, 'preview');
    await expect(page.locator('#note-editor')).toBeHidden();
    await expect(page.locator('#note-preview')).toBeVisible();
    await expect(page.locator('#note-preview')).toContainText('Preview heading');
  });

  test('split mode shows both editor and preview', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('**bold** text');
    await setEditorMode(page, 'split');
    await expect(page.locator('#note-editor')).toBeVisible();
    await expect(page.locator('#note-preview')).toBeVisible();
    await expect(page.locator('#note-preview')).toContainText('bold');
  });

  test('returning to write mode hides preview', async ({ page }) => {
    await createRoom(page);
    await setEditorMode(page, 'preview');
    await expect(page.locator('#note-preview')).toBeVisible();
    await setEditorMode(page, 'write');
    await expect(page.locator('#note-preview')).toBeHidden();
    await expect(page.locator('#note-editor')).toBeVisible();
  });

  test('export modal opens when export button clicked', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('export me');
    // #btn-export lives inside #more-dropdown; open it via #btn-more first.
    await openMoreMenu(page);
    await page.locator('#btn-export').click();
    await expect(page.locator('#export-modal')).toBeVisible({ timeout: 3000 });
  });

  test('export modal shows warning toast on empty note', async ({ page }) => {
    await createRoom(page);
    // Clear editor
    await page.locator('#note-editor').fill('');
    // #btn-export lives inside #more-dropdown; open it via #btn-more first.
    await openMoreMenu(page);
    await page.locator('#btn-export').click();
    // Click export .txt button in modal
    await page.locator('#export-txt').click();
    await waitForToast(page, 'empty');
  });
});

test.describe('Editor auto-pair', () => {
  test('typing an opening bracket/paren/quote/backtick inserts the matching closer', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await editor.fill('');
    await editor.focus();
    // Each press inserts a pair with the cursor left in the middle, so the
    // next press nests inside the previous one rather than appending after it.
    await editor.press('(');
    await editor.press('[');
    await editor.press('"');
    await editor.press('`');
    expect(await editor.inputValue()).toBe('(["``"])');
  });

  test('typing a closer right after an auto-inserted one skips over instead of duplicating', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await editor.fill('');
    await editor.focus();
    await editor.press('(');       // -> "()" cursor between
    await editor.press(')');       // should skip over, not insert a second ")"
    await editor.press('x');       // typed after skipping past the closer
    expect(await editor.inputValue()).toBe('()x');
  });

  test('typing an opener while text is selected wraps the selection', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await editor.fill('hello');
    await editor.focus();
    await page.keyboard.press('Control+A');
    await editor.press('"');
    expect(await editor.inputValue()).toBe('"hello"');
  });

  test('backspace inside an empty auto-inserted pair removes both characters', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await editor.fill('');
    await editor.focus();
    await editor.press('[');       // -> "[]" cursor between
    await editor.press('Backspace');
    expect(await editor.inputValue()).toBe('');
  });

  test('does not interfere with normal typing of unmatched closing characters', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await editor.fill('');
    await editor.focus();
    await editor.pressSequentially(')) hi'); // no opener before these — plain typing
    expect(await editor.inputValue()).toBe(')) hi');
  });
});

test.describe('Smart punctuation (opt-in)', () => {
  async function enableSmartPunct(page) {
    await openPanel(page, 'settings');
    const btn = page.locator('#setting-smart-punct-btn');
    if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
  }

  test('is off by default — quotes stay straight (plain auto-pair still applies) and hyphens stay literal', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await editor.fill('');
    await editor.focus();
    await editor.press('"');            // plain auto-pair from a separate feature: "" cursor between
    await editor.pressSequentially('hi');
    await editor.press('-'); await editor.press('-'); // typed inside the still-open pair — no dash conversion
    expect(await editor.inputValue()).toBe('"hi--"');
  });

  test('converts straight double quotes to curly quotes around a word', async ({ page }) => {
    await createRoom(page);
    await enableSmartPunct(page);
    const editor = page.locator('#note-editor');
    await editor.fill('');
    await editor.focus();
    await editor.press('"');
    await editor.pressSequentially('hello');
    await editor.press('"');
    expect(await editor.inputValue()).toBe('“hello”');
  });

  test('a contraction apostrophe becomes the closing curly form, not an opening quote', async ({ page }) => {
    await createRoom(page);
    await enableSmartPunct(page);
    const editor = page.locator('#note-editor');
    await editor.fill('don');
    await editor.focus();
    await page.keyboard.press('End');
    await editor.press("'");
    await editor.pressSequentially('t');
    expect(await editor.inputValue()).toBe('don’t');
  });

  test('two hyphens become an en dash, three become an em dash', async ({ page }) => {
    await createRoom(page);
    await enableSmartPunct(page);
    const editor = page.locator('#note-editor');

    await editor.fill('a'); await page.keyboard.press('End');
    await editor.press('-'); await editor.press('-'); await editor.pressSequentially('b');
    expect(await editor.inputValue()).toBe('a–b');

    await editor.fill('a'); await page.keyboard.press('End');
    await editor.press('-'); await editor.press('-'); await editor.press('-'); await editor.pressSequentially('b');
    expect(await editor.inputValue()).toBe('a—b');
  });

  test('a lone hyphen (e.g. a hyphenated word) is left alone', async ({ page }) => {
    await createRoom(page);
    await enableSmartPunct(page);
    const editor = page.locator('#note-editor');
    await editor.fill('well'); await page.keyboard.press('End');
    await editor.press('-');
    await editor.pressSequentially('known');
    expect(await editor.inputValue()).toBe('well-known');
  });

  test('three periods become an ellipsis character', async ({ page }) => {
    await createRoom(page);
    await enableSmartPunct(page);
    const editor = page.locator('#note-editor');
    await editor.fill('wait'); await page.keyboard.press('End');
    await editor.press('.'); await editor.press('.'); await editor.press('.');
    expect(await editor.inputValue()).toBe('wait…');
  });

  test('the preference persists across a page reload', async ({ page }) => {
    await createRoom(page);
    await enableSmartPunct(page);
    await page.reload();
    await openPanel(page, 'settings');
    await expect(page.locator('#setting-smart-punct-btn')).toHaveAttribute('aria-pressed', 'true');
  });
});
