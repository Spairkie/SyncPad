# SyncPad Playwright Test Guide

This document covers everything you need to run, understand, and extend the SyncPad Playwright test suite.

---

## 1. Prerequisites & Quick Start

**Requirements**

- Node.js 18 or later
- npm

**First-time setup**

```bash
# 1. Install dependencies (includes @playwright/test)
npm install

# 2. Install Playwright browser binaries
npx playwright install

# 3. Start the static file server in one terminal
npm run serve

# 4. Run the full test suite in another terminal
npm test
```

The static server must be running on port 5555 before executing tests. In CI, Playwright starts the server automatically via its `webServer` config block. In local development, `reuseExistingServer` is enabled, so if you already have `npm run serve` running the tests will attach to it rather than spawning a new process.

---

## 2. Running Tests

| Command | Description |
|---|---|
| `npm test` | Run all tests across all browser projects, headless |
| `npm run test:chrome` | Run all tests in Chromium only |
| `npm run test:headed` | Run tests with the browser window visible |
| `npm run test:ui` | Launch Playwright's interactive UI mode |
| `npm run test:report` | Open the last HTML report in your browser |
| `npm run serve` | Start the static server on port 5555 (required for local runs) |

You can also pass Playwright flags directly through `npx`:

```bash
# Run a single spec file
npx playwright test tests/editor.spec.js

# Run tests matching a title substring
npx playwright test -g "word count"

# Run only webkit
npx playwright test --project=webkit
```

---

## 3. Browser Projects

Tests run against four browser configurations defined in `playwright.config.js`:

| Project | Device preset | Notes |
|---|---|---|
| `chromium` | Desktop Chrome | Primary desktop target |
| `firefox` | Desktop Firefox | Gecko engine coverage |
| `webkit` | Desktop Safari | WebKit engine coverage |
| `mobile-chrome` | Pixel 5 | Mobile viewport and touch behaviour |

**CI behaviour:** When `process.env.CI` is set, Playwright enables `retries: 2` (each failing test is retried up to twice before being marked as failed) and limits workers to 1 to avoid resource contention. `forbidOnly` is also enabled in CI so accidentally committed `test.only` calls cause the run to fail immediately.

`fullyParallel: true` means individual spec files run in parallel with each other. Tests within a single file run serially by default.

---

## 4. Test File Overview

All spec files live in `tests/`. Each file is focused on a single area of the application.

| File | What it tests |
|---|---|
| `landing.spec.js` | Landing page: logo, tagline, and button visibility; new-room navigation; valid room ID format; join button and Enter-key behaviour; feature chips |
| `editor.spec.js` | Note editor: textarea input, word count display, preview/split/write mode switching, export modal, empty-export toast |
| `markdown.spec.js` | Markdown renderer: H1–H3 headings, bold, italic, inline code, fenced code blocks, ordered and unordered lists, GFM checkboxes, HTTPS links, `javascript:` URL blocking, no double-escaping, snake_case not italicised |
| `search.spec.js` | Find & Replace panel: Ctrl+F to open, Esc to close, match count display, "No results" state, Next/Prev cycling with wrap, Enter advances match, Replace action, Replace All action, Tab/Shift+Tab panel navigation |
| `settings.spec.js` | Settings panel: open/close, expiration presets visible, rejection of values below 5 minutes (30 s and 4 m), acceptance of 5-minute value, theme picker rendering, theme class applied to document |
| `routing.spec.js` | URL routing: `/`, `/admin`, `/contact`, `/privacy`, `/terms`, arbitrary room IDs, single screen visible at a time, browser back navigation |
| `accessibility.spec.js` | A11y: Tab-key navigation on landing, Esc closes modals, `files-list` has `role=list`, `devices-list` has `role=list`, confirm modal has `role=dialog` and `aria-modal`, OK resolves true, Esc resolves false, danger mode focuses Cancel, editor accessible label, icon buttons carry `aria-label` or `title` |
| `utils.spec.js` | Unit tests via `inBrowser()`: `escapeHtml`, `formatFileSize`, `countWords`, `TEMPLATES` count ≥ 13, `BODY_MAX` = 50 000, `getTemplate`, `importCustomTemplates` error cases, `exportCustomTemplates` valid JSON, `renderMarkdown` XSS safety, `toggleChecklistItem` |

There is also a `templates.spec.js` file covering template-specific behaviour.

---

## 5. Helper Utilities

Shared helpers live in `tests/helpers.js` and are imported by all spec files. Use them instead of duplicating navigation or interaction logic.

| Function | Signature | Description |
|---|---|---|
| `goToLanding` | `(page) => Promise<void>` | Navigates to `/SyncPad/` and waits for `#landing-screen` to be visible. |
| `createRoom` | `(page) => Promise<string>` | Calls `goToLanding`, clicks `.landing-create-btn`, waits for `#app-screen`, and returns the room ID extracted from the URL. |
| `typeInEditor` | `(page, text, options?) => Promise<void>` | Clicks `#note-editor`, optionally clears it (`clear: true` by default), then fills it with `text`. |
| `getEditorContent` | `(page) => Promise<string>` | Returns the current value of `#note-editor`. |
| `openPanel` | `(page, panelId) => Promise<void>` | Opens the side panel with the given ID if it is not already open. Finds the toggle button via `[aria-controls]` or `[data-panel]`. |
| `waitForToast` | `(page, textOrPattern, options?) => Promise<void>` | Waits for a `.toast` element containing the given text or pattern to become visible. Default timeout is 5 000 ms. |
| `closePanels` | `(page) => Promise<void>` | Clicks `#panel-backdrop` to dismiss any open panel, but only if the backdrop is currently visible. |
| `roomIdFromUrl` | `(url: string) => string` | Pure function. Parses a SyncPad URL and returns the room ID segment, or an empty string if the URL does not match. |

---

## 6. The `inBrowser()` Pattern

### What it does

`inBrowser()` is a local helper defined in `utils.spec.js` that lets you import a SyncPad ESM module inside the browser context and call one of its exported functions, with the result serialised back to Node.js.

```js
async function inBrowser(page, modulePath, fn) {
  return page.evaluate(
    async ({ path, fnStr }) => {
      const mod = await import(path);
      const fn = new Function('mod', `return (${fnStr})(mod)`);
      return fn(mod);
    },
    { path: modulePath, fnStr: fn.toString() }
  );
}
```

### When to use it

Use `inBrowser()` when you want to unit-test a pure utility function that lives in an ESM module. Because SyncPad's source files use `import`/`export`, they cannot be required directly in Node.js without a bundler. Running the function inside `page.evaluate` lets the browser's native ES module loader handle the import.

Do not use `inBrowser()` for tests that involve DOM interaction or real user flows — use the standard Playwright locator API for those.

### Example

```js
import { test, expect } from '@playwright/test';
import { createRoom } from './helpers.js';

async function inBrowser(page, modulePath, fn) {
  return page.evaluate(
    async ({ path, fnStr }) => {
      const mod = await import(path);
      const fn = new Function('mod', `return (${fnStr})(mod)`);
      return fn(mod);
    },
    { path: modulePath, fnStr: fn.toString() }
  );
}

test('escapeHtml escapes angle brackets', async ({ page }) => {
  // createRoom navigates to a SyncPad page so that /SyncPad/src/utils.js
  // is on the same origin and can be imported.
  await createRoom(page);

  const result = await inBrowser(page, '/SyncPad/src/utils.js', (mod) =>
    mod.escapeHtml('<b>hello</b>')
  );

  expect(result).toBe('&lt;b&gt;hello&lt;/b&gt;');
});
```

**Important:** `createRoom(page)` must be called before `inBrowser()` so that the page is on the `http://localhost:5555` origin. The dynamic `import()` inside `page.evaluate` will fail with a cross-origin error if the page is on a different origin.

The function passed to `inBrowser()` is serialised with `.toString()` and reconstructed with `new Function` inside the browser. It must therefore be a self-contained expression that takes a single argument (`mod`, the imported module object) and returns a serialisable value. Closures over outer variables will not work.

---

## 7. Writing New Tests

### Conventions

- **Always call `createRoom(page)` before interacting with the app.** Tests that navigate to the editor must start from a fresh room. Tests that only need the landing page can call `goToLanding(page)` instead.
- **Use helpers from `tests/helpers.js`** for common actions (opening panels, typing, reading editor content, waiting for toasts). This keeps tests short and avoids duplicated selectors.
- **Group related tests with `test.describe`.** Use a descriptive label that matches the feature or user action, for example `test.describe('Replace All', () => { … })`.
- **Prefer semantic selectors.** Target elements by their `id`, `role`, `aria-label`, or stable class names rather than positional CSS selectors.
- **Keep each test focused.** One logical behaviour per test makes failures easy to diagnose.

### Basic test structure

```js
import { test, expect } from '@playwright/test';
import { createRoom, typeInEditor, waitForToast } from './helpers.js';

test.describe('My Feature', () => {
  test('does something useful', async ({ page }) => {
    await createRoom(page);

    // Arrange: put the app into the required state
    await typeInEditor(page, 'Hello world');

    // Act: perform the action under test
    await page.click('#my-feature-button');

    // Assert: verify the expected outcome
    await waitForToast(page, 'Success');
    await expect(page.locator('#result')).toHaveText('Hello world');
  });
});
```

---

## 8. Adding Tests for a New Feature

Follow these steps when adding coverage for a new feature.

**Step 1 — Create the spec file**

Name the file after the feature area: `tests/<feature>.spec.js`. Import from `@playwright/test` and from `./helpers.js`.

```js
import { test, expect } from '@playwright/test';
import { createRoom, openPanel } from './helpers.js';
```

**Step 2 — Navigate to the right starting point**

Almost every test needs a room. Call `createRoom(page)` at the start of each test (or in a `test.beforeEach` block if every test in the describe group needs it).

```js
test.beforeEach(async ({ page }) => {
  await createRoom(page);
});
```

**Step 3 — Open the relevant panel or modal**

If your feature lives in a side panel, use `openPanel(page, 'panel-id')`. Check the panel's HTML `id` attribute in the application source.

```js
await openPanel(page, 'settings-panel');
```

**Step 4 — Pick locators**

Use Playwright's recommended locator strategies in this order of preference:

| Preferred | Example |
|---|---|
| `getByRole` | `page.getByRole('button', { name: 'Save' })` |
| `getByLabel` | `page.getByLabel('Room name')` |
| `getByText` | `page.getByText('No results')` |
| `locator` by id | `page.locator('#export-modal')` |
| `locator` by class | `page.locator('.toast')` |

Avoid selecting by position (`:nth-child`) or by implementation-specific class names that are likely to change.

**Step 5 — Assert with `expect`**

Use the built-in Playwright assertions which automatically retry until the condition is met or the timeout is reached:

```js
await expect(page.locator('#word-count')).toHaveText('3 words');
await expect(page.locator('#export-modal')).toBeVisible();
await expect(page.locator('#theme-toggle')).toHaveClass(/dark/);
```

**Step 6 — Run your new spec**

```bash
npx playwright test tests/myfeature.spec.js --headed
```

Review failures in the terminal or open the HTML report with `npm run test:report`.

---

## 9. CI Integration

The configuration in `playwright.config.js` detects CI automatically via `process.env.CI`:

```js
forbidOnly: !!process.env.CI,   // fail immediately if test.only is present
retries:    process.env.CI ? 2 : 0,  // retry flaky tests up to 2 times in CI
workers:    process.env.CI ? 1 : undefined,  // single worker in CI for stability
```

The `webServer` block tells Playwright to start the static server before the test run:

```js
webServer: {
  command: 'npx serve . -l 5555 --no-clipboard',
  url: 'http://localhost:5555',
  reuseExistingServer: !process.env.CI,  // always start fresh in CI
  timeout: 20_000,
}
```

In CI, `reuseExistingServer` is `false`, so Playwright always spawns a fresh server and tears it down after the run. This prevents port conflicts from a previous failed run.

**Artifacts:** On failure, Playwright saves screenshots and videos to `test-results/` and writes a full HTML report to `playwright-report/`. Configure your CI pipeline to upload these directories as job artifacts so you can inspect failures without re-running the suite.

---

## 10. Debugging

### Headed mode

Run tests with a visible browser window to watch interactions in real time:

```bash
npm run test:headed

# Or for a single file
npx playwright test tests/editor.spec.js --headed
```

### UI mode

Playwright's interactive UI lets you step through tests, see a timeline of actions, and re-run individual tests with a click:

```bash
npm run test:ui
```

### Trace viewer

When a test fails after a retry, Playwright records a trace (configured via `trace: 'on-first-retry'` in `playwright.config.js`). Open the trace for a specific test:

```bash
npx playwright show-trace test-results/<test-folder>/trace.zip
```

The trace viewer shows a full timeline of every action, DOM snapshots, network requests, and console output.

### Screenshots and videos

The config sets `screenshot: 'only-on-failure'` and `video: 'retain-on-failure'`. After a failed run, find these files under `test-results/`. Open the HTML report for a structured view:

```bash
npm run test:report
```

### Slowdown and pause

To slow down test execution (useful when debugging timing issues) or pause at a specific line, use Playwright's built-in helpers inside your test:

```js
// Slow every action by 500 ms — pass via CLI instead:
// npx playwright test --headed --slowmo=500

// Pause and open the Playwright inspector at this point
await page.pause();
```

`page.pause()` only works in headed or UI mode and has no effect in headless CI runs.
