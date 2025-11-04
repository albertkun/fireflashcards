// MV2 background page script
/* global browser */

const SYNC_KEYS = {
  WORDS: 'vocabulary-words',
  SETTINGS: 'settings',
  STUDY_LISTS: 'study-lists',
};

// UUID v4 generator (crypto if available, fallback to Math.random)
function uuidv4(){
  try{
    const buf = new Uint8Array(16);
    (self.crypto || crypto).getRandomValues(buf);
    buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
    buf[8] = (buf[8] & 0x3f) | 0x80; // variant 10
    const hex = [...buf].map(b=>b.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }catch{
    return (Date.now().toString(36)+Math.random().toString(36).slice(2)).replace(/\./g,'');
  }
}

async function getSync(key) {
  const res = await browser.storage.sync.get(key);
  return res[key] ?? null;
}
async function setSync(key, value) {
  await browser.storage.sync.set({ [key]: value });
}

function normText(s){
  const t = (s||'')
    .replace(/[\u3000\u00A0]/g, ' ') // full-width/nbsp to space
    .trim()
    .replace(/\s+/g,' ');
  try { return t.normalize('NFKC').toLowerCase(); } catch { return t.toLowerCase(); }
}

const recentAdds = new Map(); // sig -> timestamp
function shouldThrottle(sig, ms=1500){
  const now = Date.now();
  // cleanup
  for (const [k,t] of [...recentAdds]){ if (now - t > ms) recentAdds.delete(k); }
  const t = recentAdds.get(sig);
  if (t && now - t < ms) return true;
  recentAdds.set(sig, now);
  return false;
}

// Stronger duplicate protection
const inflightAdds = new Set(); // sigs being processed
async function isRecentDuplicate(lang, rawWord, windowMs=2000){
  try{
    const words = (await getSync(SYNC_KEYS.WORDS)) || [];
    const norm = normText(rawWord);
    const now = Date.now();
    // Scan most recent 20 items only for speed
    for (let i = words.length - 1, seen=0; i >= 0 && seen < 20; i--, seen++){
      const w = words[i];
      if (!w) continue;
      if (w.language === lang && normText(w.word) === norm){
        const t = new Date(w.createdAt||0).getTime();
        if (isFinite(t) && (now - t) < windowMs) return true;
      }
    }
  }catch{}
  return false;
}

async function migrateWordsEnsureIds(){
  const words = (await getSync(SYNC_KEYS.WORDS)) || [];
  let changed = false;
  const seen = new Set();
  const splitMap = new Map(); // oldId => [newIds]
  for (const w of words){
    if (!w.id){ w.id = uuidv4(); changed = true; }
    if (seen.has(w.id)){
      const oldId = w.id;
      const newId = uuidv4();
      w.id = newId; changed = true;
      const arr = splitMap.get(oldId) || [];
      arr.push(newId); splitMap.set(oldId, arr);
    }
    seen.add(w.id);
  }
  if (changed){
    await setSync(SYNC_KEYS.WORDS, words);
    // If we split any ids, include new ids in lists that referenced the old id
    if (splitMap.size){
      const lists = (await getSync(SYNC_KEYS.STUDY_LISTS)) || [];
      for (const l of lists){
        const ids = new Set(l.wordIds || []);
        for (const [oldId, newIds] of splitMap){ if (ids.has(oldId)) newIds.forEach(id=>ids.add(id)); }
        l.wordIds = Array.from(ids);
      }
      await setSync(SYNC_KEYS.STUDY_LISTS, lists);
    }
  }
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
  let translation = '';
  if (promptTranslation) {
    try {
      const res = await browser.tabs.sendMessage(tab.id, { type: 'prompt-translation', word: selection });
      translation = res?.translation || '';
    } catch {}
  }
  const lang = settings.activeLanguage || 'japanese';
  const sig = `${lang}|${normText(selection)}`;
  // triple guard: in-flight, throttle, and recent duplicate window
  if (inflightAdds.has(sig)) return;
  if (shouldThrottle(sig)) return;
  if (await isRecentDuplicate(lang, selection)) return;
  inflightAdds.add(sig);
  try{
    const words = (await getSync(SYNC_KEYS.WORDS)) || [];
    // Always create a new entry with its own UUID
    const entry = {
      id: uuidv4(), word: selection, translation,
      language: lang, difficulty: 3,
      reviewCount: 0, correctCount: 0, createdAt: new Date().toISOString(),
    };
    const next = [...words, entry];
    await setSync(SYNC_KEYS.WORDS, next);

    // Add to default list (unique per id)
    const list = await ensureDefaultList(lang);
    const lists = (await getSync(SYNC_KEYS.STUDY_LISTS)) || [];
    const idx = lists.findIndex(l => l.id === list.id);
    if (idx >= 0) {
      const ids = new Set(lists[idx].wordIds || []);
      ids.add(entry.id);
      lists[idx].wordIds = Array.from(ids);
      await setSync(SYNC_KEYS.STUDY_LISTS, lists);
    }

    try {
      browser.browserAction.setBadgeText({ text: '+1', tabId: tab?.id });
      setTimeout(() => browser.browserAction.setBadgeText({ text: '', tabId: tab?.id }), 1500);
    } catch {}
  } finally {
    // small delay before allowing same sig again
    setTimeout(()=> inflightAdds.delete(sig), 1200);
  }
}

browser.runtime.onInstalled.addListener(async () => {
  try { await browser.contextMenus.removeAll(); } catch {}
  try { browser.contextMenus.create({ id: 'quick-add-word', title: 'Add to FireFlashcards…', contexts: ['selection'] }); } catch {}
  await migrateWordsEnsureIds();
  setDynamicIcon();
});

browser.runtime.onStartup.addListener(async () => { await migrateWordsEnsureIds(); setDynamicIcon(); });

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  try{
    if (info.menuItemId !== 'quick-add-word') return; // guard other menu items
    const selection = info.selectionText?.trim();
    if (!selection) return;
    await addEntryFromSelection(selection, tab, true);
  }catch{}
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
  try {
    if (msg.type === 'refresh_badge') {
      setDynamicIcon();
    }
  } catch {}
});
