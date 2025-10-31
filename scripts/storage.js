// Helper around browser.storage.sync with web fallback
/* global browser */

const SYNC_KEYS = {
  WORDS: 'vocabulary-words',
  SETTINGS: 'settings',
  ACTIVITIES: 'learning-activities',
  STUDY_LISTS: 'study-lists',
};

function isExt() {
  return typeof browser !== 'undefined' && browser?.storage?.sync;
}

export async function syncGet(key) {
  if (isExt()) {
    const res = await browser.storage.sync.get(key);
    return res[key] ?? null;
  }
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

export async function syncSet(key, value) {
  if (isExt()) {
    await browser.storage.sync.set({ [key]: value });
    return;
  }
  localStorage.setItem(key, JSON.stringify(value));
}

export { SYNC_KEYS };
