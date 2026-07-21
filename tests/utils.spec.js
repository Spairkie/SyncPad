// tests/utils.spec.js
// Unit tests for utility functions — run in Node.js context via Playwright page.evaluate
// so that the ESM modules can be imported in the browser context.

import { test, expect } from '@playwright/test';
import { goToLanding } from './helpers.js';

/**
 * Import a SyncPad module in the browser context and return the result of fn.
 */
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

test.describe('escapeHtml()', () => {
  test('escapes < > & " characters', async ({ page }) => {
    await goToLanding(page);
    const result = await inBrowser(page, '/SyncPad/src/utils.js', (mod) =>
      mod.escapeHtml('<script>alert("xss")</script>&')
    );
    expect(result).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;&amp;');
  });

  test('returns empty string for null/undefined', async ({ page }) => {
    await goToLanding(page);
    const r1 = await inBrowser(page, '/SyncPad/src/utils.js', (mod) => mod.escapeHtml(null));
    const r2 = await inBrowser(page, '/SyncPad/src/utils.js', (mod) => mod.escapeHtml(undefined));
    expect(r1).toBe('');
    expect(r2).toBe('');
  });

  test('leaves safe strings unchanged', async ({ page }) => {
    await goToLanding(page);
    const result = await inBrowser(page, '/SyncPad/src/utils.js', (mod) =>
      mod.escapeHtml('Hello World 123')
    );
    expect(result).toBe('Hello World 123');
  });
});

test.describe('formatFileSize()', () => {
  test('formats bytes', async ({ page }) => {
    await goToLanding(page);
    const result = await inBrowser(page, '/SyncPad/src/utils.js', (mod) =>
      mod.formatFileSize(500)
    );
    expect(result).toContain('500');
  });

  test('formats kilobytes', async ({ page }) => {
    await goToLanding(page);
    const result = await inBrowser(page, '/SyncPad/src/utils.js', (mod) =>
      mod.formatFileSize(2048)
    );
    expect(result).toContain('KB');
  });

  test('formats megabytes', async ({ page }) => {
    await goToLanding(page);
    const result = await inBrowser(page, '/SyncPad/src/utils.js', (mod) =>
      mod.formatFileSize(5 * 1024 * 1024)
    );
    expect(result).toContain('MB');
  });
});

test.describe('countWords()', () => {
  test('counts words correctly', async ({ page }) => {
    await goToLanding(page);
    const result = await inBrowser(page, '/SyncPad/src/utils.js', (mod) =>
      mod.countWords('hello world foo bar')
    );
    expect(result).toBe(4);
  });

  test('returns 0 for empty string', async ({ page }) => {
    await goToLanding(page);
    const result = await inBrowser(page, '/SyncPad/src/utils.js', (mod) =>
      mod.countWords('')
    );
    expect(result).toBe(0);
  });

  test('handles leading/trailing whitespace', async ({ page }) => {
    await goToLanding(page);
    const result = await inBrowser(page, '/SyncPad/src/utils.js', (mod) =>
      mod.countWords('   three words here   ')
    );
    expect(result).toBe(3);
  });
});

test.describe('Templates module', () => {
  test('TEMPLATES has at least 13 entries', async ({ page }) => {
    await goToLanding(page);
    const count = await inBrowser(page, '/SyncPad/src/templates.js', (mod) =>
      Object.keys(mod.TEMPLATES).length
    );
    expect(count).toBeGreaterThanOrEqual(13);
  });

  test('BODY_MAX is 50000', async ({ page }) => {
    await goToLanding(page);
    const bodyMax = await inBrowser(page, '/SyncPad/src/templates.js', (mod) => mod.BODY_MAX);
    expect(bodyMax).toBe(50_000);
  });

  test('getTemplate returns built-in template body', async ({ page }) => {
    await goToLanding(page);
    const body = await inBrowser(page, '/SyncPad/src/templates.js', (mod) =>
      mod.getTemplate('checklist')
    );
    expect(typeof body).toBe('string');
    expect(body).toContain('[ ]');
  });

  test('importCustomTemplates returns -1 for invalid JSON', async ({ page }) => {
    await goToLanding(page);
    const count = await inBrowser(page, '/SyncPad/src/templates.js', (mod) =>
      mod.importCustomTemplates('not valid json')
    );
    expect(count).toBe(-1);
  });

  test('importCustomTemplates returns -1 for JSON array', async ({ page }) => {
    await goToLanding(page);
    const count = await inBrowser(page, '/SyncPad/src/templates.js', (mod) =>
      mod.importCustomTemplates('[]')
    );
    expect(count).toBe(-1);
  });

  test('exportCustomTemplates returns valid JSON string', async ({ page }) => {
    await goToLanding(page);
    const json = await inBrowser(page, '/SyncPad/src/templates.js', (mod) =>
      mod.exportCustomTemplates()
    );
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

test.describe('Markdown renderer', () => {
  test('renderMarkdown returns safe HTML', async ({ page }) => {
    await goToLanding(page);
    const html = await inBrowser(page, '/SyncPad/src/markdown.js', (mod) =>
      mod.renderMarkdown('**bold** and <script>xss</script>')
    );
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('toggleChecklistItem toggles checked state', async ({ page }) => {
    await goToLanding(page);
    const result = await inBrowser(page, '/SyncPad/src/markdown.js', (mod) =>
      mod.toggleChecklistItem('- [ ] Item one\n- [ ] Item two\n', 0, true)
    );
    expect(result).toContain('[x] Item one');
    expect(result).toContain('[ ] Item two');
  });

  test('a checkbox after a blockquoted checklist toggles the right source line', async ({ page }) => {
    // Regression for the ctx.cbCounter-sharing bug: the render-time index
    // assigned to "normal" must match a real index toggleChecklistItem()'s
    // source scan recognizes (it never counts blockquoted checklist lines),
    // or clicking the checkbox silently does nothing.
    await goToLanding(page);
    const result = await inBrowser(page, '/SyncPad/src/markdown.js', (mod) => {
      const src = '> - [ ] quoted\n\n- [ ] normal';
      const html = mod.renderMarkdown(src);
      const indices = [...html.matchAll(/data-cb-index="(\d+)"/g)].map((m) => Number(m[1]));
      const normalIndex = indices[1]; // second rendered checkbox is "normal"
      return mod.toggleChecklistItem(src, normalIndex, true);
    });
    expect(result).toContain('- [x] normal');
    expect(result).toContain('> - [ ] quoted'); // unaffected
  });

  test('renderMarkdownWithToc derives labels from rendered text, not raw markdown syntax', async ({ page }) => {
    await goToLanding(page);
    const headings = await inBrowser(page, '/SyncPad/src/markdown.js', (mod) => {
      const src = '# Intro\n\n## [API guide](https://example.com)\n\n### **Bold** and `code`';
      return mod.renderMarkdownWithToc(src).headings;
    });
    expect(headings.map((h) => h.text)).toEqual(['Intro', 'API guide', 'Bold and code']);
    // Never the raw markdown link syntax leaking through.
    expect(headings[1].text).not.toContain('[');
    expect(headings[1].text).not.toContain('(https://');
  });
});
