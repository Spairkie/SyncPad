// SyncPad – templates.js
// Static template registry. Each template is plain text; the editor stays
// plain text in the database. Markdown preview renders them prettily.

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
  return TEMPLATES[key]?.body ?? null;
}

export function templateKeys() {
  return Object.keys(TEMPLATES);
}
