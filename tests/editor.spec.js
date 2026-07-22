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
    const wc = page.locator('#word-count');
    await page.locator('#note-editor').fill('one two three');
    await expect(wc).toContainText('3 word');
  });

  test('word count shows 0 words on empty editor', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await editor.fill('');
    const wc = page.locator('#word-count');
    await expect(wc).toContainText('0 word');
  });

  test('preview mode hides the textarea and shows the editable live surface', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('# Preview heading');
    await setEditorMode(page, 'preview');
    await expect(page.locator('#note-editor')).toBeHidden();
    await expect(page.locator('#note-live')).toBeVisible();
    await expect(page.locator('#note-live')).toContainText('Preview heading');
    // The old rendered-HTML pane stays hidden — the live surface replaced it.
    await expect(page.locator('#note-preview')).toBeHidden();
  });

  test('split mode shows both the textarea and the live surface', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('**bold** text');
    await setEditorMode(page, 'split');
    await expect(page.locator('#note-editor')).toBeVisible();
    await expect(page.locator('#note-live')).toBeVisible();
    await expect(page.locator('#note-live')).toContainText('bold');
  });

  test('returning to write mode hides the live surface', async ({ page }) => {
    await createRoom(page);
    await setEditorMode(page, 'preview');
    await expect(page.locator('#note-live')).toBeVisible();
    await setEditorMode(page, 'write');
    await expect(page.locator('#note-live')).toBeHidden();
    await expect(page.locator('#note-editor')).toBeVisible();
  });

  test('edits made in the live surface flow back to the textarea', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('start');
    await setEditorMode(page, 'preview');
    const cm = page.locator('#note-live .cm-content');
    await expect(cm).toBeVisible();
    await cm.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' plus live edit');
    // The textarea (hidden but still the source of truth) must have the edit.
    await expect
      .poll(async () => page.locator('#note-editor').inputValue())
      .toContain('start plus live edit');
  });

  test('edits made in the textarea appear in the live surface (split mode)', async ({ page }) => {
    await createRoom(page);
    await setEditorMode(page, 'split');
    const editor = page.locator('#note-editor');
    await editor.click();
    await editor.fill('typed in the textarea');
    await expect(page.locator('#note-live')).toContainText('typed in the textarea');
  });

  test('live surface hides syntax markers away from the caret and reveals them on entry', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('# Title\n\n**bold** middle\n\ntail line');
    await setEditorMode(page, 'preview');
    const content = page.locator('#note-live .cm-content');
    await expect(content).toBeVisible();

    // Caret in the plain tail — every marker should be folded away.
    await content.click();
    await page.keyboard.press('Control+End');
    await expect(content).not.toContainText('#');
    await expect(content).not.toContainText('**');
    await expect(content).toContainText('Title');
    await expect(content).toContainText('bold');

    // Walk the caret into the bold span — its ** reveal, the heading stays folded.
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(content).toContainText('**bold**');
    await expect(content).not.toContainText('# Title');
  });

  test('formatting toolbar acts on the live surface in preview mode', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('hello world');
    await setEditorMode(page, 'preview');
    const content = page.locator('#note-live .cm-content');
    await expect(content).toBeVisible();

    // Select "world" inside the live surface, then click Bold on the toolbar.
    await content.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.down('Shift');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');

    await page.locator('[data-md-action="bold"]').click();

    await expect
      .poll(async () => page.locator('#note-editor').inputValue())
      .toBe('hello **world**');
  });

  test('the markdown toolbar is visible in preview mode (live surface active)', async ({ page }) => {
    await createRoom(page);
    await setEditorMode(page, 'preview');
    await expect(page.locator('#note-live')).toBeVisible();
    await expect(page.locator('#md-toolbar')).toBeVisible();
  });

  test('images render inline in the live surface instead of folding to alt text', async ({ page }) => {
    await createRoom(page);
    await page.locator('#note-editor').fill('![a pic](https://example.com/pic.png)\n\ntail');
    await setEditorMode(page, 'preview');
    const content = page.locator('#note-live .cm-content');
    await expect(content).toBeVisible();
    await content.click();
    await page.keyboard.press('Control+End');

    const img = page.locator('#note-live .cm-md-image');
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute('src', 'https://example.com/pic.png');
    await expect(img).toHaveAttribute('alt', 'a pic');
  });

  test('split mode scroll-syncs the textarea and the live surface', async ({ page }) => {
    await createRoom(page);
    const longDoc = Array.from({ length: 150 }, (_, i) => `Line ${i}`).join('\n');
    await page.locator('#note-editor').fill(longDoc);
    await setEditorMode(page, 'split');

    const editor = page.locator('#note-editor');
    const scroller = page.locator('#note-live .cm-scroller');
    await expect(scroller).toBeVisible();

    await editor.evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
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

test.describe('Focus mode (opt-in)', () => {
  test('is off by default and the editor has no mask applied', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await expect(editor).not.toHaveClass(/focus-mode/);
  });

  test('toggling the setting applies and removes the focus-mode class', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'settings');
    const btn = page.locator('#setting-focus-mode-btn');
    const editor = page.locator('#note-editor');

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(editor).toHaveClass(/focus-mode/);

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(editor).not.toHaveClass(/focus-mode/);
  });

  test('clicking a settings toggle does not steal the editor caret/selection', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await editor.fill('Hello world');

    // The settings panel can stay open alongside editing (it isn't modal).
    // Simulate the real workflow: open it, then click back into the note to
    // keep typing, then flip a toggle without leaving the editor.
    await openPanel(page, 'settings');
    await editor.evaluate((el) => { el.focus(); el.setSelectionRange(2, 5); }); // select "llo"

    await page.locator('#setting-focus-mode-btn').click();

    const sel = await editor.evaluate((el) => [document.activeElement === el, el.selectionStart, el.selectionEnd]);
    expect(sel).toEqual([true, 2, 5]);
  });

  test('the dimmed band follows the caret as it moves through the document', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    const lines = Array.from({ length: 15 }, (_, i) => `Line number ${i}`);
    await editor.fill(lines.join('\n'));

    await openPanel(page, 'settings');
    await page.locator('#setting-focus-mode-btn').click();
    await page.locator('.panel-close').first().click(); // close settings, back to the editor

    await editor.focus();
    await page.keyboard.press('Control+Home'); // caret at the very start
    await page.waitForTimeout(50);
    const yAtStart = await editor.evaluate((el) => el.style.getPropertyValue('--focus-y'));

    await page.keyboard.press('Control+End'); // caret at the very end
    await page.waitForTimeout(50);
    const yAtEnd = await editor.evaluate((el) => el.style.getPropertyValue('--focus-y'));

    expect(yAtStart).not.toBe('');
    expect(yAtEnd).not.toBe('');
    expect(parseFloat(yAtEnd)).toBeGreaterThan(parseFloat(yAtStart));
  });

  test('the preference persists across a page reload', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'settings');
    await page.locator('#setting-focus-mode-btn').click();
    await page.reload();
    await openPanel(page, 'settings');
    await expect(page.locator('#setting-focus-mode-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#note-editor')).toHaveClass(/focus-mode/);
  });
});

test.describe('Typewriter mode (opt-in)', () => {
  test('is off by default and the editor has no typewriter class', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    await expect(editor).not.toHaveClass(/typewriter-mode/);
  });

  test('toggling the setting applies and removes the typewriter-mode class', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'settings');
    const btn = page.locator('#setting-typewriter-mode-btn');
    const editor = page.locator('#note-editor');

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(editor).toHaveClass(/typewriter-mode/);

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(editor).not.toHaveClass(/typewriter-mode/);
  });

  test('scrolls to keep the caret line centered as it moves through a long document', async ({ page }) => {
    await createRoom(page);
    const editor = page.locator('#note-editor');
    const lines = Array.from({ length: 60 }, (_, i) => `Line number ${i}`);
    await editor.fill(lines.join('\n'));

    await openPanel(page, 'settings');
    await page.locator('#setting-typewriter-mode-btn').click();
    await page.locator('.panel-close').first().click(); // close settings, back to the editor

    await editor.focus();
    await page.keyboard.press('Control+Home'); // caret at the very start
    await page.waitForTimeout(50);
    const scrollAtStart = await editor.evaluate((el) => el.scrollTop);

    await page.keyboard.press('Control+End'); // caret at the very end
    await page.waitForTimeout(50);
    const scrollAtEnd = await editor.evaluate((el) => el.scrollTop);

    expect(scrollAtEnd).toBeGreaterThan(scrollAtStart);
  });

  test('the preference persists across a page reload', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'settings');
    await page.locator('#setting-typewriter-mode-btn').click();
    await page.reload();
    await openPanel(page, 'settings');
    await expect(page.locator('#setting-typewriter-mode-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#note-editor')).toHaveClass(/typewriter-mode/);
  });
});

test.describe('Hide my cursor & typing (opt-in)', () => {
  test('is off by default', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'presence');
    await expect(page.locator('#setting-hide-presence-btn')).toHaveAttribute('aria-pressed', 'false');
  });

  test('toggling flips the button state', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'presence');
    const btn = page.locator('#setting-hide-presence-btn');

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(btn).toHaveText('On');

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(btn).toHaveText('Off');
  });

  test('the preference persists across a page reload', async ({ page }) => {
    await createRoom(page);
    await openPanel(page, 'presence');
    await page.locator('#setting-hide-presence-btn').click();
    await page.reload();
    await openPanel(page, 'presence');
    await expect(page.locator('#setting-hide-presence-btn')).toHaveAttribute('aria-pressed', 'true');
  });
});
