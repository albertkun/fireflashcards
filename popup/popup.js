(function(){
  // Visible debug
  const log = (...a)=>{ try{ console.debug('[FireFlashcards]', ...a); }catch(e){} };
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

  // Local recent-add throttle to prevent double clicks in Add view
  const _recentAdds = new Map(); // sig -> timestamp
  function shouldThrottleAdd(sig, ms=1500){
    const now = Date.now();
    for (const [k,t] of _recentAdds) { if (now - t > ms) _recentAdds.delete(k); }
    const last = _recentAdds.get(sig);
    if (last && now - last < ms) return true;
    _recentAdds.set(sig, now);
    return false;
  }

  const DEFAULT_LANGS = [
    { id: 'japanese', label: 'Japanese' },
    { id: 'thai', label: 'Thai' },
    { id: 'spanish', label: 'Spanish' },
    { id: 'korean', label: 'Korean' },
  ];
  const getEl = (id) => document.getElementById(id);

  async function loadSettings(){
    const settings = (await syncGet(SYNC_KEYS.SETTINGS)) || {};
    if (!Array.isArray(settings.languages) || settings.languages.length === 0) settings.languages = DEFAULT_LANGS;
    if (!settings.activeLanguage) settings.activeLanguage = settings.languages[0].id;
    if (!settings.dailyGoal) settings.dailyGoal = 10;
    if (!settings.appLocale) settings.appLocale = (navigator.language || 'en').replace('_','-');
    await syncSet(SYNC_KEYS.SETTINGS, settings);
    return settings;
  }

  function applyTheme(settings){
    const theme = settings.theme || 'system';
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
    document.documentElement.setAttribute('data-theme', effective);
  }
  function openConfig(open){
    const m = getEl('configModal');
    if (!m) return;
    if (open) m.classList.remove('hidden');
    else m.classList.add('hidden');
  }

  function renderLanguages(select, settings){
    select.innerHTML = '';
    for (const lang of settings.languages){
      const opt = document.createElement('option');
      opt.value = lang.id; opt.textContent = lang.label; if (lang.id === settings.activeLanguage) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function renderAppLocales(select, current){
    const supported = ['en','ja','th','es','ko','zh-TW'];
    select.innerHTML = '';
    for (const lc of supported){
      const opt = document.createElement('option');
      opt.value = lc; opt.textContent = (window.i18n?.t ? window.i18n.t(`lang.${lc}`) : lc).replace('lang.','');
      if (lc === current) opt.selected = true;
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
  const schedule = (word, wasCorrect) => { const reviewCount=(word.reviewCount||0)+1; const correctCount=(word.correctCount||0)+(wasCorrect?1:0); let difficulty=word.difficulty??3; difficulty=Math.min(5,Math.max(1,difficulty+(wasCorrect?-0.2:0.3))); let next; if (!wasCorrect){ next = new Date(Date.now()); } else { const ints=[1,3,7,14,30]; const days=ints[Math.min(Math.round(difficulty)-1,4)]||1; next=new Date(); next.setDate(next.getDate()+days); } return { reviewCount, correctCount, difficulty, nextReview: next.toISOString(), lastReviewed: new Date().toISOString() }; };

  async function ensureDefaultList(language){
    const lists = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
    const id = `default-${language}`;
    let list = lists.find(l=>l.id===id);
    if (!list){ list = { id, name: `${language} list`, wordIds: [], createdAt: new Date().toISOString(), color: '#6366f1', language }; lists.push(list); await syncSet(SYNC_KEYS.STUDY_LISTS, lists); }
    return list;
  }

  function uuidv4(){
    try{ const buf = new Uint8Array(16); (self.crypto || crypto).getRandomValues(buf); buf[6] = (buf[6] & 0x0f) | 0x40; buf[8] = (buf[8] & 0x3f) | 0x80; const hex = [...buf].map(b=>b.toString(16).padStart(2,'0')).join(''); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`; }catch{ return (Date.now().toString(36)+Math.random().toString(36).slice(2)).replace(/\./g,''); }
  }

  function normText(s){ const t = (s||'').replace(/[\u3000\u00A0]/g, ' ').trim().replace(/\s+/g,' '); try { return t.normalize('NFKC').toLowerCase(); } catch { return t.toLowerCase(); } }

  async function migrateWordsEnsureIds(){ const words = (await syncGet(SYNC_KEYS.WORDS)) || []; let changed = false; const seen = new Set(); for (const w of words){ if (!w.id || seen.has(w.id)) { w.id = uuidv4(); changed = true; } seen.add(w.id); } if (changed){ await syncSet(SYNC_KEYS.WORDS, words); } }

  function t(key, params){ return window.i18n?.t ? window.i18n.t(key, params) : key; }

  function formatTodayProgress(done, goal){ return t('dashboard.todayProgress', { done, goal }); }
  function formatDue(count){ return t('dashboard.due', { count }); }

  function ymd(d){ const dt = (d instanceof Date)?d:new Date(d); const y=dt.getFullYear(); const m=String(dt.getMonth()+1).padStart(2,'0'); const day=String(dt.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
  function rangeDays(back){ const days=[]; const now=new Date(); for(let i=back-1;i>=0;i--){ const d=new Date(now); d.setDate(now.getDate()-i); days.push(ymd(d)); } return days; }

  async function recordActivity(delta){ const acts = (await syncGet(SYNC_KEYS.ACTIVITIES)) || []; const today = ymd(new Date()); const idx = acts.findIndex(a=>a.date===today); const base = { date: today, sessions: 0, words: 0, minutes: 0, streakBreak:false }; const next = {...(idx>=0?acts[idx]:base)}; next.sessions += delta.sessions||0; next.words += delta.words||0; next.minutes += delta.minutes||0; if (idx>=0) acts[idx]=next; else acts.push(next); await syncSet(SYNC_KEYS.ACTIVITIES, acts); }

  function computeStreak(acts){ const byDate = new Map(acts.map(a=>[a.date,a])); let streak=0, longest=0; let i=0; while(true){ const d=new Date(); d.setDate(new Date().getDate()-i); const k=ymd(d); if (byDate.has(k) && (byDate.get(k).sessions>0 || byDate.get(k).words>0)) { streak++; longest=Math.max(longest,streak); i++; continue; } break; } let cur=0; for(let j=0;j<365;j++){ const d=new Date(); d.setDate(new Date().getDate()-j); const k=ymd(d); const has = byDate.has(k) && (byDate.get(k).sessions>0 || byDate.get(k).words>0); if (has){ cur++; longest=Math.max(longest,cur); } else { cur=0; } } const weekDays = rangeDays(7); const thisWeek = weekDays.reduce((acc,k)=> acc + ((byDate.get(k)?.sessions)||0), 0); return { streak, longest, thisWeek }; }

  function renderHeatmap(root, acts){ if (!root) return; root.innerHTML = ''; const last28 = rangeDays(28); const byDate = new Map(acts.map(a=>[a.date,a])); last28.forEach(k=>{ const a = byDate.get(k); const v = a? Math.min(4, Math.ceil(((a.sessions||0)+(a.words||0)/5))) : 0; const div = document.createElement('div'); div.className = 'cell ' + (v>=4?'l4': v===3?'l3': v===2?'l2': v===1?'l1':''); div.title = `${k}: ${a?`${a.sessions} sessions, ${a.words} words`:'no activity'}`; root.appendChild(div); }); }

  function renderRecentSessions(root, acts){ if (!root) return; root.innerHTML=''; const items = [...acts].sort((a,b)=> (a.date>b.date?-1:1)).slice(0,5); for (const a of items){ const el = document.createElement('div'); el.className='session-item'; el.innerHTML = `<div><strong>${a.date}</strong><div class="session-meta">${a.words} words • ${a.minutes||0} min</div></div><div>${a.sessions||0}</div>`; root.appendChild(el); } }

  async function renderListView(container, words, activeLang){
    container.innerHTML = '';
    const showArchived = !!getEl('showArchived')?.checked;
    const filtered = (words||[]).filter(w=>w.language===activeLang && (showArchived || !w.archived));
    const listsNow = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
    const listsForLang = listsNow.filter(l => (l.language ? l.language===activeLang : (l.id||'').startsWith(`default-${activeLang}`)));
    for (const w of filtered){
      const card = document.createElement('div'); card.className='card'; card.setAttribute('data-id', w.id);
      const assigned = listsNow.filter(l => (l.wordIds||[]).includes(w.id)).map(l=>l.name);
      const listCheckboxes = listsForLang.map(l=>{
        const checked = (l.wordIds||[]).includes(w.id) ? 'checked' : '';
        const disabled = l.id.startsWith('default-') ? 'disabled' : '';
        return `<label style=\"display:flex; align-items:center; gap:6px; font-size:12px;\"><input type=\"checkbox\" data-list=\"${l.id}\" ${checked} ${disabled}/> ${l.name}</label>`;
      }).join('');
      const archivedBadge = w.archived ? `<small class=\"pill\">${t('list.archived')}</small>` : '';
      card.innerHTML = `
        <div class=\"display\">
          <div class=\"row\"><div style=\"display:flex; align-items:center; gap:8px;\"><input type=\"checkbox\" class=\"sel\" aria-label=\"select\"> <strong>${w.word}</strong></div> ${archivedBadge}</div>
          <div>${w.translation||''}</div>
          ${w.pronunciation?`<small>[${w.pronunciation}]</small>`:''}
          ${w.reference?`<div><a href=\"${w.reference}\" target=\"_blank\" rel=\"noreferrer\" style=\"font-size:12px\" data-i18n=\"list.reference\">Reference</a></div>`:''}
          ${assigned.length?`<small>${t('list.lists')}: ${assigned.join(', ')}</small>`:''}
        </div>
        <div class=\"editor\">
          <div class=\"actions actions-top\" style=\"display:flex; gap:4px; padding: 4px 2px 8px 2px; width: 100%; box-sizing: border-box;\">
            <button class=\"archive\" style=\"font-size:11px; padding:3px 6px;\">${w.archived ? t('list.unarchive') : t('list.archive')}</button>
            <button class=\"del\" title=\"${t('list.delete')}\" style=\"font-size:11px; padding:3px 6px;\">🗑️</button>
            <button class=\"save\" style=\"font-size:11px; padding:3px 6px; margin-left:auto;\">${t('list.save')}</button>
          </div>
          <input class=\"w\" placeholder=\"${t('list.placeholder.word')}\" value=\"${w.word}\" />
          <input class=\"t\" placeholder=\"${t('list.placeholder.translation')}\" value=\"${w.translation||''}\" />
          <input class=\"p\" placeholder=\"${t('list.placeholder.pronunciation')}\" value=\"${w.pronunciation||''}\" />
          <input class=\"r\" placeholder=\"${t('list.placeholder.reference')}\" value=\"${w.reference||''}\" />
          <div class=\"list-assign\" style=\"grid-column: span 2; display:flex; flex-wrap: wrap; gap:6px;\">${listCheckboxes}</div>
        </div>
      `;
      container.appendChild(card);

      // selection checkbox
      const sel = card.querySelector('.sel'); if (sel) sel.addEventListener('change', updateBulkButtonsState);

      // Archive/Unarchive toggle
      const arcBtn = card.querySelector('.archive'); if (arcBtn) arcBtn.onclick = async () => {
        const all = (await syncGet(SYNC_KEYS.WORDS)) || [];
        const updated = all.map(x => x.id === w.id ? { ...x, archived: !w.archived } : x);
        await syncSet(SYNC_KEYS.WORDS, updated);
        init();
      };

      const saveBtn = card.querySelector('.save'); if (saveBtn) saveBtn.onclick = async () => {
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

      const delBtn = card.querySelector('.editor .del'); if (delBtn) delBtn.onclick = async () => {
        if (!confirm(t('list.deleteConfirm'))) return;
        const all = (await syncGet(SYNC_KEYS.WORDS)) || [];
        await syncSet(SYNC_KEYS.WORDS, all.filter(v=>v.id !== w.id));
        const lists = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
        for (const l of lists) l.wordIds = (l.wordIds||[]).filter(id=>id!==w.id);
        await syncSet(SYNC_KEYS.STUDY_LISTS, lists);
        init();
      };

      // Assign checkboxes
      card.querySelectorAll('input[type="checkbox"][data-list]').forEach(cb=>{
        cb.addEventListener('change', async ()=>{
          const listId = cb.getAttribute('data-list');
          const lists = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
          const idx = lists.findIndex(l=> l.id===listId);
          if (idx<0) return;
          const ids = new Set(lists[idx].wordIds || []);
          if (cb.checked) ids.add(w.id); else ids.delete(w.id);
          lists[idx].wordIds = Array.from(ids);
          await syncSet(SYNC_KEYS.STUDY_LISTS, lists);
          init();
        });
      });
    }
    updateBulkButtonsState();
  }

  // Helpers for bulk list actions
  function getSelectedCardIds(){
    return Array.from(document.querySelectorAll('#list .card .sel:checked'))
      .map(cb=> cb.closest('.card')?.getAttribute('data-id'))
      .filter(Boolean);
  }

  function updateBulkButtonsState(){
    const ids = getSelectedCardIds();
    const arcSel = getEl('archiveSelectedBtn');
    const unarcSel = getEl('unarchiveSelectedBtn');
    if (arcSel) arcSel.disabled = ids.length===0;
    if (unarcSel) unarcSel.disabled = ids.length===0;
    // Update selectAll checkbox state
    const allCbs = Array.from(document.querySelectorAll('#list .card .sel'));
    const selAll = getEl('selectAll');
    if (selAll){
      const checkedCount = allCbs.filter(cb=>cb.checked).length;
      selAll.checked = checkedCount>0 && checkedCount===allCbs.length && allCbs.length>0;
      selAll.indeterminate = checkedCount>0 && checkedCount<allCbs.length;
    }
  }

  async function bulkSetArchived(flag){
    const ids = new Set(getSelectedCardIds());
    if (!ids.size) return;
    const all = (await syncGet(SYNC_KEYS.WORDS)) || [];
    const updated = all.map(w=> ids.has(w.id) ? { ...w, archived: !!flag } : w);
    await syncSet(SYNC_KEYS.WORDS, updated);
    // Re-render list and reset selection
    const settings = (await syncGet(SYNC_KEYS.SETTINGS)) || {};
    const listRoot = getEl('list');
    if (listRoot) await renderListView(listRoot, updated, settings.activeLanguage || 'japanese');
    const selAll = getEl('selectAll'); if (selAll){ selAll.checked = false; selAll.indeterminate = false; }
    updateBulkButtonsState();
  }

  // Render study-from-list filter options (per active language) as multi-select
  async function renderStudyListFilter(settings){
    const select = getEl('studyListFilter'); if (!select) return;
    const lists = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
    const activeLang = settings.activeLanguage;
    const savedRaw = (settings.studyListFilter && settings.studyListFilter[activeLang]) || [];
    const saved = Array.isArray(savedRaw) ? savedRaw : (savedRaw ? [savedRaw] : []);
    select.innerHTML = '';
    // single-select: explicit "All" option; empty selection means All
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All';
    if (!saved.length) allOpt.selected = true;
    select.appendChild(allOpt);
    lists
      .filter(l=> (l.language ? l.language===activeLang : (l.id||'').startsWith(`default-${activeLang}`)))
      .forEach(l=>{
        const o = document.createElement('option');
        o.value = l.id; o.textContent = l.name; if (saved.includes(l.id)) o.selected = true; select.appendChild(o);
      });
  }

  function getSelectedListIds(){
    const sel = getEl('studyListFilter'); if (!sel) return [];
    return Array.from(sel.selectedOptions || []).map(o=>o.value).filter(Boolean);
  }

  // NEW: dashboard refresh util
  async function refreshDashboardUI(words, settings){
    try{
      const activeLang = settings.activeLanguage;
      const all = words || (await syncGet(SYNC_KEYS.WORDS)) || [];
      const acts = (await syncGet(SYNC_KEYS.ACTIVITIES)) || [];
      const filtered = all.filter(w=>w.language===activeLang);

      const total = filtered.length;
      const totalReviews = filtered.reduce((s,w)=> s + (w.reviewCount||0), 0);
      const totalCorrect = filtered.reduce((s,w)=> s + (w.correctCount||0), 0);
      const accuracy = totalReviews>0 ? Math.round((totalCorrect/Math.max(1,totalReviews))*100) : 0;
      // Simple learned heuristic: words with >= 3 correct answers
      const learned = filtered.filter(w=> (w.correctCount||0) >= 3).length;

      const statTotal = getEl('statTotal'); if (statTotal) statTotal.textContent = `${total} words`;
      const statLearned = getEl('statLearned'); if (statLearned) statLearned.textContent = String(learned);
      const statAccuracy = getEl('statAccuracy'); if (statAccuracy) statAccuracy.textContent = `${accuracy}%`;

      const streakStats = computeStreak(acts);
      const statStreak = getEl('statStreak'); if (statStreak) statStreak.innerHTML = `${streakStats.streak} <span data-i18n="dashboard.days">${t('dashboard.days')}</span>`;

      // Daily goal section
      const today = ymd(new Date());
      const todayActs = acts.find(a=>a.date===today);
      const done = todayActs ? (todayActs.words||0) : 0;
      const goal = settings.dailyGoal || 10;
      const dailyGoalInput = getEl('dailyGoalInput'); if (dailyGoalInput) dailyGoalInput.value = String(goal);
      const bar = getEl('dailyGoalBar'); if (bar) bar.style.width = `${Math.min(100, Math.round((done/Math.max(1,goal))*100))}%`;
      const txt = getEl('dailyGoalText'); if (txt) txt.textContent = formatTodayProgress(done, goal);

      const due = dueWords(filtered).length;
      const dueCount = getEl('dueCount'); if (dueCount) dueCount.textContent = formatDue(due);

      renderHeatmap(getEl('heatmap'), acts);
      renderRecentSessions(getEl('recentSessions'), acts);
    }catch(e){ log('refreshDashboardUI error', e); }
  }

  // Avoid multiple hotkey listeners across re-inits
  let hotkeysBound = false;

  // NEW: Lists manager (create/rename/delete) scoped to active language
  async function renderListsManager(settings){
    const root = getEl('listsManager'); if (!root) return;
    const lists = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
    const activeLang = settings.activeLanguage;
    const local = lists.filter(l => (l.language ? l.language === activeLang : (l.id||'').startsWith(`default-${activeLang}`)));

    function rowHTML(l){
      const count = (l.wordIds||[]).length;
      return `<div class="list-row" data-id="${l.id}">
        <input class="name" value="${l.name||''}" placeholder="${window.i18n?.t('lists.namePlaceholder')||'List name'}" />
        <span class="pill">${count}</span>
        <button class="save">${window.i18n?.t('list.save')||'Save'}</button>
        ${l.id.startsWith('default-') ? '' : `<button class="del">${window.i18n?.t('list.delete')||'Delete'}</button>`}
      </div>`;
    }

    root.innerHTML = `<div class="row" style="justify-content:space-between; align-items:center;">
      <strong>${window.i18n?.t('lists.title')||'Lists'}</strong>
      <button id="addListBtn">${window.i18n?.t('lists.new')||'New List'}</button>
    </div>` + local.map(rowHTML).join('');

    // Bind events
    root.querySelectorAll('.list-row').forEach(el=>{
      const id = el.getAttribute('data-id');
      const save = el.querySelector('.save');
      const del = el.querySelector('.del');
      const nameInput = el.querySelector('.name');
      if (save) save.onclick = async ()=>{
        const all = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
        const next = all.map(x=> x.id===id ? { ...x, name: (nameInput.value||'').trim() || x.name } : x);
        await syncSet(SYNC_KEYS.STUDY_LISTS, next);
        await init();
      };
      if (del) del.onclick = async ()=>{
        if (!confirm(window.i18n?.t('list.deleteConfirm')||'Delete this list?')) return;
        const all = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
        const next = all.filter(x=> x.id!==id);
        await syncSet(SYNC_KEYS.STUDY_LISTS, next);
        await init();
      };
    });

    const addBtn = getEl('addListBtn');
    if (addBtn) addBtn.onclick = async ()=>{
      const all = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
      const id = `list-${activeLang}-${uuidv4()}`;
      const name = prompt(window.i18n?.t('lists.namePlaceholder')||'List name', '');
      if (name===null) return;
      const list = { id, language: activeLang, name: (name||'').trim() || 'New List', wordIds: [], createdAt: new Date().toISOString(), color: '#6366f1' };
      await syncSet(SYNC_KEYS.STUDY_LISTS, [...all, list]);
      await init();
    };
  }

  // Study-from-list filter for quiz
  async function getStudyListFilter(settings){
    const sel = getEl('studyListFilter'); if (!sel) return null;
    const lists = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
    const activeLang = settings.activeLanguage;
    sel.innerHTML = '';
    const optAll = document.createElement('option'); optAll.value=''; optAll.textContent = 'All'; sel.appendChild(optAll);
    lists.filter(l=> (l.language ? l.language===activeLang : (l.id||'').startsWith(`default-${activeLang}`))).forEach(l=>{
      const o = document.createElement('option'); o.value = l.id; o.textContent = l.name; sel.appendChild(o);
    });
    return sel;
  }

  // Patch quiz pool to respect selected list
  async function getPoolWithFilter(settings, retakeMode){
    const all = (await syncGet(SYNC_KEYS.WORDS)) || [];
    const lang = settings.activeLanguage;
    const poolAll = retakeMode
      ? all.filter(w=> w.language===lang && w.lastReviewed && ymd(w.lastReviewed)===ymd(new Date()))
      : all.filter(w=> w.language===lang);
    const sel = getEl('studyListFilter');
    if (!sel || !sel.value) return retakeMode ? poolAll : dueWords(poolAll);
    const lists = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
    const list = lists.find(l=> l.id === sel.value);
    if (!list) return retakeMode ? poolAll : dueWords(poolAll);
    const ids = new Set(list.wordIds || []);
    const narrowed = poolAll.filter(w=> ids.has(w.id));
    return retakeMode ? narrowed : dueWords(narrowed);
  }

  async function init(){
    try{
      const settings = await loadSettings();
      await migrateWordsEnsureIds();

      try { window.i18n?.setLocale(settings.appLocale || 'en'); } catch {}
      try { window.i18n?.apply(document); } catch {}
      try { document.title = window.i18n?.t ? window.i18n.t('app.title') : 'FireFlashcards'; } catch {}

      applyTheme(settings);

      const cfgBtn = getEl('configBtn'); if (cfgBtn) cfgBtn.onclick = (ev)=>{ ev.stopPropagation(); openConfig(true); };
      const cfgClose = getEl('configClose'); if (cfgClose) cfgClose.onclick = (ev)=>{ ev.stopPropagation(); openConfig(false); };
      const cfgModal = getEl('configModal'); if (cfgModal) cfgModal.addEventListener('click', (ev)=>{ const target = ev.target; if (!(target instanceof Element)) return; if (!target.closest('.modal-card')) openConfig(false); });
      // Close on Escape
      if (!window.__ff_cfgEsc){
        window.__ff_cfgEsc = true;
        document.addEventListener('keydown', (ev)=>{ if (ev.key === 'Escape' && !getEl('configModal')?.classList.contains('hidden')) openConfig(false); });
      }

      // Edit mode toggle for List view
      const editToggle = getEl('editToggle');
      if (editToggle) editToggle.onclick = ()=>{
        const body = document.body;
        body.classList.toggle('editing');
        const listView = getEl('view-list');
        if (listView){
          const txt = window.i18n?.t('list.editModeBanner') || 'Editing mode';
          listView.setAttribute('data-edit-banner', txt);
        }
      };

      document.querySelectorAll('#tabs button').forEach(btn=> btn.onclick = ()=> setActiveTab(btn.dataset.tab));
      const startBtn = getEl('startQuizBtn'); if (startBtn) startBtn.onclick = ()=> { setActiveTab('quiz'); };

      const themeSelect = getEl('themeSelect'); if (themeSelect){ themeSelect.value = settings.theme || 'system'; themeSelect.onchange = async ()=>{ const s=(await syncGet(SYNC_KEYS.SETTINGS))||{}; s.theme = themeSelect.value; await syncSet(SYNC_KEYS.SETTINGS, s); applyTheme(s); }; }

      const appLangSelect = getEl('appLangSelect'); if (appLangSelect){ renderAppLocales(appLangSelect, settings.appLocale||'en'); appLangSelect.onchange = async ()=>{ const s=(await syncGet(SYNC_KEYS.SETTINGS))||{}; s.appLocale = appLangSelect.value; await syncSet(SYNC_KEYS.SETTINGS, s); window.i18n?.setLocale(s.appLocale); window.i18n?.apply(document); init(); }; }

      const langSelect = getEl('languageSelect'); if (langSelect){ renderLanguages(langSelect, settings); langSelect.onchange = async ()=>{ const s=(await syncGet(SYNC_KEYS.SETTINGS))||{}; s.activeLanguage = langSelect.value; await syncSet(SYNC_KEYS.SETTINGS, s); init(); }; }

      const quickLangSwitch = getEl('quickLangSwitch'); if (quickLangSwitch){ quickLangSwitch.value = settings.activeLanguage || 'japanese'; quickLangSwitch.onchange = async ()=>{ const s=(await syncGet(SYNC_KEYS.SETTINGS))||{}; s.activeLanguage = quickLangSwitch.value; await syncSet(SYNC_KEYS.SETTINGS, s); init(); }; }

      const addBtn = getEl('addBtn'); if (addBtn){ addBtn.onclick = async ()=>{ try{ const word = (getEl('word')?.value||'').trim(); const translation = (getEl('translation')?.value||'').trim(); const pronunciation = (getEl('pronunciation')?.value||'').trim(); const reference = (getEl('reference')?.value||'').trim(); const hint = (getEl('hint')?.value||'').trim(); if (!word || !translation) return; const activeLang = (await syncGet(SYNC_KEYS.SETTINGS))?.activeLanguage || settings.activeLanguage; const sig = `${activeLang}|${normText(word)}|${normText(translation)}`; if (shouldThrottleAdd(sig)) return; const fresh = (await syncGet(SYNC_KEYS.WORDS)) || []; const entry = { id: uuidv4(), word, translation, pronunciation: pronunciation||undefined, reference: reference||undefined, hint: hint||undefined, language: activeLang, difficulty: 3, reviewCount:0, correctCount:0, createdAt: new Date().toISOString() }; const next = [...fresh, entry]; await syncSet(SYNC_KEYS.WORDS, next); await ensureDefaultList(entry.language); const lists = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || []; const idx = lists.findIndex(l=>l.id===`default-${entry.language}`); if (idx>=0 && !(lists[idx].wordIds||[]).includes(entry.id)) { lists[idx].wordIds = [...(lists[idx].wordIds||[]), entry.id]; await syncSet(SYNC_KEYS.STUDY_LISTS, lists); } ['word','translation','pronunciation','reference','hint'].forEach(id=>{ const el=getEl(id); if (el) el.value=''; }); init(); } catch(e){} }; }

      // Daily goal input handler
      const dailyGoalInput = getEl('dailyGoalInput'); if (dailyGoalInput){ dailyGoalInput.value = String(settings.dailyGoal||10); dailyGoalInput.onchange = async ()=>{ const v = parseInt(dailyGoalInput.value, 10); const s=(await syncGet(SYNC_KEYS.SETTINGS))||{}; s.dailyGoal = Number.isFinite(v) && v>0 ? v : 10; await syncSet(SYNC_KEYS.SETTINGS, s); await refreshDashboardUI(null, s); }; }

      // Reset all data
      const resetBtn = getEl('resetAllBtn'); if (resetBtn){ resetBtn.onclick = async ()=>{ if (!confirm('Reset all data?')) return; await syncSet(SYNC_KEYS.WORDS, []); await syncSet(SYNC_KEYS.ACTIVITIES, []); await syncSet(SYNC_KEYS.STUDY_LISTS, []); const freshSettings = { ...(await syncGet(SYNC_KEYS.SETTINGS))||{}, dailyGoal:10, languages: DEFAULT_LANGS, activeLanguage: DEFAULT_LANGS[0].id }; await syncSet(SYNC_KEYS.SETTINGS, freshSettings); openConfig(false); init(); }; }

      // List controls wiring (persist showArchived per language)
      const showArchived = getEl('showArchived');
      if (showArchived){
        const s0 = (await syncGet(SYNC_KEYS.SETTINGS)) || {};
        const perLang = (s0.showArchived && typeof s0.showArchived==='object') ? s0.showArchived : {};
        showArchived.checked = !!perLang[settings.activeLanguage];
        showArchived.onchange = async ()=>{
          const s2 = (await syncGet(SYNC_KEYS.SETTINGS)) || {};
          s2.showArchived = s2.showArchived || {};
          s2.showArchived[settings.activeLanguage] = !!showArchived.checked;
          await syncSet(SYNC_KEYS.SETTINGS, s2);
          const wordsNow = (await syncGet(SYNC_KEYS.WORDS)) || [];
          const listRootNow = getEl('list'); if (listRootNow) await renderListView(listRootNow, wordsNow, settings.activeLanguage);
          updateBulkButtonsState();
        };
      }
      const selAll = getEl('selectAll'); if (selAll){ selAll.onchange = ()=>{ const val = !!selAll.checked; document.querySelectorAll('#list .card .sel').forEach(cb=>{ cb.checked = val; }); updateBulkButtonsState(); }; }
      const arcSel = getEl('archiveSelectedBtn'); if (arcSel){ arcSel.onclick = ()=> bulkSetArchived(true); }
      const unarcSel = getEl('unarchiveSelectedBtn'); if (unarcSel){ unarcSel.onclick = ()=> bulkSetArchived(false); }

      // Collapsible list options panel
      const listOptionsToggle = getEl('listOptionsToggle');
      const listOptionsPanel = getEl('listOptionsPanel');
      if (listOptionsToggle && listOptionsPanel){
        listOptionsToggle.onclick = (e)=>{
          e.preventDefault();
          const open = listOptionsPanel.classList.toggle('hidden') === false ? true : !listOptionsPanel.classList.contains('hidden');
          listOptionsToggle.setAttribute('aria-expanded', String(open));
          // Flip arrow
          listOptionsToggle.textContent = open ? (window.i18n?.t('list.moreOptionsHide') || 'Hide options ▴') : (window.i18n?.t('list.moreOptions') || 'More options ▾');
        };
        // Initialize label
        listOptionsToggle.textContent = window.i18n?.t('list.moreOptions') || 'More options ▾';
      }

      const words = (await syncGet(SYNC_KEYS.WORDS)) || [];
      const listRoot = getEl('list'); if (listRoot) await renderListView(listRoot, words, settings.activeLanguage);
      // Ensure bulk buttons and select-all are synced after initial render
      if (typeof updateBulkButtonsState === 'function') updateBulkButtonsState();
      await renderListsManager(settings);

      await refreshDashboardUI(words, settings);

      // QUIZ (stateless, simple and robust)
      const card = getEl('ankiCard'); const wEl = getEl('ankiWord'); const aEl = getEl('ankiAnswer'); const ref = getEl('ankiRefLink'); const rev = getEl('ankiReveal'); const good = getEl('ankiGood'); const again = getEl('ankiAgain'); const hintEl = getEl('ankiHint'); const restartBtn = getEl('restartQuizBtn');
      if (card) card.classList.remove('hidden'); if (!wEl || !aEl || !rev || !good || !again) return;
      let currentId = null; let handling = false; let retakeMode = false;

      // Build study-from-list filter + missed-today-only toggle
      await renderStudyListFilter(settings);
      const studyFilter = getEl('studyListFilter');
      if (studyFilter){
        studyFilter.onchange = async ()=>{
          const val = studyFilter.value;
          const s = (await syncGet(SYNC_KEYS.SETTINGS)) || {};
          s.studyListFilter = s.studyListFilter || {};
          s.studyListFilter[settings.activeLanguage] = val ? [val] : [];
          await syncSet(SYNC_KEYS.SETTINGS, s);
          await renderQuizCard(null, true);
        };
      }
      const missedOnly = getEl('missedTodayOnly');
      if (missedOnly){
        const s = (await syncGet(SYNC_KEYS.SETTINGS)) || {};
        const perLang = (s.missedTodayOnly && typeof s.missedTodayOnly==='object') ? s.missedTodayOnly : {};
        missedOnly.checked = !!perLang[settings.activeLanguage];
        missedOnly.onchange = async ()=>{
          const s2 = (await syncGet(SYNC_KEYS.SETTINGS)) || {};
          s2.missedTodayOnly = s2.missedTodayOnly || {};
          s2.missedTodayOnly[settings.activeLanguage] = !!missedOnly.checked;
          await syncSet(SYNC_KEYS.SETTINGS, s2);
          await renderQuizCard(null, true);
        };
      }

      const tip = getEl('quizTip');
      function setCaughtUp(){ wEl.innerHTML = `<strong>${t('quiz.allCaughtUp')}</strong>`; aEl.textContent=''; aEl.classList.add('hidden'); aEl.style.display='none'; if (ref){ ref.href='#'; ref.classList.add('hidden'); ref.style.display='none'; } if (hintEl){ hintEl.textContent=''; hintEl.classList.add('hidden'); } if (tip) tip.classList.add('hidden'); rev.disabled = true; good.disabled = true; again.disabled = true; // show restart only if there were any reviews today
        (async ()=>{ const all = (await syncGet(SYNC_KEYS.WORDS)) || []; const reviewedToday = all.filter(w=> w.language===settings.activeLanguage && w.lastReviewed && ymd(w.lastReviewed)===ymd(new Date())).length; if (restartBtn){ if (!retakeMode && reviewedToday>0){ restartBtn.classList.remove('hidden'); restartBtn.disabled=false; restartBtn.onclick = async ()=>{ retakeMode = true; restartBtn.classList.add('hidden'); await renderQuizCard(currentId, true); }; } else { restartBtn.classList.add('hidden'); } } })(); }

      // Build the quiz pool considering language, archived, retake mode, missed-today-only, and list filter
      async function getPool(){
        const s = (await syncGet(SYNC_KEYS.SETTINGS)) || {};
        const lang = settings.activeLanguage;
        const all = (await syncGet(SYNC_KEYS.WORDS)) || [];
        // Base set: correct language and not archived
        let base = all.filter(w=> w.language===lang && !w.archived);
        // Retake mode = only words reviewed today; otherwise due words
        if (retakeMode){
          const today = ymd(new Date());
          base = base.filter(w=> w.lastReviewed && ymd(w.lastReviewed)===today);
        } else {
          base = dueWords(base);
        }
        // Optional: Missed today only filter
        const missedOnlyFlag = !!(s.missedTodayOnly && s.missedTodayOnly[lang]);
        if (missedOnlyFlag){
          const today = ymd(new Date());
          base = base.filter(w=> w.lastReviewed && ymd(w.lastReviewed)===today && (w._lastAnswerCorrect===false || ((w.reviewCount||0)>(w.correctCount||0))));
        }
        // Optional: List filter (single-select; stored as array of 0..1 in settings)
        const sel = getEl('studyListFilter');
        const selectedId = sel && sel.value ? sel.value : (Array.isArray(s.studyListFilter && s.studyListFilter[lang]) ? (s.studyListFilter[lang][0]||'') : '');
        if (selectedId){
          const lists = (await syncGet(SYNC_KEYS.STUDY_LISTS)) || [];
          const list = lists.find(x=>x.id===selectedId);
          if (list){
            const idSet = new Set(list.wordIds || []);
            base = base.filter(w=> idSet.has(w.id));
          }
        }
        return base;
      }

      // Pick next card, preferring a different id when provided
      function pickNextFromPool(pool, preferDifferentId){
        if (!Array.isArray(pool) || pool.length===0) return null;
        if (!preferDifferentId) return pool[0];
        const next = pool.find(w=> w.id !== preferDifferentId);
        return next || pool[0];
      }

      async function renderQuizCard(preferDifferentId=null, preferDifferent=false){ const pool = await getPool(); if (!pool.length){ setCaughtUp(); return; } const item = pickNextFromPool(pool, preferDifferent?preferDifferentId:null) || pool[0]; currentId = item.id; if (tip) tip.classList.remove('hidden'); if (restartBtn) restartBtn.classList.add('hidden'); wEl.innerHTML = `<strong>${item.word}</strong>`; const parts=[item.translation]; if (item.pronunciation) parts.push(` [${item.pronunciation}]`); aEl.textContent = parts.filter(Boolean).join(''); aEl.classList.add('hidden'); aEl.style.display='none'; if (hintEl){ if (item.hint){ hintEl.textContent = item.hint; hintEl.classList.add('hidden'); } else { hintEl.textContent=''; hintEl.classList.add('hidden'); } } if (ref){ if (item.reference){ ref.href=item.reference; ref.classList.add('hidden'); ref.style.display='none'; } else { ref.href='#'; ref.classList.add('hidden'); ref.style.display='none'; } } rev.disabled=false; good.disabled=false; again.disabled=false; rev.onclick = ()=>{ aEl.classList.remove('hidden'); aEl.style.display='block'; if (hintEl && item.hint) hintEl.classList.remove('hidden'); if (item.reference && ref){ ref.classList.remove('hidden'); ref.style.display='inline'; } }; good.onclick = async ()=>{ if (handling) return; handling=true; rev.disabled=good.disabled=again.disabled=true; await onAnswer(item, true); handling=false; }; again.onclick = async ()=>{ if (handling) return; handling=true; rev.disabled=good.disabled=again.disabled=true; await onAnswer(item, false); handling=false; }; log('quiz: show', { id: item.id, word: item.word }); }

      async function onAnswer(item, correct){ try{ const updates = schedule(item, correct); const all = (await syncGet(SYNC_KEYS.WORDS)) || []; const updated = all.map(w=> w.id===item.id ? { ...w, ...updates, _lastAnswerCorrect: !!correct } : w); await syncSet(SYNC_KEYS.WORDS, updated); await recordActivity({ sessions: 1, words: 1, minutes: 1 }); const fresh = (await syncGet(SYNC_KEYS.WORDS)) || []; await refreshDashboardUI(fresh, settings); await renderQuizCard(item.id, true); } catch(e){ console.error('Quiz answer error', e); setCaughtUp(); } }

      await renderQuizCard();

      // Keyboard shortcuts specific to quiz
      if (!hotkeysBound){
        hotkeysBound = true;
        document.addEventListener('keydown', (ev)=>{
          const activeView = !getEl('view-quiz')?.classList.contains('hidden');
          if (!activeView) return;
          const tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : '';
          if (tag === 'input' || tag === 'textarea') return;
          if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); getEl('ankiReveal')?.click(); return; }
          if (ev.key === '1' || ev.key.toLowerCase() === 'a') { ev.preventDefault(); getEl('ankiAgain')?.click(); return; }
          if (ev.key === '2' || ev.key.toLowerCase() === 'g') { ev.preventDefault(); getEl('ankiGood')?.click(); return; }
        });
      }

    } catch(e){ log('init error', e); }
  }

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState === 'interactive' || document.readyState === 'complete') { try { init(); } catch (e) {} } else { setTimeout(()=>{ try { init(); } catch (e) {} }, 0); }
})();
