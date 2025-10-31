import { syncGet, syncSet, SYNC_KEYS } from '../scripts/storage.js';

const DEFAULT_LANGS = [
  { id: 'japanese', label: 'Japanese' },
  { id: 'thai', label: 'Thai' },
  { id: 'spanish', label: 'Spanish' },
  { id: 'korean', label: 'Korean' },
];

function renderLangRow(root, lang, onUpdate, onDelete) {
  const row = document.createElement('div');
  row.innerHTML = `
    <input class="id" value="${lang.id}" />
    <input class="label" value="${lang.label}" />
    <button class="save">Save</button>
    <button class="delete">Delete</button>
  `;
  row.querySelector('.save').onclick = () => {
    const id = row.querySelector('.id').value.trim();
    const label = row.querySelector('.label').value.trim();
    if (!id || !label) return;
    onUpdate({ id, label });
  };
  row.querySelector('.delete').onclick = () => onDelete();
  root.appendChild(row);
}

function toCsv(rows) {
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v).replaceAll('"', '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const headers = Object.keys(rows[0] || {});
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => escape(row[h])).join(','));
  return lines.join('\n');
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function loadSettings() {
  const settings = await syncGet(SYNC_KEYS.SETTINGS) || {};
  if (!Array.isArray(settings.languages) || settings.languages.length === 0) settings.languages = DEFAULT_LANGS;
  if (!settings.activeLanguage) settings.activeLanguage = settings.languages[0].id;
  await syncSet(SYNC_KEYS.SETTINGS, settings);
  return settings;
}

async function init() {
  const settings = await loadSettings();
  const root = document.getElementById('languages');
  root.innerHTML = '';

  for (let i = 0; i < settings.languages.length; i++) {
    const lang = settings.languages[i];
    renderLangRow(root, lang, async (updated) => {
      settings.languages[i] = updated;
      // ensure active still valid
      if (!settings.languages.find(l => l.id === settings.activeLanguage)) {
        settings.activeLanguage = settings.languages[0]?.id;
      }
      await syncSet(SYNC_KEYS.SETTINGS, settings);
      init();
    }, async () => {
      settings.languages.splice(i, 1);
      if (settings.activeLanguage === lang.id) settings.activeLanguage = settings.languages[0]?.id;
      await syncSet(SYNC_KEYS.SETTINGS, settings);
      init();
    });
  }

  document.getElementById('addLang').onclick = async () => {
    const id = document.getElementById('newLangId').value.trim();
    const label = document.getElementById('newLangLabel').value.trim();
    if (!id || !label) return;
    if (settings.languages.find(l => l.id === id)) return alert('Language id exists');
    settings.languages.push({ id, label });
    await syncSet(SYNC_KEYS.SETTINGS, settings);
    document.getElementById('newLangId').value = '';
    document.getElementById('newLangLabel').value = '';
    init();
  };

  // JSON export/import
  document.getElementById('exportBtn').onclick = async () => {
    const words = await syncGet(SYNC_KEYS.WORDS) || [];
    const blob = new Blob([JSON.stringify(words, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fireflashcards-data.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  document.getElementById('importBtn').onclick = async () => {
    const file = document.getElementById('importFile').files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('Invalid file');
      await syncSet(SYNC_KEYS.WORDS, data);
      alert('Imported successfully');
    } catch (e) {
      alert('Failed to import: ' + e.message);
    }
  };

  // CSV exports
  const wordsBtn = document.getElementById('exportWordsCsv');
  if (wordsBtn) wordsBtn.onclick = async () => {
    const words = await syncGet(SYNC_KEYS.WORDS) || [];
    download('fireflashcards-words.csv', toCsv(words));
  };
  const actsBtn = document.getElementById('exportActivityCsv');
  if (actsBtn) actsBtn.onclick = async () => {
    const acts = await syncGet(SYNC_KEYS.ACTIVITIES) || [];
    download('fireflashcards-activity.csv', toCsv(acts));
  };
}

init();
