// tests/editor-context-menu.spec.js
// Right-click (selection) context menu: Add comment + quick formatting.
//
// Playwright's synthetic right-click (page.mouse.click(..., {button:'right'}))
// doesn't reliably fire a real `contextmenu` DOM event across environments —
// dispatching one directly is the robust way to exercise this feature in tests
// (real browsers fire it reliably on an actual right-click; this only affects
// how the test simulates one).

import { test, expect } from '@playwright/test';
import { createRoom, typeInEditor } from './helpers.js';

async function rightClickSelection(page, selectionStart, selectionEnd) {
  const editor = page.locator('#note-editor');
  await editor.evaluate((el, [s, e]) => { el.selectionStart = s; el.selectionEnd = e; }, [selectionStart, selectionEnd]);
  await editor.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + 40, clientY: rect.y + 20 }));
  });
}

test.describe('Editor selection context menu', () => {
  test('right-click with a selection shows the menu', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'hello selectable world');
    await rightClickSelection(page, 0, 5);
    await expect(page.locator('#editor-context-menu')).toHaveClass(/visible/);
  });

  test('right-click with no selection does not show the menu', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'hello world');
    await rightClickSelection(page, 0, 0);
    await page.waitForTimeout(150);
    await expect(page.locator('#editor-context-menu')).not.toHaveClass(/visible/);
  });

  test('Bold applies formatting to the selection and closes the menu', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'hello selectable world');
    await rightClickSelection(page, 0, 5);
    await page.locator('[data-ctx-action="bold"]').click();
    await expect(page.locator('#note-editor')).toHaveValue('**hello** selectable world');
    await expect(page.locator('#editor-context-menu')).not.toHaveClass(/visible/);
  });

  test('Add comment opens the Comments panel with the selection pre-filled', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'another selection here');
    await rightClickSelection(page, 8, 17); // "selection"
    await page.locator('[data-ctx-action="comment"]').click();
    await expect(page.locator('#comments-panel')).toHaveClass(/open/);
  });

  test('Escape closes the menu', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'hello world');
    await rightClickSelection(page, 0, 5);
    await expect(page.locator('#editor-context-menu')).toHaveClass(/visible/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#editor-context-menu')).not.toHaveClass(/visible/);
  });

  test('clicking outside the menu closes it without applying anything', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, 'hello world');
    await rightClickSelection(page, 0, 5);
    await expect(page.locator('#editor-context-menu')).toHaveClass(/visible/);
    await page.locator('.app-footer').click();
    await expect(page.locator('#editor-context-menu')).not.toHaveClass(/visible/);
    await expect(page.locator('#note-editor')).toHaveValue('hello world');
  });
});
