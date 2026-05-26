// SyncPad – templates.js
// Static built-in templates + localStorage-backed custom templates.

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum body size for any custom template (characters). */
export const BODY_MAX = 50_000;

// ── Built-in templates ────────────────────────────────────────────────────────

export const TEMPLATES = {
  blank: {
    label: 'Blank note',
    desc:  'Empty canvas to start from scratch',
    body:  '',
  },

  checklist: {
    label: 'Checklist',
    desc:  'Simple task list with checkboxes',
    body:
`- [ ] First task
- [ ] Second task
- [ ] Third task
`,
  },

  meeting: {
    label: 'Meeting notes',
    desc:  'Agenda, discussion notes, and action items',
    body:
`# Meeting Notes
Date:
Attendees:

## Agenda
-

## Notes
-

## Action Items
- [ ]
`,
  },

  quicklinks: {
    label: 'Quick links',
    desc:  'Shared list of URLs and resources',
    body:
`# Quick Links
-
`,
  },

  troubleshoot: {
    label: 'Troubleshooting notes',
    desc:  'Issue description, steps tried, and next steps',
    body:
`# Troubleshooting Notes
Issue:
Device/User:

Steps Tried:
1.
2.
3.

Result:
Next Step:
`,
  },

  daily: {
    label: 'Daily plan',
    desc:  'Top priorities, task list, and notes for the day',
    body:
`# Daily Plan
Date:

## Top Priorities
1.
2.
3.

## Tasks
- [ ]

## Notes
-
`,
  },

  email: {
    label: 'Email draft',
    desc:  'Quick email draft skeleton',
    body:
`Subject:

Good morning,



Thank you,
`,
  },

  standup: {
    label: 'Daily standup',
    desc:  'Yesterday / today / blockers — scrum format',
    body:
`# Daily Standup
Date:

**Yesterday**
-

**Today**
-

**Blockers**
- None
`,
  },

  bug: {
    label: 'Bug report',
    desc:  'Reproducible steps, expected vs actual behaviour',
    body:
`# Bug Report
**Title:**
**Reported by:**
**Date:**

## Environment
- OS:
- Browser / App version:
- URL / Route:

## Steps to Reproduce
1.
2.
3.

## Expected Behaviour


## Actual Behaviour


## Screenshots / Logs


## Severity
- [ ] Critical  - [ ] High  - [ ] Medium  - [ ] Low

## Notes
`,
  },

  review: {
    label: 'Code review',
    desc:  'Checklist for reviewing a pull request',
    body:
`# Code Review
PR / Branch:
Reviewer:
Date:

## Checklist
- [ ] Logic is correct and handles edge cases
- [ ] No obvious security issues (XSS, injection, auth)
- [ ] Tests added or updated
- [ ] No unnecessary complexity / dead code
- [ ] Naming is clear and consistent
- [ ] Error handling is adequate
- [ ] Performance considerations addressed

## Comments


## Decision
- [ ] Approve  - [ ] Request changes  - [ ] Needs discussion
`,
  },

  weekly: {
    label: 'Weekly review',
    desc:  'Wins, challenges, lessons, and next week plan',
    body:
`# Weekly Review
Week of:

## Wins 🎉
-

## Challenges
-

## Lessons Learned
-

## Next Week — Top 3 Goals
1.
2.
3.

## Notes
`,
  },

  shopping: {
    label: 'Shopping list',
    desc:  'Categorised grocery / shopping list',
    body:
`# Shopping List
Date:

## Produce
- [ ]

## Dairy & Eggs
- [ ]

## Pantry
- [ ]

## Meat & Fish
- [ ]

## Other
- [ ]
`,
  },

  project: {
    label: 'Project brief',
    desc:  'Goal, scope, timeline, and stakeholders',
    body:
`# Project Brief
**Project name:**
**Owner:**
**Date:**

## Goal


## Scope
**In scope:**
-

**Out of scope:**
-

## Timeline
| Milestone | Date |
|-----------|------|
|           |      |

## Stakeholders
| Name | Role |
|------|------|
|      |      |

## Risks


## Notes
`,
  },
};

export function getTemplate(key) {
  // Check custom templates first
  const custom = getCustomTemplates();
  if (custom[key]) return custom[key].body;
  return TEMPLATES[key]?.body ?? null;
}

export function templateKeys() {
  return Object.keys(TEMPLATES);
}

// ── Custom templates (localStorage) ──────────────────────────────────────────

const CUSTOM_KEY = 'syncpad_custom_templates';

/**
 * Load custom templates from localStorage.
 * @returns {Record<string, {label: string, body: string}>}
 */
export function getCustomTemplates() {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
}

/**
 * Persist custom templates. Throws a structured error on QuotaExceededError
 * so callers can surface feedback rather than silently swallowing the failure.
 */
function _saveCustomTemplates(templates) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(templates));
  } catch (err) {
    if (err?.name === 'QuotaExceededError' || err?.code === 22) {
      const quota = new Error('Browser storage is full — template could not be saved.');
      quota.code = 'QUOTA_EXCEEDED';
      throw quota;
    }
    throw err;
  }
}

/**
 * Save the current note text as a new custom template.
 * Body is capped at BODY_MAX characters. Throws if storage is full.
 * @param {string} label  – display name
 * @param {string} body   – template text
 * @returns {{ key: string, truncated: boolean }}
 */
export function saveCustomTemplate(label, body) {
  const truncated = body.length > BODY_MAX;
  const key = `custom_${Date.now()}`;
  const all = getCustomTemplates();
  all[key]  = {
    label: label.trim().slice(0, 60) || 'Untitled',
    body:  truncated ? body.slice(0, BODY_MAX) : body,
  };
  _saveCustomTemplates(all); // may throw QUOTA_EXCEEDED
  return { key, truncated };
}

/**
 * Rename an existing custom template.
 */
export function renameCustomTemplate(key, newLabel) {
  const all = getCustomTemplates();
  if (!all[key]) return;
  all[key].label = newLabel.trim().slice(0, 60) || all[key].label;
  _saveCustomTemplates(all);
}

/**
 * Delete a custom template.
 */
export function deleteCustomTemplate(key) {
  const all = getCustomTemplates();
  delete all[key];
  _saveCustomTemplates(all);
}

// ── Export / Import ───────────────────────────────────────────────────────────

/**
 * Serialise all custom templates to a JSON string for file download.
 * @returns {string}
 */
export function exportCustomTemplates() {
  return JSON.stringify(getCustomTemplates(), null, 2);
}

/**
 * Merge templates from a JSON string into the existing custom templates.
 * Each entry must have `label` (string) and `body` (string).
 * Bodies are capped at BODY_MAX. Returns the number imported, or -1 on parse error.
 * @param {string} jsonStr
 * @returns {number}
 */
export function importCustomTemplates(jsonStr) {
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return -1;
  } catch { return -1; }

  const existing = getCustomTemplates();
  let count = 0;
  for (const [key, t] of Object.entries(parsed)) {
    if (!t || typeof t !== 'object') continue;
    if (typeof t.label !== 'string' || typeof t.body !== 'string') continue;
    // Prefix imported keys with 'imp_' to avoid collisions with own 'custom_...' keys.
    const importKey = key.startsWith('imp_') ? key : `imp_${key}`;
    existing[importKey] = {
      label: t.label.trim().slice(0, 60) || 'Untitled',
      body:  t.body.slice(0, BODY_MAX),
    };
    count++;
  }
  _saveCustomTemplates(existing); // may throw QUOTA_EXCEEDED
  return count;
}
