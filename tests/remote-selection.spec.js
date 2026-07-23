// tests/remote-selection.spec.js
// Selection & viewport awareness: a remote collaborator's selected text
// range renders as a highlighted span (not just a caret) in the CM6 live
// surface, and the Devices panel's "Follow" toggle scrolls the local view
// to a followed device's position.
//
// Real multi-device presence isn't exercised here (no established
// multi-tab pattern in this suite) — LiveEditor.setRemoteCursors() is
// called directly with synthetic presence-shaped data, the same technique
// markdown.spec.js's withPreview() uses to exercise renderMarkdown()
// directly rather than through a second browser.

import { test, expect } from '@playwright/test';
import { createRoom, setEditorMode, typeInEditor } from './helpers.js';

async function setRemoteCursors(page, cursors) {
  await page.evaluate(async (cursors) => {
    const LE = await import('/SyncPad/src/live-editor.js');
    LE.setRemoteCursors(cursors);
  }, cursors);
}

test.describe('Remote selection highlighting', () => {
  test('a remote collaborator with a real selection range renders a highlighted span', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '# Title\n\nSome paragraph text here for selection testing.');
    await setEditorMode(page, 'preview');

    await setRemoteCursors(page, [{ id: 'dev-a', name: 'Alice', pos: 20, anchor: 5 }]);
    await expect(page.locator('.note-live .cm-remote-selection').first()).toBeVisible();
    await expect(page.locator('.note-live .cm-remote-caret')).toHaveCount(1);
  });

  test('a remote collaborator with a plain caret (no selection) renders no highlight', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '# Title\n\nSome text.');
    await setEditorMode(page, 'preview');

    await setRemoteCursors(page, [{ id: 'dev-b', name: 'Bob', pos: 8, anchor: 8 }]);
    await expect(page.locator('.note-live .cm-remote-caret')).toHaveCount(1);
    await expect(page.locator('.note-live .cm-remote-selection')).toHaveCount(0);
  });
});

test.describe('Follow mode', () => {
  test('with only the local device connected, no Follow toggle is shown', async ({ page }) => {
    await createRoom(page);
    await page.locator('#btn-presence').click();
    // Only the local device is connected in this test, so the follow
    // button (only rendered for non-self rows) shouldn't appear yet.
    await expect(page.locator('.device-follow-btn')).toHaveCount(0);
  });

  test('a non-self device gets a Follow toggle that activates on click', async ({ page }) => {
    await createRoom(page);
    await page.locator('#btn-presence').click();

    await page.evaluate(async () => {
      const UI = await import('/SyncPad/src/ui.js');
      window.__syncpadFollowed = null;
      UI.renderDevicesList(
        [
          { device_id: 'me', device_name: 'Me', isMe: true, read_only: false, typing: false, cursor_line: null },
          { device_id: 'dev-a', device_name: 'Alice', isMe: false, read_only: false, typing: false, cursor_line: 3 },
        ],
        'me',
        () => {},
        { followedDeviceId: null, onToggleFollow: (id) => { window.__syncpadFollowed = id; } },
      );
    });

    const followBtn = page.locator('.device-follow-btn');
    await expect(followBtn).toHaveCount(1);
    await expect(followBtn).toHaveAttribute('aria-pressed', 'false');

    await followBtn.click();
    const followedId = await page.evaluate(() => window.__syncpadFollowed);
    expect(followedId).toBe('dev-a');
  });
});
