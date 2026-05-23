// SyncPad – templates.js
// Static built-in templates + localStorage-backed custom templates.

// ── Built-in templates ────────────────────────────────────────────────────────

export const TEMPLATES = {
  blank: {
    label: 'Blank note',
    body:  '',
  },

  checklist: {
    label: 'Checklist',
    body:
`- [ ] First task
- [ ] Second task
- [ ] Third task
`,
  },

  meeting: {
    label: 'Meeting notes',
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
    body:
`# Quick Links
-
`,
  },

  troubleshoot: {
    label: 'Troubleshooting notes',
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
    body:
`Subject:

Good morning,



Thank you,
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

function _saveCustomTemplates(templates) {
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(templates)); } catch {}
}

/**
 * Save the current note text as a new custom template.
 * @param {string} label  – display name
 * @param {string} body   – template text
 * @returns {string} key  – generated key for this template
 */
export function saveCustomTemplate(label, body) {
  const key  = `custom_${Date.now()}`;
  const all  = getCustomTemplates();
  all[key]   = { label: label.trim().slice(0, 60) || 'Untitled', body };
  _saveCustomTemplates(all);
  return key;
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
