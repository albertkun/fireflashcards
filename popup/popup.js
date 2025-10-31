(function(){
  // Visible debug (now no-op)
  const dbg = ()=>{};

  // Storage helper for MV2 popup (no import)
  const SYNC_KEYS = {
    WORDS: 'vocabulary-words',
    SETTINGS: 'settings',
    ACTIVITIES: 'learning-activities',
    STUDY_LISTS: 'study-lists',
  };
  function isExt(){ return typeof browser !== 'undefined' && browser?.storage?.sync; }
  async function syncGet(key){
    try{
      if (isExt()) { const res = await browser.storage.sync.get(key); return res[key] ?? null; }
      const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  }
  async function syncSet(key, value){
    try{
      if (isExt()) return await browser.storage.sync.set({ [key]: value });
      localStorage.setItem(key, JSON.stringify(value));
    }catch(e){}
  }

  const DEFAULT_LANGS = [
    { id: 'japanese', label: 'Japanese' },
    { id: 'thai', label: 'Thai' },
    { id: 'spanish', label: 'Spanish' },
    { id: 'korean', label: 'Korean' },
  ];
  const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2,8);
  const getEl = (id) => document.getElementById(id);

  async function loadSettings(){
    const settings = (await syncGet(SYNC_KEYS.SETTINGS)) || {};
    if (!Array.isArray(settings.languages) || settings.languages.length === 0) settings.languages = DEFAULT_LANGS;
    if (!settings.activeLanguage) settings.activeLanguage = settings.languages[0].id;
    if (!settings.dailyGoal) settings.dailyGoal = 10;
    await syncSet(SYNC_KEYS.SETTINGS, settings);
    return settings;
  }

  function applyTheme(settings){
    const theme = settings.theme || 'system';
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
    document.documentElement.setAttribute('data-theme', effective);
  }
  function openConfig(open){ const m = getEl('configModal'); if (!m) return; m.classList[open?'remove':'add']('hidden'); }

  function renderLanguages(select, settings){
    select.innerHTML = '';
    for (const lang of settings.languages){
      const opt = document.createElement('option');
      opt.value = lang.id; opt.textContent = lang.label; if (lang.id === settings.activeLanguage) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function setActiveTab(tab){
    document.querySelectorAll('#tabs button').forEach(b => { if (b.dataset.tab === tab) b.classList.add('active'); else b.classList.remove('active'); });
    const views = ['dashboard','add','quiz','list'];
    views.forEach(v => getEl(`view-${v}`)?.classList.add('hidden'));
    getEl(`view-${tab}`)?.classList.remove('hidden');
  }

  const dueWords = (words) => { const now = Date.now(); return (words||[]).filter(w => { if (!w.nextReview) return true; const t = new Date(w.nextReview).getTime(); return isFinite(t) ? t <= now : true; }); };
  const schedule = (word, wasCorrect) => { const reviewCount=(word.reviewCount||0)+1; const correctCount=(word.correctCount||0)+(wasCorrect?1:0); let difficulty=word.difficulty??3; difficulty=Math.min(5,Math.max(1,difficulty+(wasCorrect?-0.2:0.3))); const ints=[1,3,7,14,30]; const days=ints[Math.min(Math.round(difficulty)-1,4)]||1; const next=new Date(); next.setDate(next.getDate()+days); return { reviewCount, correctCount, difficulty, nextReview: next.toISOString(), lastReviewed: new Date().toISOString() }; };

  async function ensureDefaultList(language){
    const lists = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
    const id = `default-${language}`;
    let list = lists.find(l=>l.id===id);
    if (!list){ list = { id, name: `${language} list`, wordIds: [], createdAt: new Date().toISOString(), color: '#6366f1' }; lists.push(list); await syncSet(SYNC_KEYS.STUDY_LISTS, lists); }
    return list;
  }

  async function migrateWordsEnsureIds(){
    const words = (await syncGet(SYNC_KEYS.WORDS)) || [];
    let changed = false;
    const seen = new Set();
    const mappings = [];
    for (const w of words){
      if (!w.id || seen.has(w.id)) { const oldId = w.id || null; const newId = makeId(); w.id = newId; changed = true; mappings.push({ oldId, newId }); }
      seen.add(w.id);
    }
    if (changed) {
      await syncSet(SYNC_KEYS.WORDS, words);
      const lists = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
      if (lists.length && mappings.length){
        for (const m of mappings){ if (!m.oldId) continue; for (const l of lists){ const ids=l.wordIds||[]; if (ids.includes(m.oldId) && !ids.includes(m.newId)) ids.push(m.newId); l.wordIds = Array.from(new Set(ids)); } }
        await syncSet(SYNC_KEYS.STUDY_LISTS, lists);
      }
    }
  }

  async function renderListView(container, words, activeLang){
    container.innerHTML = '';
    const filtered = (words||[]).filter(w=>w.language===activeLang);
    const listsNow = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
    for (const w of filtered){
      const card = document.createElement('div'); card.className='card';
      const assigned = listsNow.filter(l => (l.wordIds||[]).includes(w.id)).map(l=>l.name);
      card.innerHTML = `
        <div class="display">
          <div class="row"><strong>${w.word}</strong></div>
          <div>${w.translation||''}</div>
          ${w.pronunciation?`<small>[${w.pronunciation}]</small>`:''}
          ${w.reference?`<div><a href="${w.reference}" target="_blank" rel="noreferrer" style="font-size:12px">Reference</a></div>`:''}
          ${assigned.length?`<small>Lists: ${assigned.join(', ')}</small>`:''}
        </div>
        <div class="editor">
          <input class="w" placeholder="Word" value="${w.word}" />
          <input class="t" placeholder="Translation" value="${w.translation||''}" />
          <input class="p" placeholder="Pronunciation" value="${w.pronunciation||''}" />
          <input class="r" placeholder="Reference URL" value="${w.reference||''}" />
          <div class="actions">
            <button class="save">Save</button>
            <button class="del" title="Delete">🗑️</button>
          </div>
        </div>
      `;
      container.appendChild(card);

      card.querySelector('.save').onclick = async () => {
        const all = (await syncGet(SYNC_KEYS.WORDS)) || [];
        const updated = all.map(x => x.id === w.id ? {
          ...x,
          word: card.querySelector('.w').value.trim(),
          translation: card.querySelector('.t').value.trim(),
          pronunciation: card.querySelector('.p').value.trim() || undefined,
          reference: card.querySelector('.r').value.trim() || undefined,
        } : x);
        await syncSet(SYNC_KEYS.WORDS, updated);
        init();
      };

      const delBtn = card.querySelector('.editor .del');
      delBtn.onclick = async () => {
        if (!confirm('Delete this word?')) return;
        const all = (await syncGet(SYNC_KEYS.WORDS)) || [];
        await syncSet(SYNC_KEYS.WORDS, all.filter(v=>v.id !== w.id));
        const lists = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
        for (const l of lists) l.wordIds = (l.wordIds||[]).filter(id=>id!==w.id);
        await syncSet(SYNC_KEYS.STUDY_LISTS, lists);
        init();
      };
    }
  }

  async function init(){
    try{
      const settings = await loadSettings();
      await migrateWordsEnsureIds();
      applyTheme(settings);

      // Header buttons
      const cfgBtn = getEl('configBtn'); if (cfgBtn) cfgBtn.onclick = (ev)=>{ ev.stopPropagation(); openConfig(true); };
      const cfgClose = getEl('configClose'); if (cfgClose) cfgClose.onclick = (ev)=>{ ev.stopPropagation(); openConfig(false); };
      const editBtn = getEl('editToggle'); if (editBtn) editBtn.onclick = async (ev)=>{ ev.stopPropagation(); document.body.classList.toggle('editing'); setActiveTab('list'); };

      // Tabs
      document.querySelectorAll('#tabs button').forEach(btn=> btn.onclick = ()=> setActiveTab(btn.dataset.tab));
      const startBtn = getEl('startQuizBtn'); if (startBtn) startBtn.onclick = ()=> setActiveTab('quiz');

      // Config panel wiring (theme only)
      const themeSelect = getEl('themeSelect'); if (themeSelect){ themeSelect.value = settings.theme || 'system'; themeSelect.onchange = async ()=>{ const s=(await syncGet(SYNC_KEYS.SETTINGS))||{}; s.theme = themeSelect.value; await syncSet(SYNC_KEYS.SETTINGS, s); applyTheme(s); }; }

      // Languages
      const langSelect = getEl('languageSelect'); if (langSelect){ renderLanguages(langSelect, settings); langSelect.onchange = async ()=>{ const s=(await syncGet(SYNC_KEYS.SETTINGS))||{}; s.activeLanguage = langSelect.value; await syncSet(SYNC_KEYS.SETTINGS, s); init(); }; }

      // Add flow
      const addBtn = getEl('addBtn'); if (addBtn){
        addBtn.onclick = async ()=>{
          try{
            const word = (getEl('word')?.value||'').trim();
            const translation = (getEl('translation')?.value||'').trim();
            const pronunciation = (getEl('pronunciation')?.value||'').trim();
            const reference = (getEl('reference')?.value||'').trim();
            if (!word || !translation) return;
            const fresh = (await syncGet(SYNC_KEYS.WORDS)) || [];
            const entry = { id: makeId(), word, translation, pronunciation: pronunciation||undefined, reference: reference||undefined, language: (await syncGet(SYNC_KEYS.SETTINGS))?.activeLanguage || settings.activeLanguage, difficulty: 3, reviewCount:0, correctCount:0, createdAt: new Date().toISOString() };
            const next = [...fresh, entry];
            await syncSet(SYNC_KEYS.WORDS, next);
            await ensureDefaultList(entry.language);
            const lists = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
            const idx = lists.findIndex(l=>l.id===`default-${entry.language}`);
            if (idx>=0 && !(lists[idx].wordIds||[]).includes(entry.id)) { lists[idx].wordIds = [...(lists[idx].wordIds||[]), entry.id]; await syncSet(SYNC_KEYS.STUDY_LISTS, lists); }
            ['word','translation','pronunciation','reference'].forEach(id=>{ const el=getEl(id); if (el) el.value=''; });
            init();
          } catch(e){}
        };
      }

      // List
      const words = (await syncGet(SYNC_KEYS.WORDS)) || [];
      const listRoot = getEl('list'); if (listRoot) await renderListView(listRoot, words, settings.activeLanguage);

      // Reveal-only quiz
      const pool = dueWords(words.filter(w=>w.language===settings.activeLanguage));
      const card = getEl('ankiCard'); const wEl = getEl('ankiWord'); const aEl = getEl('ankiAnswer'); const ref = getEl('ankiRefLink'); const rev = getEl('ankiReveal'); const good = getEl('ankiGood'); const again = getEl('ankiAgain');
      if (card) card.classList.remove('hidden');
      if (pool.length === 0){ if (wEl) wEl.innerHTML = '<strong>All caught up!</strong>'; if (aEl) { aEl.textContent=''; aEl.classList.add('hidden'); aEl.style.display='none'; } if (ref){ ref.href='#'; ref.classList.add('hidden'); ref.style.display='none'; } if (rev) rev.disabled = true; if (good) good.disabled = true; if (again) again.disabled = true; return; }

      const current = pool.sort((a,b)=> (new Date(a.nextReview||0).getTime()) - (new Date(b.nextReview||0).getTime()))[0];
      if (wEl) wEl.innerHTML = `<strong>${current.word}</strong>`;
      if (aEl){ aEl.textContent = current.translation || ''; aEl.classList.add('hidden'); aEl.style.display='none'; }
      if (ref){ if (current.reference){ ref.href = current.reference; ref.classList.add('hidden'); ref.style.display='none'; } else { ref.href='#'; ref.classList.add('hidden'); ref.style.display='none'; } }
      if (rev){ rev.disabled = false; rev.onclick = ()=>{ if (aEl){ aEl.classList.remove('hidden'); aEl.style.display='block'; } if (current.reference && ref){ ref.classList.remove('hidden'); ref.style.display='inline'; } }; }
      const apply = async (correct)=>{ const updates=schedule(current, correct); const all=(await syncGet(SYNC_KEYS.WORDS))||[]; await syncSet(SYNC_KEYS.WORDS, all.map(w=>w.id===current.id?{...w,...updates}:w)); init(); };
      if (good){ good.disabled = false; good.onclick = ()=>apply(true); }
      if (again){ again.disabled = false; again.onclick = ()=>apply(false); }

    } catch(e){}
  }

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    try { init(); } catch (e) {}
  } else {
    setTimeout(()=>{ try { init(); } catch (e) {} }, 0);
  }
})();
