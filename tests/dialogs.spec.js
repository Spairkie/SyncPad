// tests/dialogs.spec.js
// Tests for showPrompt(), focus trapping in modals, and keyboard improvements.

import { test, expect } from '@playwright/test';
import { goToLanding, createRoom, openPanel } from './helpers.js';

// ── showPrompt ─────────────────────────────────────────────────────────────────

test.describe('showPrompt dialog', () => {
  test('renders modal with role=dialog and aria-modal', async ({ page }) => {
    await goToLanding(page);
    await page.evaluate(async () => {
      const { showPrompt } = await import('/SyncPad/src/ui.js');
      showPrompt('Enter your name:', { confirmLabel: 'Save' }); // not awaited — would deadlock
    });
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    await expect(page.locator('#sp-prompt-modal')).toHaveAttribute('role', 'dialog');
    await expect(page.locator('#sp-prompt-modal')).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#sp-prompt-message')).toContainText('Enter your name');
    // Clean up
    await page.evaluate(() => document.getElementById('sp-prompt-cancel').click());
  });

  test('OK resolves with the raw input value (no trimming)', async ({ page }) => {
    // showPrompt does not trim — callers decide whether to trim at the point of use.
    await goToLanding(page);
    const resultPromise = page.evaluate(async () => {
      const { showPrompt } = await import('/SyncPad/src/ui.js');
      return showPrompt('Your name:', { confirmLabel: 'Save' });
    });
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    await page.locator('#sp-prompt-input').fill('Alice');
    await page.evaluate(() => document.getElementById('sp-prompt-ok').click());
    const result = await resultPromise;
    expect(result).toBe('Alice');
  });

  test('Cancel resolves with null', async ({ page }) => {
    await goToLanding(page);
    const resultPromise = page.evaluate(async () => {
      const { showPrompt } = await import('/SyncPad/src/ui.js');
      return showPrompt('Confirm?');
    });
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    await page.evaluate(() => document.getElementById('sp-prompt-cancel').click());
    const result = await resultPromise;
    expect(result).toBeNull();
  });

  test('Escape closes and resolves null', async ({ page }) => {
    await goToLanding(page);
    const resultPromise = page.evaluate(async () => {
      const { showPrompt } = await import('/SyncPad/src/ui.js');
      return showPrompt('Escape test');
    });
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    await page.keyboard.press('Escape');
    const result = await resultPromise;
    expect(result).toBeNull();
    await expect(page.locator('#sp-prompt-modal')).not.toHaveClass(/visible/);
  });

  test('Enter in input field submits', async ({ page }) => {
    await goToLanding(page);
    const resultPromise = page.evaluate(async () => {
      const { showPrompt } = await import('/SyncPad/src/ui.js');
      return showPrompt('Name:');
    });
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    await page.locator('#sp-prompt-input').fill('Bob');
    await page.locator('#sp-prompt-input').press('Enter');
    const result = await resultPromise;
    expect(result).toBe('Bob');
  });

  test('defaultValue pre-fills input', async ({ page }) => {
    await goToLanding(page);
    await page.evaluate(async () => {
      const { showPrompt } = await import('/SyncPad/src/ui.js');
      showPrompt('Rename:', { defaultValue: 'My template' });
    });
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    const value = await page.locator('#sp-prompt-input').inputValue();
    expect(value).toBe('My template');
    await page.evaluate(() => document.getElementById('sp-prompt-cancel').click());
  });

  test('empty input resolves null (not empty string)', async ({ page }) => {
    await goToLanding(page);
    const resultPromise = page.evaluate(async () => {
      const { showPrompt } = await import('/SyncPad/src/ui.js');
      return showPrompt('Name:');
    });
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    // Clear input and click OK
    await page.locator('#sp-prompt-input').fill('');
    await page.evaluate(() => document.getElementById('sp-prompt-ok').click());
    const result = await resultPromise;
    expect(result).toBeNull();
  });

  test('showPrompt returns raw untrimmed value (passphrase preservation)', async ({ page }) => {
    // Passphrases and tokens may have leading/trailing spaces that are meaningful.
    // showPrompt must return the exact typed value — callers that want trimming
    // do so themselves (e.g. template names, passcodes).
    await goToLanding(page);
    const resultPromise = page.evaluate(async () => {
      const { showPrompt } = await import('/SyncPad/src/ui.js');
      return showPrompt('Passphrase:');
    });
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });
    await page.locator('#sp-prompt-input').fill('  secret  ');
    await page.evaluate(() => document.getElementById('sp-prompt-ok').click());
    const result = await resultPromise;
    expect(result).toBe('  secret  ');
  });
});

// ── Long-content wrapping ────────────────────────────────────────────────────

test.describe('Confirm modal wraps long content', () => {
  test('a long filename in the confirm message wraps instead of overflowing', async ({ page }) => {
    await goToLanding(page);
    const longName = 'AVD-Instructions-For-New-Employees-Onboarding-2024-Final-Draft-VeryLongFilename.pdf';
    await page.evaluate(async (name) => {
      const { showConfirm } = await import('/SyncPad/src/ui.js');
      showConfirm(`Delete "${name}"?`, { confirmLabel: 'Delete', danger: true });
    }, longName);
    await page.waitForSelector('#sp-confirm-modal.visible', { timeout: 5000 });

    const overflows = await page.evaluate(() => {
      const msg = document.getElementById('sp-confirm-message');
      return msg.scrollWidth > msg.clientWidth + 1;
    });
    expect(overflows).toBe(false);

    await page.evaluate(() => document.getElementById('sp-confirm-cancel').click());
  });
});

test.describe('Toast wraps long messages', () => {
  test('a long toast message wraps instead of overflowing its bounds', async ({ page }) => {
    await goToLanding(page);
    const longMessage = 'File removed from storage, but the metadata row could not be deleted. Refresh the file list.';
    await page.evaluate(async (msg) => {
      const { showToast } = await import('/SyncPad/src/ui.js');
      showToast(msg, 'error', 10000);
    }, longMessage);
    await page.waitForSelector('.toast', { timeout: 5000 });

    const overflows = await page.evaluate(() => {
      const toast = document.querySelector('.toast');
      return toast.scrollWidth > toast.clientWidth + 1;
    });
    expect(overflows).toBe(false);
  });
});

// ── Stacking on top of full-screen overlays (admin dashboard, loading screen) ──

test.describe('Shared dialogs stack above the admin screen', () => {
  test('showConfirm renders above #admin-screen and is the actual click target', async ({ page }) => {
    await page.goto('/SyncPad/admin');
    await page.waitForSelector('#admin-screen:not(.hidden)', { timeout: 10_000 });

    await page.evaluate(async () => {
      const { showConfirm } = await import('/SyncPad/src/ui.js');
      showConfirm('Run server-side cleanup to delete all expired rooms?', { confirmLabel: 'Run cleanup' });
    });
    await page.waitForSelector('#sp-confirm-modal.visible', { timeout: 5000 });

    const stacking = await page.evaluate(() => {
      const admin = document.getElementById('admin-screen');
      const modal = document.getElementById('sp-confirm-modal');
      const okBtn = document.getElementById('sp-confirm-ok');
      const rect = okBtn.getBoundingClientRect();
      const topEl = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        adminZ: Number(getComputedStyle(admin).zIndex),
        modalZ: Number(getComputedStyle(modal).zIndex),
        okBtnIsClickTarget: topEl === okBtn || okBtn.contains(topEl),
      };
    });
    expect(stacking.modalZ).toBeGreaterThan(stacking.adminZ);
    expect(stacking.okBtnIsClickTarget).toBe(true);

    await page.evaluate(() => document.getElementById('sp-confirm-cancel').click());
  });
});

// ── Modal focus trapping (A-2) ─────────────────────────────────────────────────

test.describe('Confirm modal focus trap (A-2)', () => {
  test('Tab cycles within confirm modal buttons', async ({ page }) => {
    await goToLanding(page);
    await page.evaluate(async () => {
      const { showConfirm } = await import('/SyncPad/src/ui.js');
      showConfirm('Focus trap test?', { danger: false });
    });
    await page.waitForSelector('#sp-confirm-modal.visible', { timeout: 5000 });

    // Focus the OK button first
    await page.locator('#sp-confirm-ok').focus();
    // Tab should wrap to Cancel (last→first cycle)
    await page.keyboard.press('Tab');
    await expect(page.locator('#sp-confirm-cancel')).toBeFocused();
    // Tab again should wrap to OK
    await page.keyboard.press('Tab');
    await expect(page.locator('#sp-confirm-ok')).toBeFocused();

    await page.evaluate(() => document.getElementById('sp-confirm-cancel').click());
  });

  test('Shift+Tab reverse-cycles within confirm modal', async ({ page }) => {
    await goToLanding(page);
    await page.evaluate(async () => {
      const { showConfirm } = await import('/SyncPad/src/ui.js');
      showConfirm('Shift+Tab test?');
    });
    await page.waitForSelector('#sp-confirm-modal.visible', { timeout: 5000 });

    // Focus Cancel first and wait for focus to settle before pressing keys
    await page.locator('#sp-confirm-cancel').focus();
    await page.waitForFunction(
      () => document.activeElement?.id === 'sp-confirm-cancel',
      null, { timeout: 2000 }
    );
    // Shift+Tab from first element should wrap to last
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#sp-confirm-ok')).toBeFocused();

    await page.evaluate(() => document.getElementById('sp-confirm-cancel').click());
  });
});

test.describe('Prompt modal focus trap (A-2)', () => {
  test('Tab cycles: input → cancel → ok → input', async ({ page }) => {
    await goToLanding(page);
    await page.evaluate(async () => {
      const { showPrompt } = await import('/SyncPad/src/ui.js');
      showPrompt('Trap test:');
    });
    await page.waitForSelector('#sp-prompt-modal.visible', { timeout: 5000 });

    // Input starts focused; Tab moves to Cancel
    await page.locator('#sp-prompt-input').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#sp-prompt-cancel')).toBeFocused();
    // Tab moves to OK
    await page.keyboard.press('Tab');
    await expect(page.locator('#sp-prompt-ok')).toBeFocused();
    // Tab wraps back to input
    await page.keyboard.press('Tab');
    await expect(page.locator('#sp-prompt-input')).toBeFocused();

    await page.evaluate(() => document.getElementById('sp-prompt-cancel').click());
  });
});

// ── Device count badge keyboard access (A-3) ──────────────────────────────────

test.describe('Device count badge keyboard (A-3)', () => {
  test('badge has role=button and tabindex=0', async ({ page }) => {
    await createRoom(page);
    const badge = page.locator('#device-count-btn');
    await expect(badge).toHaveAttribute('role', 'button');
    await expect(badge).toHaveAttribute('tabindex', '0');
  });

  test('Enter key opens presence panel', async ({ page }) => {
    await createRoom(page);
    const badge = page.locator('#device-count-btn');
    await badge.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#presence-panel')).toHaveClass(/open/, { timeout: 3000 });
  });

  test('Space key opens presence panel', async ({ page }) => {
    await createRoom(page);
    const badge = page.locator('#device-count-btn');
    await badge.focus();
    await page.keyboard.press(' ');
    await expect(page.locator('#presence-panel')).toHaveClass(/open/, { timeout: 3000 });
  });
});

// ── More-dropdown keyboard navigation (A-4) ───────────────────────────────────

test.describe('More-dropdown keyboard navigation (A-4)', () => {
  test('opening the dropdown focuses the first menu item', async ({ page }) => {
    await createRoom(page);
    const moreBtn = page.locator('#btn-more');
    await moreBtn.click();
    await page.waitForSelector('#more-dropdown.open', { timeout: 3000 });
    // First menuitem should be focused after rAF
    await page.waitForFunction(() => {
      const first = document.querySelector('#more-dropdown [role="menuitem"]');
      return first && document.activeElement === first;
    }, null, { timeout: 2000 });
    const firstItem = page.locator('#more-dropdown [role="menuitem"]').first();
    await expect(firstItem).toBeFocused();
    // Clean up
    await page.keyboard.press('Escape');
  });

  test('ArrowDown moves focus to next menu item', async ({ page }) => {
    await createRoom(page);
    await page.locator('#btn-more').click();
    await page.waitForSelector('#more-dropdown.open', { timeout: 3000 });
    // Wait for focus to land on first item
    await page.waitForFunction(() => {
      const first = document.querySelector('#more-dropdown [role="menuitem"]');
      return first && document.activeElement === first;
    }, null, { timeout: 2000 });
    // ArrowDown should move to second item
    await page.keyboard.press('ArrowDown');
    const secondItem = page.locator('#more-dropdown [role="menuitem"]').nth(1);
    await expect(secondItem).toBeFocused();
    await page.keyboard.press('Escape');
  });

  test('Escape closes dropdown and returns focus to trigger', async ({ page }) => {
    await createRoom(page);
    await page.locator('#btn-more').click();
    await page.waitForSelector('#more-dropdown.open', { timeout: 3000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#more-dropdown')).not.toHaveClass(/open/);
    await expect(page.locator('#btn-more')).toBeFocused();
  });
});

// ── Presence live-region announcer ──────────────────────────────────────────────

test.describe('Presence live announcer', () => {
  test('does not announce already-present devices as joining on first render', async ({ page }) => {
    await goToLanding(page);
    const text = await page.evaluate(async () => {
      const ui = await import('/SyncPad/src/ui.js');
      ui.resetPresenceAnnouncer();
      ui.renderDevicesList([
        { device_id: 'me', device_name: 'Me' },
        { device_id: 'a', device_name: 'Alice', typing: false },
      ], 'me', () => {});
      return document.getElementById('presence-live-region').textContent;
    });
    expect(text).toBe('');
  });

  test('announces a device joining after the first render', async ({ page }) => {
    await goToLanding(page);
    const text = await page.evaluate(async () => {
      const ui = await import('/SyncPad/src/ui.js');
      ui.resetPresenceAnnouncer();
      ui.renderDevicesList([{ device_id: 'me', device_name: 'Me' }], 'me', () => {});
      ui.renderDevicesList([
        { device_id: 'me', device_name: 'Me' },
        { device_id: 'a', device_name: 'Alice', typing: false },
      ], 'me', () => {});
      return document.getElementById('presence-live-region').textContent;
    });
    expect(text).toBe('Alice joined.');
  });

  test('announces a device starting to type, but not per-keystroke cursor movement', async ({ page }) => {
    await goToLanding(page);
    const result = await page.evaluate(async () => {
      const ui = await import('/SyncPad/src/ui.js');
      const region = () => document.getElementById('presence-live-region').textContent;
      ui.resetPresenceAnnouncer();
      ui.renderDevicesList([
        { device_id: 'me', device_name: 'Me' },
        { device_id: 'a', device_name: 'Alice', typing: false },
      ], 'me', () => {});
      ui.renderDevicesList([
        { device_id: 'me', device_name: 'Me' },
        { device_id: 'a', device_name: 'Alice', typing: true },
      ], 'me', () => {});
      const afterTyping = region();
      // Cursor-line-only change on an already-typing device must not re-fire the region.
      ui.renderDevicesList([
        { device_id: 'me', device_name: 'Me' },
        { device_id: 'a', device_name: 'Alice', typing: true, cursor_line: 12 },
      ], 'me', () => {});
      return { afterTyping, afterCursorMove: region() };
    });
    expect(result.afterTyping).toBe('Alice started typing.');
    expect(result.afterCursorMove).toBe('Alice started typing.'); // unchanged
  });

  test('announces a device leaving', async ({ page }) => {
    await goToLanding(page);
    const text = await page.evaluate(async () => {
      const ui = await import('/SyncPad/src/ui.js');
      ui.resetPresenceAnnouncer();
      ui.renderDevicesList([
        { device_id: 'me', device_name: 'Me' },
        { device_id: 'a', device_name: 'Alice', typing: false },
      ], 'me', () => {});
      ui.renderDevicesList([{ device_id: 'me', device_name: 'Me' }], 'me', () => {});
      return document.getElementById('presence-live-region').textContent;
    });
    expect(text).toBe('Alice left.');
  });
});
