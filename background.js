// MV2 background page script
/* global browser */

const SYNC_KEYS = {
  WORDS: 'vocabulary-words',
  SETTINGS: 'settings',
  STUDY_LISTS: 'study-lists',
};

function makeId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

async function getSync(key) {
  const res = await browser.storage.sync.get(key);
  return res[key] ?? null;
}
async function setSync(key, value) {
  await browser.storage.sync.set({ [key]: value });
}

async function migrateWordsEnsureIds(){
  const words = (await getSync(SYNC_KEYS.WORDS)) || [];
  let changed = false;
  const seen = new Set();
  for (const w of words){
    if (!w.id || seen.has(w.id)) { w.id = makeId(); changed = true; }
    seen.add(w.id);
  }
  if (changed) await setSync(SYNC_KEYS.WORDS, words);
}

function setDynamicIcon() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0,0,32,32);
    grad.addColorStop(0, '#6D28D9');
    grad.addColorStop(1, '#EF4444');
    ctx.fillStyle = grad; ctx.fillRect(0,0,32,32);
    // Simple flame shape
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(16, 6);
    ctx.bezierCurveTo(20, 10, 22, 14, 22, 18);
    ctx.bezierCurveTo(22, 24, 18, 26, 16, 26);
    ctx.bezierCurveTo(12, 26, 10, 24, 10, 20);
    ctx.bezierCurveTo(10, 16, 12, 14, 14, 12);
    ctx.bezierCurveTo(14, 14, 15, 16, 16, 18);
    ctx.closePath(); ctx.fill();
    const imageData = ctx.getImageData(0,0,32,32);
    browser.browserAction.setIcon({ imageData });
  } catch {}
}

async function ensureDefaultList(language) {
  const lists = (await getSync(SYNC_KEYS.STUDY_LISTS)) || [];
  const id = `default-${language}`;
  let list = lists.find(l => l.id === id);
  if (!list) {
    list = { id, name: `${language} list`, wordIds: [], createdAt: new Date().toISOString(), color: '#6366f1' };
    lists.push(list);
    await setSync(SYNC_KEYS.STUDY_LISTS, lists);
  }
  return list;
}

async function addEntryFromSelection(selection, tab, promptTranslation) {
  const settings = await getSync(SYNC_KEYS.SETTINGS) || { activeLanguage: 'japanese' };
  await migrateWordsEnsureIds();
  const words = await getSync(SYNC_KEYS.WORDS) || [];
  let translation = '';
  if (promptTranslation) {
    try {
      const res = await browser.tabs.sendMessage(tab.id, { type: 'prompt-translation', word: selection });
      translation = res?.translation || '';
    } catch {}
  }
  const entry = {
    id: makeId(), word: selection, translation,
    language: settings.activeLanguage || 'japanese', difficulty: 3,
    reviewCount: 0, correctCount: 0, createdAt: new Date().toISOString(),
  };
  const next = [...words, entry];
  await setSync(SYNC_KEYS.WORDS, next);

  // Add to default list
  const list = await ensureDefaultList(entry.language);
  const lists = (await getSync(SYNC_KEYS.STUDY_LISTS)) || [];
  const idx = lists.findIndex(l => l.id === list.id);
  if (idx >= 0 && !lists[idx].wordIds?.includes(entry.id)) {
    lists[idx].wordIds = [...(lists[idx].wordIds || []), entry.id];
    await setSync(SYNC_KEYS.STUDY_LISTS, lists);
  }

  try {
    browser.browserAction.setBadgeText({ text: '+1', tabId: tab?.id });
    setTimeout(() => browser.browserAction.setBadgeText({ text: '', tabId: tab?.id }), 1500);
  } catch {}
}

browser.runtime.onInstalled.addListener(async () => {
  try { await browser.contextMenus.removeAll(); } catch {}
  browser.contextMenus.create({ id: 'quick-add-word', title: 'Add to FireFlashcards…', contexts: ['selection'] });
  await migrateWordsEnsureIds();
  setDynamicIcon();
});

browser.runtime.onStartup.addListener(async () => { await migrateWordsEnsureIds(); setDynamicIcon(); });

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const selection = info.selectionText?.trim();
  if (!selection) return;
  await addEntryFromSelection(selection, tab, true);
});

browser.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (command === 'quick_add') {
      const [text] = await browser.tabs.executeScript(tab.id, { code: 'window.getSelection().toString()' });
      if (text && text.trim()) await addEntryFromSelection(text.trim(), tab, true);
      return;
    }
    if (command === 'open_popup') {
      // MV2 cannot programmatically open popup reliably; focus toolbar by setting badge
      setDynamicIcon();
      return;
    }
  } catch {}
});

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg?.type === 'getWords') {
    const w = await getSync(SYNC_KEYS.WORDS) || [];
    return { ok: true, words: w };
  }
  if (msg?.type === 'setWords') {
    await setSync(SYNC_KEYS.WORDS, msg.words || []);
    return { ok: true };
  }
});
