// SyncPad – theme.js
// CSS-variable-based theme system. Themes override :root variables
// via a data-theme attribute on <html>.

const THEME_KEY = 'syncpad_theme';

export const THEMES = [
  { id: 'charcoal-amber',  label: 'Charcoal Amber', swatch: '#f5a623' },
  { id: 'midnight-blue',   label: 'Midnight Blue',  swatch: '#60a5fa' },
  { id: 'forest-green',    label: 'Forest Green',   swatch: '#4ade80' },
  { id: 'paper-light',     label: 'Paper Light',    swatch: '#c17d2e' },
  { id: 'terminal',        label: 'Terminal',       swatch: '#00ff41' },
];

/**
 * Apply a theme by setting data-theme on <html>.
 * 'charcoal-amber' is the default and removes the attribute.
 */
export function applyTheme(id) {
  const root = document.documentElement;
  if (!id || id === 'charcoal-amber') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', id);
  }
  try { localStorage.setItem(THEME_KEY, id); } catch {}
}

/** Load and apply the saved theme from localStorage. */
export function loadSavedTheme() {
  let saved;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  applyTheme(saved || 'charcoal-amber');
}

/** Return the currently active theme ID. */
export function getSavedTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'charcoal-amber'; } catch {}
  return 'charcoal-amber';
}
