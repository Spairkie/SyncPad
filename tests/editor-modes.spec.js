// tests/editor-modes.spec.js
// Editor mode switching: write, preview, split. CSS class correctness.

import { test, expect } from '@playwright/test';
import { createRoom, setEditorMode, typeInEditor } from './helpers.js';

test.describe('Editor mode classes', () => {
  test('editor-wrap starts with mode-write class', async ({ page }) => {
    await createRoom(page);
    const wrap = page.locator('.editor-wrap');
    await expect(wrap).toHaveClass(/mode-write/);
  });

  test('clicking preview mode adds mode-preview and removes mode-write', async ({ page }) => {
    await createRoom(page);
    await setEditorMode(page, 'preview');
    const wrap = page.locator('.editor-wrap');
    await expect(wrap).toHaveClass(/mode-preview/);
    const classes = await wrap.getAttribute('class') || '';
    expect(classes).not.toContain('mode-write');
    expect(classes).not.toContain('mode-split');
  });

  test('clicking split mode adds mode-split and removes mode-write', async ({ page }) => {
    await createRoom(page);
    await setEditorMode(page, 'split');
    const wrap = page.locator('.editor-wrap');
    await expect(wrap).toHaveClass(/mode-split/);
    const classes = await wrap.getAttribute('class') || '';
    expect(classes).not.toContain('mode-write');
    expect(classes).not.toContain('mode-preview');
  });

  test('switching from split back to write restores mode-write', async ({ page }) => {
    await createRoom(page);
    await setEditorMode(page, 'split');
    await expect(page.locator('.editor-wrap')).toHaveClass(/mode-split/);

    await setEditorMode(page, 'write');
    await expect(page.locator('.editor-wrap')).toHaveClass(/mode-write/);
    const classes = await page.locator('.editor-wrap').getAttribute('class') || '';
    expect(classes).not.toContain('mode-split');
  });

  test('editor is visible in write mode, hidden in preview mode', async ({ page }) => {
    await createRoom(page);
    const editor  = page.locator('#note-editor');
    const preview = page.locator('#note-preview');

    // Write mode: editor visible, preview hidden
    await expect(editor).toBeVisible();
    const previewHidden = await preview.evaluate(el => el.classList.contains('hidden'));
    expect(previewHidden).toBe(true);

    // Preview mode: editor hidden, preview visible
    await setEditorMode(page, 'preview');
    const editorHidden = await editor.evaluate(el => el.classList.contains('hidden'));
    expect(editorHidden).toBe(true);
    await expect(preview).toBeVisible();
  });

  test('both editor and preview visible in split mode', async ({ page }) => {
    await createRoom(page);
    await setEditorMode(page, 'split');
    await expect(page.locator('#note-editor')).toBeVisible();
    await expect(page.locator('#note-preview')).toBeVisible();
  });

  test('mode button has aria-pressed=true only for active mode', async ({ page }) => {
    await createRoom(page);
    const previewBtn = page.locator('.md-seg-btn[data-mode="preview"]');
    const writeBtn   = page.locator('.md-seg-btn[data-mode="write"]');

    // Initially write is active
    await expect(writeBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(previewBtn).toHaveAttribute('aria-pressed', 'false');

    await setEditorMode(page, 'preview');
    await expect(previewBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(writeBtn).toHaveAttribute('aria-pressed', 'false');
  });

  test('preview renders markdown content', async ({ page }) => {
    await createRoom(page);
    await typeInEditor(page, '# Hello World\n\nThis is **bold**.');
    await setEditorMode(page, 'preview');

    const preview = page.locator('#note-preview');
    await expect(preview).toBeVisible();
    const html = await preview.innerHTML();
    // Should contain h1 and strong tags from markdown
    expect(html).toMatch(/h1|<h1/i);
  });
});
