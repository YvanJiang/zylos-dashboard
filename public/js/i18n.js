const SUPPORTED = ['en', 'zh'];
const STORAGE_KEY = 'zylos-dashboard-locale';

let currentLocale = 'en';
let translations = {};
let assetRoot = '';

export function setAssetRoot(root) { assetRoot = root; }
export function getLocale() { return currentLocale; }

export function resolveLocale(explicit) {
  if (SUPPORTED.includes(explicit)) return explicit;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (SUPPORTED.includes(stored)) return stored;
  return navigator.language?.startsWith('zh') ? 'zh' : 'en';
}

export async function initI18n(locale) {
  currentLocale = resolveLocale(locale);
  localStorage.setItem(STORAGE_KEY, currentLocale);
  const resp = await fetch(`${assetRoot}/i18n/${currentLocale}.json`, { cache: 'no-store' });
  translations = await resp.json();
  document.documentElement.lang = currentLocale;
}

export function t(key, params = {}) {
  let text = translations[key] || key;
  for (const [k, v] of Object.entries(params)) {
    text = text.replaceAll(`{${k}}`, v ?? '');
  }
  return text;
}

export function renderI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
}
